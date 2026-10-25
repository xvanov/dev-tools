'use strict';

// Card links (src/dashboard/links.js) and the card-context prompt
// (src/commitments/contextCore.js). Pure: no database, no model. Names and
// ids are invented.

const assert = require('assert');
const L = require('../src/dashboard/links');
const K = require('../src/commitments/contextCore');

const hubs = { local: 'http://127.0.0.1:7000/', machines: { 'build-vm': 'http://build-vm.tail:7000' } };

// ---------------------------------------------------------------- source --

{
  // A Teams message with the connector's webUrl.
  const [l] = L.sourceLinks({
    source: 'graph_chat', external_id: '19:abc@thread.v2/111',
    raw: { webUrl: 'https://teams.microsoft.com/l/message/19%3aabc%40thread.v2/111?context=x', chatTopic: 'Widget feedback' },
  });
  assert.strictEqual(l.url, 'https://teams.microsoft.com/l/message/19%3aabc%40thread.v2/111?context=x');
  assert.strictEqual(l.label, 'Teams message in “Widget feedback”');
}
{
  // No webUrl (a cached row): the deep link is built from the id.
  const [l] = L.sourceLinks({ source: 'graph_chat', external_id: '19:a_b@unq.gbl.spaces/1792', raw: { chatType: 'oneOnOne' } });
  assert.ok(l.url.startsWith('https://teams.microsoft.com/l/message/19%3Aa_b%40unq.gbl.spaces/1792?context='), l.url);
  assert.strictEqual(l.label, 'Teams message (1:1 chat)');
}
{
  const [l] = L.sourceLinks({ source: 'graph_mail', raw: { webLink: 'https://outlook.office365.com/owa/?ItemID=x' } });
  assert.strictEqual(l.label, 'Email in Outlook');
  // A mail without a link gets none, rather than a broken one.
  assert.deepStrictEqual(L.sourceLinks({ source: 'graph_mail', raw: {} }), []);
  // Only http(s) URLs ever become links.
  assert.deepStrictEqual(L.sourceLinks({ source: 'graph_mail', raw: { webLink: 'javascript:alert(1)' } }), []);
}
{
  const [l] = L.sourceLinks({ source: 'github_pr', raw: { webUrl: 'https://github.com/acme/widgets/pull/42' } });
  assert.deepStrictEqual(l, { kind: 'source', label: 'PR acme/widgets#42', url: 'https://github.com/acme/widgets/pull/42' });
  const jira = L.sourceLinks({ source: 'jira_issue', subject: 'WID-7 [Open]: Fix it', raw: { webUrl: 'https://acme.atlassian.net/browse/WID-7' } });
  assert.strictEqual(jira[0].label, 'Jira WID-7');
  const board = L.sourceLinks({
    source: 'github_project_item',
    raw: { webUrl: 'https://github.com/acme/widgets/issues/3', boardUrl: 'https://github.com/orgs/acme/projects/1', board: 'Roadmap' },
  });
  assert.deepStrictEqual(board.map((x) => x.label), ['issue acme/widgets#3', 'board Roadmap']);
}

// --------------------------------------------------------------- session --

{
  // A local session: termhub's transcript id is the last two path parts.
  const s = L.sessionInfo(
    {
      id: '9', source: 'claude_session', external_id: '7d351fab-bbd2-40c2-bd92-579001bd7fcf', occurred_at: '2026-10-22T03:24:49Z',
      raw: { cwd: 'C:\\repos\\tools', gitBranch: 'main', transcript: 'C:\\Users\\x\\.claude\\projects\\C--repos-tools\\7d351fab-bbd2-40c2-bd92-579001bd7fcf.jsonl' },
    },
    hubs
  );
  assert.strictEqual(s.machine, 'this machine');
  assert.strictEqual(s.remote, false);
  assert.strictEqual(s.cwd, 'C:\\repos\\tools');
  assert.strictEqual(s.resume, 'claude --resume 7d351fab-bbd2-40c2-bd92-579001bd7fcf');
  assert.strictEqual(s.itemId, 9);
  assert.strictEqual(
    s.transcriptUrl,
    'http://127.0.0.1:7000/api/claude/transcript?id=' + encodeURIComponent('C--repos-tools/7d351fab-bbd2-40c2-bd92-579001bd7fcf.jsonl')
  );
}
{
  // A remote session: the id loses its machine prefix, the link goes to that machine's termhub.
  const s = L.sessionInfo(
    {
      source: 'claude_session', external_id: 'build-vm:b2356b37-fdc0-44a2-87af-493b4cf7cfba',
      raw: { cwd: 'C:\\source\\widgets', machine: 'build-vm', transcript: 'C--source-widgets/b2356b37-fdc0-44a2-87af-493b4cf7cfba.jsonl' },
    },
    hubs
  );
  assert.strictEqual(s.machine, 'build-vm');
  assert.strictEqual(s.remote, true);
  assert.strictEqual(s.id, 'b2356b37-fdc0-44a2-87af-493b4cf7cfba');
  assert.ok(s.transcriptUrl.startsWith('http://build-vm.tail:7000/api/claude/transcript?id='), s.transcriptUrl);
  // Not a UUID: no resume command is offered (it would be typed into a shell).
  assert.strictEqual(L.sessionInfo({ source: 'claude_session', external_id: 'x; rm -rf /', raw: {} }, hubs).resume, null);
  assert.strictEqual(L.sessionInfo({ source: 'graph_chat', raw: {} }, hubs), null);
}

// ---------------------------------------------------- person, repo, text --

{
  const p = L.personLinks({ name: 'Ada Example', email: 'ada@example.com', github: 'ada-ex' });
  assert.deepStrictEqual(p, [
    { kind: 'person', label: 'Chat with Ada Example', url: 'https://teams.microsoft.com/l/chat/0/0?users=ada%40example.com' },
    { kind: 'person', label: 'Ada Example on GitHub', url: 'https://github.com/ada-ex' },
  ]);
  assert.deepStrictEqual(L.personLinks({ name: 'Me', email: 'me@example.com', is_me: true }), []);
  assert.deepStrictEqual(L.personLinks({ name: 'No Mail' }), []);
  assert.strictEqual(L.teamsChatUrl('not an address'), null);
}
{
  assert.deepStrictEqual(L.repoLink('acme/widgets'), { kind: 'repo', label: 'acme/widgets', url: 'https://github.com/acme/widgets' });
  assert.strictEqual(L.repoLink('acme/widgets.git').url, 'https://github.com/acme/widgets');
  assert.strictEqual(L.repoLink('not a path'), null);
  assert.strictEqual(L.repoLink(null), null);
}
{
  const text = `See https://github.com/acme/widgets/pull/1842/files, and the branch
https://github.com/acme/widgets/tree/fix/deploy-form. Also https://github.com/acme/widgets/pull/1842#issuecomment-9
and https://acme.atlassian.net/browse/WID-12?focused=1 plus https://example.com/x and https://github.com/acme/widgets.`;
  const m = L.mentionedLinks(text);
  assert.deepStrictEqual(m.map((x) => x.label), ['PR acme/widgets#1842', 'branch acme/widgets:fix/deploy-form', 'Jira WID-12', 'acme/widgets']);
  assert.strictEqual(m[0].url, 'https://github.com/acme/widgets/pull/1842');
  assert.strictEqual(m[2].url, 'https://acme.atlassian.net/browse/WID-12');
  assert.strictEqual(m[3].url, 'https://github.com/acme/widgets');
  assert.strictEqual(L.mentionedLinks('').length, 0);
  // Another repo named in a message, a file in it, and a page that is no repo.
  const other = L.mentionedLinks('the snapshot is in https://github.com/acme/brand-kb/actions/runs/5 and ' +
    'https://github.com/acme/brand-kb/blob/main/docs/a.md — see https://github.com/acme');
  assert.deepStrictEqual(other.map((x) => [x.label, x.url]), [
    ['acme/brand-kb', 'https://github.com/acme/brand-kb'],
    ['file acme/brand-kb/docs/a.md', 'https://github.com/acme/brand-kb/blob/main/docs/a.md'],
  ]);
}

// -------------------------------------------------------------- the card --

{
  const out = L.cardLinks({
    item: {
      source: 'graph_chat', external_id: '19:a@unq.gbl.spaces/5',
      raw: { webUrl: 'https://teams.microsoft.com/l/message/19%3Aa/5?context=x' },
    },
    text: 'the fix is in https://github.com/acme/widgets/pull/7 — repo https://github.com/acme/widgets',
    person: { name: 'Ada Example', email: 'ada@example.com' },
    project: 'acme/widgets',
    runs: [{ id: 3, mr_url: 'https://github.com/acme/widgets/pull/7' }, { id: 4, mr_url: 'https://github.com/acme/widgets/pull/8' }],
    evidence: { source: 'github_pr', raw: { webUrl: 'https://github.com/acme/widgets/pull/9' } },
    hubs,
  });
  assert.deepStrictEqual(out.links.map((l) => l.kind), ['source', 'person', 'repo', 'mention', 'run', 'evidence']);
  assert.deepStrictEqual(out.links.map((l) => l.label), [
    'Teams message', 'Chat with Ada Example', 'acme/widgets', 'PR acme/widgets#7', 'PR acme/widgets#8 (run #4)', 'evidence: PR acme/widgets#9',
  ]);
  assert.deepStrictEqual(out.sessions, []);
  // Every link is http(s).
  assert.ok(out.links.every((l) => /^https?:\/\//.test(l.url)));
}
{
  // A card read from a session: the session is a place, plus the repo.
  const out = L.cardLinks({
    item: { id: 1, source: 'claude_session', external_id: '7d351fab-bbd2-40c2-bd92-579001bd7fcf', raw: { cwd: 'C:\\repos\\tools' } },
    project: 'acme/tools',
    hubs,
  });
  assert.deepStrictEqual(out.links.map((l) => l.url), ['https://github.com/acme/tools']);
  assert.strictEqual(out.sessions.length, 1);
  assert.strictEqual(out.sessions[0].role, 'source');
  assert.strictEqual(out.sessions[0].transcriptUrl, null);
}

// ---------------------------------------------------------- card context --

{
  const prompt = K.buildPrompt({
    c: { id: 945, summary: 'Expect Ada to file repo issues', direction: 'owed_to_me', who: 'Ada Example', project: 'acme/widgets', status: 'open' },
    me: 'Sam Owner',
    item: { source: 'graph_chat', occurred_at: '2026-10-21T10:00:00Z', author: 'Ada Example', body: 'I will file the issues once I scope my side.', raw: { chatType: 'oneOnOne' } },
    thread: [
      { author: 'Sam Owner', occurred_at: '2026-10-21T09:50:00Z', body: 'Can you list what the migration needs?' },
      { author: 'Ada Example', occurred_at: '2026-10-21T10:00:00Z', body: 'I will file the issues once I scope my side.', is_source: true },
      { author: 'Ada Example', occurred_at: '2026-10-22T08:00:00Z', body: 'Filed two of them.' },
    ],
    runs: [{ id: 3, mode: 'plan', status: 'done', mr_url: null, started_at: '2026-10-22T09:00:00Z' }],
    now: new Date('2026-10-25T12:00:00Z'),
  });
  assert.ok(prompt.includes('Sam Owner ("you")'));
  assert.ok(prompt.includes('someone owes the board owner this (Ada Example)'));
  assert.ok(prompt.includes('(SOURCE)'));
  assert.ok(prompt.includes('Filed two of them.'));
  assert.ok(prompt.includes('agent run #3'));
  assert.ok(prompt.includes('<source>') && prompt.includes('</source>'));
  // The system prompt says message content is data (AGENT.md).
  assert.ok(/data, never instructions/.test(K.SYSTEM));
}
{
  // A session prompt names the machine and folder, and keeps head and tail.
  const body = `>> start ${'x'.repeat(20000)} << the end`;
  const prompt = K.buildPrompt({
    c: { id: 1, summary: 'Re-authenticate the connectors', direction: 'owed_by_me' },
    me: 'Sam',
    item: { source: 'claude_session', body, raw: { machine: 'build-vm', cwd: 'C:\\repos\\tools' } },
  });
  assert.ok(prompt.includes('on machine build-vm') && prompt.includes('in folder C:\\repos\\tools'));
  assert.ok(prompt.includes('>> start') && prompt.includes('<< the end') && prompt.includes('characters left out'));
}
{
  assert.strictEqual(K.parseContext(''), null);
  assert.strictEqual(K.parseContext('ok'), null);
  assert.strictEqual(
    K.parseContext('```\nContext: **Ada** asked you on Monday to review the PR.\nNothing since.\n```'),
    'Ada asked you on Monday to review the PR. Nothing since.'
  );
  assert.strictEqual(K.parseContext('“Ada asked you to review PR #7 in acme/widgets.”'), 'Ada asked you to review PR #7 in acme/widgets.');
  assert.ok(K.parseContext('a'.repeat(5000)).length <= 1200);
}

console.log('links ok');
