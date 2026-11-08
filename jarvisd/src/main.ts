// jarvisd: the Jarvis core on Bun (native plan 4.1, D1).
//
// Stage 1 of the move (docs/native/JARVISD.md): jarvisd boots the PA worker's
// CommonJS unchanged. Bun runs it as is (the contract, dashboard and event
// tests pass under Bun), so the process, its ports and its supervisor protocol
// are the PA's own. The requires below are static, so `bun build --compile`
// bundles the whole worker graph (and its npm packages) into one executable.
// Modules then become strict TypeScript one at a time, leaves first, without
// the entrypoint changing.
//
// One executable, three roles (plan 4.4):
//   jarvisd supervise [run|roll|rollback|status]   the supervisor (Z1): owns
//       the dashboard port and runs generations of this same executable
//   jarvisd generation                              a worker generation (what
//       the supervisor starts, with PA_SUPERVISED=1); also the default
//   jarvisd front [--port N] [--sessiond-port N] [--host H]
//       termhub's front (plan 4.1): the web UI, the proxy to sessiond (which owns
//       the terminals, or ptyd does) and /pa/ to the dashboard
//   jarvisd --check                                 load everything, start nothing

interface Worker {
  main(): Promise<void>;
}

interface Supervisor {
  cli(argv: string[]): Promise<void>;
}

interface Front {
  startFront(o: { port?: number; sessiondPort?: number; host?: string; claimPid?: boolean }): unknown;
}

/** The PA worker module (CommonJS), bundled into the executable. */
export function loadWorker(): Worker {
  // A test can run a stand-in worker (the supervisor's fixtures) in a
  // generation of the real executable: PA_GENERATION_MODULE names its file.
  const stand = process.env.PA_GENERATION_MODULE;
  if (stand) {
    require(stand);
    return { main: async () => {} };
  }
  return require('../../personal-assistant/src/worker.ts') as Worker;
}

/** termhub's front (termhub/front.js), bundled too. It holds no terminals, so Bun can run it. */
export function loadFront(): Front {
  return require('../../termhub/front.ts') as Front;
}

/** `--name value` from argv, as a number when it is one. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The supervisor (personal-assistant/src/supervisor/index.ts), bundled too. */
export function loadSupervisor(): Supervisor {
  return require('../../personal-assistant/src/supervisor/index.ts') as Supervisor;
}

if (import.meta.main) {
  process.env.PA_RUNTIME = `bun ${Bun.version}`;
  const args = process.argv.slice(2);
  const fail = (what: string) => (err: unknown) => {
    console.error(`jarvisd ${what} failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  };
  // --check: load the worker's and the supervisor's whole module graph and
  // stop, starting nothing (what CI and scripts/build.js smoke-test with).
  if (args.includes('--check')) {
    const w = loadWorker();
    if (typeof w.main !== 'function') throw new Error('the PA worker has no main()');
    if (typeof loadSupervisor().cli !== 'function') throw new Error('the supervisor has no cli()');
    if (typeof loadFront().startFront !== 'function') throw new Error('the termhub front has no startFront()');
    console.log(`jarvisd ok: bun ${Bun.version}`);
    process.exit(0);
  } else if (args[0] === 'supervise') {
    // Generations are this executable (`generation`), unless PA_RUNTIME says
    // otherwise; the supervisor drops PA_JARVISD_SELF from their environment.
    // 'exe': this is the compiled executable, so a generation is
    // "<this exe> generation"; 'bun': run from source by the bun binary.
    process.env.PA_JARVISD_SELF = /^bun(\.exe)?$/i.test(require('node:path').basename(process.execPath)) ? 'bun' : 'exe';
    process.env.PA_RUNTIME = 'jarvisd';
    loadSupervisor().cli(args.slice(1)).catch(fail('supervise'));
  } else if (args[0] === 'front') {
    // As `node front.js`: the default ports claim the pid file; ports given
    // (a spare front, an update's second front) do not.
    const port = flag(args, 'port');
    const sessiondPort = flag(args, 'sessiond-port');
    const host = flag(args, 'host');
    loadFront().startFront({
      ...(port ? { port: Number(port) } : {}),
      ...(sessiondPort ? { sessiondPort: Number(sessiondPort) } : {}),
      ...(host ? { host } : {}),
      claimPid: !port,
    });
  } else {
    loadWorker().main().catch(fail('generation'));
  }
}
