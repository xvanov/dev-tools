'use strict';

// SQLite twin of src/repo/evals.js (eval_case, eval_run, and the corpus
// samples the seeder draws from). Differences from Postgres, stated:
//   - sample(): the Efraimidis-Spirakis weighted order (-ln(u)/w) is drawn in
//     JS over the candidate rows SQL selects (SQLite's random() is an integer
//     and ln() is not always compiled in).
//   - fullTextHit(): chunks through chunk_fts (porter); subjects have no FTS
//     table, so a like prefilter and a whole-word check in JS (no stemming
//     on subjects). English stop words are dropped as in search.js.
//   - itemsWithFacts(): the due date is the UTC day (pg's to_char uses the
//     session time zone).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { BOOSTS } = require('../evals.ts');
const { NOW } = require('./_sql');
const { ftsQuery } = require('./search.ts');

// The same boosts, in SQLite SQL (named, never caller text).
const SQLITE_BOOSTS = {
  none: '0',
  temporal: `(si.source = 'graph_event' or exists (select 1 from commitment x where x.source_item_id = si.id and x.due_at is not null))`,
};

const ids = (list: unknown) => ((list ?? []) as unknown[]).map(Number);
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const words = (s: unknown) => String(s || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];

function create(db: Db) {
  return {
    // ---- cases and runs -------------------------------------------------------

    /** Active cases, by id. */
    async activeCases() {
      return db.rows('select id, question, qtype, gold_item_ids, gold_answer, as_of from eval_case where active order by id');
    },

    /** Cases (all, or active only), optionally of one qtype, by id. */
    async listCases({ all = false, qtype = null }: { all?: boolean; qtype?: unknown } = {}) {
      return db.rows(
        `select id, question, qtype, gold_item_ids, gold_answer, origin, active, notes, created_at
       from eval_case
      where ($1 or active) and ($2 is null or qtype = $2)
      order by id`,
        [Boolean(all), qtype]
      );
    },

    /** How many active cases there are ({n}). */
    async activeCount() {
      return db.one('select count(*) as n from eval_case where active');
    },

    /** Adds a case asked as of now ({id, qtype}). */
    async insertCase({ question, qtype, gold, answer, origin, notes }: { question?: unknown; qtype?: unknown; gold?: unknown; answer?: string | null; origin?: string | null; notes?: unknown }) {
      return db.one(
        `insert into eval_case (question, qtype, gold_item_ids, gold_answer, as_of, origin, notes)
     values ($1, $2, $3, $4, ${NOW}, $5, $6) returning id, qtype`,
        [question, qtype, ids(gold), answer, origin, notes]
      );
    },

    /** A generated case (the seeder's); resolves its id. */
    async insertGenerated({ question, qtype, gold_item_ids: gold, gold_answer: answer, notes }: { question?: unknown; qtype?: unknown; gold_item_ids?: unknown; gold_answer?: unknown; notes?: unknown }) {
      const row = await db.one(
        `insert into eval_case (question, qtype, gold_item_ids, gold_answer, as_of, origin, notes)
     values ($1, $2, $3, $4, ${NOW}, 'generated', $5) returning id`,
        [question, qtype, ids(gold), answer, notes]
      );
      return row?.id;
    },

    /** Turns a case on or off. Resolves whether it exists. */
    async setActive(id: number | string, active: boolean) {
      const r = await db.query('update eval_case set active = $2 where id = $1', [id, Boolean(active)]);
      return (r.rowCount ?? 0) > 0;
    },

    /** Every item id an active case uses as gold. */
    async usedGold() {
      const r = await db.rows('select distinct j.value as id from eval_case e, json_each(e.gold_item_ids) j where e.active');
      return r.map((x) => Number(x.id));
    },

    /** The newest run of a retriever ({id, ran_at, metrics, config}), or null. */
    async previousRun(retriever: unknown) {
      return db.one('select id, ran_at, metrics, config from eval_run where retriever = $1 order by ran_at desc, id desc limit 1', [retriever]);
    },

    /** Saves a run ({id, ran_at}); `perCase` is stored as JSON. */
    async insertRun({ retriever, config, metrics, perCase }: { retriever?: unknown; config?: unknown; metrics?: unknown; perCase?: unknown }) {
      return db.one('insert into eval_run (retriever, config, metrics, per_case) values ($1, $2, $3, $4) returning id, ran_at', [
        retriever,
        config,
        metrics,
        JSON.stringify(perCase),
      ]);
    },

    // ---- the corpus -----------------------------------------------------------

    /** Which of these ids are source items ([{id}]). */
    async existingItems(list: unknown[]) {
      return db.rows('select id from source_item where id in (select value from json_each($1))', [ids(list)]);
    },

    /** These items' {id, source, subject, occurred_at, body_text}, in no order. */
    async itemsForJudge(list: unknown[]) {
      return db.rows('select id, source, subject, occurred_at, body_text from source_item where id in (select value from json_each($1))', [ids(list)]);
    },

    /** A weighted random sample of chunked items with some body, not in `exclude` (see the pg twin). */
    async sample({ exclude, limit, boost = 'none' }: { exclude?: unknown; limit?: number | null; boost?: string }) {
      if (!(boost in BOOSTS) || !(boost in SQLITE_BOOSTS)) throw new Error(`unknown sample boost "${boost}"`);
      const rows = await db.rows(
        `select si.id, si.source, si.occurred_at,
              (select count(*) from commitment x where x.source_item_id = si.id) as nc,
              (select count(*) from fact x where x.source_item_id = si.id) as nf,
              ${SQLITE_BOOSTS[boost as keyof typeof SQLITE_BOOSTS]} as boosted
         from source_item si
        where exists (select 1 from chunk ch where ch.source_item_id = si.id)
          and length(si.body_text) > 80
          and si.id not in (select value from json_each($1))`,
        [ids(exclude)]
      );
      return rows
        .map((r) => {
          const w = 1 + 3 * (Number(r.nc) + Number(r.nf) > 0 ? 1 : 0) + 3 * (r.boosted ? 1 : 0);
          return { r, key: -Math.log(Math.max(Math.random(), 1e-9)) / w };
        })
        .sort((a, b) => a.key - b.key)
        .slice(0, limit ?? undefined)
        .map(({ r }) => ({ id: r.id, source: r.source, occurred_at: r.occurred_at }));
    },

    /** Items with their commitments and facts as text arrays, in no order. */
    async itemsWithFacts(list: unknown[]) {
      const rows = await db.rows(
        `select si.id, si.source, si.subject, si.occurred_at, si.body_text, si.thread_external_id,
            (select json_group_array(summary || coalesce(' (due ' || substr(due_at, 1, 10) || ')', ''))
               from commitment where source_item_id = si.id) as commitments,
            (select json_group_array(kind || ': ' || summary) from fact where source_item_id = si.id) as facts
       from source_item si where si.id in (select value from json_each($1))`,
        [ids(list)]
      );
      return rows.map((r) => ({ ...r, commitments: parse(r.commitments) || [], facts: parse(r.facts) || [] }));
    },

    /** Random earlier/later pairs in one thread, both chunked, with a commitment or fact. */
    async threadPairs({ exclude, limit }: { exclude?: unknown; limit?: number | null }) {
      return db.rows(
        `select a.id as earlier, b.id as later, b.source, b.occurred_at
       from source_item a
       join source_item b on b.source = a.source and b.thread_external_id = a.thread_external_id
                         and b.occurred_at > a.occurred_at
      where a.thread_external_id is not null
        and exists (select 1 from chunk where source_item_id = b.id)
        and exists (select 1 from chunk where source_item_id = a.id)
        and b.id not in (select value from json_each($1))
        and (exists (select 1 from commitment where source_item_id in (a.id, b.id))
             or exists (select 1 from fact where source_item_id in (a.id, b.id)))
      order by random()
      limit $2`,
        [ids(exclude), limit]
      );
    },

    /** Random groups of chunked items sharing a counterparty or project across two or more threads: {key, ids}. */
    async sharedGroups({ exclude, limit }: { exclude?: unknown; limit?: number | null }) {
      const rows = await db.rows(
        `with link as (
       select 'person:' || c.counterparty_person_id as key, c.source_item_id as id
         from commitment c join person p on p.id = c.counterparty_person_id
        where not p.is_me
       union
       select 'project:' || c.project_id, c.source_item_id from commitment c where c.project_id is not null
     )
     select key, json_group_array(distinct l.id) as ids
       from link l join source_item si on si.id = l.id
      where exists (select 1 from chunk where source_item_id = l.id)
        and l.id not in (select value from json_each($1))
      group by key
     having count(distinct coalesce(si.thread_external_id, cast(si.id as text))) >= 2
      order by random()
      limit $2`,
        [ids(exclude), limit]
      );
      return rows.map((r) => ({ key: r.key, ids: parse(r.ids) }));
    },

    /** Each item's thread key (its thread id, else its own id): [{id, t}]. */
    async threadKeys(list: unknown[]) {
      return db.rows('select id, coalesce(thread_external_id, cast(id as text)) as t from source_item where id in (select value from json_each($1))', [ids(list)]);
    },

    /** Whether any chunk or subject matches every (non stop) word of `term` ({hit}). */
    async fullTextHit(term: unknown) {
      const q: { terms: string[] } = ftsQuery(term, false);
      if (!q) return { hit: false };
      const match = q.terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
      if (await db.one('select 1 from chunk_fts where chunk_fts match $1 limit 1', [match])) return { hit: true };
      const likes = q.terms.map((_, i) => `lower(subject) like $${i + 1}`).join(' and ');
      const cands = await db.rows(`select subject from source_item where subject is not null and ${likes}`, q.terms.map((t) => `%${t}%`));
      const hit = cands.some((r) => {
        const ws = new Set(words(r.subject));
        return q.terms.every((t) => ws.has(t));
      });
      return { hit };
    },

    /** Active cases and the last run's time: {cases, last}. */
    async state() {
      const r = await db.one('select (select count(*) from eval_case where active) as cases, (select max(ran_at) from eval_run) as last');
      return { ...r, last: r?.last == null ? null : new Date(r.last as string) };
    },

    /** Up to 400 distinct subjects of a reasonable length: [{subject}]. */
    async sampleSubjects() {
      return db.rows(
        `select distinct subject from source_item
        where subject is not null and length(subject) between 8 and 140
        order by subject limit 400`
      );
    },
  };
}

module.exports = { create, BOOSTS };
