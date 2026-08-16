'use strict';

// Covers lib/peers.js — the peer list and the discovery filter behind the
// dashboard's machine strip.
//
// The fixture is trimmed from this tailnet's real `tailscale status --json`,
// and it is the reason discovery is filtered rather than exhaustive: 14 peers,
// of which three run termhub, the rest being colleagues' laptops and a phone.
// Probing all of them costs a 2.5s timeout each, on every dashboard load, to
// answer a question that changes about once a year.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-peers-'));
process.env.TERMHUB_DATA_DIR = DATA;
delete process.env.TERMHUB_PEERS;

const peers = require('../lib/peers');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}

// Real shape: DNSName carries a trailing dot, HostName is the machine's own
// name, Online is what Tailscale itself believes.
const STATUS = {
  Self: { DNSName: 'lap-us101.porgy-boga.ts.net.', HostName: 'LAP-US101', Online: true, OS: 'windows' },
  Peer: {
    'k1:': { DNSName: 'desktop-r3n4s1s.porgy-boga.ts.net.', HostName: 'DESKTOP-R3N4S1S', Online: true, OS: 'windows' },
    'k2:': { DNSName: 'b.porgy-boga.ts.net.', HostName: 'b', Online: true, OS: 'linux' },
    'k3:': { DNSName: 'lap-us153.porgy-boga.ts.net.', HostName: 'LAP-US153', Online: false, OS: 'windows' },
    'k4:': { DNSName: 'iphone-14.porgy-boga.ts.net.', HostName: 'localhost', Online: true, OS: 'iOS' },
  },
};

console.log('peers — discovery candidates');

ok('offline peers are skipped', () => {
  const hosts = peers.candidatesFromStatus(STATUS).map((c) => c.host);
  assert.ok(!hosts.some((h) => h.startsWith('lap-us153')), 'a machine Tailscale says is down costs a timeout to learn nothing');
});

ok('phones are skipped', () => {
  const hosts = peers.candidatesFromStatus(STATUS).map((c) => c.host);
  assert.ok(!hosts.some((h) => h.startsWith('iphone')), 'an iPhone never runs termhub');
});

ok('the trailing dot is stripped', () => {
  const hosts = peers.candidatesFromStatus(STATUS).map((c) => c.host);
  assert.deepStrictEqual(hosts, ['desktop-r3n4s1s.porgy-boga.ts.net', 'b.porgy-boga.ts.net']);
});

ok('a status with no peers is empty, not a throw', () => {
  assert.deepStrictEqual(peers.candidatesFromStatus(null), []);
  assert.deepStrictEqual(peers.candidatesFromStatus({}), []);
});

console.log('peers — the configured list');

ok('a bare host gets the default publish port and https', () => {
  assert.strictEqual(peers.normalize('desktop-r3n4s1s.porgy-boga.ts.net'), 'https://desktop-r3n4s1s.porgy-boga.ts.net:7000');
});

ok('an explicit port is honoured — a Linux box commonly publishes 7443', () => {
  assert.strictEqual(peers.normalize('b.porgy-boga.ts.net:7443'), 'https://b.porgy-boga.ts.net:7443');
});

ok('a full URL passes through, trailing slash trimmed', () => {
  assert.strictEqual(peers.normalize('http://192.168.1.5:7000/'), 'http://192.168.1.5:7000');
});

ok('a DNSName with its trailing dot still normalises', () => {
  assert.strictEqual(peers.normalize('b.porgy-boga.ts.net.'), 'https://b.porgy-boga.ts.net:7000');
});

ok('save() de-duplicates and list() reads it back', () => {
  const saved = peers.save(['b.porgy-boga.ts.net:7443', 'b.porgy-boga.ts.net:7443', 'desktop-r3n4s1s.porgy-boga.ts.net']);
  assert.strictEqual(saved.length, 2);
  assert.deepStrictEqual(peers.list(), saved);
});

ok('a missing peers.json is an empty list, not an error', () => {
  fs.unlinkSync(peers.peersFile());
  assert.deepStrictEqual(peers.list(), []);
});

ok('TERMHUB_PEERS wins over the file', () => {
  peers.save(['b.porgy-boga.ts.net:7443']);
  process.env.TERMHUB_PEERS = 'desktop-qluncpc.porgy-boga.ts.net';
  assert.deepStrictEqual(peers.list(), ['https://desktop-qluncpc.porgy-boga.ts.net:7000']);
  delete process.env.TERMHUB_PEERS;
});

ok('a BOM-prefixed peers.json still parses', () => {
  // PowerShell 5.1's `Out-File -Encoding utf8` writes one, and this file is
  // meant to be hand-editable. Same trap as notify.json.
  fs.writeFileSync(peers.peersFile(), '﻿' + JSON.stringify({ peers: ['b.porgy-boga.ts.net:7443'] }));
  assert.deepStrictEqual(peers.list(), ['https://b.porgy-boga.ts.net:7443']);
});

console.log(`\n${passed} assertions passed`);
