# termhub installer (Windows) — self-contained, self-healing.
#
# Run from PowerShell in the project directory:
#     Set-ExecutionPolicy -Scope Process Bypass
#     .\windows\install.ps1
#
# Exposure model: termhub binds to LOOPBACK and is published on the tailnet via
# **Tailscale Serve** (HTTPS). This is the same mechanism other tailnet services use
# and it works from phones with no Windows Firewall rule — raw ports on the Tailscale
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
& setx TERMHUB_BIND 127.0.0.1 | Out-Null
$env:TERMHUB_BIND = '127.0.0.1'
if ($Port -ne 7000) { & setx TERMHUB_PORT $Port | Out-Null; $env:TERMHUB_PORT = "$Port" }

# --- clean up tasks from the older two-process layout, if present ----------
foreach ($old in @('TermhubAgent', 'TermhubHub')) {
  if (Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue) {
    try { Unregister-ScheduledTask -TaskName $old -Confirm:$false; Write-Host "termhub: removed obsolete task '$old'" } catch {}
  }
}

# Stop any running instance so the new bind/port takes effect.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }

$IsAdmin    = Test-Admin
$StartupVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'termhub.vbs'
# cmd sets the loopback bind for the launch (covers machines without the user env var yet).
$RunLine    = "cmd /c set TERMHUB_BIND=127.0.0.1&& set TERMHUB_PORT=$Port&& node.exe server.js"

# --- auto-start ------------------------------------------------------------
if ($IsAdmin) {
  if (Test-Path $StartupVbs) { Remove-Item $StartupVbs -Force; Write-Host "termhub: removed Startup-folder launcher (using scheduled task)" }
  $action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c set TERMHUB_BIND=127.0.0.1&& set TERMHUB_PORT=$Port&& `"$NodePath`" server.js" -WorkingDirectory $Dir
  $trigger   = New-ScheduledTaskTrigger -AtLogOn
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
  Register-ScheduledTask -TaskName 'Termhub' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'Termhub'
  Write-Host "termhub: registered + started scheduled task 'Termhub'"
}
else {
  # Generate the Startup launcher with an ABSOLUTE project dir baked in. (Resolving
  # the dir relative to the .vbs fails once it's copied into the Startup folder.)
  $vbs = @"
' termhub startup launcher (generated by install.ps1).
' Binds to loopback; Tailscale Serve exposes it at https://<host>:$Port.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$Dir"
sh.Run "$RunLine", 0, False
"@
  Set-Content -Path $StartupVbs -Value $vbs -Encoding ASCII
  Write-Host "termhub: installed Startup-folder launcher -> $StartupVbs"
  & wscript.exe $StartupVbs
  Write-Host "termhub: server started (hidden)"
}

Start-Sleep -Seconds 2

# --- publish on the tailnet via Tailscale Serve ----------------------------
& tailscale serve --bg --https=$Port "http://127.0.0.1:$Port" 2>&1 | Out-Host

# --- done ------------------------------------------------------------------
$dns = ''
try {
  $self = (& tailscale status --json 2>$null | ConvertFrom-Json).Self
  $dns = ($self.DNSName).TrimEnd('.')
} catch {}
Write-Host ""
if ($dns) { Write-Host "Done. Open from any tailnet device (incl. iPhone Safari):  https://${dns}:${Port}/" }
else      { Write-Host "Done. Find the URL with:  tailscale serve status" }
Write-Host "Manage Serve:  tailscale serve status   /   tailscale serve --https=$Port off"
Write-Host "Manage start:  Get-ScheduledTask Termhub   (elevated)   or   $StartupVbs   (non-admin)"
