'use strict';

// The fast lane's router (System 1, decide-then-speak; docs/native/PLAN.md
// D7, item 0.6). It returns calibrated probabilities, never words:
//
//   p.answer_here  the fast lane can say the whole answer from the snapshot or
//                  the conversation (small talk included)
//   p.hand_off     Jarvis (the PA chat) has to look something up
//   p.action       Jarvis has to do something
//
// One local model call scores one fixed question, "A, B or C?", from the
// log-probabilities of the single next token (Ollama `logprobs`): no text is
// generated, so the router cannot be confidently wrong in prose, and it costs
// one forward pass. The system prompt and the examples in it never change, so
// Ollama keeps them in its prompt cache; a turn only pays for the snapshot
// (when it changed), the last two turns and the user's words.
//
// Raw model log-probabilities are over-confident and biased towards "A", so
// they are calibrated: z_k = lp_k / T + b_k, p = softmax(z) (temperature
// scaling with a per-class bias), fitted on the eval set
// (src/eval/router-cases.json) by `pa eval router --fit`. The answerer only
// speaks when p.answer_here clears the threshold (PA_FAST_ANSWER_THRESHOLD);
// otherwise the user's words go to Jarvis verbatim.

const CLASSES = ['answer_here', 'hand_off', 'action'];
const LETTERS = { A: 'answer_here', B: 'hand_off', C: 'action' };
const FLOOR = -20; // log-probability of a letter missing from top_logprobs

// Fitted by `pa eval router --fit` on src/eval/router-cases.json (llama3.2:3b,
// 2026-11-07). Re-fit after changing the prompt or the model.
const CALIBRATION = { T: 0.397, b: { answer_here: -0.46, hand_off: -0.771, action: 0 } };
const THRESHOLD = 0.85;

const ROUTER_SYSTEM = `You route what the user says to their voice assistant. Reply with one letter only.
A = small talk, or a question whose whole answer is written in the snapshot or the conversation (counts, due dates, today's meetings, the time and date, what was just said).
B = a question that needs looking something up that the snapshot does not show: mail, messages, chats, documents, tickets, PRs, past meetings, memory, the web, or details beyond the snapshot's lines.
C = asks for something to be done or changed: send, reply, tell, forward, remind, remember, schedule, book, move, cancel, close, mark, approve, start, draft, merge, set up. Anything the user wants to happen is C, however it is phrased.
If unsure between A and anything else, it is not A.

Examples:
"hey there" -> A
"how many asks are due soon?" -> A
"what's my first meeting tomorrow?" -> A
"what did you say about the overdue ones?" -> A
"perfect, thanks a lot" -> A
"what did the vendor send me yesterday?" -> B
"any news from the release channel?" -> B
"check whether my report got a reply" -> B
"what does the design doc say about caching?" -> B
"look up the ticket for the outage" -> B
"write back to the vendor that we agree" -> C
"get the slides over to my manager" -> C
"put a reminder in for Friday" -> C
"have the factory open a PR for it" -> C
"I want the meeting pushed to Thursday" -> C`;

const clip = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** Pure. The router's user message: snapshot first (cached longest), words last. */
function routerPrompt({ text, context, history }) {
  const conv = (history || [])
    .slice(-2)
    .map((e) => `${e.type === 'user' ? 'user' : 'assistant'}: ${clip(e.text, 200)}`)
    .join('\n');
  return `<snapshot>
${context || '(no snapshot available)'}
</snapshot>

<conversation>
${conv || '(none yet)'}
</conversation>

The user just said: ${JSON.stringify(clip(String(text || ''), 600))}

A, B or C?`;
}

/** Pure. The native Ollama request: one token, its top log-probabilities. */
function routerRequest({ model, text, context, history, keepAlive = null, baseUrl, key = null, topLogprobs = 5 }) {
  const body = {
    model,
    stream: false,
    think: false,
    logprobs: true,
    top_logprobs: topLogprobs,
    options: { temperature: 0, num_predict: 1 },
    messages: [
      { role: 'system', content: ROUTER_SYSTEM },
      { role: 'user', content: routerPrompt({ text, context, history }) },
    ],
  };
  if (keepAlive != null) body.keep_alive = keepAlive;
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return { url: `${String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')}/api/chat`, headers, body };
}

const logsumexp = (xs) => {
  const m = Math.max(...xs);
  return m === -Infinity ? -Infinity : m + Math.log(xs.reduce((s, x) => s + Math.exp(x - m), 0));
};

/**
 * Pure. Ollama's top_logprobs for the first token -> { answer_here, hand_off,
 * action } log-probabilities. Variants of a letter (" A", "a", "A.") are
 * summed; a letter not in the list gets FLOOR. null when no letter is there
 * (the model wrote something else: not a decision).
 */
function letterLogprobs(top) {
  const acc = { answer_here: [], hand_off: [], action: [] };
  let any = false;
  for (const t of top || []) {
    const m = /^\s*([ABC])\W*$/i.exec(String(t.token || ''));
    if (!m || !Number.isFinite(t.logprob)) continue;
    acc[LETTERS[m[1].toUpperCase()]].push(t.logprob);
    any = true;
  }
  if (!any) return null;
  const out = {};
  for (const k of CLASSES) out[k] = acc[k].length ? logsumexp(acc[k]) : FLOOR;
  return out;
}

/** Pure. Calibrated probabilities from letter log-probabilities. */
function calibrate(lp, cal = CALIBRATION) {
  const z = CLASSES.map((k) => lp[k] / cal.T + (cal.b[k] || 0));
  const m = Math.max(...z);
  const e = z.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  const p = {};
  CLASSES.forEach((k, i) => (p[k] = e[i] / s));
  return p;
}

/** Pure. p -> what happens: answer here only above the threshold. */
function decide(p, threshold = THRESHOLD) {
  if (p.answer_here >= threshold) return 'answer';
  return p.action > p.hand_off ? 'action' : 'handoff';
}

/**
 * Scores one turn. -> { p, lp, ms, model } or throws (Ollama down, model
 * missing, no letter in the reply). `post(url, init)` is fetch.
 */
async function score({ text, context = '', history = [], model, keepAlive = null, timeoutMs = 2500, signal = null, cal = CALIBRATION, post = (...a) => fetch(...a), baseUrl = null, key = null }) {
  const bare = String(model || '').replace(/^local\//, '');
  if (baseUrl == null) baseUrl = require('../config.ts').config.providers.local.baseUrl;
  if (key == null) key = require('../models').providerKey('local');
  const req = routerRequest({ model: bare, text, context, history, keepAlive, baseUrl, key });
  const t0 = Date.now();
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await post(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: sig });
  } catch (err) {
    throw new Error(`router: ${err.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : err.cause?.code || err.message}`);
  }
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  if (!res.ok || !json || json.error) throw new Error(`router ${res.status}: ${String(json?.error || raw).slice(0, 200)}`);
  const top = json.logprobs?.[0]?.top_logprobs;
  if (!top) throw new Error('router: no logprobs in the reply (Ollama too old for `logprobs`?)');
  const lp = letterLogprobs(top);
  if (!lp) throw new Error(`router: no A/B/C in the top tokens (${top.slice(0, 3).map((t) => JSON.stringify(t.token)).join(' ')})`);
  return { p: calibrate(lp, cal), lp, ms: Date.now() - t0, model: bare };
}

/**
 * Fills Ollama's prompt cache with what the next turn's router call will
 * start with (system, snapshot, the last two turns, up to the user's words),
 * so that call only pays for the words. Fire and forget: never throws.
 */
function prime(args) {
  return score({ ...args, text: '' }).then(
    (s) => s.ms,
    () => null
  );
}

// ------------------------------------------------------------ fitting ----

/**
 * Pure. Fits { T, b } to labelled letter log-probabilities by gradient
 * descent on the mean negative log-likelihood (b.action is pinned at 0).
 * `rows` is [{ lp, expect: 'answer' | 'handoff' | 'action' }].
 */
function fitCalibration(rows, { iters = 4000, lr = 0.05, l2 = 0.01 } = {}) {
  const idx = { answer: 0, handoff: 1, action: 2 };
  const X = rows.map((r) => CLASSES.map((k) => r.lp[k]));
  const Y = rows.map((r) => idx[r.expect]);
  let invT = 1;
  const b = [0, 0, 0];
  for (let it = 0; it < iters; it++) {
    let gInv = 0;
    const gb = [0, 0, 0];
    for (let i = 0; i < X.length; i++) {
      const z = X[i].map((x, k) => x * invT + b[k]);
      const m = Math.max(...z);
      const e = z.map((v) => Math.exp(v - m));
      const s = e.reduce((a, c) => a + c, 0);
      for (let k = 0; k < 3; k++) {
        const d = e[k] / s - (k === Y[i] ? 1 : 0);
        gInv += d * X[i][k];
        gb[k] += d;
      }
    }
    const n = X.length || 1;
    invT -= lr * (gInv / n + l2 * (invT - 1));
    if (invT < 0.01) invT = 0.01;
    for (let k = 0; k < 2; k++) b[k] -= lr * (gb[k] / n + l2 * b[k]);
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { T: r3(1 / invT), b: { answer_here: r3(b[0]), hand_off: r3(b[1]), action: 0 } };
}

/**
 * Pure. The lowest threshold (a step above the highest p.answer_here of any
 * turn that must not be answered here), so that none of them is: the
 * eval set's "no action-like turn answered locally" by construction, with
 * `margin` to spare. Never below `min`.
 */
function pickThreshold(rows, { margin = 0.05, min = 0.5 } = {}) {
  const worst = Math.max(0, ...rows.filter((r) => r.expect !== 'answer').map((r) => r.p.answer_here));
  return Math.min(0.99, Math.max(min, Math.round((worst + margin) * 100) / 100));
}

module.exports = { CLASSES, CALIBRATION, THRESHOLD, ROUTER_SYSTEM, routerPrompt, routerRequest, letterLogprobs, calibrate, decide, score, prime, fitCalibration, pickThreshold };
