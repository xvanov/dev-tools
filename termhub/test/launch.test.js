'use strict';

// lib/launch.ts, lib/dotenv.ts and the ptyHost parts the deploy switches use:
// TERMHUB_FRONT=jarvisd|node and TERMHUB_PTYD=1|0 as one line in termhub/.env.
//
// The properties that matter: a jarvisd front without its pinned Bun falls back
// to node (a missing Bun must never leave a stack without a front); a value a
// running sessiond exported into its terminals is not mistaken for a choice
// (the update scripts run in those terminals); and installing a ptyd build never
// writes over the copy a running ptyd uses.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('../lib/dotenv.ts');
const launch = require('../lib/launch.ts');
const ptyHost = require('../lib/ptyHost.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-launch-'));

// .env parsing: comments, export, quotes, trailing comments.
assert.deepStrictEqual(
  dotenv.parse('# c\nTERMHUB_FRONT=jarvisd\r\nexport TERMHUB_PTYD="1"\nX = a b # note\nY=\'q # kept\'\nbad line\n'),
  { TERMHUB_FRONT: 'jarvisd', TERMHUB_PTYD: '1', X: 'a b', Y: 'q # kept' },
);

// The first file that sets a name wins; an empty value does not count.
const termhubEnv = path.join(tmp, 'termhub.env');
const repoEnv = path.join(tmp, 'repo.env');
fs.writeFileSync(termhubEnv, 'TERMHUB_FRONT=\nTERMHUB_PTYD=0\n');
fs.writeFileSync(repoEnv, 'TERMHUB_FRONT=jarvisd\nTERMHUB_PTYD=1\n');
const files = [termhubEnv, repoEnv];
assert.deepStrictEqual(dotenv.lookup('TERMHUB_PTYD', files), { value: '0', file: termhubEnv });
assert.deepStrictEqual(dotenv.lookup('TERMHUB_FRONT', files), { value: 'jarvisd', file: repoEnv });
assert.strictEqual(dotenv.lookup('NOPE', files), undefined);
assert.strictEqual(dotenv.lookup('X', [path.join(tmp, 'missing.env')]), undefined);

// TERMHUB_PTYD: the environment wins over the files...
assert.strictEqual(ptyHost.chosen({ TERMHUB_PTYD: '1' }, files).value, '1');
assert.strictEqual(ptyHost.chosen({ TERMHUB_PTYD: '1' }, files).source, 'the environment');
assert.strictEqual(ptyHost.chosen({}, files).value, '0');
// ...unless a sessiond exported it (its terminals inherit it), marked or from a terminal.
assert.strictEqual(ptyHost.chosen({ TERMHUB_PTYD: '1', TERMHUB_PTYD_RESOLVED: '1' }, files).value, '0');
assert.strictEqual(ptyHost.chosen({ TERMHUB_PTYD: '1', TERMHUB_SESSION_ID: 'abc' }, files).value, '0');
assert.strictEqual(ptyHost.chosen({ TERMHUB_PTYD: '1', TERMHUB_PTYD_RESOLVED: '1' }, []).value, undefined);
assert.match(ptyHost.resolve({ envValue: '1', source: 'termhub/.env', mode: 'node-pty' }).reason, /TERMHUB_PTYD=1 in termhub\/\.env/);
assert.strictEqual(ptyHost.resolve({ envValue: '0', source: 'termhub/.env', mode: 'ptyd' }).ptyd, false, 'an explicit 0 beats the setting');

// The pinned Bun: jarvisd/.bun/<pin> first, node_modules only at the pinned version.
const jd = path.join(tmp, 'jarvisd');
fs.mkdirSync(jd);
fs.writeFileSync(path.join(jd, 'package.json'), JSON.stringify({ devDependencies: { bun: '1.4.4' } }));
const own = path.join(jd, '.bun', '1.4.4', 'node_modules', 'bun', 'bin', 'bun.exe');
const npm = path.join(jd, 'node_modules', 'bun', 'bin', 'bun.exe');
const has = (...ps) => (p) => ps.includes(p);
assert.strictEqual(launch.pinnedBun(jd, has(own, npm), () => '1.4.4').exe, own);
assert.strictEqual(launch.pinnedBun(jd, has(npm), () => '1.4.4').exe, npm);
const old = launch.pinnedBun(jd, has(npm), () => '1.3.13');
assert.strictEqual(old.exe, null, 'another Bun version is not the pinned one');
assert.match(old.problem, /has Bun 1\.3\.13, 1\.4\.4 is pinned/);
assert.match(launch.pinnedBun(jd, has()).problem, /Bun 1\.4\.4 is not installed/);

// The front plan.
const bun = launch.pinnedBun(jd, has(own));
const noBun = launch.pinnedBun(jd, has());
const plan = (env, b = bun) => launch.frontPlan(env, { files: [], bun: b });
assert.strictEqual(plan({}).runtime, 'node', 'unset means node front.js');
assert.strictEqual(plan({}).exe, null);
assert.strictEqual(plan({ TERMHUB_FRONT: 'node' }).runtime, 'node');
const j = plan({ TERMHUB_FRONT: 'jarvisd' });
assert.deepStrictEqual([j.runtime, j.exe, j.args], ['jarvisd', own, [launch.MAIN, 'front']]);
assert.strictEqual(path.basename(launch.MAIN), 'main.ts');
assert.ok(fs.existsSync(launch.MAIN), 'launch.MAIN names jarvisd/src/main.ts');
const fb = plan({ TERMHUB_FRONT: 'jarvisd' }, noBun);
assert.deepStrictEqual([fb.runtime, fb.fallback], ['node', true], 'no Bun: node, and says so');
assert.match(fb.reason, /not installed.*node front\.js instead/);
assert.deepStrictEqual([plan({ TERMHUB_FRONT: 'deno' }).runtime, plan({ TERMHUB_FRONT: 'deno' }).fallback], ['node', true]);
// From the file when the environment is silent.
assert.strictEqual(launch.frontPlan({}, { files: [repoEnv], bun }).runtime, 'jarvisd');

// Installing a ptyd build: a copy named by content, ptyd-current pointing at it.
const data = path.join(tmp, 'data');
const build = path.join(tmp, 'ptyd-build');
fs.writeFileSync(build, 'one');
const a = ptyHost.install(data, { build });
assert.ok(a.changed && fs.existsSync(a.bin), 'first install copies the build');
assert.strictEqual(ptyHost.installedBinary(data), a.bin);
assert.strictEqual(ptyHost.install(data, { build }).changed, false, 'same build: nothing to do');
assert.strictEqual(ptyHost.releaseBinary({}, fs.existsSync, data), a.bin, 'the installed copy is what ptyd runs');
fs.writeFileSync(build, 'two');
assert.strictEqual(ptyHost.install(data, { build, dryRun: true }).changed, true);
assert.strictEqual(ptyHost.installedBinary(data), a.bin, 'a dry run changes nothing');
const b = ptyHost.install(data, { build });
assert.notStrictEqual(b.bin, a.bin);
assert.strictEqual(fs.readFileSync(a.bin, 'utf8'), 'one', 'the previous copy (a running ptyd may use it) is untouched');
fs.writeFileSync(build, 'three');
const c = ptyHost.install(data, { build });
assert.deepStrictEqual([fs.existsSync(c.bin), fs.existsSync(b.bin), fs.existsSync(a.bin)], [true, true, false], 'the current and the previous stay');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('launch ok');
