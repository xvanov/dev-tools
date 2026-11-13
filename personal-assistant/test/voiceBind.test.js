'use strict';

// voice/server.py must be the only owner of its port. http.server's SO_REUSEADDR let a second
// pa-voice bind and LISTEN beside the first on Windows (two services, the stale one on the GPU).
// Needs a Python 3 on PATH (stdlib only: server.py imports torch lazily); skipped without one.

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const py = ['python', 'python3', 'py'].find((c) => spawnSync(c, ['-c', 'pass']).status === 0);
if (!py) {
  console.log('voiceBind: no python on PATH, skipped');
  process.exit(0);
}

const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'voice'))})
import server
a = server.VoiceHTTPServer(('127.0.0.1', 0), server.BaseHTTPRequestHandler)
port = a.server_address[1]
try:
    b = server.VoiceHTTPServer(('127.0.0.1', port), server.BaseHTTPRequestHandler)
    print('DOUBLE-BIND')
except OSError:
    print('REFUSED')
print('health', server.health_answers('127.0.0.1', port, 0.3))
`;
const r = spawnSync(py, ['-I', '-c', script], { encoding: 'utf8' });
assert.strictEqual(r.status, 0, r.stderr);
assert.ok(r.stdout.includes('REFUSED'), `second bind must fail, got: ${r.stdout}`);
assert.ok(r.stdout.includes('health False'), 'a non-pa-voice listener is not a healthy voice server');
console.log('voiceBind: ok');
