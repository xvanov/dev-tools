'use strict';

// Editing a card in place (src/commitments.ts editCard; `pa card edit`; the
// chat's card_edit tool): fields change, the ledger records before/who/why, a
// re-distillation neither replaces the card nor re-adds its original wording,
// and the tool asks. On a throwaway SQLite store, no model call. Invented
// names throughout.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-card-edit-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_card_edit.sqlite');
process.env.PA_SQLITE_KEY = 'card-edit-test-key';
process.env.PA_DATA_DIR = path.join(dir, 'data');

const { available } = require('../src/db/sqlite.ts');

(async () => {
  // Pure and static parts first: they need no store.
  const chat = require('../src/chat/index.ts');
  const T = require('../src/mcp/chatTools.ts');
  assert.ok(T.CHAT_ACTION_TOOL_NAMES.includes('card_edit'), 'card_edit is an action tool');
  assert.ok(!T.CHAT_READ_TOOL_NAMES.includes('card_edit'), 'and not a read tool');
  assert.ok(T.ACTION_TOOLS.some((t) => t.name === 'card_edit' && t.inputSchema.required.includes('card')));
  assert.ok(chat.ASK_COMMANDS.includes('card edit'), "`pa card edit` asks in the chat's shell");
  assert.ok(chat.launchers()['pa-card-edit'], 'with its own launcher');
  const s = chat.settingsJson();
  assert.ok(!s.permissions.allow.some((r) => r.endsWith('__card_edit')), 'card_edit is not on the allow list');
  const { askTool, describeTool } = require('../src/chat/transcript.ts');
  assert.strictEqual(askTool('mcp__pa-chat__card_edit', { card: '412', title: 'Send the Q3 numbers', due: 'friday' }), 'Change card 412: title to "Send the Q3 numbers", due friday. Shall I?');
  assert.match(describeTool('mcp__pa-chat__card_edit', { card: '412' }), /editing card 412/);

  const opts = require('../src/cli/task.ts').editOptions;
  assert.deepStrictEqual(opts({ title: 'x', 'due': false, project: false, note: 'n', reason: 'r' }), { edit: { title: 'x', note: 'n', reason: 'r', due: null, project: null } }, '--no-due and --no-project clear');
  assert.ok(opts({ title: true }).error, '--title with no value is refused');
  assert.ok(require('../src/cli/index.ts').HELP.includes('pa card edit'));

  if (!available()) return console.log('cardEdit: store half skipped (no sqlite driver)');
  const repo = require('../src/repo');
  const db = require('../src/db');
  await require('../src/db/migrate.ts').migrate();
  const { editCard } = require('../src/commitments.ts');
  const ledger = require('../src/ledger');
  const keep = require('../src/distill/keep.ts');

  const item = await db.one(`insert into source_item (source, external_id, occurred_at, author_identity, subject, body_text, content_hash) values ('graph_mail', 'ce1', $1, 'ada@example.test', 'Q3', 'body', 'h-ce1') returning id`, [new Date().toISOString()]);
  const card = async (summary, extra = {}) => Number((await repo.commitments.insertFromDebrief({ sourceItemId: item.id, direction: 'owed_by_me', summary, detail: 'old details', counterpartyPersonId: null, dueAt: null, confidence: 0.9, extractedBy: 'test', ...extra })));
  const row = (id) => db.one('select * from commitment where id = $1', [id]);

  // Fields change; the ledger says who, why and what it replaced.
  const id = await card('Send the Q3 numbers to Ada');
  const r = await editCard(id, { title: 'Send Q3 numbers to Ada by Friday', due: '2026-12-01', note: 'she asked twice', reason: 'Ada moved the deadline' });
  assert.deepStrictEqual(r.changed, ['title', 'details', 'due']);
  const c = await row(id);
  assert.strictEqual(c.summary, 'Send Q3 numbers to Ada by Friday');
  assert.match(c.detail, /^old details\n\nNote \(\d{4}-\d{2}-\d{2}\): she asked twice$/, 'a note is appended, details kept');
  assert.ok(String(c.due_at).startsWith('2026-12-01') || new Date(c.due_at).getFullYear() === 2026, 'due set');
  assert.ok(c.touched_at, 'a person edit stamps touched_at');
  assert.strictEqual(c.status, 'open', 'status untouched');
  const hist = await ledger.history(id);
  assert.strictEqual(hist.length, 1);
  assert.deepStrictEqual([hist[0].actor, hist[0].from_status, hist[0].to_status], ['you', 'open', 'open']);
  assert.match(hist[0].reason, /edited title, details, due — Ada moved the deadline/);
  const before = typeof hist[0].before === 'string' ? JSON.parse(hist[0].before) : hist[0].before;
  assert.strictEqual(before.edit.summary, 'Send the Q3 numbers to Ada');
  assert.strictEqual(before.edit.detail, 'old details');

  // Clearing the due date; an identical edit changes nothing and writes nothing.
  assert.deepStrictEqual((await editCard(id, { due: null })).changed, ['due']);
  assert.strictEqual((await row(id)).due_at, null);
  const same = await editCard(id, { title: 'Send Q3 numbers to Ada by Friday' });
  assert.deepStrictEqual([same.changed, same.transitionId], [[], null]);
  assert.strictEqual((await ledger.history(id)).length, 2);

  // Bad input and unknown ids fail with a message, and change nothing.
  await assert.rejects(() => editCard(999999, { title: 'x' }), /^Error: no commitment #999999$/);
  await assert.rejects(() => editCard(id, {}), /nothing to edit/);
  await assert.rejects(() => editCard(id, { title: '   ' }), /needs a title/);
  await assert.rejects(() => editCard(id, { due: 'someday soon' }), /cannot read the due date/);
  await assert.rejects(() => editCard(id, { project: 'no-such-project-xyz' }), /no project/);
  assert.strictEqual((await ledger.history(id)).length, 2, 'failed edits leave no rows');

  // An edit's ledger row is not a status change: undo refuses it.
  const u = await ledger.undo(hist[0].id);
  assert.strictEqual(u.ok, false);
  assert.match(u.result, /card edit/);
  assert.strictEqual((await row(id)).summary, 'Send Q3 numbers to Ada by Friday', 'undo changed nothing');

  // Re-distillation: the item is extracted again with its ORIGINAL wording
  // (and an untouched sibling it no longer says). The edited card is kept as
  // it is and the original wording is not added back as a second card.
  const sibling = await card('Book the room for Monday');
  const existing = await repo.commitments.liveForItem(item.id);
  const e = existing.find((x) => Number(x.id) === id);
  assert.strictEqual(e.orig_summary, 'Send the Q3 numbers to Ada', 'the original wording is read back from the ledger');
  const p = keep.plan(existing, [{ summary: 'Send the Q3 numbers to Ada' }, { summary: 'Order lunch for the offsite' }]);
  assert.ok(p.keep.includes(id) && !p.remove.includes(id), 'the edited card is kept');
  assert.deepStrictEqual(p.insert.map((x) => x.summary), ['Order lunch for the offsite'], 'the original wording is not re-inserted');
  assert.ok(p.remove.includes(sibling), 'an untouched card the item stopped saying still goes');
  assert.strictEqual((await row(id)).summary, 'Send Q3 numbers to Ada by Friday', 'nothing in the plan rewrites it');

  // A card nobody edited has no orig_summary: behaviour as before.
  assert.ok(!existing.find((x) => Number(x.id) === sibling).orig_summary);

  // Closing and reopening still work around edits.
  const { setStatus } = require('../src/commitments.ts');
  await setStatus(id, 'done');
  await setStatus(id, 'open');
  assert.strictEqual((await row(id)).status, 'open');

  // The chat tool: the same edit through chatTools.handle; an offer id is refused.
  const out = await T.handle('card_edit', { card: String(id), title: 'Q3 numbers to Ada', reason: 'shorter' });
  assert.deepStrictEqual([out.card, out.changed], [id, ['title']]);
  assert.strictEqual((await row(id)).summary, 'Q3 numbers to Ada');
  await assert.rejects(() => T.handle('card_edit', { card: 'p7', title: 'x' }), /offer, not a card/);
  await assert.rejects(() => T.handle('card_edit', { card: '999999', title: 'x' }), /no commitment #999999/);

  console.log('cardEdit: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
