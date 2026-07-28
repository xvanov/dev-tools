# termhub safe update (Windows) - deterministic, reversible, terminals survive.
#
# Run from ANY termhub terminal on this machine (your remote-trigger mechanism).
# Because only the front is swapped - sessiond and its PTYs are never touched -
# even the terminal running this script survives the update.
#
# Two deploy shapes, chosen by state.json (activeFrontPort vs publishPort):
#
#   SINGLE-PORT (activeFrontPort == publishPort, the default)
#     The front owns 127.0.0.1:<publishPort> and Serve proxies the same number to
#     it, so ONE port is the answer everywhere: the tailnet URL and
#     http://127.0.0.1:<publishPort> are the same server. Updating means stopping
#     the front and starting the new one on that port - a ~1-2s window where
#     connections are refused, after which browsers reconnect on their own.
#
#   BLUE/GREEN (activeFrontPort in {7001, 7002})
#     The front hides on an alternate loopback port and Serve is re-pointed
#     between them, so the swap is atomic and the previous front stays alive as a
#     rollback target. No downtime, but http://127.0.0.1:<publishPort> is not a
#     working URL - only the tailnet one is. Switch with:
#         .\windows\start.ps1 -BlueGreen      (and -SinglePort to come back)
#
# Either way sessiond is never restarted, so PTYs survive both.
#
#     .\windows\update.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Fail($msg) { Write-Host "termhub update FAILED: $msg" -ForegroundColor Red; exit 1 }

$git = (Get-Command git -ErrorAction SilentlyContinue)
if (-not $git) { Fail "git not found on PATH." }

$state        = Get-TermhubState
$sessiondPort = $state.sessiondPort
$bluePort     = $state.activeFrontPort
$publishPort  = $state.publishPort
$singlePort   = ($bluePort -eq $publishPort)
$greenPort    = if ($bluePort -eq 7001) { 7002 } else { 7001 }

if ($singlePort) {
  Write-Host "termhub update: single-port mode  front=publish=$publishPort  sessiond=$sessiondPort"
} else {
  Write-Host "termhub update: blue=$bluePort  green=$greenPort  sessiond=$sessiondPort  publish=$publishPort"
}

# 0a) Reclaim the publish port from anything that isn't a front. In single-port
# mode the front legitimately owns it and is left alone (Clear-PublishPort decides
# on identity, not mode); what gets removed is a pre-split `node server.js`, which
# served old code on http://127.0.0.1:$publishPort while the tailnet URL for the
# same port served the current front - and shadowed sessiond, which is how an
# update once deployed a fresh front on top of a supervisor from days earlier.
Clear-PublishPort -PublishPort $publishPort -SessiondPort $sessiondPort -ActiveFrontPort $bluePort

# ...and say so if the logon task is what keeps putting it there.
Test-TermhubTask

# 0b) sessiond must be up (start if somehow down - does NOT restart a live one).
# $publishPort is passed so a pre-identity monolith can still be recognised.
$sessiondPort = Confirm-Sessiond -Port $sessiondPort -PublishPort $publishPort
$sessiondBefore = Get-SessiondIdentity -Port $sessiondPort

# 1) Pull, deterministically. Save the current commit for rollback.
$rollback = (& git -C $ProjectDir rev-parse HEAD).Trim()
Write-Host "termhub update: current HEAD $rollback"
& git -C $ProjectDir fetch --quiet
if ($LASTEXITCODE -ne 0) { Fail "git fetch failed." }
$pull = & git -C $ProjectDir pull --ff-only 2>&1
Write-Host $pull
if ($LASTEXITCODE -ne 0) { Fail "git pull --ff-only failed (not a fast-forward, or dirty tree). Nothing changed; blue still serving." }
$newHead = (& git -C $ProjectDir rev-parse HEAD).Trim()
if ($newHead -eq $rollback) { Write-Host "termhub update: already up to date - re-deploying anyway to pick up local changes." }

# 2) Install deps only if the lockfile/manifest changed (front needs no native build).
$changed = & git -C $ProjectDir diff --name-only $rollback $newHead
if ($changed -match 'package(-lock)?\.json') {
  Write-Host "termhub update: dependencies changed -> npm install (no native build)"
  Push-Location $ProjectDir
  try { & npm install --omit=dev --ignore-scripts --no-audit --no-fund } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { & git -C $ProjectDir reset --hard $rollback | Out-Null; Fail "npm install failed; rolled back. Blue still serving." }
}

if ($singlePort) {
  # 3-5) SINGLE-PORT: swap the front in place on the published port.
  #
  # There is no alternate port to stage on, so the old front is stopped first and
  # the new one takes the same socket. That trades the atomic cutover for a
  # ~1-2s window of refused connections - and for a rollback that has to RESTART
  # the previous version instead of just leaving it running. Both are the accepted
  # cost of one port meaning one thing. sessiond is untouched throughout, so no
  # terminal dies and no scrollback is lost; browsers reconnect and replay.
  Write-Host "termhub update: swapping the front in place on 127.0.0.1:$publishPort (brief gap) ..."
  Stop-Front "front-$publishPort"
  $frontProc = Start-VerifiedFront -Port $publishPort -SessiondPort $sessiondPort -ExpectCommit $newHead

  if (-not $frontProc) {
    Write-Host "termhub update: the new front is unhealthy - reverting the tree and restarting the previous one." -ForegroundColor Yellow
    & git -C $ProjectDir reset --hard $rollback | Out-Null
    $back = Start-VerifiedFront -Port $publishPort -SessiondPort $sessiondPort -ExpectCommit $rollback
    if ($back) {
      Fail "new version unhealthy; reverted to $(Format-Commit $rollback) and restarted the front on $publishPort. Terminals untouched."
    }
    Fail ("new version unhealthy AND the reverted front did not come up either - the UI is DOWN. " `
      + "Run: .\windows\start.ps1   (sessiond 127.0.0.1:$sessiondPort is untouched, so the terminals are still there.)")
  }

  # Serve should already point here; re-assert it so a lost or wrong config heals.
  & tailscale serve --bg --https=$publishPort "http://127.0.0.1:$publishPort" 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host "termhub update: could not re-assert Tailscale Serve - the front is up and http://127.0.0.1:$publishPort works," -ForegroundColor Yellow
    Write-Host "termhub update: but the tailnet URL may not. Check: tailscale serve status" -ForegroundColor Yellow
  }
  Set-TermhubState @{ activeFrontPort = $publishPort } | Out-Null
  # Any leftover blue/green fronts from a previous mode would serve stale code.
  foreach ($p in @(7001, 7002)) { if ($p -ne $publishPort) { Stop-Front "front-$p" } }
}
else {
  # 3) BLUE/GREEN: stage the new front on the alternate loopback port.
  Stop-Front "front-$greenPort"
  $greenProc = Start-VerifiedFront -Port $greenPort -SessiondPort $sessiondPort -ExpectCommit $newHead

  # 4) On any failure green is already stopped; blue never stopped serving.
  if (-not $greenProc) {
    Write-Host "termhub update: green failed verification - rolling back." -ForegroundColor Yellow
    & git -C $ProjectDir reset --hard $rollback | Out-Null
    Fail "new version unhealthy; reverted tree to $rollback. Blue (port $bluePort) still serving - terminals untouched."
  }

  # 5) Cut over: re-point Tailscale Serve to green (atomic), record state, stop blue.
  Write-Host "termhub update: green healthy - re-pointing Tailscale Serve to 127.0.0.1:$greenPort"
  & tailscale serve --bg --https=$publishPort "http://127.0.0.1:$greenPort" 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host "termhub update: tailscale serve re-point failed - rolling back." -ForegroundColor Yellow
    Stop-Front "front-$greenPort"
    & git -C $ProjectDir reset --hard $rollback | Out-Null
    Fail "could not re-point Tailscale Serve; blue (port $bluePort) still serving."
  }
  Set-TermhubState @{ activeFrontPort = $greenPort } | Out-Null
  Stop-Front "front-$bluePort"
}

# 5b) Report sessiond drift. sessiond is deliberately NOT restarted - that's what
# keeps the PTYs (including this terminal) alive - so after a pull that touched
# sessiond-side code the supervisor is legitimately behind the working tree. That
# is normal and must never fail an update, but it has to be SAID: otherwise the
# update reads as "deployed" while the tier doing the work still runs old code,
# which is indistinguishable from a fix that didn't work.
$sessiondCommit = if ($sessiondBefore) { $sessiondBefore.commit } else { $null }
$sessiondDirty  = if ($sessiondBefore) { $sessiondBefore.dirty } else { $false }
# A sessiond started from a MODIFIED tree counts as drifted even at the same HEAD:
# whatever it loaded isn't the committed code, so no commit describes it.
if ($sessiondCommit -and (($sessiondCommit -ne $newHead) -or ($sessiondDirty -eq $true))) {
  # Diff from what SESSIOND IS RUNNING to the new HEAD - not from this update's
  # rollback ref. A supervisor that sat through five updates is behind by all of
  # them, and "nothing sessiond-side changed in THIS update" is true and useless
  # in that case: the restart is owed for the accumulated drift, not for one pull.
  $drift = & git -C $ProjectDir diff --name-only $sessiondCommit $newHead 2>$null
  $driftKnown = ($LASTEXITCODE -eq 0)
  # Owe the restart unless it can be PROVEN unnecessary: an unknown commit (never
  # fetched, or rewritten history) and a modified tree are both uncomparable, and
  # staying quiet about those is how drift goes unnoticed for days.
  $why = ''
  if ($sessiondDirty -eq $true) { $why = 'it was started from a modified tree, so no commit describes what it loaded' }
  elseif (-not $driftKnown) { $why = "that commit isn't in this checkout, so the difference can't be compared" }
  elseif ($drift -match 'sessiond\.js|(^|/)lib/') { $why = 'sessiond-side files have changed since then' }

  Write-Host ""
  if ($why) {
    Write-Host "termhub update: sessiond runs $(Format-Commit $sessiondCommit $sessiondDirty) - $why." -ForegroundColor Yellow
    Write-Host "termhub update: the front is current; PTY/session behaviour may not be. To pick it up," -ForegroundColor Yellow
    Write-Host "termhub update: from a NON-termhub window (this ends live terminals; they become Restorable):" -ForegroundColor Yellow
    Write-Host "termhub update:   .\windows\restart-sessiond.ps1" -ForegroundColor Yellow
  } else {
    Write-Host "termhub update: sessiond runs $(Format-Commit $sessiondCommit) - older than HEAD, but nothing"
    Write-Host "termhub update: sessiond-side changed since then, so a restart would buy nothing."
  }
}

# 6) Update the Claude Code CLI too. termhub's Claude integration is
# version-coupled (see lib/claudeCli.js): it pins conversations with
# --session-id, resumes them with --resume, and parses the on-disk transcript.
# A machine that updates only termhub drifts away from the CLI termhub was
# tested against - which is how session restore came to work on one machine and
# not another. Runs LAST and never fails the update: termhub is already serving
# green by this point, and an offline or rate-limited `claude update` is a
# warning, not a rollback. Open terminals keep the CLI build they started with.
$claude = (Get-Command claude -ErrorAction SilentlyContinue)
if (-not $claude) {
  Write-Host "termhub update: claude CLI not on PATH - skipping CLI update." -ForegroundColor Yellow
} else {
  # Drop out of the script's $ErrorActionPreference='Stop' for this step only.
  # Under Stop, a native command writing anything to stderr can be promoted to a
  # terminating error - and `claude update` legitimately chats on stderr, which
  # would abort a step that is supposed to be unable to fail.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $before = (& claude --version) 2>$null
    Write-Host "termhub update: updating Claude Code CLI (currently $before)"
    & claude update
    if ($LASTEXITCODE -ne 0) {
      Write-Host "termhub update: claude update exited $LASTEXITCODE - continuing." -ForegroundColor Yellow
    } else {
      $after = (& claude --version) 2>$null
      Write-Host "termhub update: claude CLI now $after"
    }
  } catch {
    Write-Host "termhub update: claude update failed ($($_.Exception.Message)) - continuing." -ForegroundColor Yellow
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

$servingPort = if ($singlePort) { $publishPort } else { $greenPort }
$dns = ''
try { $dns = ((& tailscale status --json 2>$null | ConvertFrom-Json).Self.DNSName).TrimEnd('.') } catch { }

Write-Host ""
Write-Host "termhub update OK: front 127.0.0.1:$servingPort at HEAD $(Format-Commit $newHead)." -ForegroundColor Green
if ($dns) { Write-Host "  https://${dns}:${publishPort}/" -ForegroundColor Green }
if ($singlePort) { Write-Host "  http://127.0.0.1:$publishPort/" -ForegroundColor Green }
Write-Host "Open terminals reconnect automatically to the same sessions (sessiond 127.0.0.1:$sessiondPort)."
