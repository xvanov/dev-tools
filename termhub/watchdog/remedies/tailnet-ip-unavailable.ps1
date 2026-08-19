# REPAIRS: tailnet-ip-unavailable
#
# Plain-HTTP mode has the front bind <tailnet ip>:<publish port> itself, so the
# classifier refuses to even probe when `tailscale ip -4` answers nothing: there is no
# address to probe. That check is the FIRST branch in Get-TermhubDiagnosis and runs
# before the front and sessiond are looked at at all, which is why this signature means
# "we could not find out", not "termhub is dead". Four very different things produce it,
# and only the last one needs a human:
#
#   1. the CLI is not on PATH in the watchdog's environment. The watchdog runs from a
#      scheduled task, whose PATH is not the interactive one; `& tailscale` then fails
#      to resolve, Resolve-TermhubTopology swallows it (`2>$null`) and reports no IP on
#      a machine that is perfectly logged in and serving. Test-ServePublished fails the
#      same way, so even the mode gets resolved from the logon task rather than from
#      Serve. Repaired by resolving tailscale.exe absolutely and PREPENDING its
#      directory to this process's PATH, so start-http.ps1 and Get-TermhubDiagnosis -
#      which both call bare `tailscale` - work for the rest of this remedy too.
#   2. a transient: tailscaled restarting, or the LocalAPI briefly not answering. One
#      empty answer is not evidence, so poll rather than conclude.
#   3. `tailscale down` was run (BackendState 'Stopped'), or the Tailscale service is
#      not running. Both are repairable with no human: the node key is still valid, so
#      `tailscale up` reconnects silently.
#   4. the node is LOGGED OUT (BackendState 'NeedsLogin'). Not repairable here, and not
#      termhub's to repair - re-authenticating needs someone to open a login URL.
#      `tailscale up` in this state does not fail fast, it prints an auth URL and
#      blocks; running it would spend the whole 60s budget to achieve nothing, so this
#      remedy deliberately does NOT try. It surfaces the URL in its output instead,
#      which is the one thing that actually shortens the outage.
#
# THE FIX, once an IP exists: windows\start-http.ps1 -Port <publish port>. Not a
# hand-rolled front launch - that script turns Serve off for the port first, which
# matters here: tailscaled can be left holding <tailnet ip>:<port> from an earlier Serve
# config even while `tailscale serve status` says "No serve config" (observed on
# LAP-US101, 2026-08-19). It also reuses a front already bound to the right address,
# which is what makes re-running this on a healthy machine a no-op.
#
# WHEN THERE IS NO IP TO BE HAD it degrades instead of giving up: if sessiond is alive
# and nothing healthy answers on 127.0.0.1:<publish port>, it puts a front on loopback.
# That does not restore tailnet access - nothing here can - but it keeps the machine
# usable from itself and leaves only a rebind to do once someone logs in. It then exits
# 1, because the contract's exit 0 means service restored, and reporting success for a
# machine no phone can reach would make the watchdog's log fiction.
#
# WHAT THE 2026-08-19 ESCALATION RULED OUT, so the next responder starts ahead of it:
# tailscaled was RUNNING (service Running, pids 31084/34060) and still holding
# 100.126.164.21:7000 and fd7a:...:7000 - stale sockets from before the logout, which is
# exactly what makes "tailscaled is down" the wrong first guess. `tailscale status` said
# "Logged out."; `tailscale up --timeout=20s` printed https://login.tailscale.com/a/...
# and timed out. The front (pid 47320) and sessiond (pid 43840, 1 live session) were
# both healthy on loopback the whole time. So nothing was broken about termhub itself; a
# human had to run `tailscale login` on the box.
#
# On a logged-out node this signature CANNOT clear, so the watchdog keeps re-diagnosing
# it. The escalation budget (>=10 min apart, 3/h, 8/day) is what stops that becoming a
# model woken every two minutes - that is the designed outcome, not a gap in this
# remedy. See watchdog/README.md, "Escalate in a loop".

param(
  [string]$Signature,
  [string]$Mode,
  [int]$PublishPort,
  [int]$FrontPort,
  [int]$SessiondPort,
  [string]$TailnetIp
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\windows\common.ps1')
. (Join-Path $PSScriptRoot '..\lib\diagnose.ps1')

$windows  = Join-Path $ProjectDir 'windows'
$deadline = (Get-Date).AddSeconds(55)   # the watchdog kills a remedy at 120s; the contract asks for 60
function Get-RemainingSec { [int][Math]::Max(0, [Math]::Floor(($deadline - (Get-Date)).TotalSeconds)) }

# ---- talking to tailscale ---------------------------------------------------

# Absolute path first, PATH second: the whole point of cause (1) is that PATH is the
# thing that cannot be trusted in this process.
function Resolve-TailscaleExe {
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, 'C:\Program Files')) {
    if (-not $root) { continue }
    $p = Join-Path $root 'Tailscale\tailscale.exe'
    if (Test-Path $p) { return $p }
  }
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return [string]$cmd.Source }
  return ''
}

# Native stderr under $ErrorActionPreference='Stop' becomes a TERMINATING error, so
# every tailscale call is made with it relaxed - the same trap start-http.ps1 documents
# around `tailscale serve ... off`. Merging stderr is deliberate by default: the reason
# for a failure ("Logged out.", an auth URL) is the useful half of the output.
function Invoke-Tailscale {
  param([string[]]$TsArgs, [switch]$DropStderr)
  if (-not $script:TsExe) { return @{ Text = ''; Code = 9009 } }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $text = ''; $code = 9009
  try {
    if ($DropStderr) { $text = (& $script:TsExe @TsArgs 2>$null | Out-String) }
    else             { $text = (& $script:TsExe @TsArgs 2>&1  | Out-String) }
    $code = $LASTEXITCODE
  } catch {
    $text = $_.Exception.Message
  } finally {
    $ErrorActionPreference = $prev
  }
  return @{ Text = ([string]$text).Trim(); Code = $code }
}

# Validate the shape instead of trusting the first line. `tailscale ip -4` prints
# "no current Tailscale IPs; state: NeedsLogin" when it has none, and handing that to
# TERMHUB_BIND would start a front bound to nothing at all.
function Get-TailnetIp4 {
  $r = Invoke-Tailscale -TsArgs @('ip', '-4') -DropStderr
  if ($r.Code -ne 0) { return '' }
  foreach ($line in ($r.Text -split "`r?`n")) {
    $s = $line.Trim()
    if ($s -match '^\d{1,3}(\.\d{1,3}){3}$') { return $s }
  }
  return ''
}

function Wait-TailnetIp {
  param([int]$TimeoutSec)
  $end = (Get-Date).AddSeconds($TimeoutSec)
  while ($true) {
    $found = Get-TailnetIp4
    if ($found) { return $found }
    if ((Get-Date) -ge $end -or (Get-RemainingSec) -le 2) { return '' }
    Start-Sleep -Milliseconds 1200
  }
}

# BackendState is what separates "reconnect it" from "a human must log in", and it is
# only in the JSON. Asked with stderr dropped so an error line cannot corrupt the parse.
function Get-TailscaleBackend {
  $out = @{ State = ''; AuthUrl = '' }
  $r = Invoke-Tailscale -TsArgs @('status', '--json') -DropStderr
  if ($r.Code -eq 0 -and $r.Text) {
    try {
      $j = $r.Text | ConvertFrom-Json
      $out.State = [string]$j.BackendState
      if ($j.AuthURL) { $out.AuthUrl = [string]$j.AuthURL }
    } catch { }
  }
  if (-not $out.AuthUrl) {
    $t = (Invoke-Tailscale -TsArgs @('status')).Text
    if ($t -match '(https://login\.tailscale\.com/\S+)') { $out.AuthUrl = $Matches[1] }
  }
  return $out
}

# ---- 0. resolve the CLI (cause 1) -------------------------------------------

$script:TsExe = Resolve-TailscaleExe
if (-not $script:TsExe) {
  Write-Host "remedy: tailscale.exe is neither on PATH nor in Program Files\Tailscale - Tailscale is not installed here, so plain-HTTP mode cannot work on this machine at all. A human must install it, or move the machine off plain-HTTP mode (.\windows\start.ps1)."
} else {
  $tsDir = Split-Path $script:TsExe -Parent
  if (@($env:PATH -split ';' | Where-Object { $_.TrimEnd('\') -ieq $tsDir.TrimEnd('\') }).Count -eq 0) {
    # Process-scoped only. start-http.ps1 and Get-TermhubDiagnosis call bare
    # `tailscale` and inherit this, which is the actual repair for cause (1).
    $env:PATH = "$tsDir;$env:PATH"
    Write-Host "remedy: tailscale.exe was NOT on PATH ($($script:TsExe)); prepended its directory for this process. That alone can be the whole outage - the watchdog task's PATH is not the interactive one."
  }
}

# ---- 1. is there an IP after all? (cause 2) ---------------------------------

$ip = Wait-TailnetIp -TimeoutSec 6
if ($ip) { Write-Host "remedy: tailnet IP is $ip (the classifier saw none - a transient, or the PATH gap above)." }

# ---- 2. reconnect what can be reconnected without a human (cause 3) --------

if (-not $ip -and (Get-RemainingSec) -gt 30) {
  $svc = Get-Service -Name 'Tailscale*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($svc -and $svc.Status -ne 'Running') {
    Write-Host "remedy: the $($svc.Name) service is $($svc.Status) - starting it."
    try {
      Start-Service -Name $svc.Name -ErrorAction Stop
      $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(8))
    } catch {
      # Starting a service needs admin. The watchdog's task is S4U when it was installed
      # elevated and Interactive otherwise, so this genuinely may not be permitted - say
      # so rather than reporting a repair that did not happen.
      Write-Host "remedy: could not start $($svc.Name): $($_.Exception.Message) (needs an elevated watchdog task)."
    }
    $ip = Wait-TailnetIp -TimeoutSec 8
  }

  if (-not $ip) {
    $backend = Get-TailscaleBackend
    Write-Host "remedy: BackendState=$(if ($backend.State) { $backend.State } else { '(unknown)' })"
    if ($backend.State -eq 'Stopped' -or $backend.State -eq 'NoState') {
      # 'Stopped' is `tailscale down`: the node key is still good, so `up` reconnects
      # with no login and no prompt. Bounded anyway, because `up` blocks when it turns
      # out to be wrong about that.
      Write-Host "remedy: the tailnet is administratively down but still authenticated - 'tailscale up'."
      $r = Invoke-Tailscale -TsArgs @('up', '--timeout=12s')
      if ($r.Text) { Write-Host "remedy: tailscale up said: $($r.Text -replace '\r?\n', ' | ')" }
      $ip = Wait-TailnetIp -TimeoutSec 5
    }
    elseif ($backend.State -eq 'NeedsLogin' -or $backend.State -eq 'Starting') {
      # Deliberately no `tailscale up` here - see cause (4). It cannot succeed, and it
      # does not fail fast.
      $where = if ($backend.AuthUrl) { $backend.AuthUrl } else { "(run 'tailscale login' on the machine to get one)" }
      Write-Host "remedy: this node is LOGGED OUT of the tailnet. No script can re-authenticate it - a human must open: $where"
    }
  }
}

# ---- 3. an IP exists: put the front on it -----------------------------------

if ($ip) {
  if ($Mode -ne 'http') {
    # The classifier only mints this signature in plain-HTTP mode, so this is
    # belt-and-braces: never re-bind a front in a mode this remedy was not reasoning
    # about. restart-front.ps1 is the mode-preserving door.
    Write-Host "remedy: mode is '$Mode', not http - leaving the front alone; restart-front.ps1 owns that case."
  } else {
    try {
      Write-Host "remedy: plain-HTTP mode - start-http.ps1 -Port $PublishPort (binds ${ip}:$PublishPort and turns Serve off for it)"
      & (Join-Path $windows 'start-http.ps1') -Port $PublishPort
    } catch {
      Write-Host "remedy: start-http.ps1 failed: $($_.Exception.Message)"
    }
  }

  # Verify independently. The start script health-checks its own launch, but this file's
  # exit code is what decides whether a model gets woken up.
  while ((Get-RemainingSec) -gt 2) {
    $d = Get-TermhubDiagnosis
    if ($d.Healthy) {
      Write-Host "remedy: verified healthy at $($d.Topology.FrontUrl) (sessiond untouched, $($d.SessiondProbe.Json.sessions) session(s))"
      exit 0
    }
    Start-Sleep -Seconds 2
  }
  $d = Get-TermhubDiagnosis
  Write-Host "remedy: a tailnet IP was available but termhub is still not healthy: $($d.Signature) - $($d.Detail)"
  exit 1
}

# ---- 4. no IP to be had: degrade, do not pretend -----------------------------

# sessiond is NEVER started or restarted here. This signature says nothing about
# sessiond - it is classified before sessiond is even probed - and sessiond holds every
# live terminal as an in-memory PTY.
$sess = Get-HttpProbe "http://127.0.0.1:$SessiondPort/api/ping"
if (-not ($sess.Json -and $sess.Json.ok -eq $true)) {
  Write-Host "remedy: sessiond on 127.0.0.1:$SessiondPort is down too ($($sess.Error)) - that is a both-down-shaped outage wearing this signature, and starting tiers is not in this remedy's scope. Left alone."
} elseif (Wait-FrontHealthy -Port $PublishPort -TimeoutSec 3 -Address '127.0.0.1') {
  Write-Host "remedy: no tailnet IP, but the front is already healthy on 127.0.0.1:$PublishPort - termhub works on this machine and is only unreachable from the tailnet. Nothing to change (the idempotent case)."
} else {
  Write-Host "remedy: no tailnet IP and nothing healthy on 127.0.0.1:$PublishPort - putting a front on loopback so the machine is at least usable from itself."
  # Only the front recorded in front-<port>.pid is stopped: in plain-HTTP mode it is
  # bound to a tailnet address that no longer exists, so it is unreachable from
  # everywhere and there is nothing to preserve. No unidentified process is touched.
  Stop-Front "front-$PublishPort"
  if (Start-VerifiedFront -Port $PublishPort -SessiondPort $SessiondPort -Bind '127.0.0.1') {
    Write-Host "remedy: front is up on 127.0.0.1:$PublishPort. state.json is left as-is - this is still a plain-HTTP machine, and start-http.ps1 rebinds it once there is an IP."
  } else {
    Write-Host "remedy: could not even get a front up on 127.0.0.1:$PublishPort."
  }
}

Write-Host "remedy: FAILED to restore tailnet access - there is no tailnet IP to bind to and no script can mint one. A human must run 'tailscale login' (or 'tailscale up') on $env:COMPUTERNAME; the outage clears on its own once the node is authenticated."
exit 1
