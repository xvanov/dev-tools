# remedies — the contract

One script per failure signature. `watchdog.ps1` classifies an outage into a signature
(see `../lib/diagnose.ps1`) and, if `remedies/<signature>.ps1` exists, runs **that**
instead of waking a model. These files are the point of the whole watchdog: each one is
an outage that will never need an LLM again.

**If you are a Claude Code escalation, this file is your spec.** Read it before writing
anything.

## Parameters

Every remedy declares exactly this block. The watchdog always passes all six, so a
remedy that omits one fails to start.

```powershell
param(
  [string]$Signature,     # the signature this run was classified as
  [string]$Mode,          # 'http' | 'single' | 'bluegreen'  (resolved from Serve, not guessed)
  [int]$PublishPort,      # the port users connect to
  [int]$FrontPort,        # state.json activeFrontPort
  [int]$SessiondPort,     # sessiond's loopback port
  [string]$TailnetIp      # may be '' if tailscaled could not be asked
)
```

Nothing else is passed and nothing is read from stdin — the watchdog runs remedies
non-interactively with no console.

## Rules

1. **Exit 0 only if service is actually restored.** Verify it yourself:
   `GET <front url>/api/health` must return `ok:true` with `self.entry == 'front'`.
   The watchdog re-verifies independently and does not trust the exit code, but a
   remedy that reports success on a port merely answering makes the log lie.
2. **Never touch `sessiond` unless the signature says it is already down.** It holds
   every live terminal as an in-memory PTY. Restarting it to fix a front problem
   destroys the user's running work; those sessions come back only as *Restorable*.
   Signatures where starting one is in scope: `both-down`, `sessiond-down-front-up`.
3. **Idempotent.** It will be run again on the next occurrence, and possibly twice in
   a row if the first attempt half-worked. Re-running a healthy machine must be a
   no-op, not a restart.
4. **Finish inside 60 seconds.** The watchdog kills a remedy at 120s and treats that
   as a failure. Health-check polls, not sleeps.
5. **Prefer the existing scripts.** `..\..\windows\start-http.ps1`,
   `restart-front.ps1`, `start.ps1` already handle mode resolution, pid-file
   ownership, port reclamation and verification. Re-implementing a front launch by
   hand is how you get a front bound to the wrong address.
6. **Never kill a process you have not identified.** An unrecognised listener is much
   more likely to be something else on the machine than a termhub tier — this is why
   `Clear-PortSquatter` refuses to, and why `publish-port-squatted` has no remedy and
   escalates instead. That is deliberate. Do not "fix" it with a kill.
7. **No prompts, no `Read-Host`, no `-Confirm`.** There is no human present.
8. **Say why.** A comment at the top stating what failure this repairs and what the
   fix actually is. The next reader is debugging at 2am or is a model with no context.

## Helpers

Dot-source these; do not re-derive their logic.

```powershell
. (Join-Path $PSScriptRoot '..\..\windows\common.ps1')   # state, pid files, ports, Start-TermhubNode
. (Join-Path $PSScriptRoot '..\lib\diagnose.ps1')        # Get-HttpProbe, Get-PortListeners, topology
```

## Signatures

Fixable by script — a remedy here is expected:

| signature | meaning |
|---|---|
| `front-down-sessiond-up` | nothing on the front's address; PTYs intact. Replace the front only. |
| `front-bound-wrong-address` | the front is alive but listening somewhere this mode does not publish. |
| `front-unhealthy` | the front answers but reports not-ok while sessiond is fine. |
| `sessiond-down-front-up` | the front is up, its proxy target is gone. Starting sessiond is in scope. |
| `both-down` | reboot, or a logon task that never ran. Bring both tiers up. |
| `serve-holds-http-port` | tailscaled's TLS listener took the address the front should own in plain-HTTP mode. |
| `publish-port-monolith` | a pre-split `node server.js` is squatting the publish port. |

Deliberately **not** self-healed — these escalate every time, by design:

| signature | why |
|---|---|
| `publish-port-squatted` | an unidentified non-termhub process holds the port. Killing it blind is worse than the outage. |
| `tailnet-ip-unavailable` | tailscaled is down or logged out. Not termhub's to repair. |
| `unknown` | fell through classification. If you see this, the taxonomy needs a new signature more than it needs a script. |
