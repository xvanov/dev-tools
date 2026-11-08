'use strict';

// Contract: src/repo/search.js (see test/repoContract.test.js).

const word = (uniq) => 'zq' + uniq('').replace(/[^0-9a-f]/g, '').replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);
const vec = (i) => `[${Array.from({ length: 1536 }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;
const ids = (list) => list.map((r) => Number(r.id));
const DAY = 86_400_000;

module.exports = {
  'staleChunks: chunks whose context version differs, with their item': async ({ repos, seed, assert }) => {
    const item = await seed.sourceItem({ subject: 'stale subject' });
    const chunk = await seed.memChunk(item, { contextV: 0 });
    const got = (await repos.search.staleChunks(98, 100000)).find((r) => Number(r.id) === chunk);
    assert.deepStrictEqual([got.source, got.subject, got.author_identity], ['graph_mail', 'stale subject', null]);
    assert.ok(got.occurred_at instanceof Date && 'raw' in got);
    assert.ok(!(await repos.search.staleChunks(0, 100000)).some((r) => Number(r.id) === chunk), 'current version');
    assert.ok((await repos.search.staleChunks(98, 1)).length <= 1);
  },

  'staleChunks: versions below and above both count, newest first, the limit on the newest': async ({ repos, seed, assert }) => {
    const item = await seed.sourceItem();
    const low = await seed.memChunk(item, { contextV: 1, ord: 0 });
    const current = await seed.memChunk(item, { contextV: 3, ord: 1 });
    const high = await seed.memChunk(item, { contextV: 5, ord: 2 });
    const got = (await repos.search.staleChunks(3, 100000)).map((r) => Number(r.id));
    assert.ok(got.includes(low) && got.includes(high) && !got.includes(current));
    for (let i = 1; i < got.length; i++) assert.ok(got[i - 1] > got[i], 'newest first');
    assert.deepStrictEqual((await repos.search.staleChunks(3, 2)).map((r) => Number(r.id)), got.slice(0, 2));
  },

  'reheadChunk: new header and version, embedding cleared for the next backfill': async ({ repos, seed, assert }) => {
    const item = await seed.sourceItem();
    const chunk = await seed.memChunk(item, { contextV: 0, embedding: vec(40) });
    assert.ok(!ids(await repos.search.chunksMissingEmbedding(100000)).includes(chunk));
    await repos.search.reheadChunk(chunk, 'mail · today · someone', 97);
    assert.ok(ids(await repos.search.chunksMissingEmbedding(100000)).includes(chunk), 'embedding cleared');
    assert.ok(!(await repos.search.staleChunks(97, 100000)).some((r) => Number(r.id) === chunk), 'now at version 97');
  },

  'chunksMissingEmbedding: chunks with no vector, newest first': async ({ repos, seed, assert }) => {
    const a = await seed.memChunk(await seed.sourceItem(), { content: 'first words', context: 'ctx a' });
    const b = await seed.memChunk(await seed.sourceItem());
    const embedded = await seed.memChunk(await seed.sourceItem(), { embedding: vec(42) });
    const got = await repos.search.chunksMissingEmbedding(100000);
    assert.ok(ids(got).includes(a) && ids(got).includes(b) && !ids(got).includes(embedded));
    assert.ok(ids(got).indexOf(b) < ids(got).indexOf(a));
    const mine = got.find((r) => Number(r.id) === a);
    assert.deepStrictEqual([mine.content, mine.context], ['first words', 'ctx a']);
    assert.strictEqual((await repos.search.chunksMissingEmbedding(1)).length, 1);
  },

  'setChunkEmbedding: a chunk stops missing its vector': async ({ repos, seed, assert }) => {
    const chunk = await seed.memChunk(await seed.sourceItem());
    await repos.search.setChunkEmbedding(chunk, vec(43));
    assert.ok(!ids(await repos.search.chunksMissingEmbedding(100000)).includes(chunk));
  },

  'lexicalPass: one row per item, strict needs every term, loose any; filters apply': async ({ repos, seed, uniq, assert }) => {
    const w = word(uniq);
    const item = await seed.sourceItem({ subject: 'lexical subject' });
    const chunk = await seed.memChunk(item, { content: `the ${w} export is late`, context: 'mail · lexical' });
    await seed.memChunk(item, { ord: 1, content: `also ${w} again` });

    const strict = await repos.search.lexicalPass(w, 10, {}, true);
    assert.deepStrictEqual(ids(strict), [item], 'one row per item');
    const r = strict[0];
    assert.deepStrictEqual([r.source, r.subject, Number(r.chunk_id), r.context], ['graph_mail', 'lexical subject', chunk, 'mail · lexical']);
    assert.ok(r.rank > 0 && r.content.includes(w) && r.snippet.includes(w) && !r.snippet.includes('<b>'));

    assert.deepStrictEqual(await repos.search.lexicalPass(`${w} nonexistentterm`, 10, {}, true), [], 'strict: all terms');
    assert.deepStrictEqual(ids(await repos.search.lexicalPass(`${w} nonexistentterm`, 10, {}, false)), [item], 'loose: any term');

    assert.deepStrictEqual(ids(await repos.search.lexicalPass(w, 10, { sources: ['graph_mail'] }, true)), [item]);
    assert.deepStrictEqual(await repos.search.lexicalPass(w, 10, { sources: ['jira_issue'] }, true), []);
    assert.deepStrictEqual(await repos.search.lexicalPass(w, 10, { since: new Date(Date.now() + DAY) }, true), []);
    assert.deepStrictEqual(await repos.search.lexicalPass(w, 10, { until: new Date(Date.now() - DAY) }, true), []);
    assert.deepStrictEqual(ids(await repos.search.lexicalPass(w, 10, { since: new Date(Date.now() - DAY), until: new Date(Date.now() + DAY) }, true)), [item]);
  },

  'vectorPass: nearest chunk per item by cosine, with or without filters': async ({ repos, seed, assert }) => {
    const near = await seed.sourceItem({ subject: 'near' });
    const far = await seed.sourceItem({ subject: 'far' });
    const nearChunk = await seed.memChunk(near, { content: 'near words', embedding: vec(50) });
    await seed.memChunk(near, { ord: 1, embedding: vec(51) });
    await seed.memChunk(far, { embedding: vec(51) });
    await seed.memChunk(await seed.sourceItem(), { content: 'no vector' });

    for (const filters of [{}, { sources: ['graph_mail'] }]) {
      const got = await repos.search.vectorPass(vec(50), 1000, filters);
      const order = ids(got);
      assert.ok(order.indexOf(near) >= 0 && order.indexOf(near) < order.indexOf(far), JSON.stringify(filters));
      assert.strictEqual(order.filter((x) => x === near).length, 1, 'one row per item');
      const r = got.find((x) => Number(x.id) === near);
      assert.deepStrictEqual([Number(r.chunk_id), r.content, r.snippet, r.subject], [nearChunk, 'near words', 'near words', 'near']);
      assert.ok(Math.abs(r.rank - 1) < 1e-6);
    }
    assert.deepStrictEqual(await repos.search.vectorPass(vec(50), 10, { sources: ['jira_issue'] }), []);
    assert.strictEqual((await repos.search.vectorPass(vec(50), 1, {})).length, 1);
  },

  'knownPeople: everyone with their identities as kind:value': async ({ repos, seed, uniq, assert }) => {
    const w = uniq('kp');
    const id = await seed.memPerson({ name: `Known ${w}` });
    await seed.memIdentity(id, 'smtp', `${w}@example.test`);
    await seed.memIdentity(id, 'github_username', `gh-${w}`);
    const lone = await seed.memPerson({ name: `Lone ${w}` });
    const all = await repos.search.knownPeople();
    const mine = all.find((p) => Number(p.id) === id);
    assert.deepStrictEqual([mine.display_name, mine.is_me, [...mine.identities].sort()], [`Known ${w}`, false, [`github_username:gh-${w}`, `smtp:${w}@example.test`]]);
    assert.deepStrictEqual(all.find((p) => Number(p.id) === lone).identities, []);
  },

  'peopleItems: newest items authored by, or mentioning, the named people': async ({ repos, seed, db, uniq, assert }) => {
    const w = uniq('pi');
    const authored = await seed.sourceItem();
    await db.query('update source_item set author_identity = $2 where id = $1', [authored, `github:${w}`]);
    const mentioned = await seed.sourceItem({ occurredAt: new Date(Date.now() - DAY) });
    await db.query(`update source_item set raw = $2::jsonb where id = $1`, [mentioned, JSON.stringify({ to: `${w}@example.test` })]);
    const unrelated = await seed.sourceItem();
    const chunk = await seed.memChunk(authored, { content: 'authored words', context: 'ctx' });
    const got = await repos.search.peopleItems([`github:${w}`], [`%${w}@example.test%`], 10, {});
    assert.deepStrictEqual(ids(got), [authored, mentioned], 'newest first');
    assert.deepStrictEqual([Number(got[0].chunk_id), got[0].content, got[0].context], [chunk, 'authored words', 'ctx']);
    assert.deepStrictEqual([got[1].chunk_id, got[1].context], [null, '']);
    assert.ok(typeof Number(got[0].rank) === 'number' && Number(got[0].rank) > Number(got[1].rank), 'rank is recency');
    assert.ok(!ids(got).includes(unrelated));
    assert.strictEqual((await repos.search.peopleItems([`github:${w}`], [`%${w}@example.test%`], 1, {})).length, 1);
    assert.deepStrictEqual(ids(await repos.search.peopleItems([`github:${w}`], [`%${w}@example.test%`], 10, { until: new Date(Date.now() - 12 * 3600_000) })), [mentioned]);
  },

  'itemsById: items with their first chunk\'s words': async ({ repos, seed, assert }) => {
    const withChunk = await seed.sourceItem({ subject: 'has chunk', body: 'body text' });
    await seed.memChunk(withChunk, { content: 'chunk words', context: 'chunk ctx' });
    const bare = await seed.sourceItem({ subject: 'no chunk', body: 'only body' });
    const got = await repos.search.itemsById([withChunk, bare]);
    const a = got.find((r) => Number(r.id) === withChunk);
    const b = got.find((r) => Number(r.id) === bare);
    assert.deepStrictEqual([a.subject, a.context, a.text, a.snippet], ['has chunk', 'chunk ctx', 'chunk words', 'chunk words']);
    assert.deepStrictEqual([b.context, b.text, b.snippet], [null, 'only body', 'only body']);
    assert.deepStrictEqual(await repos.search.itemsById([]), []);
  },

  'cacheGet: a hit returns the vector text and counts; a miss is null': async ({ repos, uniq, assert }) => {
    const norm = uniq('q');
    assert.strictEqual(await repos.search.cacheGet('m', 3, norm), null);
    await repos.search.cachePut('m', 3, norm, '[1,2,3]');
    assert.deepStrictEqual(JSON.parse(await repos.search.cacheGet('m', 3, norm)), [1, 2, 3]);
    assert.strictEqual(await repos.search.cacheGet('m', 4, norm), null, 'other dims');
    assert.strictEqual(await repos.search.cacheGet('other', 3, norm), null, 'other model');
  },

  'cachePut: stores under model, dims and text; a repeat keeps the first vector': async ({ repos, uniq, assert }) => {
    const norm = uniq('put');
    await repos.search.cachePut('m', 3, norm, '[1,0,0]');
    await repos.search.cachePut('m', 3, norm, '[0,1,0]');
    assert.deepStrictEqual(JSON.parse(await repos.search.cacheGet('m', 3, norm)), [1, 0, 0]);
  },

  'cacheTrim: keeps the newest N entries by last use': async ({ repos, uniq, assert }) => {
    const model = uniq('trim');
    for (let i = 0; i < 4; i++) {
      await repos.search.cachePut(model, 3, `q${i}`, '[1,2,3]');
      await new Promise((r) => setTimeout(r, 5));
    }
    await repos.search.cacheGet(model, 3, 'q0'); // q0 is now the most recently used
    await repos.search.cacheTrim(1);
    assert.notStrictEqual(await repos.search.cacheGet(model, 3, 'q0'), null);
    for (const gone of ['q1', 'q2', 'q3']) assert.strictEqual(await repos.search.cacheGet(model, 3, gone), null, gone);
  },
};
