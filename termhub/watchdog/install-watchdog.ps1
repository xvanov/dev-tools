# Register (or remove) the TermhubWatchdog scheduled task.
#
#   .\watchdog\install-watchdog.ps1                     # every 2 minutes, plus at boot
#   .\watchdog\install-watchdog.ps1 -IntervalMinutes 5
#   .\watchdog\install-watchdog.ps1 -Uninstall
#
# Why a scheduled task rather than a long-lived process: the watchdog is then itself
# supervised. A crashed or wedged watchdog is replaced by the next scheduled run,
# whereas a resident loop that dies leaves nothing watching the thing it was watching
# — and a watchdog that fails silently is worse than none, because it is trusted.
#
# It also keeps the watchdog out of any PTY's process tree. A console-launched
# supervisor shares the fate of the terminal it was started from, which is a plausible
# way for termhub's front to have quietly disappeared in the first place.

param(
  [int]$IntervalMinutes = 2,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\windows\common.ps1')
. (Join-Path $PSScriptRoot 'lib\task.ps1')

$TaskName = $WatchdogTaskName
$script   = Get-WatchdogScriptPath
$elevated = Test-WatchdogAdmin

if ($Uninstall) {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "watchdog: unregistered scheduled task '$TaskName'." -ForegroundColor Green
  } catch {
    Write-Host "watchdog: '$TaskName' was not registered ($($_.Exception.Message))." -ForegroundColor Yellow
  }
  Write-Host "watchdog: note that this does NOT stop termhub - the tiers keep running."
  return
}

if (-not (Test-Path $script)) { throw "watchdog.ps1 not found at $script" }

# Repetition on a boot/logon trigger is not exposed as a parameter, so it is lifted
# off a throwaway -Once trigger. Both triggers repeat: the -Once trigger drives the
# steady state, and the boot trigger guarantees the cycle restarts after a reboot
# The triggers, settings, principal and post-registration verification all live in
# lib\task.ps1, because windows\install.ps1 and windows\update.ps1 register this same
# task and a second copy of that logic is a second thing to drift.
if (-not $elevated) {
  Write-Host "watchdog: not elevated - registering with an Interactive principal, so the" -ForegroundColor Yellow
  Write-Host "watchdog: watchdog only runs while you are logged on. Re-run this from an admin" -ForegroundColor Yellow
  Write-Host "watchdog: shell to get the S4U principal that survives logoff and reboot." -ForegroundColor Yellow
}

$result = Register-WatchdogTask -IntervalMinutes $IntervalMinutes
if (-not $result.Ok) { throw "could not register '$TaskName': $($result.Message)" }

Write-Host ""
Write-Host "watchdog: registered '$TaskName' - every $IntervalMinutes min, and at startup." -ForegroundColor Green
Write-Host "watchdog: script  $script"
Write-Host "watchdog: log     $(Join-Path (Join-Path (Get-TermhubDataDir) 'watchdog') 'watchdog.log')"
Write-Host ""
Write-Host "  Start-ScheduledTask $TaskName            # run a cycle now"
Write-Host "  .\watchdog\watchdog.ps1 -Probe           # report the current state, change nothing"
Write-Host "  New-Item `"$(Join-Path (Join-Path (Get-TermhubDataDir) 'watchdog') 'DISABLED')`" -ItemType File   # kill switch"
Write-Host ""

# The watchdog restarts a dead front; it cannot bring termhub up after a reboot before
# anyone logs on unless the Termhub task itself is sound. Say so if it is not.
try {
  $t = Get-ScheduledTask -TaskName 'Termhub' -ErrorAction Stop
  $act = (($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ')
  if ($act -notmatch 'start\.ps1|start-http\.ps1') {
    Write-Host "watchdog: WARNING - the 'Termhub' task does not run a start script: $act" -ForegroundColor Yellow
  }
} catch {
  Write-Host "watchdog: WARNING - there is no 'Termhub' scheduled task, so nothing starts termhub at" -ForegroundColor Yellow
  Write-Host "watchdog: boot. The watchdog will repair that as a 'both-down' outage a couple of" -ForegroundColor Yellow
  Write-Host "watchdog: minutes later, but fixing the cause is better: run windows\install.ps1." -ForegroundColor Yellow
}
