'use strict';

// The dashboard's Memory tab: JSON over src/memory's public surface, plus the
// one judgement the tab makes itself — which people look like the same human.
//
// Reads are GETs; every write is a POST, which server.js only lets through
// with the X-PA header. Nothing here renders HTML: pages go out as the tree
// markdown.js parses, and the browser builds them with textContent.

const { parseMarkdown, pageSummary } = require('./markdown');

// ------------------------------------------------------ duplicate people ----
//
// The same colleague is often two `person` rows: one from a GitHub handle, one
// from an email address, because identity resolution only joins on exact
// identifiers (by design — see distill/identity.js). This only *suggests*
// pairs; merging stays a click you confirm.

function fold(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function nameTokens(s) {
  return fold(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
}

function compact(s) {
  return fold(s).replace(/[^\p{L}\p{N}]/gu, '');
}

function humanName(s) {
  const v = String(s ?? '').trim();
  return /\s/.test(v) && !/@|^(github|gitlab|aad):/i.test(v);
}

// The bare handle in "github:qbrannoc", "qbrannoc@example.test", "qbrannoc".
function handleOf(s) {
  return compact(String(s ?? '').trim().replace(/^(github|gitlab|aad):/i, '').replace(/@.*$/, ''));
}

function profile(p) {
  const labels = [p.display_name, p.page_title].filter(Boolean);
  const names = [];
  for (const l of labels.filter(humanName)) {
    const t = nameTokens(l);
    if (t.length >= 2 && !names.some((n) => n.join(' ') === t.join(' '))) names.push(t);
  }
  const handles = new Set();
  for (const i of p.identities || []) {
    if (['github_username', 'gitlab_username', 'smtp'].includes(i.kind)) handles.add(handleOf(i.value));
  }
  if (p.primary_email) handles.add(handleOf(p.primary_email));
  for (const l of labels.filter((x) => !humanName(x))) handles.add(handleOf(l));
  for (const h of [...handles]) if (h.length < 3) handles.delete(h);

  // How people turn a name into a handle: brannocquill, quillbrannoc,
  // bquill, brannocq, quillb.
  const forms = new Set();
  for (const t of names) {
    const f = t[0];
    const l = t[t.length - 1];
    for (const v of [f + l, l + f, f[0] + l, f + l[0], l + f[0], t.join('')]) if (v.length >= 4) forms.add(v);
  }
  // A one-word label that is a plain word ("Brannoc") is probably a first name.
  const firsts = new Set(names.map((t) => t[0]));
  const single = labels.find((l) => /^\p{L}{3,}$/u.test(String(l).trim()));
  const loneFirst = single ? fold(single) : null;
  return { names, handles, forms, firsts, loneFirst, handleOnly: !names.length };
}

function rank(p) {
  return [p.is_me ? 1 : 0, humanName(p.display_name) || humanName(p.page_title) ? 1 : 0, (p.claims || 0) + (p.commitments || 0), -Number(p.id)];
}

function better(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
  return true;
}

// A handle built from a name, possibly with an org or number stuck on either
// end ("qbrannoc-acme", "AcmeBrannocQuill"). Short forms must match exactly.
function fitsName(handles, forms) {
  for (const h of handles) {
    for (const f of forms) {
      if (h === f || (f.length >= 6 && (h.startsWith(f) || h.endsWith(f)))) return h;
    }
  }
  return null;
}

function comparePair(a, b, pa, pb) {
  const reasons = [];
  let score = 0;
  if (pa.names.some((x) => pb.names.some((y) => [...x].sort().join(' ') === [...y].sort().join(' ')))) {
    score += 3;
    reasons.push('same name');
  }
  const shared = [...pa.handles].filter((h) => pb.handles.has(h));
  if (shared.length) {
    score += 3;
    reasons.push(`same handle or email prefix "${shared[0]}"`);
  }
  const looks = fitsName(pa.handles, pb.forms) || fitsName(pb.handles, pa.forms);
  if (looks && !shared.includes(looks)) {
    score += 2;
    reasons.push(`handle "${looks}" fits the other's name`);
  }
  if (!score) {
    const similar = pa.names.some((x) =>
      pb.names.some((y) => {
        const [fx, lx] = [x[0], x[x.length - 1]];
        const [fy, ly] = [y[0], y[y.length - 1]];
        return lx === ly && fx !== fy && Math.min(fx.length, fy.length) >= 3 && (fx.startsWith(fy) || fy.startsWith(fx));
      })
    );
    if (similar) {
      score += 2;
      reasons.push('similar name');
    }
  }
  if (!score) {
    const lone = (p, q) => p.loneFirst && (q.firsts.has(p.loneFirst) || [...q.handles].some((h) => h.startsWith(p.loneFirst)));
    if (lone(pa, pb) || lone(pb, pa)) {
      score += 1;
      reasons.push('first name only — check');
    }
  }
  if (score && (pa.handleOnly || pb.handleOnly)) {
    score += 1;
    reasons.push('one is known only by a handle');
  }
  return { score, reasons };
}

// people: [{id, display_name, primary_email, is_me, page_title, identities:[{kind,value}], claims, commitments}]
// → [{into, from, score, reasons}], best first. `into` is the row worth keeping:
// you, then the one with a real name, then the one with more history.
function duplicatePairs(people, { min = 2, limit = 40 } = {}) {
  const list = (people || []).filter((p) => p && p.id != null);
  const profiles = new Map(list.map((p) => [p.id, profile(p)]));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.is_me && b.is_me) continue;
      const { score, reasons } = comparePair(a, b, profiles.get(a.id), profiles.get(b.id));
      if (score < min) continue;
      const [into, from] = better(a, b) ? [a, b] : [b, a];
      out.push({ into: brief(into), from: brief(from), score, reasons });
    }
  }
  out.sort((x, y) => y.score - x.score || x.into.id - y.into.id);
  return out.slice(0, limit);
}

function brief(p) {
  return {
    id: p.id,
    name: p.page_title || p.display_name,
    display_name: p.display_name,
    is_me: !!p.is_me,
    identities: (p.identities || []).map((i) => `${i.kind === 'github_username' ? 'github:' : i.kind === 'gitlab_username' ? 'gitlab:' : ''}${i.value}`),
    claims: p.claims || 0,
    commitments: p.commitments || 0,
  };
}

// ------------------------------------------------------------- the API -----

const SUBJECT_KINDS = ['person', 'project', 'me', 'index', 'topic'];

// Claim rows without the columns a browser has no use for (a 1536-float
// vector per row would dwarf the rest).
function clean(c) {
  if (!c) return c;
  const { embedding, tsv, ...rest } = c;
  return rest;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function idParam(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw httpError(400, 'bad id');
  return n;
}

async function page(memory, q) {
  const kind = String(q.get('kind') || '');
  if (!SUBJECT_KINDS.includes(kind)) throw httpError(400, 'bad kind');
  const all = q.get('history') === '1';
  let subject = null;
  let row = null;
  if (kind === 'me' || kind === 'index') {
    row = await memory.getPage(kind);
    subject = kind === 'me' ? 'me' : null;
  } else if (kind === 'topic') {
    subject = { kind: 'topic', id: null, label: String(q.get('label') || '').toLowerCase() };
    if (!subject.label) throw httpError(400, 'topic needs a label');
  } else {
    subject = { kind, id: idParam(q.get('id')), label: String(q.get('label') || kind) };
    row = await memory.getPage(subject);
  }
  const claims = subject ? (await memory.claimsFor(subject, { all })).claims.map(clean) : [];
  return {
    kind,
    id: subject && typeof subject === 'object' ? subject.id : null,
    label: subject && typeof subject === 'object' ? subject.label : kind,
    title: row?.title || (subject && typeof subject === 'object' ? subject.label : kind === 'me' ? 'Me' : 'Index'),
    generated_at: row?.generated_at || null,
    blocks: row ? parseMarkdown(row.body) : null,
    claims,
  };
}

// Returns the JSON for a /api/memory/... request, or undefined for a path it
// does not know. `memory` is src/memory (injectable for tests).
async function route(method, url, body = {}, memory = require('../memory')) {
  const p = url.pathname.replace(/^\/api\/memory/, '');
  const q = url.searchParams;
  let m;

  if (method === 'GET') {
    if (p === '/overview') {
      const [stats, subjects] = await Promise.all([memory.stats(), memory.subjects()]);
      return {
        stats,
        subjects: subjects.map((s) => ({
          kind: s.kind,
          id: s.id,
          title: s.title,
          summary: s.body ? pageSummary(s.body) : '',
          hasPage: !!s.body,
          claims: s.claims,
          latest: s.latest,
          generated_at: s.generated_at,
        })),
      };
    }
    if (p === '/page') return page(memory, q);
    if (p === '/search') {
      const text = String(q.get('q') || '').trim();
      if (!text) return { results: [] };
      const r = await memory.searchClaims(text, {
        subject: q.get('subject') || null,
        asOf: q.get('asOf') || null,
        limit: Math.min(50, Number(q.get('limit')) || 20),
      });
      return { subject: r.subject, lexicalOnly: r.lexicalOnly, results: r.results.map(clean) };
    }
    if (p === '/review') return { claims: await memory.reviewQueue() };
    if (p === '/duplicates') return { pairs: duplicatePairs(await memory.people()) };
    if ((m = p.match(/^\/claims\/(\d+)$/))) {
      const r = await memory.explain(idParam(m[1]));
      if (!r) throw httpError(404, 'no such claim');
      return { ...r, claim: clean(r.claim) };
    }
    if ((m = p.match(/^\/items\/(\d+)$/))) {
      const r = await memory.item(idParam(m[1]));
      if (!r) throw httpError(404, 'no such item (retention may have removed it)');
      return r;
    }
    return undefined;
  }

  if (method === 'POST') {
    if (p === '/remember') {
      const text = String(body.text || '').trim();
      if (!text) throw httpError(400, 'nothing to remember');
      const r = await memory.remember(text.slice(0, 4000), {
        subject: body.subject ? String(body.subject) : null,
        kind: body.kind ? String(body.kind) : null,
      });
      return { claim: clean(r.claim), consolidation: r.consolidation };
    }
    if ((m = p.match(/^\/claims\/(\d+)\/(forget|reject|approve)$/))) {
      const id = idParam(m[1]);
      if (m[2] === 'approve') {
        const r = await memory.approve(id);
        return { claim: r.claim, consolidation: r.consolidation };
      }
      return memory.forget(id);
    }
    if (p === '/people/merge') {
      const into = idParam(body.into);
      const from = idParam(body.from);
      if (into === from) throw httpError(400, 'pick two different people');
      return memory.mergePeople(into, from);
    }
    return undefined;
  }
  return undefined;
}

module.exports = { route, duplicatePairs, nameTokens, handleOf, humanName, clean };
