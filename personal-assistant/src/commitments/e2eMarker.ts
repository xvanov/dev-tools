'use strict';

// An e2e run's card carries `e2e-<uuid>` in its ask, its title and its card
// text (goldenPathCore.dummyCard). It is not the owner's work. The blocker
// pass must not be shown it as a task, the context pass must not write it up,
// and a stored verdict that cites one — by id, by the marker, or by a phrase
// of that ask or title — is ignored when the board reads it (8.4.53). The row
// stays; a later pass can judge the real tasks without it.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, unknown>;
type Q = { rows: (sql: string, params?: unknown[]) => Promise<Row[]> };

/** The golden-path marker, `e2e-<uuid>` (goldenPathCore MARKER_RE). */
const MARKER = /\be2e-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function carriesMarker(...parts: unknown[]): boolean {
  return parts.some((p) => p != null && p !== '' && MARKER.test(String(p)));
}

function norm(s: unknown): string {
  return String(s ?? '')
    .replace(MARKER, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Three-word phrases of an e2e card's ask or title, marker stripped. Short ones are dropped. */
function phrases(text: unknown): string[] {
  const words = norm(text).split(' ').filter((w) => w.length >= 2);
  const out: string[] = [];
  for (let i = 0; i + 2 < words.length; i++) {
    const phrase = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    if (phrase.length >= 12) out.push(phrase);
  }
  return out;
}

/** The why names an e2e card when a phrase of its ask or title is in it. */
function citesPhrase(why: unknown, texts: string[]): boolean {
  const w = norm(why);
  if (!w) return false;
  for (const t of texts) {
    for (const p of phrases(t)) if (w.includes(p)) return true;
  }
  return false;
}

/**
 * A stored verdict cites an e2e card: its blocker or task is one, its why
 * carries the marker, or its why repeats a phrase of the card's ask or title.
 */
function verdictCites(row: { blocker_id?: unknown; task_id?: unknown; why?: unknown }, ids: Set<string>, texts: string[]): boolean {
  if (row.blocker_id != null && ids.has(String(row.blocker_id))) return true;
  if (row.task_id != null && ids.has(String(row.task_id))) return true;
  if (carriesMarker(row.why)) return true;
  return citesPhrase(row.why, texts);
}

/** Commitments and run asks that carry the marker. Ids, and the texts a verdict might quote. */
async function marked(db: Q): Promise<{ ids: Set<string>; texts: string[] }> {
  const cards = await db.rows(
    `select id, summary, detail from commitment where summary like '%e2e-%' or coalesce(detail, '') like '%e2e-%'`
  );
  const asks = await db.rows(`select commitment_id as id, task as ask from run where task like '%e2e-%'`);
  const ids = new Set<string>();
  const texts: string[] = [];
  for (const c of cards) {
    if (!carriesMarker(c.summary, c.detail)) continue;
    ids.add(String(c.id));
    if (c.summary) texts.push(String(c.summary));
    if (c.detail) texts.push(String(c.detail));
  }
  for (const a of asks) {
    if (!carriesMarker(a.ask)) continue;
    if (a.id != null) ids.add(String(a.id));
    texts.push(String(a.ask));
  }
  return { ids, texts };
}

/** Drop rows whose commitment id is an e2e card. */
async function omitCards<T extends { id?: unknown }>(db: Q, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const { ids } = await marked(db);
  if (!ids.size) return rows;
  return rows.filter((r) => !ids.has(String(r.id)));
}

/** Drop verdicts that cite an e2e card. */
async function omitVerdicts<T extends { blocker_id?: unknown; task_id?: unknown; why?: unknown }>(db: Q, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const { ids, texts } = await marked(db);
  if (!ids.size && !texts.length) return rows;
  return rows.filter((r) => !verdictCites(r, ids, texts));
}

module.exports = { MARKER, carriesMarker, phrases, citesPhrase, verdictCites, marked, omitCards, omitVerdicts };
