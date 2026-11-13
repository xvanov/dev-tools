# ptyd as a logon task (plan 5.1 / Exit 5): the Windows counterpart of
# linux/ptyd-unit.sh. update.ps1 runs -Ensure; the rest are by hand.
#
#   .\windows\ptyd.ps1 [-Ensure]  ptyd is the only PTY host: build it if its sources are
#                                 newer than the build (cargo), install the build for ptyd's next
#                                 start (lib\ptyHost.js install), register the termhub-ptyd task,
#                                 and start it when nothing answers on the port.
#                                 TERMHUB_PTYD=0 or ptyHost=node-pty is an error (node-pty is gone).
#   .\windows\ptyd.ps1 -Restart   stop ptyd and start the installed copy. ENDS EVERY TERMINAL IN IT.
#   .\windows\ptyd.ps1 -Remove    stop ptyd and unregister the task. ENDS EVERY TERMINAL IN IT.
#                                 Not a rollback: node-pty is gone. Rollback is the previous commit.
#   -DryRun                       print what would happen; change nothing.
#
# -Ensure never restarts a running ptyd: that would end every terminal in it. A new build waits
# in <dataDir>\bin until -Restart (or the next logon).
#
# The task runs this script with -Run (conhost --headless, like the watchdog: an Interactive
# task would otherwise open a console window), which starts the installed copy and waits on it,
# so the task definition never changes when the binary does.
param([switch]$Ensure, [switch]$Restart, [switch]$Remove, [switch]$Run, [switch]$DryRun)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$TaskName = 'termhub-ptyd'
$Port = if ($env:TERMHUB_PTYD_PORT) { [int]$env:TERMHUB_PTYD_PORT } else { 7020 }
$RepoDir = Split-Path $ProjectDir -Parent
$Node = Get-NodePath
$PtyHostJs = Join-Path $ProjectDir 'lib\ptyHost.js'

function Get-PtydPing {
  Get-JsonEndpoint "http://127.0.0.1:$Port/api/ping"
}

function Get-PtydPlan {
  $json = & $Node -e "const h=require(process.argv[1]);const r=h.plan();if(r.error){console.error(r.error);process.exit(2)}process.stdout.write(JSON.stringify({ptyd:r.ptyd,bin:r.bin,reason:r.reason,error:r.error||'',installed:h.installedBinary(),build:h.buildBinary()}))" $PtyHostJs
  if ($LASTEXITCODE -ne 0 -or -not $json) { throw "lib\ptyHost.js did not answer (node-pty was retired; ptyd is required)" }
  return ($json | ConvertFrom-Json)
}

function Get-PtydTask {
  try { return (Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop) } catch { return $null }
}

function Stop-Ptyd {
  $ping = Get-PtydPing
  if (-not $ping -or $ping.entry -ne 'ptyd' -or -not $ping.pid) { return }
  Write-Host "ptyd: stopping pid $($ping.pid) on 127.0.0.1:$Port ($($ping.sessions) terminal(s) end)" -ForegroundColor Yellow
  # The -Run wrapper restarts a ptyd that dies, so it goes first. Stop-ScheduledTask
  # alone ends conhost and leaves the wrapper running.
  if (Get-PtydTask) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'ptyd\.ps1"?\s+-Run' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id ([int]$ping.pid) -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20 -and (Get-PtydPing); $i++) { Start-Sleep -Milliseconds 250 }
}

# A ptyd build is stale when a ptyd source file is newer than it.
function Test-PtydBuildStale {
  param([string]$Build)
  if (-not $Build -or -not (Test-Path $Build)) { return $true }
  $built = (Get-Item $Build).LastWriteTimeUtc
  $src = Get-ChildItem -Recurse -File (Join-Path $RepoDir 'ptyd\src'), (Join-Path $RepoDir 'ptyd\Cargo.toml'), (Join-Path $RepoDir 'ptyd\Cargo.lock') -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -gt $built } | Select-Object -First 1
  return [bool]$src
}

function Register-PtydTask {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $script = Join-Path $PSScriptRoot 'ptyd.ps1'
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Run" `
    -WorkingDirectory $ProjectDir
  # No time limit: it is a server. IgnoreNew: a second logon must not race the first for the port.
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  # Scheduled tasks default to priority 7 (BelowNormal), which ptyd would pass to every terminal's
  # tree. 5 = Normal: ptyd stays responsive; the sessions are held at BelowNormal by ptyd's own job.
  $settings.Priority = 5
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) `
    -Settings $settings -Principal $principal -Force `
    -Description "ptyd, termhub's terminal host (plan 5.1). Restarting it ends its terminals." | Out-Null
  $landed = Get-PtydTask
  if (-not $landed -or -not ((($landed.Actions | ForEach-Object { $_.Arguments }) -join ' ') -match [regex]::Escape($script))) {
    throw "the $TaskName task is not in place after registering it (access denied? an elevated shell registered it before)"
  }
}

if ($Run) {
  # The task's process: start the installed copy and wait. Exits when a ptyd already answers,
  # so a second start (logon, -Ensure) never fights the first for the port.
  $logs = Get-TermhubLogDir
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    if (Get-PtydPing) { exit 0 }
    $bin = (Get-PtydPlan).installed
    if (-not $bin) { Write-Host "ptyd: nothing installed (.\windows\ptyd.ps1 -Ensure)"; exit 1 }
    $p = Start-Process -FilePath $bin -ArgumentList "--port $Port" -WindowStyle Hidden -PassThru -Wait `
      -RedirectStandardOutput (Join-Path $logs 'ptyd.out.log') -RedirectStandardError (Join-Path $logs 'ptyd.err.log')
    if ($p.ExitCode -eq 0) { exit 0 }
    Start-Sleep -Seconds 2
  }
  exit 1
}

if ($Remove) {
  $task = Get-PtydTask
  $ping = Get-PtydPing
  if ($DryRun) {
    Write-Host "ptyd -Remove -DryRun: would $(if ($ping) { "stop pid $($ping.pid) ($($ping.sessions) terminal(s) end) and " })$(if ($task) { "unregister the $TaskName task" } else { 'find no task to unregister' })"
    exit 0
  }
  Stop-Ptyd
  if ($task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "ptyd: $TaskName task removed" }
  exit 0
}

$plan = Get-PtydPlan
if ($Restart) {
  $ping = Get-PtydPing
  $installed = $plan.installed
  if ($DryRun) {
    Write-Host "ptyd -Restart -DryRun: would stop $(if ($ping) { "pid $($ping.pid) ($($ping.sessions) terminal(s) end)" } else { 'nothing (none running)' }) and start $(if ($installed) { $installed } else { 'NOTHING: no installed copy, run -Ensure first' })"
    exit 0
  }
  if (-not $installed) { throw "no installed ptyd: run .\windows\ptyd.ps1 -Ensure first" }
  Stop-Ptyd
  if (Get-PtydTask) { Start-ScheduledTask -TaskName $TaskName } else { throw "no $TaskName task: run .\windows\ptyd.ps1 -Ensure" }
  for ($i = 0; $i -lt 40 -and -not (Get-PtydPing); $i++) { Start-Sleep -Milliseconds 250 }
  $ping = Get-PtydPing
  if (-not $ping) { throw "ptyd did not come back on 127.0.0.1:$Port (see $(Join-Path (Get-TermhubLogDir) 'ptyd.err.log'))" }
  Write-Host "ptyd: restarted (pid $($ping.pid), $(Format-Commit $ping.commit))" -ForegroundColor Green
  exit 0
}

# -Ensure (the default).
if (-not $plan.ptyd) {
  throw "ptyd is required ($($plan.reason)). node-pty was retired; there is no other host."
}
if (Test-PtydBuildStale $plan.build) {
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    if (-not $plan.build -and -not $plan.installed) { throw "ptyd is wanted but there is no build and no cargo to make one (rustup, then .\windows\ptyd.ps1)" }
    Write-Host "ptyd: sources are newer than the build, but cargo is not on PATH; keeping the build there is" -ForegroundColor Yellow
  } elseif ($DryRun) {
    Write-Host "ptyd: would build it (node scripts\build.js --only ptyd)"
  } else {
    Write-Host "ptyd: building (node scripts\build.js --only ptyd) ..."
    & $Node (Join-Path $RepoDir 'scripts\build.js') --only ptyd
    if ($LASTEXITCODE -ne 0) { throw "the ptyd build failed (exit $LASTEXITCODE); the installed copy is unchanged" }
  }
}
$installArgs = @($PtyHostJs, 'install') + $(if ($DryRun) { @('--dry-run') } else { @() })
if ($plan.build -or -not $DryRun) { & $Node @installArgs; if ($LASTEXITCODE -ne 0) { throw "lib\ptyHost.js install failed" } }

$task = Get-PtydTask
if (-not $task) {
  if ($DryRun) { Write-Host "ptyd: would register the $TaskName logon task (conhost --headless ... ptyd.ps1 -Run)" }
  else { Register-PtydTask; Write-Host "ptyd: registered the $TaskName logon task" -ForegroundColor Green }
} elseif ("$($task.State)" -eq 'Disabled') {
  if ($DryRun) { Write-Host "ptyd: would re-enable the $TaskName task" }
  else { Enable-ScheduledTask -TaskName $TaskName | Out-Null; Write-Host "ptyd: re-enabled the $TaskName task" -ForegroundColor Yellow }
}

$ping = Get-PtydPing
if ($ping) {
  Write-Host "ptyd: running (pid $($ping.pid), $(Format-Commit $ping.commit), $($ping.sessions) terminal(s)); not restarted (-Restart picks up a new install, ending its terminals)"
} elseif ($DryRun) {
  Write-Host "ptyd: would start the $TaskName task (127.0.0.1:$Port)"
} else {
  Start-ScheduledTask -TaskName $TaskName
  for ($i = 0; $i -lt 40 -and -not (Get-PtydPing); $i++) { Start-Sleep -Milliseconds 250 }
  $ping = Get-PtydPing
  if (-not $ping) { throw "ptyd did not start on 127.0.0.1:$Port (see $(Join-Path (Get-TermhubLogDir) 'ptyd.err.log'))" }
  Write-Host "ptyd: started (pid $($ping.pid)) on 127.0.0.1:$Port" -ForegroundColor Green
}
