'use strict';

// Contract: src/repo/people.js (see test/repoContract.test.js).

/** The is_me person, made when there is none yet. */
async function me({ repos }) {
  return (await repos.people.meRow()) || { id: (await repos.people.insertMe('Me Example', null)).id };
}

module.exports = {
  'me: the person flagged is_me': async ({ repos, seed, db, assert }) => {
    await db.query(`update person set is_me = false where is_me`);
    assert.strictEqual(await repos.people.meRow(), null);
    const id = await seed.personWith({ name: 'Me Myself', email: 'me@x.test', isMe: true });
    const me = await repos.people.meRow();
    assert.deepStrictEqual([Number(me.id), me.display_name, me.primary_email], [id, 'Me Myself', 'me@x.test']);
  },

  'identitiesOf: kind and value of every identity of a person': async ({ repos, seed, assert, uniq }) => {
    const p = await seed.personWith();
    const smtp = uniq('smtp');
    const gh = uniq('gh');
    await seed.identity(p, 'smtp', smtp);
    await seed.identity(p, 'github_username', gh);
    const other = await seed.personWith();
    await seed.identity(other, 'smtp', uniq('smtp'));
    const got = await repos.people.identitiesOf(p);
    assert.deepStrictEqual(got.map((r) => [r.kind, r.value]).sort(), [['github_username', gh], ['smtp', smtp]]);
    assert.deepStrictEqual(await repos.people.identitiesOf(999999999), []);
  },

  'otherByEmail: someone other than me, by primary email or an smtp identity': async ({ repos, seed, assert, uniq }) => {
    const primary = `${uniq('primary')}@x.test`;
    const a = await seed.personWith({ name: 'Primary', email: primary });
    const alias = `${uniq('alias')}@x.test`;
    const b = await seed.personWith({ name: 'Aliased', email: null });
    await seed.identity(b, 'smtp', alias);
    assert.strictEqual(Number((await repos.people.otherByEmail(primary)).id), a);
    const viaAlias = await repos.people.otherByEmail(alias);
    assert.deepStrictEqual([Number(viaAlias.id), viaAlias.display_name], [b, 'Aliased']);
    assert.strictEqual(await repos.people.otherByEmail(`${uniq('nobody')}@x.test`), null);
    const myEmail = `${uniq('me')}@x.test`;
    await seed.personWith({ name: 'Self', email: myEmail, isMe: true });
    assert.strictEqual(await repos.people.otherByEmail(myEmail), null, 'never me');
  },

  'namesForEmails: display names for lowercased addresses the store knows': async ({ repos, seed, assert, uniq }) => {
    const e1 = `${uniq('one')}@x.test`;
    const e2 = `${uniq('two')}@x.test`;
    await seed.personWith({ name: 'One', email: e1 });
    const p2 = await seed.personWith({ name: 'Two', email: null });
    await seed.identity(p2, 'smtp', e2);
    const got = await repos.people.namesForEmails([e1, e2, `${uniq('x')}@x.test`]);
    assert.deepStrictEqual(got.map((r) => [r.email, r.display_name]).sort(), [[e1, 'One'], [e2, 'Two']].sort());
    assert.deepStrictEqual(await repos.people.namesForEmails([]), []);
  },

  'myIdentities: the identities of the person marked me, only': async ({ repos, seed, db, assert }) => {
    const me = (await db.one(`select id from person where is_me`)) || { id: await seed.person('Me Example') };
    await db.query('update person set is_me = true where id = $1', [me.id]);
    const other = await seed.person('Someone Else');
    await db.query(`insert into person_identity (person_id, kind, value) values ($1, 'smtp', 'me@example.com'), ($2, 'smtp', 'else@example.com')`, [me.id, other]);
    const ids = await repos.people.myIdentities();
    assert.ok(ids.some((i) => i.kind === 'smtp' && i.value === 'me@example.com'));
    assert.ok(!ids.some((i) => i.value === 'else@example.com'));
  },

  'meRow: null before sign-in, then the whole is_me row': async ({ repos, assert }) => {
    const first = await repos.people.meRow();
    const made = first || (await repos.people.insertMe('Me Example', 'me@example.com'));
    const got = await repos.people.meRow();
    assert.ok(got.is_me);
    assert.strictEqual(String(got.id), String(first ? first.id : made.id));
  },

  'meName: the display name of the is_me person': async ({ repos, assert, ...t }) => {
    await me({ repos });
    const row = await repos.people.meName();
    assert.strictEqual(typeof row.display_name, 'string');
  },

  'myHandle: your own handle of one identity kind': async ({ repos, assert, uniq, ...t }) => {
    const m = await me({ repos });
    const kind = uniq('kind');
    assert.strictEqual(await repos.people.myHandle(kind), null);
    await repos.people.addIdentity(m.id, kind, 'zed');
    await repos.people.addIdentity(m.id, kind, 'abe');
    assert.strictEqual((await repos.people.myHandle(kind)).value, 'abe', 'lowest value first');
  },

  'setNames: display name and primary email': async ({ repos, seed, assert, uniq }) => {
    const p = await seed.person('Before');
    const email = `${uniq('sn')}@example.com`;
    await repos.people.setNames(p, 'After', email);
    const row = await repos.people.byPrimaryEmail(email);
    assert.strictEqual(Number(row.id), p);
    assert.strictEqual((await repos.people.pair(p, p))[0].display_name, 'After');
  },

  'insertMe: the is_me person, returned with its id': async ({ repos, assert }) => {
    const row = await repos.people.insertMe('Another Me', null);
    assert.ok(row.id);
    const pair = await repos.people.pair(row.id, row.id);
    assert.deepStrictEqual([pair[0].display_name, pair[0].is_me, pair[0].primary_email], ['Another Me', true, null]);
    await repos.people.deleteById(row.id);
  },

  'addIdentity: files an identity once; the first owner keeps it': async ({ repos, seed, assert, uniq }) => {
    const [a, b] = [await seed.person(), await seed.person()];
    const value = `${uniq('id')}@example.com`;
    await repos.people.addIdentity(a, 'smtp', value);
    await repos.people.addIdentity(b, 'smtp', value);
    assert.strictEqual(Number((await repos.people.identityOwner('smtp', value)).person_id), a);
  },

  'byDisplayName: up to two people with the name, case-insensitive': async ({ repos, seed, assert, uniq }) => {
    const name = uniq('Nameless');
    assert.deepStrictEqual(await repos.people.byDisplayName(name), []);
    const a = await seed.person(name);
    assert.deepStrictEqual((await repos.people.byDisplayName(name.toUpperCase())).map((r) => Number(r.id)), [a]);
    await seed.person(name);
    await seed.person(name);
    assert.strictEqual((await repos.people.byDisplayName(name)).length, 2, 'two means ambiguous');
  },

  'identityOwner: who owns (kind, value), or null': async ({ repos, seed, assert, uniq }) => {
    const p = await seed.person();
    const value = uniq('owner');
    assert.strictEqual(await repos.people.identityOwner('gitlab_username', value), null);
    await repos.people.addIdentity(p, 'gitlab_username', value);
    assert.strictEqual(Number((await repos.people.identityOwner('gitlab_username', value)).person_id), p);
    assert.strictEqual(await repos.people.identityOwner('github_username', value), null, 'kind matters');
  },

  'byPrimaryEmail: matches a lower-case address case-insensitively': async ({ repos, assert, uniq }) => {
    const email = `${uniq('pe')}@example.com`;
    const row = await repos.people.insert('Mixed', email.toUpperCase());
    assert.strictEqual(Number((await repos.people.byPrimaryEmail(email)).id), Number(row.id));
    assert.strictEqual(await repos.people.byPrimaryEmail('nobody@example.com'), null);
  },

  'insert: a person that is not you': async ({ repos, assert }) => {
    const row = await repos.people.insert('Someone', null);
    const got = (await repos.people.pair(row.id, row.id))[0];
    assert.deepStrictEqual([got.display_name, got.is_me, got.primary_email], ['Someone', false, null]);
  },

  'othersByExactName: not you, case-insensitive, at most two': async ({ repos, seed, assert, uniq }) => {
    const name = uniq('Exact Person');
    assert.deepStrictEqual(await repos.people.othersByExactName(name), []);
    const a = await seed.person(name);
    const got = await repos.people.othersByExactName(name.toLowerCase());
    assert.deepStrictEqual(got.map((r) => [Number(r.id), r.display_name]), [[a, name]]);
    await seed.person(name);
    await seed.person(name);
    assert.strictEqual((await repos.people.othersByExactName(name)).length, 2);
    const meRow = await repos.people.insertMe(uniq('Exact Me'), null);
    assert.deepStrictEqual(await repos.people.othersByExactName((await repos.people.pair(meRow.id, meRow.id))[0].display_name), []);
    await repos.people.deleteById(meRow.id);
  },

  'othersByNamePrefix: starts with the (escaped) prefix, case-insensitive, at most two': async ({ repos, seed, assert, uniq }) => {
    const stem = uniq('Zq').replace('-', '');
    const a = await seed.person(`${stem} Alpha`);
    assert.deepStrictEqual((await repos.people.othersByNamePrefix(stem.toLowerCase())).map((r) => Number(r.id)), [a]);
    assert.deepStrictEqual(await repos.people.othersByNamePrefix(`\\%${stem}`), [], 'an escaped % is a literal character, not a wildcard');
    await seed.person(`${stem} Beta`);
    await seed.person(`${stem} Gamma`);
    assert.strictEqual((await repos.people.othersByNamePrefix(stem)).length, 2);
  },

  'pair: both rows of a merge by id': async ({ repos, seed, assert }) => {
    const [a, b] = [await seed.person('A'), await seed.person('B')];
    const got = await repos.people.pair(a, b);
    assert.deepStrictEqual(got.map((r) => Number(r.id)).sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
    assert.strictEqual((await repos.people.pair(a, 0)).length, 1);
  },

  'moveIdentities: every identity of one person to another': async ({ repos, seed, assert, uniq }) => {
    const [from, into] = [await seed.person(), await seed.person()];
    const [v1, v2] = [uniq('mv'), uniq('mv')];
    await repos.people.addIdentity(from, 'github_username', v1);
    await repos.people.addIdentity(from, 'gitlab_username', v2);
    await repos.people.moveIdentities(into, from);
    assert.strictEqual(Number((await repos.people.identityOwner('github_username', v1)).person_id), into);
    assert.strictEqual(Number((await repos.people.identityOwner('gitlab_username', v2)).person_id), into);
  },

  'deleteById: removes the person and its identities': async ({ repos, seed, assert, uniq }) => {
    const p = await seed.person();
    const v = uniq('del');
    await repos.people.addIdentity(p, 'github_username', v);
    await repos.people.deleteById(p);
    assert.deepStrictEqual(await repos.people.pair(p, p), []);
    assert.strictEqual(await repos.people.identityOwner('github_username', v), null);
  },

  'renameKeepingEmail: sets the name; fills primary_email only when empty': async ({ repos, seed, assert, uniq }) => {
    const emailA = `${uniq('rk')}@example.com`;
    const a = await repos.people.insert('A', null);
    await repos.people.renameKeepingEmail(a.id, 'A2', emailA);
    let row = (await repos.people.pair(a.id, a.id))[0];
    assert.deepStrictEqual([row.display_name, row.primary_email], ['A2', emailA]);
    await repos.people.renameKeepingEmail(a.id, 'A3', `${uniq('rk')}@example.com`);
    row = (await repos.people.pair(a.id, a.id))[0];
    assert.deepStrictEqual([row.display_name, row.primary_email], ['A3', emailA], 'an existing email is kept');
  },

  // --- for chunk F (ingest)
  'myPrimaryEmail: the primary email of a person marked me': async ({ repos, seed, db, assert, uniq }) => {
    if (!(await db.one('select id from person where is_me and primary_email is not null'))) await seed.personWith({ name: 'Me', email: `${uniq('me')}@x.test`, isMe: true });
    const got = (await repos.people.myPrimaryEmail()).primary_email;
    const mine = (await db.rows('select primary_email from person where is_me')).map((r) => r.primary_email);
    assert.ok(got && mine.includes(got), got);
  },
  'emailsByAadOid: primary email, else an smtp identity': async ({ repos, seed, assert, uniq }) => {
    const [o1, o2] = [uniq('oid'), uniq('oid')];
    const a = await seed.personWith({ name: 'A', email: 'a-primary@x.test' });
    await seed.identity(a, 'aad_oid', o1);
    const b = await seed.personWith({ name: 'B', email: null });
    await seed.identity(b, 'aad_oid', o2);
    await seed.identity(b, 'smtp', 'b-smtp@x.test');
    const got = new Map((await repos.people.emailsByAadOid([o1, o2])).map((r) => [r.oid, r.email]));
    assert.deepStrictEqual([got.get(o1), got.get(o2)], ['a-primary@x.test', 'b-smtp@x.test']);
  },

  // --- for dispatch, mcp (chunk E)

  'rowById: the whole person row; null when gone': async ({ repos, seed, assert }) => {
    const id = await seed.personWith({ name: 'Row Person' });
    assert.strictEqual((await repos.people.rowById(id)).display_name, 'Row Person');
    assert.strictEqual(await repos.people.rowById(999999999), null);
  },

  'findLoose: name, email or identity matching an ilike pattern': async ({ repos, seed, assert, uniq }) => {
    const tag = uniq('zq').replace('-', '');
    const p = await seed.personWith({ name: `Loose ${tag} Name`, email: null });
    assert.strictEqual(Number((await repos.people.findLoose(`%${tag}%`)).id), p);
    const q = await seed.personWith({ name: 'Plain', email: null });
    const ident = uniq('identzq').replace('-', '');
    await seed.identity(q, 'smtp', `${ident}@x.test`);
    assert.strictEqual(Number((await repos.people.findLoose(`%${ident}%`)).id), q);
    assert.strictEqual(await repos.people.findLoose('%nobody-matches-this-zzz%'), null);
  },
};