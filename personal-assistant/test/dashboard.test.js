'use strict';

// The dashboard can start agents, so its guards are tested, not assumed.

const assert = require('assert');
const { hostAllowed } = require('../src/dashboard/server');

assert.ok(hostAllowed('127.0.0.1:7300'));
assert.ok(hostAllowed('localhost:7300'));
assert.ok(hostAllowed('[::1]:7300'));
// DNS rebinding arrives with the attacker's hostname in Host.
assert.ok(!hostAllowed('evil.example:7300'));
assert.ok(!hostAllowed('100.64.0.5:7300'));
assert.ok(!hostAllowed(''));
assert.ok(!hostAllowed(undefined));

console.log('dashboard ok');
