'use strict';

// e2e cards stay out of a blocker's verdict (src/commitments/e2eMarker.ts).

const assert = require('assert');
const M = require('../src/commitments/e2eMarker.ts');

const MARK = 'e2e-12345678-1234-1234-1234-123456789abc';
const dummy = `Add a pa version verb that prints the served commit (${MARK})`;
const title = `e2e: pa version verb (${MARK})`;
const ask = `In personal-assistant, add a pa version CLI verb. (Automated golden-path run ${MARK}.)`;

assert.strictEqual(M.carriesMarker(dummy, 'ordinary work'), true);
assert.strictEqual(M.carriesMarker('Ship the sync', 'e2e-teams-12345678-1234-1234-1234-123456789abc'), false);
assert.ok(M.phrases(dummy).includes('pa version verb'));
assert.ok(M.phrases(title).includes('pa version verb'));

const ids = new Set(['42']);
const texts = [dummy, title, ask];
const why = 'Needs the ArgoCD sync to deploy the target service before adding the pa version verb.';
assert.strictEqual(M.verdictCites({ blocker_id: '7', task_id: null, why }, ids, texts), true, 'the why names the dummy task');
assert.strictEqual(M.verdictCites({ blocker_id: '7', task_id: '42', why: 'needs the dummy task' }, ids, texts), true, 'the task is the e2e card');
assert.strictEqual(M.verdictCites({ blocker_id: '42', task_id: null, why: 'stands alone' }, ids, texts), true, 'the blocker is the e2e card');
assert.strictEqual(M.verdictCites({ blocker_id: '7', task_id: '9', why: `needs it (${MARK})` }, ids, texts), true, 'the why carries the marker');
assert.strictEqual(M.verdictCites({ blocker_id: '7', task_id: '9', why: 'Needs the field list to build the sync' }, ids, texts), false);

console.log('e2eMarker: ok');
