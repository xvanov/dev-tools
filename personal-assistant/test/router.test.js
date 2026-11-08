'use strict';

// The dashboard's typed router (src/dashboard/router.ts): first match wins,
// `false` passes the request on, RegExp groups reach the handler, and the JSON
// body is read once however many routes ask for it.

const assert = require('assert');
const { dispatch, matchPath } = require('../src/dashboard/router.ts');

const req = (method, url) => ({ method, url, headers: {} });

(async () => {
  const seen = [];
  let reads = 0;
  const base = (method, path) => ({
    req: req(method, path),
    res: {},
    url: new URL(path, 'http://localhost'),
    send: () => {},
    readJson: async () => {
      reads++;
      return { a: 1 };
    },
    issuePageToken: () => 't',
    pageTokenOk: () => true,
  });
  const routes = [
    { path: () => true, handle: () => (seen.push('guard'), false) },
    { method: 'GET', path: '/x', handle: () => seen.push('get x') },
    { method: 'POST', path: /^\/items\/(\d+)$/, handle: async (c) => seen.push(`item ${c.m[1]} ${(await c.body()).a} ${(await c.body()).a}`) },
    { path: '/x', handle: () => seen.push('any x') },
  ];

  assert.strictEqual(await dispatch(routes, base('GET', '/x')), true);
  assert.deepStrictEqual(seen.splice(0), ['guard', 'get x'], 'first matching route answers; a false one passes on');

  assert.strictEqual(await dispatch(routes, base('POST', '/x')), true);
  assert.deepStrictEqual(seen.splice(0), ['guard', 'any x'], 'the method filters');

  assert.strictEqual(await dispatch(routes, base('POST', '/items/42')), true);
  assert.deepStrictEqual(seen.splice(0), ['guard', 'item 42 1 1'], 'groups reach the handler');
  assert.strictEqual(reads, 1, 'the body is read once');

  assert.strictEqual(await dispatch(routes, base('GET', '/nothing')), false, 'no route: false (the server answers 404)');

  assert.strictEqual(matchPath('/a', new URL('http://h/a?q=1'), req('GET', '/a')), true, 'exact paths ignore the query');
  assert.strictEqual(matchPath('/a', new URL('http://h/a/b'), req('GET', '/a/b')), null);
  console.log('router ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
