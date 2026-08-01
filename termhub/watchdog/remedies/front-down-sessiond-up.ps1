# REPAIRS: front-down-sessiond-up
#
# Nothing is listening on the address this machine publishes, while sessiond is
# healthy on its loopback port. So the PTYs — and every terminal the user has open —
# are intact in sessiond's memory, and the only missing piece is the front tier that
# serves the UI and proxies to it.
#
# THE FIX: start a front, and nothing else. sessiond is deliberately left completely
# alone; restarting it here would end every live terminal to repair a process that is
# not the one that failed.
#
# This was the first outage the watchdog was built for (2026-07-31): the front had
# died some hours after being started, and nothing on the machine would ever have
# restarted it — the `Termhub` scheduled task fires at logon only. It was repaired by
# hand with exactly the command below.
#
# Mode matters, and this is why the watchdog resolves it from Tailscale Serve rather
# than from state.json (single-port and plain-HTTP record identically):
#   http       the front owns <tailnet ip>:<port> itself and Serve is OFF for it, so
#              start-http.ps1 is the unambiguous choice. Letting restart-front.ps1
#              resolve the mode a second time risks it falling back to 'single' when
#              Serve cannot be read, which would bind loopback and leave the machine
#              reachable only from itself.
#   single     the front owns 127.0.0.1:<port> and Serve proxies the same number to
#              it from the tailnet IP.
#   bluegreen  the front hides on 7001/7002 and Serve points at one of them.
# restart-front.ps1 handles the latter two correctly and never switches modes, which
# is exactly the property wanted here.

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

$windows = Join-Path $ProjectDir 'windows'

try {
  if ($Mode -eq 'http') {
    Write-Host "remedy: plain-HTTP mode - start-http.ps1 -Port $PublishPort"
    & (Join-Path $windows 'start-http.ps1') -Port $PublishPort
  } else {
    Write-Host "remedy: $Mode mode - restart-front.ps1"
    & (Join-Path $windows 'restart-front.ps1')
  }
} catch {
  Write-Host "remedy: the start script failed: $($_.Exception.Message)"
  exit 1
}

# Verify rather than assume. The start scripts health-check their own launch, but a
# remedy claiming success it did not achieve turns the watchdog's log into fiction —
# and the exit code is what decides whether this escalates to a model.
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $d = Get-TermhubDiagnosis
  if ($d.Healthy) {
    Write-Host "remedy: verified healthy at $($d.Topology.FrontUrl) (sessiond untouched, $($d.SessiondProbe.Json.sessions) session(s))"
    exit 0
  }
  Start-Sleep -Seconds 2
}

$d = Get-TermhubDiagnosis
Write-Host "remedy: the front was started but termhub is still not healthy: $($d.Signature) - $($d.Detail)"
exit 1
