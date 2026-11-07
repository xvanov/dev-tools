'use strict';

// The chat box / voice page feed: transcript lines -> chat events, termhub's
// session state -> status, and the feed end to end over a fake termhub and a
// temp transcript directory (src/chat/transcript.js, src/chat/feed.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const T = require('../src/chat/transcript');
const { createFeed } = require('../src/chat/feed');

const at = '2026-11-06T10:00:00.000Z';
const user = (uuid, content, extra = {}) => ({ type: 'user', uuid, timestamp: at, message: { role: 'user', content }, ...extra });
const asst = (uuid, blocks, stop = 'end_turn', extra = {}) => ({ type: 'assistant', uuid, timestamp: at, requestId: 'r1', message: { role: 'assistant', content: blocks, stop_reason: stop }, ...extra });

// --- transcript.js (pure) ---
assert.strictEqual(T.projectDirFor('C:\\Users\\k.i\\AppData\\Local\\personal-assistant\\pa-home'), 'C--Users-k-i-AppData-Local-personal-assistant-pa-home');
assert.strictEqual(T.projectDirFor('/home/k/pa-home/'), '-home-k-pa-home');

// What was typed is a user event; a tool result, hook output and CLI noise are not.
assert.deepStrictEqual(T.entryEvents(user('u1', 'what is on today?')), [{ id: 'u1', type: 'user', text: 'what is on today?', at }]);
assert.deepStrictEqual(T.entryEvents(user('u2', [{ type: 'text', text: 'multi' }, { type: 'text', text: 'block' }])).map((e) => e.text), ['multi\nblock']);
assert.deepStrictEqual(T.entryEvents(user('u3', [{ type: 'tool_result', tool_use_id: 't', content: 'x' }])), []);
assert.deepStrictEqual(T.entryEvents(user('u4', 'SessionStart hook output', { isMeta: true })), []);
assert.deepStrictEqual(T.entryEvents(user('u5', '<command-name>/clear</command-name>')), []);
assert.deepStrictEqual(T.entryEvents(user('u6', '[Request interrupted by user]')), []);
assert.deepStrictEqual(T.entryEvents(user('u7', 'side', { isSidechain: true })), []);

// An assistant line: text is the reply, tool_use is activity, thinking is nothing.
assert.deepStrictEqual(T.entryEvents(asst('a1', [{ type: 'thinking', thinking: 'hmm' }], 'tool_use')), []);
assert.deepStrictEqual(T.entryEvents(asst('a2', [{ type: 'text', text: '  Two meetings.  ' }])), [{ id: 'a2', type: 'assistant', text: 'Two meetings.', at, final: true }]);
// Text before a tool call is a step, not the answer; no stop_reason: unknown.
assert.strictEqual(T.entryEvents(asst('a2b', [{ type: 'text', text: 'Let me check.' }], 'tool_use'))[0].final, false);
assert.ok(!('final' in T.entryEvents(asst('a2c', [{ type: 'text', text: 'Hm.' }], null))[0]));
const tools = T.entryEvents(asst('a3', [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'mcp__personal-assistant__recall', input: { query: 'renewal' } }], 'tool_use'));
assert.deepStrictEqual(tools.map((e) => [e.id, e.type]), [['a3', 'assistant'], ['a3:1', 'activity']]);
assert.strictEqual(tools[1].text, 'searching your history: renewal…');

// Tool descriptions: short, and never the whole input.
assert.strictEqual(T.describeTool('mcp__pa-chat__pa', { command: 'search', args: ['renewal', '--since', '2026-01-01'] }), 'running pa search renewal --since 2026-01-01…');
assert.strictEqual(T.describeTool('Bash', { command: 'node pa.js do --task "x"', description: 'Start the run' }), 'running a command: Start the run…');
assert.strictEqual(T.describeTool('Read', { file_path: 'C:\\x\\INBOX.md' }), 'reading INBOX.md…');
assert.strictEqual(T.describeTool('mcp__pa-chat__who_is', { name: 'Ana' }), 'looking up Ana…');
assert.strictEqual(T.describeTool('Mystery'), 'using Mystery…');
assert.ok(T.describeTool('mcp__x__recall', { query: 'q'.repeat(500) }).length < 90);

// Lines: a half-written last line is carried, a torn line skipped.
let p = T.parseLines('', '{"a":1}\n{"b":');
assert.deepStrictEqual(p.entries, [{ a: 1 }]);
assert.strictEqual(p.rest, '{"b":');
p = T.parseLines(p.rest, '2}\nnot json\n');
assert.deepStrictEqual(p.entries, [{ b: 2 }]);
assert.strictEqual(p.rest, '');

// Status comes from termhub, which also sees prompts the transcript cannot.
assert.deepStrictEqual(T.sessionStatus(null), { status: 'offline', waitingOn: null });
assert.deepStrictEqual(T.sessionStatus({ alive: false }), { status: 'offline', waitingOn: null });
assert.deepStrictEqual(T.sessionStatus({ idleState: 'working', idleReason: 'streaming' }), { status: 'thinking', waitingOn: null });
assert.deepStrictEqual(T.sessionStatus({ idleState: 'waiting', idleReason: 'blocked' }), { status: 'thinking', waitingOn: 'termhub' });
assert.deepStrictEqual(T.sessionStatus({ idleState: 'waiting', idleReason: 'question' }), { status: 'thinking', waitingOn: 'termhub' });
assert.deepStrictEqual(T.sessionStatus({ idleState: 'waiting', idleReason: 'turn-end' }), { status: 'idle', waitingOn: null });
assert.deepStrictEqual(T.sessionStatus({ busy: true }), { status: 'thinking', waitingOn: null });

// --- the client: parses, and has no HTML sink ---
const client = fs.readFileSync(path.join(__dirname, '../src/dashboard/chat.client.js'), 'utf8');
new vm.Script(client, { filename: 'chat.client.js' });
assert.ok(!/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/.test(client), 'no HTML sinks in the chat tab');
// It lives in Ask (talk.html) as the Text mode, no longer in Plan's Chat view.
const html = fs.readFileSync(path.join(__dirname, '../src/dashboard/talk.html'), 'utf8');
assert.match(html, /<script src="chat\.js"><\/script>/);
assert.match(html, /id="textmode"/);
assert.match(html, /data-talk-mode-pick="text"/);
assert.match(html, /data-permission-card/, 'Text mode shows the Approve / Deny card');
const plan = fs.readFileSync(path.join(__dirname, '../src/dashboard/index.html'), 'utf8');
assert.ok(!/id="chat-view"|id="tab-chat"|src="chat\.js"/.test(plan), 'Plan has no Chat view any more');
// Relative, so it works behind termhub's /pa/ proxy.
assert.match(client, /new EventSource\('api\/chat\/stream'\)/);

// --- feed.js end to end over a fake termhub ---
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-chat-'));
  const home = path.join(root, 'pa-home');
  const dir = path.join(root, 'projects', T.projectDirFor(home));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'c0ffee00-0000-4000-8000-000000000000.jsonl');
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(file, line(user('h1', 'earlier question')) + line(asst('h2', [{ type: 'text', text: 'earlier answer' }])));

  const typed = [];
  let session = { id: 's1', cwd: home, alive: true, kind: 'claude', idleState: 'waiting', idleReason: 'turn-end' };
  let ensured = 0;
  const hub = {
    listSessions: async () => (session ? [session] : []),
    say: async (id, text) => { typed.push([id, text]); },
    briefClaude: async (h, id, text) => { typed.push([id, `brief:${text}`]); },
    sessionUrl: async (id) => `http://127.0.0.1:7000/#session=${id}`,
  };
  const feed = createFeed({
    home: () => home,
    root: () => path.join(root, 'projects'),
    hub: () => hub,
    ensureSession: async () => { ensured++; return session ? { sessionId: session.id, created: false } : { sessionId: 's2', created: true }; },
    pollMs: 20,
    statusMs: 20,
  });

  // History is the transcript, seeded without being broadcast.
  assert.deepStrictEqual(feed.history().map((e) => [e.type, e.text]), [['user', 'earlier question'], ['assistant', 'earlier answer']]);

  const got = [];
  const unsubscribe = feed.subscribe((e) => got.push(e));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(got.some((e) => e.type === 'status' && e.text === 'idle'), 'a subscriber is told the current state');

  // Sending types into the live session; CRLF never reaches the terminal.
  const { id } = await feed.send({ text: 'hello\r\nthere', source: 'voice' });
  assert.deepStrictEqual(typed, [['s1', 'hello\nthere']]);
  const mine = got.find((e) => e.id === id);
  assert.deepStrictEqual([mine.type, mine.text, mine.source], ['user', 'hello\nthere', 'voice']);
  // termhub still says idle (the keystrokes have not landed): the turn is not over.
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(got.filter((e) => e.type === 'status').pop().text, 'thinking');

  // The echo lands but termhub has not said "working" yet (a prompt hook
  // runs first): its "idle" is still the previous turn's.
  fs.appendFileSync(file, line(user('t1', 'hello\nthere')));
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(got.filter((e) => e.type === 'status').pop().text, 'thinking', 'no idle before the turn has begun');

  // Its echo in the transcript is dropped; the reply and the tool use come through.
  fs.appendFileSync(file, line(asst('t2', [{ type: 'tool_use', name: 'Read', input: { file_path: 'INBOX.md' } }], 'tool_use')));
  fs.appendFileSync(file, line(asst('t3', [{ type: 'text', text: 'Hi.' }])) + '{"type":"assistant","uuid":"t4"'); // half-written
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!got.some((e) => e.id === 't1'), 'our own message is not shown twice');
  assert.ok(got.some((e) => e.id === 't2' && e.type === 'activity' && e.text === 'reading INBOX.md…'));
  assert.ok(got.some((e) => e.id === 't3' && e.type === 'assistant' && e.text === 'Hi.'));
  assert.ok(!got.some((e) => e.id === 't4'), 'a line still being written is not read');
  assert.deepStrictEqual(feed.history(2).map((e) => e.text), ['hello\nthere', 'Hi.']);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(got.filter((e) => e.type === 'status').pop().text, 'idle', 'the answer ends the turn');

  // Someone typing in termhub is the same conversation.
  fs.appendFileSync(file, `,"timestamp":"${at}","message":{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}\n` + line(user('t5', 'typed in termhub')));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(got.some((e) => e.id === 't4' && e.text === 'done'), 'the completed line is read once finished');
  assert.ok(got.some((e) => e.id === 't5' && e.type === 'user' && !e.source));

  // Parked on a permission prompt: typing would answer it, so it is refused.
  session = { ...session, idleState: 'waiting', idleReason: 'blocked' };
  await assert.rejects(feed.send({ text: 'yes' }), (err) => err.status === 409);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(got.some((e) => e.type === 'activity' && /termhub/.test(e.text)), 'the wait is announced');
  assert.strictEqual(typed.length, 1);

  // Bad input.
  await assert.rejects(feed.send({ text: '  ' }), (err) => err.status === 400);
  await assert.rejects(feed.send({ text: 'x', source: 'sms' }), (err) => err.status === 400);

  // No session: offline, and sending starts one and briefs it once ready.
  session = null;
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(got.filter((e) => e.type === 'status').pop().text, 'offline');
  await feed.send({ text: 'wake up' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(typed[typed.length - 1], ['s2', 'brief:wake up']);

  const s = await feed.session();
  assert.strictEqual(s.status, 'offline');
  unsubscribe();
  feed.stop();
  fs.rmSync(root, { recursive: true, force: true });

  // --- the routes, on a throwaway port: POST needs X-PA, GETs answer ---
  const server = await require('../src/dashboard/server').start({ port: 0 });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', body: '{"text":"x"}' });
    assert.strictEqual(res.status, 403);
    const js = await fetch(`http://127.0.0.1:${port}/chat.js`);
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  } finally {
    server.close();
  }
  console.log('chatFeed ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
