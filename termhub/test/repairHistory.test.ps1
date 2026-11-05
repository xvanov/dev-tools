# Repair-DivergedHistory (windows/common.ps1) against real git repositories.
#
# The Windows twin of test/updateHeal.test.js, and it exists for an uncomfortable
# reason: this fleet is Linux apart from the Windows boxes, so the PowerShell half of
# the updater is the half nobody runs by accident. A `git reset --hard` that only
# executes on the machine you are not watching has to be tested somewhere.
#
#   Windows:  pwsh -NoProfile -File test\repairHistory.test.ps1
#   Linux:    docker run --rm -v "$PWD:/repo" <a pwsh image with git> \
#               pwsh -NoProfile -File /repo/test/repairHistory.test.ps1
#
# Exits non-zero on the first failing expectation's tally, like the node tests.

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 (what the update button runs) takes ONE child path per Join-Path.
. (Join-Path (Join-Path $PSScriptRoot '..') 'windows\common.ps1')

$script:pass = 0
$script:failures = @()
function Check($name, $cond, $extra) {
  if ($cond) { $script:pass++; Write-Host "  OK    $name" }
  else {
    $script:failures += $name
    Write-Host "  FAIL  $name" -ForegroundColor Red
    if ($extra) { Write-Host "        $extra" }
  }
}

# Hermetic git: the machine's own config must not decide whether these pass.
$env:GIT_CONFIG_GLOBAL   = if ($IsWindows) { "$env:TEMP\termhub-nonexistent-gitconfig" } else { '/dev/null' }
$env:GIT_CONFIG_SYSTEM   = $env:GIT_CONFIG_GLOBAL
$env:GIT_AUTHOR_NAME     = 'fixture'; $env:GIT_AUTHOR_EMAIL    = 'fixture@example.invalid'
$env:GIT_COMMITTER_NAME  = 'fixture'; $env:GIT_COMMITTER_EMAIL = 'fixture@example.invalid'
$env:GIT_TERMINAL_PROMPT = '0'

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("termhub-heal-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $root | Out-Null

# Resolve the git EXECUTABLE once and call it through that path. A helper called
# `Git` would otherwise shadow the native command - PowerShell resolves functions
# before executables and is case-insensitive - so `& git` inside such a helper calls
# the helper, forever. The first draft of this file hung exactly that way.
$GIT = (Get-Command git -CommandType Application | Select-Object -First 1).Source

function Invoke-FixtureGit($dir) {
  $r = Invoke-Native $GIT -Arguments (@('-C', $dir) + @($args))
  if ($r.Code -ne 0) { throw "git $args failed in $dir`: $($r.Text)" }
}
function Get-FixtureGit($dir) { return (Invoke-Native $GIT -Arguments (@('-C', $dir) + @($args))).Stdout }
function Commit($dir, $file, $message) {
  Set-Content -Path (Join-Path $dir $file) -Value $message
  Invoke-FixtureGit $dir add -A
  Invoke-FixtureGit $dir commit -q -m $message
}

# A checkout plus the bare remote it tracks.
function New-Fixture($name) {
  $dir    = Join-Path $root $name
  $origin = Join-Path $dir 'origin.git'
  $work   = Join-Path $dir 'work'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $null = Invoke-Native $GIT -Arguments @('init', '-q', '--bare', '-b', 'main', $origin)
  $null = Invoke-Native $GIT -Arguments @('clone', '-q', $origin, $work)
  Commit $work 'a.txt' 'base'
  Invoke-FixtureGit $work push -q -u origin main
  return @{ Dir = $dir; Origin = $origin; Work = $work }
}

# Rewrite upstream the way a rebase or an amend on another machine does: same patch,
# different sha, force-pushed. A fixed distant committer date guarantees the new sha
# - without it the amend can land in the same second as the original and produce the
# identical commit, leaving a fixture that quietly tests nothing.
function Invoke-UpstreamRewrite($fx, $extraFile) {
  $other = Join-Path $fx.Dir 'other'
  $null = Invoke-Native $GIT -Arguments @('clone', '-q', $fx.Origin, $other)
  $env:GIT_COMMITTER_DATE = '2001-01-01T00:00:00 +0000'
  Invoke-FixtureGit $other commit -q --amend --no-edit
  Remove-Item Env:\GIT_COMMITTER_DATE
  if ($extraFile) { Commit $other $extraFile 'upstream-only work' }
  Invoke-FixtureGit $other push -qf origin main
}

Write-Host "`nRepair-DivergedHistory (pwsh $($PSVersionTable.PSVersion))"

# ---- 1) rewritten upstream: heal ---------------------------------------------
$fx = New-Fixture 'rewritten'
Commit $fx.Work 'b.txt' 'shared work'
Invoke-FixtureGit $fx.Work push -q origin main
Invoke-UpstreamRewrite $fx 'c.txt'
Invoke-FixtureGit $fx.Work fetch -q
$before = Get-FixtureGit $fx.Work rev-parse HEAD
$counts = Get-FixtureGit $fx.Work rev-list --left-right --count 'origin/main...HEAD'
Check 'fixture really is diverged' ($counts -match '^[1-9]\d*\s+[1-9]\d*$') $counts
$pullRes = Invoke-Native $GIT -Arguments @('-C', $fx.Work, 'pull', '--ff-only')
Check 'git pull --ff-only really refuses it' ($pullRes.Code -ne 0)

$result = Repair-DivergedHistory -RepoDir $fx.Work
# The PowerShell-specific hazard: a function returns every value that reached the
# pipeline, so an un-suppressed git line inside it would arrive here as an array and
# make `if (-not $result)` read as success. A strict type check is the guard.
Check 'returns a bare boolean, not a polluted pipeline' ($result -is [bool]) ("got: " + $result.GetType().Name)
Check 'heals a rewritten upstream' ($result -eq $true)
Check 'HEAD is now exactly origin/main' ((Get-FixtureGit $fx.Work rev-parse HEAD) -eq (Get-FixtureGit $fx.Work rev-parse origin/main))
Check 'the upstream-only commit is in the tree' (Test-Path (Join-Path $fx.Work 'c.txt'))
Check 'the pre-reset lineage is kept' ((Get-FixtureGit $fx.Work rev-parse termhub-pre-reset) -eq $before)

# ---- 2) genuine local work: refuse -------------------------------------------
$fx = New-Fixture 'local-work'
Commit $fx.Work 'b.txt' 'shared work'
Invoke-FixtureGit $fx.Work push -q origin main
Invoke-UpstreamRewrite $fx 'c.txt'
Invoke-FixtureGit $fx.Work fetch -q
Commit $fx.Work 'mine.txt' 'my unpushed work'
$before = Get-FixtureGit $fx.Work rev-parse HEAD
$out = (Repair-DivergedHistory -RepoDir $fx.Work 6>&1 | Out-String)
Check 'refuses when a local commit exists nowhere upstream' ($out -match 'exist nowhere upstream')
Check 'names the commit it refused to destroy' ($out -match 'my unpushed work') $out
Check 'HEAD is untouched' ((Get-FixtureGit $fx.Work rev-parse HEAD) -eq $before)

# ---- 3) dirty tree: refuse ----------------------------------------------------
$fx = New-Fixture 'dirty'
Commit $fx.Work 'b.txt' 'shared work'
Invoke-FixtureGit $fx.Work push -q origin main
Invoke-UpstreamRewrite $fx 'c.txt'
Invoke-FixtureGit $fx.Work fetch -q
Add-Content -Path (Join-Path $fx.Work 'a.txt') -Value 'uncommitted edit'
$before = Get-FixtureGit $fx.Work rev-parse HEAD
$result = Repair-DivergedHistory -RepoDir $fx.Work
Check 'refuses on a dirty tree' ($result -eq $false)
Check 'HEAD is untouched by the dirty-tree refusal' ((Get-FixtureGit $fx.Work rev-parse HEAD) -eq $before)
Check 'the uncommitted edit survives' ((Get-Content (Join-Path $fx.Work 'a.txt') -Raw) -match 'uncommitted edit')

# ---- 4) not diverged at all: refuse -------------------------------------------
# A pull can fail for reasons that have nothing to do with history. The heal must
# recognise it has no business acting.
$fx = New-Fixture 'behind-only'
$other = Join-Path $fx.Dir 'other'
$null = Invoke-Native $GIT -Arguments @('clone', '-q', $fx.Origin, $other)
Commit $other 'c.txt' 'upstream moved on'
Invoke-FixtureGit $other push -q origin main
Invoke-FixtureGit $fx.Work fetch -q
$before = Get-FixtureGit $fx.Work rev-parse HEAD
$out = (Repair-DivergedHistory -RepoDir $fx.Work 6>&1 | Out-String)
Check 'refuses when HEAD is merely behind' ($out -match 'not diverged')
Check 'HEAD is untouched when there was no divergence' ((Get-FixtureGit $fx.Work rev-parse HEAD) -eq $before)

# ---- 5) no upstream configured: refuse ----------------------------------------
$fx = New-Fixture 'no-upstream'
Invoke-FixtureGit $fx.Work checkout -q -b orphan
$out = (Repair-DivergedHistory -RepoDir $fx.Work 6>&1 | Out-String)
Check 'refuses a branch with no upstream' ($out -match 'no upstream is configured')

function Stash-Count($dir) { return @((Invoke-Native $GIT -Arguments @('-C', $dir, 'stash', 'list')).Out | Where-Object { $_ }).Count }
function Status-Of($dir) { return (Invoke-Native $GIT -Arguments @('-C', $dir, 'status', '--porcelain')).Stdout }

Write-Host "`nSave/Restore/Reset-TreeTo (uncommitted work survives an update)"

# ---- 6) dirty tree + rewritten upstream: stash, heal, restore -----------------
# The live failure: a dirty tree stopped the pull and the heal, so the update button
# failed every time. With the edits stashed, the same heal must now succeed, and the
# edits (tracked and untracked) must come back on the new HEAD.
$fx = New-Fixture 'stash-heal'
Commit $fx.Work 'b.txt' 'shared work'
Invoke-FixtureGit $fx.Work push -q origin main
Invoke-UpstreamRewrite $fx 'c.txt'
Invoke-FixtureGit $fx.Work fetch -q
Set-Content -Path (Join-Path $fx.Work 'a.txt') -Value 'uncommitted edit'
Set-Content -Path (Join-Path $fx.Work 'wip-new.txt') -Value 'untracked work'
$st = Save-LocalChanges -RepoDir $fx.Work -Why 'test'
Check 'stashes a dirty tree' ($st -eq $true) "got: $st"
Check 'tree is clean once stashed' ((Status-Of $fx.Work) -eq '')
$healed = Repair-DivergedHistory -RepoDir $fx.Work 6>$null
Check 'the heal now runs on a dirty checkout' ($healed -eq $true)
$restored = Restore-LocalChanges -RepoDir $fx.Work 6>$null
Check 'restore returns true when it applies cleanly' ($restored -eq $true)
Check 'tracked edit is back' ((Get-Content (Join-Path $fx.Work 'a.txt') -Raw) -match 'uncommitted edit')
Check 'untracked file is back' (Test-Path (Join-Path $fx.Work 'wip-new.txt'))
Check 'stash list is empty after a clean restore' ((Stash-Count $fx.Work) -eq 0)

# ---- 7) clean tree: nothing to stash ------------------------------------------
$fx = New-Fixture 'stash-clean'
$st = Save-LocalChanges -RepoDir $fx.Work -Why 'test'
Check 'a clean tree is not stashed' ($st -eq $false) "got: $st"
Check 'a clean tree creates no stash' ((Stash-Count $fx.Work) -eq 0)

# ---- 8) restore that conflicts: keep the stash, say so ------------------------
# Upstream changed the same line the user edited. The pull still fast-forwards (the
# tree is clean), but the re-apply conflicts. The work must stay in the stash list,
# not be dropped.
$fx = New-Fixture 'stash-conflict'
Set-Content -Path (Join-Path $fx.Work 'a.txt') -Value 'local edit'
$st = Save-LocalChanges -RepoDir $fx.Work -Why 'test'
$other = Join-Path $fx.Dir 'other'
$null = Invoke-Native $GIT -Arguments @('clone', '-q', $fx.Origin, $other)
Commit $other 'a.txt' 'upstream edit'
Invoke-FixtureGit $other push -q origin main
Invoke-FixtureGit $fx.Work pull -q --ff-only
$restored = Restore-LocalChanges -RepoDir $fx.Work 6>$null
Check 'a conflicting restore reports failure' ($restored -eq $false) "got: $restored"
Check 'a conflicting restore keeps the stash' ((Stash-Count $fx.Work) -eq 1)

# ---- 9) rollback keeps uncommitted edits (the old reset --hard wiped them) -----
$fx = New-Fixture 'reset-keeps'
Commit $fx.Work 'b.txt' 'second commit'
Invoke-FixtureGit $fx.Work push -q origin main
$old = Get-FixtureGit $fx.Work rev-parse HEAD
Commit $fx.Work 'c.txt' 'third commit'
Invoke-FixtureGit $fx.Work push -q origin main
Set-Content -Path (Join-Path $fx.Work 'a.txt') -Value 'wip during rollback'
$ok = Reset-TreeTo -RepoDir $fx.Work -Rev $old 6>$null
Check 'rollback reset succeeds' ($ok -eq $true)
Check 'rollback lands on the old commit' ((Get-FixtureGit $fx.Work rev-parse HEAD) -eq $old)
Check 'rollback keeps the uncommitted edit' ((Get-Content (Join-Path $fx.Work 'a.txt') -Raw) -match 'wip during rollback')
Check 'rollback leaves no stash behind' ((Stash-Count $fx.Work) -eq 0)

Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue

Write-Host "`nRepair-DivergedHistory + stash helpers: $($script:pass) checks passed, $($script:failures.Count) failed"
if ($script:failures.Count -gt 0) { $script:failures | ForEach-Object { Write-Host "  FAIL $_" }; exit 1 }
