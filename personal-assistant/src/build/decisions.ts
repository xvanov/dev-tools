'use strict';

// The decision queue's data shapes (BUILD-ENRICHMENT D): a structured `pa run ask` is several questions
// in one build_msg ask, each with options and/or free text, answered in one reply.
//
//   ask body      {"decisions":1,"questions":[{id,text,options?,allowFree}]}   (a plain ask stays plain text)
//   answer        {"answers":{"<id>":"<text>"},"text":"<free-text reply, when it was not mapped>"}
//
// Pure: no repo, no clock. messages.ts stores and waits; the board, the chat tool and `pa run reply` all
// come through answerFrom, so one set of rules decides what a valid answer is.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Question = { id: string; text: string; options: string[]; allowFree: boolean };
type Answers = { answers: Record<string, string>; text: string | null };

const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 12;
const MAX_TEXT = 500;
const MAX_OPTION = 200;
const MAX_ANSWER = 2000;

/** What the agent wrote (the --json file, or the --q/--option flags) as validated questions; throws a plain message. */
function normalize(input: unknown): Question[] {
  const list = Array.isArray(input) ? input : (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list) || !list.length) throw new Error('give at least one question: {"questions":[{"id":"db","text":"Which database?","options":["sqlite","postgres"]}]}');
  if (list.length > MAX_QUESTIONS) throw new Error(`at most ${MAX_QUESTIONS} questions in one ask; keep the rest for later`);
  const seen = new Set<string>();
  return list.map((raw: unknown, i: number) => {
    const q = (raw && typeof raw === 'object' ? raw : { text: raw }) as Record<string, unknown>;
    const text = String(q.text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) throw new Error(`question ${i + 1} has no text`);
    const id = String(q.id ?? `q${i + 1}`).trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `q${i + 1}`;
    if (seen.has(id)) throw new Error(`two questions share the id "${id}"`);
    seen.add(id);
    const rawOptions = q.options == null ? [] : q.options;
    if (!Array.isArray(rawOptions)) throw new Error(`question "${id}": options must be a list of strings`);
    const options = [...new Set(rawOptions.map((o) => String(o).trim().slice(0, MAX_OPTION)).filter(Boolean))].slice(0, MAX_OPTIONS);
    // No options means free text is the only way to answer.
    const allowFree = options.length ? q.allowFree !== false : true;
    return { id, text, options, allowFree };
  });
}

/** The ask body for a structured ask. */
function encode(questions: Question[]): string {
  return JSON.stringify({ decisions: 1, questions });
}

/** The questions of an ask body, or null when it is a plain text ask. */
function decode(body: unknown): Question[] | null {
  const s = String(body ?? '');
  if (!s.startsWith('{"decisions":1')) return null;
  try { return normalize(JSON.parse(s)); } catch { return null; }
}

/**
 * The stored answer for a structured ask, from per-question `answers` and/or a free-text reply. A text with
 * no answers maps onto a lone question and otherwise travels as it is, for the agent to read. Option-only
 * questions refuse anything that is not one of their options (matched ignoring case).
 */
function answerFrom(questions: Question[], input: { answers?: unknown; text?: unknown }): Answers {
  const given = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? (input.answers as Record<string, unknown>) : {};
  const answers: Record<string, string> = {};
  for (const [id, v] of Object.entries(given)) {
    const q = questions.find((x) => x.id === id);
    if (!q) throw new Error(`no question "${id}" in this ask (ids: ${questions.map((x) => x.id).join(', ')})`);
    let a = String(v ?? '').trim().slice(0, MAX_ANSWER);
    if (!a) continue;
    const opt = q.options.find((o) => o.toLowerCase() === a.toLowerCase());
    if (opt) a = opt;
    else if (!q.allowFree) throw new Error(`question "${id}" takes one of: ${q.options.join(' | ')}`);
    answers[id] = a;
  }
  let text = String(input.text ?? '').trim().slice(0, MAX_ANSWER) || null;
  if (text && !Object.keys(answers).length && questions.length === 1) {
    const only = questions[0] as Question;
    const opt = only.options.find((o) => o.toLowerCase() === (text as string).toLowerCase());
    if (!opt && !only.allowFree) throw new Error(`question "${only.id}" takes one of: ${only.options.join(' | ')}`);
    answers[only.id] = opt || text;
    text = null;
  }
  if (!Object.keys(answers).length && !text) throw new Error('answer at least one question (answers: {"<id>": "<answer>"}) or give a text');
  return { answers, text };
}

/** Parses a stored answer; null when it is not one (a plain ask's answer is plain text). */
function parseAnswer(stored: unknown): Answers | null {
  try {
    const j = JSON.parse(String(stored));
    if (j && typeof j === 'object' && j.answers && typeof j.answers === 'object') return { answers: j.answers, text: j.text ?? null };
  } catch { /* plain text */ }
  return null;
}

/** What the agent reads: each question with its answer, then the same as one JSON line it can parse. */
function readable(questions: Question[], a: Answers): string {
  const lines = questions.map((q) => `${q.id}: ${q.text}\n  -> ${a.answers[q.id] ?? '(no answer: decide yourself, the safest choice, and note it)'}`);
  if (a.text) lines.push(`Free-text reply: ${a.text}`);
  lines.push(`JSON: ${JSON.stringify({ answers: a.answers, ...(a.text ? { text: a.text } : {}) })}`);
  return lines.join('\n');
}

/** The questions as one plain list, for a notice or a chat line. */
function summary(questions: Question[]): string {
  return questions.map((q) => `${q.id}: ${q.text}${q.options.length ? ` [${q.options.join(' | ')}]` : ''}`).join('\n');
}

module.exports = { normalize, encode, decode, answerFrom, parseAnswer, readable, summary, MAX_QUESTIONS };
