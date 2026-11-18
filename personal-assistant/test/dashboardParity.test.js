'use strict';

// Agent access parity (docs/native/BUILD-ENRICHMENT.md, B): everything the dashboard can change, the
// PA chat and the `pa` CLI can change too. This test lists the dashboard's mutating API routes from
// its source and fails when one has no chat tool or `pa` verb in test/dashboardParity.map.js,
// unless that file says why not (an exception) or records it as known debt (a gap).
//
// How routes are found (the router is a table plus modules that dispatch on their own, so this reads
// the source, not a registry):
//   server.ts           every `method: 'POST'|'PUT'|'PATCH'|'DELETE'` entry of ROUTES, with its path literal
//   every other .ts     a mutation guard, `method === 'POST'` (the lines of its `if` block, and the line
//                       before it, where a module matches its path first) or `method !== 'POST'` (the rest
//                       of the file); the path literals in that region are its routes; a guard with no path
//                       literal in it is keyed by its own text
// A new route that this cannot see would also be one nobody mapped: the checks at the end count the
// mutation guards per file, so a new one fails here until the map is updated.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..', 'src', 'dashboard');
const MAP = require('./dashboardParity.map.js');

// ---------------------------------------------------------------- extraction ----

const STR = /'(\/[^'\s]*[^'\s/])'/g; // '/api/x' (a trailing-slash prefix check is not a route)
const RE_SRC = String.raw`\/\^(?:\\\/|\[[^\]\n]*\]|[^/\n])+?\$\/`; // /^\/api\/x\/(\d+)$/, a [class] may hold a /
const RE = new RegExp(RE_SRC, 'g');

/** Pure. A path literal (a quoted path or a regex literal) as a stable text: `:id` for (\d+), `{a|b}` for a group. */
function normalize(lit) {
  if (lit.startsWith("'")) return lit.slice(1, -1);
  return lit
    .slice(2, -2) // /^ … $/
    .replace(/\\\//g, '/')
    .replace(/\(\\d\+\)/g, ':id')
    .replace(/\(\[\^\/\]\+\)/g, ':name')
    .replace(/\(\?:\/\(([^)]*)\)\)\?/g, '[/{$1}]')
    .replace(/\(([^()]*\|[^()]*)\)/g, '{$1}');
}

function literals(text) {
  return [...text.matchAll(STR)].map((m) => m[1]).filter((s) => s.startsWith('/api/') || s.startsWith('/'))
    .concat([...text.matchAll(RE)].map((m) => normalize(m[0])))
    .map((s) => (s.startsWith("'") ? normalize(s) : s));
}

/** Pure. The lines of the block an `if (...) {` on line `i` opens (the line itself when it opens none). */
function blockOf(lines, i) {
  if (!/\{\s*$/.test(lines[i])) return [lines[i]];
  let depth = 0;
  const out = [];
  for (let j = i; j < lines.length; j++) {
    out.push(lines[j]);
    for (const ch of lines[j].replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\/.*$/g, '')) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth <= 0) break;
  }
  return out;
}

/** Pure. The mutating routes a module source declares, as { key, method } (see the header for the rules). */
function moduleRoutes(file, src) {
  const lines = src.split('\n');
  const found = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const m = /\bmethod\s*(===|!==)\s*'(POST|PUT|PATCH|DELETE)'/.exec(line);
    if (!m) return;
    let region;
    if (m[1] === '!==') region = lines.slice(i);
    else region = [...(i > 0 && !/\bmethod\s*[!=]==/.test(lines[i - 1]) ? [lines[i - 1]] : []), ...blockOf(lines, i)];
    const text = region.join('\n');
    const lits = literals(text).filter((l) => l !== '/');
    if (lits.length) for (const l of lits) found.push({ key: `${file} ${l}`, method: m[2] });
    else found.push({ key: `${file} ${line.trim()}`, method: m[2] });
  });
  return found;
}

/** Pure. server.ts's ROUTES entries that mutate: { key, method }. */
function tableRoutes(src) {
  const found = [];
  for (const m of src.matchAll(new RegExp(String.raw`method:\s*'(POST|PUT|PATCH|DELETE)',\s*path:\s*('[^']*'|${RE_SRC})`, 'g'))) {
    found.push({ key: `server.ts ${normalize(m[2])}`, method: m[1] });
  }
  // The one entry with no path is the guard every other POST passes (X-PA); anything else without a literal path is a route this cannot see.
  const all = [...src.matchAll(/method:\s*'(POST|PUT|PATCH|DELETE)'/g)].length;
  assert.strictEqual(all - found.length, 1, "server.ts has a mutating route whose path is not a literal ('/x' or /^…$/): write it as one so the parity test can see it");
  return found;
}

function extract() {
  const routes = [];
  for (const f of fs.readdirSync(DASH).filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts')).sort()) {
    const src = fs.readFileSync(path.join(DASH, f), 'utf8');
    if (MAP.exceptFiles[f]) continue;
    routes.push(...(f === 'server.ts' ? tableRoutes(src) : moduleRoutes(f, src)));
  }
  return routes;
}

// ------------------------------------------------------------------ the check ----

const keys = extract().map((r) => r.key);
assert.ok(keys.length >= 30, `found only ${keys.length} mutating routes: the extraction broke`);
assert.strictEqual(new Set(keys).size, keys.length, `a route is found twice: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`);

const mapped = Object.keys(MAP.routes);
const unmapped = keys.filter((k) => !mapped.includes(k));
assert.deepStrictEqual(unmapped, [], `dashboard routes with no chat tool or pa verb (add them to test/dashboardParity.map.js, with the tool and the verb that do the same, or an exception with the reason):\n  ${unmapped.join('\n  ')}`);
const stale = mapped.filter((k) => !keys.includes(k));
assert.deepStrictEqual(stale, [], `test/dashboardParity.map.js names routes that no longer exist:\n  ${stale.join('\n  ')}`);
for (const f of Object.keys(MAP.exceptFiles)) {
  assert.ok(fs.existsSync(path.join(DASH, f)), `exceptFiles names ${f}, which does not exist`);
  assert.ok(MAP.exceptFiles[f].length > 20, `exceptFiles ${f}: say why`);
}

// What a tool or verb name has to be to count.
const chatTools = require('../src/mcp/chatTools.ts');
const mcp = require('../src/mcp/server.ts');
const chat = require('../src/chat');
const cli = require('../src/cli/index.ts');
const toolNames = new Set([...chatTools.ALL.map((t) => t.name), ...mcp.TOOLS.map((t) => t.name), mcp.TASK_TOOL.name]);
const helpAll = [cli.HELP, require('../src/cli/meeting.ts').HELP, ...new Set(Object.values(cli.HELP_TOPICS).map((rel) => require(path.join(DASH, '..', 'cli', rel)).HELP))].join('\n');

let gaps = 0;
for (const [key, e] of Object.entries(MAP.routes)) {
  const kinds = ['tool', 'verb', 'exception', 'gap'].filter((k) => e[k] !== undefined);
  assert.ok(kinds.length > 0, `${key}: give a tool and/or verb, an exception or a gap`);
  if (e.exception !== undefined || e.gap !== undefined) {
    assert.deepStrictEqual(kinds.filter((k) => k === 'tool' || k === 'verb'), [], `${key}: an exception or gap names no tool or verb`);
    assert.ok(String(e.exception ?? e.gap).trim().length > 15, `${key}: say why`);
    if (e.gap !== undefined) gaps++;
    continue;
  }
  // `tool` and `verb` are a name, or a list of them when one route covers several actions.
  for (const tool of [].concat(e.tool || [])) {
    assert.ok(toolNames.has(tool), `${key}: no chat tool named ${tool}`);
    // A write must be a tool that asks (or one of the shared MCP tools that are small and reversible by design).
    if (chatTools.ALL.some((t) => t.name === tool)) assert.ok(chatTools.CHAT_ACTION_TOOL_NAMES.includes(tool), `${key}: ${tool} is a read tool; a route that changes things maps to an action tool`);
  }
  for (const verb of [].concat(e.verb || [])) {
    const first = verb.split(' ')[0];
    assert.strictEqual(typeof cli.commands[first], 'function', `${key}: no pa command "${first}"`);
    // Some help line names the verb: `pa <first>` and the rest as words (`pa routine list|run <id>|pause`).
    const rest = verb.split(' ').slice(1);
    assert.ok(helpAll.split('\n').some((l) => l.includes(`pa ${first}`) && rest.every((w) => new RegExp(`(^|[^\\w-])${w}($|[^\\w-])`).test(l))), `${key}: pa help never mentions "pa ${verb}"`);
    assert.ok(!chat.ALLOW_COMMANDS.includes(verb), `${key}: pa ${verb} is on the chat's read-only list; a route that changes things maps to a verb that asks`);
  }
}
// Gaps are debt, not a place to put new routes: this number only goes down.
assert.ok(gaps <= MAP.maxGaps, `${gaps} routes are recorded as gaps, over the ${MAP.maxGaps} allowed: give the new route a tool and a verb instead`);
assert.ok(gaps === MAP.maxGaps, `${gaps} gaps remain: lower maxGaps in test/dashboardParity.map.js to ${gaps} so the debt cannot grow back`);

// The Agents page itself has no gaps and no exceptions: every one of its writes has both a tool and a verb.
for (const [key, e] of Object.entries(MAP.routes).filter(([k]) => k.startsWith('agents.ts '))) {
  assert.ok(e.tool && e.verb, `${key}: the Agents page's routes each have a chat tool and a pa verb`);
}
assert.ok(keys.some((k) => k.startsWith('agents.ts ')), 'the Agents page routes were not found');

// The unit pieces of the extraction, on small sources.
assert.strictEqual(normalize("'/api/x'"), '/api/x');
assert.strictEqual(normalize('/^\\/api\\/a\\/(\\d+)\\/(x|y)$/'), '/api/a/:id/{x|y}');
assert.strictEqual(normalize('/^\\/api\\/agents\\/profiles\\/([^/]+)(?:\\/(delete|reset))?$/'), '/api/agents/profiles/:name[/{delete|reset}]');
assert.deepStrictEqual(
  moduleRoutes('m.ts', ["async function route(method, url) {", "  if (method === 'GET' && url.pathname === '/api/m/read') return 1;", "  if (method === 'POST' && url.pathname === '/api/m/write') {", '    return 2;', '  }', '}'].join('\n')),
  [{ key: 'm.ts /api/m/write', method: 'POST' }]
);
assert.deepStrictEqual(
  moduleRoutes('m.ts', ["async function route(method, url) {", "  if (method !== 'POST') return undefined;", "  if (url.pathname === '/api/m/a') return 1;", "  const m = url.pathname.match(/^\\/api\\/m\\/(\\d+)\\/(go|stop)$/);", '}'].join('\n')).map((r) => r.key),
  ['m.ts /api/m/a', 'm.ts /api/m/:id/{go|stop}']
);

console.log(`dashboard parity ok (${keys.length} mutating routes: ${keys.length - gaps - Object.values(MAP.routes).filter((e) => e.exception !== undefined).length} mapped, ${Object.values(MAP.routes).filter((e) => e.exception !== undefined).length} exceptions, ${gaps} known gaps)`);
