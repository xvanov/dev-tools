'use strict';

// Jarvis pages, the pure half: one JSON file per page is the source of truth,
// and everything else — the dashboard's /pages/<slug>, the exported HTML file
// and the claude.ai Artifact made from it — is rendered from it by the same
// client (src/dashboard/page.client.js). Nothing here touches disk, the
// database or the network; src/pages/index.ts does.
//
//   validate(page)                    every problem at once, [] when it is fine
//   resolve(page, cards, opts)        the page with each task's title/status from its card,
//                                     overall and per-group progress, and what is being worked on
//   snapshotHash(resolved)            what changed, ignoring when it was resolved
//   exportHtml(resolved, parts)       one self-contained HTML file (no external script or font)
//   parsePublishUrl(text)             the claude.ai artifact link in the CLI's answer
//
// A task's card comes from the board: open/dispatched counts as to do, done as
// done, dropped or folded into another card leaves the total (it is shown, struck
// through). A card that does not exist is shown as "card #N not found" and does
// not count either way.
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

/** A card's state on a page: todo | doing | done | dropped | missing. */
function taskState(card: Row | undefined, doing: boolean): string {
  if (!card) return 'missing';
  if (card.superseded_by != null || card.status === 'dropped') return 'dropped';
  if (card.status === 'done') return 'done';
  return doing ? 'doing' : 'todo';
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
    const state = taskState(card, Boolean(t.doing) || running.has(Number(t.card)));
    return {
      card: t.card,
      group: t.group || 'Tasks',
      blockedOn: t.blockedOn || null,
      nodes: t.nodes || [],
      title: card ? String(card.summary || '') : `card #${t.card} not found`,
      state,
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
  for (const g of groups) Object.assign(g, progressOf(g.tasks));
  return {
    ...p,
    tasks,
    groups,
    progress: { ...progressOf(tasks), doing: tasks.filter((t: Row) => t.state === 'doing').map((t: Row) => t.title) },
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
  while (pick.length < 2) pick.push(pick.length ? 'page' : 'Jarvis');
  return pick.join(' ');
}

const escapeText = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** JSON that is safe inside <script type="application/json">: no `</` can end the tag. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * One self-contained HTML file: the renderer inlined, the resolved page as
 * JSON, nothing loaded from elsewhere. The same client draws it in the dashboard.
 */
function exportHtml(resolved: Row, { clientJs }: { clientJs: string }): string {
  const js = String(clientJs).replace(/<\/script/gi, '<\\/script');
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

module.exports = { VERSION, validate, normalize, resolve, taskState, snapshotHash, shortTitle, exportHtml, scriptJson, parsePublishUrl, SLUG };
