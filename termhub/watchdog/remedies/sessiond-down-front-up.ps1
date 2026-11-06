# REPAIRS: sessiond-down-front-up
#
# The front answers on the address this machine publishes (its /api/health is a 503
# because it cannot reach its proxy target), but sessiond does not answer /api/ping on
# its loopback port. The UI is up and every terminal in it is dead.
#
# That signature covers TWO different states, and the existing boot path only repairs
# one of them:
#
#   (a) sessiond is GONE - nothing listens on 127.0.0.1:<sessiond port>. Confirm-Sessiond
#       starts one. Same as both-down's sessiond half.
#
#   (b) sessiond is HUNG - its node process is alive and still holds the listening socket,
#       but its event loop never runs, so every request times out. This is the one that
#       produced this file. Confirm-Sessiond alone CANNOT fix it: /api/ping times out, so
#       it concludes "nobody answers", launches a new sessiond, which loses the bind to
#       the hung one (EADDRINUSE, exit 3), and the start throws. The hung process has to
#       be stopped first - and only after it has been positively identified as this
#       machine's sessiond, never on the strength of "something node-shaped holds the
#       port" (remedies/README.md rule 6).
#
# THE FIX:
#   1. If sessiond answers after all, touch nothing (idempotence; also a slow-but-alive
#      supervisor is not ours to kill).
#   2. If the port is held, identify the holder: a node.exe, listening on
#      127.0.0.1:<sessiond port>, that sessiond.pid names (or whose command line runs
#      sessiond.js), NOT also holding the publish port (that is the server.js monolith -
#      a different signature's problem), and NOT an ancestor of this script. Re-probe it
#      with a longer timeout; only a holder that still does not answer is stopped.
#      Anything that fails identification -> exit 1 and escalate, untouched. So does a
#      node_modules\node-pty that will not load: a replacement could not start.
#   3. Confirm-Sessiond starts a fresh sessiond and proves the pid answering is the one
#      it spawned.
#   4. The front is left running - it holds no PTYs, and it reaches the new sessiond on
#      its next request. Only if it still does not report healthy is it redeployed with
#      the mode-correct script (start-http.ps1 for plain-HTTP, restart-front.ps1
#      otherwise, exactly as front-down-sessiond-up.ps1 does).
#
# COST: stopping a hung sessiond ends its PTYs. That is in scope for this signature
# (README rule 2): a supervisor that cannot service a request cannot serve those
# PTYs either, so nothing usable is lost. They come back from
# sessions.json as *Restorable*.
#
# ---------------------------------------------------------------------------
# 2026-11-06, LAP-US101 - the escalation that produced this file.
#
# Evidence: sessiond pid 25468 (started 2026-11-05 21:44:07, commit 3d861f8) still held
# 127.0.0.1:7010 and sessiond.pid named it, but /api/ping timed out every time, for
# minutes. The process used ZERO CPU across a 3s sample - blocked, not spinning - and
# 7010 had a pile of CLOSE_WAIT connections it never got round to closing, which is
# what a stalled event loop looks like from the outside. Its only children were
# conhost.exe: its own (21:44:07) and one created at 10:00:37 with NO shell under it.
# The watchdog's first failed probe was 10:02:29. So: a PTY spawn began ~10:00:37 and
# the main thread never came back from it.
# ROOT CAUSE: termhub\node_modules had been gutted at 2026-11-06 02:00:18 - ws,
# node-addon-api and all of node-pty except build\Release\conpty.node (held open by the
# running sessiond). What survived was exactly what was locked or younger than 7 days
# (@xterm, reinstalled 11-05), the signature of an age sweep. 02:00:18 is inside
# the nightly DiskJanitor run (02:00:01-02:00:20), whose age-based cleanup walks the
# temp roots with os.walk, which follows Windows junctions; a junction from a temp
# dir into node-pty would delete every file older than 7 days through it and then
# rmdir the junction itself, leaving no trace. disk-janitor no longer follows
# junctions (69f9cf4). Why that
# hangs instead of crashing: each node-pty spawn starts a worker thread from
# lib\worker\conoutSocketWorker.js to drain ConPTY's output pipe, while the native
# connect() call runs synchronously on the main thread. With that file gone the
# worker never starts, so nothing reads the pipe, connect() blocks, and the event
# loop stops. That is the deadlock the worker exists to prevent. It matches the
# evidence: zero CPU and a conhost with no shell. Hence the guard below. Before
# stopping a hung sessiond, prove a NEW one could load node-pty; otherwise the kill
# only turns "hung" into "gone".
# Ruled out:
#   - not a crash / not "down": the process was alive and bound the whole time;
#   - not EADDRINUSE / a squatter: the holder was the pid sessiond.pid recorded;
#   - not the cursor-agent node processes on the box (31312/32516): they were started
#     from Windows Terminal (powershell 34496), not by termhub, after the hang began;
#   - not the AttachConsole stack trace in sessiond.err.log - see below.
#
# THIS ESCALATION COULD NOT FINISH THE REPAIR. Stop-Process on 25468 failed "Access is
# denied": both tiers (sessiond 25468, front 32816) had been started 2026-11-05
# 21:44-21:45 from an ELEVATED shell - their Path and CommandLine were unreadable from
# the Medium-integrity watchdog, while an unrelated user node.exe on the same box was
# fully readable. The watchdog task runs RunLevel=Limited, so neither it nor this
# remedy can ever stop those tiers. No elevation workaround was attempted, by design.
# The remedy now says so and prints the exact two human steps instead of a bare error.
# Not established: what ran the elevated restart at 21:44 (its parent, pid 31396, was
# already gone). How it actually ended: at ~10:11 an attended session stopped both
# elevated tiers through a UAC prompt and ran `npm ci`. That left a plain both-down,
# which `windows\start.ps1 -PublishPort 7000`, run non-elevated, cleared in one pass.
#
# A smaller precursor: 2026-11-05 08:42 the watchdog saw this same signature once and
# it cleared within 5s - unrelated (it recovered; the tree was intact then).
#
# A RED HERRING, because the escalation bundle tails it: a healthy sessiond's stderr
# routinely contains
#   node_modules\node-pty\lib\conpty_console_list_agent.js:13
#   Error: AttachConsole failed
# That is node-pty's forked console-list helper dying, not sessiond (AGENT.md,
# troubleshooting matrix). Those lines predated this hang by twelve hours.
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

# Idempotence: a healthy machine is a no-op.
$pre = Get-TermhubDiagnosis
if ($pre.Healthy) {
  Write-Host "remedy: termhub is already healthy at $($pre.Topology.FrontUrl) - nothing to do."
  exit 0
}
if ($pre.Signature -ne 'sessiond-down-front-up') {
  # The machine moved on to a different failure between the watchdog's confirmation
  # and now. Starting or stopping a sessiond is only licensed by THIS signature, so do
  # nothing and let the next cycle classify and route it.
  Write-Host "remedy: the machine is now '$($pre.Signature)', not sessiond-down-front-up - leaving it for the next watchdog cycle. ($($pre.Detail))"
  exit 1
}

# ---- 1. is sessiond really unresponsive? ------------------------------------
# A longer timeout than the watchdog's 4s probe: a supervisor that is merely slow
# (big scrollback replay, a busy disk) must not be killed for being slow.
$ping = Get-HttpProbe "http://127.0.0.1:$SessiondPort/api/ping" -TimeoutSec 8
if ($ping.Json -and $ping.Json.ok -eq $true) {
  Write-Host "remedy: sessiond answered /api/ping on a longer timeout (pid $($ping.Json.pid)) - not hung, not touching it."
  $d = Wait-Restored -TimeoutSec ([Math]::Min(15, (Get-Remaining)))
  if ($d.Healthy) { Write-Host "remedy: verified healthy at $($d.Topology.FrontUrl)."; exit 0 }
  Write-Host "remedy: sessiond is alive but termhub is still '$($d.Signature)': $($d.Detail)"
  exit 1
}

# ---- 2. who holds the sessiond port? ----------------------------------------
$holder = Get-PortListenerPid -Port $SessiondPort
if ($holder) {
  $name = Get-ProcessNameFor $holder
  $info = Get-PidInfo 'sessiond'
  $cim  = Get-CimInstance Win32_Process -Filter "ProcessId=$holder" -ErrorAction SilentlyContinue
  $cmd  = if ($cim) { [string]$cim.CommandLine } else { '' }
  $byPidFile = ($info -and $info.Pid -eq $holder)
  $byCmd     = ($cmd -match 'sessiond\.js')
  $isMonolith = ($holder -eq (Get-PortListenerPid -Port $PublishPort))

  if ($name -ne 'node') {
    Write-Host "remedy: 127.0.0.1:$SessiondPort is held by '$name' (pid $holder), not node - not a termhub tier, refusing to touch it."
    exit 1
  }
  if ($isMonolith) {
    Write-Host "remedy: pid $holder holds BOTH the sessiond port and the publish port - that is a 'node server.js' monolith, not a hung sessiond. Escalating rather than killing it here."
    exit 1
  }
  if (-not ($byPidFile -or $byCmd)) {
    Write-Host "remedy: node pid $holder holds 127.0.0.1:$SessiondPort but neither sessiond.pid nor its command line identifies it as sessiond - refusing to stop an unidentified process."
    exit 1
  }
  if (Test-SelfAncestor $holder) {
    Write-Host "remedy: pid $holder is an ancestor of this remedy - stopping it would kill the repair mid-run. Refusing."
    exit 1
  }

  # Second, independent look before the kill: a supervisor that recovered in the
  # last few seconds keeps its PTYs.
  $again = Get-HttpProbe "http://127.0.0.1:$SessiondPort/api/ping" -TimeoutSec 5
  if ($again.Json -and $again.Json.ok -eq $true) {
    Write-Host "remedy: sessiond (pid $holder) recovered on its own - not touching it."
    $d = Wait-Restored -TimeoutSec ([Math]::Min(15, (Get-Remaining)))
    if ($d.Healthy) { Write-Host "remedy: verified healthy at $($d.Topology.FrontUrl)."; exit 0 }
    exit 1
  }

  # Can a replacement even start? node-pty on disk is what a fresh sessiond loads,
  # and a broken install (2026-11-06) is also what hangs a running one. Stopping the
  # hung supervisor when its successor cannot load is all cost, no repair.
  # EAP Continue: under 'Stop', PS 5.1 turns the first native stderr line into a
  # terminating NativeCommandError (AGENT.md, "Native git output is not an error").
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $ptyCheck = & (Get-NodePath) -e "require(process.argv[1] + '/node_modules/node-pty'); require('fs').accessSync(process.argv[1] + '/node_modules/node-pty/lib/worker/conoutSocketWorker.js')" $ProjectDir 2>&1
  $ptyOk = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $eap
  if (-not $ptyOk) {
    Write-Host "remedy: node_modules\node-pty does not load ($(($ptyCheck | Select-Object -Last 1)))."
    Write-Host "remedy: that is the likely reason sessiond hung, and a new sessiond would fail the same way - NOT stopping pid $holder."
    Write-Host "remedy: reinstall it (stop the tiers first if conpty.node is locked: move node_modules\node-pty aside, then 'npm install --omit=dev --ignore-scripts --no-audit --no-fund' and 'git checkout -- package-lock.json'), then re-run."
    exit 1
  }

  $started = if ($cim -and $cim.CreationDate) { $cim.CreationDate } else { 'unknown' }
  $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$holder" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'conhost.exe' -and $_.Name -ne 'OpenConsole.exe' })
  $how = if ($byPidFile) { 'sessiond.pid' } else { 'command line' }
  Write-Host "remedy: sessiond pid $holder (started $started, identified by $how) holds 127.0.0.1:$SessiondPort but has not answered /api/ping in 8s+5s - HUNG. Stopping it; its $($kids.Count) PTY child process(es) end and return as Restorable."
  try { Stop-Process -Id $holder -Force -ErrorAction Stop }
  catch {
    Write-Host "remedy: could not stop pid ${holder}: $($_.Exception.Message)"
    # The case that happened on 2026-11-06 (see header). A tier started from an
    # elevated shell runs at High integrity, and this remedy runs at whatever the
    # watchdog task runs at - normally Limited - so it cannot open the process to
    # stop it. Unreadable Path/CommandLine is the tell. No unattended way around
    # that exists, and none should be attempted: hand over to a human, precisely.
    $unreadable = (-not $cmd) -and (-not (Get-Process -Id $holder -ErrorAction SilentlyContinue).Path)
    if ($unreadable) {
      $front = Get-PortListenerPid -Port $FrontPort
      $boot = if ($Mode -eq 'http') { "windows\start-http.ps1 -Port $PublishPort" } else { "windows\start.ps1 -PublishPort $PublishPort" }
      Write-Host "remedy: pid $holder runs at a HIGHER INTEGRITY LEVEL than this remedy (its path and command line are unreadable) - it was started from an elevated shell. A human must:"
      Write-Host "remedy:   1. in an ELEVATED PowerShell: Stop-Process -Id $holder -Force$(if ($front) { "; Stop-Process -Id $front -Force   # the front, if it is elevated too" })"
      Write-Host "remedy:   2. in a NORMAL (non-elevated) PowerShell, from the repo: .\$boot"
      Write-Host "remedy: Step 2 non-elevated matters: tiers started elevated cannot be stopped by the watchdog, which is how this outage outlived its own remedy."
    }
    exit 1
  }
  $freed = $false
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Get-PortListenerPid -Port $SessiondPort)) { $freed = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $freed) {
    Write-Host "remedy: pid $holder was stopped but 127.0.0.1:$SessiondPort is still bound."
    exit 1
  }
  Remove-OwnedPidFile -Name 'sessiond' -ProcId $holder
} else {
  Write-Host "remedy: nothing listens on 127.0.0.1:$SessiondPort - sessiond is gone; starting one."
}

# ---- 3. start a fresh sessiond ----------------------------------------------
# A sessiond whose node_modules was deleted under it hangs on its next spawn; a new
# one would just crash on require('ws'). Reinstalling is not a 60s unattended job.
$missing = @('node_modules\ws\package.json', 'node_modules\node-pty\lib\worker\conoutSocketWorker.js') |
  Where-Object { -not (Test-Path (Join-Path $ProjectDir $_)) }
if ($missing) {
  Write-Host "remedy: termhub's dependencies are damaged (missing: $($missing -join ', ')). A human must run, from a NORMAL PowerShell: cd $ProjectDir; npm ci; .\windows\start.ps1 -PublishPort $PublishPort"
  exit 1
}
try {
  $null = Confirm-Sessiond -Port $SessiondPort -PublishPort $PublishPort
} catch {
  Write-Host "remedy: Confirm-Sessiond failed: $($_.Exception.Message)"
  exit 1
}

# ---- 4. verify; redeploy the front only if it does not pick sessiond back up --
$d = Wait-Restored -TimeoutSec ([Math]::Max(0, [Math]::Min(10, (Get-Remaining) - 20)))
if ($d.Healthy) {
  Write-Host "remedy: verified healthy at $($d.Topology.FrontUrl) - new sessiond pid $($d.SessiondProbe.Json.pid), front untouched."
  exit 0
}

Write-Host "remedy: sessiond is up but termhub is '$($d.Signature)' - redeploying the front ($Mode mode)."
try {
  if ($Mode -eq 'http') {
    if (-not $TailnetIp) {
      Write-Host "remedy: plain-HTTP mode with no tailnet IP - no address to bind a front to (tailnet-ip-unavailable.ps1's job)."
      exit 1
    }
    & (Join-Path $windows 'start-http.ps1') -Port $PublishPort
  } else {
    & (Join-Path $windows 'restart-front.ps1')
  }
} catch {
  Write-Host "remedy: the front script reported: $($_.Exception.Message)"
}

$d = Wait-Restored -TimeoutSec ([Math]::Max(0, [Math]::Min(15, (Get-Remaining))))
if ($d.Healthy) {
  Write-Host "remedy: verified healthy at $($d.Topology.FrontUrl) - sessiond pid $($d.SessiondProbe.Json.pid)."
  exit 0
}
Write-Host "remedy: termhub is still not healthy: $($d.Signature) - $($d.Detail)"
exit 1
