'use strict';

// Card plans (src/cardplans.ts; chat tools card_plan_propose / card_plan_apply;
// `pa cardplan`; the dashboard's "Proposed card changes"): one set of card
// changes, validated when proposed, approved once, applied item by item with
// per-item results. On a throwaway SQLite store, no model call. Invented names.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-card-plan-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_card_plan.sqlite');
process.env.PA_SQLITE_KEY = 'card-plan-test-key';
process.env.PA_DATA_DIR = path.join(dir, 'data');
process.env.PA_TOASTS = '0';

const { available } = require('../src/db/sqlite.ts');

(async () => {
  // Tiers and surfaces first: static, no store.
  const chat = require('../src/chat/index.ts');
  const T = require('../src/mcp/chatTools.ts');
  assert.ok(T.CHAT_READ_TOOL_NAMES.includes('card_plan_propose'), 'propose only stores: a read tool');
  assert.ok(!T.CHAT_ACTION_TOOL_NAMES.includes('card_plan_propose'));
  assert.ok(T.CHAT_ACTION_TOOL_NAMES.includes('card_plan_apply'), 'apply is an action tool');
  assert.ok(!T.CHAT_READ_TOOL_NAMES.includes('card_plan_apply'));
  assert.ok(T.READ_TOOLS.some((t) => t.name === 'card_plan_propose' && t.inputSchema.required.includes('items')));
  assert.ok(T.ACTION_TOOLS.some((t) => t.name === 'card_plan_apply' && t.inputSchema.required.includes('plan')));
  const s = chat.settingsJson();
  assert.ok(s.permissions.allow.includes('mcp__pa-chat__card_plan_propose'), 'propose is on the allow list');
  assert.ok(!s.permissions.allow.some((r) => r.endsWith('__card_plan_apply')), 'apply is not');
  assert.ok(chat.ASK_COMMANDS.includes('cardplan apply') && chat.ASK_COMMANDS.includes('cardplan discard'));
  assert.ok(chat.ALLOW_COMMANDS.includes('cardplan list') && chat.ALLOW_COMMANDS.includes('cardplan show'));
  assert.match(chat.claudeMd(), /card_plan_propose/, 'the chat is told to use it for several changes');
  assert.ok(require('../src/cli/index.ts').HELP.includes('pa cardplan'));
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/policy/default.policy.json'), 'utf8'));
  assert.ok(policy.rules.some((r) => r.id === 'read-surface-allow' && r.tools.includes('card_plan_propose')));
  assert.ok(policy.rules.filter((r) => r.tools.includes('card_plan_apply')).length >= 2, 'apply asks and is approvable');
  new vm.Script(fs.readFileSync(path.join(__dirname, '../src/dashboard/cardplan.client.js'), 'utf8'), { filename: 'cardplan.client.js' });
  const plans0 = require('../src/cardplans.ts');
  assert.deepStrictEqual(plans0.numbers('1, 3 3'), [1, 3, 3]);
  assert.throws(() => plans0.numbers('0'), /item numbers/);
  assert.strictEqual(plans0.cardId('#412'), 412);
  assert.strictEqual(plans0.cardId('p7'), null);
  const { askTool } = require('../src/chat/transcript.ts');
  assert.match(askTool('mcp__pa-chat__card_plan_apply', { plan: 7, skip: [2] }), /^Apply card plan 7, leaving out 1 item.*Shall I\?$/);

  if (!available()) return console.log('cardPlan: store half skipped (no sqlite driver)');
  const repo = require('../src/repo');
  const db = require('../src/db');
  await require('../src/db/migrate.ts').migrate();
  const plans = require('../src/cardplans.ts');
  const ledger = require('../src/ledger');

  const item = await db.one(`insert into source_item (source, external_id, occurred_at, author_identity, subject, body_text, content_hash) values ('graph_mail', 'cp1', $1, 'ada@example.test', 'Plan', 'body', 'h-cp1') returning id`, [new Date().toISOString()]);
  const card = async (summary) => Number(await repo.commitments.insertFromDebrief({ sourceItemId: item.id, direction: 'owed_by_me', summary, detail: 'old details', counterpartyPersonId: null, dueAt: null, confidence: 0.9, extractedBy: 'test' }));
  const row = (id) => db.one('select * from commitment where id = $1', [id]);

  const a = await card('Set up VM backups');
  const b = await card('Send the Q3 numbers to Ada');
  const c = await card('Order lunch for the offsite');
  const closed = await card('Already closed one');
  await require('../src/commitments.ts').setStatus(closed, 'dropped');

  // propose: validates everything, reports all problems together, stores nothing when any fail.
  await assert.rejects(() => plans.propose({ title: 'bad', items: [
    { op: 'close', card: '999999' },
    { op: 'edit', card: String(b) },
    { op: 'edit', card: String(b), due: 'someday soon' },
    { op: 'edit', card: String(closed), title: 'x' },
    { op: 'create' },
    { op: 'nope' },
    { op: 'edit', card: String(b), project: 'no-such-project-xyz', title: 'x' },
  ] }), (e) => /item 1: no card #999999/.test(e.message) && /item 2: an edit needs at least one/.test(e.message) && /item 3: cannot read the due date/.test(e.message)
    && /item 4: card #\d+ is dropped, not open/.test(e.message) && /item 5: a new card needs a title/.test(e.message) && /item 6: op must be/.test(e.message) && /item 7: no project/.test(e.message));
  await assert.rejects(() => plans.propose({ title: '', items: [{ op: 'close', card: String(a) }] }), /give the plan a title/);
  await assert.rejects(() => plans.propose({ title: 'x', items: [] }), /at least one item/);
  assert.strictEqual((await repo.cardPlans.listPlans({})).length, 0, 'a refused plan stores nothing');

  // The read-tier tool: stores, changes no card, returns id + link, and a notice joins the feed.
  const r = await T.handle('card_plan_propose', {
    title: "Drew's VM migration plan", rationale: 'The VM plan supersedes the backup card.', sources: ['https://example.test/plan'],
    items: [
      { op: 'close', card: String(a), reason: 'superseded by the migration plan' },
      { op: 'edit', card: String(b), title: 'Send Q3 numbers to Ada by Friday', due: '2d', note: 'she asked twice', reason: 'deadline moved' },
      { op: 'create', title: 'Migrate the billing VM to the new host', details: 'per the plan, phase 2', due: '3d', reason: 'new in the plan' },
      { op: 'close', card: String(c), as: 'done', reason: 'covered' },
      { op: 'edit', card: String(c), note: 'x' },
    ],
  }).catch((e) => e);
  assert.match(String(r.message), /item 5: card #\d+ is already closed by an earlier item/, 'a card closed earlier in the plan cannot be edited later');
  const good = await T.handle('card_plan_propose', {
    title: "Drew's VM migration plan", rationale: 'The VM plan supersedes the backup card.', sources: ['https://example.test/plan'],
    items: [
      { op: 'close', card: String(a), reason: 'superseded by the migration plan' },
      { op: 'edit', card: String(b), title: 'Send Q3 numbers to Ada by Friday', due: '2d', note: 'she asked twice', reason: 'deadline moved' },
      { op: 'create', title: 'Migrate the billing VM to the new host', details: 'per the plan, phase 2', due: '3d', reason: 'new in the plan' },
      { op: 'close', card: String(c), as: 'done', reason: 'covered' },
    ],
  });
  assert.deepStrictEqual([good.plan, good.items], [1, 4]);
  assert.match(good.link, /#cardplan-1$/);
  assert.strictEqual((await row(a)).status, 'open', 'propose changed no card');
  assert.strictEqual((await row(b)).summary, 'Send the Q3 numbers to Ada');
  const notes = await require('../src/notify/notify.ts').feed({ limit: 10 });
  assert.ok(notes.some((n) => /Card changes waiting for your yes/.test(n.title)), 'a notice says it waits');

  const shown = await plans.show(good.plan);
  assert.strictEqual(shown.status, 'pending');
  assert.deepStrictEqual(shown.items.map((i) => i.op), ['close', 'edit', 'close', 'create'].sort().length ? ['close', 'edit', 'create', 'close'] : []);
  assert.match(shown.items[0].line, /^Close #\d+ 'Set up VM backups' — superseded by the migration plan$/);
  assert.match(shown.items[1].line, /^Edit #\d+ 'Send the Q3 numbers to Ada': title → 'Send Q3 numbers to Ada by Friday', due → .+, note 'she asked twice' — deadline moved$/);
  assert.match(shown.items[2].line, /^New: 'Migrate the billing VM to the new host' \(due .+\) — new in the plan$/);
  assert.strictEqual((await plans.list({})).length, 1, 'it is listed as waiting');

  // The one approval shows every change that would run, minus the unticked.
  const ap = await plans.approvalText({ plan: good.plan, skip: [4] });
  assert.match(ap.ask, /^Apply card plan 1, Drew's VM migration plan: 3 changes \(close 1, edit 1, create 1\)\. Shall I\?$/);
  assert.strictEqual(ap.detail.split('\n').length, 3);
  assert.ok(!/covered/.test(ap.detail), 'the skipped item is not in what is approved');

  // apply: skips the unticked one, runs the rest in order as 'you', with the plan in the ledger reason.
  const res = await T.handle('card_plan_apply', { plan: good.plan, skip: [4] });
  assert.deepStrictEqual([res.status, res.applied, res.failed, res.skipped], ['applied', 3, 0, 1]);
  assert.deepStrictEqual(res.items.map((i) => i.status), ['applied', 'applied', 'applied', 'skipped']);
  assert.strictEqual((await row(a)).status, 'dropped', 'close = dismiss by default');
  assert.strictEqual((await row(c)).status, 'open', 'the unticked item did nothing');
  assert.strictEqual((await row(b)).summary, 'Send Q3 numbers to Ada by Friday');
  assert.match((await row(b)).detail, /Note \(\d{4}-\d{2}-\d{2}\): she asked twice/);
  assert.ok((await row(b)).due_at, 'due set');
  const made = res.items[2].card;
  const mc = await row(made);
  assert.deepStrictEqual([mc.summary, mc.status], ['Migrate the billing VM to the new host', 'open']);
  assert.ok(mc.due_at && /phase 2/.test(mc.detail || ''), 'a created card carries its due date and details');
  const ha = await ledger.history(a);
  assert.deepStrictEqual([ha.at(-1).actor, ha.at(-1).to_status, ha.at(-1).reason], ['you', 'dropped', 'card plan #1: superseded by the migration plan']);
  const hb = await ledger.history(b);
  assert.match(hb.at(-1).reason, /edited title, details, due — card plan #1: deadline moved/);
  assert.strictEqual((await repo.cardPlans.planById(good.plan)).status, 'applied');
  assert.strictEqual((await plans.list({})).length, 0, 'an applied plan is no longer waiting');

  // Re-apply is a no-op: nothing runs twice (no second created card, no new ledger rows).
  const before = (await ledger.history(b)).length;
  const again = await plans.apply(good.plan);
  assert.strictEqual(again.ran, 0);
  assert.strictEqual((await ledger.history(b)).length, before);
  assert.strictEqual((await db.rows(`select id from commitment where summary = 'Migrate the billing VM to the new host'`)).length, 1);
  await assert.rejects(() => plans.discard(good.plan), /already applied/);

  // A failing item is recorded and the rest go on; it can be retried; a closed-meanwhile card is skipped, not failed.
  const d = await card('Renew the domain');
  const e1 = await card('Call the landlord');
  const f = await card('Water the plants');
  const p2 = await plans.propose({ title: 'Second set', items: [
    { op: 'edit', card: String(d), title: 'Renew the domain for 3 years', reason: 'longer term' },
    { op: 'close', card: String(e1), reason: 'not needed' },
    { op: 'edit', card: String(f), due: '2d', reason: 'soon' },
  ] });
  await db.query(`update commitment set due_at = null where id = $1`, [f]);
  await require('../src/commitments.ts').setStatus(e1, 'dropped'); // closed by hand before the apply
  // Make the first item fail: its card vanishes.
  await db.query('delete from commitment where id = $1', [d]);
  const r2 = await plans.apply(p2.id);
  assert.deepStrictEqual(r2.items.map((i) => i.status), ['failed', 'skipped', 'applied']);
  assert.match(r2.items[0].error, /no commitment/);
  assert.match(r2.items[1].error, /already dropped/);
  assert.strictEqual(r2.status, 'partly', 'a failure leaves the plan partly applied and waiting');
  assert.strictEqual((await plans.list({})).length, 1);
  assert.deepStrictEqual([r2.applied, r2.failed], [1, 1]);

  // discard: nothing changes, items are left out; a discarded plan cannot be applied.
  const g = await card('Archive old photos');
  const p3 = await plans.propose({ title: 'Third set', items: [{ op: 'close', card: String(g), reason: 'meh' }] });
  const dis = await plans.discard(p3.id);
  assert.strictEqual(dis.status, 'discarded');
  assert.strictEqual((await row(g)).status, 'open', 'discard changed no card');
  await assert.rejects(() => plans.apply(p3.id), /was discarded/);
  await assert.rejects(() => plans.apply(999), /no card plan #999/);
  await assert.rejects(() => plans.apply(p2.id, { skip: [9] }), /has 3 items, not 9/);

  // Unticking everything applies nothing and retires the plan.
  const h = await card('Pick up the parcel');
  const p4 = await plans.propose({ title: 'Fourth set', items: [{ op: 'close', card: String(h) }] });
  const none = await plans.apply(p4.id, { skip: '1' });
  assert.deepStrictEqual([none.status, none.applied, none.skipped], ['discarded', 0, 1]);
  assert.strictEqual((await row(h)).status, 'open');

  // A due date is stored as the moment shown at propose time, not as words re-read at apply time.
  const j = await card('Book the venue');
  const p5 = await plans.propose({ title: 'Fifth set', items: [{ op: 'edit', card: String(j), due: '2d' }, { op: 'edit', card: String(j), note: 'x' }] });
  const stored = JSON.parse((await repo.cardPlans.items(p5.id))[0].fields);
  assert.match(stored.due, /^at:[0-9]{4}-[0-9]{2}-[0-9]{2}T/, 'due is canonical');

  // An edit whose card was closed after the proposal is skipped, as a close is, not applied to the closed card.
  await require('../src/commitments.ts').setStatus(j, 'dropped');
  const r5 = await plans.apply(p5.id);
  assert.deepStrictEqual(r5.items.map((i) => i.status), ['skipped', 'skipped']);
  assert.strictEqual((await row(j)).due_at, null);

  // Retrying a create whose details step failed adopts the card it already made: no second card.
  const p6 = await plans.propose({ title: 'Sixth set', items: [{ op: 'create', title: 'Print the badges', details: 'two hundred' }] });
  const madeBadges = await card('Print the badges');
  const [it6] = await repo.cardPlans.items(p6.id);
  await repo.cardPlans.updateItem(it6.id, { status: 'failed', error: 'boom', result: JSON.stringify({ created: madeBadges }) });
  const r6 = await plans.apply(p6.id);
  assert.strictEqual(r6.items[0].status, 'applied');
  assert.strictEqual(r6.items[0].result.created, madeBadges);
  assert.strictEqual((await db.rows(`select id from commitment where summary = 'Print the badges'`)).length, 1);
  assert.match((await row(madeBadges)).detail, /two hundred/);

  console.log('cardPlan: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
