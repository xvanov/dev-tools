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

$TaskName = 'TermhubWatchdog'
$script   = Join-Path $PSScriptRoot 'watchdog.ps1'

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

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
# without depending on the past-dated -Once trigger being re-armed.
function Set-TriggerRepetition {
  param($Trigger, [int]$Minutes)
  $donor = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $Minutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $Trigger.Repetition = $donor.Repetition
  return $Trigger
}

$triggers = @(
  (Set-TriggerRepetition -Trigger (New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1))) -Minutes $IntervalMinutes),
  (Set-TriggerRepetition -Trigger (New-ScheduledTaskTrigger -AtStartup) -Minutes $IntervalMinutes)
)

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Quiet" `
  -WorkingDirectory $ProjectDir

# MultipleInstances IgnoreNew is load-bearing, not hygiene. An escalation can hold the
# task for minutes while a model works; with a 2-minute trigger, anything else would
# stack watchdogs that all diagnose the same outage and all try to repair it at once.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

# Mirror the Termhub task's principal: S4U runs the watchdog even with nobody logged
# on, which is the case that matters most — a machine that rebooted unattended.
#
# NOT "$env:USERDOMAIN\$env:USERNAME": on a machine that is not domain-joined
# USERDOMAIN is the literal string WORKGROUP, and 'WORKGROUP\mvadmin' resolves to no
# SID at all - Register-ScheduledTask fails with "No mapping between account names
# and security IDs was done". WindowsIdentity always gives a name that resolves
# (<machine>\<user> in a workgroup, <domain>\<user> when joined).
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($elevated) {
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
} else {
  Write-Host "watchdog: not elevated - registering with an Interactive principal, so the" -ForegroundColor Yellow
  Write-Host "watchdog: watchdog only runs while $me is logged on. Re-run this from an admin" -ForegroundColor Yellow
  Write-Host "watchdog: shell to get the S4U principal that survives logoff and reboot." -ForegroundColor Yellow
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
}

try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop | Out-Null } catch { }

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal `
    -Description "Watches termhub, repairs known failures from watchdog\remedies\, and escalates novel ones to Claude Code." | Out-Null
} catch {
  throw "could not register '$TaskName': $($_.Exception.Message)"
}

# Verify, rather than trust that no error surfaced. Register-ScheduledTask reports
# some CIM failures WITHOUT tripping -ErrorAction Stop, so this script's first
# version printed "registered" over the top of a registration that had just failed -
# leaving a machine that believed it was watched and was not. That is the single
# worst way for a watchdog to be wrong, so it is checked rather than assumed.
$registered = $null
try { $registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
if (-not $registered) { throw "'$TaskName' is not present after registering it - the install FAILED." }

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
