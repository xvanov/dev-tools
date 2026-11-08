'use strict';

// Contract: src/repo/secrets.js (see test/repoContract.test.js). Names are
// unique per case; no case stores a value (the table never holds one).

const req = (name, o = {}) => ({ kind: 'secret', name, purpose: 'p', hint: null, url: null, command: null, requestedBy: 'agent', target: 'credential-manager', ...o });
const NAME = (uniq) => uniq('PA_TEST_SECRET').toUpperCase().replace(/-/g, '_');

module.exports = {
  'open: a pending request; a second for the same name is a no-op (null)': async ({ repos, assert, uniq }) => {
    const name = NAME(uniq);
    const row = await repos.secrets.open(req(name, { hint: 'h', url: 'https://x.example', command: 'pa x' }));
    assert.deepStrictEqual([row.kind, row.name, row.status, row.hint, row.url, row.command, row.requested_by, row.target], ['secret', name, 'pending', 'h', 'https://x.example', 'pa x', 'agent', 'credential-manager']);
    assert.strictEqual(await repos.secrets.open(req(name)), null);
  },

  'pendingByName: the pending one, or null': async ({ repos, assert, uniq }) => {
    const name = NAME(uniq);
    assert.strictEqual(await repos.secrets.pendingByName(name), null);
    const row = await repos.secrets.open(req(name));
    assert.strictEqual(String((await repos.secrets.pendingByName(name)).id), String(row.id));
  },

  'pendingIdByName: its id, or null': async ({ repos, assert, uniq }) => {
    const name = NAME(uniq);
    assert.strictEqual(await repos.secrets.pendingIdByName(name), null);
    const row = await repos.secrets.open(req(name));
    assert.deepStrictEqual(Object.keys(await repos.secrets.pendingIdByName(name)), ['id']);
    assert.strictEqual(String((await repos.secrets.pendingIdByName(name)).id), String(row.id));
  },

  'byId: the row, or null': async ({ repos, assert, uniq }) => {
    const row = await repos.secrets.open(req(NAME(uniq)));
    assert.strictEqual((await repos.secrets.byId(row.id)).purpose, 'p');
    assert.strictEqual(await repos.secrets.byId(-1), null);
  },

  'kindOf: secret or login': async ({ repos, assert, uniq }) => {
    const s = await repos.secrets.open(req(NAME(uniq)));
    const l = await repos.secrets.open(req(`login:${uniq('svc')}`, { kind: 'login', target: 'action' }));
    assert.deepStrictEqual([(await repos.secrets.kindOf(s.id)).kind, (await repos.secrets.kindOf(l.id)).kind], ['secret', 'login']);
    assert.strictEqual(await repos.secrets.kindOf(-1), null);
  },

  'settle: declined or fulfilled, only while pending': async ({ repos, assert, uniq }) => {
    const a = await repos.secrets.open(req(NAME(uniq)));
    const b = await repos.secrets.open(req(NAME(uniq)));
    assert.deepStrictEqual(await repos.secrets.settle(a.id, 'declined').then((r) => [r.name, r.status]), [a.name, 'declined']);
    assert.strictEqual((await repos.secrets.byId(a.id)).fulfilled_at, null);
    await repos.secrets.settle(b.id, 'fulfilled');
    assert.ok((await repos.secrets.byId(b.id)).fulfilled_at instanceof Date);
    assert.strictEqual(await repos.secrets.settle(a.id, 'fulfilled'), null, 'not pending any more');
  },

  'fulfilPendingByName: every pending one for the name, with where it went': async ({ repos, assert, uniq }) => {
    const name = NAME(uniq);
    assert.deepStrictEqual(await repos.secrets.fulfilPendingByName(name, 'credential-manager'), []);
    const row = await repos.secrets.open(req(name));
    const done = await repos.secrets.fulfilPendingByName(name, 'env-file');
    assert.deepStrictEqual(done.map((d) => String(d.id)), [String(row.id)]);
    const after = await repos.secrets.byId(row.id);
    assert.deepStrictEqual([after.status, after.stored_in], ['fulfilled', 'env-file']);
  },

  'recordSetDirectly: a fulfilled row with no request': async ({ repos, assert, uniq }) => {
    const name = NAME(uniq);
    await repos.secrets.recordSetDirectly(name, 'you', 'credential-manager');
    const last = (await repos.secrets.lastSet()).find((r) => r.name === name);
    assert.strictEqual(last.stored_in, 'credential-manager');
    assert.strictEqual(await repos.secrets.pendingByName(name), null);
  },

  'fulfilPendingLogin: closes the pending login request': async ({ repos, assert, uniq }) => {
    const key = `login:${uniq('svc')}`;
    const row = await repos.secrets.open(req(key, { kind: 'login', target: 'action' }));
    await repos.secrets.fulfilPendingLogin(key);
    assert.strictEqual((await repos.secrets.byId(row.id)).status, 'fulfilled');
  },

  'pending: every pending one, oldest first': async ({ repos, assert, uniq }) => {
    const a = await repos.secrets.open(req(NAME(uniq)));
    await new Promise((r) => setTimeout(r, 5));
    const b = await repos.secrets.open(req(NAME(uniq)));
    const c = await repos.secrets.open(req(NAME(uniq)));
    await repos.secrets.settle(c.id, 'declined');
    const ids = (await repos.secrets.pending()).map((r) => String(r.id));
    assert.ok(ids.indexOf(String(a.id)) >= 0 && ids.indexOf(String(a.id)) < ids.indexOf(String(b.id)));
    assert.ok(!ids.includes(String(c.id)));
  },

  'expire: expired, with a time': async ({ repos, assert, uniq }) => {
    const row = await repos.secrets.open(req(NAME(uniq)));
    await repos.secrets.expire(row.id);
    const after = await repos.secrets.byId(row.id);
    assert.strictEqual(after.status, 'expired');
    assert.ok(after.fulfilled_at instanceof Date);
  },

  'lastSet: the newest set per secret name, logins and unstored left out': async ({ repos, db, assert, uniq }) => {
    const name = NAME(uniq);
    await repos.secrets.recordSetDirectly(name, 'you', 'credential-manager');
    await db.query(`update secret_request set fulfilled_at = now() - interval '1 day' where name = $1`, [name]);
    await repos.secrets.recordSetDirectly(name, 'you', 'env-file');
    const login = `login:${uniq('svc')}`;
    const l = await repos.secrets.open(req(login, { kind: 'login', target: 'action' }));
    await repos.secrets.settle(l.id, 'fulfilled');
    const rows = await repos.secrets.lastSet();
    assert.deepStrictEqual(rows.filter((r) => r.name === name).map((r) => r.stored_in), ['env-file']);
    assert.ok(!rows.some((r) => r.name === login));
  },
};
