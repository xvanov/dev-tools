'use strict';

// The other machines running termhub — for the dashboard's machine strip.
//
// **Stats stay per machine.** Nothing here merges anything: each machine keeps
// measuring its own PTYs (only it can) and keeps its own log, and this module
// only lets one dashboard *look at* the others. There is no hub, no central
// store, and no combined number that would hide which box the idle time was on.
//
// **The peer list is explicit, and that is a measured decision.** The obvious
// design — discover every tailnet peer and probe it — was tried against the
// real tailnet here: 14 peers, of which 3 run termhub and the rest are
// colleagues' laptops and an iPhone. Probing all of them on every dashboard
// load is 14 requests, most of which sit until they time out. So the list is
// configured, and `scan()` exists to fill it in once rather than on every load.
//
// Configuration, first hit wins:
//   TERMHUB_PEERS=host:port,host:port          (env)
//   <dataDir>/peers.json  { "peers": ["host:port", …] }
//
// A bare host gets the default publish port. Entries may also be full URLs, for
// a machine published somewhere unusual.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const { dataDir } = require('./paths');

// Where a termhub front actually answers, in the order worth trying. All three
// forms are real deployments in this fleet, and the list is what a scan across
// the live tailnet produced:
//
//   https :7000  Windows single-port behind Tailscale Serve (the default)
//   https :7443  a Linux box publishing 7443 in front of a front on 7000
//   http  :7000  plain-HTTP mode (windows/start-http.ps1 binds the tailnet IP
//                itself and turns Serve OFF for that port)
//
// The plain-HTTP row is not hypothetical padding: probing https-only found ONE
// of the fleet's machines. Two more were sitting right there answering plain
// HTTP on 7000 and showed up as `ECONNRESET` and `EPROTO` — a TLS handshake
// against a server that speaks none. A scan that can't see them is a machine
// strip that quietly loses a third of your fleet.
const PROBE_TARGETS = [
  { scheme: 'https', port: 7000 },
  { scheme: 'https', port: 7443 },
  { scheme: 'http', port: 7000 },
];
const DEFAULT_PORTS = [7000, 7443];
const PROBE_TIMEOUT_MS = 2500;
const SCAN_CONCURRENCY = 6;

function peersFile() {
  return path.join(dataDir(), 'peers.json');
}

function normalize(entry) {
  const raw = String(entry || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  // Tailscale's DNSName comes with a trailing dot; a URL must not have one.
  const clean = raw.replace(/\.(?=:|$)/, '');
  return /:\d+$/.test(clean) ? `https://${clean}` : `https://${clean}:${DEFAULT_PORTS[0]}`;
}

function readFileList() {
  try {
    const raw = fs.readFileSync(peersFile(), 'utf8').replace(/^﻿/, '');   // PowerShell writes a BOM
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.peers)) return data.peers;
  } catch {
    // no peers configured is the normal state on a single-machine install
  }
  return [];
}

// The configured peers, as absolute URLs. De-duplicated, because a host listed
// twice would be probed twice and shown twice.
function list() {
  const fromEnv = String(process.env.TERMHUB_PEERS || '').split(',');
  const entries = fromEnv.some((s) => s.trim()) ? fromEnv : readFileList();
  const out = [];
  for (const e of entries) {
    const url = normalize(e);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

function save(entries) {
  const peers = [];
  for (const e of entries || []) {
    const url = normalize(e);
    if (url && !peers.includes(url)) peers.push(url);
  }
  fs.writeFileSync(peersFile(), JSON.stringify({ peers }, null, 2));
  return peers;
}

// GET JSON from a peer. Resolves `null` for anything that isn't a clean 200 —
// a machine that is asleep, rebooting, or not running termhub is the expected
// case here, not an error worth propagating into the UI as a failure.
function fetchJson(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let target;
    try { target = new URL(url); } catch { return done(null); }
    const lib = target.protocol === 'http:' ? http : https;
    // ts.net certificates are publicly trusted, so the default verification
    // applies — deliberately NOT disabled. A peer that fails TLS is a peer we
    // shouldn't be reading numbers from.
    const req = lib.get({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return done(null);
        try { done(JSON.parse(raw)); } catch { done(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

// Ask one peer who it is. `/api/ping` is sessiond's identity endpoint, proxied
// by the front — so a 200 here means "termhub is up on this URL AND its
// supervisor is reachable", which is exactly the bar for showing it as online.
async function identify(url) {
  const info = await fetchJson(`${url}/api/ping`);
  if (!info || !info.ok) return { url, online: false, machine: null };
  return { url, online: true, machine: info.machine || null, sessions: info.sessions ?? null, commit: info.commit || null };
}

// Every configured peer's identity, probed in parallel. Bounded by how many
// peers you configured, which is a handful by construction.
function status() {
  return Promise.all(list().map(identify));
}

// ---- discovery -------------------------------------------------------------

// Parse `tailscale status --json` into candidate hosts. Kept separate from the
// spawn so it can be tested against captured output (test/peers.test.js).
// Offline peers are dropped: probing a machine Tailscale already says is down
// costs one timeout each and can only produce "offline", which we knew.
function candidatesFromStatus(status) {
  const out = [];
  const add = (p) => {
    if (!p || !p.DNSName || !p.Online) return;
    // Phones and tablets never run termhub; skipping them is not an
    // optimisation, it's avoiding a pointless 2.5s timeout per device.
    if (/^(ios|android|tvos)$/i.test(String(p.OS || ''))) return;
    out.push({ host: String(p.DNSName).replace(/\.$/, ''), name: p.HostName || null });
  };
  for (const p of Object.values((status && status.Peer) || {})) add(p);
  return out;
}

function tailscaleStatus() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Which tailnet machines are actually running termhub. Used to fill the peer
// list in once, from the dashboard — not on every load. Tries each candidate on
// both default ports, because the port is a per-machine deployment choice.
async function scan() {
  const status = await tailscaleStatus();
  if (!status) return { available: false, found: [] };
  const candidates = candidatesFromStatus(status);
  const targets = [];
  for (const c of candidates) {
    for (const t of PROBE_TARGETS) targets.push({ ...c, url: `${t.scheme}://${c.host}:${t.port}` });
  }

  const results = await mapLimit(targets, SCAN_CONCURRENCY, async (t) => {
    const info = await identify(t.url);
    return info.online ? { url: t.url, machine: info.machine || t.name, sessions: info.sessions } : null;
  });

  // One machine can answer on both ports (single-port Windows publishes 7000
  // and nothing else, but a Linux box can genuinely serve both). Keep the first.
  const seen = new Set();
  const found = [];
  for (const r of results) {
    if (!r || seen.has(r.machine)) continue;
    seen.add(r.machine);
    found.push(r);
  }
  return { available: true, found };
}

module.exports = {
  list, save, status, identify, fetchJson, scan, candidatesFromStatus, normalize,
  DEFAULT_PORTS, PROBE_TARGETS, peersFile,
};
