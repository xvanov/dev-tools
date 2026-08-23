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
. (Join-Path $PSScriptRoot '..' 'windows' 'common.ps1')

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
  & $GIT -C $dir @args 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "git $args failed in $dir" }
}
function Get-FixtureGit($dir) { return ("$(& $GIT -C $dir @args 2>$null)").Trim() }
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
  & $GIT init -q --bare -b main $origin 2>&1 | Out-Null
  & $GIT clone -q $origin $work 2>&1 | Out-Null
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
  & $GIT clone -q $fx.Origin $other 2>&1 | Out-Null
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
& $GIT -C $fx.Work pull --ff-only 2>&1 | Out-Null
Check 'git pull --ff-only really refuses it' ($LASTEXITCODE -ne 0)

$result = Repair-DivergedHistory -RepoDir $fx.Work
# The PowerShell-specific hazard: a function returns EVERYTHING that reached the
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
& $GIT clone -q $fx.Origin $other 2>&1 | Out-Null
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

Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue

Write-Host "`nRepair-DivergedHistory: $($script:pass) checks passed, $($script:failures.Count) failed"
if ($script:failures.Count -gt 0) { $script:failures | ForEach-Object { Write-Host "  FAIL $_" }; exit 1 }
