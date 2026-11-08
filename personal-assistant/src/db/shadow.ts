'use strict';

// `pa db compare --sqlite <file>` (plan 3.4, D12): the shadow comparison. The
// same recorded queries go to both stores, Postgres (read only: every
// statement runs with default_transaction_read_only) and a SQLite file made
// by `pa db export`, through the repository methods search, recall and the
// board use. It compares what comes back and how long it takes.
//
// The recorded query set:
//   - eval_case: the retrieval eval's questions, with the items that answer
//     them (gold_item_ids), so each store's hybrid search is also scored.
//   - query_embedding_cache: real searches with their stored vectors, so the
//     vector leg runs too without an embedding call (D5).
// Per query: lexical (strict, then loose, as search does), vector, people,
// fused as src/search fuses them (RRF, weights 1.2/1.0/0.6), and memory recall's
// claim and page legs. Board reads: open asks both ways, the inbox, the
// notification feed, recent runs, pending proposals.
//
// No reranker and no embedding calls: both depend only on what the stores
// return, and fusion is rank-based, so ts_rank and bm25 scales never meet a
// threshold. What can differ is which candidates come back, in what order.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Client = import('../repo/types.ts').Client;
type Repos = import('../repo/types.ts').Repos;
/** Rows and the report's per-query and per-leg bags, read and built key by key. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
/** One timed call: its value, or its error, and how long it took. */
type Timed = { v?: Json[]; err?: string; ms: number };

const { createRepos } = require('../repo');
const { fuse } = require('../search/fuse');
const { mentionedPeople } = require('../search/entities');

const { normalizeQuery } = require('../search/embedCache');

const K = 10;

// src/search's author_identity spellings per identity kind (people leg).
function authorForms(identity: string) {
  const [kind, ...rest] = identity.split(':');
  const value = rest.join(':');
  if (kind === 'smtp') return [value];
  if (kind === 'aad_oid') return [`aad:${value}`];
  if (kind === 'github_username') return [`github:${value}`];
  if (kind === 'gitlab_username') return [`gitlab:${value}`];
  return [value];
}

function pgReadOnly(url: string) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 4, options: '-c default_transaction_read_only=on' });
  pool.on('error', () => {});
  const query = (t: string, p?: unknown[]): Promise<{ rows: Json[] }> => pool.query(t, p);
  return {
    query,
    rows: async (t: string, p?: unknown[]) => (await query(t, p)).rows,
    one: async (t: string, p?: unknown[]) => (await query(t, p)).rows[0] ?? null,
    withTx: async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
      const c = await pool.connect();
      try {
        await c.query('begin read only');
        const r = await fn(c);
        await c.query('commit');
        return r;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

async function timed(fn: () => Promise<unknown>): Promise<Timed> {
  const t0 = process.hrtime.bigint();
  try {
    const v = await fn();
    return { v: v as Json[], ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } catch (err) {
    return { err: (err as Error).message, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  }
}

const ids = (list: Json[] | null | undefined) => (list || []).map((r) => String(r.id));
function overlap(a: Json[] | null | undefined, b: Json[] | null | undefined, k: number = K) {
  const A = new Set(ids(a).slice(0, k));
  const B = ids(b).slice(0, k);
  if (!A.size && !B.length) return 1;
  return B.filter((x) => A.has(x)).length / Math.max(A.size, B.length);
}
function pct(xs: number[], p: number) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
}

/** The search legs and fusion of src/search, on one repository set. */
async function hybrid(repos: Repos, q: string, vectorLiteral: unknown, people: Json[]) {
  const filters = { sources: null, since: null, until: null };
  const pool = 30;
  const out: Json = { legs: {} };
  out.legs.lexical = await timed(async () => {
    const strict = await repos.search.lexicalPass(q, pool, filters, true);
    if (strict.length >= Math.ceil(pool / 3)) return strict;
    const loose = await repos.search.lexicalPass(q, pool, filters, false);
    const seen = new Set(strict.map((r: Json) => r.id));
    return [...strict, ...loose.filter((r: Json) => !seen.has(r.id))].slice(0, pool);
  });
  out.legs.vector = vectorLiteral ? await timed(() => repos.search.vectorPass(vectorLiteral, pool, filters)) : { v: [], ms: 0 };
  out.legs.people = await timed(async () => {
    const want = new Set(mentionedPeople(q, people));
    const named = people.filter((p) => want.has(p.id));
    if (!named.length) return [];
    const authors = named.flatMap((p) => p.identities.flatMap(authorForms));
    const patterns = [
      ...named.flatMap((p) => p.identities.filter((i: string) => i.startsWith('smtp:')).map((i: string) => `%${i.slice(5)}%`)),
      ...named.filter((p) => /\s/.test(p.display_name)).map((p) => `%${p.display_name}%`),
    ];
    return repos.search.peopleItems(authors, patterns, pool, filters);
  });
  out.fused = fuse([out.legs.lexical.v || [], out.legs.vector.v || [], out.legs.people.v || []], [1.2, 1.0, 0.6]).map((h: Json) => ({ id: h.id }));
  out.claims = await timed(() => repos.memory.searchClaimsLexical(q, { limit: K }));
  out.pages = await timed(() => repos.memory.searchPagesLexical(q, 4));
  if (vectorLiteral) {
    out.claimsVec = await timed(() => repos.memory.searchClaimsVector(vectorLiteral, { limit: K }));
    out.pagesVec = await timed(() => repos.memory.searchPagesVector(vectorLiteral, 4));
  }
  return out;
}

function goldScore(fused: Json[], gold: string[] | null) {
  if (!gold || !gold.length) return null;
  const top = ids(fused).slice(0, K);
  const g = new Set(gold.map(String));
  const first = top.findIndex((x) => g.has(x));
  return { hit: first >= 0, rr: first >= 0 ? 1 / (first + 1) : 0 };
}

/**
 * Runs the comparison. Resolves the report: per-query rows, per-leg overlap
 * and latency percentiles per store, eval hit@10 / MRR per store, and the
 * board reads' agreement.
 */
async function compare({ pgUrl, file, key = null, log = () => {} }: { pgUrl: string; file: string; key?: string | null; log?: (line: string) => void }) {
  const { createSqliteBackend } = require('./sqlite');
  const pgdb = pgReadOnly(pgUrl);
  const lite = createSqliteBackend(file, { key });
  const P = createRepos(pgdb);
  const S = createRepos(lite);
  try {
    const cases = await pgdb.rows(`select id, question, gold_item_ids from eval_case where active order by id`);
    const cached = await pgdb.rows(`select query_norm, embedding::text as v from query_embedding_cache order by last_used_at desc`);
    const queries = [
      ...cases.map((c) => ({ kind: 'eval', q: c.question, gold: (c.gold_item_ids || []).map(String), vector: (cached.find((x) => x.query_norm === normalizeQuery(c.question)) || {}).v || null })),
      ...cached.map((c) => ({ kind: 'recorded', q: c.query_norm, gold: null, vector: c.v })),
    ];
    const peopleP = await P.search.knownPeople();
    const peopleS = await S.search.knownPeople();
    const rows: Json[] = [];
    for (const [i, x] of queries.entries()) {
      // Alternate which store goes first, so a warm cache favours neither.
      const order = i % 2 ? ['s', 'p'] : ['p', 's'];
      const got: Json = {};
      for (const w of order) got[w] = await hybrid(w === 'p' ? P : S, x.q, x.vector, w === 'p' ? peopleP : peopleS);
      const legs = ['lexical', 'vector', 'people'];
      rows.push({
        kind: x.kind,
        q: x.q,
        overlap: {
          ...Object.fromEntries(legs.map((l) => [l, overlap(got.p.legs[l].v, got.s.legs[l].v)])),
          fused: overlap(got.p.fused, got.s.fused),
          claims: overlap(got.p.claims.v, got.s.claims.v),
          pages: overlap(got.p.pages.v, got.s.pages.v, 4),
          ...(x.vector ? { claimsVec: overlap(got.p.claimsVec.v, got.s.claimsVec.v), pagesVec: overlap(got.p.pagesVec.v, got.s.pagesVec.v, 4) } : {}),
        },
        ms: Object.fromEntries(
          ['p', 's'].map((w) => [
            w,
            Object.fromEntries([
              ...legs.map((l) => [l, got[w].legs[l].ms]),
              ['claims', got[w].claims.ms],
              ['pages', got[w].pages.ms],
              ...(x.vector ? [['claimsVec', got[w].claimsVec.ms], ['pagesVec', got[w].pagesVec.ms]] : []),
            ]),
          ])
        ),
        errors: [...legs.flatMap((l) => [got.p.legs[l].err && `pg ${l}: ${got.p.legs[l].err}`, got.s.legs[l].err && `sqlite ${l}: ${got.s.legs[l].err}`]), got.s.claims.err && `sqlite claims: ${got.s.claims.err}`, got.s.pages.err && `sqlite pages: ${got.s.pages.err}`].filter(Boolean),
        gold: x.gold ? { p: goldScore(got.p.fused, x.gold), s: goldScore(got.s.fused, x.gold) } : null,
        hits: { p: got.p.legs.lexical.v ? got.p.legs.lexical.v.length : 0, s: got.s.legs.lexical.v ? got.s.legs.lexical.v.length : 0 },
      });
      if ((i + 1) % 10 === 0) log(`${i + 1}/${queries.length} queries`);
    }

    // The board's reads: the same rows in the same order.
    const board: Json[] = [];
    const reads: [string, (r: Repos) => Promise<unknown>][] = [
      ['open asks on me', (r) => r.commitments.listForTool('owed_by_me', null, 100)],
      ['open asks owed to me', (r) => r.commitments.listForTool('owed_to_me', null, 100)],
      ['inbox', (r) => r.commitments.inboxList(null, 100)],
      ['notification feed', (r) => r.notifications.feed({ limit: 100 })],
      ['recent runs', (r) => r.runs.recent(true, 50)],
      ['pending proposals', (r) => r.proposals.pending({ limit: 100 })],
    ];
    for (const [name, fn] of reads) {
      const a = await timed(() => fn(P));
      const b = await timed(() => fn(S));
      const same = !a.err && !b.err && JSON.stringify(ids(a.v)) === JSON.stringify(ids(b.v));
      const sameSet = !a.err && !b.err && ids(a.v).slice().sort().join() === ids(b.v).slice().sort().join();
      board.push({ name, rows: { p: a.v ? a.v.length : a.err, s: b.v ? b.v.length : b.err }, same, sameSet, ms: { p: a.ms, s: b.ms } });
    }

    const summary: Json = { queries: rows.length, eval: cases.length, recorded: cached.length, legs: {}, latency: {}, eval_scores: {} };
    for (const leg of ['lexical', 'vector', 'people', 'fused', 'claims', 'pages', 'claimsVec', 'pagesVec']) {
      const v = rows.map((r) => r.overlap[leg]).filter((x) => x != null);
      if (v.length) summary.legs[leg] = { n: v.length, mean: v.reduce((a: number, b: number) => a + b, 0) / v.length, identical: v.filter((x) => x === 1).length };
    }
    for (const w of ['p', 's']) {
      for (const leg of ['lexical', 'vector', 'people', 'claims', 'pages', 'claimsVec', 'pagesVec']) {
        const xs = rows.map((r) => r.ms[w][leg]).filter((x) => x > 0);
        (summary.latency[leg] ||= {})[w === 'p' ? 'postgres' : 'sqlite'] = { p50: pct(xs, 50), p95: pct(xs, 95) };
      }
      const scored = rows.filter((r) => r.gold && r.gold[w]);
      summary.eval_scores[w === 'p' ? 'postgres' : 'sqlite'] = {
        cases: scored.length,
        hit10: scored.filter((r) => r.gold[w].hit).length / (scored.length || 1),
        mrr: scored.reduce((a, r) => a + r.gold[w].rr, 0) / (scored.length || 1),
      };
    }
    summary.errors = rows.flatMap((r) => r.errors);
    return { summary, board, rows };
  } finally {
    await pgdb.close().catch(() => {});
    await lite.close().catch(() => {});
  }
}

module.exports = { compare, overlap };
