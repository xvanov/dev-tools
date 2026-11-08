'use strict';

// Contract: src/repo/people.js (see test/repoContract.test.js).

module.exports = {
  'me: the person flagged is_me': async ({ repos, seed, db, assert }) => {
    await db.query(`update person set is_me = false where is_me`);
    assert.strictEqual(await repos.people.me(), null);
    const id = await seed.personWith({ name: 'Me Myself', email: 'me@x.test', isMe: true });
    const me = await repos.people.me();
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
};
