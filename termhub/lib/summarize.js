'use strict';

// Turn a Claude turn's raw markdown into two or three sentences worth speaking.
//
// Reading a real assistant message aloud verbatim is unusable: code fences,
// bullet lists, file paths and backticks all come out as noise. So we ask
// `claude -p --model haiku` to rewrite it for speech — free on the user's
// subscription, no API key, ~4 s. When that isn't possible (no CLI, offline,
// timeout) we fall back to a crude local reduction, because a mediocre spoken
// summary is still far better than the voice loop going silent.
//
// Never throws and never blocks: the child is spawned with piped stdio, killed
// on timeout, and run in the temp dir so it can't touch a user's project.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const INSTRUCTION = "Summarize the assistant's message in 2-3 short spoken sentences for text-to-speech. "
  + 'Plain prose, no markdown, no code, no lists. '
  + 'If it ends with a question or asks for a decision, end with that question.';

const TIMEOUT_MS = 25000;
const MAX_SUMMARY_CHARS = 1200;

// Anything longer is mostly code/logs the model doesn't need to see, and it
// slows haiku down for no gain.
const MAX_INPUT_CHARS = 12000;

// Below this, flattening the markdown IS the summary — roughly two spoken
// sentences. Measured reason, not just a latency win: handed something as short
// as "The secret word is marmalade." haiku doesn't recognise it as a message to
// summarize and replies "I don't see a previous assistant message…", and handed
// "Lima is the capital of Peru." it answers the question instead of condensing
// it. Short turns are common (most answers are two lines), so this is the hot
// path as well as the correct one — and it saves ~4 s.
const SHORT_ENOUGH_CHARS = 240;

const RESOLVE_TTL_MS = 30000;
let binCache = { checkedAt: 0, bin: null };

// Environment variables Claude Code exports into the shells it spawns. sessiond
// is often started from inside one (a dev run launched from a termhub session),
// and a nested `claude` that thinks it's a child of another `claude` behaves
// differently. Strip them so the summarizer runs like a fresh terminal would.
// ANTHROPIC_*/CLAUDE_CONFIG_DIR are deliberately left alone — those carry
// credentials and config the child genuinely needs.
const INHERITED_AGENT_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT',
];

// The summarizer's cwd. Its own `claude -p` runs get filed as conversations
// under ~/.claude/projects/<encoded cwd>/ like any other, so this must not be a
// directory a user might have a terminal open in — a bare os.tmpdir() would
// make every summarizer run look like "the active transcript in /tmp" to
// lib/claudeModel.js's cwd fallback, and a session opened in /tmp would start
// reporting the summarizer's model and turns as its own.
function workDir() {
  const dir = path.join(os.tmpdir(), 'termhub-summarize');
  try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return os.tmpdir(); }
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function claudeBin() {
  if (Date.now() - binCache.checkedAt < RESOLVE_TTL_MS) return binCache.bin;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const candidates = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) candidates.push(path.join(dir, n));
  }
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'));
  const bin = candidates.find(isExecutable) || null;
  binCache = { checkedAt: Date.now(), bin };
  return bin;
}

function available() {
  return !!claudeBin();
}

// ---- text tidying -----------------------------------------------------------

// CSI/OSC escapes: a summary is spoken, so any stray terminal colour codes that
// rode along in the transcript would be read out as gibberish.
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

// Flatten the markdown a spoken sentence can't carry. Order matters: fenced
// blocks go first so their contents don't get treated as headings or bullets.
function stripMarkdown(s) {
  return s
    .replace(/```[\s\S]*?```/g, ' ')            // fenced code
    .replace(/`([^`]*)`/g, '$1')                // inline code, keep the word
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // links, keep the label
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')         // headings
    .replace(/^\s{0,3}[-*+]\s+/gm, '')          // bullets
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')        // numbered items
    .replace(/^\s{0,3}>\s?/gm, '')              // block quotes
    .replace(/\*\*|__|\*|_|~~/g, '')            // emphasis
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ');       // rules
}

function tidy(s) {
  return stripMarkdown(stripAnsi(String(s || '')))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .join(' ')
    .trim();
}

// Last-resort summary with no model involved: flatten the markdown, keep the
// first few sentences, and — because "what do you want me to do?" is the part
// the user actually needs — append the message's final question if it had one
// and it didn't already survive the trim.
function ruleBasedSummary(text) {
  const flat = tidy(text);
  if (!flat) return '';
  const sentences = flat.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [flat];
  let out = sentences.slice(0, 3).map((s) => s.trim()).join(' ');
  const question = [...flat.matchAll(/([^.!?]*\?)/g)].pop();
  if (question) {
    const q = question[1].trim();
    if (q && !out.includes(q)) out += ` ${q}`;
  }
  return out.slice(0, MAX_SUMMARY_CHARS).trim();
}

// ---- the model call ---------------------------------------------------------

function runClaude(bin, text) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of INHERITED_AGENT_VARS) delete env[key];

    // detached so the child gets its own process group: sessiond's own children
    // include PTYs, and a summarizer must never receive a signal meant for one.
    const child = execFile(bin, ['-p', '--model', 'haiku', INSTRUCTION], {
      cwd: workDir(),
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env,
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ''));
    });
    child.stdin.on('error', () => {}); // the CLI can exit before reading stdin
    child.stdin.end(text);
  });
}

// Always resolves to a string — possibly the rule-based fallback, possibly ''
// if there was nothing to summarize in the first place.
async function summarize(text) {
  const input = (typeof text === 'string' ? text : '').trim().slice(0, MAX_INPUT_CHARS);
  if (!input) return '';
  const flat = tidy(input);
  if (!flat) return '';
  if (flat.length <= SHORT_ENOUGH_CHARS) return flat;
  const bin = claudeBin();
  if (!bin) return ruleBasedSummary(input);
  try {
    const raw = await runClaude(bin, input);
    const cleaned = tidy(raw).slice(0, MAX_SUMMARY_CHARS).trim();
    return cleaned || ruleBasedSummary(input);
  } catch {
    return ruleBasedSummary(input);
  }
}

module.exports = { summarize, ruleBasedSummary, available, INSTRUCTION };
