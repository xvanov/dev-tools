'use strict';

// Memory held teammates' PRs, on a throwaway SQLite store: the claims pass
// must not read items the user is not part of (no model call, no claims), and
// `pa memory prune` must find and retract the claims read from such items
// before the rule, giving belief back to what they had superseded.
//
// Invented names only. Skips without the optional SQLite driver.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-memory-prune-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_prune.sqlite');
process.env.PA_SQLITE_KEY = '';

const { available } = require('../src/db/sqlite.ts');

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP memoryPrune: no SQLite driver');
  }
  const repo = require('../src/repo');
  await require('../src/db/migrate.ts').migrate();
  const search = require('../src/search');
  search.embed = async (texts) => texts.map(() => null);
  const llm = require('../src/llm.ts');
  const identity = require('../src/distill/identity.ts');

  // ------------------------------------- only items the user is part of ---
  await identity.claimForMe('github_username', 'alex-dev', { displayName: 'Alex Dev', email: 'alex@example.test' });
  const PR = 'https://github.example/org/library-ui/pull/198';
  const MINE = 'https://github.example/org/optimizer/pull/7';
  let n = 0;
  const item = async (o) => {
    n++;
    const row = await repo.sources.upsertItem({
      source: o.source, externalId: `t-${n}`, threadExternalId: o.thread || null, occurredAt: new Date(Date.now() - n * 60_000),
      authorIdentity: o.author || null, subject: o.subject || `item ${n}`, bodyText: o.body || 'The library pages now take uploads of workbooks and drawings.', raw: o.raw || {}, hash: `h${n}`,
    });
    return Number(row.id);
  };
  const team = await item({ source: 'github_notification', thread: PR, author: 'github:sam-dev', raw: { action: 'team_review_requested', author: 'sam-dev', requestedMe: false } });
  const named = await item({ source: 'github_notification', thread: MINE, author: 'github:sam-dev', raw: { action: 'review_requested', author: 'sam-dev', requestedMe: true } });
  const channel = await item({ source: 'graph_chat', thread: 'chan-1', author: 'sam@example.test', raw: { chatType: 'channel', mentionsMe: false } });
  const chat = await item({ source: 'graph_chat', thread: 'chat-1', author: 'sam@example.test', raw: { chatType: 'oneOnOne' } });

  {
    const prompts = [];
    llm.complete = async ({ prompt }) => { prompts.push(prompt); return '{"claims": []}'; };
    const extract = require('../src/memory/extract.ts');
    const r = await extract.run({ limit: 50 });
    assert.strictEqual(r.skipped, 2);
    const sent = prompts.join('\n');
    for (const id of [named, chat]) assert.ok(sent.includes(`=== ITEM ${id} `), `item ${id} is read`);
    for (const id of [team, channel]) assert.ok(!sent.includes(`=== ITEM ${id} `), `item ${id} never reaches the model`);
    const left = (await extract.pending(100)).map((i) => Number(i.id));
    assert.ok(![team, channel].some((id) => left.includes(id)), 'skipped items are done, not retried');
  }

  // ------------------------------------------------- prune what is there ---
  {
    const claim = async (itemId, o = {}) => {
      await repo.memory.insertExtractedClaim({ subjectKind: 'topic', subjectId: null, label: o.label || 'library uploads', kind: 'status', text: o.text || 'library-ui adds upload flows', quote: 'q', itemId, source: 'github_notification', confidence: 0.8, validFrom: null, occurredAt: new Date(), validUntil: null, status: 'active', version: 'claims-v1', vector: null });
      const all = await repo.memory.liveClaimsByItem(itemId);
      return Number(all[all.length - 1].id);
    };
    const old = await claim(named, { text: 'library uploads are planned' }); // from an item the user is in
    const leaked = await claim(team);
    // The leaked claim had superseded the user's own.
    const db = require('../src/db');
    await db.query(`update claim set status = 'superseded' where id = $1`, [old]);
    await db.query(`update claim set supersedes_id = $1 where id = $2`, [old, leaked]);
    const prune = require('../src/memory/prune.ts');
    const a = await prune.audit();
    assert.deepStrictEqual(a.claims.map((c) => Number(c.id)), [leaked]);
    assert.match(a.skipped[0].why, /team_review_requested/);
    assert.strictEqual((await repo.memory.claimById(leaked)).status, 'active', 'the audit writes nothing');
    const r = await prune.apply(a.claims);
    assert.deepStrictEqual([r.retracted, r.restored], [1, 1]);
    assert.strictEqual((await repo.memory.claimById(leaked)).status, 'retracted');
    assert.strictEqual((await repo.memory.claimById(old)).status, 'active', 'the user\'s own claim is believed again');
    assert.strictEqual((await prune.audit()).claims.length, 0);
  }

  console.log('memoryPrune ok');
}

main()
  .then(() => require('../src/db').close?.())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
