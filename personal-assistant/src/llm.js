'use strict';

// One way to ask a model for text, with two backends behind it.
//
//  - **api** — the Anthropic SDK, when `ANTHROPIC_API_KEY` is set.
//  - **cli** — a headless `claude -p`, otherwise. It runs on the operator's own
//    Claude Code login, so the tool needs no key of its own, and it is the same
//    process that can reach the claude.ai connectors (Atlassian, Microsoft 365)
//    without an app registration in anyone's tenant.
//
// The CLI is isolated on purpose. It runs from a temp directory so no repo
// `CLAUDE.md` is discovered, with `--setting-sources project` so the user's own
// hooks and plugins (an output-style hook, a status line) cannot rewrite an
// extraction prompt, and with `--no-session-persistence` so a thousand
// distillation calls do not land in the session history. Tools are off unless
// the caller names the ones it needs.

const os = require('os');
const { spawn } = require('child_process');
const { config } = require('./config');

function backend() {
  return config.anthropic.apiKey ? 'api' : 'cli';
}

let sdkClient = null;
function sdk() {
  if (!sdkClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    sdkClient = new Ctor({ apiKey: config.anthropic.apiKey });
  }
  return sdkClient;
}

async function viaApi({ system, prompt, effort, maxTokens }) {
  const response = await sdk().messages.create({
    model: config.anthropic.model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`model declined: ${response.stop_details?.category || 'unknown'}`);
  }
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function cliArgs({ system, effort, tools }) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--effort', effort,
    '--model', config.anthropic.model,
  ];
  if (system) args.push('--system-prompt', system);
  if (tools && tools.length) args.push('--allowedTools', tools.join(','));
  else args.push('--tools', '');
  return args;
}

// The prompt goes in on stdin: Windows caps a command line at 32k characters
// and a distillation prompt is routinely longer.
function runCli(args, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${config.claudeBin}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.end(prompt);
  });
}

function parseCliOutput({ code, out, err }) {
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`claude -p exited ${code}: ${(err || out).trim().slice(0, 300)}`);
  }
  if (parsed.is_error || parsed.subtype !== 'success') {
    throw new Error(`claude -p failed: ${String(parsed.result || parsed.subtype || 'unknown').slice(0, 300)}`);
  }
  return String(parsed.result || '');
}

async function viaCli({ system, prompt, effort, tools, timeoutMs }) {
  return parseCliOutput(await runCli(cliArgs({ system, effort, tools }), prompt, timeoutMs));
}

// `tools` forces the CLI backend: only Claude Code can reach the connectors.
async function complete({
  system = null,
  prompt,
  effort = config.anthropic.effort,
  maxTokens = 8000,
  tools = null,
  timeoutMs = 300_000,
}) {
  if (tools || backend() === 'cli') return viaCli({ system, prompt, effort, tools, timeoutMs });
  return viaApi({ system, prompt, effort, maxTokens });
}

// Pulls the first JSON object or array out of a model reply, tolerating a
// code fence or a sentence of preamble — the CLI does not enforce a schema.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in model reply');
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) throw new Error('unterminated JSON in model reply');
  return JSON.parse(body.slice(start, end + 1));
}

module.exports = { complete, backend, extractJson, cliArgs, parseCliOutput };
