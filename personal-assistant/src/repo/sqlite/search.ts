'use strict';

// SQLite twin of src/repo/search.js (chunk, query_embedding_cache).
//
// Lexical leg: FTS5 (sql-sqlite/002_search.sql) instead of tsvectors.
// chunk_fts (porter) stands in for the 'english' tsvector, chunk_fts_exact
// (unicode61, no stemming) for the 'simple' one; rank is -bm25() (higher is
// better, only meaningful as an order, as ts_rank). The user's text never
// reaches MATCH: it is split into words here and each is quoted. Strict mode
// keeps websearch syntax's meaning (every term, "quoted phrases", -exclusions,
// `or`); loose mode is any term, English stop words left out (pg's 'english'
// config drops them). The snippet is a ~28-word window around the first hit,
// built in JS (no <b>, as the pg one). The chunk shown for an item is its first
// matching one, ranked by the item's best chunk: bm25 normalises by length, so
// "best chunk" would favour a short trailing fragment where ts_rank (no length
// normalisation) ties and pg keeps the leading chunk.
//
// Vector leg: exact scan over float32 BLOBs, vec_distance_cosine = pgvector's
// <=>. Vectors arrive as the '[0.1,...]' literal callers format (or arrays).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;
type Filters = { sources?: unknown[] | null; since?: Date | string | number | null; until?: Date | string | number | null };

const { vectorBlob, signBits, hammingSql } = require('../../db/sqlite');

// How many chunks the Hamming pass hands to the exact cosine re-rank: on the
// work stack 300 gave the exact scan's top 30 for every test query (plan 3.4).
const CANDIDATES = 400;

// How many chunks per FTS index an unfiltered keyword search ranks into items
// (plan 3.4: the same top 30 items as ranking every match, on the eval set).
const TOP_CHUNKS = 2000;
const { NOW } = require('./_sql');

const ITEM = `si.id, si.source, si.subject, si.occurred_at, si.author_identity,
              si.thread_external_id`;

// The Snowball English stop words Postgres's `english` config drops (its
// english.stop): to_tsvector and websearch_to_tsquery never match on them,
// so neither does this (plan 3.4: also what kept loose queries slow).
const STOP = new Set(
  ('i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself ' +
    'it its itself they them their theirs themselves what which who whom this that these those am is are was were be ' +
    'been being have has had having do does did doing a an the and but if or because as until while of at by for with ' +
    'about against between into through during before after above below to from up down in out on off over under again ' +
    'further then once here there when where why how all any both each few more most other some such no nor not only own ' +
    'same so than too very s t can will just don should now').split(' ')
);

/** Source and date filters as SQL starting with `and` (or empty); pushes its parameters. */
function filterSql({ sources, since, until }: Filters = {}, params: unknown[]) {
  const parts = [];
  if (sources?.length) {
    params.push(sources);
    parts.push(`si.source in (select value from json_each($${params.length}))`);
  }
  if (since) {
    params.push(new Date(since));
    parts.push(`si.occurred_at >= $${params.length}`);
  }
  if (until) {
    params.push(new Date(until));
    parts.push(`si.occurred_at <= $${params.length}`);
  }
  return parts.length ? `and ${parts.join(' and ')}` : '';
}

const words = (s: unknown): string[] => String(s || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
const quote = (w: string) => `"${w.replace(/"/g, '""')}"`;

/**
 * The FTS5 MATCH expression for `q` and the plain terms it looks for (for the
 * snippet), or null when nothing searchable is left.
 */
function ftsQuery(q: string, strict: unknown) {
  const text = String(q || '');
  if (!strict) {
    const terms = [...new Set(words(text))];
    const kept = terms.filter((t) => !STOP.has(t));
    const use = kept.length ? kept : terms;
    return use.length ? { match: use.map(quote).join(' OR '), terms: use } : null;
  }
  // websearch_to_tsquery: "a phrase", -excluded, `or` between terms, else AND.
  const groups: string[][] = [[]]; // OR of ANDs
  const not: string[] = [];
  const terms: string[] = [];
  const re = /(-?)"([^"]*)"|(-?)(\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    const neg = Boolean(m[1] || m[3]);
    const raw = (m[2] !== undefined ? m[2] : m[4]) ?? '';
    if (m[2] === undefined && raw.toLowerCase() === 'or') {
      if (groups[groups.length - 1]?.length) groups.push([]);
      continue;
    }
    // A lone stop word is dropped, as websearch_to_tsquery drops it; a quoted phrase keeps all its words.
    const ws = m[2] !== undefined ? words(raw) : words(raw).filter((w) => !STOP.has(w));
    if (!ws.length) continue;
    const expr = ws.length > 1 ? quote(ws.join(' ')) : quote(ws[0] ?? '');
    if (neg) not.push(expr);
    else {
      groups[groups.length - 1]?.push(expr);
      terms.push(...ws);
    }
  }
  const ors = groups.filter((g) => g.length).map((g) => (g.length > 1 ? `(${g.join(' AND ')})` : g[0]));
  if (!ors.length) return null;
  let match = ors.length > 1 ? `(${ors.join(' OR ')})` : ors[0];
  for (const n of not) match = `${match} NOT ${n}`;
  return { match, terms };
}

/** ~28 words of `content` around the first word that starts like a term. */
function snippet(content: unknown, terms: string[]) {
  const ws = String(content || '').split(/\s+/).filter(Boolean);
  const stems = terms.map((t) => t.slice(0, Math.max(3, t.length - 2)));
  let at = ws.findIndex((w) => {
    const lw = w.toLowerCase();
    return stems.some((s) => lw.includes(s));
  });
  if (at < 0) at = 0;
  const start = Math.max(0, at - 8);
  return ws.slice(start, start + 28).join(' ');
}

/** A float32 as pg's float4 text: the shortest decimal that reads back the same. */
function f4(x: number) {
  if (!Number.isFinite(x)) return String(x);
  for (let p = 1; p <= 9; p++) {
    const s = Number(x.toPrecision(p));
    if (Math.fround(s) === x) return String(s);
  }
  return String(x);
}

/** pgvector's text for a vector column value (Float32Array or BLOB). */
function vectorText(v: unknown) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  const f = Buffer.isBuffer(v) ? new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : (v as ArrayLike<number>);
  return `[${Array.from(f, f4).join(',')}]`;
}

/** A vector argument ('[...]' literal, array or Float32Array) as the BLOB a column holds. */
function blob(v: unknown) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  return vectorBlob(typeof v === 'string' ? JSON.parse(v) : v);
}

function create(db: Db) {
  return {
    /** Chunks whose context header predates `contextVersion`, with their item. */
    async staleChunks(contextVersion: unknown, limit: number) {
      return db.rows(
        `select c.id, si.source, si.subject, si.occurred_at, si.author_identity, si.raw
       from chunk c join source_item si on si.id = c.source_item_id
      where c.context_v <> $1
      order by c.id desc limit $2`,
        [contextVersion, limit]
      );
    },

    /** Re-heads a chunk and clears its embedding so the next backfill redoes it. */
    async reheadChunk(id: number | string, context: unknown, contextVersion: unknown) {
      await db.query('update chunk set context = $2, context_v = $3, embedding = null where id = $1', [id, context, contextVersion]);
    },

    /** Chunks with no embedding, newest first. */
    async chunksMissingEmbedding(limit: number) {
      return db.rows('select id, context, content from chunk where embedding is null order by id desc limit $1', [limit]);
    },

    /** Sets a chunk's embedding (a '[...]' literal, or an array). */
    async setChunkEmbedding(id: number | string, vector: unknown) {
      await db.query('update chunk set embedding = $2 where id = $1', [id, blob(vector)]);
    },

    /** Lexical leg: the best chunk per item for the query (see the header). */
    async lexicalPass(q: string, limit: number, filters: Filters | null | undefined, strict: unknown) {
      const fq = ftsQuery(q, strict);
      if (!fq) return [];
      const params = [fq.match, limit];
      const where = filterSql(filters ?? {}, params);
      // Ranks on narrow columns only (chunk id, item, ord), keeps the top
      // `limit` items, and reads text for those rows alone: a common word
      // matches ~20k chunks, and reading each one's content made this ~400 ms
      // (plan 3.4). An item ranks by its best chunk; it shows its first
      // matching chunk (lowest ord), as before.
      // Without source/date filters, only each index's best TOP_CHUNKS chunks
      // can make the top items (FTS5 orders by bm25 itself); with filters every
      // match is ranked, since a filter could leave the top ones out.
      const cap = where ? '' : ` order by rank limit ${TOP_CHUNKS}`;
      // The loose pass (any term) asks the stemmed index only: its stems already
      // match every word the exact index would, and ranking ~25k matches a second
      // time was most of a loose query's time (plan 3.4).
      const exact = strict ? `union all
         select * from (select rowid as cid, -rank as r from chunk_fts_exact where chunk_fts_exact match $1${cap})` : '';
      const rows = await db.rows(
        `with m as (
         select * from (select rowid as cid, -rank as r from chunk_fts where chunk_fts match $1${cap})
         ${exact}
       ), hits as materialized (
         select c.source_item_id as sid, b.cid, c.ord, b.rank
           from (select cid, max(r) as rank from m group by cid) b join chunk c on c.id = b.cid
       ), items as (
         select sid, max(rank) as rank from hits group by sid
       ), top as (
         select i.sid, i.rank, si.occurred_at from items i join source_item si on si.id = i.sid
          where 1 = 1 ${where}
          order by i.rank desc, si.occurred_at desc limit $2
       ), first as (
         select h.sid, (select h2.cid from hits h2 where h2.sid = h.sid order by h2.ord, h2.cid limit 1) as cid
           from top h
       )
     select ${ITEM}, c.id as chunk_id, c.context, substr(c.content, 1, 2000) as content, t.rank
       from top t join first f on f.sid = t.sid
       join source_item si on si.id = t.sid join chunk c on c.id = f.cid
      order by t.rank desc, t.occurred_at desc`,
        params
      );
      return rows.map((r) => ({ ...r, snippet: snippet(r.content, fq.terms) }));
    },

    /** Vector leg: the nearest chunk per item (cosine), always an exact scan. */
    async vectorPass(vector: unknown, limit: number, filters: Filters | null | undefined) {
      // Two stages (sql-sqlite/007): every chunk ranked by Hamming distance on
      // its sign bits, then the best CANDIDATES re-ranked by exact cosine.
      const q = blob(vector);
      const params = [q, limit, limit * 4];
      const where = filterSql(filters ?? {}, params);
      params.push(signBits(q), Math.max(CANDIDATES, limit * 10));
      const bitsAt = params.length - 1;
      const rows = await db.rows(
        `select * from (
         select ${ITEM}, c.id as chunk_id, c.context,
                substr(c.content, 1, 2000) as content, substr(c.content, 1, 240) as snippet, 1 - c.dist as rank,
                row_number() over (partition by c.source_item_id order by c.dist) as rn
           from (select c.id, c.source_item_id, c.context, c.content, vec_distance_cosine(c.embedding, $1) as dist
                   from (select b.id from chunk_bits b
                           join chunk c on c.id = b.id join source_item si on si.id = c.source_item_id
                          where 1 = 1 ${where}
                          order by ${hammingSql('b.bits', `$${bitsAt}`)} limit $${bitsAt + 1}) k
                   join chunk c on c.id = k.id
                  order by dist limit $3) c
           join source_item si on si.id = c.source_item_id
       ) x where rn = 1
       order by x.rank desc limit $2`,
        params
      );
      return rows.map(({ rn, ...r }) => r);
    },

    /** Everyone with their identity strings ('kind:value'). */
    async knownPeople() {
      const rows = await db.rows(
        `select p.id, p.display_name, p.is_me,
            coalesce(json_group_array(pi.kind || ':' || pi.value) filter (where pi.id is not null), '[]') as identities
       from person p left join person_identity pi on pi.person_id = p.id
      group by p.id`
      );
      return rows.map((r) => ({ ...r, identities: typeof r.identities === 'string' ? JSON.parse(r.identities) : r.identities }));
    },

    /** People leg: recent items authored by, or mentioning, the named people. */
    async peopleItems(authors: unknown, patterns: unknown, limit: number, filters: Filters | null | undefined) {
      const params = [authors || [], patterns || [], limit];
      const where = filterSql(filters ?? {}, params);
      return db.rows(
        `select ${ITEM}, c.id as chunk_id, coalesce(c.context, '') as context,
            substr(coalesce(c.content, si.body_text), 1, 2000) as content,
            substr(coalesce(c.content, si.body_text), 1, 240) as snippet,
            (julianday(si.occurred_at) - 2440587.5) * 86400.0 as rank
       from source_item si
       left join chunk c on c.source_item_id = si.id and c.ord = 0
      where (si.author_identity in (select value from json_each($1))
             or exists (select 1 from json_each($2) p where si.raw like p.value escape '\\')) ${where}
      order by si.occurred_at desc
      limit $3`,
        params
      );
    },

    /** Items by id, with their first chunk's words. */
    async itemsById(ids: unknown[]) {
      return db.rows(
        `select si.id, si.source, si.subject, si.occurred_at, si.author_identity, si.thread_external_id,
            c.context, substr(coalesce(c.content, si.body_text), 1, 2000) as text,
            substr(coalesce(c.content, si.body_text), 1, 240) as snippet
       from source_item si left join chunk c on c.source_item_id = si.id and c.ord = 0
      where si.id in (select value from json_each($1))`,
        [(ids || []).map(Number)]
      );
    },

    // ----------------------------------------- query_embedding_cache

    /** Counts a hit and returns the cached vector as text ('[...]'), or null. */
    async cacheGet(model: string, dims: unknown, norm: unknown) {
      const r = await db.query(
        `update query_embedding_cache set hits = hits + 1, last_used_at = ${NOW}
          where model = $1 and dims = $2 and query_norm = $3 returning embedding`,
        [model, dims, norm]
      );
      return r.rows && r.rows[0] ? vectorText(r.rows[0].embedding) : null;
    },

    /** Stores a vector under the normalized query; a repeat refreshes last_used_at. */
    async cachePut(model: string, dims: unknown, norm: unknown, vector: unknown) {
      await db.query(
        `insert into query_embedding_cache (model, dims, query_norm, embedding) values ($1, $2, $3, $4)
         on conflict (model, dims, query_norm) do update set last_used_at = ${NOW}`,
        [model, dims, norm, blob(vector)]
      );
    },

    /** Keeps the newest `maxRows` entries by last use. */
    async cacheTrim(maxRows: unknown) {
      await db.query(
        `delete from query_embedding_cache where rowid in (
             select rowid from query_embedding_cache order by last_used_at desc limit -1 offset $1)`,
        [maxRows]
      );
    },
  };
}

module.exports = { create, filterSql, ftsQuery };
