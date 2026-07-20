# termhub boot (plain-HTTP variant) — start sessiond + front, bind the front
# DIRECTLY to the tailnet IP over plain HTTP, and do NOT use Tailscale Serve.
#
# Use this instead of start.ps1 on machines where:
#   - raw ports ARE reachable on the Tailscale interface (no firewall block), and
#   - clients force HTTPS / can't resolve the MagicDNS name, making Serve painful.
#
# Result:  http://<tailscale-ip>:<port>/   (no TLS, no hostname, no cert)
#
#     .\windows\start-http.ps1 [-Port 7000]

param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$state = Get-TermhubState
if ($Port -eq 0) { $Port = $state.publishPort }
$sessiondPort = $state.sessiondPort

# Make sure Serve isn't also holding this port (it would shadow the front).
# Tolerate "handler does not exist" (no serve config, e.g. right after a reboot):
# a native stderr line would otherwise become a terminating error under -Stop
# and abort the whole boot.
try { & tailscale serve --https=$Port off 2>$null | Out-Null } catch { }

# 1) Persistent supervisor (owns the PTYs). Reused if already alive.
$sessiondPort = Confirm-Sessiond -Port $sessiondPort

# 2) Resolve the tailnet IP to bind the front to.
$ip = ((& tailscale ip -4) | Select-Object -First 1).Trim()
if (-not $ip) { throw "could not determine Tailscale IPv4 address (tailscale ip -4)" }

# 3) Front: bind to <tailnet-ip>:<port> over plain HTTP, proxy /api -> sessiond.
#    Reuse a live front on this port; otherwise (re)start it.
$frontName = "front-$Port"
$finfo = Get-PidInfo $frontName
if ($finfo -and (Test-NodeAlive $finfo.Pid)) {
  Write-Host "termhub: front already running (pid $($finfo.Pid), port $Port)"
} else {
  Stop-Front $frontName
  Write-Host "termhub: starting front on ${ip}:$Port (plain HTTP) -> sessiond 127.0.0.1:$sessiondPort ..."
  Start-TermhubNode -Script 'front.js' -EnvVars @{
    TERMHUB_FRONT_PORT    = $Port
    TERMHUB_SESSIOND_PORT = $sessiondPort
    TERMHUB_BIND          = $ip
  } | Out-Null

  # Health-check against the tailnet IP (front is NOT on loopback here).
  $deadline = (Get-Date).AddSeconds(12); $ok = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://${ip}:$Port/api/health"
      if (($r.Content | ConvertFrom-Json).ok -eq $true) { $ok = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  if (-not $ok) { throw "front did not become healthy on ${ip}:$Port" }
}

Set-TermhubState @{ sessiondPort = $sessiondPort; activeFrontPort = $Port; publishPort = $Port } | Out-Null
Write-Host ""
Write-Host "termhub up:  http://${ip}:$Port/   (sessiond 127.0.0.1:$sessiondPort, front ${ip}:$Port, no Serve)"
