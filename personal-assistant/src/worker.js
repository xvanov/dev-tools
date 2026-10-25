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

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { config } = require('./config');
const { logger } = require('./log');
const db = require('./db');

const exec = promisify(execFile);

// Runs the Python trim/transcribe pass. Kept as a subprocess rather than a
// long-lived service: it is idempotent, it holds a GPU only while it runs, and
// a crash costs one cycle rather than the capture stream.
async function runAudioProcess() {
  const script = path.join(__dirname, '..', 'audio', 'process.py');
  if (!fs.existsSync(config.audio.python)) {
    logger('worker').debug('audio venv missing — skipping the trim pass', {
      python: config.audio.python,
    });
    return;
  }
  const { stdout } = await exec(config.audio.python, [script, '--spool', config.audioDir], {
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PA_TRANSCRIBE_HOST: config.audio.transcribeHost,
      PA_TRANSCRIBE_PORT: String(config.audio.transcribePort),
      PA_AUDIO_EPISODE_GAP_SECONDS: String(config.audio.episodeGapSeconds),
      PA_AUDIO_ROLL_MINUTES: String(config.audio.rollMinutes),
      PA_AUDIO_SAMPLE_RATE: String(config.audio.sampleRate),
      PA_RETENTION_RAW_AUDIO_HOURS: String(config.retention.rawAudioHours),
    },
  });
  const last = stdout.trim().split(/\r?\n/).pop();
  if (last) logger('worker').info('audio pass', { result: last });
}

const log = logger('worker');

const running = new Set();

// Runs a pass unless that pass is already running. Every caller — the timer
// and the Teams fast path alike — goes through here, so a pass never overlaps
// itself however it was started. Resolves to whether it ran.
async function exclusive(name, fn) {
  if (running.has(name)) {
    log.debug('skipping overlapping pass', { name });
    return false;
  }
  running.add(name);
  try {
    await fn();
  } catch (err) {
    log.warn('pass failed', { name, message: err.message });
  } finally {
    running.delete(name);
  }
  return true;
}

function every(seconds, name, fn) {
  const tick = () => exclusive(name, fn);
  // One immediate pass so a freshly started worker is useful straight away.
  setTimeout(tick, 2000 + Math.random() * 3000);
  return setInterval(tick, seconds * 1000);
}

async function main() {
  // Below normal, so everything the worker starts — every headless `claude
  // -p`, the audio pass — inherits it and yields to whatever you are typing
  // into. The worker is never in a hurry; a pass a second later costs nothing,
  // while a model call at Normal priority made a terminal lag by seconds.
  try {
    require('os').setPriority(require('os').constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* not permitted here: run at the default */
  }

  log.info('starting', {
    m365Poll: config.m365.pollSeconds,
    db: config.databaseUrl.replace(/:[^:@/]*@/, ':***@'),
  });

  // Wait for the store rather than exit. Postgres lives in WSL, and at logon
  // (or after WSL drops the distro) it is routinely down for a minute; exiting
  // spent the task's five restarts in ten minutes and left the worker dead for
  // a week. Retrying here costs nothing and has no ceiling.
  const { migrate } = require('./db/migrate');
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      break;
    } catch (err) {
      const wait = Math.min(300, 5 * 2 ** Math.min(attempt, 6));
      log.warn('store not reachable — retrying', { attempt, waitSeconds: wait, message: err.message });
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }

  // One worker at a time. `Stop-ScheduledTask` ends the conhost wrapper, not
  // node, so a "restart" can leave the old worker running beside the new one
  // — two of every pass, two dreams, two dashboards fighting for a port. A
  // session advisory lock held on a dedicated connection makes the second
  // one wait; it is released the moment the first process dies.
  const lockClient = await db.getPool().connect();
  for (let attempt = 1; ; attempt++) {
    const { rows: got } = await lockClient.query('select pg_try_advisory_lock(7300) as ok');
    if (got[0].ok) break;
    if (attempt === 1) log.warn('another worker holds the lock — waiting for it to exit');
    await new Promise((r) => setTimeout(r, 15_000));
  }

  // The dashboard rides along with the worker: one process to keep alive.
  // A port clash must not stop ingest — and must not be permanent either: on
  // a restart the old worker can still hold the port for a few seconds, and a
  // single attempt left the dashboard down until the next restart.
  const startDashboard = (attempt = 1) =>
    require('./dashboard/server')
      .start()
      .catch((err) => {
        log.warn('dashboard not started — retrying', { attempt, message: err.message });
        setTimeout(() => startDashboard(attempt + 1), Math.min(300, 10 * attempt) * 1000);
      });
  startDashboard();

  const ingest = require('./ingest');
  const distill = require('./distill');
  const search = require('./search');
  const dispatch = require('./dispatch');

  every(config.m365.pollSeconds, 'm365', async () => {
    if (!config.m365.enabled) return;
    await ingest.runAll(['graph_chat', 'graph_mail']);
  });

  // Teams in seconds, from the client's local cache. A fresh DM or mention is
  // distilled (and drafted for) straight away rather than at the next 90 s
  // tick — through `exclusive`, so it never overlaps a scheduled pass; if one
  // is running, that pass or the next picks the item up. Not awaited: the
  // cache pass stays a few hundred milliseconds whatever distill costs.
  if (config.teamsCache.enabled) {
    every(config.teamsCache.pollSeconds, 'teams-cache', async () => {
      const r = await require('./ingest/teamsLocal').tick();
      if (!r.fresh) return;
      exclusive('distill', () => distill.run({ limit: 5 }))
        .then((ran) => ran && exclusive('drafts', () => require('./draft').autoDraft({ limit: 3 })))
        .then(() => config.reconcile.enabled && exclusive('reconcile', () => require('./ledger/reconcile').pass()))
        .catch(() => {});
    });
  }

  every(config.m365.calendarPollSeconds, 'calendar', async () => {
    if (!config.m365.enabled) return;
    await ingest.runAll(['graph_event']);
  });

  every(config.github.pollSeconds, 'github', async () => {
    await ingest.runAll(['github']);
  });

  every(config.jira.pollSeconds, 'jira', async () => {
    await ingest.runAll(['jira']);
  });

  // Local files, so this can be frequent and cheap.
  every(120, 'sessions', async () => {
    await ingest.runAll(['claude_session']);
  });

  // The audio cycle: Python trims and transcribes completed capture files,
  // then the sidecars it wrote become episodes here, then a meeting that is
  // over gets its debrief (src/meetings/debrief.js).
  //
  // Checked every minute so a meeting lands within minutes of ending: when
  // one ends, capture is asked to finish its files early, and the next tick
  // finds them. Python only starts when a finished file is waiting, or every
  // five minutes regardless (it also recovers files a dead capture left).
  let lastAudioSweep = 0;
  // A recorder that is up but writing nothing is restarted, and a disk that
  // is filling up is reported before it stops capture (src/audio/watchdog.js).
  every(60, 'capture-watchdog', async () => {
    const watchdog = require('./audio/watchdog');
    await watchdog.checkCapture();
    await watchdog.checkDisk();
  });

  // Records during meetings only: a calendar meeting, or another app on the
  // microphone for the unplanned call (src/audio/gate.js).
  if (config.audio.enabled && config.audio.gate.enabled) {
    every(config.audio.gate.pollSeconds, 'meeting-gate', async () => {
      await require('./audio/gate').tick();
    });
  }

  every(config.audio.enabled ? 60 : 86400, 'audio', async () => {
    if (!config.audio.enabled) return;
    const spool = require('./audio/spool');
    const debrief = require('./meetings/debrief');
    if (config.meetings.debrief) {
      const rolled = await debrief.rollIfUseful().catch((err) => log.warn('roll check failed', { message: err.message }));
      // Capture checks the roll file every second; give it a moment to close.
      if (rolled) await new Promise((r) => setTimeout(r, 4000));
    }
    if (spool.needsProcessing(config.audioDir) || Date.now() - lastAudioSweep >= 290_000) {
      lastAudioSweep = Date.now();
      await runAudioProcess();
      await ingest.runAll(['audio']);
    }
    await debrief.pass();
  });

  every(90, 'distill', async () => {
    await distill.run({ limit: 15 });
  });

  // After distillation, so a fresh ask has its commitment before a reply is
  // drafted for it.
  every(120, 'drafts', async () => {
    await require('./draft').autoDraft({ limit: 3 });
  });

  // An ask from chat or mail I have since answered myself in the thread is
  // closed, with the quote that answered it. Judged once per new reply.
  if (config.replyClose.enabled) {
    every(300, 'reply-close', async () => {
      await require('./commitments/replyClose').pass({ limit: 8 });
    });
  }

  // The reconciler keeps open commitments true: anything related that arrived
  // since an item was last judged — the other person's answer, my PR, my
  // session — is weighed, and a verified close is applied through the ledger
  // (src/ledger). With nothing new it is one query, so every minute is cheap;
  // the Teams fast path above also starts it.
  if (config.reconcile.enabled) {
    every(60, 'reconcile', async () => {
      await require('./ledger/reconcile').pass();
    });
  }

  // Memory: claims → consolidation → pages, and a nightly dream. Each pass is
  // a query over its own marker table, so they need no ordering beyond this.
  if (config.memory.enabled) {
    const memoryPass = (file, opts) => () => require(`./memory/${file}`).run(opts);
    every(300, 'memory-extract', memoryPass('extract', { limit: 16 }));
    every(300, 'memory-consolidate', memoryPass('consolidate', { limit: 60 }));
    every(3600, 'memory-pages', memoryPass('pages', { limit: 20 }));
    every(3600, 'memory-dream', memoryPass('dream', {}));
  }

  // Pre-meeting briefs: learn from meetings that just ended, then brief the
  // ones starting within the lead time. Idempotent per occurrence.
  every(300, 'meetings', async () => {
    await require('./meetings').pass();
  });

  // The project table follows the disk: new clones become candidates, and a
  // deleted folder is retired so nothing more is routed to it.
  every(6 * 3600, 'projects-sync', async () => {
    await require('./projects').sync();
  });

  every(300, 'embed', async () => {
    await search.backfillEmbeddings({ limit: 256 });
  });

  // A run whose termhub session has gone is not running, whatever the table
  // says — reboots and killed sessions both land here.
  every(120, 'runs', async () => {
    await dispatch.reconcile();
  });

  // Routines: due ones run one at a time; a missed slot runs once, never a
  // backlog (src/routines). Suggestions are proposed nightly, never enabled.
  if (config.routines.enabled) {
    every(60, 'routines', async () => {
      await require('./routines').runDue();
    });
    every(3600, 'routine-suggest', async () => {
      await require('./routines/suggest').nightly();
    });
  }

  // Deterministic retrieval eval; a no-op with no cases, at most once a day.
  every(86400, 'eval', async () => {
    await require('./eval').nightly();
  });

  // Checked hourly, dumps when the newest backup is older than a day; a
  // restart therefore does not produce a dump of its own.
  every(3600, 'backup', async () => {
    await require('./backup').dumpIfDue();
  });

  // Notes from my own sessions and PRs nobody touched for a week are closed
  // (src/commitments/selfNotes.js); asks from people never expire.
  every(3600, 'self-notes', async () => {
    await require('./commitments/selfNotes').expire();
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
  // A stray rejection in one pass must not end every other pass with it.
  process.on('unhandledRejection', (err) => {
    log.warn('unhandled rejection', { message: err?.message || String(err) });
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    log.error('worker failed to start', { message: err.message });
    process.exit(1);
  });
}

module.exports = { every, exclusive };
