'use strict';

// `POST /api/sessions/:id/input` — the plain-HTTP way to type at a session.
//
// The cases that earned their place: `submit` defaults to pressing return (the
// common case is "send this line"), `submit:false` stages text without sending
// it (so a model's words can wait for a human), a non-string body is rejected
// rather than coerced — `String(undefined)` types the literal word "undefined"
// at an agent, which is both wrong and very hard to notice afterwards — and an
// unknown session is a 404 rather than a silent success.

const assert = require('assert');
const { applyInput } = require('../lib/sessionInput');

function fakeSession() {
  const written = [];
  return { written, write: (d) => written.push(d) };
}

{
  const s = fakeSession();
  const res = applyInput(s, { data: 'hello' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(s.written, ['hello', '\r']);
  assert.strictEqual(res.payload.bytes, 5);
}

{
  // Staging without sending: the whole reason `submit` exists.
  const s = fakeSession();
  const res = applyInput(s, { data: 'draft this', submit: false });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(s.written, ['draft this']);
}

{
  const s = fakeSession();
  assert.strictEqual(applyInput(s, {}).status, 400);
  assert.strictEqual(applyInput(s, { data: 42 }).status, 400);
  assert.strictEqual(applyInput(s, { data: null }).status, 400);
  assert.strictEqual(applyInput(s, undefined).status, 400);
  assert.deepStrictEqual(s.written, [], 'a rejected body must write nothing');
}

{
  assert.strictEqual(applyInput(undefined, { data: 'x' }).status, 404);
}

{
  // An empty string is a legitimate request — pressing return on its own is how
  // you answer a prompt that is waiting for confirmation.
  const s = fakeSession();
  assert.strictEqual(applyInput(s, { data: '' }).status, 200);
  assert.deepStrictEqual(s.written, ['', '\r']);
}

{
  // Bytes, not characters: a caller sizing a buffer cares about the former.
  const s = fakeSession();
  assert.strictEqual(applyInput(s, { data: 'héllo' }).payload.bytes, 6);
}

console.log('input.test.js ok');
