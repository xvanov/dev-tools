'use strict';

// The query-embedding cache (src/search/embedCache.js): normalization, hit/miss,
// LRU eviction, and persistence through the table store. No database: the table
// is a Map behind a fake `query`, so this never touches a live store.

const assert = require('assert');
const { normalizeQuery, Lru, createQueryEmbedder, tableStore, parseVector, toVectorLiteral } = require('../src/search/embedCache.ts');

(async () => {
  // Normalization: trim, collapse whitespace, lower-case.
  assert.strictEqual(normalizeQuery('  What did\tAcme   say?\n'), 'what did acme say?');
  assert.strictEqual(normalizeQuery('ABC-12'), 'abc-12');
  assert.strictEqual(normalizeQuery(null), '');
  assert.strictEqual(normalizeQuery('   '), '');

  // LRU: the least recently used key goes first, and a get refreshes.
  {
    const l = new Lru(2);
    l.set('a', 1);
    l.set('b', 2);
    assert.strictEqual(l.get('a'), 1); // a is now newest
    l.set('c', 3); // evicts b
    assert.strictEqual(l.get('b'), undefined);
    assert.strictEqual(l.get('a'), 1);
    assert.strictEqual(l.get('c'), 3);
    assert.strictEqual(l.size, 2);
  }

  // Vector text round-trips.
  assert.deepStrictEqual(parseVector(toVectorLiteral([0.5, -1, 0.25])), [0.5, -1, 0.25]);
  assert.strictEqual(parseVector(''), null);

  const model = () => 'text-embedding-3-small';
  const dims = () => 3;
  const mk = (extra = {}) => {
    const calls = [];
    const embedFn = async (text) => {
      calls.push(text);
      return [text.length, 1, 0];
    };
    return { calls, e: createQueryEmbedder({ embedFn, model, dims, ...extra }) };
  };

  // Miss then hit; variants of one question share one embed, of the normalized text.
  {
    const { calls, e } = mk();
    const v1 = await e.get('  Hello   World ');
    const v2 = await e.get('hello world');
    const v3 = await e.get('HELLO\nWORLD');
    assert.deepStrictEqual(calls, ['hello world']);
    assert.deepStrictEqual(v1, v2);
    assert.deepStrictEqual(v2, v3);
    assert.deepStrictEqual(e.stats, { memoryHits: 2, storeHits: 0, misses: 1 });
    await e.get('another question');
    assert.strictEqual(calls.length, 2);
  }

  // Empty query: nothing to embed.
  {
    const { calls, e } = mk();
    assert.strictEqual(await e.get('  '), null);
    assert.strictEqual(calls.length, 0);
  }

  // A failed embed returns null and is not cached: the next call tries again.
  {
    let n = 0;
    const e = createQueryEmbedder({ embedFn: async () => (++n === 1 ? null : [1, 2, 3]), model, dims });
    assert.strictEqual(await e.get('q'), null);
    assert.deepStrictEqual(await e.get('q'), [1, 2, 3]);
    assert.strictEqual(n, 2);
  }

  // LRU eviction through the embedder: capacity 2, memory only.
  {
    const { calls, e } = mk({ max: 2 });
    await e.get('one');
    await e.get('two');
    await e.get('one'); // refresh one
    await e.get('three'); // evicts two
    assert.strictEqual(e.size(), 2);
    await e.get('one'); // still cached
    assert.strictEqual(calls.length, 3);
    await e.get('two'); // was evicted: embeds again
    assert.strictEqual(calls.length, 4);
  }

  // Model and dims are part of the key: changing either misses.
  {
    let m = 'a';
    const calls = [];
    const e = createQueryEmbedder({ embedFn: async (t) => (calls.push(t), [1, 2, 3]), model: () => m, dims });
    await e.get('q');
    await e.get('q');
    m = 'b';
    await e.get('q');
    assert.strictEqual(calls.length, 2);
  }

  // Persistence: the table store keeps the vector across a fresh embedder (a restart).
  {
    const table = new Map();
    const queries = [];
    const fakeDb = {
      async query(sql, params) {
        queries.push(sql);
        if (/^\s*update query_embedding_cache/.test(sql)) {
          const row = table.get(params.slice(0, 3).join('|'));
          return { rows: row ? [{ embedding: row }] : [] };
        }
        if (/^\s*insert into query_embedding_cache/.test(sql)) {
          table.set(params.slice(0, 3).join('|'), params[3]);
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const store = tableStore({ db: fakeDb });
    const a = mk({ store });
    const v = await a.e.get('Persist Me');
    assert.strictEqual(table.size, 1);
    assert.ok(table.has('text-embedding-3-small|3|persist me'));

    const b = mk({ store }); // "restart": empty memory, same table
    const w = await b.e.get('persist me');
    assert.deepStrictEqual(w, v);
    assert.strictEqual(b.calls.length, 0, 'served from the table, not the endpoint');
    assert.deepStrictEqual(b.e.stats, { memoryHits: 0, storeHits: 1, misses: 0 });

    // A stored vector of the wrong length (dims changed under the same key) is not served.
    table.set('text-embedding-3-small|3|stale', '[1,2]');
    const c = mk({ store });
    await c.e.get('stale');
    assert.strictEqual(c.calls.length, 1);
  }

  // The store is best effort: a failing table costs the hit, never the search.
  {
    const broken = { async query() { throw new Error('relation "query_embedding_cache" does not exist'); } };
    const { calls, e } = mk({ store: tableStore({ db: broken }) });
    assert.deepStrictEqual(await e.get('still works'), [11, 1, 0]);
    await e.get('still works'); // memory layer still serves it
    assert.strictEqual(calls.length, 1);
  }

  // The table is trimmed to maxRows every 25th write.
  {
    const sqls = [];
    const store = tableStore({ db: { async query(sql, p) { sqls.push({ sql, p }); return { rows: [] }; } }, maxRows: 7 });
    for (let i = 0; i < 25; i++) await store.put('m', 3, `q${i}`, [1, 2, 3]);
    const del = sqls.filter((s) => /^\s*delete from query_embedding_cache/.test(s.sql));
    assert.strictEqual(del.length, 1);
    assert.deepStrictEqual(del[0].p, [7]);
  }

  console.log('embedCache tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
