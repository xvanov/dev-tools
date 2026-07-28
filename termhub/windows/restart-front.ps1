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
# It follows whichever of the THREE layouts the machine is on (see the mode
# resolution below); it never switches modes - that's start.ps1's job.
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

# There are THREE layouts, and state.json only distinguishes the first:
#
#   blue/green   activeFrontPort != publishPort - the front hides on 7001/7002 and
#                Serve is re-pointed between them.
#   single-port  activeFrontPort == publishPort AND Serve publishes it - the front
#                is on 127.0.0.1:<publishPort>; Serve proxies the same number to it
#                from the tailnet IP only, so the two never collide.
#   plain HTTP   activeFrontPort == publishPort AND Serve is off for it
#                (start-http.ps1) - the front binds the tailnet IP itself.
#
# The last two are recorded identically, so the mode is read from Serve rather than
# from the port numbers (Test-ServePublished). Assuming equal ports meant plain
# HTTP - as this script used to - is fatal on a single-port machine, i.e. on the
# default layout: it tried to bind <tailnet-ip>:<publishPort>, which tailscaled
# already holds for Serve, then failed the health check and left NO front running.
# restart-sessiond.ps1 calls this script, so that took the whole restart down with
# it, after sessiond had already been killed.
if ($frontPort -ne $publishPort) {
  $mode = 'bluegreen'
} else {
  $published = Test-ServePublished -Port $publishPort
  if ($published -eq $false) {
    $mode = 'http'
  } else {
    $mode = 'single'
    if ($null -eq $published) {
      Write-Host "termhub restart-front: could not read 'tailscale serve status' - assuming single-port, the default." -ForegroundColor Yellow
      Write-Host "termhub restart-front: if this machine uses the plain-HTTP layout, run .\windows\start-http.ps1 instead." -ForegroundColor Yellow
    }
  }
}

if ($mode -eq 'bluegreen') {
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
} elseif ($mode -eq 'single') {
  # One socket for both the front and the published number, so there is nowhere to
  # stage: the old front is stopped and the new one takes the same port. That's a
  # ~1-2s window of refused connections; browsers reconnect through the new front
  # and sessiond replays the scrollback, so no session or progress is lost.
  Write-Host "termhub restart-front (single-port): swapping the front on 127.0.0.1:$publishPort (brief gap) ..."
  Stop-Front "front-$publishPort"
  if (-not (Start-VerifiedFront -Port $publishPort -SessiondPort $sessiondPort)) {
    throw "front did not become healthy on 127.0.0.1:$publishPort"
  }
  # Serve should already point here; re-assert it so a lost or wrong config heals.
  & tailscale serve --bg --https=$publishPort "http://127.0.0.1:$publishPort" 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host "termhub restart-front: could not re-assert Tailscale Serve - the front is up and http://127.0.0.1:$publishPort works," -ForegroundColor Yellow
    Write-Host "termhub restart-front: but the tailnet URL may not. Check: tailscale serve status" -ForegroundColor Yellow
  }
  Set-TermhubState @{ activeFrontPort = $publishPort } | Out-Null
  # A leftover blue/green front from a previous mode would keep serving stale code.
  foreach ($p in @(7001, 7002)) { if ($p -ne $publishPort) { Stop-Front "front-$p" } }
  Write-Host "termhub restart-front OK (single-port) -> 127.0.0.1:$publishPort" -ForegroundColor Green
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
