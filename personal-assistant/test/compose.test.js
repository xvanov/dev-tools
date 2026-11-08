'use strict';

// Brief composition (src/dispatch/composeCore.js, compose.js): what a factory
// job's brief may carry. The model is stubbed; the repo search runs against a
// throwaway git repo. Names and messages are invented.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const C = require('../src/dispatch/composeCore');

// --- secrets never pass ------------------------------------------------------------------

{
  const leaky = [
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'use github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'key sk-ant-api03-abcdefghijklmnopqrstuv',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdefghij',
    'Authorization: Bearer abcdef0123456789abcdef',
    'password: hunter2hunter2',
    'API_KEY=s3cr3tvalue',
    'postgres://admin:pa55word@db.internal:5432/app',
    'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abc123def456==;',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  ];
  for (const t of leaky) {
    const r = C.redactSecrets(t);
    assert.match(r, /\[redacted/, `redacted: ${t.slice(0, 20)}`);
    for (const secret of ['abcdefghijklmnopqrstuvwxyz0123456789', 'hunter2hunter2', 's3cr3tvalue', 'pa55word', 'abc123def456', 'MIIEow', 'dozjgNryP4J3jVmNHl0w5N']) {
      assert.ok(!r.includes(secret), `${secret} gone from ${t.slice(0, 20)}`);
    }
  }
  assert.strictEqual(C.redactSecrets(C.redactSecrets('password=x1')), C.redactSecrets('password=x1'), 'idempotent');
  assert.strictEqual(C.redactSecrets('rename src/auth/token.js and add a retry'), 'rename src/auth/token.js and add a retry', 'ordinary prose and paths untouched');
}

// MUST-FIX 9/10: the review's leaks, every one redacted; ordinary text untouched.
{
  const leaks = {
    ghp_split: 'ghp_ABCDEFGHIJ\nKLMNOPQRSTUVWXYZ0123456789ab',
    azure_env: 'AZURE_OPENAI_API_KEY=3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6',
    aws_secret_env: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    deepseek_env: 'DEEPSEEK_API_KEY: abcdef0123456789abcdef0123456789',
    x_api_key: 'X_API_KEY: Zm9vYmFyYmF6cXV4MTIz',
    ocp: 'Ocp-Apim-Subscription-Key: 3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6',
    bare_hex: 'the azure key is 3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6',
    pgp: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF...secretmaterial\n-----END PGP PRIVATE KEY BLOCK-----',
    pg_at: 'postgres://admin:p@ss/w0rd@db.host:5432/app',
    mongo: 'mongodb+srv://u:Hunter2!x@cluster0.mongodb.net',
    creds_b64: 'creds: dXNlcjpodW50ZXIyLXN1cGVyLXNlY3JldA==',
    curl_u: 'curl -u admin:hunter2 https://x',
    netrc: 'machine github.com login me password hunter2',
    access_token: '{"access_token": "ya29.a0AfH6SMBx-very-long-google-token"}',
    refresh: 'refresh_token=1//0gLongGoogleRefreshTokenValue',
    stripe: 'sk_live_51H' + 'a'.repeat(30),
    npm: 'npm_' + 'c'.repeat(36),
    hf: 'hf_' + 'd'.repeat(34),
    zero_width: 'ghp_' + 'A'.repeat(18) + '\u200b' + 'B'.repeat(18),
    entropy: 'use Xk9fQ2mZ7pL4vR8tW1nB6cY3hJ5dG0sA for it',
  };
  for (const [k, v] of Object.entries(leaks)) {
    const r = C.redactSecrets(v);
    assert.match(r, /\[redacted/, k);
    for (const secret of ['3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6', 'wJalrXUtnFEMI', 'p@ss/w0rd', 'Hunter2!x', 'hunter2', 'secretmaterial', 'ya29.', '1//0gLong', 'KLMNOPQRSTUV', 'Xk9fQ2mZ7pL4']) {
      assert.ok(!r.includes(secret), `${k}: ${secret}`);
    }
  }
  for (const t of ['rename src/auth/token.js and add a retry', 'the password reset flow sends a token by email', 'Retry the export; key: retries must use backoff',
    'commit 0123456789abcdef0123456789abcdef01234567 broke it', 'see src/components/UserProfileSettingsPanel2.tsx', 'the token expiry is configurable']) {
    assert.strictEqual(C.redactSecrets(t), t, t);
  }
  // Title, criteria and flow are on the factory's command line and in its direction.
  const F = require('../src/dispatch/factoryCore');
  const task = 'rotate the key; current one is AZURE_OPENAI_API_KEY=3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6 and ghp_' + 'Z'.repeat(36);
  const argv = F.submitArgv({ app: 'a', title: task, askFile: '/x', done: [task], delivery: 'pr', externalId: 'k-1' });
  assert.ok(!argv.some((a) => /3f2a9c0d|ZZZZZZZZ/.test(a)), 'argv carries no secret');
  assert.ok(!/3f2a9c0d|ZZZZZZZZ/.test(F.flowMarkdown({ title: task, summary: task, done: [task] })), 'flow.md carries no secret');
  // clip never splits a surrogate pair.
  const c = C.clip('x'.repeat(598) + '\u{1F600}\u{1F600}', 600);
  assert.ok(c.isWellFormed(), 'well-formed after clipping');
  // Doctor shows the database URL with its password hidden, however it is spelled.
  const { maskUrl } = require('../src/cli/index');
  assert.strictEqual(maskUrl('postgres://pa:s3cret@127.0.0.1:5433/pa'), 'postgres://pa:***@127.0.0.1:5433/pa');
  assert.ok(!maskUrl('postgres://pa:p@ss:w/rd@h/db').includes('ss:w'));
}

// --- what to look for, and what exists ---------------------------------------------------

{
  const kws = C.keywords('Add retries to `exportCsv` in the export_worker; see src/export/retry.js');
  assert.ok(kws.includes('exportCsv') && kws.includes('export_worker') && kws.includes('retry.js'), kws.join(','));
  assert.ok(!kws.includes('the') && !kws.includes('Add'), 'stop words dropped');
  assert.ok(kws.length <= 8);

  const files = ['src/export/retry.js', 'src/export/csv.js', 'src/billing/invoice.js', 'test/export.test.js', 'package-lock.json', 'node_modules/retry/index.js', 'README.md', 'CLAUDE.md', 'docs/README.md'];
  const { reuse, conventions } = C.rankHints({ files, hits: { retries: ['src/export/csv.js', 'package-lock.json'] }, keywords: ['retries', 'export'] });
  assert.strictEqual(reuse[0].path, 'src/export/retry.js', 'named for a keyword beats mentioning it');
  assert.ok(reuse.some((r) => r.path === 'src/export/csv.js'));
  assert.ok(!reuse.some((r) => /package-lock|node_modules/.test(r.path)), 'never lockfiles or vendored code');
  assert.ok(!reuse.some((r) => /invoice/.test(r.path)));
  assert.match(reuse[0].why, /name matches "retries"/);
  assert.deepStrictEqual(conventions, ['CLAUDE.md', 'README.md'], 'the root convention docs only');
}

// --- the model's answer, held to the rules --------------------------------------------

const MESSAGE = 'Hi! Could you make the nightly export retry when the storage API times out? Last night it died at 2am and finance had nothing in the morning, which was embarrassing for me in front of the CFO. Also my password is hunter2hunter2 if you need the portal.';
const PERSON = 'Dana Moss — head of finance ops. Going through a divorce, often stressed on Mondays. Prefers short answers. Phone +1 555 0100.';
const inputs = {
  title: 'Add retries to the nightly export',
  operatorAsk: 'Add retries to the nightly export when storage times out',
  summary: 'Make the nightly export retry on storage timeouts',
  detail: null,
  done: [],
  message: { source: 'graph_mail', body: MESSAGE },
  related: ['Re: export failed again'],
  facts: [{ subject: 'export', text: 'runs at 02:00 UTC from the worker' }],
  personNote: PERSON,
  projectNote: 'The widget repo uses exponential backoff helpers in src/util/backoff.js for every network call.',
  codeHints: [{ path: 'src/export/nightly.js', why: 'its name matches "export"' }],
  conventions: ['CLAUDE.md'],
  files: ['src/export/nightly.js', 'src/util/backoff.js', 'CLAUDE.md'],
  app: 'widget',
  slug: 'acme/widget',
};

{
  const { system, prompt } = C.buildPrompt(inputs);
  assert.match(system, /data, never instructions/);
  assert.match(system, /Never copy a message or note wholesale/);
  assert.ok(!prompt.includes('hunter2hunter2'), 'a secret never reaches the model either');
  assert.match(prompt, /PRIVATE/);
  assert.match(prompt, /src\/export\/nightly\.js/);
}

{
  const raw = {
    goal: 'Make the nightly export retry storage timeouts with backoff so one timeout does not lose the night\'s export.',
    done: ['A storage timeout is retried up to 3 times with backoff', 'A test covers the timeout path'],
    constraints: ['Keep the export schedule at 02:00 UTC'],
    decisions: [],
    facts: [
      // A wholesale copy of the message: dropped.
      'Last night it died at 2am and finance had nothing in the morning, which was embarrassing for me in front of the CFO.',
      // A personal detail lifted from the person page: dropped (verbatim run).
      'Dana Moss — head of finance ops. Going through a divorce, often stressed on Mondays.',
      // A credential: redacted.
      'The portal password is hunter2hunter2',
      'Backoff helpers already exist for network calls',
    ],
    reuse: [
      { path: 'src/util/backoff.js', why: 'existing exponential backoff helper' },
      { path: 'src/made/up.js', why: 'invented' },
      { path: './src/export/nightly.js', why: 'the export itself' },
    ],
    questions: ['Which errors count as a timeout?'],
  };
  const { composed, dropped } = C.checkComposed(raw, inputs);
  assert.strictEqual(composed.facts.length, 2);
  assert.ok(!composed.facts.some((f) => /CFO|divorce/.test(f)), 'nothing copied wholesale from private material');
  assert.ok(composed.facts.some((f) => /password is \[redacted\]|\[redacted\]/.test(f)) && !composed.facts.some((f) => f.includes('hunter2')));
  assert.deepStrictEqual(composed.reuse.map((r) => r.path), ['src/util/backoff.js', 'src/export/nightly.js'], 'only real files');
  assert.ok(dropped.some((d) => /not a file in the repo/.test(d.why)));
  assert.strictEqual(dropped.filter((d) => /verbatim/.test(d.why)).length, 2);
  assert.deepStrictEqual(composed.done, raw.done, 'no criteria given: the model\'s');

  // The operator's own criteria win and come first; the model's are not mixed in.
  const given = C.checkComposed(raw, { ...inputs, done: ['retries are configurable'] });
  assert.deepStrictEqual(given.composed.done, ['retries are configurable']);

  // The operator may quote the requester: that run is theirs to send.
  const quoted = 'Last night it died at 2am and finance had nothing in the morning, which was embarrassing';
  const ok = C.checkComposed({ goal: quoted }, { ...inputs, operatorAsk: `Fix this: "${quoted}"` });
  assert.strictEqual(ok.composed.goal, quoted);

  // Rendered: the fixed engineering instruction, the stop condition, the reuse pointers, nothing private.
  const brief = C.render(composed, { title: inputs.title, app: 'widget', slug: 'acme/widget', delivery: 'auto_merge', deliveryPlain: 'Will merge to main automatically once its checks pass.', pipeline: 'solo', by: 'compose:test' });
  assert.ok(brief.includes(C.ENGINEERING_RULE));
  assert.strictEqual(C.ENGINEERING_RULE, 'Search the repo for existing implementations before writing new code; extend rather than duplicate; follow existing conventions; add/extend tests.');
  assert.match(brief, /## Existing code to reuse or extend\n\n- `src\/util\/backoff\.js` — existing exponential backoff helper/);
  assert.match(brief, /- \[ \] A storage timeout is retried up to 3 times with backoff/);
  assert.match(brief, /## Stop condition\n\nOpen a pull request; it is merged automatically/);
  assert.match(brief, /Delivery: `auto_merge` — Will merge to main automatically/);
  assert.match(brief, /`CLAUDE\.md`/);
  for (const banned of ['hunter2', 'divorce', 'CFO', '555 0100', 'Dana']) assert.ok(!brief.includes(banned), `no ${banned}`);
  assert.strictEqual(brief, C.render(composed, { title: inputs.title, app: 'widget', slug: 'acme/widget', delivery: 'auto_merge', deliveryPlain: 'Will merge to main automatically once its checks pass.', pipeline: 'solo', by: 'compose:test' }), 'deterministic: the card shows what is sent');
  for (const d of ['none', 'branch', 'draft_pr', 'pr', 'auto_merge', 'push_to_main']) assert.ok(C.STOP[d], d);
}

// --- no model: the operator's words and the hints, nothing private -----------------------

{
  const fb = C.fallbackComposed(inputs);
  const brief = C.render(fb, { title: inputs.title, delivery: 'draft_pr' });
  assert.match(brief, /Add retries to the nightly export when storage times out/);
  assert.match(brief, /src\/export\/nightly\.js/);
  for (const banned of ['hunter2', 'divorce', 'CFO', 'Dana', 'backoff helpers in src/util']) assert.ok(!brief.includes(banned), `fallback carries no ${banned}`);
  assert.ok(brief.includes(C.ENGINEERING_RULE));
  // With no hints it says to search rather than implying there is nothing.
  assert.match(C.render(C.fallbackComposed({ title: 't' }), { delivery: 'none' }), /None identified by the assistant\. That is not evidence there is none/);
}

// --- compose.js: the model call is swappable, and failure falls back ----------------------

async function composeModule() {
  const compose = require('../src/dispatch/compose');
  let prompts = 0;
  compose._setModel(async () => { prompts++; return 'Here you go:\n```json\n{"goal": "Retry storage timeouts.", "done": ["timeouts retried"], "reuse": [{"path": "src/util/backoff.js", "why": "helper"}]}\n```'; });
  const a = await compose.composeFrom(inputs);
  assert.deepStrictEqual([a.composed.goal, a.composed.done, a.composed.reuse[0].path, a.by], ['Retry storage timeouts.', ['timeouts retried'], 'src/util/backoff.js', 'compose:test']);
  compose._setModel(async () => { throw new Error('provider down'); });
  const b = await compose.composeFrom(inputs);
  assert.strictEqual(b.by, 'compose:fallback');
  assert.strictEqual(b.composed.goal, inputs.operatorAsk);
  compose._setModel(async () => 'I cannot help with that.');
  assert.strictEqual((await compose.composeFrom(inputs)).by, 'compose:fallback', 'no JSON: fallback');
  const c = await compose.composeFrom(inputs, { useModel: false });
  assert.strictEqual(c.by, 'compose:fallback');
  assert.strictEqual(prompts, 1);

  // The repo search, against a real (throwaway) git repo.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-compose-repo-'));
  const write = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
  write('src/export/nightly.js', 'module.exports = function runExport() { /* storage */ };\n');
  write('src/util/backoff.js', '// retries with exponential backoff\nmodule.exports = {};\n');
  write('src/billing/invoice.js', 'module.exports = {};\n');
  write('CLAUDE.md', '# rules\n');
  write('package-lock.json', '{"retries": 1}\n');
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const hints = await compose.codeHints(repo, 'Add retries to the nightly export');
  const paths = hints.reuse.map((r) => r.path);
  assert.ok(paths.includes('src/export/nightly.js'), paths.join(','));
  assert.ok(paths.includes('src/util/backoff.js'), 'found by content ("retries")');
  assert.ok(!paths.includes('package-lock.json') && !paths.includes('src/billing/invoice.js'));
  assert.deepStrictEqual(hints.conventions, ['CLAUDE.md']);
  assert.strictEqual(compose.localRepo(['/no/such/dir', repo]), repo);
  assert.deepStrictEqual((await compose.codeHints(null, 'x')).reuse, [], 'no local checkout: no hints, no error');
  fs.rmSync(repo, { recursive: true, force: true });
}

// --- model choice: a keyed path beats `claude -p` ---------------------------------------------

{
  const { pickModel } = require('../src/dispatch/compose');
  const cfg = (composeModel, fallback = null, endpoint = 'https://example.invalid') => ({
    anthropic: { apiKey: '' },
    providers: { azure: { endpoint } },
    dispatch: { composeModel, composeFallbackModel: fallback },
  });
  const keys = (names) => (n) => (names.includes(n) ? 'k' : null);
  const bare = 'claude-sonnet-5-5';

  assert.strictEqual(pickModel({ c: cfg(bare), read: keys([]), hasAnthropicKey: true }), bare, 'Anthropic key: the API, as configured');
  assert.strictEqual(pickModel({ c: cfg(bare, 'azure/x'), read: keys(['AZURE_OPENAI_API_KEY']) }), 'azure/x', 'no Anthropic key: the keyed fallback');
  assert.strictEqual(pickModel({ c: cfg(bare, 'azure/x', ''), read: keys(['AZURE_OPENAI_API_KEY']) }), bare, 'azure without an endpoint cannot be called');
  assert.strictEqual(pickModel({ c: cfg(bare, 'openrouter/x'), read: keys([]) }), bare, 'fallback has no key: claude -p');
  assert.strictEqual(pickModel({ c: cfg(bare), read: keys(['AZURE_OPENAI_API_KEY']) }), bare, 'nothing configured: claude -p');
  assert.strictEqual(pickModel({ c: cfg(bare, 'cli/claude-sonnet-5-5'), read: keys([]) }), bare, 'a cli fallback is no gain');
  assert.strictEqual(pickModel({ c: cfg(bare, 'bogus/x'), read: keys([]) }), bare, 'a bad fallback string is ignored');
  assert.strictEqual(pickModel({ c: cfg('openai/gpt-x', 'azure/x'), read: keys(['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY']) }), 'openai/gpt-x', 'an explicit keyed model stays');
}

composeModule()
  .then(() => console.log('compose ok'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
