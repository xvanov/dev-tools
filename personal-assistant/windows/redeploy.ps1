# Redeploy the personal assistant after the repo was pulled.
#
# Called by termhub's updater (termhub/windows/update.ps1) so one "Update" brings the
# whole stack to the pulled commit, not just termhub. Safe to run by hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File personal-assistant\windows\redeploy.ps1 [-From <commit>]
#
# -From: the commit before the pull. When given and nothing under personal-assistant/
# changed since it, nothing is restarted. Never throws: a failure here is reported,
# and termhub's own update has already succeeded by the time this runs.
param([string]$From = '')

$ErrorActionPreference = 'Continue'
$PaDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RepoDir = (& git -C $PaDir rev-parse --show-toplevel 2>$null)
function Say($m) { Write-Host "stack update: $m" }

try {
  $head = (& git -C $PaDir rev-parse HEAD 2>$null).Trim()
  $changed = @()
  if ($From) { $changed = @(& git -C $RepoDir diff --name-only $From $head -- personal-assistant 2>$null) }
  if ($From -and $changed.Count -eq 0) { Say "personal-assistant unchanged - no restart needed."; return }

  if (-not $From -or ($changed -match 'personal-assistant/package(-lock)?\.json')) {
    Say "personal-assistant dependencies: npm install"
    Push-Location $PaDir
    try { & npm install --omit=dev --no-audit --no-fund 2>&1 | Out-Host } finally { Pop-Location }
    $null = & git -C $PaDir checkout -- package-lock.json 2>$null
  }

  $task = Get-ScheduledTask -TaskName 'pa-worker' -ErrorAction SilentlyContinue
  if (-not $task) { Say "no pa-worker task on this machine - skipping the restart."; return }

  Say "restarting pa-worker"
  Stop-ScheduledTask -TaskName 'pa-worker' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*src\worker.js*' -or $_.CommandLine -like '*src/worker.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-ScheduledTask -TaskName 'pa-worker'

  $port = 7300
  $envFile = Join-Path $PaDir '.env'
  if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*PA_DISPATCH_PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
  }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $v = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/version" -TimeoutSec 2
      if ($v.commit -eq $head) { Say "pa-worker serving $($head.Substring(0, 7))."; return }
    } catch { }
  }
  Write-Host "stack update: pa-worker did not report $($head.Substring(0, 7)) within 30 s - check its log." -ForegroundColor Yellow
} catch {
  Write-Host "stack update: $($_.Exception.Message) - continuing." -ForegroundColor Yellow
}
