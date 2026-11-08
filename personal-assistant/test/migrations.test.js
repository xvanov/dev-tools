'use strict';

// Expand/contract migrations (src/db/migrationRules.js; docs/native/PLAN.md Z3).
//
// 1. The rule itself, on small cases.
// 2. Every migration after the baseline in sql/ is additive, or a contract
//    migration naming an expand that shipped a release earlier.
// 3. An applied migration is never edited (it would never run again anywhere).
// 4. The previous release's code against the new schema: every INSERT the
//    previous commit's src/ makes still finds its table and columns once the
//    new migrations are applied — what the old generation does during a roll.
//    No Postgres: the schema is modelled from the migration files. "Previous
//    release" is HEAD when sql/ or src/ have uncommitted changes (pre-commit),
//    else HEAD~1 (CI); PA_COMPAT_BASE overrides. Skipped, saying so, without git.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const R = require('../src/db/migrationRules.ts');
const { expandIncludes } = require('../src/db/migrate.ts');

const PA = path.join(__dirname, '..');
const SQL = path.join(PA, 'sql');

// ---- 1. the rule ----
{
  const bad = (sql, rule) => {
    const p = R.nonAdditive(sql);
    assert.ok(p.some((x) => x.rule === rule), `expected "${rule}" for: ${sql}\n got ${JSON.stringify(p)}`);
  };
  const ok = (sql) => assert.deepStrictEqual(R.nonAdditive(sql), [], sql);

  ok('create table if not exists t (id bigint primary key, name text not null);');
  ok('alter table run add column if not exists job_kind text;');
  ok("alter table run add column state text not null default 'open';");
  ok('create index if not exists run_x on run (x);');
  ok('alter table run alter column x drop not null;');
  ok('alter table run drop constraint run_x_check;');
  ok('drop index if exists run_x;');
  ok('create table t (id int); alter table t add column y int not null; create unique index t_y on t (y);');
  ok("-- drop table run;\nselect 1 where 'drop table x' <> '';");
  ok("create or replace function f() returns void language plpgsql as $$ begin drop table x; end $$;");

  bad('drop table run;', 'drop');
  bad('alter table run drop column job_kind;', 'drop column');
  bad('alter table run drop job_kind;', 'drop column');
  bad('alter table run rename column a to b;', 'rename');
  bad('alter table run rename to runs;', 'rename');
  bad('alter table run alter column a type bigint;', 'change a column type');
  bad('alter table run alter column a set data type bigint;', 'change a column type');
  bad('alter table run alter column a set not null;', 'set not null');
  bad('alter table run alter column a drop default;', 'drop default');
  bad('alter table run add column b text not null;', 'add a not-null column without a default');
  bad('alter table run add column c int, add column b text not null;', 'add a not-null column without a default');
  bad("alter table run add constraint run_c check (c > 0);", 'add a constraint old rows or old writes may break');
  bad('create unique index run_u on run (u);', 'unique index on an existing table');
  bad('truncate run;', 'truncate');
  ok("alter table run add constraint run_c check (c > 0) not valid;");

  assert.deepStrictEqual(R.contractMarker('-- contract: 040_x.sql (abc1234)\ndrop table y;'), { expand: '040_x.sql', commit: 'abc1234' });
  assert.deepStrictEqual(R.contractMarker('-- contract: 040_x.sql\n'), { expand: '040_x.sql', commit: null });
  assert.strictEqual(R.contractMarker('drop table y;'), null);

  const files = [
    { name: '001_init.sql', sql: 'create table run (id int, a text, old text);' },
    { name: '040_add_b.sql', sql: 'alter table run add column b text;' },
    { name: '041_drop_old.sql', sql: '-- contract: 040_add_b.sql\nalter table run drop column old;' },
    { name: '042_rename.sql', sql: 'alter table run rename column a to aa;' },
    { name: '043_bad_contract.sql', sql: '-- contract: 099_nope.sql\ndrop table run;' },
  ];
  const added = { '040_add_b.sql': 'c1', '041_drop_old.sql': 'c2', '042_rename.sql': 'c2', '043_bad_contract.sql': 'c2' };
  const gitInfo = { addedIn: (f) => added[f] || null, isAncestor: () => true };
  const res = R.checkMigrations(files, { baseline: '032', gitInfo });
  assert.deepStrictEqual(res.map((r) => r.file), ['042_rename.sql', '043_bad_contract.sql']);
  // A contract in the same commit as its expand is refused.
  const same = R.checkMigrations(files.slice(0, 3), { baseline: '032', gitInfo: { addedIn: () => 'c1', isAncestor: () => true } });
  assert.match(same[0].problems[0], /same commit/);
  // ... and so is one whose expand is not committed at all.
  const uncommitted = R.checkMigrations(files.slice(0, 3), { baseline: '032', gitInfo: { addedIn: () => null, isAncestor: () => true } });
  assert.match(uncommitted[0].problems[0], /not committed yet/);

  // The schema model and the old-insert check.
  const oldS = R.schemaOf(files.slice(0, 1));
  const newS = R.schemaOf(files.slice(0, 3));
  assert.deepStrictEqual([...newS.get('run')].sort(), ['a', 'b', 'id']);
  const sources = [{ path: 'old.js', text: "db.query('insert into run (id, a, old) values ($1,$2,$3)')" }];
  assert.deepStrictEqual(R.oldInsertsFit({ sources, oldSchema: oldS, newSchema: oldS }), []);
  assert.match(R.oldInsertsFit({ sources, oldSchema: oldS, newSchema: newS })[0], /run\(old\)/);
}

// ---- the files on disk ----
const read = (dir) =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: expandIncludes(fs.readFileSync(path.join(dir, name), 'utf8')) }));
const current = read(SQL);
const newSchema = R.schemaOf(current);
assert.ok(newSchema.size > 20, `schema model found only ${newSchema.size} tables`);

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: PA, encoding: opts.encoding === null ? null : 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...opts });
}
let hasGit = true;
try {
  git(['rev-parse', 'HEAD']);
} catch {
  hasGit = false;
}

// ---- 2. additive, or a properly sequenced contract ----
{
  const gitInfo = hasGit
    ? {
        addedIn: (file) => {
          try {
            const out = git(['log', '--diff-filter=A', '--format=%H', '--', `sql/${file}`]).trim().split('\n').filter(Boolean);
            return out.length ? out[out.length - 1] : null;
          } catch {
            return null;
          }
        },
        isAncestor: (a, b) => {
          try {
            git(['merge-base', '--is-ancestor', a, b]);
            return true;
          } catch {
            return false;
          }
        },
      }
    : null;
  const res = R.checkMigrations(current, { gitInfo });
  assert.deepStrictEqual(res, [], `non-additive migrations (see src/db/migrationRules.js and AGENT.md, "Expand/contract"):\n${res.map((r) => `${r.file}:\n  ${r.problems.join('\n  ')}`).join('\n')}`);
}

// ---- 3 and 4: against the previous release ----
function previousRelease() {
  if (process.env.PA_COMPAT_BASE) return process.env.PA_COMPAT_BASE;
  const dirty = git(['status', '--porcelain', '--', 'sql', 'src']).trim();
  return dirty ? 'HEAD' : 'HEAD~1';
}

function filesAt(rev, dirs) {
  // Both relative to this tool's directory (ls-tree's default, `rev:./path`).
  const names = git(['ls-tree', '-r', '--name-only', rev, '--', ...dirs]).split('\n').filter((n) => n.endsWith('.sql') || n.endsWith('.js'));
  if (!names.length) return [];
  const raw = git(['cat-file', '--batch'], { input: names.map((n) => `${rev}:./${n}`).join('\n') + '\n', encoding: null });
  const out = [];
  let at = 0;
  for (const n of names) {
    const nl = raw.indexOf(10, at);
    const header = raw.slice(at, nl).toString('utf8');
    const size = Number(header.split(' ')[2]);
    if (!Number.isFinite(size)) throw new Error(`git cat-file: ${header}`);
    out.push({ path: n, text: raw.slice(nl + 1, nl + 1 + size).toString('utf8') });
    at = nl + 1 + size + 1;
  }
  return out;
}

if (!hasGit) {
  console.log('migrations: no git here — previous-release checks skipped');
} else {
  const base = previousRelease();
  let old = null;
  try {
    git(['rev-parse', '--verify', `${base}^{commit}`]);
    old = filesAt(base, ['sql', 'src']);
  } catch {
    console.log(`migrations: ${base} is not available (shallow clone?) — previous-release checks skipped`);
  }
  if (old) {
    const oldSql = old
      .filter((f) => f.path.startsWith('sql/') && f.path.endsWith('.sql') && !f.path.slice(4).includes('/'))
      .map((f) => ({ name: f.path.slice(4), sql: f.text }));
    // Includes resolve against today's tree; vendored files are not edited in place.
    const oldFiles = oldSql.map((f) => ({ name: f.name, sql: expandIncludes(f.sql) }));

    // 3. Applied migrations are never edited.
    const byName = new Map(current.map((f) => [f.name, f.sql]));
    const norm = (s) => R.stripSql(s).replace(/\s+/g, ' ').trim();
    for (const f of oldFiles) {
      assert.ok(byName.has(f.name), `${f.name} was in ${base} and is gone: applied migrations are never removed`);
      assert.strictEqual(norm(byName.get(f.name)), norm(f.sql), `${f.name} changed since ${base}: an applied migration never runs again; add a new one`);
    }

    // 4. The previous release's inserts against the new schema.
    const oldSchema = R.schemaOf(oldFiles);
    const sources = old.filter((f) => f.path.startsWith('src/') && f.path.endsWith('.js'));
    const problems = R.oldInsertsFit({ sources, oldSchema, newSchema });
    assert.deepStrictEqual(problems, [], `the previous release (${base}) would break on the new schema:\n${problems.join('\n')}`);
    const added = current.length - oldFiles.length;
    console.log(`migrations: previous release ${base}: ${sources.length} files, ${oldFiles.length} migrations, ${added} new — compatible`);
  }
}

// And today's code against today's schema (a typo'd column is caught here, not at 2am).
{
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const sources = walk(path.join(PA, 'src')).map((p) => ({ path: path.relative(PA, p), text: fs.readFileSync(p, 'utf8') }));
  const problems = R.oldInsertsFit({ sources, oldSchema: newSchema, newSchema });
  assert.deepStrictEqual(problems, [], problems.join('\n'));
}

console.log('migrations ok');
