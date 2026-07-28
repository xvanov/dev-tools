'use strict';

// Claude CLI version-pin tests. Plain node, no framework, no deps:
//   node test/claudeCli.test.js
//
// The comparison is the part worth testing: it decides whether the UI nags the
// user to update, and both failure directions are bad — a false "too old" trains
// them to ignore the warning, a false "fine" hides the exact mismatch that broke
// session restore in the first place (see lib/claudeCli.js).

const claudeCli = require('../lib/claudeCli');

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- 1. parsing `claude --version` ------------------------------------------

eq('real output', claudeCli.parseVersion('2.1.220 (Claude Code)'), '2.1.220');
eq('version only', claudeCli.parseVersion('2.1.220'), '2.1.220');
eq('with a pre-release suffix', claudeCli.parseVersion('2.2.0-beta.3 (Claude Code)'), '2.2.0-beta.3');
eq('no version in output', claudeCli.parseVersion('command not found'), null);
eq('empty output', claudeCli.parseVersion(''), null);

// ---- 2. ordering ------------------------------------------------------------
// The trap this table exists for: segments are NUMBERS, not text. A string
// compare puts "2.1.220" before "2.1.3", which would declare a current CLI too
// old and send the user off to run an update they don't need.

const ORDER = [
  ['2.1.220', '2.1.3', 1],
  ['2.1.3', '2.1.220', -1],
  ['2.1.220', '2.1.220', 0],
  ['2.2.0', '2.1.999', 1],
  ['3.0.0', '2.9.9', 1],
  ['2.1', '2.1.220', -1],       // missing segment reads as 0
  ['2.1.220', '2.1', 1],
  ['2.1.220-beta.1', '2.1.220', 0], // suffix ignored: same numeric version
  ['garbage', '2.1.220', -1],   // unparsable reads as 0.0.0 rather than throwing
];
for (const [a, b, want] of ORDER) {
  eq(`compare ${a} vs ${b}`, claudeCli.compareVersions(a, b), want);
}

// ---- 3. the pin itself ------------------------------------------------------
// package.json is the pin's home; a typo there (or a dropped block) would
// silently disable the check, since an absent floor means "anything goes".

check('a minimum version is pinned', !!claudeCli.MIN_VERSION, String(claudeCli.MIN_VERSION));
check('the pin parses as a version',
  claudeCli.parseVersion(claudeCli.MIN_VERSION || '') === claudeCli.MIN_VERSION,
  String(claudeCli.MIN_VERSION));
check('the verified version is at least the floor',
  claudeCli.compareVersions(claudeCli.VERIFIED_VERSION, claudeCli.MIN_VERSION) >= 0,
  `${claudeCli.VERIFIED_VERSION} vs ${claudeCli.MIN_VERSION}`);

// ---- 4. status() shape ------------------------------------------------------
// Runs against whatever CLI is on this machine, so it asserts the contract the
// UI depends on, not a specific version. `satisfied` must stay true when the CLI
// can't be found: termhub reports that as `error`, and must not nag about a
// version it never read.

(async () => {
  const s = await claudeCli.status({ force: true });
  check('status reports the pin', s.minVersion === claudeCli.MIN_VERSION, JSON.stringify(s));
  check('status carries an update command', typeof s.updateCommand === 'string' && s.updateCommand.length > 0);
  check('installed is a version or null', s.installed === null || !!claudeCli.parseVersion(s.installed), String(s.installed));
  check('a missing CLI is an error, not a nag', !!s.installed || s.satisfied === true, JSON.stringify(s));
  check('describe() produces one line', /\S/.test(claudeCli.describe(s)) && !claudeCli.describe(s).includes('\n'),
    claudeCli.describe(s));
  console.log(`  (this machine: ${claudeCli.describe(s)}${s.error ? ` [${s.error}]` : ''})`);

  console.log(`\nclaudeCli: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  FAIL ' + f);
    process.exit(1);
  }
})();
