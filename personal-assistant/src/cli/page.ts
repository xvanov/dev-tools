'use strict';

// `pa page` — Jarvis pages (src/pages): a plan with a map and a task list,
// kept in one JSON file, shown on the dashboard and exported or published as
// one HTML file. Kept in its own file so cli/index.js only has to wire it in.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

const { flagBool } = require('./parseArgs.ts');

const HELP = `
  Pages (a plan with a map and tasks; one JSON file is the source of truth)
    pa page list                       every page: progress, what is being worked on, where published
    pa page show <slug>                one page with its tasks, read live from their cards
    pa page import <file.json>         validate a page file and store it (PA_PAGES_DIR, default <data dir>/pages)
    pa page export <slug> [--out p]    write the self-contained HTML (default <pages dir>/<slug>.html)
    pa page doing <slug> <card> [--off]  mark (or unmark) the task being worked on
    pa page publish <slug>             export, then publish to claude.ai with the claude CLI (Artifact
                                       tool); later publishes update the same link
  The dashboard shows each page at /pages/<slug> and lists them on Plan. The worker's
  \`pages\` pass re-exports a page whose cards changed and republishes a published one at
  most every 10 minutes (PA_PAGES_REPUBLISH=off stops that).
`;

/** `pa page <verb> …` as a plain object, or {error}. Pure: test/pages.test.js. */
function parse(args: string[], flags: Json): Json {
  const [verb, a, b] = args;
  const need = (ok: boolean, usage: string) => (ok ? null : { error: `usage: pa page ${usage}` });
  switch (verb) {
    case undefined:
    case 'list':
      return { verb: 'list' };
    case 'show':
      return need(Boolean(a), 'show <slug>') || { verb, slug: a };
    case 'import':
      return need(Boolean(a), 'import <file.json>') || { verb, file: a };
    case 'export':
      return need(Boolean(a), 'export <slug> [--out path]') || { verb, slug: a, out: typeof flags.out === 'string' ? flags.out : null };
    case 'doing': {
      const card = Number(b);
      return need(Boolean(a) && Number.isInteger(card) && card > 0, 'doing <slug> <card> [--off]') || { verb, slug: a, card, on: !flagBool(flags, 'off') };
    }
    case 'publish':
      return need(Boolean(a), 'publish <slug>') || { verb, slug: a };
    default:
      return { error: `unknown verb "${verb}" — pa help page` };
  }
}

function make(out: (s: string) => void, fail: (s: string) => void) {
  const P = () => require('../pages/index.ts');

  function progressLine(p: Json) {
    const pr = p.progress || {};
    const doing = pr.doing && pr.doing.length ? `  working on: ${pr.doing.join(' · ')}` : '';
    return `${String(pr.percent ?? 0).padStart(3)}%  ${pr.done ?? 0}/${pr.total ?? 0}${doing}`;
  }

  async function page(args: string[], flags: Json) {
    const cmd = parse(args, flags);
    if (cmd.error) return fail(cmd.error);
    const pages = P();
    if (cmd.verb === 'list') {
      const all = await pages.list();
      if (!all.length) return out(`  no pages yet — pa page import <file.json>   (stored in ${pages.dir()})`);
      for (const p of all) {
        out(`  ${p.slug}  ${p.title}${p.error ? `  ERROR ${p.error}` : ''}`);
        if (!p.error) out(`      ${progressLine(p)}${p.publishedUrl ? `\n      published ${p.publishedUrl}` : ''}`);
      }
      return;
    }
    if (cmd.verb === 'show') {
      const r = await pages.resolved(cmd.slug);
      out(`  ${r.title}`);
      out(`  ${progressLine(r)}`);
      for (const g of r.groups) {
        out(`\n  ${g.name}  (${g.done}/${g.total}, ${g.percent}%)`);
        for (const t of g.tasks) out(`    [${t.state.padEnd(7)}] #${t.card} ${t.title}${t.blockedOn && (t.state === 'todo' || t.state === 'doing') ? `  — waiting on ${t.blockedOn}` : ''}`);
      }
      if (r.publish.url) out(`\n  published ${r.publish.url} (${r.publish.publishedAt})`);
      return;
    }
    if (cmd.verb === 'import') {
      const p = pages.importFile(cmd.file);
      return out(`  stored page "${p.slug}" (${(p.tasks || []).length} tasks) in ${pages.dir()} — open /pages/${p.slug} on the dashboard`);
    }
    if (cmd.verb === 'export') {
      const r = await pages.exportPage(cmd.slug, { out: cmd.out });
      return out(`  wrote ${r.file}  (${r.progress.percent}% done, snapshot ${r.hash})`);
    }
    if (cmd.verb === 'doing') {
      pages.setDoing(cmd.slug, cmd.card, cmd.on);
      return out(`  #${cmd.card} ${cmd.on ? 'is being worked on' : 'is no longer marked as worked on'}`);
    }
    if (cmd.verb === 'publish') {
      out('  publishing through the claude CLI (Artifact tool)…');
      const r = await pages.publish(cmd.slug);
      return out(`  published ${r.url}\n  from ${r.file}`);
    }
  }

  return { page, pages: page };
}

module.exports = { make, parse, HELP };
