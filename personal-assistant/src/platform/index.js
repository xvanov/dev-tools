'use strict';

// The platform layer: every decision that depends on the operating system is
// made here, once, and nowhere else. The rest of the tool asks this module —
// it never tests `process.platform` itself. (Exceptions, out of this layer's
// scope: src/dispatch/remote.js and src/dispatch/exec.js, which decide by the
// *target* machine's OS, not this one's.)
//
// One implementation per behaviour per OS, all with the same shape:
//
//   id, label                      'windows' | 'linux' | 'darwin'
//   defaults.dataDir(env)          where the store's files, audio and venvs live
//   defaults.reposRoot(env)        PA_REPOS_ROOT's default
//   defaults.venvPython(dir)       a venv's interpreter
//   defaults.teamsCacheDir(env)    the Teams cache, or null where there is none
//   defaults.pgTools(opts)         how backup reaches pg_dump: 'wsl:<distro>' |
//                                  'native' | 'docker:<container>'
//   teamsCache {supported, why}    whether the Teams cache reader runs by default
//   pathKey(p)                     a path's identity (case-folded where the FS is)
//   openCommand(url) / openUrl(url)            the browser / protocol handler
//   clipboardCommand() / copyToClipboard(text)
//   teamsDesktop()                 is there an msteams: handler (else: web links)
//   toastCommand(spec) / toast(spec)           a desktop notification
//   vault {id,label,where,available,invocation,run}   the OS secret store;
//                                  the value travels on stdin, never argv
//   capture {backend,installed,restartHint,restartCommand,restart,micHolders}
//   freeBytes(dir)                 free space on dir's filesystem
//   services {workerStart,workerStop,install,dbProvision}   text for hints
//   doctor(opts) → [{ok,label,detail}]         platform-only `pa doctor` lines
//
// `…Command` functions are pure and return the exact process a behaviour
// starts, so tests pin construction without side effects.
//
// Must not require config.js: config takes its defaults from here.

// Literal requires, so a bundler (jarvisd's bun build --compile, plan 4.1) sees every implementation.
const IMPL = { win32: () => require('./windows'), linux: () => require('./linux'), darwin: () => require('./darwin') };

/** The implementation for a Node `process.platform` value. Other Unixes get Linux's. */
function select(platform = process.platform) {
  return (IMPL[platform] || IMPL.linux)();
}

const current = select();

module.exports = { ...current, select, current };
