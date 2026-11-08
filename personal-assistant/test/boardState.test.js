'use strict';

// What /api/state reads on every board refresh (plan 8.4.33): not the
// reviews it never draws, and on SQLite each source's newest fetched_at from
// an index rather than from every row of the source.

const assert = require('assert');

async function main() {
  const repo = require('../src/repo');
  const calls = [];
  Object.assign(repo.commitments, { openForBrief: async () => [] });
  Object.assign(repo.runs, { activeForBrief: async () => [], reviewForBrief: async () => [] });
  Object.assign(repo.sources, {
    calendarToday: async () => [],
    recentReviews: async () => {
      calls.push('recentReviews');
      return [{ subject: 'a PR' }];
    },
  });
  const { gather } = require('../src/brief');
  assert.deepStrictEqual((await gather({ horizonDays: 7, reviews: false })).reviews, []);
  assert.deepStrictEqual(calls, [], 'the board does not read the reviews');
  assert.strictEqual((await gather({ horizonDays: 7 })).reviews.length, 1, 'pa brief still does');
  const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'dashboard', 'server.ts'), 'utf8');
  assert.match(server, /gather\(\{ horizonDays: 7, reviews: false \}\)/, '/api/state asks without reviews');

  const b = await require('./contract/_backends').sqlite();
  if (b.skip) return console.log(`boardState.test.js ok (SQLite plan skipped: ${b.skip})`);
  try {
    const plan = await b.db.rows(`explain query plan select max(si.fetched_at) from source_item si where si.source = 'graph_chat'`);
    assert.ok(plan.some((r) => /COVERING INDEX source_item_fetched_idx/.test(r.detail)), JSON.stringify(plan));
  } finally {
    await b.teardown();
  }
  console.log('boardState.test.js ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
