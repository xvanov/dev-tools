'use strict';

// Prompts that turn captured items into eval questions, and the checks on what
// comes back. Pure: no database, no model — seed.js does the I/O.
//
// The failure these prompts are written against is the *keyword-matchable*
// question: one that quotes the subject line, so lexical search finds it by
// construction and the case measures nothing. A real question is asked weeks
// later from memory, in your own words, and the eval is only as honest as its
// questions are like that.

const SYSTEM = `You write evaluation questions for a personal memory assistant.

The assistant indexes one person's working life — mail, Teams chats, calendar, pull requests,
issues, notifications, recorded meetings and their own coding-agent sessions. Later, that person
asks it questions. You are shown items from the store and write the question they would
realistically ask weeks later, plus the answer the items support.

Rules for every question:
- Short: one sentence, at most about 20 words — what you would type into a search box or ask a
  colleague, not a summary of the item. Do not restate the item's details to set up the question.
- Ask from vague memory, in plain words. Paraphrase. Never copy the subject line, a title, a
  distinctive phrase, an id, a PR or ticket number, a branch or file name verbatim.
- At most one or two specific names or terms (a person, team, product or system someone would
  naturally remember); leave the rest of the item's vocabulary out.
- Be specific enough that only these items (or very few) answer it. "What did we decide?" is
  useless; "What did we land on for how retries should back off in the sync job?" is good.
- The answer must actually be stated in the items. Never ask something they do not answer.
- No relative dates in the question ("yesterday", "last week"): the question may be asked months
  from now. Absolute dates in answers.
- Ask in the first person, as the owner of the data ("did I", "what did Brannoc ask me").
- If the items are noise (automated notifications with no substance, empty bodies) set "skip".

Reply with JSON only.`;

const SHAPE = `{"skip": false, "question": "...", "answer": "...", "why": "one line: what makes this a fair test"}`;

const QTYPE_BRIEF = {
  single_session: `Write ONE question answerable from this single item — a fact, a decision, a request,
a number, a reason. Prefer the substantive content (asks, commitments, decisions) over boilerplate.`,

  temporal: `Write ONE question about WHEN something happened, is due, or is scheduled
("When did ...", "What date is ...", "Was X before or after Y"). The answer must contain the
absolute date (and time if it matters) taken from the item. Do not put the date in the question.`,

  knowledge_update: `These items are from one thread, earliest first. Find something the LATER item
changes, corrects, supersedes or resolves relative to the EARLIER one (a new date, a changed
decision, a status that moved, a reviewer's ask that was addressed). Write ONE question whose
correct answer is the CURRENT state from the later item — someone who only read the earlier item
would answer it wrongly. Put the old value in "why". If nothing changes, set "skip": true.`,

  multi_session: `These items are separate conversations that share a person or project. Write ONE
question that needs information from at least two of them to answer fully — an aggregation
("what has Quill asked me for across ...", "how many ...", "which of ...") or a connection between
them. The answer must cite what comes from each item. If they share nothing meaningful, set
"skip": true. Also return "uses": [ids of the items the answer needs].`,
};

function clip(text, max) {
  const t = String(text || '').replace(/\s+\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max)}\n[...truncated]` : t;
}

function renderItem(item, { maxChars = 5000 } = {}) {
  const when = item.occurred_at ? new Date(item.occurred_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '?';
  const head = `### item #${item.id} · ${item.source} · ${when}\nsubject: ${item.subject || '(none)'}`;
  const derived = [
    ...(item.commitments || []).map((c) => `- commitment: ${c}`),
    ...(item.facts || []).map((f) => `- fact: ${f}`),
  ];
  return [head, derived.length ? `distilled:\n${derived.join('\n')}` : null, `body:\n${clip(item.body_text, maxChars)}`]
    .filter(Boolean)
    .join('\n');
}

function casePrompt(qtype, items, { now = new Date() } = {}) {
  const brief = QTYPE_BRIEF[qtype];
  if (!brief) throw new Error(`no prompt for qtype ${qtype}`);
  const per = items.length > 1 ? 3000 : 6000;
  return [
    `Today is ${now.toISOString().slice(0, 10)}.`,
    '',
    brief,
    '',
    items.map((it) => renderItem(it, { maxChars: per })).join('\n\n'),
    '',
    `Reply with JSON: ${qtype === 'multi_session' ? SHAPE.replace('"why"', '"uses": [], "why"') : SHAPE}`,
  ].join('\n');
}

// Abstention: plausible questions about things that are NOT in the store. The
// model sees subject lines only, to pitch questions at the right domain, and
// names the one distinctive term an answer would have to contain — that term
// is what the lexical absence check looks for.
function abstentionPrompt(subjects, count) {
  return [
    `Here are subject lines from the store, to show what this person's work is about:`,
    subjects.map((s) => `- ${s}`).join('\n'),
    '',
    `Write ${count} questions this person might plausibly ask that these items would NOT answer:`,
    `same working world, but about a meeting, decision, person, system, incident or request that`,
    `is not in this list. Vary them: some near-misses (a neighbouring topic), some different areas.`,
    `For each, give "term": ONE distinctive word (a name, product, system or noun — not a common`,
    `verb) that any item answering the question would have to contain.`,
    '',
    `Reply with JSON: {"questions": [{"question": "...", "term": "..."}]}`,
  ].join('\n');
}

// Validates and normalises a generation reply. Returns null for a skip or for
// anything malformed; never throws, because one bad reply must not end a seed.
function parseCaseReply(reply, { qtype, itemIds = [] } = {}) {
  if (!reply || typeof reply !== 'object' || reply.skip) return null;
  const question = String(reply.question || '').trim();
  const answer = String(reply.answer || '').trim();
  if (question.length < 12 || !answer) return null;
  let gold = itemIds;
  if (qtype === 'multi_session' && Array.isArray(reply.uses)) {
    const allowed = new Set(itemIds.map(String));
    const used = reply.uses.map(String).filter((id) => allowed.has(id));
    if (used.length < 2) return null;
    gold = used.map(Number);
  }
  return { question, answer, gold: gold.map(Number), why: reply.why ? String(reply.why).slice(0, 400) : null };
}

// The cheap guard against keyword-matchable questions: how much of the
// question's vocabulary is lifted from the item's subject line. A question that
// is mostly the subject is a lexical lookup wearing a disguise.
function subjectOverlap(question, subject) {
  const words = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3)
    );
  const q = words(question);
  const subj = words(subject);
  if (!q.size || !subj.size) return 0;
  let shared = 0;
  for (const w of q) if (subj.has(w)) shared++;
  return shared / q.size;
}

// How many cases of each qtype a seed of n asks for. Single-session gets the
// largest share because it is the floor everything else stands on.
const MIX = { single_session: 0.34, multi_session: 0.16, temporal: 0.16, knowledge_update: 0.17, abstention: 0.17 };

function allocate(n) {
  const out = {};
  let left = n;
  const keys = Object.keys(MIX);
  for (const k of keys.slice(1)) {
    out[k] = Math.round(n * MIX[k]);
    left -= out[k];
  }
  out[keys[0]] = Math.max(0, left);
  return out;
}

// Spreads a weighted-random candidate list across sources and weeks: round-
// robin over sources, and within a source prefer a week not yet used. Without
// it, sixty cases come out as fifty GitHub notifications from one Tuesday.
function spread(candidates, n) {
  const bySource = new Map();
  for (const c of candidates) {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source).push(c);
  }
  const weekOf = (c) => Math.floor(new Date(c.occurred_at).getTime() / (7 * 86400_000));
  const usedWeeks = new Map();
  const picked = [];
  const sources = [...bySource.keys()];
  while (picked.length < n && sources.some((s) => bySource.get(s).length)) {
    for (const s of sources) {
      if (picked.length >= n) break;
      const list = bySource.get(s);
      if (!list.length) continue;
      const weeks = usedWeeks.get(s) || new Set();
      let idx = list.findIndex((c) => !weeks.has(weekOf(c)));
      if (idx < 0) idx = 0;
      const [c] = list.splice(idx, 1);
      weeks.add(weekOf(c));
      usedWeeks.set(s, weeks);
      picked.push(c);
    }
  }
  return picked;
}

const ANSWER_SYSTEM = `You answer a question using only the retrieved items you are given. Be brief:
one or two sentences. If the items do not contain the answer, reply exactly: UNKNOWN`;

function answerPrompt(question, items) {
  return [
    items.length ? items.map((it) => renderItem(it, { maxChars: 1500 })).join('\n\n') : '(no items retrieved)',
    '',
    `Question: ${question}`,
  ].join('\n');
}

const GRADE_SYSTEM = `You grade answers against a reference. An answer is correct if it states the
same essential fact as the reference (wording, extra detail and formatting do not matter; a wrong
date, person or value does). Where the reference is NONE, the question has no answer in the data:
the answer is correct only if it says it does not know (e.g. UNKNOWN). Reply with JSON only.`;

function gradePrompt(rows) {
  return [
    'Grade each row.',
    JSON.stringify(rows.map((r) => ({ i: r.i, question: r.question, reference: r.reference ?? 'NONE', answer: r.answer }))),
    '',
    'Reply with JSON: {"grades": [{"i": 0, "correct": true}]}',
  ].join('\n');
}

module.exports = {
  SYSTEM,
  QTYPE_BRIEF,
  ANSWER_SYSTEM,
  GRADE_SYSTEM,
  renderItem,
  casePrompt,
  abstentionPrompt,
  parseCaseReply,
  subjectOverlap,
  allocate,
  spread,
  answerPrompt,
  gradePrompt,
};
