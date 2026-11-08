// jarvisd: the Jarvis core on Bun (native plan 4.1, D1).
//
// Stage 1 of the move (docs/native/JARVISD.md): jarvisd boots the PA worker's
// CommonJS unchanged. Bun runs it as is (the contract, dashboard and event
// tests pass under Bun), so the process, its ports and its supervisor protocol
// are the PA's own. The require below is static, so `bun build --compile`
// bundles the whole worker graph (and its npm packages) into one executable.
// Modules then become strict TypeScript one at a time, leaves first, without
// the entrypoint changing.

interface Worker {
  main(): Promise<void>;
}

/** The PA worker module (CommonJS), bundled into the executable. */
export function loadWorker(): Worker {
  return require('../../personal-assistant/src/worker.js') as Worker;
}

if (import.meta.main) {
  process.env.PA_RUNTIME = `bun ${Bun.version}`;
  // --check: load the worker's whole module graph and stop, starting nothing
  // (what CI and scripts/build.js smoke-test the binary with).
  if (process.argv.includes('--check')) {
    const w = loadWorker();
    if (typeof w.main !== 'function') throw new Error('the PA worker has no main()');
    console.log(`jarvisd ok: bun ${Bun.version}`);
    process.exit(0);
  }
  loadWorker()
    .main()
    .catch((err: unknown) => {
      console.error('jarvisd failed to start:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
