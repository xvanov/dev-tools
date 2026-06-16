# termhub installer (Windows) — self-contained, self-healing.
#
# Run from PowerShell in the project directory:
#     Set-ExecutionPolicy -Scope Process Bypass
#     .\windows\install.ps1
#
# Works elevated OR not:
#   - Elevated  -> auto-start via a Scheduled Task (at logon, auto-restart on crash)
#                  + Windows Firewall rule (inbound TCP 7000, tailnet-scoped).
#   - Not admin -> auto-start via a hidden launcher in the Startup folder, then
#                  self-elevates JUST the firewall step (one UAC prompt).
#
# Handles the two Windows gotchas that break node-pty's native build:
#   - NoDefaultCurrentDirectoryInExePath=1 (breaks winpty's GetCommitHash.bat)
#   - Spectre-mitigated libs required by newer VS toolsets (passes SpectreMitigation=false)

param(
  [int]$Port = 7000,
  [switch]$FirewallOnly   # internal: used when self-elevating just the firewall rule
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dir       = (Resolve-Path (Join-Path $ScriptDir '..')).Path

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Add-FirewallRule {
  param([int]$Port)
  $name = "Termhub $Port (tailnet)"
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  # Allow inbound only from the Tailscale CGNAT range (100.64.0.0/10), never the open LAN.
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -RemoteAddress 100.64.0.0/10 -Profile Any | Out-Null
  Write-Host "termhub: firewall rule '$name' added (inbound TCP $Port from 100.64.0.0/10)"
}

# --- self-elevation entrypoint: only add the firewall rule, then exit --------
if ($FirewallOnly) { Add-FirewallRule -Port $Port; return }

Write-Host "termhub: project dir = $Dir"

# --- prerequisites ---------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "node not found. Install Node.js 18+ (https://nodejs.org) and re-run." }
$NodePath = $node.Source
Write-Host "termhub: node = $NodePath ($(& $NodePath --version))"

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  Write-Warning "tailscale CLI not found. termhub falls back to loopback unless you set TERMHUB_BIND."
}

# --- JS deps (skip native build here; we build node-pty deterministically) --
Write-Host "termhub: installing npm dependencies..."
Push-Location $Dir
try { & npm install --omit=dev --ignore-scripts --no-audit --no-fund } finally { Pop-Location }

# --- build node-pty native addon (the part that fails on stock Windows) -----
function Find-MSBuild {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $msb = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild `
      -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
    if ($msb) { return $msb }
  }
  $cmd = Get-Command MSBuild.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  Write-Error "MSBuild not found. Install Visual Studio Build Tools with the 'Desktop development with C++' workload."
}

function Build-NodePty {
  $pty = Join-Path $Dir 'node_modules\node-pty'
  $bin = Join-Path $pty 'build\Release\pty.node'
  if (Test-Path $bin) { Write-Host "termhub: node-pty already built"; return }
  Write-Host "termhub: compiling node-pty (node-gyp + MSBuild)..."

  # Gotcha 1: this env var makes cmd refuse to run winpty's GetCommitHash.bat from cwd.
  Remove-Item Env:\NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue

  Push-Location $pty
  try {
    & npx node-gyp configure
    if ($LASTEXITCODE -ne 0) { Write-Error "node-gyp configure failed" }
    $msb = Find-MSBuild
    # Gotcha 2: newer VS toolsets demand Spectre-mitigated libs; disable to avoid MSB8040.
    & $msb (Join-Path $pty 'build\binding.sln') /p:Configuration=Release /p:Platform=x64 `
      /p:SpectreMitigation=false /m /clp:ErrorsOnly /v:m
    if ($LASTEXITCODE -ne 0) { Write-Error "MSBuild failed building node-pty" }
  } finally { Pop-Location }

  if (-not (Test-Path $bin)) { Write-Error "node-pty build produced no pty.node" }
  Write-Host "termhub: node-pty built OK"
}

Build-NodePty

# --- clean up tasks from the older two-process layout, if present ----------
foreach ($old in @('TermhubAgent', 'TermhubHub')) {
  if (Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue) {
    try { Unregister-ScheduledTask -TaskName $old -Confirm:$false; Write-Host "termhub: removed obsolete task '$old'" } catch {}
  }
}

$IsAdmin    = Test-Admin
$StartupVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'termhub.vbs'

# --- auto-start ------------------------------------------------------------
if ($IsAdmin) {
  # Scheduled task is more robust (auto-restart). Remove the Startup-folder
  # launcher if a previous non-admin run installed it, to avoid double-launch.
  if (Test-Path $StartupVbs) { Remove-Item $StartupVbs -Force; Write-Host "termhub: removed Startup-folder launcher (using scheduled task instead)" }

  $action    = New-ScheduledTaskAction -Execute $NodePath -Argument (Join-Path $Dir 'server.js') -WorkingDirectory $Dir
  $trigger   = New-ScheduledTaskTrigger -AtLogOn
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
  Register-ScheduledTask -TaskName 'Termhub' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'Termhub'
  Write-Host "termhub: registered + started scheduled task 'Termhub'"

  Add-FirewallRule -Port $Port
}
else {
  # No admin: scheduled-task registration is denied. Use a hidden Startup-folder
  # launcher (runs at logon, no elevation) and self-elevate only the firewall rule.
  Copy-Item (Join-Path $ScriptDir 'start-termhub.vbs') $StartupVbs -Force
  Write-Host "termhub: installed Startup-folder launcher -> $StartupVbs"

  # Start it now if not already running.
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
             Where-Object { $_.CommandLine -like '*server.js*' }
  if (-not $running) { & wscript.exe $StartupVbs; Write-Host "termhub: server started (hidden)" }
  else { Write-Host "termhub: server already running (pid $($running.ProcessId))" }

  Write-Host "termhub: firewall rule needs admin; requesting elevation (approve the UAC prompt)..."
  try {
    $self = $MyInvocation.MyCommand.Path
    $p = Start-Process powershell -Verb RunAs -PassThru -Wait -ArgumentList `
      '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$self`"",'-FirewallOnly','-Port',"$Port"
    if ($p.ExitCode -eq 0) { Write-Host "termhub: firewall rule added" }
    else { Write-Warning "termhub: firewall step exited $($p.ExitCode). Add it manually (see below)." }
  } catch {
    Write-Warning "termhub: could not elevate for the firewall rule. Run this in an elevated PowerShell:"
    Write-Host "  New-NetFirewallRule -DisplayName 'Termhub $Port (tailnet)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress 100.64.0.0/10 -Profile Any"
  }
}

# --- done ------------------------------------------------------------------
$tsip = (& tailscale ip -4 2>$null | Select-Object -First 1)
Write-Host ""
if ($tsip) { Write-Host "Done. Open from any tailnet device:  http://${tsip}:${Port}" }
else       { Write-Host "Done. No Tailscale IP detected; set TERMHUB_BIND and restart." }
Write-Host "Manage:  Get-ScheduledTask Termhub | Get-ScheduledTaskInfo   (elevated installs)"
Write-Host "         or the launcher at:  $StartupVbs                    (non-admin installs)"
