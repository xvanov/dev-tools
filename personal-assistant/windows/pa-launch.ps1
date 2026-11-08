# Starts the personal assistant's supervisor: what the pa-worker scheduled task runs.
#
# PA_RUNTIME (environment, else personal-assistant\.env, else the repo's .env) picks it:
#   node (default), bun   node src\supervisor (bun: its generations run under Bun)
#   jarvisd               the compiled jarvisd: <jarvisd\dist\current>, else jarvisd\dist\jarvisd.exe,
#                         run as `supervise` - no Node involved (plan 4.4)
# A jarvisd setting with no executable built falls back to Node, saying so, so the dashboard
# still comes up. Switching, or rolling a switch back, is: change PA_RUNTIME, restart the task
# (windows\redeploy.ps1 does that when the running supervisor's runtime differs from the setting).
#
# Read on every start, so a restart after a deploy that built a new jarvisd (and pointed
# jarvisd\dist\current at it) runs the new one. -DryRun prints the command and exits.
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$PaDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Repo = (Resolve-Path (Join-Path $PaDir '..')).Path
if ($env:PA_LAUNCH_ROOT) { $Repo = $env:PA_LAUNCH_ROOT; $PaDir = Join-Path $Repo 'personal-assistant' }

function Get-Setting([string]$Name) {
  $v = [Environment]::GetEnvironmentVariable($Name)
  if ($v) { return $v.Trim() }
  foreach ($f in @((Join-Path $PaDir '.env'), (Join-Path $Repo '.env'))) {
    if (Test-Path $f) {
      $m = Select-String -Path $f -Pattern "^\s*$Name\s*=\s*[`"']?([^`"'#\r\n]*)" | Select-Object -First 1
      if ($m -and $m.Matches[0].Groups[1].Value.Trim()) { return $m.Matches[0].Groups[1].Value.Trim() }
    }
  }
  return ''
}

$runtime = Get-Setting 'PA_RUNTIME'
$cmd = $null
$cmdArgs = @()
if ($runtime -eq 'jarvisd') {
  $dist = Join-Path $Repo 'jarvisd\dist'
  $pointer = Join-Path $dist 'current'
  if (Test-Path $pointer) {
    $name = (Get-Content $pointer -TotalCount 1).Trim()
    if ($name -and (Test-Path (Join-Path $dist $name))) { $cmd = Join-Path $dist $name }
  }
  if (-not $cmd -and (Test-Path (Join-Path $dist 'jarvisd.exe'))) { $cmd = Join-Path $dist 'jarvisd.exe' }
  if ($cmd) { $cmdArgs = @('supervise') }
  else { Write-Host "pa-launch: PA_RUNTIME=jarvisd but no jarvisd executable in $dist (node scripts\build.js --only jarvisd) - starting the Node supervisor instead" }
}
if (-not $cmd) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $cmd = if ($node) { $node.Source } else { 'node' }
  $cmdArgs = @('src\supervisor')
}

if ($DryRun) {
  Write-Output "runtime=$(if ($runtime) { $runtime } else { 'node' }) cwd=$PaDir command=$cmd $($cmdArgs -join ' ')"
  exit 0
}
Set-Location $PaDir
& $cmd @cmdArgs
exit $LASTEXITCODE
