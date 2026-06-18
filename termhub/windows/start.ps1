# termhub boot - start/ensure both tiers and publish via Tailscale Serve.
#
# Run by the Termhub scheduled task (or Startup launcher) at logon, and safe to
# run by hand. Idempotent: reuses a live sessiond/front instead of restarting it,
# so re-running this never kills terminals.
#
#     .\windows\start.ps1 [-PublishPort 7000]

param([int]$PublishPort = 0)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$state = Get-TermhubState
if ($PublishPort -eq 0) { $PublishPort = $state.publishPort }
$sessiondPort = $state.sessiondPort
$frontPort    = $state.activeFrontPort

# 1) Persistent supervisor (owns the PTYs). Never restarted here.
$sessiondPort = Confirm-Sessiond -Port $sessiondPort

# 2) Active front (UI + proxy). Reuse if already alive.
$frontName = "front-$frontPort"
$finfo = Get-PidInfo $frontName
if ($finfo -and (Test-NodeAlive $finfo.Pid)) {
  Write-Host "termhub: front already running (pid $($finfo.Pid), port $frontPort)"
} else {
  Write-Host "termhub: starting front on 127.0.0.1:$frontPort ..."
  Start-TermhubNode -Script 'front.js' -EnvVars @{
    TERMHUB_FRONT_PORT    = $frontPort
    TERMHUB_SESSIOND_PORT = $sessiondPort
    TERMHUB_BIND          = '127.0.0.1'
  } | Out-Null
  if (-not (Wait-FrontHealthy -Port $frontPort)) { throw "front did not become healthy on port $frontPort" }
}

# 3) Publish the active front on the tailnet (loopback target; raw ports are
#    dropped by the Windows firewall on the Tailscale interface).
Set-TermhubState @{ sessiondPort = $sessiondPort; activeFrontPort = $frontPort; publishPort = $PublishPort } | Out-Null
& tailscale serve --bg --https=$PublishPort "http://127.0.0.1:$frontPort" 2>&1 | Out-Host

# 4) Report the URL.
$dns = ''
try { $dns = ((& tailscale status --json 2>$null | ConvertFrom-Json).Self.DNSName).TrimEnd('.') } catch { }
Write-Host ""
if ($dns) { Write-Host "termhub up:  https://${dns}:${PublishPort}/   (sessiond 127.0.0.1:$sessiondPort, front 127.0.0.1:$frontPort)" }
else      { Write-Host "termhub up on front 127.0.0.1:$frontPort - find the URL with: tailscale serve status" }
