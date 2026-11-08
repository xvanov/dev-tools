// Config for ../scripts/run-tests.js. Every entry needs a reason.
module.exports = {
  "skip": [
    { "file": "agents.test.js", "reason": "spawns a generated shell script (pa-say); needs a POSIX shell, ENOENT on Windows" },
    { "file": "dispatchStart.test.js", "reason": "needs a termhub with noRc support on the target; fails on this Windows box" },
    { "file": "factoryDispatch.test.js", "reason": "shells out to python3, which is not on PATH on Windows" },
    { "file": "platform.test.js", "reason": "asserts POSIX path separators; fails on Windows" },
    { "file": "remoteExec.test.js", "reason": "spawns sh for the remote BRIEF.md write; needs a POSIX shell, ENOENT on Windows" }
  ],
  "serial": [
    { "file": "talk.test.js", "reason": "T2: fails only under parallel load (shared port or file); passes alone" }
  ]
}
