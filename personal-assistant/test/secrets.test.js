'use strict';

// Secret values flow browser → store and nowhere else. These tests pin that:
// no endpoint or MCP result echoes one, the fulfil endpoint keeps the
// dashboard's guards, the value reaches PowerShell on stdin and never in
// argv, no log line contains it, and .env is only written when git ignores it.
//
// Postgres and the Credential Manager are replaced by in-memory fakes; the
// real vault is exercised by hand (see README, "Secrets").

process.env.PA_LOG_LEVEL = 'debug';
process.env.PA_TOASTS = '0';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const FAKE = 'fake-tok-Zq81vXc0-not-real';
const NAME = 'PA_TEST_FAKE_TOKEN';
delete process.env[NAME];

// --------------------------------------------------------- capture logs --
let captured = '';
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => { captured += String(chunk); return true; };
process.stderr.write = (chunk, ...rest) => { captured += String(chunk); return true; };
const restore = () => { process.stdout.write = realOut; process.stderr.write = realErr; };

// ------------------------------------------------------------- fake db --
// Just enough SQL, matched by shape, for the statements secrets/ issues.
const db = require('../src/db');
const table = [];
let nextId = 1;
function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  const pendingByName = (name) => table.find((r) => r.name === name && r.status === 'pending');
  if (s.startsWith('select * from secret_request where id = $1')) return [table.find((r) => r.id === Number(params[0]))].filter(Boolean);
  if (s.startsWith("select * from secret_request where name = $1 and status = 'pending'")) return [pendingByName(params[0])].filter(Boolean);
  if (s.startsWith("select id from secret_request where name = $1 and status = 'pending'")) return [pendingByName(params[0])].filter(Boolean);
  if (s.startsWith("select * from secret_request where status = 'pending'")) return table.filter((r) => r.status === 'pending');
  if (s.startsWith('insert into secret_request (kind, name, purpose, hint, url, command, requested_by, target)')) {
    if (pendingByName(params[1])) return [];
    const row = { id: nextId++, kind: params[0], name: params[1], purpose: params[2], hint: params[3], url: params[4],
      command: params[5], requested_by: params[6], target: params[7], status: 'pending', created_at: new Date(), fulfilled_at: null };
    table.push(row);
    return [row];
  }
  if (s.startsWith("update secret_request set status = 'fulfilled', fulfilled_at = now(), stored_in = $2 where name = $1")) {
    return table.filter((r) => r.name === params[0] && r.status === 'pending').map((r) => Object.assign(r, { status: 'fulfilled', fulfilled_at: new Date(), stored_in: params[1] }));
  }
  if (s.startsWith("insert into secret_request (kind, name, purpose, requested_by, target, status, fulfilled_at, stored_in)")) {
    table.push({ id: nextId++, kind: 'secret', name: params[0], requested_by: params[1], status: 'fulfilled', fulfilled_at: new Date(), stored_in: params[2] });
    return [];
  }
  if (s.startsWith('update secret_request set status = $2')) {
    const r = table.find((x) => x.id === Number(params[0]) && x.status === 'pending');
    if (!r) return [];
    r.status = params[1];
    return [{ id: r.id, name: r.name, status: r.status }];
  }
  if (s.startsWith('select kind from secret_request where id = $1')) return [table.find((r) => r.id === Number(params[0]))].filter(Boolean);
  if (s.startsWith('select distinct on (name)')) return table.filter((r) => r.stored_in).map((r) => ({ name: r.name, fulfilled_at: r.fulfilled_at, stored_in: r.stored_in }));
  if (s.startsWith("update secret_request set status = 'expired'")) return [];
  if (s.startsWith('insert into notification')) return [{ id: 1, kind: params[0], title: params[1], body: params[2], url: params[3] }];
  throw new Error(`fake db: unexpected SQL: ${s.slice(0, 90)}`);
}
db.rows = async (sql, params) => fakeQuery(sql, params);
db.one = async (sql, params) => fakeQuery(sql, params)[0] || null;
db.query = async (sql, params) => ({ rows: fakeQuery(sql, params) });

// ---------------------------------------------------------- fake vault --
const vault = require('../src/secrets/vault');
const store = new Map();
const invocations = [];
vault.setRunner((inv) => {
  invocations.push(inv);
  const req = JSON.parse(Buffer.from(inv.input.trim(), 'base64').toString('utf8'));
  let reply;
  if (req.op === 'set') {
    if (req.value === 'make-it-fail') reply = { ok: false, error: `cannot store make-it-fail for ${req.name}` };
    else { store.set(req.name, req.value); reply = { ok: true }; }
  } else if (req.op === 'get') reply = store.has(req.name) ? { ok: true, found: true, value: store.get(req.name) } : { ok: true, found: false };
  else if (req.op === 'delete') reply = { ok: true, found: store.delete(req.name) };
  else reply = { ok: true, names: [...store.keys()] };
  return { stdout: JSON.stringify(reply) + '\n', status: 0 };
});

const secrets = require('../src/secrets');
const cfg = require('../src/config');
const server = require('../src/dashboard/server');

function request(port, { method = 'GET', path: p, host = `127.0.0.1:${port}`, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { Host: host, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // The real invocation: the value is on stdin, never in argv.
  {
    const inv = vault.invocation({ op: 'set', name: NAME, value: FAKE });
    assert.ok(!inv.args.join(' ').includes(FAKE), 'value must not be in argv');
    assert.ok(!inv.args.join(' ').includes(Buffer.from(FAKE).toString('base64')), 'not even encoded');
    assert.ok(Buffer.from(inv.input.trim(), 'base64').toString('utf8').includes(FAKE), 'value travels on stdin');
    assert.ok(inv.args.includes('-EncodedCommand'));
    assert.strictEqual(vault.scrub(`oops ${FAKE} oops`, FAKE), 'oops <redacted> oops');
  }

  // A request, then the dashboard answers it.
  const r = await secrets.requestSecret({ name: NAME, purpose: 'Testing: an invented integration', hint: 'https://example.invalid/tokens', requestedBy: 'agent' });
  assert.strictEqual(r.status, 'pending');
  const again = await secrets.requestSecret({ name: NAME, purpose: 'asked twice', requestedBy: 'agent' });
  assert.strictEqual(again.id, r.id, 'a second ask finds the first');

  const srv = await server.start({ port: 0, host: '127.0.0.1' });
  const port = srv.address().port;
  try {
    const path1 = `/api/secrets/${r.id}/fulfil`;
    // No X-PA: a cross-origin form post cannot set it.
    let res = await request(port, { method: 'POST', path: path1, body: { value: FAKE } });
    assert.strictEqual(res.status, 403);
    // Rebinding: a hostile Host.
    res = await request(port, { method: 'POST', path: path1, host: 'evil.example:80', headers: { 'X-PA': '1' }, body: { value: FAKE } });
    assert.strictEqual(res.status, 403);
    assert.ok(!store.has(NAME), 'nothing stored by a rejected request');

    // A store failure whose message contains the value: scrubbed.
    const r2 = await secrets.requestSecret({ name: 'PA_TEST_OTHER', purpose: 'Testing failure', requestedBy: 'cli' });
    res = await request(port, { method: 'POST', path: `/api/secrets/${r2.id}/fulfil`, headers: { 'X-PA': '1' }, body: { value: 'make-it-fail' } });
    assert.strictEqual(res.status, 500);
    assert.ok(!res.text.includes('make-it-fail'), `failure echoed the value: ${res.text}`);

    // The real thing.
    res = await request(port, { method: 'POST', path: path1, headers: { 'X-PA': '1' }, body: { value: FAKE, target: 'credential-manager' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(JSON.parse(res.text), { ok: true, stored: 'credential-manager', name: NAME });
    assert.ok(!res.text.includes(FAKE));
    assert.strictEqual(store.get(NAME), FAKE, 'stored in the vault');
    assert.strictEqual(table.find((x) => x.id === r.id).status, 'fulfilled');
    assert.ok(!JSON.stringify(table).includes(FAKE), 'the request table never holds the value');

    // Answering twice is refused.
    res = await request(port, { method: 'POST', path: path1, headers: { 'X-PA': '1' }, body: { value: 'x' } });
    assert.strictEqual(res.status, 409);

    // Listing says where, not what.
    res = await request(port, { path: '/api/secrets' });
    assert.strictEqual(res.status, 200);
    assert.ok(!res.text.includes(FAKE));
    const listed = JSON.parse(res.text).secrets.find((s) => s.name === NAME);
    assert.strictEqual(listed.source, 'credential-manager');
    assert.deepStrictEqual(Object.keys(listed).sort(), ['name', 'set_at', 'source']);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }

  // The resolver finds it; that is the only path to the value.
  cfg.forgetSecret(NAME);
  assert.strictEqual(cfg.secret(NAME), FAKE);
  assert.strictEqual(cfg.secretSource(NAME), 'credential-manager');

  // MCP: status and request return no value.
  const mcp = require('../src/mcp/server');
  const st = await mcp.handle('secret_status', { name: NAME });
  assert.ok(!JSON.stringify(st).includes(FAKE));
  assert.ok(st.content[0].text.includes('"configured": true'));
  const rq = await mcp.handle('request_secret', { name: NAME, purpose: 'again' });
  assert.ok(!JSON.stringify(rq).includes(FAKE));
  assert.ok(rq.content[0].text.includes('configured'));
  for (const t of mcp.TOOLS) assert.ok(!/secret_value|get_secret|read_secret/.test(t.name), `no tool may read secrets: ${t.name}`);

  // Every argv the vault saw is clean.
  for (const inv of invocations) assert.ok(!inv.args.join(' ').includes(FAKE));

  // .env: refused unless git ignores it.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-secrets-'));
    const file = path.join(dir, '.env');
    assert.throws(() => secrets.writeEnvFile(NAME, FAKE, { file }), /git does not ignore/);
    assert.ok(!fs.existsSync(file));
    fs.writeFileSync(file, '# comment\nPA_OTHER=1\nPA_TEST_FAKE_TOKEN=old\n');
    secrets.writeEnvFile(NAME, 'new value', { file, ignored: () => true });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# comment\nPA_OTHER=1\nPA_TEST_FAKE_TOKEN="new value"\n');
    assert.throws(() => secrets.writeEnvFile(NAME, 'a\nB=1', { file, ignored: () => true }), /line break/);
    fs.rmSync(dir, { recursive: true, force: true });
    // The tool's own .env is ignored in this repo — the rule this depends on.
    assert.ok(secrets.isGitIgnored(path.join(__dirname, '..', '.env')), 'personal-assistant/.env must be gitignored');
  }

  restore();
  assert.ok(captured.includes('[secrets]'), 'the test did capture log output');
  assert.ok(!captured.includes(FAKE), 'a secret value reached a log');
  assert.ok(!captured.includes('make-it-fail'), 'a failed value reached a log');
  console.log('secrets ok');
})().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
