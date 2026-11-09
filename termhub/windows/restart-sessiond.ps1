# termhub restart-sessiond (Windows) - restart the SUPERVISOR tier.
#
# Terminals live in ptyd, not in sessiond. Restarting sessiond adopts the ones
# ptyd still has (same id, output kept) as long as the next start also uses ptyd,
# which is the only host. It does not restart ptyd. A sessiond that is still on
# node-pty (a process from before Exit 5) ends those terminals once; they come
# back Restorable from sessions.json.
#
# Needed because update.ps1 deliberately never restarts sessiond - that's what
# keeps the front swap from touching terminals - so sessiond-side changes
# (sessiond.js, lib/*) only take effect here, on purpose.
#
# Run it from a plain PowerShell window, NOT from a termhub terminal: it restarts
# the front, which drops the view, and a sessiond that is still on node-pty would
# end this terminal mid-run.
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
if ($ident -and "$($ident.ptyHost)" -eq 'ptyd') {
  Write-Host "Its PTYs live in ptyd: they survive this restart (ptyd is not restarted)." -ForegroundColor Yellow
} elseif ($live -gt 0) {
  Write-Host "This sessiond is not on ptyd. Restarting it ENDS those $live terminal(s); they stay restorable from the sidebar. The new sessiond uses ptyd only." -ForegroundColor Yellow
}
# The next start must resolve to ptyd. Exit 2 is the removed node-pty setting; do not kill sessiond then.
& node (Join-Path $PSScriptRoot '..\lib\ptyHost.js') status | ForEach-Object { Write-Host "  pty host $_" }
if ($LASTEXITCODE -ne 0) { throw "refusing to restart sessiond: ptyd is not the next host (above). Rollback is the previous commit, not TERMHUB_PTYD=0." }

# Running inside a termhub terminal: the front restart drops this view, and a
# sessiond still on node-pty would kill this shell. The caller would not see
# whether it worked.
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

# ptyd up first, before sessiond is stopped, so a failed -Ensure leaves the
# current sessiond in place. -Ensure never restarts a running ptyd.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ptyd.ps1') -Ensure
if ($LASTEXITCODE -ne 0) { throw "ptyd -Ensure failed; sessiond was not stopped. node-pty was retired, so there is no other host." }

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
Write-Host "Terminals that were in ptyd are still there. A sessiond that was not on ptyd left its terminals under Restorable."
