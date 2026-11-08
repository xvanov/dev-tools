'use strict';

// `pa eval router`: the fast lane's router (src/chat/fastRouter.js) against
// its eval set (src/eval/router-cases.json). Reports accuracy, the turns that
// must not be answered here but would be, and the router's latency warm.
// --fit re-fits the calibration and the threshold on the same set and prints
// the constants to paste into fastRouter.js.

const path = require('path');
const R = require('../chat/fastRouter');

const RAW = { T: 1, b: { answer_here: 0, hand_off: 0, action: 0 } };

function loadCases(file = path.join(__dirname, 'router-cases.json')) {
  return require(file);
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
}

/**
 * Pure. Scored rows ({ text, expect, lp, ms }) under one calibration and
 * threshold -> metrics. `guard` is the fast lane's looksLikeAction: a turn
 * the router would answer but that reads as an action is handed off.
 */
function evaluate(rows, { cal, threshold, guard = () => false }) {
  const out = { n: rows.length, correct: 0, localCorrect: 0, answeredNonAnswer: [], answeredAction: [], answeredActionRouter: [], missedAnswers: 0, perCase: [] };
  for (const r of rows) {
    const p = R.calibrate(r.lp, cal);
    let route = R.decide(p, threshold);
    const routerRoute = route;
    if (route === 'answer' && guard(r.text)) route = 'action';
    const ok = route === r.expect;
    if (ok) out.correct++;
    if ((route === 'answer') === (r.expect === 'answer')) out.localCorrect++;
    if (route === 'answer' && r.expect !== 'answer') out.answeredNonAnswer.push(r);
    if (route === 'answer' && r.expect === 'action') out.answeredAction.push(r);
    if (routerRoute === 'answer' && r.expect === 'action') out.answeredActionRouter.push(r);
    if (r.expect === 'answer' && route !== 'answer') out.missedAnswers++;
    out.perCase.push({ ...r, p, route, routerRoute, ok });
  }
  out.answers = rows.filter((r) => r.expect === 'answer').length;
  return out;
}

/** Leave-one-out accuracy of fit + threshold: how it does on turns it was not fitted on. */
function leaveOneOut(rows, guard) {
  let correct = 0;
  let answeredAction = 0;
  let answeredNonAnswer = 0;
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, j) => j !== i);
    const cal = R.fitCalibration(train, { iters: 1500 });
    const threshold = R.pickThreshold(train.map((r) => ({ ...r, p: R.calibrate(r.lp, cal) })));
    const e = evaluate([rows[i]], { cal, threshold, guard });
    correct += e.correct;
    answeredAction += e.answeredAction.length;
    answeredNonAnswer += e.answeredNonAnswer.length;
  }
  return { correct, n: rows.length, answeredAction, answeredNonAnswer };
}

/**
 * Scores every case against the local model. One untimed warm-up first (the
 * model load and the system prompt's cache), then each case `repeat` times;
 * the latency is every call, the log-probabilities the first.
 */
async function scoreCases({ model, keepAlive = '24h', repeat = 1, progress = () => {}, score = R.score } = {}) {
  const set = loadCases();
  await score({ text: 'hello', context: set.snapshot, model, keepAlive, timeoutMs: 60_000 });
  const rows = [];
  const ms = [];
  for (const c of set.cases) {
    let first = null;
    for (let k = 0; k < repeat; k++) {
      const s = await score({ text: c.text, context: set.snapshot, history: c.history || [], model, keepAlive, cal: RAW, timeoutMs: 10_000 });
      ms.push(s.ms);
      if (!first) first = s;
    }
    const row = { text: c.text, expect: c.expect, origin: c.origin, lp: first.lp, ms: first.ms };
    rows.push(row);
    progress(row);
  }
  return { rows, ms };
}

function report({ rows, ms }, { cal, threshold, guard, fit = false, out = console.log, misses = false }) {
  const lines = [];
  const say = (s) => lines.push(s);
  const raw = evaluate(rows, { cal: RAW, threshold: 0.5, guard: () => false });
  let usedCal = cal;
  let usedThreshold = threshold;
  if (fit) {
    usedCal = R.fitCalibration(rows);
    usedThreshold = R.pickThreshold(rows.map((r) => ({ ...r, p: R.calibrate(r.lp, usedCal) })));
  }
  const e = evaluate(rows, { cal: usedCal, threshold: usedThreshold, guard });
  const byExpect = (x) => rows.filter((r) => r.expect === x).length;
  say(`router eval · ${rows.length} turns (${byExpect('answer')} answer, ${byExpect('handoff')} handoff, ${byExpect('action')} action) · calibration T=${usedCal.T} b=${JSON.stringify(usedCal.b)} · threshold p(answer_here) >= ${usedThreshold}${fit ? ' (fitted on this set)' : ''}`);
  say(`  raw argmax (no calibration, no guard): ${pct(raw.correct, raw.n)} correct, ${raw.answeredAction.length} action and ${raw.answeredNonAnswer.length} non-answer turns answered here`);
  say(`  routed: ${pct(e.correct, e.n)} correct (3-way), ${pct(e.localCorrect, e.n)} on answer-here vs Jarvis`);
  say(`  answered here but should not be: ${e.answeredNonAnswer.length} (actions: ${e.answeredAction.length}; by the router alone, before the action guard: ${e.answeredActionRouter.length})`);
  say(`  answerable turns handed to Jarvis anyway: ${e.missedAnswers} of ${e.answers}`);
  if (fit) {
    const loo = leaveOneOut(rows, guard);
    say(`  leave-one-out (fit without the turn): ${pct(loo.correct, loo.n)} correct, ${loo.answeredAction} actions and ${loo.answeredNonAnswer} non-answer turns answered here`);
    say(`  constants for src/chat/fastRouter.js: CALIBRATION = ${JSON.stringify(usedCal)}; THRESHOLD = ${usedThreshold}`);
  }
  say(`  latency warm (${ms.length} calls): p50 ${quantile(ms, 0.5)} ms · p95 ${quantile(ms, 0.95)} ms · max ${Math.max(...ms)} ms`);
  if (misses) {
    for (const c of e.perCase.filter((x) => !x.ok)) {
      say(`  miss: expect ${c.expect.padEnd(7)} got ${c.route.padEnd(7)} p=${['answer_here', 'hand_off', 'action'].map((k) => c.p[k].toFixed(2)).join('/')} ${JSON.stringify(c.text.slice(0, 80))}`);
    }
  }
  for (const l of lines) out(l);
  return { metrics: e, cal: usedCal, threshold: usedThreshold, latency: { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), max: Math.max(...ms) } };
}

module.exports = { loadCases, evaluate, leaveOneOut, scoreCases, report, quantile, RAW };
