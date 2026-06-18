# termhub safe update (Windows) - deterministic, reversible, terminals survive.
#
# Run from ANY termhub terminal on this machine (your remote-trigger mechanism).
# Because only the front is swapped - sessiond and its PTYs are never touched -
# even the terminal running this script survives the update.
#
#   git pull --ff-only  ->  start GREEN front on the alternate loopback port
#   ->  health-check it  ->  if healthy: re-point Tailscale Serve, stop BLUE
#                            if not:     kill GREEN, roll back, keep BLUE serving
#
#     .\windows\update.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Fail($msg) { Write-Host "termhub update FAILED: $msg" -ForegroundColor Red; exit 1 }

$git = (Get-Command git -ErrorAction SilentlyContinue)
if (-not $git) { Fail "git not found on PATH." }

$state        = Get-TermhubState
$sessiondPort = $state.sessiondPort
$bluePort     = $state.activeFrontPort
$publishPort  = $state.publishPort
$greenPort    = if ($bluePort -eq 7001) { 7002 } else { 7001 }

Write-Host "termhub update: blue=$bluePort  green=$greenPort  sessiond=$sessiondPort  publish=$publishPort"

# 0) sessiond must be up (start if somehow down - does NOT restart a live one).
$sessiondPort = Confirm-Sessiond -Port $sessiondPort

# 1) Pull, deterministically. Save the current commit for rollback.
$rollback = (& git -C $ProjectDir rev-parse HEAD).Trim()
Write-Host "termhub update: current HEAD $rollback"
& git -C $ProjectDir fetch --quiet
if ($LASTEXITCODE -ne 0) { Fail "git fetch failed." }
$pull = & git -C $ProjectDir pull --ff-only 2>&1
Write-Host $pull
if ($LASTEXITCODE -ne 0) { Fail "git pull --ff-only failed (not a fast-forward, or dirty tree). Nothing changed; blue still serving." }
$newHead = (& git -C $ProjectDir rev-parse HEAD).Trim()
if ($newHead -eq $rollback) { Write-Host "termhub update: already up to date - re-deploying anyway to pick up local changes." }

# 2) Install deps only if the lockfile/manifest changed (front needs no native build).
$changed = & git -C $ProjectDir diff --name-only $rollback $newHead
if ($changed -match 'package(-lock)?\.json') {
  Write-Host "termhub update: dependencies changed -> npm install (no native build)"
  Push-Location $ProjectDir
  try { & npm install --omit=dev --ignore-scripts --no-audit --no-fund } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { & git -C $ProjectDir reset --hard $rollback | Out-Null; Fail "npm install failed; rolled back. Blue still serving." }
}

# 3) Clear any stale green, then start the new GREEN front.
Stop-Front "front-$greenPort"
Write-Host "termhub update: starting green front on 127.0.0.1:$greenPort ..."
Start-TermhubNode -Script 'front.js' -EnvVars @{
  TERMHUB_FRONT_PORT    = $greenPort
  TERMHUB_SESSIOND_PORT = $sessiondPort
  TERMHUB_BIND          = '127.0.0.1'
} | Out-Null

# 4) Health-check green: front up + sessiond reachable, and the proxy path works.
$healthy = Wait-FrontHealthy -Port $greenPort -TimeoutSec 12
if ($healthy) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 "http://127.0.0.1:$greenPort/api/sessions"
    if ($r.StatusCode -ne 200) { $healthy = $false }
    $idx = Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 "http://127.0.0.1:$greenPort/"
    if ($idx.StatusCode -ne 200) { $healthy = $false }
  } catch { $healthy = $false }
}

if (-not $healthy) {
  Write-Host "termhub update: green failed health check - rolling back." -ForegroundColor Yellow
  Stop-Front "front-$greenPort"
  & git -C $ProjectDir reset --hard $rollback | Out-Null
  Fail "new version unhealthy; reverted tree to $rollback. Blue (port $bluePort) still serving - terminals untouched."
}

# 5) Cut over: re-point Tailscale Serve to green (atomic), record state, stop blue.
Write-Host "termhub update: green healthy - re-pointing Tailscale Serve to 127.0.0.1:$greenPort"
& tailscale serve --bg --https=$publishPort "http://127.0.0.1:$greenPort" 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "termhub update: tailscale serve re-point failed - rolling back." -ForegroundColor Yellow
  Stop-Front "front-$greenPort"
  & git -C $ProjectDir reset --hard $rollback | Out-Null
  Fail "could not re-point Tailscale Serve; blue (port $bluePort) still serving."
}
Set-TermhubState @{ activeFrontPort = $greenPort } | Out-Null
Stop-Front "front-$bluePort"

Write-Host ""
Write-Host "termhub update OK: now serving green (127.0.0.1:$greenPort) at HEAD $newHead." -ForegroundColor Green
Write-Host "Open terminals reconnect automatically to the same sessions (sessiond 127.0.0.1:$sessiondPort)."
