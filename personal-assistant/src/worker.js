'use strict';

// The worker: everything that happens without you typing anything.
//
// It is a scheduler of periodic passes, not a job queue. There is no `job`
// table, no broker, and nothing to drain after a crash — "work to do" is a
// query (items with no distillation row at the current prompt version), so a
// process that dies mid-pass simply picks the same work up next tick.
//
// Passes never overlap with themselves. A slow Graph poll must not stack up
// behind a slower one; skipping a tick is always the right answer, because the
// next one will see the same delta.

const { config } = require('./config');
const { logger } = require('./log');
const db = require('./db');

const log = logger('worker');

const running = new Set();

function every(seconds, name, fn) {
  const tick = async () => {
    if (running.has(name)) {
      log.debug('skipping overlapping pass', { name });
      return;
    }
    running.add(name);
    try {
      await fn();
    } catch (err) {
      log.warn('pass failed', { name, message: err.message });
    } finally {
      running.delete(name);
    }
  };
  // One immediate pass so a freshly started worker is useful straight away.
  setTimeout(tick, 2000 + Math.random() * 3000);
  return setInterval(tick, seconds * 1000);
}

async function main() {
  log.info('starting', {
    graphPoll: config.graph.pollSeconds,
    gitlabPoll: config.gitlab.pollSeconds,
    db: config.databaseUrl.replace(/:[^:@/]*@/, ':***@'),
  });

  const { migrate } = require('./db/migrate');
  await migrate();

  const ingest = require('./ingest');
  const distill = require('./distill');
  const search = require('./search');
  const dispatch = require('./dispatch');

  every(config.graph.pollSeconds, 'graph', async () => {
    await ingest.runAll(['graph_mail', 'graph_event', 'graph_chat']);
  });

  every(config.gitlab.pollSeconds, 'gitlab', async () => {
    await ingest.runAll(['gitlab']);
  });

  // Local files, so this can be frequent and cheap.
  every(120, 'sessions', async () => {
    await ingest.runAll(['claude_session']);
  });

  every(90, 'distill', async () => {
    await distill.run({ limit: 15 });
  });

  every(300, 'embed', async () => {
    await search.backfillEmbeddings({ limit: 256 });
  });

  // A run whose termhub session has gone is not running, whatever the table
  // says — reboots and killed sessions both land here.
  every(120, 'runs', async () => {
    await dispatch.reconcile();
  });

  every(3600, 'retention', async () => {
    const result = await db.query(
      `delete from source_item
        where source in ('graph_mail','graph_chat')
          and occurred_at < now() - ($1 || ' days')::interval`,
      [String(config.retention.rawItemDays)]
    );
    if (result.rowCount) log.info('retention', { deleted: result.rowCount });
  });

  const shutdown = async (signal) => {
    log.info('stopping', { signal });
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    log.error('worker failed to start', { message: err.message });
    process.exit(1);
  });
}

module.exports = { every };
