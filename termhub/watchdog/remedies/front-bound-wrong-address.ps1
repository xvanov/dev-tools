# REPAIRS: front-bound-wrong-address
#
# The classifier mints this when front-<port>.pid names a live front, nothing at all
# answers on the address the resolved mode publishes, and nothing foreign holds that
# address either. The front is running, but at an address no client is sent to.
#
# FIRST RESPONSE, 2026-11-26 (LAP-US101): the box had been single-port (Termhub logon
# task = start.ps1, healthy jarvisd bun front on 127.0.0.1:7000, sessiond with
# 7 live sessions behind it). Then the Tailscale node RE-REGISTERED AS A NEW NODE: its
# tailnet IPs changed (100.126.164.21 -> 100.103.204.112, and the fd7a: address too),
# and Serve's config was gone ("No serve config", `--json` = {}). tailscaled still held
# its old Serve sockets on the OLD addresses (100.126.164.21:7000, fd7a:..:c534:a415:7000).
# Empty Serve config => mode resolved to 'http' => the classifier probed
# http://<new tailnet IP>:7000, found nothing there and no squatter either (the stale
# tailscaled sockets are on the old IP), so it fell through to this signature rather than
# serve-holds-http-port (that one is the same loss with the tailnet IP unchanged).
# Why the node re-registered is unknown (LAP-US101 has a history of node-key expiry, see
# AGENT.md troubleshooting, but the evidence did not show which).
#
# Re-asserting Serve (the serve-holds-http-port repair) did NOT work: on the new node
# `tailscale serve --bg --https=7000 ...` printed "Serve is not enabled on your tailnet.
# To enable, visit: https://login.tailscale.com/f/serve?node=..." and then BLOCKED
# waiting for a human to click it. So it is tried here only under a hard timeout.
# What restored service was start-http.ps1 -Port 7000: it turned Serve off for the
# port (no-op), reused sessiond, saw front-7000.pid alive but not bound to the tailnet
# IP, replaced only the front, and bound it to <tailnet IP>:7000. The watchdog then read
# the machine as healthy plain-HTTP. That does flip the layout from single-port to
# plain-HTTP until a human enables Serve for the node and runs start.ps1 again, but it
# is the only layout reachable from the tailnet without that human.
#
# Order of repair:
#   0. Already healthy => exit 0, touch nothing (idempotence).
#   1. Mode 'http' and a healthy front on 127.0.0.1:<publish port> => a single-port box
#      whose Serve config was lost. Try `tailscale serve --bg` with a 15s cap; if Serve
#      then publishes the port, done, front untouched.
#   2. Mode 'http' otherwise (or step 1 failed) => start-http.ps1 -Port <publish port>,
#      which replaces only the front and binds it to the tailnet IP.
#   3. Mode 'single'/'bluegreen' => restart-front.ps1, the mode-preserving front
#      redeploy (a front bound to the tailnet IP while Serve publishes loopback).
#
# sessiond is never restarted: start-http.ps1 and restart-front.ps1 both go through
# Confirm-Sessiond, which only starts one if it is down. No process is killed here
# except a `tailscale serve` CLI this script itself launched and that hung.

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

# The watchdog's task PATH is not the interactive one (tailnet-ip-unavailable.ps1).
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($root -and (Test-Path (Join-Path $root 'Tailscale\tailscale.exe'))) {
      $env:PATH = "$(Join-Path $root 'Tailscale');$env:PATH"; break
    }
  }
}

function Test-FrontHealth([string]$Url) {
  $p = Get-HttpProbe "$Url/api/health"
  return ($p.Json -and $p.Json.ok -eq $true -and $p.Json.self -and
          $p.Json.self.entry -eq 'front' -and $p.Json.sessiond -and $p.Json.sessiond.ok -eq $true)
}

# `tailscale serve --bg` blocks indefinitely when Serve is not enabled for the node
# (it waits for the admin-console URL it prints to be visited). Run it with a cap.
function Invoke-ServeAssert([int]$Port, [int]$TimeoutSec = 15) {
  $exe = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
  if (-not $exe) { Write-Host "remedy: tailscale.exe not found."; return $false }
  $out = [IO.Path]::GetTempFileName(); $err = [IO.Path]::GetTempFileName()
  try {
    $p = Start-Process -FilePath $exe -ArgumentList @('serve', '--bg', "--https=$Port", "http://127.0.0.1:$Port") `
         -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
      try { $p.Kill() } catch { }
      Write-Host "remedy: 'tailscale serve' did not return in ${TimeoutSec}s (Serve probably not enabled for this node): $((Get-Content $out, $err -Raw -ErrorAction SilentlyContinue) -join ' ')"
      return $false
    }
    Write-Host "remedy: 'tailscale serve' exited $($p.ExitCode): $((Get-Content $out, $err -Raw -ErrorAction SilentlyContinue) -join ' ')"
    return ((Test-ServePublished -Port $Port) -eq $true)
  } catch {
    Write-Host "remedy: 'tailscale serve' failed: $($_.Exception.Message)"; return $false
  } finally {
    Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  }
}

$d = Get-TermhubDiagnosis
if ($d.Healthy) { Write-Host "remedy: already healthy ($($d.Topology.Mode), $($d.Topology.FrontUrl)) - nothing to do."; exit 0 }
$mode = $d.Topology.Mode
Write-Host "remedy: $($d.Signature) in mode '$mode' - $($d.Detail)"

$path = ''
try {
  if ($mode -eq 'http') {
    $served = $false
    if (Test-FrontHealth "http://127.0.0.1:$PublishPort") {
      Write-Host "remedy: a healthy front is on 127.0.0.1:$PublishPort - single-port box whose Serve config was lost. Trying to re-assert Serve first."
      $served = Invoke-ServeAssert -Port $PublishPort
    }
    if ($served) {
      $path = 'serve'
    } else {
      $path = 'http'
      Write-Host "remedy: start-http.ps1 -Port $PublishPort (replaces only the front, binds it to the tailnet IP; sessiond reused)."
      & (Join-Path $windows 'start-http.ps1') -Port $PublishPort
    }
  } else {
    $path = 'restart-front'
    Write-Host "remedy: restart-front.ps1 (mode-preserving front redeploy; sessiond reused)."
    & (Join-Path $windows 'restart-front.ps1')
  }
} catch {
  Write-Host "remedy: the '$path' repair failed: $($_.Exception.Message)"
  exit 1
}

# Verify against what the watchdog itself will check: the classifier re-resolves the
# mode (a re-asserted Serve makes it 'single'), so 'healthy' from it plus an explicit
# entry=='front' and sessiond ok on the probed URL.
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  $d = Get-TermhubDiagnosis
  if ($d.Healthy) {
    $front = $d.FrontProbe.Json
    if ($front -and $front.self.entry -eq 'front' -and $front.sessiond.ok -eq $true) {
      Write-Host "remedy: verified healthy via '$path' ($($d.Topology.Mode), $($d.Topology.FrontUrl), front pid $($front.self.pid), sessiond ok with $($front.sessiond.sessions) session(s))."
      if ($path -eq 'http') {
        Write-Host "remedy: NOTE the box is now plain-HTTP. If it was single-port, a human should enable Serve for this node in the Tailscale admin console and re-run windows\start.ps1."
      }
      exit 0
    }
  }
  Start-Sleep -Seconds 2
}

$d = Get-TermhubDiagnosis
Write-Host "remedy: still not healthy after the '$path' repair: $($d.Signature) - $($d.Detail)"
exit 1
