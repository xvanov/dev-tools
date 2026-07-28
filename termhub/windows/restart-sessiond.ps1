# termhub restart-sessiond (Windows) - restart the SUPERVISOR tier.
#
# THIS ENDS EVERY LIVE TERMINAL, including the one you run it from. PTYs live in
# sessiond's memory and cannot be migrated. What survives is the session ARCHIVE
# (sessions.json): after the restart the sidebar lists them under "Restorable",
# and restoring a claude session resumes that exact conversation.
#
# Needed because update.ps1 deliberately never restarts sessiond - that's what
# keeps terminals alive across updates - so sessiond-side changes (sessiond.js,
# lib/*, a node-pty bump) only take effect here, on purpose.
#
# Run it from a plain PowerShell window, NOT from a termhub terminal: this script
# kills that terminal mid-run, and the update it was performing dies with it.
#
#     .\windows\restart-sessiond.ps1 [-Force]

param([switch]$Force)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$state        = Get-TermhubState
$sessiondPort = $state.sessiondPort
$publishPort  = $state.publishPort
$frontPort    = $state.activeFrontPort

$ident = Get-SessiondIdentity -Port $sessiondPort
$live  = if ($ident -and $ident.sessions) { [int]$ident.sessions } else { 0 }

Write-Host "termhub restart-sessiond: port $sessiondPort, running $(Format-Commit $ident.commit $ident.dirty), $live live session(s)."
Write-Host "This ENDS those $live terminal(s). They stay restorable from the sidebar." -ForegroundColor Yellow

# Running inside a termhub PTY means this script is about to kill itself. The
# restart would still happen, but the caller never sees whether it worked.
if ($env:TERMHUB_SESSION_ID -and -not $Force) {
  Write-Host ""
  Write-Host "Refusing: this looks like a termhub terminal (TERMHUB_SESSION_ID is set)." -ForegroundColor Red
  Write-Host "Run it from a normal PowerShell window, or pass -Force to do it anyway." -ForegroundColor Red
  exit 1
}

if (-not $Force) {
  $answer = Read-Host "Type 'yes' to restart sessiond"
  if ($answer -ne 'yes') { Write-Host "Aborted; nothing changed."; exit 1 }
}

# Stop the supervisor: by pid file, then by whatever holds the port (covers a
# monolith `node server.js` and a sessiond whose pid file went missing).
$info = Get-PidInfo 'sessiond'
if ($info -and (Test-NodeAlive $info.Pid)) {
  Write-Host "termhub: stopping sessiond (pid $($info.Pid)) ..."
  try { Stop-Process -Id $info.Pid -Force -ErrorAction Stop } catch { }
}
Remove-PidFile 'sessiond'
if (-not (Clear-PortSquatter -Port $sessiondPort -Why 'restarting sessiond')) {
  throw "port $sessiondPort is still held; sessiond cannot restart."
}

$sessiondPort = Confirm-Sessiond -Port $sessiondPort -PublishPort $publishPort

# The front holds no PTYs but does hold pooled connections to the old supervisor;
# restarting it gives the browser a clean reconnect instead of a pile of 502s.
Write-Host "termhub: restarting the front so it reconnects cleanly ..."
& (Join-Path $PSScriptRoot 'restart-front.ps1')

Write-Host ""
Write-Host "termhub restart-sessiond OK: sessiond 127.0.0.1:$sessiondPort, front 127.0.0.1:$frontPort." -ForegroundColor Green
Write-Host "Previous sessions are in the sidebar under 'Restorable (after restart)'."
