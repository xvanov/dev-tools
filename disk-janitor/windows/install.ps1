#Requires -Version 5.1
<#
.SYNOPSIS
    Install disk-janitor as a daily hidden Scheduled Task.
.DESCRIPTION
    Registers a per-user Scheduled Task that runs disk_janitor.py once a day
    (and shortly after logon), freeing rebuildable cache/temp space. Re-running
    is safe; the task is overwritten. Pass -DryRun to install a report-only task
    (deletes nothing). Pass -Uninstall to remove it.
.EXAMPLE
    .\install.ps1
    .\install.ps1 -DryRun
    .\install.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$DryRun,
    [string]$Time = "03:00"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'DiskJanitor'
$Script   = Join-Path $PSScriptRoot '..\disk_janitor.py' | Resolve-Path | Select-Object -ExpandProperty Path

if ($Uninstall) {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
        Unregister-ScheduledTask -Confirm:$false
    Write-Host "disk-janitor uninstalled (log kept at ~\.disk-janitor\janitor.log)."
    return
}

# --- locate a console-less python (pythonw) so the task runs invisibly ------
$py = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
if (-not $py) { throw "Python not found on PATH. Install Python 3.9+ first." }
Write-Host "disk-janitor: python  = $py"
Write-Host "disk-janitor: script  = $Script"

$argLine = "`"$Script`""
if ($DryRun) { $argLine += " --dry-run" }

# --- register the task ------------------------------------------------------
$action = New-ScheduledTaskAction -Execute $py -Argument $argLine

# Daily at $Time, plus ~2 min after logon so a freshly-booted box gets swept.
$daily = New-ScheduledTaskTrigger -Daily -At $Time
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT2M'

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger @($daily, $logon) -Settings $settings -Principal $principal -Force | Out-Null

$mode = if ($DryRun) { "DRY-RUN (report only)" } else { "active cleanup" }
Write-Host "Registered scheduled task '$TaskName' - $mode, daily at $Time + logon."
Write-Host ""
Write-Host "Run once now:   python `"$Script`"$(if($DryRun){' --dry-run'})"
Write-Host "Log:            ~\.disk-janitor\janitor.log"
Write-Host "Remove:         .\install.ps1 -Uninstall"
