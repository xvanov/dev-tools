# termhub watchdog - keep termhub up, and get smarter every time it goes down.
#
#   .\watchdog\watchdog.ps1                 # one cycle (what the scheduled task runs)
#   .\watchdog\watchdog.ps1 -Loop           # stay in the foreground, probe every 60s
#   .\watchdog\watchdog.ps1 -Once -NoEscalate   # probe + remedy only, never call the LLM
#   .\watchdog\watchdog.ps1 -Probe          # report and exit; change nothing
#
# THE CYCLE
#
#   probe -> healthy?                       -> done
#         -> a deploy is running?           -> stand down (it owns the port right now)
#         -> confirm it 3x over ~15s        -> a front swap is a 1-2s gap, not an outage
#         -> remedies\<signature>.ps1?      -> run it, then VERIFY independently
#         -> still down?                    -> escalate to Claude Code, which fixes it
#                                              AND writes remedies\<signature>.ps1 so
#                                              the next occurrence never gets here
#
# That last step is the whole design: the LLM is the fallback, not the mechanism. Its
# job is to convert a novel outage into a deterministic script, so the remedy library
# accumulates and escalations get rarer. A signature that has been seen before is
# repaired in about a second by a script with no model in the loop at all.
#
# WHAT IT WILL NOT DO
#
#   - restart sessiond to fix a front problem. sessiond holds every live terminal as
#     an in-memory PTY; restarting it ends the user's running work and the sessions
#     come back only as Restorable. Only signatures that say sessiond is already gone
#     may start one.
#   - kill an unrecognised process to free a port (see publish-port-squatted).
#   - escalate in a loop. Cooldowns below.
#
# Kill switch: create <data dir>\watchdog\DISABLED, or set TERMHUB_WATCHDOG_DISABLED=1.

param(
  [switch]$Loop,
  [switch]$Once,
  [switch]$Probe,
  [switch]$NoEscalate,
  [switch]$NoRemedy,
  [switch]$TestClaude,
  [int]$IntervalSec        = 60,
  [int]$Confirmations      = 3,
  [int]$ConfirmDelaySec    = 5,
  [int]$RemedyTimeoutSec   = 120,
  [int]$EscalateTimeoutSec = 900,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$WatchdogDir = $PSScriptRoot
. (Join-Path $WatchdogDir '..\windows\common.ps1')
. (Join-Path $WatchdogDir 'lib\diagnose.ps1')

# Escalation budget. Generous enough to fix a real outage, tight enough that a
# failure the LLM cannot fix does not become a model running every two minutes
# forever. A crash-loop is a thing to report, not a thing to keep paying for.
$MinGapMinutes     = 10
$MaxPerHour        = 3
$MaxPerDay         = 8

function Get-WatchdogDir {
  $d = Join-Path (Get-TermhubDataDir) 'watchdog'
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  return $d
}

$LogFile     = Join-Path (Get-WatchdogDir) 'watchdog.log'
$LedgerFile  = Join-Path (Get-WatchdogDir) 'escalations.json'
$DisableFile = Join-Path (Get-WatchdogDir) 'DISABLED'

function Write-Log {
  param([string]$Message, [string]$Level = 'info')
  $line = "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) [$Level] $Message"
  try {
    Add-Content -Path $LogFile -Value $line -Encoding utf8 -ErrorAction Stop
    # The log is the watchdog's only output when it runs from a scheduled task, so
    # cap it rather than let it grow without bound on a machine that flaps.
    $fi = Get-Item $LogFile -ErrorAction SilentlyContinue
    if ($fi -and $fi.Length -gt 4MB) {
      Move-Item -LiteralPath $LogFile -Destination "$LogFile.prev" -Force -ErrorAction SilentlyContinue
    }
  } catch { }
  if (-not $Quiet) {
    $color = switch ($Level) { 'error' { 'Red' } 'warn' { 'Yellow' } 'ok' { 'Green' } default { 'Gray' } }
    Write-Host $line -ForegroundColor $color
  }
}

# ---- escalation ledger ------------------------------------------------------

function Get-Ledger {
  if (-not (Test-Path $LedgerFile)) { return @() }
  try {
    $j = Get-Content $LedgerFile -Raw | ConvertFrom-Json
    if ($null -eq $j) { return @() }
    return @($j)
  } catch { return @() }
}

function Add-LedgerEntry {
  param([string]$Signature, [string]$Outcome, [string]$Note = '')
  $entries = @(Get-Ledger)
  $entries += [pscustomobject]@{
    at        = (Get-Date).ToString('o')
    signature = $Signature
    outcome   = $Outcome
    note      = $Note
    machine   = $env:COMPUTERNAME
  }
  # Keep the tail only; this is a rate-limit input and a history for humans, not
  # an archive.
  if ($entries.Count -gt 200) { $entries = $entries[-200..-1] }
  try { ($entries | ConvertTo-Json -Depth 4) | Set-Content -Path $LedgerFile -Encoding utf8 } catch { }
}

# Is escalation allowed right now? Returns '' when yes, or the reason it is not.
function Test-EscalationBudget {
  $now = Get-Date
  $escalations = @(Get-Ledger | Where-Object { $_.outcome -ne 'remedy-fixed' -and $_.at })
  $times = @()
  foreach ($e in $escalations) {
    try { $times += [datetime]::Parse($e.at) } catch { }
  }
  if ($times.Count -eq 0) { return '' }
  $last = ($times | Sort-Object -Descending)[0]
  $gap = ($now - $last).TotalMinutes
  if ($gap -lt $MinGapMinutes) {
    return ("last escalation was {0:N1} min ago; minimum gap is $MinGapMinutes min" -f $gap)
  }
  $inHour = @($times | Where-Object { ($now - $_).TotalHours -lt 1 }).Count
  if ($inHour -ge $MaxPerHour) { return "$inHour escalations in the last hour (max $MaxPerHour)" }
  $inDay = @($times | Where-Object { ($now - $_).TotalDays -lt 1 }).Count
  if ($inDay -ge $MaxPerDay) { return "$inDay escalations in the last 24h (max $MaxPerDay)" }
  return ''
}

# ---- verification ----------------------------------------------------------

# Poll until termhub is healthy, or give up. Used after every repair attempt: a
# remedy's exit code is a claim, not proof - the same reason Start-VerifiedFront
# re-checks identity instead of trusting that the port answers.
function Wait-TermhubHealthy {
  param([int]$TimeoutSec = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    $last = Get-TermhubDiagnosis
    if ($last.Healthy) { return $last }
    Start-Sleep -Seconds 2
  }
  return $last
}

# ---- remedies --------------------------------------------------------------

# Wait for a process and get its exit code.
#
# The timed WaitForExit($ms) overload returns whether the process ended, but leaves
# the object's cached state unfinalised - reading .ExitCode straight after it yields
# $null, which reads in a log as "exited " with no code at all. The parameterless
# overload (safe once the timed one has returned $true) plus a Refresh() is what
# actually populates it.
function Wait-ProcExit {
  param($Proc, [int]$TimeoutSec)
  if (-not $Proc.WaitForExit($TimeoutSec * 1000)) { return @{ Finished = $false; ExitCode = $null } }
  try { $Proc.WaitForExit() } catch { }
  $code = $null
  try { $Proc.Refresh(); $code = $Proc.ExitCode } catch { }
  return @{ Finished = $true; ExitCode = $code }
}

function Format-ExitCode {
  param($Code)
  if ($null -eq $Code) { return 'unknown' }
  return "$Code"
}

function Get-RemedyPath {
  param([string]$Signature)
  $p = Join-Path (Join-Path $WatchdogDir 'remedies') "$Signature.ps1"
  if (Test-Path $p) { return $p }
  return $null
}

# Run a remedy in its OWN process, so a remedy that hangs or throws cannot take the
# watchdog with it, and so a timeout is enforceable.
function Invoke-Remedy {
  param([string]$Path, $Diagnosis)
  $t = $Diagnosis.Topology
  $outFile = Join-Path (Get-WatchdogDir) 'last-remedy.out.log'
  $errFile = Join-Path (Get-WatchdogDir) 'last-remedy.err.log'
  $args = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Path,
    '-Signature',    $Diagnosis.Signature,
    '-Mode',         $t.Mode,
    '-PublishPort',  $t.PublishPort,
    '-FrontPort',    $t.FrontPort,
    '-SessiondPort', $t.SessiondPort,
    '-TailnetIp',    "$($t.TailnetIp)"
  )
  try {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WorkingDirectory $ProjectDir `
      -WindowStyle Hidden -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    try { $null = $p.Handle } catch { }   # see Wait-ProcExit / Start-TermhubNode
  } catch {
    return @{ ExitCode = $null; TimedOut = $false; Error = $_.Exception.Message; Out = ''; Err = '' }
  }
  $w = Wait-ProcExit -Proc $p -TimeoutSec $RemedyTimeoutSec
  if (-not $w.Finished) {
    try { $p.Kill() } catch { }
    return @{ ExitCode = $null; TimedOut = $true; Error = "remedy exceeded ${RemedyTimeoutSec}s"; Out = ''; Err = '' }
  }
  $out = ''; $err = ''
  try { $out = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue) } catch { }
  try { $err = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue) } catch { }
  return @{ ExitCode = $w.ExitCode; TimedOut = $false; Error = ''; Out = "$out"; Err = "$err" }
}

# ---- the LLM escalation ----------------------------------------------------

# Where is the Claude CLI, and how must it be launched?
#
# Mirrors lib/claudeCli.js's lookup order, but has to answer a question Node does
# not: the npm global install is a .cmd/.ps1 shim, and a shim cannot be started the
# way an .exe can. So this returns a launch strategy along with the path.
function Resolve-ClaudeLauncher {
  $candidates = @()
  if ($env:TERMHUB_CLAUDE_BIN) { $candidates += $env:TERMHUB_CLAUDE_BIN }
  $appdata = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME 'AppData\Roaming' }
  $local   = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  $candidates += (Join-Path $local 'Programs\claude\claude.exe')
  $candidates += (Join-Path $HOME '.local\bin\claude.exe')
  $candidates += (Join-Path $appdata 'npm\claude.cmd')
  $cmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }

  foreach ($c in $candidates) {
    if (-not $c) { continue }
    if (-not (Test-Path $c)) { continue }
    $ext = [IO.Path]::GetExtension($c).ToLowerInvariant()
    if ($ext -eq '.exe')                    { return @{ Bin = $c; Kind = 'exe' } }
    if ($ext -eq '.cmd' -or $ext -eq '.bat') { return @{ Bin = $c; Kind = 'cmd' } }
    if ($ext -eq '.ps1')                    { return @{ Bin = $c; Kind = 'ps1' } }
  }
  return $null
}

function New-EscalationPrompt {
  param($Diagnosis, [string]$Bundle, [string]$RemedyNote)
  $t = $Diagnosis.Topology
  $sig = $Diagnosis.Signature
  $remedyPath = "termhub/watchdog/remedies/$sig.ps1"

  $sessiondRule = if ($sig -eq 'both-down' -or $sig -eq 'sessiond-down-front-up') {
    "This signature says sessiond is ALREADY DOWN, so starting one is in scope. Use windows\Confirm-Sessiond via the existing scripts rather than launching node by hand, and understand that the previous PTYs are gone - they return as *Restorable*, which is expected and correct here."
  } else {
    "sessiond is UP and it owns every live terminal as an in-memory PTY. DO NOT restart, kill, or otherwise disturb it - that would destroy the user's running work to fix a problem it is not part of. Only the front tier may be replaced."
  }

  return @"
You are the termhub watchdog's escalation path, running UNATTENDED on $env:COMPUTERNAME.
No human is watching. Nobody will answer a question. Finish the job or fail loudly.

termhub is DOWN. $RemedyNote

FAILURE SIGNATURE: $sig
$($Diagnosis.Detail)

=========================== DIAGNOSTIC BUNDLE ===========================
$Bundle
=========================================================================

Your working directory is the dev-tools repo. termhub's own docs are the map:
read termhub/AGENT.md (the two-tier sessiond/front layout, the three port modes,
and a troubleshooting matrix) and termhub/watchdog/README.md before you act. Do
not re-derive from scratch what those files already explain.

DO THESE FOUR THINGS, IN ORDER.

1) FIX THE OUTAGE.
   $sessiondRule
   - Prefer termhub's existing scripts over ad-hoc commands: windows\start-http.ps1
     (plain-HTTP mode), windows\restart-front.ps1 (mode-preserving front redeploy),
     windows\start.ps1. This machine resolved as mode '$($t.Mode)' (from
     $($t.ModeSource)).
   - Never kill a process you have not identified. An unrecognised listener is far
     more likely to be something else on this machine than a termhub tier.
   - VERIFY: GET $($t.FrontUrl)/api/health must return ok:true with self.entry
     == 'front', and the sessiond block must report ok:true. Do not declare success
     on a port merely answering.

2) WRITE THE REMEDY: $remedyPath
   This is the point of the exercise. The next time this signature occurs, that
   script runs INSTEAD of you - no model, no waiting. Read
   termhub/watchdog/remedies/README.md and follow the contract exactly (parameters,
   exit codes, idempotence, the 60-second budget, no interactive prompts, no
   sessiond restarts unless the signature allows it).
   - If $remedyPath ALREADY EXISTS, it ran and did not fix this. Improve it in
     place, and leave a comment saying what it missed and why the new version
     catches it. Do not create a variant filename.
   - Encode the fix you just performed, generalised - re-derive ports, mode and the
     tailnet IP from the parameters rather than hardcoding today's values.

3) LEAVE THE TREE CLEAN. Commit and push to main.
   This is not bookkeeping: termhub deploys by 'git pull --ff-only' (see
   windows/update.ps1) which FAILS ON A DIRTY TREE, so uncommitted work here blocks
   every future update on every machine. Follow the repo agreement in CLAUDE.md -
   Conventional Commits, scoped 'fix(termhub):' or 'feat(termhub):', body explaining
   the failure this prevents, and the Co-Authored-By trailer. If the push fails, say
   so explicitly in your summary. Update termhub/AGENT.md in the same commit if
   anything you learned makes a statement in it false.

4) REPORT. End with a short plain-text summary: the root cause (say "unknown" if the
   evidence does not support a conclusion - do not invent one), what you changed to
   restore service, the remedy you wrote, and whether the commit and push succeeded.

CONSTRAINTS
   - Change nothing unrelated to this outage. No refactors, no drive-by cleanups.
   - Do not register scheduled tasks and do not modify the watchdog's own cycle.
   - If you cannot fix it, still do steps 2-4: write down what you ruled out, as a
     comment in the remedy or a note in AGENT.md, so the next escalation starts
     ahead of where you did.
"@
}

# $PromptOverride exists so -TestClaude can exercise this exact spawn path with a
# trivial prompt. The launcher resolution, the cmd.exe quoting for an npm .cmd shim,
# the stdin redirect and the exit-code handling are the parts most likely to be
# quietly broken, and an escalation path that has never been run is not a safety net.
function Invoke-Escalation {
  param($Diagnosis, [string]$Bundle, [string]$RemedyNote, [string]$PromptOverride = '')
  $launcher = Resolve-ClaudeLauncher
  if (-not $launcher) {
    Write-Log "cannot escalate: the Claude CLI was not found (set TERMHUB_CLAUDE_BIN)." 'error'
    return @{ ExitCode = $null; TimedOut = $false; Out = ''; Err = 'claude not found' }
  }

  $stamp      = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $dir        = Get-WatchdogDir
  $promptFile = Join-Path $dir "escalation-$stamp.prompt.txt"
  $outFile    = Join-Path $dir "escalation-$stamp.out.txt"
  $errFile    = Join-Path $dir "escalation-$stamp.err.txt"

  if ($PromptOverride) { $prompt = $PromptOverride }
  else { $prompt = New-EscalationPrompt -Diagnosis $Diagnosis -Bundle $Bundle -RemedyNote $RemedyNote }
  Set-Content -Path $promptFile -Value $prompt -Encoding utf8

  $what = if ($PromptOverride) { 'launcher self-test' } else { 'escalating to Claude Code' }
  Write-Log "${what} ($($launcher.Bin), kind=$($launcher.Kind)); prompt: $promptFile" 'warn'

  $claudeArgs = '-p --dangerously-skip-permissions'
  switch ($launcher.Kind) {
    'exe' { $file = $launcher.Bin;   $argList = @('-p', '--dangerously-skip-permissions') }
    'cmd' {
      # cmd.exe needs the whole command wrapped in one extra pair of quotes for a
      # path containing spaces to survive; the inner quotes are what it keeps.
      $file = $env:ComSpec
      $argList = @('/d', '/c', "`"`"$($launcher.Bin)`" $claudeArgs`"")
    }
    'ps1' { $file = 'powershell.exe'; $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher.Bin, '-p', '--dangerously-skip-permissions') }
  }

  # Claude Code refuses to write a transcript when it believes it is a child of
  # another Claude session, and an escalation with no transcript is an escalation
  # nobody can audit. lib/session.js scrubs the same variables from every PTY
  # termhub spawns; do it here too, since the watchdog may be run by hand from
  # inside a Claude session.
  $scrub = @('CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID')
  $saved = @{}
  foreach ($k in $scrub) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  $saved['TERMHUB_WATCHDOG_ESCALATION'] = [Environment]::GetEnvironmentVariable('TERMHUB_WATCHDOG_ESCALATION')
  $env:TERMHUB_WATCHDOG_ESCALATION = '1'

  try {
    $p = Start-Process -FilePath $file -ArgumentList $argList -WorkingDirectory (Split-Path $ProjectDir -Parent) `
      -WindowStyle Hidden -PassThru `
      -RedirectStandardInput $promptFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    try { $null = $p.Handle } catch { }   # see Wait-ProcExit
  } catch {
    foreach ($k in $saved.Keys) { if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } else { Set-Item "Env:$k" -Value $saved[$k] } }
    Write-Log "could not start the Claude CLI: $($_.Exception.Message)" 'error'
    return @{ ExitCode = -1; TimedOut = $false; Out = ''; Err = $_.Exception.Message }
  }

  $w = Wait-ProcExit -Proc $p -TimeoutSec $EscalateTimeoutSec
  foreach ($k in $saved.Keys) { if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } else { Set-Item "Env:$k" -Value $saved[$k] } }

  if (-not $w.Finished) {
    try { $p.Kill() } catch { }
    Write-Log "the escalation exceeded ${EscalateTimeoutSec}s and was killed; transcript: $outFile" 'error'
    return @{ ExitCode = $null; TimedOut = $true; Out = ''; Err = 'timeout'; OutFile = $outFile }
  }
  $out = ''; $err = ''
  try { $out = "$(Get-Content $outFile -Raw -ErrorAction SilentlyContinue)" } catch { }
  try { $err = "$(Get-Content $errFile -Raw -ErrorAction SilentlyContinue)" } catch { }
  return @{ ExitCode = $w.ExitCode; TimedOut = $false; Out = $out; Err = $err; OutFile = $outFile }
}

# ---- one cycle -------------------------------------------------------------

function Invoke-WatchdogCycle {
  if ((Test-Path $DisableFile) -or $env:TERMHUB_WATCHDOG_DISABLED -eq '1') {
    Write-Log "disabled (remove $DisableFile to re-enable); no action taken." 'warn'
    return
  }

  $d = Get-TermhubDiagnosis
  if ($d.Healthy) {
    if (-not $Quiet) { Write-Log "healthy: $($d.Topology.FrontUrl) ($($d.Topology.Mode) mode), sessiond $($d.SessiondProbe.Json.sessions) session(s)" 'ok' }
    return
  }

  $maint = Test-TermhubMaintenance
  if ($maint) {
    Write-Log "standing down: a deploy script is running and owns the port right now - $maint" 'warn'
    return
  }

  Write-Log "probe failed: $($d.Signature) - $($d.Detail)" 'warn'

  # Confirm before acting. A single-port or plain-HTTP front swap is a real gap of
  # about a second, and reacting to it would put the watchdog in a fight with the
  # updater over the same socket.
  for ($i = 2; $i -le $Confirmations; $i++) {
    Start-Sleep -Seconds $ConfirmDelaySec
    $d = Get-TermhubDiagnosis
    if ($d.Healthy) {
      Write-Log "recovered on its own after $((($i - 1) * $ConfirmDelaySec))s (probe $i/$Confirmations) - a transient gap, not an outage." 'ok'
      return
    }
    Write-Log "confirmation $i/${Confirmations}: still $($d.Signature)" 'warn'
  }

  $bundle = Get-TermhubDiagnosticBundle -Diagnosis $d
  Write-Log "confirmed outage. signature=$($d.Signature)`r`n$bundle"

  # 1) A known failure: fix it with a script and never wake the model.
  $remedyNote = "No remedy script exists for this signature yet, so you are the first responder."
  if (-not $NoRemedy) {
    $remedy = Get-RemedyPath -Signature $d.Signature
    if ($remedy) {
      Write-Log "running remedy $remedy" 'warn'
      $r = Invoke-Remedy -Path $remedy -Diagnosis $d
      $tail = (("$($r.Out)`r`n$($r.Err)").Trim() -split "`r?`n" | Select-Object -Last 20) -join '; '
      $rc = Format-ExitCode $r.ExitCode
      Write-Log "remedy exited $rc$(if ($r.TimedOut) { ' (TIMED OUT)' }): $tail"
      $after = Wait-TermhubHealthy -TimeoutSec 30
      if ($after.Healthy) {
        Write-Log "RECOVERED by remedy $([IO.Path]::GetFileName($remedy)) - no LLM needed." 'ok'
        Add-LedgerEntry -Signature $d.Signature -Outcome 'remedy-fixed' -Note "exit $rc"
        return
      }
      Write-Log "the remedy did not restore service (now: $($after.Signature))." 'error'
      $remedyNote = "The existing remedy script remedies\$($d.Signature).ps1 ran and FAILED to restore service (exit $rc$(if ($r.TimedOut) { ', timed out' })). Its output was: $tail"
      $d = $after
      $bundle = Get-TermhubDiagnosticBundle -Diagnosis $d
    }
  }

  # 2) Unknown, or the script was not enough: put a model on it, and make it leave a
  #    script behind.
  if ($NoEscalate) {
    Write-Log "escalation suppressed (-NoEscalate). termhub is still down: $($d.Signature)" 'error'
    Add-LedgerEntry -Signature $d.Signature -Outcome 'not-escalated' -Note 'NoEscalate'
    return
  }
  $blocked = Test-EscalationBudget
  if ($blocked) {
    Write-Log "NOT escalating: $blocked. termhub is still down ($($d.Signature)) and needs a human." 'error'
    Add-LedgerEntry -Signature $d.Signature -Outcome 'budget-blocked' -Note $blocked
    return
  }

  $e = Invoke-Escalation -Diagnosis $d -Bundle $bundle -RemedyNote $remedyNote
  $summary = (("$($e.Out)").Trim() -split "`r?`n" | Select-Object -Last 25) -join "`r`n"
  if ($summary) { Write-Log "Claude Code said:`r`n$summary" }

  $ec = Format-ExitCode $e.ExitCode
  $after = Wait-TermhubHealthy -TimeoutSec 30
  if ($after.Healthy) {
    Write-Log "RECOVERED after escalation (claude exit $ec)." 'ok'
    Add-LedgerEntry -Signature $d.Signature -Outcome 'llm-fixed' -Note "claude exit $ec"
    $wrote = Get-RemedyPath -Signature $d.Signature
    if ($wrote) { Write-Log "a remedy now exists for '$($d.Signature)': $wrote - the next occurrence self-heals." 'ok' }
    else { Write-Log "service is back but NO remedy was written for '$($d.Signature)'; the next occurrence will escalate again." 'warn' }
  } else {
    Write-Log "STILL DOWN after escalation: $($after.Signature). claude exit $ec; transcript: $($e.OutFile)" 'error'
    Add-LedgerEntry -Signature $d.Signature -Outcome 'llm-failed' -Note "claude exit $ec"
  }
}

# ---- entrypoint ------------------------------------------------------------

# Is the escalation path actually wired up? Runs the real spawn code with a trivial
# prompt: no ledger entry, no budget consumed, termhub untouched.
if ($TestClaude) {
  $l = Resolve-ClaudeLauncher
  if (-not $l) {
    Write-Host "claude NOT found - escalation would be impossible. Set TERMHUB_CLAUDE_BIN." -ForegroundColor Red
    exit 1
  }
  Write-Host "launcher: $($l.Bin)  (kind=$($l.Kind))"
  $e = Invoke-Escalation -Diagnosis $null -Bundle '' -RemedyNote '' `
    -PromptOverride 'Reply with exactly the word READY and nothing else. Do not use any tools.'
  Write-Host "exit code: $(Format-ExitCode $e.ExitCode)   timedOut: $($e.TimedOut)"
  Write-Host "stdout:    $(("$($e.Out)").Trim())"
  if (("$($e.Err)").Trim()) { Write-Host "stderr:    $(("$($e.Err)").Trim())" -ForegroundColor Yellow }
  if (("$($e.Out)") -match 'READY') { Write-Host "escalation path is ARMED." -ForegroundColor Green }
  else { Write-Host "the CLI did not answer as expected - escalation may not work." -ForegroundColor Red }
  return
}

if ($Probe) {
  $d = Get-TermhubDiagnosis
  Write-Host ""
  Write-Host "signature: $($d.Signature)" -ForegroundColor $(if ($d.Healthy) { 'Green' } else { 'Yellow' })
  if ($d.Detail) { Write-Host "detail:    $($d.Detail)" }
  Write-Host ""
  Write-Host (Get-TermhubDiagnosticBundle -Diagnosis $d)
  if (-not $d.Healthy) {
    $r = Get-RemedyPath -Signature $d.Signature
    Write-Host ""
    Write-Host "remedy for this signature: $(if ($r) { $r } else { '(none - this one would escalate to Claude Code)' })"
  }
  return
}

if ($Loop) {
  Write-Log "watchdog loop starting (every ${IntervalSec}s). Ctrl-C to stop."
  while ($true) {
    try { Invoke-WatchdogCycle } catch { Write-Log "cycle threw: $($_.Exception.Message)" 'error' }
    Start-Sleep -Seconds $IntervalSec
  }
}

try { Invoke-WatchdogCycle } catch { Write-Log "cycle threw: $($_.Exception.Message)" 'error'; exit 1 }
