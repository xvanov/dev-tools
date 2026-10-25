'use strict';

// One way to ask a model for text, with two backends behind it.
//
//  - **api** — the Anthropic SDK, when `ANTHROPIC_API_KEY` is set.
//  - **cli** — a headless `claude -p`, otherwise. It runs on the operator's own
//    Claude Code login, so the tool needs no key of its own, and it is the same
//    process that can reach the claude.ai connectors (Atlassian, Microsoft 365)
//    without an app registration in anyone's tenant.
//
// The CLI is isolated on purpose. It runs from an empty directory of its own
// (CLI_CWD) so no repo `CLAUDE.md` is discovered — and not from the temp root,
// which Claude Code lists in full at startup (`rg --files`): with tens of
// thousands of files there, every call cost seconds of CPU and disk,
// several times a minute, and made the whole machine lag. It also runs with `--setting-sources project` so the user's own
// hooks and plugins (an output-style hook, a status line) cannot rewrite an
// extraction prompt, and with `--no-session-persistence` so a thousand
// distillation calls do not land in the session history. Tools are off unless
// the caller names the ones it needs.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('./config');

const CLI_CWD = path.join(config.dataDir, 'llm-cwd');

function cliCwd() {
  fs.mkdirSync(CLI_CWD, { recursive: true });
  return CLI_CWD;
}

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

async function viaApi({ system, prompt, effort, maxTokens, model }) {
  const response = await sdk().messages.create({
    model: model || config.anthropic.model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const usage = apiUsage(model || config.anthropic.model, response.usage);
  if (response.stop_reason === 'refusal') {
    throw withUsage(new Error(`model declined: ${response.stop_details?.category || 'unknown'}`), usage);
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { text, usage };
}

// `model` overrides the default for one call: cheap judgements (is this a
// duplicate?) do not need the model that extracts commitments.
function cliArgs({ system, effort, tools, model = null }) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--effort', effort,
    '--model', model || config.anthropic.model,
  ];
  if (system) args.push('--system-prompt', system);
  if (tools && tools.length) args.push('--allowedTools', tools.join(','));
  // No tools, no MCP servers either: a user-scope server (this tool's own
  // recall server among them) would otherwise be spawned, and connected to
  // Postgres, for every one of the worker's thousands of model calls.
  else args.push('--tools', '', '--strict-mcp-config');
  return args;
}

// The prompt goes in on stdin: Windows caps a command line at 32k characters
// and a distillation prompt is routinely longer.
function runCli(args, prompt, timeoutMs, env = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, {
      cwd: cliCwd(),
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
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

// What `claude -p` reported spending, summed over this process. Backfills
// read it to say what a pass cost; the durable record, and the daily cap, are
// `llm_spend` (src/budget.js).
const spend = { calls: 0, usd: 0 };

function noteCost(usage) {
  spend.calls++;
  if (Number.isFinite(usage?.costUsd)) spend.usd += usage.costUsd;
}

// Cost and tokens from `claude -p` output: the one JSON object of
// `--output-format json`, or the final `result` event of `stream-json`.
// Input tokens include cache reads and writes — they are what the call read.
// Best effort: anything unparseable is nulls, and fails elsewhere.
function cliUsage(out) {
  const none = { costUsd: null, inputTokens: null, outputTokens: null };
  let final = null;
  try {
    final = JSON.parse(out);
  } catch {
    const lines = String(out || '').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && !final; i--) {
      if (!lines[i].includes('"result"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        if (e && e.type === 'result') final = e;
      } catch {
        /* not this line */
      }
    }
  }
  if (!final || typeof final !== 'object') return none;
  const cost = Number(final.total_cost_usd);
  const u = final.usage || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    costUsd: final.total_cost_usd != null && Number.isFinite(cost) ? cost : null,
    inputTokens: u.input_tokens != null ? n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) : null,
    outputTokens: u.output_tokens != null ? n(u.output_tokens) : null,
  };
}

// Dollars per million tokens, input / output, for the API backend, which
// reports tokens but not cost. Exact ids first, then the family at
// current-generation prices; an unknown model records a null cost rather than
// a guess. Cache writes are billed at 1.25x input, cache reads at 0.1x.
const PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};
const FAMILY = [
  [/fable|mythos/, [10, 50]],
  [/opus/, [4, 20]],
  [/sonnet/, [2, 10]],
  [/haiku/, [0.1, 0.5]],
];

function priceOf(model) {
  const id = String(model || '').toLowerCase();
  if (PRICES[id]) return PRICES[id];
  const fam = FAMILY.find(([re]) => re.test(id));
  return fam ? fam[1] : null;
}

function apiUsage(model, u) {
  if (!u) return { costUsd: null, inputTokens: null, outputTokens: null };
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const plain = n(u.input_tokens);
  const write = n(u.cache_creation_input_tokens);
  const read = n(u.cache_read_input_tokens);
  const output = n(u.output_tokens);
  const price = priceOf(model);
  const costUsd = price ? (plain * price[0] + write * price[0] * 1.25 + read * price[0] * 0.1 + output * price[1]) / 1e6 : null;
  return { costUsd, inputTokens: plain + write + read, outputTokens: output };
}

function withUsage(err, usage) {
  err.usage = usage;
  return err;
}

async function viaCli({ system, prompt, effort, tools, timeoutMs, model }) {
  const result = await runCli(cliArgs({ system, effort, tools, model }), prompt, timeoutMs);
  const usage = cliUsage(result.out);
  noteCost(usage);
  try {
    return { text: parseCliOutput(result), usage };
  } catch (err) {
    throw withUsage(err, usage);
  }
}

// One `llm_spend` row per call (src/budget.js), awaited so a short-lived `pa`
// process does not exit before it lands, but never for more than a moment and
// never with an error: spend is bookkeeping, and the caller's result matters
// more. Only the purpose, model, numbers and outcome are passed — no text.
async function recordCall(meta, started, usage, ok) {
  const row = { ...meta, ...(usage || {}), durationMs: Date.now() - started, ok };
  try {
    let timer;
    await Promise.race([
      require('./budget').record(row),
      new Promise((r) => {
        timer = setTimeout(r, 2000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  } catch {
    // record() swallows its own errors; this is for a failed require.
  }
}

// `tools` forces the CLI backend: only Claude Code can reach the connectors.
// `purpose` names the pass for `llm_spend` and the daily cap (src/budget.js);
// a call with tools is a connector relay unless it says otherwise.
async function complete({
  system = null,
  prompt,
  effort = config.anthropic.effort,
  maxTokens = 8000,
  tools = null,
  timeoutMs = 300_000,
  model = null,
  purpose = null,
}) {
  const useCli = Boolean(tools) || backend() === 'cli';
  const meta = {
    purpose: purpose || (tools ? 'connector' : 'unknown'),
    model: model || config.anthropic.model,
    backend: useCli ? 'cli' : 'api',
  };
  // A connector relay without a model of its own: the relay model.
  if (tools && !model) model = meta.model = config.m365.connectorModel;
  const started = Date.now();
  try {
    const { text, usage } = useCli
      ? await viaCli({ system, prompt, effort, tools, timeoutMs, model })
      : await viaApi({ system, prompt, effort, maxTokens, model });
    await recordCall(meta, started, usage, true);
    return text;
  } catch (err) {
    await recordCall(meta, started, err.usage, false);
    throw err;
  }
}

// Runs a headless session whose only job is to call connector tools, and
// returns what the tools returned — not what the model says they returned.
//
// The reply is read as `stream-json`, so every tool_use and its tool_result
// come back verbatim: the model chooses the calls, it never copies the data.
// That is the difference from the Jira relay, and the reason bodies arrive
// intact. Each result block is JSON-parsed when it can be; Microsoft 365
// results are one JSON object per block.
//
// A result larger than MAX_MCP_OUTPUT_TOKENS is not shown to the model at all:
// Claude Code writes it to a file and hands the model the path. For a relay
// that is the better channel — the data arrives verbatim from disk and the
// session's context stays small — so `visibleTokens` sets that threshold per
// call: high where the model must read a result to act on it (a search's
// `nextOffset`), low where it only has to make the call (read_resource).
//
// Returns [{ name, input, results: [...], error: string|null }] in call order.
async function toolCalls({ prompt, tools, effort = 'low', timeoutMs = 300_000, visibleTokens = null, purpose = 'connector' }) {
  const model = config.m365.connectorModel;
  const args = cliArgs({ system: null, effort, tools, model });
  const fmt = args.indexOf('json');
  args[fmt] = 'stream-json';
  args.push('--verbose');
  const env = visibleTokens ? { MAX_MCP_OUTPUT_TOKENS: String(visibleTokens) } : null;
  const meta = { purpose: purpose || 'connector', model, backend: 'cli' };
  const started = Date.now();
  let usage = null;
  try {
    const { code, out, err } = await runCli(args, prompt, timeoutMs, env);
    usage = cliUsage(out);
    noteCost(usage);
    const calls = parseToolStream(out, { code, err });
    await recordCall(meta, started, usage, true);
    return calls;
  } catch (err) {
    await recordCall(meta, started, usage, false);
    throw err;
  }
}

// "...exceeds maximum allowed tokens. Output has been saved to C:\...\x.txt"
// → the blocks that file holds: a JSON array of {type, text}.
function spilledBlocks(text) {
  // Two spellings across Claude Code versions: "Output has been saved to X"
  // and "<persisted-output> … Full output saved to: X". Missing the newer one
  // silently dropped every large page (a 25-event calendar page is ~70KB).
  const m = String(text).match(/(?:Output has been saved to|Full output saved to:)\s*(.+?\.(?:txt|json))/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(require('fs').readFileSync(m[1].trim(), 'utf8'));
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    return blocks.map((b) => (b && typeof b === 'object' && 'text' in b ? b.text : JSON.stringify(b)));
  } catch {
    return null;
  }
}

function parseToolStream(out, { code = 0, err = '' } = {}) {
  const calls = new Map();
  let final = null;
  for (const line of String(out).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event.message?.content;
    if (event.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && /^mcp__/.test(block.name)) {
          calls.set(block.id, { name: block.name, input: block.input || {}, results: [], error: null });
        }
      }
    } else if (event.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        const call = block.type === 'tool_result' && calls.get(block.tool_use_id);
        if (!call) continue;
        let parts = Array.isArray(block.content)
          ? block.content.filter((p) => p.type === 'text').map((p) => p.text)
          : [String(block.content ?? '')];
        const spilled = parts.length === 1 ? spilledBlocks(parts[0]) : null;
        if (spilled) parts = spilled;
        if (block.is_error) {
          call.error = parts.join('\n').slice(0, 500);
          continue;
        }
        for (const text of parts) {
          try {
            call.results.push(JSON.parse(text));
          } catch {
            call.results.push(text);
          }
        }
      }
    } else if (event.type === 'result') {
      final = event;
    }
  }
  if (!final && !calls.size) {
    throw new Error(`claude -p exited ${code}: ${(err || out).trim().slice(0, 300)}`);
  }
  return [...calls.values()];
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

module.exports = {
  spend: () => ({ ...spend }),
  complete,
  toolCalls,
  parseToolStream,
  spilledBlocks,
  backend,
  extractJson,
  cliArgs,
  parseCliOutput,
  cliUsage,
  apiUsage,
  priceOf,
};
