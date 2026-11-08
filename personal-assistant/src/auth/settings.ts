'use strict';

// Passkey settings (plan 7.1), read from the environment at CALL time so a
// test (or `pa passkeys status`) sees what it just set. The flag is off by
// default: with PA_PASSKEYS unset or anything but "on", the dashboard behaves
// exactly as it did before this existed (loopback + Host + X-PA + page token)
// and no passkey table is read.
//
//   PA_PASSKEYS            off | on                     (default off)
//   PA_PASSKEY_RP_ID       the WebAuthn relying-party id (default localhost); for the
//                          tailnet this is the MagicDNS name the browser sees
//   PA_PASSKEY_ORIGINS     comma-separated origins a ceremony may come from (default
//                          http://localhost:<dispatch port>, http://127.0.0.1:<port>)
//   PA_PASSKEY_SESSION_MIN idle lifetime of a session cookie, minutes, slides on use (30)
//   PA_PASSKEY_SESSION_MAX_HOURS  hard ceiling on a session, hours (12)
//   PA_PASSKEY_STEPUP_SEC  how long a step-up assertion stays valid for its approval (120)
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).


function str<T>(name: string, fallback: T): string | T {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num<T>(name: string, fallback: T): number | T {
  const n = Number(str(name, ''));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function enabled() {
  return String(process.env.PA_PASSKEYS || 'off').trim().toLowerCase() === 'on';
}

function settings() {
  const port = Number(process.env.PA_DISPATCH_PORT) || 7300;
  const origins = String(str('PA_PASSKEY_ORIGINS', ''))
    .split(',')
    .map((s: string) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return {
    enabled: enabled(),
    rpId: str('PA_PASSKEY_RP_ID', 'localhost'),
    rpName: 'PA',
    origins: origins.length ? origins : [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
    idleMs: Number(num('PA_PASSKEY_SESSION_MIN', 30)) * 60_000,
    hardMs: Number(num('PA_PASSKEY_SESSION_MAX_HOURS', 12)) * 3600_000,
    stepUpMs: Number(num('PA_PASSKEY_STEPUP_SEC', 120)) * 1000,
    challengeMs: 120_000,
  };
}

module.exports = { enabled, settings };
