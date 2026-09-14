# REPAIRS: both-down
#
# Nothing is listening on the address this machine publishes AND nothing answers on
# sessiond's loopback port. Both tiers are gone, so there are no live PTYs left to
# protect: whatever the user had open ended when sessiond did, and those sessions come
# back from sessions.json as *Restorable*. That is what puts starting a sessiond in
# scope here - remedies/README.md rule 2 names this signature and
# `sessiond-down-front-up` as the only two where it is - because there is no running
# work left for a start to destroy.
#
# THE FIX: run the machine's own boot script, the same one the `Termhub` task runs.
# It is idempotent by construction, which is the property a remedy needs:
#   - `Confirm-Sessiond` REUSES a live sessiond and starts one only when nobody
#     answers /api/ping. So while this remedy may start a sessiond, it can never
#     *restart* one - including in the race where the logon/boot task wins between
#     the watchdog's last confirmation and this script.
#   - the front is likewise reused when it is already bound where this mode
#     publishes, and replaced otherwise.
#
# Mode dispatch is not cosmetic. state.json records plain-HTTP and single-port
# identically (`activeFrontPort == publishPort`), and the two boot scripts are not
# interchangeable:
#   http       start-http.ps1 - binds the front to <tailnet ip>:<port> itself and
#              turns Serve OFF for that port. Running start.ps1 here would bind the
#              front to loopback and force-enable Serve on the publish port: it would
#              silently migrate the machine to single-port mode and leave a TLS
#              listener on the address a plain http:// client is asking for.
#   single     start.ps1 - front on 127.0.0.1:<port>, Serve proxies the same number.
#   bluegreen  start.ps1 - front on 7001/7002, Serve points at one of them. Passing
#              only -PublishPort keeps whatever state.json already says, so this
#              never switches modes in either direction.
# The watchdog resolves $Mode from Serve before calling us, so it is taken as given
# here rather than re-derived - a second resolution that fell back differently is
# exactly how a machine ends up moved between modes by its own repair.
#
# NOT `Start-ScheduledTask Termhub`, even though on a plain-HTTP machine that task
# runs this very script: a task start is fire-and-forget, with no exit code and no
# captured output, so a failed boot would look identical to a successful one. Calling
# the script directly puts its console output in last-remedy.out.log, which is the
# only record of why a repair did not work.
#
# ---------------------------------------------------------------------------
# 2026-09-14, mv-automated-vm - the escalation that produced this file, and what it
# could NOT establish. Read this before assuming a recurrence has the same cause.
#
# Both tiers had come up cleanly (each logged its `listening` line - sessiond 09:16:06,
# front 09:16:07) and both were gone by the next watchdog probe ~50s later, with
# *empty* .err.log files and no further stdout. Ruled out by that evidence:
#   - not a crash in termhub's own code: an uncaught exception writes a stack trace to
#     <data dir>\logs\<tier>.err.log, and both generations were 0 bytes;
#   - not EADDRINUSE or a port squatter: both tiers won their binds and said so, and
#     nothing else was listening on 7000/7010 afterwards;
#   - not a reboot, which is the first cause this signature's own text suggests:
#     uptime was continuous since 2026-07-13, and unrelated node processes started
#     2026-08-19 were still running across the whole outage;
#   - not a tailnet problem: `tailscale ip -4` answered throughout, so the mode
#     resolved from Serve and the front had an address to bind;
#   - not the `Termhub` task running the pre-split `node server.js`: it runs
#     start-http.ps1, correctly for a plain-HTTP machine.
# What it positively was is UNKNOWN and nothing on the machine records it - no
# process-creation auditing, and no System, Application or TaskScheduler events in the
# window. Two processes exiting together within a second or two, silently, is the
# shape of an external kill rather than of two independent failures, and the outage
# sat inside a window of obvious maintenance: the tiers had been started at 09:16:05
# in the sessiond-then-front order a boot script produces, the `Termhub` task was run
# by hand at 09:18:04, and at 09:21:11 an update pulled 16d7e09 and swapped the front
# under a machine that was back in use. So: bring the tiers back, quickly and
# deterministically, and let the escalation budget (>=10 min apart, <=3/h) be what
# surfaces a *repeatedly* recurring both-down to a human rather than re-repairing it
# forever.
#
# Two leads for whoever reads this next, so they start ahead of where this did:
#   - `Test-TermhubMaintenance` (watchdog\lib\diagnose.ps1) recognises update.ps1,
#     restart-front.ps1, restart-sessiond.ps1 and the two start scripts - but NOT
#     windows\install.ps1, which stops every node running server.js/sessiond.js/
#     front.js before rebuilding. An install is therefore a deploy the watchdog does
#     not stand down for, and it looks exactly like this: both tiers killed together,
#     silently, with nothing in either .err.log.
#   - tiers started from inside a scheduled task's process tree die with that task if
#     it is ever *stopped* (`Stop-ScheduledTask`, or hitting ExecutionTimeLimit),
#     because Task Scheduler terminates the whole tree - which includes node processes
#     started by a remedy, since Start-TermhubNode does not break them out of the job.
#
# A RED HERRING worth naming, because the escalation bundle tails this file and the
# next reader will see it: a *healthy* sessiond's stderr routinely contains
#   node_modules\node-pty\lib\conpty_console_list_agent.js:13
#   Error: AttachConsole failed
# That is node-pty's console-list helper, which windowsPtyAgent.js `fork`s as its own
# short-lived process (there can only be one console attached per process) and whose
# stderr is inherited into sessiond's log. It dies, sessiond does not - the sessiond
# carrying that trace was serving three live sessions at the time. A stack trace in
# sessiond.err.log is not by itself evidence that sessiond fell over.
# ---------------------------------------------------------------------------

param(
  [string]$Signature,
  [string]$Mode,
  [int]$PublishPort,
  [int]$FrontPort,
  [int]$SessiondPort,
  [string]$TailnetIp
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\windows\common.ps1')
. (Join-Path $PSScriptRoot '..\lib\diagnose.ps1')

$windows   = Join-Path $ProjectDir 'windows'
$BudgetSec = 55          # the watchdog kills a remedy at 120s; finish inside 60.
$clock     = [Diagnostics.Stopwatch]::StartNew()
function Get-Remaining { return [int]($BudgetSec - $clock.Elapsed.TotalSeconds) }

# Poll the whole diagnosis rather than one port, because "restored" means the front is
# healthy AND reaching sessiond. A front answering on its own is how a both-down turns
# into a sessiond-down-front-up that nobody noticed.
function Wait-Restored {
  param([int]$TimeoutSec)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $d = Get-TermhubDiagnosis
  while (-not $d.Healthy -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $d = Get-TermhubDiagnosis
  }
  return $d
}

# Idempotence, first thing: re-running against a healthy machine must change nothing.
# That is a real case and not a formality - the watchdog runs this again on the next
# occurrence, and the boot task can win the race while an outage is being confirmed.
$pre = Get-TermhubDiagnosis
if ($pre.Healthy) {
  Write-Host "remedy: termhub is already healthy at $($pre.Topology.FrontUrl) - nothing to do."
  exit 0
}

if ($Mode -eq 'http' -and -not $TailnetIp) {
  # The classifier mints tailnet-ip-unavailable before probing anything, so this
  # should be unreachable. Say it plainly anyway rather than letting start-http.ps1
  # throw a less specific "could not determine Tailscale IPv4 address" at the log.
  Write-Host "remedy: plain-HTTP mode with no tailnet IP - there is no address to bind a front to. That is remedies\tailnet-ip-unavailable.ps1's job, not this one."
  exit 1
}

$attempts = 0
while ($true) {
  $attempts++
  try {
    if ($Mode -eq 'http') {
      Write-Host "remedy: attempt ${attempts}: plain-HTTP mode - start-http.ps1 -Port $PublishPort (starts sessiond too; no live PTYs to lose)"
      & (Join-Path $windows 'start-http.ps1') -Port $PublishPort
    } else {
      Write-Host "remedy: attempt ${attempts}: $Mode mode - start.ps1 -PublishPort $PublishPort (starts sessiond too; no live PTYs to lose)"
      & (Join-Path $windows 'start.ps1') -PublishPort $PublishPort
    }
  } catch {
    # Not fatal on its own. The boot scripts throw when a tier misses its own 12s
    # health window, and a tier that is merely slow - cold page cache right after a
    # boot, node-pty loading - is often listening by the time we verify below.
    Write-Host "remedy: the boot script reported: $($_.Exception.Message)"
  }

  $verify = [Math]::Max(0, [Math]::Min(15, (Get-Remaining) - 2))
  $d = Wait-Restored -TimeoutSec $verify
  if ($d.Healthy) {
    Write-Host "remedy: verified healthy at $($d.Topology.FrontUrl) after $attempts attempt(s) - sessiond pid $($d.SessiondProbe.Json.pid), $($d.SessiondProbe.Json.sessions) live session(s); anything open before the outage is Restorable."
    exit 0
  }

  # Retry only if a whole second attempt can still finish inside the budget. A remedy
  # killed at the watchdog's timeout reports nothing at all, which is strictly worse
  # than a clean failure the escalation can read.
  if ($attempts -ge 2 -or (Get-Remaining) -lt 25) { break }
  Write-Host "remedy: still $($d.Signature) after attempt $attempts - retrying once ($(Get-Remaining)s of budget left)."
}

# Be specific about what came up and what did not. If sessiond is now alive and only
# the front is missing, the next cycle classifies this as front-down-sessiond-up,
# whose remedy already exists - so this "failure" is probably one cycle from fixed.
$d = Get-TermhubDiagnosis
Write-Host "remedy: termhub is still not healthy after $attempts attempt(s): $($d.Signature) - $($d.Detail)"
exit 1
