'use strict';

// The argv grammar, pinned. The cases here are the ones where a plausible
// simpler parser does the wrong thing: a flag whose "value" is the next flag, a
// negated boolean, and the literal `--` that has to survive so `pa say` can
// type an option at an agent.

const assert = require('assert');
const { parseArgs, flagInt, flagBool } = require('../src/cli/parseArgs');

{
  const r = parseArgs(['brief']);
  assert.strictEqual(r.command, 'brief');
  assert.deepStrictEqual(r.args, []);
  assert.deepStrictEqual(r.flags, {});
}

{
  const r = parseArgs(['do', '42', '--mode', 'mr']);
  assert.strictEqual(r.command, 'do');
  assert.deepStrictEqual(r.args, ['42']);
  assert.strictEqual(r.flags.mode, 'mr');
}

{
  const r = parseArgs(['do', '42', '--mode=branch']);
  assert.strictEqual(r.flags.mode, 'branch');
}

{
  // A flag followed by another flag is a boolean. Reading '--verbose' as the
  // mode would dispatch a run in a mode nobody asked for.
  const r = parseArgs(['do', '42', '--mode', '--verbose']);
  assert.strictEqual(r.flags.mode, true);
  assert.strictEqual(r.flags.verbose, true);
}

{
  const r = parseArgs(['sync', '--no-distill']);
  assert.strictEqual(r.flags.distill, false);
}

{
  const r = parseArgs(['say', '7', '--', '--help']);
  assert.deepStrictEqual(r.args, ['7', '--help']);
  assert.strictEqual(r.flags.help, undefined);
}

{
  const r = parseArgs(['inbox', '-n', '5']);
  assert.strictEqual(flagInt(r.flags, 'n'), 5);
  assert.strictEqual(flagInt(r.flags, 'missing', 20), 20);
}

{
  const flags = parseArgs(['x', '--force', '--quiet', 'no']).flags;
  assert.strictEqual(flagBool(flags, 'force'), true);
  assert.strictEqual(flagBool(flags, 'quiet'), false);
  assert.strictEqual(flagBool(flags, 'absent', true), true);
}

{
  // A negative number must not be mistaken for a short flag's start.
  const r = parseArgs(['runs', '--since', '-7d']);
  assert.strictEqual(r.flags.since, true);
}

console.log('parseArgs.test.js ok');
