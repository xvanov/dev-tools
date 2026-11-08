'use strict';

// The architecture map (src/dashboard/architecture.json, /architecture) must
// stay true as the system changes. This checks its shape, and the drift it can
// see cheaply: the PA chat's tools and their allow/ask split, the read-only and
// acting `pa` verbs, the worker's passes, the Postgres tables, the factory's
// personas and routes, the env defaults it quotes, every code path it names,
// and that every edge and walk-through step points at a real component.
// When this fails, update architecture.json in the same commit (root
// CLAUDE.md, "Architecture map").

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PA = path.join(__dirname, '..');
const REPO = path.join(PA, '..');
const A = JSON.parse(fs.readFileSync(path.join(PA, 'src', 'dashboard', 'architecture.json'), 'utf8'));

const sorted = (xs) => [...xs].sort();
const same = (got, want, what) => assert.deepStrictEqual(sorted(got), sorted(want), `architecture.json is stale: ${what}\n  map:  ${sorted(got).join(', ')}\n  code: ${sorted(want).join(', ')}`);

// ------------------------------------------------------------------ shape ----
const STATUSES = Object.keys(A.statuses);
assert.deepStrictEqual(sorted(STATUSES), ['landing', 'live', 'planned']);
assert.ok(typeof A.title === 'string' && A.title && typeof A.intro === 'string' && A.intro);
const layerIds = A.layers.map((l) => l.id);
assert.strictEqual(new Set(layerIds).size, layerIds.length, 'layer ids are unique');
A.layers.forEach((l, i) => {
  assert.strictEqual(l.n, i + 1, `layer ${l.id} is numbered in order`);
  assert.ok(l.name && l.summary, `layer ${l.id} has a name and summary`);
});
assert.deepStrictEqual(layerIds.slice(0, 4), ['talk', 'dashboard', 'factory', 'sessions'], 'the four layers, top to bottom');
const stackIds = A.stacks.map((s) => s.id);
assert.deepStrictEqual(sorted(stackIds), ['personal', 'work']);
for (const s of A.stacks) assert.ok(s.name && s.machine && s.identity && Array.isArray(s.runs) && s.runs.length && s.ingests, `stack ${s.id} is complete`);

const ids = A.components.map((c) => c.id);
assert.strictEqual(new Set(ids).size, ids.length, 'component ids are unique');
const byId = Object.fromEntries(A.components.map((c) => [c.id, c]));
for (const c of A.components) {
  assert.match(c.id, /^[a-z0-9-]+$/, `${c.id}: id`);
  assert.ok(layerIds.includes(c.layer), `${c.id}: unknown layer ${c.layer}`);
  assert.ok(c.name && c.role, `${c.id}: name and role`);
  assert.ok(c.stacks && Object.keys(c.stacks).length, `${c.id}: stacks`);
  for (const [s, st] of Object.entries(c.stacks)) {
    assert.ok(stackIds.includes(s), `${c.id}: unknown stack ${s}`);
    assert.ok(STATUSES.includes(st), `${c.id}: unknown status ${st}`);
  }
  if (c.where) for (const s of Object.keys(c.where)) assert.ok(c.stacks[s], `${c.id}: where.${s} for a stack it is not on`);
  if (c.health) assert.ok(A.health[c.health], `${c.id}: unknown health check ${c.health}`);
  assert.ok(c.details && typeof c.details === 'object', `${c.id}: details`);
  for (const [k, v] of Object.entries(c.details)) {
    assert.ok(typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')), `${c.id}: details.${k} is a string or list of strings`);
  }
  assert.ok(Array.isArray(c.code) && c.code.length, `${c.id}: names its code`);
  for (const p of c.code) assert.ok(fs.existsSync(path.join(REPO, p)), `${c.id}: code path ${p} does not exist`);
  for (const e of c.env || []) assert.match(e.name, /^[A-Z][A-Z0-9_]+$/, `${c.id}: env name ${e.name}`);
}

for (const e of A.edges) {
  assert.ok(byId[e.from], `edge from unknown component ${e.from}`);
  assert.ok(byId[e.to], `edge to unknown component ${e.to}`);
  assert.ok(e.label, `edge ${e.from}->${e.to} has a label`);
  for (const s of e.stacks || []) {
    assert.ok(byId[e.from].stacks[s] && byId[e.to].stacks[s], `edge ${e.from}->${e.to} on stack ${s} where an end is absent`);
  }
}
const exIds = A.examples.map((x) => x.id);
assert.strictEqual(new Set(exIds).size, exIds.length, 'example ids are unique');
assert.ok(A.examples.length >= 4, 'at least four walk-throughs');
for (const x of A.examples) {
  assert.ok(x.title && x.say && x.steps.length >= 3, `example ${x.id} is complete`);
  for (const s of x.steps) {
    assert.ok(byId[s.c], `example ${x.id}: unknown component ${s.c}`);
    assert.ok(s.t, `example ${x.id}: step text`);
  }
}
// Acceptance criteria (PLAN.md 8.1): every walk-through says what "done" means,
// or is explicitly out of scope. The Phase 8 reviewers score against this block.
{
  const VIEWS = ['plan', 'build', 'run', 'ask'];
  const askTools = byId.jarvis.tools.ask;
  const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;
  for (const x of A.examples) {
    const a = x.acceptance;
    assert.ok(a && typeof a === 'object', `example ${x.id}: has an acceptance block`);
    if (a.outOfScope !== undefined) {
      assert.ok(nonEmpty(a.outOfScope), `example ${x.id}: outOfScope gives a reason`);
      assert.deepStrictEqual(Object.keys(a), ['outOfScope'], `example ${x.id}: an out-of-scope workflow has only the reason`);
      continue;
    }
    assert.deepStrictEqual(sorted(Object.keys(a)), sorted(['outcome', 'hops', 'cost', 'views', 'approvals', 'rubric', 'verdict']), `example ${x.id}: acceptance keys`);
    assert.ok(nonEmpty(a.outcome), `example ${x.id}: acceptance.outcome`);
    assert.ok(Array.isArray(a.hops) && a.hops.length >= 2, `example ${x.id}: acceptance.hops`);
    for (const h of a.hops) {
      assert.ok(byId[h.c], `example ${x.id}: acceptance hop on unknown component ${h.c}`);
      assert.ok(nonEmpty(h.what), `example ${x.id}: hop ${h.c} says what it does`);
      // A hop has a latency ceiling, or says why it has none (model- or CI-bound).
      assert.ok((Number.isFinite(h.max_ms) && h.max_ms > 0) !== nonEmpty(h.unbounded), `example ${x.id}: hop ${h.c} has exactly one of max_ms, unbounded`);
    }
    assert.ok(a.hops.some((h) => Number.isFinite(h.max_ms)), `example ${x.id}: at least one hop has a latency target`);
    assert.ok(a.cost && Number.isFinite(a.cost.max_usd) && a.cost.max_usd >= 0 && nonEmpty(a.cost.basis), `example ${x.id}: cost ceiling and its basis`);
    assert.ok(Array.isArray(a.views) && a.views.length >= 1 && a.views.every((v) => VIEWS.includes(v)) && new Set(a.views).size === a.views.length, `example ${x.id}: views are from ${VIEWS.join(', ')}`);
    assert.ok(Array.isArray(a.approvals), `example ${x.id}: approvals is a list (empty when none)`);
    for (const t of a.approvals) assert.ok(askTools.includes(t), `example ${x.id}: approval ${t} is not a tool that asks`);
    assert.ok(Array.isArray(a.rubric) && a.rubric.length >= 3, `example ${x.id}: a rubric of at least three criteria`);
    const rids = a.rubric.map((r) => r.id);
    assert.strictEqual(new Set(rids).size, rids.length, `example ${x.id}: rubric ids are unique`);
    for (const r of a.rubric) assert.ok(/^[a-z0-9-]+$/.test(r.id) && nonEmpty(r.check), `example ${x.id}: rubric item ${r.id}`);
    // The verdict is filled by Phase 8 (8.4): null until a reviewer has scored it.
    const v = a.verdict;
    assert.deepStrictEqual(sorted(Object.keys(v)), ['date', 'report', 'result'], `example ${x.id}: verdict keys`);
    assert.ok([null, 'pass', 'fail'].includes(v.result), `example ${x.id}: verdict.result`);
    if (v.result === null) assert.ok(v.date === null && v.report === null, `example ${x.id}: an unreviewed verdict is empty`);
    else {
      assert.match(String(v.date), /^\d{4}-\d{2}-\d{2}$/, `example ${x.id}: verdict.date`);
      assert.ok(fs.existsSync(path.join(REPO, v.report || '')), `example ${x.id}: verdict.report ${v.report} does not exist`);
    }
  }
}
for (const [id, h] of Object.entries(A.health)) {
  assert.ok(['self', 'postgres', 'http', 'tcp', 'machine'].includes(h.kind), `health ${id}: kind`);
  assert.ok(h.label, `health ${id}: label`);
}
// Every check is used, and a planned-everywhere component has none.
for (const id of Object.keys(A.health)) assert.ok(A.components.some((c) => c.health === id), `health check ${id} is used by no component`);

// ------------------------------------------------------------------ drift ----
// The PA chat's MCP tools and which of them ask (src/mcp, src/chat/index.js).
{
  const server = require('../src/mcp/server.ts');
  const chat = require('../src/chat');
  const listed = server.listedTools({ PA_MCP_CHAT_TOOLS: '1' }).map((t) => t.name);
  const allow = chat.settingsJson().permissions.allow.filter((r) => r.startsWith('mcp__pa-chat__')).map((r) => r.slice('mcp__pa-chat__'.length));
  const jarvis = byId.jarvis;
  same(jarvis.tools.allowed, listed.filter((n) => allow.includes(n)), 'jarvis.tools.allowed (the pa-chat tools on the allow list)');
  same(jarvis.tools.ask, listed.filter((n) => !allow.includes(n)), 'jarvis.tools.ask (pa-chat tools that prompt)');
  for (const t of chat.CHAT_ACTION_TOOLS) assert.ok(jarvis.tools.ask.includes(t), `action tool ${t} must be listed as asking`);
  same(jarvis.pa_verbs.read, chat.ALLOW_COMMANDS, 'jarvis.pa_verbs.read (ALLOW_COMMANDS)');
  same(jarvis.pa_verbs.ask, [...chat.ASK_COMMANDS, ...chat.CARD_COMMANDS], 'jarvis.pa_verbs.ask (ASK_COMMANDS + CARD_COMMANDS)');
  const shared = server.TOOLS.map((t) => t.name);
  same(byId.mcp.tools.shared, shared, 'mcp.tools.shared (TOOLS in src/mcp/server.js)');
  same(byId.mcp.tools.chat_only, listed.filter((n) => !shared.includes(n)), 'mcp.tools.chat_only');
}

// The worker's passes (every(<s>, '<name>', ...) in src/worker.js, and the
// self-paced ones it runs through exclusive('<name>', ...), e.g. factory).
{
  const src = fs.readFileSync(path.join(PA, 'src', 'worker.ts'), 'utf8');
  const passes = [...new Set([...src.matchAll(/(?:every\([^,]+,\s*|exclusive\()'([^']+)'/g)].map((m) => m[1]))];
  assert.ok(passes.length > 10);
  same(byId.worker.passes, passes, 'worker.passes');
}

// The Postgres tables (create table in sql/*.sql).
{
  const dir = path.join(PA, 'sql');
  const tables = new Set();
  for (const f of fs.readdirSync(dir)) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/create table (?:if not exists )?([a-z_]+)/gi)) tables.add(m[1].toLowerCase());
  }
  same(byId.postgres.tables, [...tables], 'postgres.tables');
}

// The factory's personas and the api runtime's models.
{
  const dir = path.join(REPO, 'software-factory', 'factory', 'personas');
  same(byId['factory-chain'].personas, fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)), 'factory-chain.personas');
  const routes = fs.readFileSync(path.join(REPO, 'software-factory', 'factory', 'routes.yaml'), 'utf8');
  for (const m of byId['runtime-api'].models) assert.ok(routes.includes(m), `runtime-api.models: ${m} is not in routes.yaml`);
  const api = fs.readFileSync(path.join(REPO, 'software-factory', 'docs', 'JOBS-API.md'), 'utf8');
  assert.ok(api.includes(`${byId['factory-api'].contract} additions`), `factory-api.contract ${byId['factory-api'].contract} is not a section of JOBS-API.md`);
}

// Env defaults: a PA_ variable's default must be what config.js says; any
// other variable must appear in one of the component's code files.
{
  const cfg = fs.readFileSync(path.join(PA, 'src', 'config.ts'), 'utf8');
  const literal = (name) => {
    const m = new RegExp(`(?:env|envInt|modelEnv)\\('${name}'(?:,\\s*('([^']*)'|[0-9_]+|null))?\\)`).exec(cfg);
    if (!m) return undefined;
    if (m[1] == null || m[1] === 'null') return null;
    return m[2] !== undefined ? m[2] : m[1].replace(/_/g, '');
  };
  for (const c of A.components) {
    for (const e of c.env || []) {
      const inConfig = cfg.includes(`'${e.name}'`);
      if (inConfig) {
        const d = literal(e.name);
        if (d !== undefined) assert.strictEqual(e.default == null ? null : String(e.default), d, `${c.id}: ${e.name} default is ${JSON.stringify(d)} in config.ts`);
        else assert.ok(e.default == null || cfg.includes(String(e.default)), `${c.id}: ${e.name} default ${e.default} is not in config.ts`);
      } else {
        const files = c.code.map((p) => path.join(REPO, p)).filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
        assert.ok(files.some((f) => fs.readFileSync(f, 'utf8').includes(e.name)), `${c.id}: ${e.name} appears in none of its code files`);
        if (e.default) assert.ok(files.some((f) => fs.readFileSync(f, 'utf8').includes(e.default)), `${c.id}: ${e.name} default ${e.default} appears in none of its code files`);
      }
    }
  }
}

// ------------------------------------------------------------ the server ----
{
  const arch = require('../src/dashboard/architecture.ts');
  // Checks resolve to loopback or a configured machine, never a host from the JSON.
  const cfg = {
    voice: { url: 'http://127.0.0.1:47830' },
    providers: { local: { baseUrl: 'http://127.0.0.1:11434/v1' } },
    audio: { transcribeHost: '127.0.0.1', transcribePort: 47821 },
    termhub: { url: 'http://127.0.0.1:7000' },
    factory: { machine: 'lab', path: '/x' },
    dispatch: { machines: { lab: { url: 'https://lab.example.ts.net:7443' } }, host: '127.0.0.1', port: 7300 },
    databaseUrl: 'postgres://pa:secretpw@127.0.0.1:5433/pa',
  };
  assert.deepStrictEqual(arch.resolveCheck(A.health.ollama, cfg), { kind: 'http', url: 'http://127.0.0.1:11434/api/tags' });
  assert.deepStrictEqual(arch.resolveCheck(A.health.voice, cfg), { kind: 'http', url: 'http://127.0.0.1:47830/health' });
  assert.deepStrictEqual(arch.resolveCheck(A.health.whisper, cfg), { kind: 'tcp', host: '127.0.0.1', port: 47821 });
  assert.deepStrictEqual(arch.resolveCheck(A.health['factory-machine'], cfg), { kind: 'http', url: 'https://lab.example.ts.net:7443/api/health', remote: true });
  assert.ok(arch.resolveCheck({ kind: 'http', url: 'http://evil.example/' }, cfg).error, 'a non-loopback URL is refused');
  assert.ok(arch.resolveCheck({ kind: 'machine' }, { ...cfg, factory: { machine: 'nope' } }).error, 'an unknown machine is refused');
  assert.deepStrictEqual(arch.resolveCheck({ kind: 'machine' }, { ...cfg, factory: { machine: '', path: '/x' } }), { kind: 'self' });
  const live = arch.liveConfig({ ...cfg, chat: {}, fastLane: {}, anthropic: {} });
  assert.ok(!JSON.stringify(live).includes('secretpw'), 'liveConfig never shows the database password');
  assert.strictEqual(live.database, '127.0.0.1:5433/pa');

  // The page renders with textContent only.
  const client = fs.readFileSync(path.join(PA, 'src', 'dashboard', 'architecture.client.js'), 'utf8');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) assert.ok(!client.includes(sink), `architecture.client.js uses ${sink}`);
  // Relative URLs only, so the page works under termhub's /pa/ proxy.
  assert.ok(!/fetch\('\//.test(client), 'architecture.client.js fetches an absolute path');
  const html = fs.readFileSync(path.join(PA, 'src', 'dashboard', 'architecture.html'), 'utf8');
  assert.ok(html.includes('href="theme.css"') && html.includes('src="architecture.client.js"'));
}

console.log('architecture ok');
