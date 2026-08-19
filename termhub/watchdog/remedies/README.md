# remedies — the contract

One script per failure signature. The watchdog classifies an outage into a signature and, if
a remedy for it exists, runs **that** instead of waking a model. These files are the point of
the whole watchdog: each one is an outage that will never need an LLM again.

**If you are a Claude Code escalation, this file is your spec.** Read it before writing
anything. Write the file for **the platform you are running on**:

| | classifier | remedy file | contract |
|---|---|---|---|
| Windows | `../lib/diagnose.ps1` | `<signature>.ps1` | *PowerShell* section below |
| Linux | `../watchdog.sh` (`diagnose`) | `<signature>.sh` | *Bash* section below |

The signature namespaces are separate because the deployments are: Windows runs two tiers
(`sessiond` + `front`), Linux runs one process under systemd. A `front-down-sessiond-up` has no
meaning on Linux and a `service-failed` has none on Windows.

## Parameters — Bash (Linux)

Parsed as flags, and a remedy must tolerate any of them appearing in any order (the watchdog
always passes all five):

```bash
--signature <slug>     # what this run was classified as
--unit <name>          # the systemd --user unit (default: termhub)
--port <n>             # the port termhub should be serving
--bind <addr>          # TERMHUB_BIND from the unit's environment; MAY BE EMPTY
--tailnet-ip <addr>    # `tailscale ip -4`, may be empty
```

**`--bind` empty does not mean loopback.** With no `TERMHUB_BIND`, `server.js` binds the
**tailnet IP** and only falls back to loopback if there isn't one. A remedy that verifies against
`127.0.0.1` alone therefore reports failure for a start that worked, on a completely normal
machine — which sends a *fixed* machine to the model. Check every candidate: `--bind` (if set),
`127.0.0.1`, and the tailnet IP. `service-inactive.sh` shows the loop.

## Parameters — PowerShell (Windows)

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

`$TailnetIp` is empty whenever `tailscale ip -4` could not be asked or had nothing to say, which
is the *normal* state for `tailnet-ip-unavailable`. The watchdog passes a literal `""` token for it
rather than an empty array element, because `Start-Process -ArgumentList` in PowerShell 5.1 rejects
the whole list when any element is empty — which meant no remedy at all could be launched for that
signature until 2026-08-19. Declare it `[string]` with no `Mandatory`, and treat empty as "unknown",
never as "there is no tailnet".

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

## Signatures — Linux

Restarting termhub on Linux **destroys every live terminal**, because the PTYs live in the same
process. So the split below is not about difficulty, it is about cost:

| signature | meaning | remedy? |
|---|---|---|
| `service-inactive` | unit exists, not running — stopped, or systemd gave up after the start limit | ✅ `reset-failed` + `start`. Nothing was being served, so nothing is lost |
| `service-failed` | unit in `failed` state | ✅ same repair; escalates with the journal if the cause persists |
| `service-missing` | no unit file at all | ✋ escalates — reinstalling is a judgement call, not a reflex |
| `not-listening` | unit active, nothing bound (usually `TERMHUB_BIND` names an address the machine no longer has) | ✋ escalates: **live PTYs exist**, and a restart would kill them |
| `http-unhealthy` | unit active, `/api/health` not ok | ✋ escalates for the same reason — killing running work to fix a health blip is not a repair |
| `port-squatted` | the port is held by something that is not termhub's main process | ✋ escalates; killing an unidentified process is worse than the outage |

## Signatures — Windows

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
| `tailnet-ip-unavailable` | plain-HTTP mode has no address to bind the front to. **Partly** fixable — see below. |

`tailnet-ip-unavailable` is the one signature whose remedy cannot always win, and it is worth
knowing why before reading it. The classifier mints it from the *first* branch of
`Get-TermhubDiagnosis`, before the front or sessiond are probed at all, so it means "we could not
find out where the front should be", not "termhub is dead". Three of its four causes are repairable
with no human — `tailscale.exe` missing from the watchdog task's PATH (the interactive PATH is not
the task's), a transient LocalAPI answer, and an administratively-down-but-still-authenticated node
— and the remedy handles those, then re-binds the front with `start-http.ps1`. The fourth, a node
that is **logged out**, cannot be: re-authenticating needs someone to open a login URL. There the
remedy keeps a front on loopback so the machine still works from itself, prints the auth URL, and
exits 1. The escalation budget is what stops the un-clearable case from waking a model every two
minutes.

Deliberately **not** self-healed — these escalate every time, by design:

| signature | why |
|---|---|
| `publish-port-squatted` | an unidentified non-termhub process holds the port. Killing it blind is worse than the outage. |
| `unknown` | fell through classification. If you see this, the taxonomy needs a new signature more than it needs a script. |
