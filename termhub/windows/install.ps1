# termhub installer (Windows) - self-contained, self-healing.
#
# Run from PowerShell in the project directory:
#     Set-ExecutionPolicy -Scope Process Bypass
#     .\windows\install.ps1
#
# Exposure model: termhub binds to LOOPBACK and is published on the tailnet via
# **Tailscale Serve** (HTTPS). This is the same mechanism other tailnet services use
# and it works from phones with no Windows Firewall rule - raw ports on the Tailscale
# interface are blocked by the default-inbound-block firewall and just hang.
#
#   result:  https://<machine>.<tailnet>.ts.net:<port>/
#
# Auto-start:
#   - Elevated  -> Scheduled Task (at logon, auto-restart on crash).
#   - Not admin -> hidden launcher in the Startup folder (runs at logon).
#   Tailscale Serve config is persisted by tailscaled and restored on boot.
#
# Handles the two Windows gotchas that break node-pty's native build:
#   - NoDefaultCurrentDirectoryInExePath=1 (breaks winpty's GetCommitHash.bat)
#   - Spectre-mitigated libs required by newer VS toolsets (passes SpectreMitigation=false)

param(
  [int]$Port = 7000
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dir       = (Resolve-Path (Join-Path $ScriptDir '..')).Path
Write-Host "termhub: project dir = $Dir"

# Shared state/pid helpers (also used by start.ps1 / update.ps1).
. (Join-Path $ScriptDir 'common.ps1')
# The watchdog's scheduled task, so a fresh install is supervised from the start
# rather than only after somebody remembers to run install-watchdog.ps1.
. (Join-Path $ScriptDir '..\watchdog\lib\task.ps1')

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- prerequisites ---------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "node not found. Install Node.js 18+ (https://nodejs.org) and re-run." }
$NodePath = $node.Source
Write-Host "termhub: node = $NodePath ($(& $NodePath --version))"

$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $tailscale) { Write-Error "tailscale CLI not found. Install Tailscale and sign in, then re-run." }

# --- JS deps (skip native build here; we build node-pty deterministically) --
Write-Host "termhub: installing npm dependencies..."
Push-Location $Dir
try { & npm install --omit=dev --ignore-scripts --no-audit --no-fund } finally { Pop-Location }
# npm rewrites the lockfile into the local npm's preferred shape even when nothing
# installed changed, which leaves a fresh clone dirty and blocks its first
# `git pull --ff-only` update. See discard_lock_churn in linux/update.sh.
& git -C $Dir checkout -- package-lock.json 2>&1 | Out-Null

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

# --- bind to loopback (Tailscale Serve proxies to it) ----------------------
# Only the front binds a port; sessiond is always loopback. The front honours
# TERMHUB_BIND, so pin it to loopback - Serve does the tailnet exposure.
& setx TERMHUB_BIND 127.0.0.1 | Out-Null
$env:TERMHUB_BIND = '127.0.0.1'

# Record the published (external) port so start.ps1 / update.ps1 use it, and
# default to SINGLE-PORT mode (front on 127.0.0.1:$Port, Serve publishing the same
# number to it) so one port number is the whole answer - the tailnet URL and
# http://127.0.0.1:$Port are the same server. Switch a machine to the atomic-swap
# layout with `start.ps1 -BlueGreen` (front on 7001/7002). sessiond stays on 7010.
Set-TermhubState @{ publishPort = $Port; activeFrontPort = $Port } | Out-Null

# --- clean up tasks from the older two-process layout, if present ----------
foreach ($old in @('TermhubAgent', 'TermhubHub')) {
  if (Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue) {
    try { Unregister-ScheduledTask -TaskName $old -Confirm:$false; Write-Host "termhub: removed obsolete task '$old'" } catch {}
  }
}

# Stop any running instance (old single server.js OR the new tiers) so the
# fresh build/layout takes effect. start.ps1 below brings everything back up.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.js|sessiond\.js|front\.js' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
foreach ($n in @('sessiond', 'front-7001', 'front-7002', "front-$Port")) { Remove-PidFile $n }

$IsAdmin    = Test-Admin
$StartupVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'termhub.vbs'
$StartPs1   = Join-Path $ScriptDir 'start.ps1'
# Launch the two-tier boot script (starts sessiond + front, publishes via Serve).
$PsArgs     = "-NoProfile -ExecutionPolicy Bypass -File `"$StartPs1`" -PublishPort $Port"

# --- auto-start (at logon) -------------------------------------------------
if ($IsAdmin) {
  if (Test-Path $StartupVbs) { Remove-Item $StartupVbs -Force; Write-Host "termhub: removed Startup-folder launcher (using scheduled task)" }
  $action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $PsArgs -WorkingDirectory $Dir
  $trigger   = New-ScheduledTaskTrigger -AtLogOn
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
  Register-ScheduledTask -TaskName 'Termhub' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "termhub: registered scheduled task 'Termhub' (runs start.ps1 at logon)"
}
else {
  # Generate the Startup launcher with an ABSOLUTE script path baked in. (Resolving
  # relative to the .vbs fails once it's copied into the Startup folder.)
  $vbs = @"
' termhub startup launcher (generated by install.ps1).
' Starts sessiond + front; Tailscale Serve exposes the front at https://<host>:$Port.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$Dir"
sh.Run "powershell.exe $PsArgs", 0, False
"@
  Set-Content -Path $StartupVbs -Value $vbs -Encoding ASCII
  Write-Host "termhub: installed Startup-folder launcher -> $StartupVbs"
}

# --- the watchdog ----------------------------------------------------------
# The Termhub task above starts termhub at LOGON and never again, so a tier that
# dies mid-session stays dead until somebody notices. Register the watchdog here so
# that is never true of a fresh machine.
Write-Host ""
Confirm-WatchdogTask

# --- bring it up now (foreground: starts both tiers + publishes + prints URL) ---
Write-Host ""
& $StartPs1 -PublishPort $Port

# --- done ------------------------------------------------------------------
Write-Host ""
Write-Host "Manage Serve:  tailscale serve status   /   tailscale serve --https=$Port off"
Write-Host "Manage start:  Get-ScheduledTask Termhub   (elevated)   or   $StartupVbs   (non-admin)"
Write-Host "Update safely: .\windows\update.ps1   (run from any termhub terminal - terminals survive)"
Write-Host "Watchdog:      Get-ScheduledTask TermhubWatchdog   /   .\watchdog\watchdog.ps1 -Probe"
