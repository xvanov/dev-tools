# personal-assistant — Windows install.
#
# Registers two logon tasks and applies the schema. It does not ask for anything
# secret: credentials go in .env, and `pa doctor` tells you which are missing.
#
# The keep-alive task is not optional and is the least obvious part of this
# setup. WSL terminates a distro once the last wsl.exe client exits — systemd
# running Postgres inside it is not enough to hold it open — so without a
# process keeping a handle on the distro, connections from Windows fail with
# ECONNREFUSED at unpredictable intervals. One `sleep infinity` fixes it.

[CmdletBinding()]
param(
  [string]$Distro = 'Ubuntu',
  [switch]$SkipDatabase,
  [switch]$NoWorker
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$node = (Get-Command node).Source

Write-Host "personal-assistant install" -ForegroundColor Cyan
Write-Host "  root: $root"

# --- dependencies ------------------------------------------------------------

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host "==> npm install"
  Push-Location $root
  npm install --no-audit --no-fund
  Pop-Location
}

# --- the store ---------------------------------------------------------------

if (-not $SkipDatabase) {
  Write-Host "==> provisioning Postgres inside WSL ($Distro)"
  # C:\repos\... -> /mnt/c/repos/..., which is how the distro sees this file.
  $drive = $here.Substring(0, 1).ToLower()
  $rest = $here.Substring(2) -replace '\\', '/'
  $script = "/mnt/$drive$rest/setup-wsl-postgres.sh"
  wsl -d $Distro -u root -e sh $script
  if ($LASTEXITCODE -ne 0) { throw "WSL setup failed with exit code $LASTEXITCODE" }
}

# --- keep the distro alive ---------------------------------------------------

Write-Host "==> registering the WSL keep-alive task"
$keepAliveArgs = "-d $Distro -u root --exec /bin/sh -c `"exec sleep infinity`""
$keepAction = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument $keepAliveArgs
$keepTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$keepSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'pa-wsl-keepalive' -Action $keepAction -Trigger $keepTrigger `
  -Settings $keepSettings -Description 'Holds the WSL distro open so the personal-assistant Postgres stays reachable' `
  -Force | Out-Null

# Start it now rather than waiting for the next logon.
Start-ScheduledTask -TaskName 'pa-wsl-keepalive'
Start-Sleep -Seconds 4

# --- schema ------------------------------------------------------------------

Write-Host "==> applying migrations"
Push-Location $root
& $node 'src/db/migrate.js'
Pop-Location

# --- the worker --------------------------------------------------------------

if (-not $NoWorker) {
  Write-Host "==> registering the worker task"
  $workerAction = New-ScheduledTaskAction -Execute $node -Argument 'src\worker.js' -WorkingDirectory $root
  $workerTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $workerSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2)
  Register-ScheduledTask -TaskName 'pa-worker' -Action $workerAction -Trigger $workerTrigger `
    -Settings $workerSettings -Description 'personal-assistant ingest, distillation and run reconciliation' `
    -Force | Out-Null
  Write-Host "    registered (not started — start it once .env is filled in)"
}

# --- .env --------------------------------------------------------------------

$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root '.env.example') $envFile
  Write-Host "==> wrote .env from .env.example — fill it in" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1. Fill in $envFile  (see .env.example for what each value is)"
Write-Host "  2. node bin\pa.js login          sign in to Microsoft (device code)"
Write-Host "  3. node bin\pa.js projects sync   seed the project table"
Write-Host "  4. node bin\pa.js doctor          confirm everything is wired"
Write-Host "  5. Start-ScheduledTask pa-worker  start ingesting"
