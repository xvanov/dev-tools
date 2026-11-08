'use strict';

// An in-memory stand-in for src/db for tests that reach the database only incidentally (a brief
// gather, a board refresh): every query answers "no rows". Call install() BEFORE requiring any
// src module that destructures src/db at load. The real module refuses to connect a test process
// to anything but a pa_test_* database, so a test that forgets this fails loudly rather than
// touching the operator's data.
const path = require('path');

function install() {
  const file = require.resolve('../src/db');
  const empty = { rows: [], rowCount: 0 };
  const client = { query: async () => empty, release() {} };
  const fake = {
    assertSafeForTests() {},
    getPool: () => ({ query: async () => empty, connect: async () => client, end: async () => {} }),
    query: async () => empty,
    rows: async () => [],
    one: async () => null,
    withTx: async (fn) => fn(client),
    close: async () => {},
    probe: async () => ({ db: 'fake', has_vector: false }),
  };
  require.cache[file] = { id: file, filename: file, loaded: true, exports: fake, path: path.dirname(file), children: [], paths: [] };
  return fake;
}

module.exports = { install };
