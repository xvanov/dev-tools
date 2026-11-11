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
#   6. (see 2026-11-02 below) Windows, NOT in unattended mode, and the tray app
#      tailscale-ipn.exe is not running. The profile unloads the moment the last client
#      disconnects, so the node READS as NoState/NeedsLogin while it is still fully
#      authenticated. Repaired with `tailscale up --unattended`. Checked BEFORE causes 3 and
#      4, because both of their branches misread this state.
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
# WHAT THE 2026-09-11 ESCALATION RULED OUT (LAP-US101): re-verified independently with
# `tailscale status --json` - BackendState really is NeedsLogin, AuthURL present, the
# same as 2026-08-19. Front (pid 22232) and sessiond (pid 21140, 2 live sessions) were
# both already healthy on 127.0.0.1:7000 - this remedy's own previous run had already put
# the front on loopback and this run's idempotent branch confirmed it, unchanged. No
# code defect in the NeedsLogin path; the remedy did exactly what section 4 documents.
# While re-reading the backend-state branch below to confirm that, found and fixed a
# real bug unrelated to today's outage: 'Starting' was lumped in with 'NeedsLogin' and
# got told "this node is LOGGED OUT", which is wrong - Starting is what BackendState
# reads for a few seconds during a normal reconnect (e.g. right after the service-start
# branch above, or after `tailscale up` returns), not a logged-out node. Cause (2) of
# this file's own header says a transient answer should be polled, not concluded from;
# the old code did that for "no IP yet" but not for "state says Starting". Fixed by
# giving Starting its own branch that polls a little longer instead of printing the
# login-URL message, so a node that is merely still coming up is never told to re-login.
#
# On a logged-out node this signature CANNOT clear, so the watchdog keeps re-diagnosing
# it. The escalation budget (>=10 min apart, 3/h, 8/day) is what stops that becoming a
# model woken every two minutes - that is the designed outcome, not a gap in this
# remedy. See watchdog/README.md, "Escalate in a loop".
#
# WHAT THE 2026-09-22 ESCALATION FOUND (LAP-US101), and the two gaps it fixed:
# BackendState was 'NoState', which the code already routed into cause (3)'s "administratively
# down but authenticated" branch - correctly, but that branch's bare
# `tailscale up --timeout=12s` failed outright: "changing settings via 'tailscale up' requires
# mentioning all non-default flags ... tailscale up --timeout=12s --accept-dns=false". This
# machine's profile has a non-default setting (--accept-dns=false), and tailscale refuses a
# bare `up` rather than guess whether to keep or drop it - it hands back the exact command that
# would work. The old code printed that refusal and gave up, which turned a fixable case into an
# escalation. Fixed by Get-TailscaleUpRetryArgs, which parses the suggested line out of the
# refusal and reissues `up` with those exact flags - preserving the profile's settings rather
# than guessing `--reset`, which would silently change DNS behavior nobody asked to change.
#
# Second gap, found only because the first fix still didn't clear this machine: after `up`
# accepted the reissued flags (exit 0), BackendState stayed 'NoState' with the Health array
# down to just "Tailscale is starting. Please wait." - not logged out, not erroring, just never
# leaving "starting". `curl https://controlplane.tailscale.com/key?v=142` returned 200 from this
# same machine at the same time, which rules out a network/proxy block. Two full service
# restarts were tried by hand - `Restart-Service Tailscale`, and separately `Stop-Service` +
# kill both `tailscaled.exe` processes + `Start-Service` - and each left it wedged the same way
# after 40+ seconds of polling. (The two `tailscaled.exe` processes seen throughout, ~1s apart
# in start time, are normal for this service under session 0, not a duplicate-process bug worth
# chasing.) So this is a genuine fifth cause this remedy cannot clear: a backend that is running,
# reachable, authenticated (HaveNodeKey=true) and never progresses past NoState/"starting". The
# remedy now tries ONE bounded service restart when `up` succeeds but the state doesn't move -
# cheap, non-destructive to termhub, and it does sometimes clear a wedge even though it didn't
# here - then falls through to the same degrade-and-report-failure path as an unclearable
# NeedsLogin, since no script-only fix is known for it. A human needs to look at tailscaled
# itself (its logs are SYSTEM-locked from a non-elevated session: even reading
# `%ProgramData%\Tailscale\tailscaled.log*.txt` needs elevation) - this is not termhub's bug.
#
# WHAT THE 2026-10-28 ESCALATION FOUND (LAP-US101): NeedsLogin again, and this remedy did
# exactly what section 4 says (loopback front already healthy, sessiond pid 6664 with 5 live
# sessions untouched). What it MISSED was evidence, not a repair: this time the node looked
# recoverable on paper - `status --json` had HaveNodeKey=true, `tailscale debug prefs` had
# LoggedOut=false and WantRunning=true, the Health line said "The last login error was: fetch
# control key: ... context canceled", and controlplane.tailscale.com/key answered 200 from the
# box. That reads like a network blip a reconnect would clear. It is not: a bounded
# `tailscale up --timeout=20s` (bare - CorpDNS is default here now) printed a FRESH auth URL and
# timed out, BackendState still NeedsLogin. So HaveNodeKey/LoggedOut=false do NOT mean `up` can
# reconnect silently; NeedsLogin stays human-only and section 4's "do not try `up`" holds (it
# also re-mints the auth URL, so a URL logged by an earlier run goes stale). The remedy now
# prints tailscaled's Health text next to the auth URL, so the next responder sees the
# backend's own reason without re-deriving all of the above by hand.
#
# WHAT THE 2026-11-02 ESCALATION FOUND (LAP-US101) - cause 6, and very likely the real
# cause behind the 2026-09-22 "wedged NoState" and the 2026-10-28 "NeedsLogin with
# HaveNodeKey=true / LoggedOut=false" notes above. This remedy ran its NoState branch
# (`up`, then one service restart) and still exited 1 with BackendState=NoState and the
# same "logged out ... fetch control key: context canceled" health text. That escalation was
# elevated, so it could read tailscaled's own log (%ProgramData%\Tailscale\Logs\
# tailscale-service-*.txt), and the log names the mechanism:
#     04:17:33 client disconnected (S-1-5-21-...): disconnecting Tailscale
#              Switching ipn state Running -> NoState (WantRunning=false)
#     then, for every CLI call:  client connected (INNERGY\<user>): switching to profile ...
#              NoState (WantRunning=true) -> TryLogin -> client disconnected:
#              disconnecting Tailscale -> "profile not found" -> NeedsLogin
# On Windows, tailscaled WITHOUT "Run unattended" (pref ForceDaemon=false) only keeps a
# profile loaded while a LocalAPI client from the user's session stays connected. That
# long-lived client is the tray app, tailscale-ipn.exe. It exited at 04:17:33 (why is
# unknown: no Application Error event, no crash dump). The node was never logged out. Every
# short-lived client (`tailscale up`, `status`, this remedy) loads the profile, starts a login,
# and cancels it when the client disconnects. That cancelled login is the "context canceled"
# fetch error, and it explains why `up` can't finish, why a service restart doesn't help, and
# why a bare `up` can look like it needs a fresh auth URL. A prefs dump says LoggedOut=false and
# the control plane is reachable, because neither was ever the problem.
# THE FIX FOR CAUSE 6 is `tailscale up --unattended` (sets ForceDaemon=true, Tailscale's
# documented "keep running with no user client"). It held on the first try: Running and the
# old 100.x IP back in 13s, and start-http.ps1 rebound the front. Detection, all required:
# prefs LoggedOut=false and ForceDaemon=false, no tailscale-ipn.exe in any session, and
# BackendState NoState/NeedsLogin/Stopped. A watchdog task in session 0 cannot launch the
# tray app onto the user's desktop, so unattended mode is the only fix a script can apply.
# It persists until someone undoes it, which is the point: the next tray exit or logoff no
# longer takes termhub off the tailnet. Undo with `tailscale up --unattended=false` or the
# tray menu's "Run unattended" toggle.
#
# WHAT THE 2026-11-03 ESCALATION FOUND (LAP-US101) - cause 7, a NODE KEY EXPIRY. This is
# a real NeedsLogin, not cause 6 wearing its clothes: unattended mode was ON (ForceDaemon=true,
# from the 11-02 fix), the tray app was running, LoggedOut=false, HaveNodeKey=true, Health
# empty. What happened: Tailscale auto-updated itself to 1.104.5 at 05:29, which restarted
# tailscaled. On re-register, control answered `nodeKeyExpired=true`. tailscaled generated a
# new key and control wanted interactive auth for it (`authURL=true`). Neither the update nor
# the restart broke anything. They only made the node re-register, and that is when the
# expiry showed. The log shows the key minted at the 11-02 04:29 login expired about 25h
# later, and 11-01 18:24 was another expired-key re-login. So this tailnet's keys expire
# about daily for this machine. Why so short is unknown, probably the tailnet's key-expiry
# setting or a policy. No script can fix it. The one fix that stops it coming back is in the
# admin console: Machines -> LAP-US101 -> "Disable key expiry", or a longer tailnet key
# expiry.
# What the old version MISSED was the diagnosis, not a repair. It said "LOGGED OUT" and left
# the next responder to dig the expiry out of an elevated log by hand. The NeedsLogin branch
# now reads tailscaled's service log (Get-TailscaledKeyExpiry; elevated read, silently
# skipped if denied) and says "node key EXPIRED at <time>" with the console fix. That turns a
# daily escalation into a one-time setting change. Ruled out today: `tailscale up` (it only
# re-mints the auth URL, per the 10-28 note), cause 6 (ForceDaemon already true, tray
# present) and a reboot (uptime since 10-27). sessiond (pid 6664, 3 sessions) and the
# loopback front stayed healthy throughout.
#
# WHAT THE 2026-11-10 ESCALATION FOUND (LAP-US101): cause 7 again, with the same trigger.
# Tailscale auto-updated to 1.104.6 between 22:25 and 22:29 (MsiInstaller event 11707), and the
# outage began at 22:30. The state was NeedsLogin with HaveNodeKey=true, LoggedOut=false,
# ForceDaemon=true, the tray running and Health "You are logged out." This remedy reported only
# "LOGGED OUT", for two reasons. The watchdog task is not elevated, so
# Get-TailscaledKeyExpiry hit "Access is denied" on %ProgramData%\Tailscale\Logs and returned
# ''. That function was the only path to the cause-7 diagnosis, so the diagnosis never printed.
# The Application event log has no such restriction. The NeedsLogin branch now also asks
# Get-TailscaleRecentUpdate for a Tailscale MSI install in the last 48h. If it finds one and
# the node still has its key, it reports cause 7 and names the console fix, with no elevation
# needed. There is still no repair: a human must open the auth URL, and 'Disable key expiry'
# stops the next update from doing this again. Ruled out: cause 6 (ForceDaemon already true,
# tray present), and `tailscale up` (it only re-mints the URL; see the 10-28 note). sessiond
# (pid 30840, 1 session) and the loopback front (pid 23764) stayed healthy and were not touched.

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

# `tailscale up` refuses a bare re-run when the profile has non-default settings (e.g.
# --accept-dns=false), and names the exact command that would work rather than let a caller
# guess whether --reset (which would drop that setting) is intended. Parsing that command back
# out is the fix for cause (3)'s up-call - see the 2026-09-22 note above.
function Get-TailscaleUpRetryArgs {
  param([string]$Text)
  if ($Text -match '(?ms)non-default settings:\s*\r?\n\s*tailscale up\s+(.+?)\s*(\r?\n|$)') {
    return @($Matches[1] -split '\s+' | Where-Object { $_ })
  }
  return $null
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
  $out = @{ State = ''; AuthUrl = ''; Health = '' }
  $r = Invoke-Tailscale -TsArgs @('status', '--json') -DropStderr
  if ($r.Code -eq 0 -and $r.Text) {
    try {
      $j = $r.Text | ConvertFrom-Json
      $out.State = [string]$j.BackendState
      if ($j.AuthURL) { $out.AuthUrl = [string]$j.AuthURL }
      if ($j.Health)  { $out.Health = (@($j.Health) -join ' | ') }
    } catch { }
  }
  if (-not $out.AuthUrl) {
    $t = (Invoke-Tailscale -TsArgs @('status')).Text
    if ($t -match '(https://login\.tailscale\.com/\S+)') { $out.AuthUrl = $Matches[1] }
  }
  return $out
}

# `tailscale debug prefs` is JSON. LoggedOut and ForceDaemon tell cause 6 (unattended off,
# no client attached, but authenticated) apart from a real logout. Returns $null if unreadable,
# and an unreadable result never counts as evidence for cause 6.
function Get-TailscalePrefs {
  $r = Invoke-Tailscale -TsArgs @('debug', 'prefs') -DropStderr
  if ($r.Code -ne 0 -or -not $r.Text) { return $null }
  try { return ($r.Text | ConvertFrom-Json) } catch { return $null }
}

# Cause 7 (2026-11-03): tells a node-key EXPIRY apart from a plain logout. Only tailscaled's
# own log has it; `status --json` shows the same NeedsLogin and empty KeyExpiry for both.
# The log dir needs an elevated read, so an access failure returns '' and that is NOT evidence
# either way. Reads the tail of the newest two service logs, because the expiry can sit just
# before a midnight rotation.
function Get-TailscaledKeyExpiry {
  try {
    $dir = Join-Path $env:ProgramData 'Tailscale\Logs'
    $files = @(Get-ChildItem -Path $dir -Filter 'tailscale-service-*.txt' -ErrorAction Stop |
               Sort-Object LastWriteTime -Descending | Select-Object -First 2)
    foreach ($f in $files) {
      $hit = Get-Content -LiteralPath $f.FullName -Tail 4000 -ErrorAction Stop |
             Where-Object { $_ -match 'nodeKeyExpired=true|Old key expired|key-expired=true' } |
             Select-Object -Last 1
      if ($hit) { return (($hit -split ': ', 2)[0]) }
    }
  } catch { }
  return ''
}

# Cause 7 evidence that does NOT need elevation (2026-11-10). A Tailscale auto-update restarts
# tailscaled, which re-registers, and that is when an expired node key shows up. MsiInstaller
# event 11707 ("Product: Tailscale -- Installation completed successfully.") is readable from
# a non-elevated task. Returns the install time as a string, or ''.
function Get-TailscaleRecentUpdate {
  try {
    $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'MsiInstaller'; Id = 11707; StartTime = (Get-Date).AddHours(-48) } -MaxEvents 50 -ErrorAction Stop |
          Where-Object { $_.Message -match 'Product: Tailscale\b' } | Select-Object -First 1
    if ($ev) { return $ev.TimeCreated.ToString('yyyy-MM-dd HH:mm') }
  } catch { }
  return ''
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

    # Cause 6 (2026-11-02): runs before the Stopped/NoState and NeedsLogin branches, because
    # both misread this state. The first does `up` plus a service restart, and every one of
    # those calls unloads the profile again when it disconnects. The second tells a human to
    # log in a node that was never logged out.
    if ($backend.State -in @('NoState', 'NeedsLogin', 'Stopped')) {
      $prefs = Get-TailscalePrefs
      $tray  = @(Get-Process -Name 'tailscale-ipn' -ErrorAction SilentlyContinue)
      if ($prefs -and $prefs.LoggedOut -eq $false -and $prefs.ForceDaemon -ne $true -and $tray.Count -eq 0) {
        $upTimeout = [Math]::Min(20, [Math]::Max(5, (Get-RemainingSec) - 12))
        Write-Host "remedy: no tailscale-ipn.exe (tray client) running and unattended mode is OFF (ForceDaemon=false, LoggedOut=false) - tailscaled unloads the profile whenever no client is attached, so the node only LOOKS logged out. 'tailscale up --unattended' (undo: --unattended=false)."
        $r = Invoke-Tailscale -TsArgs @('up', '--unattended', "--timeout=${upTimeout}s")
        if ($r.Text) { Write-Host "remedy: tailscale up --unattended said: $($r.Text -replace '\r?\n', ' | ')" }
        if ($r.Code -ne 0) {
          $retryArgs = Get-TailscaleUpRetryArgs -Text $r.Text
          if ($retryArgs -and (Get-RemainingSec) -gt 15) {
            if ($retryArgs -notcontains '--unattended') { $retryArgs = @('--unattended') + $retryArgs }
            Write-Host "remedy: 'up' wants the profile's non-default flags re-stated - reissuing: tailscale up $($retryArgs -join ' ')"
            $r = Invoke-Tailscale -TsArgs (@('up') + $retryArgs)
            if ($r.Text) { Write-Host "remedy: reissued 'up' said: $($r.Text -replace '\r?\n', ' | ')" }
          }
        }
        $ip = Wait-TailnetIp -TimeoutSec ([Math]::Min(10, [Math]::Max(0, (Get-RemainingSec) - 5)))
        if (-not $ip) {
          $backend = Get-TailscaleBackend
          Write-Host "remedy: still no tailnet IP after 'up --unattended' (BackendState=$($backend.State)) - falling through."
          if ($backend.Health) { Write-Host "remedy: tailscaled health: $($backend.Health)" }
        }
      }
    }

    if ($ip) { }
    elseif ((Get-RemainingSec) -le 20 -and ($backend.State -eq 'Stopped' -or $backend.State -eq 'NoState')) {
      Write-Host "remedy: out of budget for the Stopped/NoState reconnect after the unattended attempt."
    }
    elseif ($backend.State -eq 'Stopped' -or $backend.State -eq 'NoState') {
      # 'Stopped' is `tailscale down`: the node key is still good, so `up` reconnects
      # with no login and no prompt. Bounded anyway, because `up` blocks when it turns
      # out to be wrong about that.
      Write-Host "remedy: the tailnet is administratively down but still authenticated - 'tailscale up'."
      $r = Invoke-Tailscale -TsArgs @('up', '--timeout=12s')
      if ($r.Text) { Write-Host "remedy: tailscale up said: $($r.Text -replace '\r?\n', ' | ')" }
      if ($r.Code -ne 0) {
        $retryArgs = Get-TailscaleUpRetryArgs -Text $r.Text
        if ($retryArgs) {
          Write-Host "remedy: 'up' refused a bare retry - non-default settings (e.g. --accept-dns=false) must be re-stated explicitly, not assumed away with --reset. Reissuing exactly what it asked for: tailscale up $($retryArgs -join ' ')"
          $r = Invoke-Tailscale -TsArgs (@('up') + $retryArgs)
          if ($r.Text) { Write-Host "remedy: reissued 'up' said: $($r.Text -replace '\r?\n', ' | ')" }
        }
      }
      $ip = Wait-TailnetIp -TimeoutSec 5

      # Cause 5 (2026-09-22): 'up' can exit clean and BackendState still never leaves
      # NoState/"starting" - not logged out, not erroring, just wedged. One bounded,
      # non-destructive service restart is worth trying even though it didn't clear the
      # case that found it; it never touches termhub. Gated on remaining budget because
      # the restart + poll below can cost up to ~25s.
      if (-not $ip -and (Get-RemainingSec) -gt 25) {
        $stillState = (Get-TailscaleBackend).State
        if ($stillState -eq 'NoState' -or $stillState -eq 'Stopped') {
          Write-Host "remedy: still $stillState after 'up' returned - restarting the Tailscale service once."
          $svc2 = Get-Service -Name 'Tailscale*' -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($svc2) {
            try {
              Restart-Service -Name $svc2.Name -Force -ErrorAction Stop
              $ip = Wait-TailnetIp -TimeoutSec ([Math]::Min(20, [Math]::Max(0, (Get-RemainingSec) - 5)))
            } catch {
              Write-Host "remedy: could not restart $($svc2.Name): $($_.Exception.Message) (needs an elevated watchdog task)."
            }
          }
        }
      }
    }
    elseif ($backend.State -eq 'Starting') {
      # Starting is what a node reads for a few seconds during a normal reconnect
      # (e.g. right after the service-start branch above, or after `tailscale up`
      # returns) - it is NOT logged out, and telling a human to re-login here would be
      # actively wrong. Poll a bit longer instead of concluding anything from one read.
      Write-Host "remedy: BackendState=Starting (reconnecting) - waiting rather than concluding logged-out."
      $ip = Wait-TailnetIp -TimeoutSec ([Math]::Min(10, [Math]::Max(0, (Get-RemainingSec) - 5)))
    }
    elseif ($backend.State -eq 'NeedsLogin' -or $backend.State -eq 'NeedsMachineAuth') {
      # Deliberately no `tailscale up` here - see cause (4). It cannot succeed, and it
      # does not fail fast.
      $where = if ($backend.AuthUrl) { $backend.AuthUrl } else { "(run 'tailscale login' on the machine to get one)" }
      Write-Host "remedy: this node is LOGGED OUT of the tailnet. No script can re-authenticate it - a human must open: $where"
      if ($backend.Health) { Write-Host "remedy: tailscaled health: $($backend.Health)" }
      $expiredAt = Get-TailscaledKeyExpiry
      if ($expiredAt) {
        Write-Host "remedy: cause is a NODE KEY EXPIRY (tailscaled log: control reported the key expired at $expiredAt), not a logout or a termhub fault. Logging in clears it for one key lifetime only. To stop it recurring: Tailscale admin console -> Machines -> $env:COMPUTERNAME -> 'Disable key expiry'."
      } else {
        # The log read above needs elevation; the watchdog task usually is not. Fall back to
        # the event log, which is readable either way (2026-11-10).
        $updatedAt = Get-TailscaleRecentUpdate
        $prefs7 = Get-TailscalePrefs
        if ($updatedAt -and $prefs7 -and $prefs7.LoggedOut -eq $false) {
          Write-Host "remedy: Tailscale auto-updated at $updatedAt (MsiInstaller 11707). That restarted tailscaled, and the node still holds its key (LoggedOut=false), so this is almost certainly a NODE KEY EXPIRY found at re-register (cause 7). It is not a logout and not a termhub fault. Logging in clears it for one key lifetime. To stop it recurring: Tailscale admin console -> Machines -> $env:COMPUTERNAME -> 'Disable key expiry'."
        }
      }
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
