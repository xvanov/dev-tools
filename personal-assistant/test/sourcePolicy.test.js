'use strict';

// Only people create tasks: the source policy (src/commitments/sourcePolicy.js),
// the explicit request path (src/commitments/request.js, `pa task add`, the
// chat's task_add tool), and the backfill's split (src/commitments/policyClose.js).
// Invented names throughout.

const assert = require('assert');
const P = require('../src/commitments/sourcePolicy.ts');

// ---------------------------------------------------------------- setting --
const def = P.parseSpec('default').sources;
for (const s of ['graph_chat', 'graph_mail', 'audio', 'graph_event', 'github_notification', 'github_pr', 'github_issue', 'github_project_item', 'jira_issue', 'pa_request']) {
  assert.ok(def.has(s), `default allows ${s}`);
}
for (const s of ['claude_session', 'cursor_session']) assert.ok(!def.has(s), `default excludes ${s}`);
assert.deepStrictEqual([...P.parseSpec('').sources].sort(), [...def].sort(), 'empty is the default');
assert.deepStrictEqual([...P.parseSpec(null).sources].sort(), [...def].sort());
const noGh = P.parseSpec('default,-github').sources;
assert.ok(!noGh.has('github_pr') && noGh.has('graph_chat'), '-group takes a group out');
assert.deepStrictEqual([...P.parseSpec('teams, mail').sources].sort(), ['graph_chat', 'graph_mail']);
assert.ok(P.parseSpec('default,sessions').sources.has('claude_session'), 'sessions can be put back explicitly');
assert.deepStrictEqual(P.parseSpec('teams,frobnicate').unknown, ['frobnicate'], 'unknown words are reported');
assert.deepStrictEqual(P.parseSpec('teams,Bad;Word').unknown, ['Bad;Word']);
assert.ok(!P.parseSpec('teams,Bad;Word').sources.has('bad;word'), 'nothing unsafe reaches SQL');

assert.strictEqual(P.sourceSql('si.source', new Set(['graph_chat', 'graph_mail'])), "si.source in ('graph_chat', 'graph_mail')");
assert.strictEqual(P.sourceSql('si.source', new Set()), 'false', 'nothing allowed: nothing matches');
assert.strictEqual(P.sourceSql('si.source', new Set(["x'; drop table y; --"])), 'false', 'a bad name is never inlined');
assert.ok(!P.distillSources(def).has('pa_request'), 'a requested task is never distilled — it is written whole');
assert.ok(P.distillSources(def).has('graph_chat'));

const d = P.describe('default,-jira');
assert.ok(d.excluded.includes('claude_session') && d.excluded.includes('jira_issue'));
assert.ok(d.allowed.includes('pa_request'));

// ------------------------------------------------------------------ items --
const ctx = { sources: def, login: 'quill-dev', me: { name: 'Quill Morrow', email: 'quill@example.test' }, isAutomated: require('../src/ingest/m365.ts').isAutomated };
const ok = (item, why) => assert.strictEqual(P.judge(item, ctx).ok, true, why);
const no = (item, why) => assert.strictEqual(P.judge(item, ctx).ok, false, why);

no({ source: 'claude_session', author_identity: 'me', raw: { cwd: 'C:/src/widgets' } }, 'a Claude session never creates a task');
no({ source: 'cursor_session', author_identity: 'me', raw: {} }, 'nor a Cursor session');
no({ source: 'some_new_feed', raw: {} }, 'a source nobody listed creates nothing');
ok({ source: 'graph_chat', author_identity: 'bryn.oakes@example.test', raw: {} }, 'Teams from a person');
ok({ source: 'graph_chat', author_identity: 'aad:0b1c', raw: {} }, 'a person known only by AAD id');
ok({ source: 'graph_chat', author_identity: null, raw: {} }, 'chat with no author recorded is still chat ingest kept');
no({ source: 'graph_chat', author_identity: 'noreply@example.test', raw: {} }, 'a mailer in chat');
ok({ source: 'graph_mail', author_identity: 'bryn.oakes@example.test', raw: {} }, 'mail from a person');
ok({ source: 'graph_mail', author_identity: 'quill@example.test', raw: {} }, 'your own sent mail is a person (you)');
no({ source: 'graph_mail', author_identity: 'notifications@github.com', raw: {} }, 'GitHub mail');
no({ source: 'graph_mail', author_identity: 'jira@acme.atlassian.net', raw: {} }, 'Jira mail');
no({ source: 'graph_mail', author_identity: null, raw: {} }, 'mail with no sender');
ok({ source: 'audio', author_identity: 'me', raw: { kind: 'note' } }, 'what was said aloud');
ok({ source: 'pa_request', author_identity: 'me', raw: {} }, 'a task you asked for');

// GitHub: a person other than you asking you.
const gh = (o) => ({ source: 'github_notification', raw: {}, ...o });
ok(gh({ author_identity: 'github:bryn-oakes', raw: { action: 'review_requested', author: 'bryn-oakes', requestedMe: true } }), 'a review requested by name');
ok(gh({ author_identity: 'github:coderabbitai[bot]', raw: { action: 'review_requested', author: 'bryn-oakes' } }), 'the PR author asks, whatever bot commented last');
no(gh({ author_identity: 'github:dependabot[bot]', raw: { action: 'review_requested', author: 'dependabot[bot]' } }), 'dependabot asking for a review');
no(gh({ author_identity: 'github:bryn-oakes', raw: { action: 'review_requested', author: 'bryn-oakes', requestedMe: false } }), 'a team review request');
no(gh({ author_identity: 'github:bryn-oakes', raw: { action: 'team_review_requested', author: 'bryn-oakes' } }), 'team queue');
ok(gh({ author_identity: 'github:bryn-oakes', raw: { action: 'mention' } }), 'a person @mentions you');
no(gh({ author_identity: 'github:coderabbitai[bot]', raw: { action: 'mention', author: 'quill-dev' } }), 'CodeRabbit mentioning you');
no(gh({ author_identity: 'github:snyk-io[bot]', raw: { action: 'author', author: 'quill-dev' } }), 'Snyk on your PR');
no(gh({ author_identity: 'github:github-actions[bot]', raw: { action: 'comment' } }), 'CI comment');
ok(gh({ author_identity: 'github:bryn-oakes', raw: { action: 'author', author: 'quill-dev' } }), 'a reviewer commenting on your PR');
no(gh({ author_identity: 'github:quill-dev', raw: { action: 'author', author: 'quill-dev' } }), 'your own activity on your own PR');
no(gh({ author_identity: 'github:Quill-Dev', raw: { action: 'mention' } }), 'your own comment, any case');
no(gh({ author_identity: null, raw: { action: 'ci_activity' } }), 'CI');
no(gh({ author_identity: null, raw: { action: 'approval_requested' } }), 'a deployment approval');
no(gh({ author_identity: 'github:bryn-oakes', raw: { action: 'state_change' } }), 'a state change');
no(gh({ author_identity: null, raw: { action: 'comment' } }), 'nobody on record');
ok({ source: 'github_pr', author_identity: 'github:bryn-oakes', raw: { reviewRequested: true } }, 'a PR you were asked to review');
no({ source: 'github_pr', author_identity: 'github:dependabot[bot]', raw: { reviewRequested: true } }, 'a dependabot PR');
no({ source: 'github_pr', author_identity: 'github:quill-dev', raw: {} }, 'your own PR');
ok({ source: 'github_issue', author_identity: 'github:bryn-oakes', raw: { assignees: ['quill-dev'] } }, 'an issue a person filed for you');
no({ source: 'github_issue', author_identity: 'github:snyk-bot', raw: { assignees: ['quill-dev'] } }, 'a Snyk issue');
no({ source: 'github_issue', author_identity: 'github:quill-dev', raw: {} }, 'an issue you filed');
ok({ source: 'github_project_item', author_identity: 'github:bryn-oakes', raw: { assignees: ['quill-dev'] } }, 'a card assigned to you');
no({ source: 'github_project_item', author_identity: 'github:bryn-oakes', raw: { assignees: [], watched: true } }, 'a watched card');
for (const login of ['coderabbitai', 'renovate', 'dependabot', 'sonarcloud', 'codecov', 'vercel', 'snyk-io', 'mergify', 'some-ci-bot', 'x[bot]']) {
  assert.ok(P.isGithubBot(login), `${login} is a bot`);
}
for (const login of ['bryn-oakes', 'robotics-fan', 'abbot', 'quill-dev']) assert.ok(!P.isGithubBot(login), `${login} is a person`);

// Jira.
ok({ source: 'jira_issue', author_identity: 'Bryn Oakes', raw: { reporter: 'Bryn Oakes' } }, 'a person on the ticket');
no({ source: 'jira_issue', author_identity: 'Automation for Jira', raw: {} }, 'Jira automation');
no({ source: 'jira_issue', author_identity: 'Quill Morrow', raw: {} }, 'your own comment');
no({ source: 'jira_issue', author_identity: null, raw: {} }, 'nobody on record');

// A narrower setting still applies per item.
assert.strictEqual(P.judge({ source: 'graph_mail', author_identity: 'bryn.oakes@example.test' }, { ...ctx, sources: P.parseSpec('teams').sources }).ok, false);

// ------------------------------------------------------- pa task add --
const R = require('../src/commitments/request.ts');
const now = new Date(2026, 10, 5, 10, 0); // Thursday 5 Nov 2026, 10:00 local
let t = R.parse({ text: '  Send the  rollout notes to the pod ' }, now);
assert.deepStrictEqual(
  { summary: t.summary, direction: t.direction, dueAt: t.dueAt, forName: t.forName },
  { summary: 'Send the rollout notes to the pod', direction: 'owed_by_me', dueAt: null, forName: null }
);
t = R.parse({ text: 'Review the billing doc', due: 'friday', for: 'Bryn Oakes' }, now);
assert.strictEqual(t.dueAt.getDay(), 5, 'friday');
assert.strictEqual(t.dueAt.getDate(), 6);
assert.strictEqual(t.forName, 'Bryn Oakes');
assert.strictEqual(R.parse({ text: 'x', due: 'by tomorrow 3pm' }, now).dueAt.getHours(), 15, '"by" is allowed');
assert.strictEqual(R.parse({ text: 'x', due: '2d' }, now).dueAt.getTime(), now.getTime() + 2 * 86400_000);
t = R.parse({ text: 'Budget figures', for: 'Bryn', owedToMe: true }, now);
assert.strictEqual(t.direction, 'owed_to_me');
assert.throws(() => R.parse({ text: 'Budget figures', owedToMe: true }, now), /needs --for/);
assert.throws(() => R.parse({ text: '   ' }, now), /what is the task/);
assert.throws(() => R.parse({ text: 'x', due: 'whenever' }, now), /cannot read the due date/);
assert.throws(() => R.parse({ text: 'y'.repeat(R.MAX_TEXT + 1) }, now), /one line/);
const long = R.parse({ text: 'z'.repeat(300) }, now);
assert.ok(long.summary.length <= 200 && long.detail.length === 300, 'a long task keeps its words in detail');
assert.match(R.describe({ id: 9, summary: 'Ship it', direction: 'owed_to_me', who: 'Bryn', personFound: false, dueAt: null }), /task #9: Ship it · owed to you by Bryn · \(no single person/);

const { addOptions } = require('../src/cli/task');
const { parseArgs } = require('../src/cli/parseArgs');
const cli = (line) => {
  const p = parseArgs(line);
  return addOptions(p.args, p.flags);
};
assert.deepStrictEqual(cli(['task', 'add', 'Send the deck', '--due', 'friday', '--for', 'Bryn Oakes']), {
  text: 'Send the deck', due: 'friday', for: 'Bryn Oakes', owedToMe: false, project: null, via: 'cli',
});
assert.deepStrictEqual(cli(['task', 'add', 'Send', 'the', 'deck']).text, 'Send the deck', 'unquoted words join');
const owed = cli(['task', 'add', '--owed-to-me', 'Budget figures', '--for', 'Bryn']);
assert.strictEqual(owed.owedToMe, true);
assert.strictEqual(owed.text, 'Budget figures', 'a boolean flag gives back the word it swallowed');
assert.strictEqual(cli(['task', 'add', 'Budget', '--for', 'Bryn', '--owed-to-me']).owedToMe, true);

// ------------------------------------------------ the chat may add, only there --
const chat = require('../src/chat');
const s = chat.settingsJson();
assert.ok(s.permissions.allow.includes(`mcp__${chat.CHAT_MCP}__task_add`), 'the chat adds a task without a prompt');
assert.ok(!s.permissions.allow.some((r) => r.startsWith('Bash(')), 'still no shell allow rule');
assert.match(chat.claudeMd(), /ONLY then: never for your own work/);
assert.strictEqual(require('../src/chat/agent.ts').opencodeRules()['personal-assistant_task_add'], 'allow');
const mcp = require('../src/mcp/server.ts');
assert.strictEqual(mcp.TASK_TOOL.name, 'task_add');
assert.deepStrictEqual(mcp.TASK_TOOL.inputSchema.required, ['text']);

(async () => {
  const prev = process.env.PA_MCP_CHAT_TOOLS;
  delete process.env.PA_MCP_CHAT_TOOLS;
  await assert.rejects(() => mcp.handle('task_add', { text: 'x' }), /unknown tool task_add/, 'no other session can add tasks');
  if (prev !== undefined) process.env.PA_MCP_CHAT_TOOLS = prev;

  // ------------------------------------------------------- backfill split --
  const PC = require('../src/commitments/policyClose.ts');
  const rows = [
    { id: 1, source: 'claude_session', summary: 'Wire in the widget', direction: 'owed_by_me', raw: {} },
    { id: 2, source: 'claude_session', summary: 'Run the e2e suite', direction: 'owed_by_me', raw: {}, has_run: true },
    { id: 3, source: 'graph_chat', author_identity: 'bryn.oakes@example.test', summary: 'Send the notes', direction: 'owed_by_me', raw: {} },
    { id: 4, source: 'github_notification', author_identity: 'github:coderabbitai[bot]', summary: 'Fix the nit', direction: 'owed_by_me', raw: { action: 'author' } },
    { id: 5, source: 'claude_session', summary: 'Check the banner', direction: 'owed_by_me', raw: {}, you_moved: true },
    { id: 6, source: 'claude_session', summary: 'Tidy fixtures', direction: 'owed_by_me', raw: {}, touched: true, has_draft: true },
    { id: 7, source: 'pa_request', author_identity: 'me', summary: 'Book the room', direction: 'owed_by_me', raw: {} },
  ];
  const sp = PC.split(rows, ctx);
  assert.deepStrictEqual(sp.close.map((c) => c.id), [1, 4], 'session notes and bot asks close');
  assert.deepStrictEqual(sp.keep.map((c) => [c.id, c.acted]), [[2, 'run'], [5, 'your status change'], [6, 'draft, your edit']], 'what you acted on is kept');
  assert.deepStrictEqual(PC.bySource(sp.close), { claude_session: 1, github_notification: 1 });
  const rep = PC.report({ ...sp, unfold: [] });
  assert.match(rep, /Would close 2/);
  assert.match(rep, /claude_session \(1\)/);
  assert.match(rep, /Dry run/);

  console.log('sourcePolicy.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
