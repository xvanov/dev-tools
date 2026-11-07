'use strict';

// Approve / Deny on the PA chat's permission prompt from the Talk page
// (src/chat/permission.js, feed.answerPermission, POST /api/chat/permission):
// one keystroke, only for the chat's own actions, only when termhub and the
// screen both show that very prompt, and only with X-PA and the page token.
// termhub is faked; names are invented.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const P = require('../src/chat/permission');
const T = require('../src/chat/transcript');
const { createFeed } = require('../src/chat/feed');

// A Claude Code permission prompt for an MCP tool, as termhub's replay gives it.
const PROMPT = (tool = 'factory_start', cursor = 1, extra = '') => [
  '● Starting the factory job for card 412.',
  '',
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Tool use                                                     │',
  '│                                                              │',
  `│   pa-chat - ${tool}(card: "412", delivery: "pr") (MCP)        │`,
  '│   Start software-factory work — the user approves each call. │',
  extra,
  '│ Do you want to proceed?                                      │',
  `│ ${cursor === 1 ? '❯' : ' '} 1. Yes                                                     │`,
  `│ ${cursor === 2 ? '❯' : ' '} 2. Yes, and don't ask again for pa-chat - ${tool} commands │`,
  `│ ${cursor === 3 ? '❯' : ' '} 3. No, and tell Claude what to do differently (esc)       │`,
  '╰──────────────────────────────────────────────────────────────╯',
].join('\n');
const SESSION = { id: 's1', alive: true, kind: 'claude', idleState: 'waiting', idleReason: 'blocked' };
const PENDING = { toolUseId: 'toolu_01', name: 'mcp__pa-chat__factory_start' };

// --- which calls may be answered here ---------------------------------------------
assert.strictEqual(P.chatAction('mcp__pa-chat__factory_start'), 'factory_start');
assert.strictEqual(P.chatAction('mcp__pa-chat__session_start'), 'session_start');
assert.strictEqual(P.chatAction('mcp__pa-chat__board'), null, 'a read never prompts; not an action');
assert.strictEqual(P.chatAction('mcp__personal-assistant__factory_start'), null, 'only the chat\'s own server');
assert.strictEqual(P.chatAction('Bash'), null, 'a shell command is answered in termhub');
assert.strictEqual(P.chatAction('mcp__pa-chat__remember'), null);

// --- reading the screen ----------------------------------------------------------
{
  const r = P.readPrompt(PROMPT(), 'factory_start');
  assert.deepStrictEqual(r, { ok: true, cursorOnYes: true, escOffered: true });
  // termhub's replay often loses the spaces of a full-screen prompt.
  assert.deepStrictEqual(P.readPrompt(PROMPT().replace(/ /g, ''), 'factory_start'), { ok: true, cursorOnYes: true, escOffered: true });
  assert.strictEqual(P.readPrompt(PROMPT(), 'factory_cancel').ok, false, 'a prompt for another tool');
  assert.strictEqual(P.readPrompt(PROMPT('factory_start', 2), 'factory_start').cursorOnYes, false, 'cursor on "don\'t ask again"');
  assert.match(P.readPrompt('● Done.\n> \n? for shortcuts', 'factory_start').reason, /no permission prompt/);
  assert.match(P.readPrompt(`${PROMPT()}\n● Started.\n> \n? for shortcuts`, 'factory_start').reason, /already answered/);
  assert.match(P.readPrompt(`│   pa-chat - factory_start(card: "1") (MCP) │\n│ pa-chat - factory_cancel(job: "w:1") (MCP) │\nDo you want to proceed?\n❯ 1. Yes\n  3. No (esc)`, 'factory_start').reason, /another tool call/);
  assert.match(P.readPrompt('pa-chat - factory_start(x) (MCP)\nDo you want to proceed?\n❯ 1. Yes', 'factory_start').reason, /Yes and No/);
  assert.strictEqual(P.readPrompt('pa-chat - factory_start_all (MCP)\nDo you want to proceed?\n❯ 1. Yes\n 3. No (esc)', 'factory_start').ok, false, 'a longer tool name is another tool');
  // Claude Code's own tool line ("pa-chat - factory_start (MCP)", no parameters), and options without numbers.
  const bare = ['│ pa-chat - factory_start (MCP) │', '│ Do you want to proceed? │', '│ ❯ Yes │', "│   Yes, and don't ask again for pa-chat - factory_start │", '│   No, and tell Claude what to do differently (esc) │'].join('\n');
  assert.deepStrictEqual(P.readPrompt(bare, 'factory_start'), { ok: true, cursorOnYes: true, escOffered: true });
  const onAlways = bare.replace('❯ Yes │', '  Yes │').replace('  Yes, and', '❯ Yes, and');
  assert.strictEqual(P.readPrompt(onAlways, 'factory_start').cursorOnYes, false, 'never "Yes, and don\'t ask again"');
}

// --- every check before a keystroke ------------------------------------------------
{
  const ok = { answer: 'yes', toolUseId: 'toolu_01', pending: PENDING, session: SESSION, screen: PROMPT() };
  assert.deepStrictEqual(P.decide(ok), { ok: true, keys: [P.ENTER], tool: 'factory_start' }, 'Enter on "1. Yes", once');
  assert.deepStrictEqual(P.decide({ ...ok, answer: 'no' }), { ok: true, keys: [P.ESC], tool: 'factory_start' });
  const no = (o, re) => {
    const d = P.decide({ ...ok, ...o });
    assert.strictEqual(d.ok, false, JSON.stringify(o).slice(0, 80));
    assert.match(d.reason, re);
  };
  no({ answer: 'always' }, /yes or no/);
  no({ pending: null }, /not waiting/);
  no({ toolUseId: 'toolu_00' }, /no longer the one/);
  no({ pending: { ...PENDING, name: 'Bash' } }, /answer this one in termhub/);
  no({ pending: { ...PENDING, name: 'mcp__pa-chat__task_add' } }, /answer this one in termhub/);
  no({ session: null }, /not running/);
  no({ session: { ...SESSION, kind: 'opencode' } }, /not a Claude Code session/);
  no({ session: { ...SESSION, idleReason: 'question' } }, /not.*permission prompt/);
  no({ session: { ...SESSION, idleState: 'working' } }, /not.*permission prompt/);
  no({ screen: PROMPT('factory_cancel') }, /not for pa-chat factory_start/);
  no({ screen: PROMPT('factory_start', 2) }, /cursor is not on "1. Yes"/);
  no({ screen: '' }, /no permission prompt/);
  // Deny works wherever the cursor is: Esc is No.
  assert.strictEqual(P.decide({ ...ok, answer: 'no', screen: PROMPT('factory_start', 2) }).ok, true);
}

// --- the tool call's id reaches the feed (never its input) ---------------------------
{
  const [e] = T.entryEvents({ type: 'assistant', uuid: 'a1', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_01', name: 'mcp__pa-chat__factory_start', input: { card: '412', ask: 'secret words' } }] } });
  assert.strictEqual(e.toolUseId, 'toolu_01');
  assert.strictEqual(e.tool, 'mcp__pa-chat__factory_start');
  assert.ok(!JSON.stringify(e).includes('secret words'), 'the input stays out of the stream');
}

// --- the page: parses, sends the page token, no HTML sink -------------------------
{
  const page = fs.readFileSync(path.join(__dirname, '../src/dashboard/talk.page.js'), 'utf8');
  new vm.Script(page, { filename: 'talk.page.js' });
  assert.match(page, /'X-PA-Page': meta \? meta\.content : ''/);
  assert.match(page, /JSON\.stringify\(\{ answer, toolUseId: permission\.toolUseId \}\)/);
  const block = page.slice(page.indexOf('function showPermission'), page.indexOf('function onEvent'));
  assert.match(block, /\$\('permissionText'\)\.textContent = /);
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(block), 'the action text is set as text');
  const html = fs.readFileSync(path.join(__dirname, '../src/dashboard/talk.html'), 'utf8');
  for (const id of ['permission', 'permissionText', 'permYes', 'permNo']) assert.match(html, new RegExp(`id="${id}"`));
  const talk = require('../src/dashboard/talk');
  assert.ok(talk.route, 'talk route');
}

// --- feed.answerPermission over a fake termhub, then the route's guards -------------
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-perm-'));
  const home = path.join(root, 'pa-home');
  const dir = path.join(root, 'projects', T.projectDirFor(home));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'c0ffee00-0000-4000-8000-000000000001.jsonl');
  const at = new Date().toISOString();
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(file, line({ type: 'user', uuid: 'u1', timestamp: at, message: { content: 'start card 412' } }));

  let session = { ...SESSION, cwd: home, idleState: 'working', idleReason: 'streaming' };
  let screen = '';
  const typed = [];
  const hub = {
    listSessions: async () => [session],
    screen: async () => screen,
    say: async (id, text, o) => { typed.push([id, text, o?.submit]); },
    sessionUrl: async (id) => `http://127.0.0.1:7000/#session=${id}`,
  };
  const feed = createFeed({ home: () => home, root: () => path.join(root, 'projects'), hub: () => hub, ensureSession: async () => ({ sessionId: 's1' }), pollMs: 20, statusMs: 20 });
  const got = [];
  const unsubscribe = feed.subscribe((e) => got.push(e));
  await new Promise((r) => setTimeout(r, 40));

  fs.appendFileSync(file, line({ type: 'assistant', uuid: 'a1', timestamp: at, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_01', name: 'mcp__pa-chat__factory_start', input: { card: '412', delivery: 'pr' } }] } }));
  session = { ...session, idleState: 'waiting', idleReason: 'blocked' };
  screen = PROMPT();
  await new Promise((r) => setTimeout(r, 80));
  const perm = got.find((e) => e.type === 'permission' && !e.cleared);
  assert.ok(perm, 'the page is offered the prompt');
  assert.deepStrictEqual([perm.toolUseId, perm.approvable, perm.text], ['toolu_01', true, 'starting a factory job: card 412 (claude_session, pr)…']);
  assert.ok(got.indexOf(perm) < got.findIndex((e) => e.type === 'activity' && /termhub/.test(e.text)), 'buttons before the "go to termhub" line');
  assert.strictEqual((await feed.session()).permission.toolUseId, 'toolu_01', 'a page opened later sees it too');

  // A stale id, then a screen that moved on: nothing typed.
  await assert.rejects(feed.answerPermission({ answer: 'yes', toolUseId: 'toolu_00' }), (err) => err.status === 409);
  screen = PROMPT('factory_start', 2);
  await assert.rejects(feed.answerPermission({ answer: 'yes', toolUseId: 'toolu_01' }), (err) => err.status === 409 && /1\. Yes/.test(err.message));
  assert.strictEqual(typed.length, 0);

  screen = PROMPT();
  const r = await feed.answerPermission({ answer: 'yes', toolUseId: 'toolu_01' });
  assert.deepStrictEqual(r, { ok: true, answer: 'yes', tool: 'factory_start' });
  assert.deepStrictEqual(typed, [['s1', '', true]], 'one Enter, nothing else');

  // A prompt for a shell command: offered, but not approvable here.
  fs.appendFileSync(file, line({ type: 'assistant', uuid: 'a2', timestamp: at, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'pa do --task x', description: 'start a run' } }] } }));
  session = { ...session, idleState: 'working', idleReason: 'streaming' };
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(got.some((e) => e.type === 'permission' && e.cleared), 'cleared once the prompt is gone');
  session = { ...session, idleState: 'waiting', idleReason: 'blocked' };
  await new Promise((r) => setTimeout(r, 60));
  const bash = got.filter((e) => e.type === 'permission' && !e.cleared).pop();
  assert.deepStrictEqual([bash.toolUseId, bash.approvable], ['toolu_02', false]);
  await assert.rejects(feed.answerPermission({ answer: 'no', toolUseId: 'toolu_02' }), (err) => err.status === 409 && /termhub/.test(err.message));
  assert.strictEqual(typed.length, 1);
  unsubscribe();
  feed.stop();
  fs.rmSync(root, { recursive: true, force: true });

  // The route: X-PA and this page's token, before anything else.
  const dash = require('../src/dashboard/server');
  const server = await dash.start({ port: 0 });
  const { port } = server.address();
  try {
    const post = (headers) => fetch(`http://127.0.0.1:${port}/api/chat/permission`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"answer":"yes","toolUseId":"toolu_01"}' });
    assert.strictEqual((await post({})).status, 403, 'no X-PA');
    const noToken = await post({ 'X-PA': '1' });
    assert.strictEqual(noToken.status, 403, 'no page token');
    assert.match((await noToken.json()).error, /page token/);
    assert.strictEqual((await post({ 'X-PA': '1', 'X-PA-Page': 'made-up' })).status, 403, 'a token the server never issued');
    // The Talk page carries a token the server issued.
    const page = await (await fetch(`http://127.0.0.1:${port}/talk`)).text();
    const token = (/<meta name="pa-page" content="([A-Za-z0-9_-]+)">/.exec(page) || [])[1];
    assert.ok(token, 'the Talk page carries its token');
    assert.ok(dash.pageTokenOk({ headers: { 'x-pa-page': token } }));
  } finally {
    server.close();
  }
  console.log('chatPermission ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
