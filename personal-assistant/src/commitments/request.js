'use strict';

// A task you asked for in so many words: `pa task add "…"`, the PA chat's
// `task_add` tool when you tell it "create a task…", or the board's + task box.
//
// The one path that writes a commitment without the distiller. It is still a
// `source_item` (source `pa_request`, author `me`, the words as typed) so the
// card has something to point at, search finds it, and nothing downstream
// needs a special case. The distiller never reads these items
// (sourcePolicy.DIRECT): the commitment is written here, whole.
//
//   parse({text, due, for, owedToMe, project}, now)  pure: validate and resolve the due date
//   add(opts)                                       write it; returns the new commitment

const crypto = require('crypto');
const { parseWhen } = require('../util/when');

const SOURCE = 'pa_request';
const EXTRACTED_BY = 'pa-request-v1';
const MAX_TEXT = 500;
const VIAS = new Set(['cli', 'chat', 'board']);

const USAGE = 'usage: pa task add "<what>" [--due <when>] [--for <person>] [--owed-to-me] [--project <name>]';

function fail(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Pure. What was asked for, checked: {summary, detail, dueAt, direction, forName, project}.
 * `due` takes what src/util/when.js reads ("friday", "tomorrow 3pm", "2d",
 * "2026-11-20"), with an optional leading "by".
 */
function parse({ text, due = null, for: forName = null, owedToMe = false, project = null } = {}, now = new Date()) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!words) throw fail(`what is the task? ${USAGE}`);
  if (words.length > MAX_TEXT) throw fail(`a task is one line (${MAX_TEXT} characters at most); put the rest in the conversation`);
  let dueAt = null;
  if (due != null && due !== true && String(due).trim()) {
    const w = parseWhen(String(due).trim().replace(/^by\s+/i, ''), now);
    if (!w) throw fail(`cannot read the due date "${String(due).slice(0, 60)}" — try friday, tomorrow 3pm, 2d or 2026-11-20`);
    dueAt = w.at;
  }
  const who = forName != null && forName !== true ? String(forName).trim() : '';
  if (owedToMe && !who) throw fail('--owed-to-me needs --for <person>: who owes it to you?');
  const proj = project != null && project !== true ? String(project).trim() : '';
  return {
    summary: words.length > 200 ? `${words.slice(0, 197)}…` : words,
    detail: words.length > 200 ? words : null,
    dueAt,
    direction: owedToMe ? 'owed_to_me' : 'owed_by_me',
    forName: who || null,
    project: proj || null,
  };
}

// A person by address, or by a name that matches exactly one person (whole
// name first, then the start of one). Never creates a person from a bare name.
async function findPerson(name) {
  if (!name) return null;
  const identity = require('../distill/identity');
  if (name.includes('@')) return identity.resolve(name, name);
  const repo = require('../repo');
  const exact = await repo.people.othersByExactName(name);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const prefix = await repo.people.othersByNamePrefix(name.replace(/[\\%_]/g, (c) => `\\${c}`));
  return prefix.length === 1 ? prefix[0].id : null;
}

/**
 * Writes the task. `via` says where you asked (cli, chat, board).
 * @returns {Promise<{id: number, itemId: number, summary, direction, dueAt, who: string|null, personFound: boolean, project: string|null}>}
 */
async function add(opts = {}, { now = new Date() } = {}) {
  const t = parse(opts, now);
  const via = VIAS.has(opts.via) ? opts.via : 'cli';
  const { saveItems } = require('../ingest/store');
  const repo = require('../repo');

  let projectRow = null;
  if (t.project) {
    projectRow = await require('../projects').byName(t.project);
    if (!projectRow) throw fail(`no project "${t.project.slice(0, 60)}" — \`pa projects\` lists them`);
  }
  const personId = await findPerson(t.forName);

  const externalId = `${via}:${now.toISOString()}:${crypto.randomBytes(4).toString('hex')}`;
  await saveItems(SOURCE, [
    {
      externalId,
      occurredAt: now,
      authorIdentity: 'me',
      subject: 'Task you asked for',
      bodyText: [t.summary, t.detail && t.detail !== t.summary ? t.detail : null].filter(Boolean).join('\n\n'),
      raw: { via, for: t.forName, owedToMe: t.direction === 'owed_to_me', due: opts.due || null, project: projectRow?.name || null },
    },
  ]);
  const item = await repo.sources.idByExternal(SOURCE, externalId);
  const detail = [t.detail, t.forName && !personId ? `${t.direction === 'owed_to_me' ? 'From' : 'For'}: ${t.forName}` : null]
    .filter(Boolean)
    .join('\n') || null;
  const row = await repo.withTx((r) =>
    r.commitments.insertRequested({
      itemId: item.id,
      direction: t.direction,
      summary: t.summary,
      detail,
      personId,
      dueAt: t.dueAt,
      projectId: projectRow?.id ?? null,
      repoPath: projectRow?.repo_path ?? null,
      projectConfidence: projectRow ? 1 : null,
      projectRationale: projectRow ? 'named when the task was created' : null,
      extractedBy: EXTRACTED_BY,
    })
  );
  return {
    id: Number(row.id),
    itemId: Number(item.id),
    summary: t.summary,
    direction: t.direction,
    dueAt: t.dueAt,
    who: t.forName,
    personFound: Boolean(personId),
    project: projectRow?.name || null,
  };
}

/** Pure. One line saying what was created. */
function describe(r) {
  const parts = [`task #${r.id}: ${r.summary}`];
  if (r.direction === 'owed_to_me') parts.push(`owed to you by ${r.who}`);
  else if (r.who) parts.push(`for ${r.who}`);
  if (r.who && !r.personFound) parts.push('(no single person by that name — kept as text)');
  if (r.dueAt) parts.push(`due ${new Date(r.dueAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
  if (r.project) parts.push(`in ${r.project}`);
  return `${parts.join(' · ')}. On the board now; \`pa done ${r.id} --dismiss\` removes it.`;
}

module.exports = { parse, add, describe, findPerson, SOURCE, EXTRACTED_BY, USAGE, MAX_TEXT };
