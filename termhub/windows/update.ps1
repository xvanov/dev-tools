# termhub safe update (Windows) - deterministic, reversible, terminals survive.
#
# Run from ANY termhub terminal on this machine (your remote-trigger mechanism).
# Because only the front is swapped - sessiond and its PTYs are never touched -
# even the terminal running this script survives the update.
#
# THREE deploy shapes share state.json, and it only distinguishes one of them
# (see restart-front.ps1 for the full writeup - this mirrors it):
#
#   SINGLE-PORT (activeFrontPort == publishPort, Serve publishes it)
#     The front owns 127.0.0.1:<publishPort> and Serve proxies the same number to
#     it, so ONE port is the answer everywhere: the tailnet URL and
#     http://127.0.0.1:<publishPort> are the same server. Updating means stopping
#     the front and starting the new one on that port - a ~1-2s window where
#     connections are refused, after which browsers reconnect on their own.
#
#   PLAIN-HTTP (activeFrontPort == publishPort, Serve is OFF - start-http.ps1)
#     The front binds the tailnet IP directly and there is no Serve in front of
#     it. Recorded IDENTICALLY to single-port in state.json, so the mode is read
#     from Tailscale Serve's own config (Test-ServePublished), not from the port
#     numbers. Getting this wrong is a real incident this script caused: treating
#     equal ports as single-port unconditionally starts the new front on
#     127.0.0.1 (not the tailnet IP) and force-enables Serve on the publish port
#     - both wrong here, and together they leave the front reachable only on
#     loopback while Serve's HTTPS listener takes over the tailnet address the
#     front used to own. A plain http:// request to that address then hits a TLS
#     endpoint and fails with "Client sent an HTTP request to an HTTPS server."
#
#   BLUE/GREEN (activeFrontPort in {7001, 7002})
#     The front hides on an alternate loopback port and Serve is re-pointed
#     between them, so the swap is atomic and the previous front stays alive as a
#     rollback target. No downtime, but http://127.0.0.1:<publishPort> is not a
#     working URL - only the tailnet one is. Switch with:
#         .\windows\start.ps1 -BlueGreen      (and -SinglePort to come back)
#
# Either way sessiond is never restarted, so PTYs survive all three.
#
#     .\windows\update.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot '..\watchdog\lib\task.ps1')

function Fail($msg) { Write-Host "termhub update FAILED: $msg" -ForegroundColor Red; exit 1 }

# Self-healing a diverged branch. The exact counterpart of heal_diverged_history()
# in linux/update.sh; that file carries the long writeup and this one must not drift
# from it. The short version:
#
# A --ff-only pull that refuses is either (a) upstream history rewritten and
# force-pushed from another machine, leaving this checkout holding patch-identical
# twins of upstream commits under stale shas - nothing of its own, nothing at risk,
# but permanently unable to update again; or (b) real unpushed commits, or a dirty
# tree, either of which a reset would destroy. Only (a) is healed here. The question
# that separates them is `git log --cherry-pick --right-only <upstream>...HEAD`:
# local commits whose PATCH appears nowhere upstream. Empty means the local lineage
# is a duplicate and resetting onto upstream loses nothing.
#
# Returns $true when HEAD now equals upstream and the update may continue.
function Repair-DivergedHistory {
  $upstream = (& git -C $ProjectDir rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $upstream) {
    $branch = (& git -C $ProjectDir rev-parse --abbrev-ref HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $branch -or $branch.Trim() -eq 'HEAD') {
      Write-Host "termhub update: no upstream branch is configured, so there is nothing to reset onto."
      return $false
    }
    $upstream = "origin/$($branch.Trim())"
  }
  $upstream = $upstream.Trim()

  # Dirty first - it needs no network and disqualifies the heal on its own.
  $dirty = & git -C $ProjectDir status --porcelain 2>$null
  if ($dirty) {
    Write-Host "termhub update: the working tree has local changes, which is enough on its own to"
    Write-Host "termhub update: make the pull fail. Commit or stash them, then update again."
    return $false
  }

  # left = upstream-only (behind), right = HEAD-only (ahead). Only a genuine
  # divergence is in scope; anything else means the pull failed for a reason this
  # function cannot see, and guessing would be worse than reporting.
  $counts = (& git -C $ProjectDir rev-list --left-right --count "$upstream...HEAD" 2>$null)
  $parts  = if ($counts) { ($counts -split '\s+') | Where-Object { $_ -ne '' } } else { @() }
  if ($parts.Count -lt 2) {
    Write-Host "termhub update: could not compare HEAD with $upstream, so the divergence cannot be judged."
    return $false
  }
  $behind = [int]$parts[0]
  $ahead  = [int]$parts[1]
  if ($ahead -eq 0 -or $behind -eq 0) {
    Write-Host "termhub update: HEAD is not diverged from $upstream (behind $behind, ahead $ahead), so the"
    Write-Host "termhub update: pull failed for some other reason - check its output above."
    return $false
  }

  $unique = & git -C $ProjectDir log --cherry-pick --right-only --oneline "$upstream...HEAD" 2>$null
  if ($unique) {
    Write-Host "termhub update: history diverged from $upstream AND these local commits exist nowhere upstream:"
    $unique | ForEach-Object { Write-Host "termhub update:     $_" }
    Write-Host "termhub update: resetting would destroy them, so nothing was changed. Push them (or drop"
    Write-Host "termhub update: them deliberately), then update again."
    return $false
  }

  $before = (& git -C $ProjectDir rev-parse --short HEAD).Trim()
  Write-Host "termhub update: history diverged from $upstream ($behind upstream, $ahead local), but every"
  Write-Host "termhub update: local commit already exists upstream as an equivalent patch - upstream was"
  Write-Host "termhub update: rewritten and force-pushed from elsewhere. Resetting onto $upstream;"
  Write-Host "termhub update: no local work is lost."

  # Keep the pre-reset lineage reachable. A human can still inspect what was here,
  # and - load-bearing - $rollback stays a referenced object instead of becoming
  # unreachable partway through the update that may still need to roll back to it.
  # Force, so these do not accumulate one per heal.
  & git -C $ProjectDir branch --force termhub-pre-reset HEAD 2>&1 | Out-Null

  & git -C $ProjectDir reset --hard $upstream 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "termhub update: the reset onto $upstream failed; the checkout is exactly as it was."
    return $false
  }
  $now = (& git -C $ProjectDir rev-parse --short HEAD).Trim()
  Write-Host "termhub update: was $before, now $now - the previous lineage is kept on branch"
  Write-Host "termhub update: 'termhub-pre-reset' if you want to look at it."
  return $true
}

$git = (Get-Command git -ErrorAction SilentlyContinue)
if (-not $git) { Fail "git not found on PATH." }

$state        = Get-TermhubState
$sessiondPort = $state.sessiondPort
$bluePort     = $state.activeFrontPort
$publishPort  = $state.publishPort
$greenPort    = if ($bluePort -eq 7001) { 7002 } else { 7001 }

# Resolve which of the three layouts this machine is actually on. See the header
# comment above and restart-front.ps1, which this mirrors.
if ($bluePort -ne $publishPort) {
  $mode = 'bluegreen'
} else {
  $published = Test-ServePublished -Port $publishPort
  if ($published -eq $false) {
    $mode = 'http'
  } else {
    $mode = 'single'
    if ($null -eq $published) {
      Write-Host "termhub update: could not read 'tailscale serve status' - assuming single-port, the default." -ForegroundColor Yellow
      Write-Host "termhub update: if this machine uses the plain-HTTP layout, re-run .\windows\start-http.ps1 after this update to confirm the bind." -ForegroundColor Yellow
    }
  }
}

switch ($mode) {
  'single'    { Write-Host "termhub update: single-port mode  front=publish=$publishPort  sessiond=$sessiondPort" }
  'http'      { Write-Host "termhub update: plain-HTTP mode  front=publish=$publishPort (tailnet IP, no Serve)  sessiond=$sessiondPort" }
  'bluegreen' { Write-Host "termhub update: blue=$bluePort  green=$greenPort  sessiond=$sessiondPort  publish=$publishPort" }
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
if ($LASTEXITCODE -ne 0) {
  Write-Host "termhub update: git pull --ff-only refused - working out whether that is safe to fix here."
  if (-not (Repair-DivergedHistory)) {
    Fail "git pull --ff-only failed and could not be safely resolved. Nothing changed; blue still serving."
  }
}
$newHead = (& git -C $ProjectDir rev-parse HEAD).Trim()
if ($newHead -eq $rollback) { Write-Host "termhub update: already up to date - re-deploying anyway to pick up local changes." }

# 2) Install deps only if the lockfile/manifest changed (front needs no native build).
$changed = & git -C $ProjectDir diff --name-only $rollback $newHead
if ($changed -match 'package(-lock)?\.json') {
  Write-Host "termhub update: dependencies changed -> npm install (no native build)"
  Push-Location $ProjectDir
  try { & npm install --omit=dev --ignore-scripts --no-audit --no-fund } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { & git -C $ProjectDir reset --hard $rollback | Out-Null; Fail "npm install failed; rolled back. Blue still serving." }
  # npm rewrites package-lock.json into whatever shape the LOCAL npm prefers even when
  # the installed tree is unchanged (11.6.2 records `"peer": true` on @xterm/xterm,
  # 11.12.1 does not), so machines on different npm versions dirty it back and forth -
  # and the pull in step 1 refuses a dirty tree. The lockfile is authoritative and
  # node_modules is derived from it, so discard the rewrite. Mirrors linux/update.sh.
  & git -C $ProjectDir checkout -- package-lock.json 2>&1 | Out-Null
}

if ($mode -eq 'single') {
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
elseif ($mode -eq 'http') {
  # 3-5) PLAIN-HTTP: same in-place swap as single-port, but bound to the tailnet
  # IP instead of loopback, and Serve is never touched - it must stay off.
  $ip = ((& tailscale ip -4) | Select-Object -First 1).Trim()
  if (-not $ip) { Fail "could not determine Tailscale IPv4 address (tailscale ip -4)." }
  Write-Host "termhub update: swapping the front in place on ${ip}:$publishPort (brief gap) ..."
  Stop-Front "front-$publishPort"
  $frontProc = Start-VerifiedFront -Port $publishPort -SessiondPort $sessiondPort -Bind $ip -ExpectCommit $newHead

  if (-not $frontProc) {
    Write-Host "termhub update: the new front is unhealthy - reverting the tree and restarting the previous one." -ForegroundColor Yellow
    & git -C $ProjectDir reset --hard $rollback | Out-Null
    $back = Start-VerifiedFront -Port $publishPort -SessiondPort $sessiondPort -Bind $ip -ExpectCommit $rollback
    if ($back) {
      Fail "new version unhealthy; reverted to $(Format-Commit $rollback) and restarted the front on ${ip}:$publishPort. Terminals untouched."
    }
    Fail ("new version unhealthy AND the reverted front did not come up either - the UI is DOWN. " `
      + "Run: .\windows\start-http.ps1   (sessiond 127.0.0.1:$sessiondPort is untouched, so the terminals are still there.)")
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

# 5c) Make sure the watchdog is installed and pointed at this checkout.
#
# The watchdog itself needs NO restart to pick up a pull: its scheduled task runs
# `powershell -File watchdog.ps1` fresh every cycle, so the code that just landed is
# live on the next tick with nothing resident holding the old version. What this step
# is for is the definition going stale, or never having existed - a machine that
# updates into a build that has a watchdog should end up supervised without anyone
# having to remember a second install step.
#
# Non-fatal by construction (Confirm-WatchdogTask never throws): termhub is already
# serving the new front by this point, and failing to register a scheduled task must
# not roll that back.
Write-Host ""
Confirm-WatchdogTask

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

$dns = ''
try { $dns = ((& tailscale status --json 2>$null | ConvertFrom-Json).Self.DNSName).TrimEnd('.') } catch { }

Write-Host ""
if ($mode -eq 'http') {
  # No loopback claim here - the front never bound 127.0.0.1, and there's no
  # Serve/DNS URL either since Serve is deliberately off in this mode.
  Write-Host "termhub update OK: front ${ip}:$publishPort at HEAD $(Format-Commit $newHead)." -ForegroundColor Green
  Write-Host "  http://${ip}:$publishPort/" -ForegroundColor Green
} else {
  $servingPort = if ($mode -eq 'single') { $publishPort } else { $greenPort }
  Write-Host "termhub update OK: front 127.0.0.1:$servingPort at HEAD $(Format-Commit $newHead)." -ForegroundColor Green
  if ($dns) { Write-Host "  https://${dns}:${publishPort}/" -ForegroundColor Green }
  if ($mode -eq 'single') { Write-Host "  http://127.0.0.1:$publishPort/" -ForegroundColor Green }
}
Write-Host "Open terminals reconnect automatically to the same sessions (sessiond 127.0.0.1:$sessiondPort)."
