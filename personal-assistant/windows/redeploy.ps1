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
#      (triggers and settings kept), once - idempotent after that.
#   2. The restart path, kept as the fallback: when no supervisor answers (the first
#      deploy after step 1 - the bootstrap), or the supervisor's own code changed (it
#      cannot roll itself), the task is stopped, its node processes killed, and started
#      again. That restart has the old gap; every deploy after it rolls.
#
# -From: the commit before the pull; nothing under personal-assistant/ changed since it
# means nothing to do. -Pull: pull here first (when not run by termhub's updater).
# -DryRun: say what would happen, change nothing. Never throws: a failure is reported, and
# termhub's own update has already succeeded by the time this runs.
param([string]$From = '', [switch]$Pull, [switch]$DryRun)

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

# Step 1. True when the task's action was rewritten (the running process is the old one).
function Confirm-SupervisorTask {
  $task = Get-ScheduledTask -TaskName 'pa-worker' -ErrorAction SilentlyContinue
  if (-not $task) { return $false }
  $action = $task.Actions | Select-Object -First 1
  if ("$($action.Arguments)" -match 'src[\\/]supervisor') { return $false }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Say "node not on PATH - cannot rewrite the pa-worker task."; return $false }
  if ($DryRun) { Say "would rewrite the pa-worker task to run the supervisor (now: $($action.Arguments))"; return $true }
  # Same shape as windows/install.ps1's New-HeadlessAction.
  $new = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless `"$node`" src\supervisor" -WorkingDirectory $PaDir
  Set-ScheduledTask -TaskName 'pa-worker' -Action $new | Out-Null
  Say "pa-worker task now runs the supervisor (node src\supervisor)."
  return $true
}

# Step 2. The old stop/kill/start, for a supervisor or a worker.
function Restart-PaTask([string]$Head) {
  if ($DryRun) { Say "would restart the pa-worker task and wait for $($Head.Substring(0, 7))"; return }
  Say "restarting pa-worker"
  Stop-ScheduledTask -TaskName 'pa-worker' -ErrorAction SilentlyContinue
  # Stop-ScheduledTask ends conhost, not node: the supervisor (`src\supervisor`), its
  # generations and a pre-supervisor worker (`src\worker.js`) are ended here. Not deploy.js.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src[\\/](worker\.js|supervisor)("|\s|$)' } |
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

  # 0 done (or nothing to do), 1 failed and rolled back, 3 no supervisor, 4 supervisor changed.
  if ($code -eq 0 -and -not $taskChanged) { return }
  if ($code -eq 1) { Write-Host "stack update: the deploy did not take (see above); the previous generation is serving." -ForegroundColor Yellow; return }
  if (-not $hasTask) { Say "no pa-worker task on this machine - skipping the restart."; return }
  # 3, 4, or the task was just rewritten to the supervisor (the one-time bootstrap).
  Restart-PaTask $head
} catch {
  Write-Host "stack update: $($_.Exception.Message) - continuing." -ForegroundColor Yellow
}
