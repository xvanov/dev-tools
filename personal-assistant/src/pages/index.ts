'use strict';

// Jarvis pages, the side that touches things: the page files, the cards they
// list, the exported HTML, and publishing that HTML as a claude.ai Artifact.
//
//   <dataDir>/pages/<slug>.json   the source of truth (src/pages/core.ts says what is in it)
//   <dataDir>/pages/<slug>.html   the export: one self-contained file, the same renderer
//
//   list() / read(slug) / resolved(slug)   the pages, raw or with their cards
//   importFile(file)                       validate a JSON file and store it under its slug
//   exportPage(slug, {out})                write the HTML; returns its path and hash
//   setDoing(slug, card, on)               mark what is being worked on
//   publish(slug)                          export, then publish through the claude CLI
//   pass()                                 the worker's `pages` pass: re-export what changed,
//                                          republish published pages (PA_PAGES_REPUBLISH)
//
// Publishing runs `claude -p` with the Artifact tool turned on
// (CLAUDE_CODE_ARTIFACT=1, as the PA chat does) and Read (which it needs to read the file) as the only tools, on the
// machine's Claude login (no API key, like the chat): it is the only way a page
// reaches claude.ai. The local file stays the source of truth; the Artifact is
// a copy for sharing, updated in place at the same URL.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** A page, a card or a resolved task: JSON read from a file or the database. */
type Row = import('../types.ts').Json;

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const core = require('./core.ts');
const { config, claudeBinary } = require('../config.ts');
const { logger } = require('../log.ts');

const log = logger('pages');
const CLIENT = path.join(__dirname, '..', 'dashboard', 'page.client.js');
const REPUBLISH_MIN_MS = 10 * 60 * 1000;
const PUBLISH_TIMEOUT_MS = 6 * 60 * 1000;

class PageError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Where pages live: PA_PAGES_DIR, else <dataDir>/pages. Never inside the repo. */
function dir(): string {
  return config.pages.dir;
}

function fileOf(slug: string, ext = 'json'): string {
  if (!core.SLUG.test(String(slug || ''))) throw new PageError(`not a page name: ${slug}`);
  return path.join(dir(), `${slug}.${ext}`);
}

function read(slug: string): Row {
  const f = fileOf(slug);
  if (!fs.existsSync(f)) throw new PageError(`no page "${slug}" (pa page list)`, 404);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/** Writes atomically (a temp file renamed over), so a reader never sees half a page. */
function write(page: Row): Row {
  const errs = core.validate(page);
  if (errs.length) throw new PageError(`page is not valid:\n  - ${errs.join('\n  - ')}`);
  fs.mkdirSync(dir(), { recursive: true });
  const f = fileOf(page.slug);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(page, null, 2) + '\n');
  fs.renameSync(tmp, f);
  return page;
}

function slugs(): string[] {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir()).filter((f: string) => f.endsWith('.json')).map((f: string) => f.slice(0, -5)).filter((s: string) => core.SLUG.test(s)).sort();
}

/** The cards a page names, and which of them have a live build run. */
async function cardsFor(page: Row): Promise<{ cards: Row[]; running: number[] }> {
  const repo = require('../repo');
  const ids = (page.tasks || []).map((t: Row) => Number(t.card)).filter((n: number) => Number.isInteger(n) && n > 0);
  if (!ids.length) return { cards: [], running: [] };
  const cards = await repo.commitments.forPage(ids);
  let running: number[] = [];
  if (typeof repo.buildRuns?.forCards === 'function') {
    try {
      const LIVE = ['starting', 'running', 'waiting', 'idle'];
      running = (await repo.buildRuns.forCards(ids)).filter((r: Row) => LIVE.includes(r.state)).map((r: Row) => Number(r.commitment_id));
    } catch {
      running = []; // a backend without build runs: "doing" comes from the page alone
    }
  }
  return { cards, running };
}

async function resolved(slug: string, page: Row = read(slug)): Promise<Row> {
  const { cards, running } = await cardsFor(page);
  return core.resolve(page, cards, { runningCards: running });
}

/** Every page with its progress, for the dashboard's list and `pa page list`. */
async function list(): Promise<Row[]> {
  const out: Row[] = [];
  for (const s of slugs()) {
    try {
      const r = await resolved(s);
      out.push({ slug: s, title: r.title, project: r.project, progress: r.progress, publishedUrl: r.publish.url, publishedAt: r.publish.publishedAt });
    } catch (e) {
      out.push({ slug: s, title: s, error: (e as Error).message });
    }
  }
  return out;
}

function importFile(file: string): Row {
  let page: Row;
  try {
    page = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new PageError(`cannot read ${file}: ${(e as Error).message}`);
  }
  // Keep what an earlier import learned about publishing, unless the file says otherwise.
  if (!page.publish && fs.existsSync(fileOf(String(page.slug || 'x')))) {
    try {
      page.publish = read(page.slug).publish;
    } catch {
      /* the old file is unreadable: start fresh */
    }
  }
  return write(page);
}

function clientJs(): string {
  return fs.readFileSync(CLIENT, 'utf8');
}

/** Writes the self-contained HTML. Returns {file, hash}. */
async function exportPage(slug: string, { out = null as string | null } = {}): Promise<Row> {
  const r = await resolved(slug);
  const file = out ? path.resolve(out) : fileOf(slug, 'html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, core.exportHtml(r, { clientJs: clientJs() }));
  return { file, hash: core.snapshotHash(r), progress: r.progress };
}

function setDoing(slug: string, card: number, on: boolean): Row {
  const page = read(slug);
  const t = (page.tasks || []).find((x: Row) => Number(x.card) === Number(card));
  if (!t) throw new PageError(`card #${card} is not on page "${slug}"`);
  t.doing = on;
  return write(page);
}

/** The prompt the headless claude gets: publish this file as-is, print the link. */
function publishPrompt(file: string, url: string | null, title: string): string {
  const base = path.basename(file);
  return [
    `Publish the existing local HTML file ./${base} as a claude.ai Artifact with the Artifact tool. It is finished: do not read, edit, rewrite or redesign it, and load no skill.`,
    url
      ? `It is already published at ${url}. Call Artifact with action "read" and url "${url}" first (required before an update), then Artifact publish with file_path "${base}" and url "${url}", so the same link updates in place. If a publish is refused because the page changed, publish this file again with the same url anyway: this file is the source of truth.`
      : `It has never been published. Call Artifact publish with file_path "${base}", icon "map", title "${title.replace(/"/g, "'")}".`,
    'When it is published, reply with exactly one line: the artifact URL (https://claude.ai/...). Nothing else.',
  ].join('\n');
}

/** Runs the claude CLI headless. Resolves {code, stdout, stderr}. */
function runClaude(args: string[], { cwd, timeoutMs = PUBLISH_TIMEOUT_MS }: { cwd: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = claudeBinary();
  const env: Row = { ...process.env, CLAUDE_CODE_ARTIFACT: '1' };
  delete env.ANTHROPIC_API_KEY; // the machine's Claude login: Artifacts belong to the account
  delete env.ANTHROPIC_AUTH_TOKEN;
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  return new Promise((resolve) => {
    const child = execFile(bin, args, { cwd, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell }, (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err ? err.message : '')) });
    });
    child.stdin?.end(); // no input: otherwise claude -p waits 3 s for stdin
  });
}

/** The argv for one headless publish. */
function publishArgs(prompt: string): string[] {
  // Read is there because the Artifact tool reads the file under Read's permission: without it
  // the publish is denied ("Read deny rule"). Nothing else is available to the session.
  return ['-p', prompt, '--output-format', 'text', '--tools', 'Artifact,Read', '--allowedTools', 'Artifact', 'Read', '--max-turns', '8'];
}

/**
 * Exports, then publishes the HTML through the claude CLI. Stores url,
 * publishedAt and the snapshot hash in the page. Throws (with the exported
 * path in the message) when the CLI does not hand back a link.
 */
async function publish(slug: string, { run = runClaude }: { run?: typeof runClaude } = {}): Promise<Row> {
  const page = read(slug);
  const exp = await exportPage(slug);
  const prompt = publishPrompt(exp.file, page.publish?.url || null, page.title);
  const r = await run(publishArgs(prompt), { cwd: path.dirname(exp.file) });
  const url = core.parsePublishUrl(r.stdout) || core.parsePublishUrl(r.stderr);
  if (!url) {
    const why = (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(-6).join('\n');
    throw new PageError(`published nothing: the claude CLI returned no artifact link (exit ${r.code}).\n${why}\nThe export is at ${exp.file}; publish it by hand with the Artifact tool.`, 502);
  }
  const fresh = read(slug); // the page may have changed while claude ran
  fresh.publish = { url, publishedAt: new Date().toISOString(), hash: exp.hash };
  write(fresh);
  return { url, file: exp.file, hash: exp.hash };
}

/**
 * The worker's `pages` pass: for each page whose snapshot changed since its
 * last export, write the HTML again; a published page whose snapshot differs
 * from its published one is republished, at most every 10 minutes, unless
 * PA_PAGES_REPUBLISH=off.
 */
async function pass({ now = Date.now(), republish = config.pages.republish, doPublish = publish }: { now?: number; republish?: boolean; doPublish?: typeof publish } = {}): Promise<Row> {
  const report: Row = { exported: [], published: [], failed: [] };
  for (const s of slugs()) {
    try {
      const page = read(s);
      const r = await resolved(s, page);
      const hash = core.snapshotHash(r);
      const html = fileOf(s, 'html');
      const stamp = fileOf(s, 'hash');
      const last = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '';
      if (hash !== last || !fs.existsSync(html)) {
        fs.writeFileSync(html, core.exportHtml(r, { clientJs: clientJs() }));
        fs.writeFileSync(stamp, hash + '\n');
        report.exported.push(s);
      }
      const pub = page.publish || {};
      const age = pub.publishedAt ? now - Date.parse(pub.publishedAt) : Infinity;
      if (republish && pub.url && pub.hash !== hash && age >= REPUBLISH_MIN_MS) {
        await doPublish(s);
        report.published.push(s);
      }
    } catch (e) {
      report.failed.push({ slug: s, error: (e as Error).message });
      log.warn('page sync failed', { slug: s, error: (e as Error).message });
    }
  }
  if (report.exported.length || report.published.length) log.info('pages synced', report);
  return report;
}

module.exports = { dir, read, write, slugs, list, resolved, importFile, exportPage, setDoing, publish, publishPrompt, publishArgs, pass, PageError, REPUBLISH_MIN_MS };
