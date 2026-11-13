'use strict';

// Jarvis pages, the pure half: one JSON file per page is the source of truth,
// and everything else — the dashboard's /pages/<slug>, the exported HTML file
// and the claude.ai Artifact made from it — is rendered from it by the same
// client (src/dashboard/page.client.js). Nothing here touches disk, the
// database or the network; src/pages/index.ts does.
//
//   validate(page)                    every problem at once, [] when it is fine
//   resolve(page, cards, opts)        the page with each task's title/status from its card,
//                                     its links (the page's and every URL in the card's own text),
//                                     overall and per-group progress, and what is being worked on
//   taskStatus(state, task)           done | doing | blocked | next | todo | dropped | missing
//   cardLinks(card) / linkLabel(url)  the http(s) URLs in a card's title and details, labelled
//   snapshotHash(resolved)            what changed, ignoring when it was resolved
//   exportHtml(resolved, parts)       one self-contained HTML file (no external script or font),
//                                     the renderer inlined without its comments (stripComments)
//   parsePublishUrl(text)             the claude.ai artifact link in the CLI's answer
//
// A task's card comes from the board: open/dispatched counts as to do, done as
// done, dropped leaves the total (it is shown, struck through). An open card
// folded into another (superseded_by) follows that card. A card that does not
// exist is shown as "card #N not found" and does not count either way.
//
// What a task SHOWS is its status: done and dropped come from the card; an open
// card is doing (a live build run or `doing: true`), else blocked (`blockedOn`),
// else next (`next: true`), else to do. Inside a group the rows sort by that
// status (doing, next, blocked, to do, done, dropped), author order within one.
// Its links are the page's `links` for it, then every URL in the card's title
// and details (a `pa card edit --note` lands there), so noting a PR on a card
// puts it on the page at the next export with no page edit.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** A page, a card or a resolved task: JSON read from a file or the database. */
type Row = import('../types.ts').Json;

const crypto = require('crypto');

const VERSION = 1;
const KINDS = ['service', 'job', 'data', 'external', 'identity', 'person'];
const NODE_STATUSES = ['live', 'planned', 'retiring', 'blocked'];
const EDGE_STYLES = ['solid', 'dashed'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown) => typeof v === 'string';
const httpUrl = (v: unknown) => isStr(v) && /^https?:\/\/[^\s]+$/.test(v as string);

/** Every problem with a page, as readable lines; [] when it is valid. */
function validate(page: unknown): string[] {
  const errs: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };
  if (!isObj(page)) return ['the page is not a JSON object'];
  need(page.version === VERSION, `version must be ${VERSION}`);
  need(isStr(page.slug) && SLUG.test(page.slug), 'slug: lower-case letters, digits and dashes, at most 64');
  need(isStr(page.title) && page.title.trim().length > 0 && page.title.length <= 200, 'title: required, at most 200 characters');
  if (page.summary != null) need(isStr(page.summary), 'summary: a string');
  if (page.project != null) need(isStr(page.project), 'project: a string');
  if (page.links != null) {
    need(Array.isArray(page.links), 'links: a list');
    for (const [i, l] of (Array.isArray(page.links) ? page.links : []).entries()) {
      need(isObj(l) && isStr(l.label) && httpUrl(l.url), `links[${i}]: {label, url} with an http(s) url`);
    }
  }

  const nodeIds = new Set<string>();
  const flowIds = new Set<string>();
  const map = page.map;
  if (map != null) {
    if (!isObj(map)) errs.push('map: an object');
    else {
      const layers = Array.isArray(map.layers) ? map.layers : [];
      need(Array.isArray(map.layers), 'map.layers: a list');
      const layerIds = new Set<string>();
      for (const [i, l] of layers.entries()) {
        need(isObj(l) && isStr(l.id) && ID.test(l.id) && isStr(l.label), `map.layers[${i}]: {id, label}`);
        if (isObj(l) && isStr(l.id)) {
          need(!layerIds.has(l.id), `map.layers: duplicate id ${l.id}`);
          layerIds.add(l.id);
        }
      }
      for (const [i, f] of (Array.isArray(map.flows) ? map.flows : []).entries()) {
        need(isObj(f) && isStr(f.id) && ID.test(f.id) && isStr(f.label), `map.flows[${i}]: {id, label}`);
        if (isObj(f) && f.color != null) need(isStr(f.color) && COLOR.test(f.color), `map.flows[${i}].color: #rrggbb`);
        if (isObj(f) && isStr(f.id)) {
          need(!flowIds.has(f.id), `map.flows: duplicate id ${f.id}`);
          flowIds.add(f.id);
        }
      }
      need(Array.isArray(map.nodes), 'map.nodes: a list');
      for (const [i, n] of (Array.isArray(map.nodes) ? map.nodes : []).entries()) {
        if (!isObj(n) || !isStr(n.id) || !ID.test(n.id) || !isStr(n.label)) {
          errs.push(`map.nodes[${i}]: {id, label, layer}`);
          continue;
        }
        need(!nodeIds.has(n.id), `map.nodes: duplicate id ${n.id}`);
        nodeIds.add(n.id);
        need(layerIds.has(n.layer), `map.nodes[${i}] (${n.id}): unknown layer ${n.layer}`);
        if (n.kind != null) need(KINDS.includes(n.kind), `map.nodes[${i}] (${n.id}): kind is one of ${KINDS.join(', ')}`);
        if (n.status != null) need(NODE_STATUSES.includes(n.status), `map.nodes[${i}] (${n.id}): status is one of ${NODE_STATUSES.join(', ')}`);
        if (n.detail != null) need(isStr(n.detail), `map.nodes[${i}] (${n.id}): detail is a string`);
      }
      for (const [i, e] of (Array.isArray(map.edges) ? map.edges : []).entries()) {
        if (!isObj(e)) {
          errs.push(`map.edges[${i}]: an object`);
          continue;
        }
        need(nodeIds.has(e.from), `map.edges[${i}]: unknown from ${e.from}`);
        need(nodeIds.has(e.to), `map.edges[${i}]: unknown to ${e.to}`);
        if (e.label != null) need(isStr(e.label), `map.edges[${i}]: label is a string`);
        if (e.style != null) need(EDGE_STYLES.includes(e.style), `map.edges[${i}]: style is solid or dashed`);
        for (const f of Array.isArray(e.flows) ? e.flows : []) need(flowIds.has(f), `map.edges[${i}]: unknown flow ${f}`);
        if (e.flows != null) need(Array.isArray(e.flows), `map.edges[${i}]: flows is a list`);
      }
    }
  }

  if (page.sections != null) {
    need(Array.isArray(page.sections), 'sections: a list');
    for (const [i, s] of (Array.isArray(page.sections) ? page.sections : []).entries()) {
      need(isObj(s) && isStr(s.heading) && isStr(s.body), `sections[${i}]: {heading, body}`);
    }
  }

  need(Array.isArray(page.tasks), 'tasks: a list (may be empty)');
  const cards = new Set<number>();
  for (const [i, t] of (Array.isArray(page.tasks) ? page.tasks : []).entries()) {
    if (!isObj(t) || !Number.isInteger(t.card) || t.card <= 0) {
      errs.push(`tasks[${i}]: {card: <card id>}`);
      continue;
    }
    need(!cards.has(t.card), `tasks: card #${t.card} is listed twice`);
    cards.add(t.card);
    if (t.group != null) need(isStr(t.group), `tasks[${i}]: group is a string`);
    if (t.blockedOn != null) need(isStr(t.blockedOn), `tasks[${i}]: blockedOn is a string`);
    if (t.doing != null) need(typeof t.doing === 'boolean', `tasks[${i}]: doing is true or false`);
    if (t.next != null) need(typeof t.next === 'boolean', `tasks[${i}]: next is true or false`);
    if (t.owner != null) need(isStr(t.owner) && t.owner.trim().length > 0 && t.owner.length <= 80, `tasks[${i}]: owner is a name, at most 80 characters`);
    if (t.links != null) {
      need(Array.isArray(t.links), `tasks[${i}]: links is a list`);
      for (const [j, l] of (Array.isArray(t.links) ? t.links : []).entries()) {
        need(isObj(l) && isStr(l.label) && l.label.trim().length > 0 && httpUrl(l.url), `tasks[${i}].links[${j}]: {label, url} with an http(s) url`);
      }
    }
    for (const n of Array.isArray(t.nodes) ? t.nodes : []) need(nodeIds.has(n), `tasks[${i}] (card #${t.card}): unknown node ${n}`);
    if (t.nodes != null) need(Array.isArray(t.nodes), `tasks[${i}]: nodes is a list`);
  }

  if (page.publish != null) {
    const p = page.publish;
    need(isObj(p), 'publish: an object');
    if (isObj(p) && p.url != null) need(httpUrl(p.url), 'publish.url: an http(s) url');
  }
  return errs;
}

/** A page with the optional parts filled in, so the renderer never checks. */
function normalize(page: Row): Row {
  const map = page.map || {};
  return {
    version: VERSION,
    slug: page.slug,
    title: page.title,
    summary: page.summary || '',
    project: page.project || null,
    links: page.links || [],
    map: { layers: map.layers || [], nodes: map.nodes || [], edges: map.edges || [], flows: map.flows || [] },
    sections: page.sections || [],
    tasks: page.tasks || [],
    publish: { url: null, publishedAt: null, hash: null, ...(page.publish || {}) },
  };
}

/**
 * A card's state on a page: todo | doing | done | dropped | missing. A card
 * the dedupe pass folded into another (superseded_by) that is still open is
 * the same work as its survivor, so it takes the survivor's state; a folded
 * card that was itself closed keeps its own.
 */
function taskState(card: Row | undefined, doing: boolean, byId: Map<number, Row> = new Map()): string {
  if (!card) return 'missing';
  let c: Row = card;
  for (let hops = 0; hops < 5 && c.superseded_by != null && (c.status === 'open' || c.status === 'dispatched'); hops++) {
    const next = byId.get(Number(c.superseded_by));
    if (!next) break;
    c = next;
  }
  if (c.status === 'dropped') return 'dropped';
  if (c.status === 'done') return 'done';
  return doing ? 'doing' : 'todo';
}

/** What a task shows, from its card's state and the page's flags. Doing beats blocked beats next. */
function taskStatus(state: string, t: Row = {}): string {
  if (state === 'done' || state === 'dropped' || state === 'missing' || state === 'doing') return state;
  if (t.blockedOn) return 'blocked';
  if (t.next) return 'next';
  return 'todo';
}

/** The order of rows inside a group. */
const STATUS_ORDER = ['doing', 'next', 'blocked', 'todo', 'done', 'dropped', 'missing'];

const URL_RE = /https?:\/\/[^\s<>"'`\]\[{}|\\^]+/gi;
const MAX_CARD_LINKS = 8;

/** The http(s) URLs in some text, trailing punctuation trimmed, in order, once each. */
function urlsIn(text: unknown): string[] {
  const out: string[] = [];
  for (const m of String(text || '').match(URL_RE) || []) {
    let u = m.replace(/[.,;:!?*_]+$/, '');
    // a ")" closes the sentence's parenthesis unless the URL opened one itself
    while (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1).replace(/[.,;:!?]+$/, '');
    if (httpUrl(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/** A link's identity for de-duplication: case-blind host, no fragment, no trailing slash. */
function linkKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url;
  }
}

/** A short label for a URL: "PR #211", "Issue #210", "owner/repo", "Page", "Doc", else the host. */
function linkLabel(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'github.com' && parts.length >= 2) {
    if (parts[2] === 'pull' && /^\d+$/.test(parts[3] || '')) return `PR #${parts[3]}`;
    if (parts[2] === 'issues' && /^\d+$/.test(parts[3] || '')) return `Issue #${parts[3]}`;
    return `${parts[0]}/${parts[1]}`;
  }
  if (host === 'claude.ai') {
    if (parts.includes('artifact')) return 'Page';
    if (parts.some((p) => /^docs?$/.test(p))) return 'Doc';
  }
  return host;
}

/** The URLs in a card's own text (title, then details and the notes appended to them), labelled. */
function cardLinks(card: Row | undefined): Row[] {
  if (!card) return [];
  return urlsIn(`${card.summary || ''}\n${card.detail || ''}`).slice(0, MAX_CARD_LINKS).map((url) => ({ label: linkLabel(url), url }));
}

/** A task's links: the page's first (their labels win), then the card's, each URL once. */
function mergeLinks(explicit: Row[], fromCard: Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const l of [...explicit, ...fromCard]) {
    if (!l || !httpUrl(l.url)) continue;
    const k = linkKey(l.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label: String(l.label || linkLabel(l.url)), url: l.url });
  }
  return out;
}

function progressOf(tasks: Row[]) {
  const counted = tasks.filter((t) => t.counted);
  const done = counted.filter((t) => t.state === 'done').length;
  const total = counted.length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * The page as the renderer draws it. `cards` are rows of
 * repo.commitments.forPage; `runningCards` are card ids with a live build run.
 */
function resolve(page: Row, cards: Row[], { runningCards = [], now = new Date() }: { runningCards?: Array<number | string>; now?: Date } = {}): Row {
  const p = normalize(page);
  const byId = new Map(cards.map((c) => [Number(c.id), c]));
  const running = new Set(runningCards.map(Number));
  const tasks = p.tasks.map((t: Row) => {
    const card = byId.get(Number(t.card));
    const state = taskState(card, Boolean(t.doing) || running.has(Number(t.card)), byId);
    return {
      card: t.card,
      group: t.group || 'Tasks',
      blockedOn: t.blockedOn || null,
      owner: t.owner ? String(t.owner).trim() : null,
      next: Boolean(t.next),
      links: mergeLinks(Array.isArray(t.links) ? t.links : [], cardLinks(card)),
      nodes: t.nodes || [],
      title: card ? String(card.summary || '') : `card #${t.card} not found`,
      state,
      status: taskStatus(state, t),
      counted: state !== 'dropped' && state !== 'missing',
      foldedInto: card && card.superseded_by != null ? Number(card.superseded_by) : null,
      due: card && card.due_at ? new Date(card.due_at).toISOString().slice(0, 10) : null,
    };
  });
  const groups: Row[] = [];
  for (const t of tasks) {
    let g = groups.find((x) => x.name === t.group);
    if (!g) groups.push((g = { name: t.group, tasks: [] }));
    g.tasks.push(t);
  }
  const rank = (t: Row) => STATUS_ORDER.indexOf(t.status);
  for (const g of groups) {
    g.tasks = g.tasks
      .map((t: Row, i: number) => ({ t, i }))
      .sort((a: Row, b: Row) => rank(a.t) - rank(b.t) || a.i - b.i)
      .map((x: Row) => x.t);
    Object.assign(g, progressOf(g.tasks));
  }
  return {
    ...p,
    tasks,
    groups,
    progress: {
      ...progressOf(tasks),
      doing: tasks.filter((t: Row) => t.status === 'doing').map((t: Row) => t.title),
      next: tasks.filter((t: Row) => t.status === 'next').map((t: Row) => t.title),
      blocked: tasks.filter((t: Row) => t.status === 'blocked').length,
    },
    resolvedAt: now.toISOString(),
  };
}

/** A hash of what the page shows, ignoring when it was resolved and where it was published. */
function snapshotHash(resolved: Row): string {
  const { resolvedAt: _at, publish: _pub, ...rest } = resolved;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

/** Two to four words of the title, for the HTML <title> and a tab. */
function shortTitle(title: string): string {
  const words = String(title || '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  const pick = words.slice(0, 4);
  while (pick.length < 2) pick.push(pick.length ? 'page' : 'Plan');
  return pick.join(' ');
}

const escapeText = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** JSON that is safe inside <script type="application/json">: no `</` can end the tag. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Words after which a `/` starts a regex literal, not a division. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** Punctuation after which a `/` starts a regex literal. */
const REGEX_AFTER_PUNCT = '(,=:[!&|?{};+-*%<>~^';
const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * JavaScript without its comments, for the export: the renderer's notes are for
 * this repo, not for whoever reads the published page's source. A small tokenizer,
 * so a `//` or a block-comment opener inside a string, a template or a regex literal
 * is kept: a `/` starts a regex when the token before it cannot end an expression.
 * A comment that spanned lines becomes a newline (ASI sees what it saw), and lines
 * left blank go. A template whose `${…}` holds another backtick is not supported;
 * the renderer has none.
 */
function stripComments(src: string): string {
  const s = String(src);
  const n = s.length;
  let out = '';
  let prev = ''; // the last significant punctuation or word, for the regex test
  let i = 0;
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += s.slice(i, stop).includes('\n') ? '\n' : ' ';
      i = stop;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_AFTER_PUNCT.includes(prev) || REGEX_AFTER_WORD.has(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && s[j] !== '\n') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') inClass = true;
        else if (s[j] === ']') inClass = false;
        else if (s[j] === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(s[j])) j++; // its flags
      out += s.slice(i, j);
      i = j;
      prev = ')'; // a regex ends an expression
      continue;
    }
    if (WORD_CHAR.test(c)) {
      let j = i;
      while (j < n && WORD_CHAR.test(s[j])) j++;
      prev = s.slice(i, j);
      out += prev;
      i = j;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0).join('\n');
}

/**
 * One self-contained HTML file: the renderer inlined without its comments, the
 * resolved page as JSON, nothing loaded from elsewhere. The dashboard serves the
 * same renderer as it is.
 */
function exportHtml(resolved: Row, { clientJs }: { clientJs: string }): string {
  const js = stripComments(String(clientJs)).replace(/<\/script/gi, '<\\/script');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeText(shortTitle(resolved.title))}</title>`,
    '</head>',
    '<body>',
    '<div id="page-root"></div>',
    `<script type="application/json" id="page-data">${scriptJson(resolved)}</script>`,
    `<script>${js}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The claude.ai artifact link in some text, or null. */
function parsePublishUrl(text: string): string | null {
  const m = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/.exec(String(text || ''));
  return m ? m[0] : null;
}

module.exports = { VERSION, validate, normalize, resolve, taskState, taskStatus, STATUS_ORDER, urlsIn, linkLabel, cardLinks, mergeLinks, snapshotHash, shortTitle, stripComments, exportHtml, scriptJson, parsePublishUrl, SLUG };
