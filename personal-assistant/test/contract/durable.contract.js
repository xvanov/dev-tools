'use strict';

// Contract: src/repo/durable.js (see test/repoContract.test.js). The Absurd
// queue 'pa' is created by sql/019 (Postgres); a queue with no tasks counts nothing.

module.exports = {
  'stats: counts per task and state; a bad queue name is refused': async ({ repos, assert }) => {
    const got = await repos.durable.stats('pa');
    assert.ok(Array.isArray(got) && got.every((r) => 'task_name' in r && 'state' in r && Number.isInteger(r.n)));
    await assert.rejects(repos.durable.stats('pa; drop table x'), /bad queue name/);
  },

  'commitmentsWithoutChase: open asks owed to me by a person, from chat or mail, with no chase task': async ({ repos, seed, assert }) => {
    const who = await seed.personWith();
    const mk = async (o = {}) => {
      const item = await seed.item({ source: o.source || 'graph_chat', occurredAt: o.occurredAt });
      const id = await seed.commitment({ sourceItemId: item, direction: o.direction || 'owed_to_me', status: o.status });
      await seed.commitmentSet(id, { counterparty_person_id: o.person === undefined ? who : o.person });
      return id;
    };
    const ok = await mk();
    const mail = await mk({ source: 'graph_mail' });
    const toMe = await mk({ direction: 'owed_by_me' });
    const jira = await mk({ source: 'jira_issue' });
    const old = await mk({ occurredAt: new Date(Date.now() - 400 * 86400_000) });
    const nobody = await mk({ person: null });
    const closed = await mk({ status: 'done' });
    const ids = (await repos.durable.commitmentsWithoutChase(30)).map((r) => Number(r.id));
    assert.ok(ids.includes(ok) && ids.includes(mail));
    for (const x of [toMe, jira, old, nobody, closed]) assert.ok(!ids.includes(x), `commitment ${x} is not due a chase`);
    assert.ok(ids.length <= 50);
  },

  // SQLite runs durable tasks on its own queue (D19); its spawnTask is how a
  // chase exists there. On Postgres the same holds through Absurd, which these
  // cases do not drive.
  'commitmentsWithoutChase: an ask that has a chase task is left out (SQLite queue)': async ({ repos, seed, assert }) => {
    if (repos.backend.dialect !== 'sqlite') return;
    const who = await seed.personWith();
    const item = await seed.item({ source: 'graph_chat' });
    const id = await seed.commitment({ sourceItemId: item, direction: 'owed_to_me' });
    await seed.commitmentSet(id, { counterparty_person_id: who });
    assert.ok((await repos.durable.commitmentsWithoutChase(30)).some((r) => Number(r.id) === id));
    await repos.durable.spawnTask({ queue: 'pa', name: 'chase', params: { commitmentId: id }, key: `chase2:${id}` });
    assert.ok(!(await repos.durable.commitmentsWithoutChase(30)).some((r) => Number(r.id) === id));
  },

  'stats: a spawned task counts under its name and state (SQLite queue)': async ({ repos, assert, uniq }) => {
    if (repos.backend.dialect !== 'sqlite') return;
    const name = uniq('task').replace(/-/g, '_');
    const a = await repos.durable.spawnTask({ queue: 'pa', name, params: {}, key: uniq('k') });
    const again = await repos.durable.spawnTask({ queue: 'pa', name, params: {}, key: uniq('k') });
    assert.ok(a.created && again.created && a.id !== again.id);
    const row = (await repos.durable.stats('pa')).find((r) => r.task_name === name);
    assert.deepStrictEqual([row.state, row.n], ['pending', 2]);
  },
};
