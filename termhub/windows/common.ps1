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

# ---- tier logs --------------------------------------------------------------
# Where a tier's stdout/stderr goes.
#
# This exists because of a real outage with no evidence. Start-TermhubNode used to
# launch both tiers `-WindowStyle Hidden` with NO redirection, so a front that died
# left nothing behind at all: node exits *normally* on an uncaught exception, so
# there is no WER crash dump; nothing reaches the event log; and the data dir holds
# only a pid file naming a process that no longer exists. The only honest answer to
# "why did the front go down?" was "that is not recorded anywhere" - which is also
# the only thing the watchdog's LLM escalation would have had to work from.
#
# Deliberately plain files rather than a rotating logger: the reader is a human (or
# an agent) asking "what did it say before it died", and the two files a tier can
# write are already the whole answer.
function Get-TermhubLogDir {
  $d = Join-Path (Get-TermhubDataDir) 'logs'
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  return $d
}

# Log basename for a tier, matching the pid-file naming so the two line up:
# front.js + TERMHUB_FRONT_PORT=7000 -> 'front-7000', sessiond.js -> 'sessiond'.
function Get-TierLogName {
  param([string]$Script, [hashtable]$EnvVars)
  $base = [IO.Path]::GetFileNameWithoutExtension($Script)
  if ($EnvVars -and $EnvVars['TERMHUB_FRONT_PORT']) { return "$base-$($EnvVars['TERMHUB_FRONT_PORT'])" }
  return $base
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

# Is Tailscale Serve publishing <port>?
#
# This exists because state.json records TWO different layouts identically - both
# leave activeFrontPort == publishPort:
#   single-port (start.ps1)   - front on 127.0.0.1:<port>, Serve proxies the same
#                               number to it from the tailnet IP.
#   plain HTTP  (start-http.ps1) - Serve is turned OFF for the port and the front
#                               binds the tailnet IP itself.
# Serve's own config is the only thing that tells them apart, so anything that has
# to re-bind a front must ask it rather than infer from the port numbers.
#
# Returns $true / $false, or $null when Serve could not be consulted at all
# (no tailscale on PATH, command failed, unparseable output). $null is NOT folded
# into $false on purpose: a failed probe answered as "not published" would send a
# single-port machine down the plain-HTTP path and straight into tailscaled, which
# already holds that port.
function Test-ServePublished {
  param([int]$Port)
  try {
    $raw = (& tailscale serve status --json 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not $raw.Trim()) { return $null }
    $j = $raw | ConvertFrom-Json
    if (-not $j) { return $null }
    if (-not $j.TCP) { return $false }
    return ($j.TCP.PSObject.Properties.Name -contains "$Port")
  } catch { return $null }
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

# Remove a pid file only when it names $ProcId, or names a process that is gone.
# The scripts kill things by PORT, and the pid file for a tier is not guaranteed
# to describe the process that happened to be holding that port - so clearing it
# unconditionally can erase a healthy tier's record, which is the failure this
# change exists to eliminate (lib/state.js removeOwnPidFile is the Node half).
function Remove-OwnedPidFile {
  param([string]$Name, [int]$ProcId)
  $info = Get-PidInfo $Name
  if (-not $info) { return }
  if ($info.Pid -eq $ProcId -or -not (Test-NodeAlive $info.Pid)) { Remove-PidFile $Name }
  else { Write-Host "termhub: keeping $Name.pid (pid $($info.Pid) is still alive and wasn't the one stopped)." }
}

# Record a pid file on a process's behalf. Used to REPAIR bookkeeping: a live
# sessiond found by port probe but missing its pid file (an older build claimed
# the file before binding, so a duplicate that lost the bind deleted the
# incumbent's on its way out) is still the real supervisor, and the stop/reuse
# paths need to be able to find it. Format matches lib/state.js.
function Set-PidFile {
  param([string]$Name, [int]$ProcId, [int]$Port)
  $file = Join-Path (Get-TermhubDataDir) "$Name.pid"
  "$ProcId`n$Port" | Set-Content -Path $file -Encoding ascii
}

# The 'Termhub' scheduled task is supposed to launch windows\start.ps1 (which
# brings up both tiers). install.ps1 registers it that way - but a machine
# installed BEFORE the sessiond/front split has a task that still runs
# `node server.js`, and nothing since then re-registered it. That task recreates
# the single-process squatter at every logon, so reclaiming the publish port
# during an update fixes the symptom while the cause returns on the next reboot.
# Detect it and say so. Never rewrite the task here: that needs elevation and is
# install.ps1's job, and silently re-registering a user's startup entry from a
# routine update is not this script's call to make.
function Test-TermhubTask {
  $task = $null
  try { $task = Get-ScheduledTask -TaskName 'Termhub' -ErrorAction Stop } catch { return }
  $action = (($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ').Trim()
  if (-not $action -or $action -match 'start\.ps1') { return }
  Write-Host ""
  Write-Host "termhub: WARNING - the 'Termhub' logon task does not run start.ps1:" -ForegroundColor Yellow
  Write-Host "termhub:   $action" -ForegroundColor Yellow
  Write-Host "termhub: that's the pre-split single-process entrypoint. It shadows sessiond, and it" -ForegroundColor Yellow
  Write-Host "termhub: will come back at the next logon. Fixing it needs ELEVATION - registering a" -ForegroundColor Yellow
  Write-Host "termhub: scheduled task is an admin operation, so a non-elevated install.ps1 skips it" -ForegroundColor Yellow
  Write-Host "termhub: (it installs the Startup-folder launcher instead and leaves this task alone)." -ForegroundColor Yellow
  Write-Host "termhub: From an ADMIN PowerShell, either re-register it:" -ForegroundColor Yellow
  Write-Host "termhub:   powershell -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'install.ps1')`"" -ForegroundColor Yellow
  Write-Host "termhub: or delete it and let the Startup launcher do the work:" -ForegroundColor Yellow
  Write-Host "termhub:   Unregister-ScheduledTask -TaskName Termhub -Confirm:`$false" -ForegroundColor Yellow
  Write-Host ""
}

# ---- ports: who is actually holding one ------------------------------------
# A pid file is a hint (it goes stale, and pids get reused). A bound socket is
# the truth, so every "is it already running?" decision below starts here.

function Get-PortListenerPid {
  param([int]$Port, [string]$Address = '127.0.0.1')
  try {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
      Where-Object { $_.LocalAddress -eq $Address } | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch {
    # Get-NetTCPConnection missing (older SKU / restricted host) - use netstat.
    $pattern = "^\s+TCP\s+$([regex]::Escape($Address)):$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    $line = (& netstat -ano) | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if ($line -and $line -match 'LISTENING\s+(\d+)\s*$') { return [int]$Matches[1] }
  }
  return 0
}

function Get-ProcessNameFor {
  param([int]$ProcId)
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($p) { return $p.ProcessName }
  return ''
}

# GET a JSON endpoint, or $null for anything that isn't a 200 with a JSON body.
function Get-JsonEndpoint {
  param([string]$Url, [int]$TimeoutSec = 3)
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec $Url
    if ($r.StatusCode -ne 200) { return $null }
    return ($r.Content | ConvertFrom-Json)
  } catch { return $null }
}

# sessiond's /api/ping identity block: entry ('sessiond' | 'server'), pid,
# commit, sessions. $null when nothing answers.
function Get-SessiondIdentity {
  param([int]$Port)
  return (Get-JsonEndpoint "http://127.0.0.1:$Port/api/ping")
}

function Format-Commit {
  param($Commit, $Dirty = $false)
  if (-not $Commit) { return 'unknown commit' }
  $short = ([string]$Commit).Substring(0, [Math]::Min(7, ([string]$Commit).Length))
  if ($Dirty -eq $true) { return "$short-dirty" }
  return $short
}

# Kill the node process holding $Port and wait for the socket to be released.
# Refuses to touch a non-node process: an unrecognised listener is far more
# likely to be something else on the machine than a termhub tier, and killing
# it would be a much worse bug than the one being cleaned up.
function Clear-PortSquatter {
  param([int]$Port, [string]$Why = '')
  $procId = Get-PortListenerPid -Port $Port
  if (-not $procId) { return $true }
  $name = Get-ProcessNameFor $procId
  if ($name -ne 'node') {
    Write-Host "termhub: 127.0.0.1:$Port held by '$name' (pid $procId) - not a termhub process, leaving it alone." -ForegroundColor Yellow
    return $false
  }
  $suffix = if ($Why) { " - $Why" } else { '' }
  Write-Host "termhub: stopping node pid $procId on 127.0.0.1:$Port$suffix" -ForegroundColor Yellow
  try { Stop-Process -Id $procId -Force -ErrorAction Stop }
  catch {
    Write-Host "termhub: could not stop pid $procId ($($_.Exception.Message))" -ForegroundColor Yellow
    return $false
  }
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-PortListenerPid -Port $Port)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  Write-Host "termhub: pid $procId is gone but 127.0.0.1:$Port is still bound." -ForegroundColor Yellow
  return $false
}

# Remove a process that is squatting the publish port, keeping the one that is
# supposed to be there.
#
# Who is allowed to hold 127.0.0.1:$PublishPort depends on the mode:
#   single-port  (activeFrontPort == publishPort) - the FRONT lives there, and
#                Tailscale Serve proxies :$PublishPort -> 127.0.0.1:$PublishPort.
#   blue/green   (activeFrontPort in 7001/7002)   - NOTHING should hold it; Serve
#                terminates the port and proxies to the front's own loopback port.
# So the decision is made on IDENTITY rather than on the mode alone: a front is
# left alone in either mode, and a `node server.js` monolith is removed in either
# mode. It's the monolith that made http://127.0.0.1:<publishPort> serve OLDER
# code than the tailnet URL for the same port, while also shadowing sessiond.
function Clear-PublishPort {
  param([int]$PublishPort, [int]$SessiondPort, [int]$ActiveFrontPort = 0)
  $procId = Get-PortListenerPid -Port $PublishPort
  if (-not $procId) { return }

  # Never touch a process a front pid file vouches for.
  foreach ($p in @(7001, 7002, $PublishPort)) {
    $f = Get-PidInfo "front-$p"
    if ($f -and $f.Pid -eq $procId) { return }
  }

  # ...nor one that identifies itself as a front (pid file lost, still the front).
  $health = Get-JsonEndpoint "http://127.0.0.1:$PublishPort/api/health"
  if ($health -and $health.self -and $health.self.entry -eq 'front') {
    Write-Host "termhub: 127.0.0.1:$PublishPort is a front (pid $($health.self.pid)) - leaving it alone."
    if ($ActiveFrontPort -eq $PublishPort -and $health.self.pid) {
      Set-PidFile -Name "front-$PublishPort" -ProcId ([int]$health.self.pid) -Port $PublishPort
    }
    return
  }

  $alsoSessiond = ((Get-PortListenerPid -Port $SessiondPort) -eq $procId)
  Write-Host ""
  Write-Host "termhub: 127.0.0.1:$PublishPort is bound by pid $procId, which is not a termhub front." -ForegroundColor Yellow
  Write-Host "termhub: that's the pre-split single-process entrypoint serving old code on the" -ForegroundColor Yellow
  Write-Host "termhub: publish port." -ForegroundColor Yellow
  if ($alsoSessiond) {
    Write-Host "termhub: it ALSO holds sessiond port $SessiondPort, so it owns the live terminals." -ForegroundColor Yellow
    Write-Host "termhub: stopping it ends those PTYs - they reappear in the sidebar as Restorable." -ForegroundColor Yellow
  }
  if (Clear-PortSquatter -Port $PublishPort -Why 'stale single-process termhub on the publish port') {
    # Clear the sessiond record only if it named the process just stopped. Deleting
    # a pid file that belongs to someone else is the exact bug this whole change is
    # about (see removeOwnPidFile in lib/state.js) - don't reintroduce it here.
    if ($alsoSessiond) { Remove-OwnedPidFile -Name 'sessiond' -ProcId $procId }
  }
  Write-Host ""
}

# Is a recorded pid still a live node.exe? (guards against pid reuse)
function Test-NodeAlive {
  param([int]$ProcId)
  if (-not $ProcId) { return $false }
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  return ($p -and $p.ProcessName -eq 'node')
}

# Launch a termhub tier (node <script>) hidden + detached, with the given env.
# Returns the spawned process. The Node process writes its own pid file, and only
# after it wins the port bind - so callers must verify it actually came up rather
# than assuming the port answering means their child is the one answering.
#
# The env vars are restored afterwards: they only exist to be inherited by the
# child, and leaving them set leaked one tier's port into the next launch from
# the same script (TERMHUB_FRONT_PORT surviving into a sessiond spawn).
#
# stdout/stderr go to <data dir>\logs\<tier>.{out,err}.log - see Get-TermhubLogDir
# for why that is not optional.
function Start-TermhubNode {
  param([string]$Script, [hashtable]$EnvVars)
  $node = Get-NodePath
  $saved = @{}
  foreach ($k in $EnvVars.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k)
    Set-Item -Path "Env:$k" -Value "$($EnvVars[$k])"
  }
  try {
    $logBase = Join-Path (Get-TermhubLogDir) (Get-TierLogName -Script $Script -EnvVars $EnvVars)
    $outLog = "$logBase.out.log"
    $errLog = "$logBase.err.log"
    # Keep exactly one previous generation. This is the whole point of rotating
    # here rather than appending: when a dead front is relaunched, the file about
    # to be truncated holds the last words of the process that just died, and the
    # relaunch is usually the moment somebody starts looking for them.
    foreach ($f in @($outLog, $errLog)) {
      if (Test-Path $f) {
        Move-Item -LiteralPath $f -Destination ($f -replace '\.log$', '.prev.log') -Force -ErrorAction SilentlyContinue
      }
    }
    try {
      $proc = Start-Process -FilePath $node -ArgumentList $Script -WorkingDirectory $ProjectDir `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
      # Touching .Handle caches it while the process is still alive, which is what
      # makes .ExitCode readable AFTER it exits. Without this, Start-Process
      # -PassThru (no -Wait) yields an object whose ExitCode reads as $null, and
      # Start-VerifiedFront's "the front exited with code ..." diagnostic - printed
      # on exactly the failure it exists to explain - came out blank.
      try { $null = $proc.Handle } catch { }
      return $proc
    } catch {
      # Logging is diagnostics, never a precondition for serving. A log file locked
      # by a tier that hasn't fully exited, or an unwritable data dir, must not be
      # the reason the machine is left with no front.
      Write-Host "termhub: could not redirect $Script output to $logBase.*.log ($($_.Exception.Message)) - starting without logs." -ForegroundColor Yellow
      $proc = Start-Process -FilePath $node -ArgumentList $Script -WorkingDirectory $ProjectDir `
        -WindowStyle Hidden -PassThru
      try { $null = $proc.Handle } catch { }
      return $proc
    }
  } finally {
    foreach ($k in $EnvVars.Keys) {
      if ($null -eq $saved[$k]) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
      else { Set-Item -Path "Env:$k" -Value $saved[$k] }
    }
  }
}

# Poll http://<address>:<port>/api/health until it returns ok:true, or timeout.
function Wait-FrontHealthy {
  param([int]$Port, [int]$TimeoutSec = 12, [string]$Address = '127.0.0.1')
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://${Address}:$Port/api/health"
      $j = $r.Content | ConvertFrom-Json
      if ($j.ok -eq $true) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

# Start a front on $Port and PROVE it: healthy, reaching sessiond, serving the
# proxied and static routes, and - the checks a plain health poll can't make - that
# the process answering is the one just spawned, running $ExpectCommit. A stale
# process that happened to own the port passes every other test.
#
# Returns the process object, or $null after cleaning up what it started. Used by
# both update paths so single-port and blue/green deploys are held to identical
# standards.
function Start-VerifiedFront {
  param(
    [int]$Port,
    [int]$SessiondPort,
    [string]$Bind = '127.0.0.1',
    [string]$ExpectCommit = '',
    [int]$TimeoutSec = 12
  )
  if (-not (Clear-PortSquatter -Port $Port -Why 'unrecorded process on the front port')) {
    Write-Host "termhub: front port $Port is occupied and could not be freed." -ForegroundColor Yellow
    return $null
  }

  Write-Host "termhub: starting front on ${Bind}:$Port -> sessiond 127.0.0.1:$SessiondPort ..."
  $proc = Start-TermhubNode -Script 'front.js' -EnvVars @{
    TERMHUB_FRONT_PORT    = $Port
    TERMHUB_SESSIOND_PORT = $SessiondPort
    TERMHUB_BIND          = $Bind
  }
  $probe = if ($Bind -eq '0.0.0.0') { '127.0.0.1' } else { $Bind }

  $ok = Wait-FrontHealthy -Port $Port -TimeoutSec $TimeoutSec -Address $probe
  if (-not $ok -and $proc -and $proc.HasExited) {
    Write-Host "termhub: the front exited with code $($proc.ExitCode) (run 'node front.js' to see why)." -ForegroundColor Yellow
  }
  if ($ok) {
    foreach ($route in @('/api/sessions', '/')) {
      try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 "http://${probe}:$Port$route"
        if ($r.StatusCode -ne 200) { Write-Host "termhub: $route -> $($r.StatusCode)" -ForegroundColor Yellow; $ok = $false }
      } catch { Write-Host "termhub: $route failed ($($_.Exception.Message))" -ForegroundColor Yellow; $ok = $false }
    }
  }
  if ($ok) {
    $ident = Get-JsonEndpoint "http://${probe}:$Port/api/health"
    if (-not $ident -or -not $ident.self) {
      Write-Host "termhub: the front did not report its identity on /api/health." -ForegroundColor Yellow
      $ok = $false
    } elseif ($proc -and $ident.self.pid -and ([int]$ident.self.pid -ne $proc.Id)) {
      Write-Host "termhub: port $Port answered by pid $($ident.self.pid), not the front just started (pid $($proc.Id))." -ForegroundColor Yellow
      $ok = $false
    } elseif ($ExpectCommit -and $ident.self.commit -and $ident.self.commit -ne $ExpectCommit) {
      Write-Host "termhub: the front runs $(Format-Commit $ident.self.commit $ident.self.dirty), expected $(Format-Commit $ExpectCommit)." -ForegroundColor Yellow
      $ok = $false
    }
  }

  if (-not $ok) { Stop-Front "front-$Port"; return $null }
  return $proc
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

# Ensure a REAL sessiond is running on $Port; start it if not. Never restarts a
# live one - it owns the PTYs.
#
# This used to decide by pid file, then treat "something answered /api/ping" as
# proof of success, and both halves could lie:
#   - the pid file was absent because a duplicate that lost the port bind deleted
#     the incumbent's file on its way out, so a healthy sessiond looked stopped;
#   - the thing answering the probe was a `node server.js` (dev monolith, which
#     serves a sessiond on the same port), so an update declared sessiond healthy
#     while the sessiond it launched had already died on EADDRINUSE - and then
#     deployed a new front against a stale supervisor.
# So: identify the answerer, and after starting one, confirm the pid replying is
# the pid we spawned.
function Confirm-Sessiond {
  param([int]$Port, [int]$PublishPort = 0)

  $ident = Get-SessiondIdentity -Port $Port
  if ($ident) {
    $isMonolith = ($ident.entry -eq 'server')
    if (-not $isMonolith -and -not $ident.entry -and $PublishPort) {
      # Pre-identity build: no `entry` field to read. Discriminate the way the
      # monolith gives itself away anyway - ONE process holding both the sessiond
      # port and the publish port.
      $sPid = Get-PortListenerPid -Port $Port
      $isMonolith = ($sPid -and $sPid -eq (Get-PortListenerPid -Port $PublishPort))
    }

    if (-not $isMonolith) {
      $livePid = if ($ident.pid) { [int]$ident.pid } else { Get-PortListenerPid -Port $Port }
      Write-Host ("termhub: sessiond already running (pid $livePid, port $Port, " `
        + "$(Format-Commit $ident.commit $ident.dirty), $($ident.sessions) session(s))")
      # Repair bookkeeping if the pid file is missing or points elsewhere.
      $info = Get-PidInfo 'sessiond'
      if ($livePid -and (-not $info -or $info.Pid -ne $livePid)) {
        Write-Host "termhub: recording sessiond pid file (pid $livePid, port $Port)"
        Set-PidFile -Name 'sessiond' -ProcId $livePid -Port $Port
      }
      return $Port
    }

    Write-Host "termhub: port $Port is served by a single-process 'node server.js', not a sessiond." -ForegroundColor Yellow
    Write-Host "termhub: that shadows the real supervisor - replacing it (live PTYs end, then Restorable)." -ForegroundColor Yellow
    $squatter = Get-PortListenerPid -Port $Port
    if (-not (Clear-PortSquatter -Port $Port -Why 'dev single-process termhub shadowing sessiond')) {
      throw "port $Port is held by a process that could not be stopped; cannot start sessiond."
    }
    Remove-OwnedPidFile -Name 'sessiond' -ProcId $squatter
  } else {
    # Nobody answers. Drop a stale pid file so the failure paths below can't
    # mistake it for a live supervisor.
    $info = Get-PidInfo 'sessiond'
    if ($info -and -not (Test-NodeAlive $info.Pid)) { Remove-PidFile 'sessiond' }
  }

  Write-Host "termhub: starting sessiond on 127.0.0.1:$Port ..."
  $proc = Start-TermhubNode -Script 'sessiond.js' -EnvVars @{ TERMHUB_SESSIOND_PORT = $Port }
  if (-not (Wait-SessiondUp -Port $Port)) {
    $why = if ($proc -and $proc.HasExited) { " (it exited with code $($proc.ExitCode) - run 'node sessiond.js' to see why)" } else { '' }
    throw "sessiond did not come up on port $Port$why"
  }
  $ident = Get-SessiondIdentity -Port $Port
  if (-not $ident) { throw "sessiond answered the liveness probe but not the identity probe on port $Port." }
  if ($proc -and $ident.pid -and ([int]$ident.pid -ne $proc.Id)) {
    throw ("port $Port is answered by pid $($ident.pid), not the sessiond just started (pid $($proc.Id)). " `
      + "Something else owns the port - refusing to continue.")
  }
  Write-Host "termhub: sessiond up (pid $($ident.pid), $(Format-Commit $ident.commit $ident.dirty))"
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
