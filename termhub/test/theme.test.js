'use strict';

// web/theme.css and web/nav.js are copies of the Jarvis design system, whose
// canonical files live with the personal assistant
// (../personal-assistant/src/dashboard/). termhub keeps its own copies so it
// looks and works the same on a machine without the PA. This test fails when a
// copy drifts; `npm run sync-theme` (this file with --write) copies them over.
// Skipped when the PA directory is not there (termhub on its own).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CANON = path.join(__dirname, '..', '..', 'personal-assistant', 'src', 'dashboard');
const HERE = path.join(__dirname, '..', 'web');
const FILES = ['theme.css', 'nav.js'];
// Compare text, not bytes: a Windows checkout may hand one file CRLF and not the other.
const norm = (s) => s.replace(/\r\n/g, '\n');

if (!fs.existsSync(CANON)) {
  console.log('theme: skipped (no ../personal-assistant)');
  process.exit(0);
}

if (process.argv.includes('--write')) {
  for (const f of FILES) {
    fs.copyFileSync(path.join(CANON, f), path.join(HERE, f));
    console.log(`theme: copied ${f}`);
  }
  process.exit(0);
}

for (const f of FILES) {
  const canon = norm(fs.readFileSync(path.join(CANON, f), 'utf8'));
  const copy = norm(fs.readFileSync(path.join(HERE, f), 'utf8'));
  assert.ok(canon === copy, `web/${f} differs from personal-assistant/src/dashboard/${f} — run \`npm run sync-theme\` in termhub`);
}

// The pages load both, before their own styles, and the terminal takes its
// colours from the tokens rather than a second palette.
for (const page of ['index.html', 'dashboard.html']) {
  const html = fs.readFileSync(path.join(HERE, page), 'utf8');
  const theme = html.indexOf('/theme.css');
  assert.ok(theme > 0 && theme < html.indexOf('/styles.css'), `${page}: theme.css before styles.css`);
  assert.match(html, /<script src="\/nav\.js" data-layer="termhub"><\/script>/, `${page}: loads nav.js as termhub`);
  assert.match(html, /data-jnav/, `${page}: has a switcher slot`);
}
const app = fs.readFileSync(path.join(HERE, 'app.js'), 'utf8');
assert.match(app, /--term-bg/, 'xterm reads --term-bg');
assert.match(app, /classList\.add\('focus'\)/, 'app.js has the ?focus= view');

console.log('theme ok');
