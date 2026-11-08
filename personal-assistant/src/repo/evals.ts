'use strict';

// Aggregate: evals. Tables: eval_case (a question with its gold items and
// answer) and eval_run (one scored run of a retriever). Also the corpus
// samples the seeder draws cases from (src/eval/seed.js). Callers: src/eval.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

// Sampling boosts the seeder may ask for (a SQL fragment over `si`, never text
// from a caller): `temporal` favours meetings and asks with a due date.
const BOOSTS = {
  none: 'false',
  temporal: `(si.source = 'graph_event' or exists (select 1 from commitment x where x.source_item_id = si.id and x.due_at is not null))`,
};

function create(db: Db) {
  return {
    // ---- cases and runs ---------------------------------------------------------

    /** Active cases, by id: {id, question, qtype, gold_item_ids, gold_answer, as_of}. */
    async activeCases() {
      return db.rows(
        `select id, question, qtype, gold_item_ids, gold_answer, as_of from eval_case where active order by id`
      );
    },

    /** Cases (all, or active only), optionally of one qtype, by id. */
    async listCases({ all = false, qtype = null }: { all?: boolean; qtype?: unknown } = {}) {
      return db.rows(
        `select id, question, qtype, gold_item_ids, gold_answer, origin, active, notes, created_at
       from eval_case
      where ($1 or active) and ($2::text is null or qtype = $2)
      order by id`,
        [all, qtype]
      );
    },

    /** How many active cases there are ({n}). */
    async activeCount() {
      return db.one('select count(*)::int as n from eval_case where active');
    },

    /** Adds a case asked as of now ({id, qtype}). `origin`: miss, generated, ... */
    async insertCase({ question, qtype, gold, answer, origin, notes }: { question?: unknown; qtype?: unknown; gold?: unknown; answer?: string | null; origin?: string | null; notes?: unknown }) {
      return db.one(
        `insert into eval_case (question, qtype, gold_item_ids, gold_answer, as_of, origin, notes)
     values ($1, $2, $3::bigint[], $4, now(), $5, $6) returning id, qtype`,
        [question, qtype, gold, answer, origin, notes]
      );
    },

    /** A generated case (the seeder's); resolves its id. */
    async insertGenerated({ question, qtype, gold_item_ids: gold, gold_answer: answer, notes }: { question?: unknown; qtype?: unknown; gold_item_ids?: unknown; gold_answer?: unknown; notes?: unknown }) {
      const row = await db.one(
        `insert into eval_case (question, qtype, gold_item_ids, gold_answer, as_of, origin, notes)
     values ($1, $2, $3::bigint[], $4, now(), 'generated', $5) returning id`,
        [question, qtype, gold, answer, notes]
      );
      return row?.id;
    },

    /** Turns a case on or off. Resolves whether it exists. */
    async setActive(id: number | string, active: boolean) {
      const r = await db.query('update eval_case set active = $2 where id = $1', [id, active]);
      return (r.rowCount ?? 0) > 0;
    },

    /** Every item id an active case uses as gold. */
    async usedGold() {
      const r = await db.rows(`select distinct unnest(gold_item_ids) as id from eval_case where active`);
      return r.map((x) => Number(x.id));
    },

    /** The newest run of a retriever ({id, ran_at, metrics, config}), or null. */
    async previousRun(retriever: unknown) {
      return db.one(
        `select id, ran_at, metrics, config from eval_run where retriever = $1 order by ran_at desc limit 1`,
        [retriever]
      );
    },

    /** Saves a run ({id, ran_at}); `perCase` is stored as JSON. */
    async insertRun({ retriever, config, metrics, perCase }: { retriever?: unknown; config?: unknown; metrics?: unknown; perCase?: unknown }) {
      return db.one(
        `insert into eval_run (retriever, config, metrics, per_case) values ($1, $2, $3, $4) returning id, ran_at`,
        [retriever, config, metrics, JSON.stringify(perCase)]
      );
    },

    // ---- the corpus, as the judge and the seeder read it ------------------------

    /** Which of these ids are source items ([{id}]). */
    async existingItems(ids: unknown[]) {
      return db.rows('select id from source_item where id = any($1::bigint[])', [ids]);
    },

    /** These items' {id, source, subject, occurred_at, body_text}, in no order. */
    async itemsForJudge(ids: unknown[]) {
      return db.rows(
        `select id, source, subject, occurred_at, body_text from source_item where id = any($1::bigint[])`,
        [ids]
      );
    },

    /**
     * A weighted random sample of chunked items with some body, not in
     * `exclude` (Efraimidis-Spirakis: order by -ln(u)/w). Items with a
     * commitment or fact weigh 4, plus 3 when `boost` (a BOOSTS key) holds.
     */
    async sample({ exclude, limit, boost = 'none' }: { exclude?: unknown; limit?: number | null; boost?: string }) {
      if (!(boost in BOOSTS)) throw new Error(`unknown sample boost "${boost}"`);
      return db.rows(
        `with c as (
       select si.id, si.source, si.occurred_at,
              (select count(*) from commitment x where x.source_item_id = si.id) as nc,
              (select count(*) from fact x where x.source_item_id = si.id) as nf,
              ${BOOSTS[boost as keyof typeof BOOSTS]} as boosted
         from source_item si
        where exists (select 1 from chunk ch where ch.source_item_id = si.id)
          and length(si.body_text) > 80
          and not (si.id = any($1::bigint[]))
     )
     select id, source, occurred_at from c
      order by -ln(greatest(random(), 1e-9)) / (1 + 3 * (nc + nf > 0)::int + 3 * boosted::int)
      limit $2`,
        [exclude, limit]
      );
    },

    /** Items with their commitments and facts as text arrays (a case is written from them), in no order. */
    async itemsWithFacts(ids: unknown[]) {
      return db.rows(
        `select si.id, si.source, si.subject, si.occurred_at, si.body_text, si.thread_external_id,
            coalesce((select array_agg(summary || coalesce(' (due ' || to_char(due_at, 'YYYY-MM-DD') || ')', ''))
                        from commitment where source_item_id = si.id), '{}') as commitments,
            coalesce((select array_agg(kind || ': ' || summary) from fact where source_item_id = si.id), '{}') as facts
       from source_item si where si.id = any($1::bigint[])`,
        [ids]
      );
    },

    /** Random earlier/later pairs in one thread, both chunked, with a commitment or fact: {earlier, later, source, occurred_at}. */
    async threadPairs({ exclude, limit }: { exclude?: unknown; limit?: number | null }) {
      return db.rows(
        `select a.id as earlier, b.id as later, b.source, b.occurred_at
       from source_item a
       join source_item b on b.source = a.source and b.thread_external_id = a.thread_external_id
                         and b.occurred_at > a.occurred_at
      where a.thread_external_id is not null
        and exists (select 1 from chunk where source_item_id = b.id)
        and exists (select 1 from chunk where source_item_id = a.id)
        and not (b.id = any($1::bigint[]))
        and (exists (select 1 from commitment where source_item_id in (a.id, b.id))
             or exists (select 1 from fact where source_item_id in (a.id, b.id)))
      order by random()
      limit $2`,
        [exclude, limit]
      );
    },

    /** Random groups of chunked items sharing a counterparty or project across two or more threads: {key, ids}. */
    async sharedGroups({ exclude, limit }: { exclude?: unknown; limit?: number | null }) {
      return db.rows(
        `with link as (
       select 'person:' || c.counterparty_person_id as key, c.source_item_id as id
         from commitment c join person p on p.id = c.counterparty_person_id
        where not p.is_me
       union
       select 'project:' || c.project_id, c.source_item_id from commitment c where c.project_id is not null
     )
     select key, array_agg(distinct l.id) as ids
       from link l join source_item si on si.id = l.id
      where exists (select 1 from chunk where source_item_id = l.id)
        and not (l.id = any($1::bigint[]))
      group by key
     having count(distinct coalesce(si.thread_external_id, si.id::text)) >= 2
      order by random()
      limit $2`,
        [exclude, limit]
      );
    },

    /** Each item's thread key (its thread id, else its own id): [{id, t}]. */
    async threadKeys(ids: unknown[]) {
      return db.rows(`select id, coalesce(thread_external_id, id::text) as t from source_item where id = any($1::bigint[])`, [ids]);
    },

    /** Whether any chunk or subject matches `term` as English full text ({hit}). */
    async fullTextHit(term: unknown) {
      return db.one(
        `select exists (select 1 from chunk where tsv @@ plainto_tsquery('english', $1))
         or exists (select 1 from source_item
                     where to_tsvector('english', coalesce(subject, '')) @@ plainto_tsquery('english', $1)) as hit`,
        [term]
      );
    },

    // --- for src/cli (pa doctor)

    /** Active cases and the time of the newest run: {cases, last}. */
    async state() {
      return db.one(`select (select count(*) from eval_case where active)::int as cases, (select max(ran_at) from eval_run) as last`);
    },

    /** Up to 400 distinct subjects of a reasonable length, randomly picked: [{subject}]. */
    async sampleSubjects() {
      return db.rows(
        `select distinct on (subject) subject from source_item
        where subject is not null and length(subject) between 8 and 140
        order by subject, random() limit 400`
      );
    },
  };
}

module.exports = { create, BOOSTS };
