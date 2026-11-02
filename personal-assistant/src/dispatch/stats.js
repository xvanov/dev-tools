'use strict';

// "Which route works for which task" (sql/024): runs grouped by route × the
// commitment's kind, with outcomes and the factory's reported cost. The
// grouping is routeCore.summarize, pure and tested; this is only the query.
// It is also what a later evidence-based route chooser would read.

const { rows } = require('../db');
const { summarize } = require('./routeCore');

async function byRoute({ days = 90 } = {}) {
  const list = await rows(
    `select r.route, coalesce(r.kind, c.kind) as kind, r.outcome, r.status, r.cost_usd
       from run r left join commitment c on c.id = r.commitment_id
      where r.started_at > now() - make_interval(days => $1::int)`,
    [days]
  );
  return summarize(list);
}

module.exports = { byRoute };
