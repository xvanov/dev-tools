'use strict';

// Contract: src/repo/system.js (see test/repoContract.test.js).

module.exports = {
  'installedExtensions: the ones present, of those asked': async ({ repos, assert }) => {
    const got = await repos.system.installedExtensions(['vector', 'pg_trgm', 'no_such_extension']);
    assert.deepStrictEqual(got.sort(), ['pg_trgm', 'vector']);
  },

  'serverMajor: a whole major version': async ({ repos, assert }) => {
    const v = await repos.system.serverMajor();
    assert.ok(Number.isInteger(v) && v >= 13, String(v));
  },
};
