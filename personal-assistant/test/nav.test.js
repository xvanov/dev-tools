'use strict';

// nav.js (the shared navigation and shell) in a stub browser: which links it
// turns into a switch between destinations, and which it must leave alone.
// The regression: Plan's views (#today, #memory, …) are links into the page
// itself, and nav.js once swallowed them as "go to Plan", so they did nothing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../src/dashboard/nav.js'), 'utf8');

function load(href, layer) {
  const noop = () => {};
  const el = () => ({
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, toggleAttribute: noop,
    appendChild: noop, insertBefore: noop, addEventListener: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], style: {},
  });
  const root = el();
  const document = {
    documentElement: root,
    currentScript: { getAttribute: (k) => (k === 'data-layer' ? layer : null) },
    readyState: 'loading', // mount() waits for DOMContentLoaded, which never comes here
    addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: el,
    title: '',
  };
  const window = {
    document, location: new URL(href), localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop }), addEventListener: noop,
    history: { pushState: noop }, fetch: () => new Promise(noop), URL, URLSearchParams, setTimeout: noop, setInterval: noop, CustomEvent: function () {},
  };
  window.top = window;
  window.window = window;
  vm.runInNewContext(SRC, Object.assign(window, { window }));
  return window.JarvisNav;
}

// Plan, served by the PA directly.
{
  const nav = load('http://127.0.0.1:7300/', 'dashboard');
  for (const v of ['#today', '#meetings', '#memory', '#memory/person/12', '#chat', '#routines', '#repos', '#brief-3']) {
    assert.strictEqual(nav.linkTarget(v), null, `Plan's own link ${v} is left to the page`);
  }
  assert.strictEqual(nav.linkTarget('./'), null, 'a link to Plan itself is not a switch');
  assert.strictEqual(nav.linkTarget('factory'), 'factory', 'Build');
  assert.strictEqual(nav.linkTarget('talk'), 'talk', 'Ask');
  assert.strictEqual(nav.linkTarget('architecture'), 'architecture', 'Map');
  assert.strictEqual(nav.linkTarget('http://127.0.0.1:7000/'), 'sessions', 'Run, on termhub');
  assert.strictEqual(nav.linkTarget('http://127.0.0.1:7000/dashboard'), 'agenttime', 'Meter, on termhub');
  assert.strictEqual(nav.linkTarget('http://127.0.0.1:7000/?focus=abc'), null, 'a focus link opens a page of its own');
  assert.strictEqual(nav.linkTarget('https://example.com/'), null, 'the outside world is not a destination');
}

// Plan under termhub's /pa/ proxy, and termhub's own pages.
{
  const nav = load('https://box.example.ts.net:7000/pa/#memory', 'dashboard');
  assert.strictEqual(nav.linkTarget('#routines'), null, 'proxied Plan keeps its views');
  assert.strictEqual(nav.linkTarget('/'), 'sessions', 'Run is termhub\'s root');
  assert.strictEqual(nav.linkTarget('/pa/factory'), 'factory');
}
{
  const nav = load('http://127.0.0.1:7000/', 'termhub');
  assert.strictEqual(nav.linkTarget('#session=abc'), null, 'Run keeps its own hash links');
  assert.strictEqual(nav.linkTarget('/dashboard'), 'agenttime', 'the agent-time bar switches to Meter');
  assert.strictEqual(nav.linkTarget('/pa/'), 'dashboard');
}

// One place for the names.
{
  const nav = load('http://127.0.0.1:7300/', 'dashboard');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(nav.destinations.map((d) => d.id))), ['talk', 'dashboard', 'factory', 'sessions', 'agenttime', 'architecture']);
  assert.ok(nav.destinations.every((d) => d.label), 'every destination has a label');
}

console.log('nav ok');
