'use strict';

// The README's pointer under its first heading to the Build section of AGENT.md
// (D30). The link must name a real heading in AGENT.md, so a rename there breaks
// this test rather than leaving a dead link.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split(/\r?\n/);
const agent = fs.readFileSync(path.join(root, 'AGENT.md'), 'utf8');

// GitHub heading slug: lowercase, drop punctuation except hyphens, spaces to hyphens.
const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').trim().replace(/ /g, '-');

const firstHeading = readme.findIndex((l) => /^# /.test(l));
assert.strictEqual(firstHeading, 0, 'README starts with its first heading');

// The line after the heading is blank; the pointer sits on the line after that.
assert.strictEqual(readme[1], '', 'blank line under the first heading');
const pointer = readme[2];
assert.ok(pointer.length > 0 && pointer.length < 400, 'pointer is one non-empty line');
assert.ok(!/\n/.test(pointer));

const link = pointer.match(/\]\(\.\/AGENT\.md#([^)]+)\)/);
assert.ok(link, 'pointer links to ./AGENT.md#<anchor>');

const target = 'Build: one Claude Code agent per task (D30)';
assert.ok(pointer.includes(target), 'pointer names the Build section');

const headings = agent.split(/\r?\n/).filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/^#+ /, ''));
assert.ok(headings.includes(target), 'AGENT.md has the Build heading');
assert.strictEqual(link[1], slug(target), 'anchor matches the AGENT.md heading slug');

console.log('readme.test.js: ok');
