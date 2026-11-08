'use strict';

// `pa eval answerer`: the fast lane's answerer (src/chat/fastLane.ts, the
// words spoken once the router lets it answer) against its eval set
// (src/eval/answerer-cases.json). The router eval asks "may it answer?"; this
// one asks "is what it says true to the snapshot?": the right day, every
// meeting, titles kept as titles (8.4.1-8.4.2). It also times what the voice
// waits for: the first token and the first piece the page would speak.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Case = {
  id: string;
  now: string;
  meetings: [number, string, boolean?][];
  text: string;
  times?: string[];
  anyTimes?: string[];
  notToday?: string[];
  empty?: boolean;
  noTimes?: boolean;
};

const path = require('path');

function loadCases(file: string = path.join(__dirname, 'answerer-cases.json')): { cases: Case[] } {
  return require(file);
}

/** Pure. A case's snapshot, built by the real formatter from its local `now` and meeting minutes. */
function caseSnapshot(c: Case) {
  const F = require('../chat/fastLane.ts');
  const now = new Date(c.now);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const meetings = c.meetings.map(([min, subject, cancelled]) => ({
    subject,
    occurred_at: new Date(midnight + min * 60_000).toISOString(),
    raw: cancelled ? { isCancelled: true } : {},
  }));
  return { now: now.getTime(), context: F.formatSnapshot({ commitments: [], meetings, runsActive: [], runsReview: [] }, { now: now.getTime() }) };
}

/** Pure. The clock times in spoken text, as HH:MM: "10:00", "10 am", "11:30 a.m.", "3pm". */
function spokenTimes(text: string) {
  const out = new Set<string>();
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || '')))) {
    if (!m[2] && !m[3]) continue; // a bare number is a count, not a time
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) continue;
    out.add(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure. One answer against its case -> the checks that failed (empty when it passed). */
function checkAnswer(c: Case, said: string) {
  const fails: string[] = [];
  const times = spokenTimes(said);
  for (const t of c.times || []) if (!times.has(t)) fails.push(`left out the ${t} meeting`);
  if (c.anyTimes && !c.anyTimes.some((t) => times.has(t))) fails.push(`named none of ${c.anyTimes.join(', ')}`);
  const day = new Date(new Date(c.now).getTime() + 86400_000).toLocaleDateString('en-GB', { weekday: 'long' });
  const saysTomorrow = new RegExp(`\\b(tomorrow|${day})\\b`, 'i').test(said);
  for (const t of c.notToday || []) if (times.has(t) && !saysTomorrow) fails.push(`spoke tomorrow's ${t} as today's`);
  if (c.empty && !/\b(nothing|no (more |other )?meetings?|none|free|clear|no more)\b/i.test(said)) fails.push('did not say nothing is left today');
  if (c.noTimes && times.size) fails.push(`spoke a time (${[...times].join(', ')}) nobody asked for`);
  if (/^\s*-\s|Meetings (?:today|tomorrow) \(|\buntil \d\d:\d\d\b/m.test(said)) fails.push('read the snapshot out instead of speaking');
  if (/Budget check|Lunch talk/i.test(said)) fails.push("spoke the prompt's example as if it were the user's day");
  for (const [min, subject, cancelled] of c.meetings) {
    const hhmm = `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    if (cancelled && times.has(hhmm) && !/cancel/i.test(said)) fails.push(`did not say "${subject}" is cancelled`);
  }
  for (const [, subject] of c.meetings) {
    const first = subject.replace(/^cancell?ed:\s*/i, '').split(/\s+/)[0] || '';
    // "starts with the standup" names the meeting; "a meeting with the team" invents who is in it.
    const withTitle = new RegExp(`(?<!\\b(?:starts?|starting|begins?|beginning|opens?|off)\\s+)\\bwith\\s+(?:the\\s+|your\\s+)?["“']?${escape(first)}\\b`, 'i');
    if (first && withTitle.test(said)) fails.push(`made the title "${subject}" into who it is with`);
  }
  return fails;
}

/** Pure. The opening the voice can speak first: its word count. */
function openerWords(said: string) {
  const first = (String(said || '').match(/^[^.!?]*[.!?]?/) || [''])[0] as string;
  return first.trim().split(/\s+/).filter(Boolean).length;
}

const quantile = (xs: number[], q: number) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};

/**
 * Runs every case `repeat` times through the answerer as the fast lane calls
 * it (its system prompt and user prompt; `stream` is llm.stream) and checks
 * each answer. One untimed warm-up first.
 */
async function runCases({ model, keepAlive = '24h', repeat = 1, progress = () => {}, stream = null }: { model: string; keepAlive?: string; repeat?: number; progress?: (r: Json) => void; stream?: any }) {
  const F = require('../chat/fastLane.ts');
  const C = require('../dashboard/talk.core.js');
  const s = stream || require('../llm.ts').stream;
  const system = F.replySystem({ route: 'answer' });
  const say = async (text: string, context: string) => {
    const t0 = Date.now();
    const words = C.createUtteranceStream({ firstClause: true });
    let full = '';
    let firstToken: number | null = null;
    let firstPiece: number | null = null;
    for await (const piece of s({ system, prompt: F.userPrompt({ text, context, history: [] }), model, maxTokens: 300, timeoutMs: 20_000, purpose: 'eval', keepAlive })) {
      if (firstToken == null) firstToken = Date.now() - t0;
      full += piece;
      if (firstPiece == null && words.push(full).length) firstPiece = Date.now() - t0;
    }
    if (firstPiece == null) firstPiece = Date.now() - t0;
    return { said: full.trim(), firstToken, firstPiece, ms: Date.now() - t0 };
  };
  const set = loadCases();
  await say('hello', caseSnapshot(set.cases[0] as Case).context);
  const rows: Json[] = [];
  for (const c of set.cases) {
    const { context } = caseSnapshot(c);
    for (let k = 0; k < repeat; k++) {
      const r = await say(c.text, context);
      const row = { id: c.id, text: c.text, ...r, fails: checkAnswer(c, r.said), opener: openerWords(r.said) };
      rows.push(row);
      progress(row);
    }
  }
  return rows;
}

function report(rows: Json[], { out = console.log, verbose = false }: { out?: (s: string) => void; verbose?: boolean } = {}) {
  const ok = rows.filter((r) => !r.fails.length).length;
  out(`answerer eval · ${rows.length} answers · ${ok} pass (${rows.length ? Math.round((100 * ok) / rows.length) : 0}%)`);
  for (const r of rows) if (r.fails.length || verbose) out(`  ${r.fails.length ? 'FAIL' : 'ok  '} ${r.id}: ${r.fails.join('; ') || ''}${verbose || r.fails.length ? `\n       "${r.said}"` : ''}`);
  const lat = (k: string) => `p50 ${quantile(rows.map((r) => r[k]), 0.5)} ms`;
  out(`  first token ${lat('firstToken')} · first spoken piece ${lat('firstPiece')} · whole answer ${lat('ms')} · opening sentence ${quantile(rows.map((r) => r.opener), 0.5)} words (p50)`);
  return { n: rows.length, ok };
}

module.exports = { loadCases, caseSnapshot, spokenTimes, checkAnswer, openerWords, runCases, report };
