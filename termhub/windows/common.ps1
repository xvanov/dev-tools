# termhub - shared helpers for start.ps1 / update.ps1 (Windows).
#
# The two-tier layout: a persistent `sessiond` (owns the PTYs) on a loopback port,
# and a swappable `front` (UI + proxy) on one of two loopback ports. Tailscale Serve
# publishes the active front. State + pid files live in the per-user data dir and
# mirror lib/state.js / lib/paths.js so Node and PowerShell agree.

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Get-TermhubDataDir {
  if ($env:TERMHUB_DATA_DIR) { $d = $env:TERMHUB_DATA_DIR }
  else {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
    $d = Join-Path $base 'termhub'
  }
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  return $d
}

function Get-NodePath {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "node not found on PATH. Install Node.js 18+." }
  return $node.Source
}

# state.json -> { sessiondPort, activeFrontPort, publishPort }
function Get-TermhubState {
  $file = Join-Path (Get-TermhubDataDir) 'state.json'
  $state = [ordered]@{ sessiondPort = 7010; activeFrontPort = 7001; publishPort = 7000 }
  if (Test-Path $file) {
    try {
      $j = Get-Content $file -Raw | ConvertFrom-Json
      foreach ($k in @('sessiondPort', 'activeFrontPort', 'publishPort')) {
        if ($null -ne $j.$k) { $state[$k] = [int]$j.$k }
      }
    } catch { }
  }
  return $state
}

function Set-TermhubState {
  param([hashtable]$Patch)
  $state = Get-TermhubState
  foreach ($k in $Patch.Keys) { $state[$k] = $Patch[$k] }
  $file = Join-Path (Get-TermhubDataDir) 'state.json'
  ($state | ConvertTo-Json) | Set-Content -Path $file -Encoding ascii
  return $state
}

# Read a "<name>.pid" file ("PID`nPORT"). Returns @{Pid;Port} or $null.
function Get-PidInfo {
  param([string]$Name)
  $file = Join-Path (Get-TermhubDataDir) "$Name.pid"
  if (-not (Test-Path $file)) { return $null }
  $lines = (Get-Content $file) | Where-Object { $_ -ne '' }
  if ($lines.Count -lt 1) { return $null }
  return @{ Pid = [int]$lines[0]; Port = if ($lines.Count -ge 2) { [int]$lines[1] } else { 0 } }
}

function Remove-PidFile {
  param([string]$Name)
  $file = Join-Path (Get-TermhubDataDir) "$Name.pid"
  Remove-Item $file -Force -ErrorAction SilentlyContinue
}

# Is a recorded pid still a live node.exe? (guards against pid reuse)
function Test-NodeAlive {
  param([int]$ProcId)
  if (-not $ProcId) { return $false }
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  return ($p -and $p.ProcessName -eq 'node')
}

# Launch a termhub tier (node <script>) hidden + detached, with the given env.
# Returns the spawned process. The Node process writes its own pid file.
function Start-TermhubNode {
  param([string]$Script, [hashtable]$EnvVars)
  $node = Get-NodePath
  foreach ($k in $EnvVars.Keys) { Set-Item -Path "Env:$k" -Value "$($EnvVars[$k])" }
  return Start-Process -FilePath $node -ArgumentList $Script -WorkingDirectory $ProjectDir `
    -WindowStyle Hidden -PassThru
}

# Poll http://127.0.0.1:<port>/api/health until it returns ok:true, or timeout.
function Wait-FrontHealthy {
  param([int]$Port, [int]$TimeoutSec = 12)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/health"
      $j = $r.Content | ConvertFrom-Json
      if ($j.ok -eq $true) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

# Poll sessiond's /api/ping until it answers, or timeout.
function Wait-SessiondUp {
  param([int]$Port, [int]$TimeoutSec = 12)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/ping"
      if (($r.Content | ConvertFrom-Json).ok -eq $true) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

# Ensure sessiond is running on $Port; start it if not. Never restarts a live one.
function Confirm-Sessiond {
  param([int]$Port)
  $info = Get-PidInfo 'sessiond'
  if ($info -and (Test-NodeAlive $info.Pid)) {
    Write-Host "termhub: sessiond already running (pid $($info.Pid), port $($info.Port))"
    return $info.Port
  }
  Write-Host "termhub: starting sessiond on 127.0.0.1:$Port ..."
  Start-TermhubNode -Script 'sessiond.js' -EnvVars @{ TERMHUB_SESSIOND_PORT = $Port } | Out-Null
  if (-not (Wait-SessiondUp -Port $Port)) { throw "sessiond did not come up on port $Port" }
  return $Port
}

# Stop a front identified by its pid file name, and clear the file.
function Stop-Front {
  param([string]$Name)
  $info = Get-PidInfo $Name
  if ($info -and (Test-NodeAlive $info.Pid)) {
    try { Stop-Process -Id $info.Pid -Force -ErrorAction Stop } catch { }
  }
  Remove-PidFile $Name
}
