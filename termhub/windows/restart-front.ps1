# termhub restart-front (Windows) - redeploy the FRONT tier from the working tree
# WITHOUT touching sessiond, so every terminal/session (incl. the one you run this
# from) survives.
#
# Use this to pick up LOCAL changes to front.js or the web/ assets. It does NO git
# pull (that's update.ps1's job) - it just relaunches the front from the tree as-is.
#
# Note: pure web/ asset edits (app.js/index.html/styles.css) need only a browser
# refresh - the front serves them from disk per request - but this guarantees a
# clean server process too, and is the safe way to reload front.js.
#
#   .\windows\restart-front.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$state        = Get-TermhubState
$sessiondPort = $state.sessiondPort
$frontPort    = $state.activeFrontPort
$publishPort  = $state.publishPort

# sessiond owns the PTYs and is NEVER restarted here (only started if it's down).
$sessiondPort = Confirm-Sessiond -Port $sessiondPort

# Serve mode routes publishPort -> a loopback front port (they differ); plain-HTTP
# mode binds the front straight onto the tailnet IP (they're equal).
$serveMode = ($frontPort -ne $publishPort)

if ($serveMode) {
  # Zero-gap blue/green: bring the other port up, health-check, flip Serve, drop old.
  $green = if ($frontPort -eq 7001) { 7002 } else { 7001 }
  Stop-Front "front-$green"
  Write-Host "termhub restart-front (serve): starting green on 127.0.0.1:$green ..."
  Start-TermhubNode -Script 'front.js' -EnvVars @{
    TERMHUB_FRONT_PORT = $green; TERMHUB_SESSIOND_PORT = $sessiondPort; TERMHUB_BIND = '127.0.0.1'
  } | Out-Null
  if (-not (Wait-FrontHealthy -Port $green)) { Stop-Front "front-$green"; throw "green front unhealthy on $green; old front still serving." }
  & tailscale serve --bg --https=$publishPort "http://127.0.0.1:$green" 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { Stop-Front "front-$green"; throw "could not re-point Tailscale Serve; old front still serving." }
  Set-TermhubState @{ activeFrontPort = $green } | Out-Null
  Stop-Front "front-$frontPort"
  Write-Host "termhub restart-front OK (serve) -> 127.0.0.1:$green" -ForegroundColor Green
} else {
  # Plain-HTTP: only one process can hold the tailnet IP:port, so there's a brief
  # (~1s) rebind gap. Open browsers auto-reconnect through the new front and
  # sessiond replays scrollback - no session or progress is lost, just a reconnect.
  $ip = ((& tailscale ip -4) | Select-Object -First 1).Trim()
  if (-not $ip) { throw "could not determine Tailscale IPv4 address (tailscale ip -4)" }
  Stop-Front "front-$frontPort"
  Write-Host "termhub restart-front (http): starting front on ${ip}:$frontPort ..."
  Start-TermhubNode -Script 'front.js' -EnvVars @{
    TERMHUB_FRONT_PORT = $frontPort; TERMHUB_SESSIOND_PORT = $sessiondPort; TERMHUB_BIND = $ip
  } | Out-Null
  $deadline = (Get-Date).AddSeconds(12); $ok = $false
  while ((Get-Date) -lt $deadline) {
    try { if (((Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://${ip}:$frontPort/api/health").Content | ConvertFrom-Json).ok -eq $true) { $ok = $true; break } } catch { }
    Start-Sleep -Milliseconds 400
  }
  if (-not $ok) { throw "front did not become healthy on ${ip}:$frontPort" }
  Write-Host "termhub restart-front OK (http) -> ${ip}:$frontPort" -ForegroundColor Green
}

Write-Host "sessiond untouched (127.0.0.1:$sessiondPort) - all sessions preserved."
