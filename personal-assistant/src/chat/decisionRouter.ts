'use strict';

// The fast lane's router on a decision model (PA_FAST_ROUTER=decision; docs/native/PLAN.md
// D7, D28). Same contract as the logprob router (src/chat/fastRouter.ts): it returns
// p = { answer_here, hand_off, action } and never words. Instead of reading one token's
// odds from a chat model, it asks Microsoft-Decision-1 (Azure AI Foundry, `systemone`
// API) a fixed set of questions about the turn and reads back probabilities:
//
//   route         choice   answer_here | hand_off | action  -> p
//   tool          choice   which of Jarvis's sources would answer it (logged)
//   effort        score    0 trivial .. 3 multi-step research (logged)
//   acts_outside  noul     p(it asks for a change outside Jarvis) (logged)
//
// All four share one `state` (snapshot, last two turns, the words), so they cost one
// call. Only `route` decides today; the other three ride along in the decision event and
// the log, so the eval can grow into tool and model-tier routing on real turns.
//
// The model writes no text, so it cannot answer a turn it should have handed off.
// It can still pick wrongly: `pa eval router --router decision` measures it on the
// same set as the logprob router.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

const { config } = require('../config.ts');

const CLASSES = ['answer_here', 'hand_off', 'action'];

// The option descriptions are the router's whole prompt: keep them in step with
// fastRouter.ts's ROUTER_SYSTEM, which the eval labels were written against.
const QUESTIONS: Json = {
  route: {
    type: 'choice',
    instructions: "Where should the user's voice assistant send what the user just said?",
    criteria: {
      answer_here:
        "Small talk, or a question whose whole answer is written in the snapshot or the conversation: counts, due dates, today's and tomorrow's meetings, the time and date, what was just said.",
      hand_off:
        'A question that needs looking something up the snapshot does not show: mail, messages, chats, documents, tickets, PRs, past meetings, meetings after tomorrow or the whole week, memory, the web, or details beyond the snapshot lines.',
      action:
        'Asks for something to be done or changed: send, reply, tell, forward, remind, remember, schedule, book, move, cancel, close, mark, approve, start, draft, merge, set up. Anything the user wants to happen.',
    },
  },
  tool: {
    type: 'choice',
    instructions: 'If something has to be looked up or done, which source fits best?',
    criteria: {
      none: 'Nothing to look up or do',
      calendar: 'Meetings on any day',
      inbox: 'Email, Teams and chat messages',
      wip_status: 'Agent runs, PRs, factory jobs, work in progress',
      memory: 'What was said, promised or decided earlier',
      commitments: 'Open asks, overdue and due items',
      other: 'Anything else: documents, tickets, the web',
    },
  },
  effort: {
    type: 'score',
    instructions: 'How much work does a good answer take?',
    criteria: ['Trivial: a word or a fact on hand', 'One lookup', 'A few lookups and a summary', 'Multi-step research or a plan'],
  },
  acts_outside: {
    type: 'noul',
    instructions: 'Does this ask the assistant to change something outside itself (send, schedule, merge, edit data)?',
    criteria: { true: 'It asks for a change, or a message to be sent', false: 'It only asks for information, or is chat' },
  },
};

const clip = (s: any, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** Pure. The shared state: snapshot, the last two turns, the words (as the logprob router sees them). */
function decisionState({ text, context, history }: { text?: string | null | undefined; context?: any; history?: any }) {
  const conversation = (history || []).slice(-2).map((e: any) => `${e.type === 'user' ? 'user' : 'assistant'}: ${clip(e.text, 200)}`);
  return {
    snapshot: context || '(no snapshot available)',
    conversation: conversation.length ? conversation : ['(none yet)'],
    user_just_said: clip(String(text || ''), 600),
  };
}

/** Pure. `https://x.cognitiveservices.azure.com/` (any path) -> its systemone URL. */
function decisionUrl(endpoint: string) {
  let origin;
  try {
    origin = new URL(String(endpoint)).origin;
  } catch {
    throw new Error('decision router: no endpoint (PA_DECISION_ENDPOINT)');
  }
  return `${origin}/providers/microsoft/v1/systemone`;
}

/** Pure. The request: one state, the fixed questions, the deployment as `model`. */
function decisionRequest({ deployment, endpoint, key, token = null, text, context, history }: { deployment: string; endpoint: string; key?: string | null | undefined; token?: string | null | undefined; text?: string | null | undefined; context?: any; history?: any }) {
  const headers: Json = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) headers['api-key'] = key;
  else if (token) headers.authorization = `Bearer ${token}`;
  return { url: decisionUrl(endpoint), headers, body: { model: deployment, state: decisionState({ text, context, history }), questions: QUESTIONS } };
}

/**
 * Pure. The reply's answers -> { p, lp, extra }. p is the route question's
 * probabilities over the three classes (renormalized); lp is ln p, so the
 * logprob router's calibration and threshold fitting work unchanged (identity
 * at T=1, b=0). null when the route answer is missing or malformed.
 */
function parseAnswers(answers: any) {
  const probs = answers?.route?.probabilities;
  if (!probs || typeof probs !== 'object') return null;
  const raw = CLASSES.map((k) => Number(probs[k]));
  if (raw.some((x) => !Number.isFinite(x) || x < 0)) return null;
  const sum = raw.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const p: Json = {};
  const lp: Json = {};
  CLASSES.forEach((k, i) => {
    p[k] = raw[i]! / sum;
    lp[k] = Math.log(Math.max(p[k], 1e-9));
  });
  const r3 = (x: any) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 1000) / 1000 : null);
  const extra: Json = {
    tool: typeof answers.tool?.choice === 'string' ? answers.tool.choice : null,
    toolConfidence: r3(answers.tool?.confidence),
    effort: r3(answers.effort?.score),
    actsOutside: r3(answers.acts_outside?.noul),
    routeConfidence: r3(answers.route?.confidence),
  };
  return { p, lp, extra };
}

/**
 * The deployment, endpoint and key in use. The key is PA_DECISION_API_KEY
 * (keychain/env); without PA_DECISION_ENDPOINT the Azure chat resource and its
 * key. No key: Entra ID (entraToken), which is what a user whose role cannot
 * list keys has.
 */
function settings() {
  const d = config.fastLane.decision || {};
  const { secret } = require('../config.ts');
  const own = secret('PA_DECISION_API_KEY');
  const key = own || (d.endpoint ? null : require('../models.ts').providerKey('azure'));
  return { deployment: d.deployment || 'decision-1', endpoint: d.endpoint || config.providers.azure.endpoint, key: key || null };
}

// An Entra ID token for Cognitive Services from the Azure CLI's login, cached
// until five minutes before it expires. `az` takes about a second, so warm()
// fetches it before the first turn (prepare) and a turn rarely waits.
const TOKEN_RESOURCE = 'https://cognitiveservices.azure.com';
let tokenCache: { value: string; expiresAt: number } | null = null;
let tokenPending: Promise<string> | null = null;

/** Pure. `az account get-access-token -o json` -> { value, expiresAt } (ms), or null. */
function parseAzToken(stdout: string) {
  let j: any = null;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  const value = j?.accessToken;
  const expiresAt = Number(j?.expires_on) * 1000 || Date.parse(j?.expiresOn) || 0;
  return typeof value === 'string' && value ? { value, expiresAt } : null;
}

// One fixed command line, no user input in it: `az` is a .cmd on Windows, so it needs a shell.
function runAz(): Promise<string> {
  const { exec } = require('child_process');
  return new Promise((resolve, reject) => {
    exec(`az account get-access-token --resource ${TOKEN_RESOURCE} -o json`, { timeout: 20_000, windowsHide: true }, (err: any, stdout: string) =>
      err ? reject(new Error(`az: ${String(err.message).split('\n')[0]}`)) : resolve(stdout)
    );
  });
}

async function entraToken({ now = Date.now(), run = runAz }: { now?: number; run?: () => Promise<string> } = {}) {
  if (tokenCache && tokenCache.expiresAt - now > 5 * 60_000) return tokenCache.value;
  if (!tokenPending) {
    tokenPending = run()
      .then((out) => {
        const t = parseAzToken(out);
        if (!t) throw new Error('az: no access token in its output (is `az login` done?)');
        tokenCache = t;
        return t.value;
      })
      .finally(() => {
        tokenPending = null;
      });
  }
  return tokenPending;
}

/** Fetches the token ahead of the first turn when no key is configured. Never throws. */
function prepare() {
  if (settings().key) return Promise.resolve(null);
  return entraToken().then(
    () => true,
    () => null
  );
}

/** Tests: forget the cached token. */
function resetToken() {
  tokenCache = null;
  tokenPending = null;
}

/**
 * Scores one turn. -> { p, lp, ms, model, extra, usage } or throws (no
 * endpoint, HTTP error, timeout, no route in the reply). `post(url, init)` is
 * fetch. Records one llm_spend row (purpose fast-lane), priced from
 * PA_MODEL_PRICES `decision/<deployment>=in:out` when given.
 */
async function score({ text, context = '', history = [], timeoutMs = 2500, signal = null, post = (...a: Parameters<typeof fetch>) => fetch(...a), deployment = null, endpoint = null, key = null, token = null, record = null, retries = 0 }: { text?: string | null | undefined; context?: string | undefined; history?: any; timeoutMs?: number | undefined; signal?: AbortSignal | null | undefined; post?: any; deployment?: string | null; endpoint?: string | null; key?: string | null; token?: string | null; record?: any; retries?: number; [k: string]: any }) {
  if (deployment == null || endpoint == null || key == null) {
    const s = settings();
    deployment ??= s.deployment;
    endpoint ??= s.endpoint;
    key ??= s.key;
  }
  if (!endpoint) throw new Error('decision router: no endpoint (PA_DECISION_ENDPOINT)');
  if (!key && token == null) {
    try {
      token = await entraToken();
    } catch (err) {
      throw new Error(`decision router: no key and no Entra token (${(err as Error).message})`);
    }
  }
  const req = decisionRequest({ deployment: deployment as string, endpoint: endpoint as string, key, token, text, context, history });
  const model = `decision/${deployment}`;
  const t0 = Date.now();
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const rec = record || ((r: any) => require('../budget.ts').record(r));
  let res;
  try {
    for (let attempt = 0; ; attempt++) {
      res = await post(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: sig });
      // A live turn never waits out a rate limit (it falls back); the eval may.
      if (res.status !== 429 || attempt >= retries) break;
      const after = Number(res.headers?.get?.('retry-after')) || 10;
      await new Promise((r) => setTimeout(r, Math.min(60, after) * 1000));
    }
  } catch (err) {
    throw new Error(`decision router: ${(err as any).name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : (err as any).cause?.code || (err as any).message}`);
  }
  const raw = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  const ms = Date.now() - t0;
  const usage = { input: Number(json?.usage?.input_tokens) || null, output: Number(json?.usage?.output_tokens) || null };
  const price = require('../models.ts').parsePrices(config.modelPrices)[model.toLowerCase()];
  const costUsd = price && usage.input != null ? (usage.input * price[0] + (usage.output || 0) * price[1]) / 1e6 : null;
  const parsed = res.ok && json ? parseAnswers(json.answers) : null;
  Promise.resolve(rec({ purpose: 'fast-lane', model, backend: 'azure', costUsd, inputTokens: usage.input, outputTokens: usage.output, durationMs: ms, ok: !!parsed })).catch(() => {});
  if (!res.ok || !json || json.error) throw new Error(`decision router ${res.status}: ${String(json?.error?.message || json?.error?.code || raw).slice(0, 200)}`);
  if (!parsed) throw new Error('decision router: no route probabilities in the reply');
  return { ...parsed, ms, model, usage };
}

module.exports = { CLASSES, QUESTIONS, decisionState, decisionUrl, decisionRequest, parseAnswers, settings, parseAzToken, entraToken, prepare, resetToken, score };
