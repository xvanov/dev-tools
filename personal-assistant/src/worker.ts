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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('./repo/types.ts').Row;
type Json = import('./types.ts').Json;
/** The supervisor's IPC messages to a generation (src/supervisor). */
type SupervisorMessage = { type?: string };
/** src/util/lease.ts createOwnership(): the lease held for the passes. */
type Ownership = { takeOver(): Promise<unknown>; handOver(): Promise<unknown>; lost(err: unknown): void };

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { config } = require('./config.ts');
const { logger } = require('./log.ts');
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
    windowsHide: true,
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

// Every caller — the timers and the Teams fast path alike — goes through
// these, so a pass never overlaps itself however it was started
// (src/util/exclusive.ts). `exclusive` skips a busy pass and resolves to
// whether it ran; `soon` runs right after a busy one instead.
const passes = require('./util/exclusive.ts').passes({
  onError: (name: string, err: unknown) => log.warn('pass failed', { name, message: (err as Error).message }),
});

// Run by the zero-downtime supervisor (src/supervisor), which talks over IPC.
const supervised = process.env.PA_SUPERVISED === '1' && typeof process.send === 'function';

// Single-owner background work (src/util/lease.js, docs/native/PLAN.md Z2):
// every timer, watcher and in-process worker below is declared on `sched` and
// runs only while this process holds the generation lease. Nothing in this
// file may start background work any other way (test/lease.test.js checks).
let ownership: Ownership | null = null;
const lease = require('./util/lease.ts').createLease({
  connect: () => db.getPool().connect(),
  // Supervised, the next generation must take over within 2 s of the old one
  // letting go; unsupervised, a second worker only waits for the first to die.
  pollMs: Number(process.env.PA_LEASE_POLL_MS) || (supervised ? 500 : 15_000),
  log,
  onLost: (err: unknown) => ownership && ownership.lost(err),
});
// First ticks spread over 2–20 s, not 2–5: a generation taking over starts
// two dozen passes at once, and their cold start is CPU it shares with
// serving the dashboard.
// PA_ONLY_PASSES=a,b,memory-*: only those passes and services run (a rehearsal on a
// copy of the store, docs/native/CUTOVER-SQLITE.md); unset, all of them.
const onlyPasses = String(process.env.PA_ONLY_PASSES || '').split(',').map((s) => s.trim()).filter(Boolean);
const sched = require('./util/scheduler.ts').createScheduler({ passes, lease, log, firstTickMs: () => 2000 + Math.random() * 18_000, only: onlyPasses });
const every = (seconds: number, name: string, fn: unknown) => sched.every(seconds, name, fn);
const exclusive = (name: string, fn: unknown) => sched.run(name, fn);

let stopping = false;
async function shutdown(signal: unknown) {
  if (stopping) return;
  stopping = true;
  log.info('stopping', { signal });
  try {
    require('./chat/feed.ts').stopChat();
  } catch {
    /* no chat here */
  }
  if (ownership) await Promise.race([ownership.handOver().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  await lease.close();
  // Bounded: a pool with a client still checked out (the lock wait, a pass
  // mid-query) never finishes ending, and a stop must not hang a deploy.
  await Promise.race([db.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}

async function main() {
  // Below normal for everything the worker starts, not for the worker: it
  // serves the dashboard, and a below-normal process gets no CPU at all
  // while other work fills every core (src/util/childPriority.js).
  require('./util/childPriority.ts').lowerChildren();
  require('./util/childPriority.ts').serveAboveNormal();

  // The supervisor's messages (src/supervisor): `drain` once routing has moved
  // to the next generation — stop the schedulers and release the lease now,
  // not at exit, so the next generation takes the passes over within its
  // poll (Z2); `undrain` when a rollback moves routing back here — take the
  // lease and the passes back; `stop` once our in-flight requests are done.
  // Its death closes the IPC channel, and a worker must not outlive it holding
  // the lease and the passes.
  if (supervised) {
    process.on('message', (m: SupervisorMessage | null) => {
      if (m && m.type === 'drain') {
        log.info('draining: routing moved to the next generation — handing the passes over');
        require('./dashboard/server.ts').markDraining();
        if (ownership) ownership.handOver().catch((err: Error) => log.warn('hand-over failed', { message: err.message }));
        // The SDK chat (PA_CHAT_ENGINE=sdk) lives here: close it so the next generation resumes it.
        require('./chat/feed.ts').drainChat().catch((err: Error) => log.warn('chat drain failed', { message: err.message }));
      } else if (m && m.type === 'undrain') {
        log.info('undrained: routing moved back here (rollback) — taking the passes back');
        require('./dashboard/server.ts').markDraining(false);
        require('./chat/feed.ts').undrainChat();
        if (ownership) ownership.takeOver().catch((err: Error) => log.warn('take-over failed', { message: err.message }));
      } else if (m && m.type === 'stop') shutdown('supervisor stop');
    });
    process.on('disconnect', () => shutdown('supervisor gone'));
  }

  log.info('starting', {
    generation: supervised ? Number(process.env.PA_SUPERVISOR_GENERATION) || null : undefined,
    m365Poll: config.m365.pollSeconds,
    db: config.db === 'sqlite' ? `sqlite:${config.sqlitePath}` : config.databaseUrl.replace(/:[^:@/]*@/, ':***@'),
    ...(onlyPasses.length ? { onlyPasses } : {}),
  });

  // A blocked loop answers nothing, /healthz included: say so, with what ran.
  require('./util/lagWatch.ts').watchLag({ log, running: () => sched.running() });

  // A pass whose model cannot do its job (a connector relay set to a
  // non-Claude-Code backend, an unknown provider) is said once, loudly, at
  // start — each call refuses too, but this names the variable to fix.
  for (const r of require('./models.ts').report()) {
    if (!r.ok) log[r.capable ? 'warn' : 'error']('model misconfigured', { purpose: r.purpose, env: r.env, model: r.model, problem: r.problem });
  }

  // Wait for the store rather than exit. Postgres lives in WSL, and at logon
  // (or after WSL drops the distro) it is routinely down for a minute; exiting
  // spent the task's five restarts in ten minutes and left the worker dead for
  // a week. Retrying here costs nothing and has no ceiling.
  const { migrate } = require('./db/migrate.ts');
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      break;
    } catch (err) {
      const wait = Math.min(300, 5 * 2 ** Math.min(attempt, 6));
      log.warn('store not reachable — retrying', { attempt, waitSeconds: wait, message: (err as Error).message });
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  if (config.db === 'sqlite') log.info('store ready', await db.probe());

  // Under the supervisor (src/supervisor, PA_SUPERVISED=1) the dashboard
  // comes up before the lease, on a port the OS picks, and /healthz says
  // ready: the supervisor routes to it while the previous generation still
  // holds the lease and runs the passes. The passes are declared below and
  // start only once the previous generation has released the lease on
  // `drain` (src/util/lease.js) — so a roll never runs two of a pass.
  const dashboard = require('./dashboard/server.ts');
  if (supervised) {
    const server = await dashboard.start({ port: 0 });
    process.send?.({ type: 'listening', port: server.address().port });
    // Ready only at the end of main(): the module loading and pass setup in
    // between blocked the loop for seconds, right after the flip.
  }

  // The dashboard rides along with the worker: one process to keep alive.
  // A port clash must not stop ingest — and must not be permanent either: on
  // a restart the old worker can still hold the port for a few seconds, and a
  // single attempt left the dashboard down until the next restart.
  const startDashboard = (attempt: number = 1) =>
    dashboard
      .start()
      .then(() => dashboard.markReady())
      .catch((err: Error) => {
        log.warn('dashboard not started — retrying', { attempt, message: err.message });
        setTimeout(() => startDashboard(attempt + 1), Math.min(300, 10 * attempt) * 1000);
      });
  const ingest = require('./ingest');
  const distill = require('./distill');
  const search = require('./search');
  const dispatch = require('./dispatch');

  let m365At = 0;
  every(config.m365.pollSeconds, 'm365', async () => {
    if (!config.m365.enabled) return;
    const now = new Date();
    const offHours = now.getDay() === 0 || now.getDay() === 6 || now.getHours() < 8 || now.getHours() >= 19;
    if (offHours && Date.now() - m365At < config.m365.offHoursPollSeconds * 1000) return;
    m365At = Date.now();
    await ingest.runAll(['graph_chat', 'graph_mail']);
  });

  // Teams in seconds, from the client's local cache: a pass on each write
  // burst Teams makes, not on a timer (src/ingest/teamsLocal.js `watch`). A
  // fresh DM or mention is distilled (and drafted for) straight away rather
  // than at the next 90 s tick — through `soon`, so it never overlaps a
  // scheduled pass yet does not wait for the next tick when one is running
  // (that pass chose its items before this one existed). Not awaited: the
  // cache pass stays tens of milliseconds whatever distill costs.
  if (config.teamsCache.enabled) {
    sched.service('teams-cache', () =>
      require('./ingest/teamsLocal.ts').watch({
        onResult: (r: Row) => {
          if (!r.fresh) return;
          sched
            .soon('distill', () => distill.run({ limit: 5 }))
            .then((ran: unknown) => ran && sched.soon('drafts', () => require('./draft').autoDraft({ limit: 3 })))
            .then(() => config.reconcile.enabled && exclusive('reconcile', () => require('./ledger/reconcile.ts').pass()))
            .catch(() => {});
        },
      })
    );
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

  // The other machines' sessions, through their termhubs
  // (src/ingest/remoteSessions.js). Its own pass so an unreachable machine's
  // timeouts never hold up the local one.
  if (Object.keys(config.termhub.machines).length) {
    every(300, 'remote-sessions', async () => {
      await ingest.runAll(['claude_session_remote']);
    });
  }

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
  // is filling up is reported before it stops capture (src/audio/watchdog.ts).
  every(60, 'capture-watchdog', async () => {
    const watchdog = require('./audio/watchdog.ts');
    await watchdog.checkCapture();
    await watchdog.checkDisk();
  });

  // Records during meetings only: a calendar meeting, or another app on the
  // microphone for the unplanned call (src/audio/gate.ts).
  if (config.audio.enabled && config.audio.gate.enabled) {
    every(config.audio.gate.pollSeconds, 'meeting-gate', async () => {
      await require('./audio/gate.ts').tick();
    });
  }

  every(config.audio.enabled ? 60 : 86400, 'audio', async () => {
    if (!config.audio.enabled) return;
    const spool = require('./audio/spool.ts');
    const debrief = require('./meetings/debrief.ts');
    if (config.meetings.debrief) {
      const rolled = await debrief.rollIfUseful().catch((err: Error) => log.warn('roll check failed', { message: err.message }));
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

  // New commitments against every open one of the last 60 days, whatever
  // thread or person they came from: embedded, paired by meaning and shared
  // refs, confirmed by a cheap model in batches, folded (commitments/dedupe.js).
  // Within the daily budget; a commitment is judged once.
  if (config.dedupe.enabled) {
    every(180, 'dedupe', async () => {
      await require('./commitments/dedupe.ts').pass({ limit: 24 });
    });
  }

  // What people owe you, judged against your tasks: "blocked on them" or not
  // on the board (commitments/blocks.js). Once per commitment, again when a
  // task is added.
  if (config.blocks.enabled) {
    every(300, 'blocks', async () => {
      await require('./commitments/blocks.ts').pass();
    });
  }

  // After distillation, so a fresh ask has its commitment before a reply is
  // drafted for it.
  every(120, 'drafts', async () => {
    await require('./draft').autoDraft({ limit: 3 });
  });

  // An ask from chat or mail I have since answered myself in the thread is
  // closed, with the quote that answered it. Judged once per new reply.
  if (config.replyClose.enabled) {
    every(300, 'reply-close', async () => {
      await require('./commitments/replyClose.ts').pass({ limit: 8 });
    });
  }

  // The reconciler keeps open commitments true: anything related that arrived
  // since an item was last judged — the other person's answer, my PR, my
  // session — is weighed, and a verified close is applied through the ledger
  // (src/ledger). With nothing new it is one query, so every minute is cheap;
  // the Teams fast path above also starts it.
  if (config.reconcile.enabled) {
    every(60, 'reconcile', async () => {
      await require('./ledger/reconcile.ts').pass();
    });
  }

  // Durable tasks (src/durable): chases of what I am owed, finished runs
  // waiting to be landed. The Absurd worker runs inside this process; the
  // pass below spawns the tasks the store says should exist.
  if (config.durable.enabled) {
    sched.service('durable-worker', async () => {
      const w = await require('./durable').startWorker();
      log.info('durable worker started');
      return () => w.close();
    });
    every(600, 'durable', async () => {
      await require('./durable/spawners.ts').pass();
    });
  }

  // The planner: each new ask on me gets a kind and, where it can, work done
  // ahead of me — within the daily budget (src/agent/planner.ts).
  if (config.planner.enabled) {
    every(300, 'planner', async () => {
      await require('./agent/planner.ts').pass();
    });
  }

  // The cause-and-effect paragraph on dashboard cards: a few a tick, only for
  // cards on the board, within the daily budget (src/commitments/context.js).
  if (config.cardContext.enabled) {
    every(120, 'card-context', async () => {
      await require('./commitments/context.ts').pass();
    });
  }

  // A source that keeps failing blinds the reconciler: one toast per outage,
  // and a banner on the dashboard (src/ingest/health.js).
  every(600, 'health', async () => {
    await require('./ingest/health.ts').pass();
  });

  // Memory: claims → consolidation → pages, and a nightly dream. Each pass is
  // a query over its own marker table, so they need no ordering beyond this.
  if (config.memory.enabled) {
    // Literal requires, so a bundler (jarvisd, plan 4.1) sees each pass module.
const MEMORY_PASSES: Record<string, () => Json> = { extract: () => require('./memory/extract.ts'), consolidate: () => require('./memory/consolidate.ts'), pages: () => require('./memory/pages.ts'), dream: () => require('./memory/dream.ts') };
const memoryPass = (file: string, opts?: unknown) => () => (MEMORY_PASSES[file] as () => Json)().run(opts);
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

  // The repo registry (src/repos) follows the evidence: clones on disk (new
  // ones become candidates, a deleted folder is retired), your GitHub PRs and
  // commits, Claude sessions on every machine, raven's repo map. Cheap: PRs
  // are read incrementally, and the model is called only for a repo that is
  // new or whose README changed. PA_REPOS=0 falls back to the disk-only seed.
  if (config.repos.enabled) {
    every(config.repos.syncSeconds, 'repos-sync', async () => {
      await require('./repos').sync();
    });
  } else {
    every(6 * 3600, 'projects-sync', async () => {
      await require('./projects').sync();
    });
  }

  every(300, 'embed', async () => {
    await search.backfillEmbeddings({ limit: 256 });
  });

  // A run whose termhub session has gone is not running, whatever the table
  // says — reboots and killed sessions both land here.
  every(120, 'runs', async () => {
    await dispatch.reconcile();
  });

  // Build runs (src/build, D30): a run whose session has gone ended without
  // `pa run done`; the transcripts of the live ones read for cost, tool calls
  // and subagents, and a run over its cost or time cap stopped.
  every(10, 'build-heartbeat', async () => {
    await require('./build/heartbeat.ts').tick();
  });
  every(15, 'build-runs', async () => {
    await require('./build/index.ts').reconcile();
    await require('./build/track.ts').tick();
  });

  // Factory jobs (src/dispatch/factory.ts): their status onto the run rows,
  // and a finished or failed one moves its commitment through the ledger.
  // A no-op, without a command, while no factory run is live.
  // Then the whole job list for the /factory page (factory_board), and a
  // notice for a job that finished, needs you, failed or has red CI.
  // Paced, not fixed (src/dispatch/factoryPace.ts): every 5 s while a job
  // moves, at once when a factory on this machine writes its state, else every
  // PA_FACTORY_POLL_SECONDS. Its writes reach the pages through the live feed.
  // A service on the scheduler: its timer, watcher and subscription run only
  // while this generation holds the lease, and stop on drain.
  if (require('./dispatch/factory.ts').enabled()) sched.service('factory-pacer', () => {
    const factory = require('./dispatch/factory.ts');
    const pace = require('./dispatch/factoryPace.ts');
    const pacer = pace.createPacer({
      run: () =>
        exclusive('factory', async () => {
          let failed = null;
          await factory.poll().catch((err: Error) => { failed = err; });
          await factory.refreshBoard();
          if (failed) throw failed;
        }),
      nextMs: async () => pace.nextDelayMs({
        jobs: (await factory.snapshot()).jobs,
        slowSeconds: config.factory.pollSeconds,
        fastSeconds: config.factory.activePollSeconds,
      }),
      onError: (err: unknown) => log.warn('factory pacing failed', { message: (err as Error).message }),
    });
    pacer.start(2000 + Math.random() * 3000);
    const stateDir = pace.localStateDir(config.factory);
    const unwatch = stateDir ? pace.watchState(stateDir, { onChange: () => pacer.kick(), ignore: () => pacer.busy() }) : null;
    if (unwatch) log.info('watching the local factory state', { dir: stateDir });
    // A run that just got its factory job (dispatch.start, Jarvis's
    // factory_start, `pa do`, in any process) moves now: switch to the fast
    // cadence without waiting out a slow one. hurry() only ever pulls the next
    // pass in to the fast interval, so the pass's own run updates cannot loop.
    const events = require('./events');
    events.ensureListening();
    // The same for a job status a factory pushed (POST /api/factory/events):
    // the full list follows within the fast interval.
    const unsubscribe = events.bus().subscribe((e: Json) => {
      const p = e.payload || {};
      if (e.topic === 'factory' ? p.op === 'push' : p.factory_job_id && ['starting', 'running'].includes(p.status)) {
        pacer.hurry(config.factory.activePollSeconds * 1000);
      }
    }, { topics: ['run', 'factory'] });
    return () => {
      pacer.stop();
      if (unwatch) unwatch();
      unsubscribe();
    };
  });

  // Routines: due ones run one at a time; a missed slot runs once, never a
  // backlog (src/routines). Suggestions are proposed nightly, never enabled.
  if (config.routines.enabled) {
    every(60, 'routines', async () => {
      await require('./routines').runDue();
    });
    every(3600, 'routine-suggest', async () => {
      await require('./routines/suggest.ts').nightly();
    });
  }

  // The digest (src/notify/digest.js): at PA_DIGEST_TIMES, what the assistant
  // closed, what waits for a yes, who is late, and what the interrupt budget
  // held back. One query when no slot is due; a missed slot runs once.
  every(60, 'digest', async () => {
    await require('./notify/digest.ts').runDue();
  });

  // Deterministic retrieval eval; a no-op with no cases, at most once a day.
  every(86400, 'eval', async () => {
    await require('./eval').nightly();
  });

  // Checked hourly, dumps when the newest backup is older than a day; a
  // restart therefore does not produce a dump of its own.
  every(3600, 'backup', async () => {
    await require('./backup.ts').dumpIfDue();
  });

  // Notes from my own sessions and PRs nobody touched for a week are closed
  // (src/commitments/selfNotes.js); asks from people never expire.
  every(3600, 'self-notes', async () => {
    await require('./commitments/selfNotes.ts').expire();
  });

  every(3600, 'retention', async () => {
    const deleted = await require('./repo').sources.deleteOldMessages(config.retention.rawItemDays);
    if (deleted) log.info('retention', { deleted });
    // Trace spans (plan 7.5) keep PA_TELEMETRY_RETENTION_DAYS; Meter's percentiles need no more.
    const spans = await require('./repo').telemetry.pruneSpans(new Date(Date.now() - config.telemetry.retentionDays * 86400_000));
    if (spans) log.info('retention', { spans });
  });

  // A stray rejection in one pass must not end every other pass with it.
  process.on('unhandledRejection', (err: unknown) => {
    log.warn('unhandled rejection', { message: (err as Error | null)?.message || String(err) });
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Everything is declared; now run it, under the lease. One worker at a
  // time: `Stop-ScheduledTask` ends the conhost wrapper, not node, so an old
  // restart could leave the previous worker running beside the new one — two
  // of every pass, two dashboards fighting for a port. The lease (a session
  // advisory lock on a dedicated connection) makes the second one wait; it is
  // released on `drain`, or the moment the holder dies.
  ownership = require('./util/lease.ts').createOwnership({ lease, scheduler: sched, log });
  const owned = (ownership as Ownership).takeOver();
  if (supervised) {
    // The live feed listens before this generation is routed to, so the
    // streams the supervisor moves here at the flip find every event since
    // the one they last saw (src/events/bus.js, cross-generation replay).
    try {
      await Promise.race([require('./events').ensureListening().listening, new Promise((r) => setTimeout(r, 10_000))]);
    } catch {
      /* no feed: streams resync instead */
    }
    dashboard.markReady();
  }
  if (!supervised) {
    await owned;
    startDashboard();
  }
}

/** Runs the worker as this process's main module (worker.js, `node src/worker.js`). */
function run() {
  main().catch((err: Error) => {
    log.error('worker failed to start', { message: err.message });
    process.exit(1);
  });
}

// main: jarvisd (plan 4.1) boots the worker through it, under Bun.
module.exports = { sched, main, run };
