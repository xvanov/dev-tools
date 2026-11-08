'use strict';

// Expand/contract discipline for sql/*.sql (docs/native/PLAN.md, Z3).
//
// A roll (src/supervisor) runs the previous generation beside the new one, and
// the new one migrates before it is ready: for up to a minute (longer if the
// deploy rolls back) the OLD code runs against the NEW schema. So a migration
// must leave everything the previous release reads and writes in place:
//
//   expand    additive only: new tables, new nullable (or defaulted) columns,
//             new indexes, relaxed constraints. Ships with the code that uses it.
//   contract  the cleanup (drop, rename, retype, tighten) — a later migration,
//             shipped at least one release after the code stopped needing the
//             old shape. It must say so on its own line:
//
//               -- contract: <expand migration file> [(<commit that shipped it>)]
//
// Pure functions; test/migrations.test.js runs them over sql/ and checks the
// previous release's INSERT statements against the new schema.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** A migration file: sql/<name>. */
type MigrationFile = { name: string; sql: string };
type Problem = { rule: string; statement: string };
/** Table name to its column names. */
type Schema = Map<string, Set<string>>;
type GitInfo = { addedIn(file: string): string | null; isAncestor(a: string, b: string): boolean };

// Everything up to here predates the rule and is not re-judged.
const BASELINE = '032';

function stripSql(sql: string) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "''") // function bodies
    .replace(/'(?:[^']|'')*'/g, "''");
}

function contractMarker(sql: string) {
  const m = /^--\s*contract:\s*(\S+\.sql)(?:\s*\(\s*([0-9a-f]{7,40})\s*\))?\s*$/im.exec(sql);
  return m ? { expand: m[1]!, commit: m[2]! || null } : null;
}

// One statement at a time, so "add column ... not null" sees only its own
// clause's default.
function statements(sql: string) {
  return stripSql(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const ID = '"?([a-z_][a-z0-9_.]*)"?';

function createdTables(stmts: string[]) {
  const out = new Set<string>();
  for (const s of stmts) {
    const m = new RegExp(`^create (?:unlogged )?table (?:if not exists )?${ID}`, 'i').exec(s);
    if (m) out.add(m[1]!.toLowerCase());
  }
  return out;
}

/** Non-additive changes in one migration: [{rule, statement}]. */
function nonAdditive(sql: string) {
  const stmts = statements(sql);
  const fresh = createdTables(stmts);
  const problems: Problem[] = [];
  const flag = (rule: string, s: string) => problems.push({ rule, statement: s.length > 160 ? s.slice(0, 157) + '...' : s });
  for (const s of stmts) {
    const alter = new RegExp(`^alter table (?:if exists )?(?:only )?${ID}`, 'i').exec(s);
    const table = alter ? alter[1]!.toLowerCase() : null;
    const onFresh = table && fresh.has(table);
    if (/^drop (?:table|view|materialized view|type|schema|sequence|function|procedure|trigger|domain)\b/i.test(s)) flag('drop', s);
    if (/^truncate\b/i.test(s)) flag('truncate', s);
    if (!alter) {
      if (/^alter (?:type|view|function|sequence)\b.*\brename\b/i.test(s)) flag('rename', s);
      if (/^create unique index\b/i.test(s)) {
        const on = new RegExp(`\\bon (?:only )?${ID}`, 'i').exec(s);
        if (!on || !fresh.has(on[1]!.toLowerCase())) flag('unique index on an existing table', s);
      }
      continue;
    }
    if (onFresh) continue; // shaping a table this migration created is not a change to old code
    // An ALTER TABLE can carry several comma-separated actions.
    for (const a of splitTop(s.slice(alter[0]!.length))) {
      if (/^drop (?:column )?(?:if exists )?[a-z_"]/i.test(a) && !/^drop (?:constraint|not null|default)\b/i.test(a)) flag('drop column', s);
      if (/^rename\b/i.test(a)) flag('rename', s);
      if (/^alter (?:column )?\S+ (?:set data )?type\b/i.test(a)) flag('change a column type', s);
      if (/^alter (?:column )?\S+ set not null\b/i.test(a)) flag('set not null', s);
      if (/^alter (?:column )?\S+ drop default\b/i.test(a)) flag('drop default', s);
      if (/^add (?:column )?(?:if not exists )?\S+ .*\bnot null\b/i.test(a) && !/\bdefault\b/i.test(a) && !/\bgenerated\b/i.test(a)) flag('add a not-null column without a default', s);
      if (/^add (?:constraint \S+ )?(?:unique|primary key|foreign key|check|exclude)\b/i.test(a) && !/\bnot valid\b/i.test(a)) flag('add a constraint old rows or old writes may break', s);
    }
  }
  return problems;
}

function seq(file: string) {
  const m = /^(\d+)_/.exec(file);
  return m ? m[1]! : null;
}

/**
 * Judges every migration after BASELINE. files: [{name, sql}]. Returns
 * [{file, problems: [string]}] for the ones that break the rule.
 * gitInfo (optional): {addedIn(file) -> commit|null, isAncestor(a, b) -> bool}
 * to check a contract really ships after its expand.
 */
function checkMigrations(files: MigrationFile[], { baseline = BASELINE, gitInfo = null }: { baseline?: string; gitInfo?: GitInfo | null } = {}) {
  const names = new Set(files.map((f) => f.name));
  const out: { file: string; problems: string[] }[] = [];
  for (const f of files) {
    const n = seq(f.name);
    if (!n || n <= baseline) continue;
    const problems: string[] = [];
    const found = nonAdditive(f.sql);
    const marker = contractMarker(f.sql);
    if (found.length && !marker) {
      for (const p of found) problems.push(`${p.rule}: ${p.statement} (not additive; ship it as a contract migration a release after the expand, with "-- contract: <expand file>")`);
    }
    if (marker) {
      if (!names.has(marker.expand)) problems.push(`contract names ${marker.expand}, which is not in sql/`);
      else if (!((seq(marker.expand) ?? '') < n)) problems.push(`contract's expand ${marker.expand} must come before it`);
      else if (gitInfo) {
        const expandAt = gitInfo.addedIn(marker.expand);
        const contractAt = gitInfo.addedIn(f.name); // null: not committed yet
        if (!expandAt) problems.push(`contract's expand ${marker.expand} is not committed yet: it must ship a release earlier`);
        else if (contractAt && contractAt === expandAt) problems.push(`contract ships in the same commit as its expand ${marker.expand} (${expandAt.slice(0, 7)}): ship it a release later`);
        if (marker.commit && expandAt && !gitInfo.isAncestor(marker.commit, contractAt || 'HEAD')) problems.push(`contract cites ${marker.commit}, which is not an earlier release on this branch`);
      }
    }
    if (problems.length) out.push({ file: f.name, problems });
  }
  return out;
}

// ---- a schema model, to run old statements against ----

function splitTop(body: string) {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const NOT_A_COLUMN = /^(?:constraint|primary key|unique|foreign key|check|exclude|like)\b/i;

/** Tables → Set(columns), by applying the migrations in order. */
function schemaOf(files: MigrationFile[]): Schema {
  const tables: Schema = new Map();
  const bare = (t: string) => t.toLowerCase().replace(/^public\./, '');
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    for (const s of statements(f.sql)) {
      let m = new RegExp(`^create (?:unlogged )?table (?:if not exists )?${ID} \\((.*)\\)`, 'i').exec(s);
      if (m) {
        const t = bare(m[1]!);
        if (!tables.has(t)) tables.set(t, new Set());
        for (const part of splitTop(m[2]!)) {
          if (NOT_A_COLUMN.test(part)) continue;
          const c = /^"?([a-z_][a-z0-9_]*)"?/i.exec(part);
          if (c) tables.get(t)?.add(c[1]!.toLowerCase());
        }
        continue;
      }
      m = new RegExp(`^drop table (?:if exists )?${ID}`, 'i').exec(s);
      if (m) {
        tables.delete(bare(m[1]!));
        continue;
      }
      m = new RegExp(`^alter table (?:if exists )?(?:only )?${ID} (.*)$`, 'i').exec(s);
      if (!m) continue;
      const t = bare(m[1]!);
      const rest = m[2]!;
      const rn = new RegExp(`^rename to ${ID}`, 'i').exec(rest);
      if (rn) {
        if (tables.has(t)) tables.set(bare(rn[1]!), tables.get(t) as Set<string>);
        tables.delete(t);
        continue;
      }
      if (!tables.has(t)) tables.set(t, new Set());
      const cols = tables.get(t) as Set<string>;
      for (const a of splitTop(rest)) {
        let x = /^add (?:column )?(?:if not exists )?"?([a-z_][a-z0-9_]*)"?/i.exec(a);
        if (x && !/^(?:constraint|primary|unique|foreign|check|exclude)$/i.test(x[1]!)) cols.add(x[1]!.toLowerCase());
        x = /^drop (?:column )?(?:if exists )?"?([a-z_][a-z0-9_]*)"?/i.exec(a);
        if (x && !/^constraint$/i.test(x[1]!)) cols.delete(x[1]!.toLowerCase());
        x = /^rename (?:column )?"?([a-z_][a-z0-9_]*)"? to "?([a-z_][a-z0-9_]*)"?/i.exec(a);
        if (x) {
          cols.delete(x[1]!.toLowerCase());
          cols.add(x[2]!.toLowerCase());
        }
      }
    }
  }
  return tables;
}

/** Every `insert into <table> (<cols>)` in a JS source: [{table, columns}]. */
function insertsIn(source: string) {
  const out: { table: string; columns: string[] }[] = [];
  for (const m of source.matchAll(/insert\s+into\s+"?([a-z_][a-z0-9_.]*)"?\s*\(([^()]*)\)/gi)) {
    const cols = m[2]!.split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase());
    if (cols.every((c) => /^[a-z_][a-z0-9_]*$/.test(c))) out.push({ table: m[1]!.toLowerCase().replace(/^public\./, ''), columns: cols });
  }
  return out;
}

/**
 * The previous release's writes against the new schema: every INSERT into a
 * table the old schema had must find its table and columns in the new one.
 * sources: [{path, text}]. Returns [string] problems.
 */
function oldInsertsFit({ sources, oldSchema, newSchema }: { sources: { path: string; text: string }[]; oldSchema: Schema; newSchema: Schema }) {
  const problems: string[] = [];
  for (const { path: p, text } of sources) {
    for (const ins of insertsIn(text)) {
      if (!oldSchema.has(ins.table)) continue; // not a table this schema owns (a CTE, a vendored one)
      const cols = newSchema.get(ins.table);
      if (!cols) {
        problems.push(`${p}: inserts into ${ins.table}, which the new schema no longer has`);
        continue;
      }
      const missing = ins.columns.filter((c) => oldSchema.get(ins.table)?.has(c) && !cols.has(c));
      if (missing.length) problems.push(`${p}: inserts ${ins.table}(${missing.join(', ')}), gone from the new schema`);
    }
  }
  return problems;
}

module.exports = { BASELINE, nonAdditive, contractMarker, checkMigrations, schemaOf, insertsIn, oldInsertsFit, stripSql };
