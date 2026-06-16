'use strict';

const os = require('os');
const { execFileSync } = require('child_process');

// Tailscale assigns addresses out of the 100.64.0.0/10 CGNAT range.
function isTailscaleV4(addr) {
  const m = /^(\d+)\.(\d+)\./.exec(addr);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

// Resolve the address the server should bind to. Order of precedence:
//   1. TERMHUB_BIND env var (explicit; e.g. "0.0.0.0", "127.0.0.1", or an IP)
//   2. `tailscale ip -4` if the CLI is available
//   3. First local interface address in the 100.64.0.0/10 range
//   4. Fall back to 127.0.0.1 (loopback) so we never accidentally bind public.
function resolveBindAddress() {
  if (process.env.TERMHUB_BIND) return process.env.TERMHUB_BIND;

  try {
    const out = execFileSync('tailscale', ['ip', '-4'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ip = out.split(/\s+/).map((s) => s.trim()).filter(Boolean)[0];
    if (ip && isTailscaleV4(ip)) return ip;
  } catch {
    // tailscale CLI not present or errored — fall through to interface scan.
  }

  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal && isTailscaleV4(ni.address)) {
        return ni.address;
      }
    }
  }

  return '127.0.0.1';
}

module.exports = { resolveBindAddress, isTailscaleV4 };
