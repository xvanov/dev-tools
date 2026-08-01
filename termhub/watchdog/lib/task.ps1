# termhub watchdog - the scheduled task as code, shared by install-watchdog.ps1,
# windows\install.ps1 and windows\update.ps1 so a machine cannot end up with a
# watchdog that install knows about and update doesn't.
#
# Dot-source AFTER windows\common.ps1 (it uses $ProjectDir). Dot-sourcing common.ps1
# again is harmless if you're not sure - it derives $ProjectDir from its own location.
#
# WHY THERE IS NO "RESTART THE WATCHDOG" STEP
#
# The task's action is `powershell.exe -File <watchdog.ps1>`: a fresh process every
# cycle, reading the script off disk each time. So a `git pull` that changes the
# watchdog is live on the next tick, with nothing to restart and no stale code
# resident anywhere. That is the opposite of the `front`, which is a long-running
# process and must be swapped deliberately.
#
# What CAN go stale is the task DEFINITION - the script path it points at, or the
# task existing at all. That is what Confirm-WatchdogTask repairs.

$WatchdogTaskName = 'TermhubWatchdog'

function Test-WatchdogAdmin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WatchdogScriptPath {
  return (Join-Path $ProjectDir 'watchdog\watchdog.ps1')
}

function Get-WatchdogTask {
  try { return (Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction Stop) } catch { return $null }
}

# Does this task actually launch THIS checkout's watchdog? A machine whose repo was
# moved or re-cloned elsewhere keeps a task pointing at a path that no longer exists,
# and a task that fails to start looks identical to a machine that is simply healthy.
function Test-WatchdogTaskTargets {
  param($Task, [string]$Script)
  if (-not $Task) { return $false }
  $act = (($Task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ')
  return ($act.ToLowerInvariant().Contains($Script.ToLowerInvariant()))
}

# Repetition is not a parameter on boot/logon triggers, so it is lifted off a
# throwaway -Once trigger. Both triggers repeat: the -Once one drives the steady
# state, and the boot trigger restarts the cycle after a reboot without relying on a
# past-dated -Once trigger being re-armed.
function New-WatchdogTriggers {
  param([int]$IntervalMinutes)
  $donor = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $once = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1))
  $once.Repetition = $donor.Repetition
  $boot = New-ScheduledTaskTrigger -AtStartup
  $boot.Repetition = $donor.Repetition
  return @($once, $boot)
}

# Register (or re-register) the task. Never throws: returns
# @{ Ok; LogonType; Message }, because the caller decides how loud to be - an
# explicit install should fail visibly, an update must not roll back over this.
function Register-WatchdogTask {
  param([int]$IntervalMinutes = 2, [string]$ForceLogonType = '')
  $script = Get-WatchdogScriptPath
  if (-not (Test-Path $script)) {
    return @{ Ok = $false; LogonType = ''; Message = "no watchdog in this checkout ($script)" }
  }

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Quiet" `
    -WorkingDirectory $ProjectDir

  # MultipleInstances IgnoreNew is load-bearing: an escalation can hold the task for
  # minutes, and a 2-minute trigger would otherwise stack watchdogs that all
  # diagnose the same outage and all try to repair it at once.
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

  # NOT "$env:USERDOMAIN\$env:USERNAME": off a domain USERDOMAIN is the literal
  # WORKGROUP, which resolves to no SID, and registration fails with "No mapping
  # between account names and security IDs was done".
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $logon = $ForceLogonType
  if (-not $logon) { $logon = if (Test-WatchdogAdmin) { 'S4U' } else { 'Interactive' } }
  try {
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType $logon -RunLevel Limited
  } catch {
    return @{ Ok = $false; LogonType = $logon; Message = "could not build a principal for ${me}: $($_.Exception.Message)" }
  }

  try {
    Register-ScheduledTask -TaskName $WatchdogTaskName -Action $action `
      -Trigger (New-WatchdogTriggers -IntervalMinutes $IntervalMinutes) `
      -Settings $settings -Principal $principal -Force `
      -Description "Watches termhub, repairs known failures from watchdog\remedies\, and escalates novel ones to Claude Code." | Out-Null
  } catch {
    return @{ Ok = $false; LogonType = $logon; Message = $_.Exception.Message }
  }

  # Verify rather than trust that no error surfaced. Register-ScheduledTask reports
  # some CIM failures WITHOUT tripping -ErrorAction Stop, so an early version of the
  # installer printed "registered" over a registration that had just failed - leaving
  # a machine that believed it was watched and was not, which is the worst way for a
  # watchdog to be wrong.
  if (-not (Get-WatchdogTask)) {
    return @{ Ok = $false; LogonType = $logon; Message = "'$WatchdogTaskName' is not present after registering it" }
  }
  return @{ Ok = $true; LogonType = $logon; Message = '' }
}

# Make sure a usable watchdog task is in place, and say what changed. Safe to call
# from every install and every update: the healthy path is a no-op and prints one
# line. Never throws.
#
# Deliberately does NOT reconcile the interval. A user who ran
# `install-watchdog.ps1 -IntervalMinutes 5` meant it, and having every update quietly
# reset that would be hostile. Only presence, target and enablement are repaired.
function Confirm-WatchdogTask {
  param([int]$IntervalMinutes = 2, [switch]$Quiet)
  $script = Get-WatchdogScriptPath
  if (-not (Test-Path $script)) { return }

  $task = Get-WatchdogTask

  if ($task -and (Test-WatchdogTaskTargets -Task $task -Script $script)) {
    # A disabled task is the one case where "exists and points here" still isn't
    # watching anything.
    if ("$($task.State)" -eq 'Disabled') {
      try {
        Enable-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction Stop | Out-Null
        Write-Host "termhub: re-enabled the '$WatchdogTaskName' task (it was disabled)." -ForegroundColor Yellow
      } catch {
        Write-Host "termhub: the '$WatchdogTaskName' task is DISABLED and could not be re-enabled: $($_.Exception.Message)" -ForegroundColor Yellow
      }
    } elseif (-not $Quiet) {
      # No restart needed - the task starts a fresh powershell per cycle, so a pull
      # that changed watchdog.ps1 is already live.
      Write-Host "termhub: watchdog task OK (next cycle runs the updated watchdog.ps1)."
    }
    Confirm-WatchdogNotDisabledByFile
    return
  }

  if ($task) {
    $existingLogon = "$($task.Principal.LogonType)"
    $act = (($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ')
    Write-Host ""
    Write-Host "termhub: the '$WatchdogTaskName' task does not point at this checkout:" -ForegroundColor Yellow
    Write-Host "termhub:   $act" -ForegroundColor Yellow
    # Re-registering non-elevated would DOWNGRADE an S4U task (runs with nobody
    # logged on) to Interactive (only while logged on). Losing that silently during a
    # routine update is worse than leaving the mismatch and saying so.
    if ($existingLogon -eq 'S4U' -and -not (Test-WatchdogAdmin)) {
      Write-Host "termhub: it runs as S4U (works when logged off) and re-registering from a" -ForegroundColor Yellow
      Write-Host "termhub: non-elevated shell would downgrade that, so it is being left alone." -ForegroundColor Yellow
      Write-Host "termhub: fix from an ADMIN shell:  .\watchdog\install-watchdog.ps1" -ForegroundColor Yellow
      return
    }
    $r = Register-WatchdogTask -IntervalMinutes $IntervalMinutes -ForceLogonType $existingLogon
    if ($r.Ok) { Write-Host "termhub: re-pointed the watchdog task at $script" -ForegroundColor Green }
    else { Write-Host "termhub: could not re-point the watchdog task: $($r.Message)" -ForegroundColor Yellow }
    Confirm-WatchdogNotDisabledByFile
    return
  }

  # Not registered at all - the normal case on a machine that predates the watchdog.
  $r = Register-WatchdogTask -IntervalMinutes $IntervalMinutes
  if ($r.Ok) {
    $scope = if ($r.LogonType -eq 'S4U') { 'runs even when logged off' } else { 'runs while you are logged on' }
    Write-Host "termhub: registered the '$WatchdogTaskName' task - every $IntervalMinutes min, at boot ($scope)." -ForegroundColor Green
    if ($r.LogonType -ne 'S4U') {
      Write-Host "termhub: re-run .\watchdog\install-watchdog.ps1 from an ADMIN shell to have it survive logoff." -ForegroundColor Yellow
    }
  } else {
    Write-Host "termhub: could not register the watchdog task ($($r.Message))." -ForegroundColor Yellow
    Write-Host "termhub: termhub is updated and serving; it just isn't being watched. Install it with:" -ForegroundColor Yellow
    Write-Host "termhub:   .\watchdog\install-watchdog.ps1" -ForegroundColor Yellow
  }
  Confirm-WatchdogNotDisabledByFile
}

# The kill switch is a deliberate act, so it is never removed here - but a machine
# that has been silently unwatched since somebody debugged something last month
# should be told.
function Confirm-WatchdogNotDisabledByFile {
  $f = Join-Path (Join-Path (Get-TermhubDataDir) 'watchdog') 'DISABLED'
  if (Test-Path $f) {
    Write-Host "termhub: NOTE - the watchdog kill switch is present, so it is doing nothing:" -ForegroundColor Yellow
    Write-Host "termhub:   $f  (delete it to resume watching)" -ForegroundColor Yellow
  }
}
