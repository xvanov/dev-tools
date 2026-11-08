# Redeploy the personal assistant after the repo was pulled (docs/native/PLAN.md, Z4).
#
# Called by termhub's updater (termhub/windows/update.ps1) so one "Update" brings the
# whole stack to the pulled commit, not just termhub. Safe to run by hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File personal-assistant\windows\redeploy.ps1 [-From <commit>] [-Pull] [-DryRun]
#
# The work is src\supervisor\deploy.js: npm install if the package files changed, then a
# zero-downtime roll through the supervisor (src\supervisor), watched for 60 s and rolled
# back if the new generation is not healthy. This script adds what is Windows-specific:
#
#   1. The pa-worker task runs the supervisor (`node src\supervisor`), not the worker.
#      An older install has `src\worker.js` there; the action is rewritten in place
#      (triggers and settings kept), once - idempotent after that. Not required: a task
#      registered from an elevated shell refuses the rewrite, and `node src\worker.js`
#      not started by the supervisor becomes the supervisor anyway.
#   2. The restart path, kept as the fallback: when no supervisor answers (the first
#      deploy after step 1 - the bootstrap), or the supervisor's own code changed (it
#      cannot roll itself), the task is stopped, its node processes killed, and started
#      again. That restart has the old gap; every deploy after it rolls.
#
# -From: the commit before the pull; nothing under personal-assistant/ changed since it
# means nothing to do. -Pull: pull here first (when not run by termhub's updater).
# -DryRun: say what would happen, change nothing. Never throws: a failure is reported, and
# termhub's own update has already succeeded by the time this runs.
# -Restart: restart the supervisor after the deploy even when a roll would do: what a switch of
# PA_RUNTIME (node | bun, plan 4.1) needs, since the supervisor reads it when it starts.
param([string]$From = '', [switch]$Pull, [switch]$DryRun, [switch]$Restart)

$ErrorActionPreference = 'Continue'
$PaDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Say($m) { Write-Host "stack update: $m" }

function Get-PaPort {
  $port = 7300
  if ($env:PA_DISPATCH_PORT) { return [int]$env:PA_DISPATCH_PORT }
  $envFile = Join-Path $PaDir '.env'
  if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*PA_DISPATCH_PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
  }
  return $port
}

# Step 1. The task runs windows\pa-launch.ps1, which starts the supervisor PA_RUNTIME asks for
# (node src\supervisor, or the compiled jarvisd: plan 4.4). True when the task's action was
# rewritten (the running process is the old one). A task registered from an elevated shell
# refuses the rewrite from a normal one: harmless, `node src\worker.js` started by the task
# becomes the Node supervisor (which runs jarvisd generations when PA_RUNTIME=jarvisd), but only
# the launcher runs the jarvisd supervisor itself - run this once from an elevated shell.
function Confirm-SupervisorTask {
  $task = Get-ScheduledTask -TaskName 'pa-worker' -ErrorAction SilentlyContinue
  if (-not $task) { return $false }
  $action = $task.Actions | Select-Object -First 1
  if ("$($action.Arguments)" -match 'pa-launch\.ps1') { return $false }
  if ($DryRun) { Say "would rewrite the pa-worker task to run windows\pa-launch.ps1 (now: $($action.Arguments))"; return $true }
  $launcher = Join-Path $PaDir 'windows\pa-launch.ps1'
  # Same shape as windows/install.ps1's New-HeadlessAction.
  $new = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launcher`"" -WorkingDirectory $PaDir
  try {
    Set-ScheduledTask -TaskName 'pa-worker' -Action $new -ErrorAction Stop | Out-Null
  } catch {
    Say "pa-worker task left as it is ($($_.Exception.Message.Trim())); run this once from an elevated shell to switch it to windows\pa-launch.ps1."
    return $false
  }
  Say "pa-worker task now runs windows\pa-launch.ps1."
  return $true
}
# Step 2. The old stop/kill/start, for a supervisor or a worker.
function Restart-PaTask([string]$Head) {
  if ($DryRun) { Say "would restart the pa-worker task and wait for $($Head.Substring(0, 7))"; return }
  Say "restarting pa-worker"
  Stop-ScheduledTask -TaskName 'pa-worker' -ErrorAction SilentlyContinue
  # Stop-ScheduledTask ends conhost, not node: the supervisor (`src\supervisor`), its
  # generations and a pre-supervisor worker (`src\worker.js`) are ended here. Not deploy.js.
  # Bun generations (PA_RUNTIME=bun) run jarvisd\src\main.ts in bun.exe: ended too; so are the
  # launcher (powershell running pa-launch.ps1) and a compiled jarvisd (supervise / generation).
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='bun.exe' OR Name='powershell.exe' OR Name LIKE 'jarvisd%'" |
    Where-Object { $_.CommandLine -match 'src[\\/](worker\.js|supervisor)("|\s|$)|jarvisd[\\/]src[\\/]main\.ts|pa-launch\.ps1' -or ($_.Name -like 'jarvisd*' -and "$($_.ExecutablePath)" -like (Join-Path (Split-Path $PaDir -Parent) 'jarvisd\dist\*')) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Start-ScheduledTask -TaskName 'pa-worker'
  $port = Get-PaPort
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    try {
      $v = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/version" -TimeoutSec 2
      if ($v.commit -eq $Head) { Say "pa-worker serving $($Head.Substring(0, 7))."; return }
    } catch { }
  }
  Write-Host "stack update: pa-worker did not report $($Head.Substring(0, 7)) within 120 s - check its log." -ForegroundColor Yellow
}

try {
  $hasTask = [bool](Get-ScheduledTask -TaskName 'pa-worker' -ErrorAction SilentlyContinue)
  $taskChanged = Confirm-SupervisorTask

  $deployArgs = @('src\supervisor\deploy.js')
  if ($From) { $deployArgs += @('--from', $From) }
  if ($Pull) { $deployArgs += '--pull' }
  if ($DryRun) { $deployArgs += '--dry-run' }
  Push-Location $PaDir
  try {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & node @deployArgs 2>&1 | ForEach-Object { Write-Host "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
  } finally { Pop-Location }
  $head = (& git -C $PaDir rev-parse HEAD 2>$null).Trim()

  # 0 done (or nothing to do), 1 failed and rolled back, 3 no supervisor, 4 supervisor changed,
  # 5 refused: another deploy is running.
  if ($code -eq 0 -and -not $taskChanged -and -not $Restart) { return }
  if ($code -eq 5) { Write-Host "stack update: refused - another deploy is running (see above). Nothing changed." -ForegroundColor Yellow; return }
  if ($code -eq 1) { Write-Host "stack update: the deploy did not take; the lines above say which generation serves." -ForegroundColor Yellow; return }
  if (-not $hasTask) { Say "no pa-worker task on this machine - skipping the restart."; return }
  # 3, 4, or the task was just rewritten to the supervisor (the one-time bootstrap).
  Restart-PaTask $head
} catch {
  Write-Host "stack update: $($_.Exception.Message) - continuing." -ForegroundColor Yellow
}
