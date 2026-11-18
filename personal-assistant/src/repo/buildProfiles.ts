'use strict';

// Aggregate: buildProfiles. Table: build_profile (a saved, named Build agent:
// model, effort, prompt, tools, subagents, caps; BUILD-ENRICHMENT.md A).
// Callers: src/build/profiles.ts. Times are ISO text the app writes, so the SQL is the
// same on Postgres and SQLite and src/repo/sqlite/buildProfiles.ts re-exports this file.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

/** The columns `upsert` writes, in order (name is the key). */
const FIELDS = [
  'description', 'model', 'effort', 'permission_mode', 'prompt', 'tools', 'subagents', 'subagent_model',
  'cost_cap_usd', 'wall_cap_min', 'idle_after_s', 'repo_path',
];

const iso = (): string => new Date().toISOString();
/** A field's value: a missing one is null, or '' for the two text columns that may not be null. */
const val = (v: Row) => (f: string): unknown => (v[f] === undefined || v[f] === null ? (f === 'description' || f === 'prompt' ? '' : null) : v[f]);

function create(db: Db) {
  return {
    /** Every profile, by name. */
    async list(): Promise<Row[]> {
      return db.rows('select * from build_profile order by name');
    },

    /** One profile, or null. */
    async byName(name: string): Promise<Row | null> {
      return db.one('select * from build_profile where name = $1', [name]);
    },

    /** Creates or replaces a profile (every field is written; a missing one becomes null): the row. */
    async upsert(name: string, v: Row): Promise<Row> {
      const now = iso();
      const vals = FIELDS.map(val(v));
      const ph = FIELDS.map((_, i) => `$${i + 4}`);
      const sets = FIELDS.map((f) => `${f} = excluded.${f}`).join(', ');
      await db.query(
        `insert into build_profile (name, created_at, updated_at, ${FIELDS.join(', ')}) values ($1,$2,$3,${ph.join(',')})
         on conflict (name) do update set ${sets}, updated_at = excluded.updated_at`,
        [name, now, now, ...vals]
      );
      return (await db.one('select * from build_profile where name = $1', [name])) as Row;
    },

    /** Inserts the profile only when no profile of that name exists (the seeds): 1 when it did, else 0. */
    async insertIfAbsent(name: string, v: Row): Promise<number> {
      const now = iso();
      const vals = FIELDS.map(val(v));
      const ph = FIELDS.map((_, i) => `$${i + 4}`);
      const r = await db.query(
        `insert into build_profile (name, created_at, updated_at, ${FIELDS.join(', ')}) values ($1,$2,$3,${ph.join(',')})
         on conflict (name) do nothing`,
        [name, now, now, ...vals]
      );
      return r.rowCount || 0;
    },

    /** Deletes a profile: 1 when it existed, else 0. */
    async remove(name: string): Promise<number> {
      const r = await db.query('delete from build_profile where name = $1', [name]);
      return r.rowCount || 0;
    },
  };
}

module.exports = { create, FIELDS };
