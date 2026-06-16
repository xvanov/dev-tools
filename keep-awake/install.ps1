#Requires -Version 5.1
<#
.SYNOPSIS
    Install KeepAwake to run hidden at logon.
.DESCRIPTION
    Copies KeepAwake.ps1 to ~/.keep-awake/ and registers a per-user scheduled
    task that launches it (hidden window) at logon. Re-running is safe; the
    task is overwritten. Pass -Uninstall to remove the task and the copy.
#>

[CmdletBinding()]
param([switch]$Uninstall)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName  = 'KeepAwake'
$InstallDir = Join-Path $env:USERPROFILE '.keep-awake'
$ScriptSrc  = Join-Path $PSScriptRoot 'KeepAwake.ps1'
$ScriptDest = Join-Path $InstallDir 'KeepAwake.ps1'

if ($Uninstall) {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
        Unregister-ScheduledTask -Confirm:$false
    Get-Process powershell -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.CommandLine -match 'KeepAwake.ps1') } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
    Write-Host "KeepAwake uninstalled."
    return
}

# --- copy script ---
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path $ScriptSrc -Destination $ScriptDest -Force
Write-Host "Copied KeepAwake.ps1 -> $ScriptDest"

# --- register logon task (hidden, no console window) ---
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptDest`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit 0
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName' (runs hidden at logon)."

# --- start now so you don't have to log out first ---
Start-ScheduledTask -TaskName $TaskName
Write-Host ""
Write-Host "Done. KeepAwake is running now and will auto-start at every logon."
Write-Host "Stop/remove with: .\install.ps1 -Uninstall"
