'use strict';

// The pure half of the repo registry: how the sources' facts become one row
// per repo, and how your manual edits sit on top. No I/O here, so every rule
// is tested directly (test/repos.test.js).

const path = require('path');

/** github | gitlab | null, from a remote URL or an `https://host/...` link. */
function forgeOf(remote) {
  const s = String(remote || '').toLowerCase();
  if (!s) return null;
  if (/github\.com[:/]/.test(s) || /^github[-\w]*:/.test(s)) return 'github';
  if (/gitlab/.test(s) || /git\.innergy\.dev/.test(s)) return 'gitlab';
  return null;
}

/** https link to a repo on its forge, or null. */
function forgeUrl(forge, fullName) {
  if (!fullName) return null;
  if (forge === 'github') return `https://github.com/${fullName}`;
  return null;
}

function cleanDir(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The repo folder a session ran in: the first path segment under one of the
 * machine's repos roots. `C:\repos\erp\src\Modules` → erp. Null for a cwd that
 * is not inside a root (a temp dir, the home folder) or is the root itself,
 * and for dot-folders (`.pa-worktrees`) — those are scratch, not repos.
 * @param {string}   cwd
 * @param {string[]} roots
 * @returns {{dir: string, path: string}|null}
 */
function sessionDir(cwd, roots) {
  const c = cleanDir(cwd);
  if (!c) return null;
  const lc = c.toLowerCase();
  for (const root of roots || []) {
    const r = cleanDir(root);
    if (!r) continue;
    if (!lc.startsWith(`${r.toLowerCase()}/`)) continue;
    const dir = c.slice(r.length + 1).split('/')[0];
    if (!dir || dir.startsWith('.')) return null;
    const sep = /^[a-z]:/i.test(c) ? '\\' : '/';
    const base = sep === '\\' ? r.replace(/\//g, '\\') : r;
    return { dir, path: `${base}${sep}${dir}` };
  }
  return null;
}

/**
 * Which registry row a folder name means: the row's name, an alias, a local
 * path's last segment, or the forge path's repo name — case-insensitive and
 * whole-name only, so `dev-tools` never matches `dev-toolkit`.
 * @param {string} dir
 * @param {Array}  repos [{id, name, gitlab_path, aliases?:string[], paths?:string[]}]
 */
function matchDir(dir, repos) {
  const d = String(dir || '').toLowerCase();
  if (!d) return null;
  const names = (r) =>
    [r.name, r.gitlab_path ? r.gitlab_path.split('/').pop() : null, ...(r.aliases || []), ...(r.paths || []).map((p) => cleanDir(p).split('/').pop())]
      .filter(Boolean)
      .map((n) => String(n).toLowerCase());
  // A row's own name beats someone else's alias of the same spelling.
  return repos.find((r) => String(r.name).toLowerCase() === d) || repos.find((r) => names(r).includes(d)) || null;
}

/**
 * Where a forge repo goes in the registry.
 *  - the row that already has that forge path (or lists it among its remotes)
 *  - else a row of the same name that has no forge path, or is retired (the
 *    archived GitLab original of a repo that moved to GitHub) — taken over
 *  - else a new row, named after the repo, or `name (owner)` when the name is
 *    already a different live repo's
 * @returns {{action:'use'|'takeover'|'insert', id?, name}}
 */
function placeForgeRepo(fullName, rows) {
  const full = String(fullName).toLowerCase();
  const [owner, name] = String(fullName).split('/');
  const byPath = rows.find(
    (r) => (r.gitlab_path && r.gitlab_path.toLowerCase() === full) || (r.remote_paths || []).some((p) => String(p).toLowerCase() === full)
  );
  if (byPath) return { action: 'use', id: byPath.id, name: byPath.name };
  const sameName = rows.find((r) => String(r.name).toLowerCase() === String(name).toLowerCase());
  if (sameName && (!sameName.gitlab_path || !sameName.active)) return { action: 'takeover', id: sameName.id, name: sameName.name };
  if (!sameName) return { action: 'insert', name };
  const alt = `${name} (${owner})`;
  const altTaken = rows.find((r) => String(r.name).toLowerCase() === alt.toLowerCase());
  return altTaken ? { action: 'use', id: altTaken.id, name: altTaken.name } : { action: 'insert', name: alt };
}

// PR bodies open with template scaffolding ("## Summary", "Closes #12",
// checklists) more often than with a sentence. The summary is the first line
// that reads like prose.
// "Closes #12" is scaffolding; "Fixes the export when…" is prose.
const SKIP_LINE = /^(#{1,6}\s|[-*]\s*\[[ x]\]|(closes|fixes|resolves|refs?|related to)\s*:?\s*(#|https?:|[A-Z]+-\d|[\w.-]+\/[\w.-]+#)|jira\s*:|ticket\s*:|<!--|---|\|)/i;

/**
 * A one-line summary from a PR body, or null when there is no prose in it.
 * Bodies are often hard-wrapped, so a paragraph's lines are joined before
 * the first sentence or two is taken from it.
 * @param {string} body
 * @param {number} [max]
 */
function prSummary(body, max = 220) {
  const text = String(body || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '');
  const clean = (line) =>
    line
      .replace(/^[-*>]\s+/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  // A paragraph ends at a blank line, and a list item starts a paragraph of its own.
  const paragraphs = [];
  let cur = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || SKIP_LINE.test(line) || /^[-*]\s/.test(line)) {
      if (cur.length) paragraphs.push(cur);
      cur = [];
      if (line && !SKIP_LINE.test(line)) paragraphs.push([line]);
      continue;
    }
    cur.push(line);
  }
  if (cur.length) paragraphs.push(cur);
  for (const p of paragraphs) {
    const para = clean(p.map(clean).join(' '));
    if (para.length < 12 || !/[a-z]{3}/i.test(para)) continue;
    if (/^(summary|description|what|why|changes|overview|context)\s*:?$/i.test(para)) continue;
    return para.length > max ? `${para.slice(0, max - 1).trimEnd()}…` : para;
  }
  return null;
}

function prState(pr) {
  if (pr.mergedAt || String(pr.state).toUpperCase() === 'MERGED') return 'merged';
  return String(pr.state).toUpperCase() === 'OPEN' ? 'open' : 'closed';
}

/**
 * raven's map of INNERGY repos (knowledge/systems/repositories.md): every
 * table row that starts with a backticked `owner/repo`. Markdown emphasis and
 * links are flattened; the text is kept whole — it is the authoritative
 * description.
 * @returns {Map<string, string>} lower(owner/repo) → description
 */
function parseRavenRepos(markdown) {
  const out = new Map();
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([\w.-]+\/[\w.-]+)`[^|]*\|\s*(.+?)\s*\|\s*$/);
    if (!m) continue;
    const text = m[2]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*|__/g, '')
      .replace(/`/g, '')
      .trim();
    if (text) out.set(m[1].toLowerCase(), text);
  }
  return out;
}

/** The first sentence or two of a long description, for a card. */
function shortText(text, max = 280) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

const MANUAL_KEYS = ['description', 'owner', 'stack', 'related', 'kind', 'pinned'];

/**
 * A registry row as every reader sees it: the synced profile with your manual
 * edits laid over it. Manual wins, field by field; sync never writes `manual`.
 */
function effective(row) {
  const manual = row.manual || {};
  const profile = row.profile || {};
  const pick = (k, synced) => (manual[k] !== undefined && manual[k] !== null && manual[k] !== '' ? manual[k] : synced);
  const lastActivity = latest([row.last_pr_at, row.last_commit_at, row.last_session_at]);
  return {
    ...row,
    description: pick('description', row.description || null),
    descriptionSource: manual.description ? 'manual' : row.profile_source || null,
    owner: pick('owner', profile.owner || null),
    stack: pick('stack', profile.stack || []),
    related: pick('related', profile.related || []),
    kind: pick('kind', profile.kind || null),
    pinned: !!manual.pinned,
    lastActivity,
  };
}

/** Merge a manual edit into the stored `manual` object. Empty string clears. */
function applyManual(manual, edits) {
  const out = { ...(manual || {}) };
  for (const [k, v] of Object.entries(edits || {})) {
    if (!MANUAL_KEYS.includes(k)) throw new Error(`cannot set "${k}" — one of ${MANUAL_KEYS.join(', ')}`);
    if (v === '' || v === null) delete out[k];
    else if ((k === 'stack' || k === 'related') && typeof v === 'string') out[k] = v.split(',').map((s) => s.trim()).filter(Boolean);
    else out[k] = v;
  }
  return out;
}

function latest(dates) {
  let best = null;
  for (const d of dates) {
    if (!d) continue;
    const t = new Date(d);
    if (!Number.isNaN(t.getTime()) && (!best || t > best)) best = t;
  }
  return best ? best.toISOString() : null;
}

/** Whether a row belongs on the Repos tab: you worked in it, or pinned it. */
function contributed(row) {
  const e = row.lastActivity !== undefined ? row : effective(row);
  return !row.hidden && (e.pinned || Number(row.pr_count) > 0 || !!row.last_commit_at || Number(row.session_count) > 0);
}

/**
 * Branches from several sources (a clone's refs, open PRs, sessions) as one
 * list: newest first, one entry per (name, machine), the default branch out.
 */
function mergeBranches(lists, { defaultBranch = null, max = 12 } = {}) {
  const seen = new Map();
  for (const b of lists.flat()) {
    if (!b || !b.name || b.name === 'HEAD' || b.name === defaultBranch) continue;
    const key = `${b.name}\u0000${b.machine || ''}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { ...b });
      continue;
    }
    seen.set(key, {
      ...prev,
      at: latest([prev.at, b.at]),
      mine: prev.mine || b.mine,
      current: prev.current || b.current,
      pr: prev.pr || b.pr || null,
      source: prev.source === b.source ? prev.source : `${prev.source}+${b.source}`,
    });
  }
  return [...seen.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, max);
}

/** Last path segment, either separator. */
function baseName(p) {
  return path.basename(cleanDir(p));
}

module.exports = {
  forgeOf,
  forgeUrl,
  sessionDir,
  matchDir,
  placeForgeRepo,
  prSummary,
  prState,
  parseRavenRepos,
  shortText,
  effective,
  applyManual,
  contributed,
  mergeBranches,
  latest,
  baseName,
  MANUAL_KEYS,
};
