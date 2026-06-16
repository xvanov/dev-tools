# termhub installer (Windows) — installs the single termhub server as a
# scheduled task that starts at logon.
#
# Run from an elevated PowerShell in the project directory:
#     Set-ExecutionPolicy -Scope Process Bypass
#     .\windows\install.ps1

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dir       = (Resolve-Path (Join-Path $ScriptDir '..')).Path
Write-Host "termhub: project dir = $Dir"

# --- prerequisites ---------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Write-Error "node not found. Install Node.js 18+ (https://nodejs.org) and re-run."
}
$NodePath = $node.Source
Write-Host "termhub: node = $NodePath ($(& $NodePath --version))"

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  Write-Warning "tailscale CLI not found. termhub falls back to loopback unless you set TERMHUB_BIND."
}

# --- dependencies (builds node-pty; needs VS Build Tools C++ workload) ------
Write-Host "termhub: installing npm dependencies (this compiles node-pty)..."
Push-Location $Dir
try { & npm install --omit=dev --no-audit --no-fund } finally { Pop-Location }

# --- clean up tasks from the older two-process layout, if present ----------
foreach ($old in @('TermhubAgent', 'TermhubHub')) {
  if (Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $old -Confirm:$false
    Write-Host "termhub: removed obsolete scheduled task '$old'"
  }
}

# --- scheduled task --------------------------------------------------------
$action   = New-ScheduledTaskAction -Execute $NodePath -Argument (Join-Path $Dir 'server.js') -WorkingDirectory $Dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName 'Termhub' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'Termhub'
Write-Host "termhub: registered and started scheduled task 'Termhub'"

$tsip = (& tailscale ip -4 2>$null | Select-Object -First 1)
Write-Host ""
Write-Host "Done. Manage in Task Scheduler (Termhub) or:  Get-ScheduledTask Termhub | Get-ScheduledTaskInfo"
if ($tsip) { Write-Host "Open in a browser:  http://${tsip}:7000" }
Write-Host "To set env overrides (port/bind/name), set a user env var and restart the task, e.g.:"
Write-Host "  setx TERMHUB_BIND 100.x.y.z"
