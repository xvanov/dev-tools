'use strict';

// `pa secrets migrate --from-env`: dry run by default, names only, a line is
// emptied only after the keychain reads back the same value, a differing
// keychain value is never overwritten.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrate, plan } = require('../src/secrets/migrate');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-migrate-'));
const file = path.join(dir, '.env');
const V = { A: 'val-anthropic-QQ1', J: 'val-jira-QQ2', C: 'val-conflict-QQ3', D: 'val-dedupe-QQ4', O: 'val-other-QQ5' };
const original = [
  '# comment stays',
  `ANTHROPIC_API_KEY=${V.A}`,
  `PA_JIRA_API_TOKEN="${V.J}"`,
  `OPENAI_API_KEY=${V.C}`,
  `DEEPSEEK_API_KEY=${V.D}`,
  `SOME_OTHER_SECRET=${V.O}`,
  'PA_DAILY_BUDGET_USD=15',
  'PA_NTFY_TOPIC=',
  '',
].join('\n');
const readable = ['ANTHROPIC_API_KEY', 'PA_JIRA_API_TOKEN', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'PA_NTFY_TOPIC'];

function fakeVault(initial) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    sets: [],
    available: () => true,
    get: (n) => (store.has(n) ? store.get(n) : null),
    set(n, v) { if (n === 'PA_JIRA_API_TOKEN' && this.failJira) throw new Error(`boom ${v}`); this.sets.push(n); store.set(n, v); },
    scrub: (m, v) => String(m).split(v).join('<redacted>'),
  };
}

const rowMap = (r) => Object.fromEntries(r.rows.map((x) => [x.name, x.action]));

// Dry run: plan only.
{
  fs.writeFileSync(file, original);
  const vault = fakeVault({ OPENAI_API_KEY: 'a-different-value', DEEPSEEK_API_KEY: V.D });
  const r = migrate([{ file, readable }], { vault });
  assert.strictEqual(r.apply, false);
  assert.deepStrictEqual(rowMap(r), {
    ANTHROPIC_API_KEY: 'move', PA_JIRA_API_TOKEN: 'move', OPENAI_API_KEY: 'conflict', DEEPSEEK_API_KEY: 'dedupe',
    SOME_OTHER_SECRET: 'kept', PA_NTFY_TOPIC: 'empty',
  });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original, 'a dry run touches nothing');
  assert.strictEqual(vault.sets.length, 0);
  for (const v of Object.values(V)) assert.ok(!JSON.stringify(r).includes(v), 'no value in the report');
}

// Apply.
{
  fs.writeFileSync(file, original);
  const vault = fakeVault({ OPENAI_API_KEY: 'a-different-value', DEEPSEEK_API_KEY: V.D });
  vault.failJira = true;
  const r = migrate([{ file, readable }], { vault, apply: true });
  assert.deepStrictEqual(rowMap(r), {
    ANTHROPIC_API_KEY: 'moved', PA_JIRA_API_TOKEN: 'failed', OPENAI_API_KEY: 'conflict', DEEPSEEK_API_KEY: 'deduped',
    SOME_OTHER_SECRET: 'kept', PA_NTFY_TOPIC: 'empty',
  });
  assert.strictEqual(vault.store.get('ANTHROPIC_API_KEY'), V.A);
  assert.strictEqual(vault.store.get('OPENAI_API_KEY'), 'a-different-value', 'a differing keychain value is never overwritten');
  const after = fs.readFileSync(file, 'utf8').split('\n');
  assert.deepStrictEqual(after, [
    '# comment stays',
    'ANTHROPIC_API_KEY=',
    `PA_JIRA_API_TOKEN="${V.J}"`, // the failed one is untouched
    `OPENAI_API_KEY=${V.C}`,
    'DEEPSEEK_API_KEY=',
    `SOME_OTHER_SECRET=${V.O}`,
    'PA_DAILY_BUDGET_USD=15',
    'PA_NTFY_TOPIC=',
    '',
  ]);
  const failed = r.rows.find((x) => x.name === 'PA_JIRA_API_TOKEN');
  assert.ok(!failed.error.includes(V.J), 'an error never carries the value');

  // Re-running is a no-op: the moved lines are empty now.
  const again = migrate([{ file, readable }], { vault, apply: true });
  assert.ok(!again.rows.some((x) => x.action === 'moved'));
}

// An unavailable keychain moves nothing.
{
  fs.writeFileSync(file, original);
  const r = migrate([{ file, readable }], { vault: { available: () => false }, apply: true });
  assert.strictEqual(r.available, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
}

assert.deepStrictEqual(plan([{ file: path.join(dir, 'missing.env'), readable }], () => null), [], 'a missing file is skipped');
fs.rmSync(dir, { recursive: true, force: true });
console.log('secretsMigrate ok');
