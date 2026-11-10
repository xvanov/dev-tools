'use strict';

// A card must not name its asker as a bare address (teams-ask `person`, 2026-11-10).
const assert = require('assert');
const id = require('../src/distill/identity.ts');

assert.strictEqual(id.nameFromEmail('ada.lovelace@innergy.com'), 'Ada Lovelace');
assert.strictEqual(id.nameFromEmail('zed_quux@x.io'), 'Zed Quux');
assert.strictEqual(id.nameFromEmail('handleonly@x.io'), null);
assert.strictEqual(id.nameFromEmail('support@x.io'), null);
const smtp = (v) => ({ kind: 'smtp', value: v });
assert.strictEqual(id.nameFor(smtp('ada.lovelace@innergy.com'), 'ada.lovelace@innergy.com'), 'Ada Lovelace');
assert.strictEqual(id.nameFor(smtp('ada.lovelace@innergy.com'), 'Ada'), 'Ada Lovelace', 'one word is not a name');
assert.strictEqual(id.nameFor(smtp('ada.lovelace@innergy.com'), 'Ada Byron'), 'Ada Byron');
assert.strictEqual(id.nameFor(smtp('ops@x.io'), null), 'ops@x.io');
console.log('identityName.test.js ok');
