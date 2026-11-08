# One command that installs, or reinstalls, the whole stack on this Windows machine (plan 7.7,
# decision D23): the personal assistant on jarvisd, termhub (jarvisd front, ptyd), the factory
# (factory serve), their scheduled tasks, started and verified.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File <checkout>\install.ps1 [-DryRun] [-Reinstall] [-Voice]
#
#   -DryRun     print every step and decision; change nothing
#   -Reinstall  also re-register the tasks through their installers and restart the services
#   -Voice      also run personal-assistant\windows\install-voice.ps1 (local TTS; NVIDIA GPU)
#
# Idempotent: a second run on an installed machine finds every step done and changes nothing.
# It keeps data: the SQLite store, %LOCALAPPDATA% state, every .env line and vault entry it finds.
# .env files are only appended to; keys are only created where none exists, never printed.
#
# What it installs itself: npm dependencies (npm ci when node_modules is missing, npm install when
# it no longer matches the lockfile; never npm ci over a live install, where Windows locks loaded
# files), the pinned Bun, `uv sync`, the jarvisd and ptyd builds. What it cannot (git, Node 24+,
# uv, Rust with MSVC, Tailscale, the Claude Code and gh logins) it checks and names.
#
# The tasks are registered by each tool's own installer, never here: personal-assistant\windows\
# install.ps1 (pa-worker via pa-launch.ps1, capture), termhub\windows\install.ps1 (Termhub, the
# watchdog), termhub\windows\ptyd.ps1 (termhub-ptyd), software-factory\scripts\windows\
# install-serve.ps1 (factory-serve).
#
# Test hooks (personal-assistant/test/install.test.js): DEVTOOLS_INSTALL_ROOT names another
# checkout to inspect; DEVTOOLS_INSTALL_TASKS_FILE is a JSON array of {TaskName, State, Arguments,
# Admin} read instead of Task Scheduler (the run then counts as not elevated); DEVTOOLS_INSTALL_NO_LOGIN_CHECK skips the claude and gh login
# checks (gh's goes over the network).
[CmdletBinding()]
param([switch]$DryRun, [switch]$Reinstall, [switch]$Voice)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Root = if ($env:DEVTOOLS_INSTALL_ROOT) { (Resolve-Path $env:DEVTOOLS_INSTALL_ROOT).Path } else { $Here }
$PaDir = Join-Path $Root 'personal-assistant'
$ThDir = Join-Path $Root 'termhub'
$JdDir = Join-Path $Root 'jarvisd'
$SfDir = Join-Path $Root 'software-factory'
$FactsJs = Join-Path $Here 'scripts\install-facts.js'
$PaEnv = Join-Path $PaDir '.env'
$ThEnv = Join-Path $ThDir '.env'
$RootEnv = Join-Path $Root '.env'

$script:Failed = @()
$script:Owner = @()
# Settings this run adds to a .env (in a dry run: would add), so later steps see them.
$script:Planned = @{}

function Say([string]$m) { Write-Host "install: $m" }
function Warn([string]$m) { Write-Host "install: $m" -ForegroundColor Yellow }
function Would([string]$m) { Write-Host "install: would $m" }
function Section([string]$m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Fail-Step([string]$step, [string]$m) { $script:Failed += $step; Write-Host "install: FAILED $step - $m" -ForegroundColor Red }
function Need-Owner([string]$m) { $script:Owner += $m; Warn "needs you: $m" }
function Rel([string]$p) { if ($p.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { return $p.Substring($Root.Length).TrimStart('\') } return $p }

# A native program with its output shown, stderr folded into it as text: under Windows PowerShell
# 5.1 a redirected stderr line is otherwise an ErrorRecord, fatal under 'Stop'
# (termhub\windows\common.ps1, Invoke-Native). $Vars are set for the child only. Returns the exit code.
function Invoke-Run {
  param([string]$Exe, [string[]]$Arguments = @(), [string]$Cwd = $Root, [hashtable]$Vars = @{}, [object]$InputText = $null)
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $saved = @{}
  foreach ($k in $Vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $Vars[$k]) }
  Push-Location $Cwd
  try {
    if ($null -ne $InputText) { $InputText | & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "  $_" } }
    else { & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "  $_" } }
    $code = $LASTEXITCODE
  } catch {
    Write-Host "  $($_.Exception.Message)"
    $code = -1
  } finally {
    Pop-Location
    foreach ($k in $Vars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    $ErrorActionPreference = $prevEap
  }
  if ($null -eq $code) { $code = 0 }
  return [int]$code
}

# The same, with stdout returned as lines (stderr dropped) for the caller to parse.
function Invoke-Capture {
  param([string]$Exe, [string[]]$Arguments = @(), [string]$Cwd = $Root)
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $Cwd
  try {
    $out = @(& $Exe @Arguments 2>$null | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } catch { $out = @(); $code = -1 } finally { Pop-Location; $ErrorActionPreference = $prevEap }
  return [pscustomobject]@{ Code = [int]$code; Lines = $out }
}

function Invoke-Script([string]$Script, [string[]]$Arguments = @(), [hashtable]$Vars = @{}) {
  if (-not (Test-Path $Script)) { Warn "$(Rel $Script) is not in this checkout; skipped"; return -1 }
  return (Invoke-Run -Exe 'powershell.exe' -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $Arguments) -Vars $Vars)
}

function Get-Facts([string[]]$Arguments) {
  if (-not $script:NodeExe) { return $null }
  $r = Invoke-Capture -Exe $script:NodeExe -Arguments (@($FactsJs) + $Arguments)
  $line = $r.Lines | Where-Object { $_.StartsWith('{') } | Select-Object -Last 1
  if ($r.Code -ne 0 -or -not $line) { return $null }
  return ($line | ConvertFrom-Json)
}

# A setting as the machine keeps it: the User or Machine environment (not this process's, which a
# shell started from termhub or a PA session inherits), else the first of $Files with a KEY= line.
# An empty KEY= line counts: a line that is there is never overwritten. @{Value; Source} or $null.
function Get-Setting([string]$Name, [string[]]$Files) {
  foreach ($scope in 'User', 'Machine') {
    $v = [Environment]::GetEnvironmentVariable($Name, $scope)
    if ($v) { return @{ Value = $v.Trim(); Source = "the $scope environment" } }
  }
  foreach ($f in $Files) {
    if (-not (Test-Path $f)) { continue }
    $m = Select-String -Path $f -Pattern "^\s*$Name\s*=\s*[`"']?([^`"'#\r\n]*)" | Select-Object -First 1
    if ($m) { return @{ Value = $m.Matches[0].Groups[1].Value.Trim(); Source = (Rel $f) } }
  }
  return $null
}

# The value a later step should assume: the setting, else what this run adds.
function Get-Effective([string]$Name, [string[]]$Files) {
  $s = Get-Setting $Name $Files
  if ($s) { return $s.Value }
  if ($script:Planned.ContainsKey($Name)) { return $script:Planned[$Name] }
  return ''
}

# Append-only: one new line at the end, in the file's own line ending, never an edit.
function Add-EnvLine([string]$File, [string]$Name, [string]$Value) {
  $script:Planned[$Name] = $Value
  if ($DryRun) { Would "add $Name=$Value to $(Rel $File)"; return }
  $text = if (Test-Path $File) { [IO.File]::ReadAllText($File) } else { '' }
  $nl = if ($text -and -not $text.Contains("`r`n") -and $text.Contains("`n")) { "`n" } else { "`r`n" }
  $sep = if ($text -and -not $text.EndsWith("`n")) { $nl } else { '' }
  [IO.File]::AppendAllText($File, "$sep$Name=$Value$nl")
  Say "added $Name=$Value to $(Rel $File)"
}

# One setting with a default for the new system: added when no line or variable sets it.
function Confirm-Default([string]$Name, [string]$Value, [string]$File, [string[]]$Files) {
  $s = Get-Setting $Name $Files
  if ($s) { Say "$Name=$($s.Value) ($($s.Source)): kept"; return }
  Add-EnvLine $File $Name $Value
}

# Windows takes about 2 s to give up on a closed loopback port (it retries the refused connect);
# a listening one accepts in milliseconds.
function Test-Listening([int]$Port) {
  $c = New-Object Net.Sockets.TcpClient
  try { return ($c.ConnectAsync('127.0.0.1', $Port).Wait(300) -and $c.Connected) } catch { return $false } finally { $c.Close() }
}

function Get-Json([string]$Url, [hashtable]$Headers = @{}, [int]$TimeoutSec = 3) {
  if (-not (Test-Listening ([Uri]$Url).Port)) { return $null }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -Headers $Headers $Url
    if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
  } catch { }
  return $null
}

function Get-FactoryJobList {
  if (-not (Test-Listening $FsPort)) { return $null }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 60 -Headers @{ 'X-Factory' = '1' } -ContentType 'application/json' `
      -Body '{"argv": ["job", "list", "--json"]}' "http://127.0.0.1:$FsPort/api/cli"
    return ($r.Content | ConvertFrom-Json)
  } catch { return $null }
}

$TaskNames = @('pa-worker', 'pa-capture-mic', 'pa-capture-loopback', 'pa-voice', 'Termhub', 'TermhubWatchdog', 'termhub-ptyd', 'factory-serve')
function Get-Tasks {
  if ($env:DEVTOOLS_INSTALL_TASKS_FILE) { return @(Get-Content -Raw $env:DEVTOOLS_INSTALL_TASKS_FILE | ConvertFrom-Json) }
  return @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $TaskNames -contains $_.TaskName } | ForEach-Object {
      # Registered from an elevated shell, the task's file belongs to Administrators.
      $admin = $true
      try { $admin = (Get-Acl "$env:SystemRoot\System32\Tasks$($_.TaskPath)$($_.TaskName)" -ErrorAction Stop).Owner -match 'Administrators$' } catch { }
      [pscustomobject]@{ TaskName = $_.TaskName; State = "$($_.State)"; Admin = $admin; Arguments = (($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ') }
    })
}

# A task registered from an elevated shell cannot be re-registered from a normal one (access
# denied); starting and stopping it still works.
function Test-Blocked([string]$Name) {
  return ((-not $script:Elevated) -and [bool]($script:Tasks | Where-Object { $_.TaskName -eq $Name -and $_.Admin }))
}

# 'missing' | 'disabled' | 'elsewhere' (runs none of $Targets) | 'ok'
function Get-TaskStatus([string]$Name, [string[]]$Targets) {
  $t = $script:Tasks | Where-Object { $_.TaskName -eq $Name } | Select-Object -First 1
  if (-not $t) { return 'missing' }
  if ($t.State -eq 'Disabled') { return 'disabled' }
  $act = "$($t.Arguments)".ToLowerInvariant()
  foreach ($x in $Targets) { if ($act.Contains($x.ToLowerInvariant())) { return 'ok' } }
  return 'elsewhere'
}

# A running process whose executable is under $Dir (Windows locks it: npm and builds fail EPERM).
function Get-LockingProcess([string]$Dir) {
  $p = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
  return $p
}

function Test-JarvisdFront([int]$ProcId) {
  $c = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcId" -ErrorAction SilentlyContinue
  return [bool]($c -and $c.CommandLine -match 'jarvisd[\\/]src[\\/]main\.ts"?\s+front\b')
}

$mode = if ($DryRun -and $Reinstall) { 'reinstall, dry run: nothing changes' } elseif ($DryRun) { 'dry run: nothing changes' } elseif ($Reinstall) { 'reinstall' } else { 'install' }
Write-Host "dev-tools install ($mode)" -ForegroundColor Cyan
Say "checkout $Root"

# ---------------------------------------------------------------- prerequisites

Section 'prerequisites'
# This run's children find these first: an editor's bundled node first on PATH once ran a
# sessiond restart on the wrong Node (docs/native/JARVISD.md), and cargo is often only in ~\.cargo\bin.
$prepend = @((Join-Path $env:USERPROFILE '.cargo\bin'), (Join-Path $env:ProgramFiles 'nodejs'), (Join-Path $env:USERPROFILE '.local\bin')) | Where-Object { Test-Path $_ }
$env:PATH = (@($prepend) + @($env:PATH -split ';' | Where-Object { $_ -and ($prepend -notcontains $_) })) -join ';'
Say "PATH for this run starts with $($prepend -join ';')"

# Started from a termhub terminal, the environment carries that sessiond's PTY decision, not a choice.
if ($env:TERMHUB_SESSION_ID -or $env:TERMHUB_PTYD_RESOLVED) {
  foreach ($k in 'TERMHUB_PTYD', 'TERMHUB_PTYD_RESOLVED', 'TERMHUB_PTYD_BIN') { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  Say "running in a termhub terminal: its inherited TERMHUB_PTYD values are ignored"
}

$missing = @()
function Report([string]$what, [bool]$ok, [string]$detail, [string]$fix, [switch]$Required) {
  if ($ok) { Say ("{0,-14} ok   {1}" -f $what, $detail); return }
  Write-Host ("install: {0,-14} {1} {2}" -f $what, $(if ($Required) { 'MISSING' } else { 'missing' }), $fix) -ForegroundColor Yellow
  if ($Required) { $script:missing += $what }
  Need-Owner "$what - $fix"
}

$git = Get-Command git -ErrorAction SilentlyContinue
Report 'git' ([bool]$git) "$(if ($git) { $git.Source })" 'install Git for Windows (https://git-scm.com)' -Required
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$script:NodeExe = if ($nodeCmd) { $nodeCmd.Source } else { $null }
$nodeVer = if ($script:NodeExe) { (Invoke-Capture -Exe $script:NodeExe -Arguments @('--version')).Lines | Select-Object -First 1 } else { '' }
$nodeMajor = if ($nodeVer -match '^v(\d+)\.') { [int]$Matches[1] } else { 0 }
Report 'node 24+' ($nodeMajor -ge 24) "$nodeVer $($script:NodeExe)" "install Node.js 24 or newer into $env:ProgramFiles\nodejs (https://nodejs.org)$(if ($nodeVer) { "; found $nodeVer" })" -Required
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
Report 'npm' ([bool]$npm) "$(if ($npm) { $npm.Source })" 'comes with Node.js' -Required
$uv = Get-Command uv -ErrorAction SilentlyContinue
Report 'uv' ([bool]$uv) "$(if ($uv) { $uv.Source })" 'install uv (https://docs.astral.sh/uv/getting-started/installation/); it fetches the Python the factory needs' -Required
$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
Report 'tailscale' ([bool]$tailscale) "$(if ($tailscale) { $tailscale.Source })" 'install Tailscale and sign in (termhub is published with Tailscale Serve)' -Required
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
Report 'cargo' ([bool]$cargo) "$(if ($cargo) { $cargo.Source })" 'install Rust with rustup (https://rustup.rs): it builds ptyd'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msvc = if (Test-Path $vswhere) { (Invoke-Capture -Exe $vswhere -Arguments @('-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')).Lines | Select-Object -First 1 } else { $null }
Report 'msvc' ([bool]$msvc) "$msvc" "install Visual Studio Build Tools with 'Desktop development with C++' (cargo's linker for ptyd; node-pty)"
$python = Get-Command python -ErrorAction SilentlyContinue
Report 'python' ([bool]$python) "$(if ($python) { $python.Source })" 'install Python 3 for the PA''s always-on capture and Teams cache venvs (skipped without it)'
$claude = Get-Command claude -ErrorAction SilentlyContinue
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($env:DEVTOOLS_INSTALL_NO_LOGIN_CHECK) { Say "claude and gh logins: not checked (DEVTOOLS_INSTALL_NO_LOGIN_CHECK)"; $claude = $null; $gh = $null; $skipLogins = $true } else { $skipLogins = $false }
$claudeIn = $false
$claudeDetail = ''
if ($claude) {
  $st = Invoke-Capture -Exe $claude.Source -Arguments @('auth', 'status', '--json')
  try { $j = ($st.Lines -join "`n") | ConvertFrom-Json; $claudeIn = [bool]$j.loggedIn; $claudeDetail = "logged in ($($j.authMethod))" } catch { }
}
if (-not $skipLogins) { Report 'claude login' $claudeIn $claudeDetail $(if ($claude) { 'run: claude auth login (the factory, the PA''s connector passes and termhub''s Claude sessions use it)' } else { 'install Claude Code (https://claude.ai/install.ps1), then: claude auth login' }) }
$ghIn = $false
$ghDetail = ''
if ($gh) {
  $st = Invoke-Capture -Exe $gh.Source -Arguments @('auth', 'status', '--json', 'hosts')
  try {
    $hosts = (($st.Lines -join "`n") | ConvertFrom-Json).hosts
    $ok = @()
    foreach ($p in $hosts.PSObject.Properties) {
      $n = @($p.Value | Where-Object { $_.state -eq 'success' }).Count
      if ($n) { $ok += "$($p.Name) ($n account$(if ($n -gt 1) { 's' }))" }
    }
    $ghIn = $ok.Count -gt 0
    $ghDetail = "logged in: $($ok -join ', ')"
  } catch {
    $ghIn = ((Invoke-Capture -Exe $gh.Source -Arguments @('auth', 'status')).Code -eq 0)
    $ghDetail = 'logged in'
  }
}
if (-not $skipLogins) { Report 'gh login' $ghIn $ghDetail $(if ($gh) { 'run: gh auth login (the factory and the PA''s GitHub pass use it)' } else { 'install the GitHub CLI (https://cli.github.com), then: gh auth login' }) }
$script:Elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($env:DEVTOOLS_INSTALL_TASKS_FILE) { $script:Elevated = $false }
Say "elevated: $($script:Elevated)$(if (-not $script:Elevated) { ' (tasks registered from an elevated shell are kept, not re-registered; termhub uses a Startup launcher when it has no task)' })"

$head = if ($git) { [string]((Invoke-Capture -Exe 'git' -Arguments @('-C', $Root, 'rev-parse', 'HEAD')).Lines | Select-Object -First 1) } else { '' }
if ($head -notmatch '^[0-9a-f]{40}$') { $head = ''; Warn "not a git checkout: the services' commits cannot be checked against HEAD" }
else { Say "HEAD $($head.Substring(0, 7))" }

if ($script:missing.Count -and -not $DryRun) {
  Write-Host ""
  Write-Host "install: stopped before changing anything: install $($script:missing -join ', ') and run this again." -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------- settings

Section 'settings (.env defaults for the new system)'
if (-not (Test-Path $PaEnv)) {
  $example = Join-Path $PaDir '.env.example'
  if ($DryRun) { Would "write personal-assistant\.env from .env.example (then fill it in)" }
  elseif (Test-Path $example) { Copy-Item $example $PaEnv; Say "wrote personal-assistant\.env from .env.example: fill it in"; Need-Owner "fill in personal-assistant\.env (see .env.example), then: node personal-assistant\bin\pa.js doctor" }
}
Confirm-Default 'PA_RUNTIME' 'jarvisd' $PaEnv @($PaEnv, $RootEnv)
Confirm-Default 'TERMHUB_FRONT' 'jarvisd' $ThEnv @($ThEnv, $RootEnv)
Confirm-Default 'TERMHUB_PTYD' '1' $ThEnv @($ThEnv, $RootEnv)
Say "PA_DB is decided with the store, below"

# ---------------------------------------------------------------- dependencies

Section 'dependencies'
foreach ($d in @(
    @{ Name = 'personal-assistant'; Dir = $PaDir; Omit = $false },
    @{ Name = 'jarvisd'; Dir = $JdDir; Omit = $false },
    # termhub's own installer and update install without dev packages and build node-pty themselves.
    @{ Name = 'termhub'; Dir = $ThDir; Omit = $true })) {
  if (-not (Test-Path (Join-Path $d.Dir 'package.json'))) { Warn "$($d.Name): no package.json; skipped"; continue }
  $f = Get-Facts (@('deps', $d.Dir) + $(if ($d.Omit) { @('--omit-dev') } else { @() }))
  $state = if ($f) { $f.state } else { 'unknown' }
  if ($state -eq 'fresh') { Say "$($d.Name): node_modules matches package-lock.json ($($f.checked) packages)"; continue }
  $flags = @('--no-audit', '--no-fund') + $(if ($d.Omit) { @('--omit=dev', '--ignore-scripts') } else { @() })
  $npmVerb = if ($state -eq 'missing') { 'ci' } else { 'install' }
  $why = switch ($state) { 'missing' { 'no node_modules' } 'stale' { "out of date: $(@($f.stale) -join ', ')" } 'no-lock' { 'no readable package-lock.json' } default { 'its state could not be read' } }
  $lock = Get-LockingProcess (Join-Path $d.Dir 'node_modules')
  if ($lock) { Warn "$($d.Name): $why, but pid $($lock.ProcessId) runs $($lock.ExecutablePath): left as it is (stop it, then run this again)"; continue }
  if ($DryRun) { Would "npm $npmVerb $($flags -join ' ') in $($d.Name) ($why)"; continue }
  Say "$($d.Name): npm $npmVerb ($why)"
  $lockClean = ((Invoke-Capture -Exe 'git' -Arguments @('-C', $d.Dir, 'status', '--porcelain', '--', 'package-lock.json')).Lines.Count -eq 0)
  $code = Invoke-Run -Exe 'npm.cmd' -Arguments (@($npmVerb) + $flags) -Cwd $d.Dir
  if ($code -ne 0) { Fail-Step "npm $npmVerb in $($d.Name)" "exit $code"; continue }
  # npm rewrites the lockfile into the local npm's shape; a dirty tree blocks the next pull.
  if ($npmVerb -eq 'install' -and $lockClean) { $null = Invoke-Capture -Exe 'git' -Arguments @('-C', $d.Dir, 'checkout', '--', 'package-lock.json') }
}
if ((Test-Path (Join-Path $ThDir 'package.json')) -and -not (Test-Path (Join-Path $ThDir 'node_modules\node-pty\build\Release\pty.node'))) {
  Say "termhub: node-pty is not built (termhub\windows\install.ps1 builds it with MSBuild); sessiond does not need it with TERMHUB_PTYD=1"
}

# The jarvisd front's Bun, pinned by jarvisd/package.json, into jarvisd\.bun\<version>.
$launchJs = Join-Path $ThDir 'lib\launch.js'
if (Test-Path $launchJs) {
  $vars = @{}
  if ($DryRun -and $script:Planned.ContainsKey('TERMHUB_FRONT')) { $vars['TERMHUB_FRONT'] = $script:Planned['TERMHUB_FRONT'] }
  $code = Invoke-Run -Exe $script:NodeExe -Arguments (@($launchJs, 'ensure-bun') + $(if ($DryRun) { @('--dry-run') } else { @() })) -Cwd $ThDir -Vars $vars
  if ($code -ne 0 -and -not $DryRun) { Fail-Step 'Bun' "node termhub\lib\launch.js ensure-bun exited $code" }
}

if ((Test-Path (Join-Path $SfDir 'pyproject.toml')) -and $uv) {
  $check = Invoke-Capture -Exe $uv.Source -Arguments @('sync', '--all-extras', '--check') -Cwd $SfDir
  if ($check.Code -eq 0) { Say "software-factory: the venv matches uv.lock" }
  elseif ($DryRun) { Would "uv sync --all-extras --compile-bytecode in software-factory (the venv does not match uv.lock)" }
  else {
    Say "software-factory: uv sync --all-extras"
    # --compile-bytecode: the first ticks otherwise compile thousands of .pyc under AV scanning.
    $code = Invoke-Run -Exe $uv.Source -Arguments @('sync', '--all-extras', '--compile-bytecode') -Cwd $SfDir
    if ($code -ne 0) { Fail-Step 'uv sync' "exit $code" }
  }
}

# ---------------------------------------------------------------- builds

Section 'builds'
$paRuntime = Get-Effective 'PA_RUNTIME' @($PaEnv, $RootEnv)
$dist = Join-Path $JdDir 'dist'
$built = $null
$pointer = Join-Path $dist 'current'
if (Test-Path $pointer) { $n = (Get-Content $pointer -TotalCount 1).Trim(); if ($n -and (Test-Path (Join-Path $dist $n))) { $built = $n } }
if (-not $built -and (Test-Path (Join-Path $dist 'jarvisd.exe'))) { $built = 'jarvisd.exe' }
if ($paRuntime -ne 'jarvisd') { Say "jarvisd: PA_RUNTIME is $(if ($paRuntime) { $paRuntime } else { 'node' }): no executable needed" }
elseif ($built -and -not $Reinstall) { Say "jarvisd: $built is built (each deploy builds the next one beside it); not rebuilt" }
else {
  $exe = Join-Path $dist 'jarvisd.exe'
  $running = Get-CimInstance Win32_Process -Filter "Name = 'jarvisd.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $exe } | Select-Object -First 1
  if ($running) { Warn "jarvisd: jarvisd\dist\jarvisd.exe is running (pid $($running.ProcessId)): not rebuilt over it" }
  elseif ($DryRun) { Would "build jarvisd (node scripts\build.js --only jarvisd -> jarvisd\dist\jarvisd.exe)" }
  else {
    Say "jarvisd: node scripts\build.js --only jarvisd"
    $code = Invoke-Run -Exe $script:NodeExe -Arguments @((Join-Path $Root 'scripts\build.js'), '--only', 'jarvisd')
    if ($code -ne 0) { Fail-Step 'jarvisd build' "exit $code (the launcher falls back to the Node supervisor)" }
  }
}
Say "ptyd: termhub\windows\ptyd.ps1 -Ensure builds it when its sources are newer than the build (tasks, below)"

# ---------------------------------------------------------------- the store

Section 'the PA store and its keys'
$paBin = Join-Path $PaDir 'bin\pa.js'
$pf = Get-Facts @('pa', $Root)
$script:Tasks = Get-Tasks
if (-not $pf) {
  Warn "could not read the PA's config (node scripts\install-facts.js pa): the store and keys are left as they are"
  if (-not $DryRun) { Fail-Step 'store' "the PA's config did not load (npm ci in personal-assistant?)" }
} else {
  $paDb = Get-Setting 'PA_DB' @($PaEnv, $RootEnv)
  $create = $false
  $addDb = $false
  Say "store: $($pf.sqlitePath) $(if ($pf.storeExists) { 'exists' } else { 'does not exist' }); PA_SQLITE_KEY $(if ($pf.sqliteKey) { "set ($($pf.sqliteKey))" } else { 'not set' }); PA_BACKUP_KEY $(if ($pf.backupKey) { "set ($($pf.backupKey))" } else { 'not set' })"
  if ($paDb) {
    if ($paDb.Value -ne 'sqlite') { Say "PA_DB=$($paDb.Value) ($($paDb.Source)): kept (docs/native/CUTOVER-SQLITE.md moves a Postgres store)" }
    elseif ($pf.storeExists) { Say "PA_DB=sqlite ($($paDb.Source)) and the store exists: kept" }
    else { Say "PA_DB=sqlite ($($paDb.Source)) but there is no store yet: creating a fresh one"; $create = $true }
  } elseif ($pf.storeExists) {
    if ($pf.sqliteKey) { $addDb = $true }
    else { Warn "a store exists but PA_SQLITE_KEY is not set anywhere: PA_DB left unset"; Need-Owner "put the store's key in the vault (node personal-assistant\bin\pa.js secret set PA_SQLITE_KEY), then run this again" }
  } elseif ((Get-TaskStatus 'pa-worker' @('pa-launch.ps1', 'supervisor', 'worker.js')) -ne 'missing') {
    Warn "PA_DB is unset and there is no SQLite store, but the PA is installed: it runs on Postgres. Not switched; docs/native/CUTOVER-SQLITE.md moves it"
  } else {
    $create = $true
    $addDb = $true
  }

  if ($create) {
    $newKey = -not $pf.sqliteKey
    if ($DryRun) {
      if ($newKey) { Would "generate PA_SQLITE_KEY (32 random bytes) and store it in the vault: pa secret set PA_SQLITE_KEY, piped, never printed" }
      Would "create the encrypted store at $($pf.sqlitePath) (PA_DB=sqlite node src\db\migrate.js)"
    } else {
      $vars = @{ PA_DB = 'sqlite' }
      $key = $null
      if ($newKey) {
        $bytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $key = [Convert]::ToBase64String($bytes)
        $vars['PA_SQLITE_KEY'] = $key
      }
      Say "creating the store at $($pf.sqlitePath)"
      $code = Invoke-Run -Exe $script:NodeExe -Arguments @('src\db\migrate.js') -Cwd $PaDir -Vars $vars
      $made = Test-Path $pf.sqlitePath
      if ($code -eq 0 -and $made -and $newKey) {
        # After the store exists: `pa secret set` records the set in it.
        $code = Invoke-Run -Exe $script:NodeExe -Arguments @($paBin, 'secret', 'set', 'PA_SQLITE_KEY') -Cwd $PaDir -Vars @{ PA_DB = 'sqlite' } -InputText $key
        $again = Get-Facts @('pa', $Root)
        if (-not ($again -and $again.sqliteKey)) { $code = 1; Warn "PA_SQLITE_KEY did not reach the vault" }
        else { Need-Owner "keep a copy of PA_SQLITE_KEY off this machine (Windows Credential Manager holds it): a backup cannot be read without it" }
      }
      $key = $null
      $vars = $null
      if ($code -ne 0 -or -not $made) {
        # Only an empty store this run just made, which nobody could open without the lost key.
        if ($made -and $newKey) { foreach ($s in '', '-wal', '-shm') { Remove-Item -LiteralPath "$($pf.sqlitePath)$s" -Force -ErrorAction SilentlyContinue } }
        Fail-Step 'store' "creating the store failed; PA_DB left unset"
        $addDb = $false
      }
    }
  }
  if ($addDb) { Add-EnvLine $PaEnv 'PA_DB' 'sqlite' }

  if ($pf.backupKey) { Say "PA_BACKUP_KEY: set ($($pf.backupKey)): kept" }
  elseif ($DryRun) { Would "create PA_BACKUP_KEY in the vault (pa backup key init)" }
  else {
    $code = Invoke-Run -Exe $script:NodeExe -Arguments @($paBin, 'backup', 'key', 'init') -Cwd $PaDir
    if ($code -ne 0) { Fail-Step 'backup key' "pa backup key init exited $code" }
    else { Need-Owner "copy the backup key off this machine: node personal-assistant\bin\pa.js backup key export --to <file>" }
  }
}

# ---------------------------------------------------------------- tasks

Section 'scheduled tasks (each tool''s installer)'
$verb = if ($DryRun) { 'would run' } else { 'running' }

# The PA: pa-worker (windows\pa-launch.ps1), and the capture tasks and Teams cache venv when Python is here.
$w = Get-TaskStatus 'pa-worker' @("$PaDir\windows\pa-launch.ps1")
$teamsVenv = Join-Path $env:LOCALAPPDATA 'personal-assistant\teams-venv\Scripts\python.exe'
$extrasMissing = [bool]$python -and ((Get-TaskStatus 'pa-capture-mic' @('capture.py')) -eq 'missing' -or (Get-TaskStatus 'pa-capture-loopback' @('capture.py')) -eq 'missing' -or -not (Test-Path $teamsVenv))
if ($Reinstall -or $w -ne 'ok' -or $extrasMissing) {
  $paArgs = @('-SkipDatabase')
  $workerBlocked = Test-Blocked 'pa-worker'
  $captureBlocked = (Test-Blocked 'pa-capture-mic') -or (Test-Blocked 'pa-capture-loopback')
  if (($w -eq 'ok' -and -not $Reinstall) -or $workerBlocked) { $paArgs += '-NoWorker' }
  if (-not $python -or $captureBlocked) { $paArgs += '-NoAudio' }
  if (-not $python) { $paArgs += '-NoTeamsCache' }
  if ($workerBlocked) {
    if ($w -eq 'ok') { Say "pa-worker was registered from an elevated shell: kept (it runs this checkout's pa-launch.ps1)" }
    else { Need-Owner "pa-worker is $w and was registered from an elevated shell: run this from an elevated PowerShell to re-register it" }
  }
  if ($captureBlocked) { Say "the capture tasks were registered from an elevated shell: kept" }
  $why = if ($Reinstall) { 'reinstall' } elseif ($w -ne 'ok') { "pa-worker is $w" } else { 'capture tasks or the Teams cache venv missing' }
  Say "$verb personal-assistant\windows\install.ps1 $($paArgs -join ' ') ($why)"
  if (-not $DryRun -and (Invoke-Script (Join-Path $PaDir 'windows\install.ps1') $paArgs) -ne 0) { Fail-Step 'pa install' 'personal-assistant\windows\install.ps1 failed (above)' }
} else { Say "pa-worker runs this checkout's windows\pa-launch.ps1; capture tasks in place: kept" }

if ($Voice) {
  Say "$verb personal-assistant\windows\install-voice.ps1"
  if (-not $DryRun -and (Invoke-Script (Join-Path $PaDir 'windows\install-voice.ps1')) -ne 0) { Fail-Step 'voice' 'install-voice.ps1 failed (above)' }
} else {
  Say "pa-voice task: $(Get-TaskStatus 'pa-voice' @('voice\server.py')), not touched (-Voice runs personal-assistant\windows\install-voice.ps1)"
}

# ptyd before termhub's tiers, so a sessiond that starts adopts the task's ptyd.
$vars = @{}
if ($DryRun -and $script:Planned.ContainsKey('TERMHUB_PTYD')) { $vars['TERMHUB_PTYD'] = $script:Planned['TERMHUB_PTYD'] }
Say "$verb termhub\windows\ptyd.ps1 -Ensure"
$code = Invoke-Script (Join-Path $ThDir 'windows\ptyd.ps1') (@('-Ensure') + $(if ($DryRun) { @('-DryRun') } else { @() })) $vars
if ($code -ne 0 -and -not $DryRun) { Fail-Step 'ptyd' "termhub\windows\ptyd.ps1 -Ensure exited $code" }

# termhub: the Termhub logon task (or, not elevated, the Startup launcher) and its watchdog.
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'termhub.vbs'
$th = Get-TaskStatus 'Termhub' @("$ThDir\windows\start.ps1", "$ThDir\windows\start-http.ps1")
if ($th -ne 'ok' -and (Test-Path $vbs) -and (Get-Content -Raw $vbs).ToLowerInvariant().Contains($ThDir.ToLowerInvariant())) { $th = 'ok' }
$termhubInstalled = $false
if ($th -ne 'ok' -and (Test-Blocked 'Termhub')) {
  Need-Owner "the Termhub task is $th and was registered from an elevated shell: run termhub\windows\install.ps1 from an elevated PowerShell"
} elseif ($th -ne 'ok') {
  # A full install: npm, node-pty, the task or launcher, the watchdog, then both tiers started.
  Say "$verb termhub\windows\install.ps1 (the Termhub task is $th)"
  if (-not $DryRun) {
    if ((Invoke-Script (Join-Path $ThDir 'windows\install.ps1')) -ne 0) { Fail-Step 'termhub install' 'termhub\windows\install.ps1 failed (above)' } else { $termhubInstalled = $true }
  }
} else {
  Say "Termhub starts this checkout's windows\start.ps1 at logon: kept (termhub\windows\install.ps1 stops node tiers, so it runs only when this is wrong)"
  $wd = Get-TaskStatus 'TermhubWatchdog' @("$ThDir\watchdog\watchdog.ps1")
  if (Test-Blocked 'TermhubWatchdog') {
    if ($wd -eq 'ok') { Say "TermhubWatchdog runs this checkout's watchdog.ps1; registered from an elevated shell: kept" }
    else { Need-Owner "TermhubWatchdog is $wd and was registered from an elevated shell: run termhub\watchdog\install-watchdog.ps1 from an elevated PowerShell" }
  } elseif ($Reinstall) {
    Say "$verb termhub\watchdog\install-watchdog.ps1 (re-register)"
    if (-not $DryRun -and (Invoke-Script (Join-Path $ThDir 'watchdog\install-watchdog.ps1')) -ne 0) { Fail-Step 'watchdog' 'install-watchdog.ps1 failed (above)' }
  } elseif ($wd -eq 'ok') { Say "TermhubWatchdog runs this checkout's watchdog.ps1: kept" }
  else {
    Say "$verb termhub\watchdog\install-watchdog.ps1 -Ensure (the watchdog task is $wd)"
    if (-not $DryRun -and (Invoke-Script (Join-Path $ThDir 'watchdog\install-watchdog.ps1') @('-Ensure')) -ne 0) { Fail-Step 'watchdog' 'install-watchdog.ps1 -Ensure failed (above)' }
  }
}

# The factory: factory-serve runs this checkout's venv (uv sync ran above).
$fs = Get-TaskStatus 'factory-serve' @("$SfDir\.venv\Scripts\python.exe")
$fsArgs = "$(($script:Tasks | Where-Object { $_.TaskName -eq 'factory-serve' } | Select-Object -First 1).Arguments)"
# install-serve.ps1 registers --interval 300 and no --app unless told: a re-register would drop them.
$fsCustom = $fsArgs -match '--app\s' -or ($fsArgs -match '--interval\s+(\d+)' -and $Matches[1] -ne '300')
if (Test-Blocked 'factory-serve') {
  if ($fs -eq 'ok') { Say "factory-serve runs this checkout's factory serve; registered from an elevated shell: kept" }
  else { Need-Owner "factory-serve is $fs and was registered from an elevated shell: run software-factory\scripts\windows\install-serve.ps1 from an elevated PowerShell" }
} elseif ($fs -eq 'ok' -and $fsCustom) {
  Say "factory-serve runs this checkout's factory serve with its own --app/--interval: kept (re-run install-serve.ps1 with -Apps/-IntervalSeconds to change it)"
} elseif ($Reinstall -or $fs -ne 'ok') {
  Say "$verb software-factory\scripts\windows\install-serve.ps1 -SkipSync ($(if ($Reinstall) { 'reinstall' } else { "factory-serve is $fs" }))"
  if (-not $DryRun -and (Invoke-Script (Join-Path $SfDir 'scripts\windows\install-serve.ps1') @('-SkipSync')) -ne 0) { Fail-Step 'factory install' 'install-serve.ps1 failed (above)' }
} else { Say "factory-serve runs this checkout's factory serve: kept" }

# ---------------------------------------------------------------- start

Section 'start'
$script:Tasks = Get-Tasks
$PaPort = 7300
if ($env:PA_DISPATCH_PORT) { $PaPort = [int]$env:PA_DISPATCH_PORT } else { $p = Get-Setting 'PA_DISPATCH_PORT' @($PaEnv, $RootEnv); if ($p -and $p.Value -match '^\d+$') { $PaPort = [int]$p.Value } }
$thData = if ($env:TERMHUB_DATA_DIR) { $env:TERMHUB_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'termhub' }
$thState = @{ sessiondPort = 7010; activeFrontPort = 7000; publishPort = 7000 }
try { $j = Get-Content -Raw (Join-Path $thData 'state.json') | ConvertFrom-Json; foreach ($k in @($thState.Keys)) { if ($j.$k) { $thState[$k] = [int]$j.$k } } } catch { }
$PtydPort = if ($env:TERMHUB_PTYD_PORT) { [int]$env:TERMHUB_PTYD_PORT } else { 7020 }
$FsPort = if ($env:FACTORY_SERVE_PORT) { [int]$env:FACTORY_SERVE_PORT } else { 7330 }
$short = { param($c) if ($c) { "$c".Substring(0, [Math]::Min(7, "$c".Length)) } else { 'unknown' } }

# The PA: windows\redeploy.ps1 brings it to HEAD (a roll, or the restart a runtime switch needs).
$redeploy = Join-Path $PaDir 'windows\redeploy.ps1'
$paVer = Get-Json "http://127.0.0.1:$PaPort/api/version"
$from = if ($paVer -and $paVer.commit) { $paVer.commit } else { $head }
$supRuntime = $null
if ($paVer) {
  $st = Invoke-Capture -Exe $script:NodeExe -Arguments @('src\supervisor', 'status') -Cwd $PaDir
  try { $supRuntime = (($st.Lines -join "`n") | ConvertFrom-Json).runtime } catch { }
}
$wantRuntime = if ($paRuntime) { $paRuntime } else { 'node' }
$deployArgs = @('-From', $from) + $(if ($DryRun) { @('-DryRun') } else { @() })
if ((Get-TaskStatus 'pa-worker' @('pa-launch.ps1')) -eq 'missing' -and -not $DryRun) { Warn "PA: no pa-worker task; not started" }
elseif (-not $paVer) {
  Say "PA: nothing answers on :$PaPort; $verb windows\redeploy.ps1 -Restart (starts pa-worker)"
  $null = Invoke-Script $redeploy ($deployArgs + @('-Restart'))
} elseif ($Reinstall) {
  Say "PA: serves $(& $short $paVer.commit) on $supRuntime; $verb windows\redeploy.ps1 -From $(& $short $from) -Restart"
  $null = Invoke-Script $redeploy ($deployArgs + @('-Restart'))
} elseif ($head -and ($paVer.commit -ne $head -or $supRuntime -ne $wantRuntime)) {
  Say "PA: serves $(& $short $paVer.commit) on $supRuntime, HEAD is $(& $short $head) and PA_RUNTIME $wantRuntime; $verb windows\redeploy.ps1 -From $(& $short $from)"
  $null = Invoke-Script $redeploy $deployArgs
} else { Say "PA: serves HEAD on ${supRuntime}: nothing to do" }

# termhub: start.ps1 brings up what is down; restart-front.ps1 swaps the front (terminals stay).
$frontHealth = Get-Json "http://127.0.0.1:$($thState.activeFrontPort)/api/health"
$sess = Get-Json "http://127.0.0.1:$($thState.sessiondPort)/api/ping"
$wantFront = Get-Effective 'TERMHUB_FRONT' @($ThEnv, $RootEnv)
$wantPtyd = (Get-Effective 'TERMHUB_PTYD' @($ThEnv, $RootEnv)) -eq '1'
$frontPid = if ($frontHealth -and $frontHealth.self) { [int]$frontHealth.self.pid } else { 0 }
$frontRuntime = if (-not $frontPid) { 'none' } elseif (Test-JarvisdFront $frontPid) { 'jarvisd' } else { 'node' }
$frontCommit = if ($frontHealth -and $frontHealth.self) { $frontHealth.self.commit } else { $null }
$wins = Join-Path $ThDir 'windows'
if ($termhubInstalled) { Say "termhub: windows\install.ps1 started it" }
if (-not $sess -or -not $frontHealth) {
  Say "termhub: sessiond $(if ($sess) { 'up' } else { 'down' }), front $(if ($frontHealth) { 'up' } else { 'down' }); $verb windows\start.ps1"
  if (-not $DryRun -and (Invoke-Script (Join-Path $wins 'start.ps1')) -ne 0) { Fail-Step 'termhub start' 'windows\start.ps1 failed (above)' }
} elseif ($Reinstall -and "$($sess.ptyHost)" -eq 'ptyd' -and $wantPtyd) {
  Say "termhub: $verb windows\restart-sessiond.ps1 -Force (its terminals live in ptyd and stay; it restarts the front too)"
  if (-not $DryRun -and (Invoke-Script (Join-Path $wins 'restart-sessiond.ps1') @('-Force')) -ne 0) { Fail-Step 'termhub restart' 'restart-sessiond.ps1 failed (above)' }
} elseif ($Reinstall -or ($head -and $frontCommit -ne $head) -or ($wantFront -eq 'jarvisd' -and $frontRuntime -ne 'jarvisd')) {
  Say "termhub: front runs $(& $short $frontCommit) on $frontRuntime (want $(& $short $head) on $(if ($wantFront) { $wantFront } else { 'node' })); $verb windows\restart-front.ps1"
  if (-not $DryRun -and (Invoke-Script (Join-Path $wins 'restart-front.ps1')) -ne 0) { Fail-Step 'termhub front' 'restart-front.ps1 failed (above)' }
} else { Say "termhub: front serves HEAD on $frontRuntime, sessiond up: nothing to do" }
if ($sess -and $wantPtyd -and "$($sess.ptyHost)" -ne 'ptyd') {
  Need-Owner "move termhub's terminals into ptyd once: termhub\windows\restart-sessiond.ps1 from a plain PowerShell window (it ends the live terminals this one time)"
}

# The factory: serve follows HEAD by itself (it exits for new code and its task restarts it).
$fsHealth = Get-Json "http://127.0.0.1:$FsPort/api/health" @{ 'X-Factory' = '1' }
$ticks = 0
if ($fsHealth -and $fsHealth.running) { $ticks = if ($fsHealth.running -is [array]) { $fsHealth.running.Count } else { @($fsHealth.running.PSObject.Properties).Count } }
if (-not $fsHealth) {
  if ((Get-TaskStatus 'factory-serve' @('factory')) -eq 'missing' -and -not $DryRun) { Warn "factory: no factory-serve task; not started" }
  else {
    Say "factory: nothing answers on :$FsPort; $verb Start-ScheduledTask factory-serve"
    if (-not $DryRun) { Start-ScheduledTask -TaskName 'factory-serve' }
  }
} elseif ($Reinstall -and $ticks -eq 0) {
  # Stopping drains running ticks first; with none running that is immediate.
  Say "factory: no tick running; $verb Stop-ScheduledTask/Start-ScheduledTask factory-serve"
  if (-not $DryRun) {
    Stop-ScheduledTask -TaskName 'factory-serve' -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 60 -and (Get-Process -Id ([int]$fsHealth.pid) -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    Start-ScheduledTask -TaskName 'factory-serve'
  }
} elseif ($Reinstall) {
  Warn "factory: $ticks tick(s) running; not restarted (stopping serve drains them first). It restarts itself when HEAD moves"
} elseif ($head -and $fsHealth.head -ne $head) {
  Say "factory: serve runs $(& $short $fsHealth.head); it restarts itself within about a minute of HEAD moving"
} else { Say "factory: serve runs HEAD: nothing to do" }

# ---------------------------------------------------------------- verify

Section $(if ($DryRun) { 'now (a dry run verifies nothing)' } else { 'verify' })
$checks = @()
function Check([string]$what, [bool]$ok, [string]$detail) {
  $script:checks += [pscustomobject]@{ What = $what; Ok = $ok }
  $tag = if ($DryRun) { 'now ' } elseif ($ok) { 'OK  ' } else { 'FAIL' }
  $color = if ($DryRun) { 'Gray' } elseif ($ok) { 'Green' } else { 'Red' }
  Write-Host ("install: {0} {1,-9} {2}" -f $tag, $what, $detail) -ForegroundColor $color
}
function Wait-Until([scriptblock]$Probe, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($(if ($DryRun) { 0 } else { $Seconds }))
  do { $r = & $Probe; if ($r) { return $r }; if ($DryRun) { break }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $deadline)
  return $null
}

$paOk = Wait-Until { $h = Get-Json "http://127.0.0.1:$PaPort/healthz"; $v = Get-Json "http://127.0.0.1:$PaPort/api/version"; ($h -and $h.ready -and $v -and (-not $head -or $v.commit -eq $head)) } 180
$h = Get-Json "http://127.0.0.1:$PaPort/healthz"
$v = Get-Json "http://127.0.0.1:$PaPort/api/version"
Check 'PA' ([bool]$paOk) "/healthz $(if (-not $h) { 'no answer' } elseif ($h.ready) { 'ready' } else { 'not ready' }), /api/version $(& $short $(if ($v) { $v.commit }))$(if ($head) { " (HEAD $(& $short $head))" }) on :$PaPort"

$tv = Wait-Until { $x = Get-Json "http://127.0.0.1:$($thState.activeFrontPort)/api/version"; if ($x -and (-not $head -or $x.commit -eq $head)) { $x } } 60
$fh = Get-Json "http://127.0.0.1:$($thState.activeFrontPort)/api/health"
$fpid = if ($fh -and $fh.self) { [int]$fh.self.pid } else { 0 }
$frt = if (-not $fpid) { 'none' } elseif (Test-JarvisdFront $fpid) { 'jarvisd' } else { 'node' }
$frontOk = [bool]$tv -and ($wantFront -ne 'jarvisd' -or $frt -eq 'jarvisd')
$tvNow = if ($tv) { $tv } else { Get-Json "http://127.0.0.1:$($thState.activeFrontPort)/api/version" }
Check 'termhub' $frontOk "/api/version $(& $short $(if ($tvNow) { $tvNow.commit })) on :$($thState.activeFrontPort), front $frt$(if ($frt -eq 'jarvisd') { ' (bun main.ts front)' })"

if ($wantPtyd) {
  $pp = Wait-Until { $x = Get-Json "http://127.0.0.1:$PtydPort/api/ping"; if ($x -and $x.entry -eq 'ptyd') { $x } } 30
  Check 'ptyd' ([bool]$pp) "/api/ping $(if ($pp) { "entry ptyd, pid $($pp.pid), $(& $short $pp.commit)" } else { 'no ptyd' }) on :$PtydPort"
  $sp = Get-Json "http://127.0.0.1:$($thState.sessiondPort)/api/ping"
  Check 'sessiond' ([bool]($sp -and "$($sp.ptyHost)" -eq 'ptyd')) "$(if ($sp) { "pty host $($sp.ptyHost)" } else { 'down' }) on :$($thState.sessiondPort)"
}

$jl = Wait-Until { $x = Get-FactoryJobList; if ($x -and $x.code -eq 0) { $x } } 120
$fsNow = Get-Json "http://127.0.0.1:$FsPort/api/health" @{ 'X-Factory' = '1' }
Check 'factory' ([bool]$jl) "job list $(if ($jl) { "answered in $($jl.ms) ms" } else { 'did not answer' }) on :$FsPort$(if ($fsNow) { ", serve at $(& $short $fsNow.head)" })"

# ---------------------------------------------------------------- summary

Write-Host ""
if ($script:Owner.Count) {
  Write-Host "Needs you:" -ForegroundColor Yellow
  $script:Owner | Select-Object -Unique | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}
if ($DryRun) { Write-Host "Dry run: nothing was changed. Run without -DryRun to do the above." -ForegroundColor Cyan; exit 0 }
$bad = @($script:checks | Where-Object { -not $_.Ok } | ForEach-Object { $_.What })
if ($script:Failed.Count -or $bad.Count) {
  Write-Host "install: finished with problems: $(@($script:Failed + $bad) -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "install: done. The stack runs HEAD $(& $short $head)." -ForegroundColor Green
