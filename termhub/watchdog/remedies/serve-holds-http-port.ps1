# REPAIRS: serve-holds-http-port
#
# The classifier mints this when the mode resolved to plain-HTTP (Serve reads "not
# published" for the publish port) and yet tailscaled is listening on
# <tailnet ip>:<publish port>, the address a plain-HTTP front would own.
#
# FIRST RESPONSE, 2026-11-16 (LAP-US101): the machine was NOT a plain-HTTP machine.
# Its Termhub logon task runs start.ps1 (single-port), and a healthy front (the jarvisd
# bun front, pid 42944) was on 127.0.0.1:7000 with sessiond (5 live sessions) behind
# it. `tailscale serve status` said "No serve config" and `--json` returned `{}`, while
# tailscaled (BackendState Running) still held 100.126.164.21:7000 and fd7a:...:7000 and
# reset every connection to it. So Serve's config had been lost and its listener left
# behind; Resolve-TermhubTopology read the empty config as "Serve is off" => mode
# 'http' => the stale listener looked like Serve squatting the front's address. Why
# the config was lost is unknown (no logout was visible at the time; the same loss is
# documented after key-expiry re-logins in AGENT.md, Port modes).
# The repair was ONE command, no process touched:
#     tailscale serve --bg --https=7000 http://127.0.0.1:7000
# after which https://<host>.ts.net:7000/api/health answered ok with entry 'front' and
# the classifier read the machine as single-port and healthy.
#
# So this signature has two meanings, and the evidence on the box tells them apart:
#
#   A. single-port machine, Serve config lost. A healthy front answers on
#      127.0.0.1:<publish port>. Re-assert Serve to it - exactly what start.ps1 and
#      restart-front.ps1 do - and leave the front and sessiond alone. Turning Serve OFF
#      and running start-http.ps1 instead would flip the user's layout and, with
#      tailscaled still holding the socket, likely fail to bind and leave no front.
#   B. plain-HTTP machine (the Termhub logon task runs start-http.ps1) where Serve really
#      was turned on for the port (update.ps1's old bug, see AGENT.md). start-http.ps1
#      turns Serve off for the port and binds the front to the tailnet IP. If tailscaled
#      keeps the socket after Serve is off (observed 2026-08-19 with no config at all),
#      the bind fails and this exits 1: freeing it means restarting tailscaled, which
#      is not a reflex for a script.
#   C. neither (no loopback front, task is start.ps1 or unreadable): single-port is the
#      default layout, so start.ps1 - idempotent, reuses sessiond, starts a loopback
#      front, re-asserts Serve.
#
# sessiond is never restarted on any path: Confirm-Sessiond only starts one if it is
# down, and this signature is classified with sessiond up.

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

$windows = Join-Path $ProjectDir 'windows'
if (-not $PublishPort) { $PublishPort = [int](Get-TermhubState).publishPort }

# The watchdog's task PATH is not the interactive one (tailnet-ip-unavailable.ps1,
# cause 1). Everything below and the scripts it calls use bare `tailscale`.
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($root -and (Test-Path (Join-Path $root 'Tailscale\tailscale.exe'))) {
      $env:PATH = "$(Join-Path $root 'Tailscale');$env:PATH"; break
    }
  }
}

# Is a termhub front healthy on loopback at the publish port? That is the single-port
# layout, whatever Serve says now (the same rule restart-front.ps1 applies).
function Test-LoopbackFront {
  $p = Get-HttpProbe "http://127.0.0.1:$PublishPort/api/health"
  return ($p.Json -and $p.Json.ok -eq $true -and $p.Json.self -and $p.Json.self.entry -eq 'front')
}

$taskAction = ''
try {
  $taskAction = ((Get-ScheduledTask -TaskName 'Termhub' -ErrorAction Stop).Actions |
                 ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' '
} catch { }

$layout = ''
try {
  if (Test-LoopbackFront) {
    $layout = 'single'
    Write-Host "remedy: a healthy front is on 127.0.0.1:$PublishPort - single-port machine whose Serve config was lost. Re-asserting Serve; front and sessiond untouched."
    $r = Invoke-Native tailscale -Arguments @('serve', '--bg', "--https=$PublishPort", "http://127.0.0.1:$PublishPort")
    Write-Host $r.Text
    if ($r.Code -ne 0) { Write-Host "remedy: 'tailscale serve' exited $($r.Code)."; exit 1 }
  }
  elseif ($taskAction -match 'start-http\.ps1') {
    $layout = 'http'
    Write-Host "remedy: the Termhub task runs start-http.ps1 - plain-HTTP machine. start-http.ps1 -Port $PublishPort (turns Serve off for the port, binds the tailnet IP)."
    & (Join-Path $windows 'start-http.ps1') -Port $PublishPort
  }
  else {
    $layout = 'single'
    Write-Host "remedy: no front on loopback and the Termhub task is not plain-HTTP ('$taskAction') - single-port default. start.ps1 -PublishPort $PublishPort."
    & (Join-Path $windows 'start.ps1') -PublishPort $PublishPort
  }
} catch {
  Write-Host "remedy: the $layout repair failed: $($_.Exception.Message)"
  if ($layout -eq 'http') {
    Write-Host "remedy: if tailscaled still holds the tailnet address with Serve off, only restarting the Tailscale service frees it - left to a human/escalation."
  }
  exit 1
}

# Verify. The classifier re-resolves the mode from Serve, so a successful re-assert
# makes it read 'single' and probe loopback; for that layout also require that Serve
# really publishes the port, or the box works only from itself.
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $d = Get-TermhubDiagnosis
  $served = ($layout -ne 'single') -or ((Test-ServePublished -Port $PublishPort) -eq $true)
  if ($d.Healthy -and $served) {
    $front = $d.FrontProbe.Json
    if ($front -and $front.self.entry -eq 'front' -and $front.sessiond.ok -eq $true) {
      Write-Host "remedy: verified healthy ($($d.Topology.Mode), $($d.Topology.FrontUrl), entry front, sessiond ok with $($front.sessiond.sessions) session(s))."
      exit 0
    }
  }
  Start-Sleep -Seconds 2
}

$d = Get-TermhubDiagnosis
Write-Host "remedy: still not healthy after the $layout repair: $($d.Signature) - $($d.Detail)"
exit 1
