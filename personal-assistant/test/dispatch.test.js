'use strict';

// Modes and the brief. Both are pure, and both encode promises that are easy to
// break by accident later: that `local` cannot push, and that a guessed repo is
// visible to the session working in it.

const assert = require('assert');
const { mode, describe, isMode } = require('../src/dispatch/modes');
const { buildBrief } = require('../src/dispatch/brief');
const { slug } = require('../src/dispatch');

{
  assert.strictEqual(mode('local').mayCommit, true);
  assert.strictEqual(mode('local').mayPush, false);
  assert.strictEqual(mode('plan').mayCommit, false);
  assert.strictEqual(mode('mr').mayOpenMr, true);
  assert.strictEqual(mode('full').mayDraftReply, true);

  // Sending is not a mode, at any level. `full` drafts; a human sends.
  for (const name of Object.keys(require('../src/dispatch/modes').MODES)) {
    assert.ok(!('maySend' in mode(name)), `${name} must not have a send capability`);
  }
}

{
  assert.strictEqual(mode().name, 'local', 'the default must be the cautious one');
  assert.throws(() => mode('yolo'), /unknown mode/);
  assert.ok(isMode('branch') && !isMode('nope'));
  assert.match(describe('plan'), /read and plan only/);
}

{
  const run = { id: 12, task: 'fix the import', worktree_path: 'C:\\wt\\run-12', branch: 'pa/12-fix' };
  const text = buildBrief({
    commitment: {
      summary: 'Fix the estimating import before Thursday',
      detail: 'Rows with empty cost codes are dropped.',
      due_at: '2026-09-04T00:00:00Z',
      project_confidence: 0.3,
      project_rationale: 'alias "import"',
    },
    item: {
      source: 'graph_chat',
      subject: 'quick one',
      occurred_at: '2026-09-01T08:00:00Z',
      body_text: 'hey can you look at the estimating import, it eats rows with no cost code',
    },
    project: { name: 'estimating-api', gitlab_path: 'innergy/estimating-api' },
    person: { display_name: 'Sam Rivera', primary_email: 'sam@example.com' },
    modeName: 'local',
    run,
  });

  // The requester's own words must survive into the brief — paraphrase is where
  // meaning goes missing.
  assert.match(text, /it eats rows with no cost code/);
  assert.match(text, /Sam Rivera/);
  assert.match(text, /Teams chat/);

  // A low-confidence repo guess has to be visible to the session working in it.
  assert.match(text, /repo was \*\*guessed\*\* \(30%/);

  // A non-pushing mode must say so as a fact about the world, not a request.
  assert.match(text, /Pushing is blocked at the git level/);
  assert.match(text, /Do not push/);

  // Org conventions are pointed at, never inlined.
  assert.match(text, /innergy-knowledge/);
  assert.ok(!/Conventional Commits/.test(text), 'org rules must not be copied into the brief');
}

{
  const text = buildBrief({
    commitment: null,
    item: null,
    project: null,
    person: null,
    modeName: 'full',
    run: { id: 3, task: 'tidy the readme' },
  });
  assert.match(text, /REPLY\.md/);
  assert.match(text, /Do not send anything/);
  assert.ok(!/Pushing is blocked/.test(text), 'full mode may push');
}

{
  assert.strictEqual(slug('Fix the estimating import!'), 'fix-the-estimating-import');
  assert.strictEqual(slug(''), 'task');
  assert.ok(slug('x'.repeat(80)).length <= 40);
}

console.log('dispatch.test.js ok');
