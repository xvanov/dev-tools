'use strict';

// Embedding spend reaches llm_spend (the Meter): tokens from the endpoint's
// `usage`, cost at config.embeddings.usdPerMTokens, one row per call, a failed
// call as a $0 not-ok row, and a cached query costing nothing. No network, no
// database: fetch and the store are stubbed.

const assert = require('assert');
const path = require('path');

const fake = { inserts: [] };
const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'db'));
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    async query(sql, params) {
      if (/llm_spend/.test(sql)) fake.inserts.push(params);
      return { rows: [], rowCount: 0 };
    },
    async one() { return { usd: 0 }; },
    async rows() { return []; },
    async withTx() { return []; },
  },
};

const { config } = require('../src/config');
config.embeddings.endpoint = 'https://example.invalid';
config.embeddings.apiKey = 'test-key';
config.embeddings.dimensions = 3;
const search = require('../src/search');

let fetches = 0;
let status = 200;
let tokens = 1000;
global.fetch = async (url, init) => {
  fetches++;
  const n = JSON.parse(init.body).input.length;
  return {
    ok: status === 200,
    status,
    headers: { get: () => null },
    json: async () => ({ data: Array.from({ length: n }, () => ({ embedding: [1, 2, 3] })), usage: { prompt_tokens: tokens, total_tokens: tokens } }),
  };
};

(async () => {
  assert.strictEqual(config.embeddings.usdPerMTokens, 0.02);

  // A batch: tokens from usage, cost = tokens * $0.02 / 1M, recorded under its purpose.
  const v = await search.embed(['a', 'b'], { purpose: 'embed-claim' });
  assert.strictEqual(v.length, 2);
  assert.deepStrictEqual(v.usage, { tokens: 1000, usd: 0.00002 });
  assert.strictEqual(fake.inserts.length, 1);
  const [purpose, model, backend, cost, inTok, , , ok] = fake.inserts[0];
  assert.strictEqual(purpose, 'embed-claim');
  assert.strictEqual(model, config.embeddings.deployment);
  assert.strictEqual(backend, 'azure');
  assert.strictEqual(Number(cost), 0.00002);
  assert.strictEqual(inTok, 1000);
  assert.strictEqual(ok, true);

  // Default purpose.
  await search.embed(['x']);
  assert.strictEqual(fake.inserts[1][0], 'embed');

  // A query goes through the cache: the second ask costs nothing and records nothing.
  search.queryEmbedder.clear();
  const before = fetches;
  await search.embedQuery('Where is  the PR?');
  await search.embedQuery('where is the pr?');
  assert.strictEqual(fetches - before, 1);
  assert.strictEqual(fake.inserts.length, 3);
  assert.strictEqual(fake.inserts[2][0], 'embed-query');

  // No usage in the reply: ~4 characters per token.
  assert.strictEqual(search.embedTokens({}, ['abcdefgh', 'abcd']), 3);
  assert.strictEqual(search.embedTokens({ usage: { total_tokens: 7 } }, ['abcdefgh']), 7);

  // A failed call is a $0 row marked not ok, and returns null.
  status = 500;
  assert.strictEqual(await search.embed(['y'], { purpose: 'embed-page' }), null);
  const last = fake.inserts[fake.inserts.length - 1];
  assert.strictEqual(last[0], 'embed-page');
  assert.strictEqual(Number(last[3]), 0);
  assert.strictEqual(last[7], false);

  console.log('embedMeter tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
