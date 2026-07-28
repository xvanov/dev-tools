'use strict';

// Restore-command tests. Plain node, no framework, no deps:
//   node test/restore.test.js
//
// This file exists because restore was broken for months in the one way nobody
// notices: the command was *plausible*. termhub injects `--session-id <uuid>` at
// launch and archives the mutated string, so restore built
//   claude --session-id X --dangerously-skip-permissions --resume X
// which every current Claude CLI rejects with "--session-id can only be used
// with --continue or --resume if --fork-session is also specified." The terminal
// opened, one line of usage error scrolled past, and the user got a bare shell.
//
// The invariant these tests protect: a restored claude command carries EXACTLY
// ONE conversation-identity flag.

const {
  restoreClaudeCommand, restoreOpencodeCommand, stripClaudeSessionFlags,
} = require('../lib/restore');

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const ID = 'abfd39c7-0e00-40a5-a116-ab03f5e116a4';
const ID2 = '4576ed98-e35d-4bb8-aeee-15738aa3e9aa';

// ---- 1. the shipped bug -----------------------------------------------------
// Both of these are verbatim from a real ~/.local/termhub/sessions.json. The
// first is what termhub archives after launching a session; the second is what a
// restore of a restore had already accumulated.

eq('archived launch command loses --session-id',
  restoreClaudeCommand(`claude --session-id ${ID} --dangerously-skip-permissions`, ID),
  `claude --resume ${ID} --dangerously-skip-permissions`);

eq('already-poisoned entry is repaired, not compounded',
  restoreClaudeCommand(`claude --session-id ${ID} --dangerously-skip-permissions --resume ${ID}`, ID),
  `claude --resume ${ID} --dangerously-skip-permissions`);

// The invariant itself, stated independently of exact flag order.
const IDENTITY_FLAG = /(^|\s)(--session-id|--resume|-r|--continue|-c|--fork-session)(\s|=|$)/g;
const SAMPLES = [
  ['claude', null],
  ['claude', ID],
  [`claude --session-id ${ID}`, ID],
  [`claude --session-id ${ID} --resume ${ID}`, ID],
  [`claude --resume ${ID2}`, ID],
  ['claude --continue', ID],
  ['claude -c', ID],
  [`claude -r ${ID2} --fork-session`, ID],
  ['claude --dangerously-skip-permissions', ID],
];
for (const [cmd, id] of SAMPLES) {
  const out = restoreClaudeCommand(cmd, id);
  const found = out.match(IDENTITY_FLAG) || [];
  check(`exactly one identity flag: ${cmd} (id=${id ? 'yes' : 'no'})`,
    found.length === 1, `got ${found.length} in ${JSON.stringify(out)}`);
}

// ---- 2. resuming the tracked conversation -----------------------------------
// A tracked id always wins over whatever the command said, because the id is the
// conversation termhub can actually find on disk (its transcript backs the model
// badge and the voice watcher).

eq('bare claude gets --resume <id>',
  restoreClaudeCommand('claude', ID),
  `claude --resume ${ID} --dangerously-skip-permissions`);

eq('a stale --resume id is replaced by the tracked one',
  restoreClaudeCommand(`claude --resume ${ID2}`, ID),
  `claude --resume ${ID} --dangerously-skip-permissions`);

eq('--continue is replaced by an exact resume',
  restoreClaudeCommand('claude --continue', ID),
  `claude --resume ${ID} --dangerously-skip-permissions`);

eq('--fork-session is dropped (forking would start a new, untracked id)',
  restoreClaudeCommand(`claude -r ${ID2} --fork-session`, ID),
  `claude --resume ${ID} --dangerously-skip-permissions`);

eq('=-form flag values are stripped too',
  restoreClaudeCommand(`claude --session-id=${ID}`, ID),
  `claude --resume ${ID} --dangerously-skip-permissions`);

// ---- 3. no tracked id: fall back to the picker -------------------------------

eq('no id -> bare --resume (cwd-scoped picker)',
  restoreClaudeCommand('claude', null),
  'claude --resume --dangerously-skip-permissions');

eq('no id -> an existing --continue is left alone',
  restoreClaudeCommand('claude --continue', null),
  'claude --continue --dangerously-skip-permissions');

eq('no command at all -> a usable default',
  restoreClaudeCommand(null, null),
  'claude --resume --dangerously-skip-permissions');

// ---- 4. flags land before a positional prompt --------------------------------
// A command can end in a prompt argument; appending --resume after it reads as
// part of the prompt to a human scanning the sidebar, so flags go after the exe.

eq('resume flag precedes a trailing prompt argument',
  restoreClaudeCommand(`claude --session-id ${ID} "fix the build"`, ID),
  `claude --resume ${ID} "fix the build" --dangerously-skip-permissions`);

eq('a path-qualified executable still matches',
  restoreClaudeCommand(`/home/k/.local/bin/claude --session-id ${ID}`, ID),
  `/home/k/.local/bin/claude --resume ${ID} --dangerously-skip-permissions`);

eq('claude.cmd (Windows) still matches',
  restoreClaudeCommand(`claude.cmd --session-id ${ID}`, ID),
  `claude.cmd --resume ${ID} --dangerously-skip-permissions`);

// ---- 5. things stripClaudeSessionFlags must NOT eat --------------------------
// -r/-c are single letters; they must not be clipped out of other flags, other
// commands' arguments, or a prompt.

eq('an unrelated -c belonging to another program survives',
  stripClaudeSessionFlags('claude --session-id ' + ID + ' && grep -c foo'),
  'claude && grep -c foo');
check('a --recursive-style long flag is not treated as -r',
  stripClaudeSessionFlags('claude --resume-nothing').includes('--resume-nothing'),
  stripClaudeSessionFlags('claude --resume-nothing'));
eq('a non-uuid token after --resume is left in place',
  stripClaudeSessionFlags('claude --resume latest'),
  'claude latest');

// ---- 6. opencode ------------------------------------------------------------

eq('opencode resumes a discovered session',
  restoreOpencodeCommand('opencode', 'ses_abc'),
  'opencode --session ses_abc');
eq('opencode without an id falls back to --continue',
  restoreOpencodeCommand('opencode', null),
  'opencode --continue');
eq('opencode does not double up an existing --session',
  restoreOpencodeCommand('opencode --session ses_old', 'ses_abc'),
  'opencode --session ses_old');

// ---- report -----------------------------------------------------------------

console.log(`\nrestore: ${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(1);
}
