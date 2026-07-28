# termhub boot - start/ensure both tiers and publish via Tailscale Serve.
#
# Run by the Termhub scheduled task (or Startup launcher) at logon, and safe to
# run by hand. Idempotent: reuses a live sessiond/front instead of restarting it,
# so re-running this never kills terminals.
#
# PORT MODES (recorded in state.json, so update.ps1 follows whatever is set here):
#
#   -SinglePort (default for a fresh install)
#       front binds 127.0.0.1:<publishPort> and Serve proxies the SAME number to
#       it. One port is the whole answer: https://<host>:<publishPort>/ and
#       http://127.0.0.1:<publishPort>/ are the same server. Serve only ever binds
#       the tailnet IP, so it and the front coexist on that port number without
#       colliding. Cost: updates swap the front in place, so there's a ~1-2s gap.
#
#   -BlueGreen
#       front hides on 7001/7002 and Serve is re-pointed between them, making the
#       update cutover atomic with the old front alive as a rollback target. Cost:
#       http://127.0.0.1:<publishPort> is NOT a working URL - only the tailnet one.
#
# Neither mode touches sessiond, so terminals survive both.
#
#     .\windows\start.ps1 [-PublishPort 7000] [-SinglePort | -BlueGreen]

param([int]$PublishPort = 0, [switch]$SinglePort, [switch]$BlueGreen)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if ($SinglePort -and $BlueGreen) { throw "-SinglePort and -BlueGreen are mutually exclusive." }

$state = Get-TermhubState
if ($PublishPort -eq 0) { $PublishPort = $state.publishPort }
$sessiondPort = $state.sessiondPort
$frontPort    = $state.activeFrontPort

# Resolve the mode: an explicit switch wins, otherwise keep whatever state.json
# says. A front port that isn't one of the two loopback ports and isn't the
# publish port is nonsense (hand-edited state, a renumbered publish port) - fall
# back to single-port rather than binding somewhere nobody is looking.
$modeSwitched = $false
if ($SinglePort) { $modeSwitched = ($frontPort -ne $PublishPort); $frontPort = $PublishPort }
elseif ($BlueGreen) {
  if ($frontPort -eq $PublishPort) { $modeSwitched = $true; $frontPort = 7001 }
}
elseif ($frontPort -ne $PublishPort -and $frontPort -notin @(7001, 7002)) {
  Write-Host "termhub: state.json front port $frontPort makes no sense - using single-port ($PublishPort)." -ForegroundColor Yellow
  $frontPort = $PublishPort
}
$isSinglePort = ($frontPort -eq $PublishPort)

# Switching modes leaves a front listening on a port nothing points at any more,
# still proxying to the same sessiond - a second, stale UI. Stop the other mode's
# fronts before starting this one.
if ($modeSwitched) {
  Write-Host "termhub: switching to $(if ($isSinglePort) { "single-port ($PublishPort)" } else { "blue/green ($frontPort)" }) mode."
  foreach ($p in @(7001, 7002, $PublishPort)) { if ($p -ne $frontPort) { Stop-Front "front-$p" } }
}

# 0) Reclaim the publish port if something that isn't a front is squatting it
#    (see Clear-PublishPort), and flag a logon task that keeps recreating it.
Clear-PublishPort -PublishPort $PublishPort -SessiondPort $sessiondPort -ActiveFrontPort $frontPort
Test-TermhubTask

# 1) Persistent supervisor (owns the PTYs). Never restarted here.
$sessiondPort = Confirm-Sessiond -Port $sessiondPort -PublishPort $PublishPort

# 2) Active front (UI + proxy). Reuse if already alive AND actually serving; a pid
#    file alone isn't proof (the process can be wedged or gone with a stale file).
$finfo = Get-PidInfo "front-$frontPort"
$frontLive = $finfo -and (Test-NodeAlive $finfo.Pid) -and (Wait-FrontHealthy -Port $frontPort -TimeoutSec 3)
if ($frontLive) {
  Write-Host "termhub: front already running (pid $($finfo.Pid), port $frontPort)"
} else {
  Stop-Front "front-$frontPort"
  if (-not (Start-VerifiedFront -Port $frontPort -SessiondPort $sessiondPort)) {
    throw "front did not become healthy on 127.0.0.1:$frontPort"
  }
}

# 3) Publish the active front on the tailnet (loopback target; raw ports are
#    dropped by the Windows firewall on the Tailscale interface). In single-port
#    mode this is <publishPort> -> 127.0.0.1:<publishPort>: not a loop, because
#    Serve listens on the tailnet IP and the front listens on loopback.
Set-TermhubState @{ sessiondPort = $sessiondPort; activeFrontPort = $frontPort; publishPort = $PublishPort } | Out-Null
& tailscale serve --bg --https=$PublishPort "http://127.0.0.1:$frontPort" 2>&1 | Out-Host

# 4) Report the URL.
$dns = ''
try { $dns = ((& tailscale status --json 2>$null | ConvertFrom-Json).Self.DNSName).TrimEnd('.') } catch { }
Write-Host ""
if ($dns) { Write-Host "termhub up:  https://${dns}:${PublishPort}/" }
else      { Write-Host "termhub up on front 127.0.0.1:$frontPort - find the URL with: tailscale serve status" }
if ($isSinglePort) { Write-Host "             http://127.0.0.1:$PublishPort/   (same server, local)" }
Write-Host "             (sessiond 127.0.0.1:$sessiondPort, front 127.0.0.1:$frontPort)"
