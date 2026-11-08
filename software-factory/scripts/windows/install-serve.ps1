# software-factory: run the factory natively on Windows (no WSL).
#
# Registers one logon task, `factory-serve`, that runs `factory serve`: the
# in-process scheduler that ticks the opted-in apps (serve_tick: true) on an interval and wakes
# within a second of `factory job submit`. It replaces the systemd
# `factory-tick@<app>.timer` units the Linux factory uses (docs/WINDOWS.md).
#
# Idempotent: re-running it re-registers the task with the current settings.
# It does not touch .env or anything secret.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-serve.ps1 [-Start]
#     [-Apps a,b] [-IntervalSeconds 300] [-SkipSync] [-Uninstall]

[CmdletBinding()]
param(
  [switch]$Start,
  [switch]$SkipSync,
  [switch]$Uninstall,
  [string[]]$Apps = @(),
  [int]$IntervalSeconds = 300,
  [string]$TaskName = 'factory-serve'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "removed task $TaskName"
  } else {
    Write-Host "task $TaskName not installed"
  }
  return
}

Write-Host "factory serve install" -ForegroundColor Cyan
Write-Host "  root: $root"

$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
  throw "uv is not on PATH. Install it (https://docs.astral.sh/uv/getting-started/installation/), then re-run."
}

if (-not $SkipSync) {
  Write-Host "==> uv sync --all-extras"
  Push-Location $root
  try {
    # --compile-bytecode: otherwise the first ticks compile thousands of .pyc
    # files (litellm, openai) under real-time AV scanning; measured >10 min of
    # cold start for three parallel ticks on a fresh venv.
    & $uv.Source sync --all-extras --compile-bytecode
    if ($LASTEXITCODE -ne 0) { throw "uv sync failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

$py = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { throw "no venv at $py; run without -SkipSync" }

# Runtime state (story worktrees, agent run dirs, the DB) belongs OUTSIDE the
# repo: an agent working in a worktree under the checkout could reach the live
# code the stacks run from. Moving it is the operator's step, never this
# script's: stop serve, run `factory state migrate` (docs/WINDOWS.md), re-run this.
if (-not (Test-Path (Join-Path $root '.state-dir'))) {
  Write-Warning ("the factory state is still in the repo ($root\state). With serve stopped, run " +
    "'uv run factory state migrate' there, then re-run this script (docs/WINDOWS.md).")
}

# -X utf8: UTF-8 mode, as on Linux (serve also passes PYTHONUTF8=1 to its children).
# --supervise: Task Scheduler does not restart a program that exits non-zero, and
# serve exits 75 when the checkout moves (new code); the supervisor restarts it.
# A relative --log-file is under the state dir (wherever .state-dir points).
$serveArgs = @('-X', 'utf8', '-m', 'factory', 'serve', '--supervise', '--interval', "$IntervalSeconds", '--log-file', 'logs\serve.log')
foreach ($a in $Apps) { $serveArgs += @('--app', $a) }

# A console program from an Interactive logon task gets a visible console
# window, and closing it kills the task. `conhost --headless` runs it on a
# windowless pseudoconsole (same as the personal assistant's tasks).
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
  -Argument ("--headless `"$py`" " + ($serveArgs -join ' ')) -WorkingDirectory $root
# At logon, as this user: claude_session runs need the user's Claude Code login
# and termhub, and the factory's git/gh credentials are the user's.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'software-factory: factory serve (ticks the serve_tick apps; replaces the systemd timers)' `
  -Force | Out-Null
Write-Host "==> registered task $TaskName"

if ($Start) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  & $py -m factory serve --status
} else {
  Write-Host "    not started (-Start, or: Start-ScheduledTask $TaskName)"
}
