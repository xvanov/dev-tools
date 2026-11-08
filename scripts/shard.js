'use strict';
// Test sharding, the test-side half of `shards` in <tool>/test/runner.config.js.
//
// A slow test file made of independent top-level blocks can be split across N parallel processes:
// the runner starts the file N times with TEST_SHARD_INDEX / TEST_SHARD_COUNT set, and each block
// is wrapped in `if (owns()) { ... }`. Blocks are dealt out round-robin in the order owns() is
// called; a process that is not sharded (plain `node test/x.test.js`) owns everything. Code outside
// the wrapped blocks (stubs, helpers, setup) runs in every shard, so it must be cheap.
const count = Math.max(1, Number(process.env.TEST_SHARD_COUNT) || 1);
const index = Number(process.env.TEST_SHARD_INDEX) || 0;
let seen = 0;

/** True when this process should run the next block. Call it exactly once per block, in order. */
function owns() {
  const mine = count === 1 || seen % count === index;
  seen += 1;
  return mine;
}

module.exports = { owns, count, index };
