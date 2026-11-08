'use strict';

// Short messages addressed to you (src/distill/short.ts, plan 8.4.36).

const assert = require('assert');
const short = require('../src/distill/short.ts');
const eval_ = require('../src/eval/short-asks-cases.json');

const names = [eval_.owner];
const wrong = eval_.cases.filter((c) => (short.courtesy(c.text, names) ? 'skip' : 'distill') !== c.expect);
assert.deepStrictEqual(wrong.map((c) => `${c.expect}: ${c.text}`), [], 'every eval case is read as expected');
for (const c of eval_.cases) assert.ok([...c.text].length < 40, `an eval case is under the old minimum: ${c.text}`);
assert.ok(eval_.cases.filter((c) => c.expect === 'skip').length >= 10);
assert.ok(eval_.cases.filter((c) => c.expect === 'distill').length >= 10);

assert.strictEqual(short.skip({ body_text: 'thank you!' }, names, 40), 'a short courtesy, not an ask');
assert.strictEqual(short.skip({ body_text: 'can you check?' }, names, 40), null);
const long = 'thank you so much, thank you so much, thank you!';
assert.strictEqual(short.skip({ body_text: long }, names, 40), null, 'a body at the usual minimum is always the model\'s');

assert.strictEqual(short.courtesy('Alex ^', []), false, 'a name is only dropped when it is yours');
assert.strictEqual(short.courtesy('Alex ^', ['Alex Doe']), true);

const now = Date.parse('2026-11-08T12:00:00Z');
assert.deepStrictEqual(short.direct(now), { minChars: short.DIRECT_MIN_CHARS, since: '2026-11-01T12:00:00.000Z' });
assert.ok(short.DIRECT_MIN_CHARS >= 4 && short.DIRECT_MIN_CHARS < 40);

console.log('distillShort.test.js ok');
