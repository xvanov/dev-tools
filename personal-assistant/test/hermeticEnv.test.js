'use strict';

// The shared runner strips a live stack's environment from each test process.
// What CI sets on purpose is kept; everything else the stack exports is not.

const assert = require('assert');
const { scrubStackEnv } = require('../../scripts/run-tests.js');

const env = scrubStackEnv({
  PATH: '/bin',
  HOME: '/home/tester',
  PTYD_BIN: '/opt/ptyd',
  PA_DB: 'sqlite',
  PA_FAST_LANE: '0',
  PA_TEST_PG_URL: 'postgres://pa:pa@127.0.0.1:5433/postgres',
  PA_CONTRACT_BACKENDS: 'sqlite',
  PA_CONTRACT_STRICT: '0',
  PA_JARVISD_EXE: '/opt/jarvisd',
  PA_COMPAT_BASE: 'abc',
  TERMHUB_PTYD: '1',
  TERMHUB_PTYD_RESOLVED: '1',
  TERMHUB_FRONT: 'jarvisd',
  TERMHUB_PEERS: 'peer.example',
  FACTORY_TERMHUB_PUBLIC_URL: 'http://127.0.0.1:1',
  AZURE_OPENAI_API_KEY: 'k',
  ANTHROPIC_API_KEY: 'k',
  OPENAI_API_KEY: 'k',
  OPENROUTER_API_KEY: 'k',
  DEEPSEEK_API_KEY: 'k',
  GH_TOKEN: 't',
  GITHUB_TOKEN: 't',
  GH_ENTERPRISE_TOKEN: 't',
  GITHUB_ENTERPRISE_TOKEN: 't',
  GH_HOST: 'github.com',
  GITHUB_PAT: 't',
  GH_PAT: 't',
});

assert.strictEqual(env.PATH, '/bin');
assert.strictEqual(env.HOME, '/home/tester');
assert.strictEqual(env.PTYD_BIN, '/opt/ptyd');
assert.strictEqual(env.PA_TEST_PG_URL, 'postgres://pa:pa@127.0.0.1:5433/postgres');
assert.strictEqual(env.PA_CONTRACT_BACKENDS, 'sqlite');
assert.strictEqual(env.PA_CONTRACT_STRICT, '0');
assert.strictEqual(env.PA_JARVISD_EXE, '/opt/jarvisd');
assert.strictEqual(env.PA_COMPAT_BASE, 'abc');
for (const k of [
  'PA_DB', 'PA_FAST_LANE', 'TERMHUB_PTYD', 'TERMHUB_PTYD_RESOLVED', 'TERMHUB_FRONT', 'TERMHUB_PEERS',
  'FACTORY_TERMHUB_PUBLIC_URL', 'AZURE_OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GITHUB_PAT', 'GH_PAT',
]) assert.strictEqual(env[k], undefined, k);

console.log('hermeticEnv ok');
