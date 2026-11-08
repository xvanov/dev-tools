// Config for ../scripts/run-tests.js. Every entry needs a reason.
module.exports = {
  "skip": [
    { "file": "exec.test.js", "reason": "hangs on this Windows box: node-pty's conpty_console_list_agent crashes (Node 26 + node-pty 1.1.0), leaving the PTY child alive; passes its assertions first. Environment-bound; T2 should give it a hard teardown" },
    { "file": "csrf.test.js", "reason": "assertions pass but teardown rmSync fails with EPERM (a live PTY still holds the temp dir as cwd on Windows), exit 1; T2 owns the cleanup" }
  ],
  "serial": []
}