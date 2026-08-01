# termhub watchdog - probing, classification, and the diagnostic bundle.
#
# Dot-source this AFTER windows\common.ps1; it builds on that file's state/pid/port
# helpers rather than re-deriving them, so the watchdog and the deploy scripts can
# never disagree about which port is which.
#
# The one idea worth understanding here is the SIGNATURE. Every failure is reduced
# to one of a small set of stable slugs (see Get-TermhubDiagnosis), and that slug is
# the filename of its remedy: signature `front-down-sessiond-up` is fixed by
# remedies\front-down-sessiond-up.ps1. That indirection is what lets the LLM
# escalation path leave something behind: it writes the remedy under the signature
# it was called for, and the next occurrence never reaches the LLM at all.
#
# So signatures must be STABLE and COARSE. A signature that encodes a pid, a port
# number, or an error string would mint a new one on every outage and the remedy
# library would never accumulate. They describe the SHAPE of the failure - which
# tier is missing, who holds the port - and the remedy re-derives the specifics.

# GET a URL and report what actually happened, distinguishing "nothing is
# listening" from "a server answered with an error".
#
# This distinction is the reason Get-JsonEndpoint (in common.ps1) is not enough:
# it returns $null for both, and those are two completely different outages. The
# front answers /api/health with a 503 when it is alive but cannot reach sessiond -
# the case where restarting the front is exactly the wrong move.
function Get-HttpProbe {
  param([string]$Url, [int]$TimeoutSec = 4)
  $res = @{ Url = $Url; Reachable = $false; StatusCode = 0; Body = ''; Json = $null; Error = '' }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec $Url
    $res.Reachable = $true
    $res.StatusCode = [int]$r.StatusCode
    $res.Body = [string]$r.Content
  } catch {
    $res.Error = $_.Exception.Message
    $resp = $null
    try { $resp = $_.Exception.Response } catch { }
    if ($resp) {
      $res.Reachable = $true
      try { $res.StatusCode = [int]$resp.StatusCode } catch { }
      try {
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $res.Body = $sr.ReadToEnd()
        $sr.Close()
      } catch { }
    }
  }
  if ($res.Body) { try { $res.Json = $res.Body | ConvertFrom-Json } catch { } }
  return $res
}

# Every listener on a port, with who owns it. The bundle wants all of them (in
# plain-HTTP mode the tailnet address and loopback are different sockets and only
# one of them is supposed to be a front), and classification wants to know whether
# the holder is node, tailscaled, or something else entirely.
function Get-PortListeners {
  param([int]$Port)
  $out = @()
  try {
    $conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop
    foreach ($c in $conns) {
      $procId = [int]$c.OwningProcess
      $out += @{ Address = [string]$c.LocalAddress; Pid = $procId; Name = (Get-ProcessNameFor $procId) }
    }
  } catch { }
  return $out
}

# Which of the three layouts is this machine on, and therefore where should the
# front be listening?
#
#   bluegreen   activeFrontPort != publishPort
#   single      equal ports AND Tailscale Serve publishes the port
#   http        equal ports AND Serve is off for it (start-http.ps1)
#
# The last two are recorded IDENTICALLY in state.json, so Serve's own config is the
# tiebreaker (Test-ServePublished) - the same rule restart-front.ps1 and update.ps1
# follow, and for the same reason: guessing sends the front at an address tailscaled
# already holds, or onto loopback where no other device can reach it.
#
# When Serve cannot be consulted at all, Test-ServePublished answers $null and this
# falls back to the logon task's own command line. That is a genuinely strong
# machine-local signal - `start-http.ps1` in the task IS the statement "this machine
# is plain-HTTP" - and it beats defaulting blind, which is what the callers in
# windows\ have to do because they have no reason to go looking at a scheduled task.
function Resolve-TermhubTopology {
  $state = Get-TermhubState
  $sessiondPort = [int]$state.sessiondPort
  $frontPort    = [int]$state.activeFrontPort
  $publishPort  = [int]$state.publishPort

  $tailnetIp = ''
  try {
    $first = (& tailscale ip -4 2>$null) | Select-Object -First 1
    if ($first) { $tailnetIp = ([string]$first).Trim() }
  } catch { }

  $modeSource = 'ports'
  $mode = 'bluegreen'
  if ($frontPort -eq $publishPort) {
    $published = Test-ServePublished -Port $publishPort
    if ($published -eq $true)       { $mode = 'single'; $modeSource = 'serve' }
    elseif ($published -eq $false)  { $mode = 'http';   $modeSource = 'serve' }
    else {
      $mode = 'single'; $modeSource = 'default'
      try {
        $action = (((Get-ScheduledTask -TaskName 'Termhub' -ErrorAction Stop).Actions |
                    ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ')
        if ($action -match 'start-http\.ps1')  { $mode = 'http';   $modeSource = 'task' }
        elseif ($action -match 'start\.ps1')   { $mode = 'single'; $modeSource = 'task' }
      } catch { }
    }
  }

  # Where the front is supposed to be, i.e. where a probe failing means "down".
  if ($mode -eq 'http')        { $bind = $tailnetIp;  $probePort = $publishPort }
  elseif ($mode -eq 'single')  { $bind = '127.0.0.1'; $probePort = $publishPort }
  else                         { $bind = '127.0.0.1'; $probePort = $frontPort }

  return @{
    SessiondPort = $sessiondPort
    FrontPort    = $frontPort
    PublishPort  = $publishPort
    Mode         = $mode
    ModeSource   = $modeSource
    TailnetIp    = $tailnetIp
    Bind         = $bind
    ProbePort    = $probePort
    FrontUrl     = "http://${bind}:$probePort"
  }
}

# Is a deploy script running right now?
#
# update.ps1 and restart-front.ps1 both stop the front and start a new one, which
# in single-port and plain-HTTP mode is a real (~1-2s) window with nothing on the
# port. A watchdog that treated that as an outage would race the updater for the
# same socket - two processes both convinced they should own it - which is strictly
# worse than the gap it was trying to fix. So the watchdog stands down while a
# deploy is in flight and lets it finish or fail on its own terms.
function Test-TermhubMaintenance {
  $mine = $PID
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop
  } catch { return $null }
  foreach ($p in $procs) {
    if ([int]$p.ProcessId -eq $mine) { continue }
    $cmd = [string]$p.CommandLine
    if (-not $cmd) { continue }
    if ($cmd -match 'update\.ps1|restart-front\.ps1|restart-sessiond\.ps1|start-http\.ps1|(?<!-)\bstart\.ps1') {
      # Never let the watchdog's own remedy subprocesses read as maintenance; they
      # are invoked with -File <remedy>, not with these names.
      return "pid $($p.ProcessId): $cmd"
    }
  }
  return $null
}

# Probe termhub and classify the result into a signature.
#
# Order matters: the most specific and most consequential causes are tested first,
# because the difference between them is the difference between the right and the
# wrong repair. `sessiond-down-front-up` in particular must never be misread as a
# dead front - sessiond holds every live PTY in memory, and "restart the front"
# would leave the real problem in place while `both-down` would invite killing it.
function Get-TermhubDiagnosis {
  $t = Resolve-TermhubTopology

  $sessiond = Get-HttpProbe "http://127.0.0.1:$($t.SessiondPort)/api/ping"
  $sessOk   = ($sessiond.Json -and $sessiond.Json.ok -eq $true)

  $frontProbe = $null
  if ($t.Bind) { $frontProbe = Get-HttpProbe "$($t.FrontUrl)/api/health" }
  $frontResponds = ($frontProbe -and $frontProbe.Reachable)
  $frontOk       = ($frontProbe -and $frontProbe.Json -and $frontProbe.Json.ok -eq $true)

  $listeners   = Get-PortListeners -Port $t.ProbePort
  $onBind      = @($listeners | Where-Object { $_.Address -eq $t.Bind })
  $frontPidRec = Get-PidInfo "front-$($t.ProbePort)"
  $frontPidAlive = ($frontPidRec -and (Test-NodeAlive $frontPidRec.Pid))

  $sig = 'unknown'
  $detail = ''

  if ($t.Mode -eq 'http' -and -not $t.TailnetIp) {
    $sig = 'tailnet-ip-unavailable'
    $detail = "plain-HTTP mode needs a tailnet IP to bind the front to, and 'tailscale ip -4' returned nothing (tailscaled down, or this node is logged out)."
  }
  elseif ($frontOk -and $sessOk) {
    $sig = 'healthy'
  }
  elseif ($frontResponds -and -not $sessOk) {
    # The front is alive and answering; its proxy target is gone. Restarting the
    # front here fixes nothing and costs the UI. sessiond is the casualty, and with
    # it every live PTY - the sessions come back as Restorable, not as they were.
    $sig = 'sessiond-down-front-up'
    $detail = "the front answers on $($t.FrontUrl) but sessiond on 127.0.0.1:$($t.SessiondPort) does not: $($sessiond.Error)"
  }
  elseif ($frontResponds -and ($frontProbe.Body -match 'HTTP request to an HTTPS server')) {
    # tailscaled's TLS listener took over the address the front is supposed to own.
    # This is update.ps1's old plain-HTTP bug arriving from the other direction.
    $sig = 'serve-holds-http-port'
    $detail = "$($t.FrontUrl) is terminating TLS, not serving the front: $($frontProbe.Body.Trim())"
  }
  elseif ($frontResponds -and -not $frontOk -and $sessOk) {
    $ident = ''
    if ($frontProbe.Json -and $frontProbe.Json.self) { $ident = [string]$frontProbe.Json.self.entry }
    if ($ident -and $ident -ne 'front') {
      # Something that is not a front is answering on the front's address - the
      # `node server.js` monolith is the classic one (see Clear-PublishPort).
      $sig = 'publish-port-monolith'
      $detail = "$($t.FrontUrl) is answered by entry '$ident', not a front."
    } else {
      $sig = 'front-unhealthy'
      $detail = "the front answers $($t.FrontUrl) with HTTP $($frontProbe.StatusCode) and ok!=true: $($frontProbe.Body)"
    }
  }
  elseif (-not $frontResponds) {
    $squatter = @($onBind | Where-Object { $_.Name -ne 'node' -and $_.Name -ne '' })
    if ($squatter.Count -gt 0) {
      if (@($squatter | Where-Object { $_.Name -match 'tailscale' }).Count -gt 0 -and $t.Mode -eq 'http') {
        $sig = 'serve-holds-http-port'
        $detail = "$($t.Bind):$($t.ProbePort) is held by $($squatter[0].Name) (pid $($squatter[0].Pid)); in plain-HTTP mode the front owns that address and Serve must be off for it."
      } else {
        # Deliberately NOT self-healing: killing an unrecognised process to free a
        # port is a far worse bug than the outage. Escalate and let a human or the
        # LLM decide, exactly as Clear-PortSquatter refuses to.
        $sig = 'publish-port-squatted'
        $detail = "$($t.Bind):$($t.ProbePort) is held by '$($squatter[0].Name)' (pid $($squatter[0].Pid)), which is not a termhub process."
      }
    }
    elseif ($frontPidAlive -and $onBind.Count -eq 0) {
      # The recorded front is running but not where this mode publishes - alive and
      # unreachable, which reads as "up" to anything that only checks liveness.
      $where = @($listeners | ForEach-Object { "$($_.Address) (pid $($_.Pid))" }) -join ', '
      if (-not $where) { $where = 'nothing on this port at all' }
      $sig = 'front-bound-wrong-address'
      $detail = "front-$($t.ProbePort).pid names live pid $($frontPidRec.Pid), but $($t.Mode) mode publishes $($t.Bind):$($t.ProbePort) and the listeners there are: $where"
    }
    elseif ($sessOk) {
      # The common one, and the one that took termhub down today: PTYs intact in
      # sessiond, no front in front of them.
      $sig = 'front-down-sessiond-up'
      $detail = "nothing is listening on $($t.Bind):$($t.ProbePort); sessiond is healthy on 127.0.0.1:$($t.SessiondPort) with $($sessiond.Json.sessions) session(s), so the PTYs are intact and only the front needs replacing."
    }
    else {
      $sig = 'both-down'
      $detail = "neither the front ($($t.FrontUrl)) nor sessiond (127.0.0.1:$($t.SessiondPort)) answers - a reboot, a logon task that never ran, or both tiers killed together."
    }
  }

  return @{
    Signature     = $sig
    Healthy       = ($sig -eq 'healthy')
    Detail        = $detail
    At            = (Get-Date)
    Topology      = $t
    FrontProbe    = $frontProbe
    SessiondProbe = $sessiond
    Listeners     = $listeners
    FrontPidRec   = $frontPidRec
    FrontPidAlive = $frontPidAlive
  }
}

# Everything an agent (or a human at 2am) needs to reason about this outage, as
# text. Assembled here rather than in the prompt so the same bundle lands in the
# watchdog log for a failure that is never escalated.
function Get-TermhubDiagnosticBundle {
  param($Diagnosis, [int]$LogTailLines = 60)
  $d = $Diagnosis
  $t = $d.Topology
  # NOT $L: PowerShell variable names are case-insensitive, so a list called $L and
  # a loop variable called $l are the same variable, and the first `foreach ($l ...)`
  # silently replaces the list with a hashtable.
  $lines = New-Object System.Collections.Generic.List[string]

  $lines.Add("machine:            $env:COMPUTERNAME")
  $lines.Add("time:               $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))")
  $lines.Add("signature:          $($d.Signature)")
  $lines.Add("detail:             $($d.Detail)")
  $lines.Add("")
  $lines.Add("--- topology (from state.json + Serve) ---")
  $lines.Add("mode:               $($t.Mode)   (resolved from: $($t.ModeSource))")
  $lines.Add("sessiond port:      127.0.0.1:$($t.SessiondPort)")
  $lines.Add("active front port:  $($t.FrontPort)")
  $lines.Add("publish port:       $($t.PublishPort)")
  $lines.Add("tailnet IP:         $(if ($t.TailnetIp) { $t.TailnetIp } else { '(none)' })")
  $lines.Add("front should be at: $($t.FrontUrl)")
  $lines.Add("")
  $lines.Add("--- probes ---")
  if ($d.FrontProbe) {
    $lines.Add("GET $($d.FrontProbe.Url)")
    $lines.Add("  reachable=$($d.FrontProbe.Reachable) status=$($d.FrontProbe.StatusCode)")
    if ($d.FrontProbe.Error) { $lines.Add("  error: $($d.FrontProbe.Error)") }
    if ($d.FrontProbe.Body)  { $lines.Add("  body: $($d.FrontProbe.Body)") }
  } else {
    $lines.Add("front not probed (no address to probe in this mode)")
  }
  $lines.Add("GET $($d.SessiondProbe.Url)")
  $lines.Add("  reachable=$($d.SessiondProbe.Reachable) status=$($d.SessiondProbe.StatusCode)")
  if ($d.SessiondProbe.Error) { $lines.Add("  error: $($d.SessiondProbe.Error)") }
  if ($d.SessiondProbe.Body)  { $lines.Add("  body: $($d.SessiondProbe.Body)") }
  $lines.Add("")
  $lines.Add("--- listeners on port $($t.ProbePort) ---")
  if ($d.Listeners.Count -eq 0) { $lines.Add("(none)") }
  foreach ($l in $d.Listeners) { $lines.Add("  $($l.Address):$($t.ProbePort)  pid=$($l.Pid) name=$($l.Name)") }
  $lines.Add("")
  $lines.Add("--- listeners on sessiond port $($t.SessiondPort) ---")
  $sl = Get-PortListeners -Port $t.SessiondPort
  if ($sl.Count -eq 0) { $lines.Add("(none)") }
  foreach ($l in $sl) { $lines.Add("  $($l.Address):$($t.SessiondPort)  pid=$($l.Pid) name=$($l.Name)") }
  $lines.Add("")
  $lines.Add("--- pid files (bookkeeping, never authority) ---")
  foreach ($n in @('sessiond', "front-$($t.PublishPort)", 'front-7001', 'front-7002')) {
    $info = Get-PidInfo $n
    if ($info) {
      $alive = Test-NodeAlive $info.Pid
      $lines.Add("  $n.pid -> pid=$($info.Pid) port=$($info.Port) aliveAsNode=$alive")
    }
  }
  $lines.Add("")
  $lines.Add("--- node processes ---")
  try {
    foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)) {
      $lines.Add("  pid=$($p.ProcessId) started=$($p.CreationDate) cmd=$($p.CommandLine)")
    }
  } catch { $lines.Add("  (could not enumerate: $($_.Exception.Message))") }
  $lines.Add("")
  $lines.Add("--- tailscale ---")
  try { $lines.Add((& tailscale serve status 2>&1 | Out-String).Trim()) } catch { $lines.Add("(serve status failed)") }
  $lines.Add("")
  $lines.Add("--- git HEAD (working tree the tiers run from) ---")
  try {
    Push-Location $ProjectDir
    $lines.Add((& git log -1 --format='%h %ci %s' 2>&1 | Out-String).Trim())
    $status = (& git status --porcelain 2>&1 | Out-String).Trim()
    if ($status) { $lines.Add("DIRTY TREE:"); $lines.Add($status) } else { $lines.Add("tree clean") }
  } catch { $lines.Add("(git failed: $($_.Exception.Message))") } finally { Pop-Location }
  $lines.Add("")
  $lines.Add("--- scheduled tasks ---")
  foreach ($tn in @('Termhub', 'TermhubWatchdog')) {
    try {
      $task = Get-ScheduledTask -TaskName $tn -ErrorAction Stop
      $act = (($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | ')
      $info = Get-ScheduledTaskInfo -TaskName $tn -ErrorAction SilentlyContinue
      $lines.Add("  ${tn}: state=$($task.State) action=$act lastRun=$($info.LastRunTime) lastResult=$($info.LastTaskResult)")
    } catch { $lines.Add("  ${tn}: not registered") }
  }
  $lines.Add("")
  $lines.Add("--- tier logs (<data dir>\logs), newest lines last ---")
  $logDir = Get-TermhubLogDir
  $logs = @(Get-ChildItem $logDir -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 6)
  if ($logs.Count -eq 0) {
    $lines.Add("(no tier logs yet - output redirection was added to Start-TermhubNode; anything")
    $lines.Add(" that died before that landed nowhere, which is why this section exists)")
  }
  foreach ($f in $logs) {
    $lines.Add("")
    $lines.Add("  === $($f.Name)  ($($f.Length) bytes, modified $($f.LastWriteTime)) ===")
    try {
      $tail = Get-Content $f.FullName -Tail $LogTailLines -ErrorAction Stop
      if (-not $tail) { $lines.Add("  (empty)") }
      foreach ($line in $tail) { $lines.Add("  $line") }
    } catch { $lines.Add("  (unreadable: $($_.Exception.Message))") }
  }
  return ($lines -join "`r`n")
}
