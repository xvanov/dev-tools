'use strict';

// "Which route works for which task" (sql/024): runs grouped by route × the
// commitment's kind, with outcomes and the factory's reported cost. The
// grouping is routeCore.summarize, pure and tested; this is only the query.
// It is also what a later evidence-based route chooser would read.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const repo = require('../repo');
const { summarize } = require('./routeCore');

async function byRoute({ days = 90 }: { days?: number } = {}) {
  const list = await repo.runs.forRouteStats(days);
  return summarize(list);
}

module.exports = { byRoute };
