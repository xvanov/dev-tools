'use strict';

// Hybrid retrieval over captured items.
//
// Three legs, fused, then reranked:
//
//  - **lexical** — first-class, not a fallback. The queries this store gets are
//    full of what embeddings are worst at: surnames, ticket keys, branch names,
//    `GridHelpers`, `INNERGY`. Two tsvectors: `english` (stemmed) for prose and
//    `simple` for exact tokens. `websearch_to_tsquery` first (AND of terms);
//    when that finds little — a long question from an agent rarely has every
//    word in one message — an OR of the same terms tops the list up.
//  - **vector** — rescues a query phrased differently from the message.
//  - **people** — a query that names a colleague pulls their recent items
//    (see entities.js).
//
// Every leg returns one row per *item* (its best chunk) before fusion. Fusing
// chunks would let a long email collect a score from each of its paragraphs
// and outrank a short message that answers the question.
//
// Filters (source, date) are applied inside each leg, not after fusion, so a
// narrow filter still returns `limit` results.
//
// The fused top candidates then go through a cross-encoder (rerank.js) whose
// scores are absolute: `score` on a reranked result is a relevance in [0,1],
// which callers can threshold. Without the reranker, `score` is the RRF score
// and only meaningful as an order.
//
// Embeddings and reranking are optional. Without them this degrades to
// lexical-only, fused order, and says so.

const { rows, query, withTx } = require('../db');
const { config } = require('../config');
const { fuse } = require('./fuse');
const { chunkContext, CONTEXT_VERSION } = require('./context');
const { mentionedPeople } = require('./entities');
const { rerank, rerankConfigured, lastRerankError } = require('./rerank');
const { logger } = require('../log');

const log = logger('search');

function embeddingsConfigured() {
  return Boolean(config.embeddings.endpoint && config.embeddings.apiKey);
}

// Returns null when embeddings are unavailable for any reason — unconfigured,
// wrong deployment name, endpoint down. `lastEmbedError` carries the why, so
// the CLI can say "the endpoint 404s" instead of "not configured", which sends
// you looking in the wrong place.
let lastEmbedError = null;

async function embed(texts) {
  if (!embeddingsConfigured()) {
    lastEmbedError = 'no endpoint configured';
    return null;
  }
  const base = config.embeddings.endpoint.replace(/\/+$/, '');
  const url =
    `${base}/openai/deployments/${config.embeddings.deployment}/embeddings` +
    `?api-version=${config.embeddings.apiVersion}`;

  // The deployment's tokens-per-minute quota is shared; a backfill hits it.
  // Waiting what the endpoint asks is cheaper than failing the batch.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': config.embeddings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, dimensions: config.embeddings.dimensions }),
    });
    if (res.status !== 429 || attempt >= 4) break;
    const wait = Math.min(60, Number(res.headers.get('retry-after')) || 10 * (attempt + 1));
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  if (!res.ok) {
    lastEmbedError = `endpoint returned ${res.status} for deployment "${config.embeddings.deployment}"`;
    log.warn('embedding call failed', { status: res.status });
    return null;
  }
  lastEmbedError = null;
  const payload = await res.json();
  return payload.data.map((d) => d.embedding);
}

function toVectorLiteral(values) {
  return `[${values.map((v) => Number(v).toFixed(6)).join(',')}]`;
}

// What gets embedded for a chunk: its context line, then its words.
function embeddingInput(chunk) {
  return (chunk.context ? `${chunk.context}\n\n${chunk.content}` : chunk.content).slice(0, 8000);
}

// Re-heads chunks written before the current context format (or before there
// was one) and clears their embedding so the next backfill re-embeds them
// with the header included.
async function backfillContext({ limit = 2000 } = {}) {
  const stale = await rows(
    `select c.id, si.source, si.subject, si.occurred_at, si.author_identity, si.raw
       from chunk c join source_item si on si.id = c.source_item_id
      where c.context_v <> $1
      order by c.id desc limit $2`,
    [CONTEXT_VERSION, limit]
  );
  for (const c of stale) {
    await query('update chunk set context = $2, context_v = $3, embedding = null where id = $1', [
      c.id,
      chunkContext(c),
      CONTEXT_VERSION,
    ]);
  }
  if (stale.length) log.info('re-headed chunks', { count: stale.length });
  return stale.length;
}

// Backfills embeddings for chunks that have none. Runs from the worker; the
// search path never blocks on it, which is why lexical has to stand alone.
async function backfillEmbeddings({ limit = 128 } = {}) {
  await backfillContext();
  if (!embeddingsConfigured()) return { embedded: 0, skipped: true };

  const pending = await rows(
    'select id, context, content from chunk where embedding is null order by id desc limit $1',
    [limit]
  );
  if (!pending.length) return { embedded: 0, skipped: false };

  let embedded = 0;
  // The endpoint takes a batch, but a few hundred long chunks in one request
  // runs into its token limit; 64 at a time stays well under.
  for (let i = 0; i < pending.length; i += 64) {
    const batch = pending.slice(i, i + 64);
    const vectors = await embed(batch.map(embeddingInput));
    if (!vectors) break;
    for (let j = 0; j < batch.length; j++) {
      await query('update chunk set embedding = $2::vector where id = $1', [
        batch[j].id,
        toVectorLiteral(vectors[j]),
      ]);
    }
    embedded += batch.length;
  }
  if (embedded) log.info('embedded', { count: embedded });
  return { embedded, skipped: embedded === 0 };
}

// ------------------------------------------------------------- the legs ---

const ITEM = `si.id, si.source, si.subject, si.occurred_at, si.author_identity,
              si.thread_external_id`;

// Shared WHERE fragment for source and date filters. Appends its parameters
// to `params` and returns SQL that starts with `and` (or is empty).
function filterSql({ sources, since, until }, params) {
  const parts = [];
  if (sources?.length) {
    params.push(sources);
    parts.push(`si.source = any($${params.length})`);
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

// `strict` is websearch syntax (all terms, quoted phrases, -exclusions);
// otherwise any of the query's terms. The OR form is built from the lexemes
// Postgres itself extracts, so stop words drop out and nothing in the user's
// text is parsed as tsquery syntax.
function tsqueries(strict) {
  if (strict) {
    return `websearch_to_tsquery('english', $1) as e, websearch_to_tsquery('simple', $1) as s`;
  }
  const anyOf = (cfg) =>
    `to_tsquery('simple', array_to_string(array(
       select quote_literal(l) from unnest(tsvector_to_array(to_tsvector('${cfg}', $1))) l), ' | '))`;
  return `${anyOf('english')} as e, ${anyOf('simple')} as s`;
}

async function lexicalPass(q, limit, filters, strict) {
  const params = [q, limit];
  const where = filterSql(filters, params);
  return rows(
    `with q as (select ${tsqueries(strict)})
     select x.*,
            -- StartSel/StopSel are emptied deliberately: these snippets are
            -- read in a terminal and fed to a model, and neither wants <b>.
            ts_headline('english', x.content, (select e from q),
                        'MaxFragments=1,MaxWords=28,MinWords=8,StartSel=,StopSel=') as snippet
       from (
         select distinct on (si.id) ${ITEM}, c.id as chunk_id, c.context, left(c.content, 2000) as content,
                greatest(ts_rank(c.tsv, q.e), ts_rank(c.tsv_exact, q.s)) as rank
           from chunk c join source_item si on si.id = c.source_item_id, q
          where (c.tsv @@ q.e or c.tsv_exact @@ q.s) ${where}
          order by si.id, rank desc
       ) x
      order by x.rank desc, x.occurred_at desc
      limit $2`,
    params
  );
}

async function lexical(q, limit, filters) {
  const strict = await lexicalPass(q, limit, filters, true);
  if (strict.length >= Math.ceil(limit / 3)) return strict;
  const loose = await lexicalPass(q, limit, filters, false);
  const seen = new Set(strict.map((r) => r.id));
  return [...strict, ...loose.filter((r) => !seen.has(r.id))].slice(0, limit);
}

async function vector(q, limit, filters) {
  const vectors = await embed([q]);
  if (!vectors) return [];
  const params = [toVectorLiteral(vectors[0]), limit, limit * 4];
  const where = filterSql(filters, params);
  return withTx(async (client) => {
    // pgvector 0.6 has no iterative scan: HNSW returns ef_search candidates and
    // a filter applied to them can leave none — "Teams chats about X" in a
    // corpus that is mostly GitHub. A filtered query therefore scans exactly;
    // at this corpus size that is milliseconds, and it is always complete.
    if (where) await client.query('set local enable_indexscan = off');
    else await client.query('set local hnsw.ef_search = 200');
    const r = await client.query(
      `select x.* from (
         select distinct on (c.source_item_id) ${ITEM}, c.id as chunk_id, c.context,
                left(c.content, 2000) as content, left(c.content, 240) as snippet, 1 - c.dist as rank
           from (select c.id, c.source_item_id, c.context, c.content, c.embedding <=> $1::vector as dist
                   from chunk c join source_item si on si.id = c.source_item_id
                  where c.embedding is not null ${where}
                  order by c.embedding <=> $1::vector limit $3) c
           join source_item si on si.id = c.source_item_id
          order by c.source_item_id, c.dist
       ) x
       order by x.rank desc limit $2`,
      params
    );
    return r.rows;
  });
}

let peopleCache = { at: 0, list: [] };
async function knownPeople() {
  if (Date.now() - peopleCache.at < 5 * 60_000) return peopleCache.list;
  const list = await rows(
    `select p.id, p.display_name, p.is_me,
            coalesce(array_agg(pi.kind || ':' || pi.value) filter (where pi.id is not null), '{}') as identities
       from person p left join person_identity pi on pi.person_id = p.id
      group by p.id`
  );
  peopleCache = { at: Date.now(), list };
  return list;
}

// author_identity spellings per identity kind (see distill/identity.js).
function authorForms(identity) {
  const [kind, ...rest] = identity.split(':');
  const value = rest.join(':');
  if (kind === 'smtp') return [value];
  if (kind === 'aad_oid') return [`aad:${value}`];
  if (kind === 'github_username') return [`github:${value}`];
  if (kind === 'gitlab_username') return [`gitlab:${value}`];
  return [value];
}

async function people(q, limit, filters) {
  const all = await knownPeople();
  const ids = new Set(mentionedPeople(q, all));
  if (!ids.size) return [];
  const named = all.filter((p) => ids.has(p.id));
  const authors = named.flatMap((p) => p.identities.flatMap(authorForms));
  // Mentions in recipients, chat members and attendees: by email, and by full
  // display name where there is one.
  const patterns = [
    ...named.flatMap((p) => p.identities.filter((i) => i.startsWith('smtp:')).map((i) => `%${i.slice(5)}%`)),
    ...named.filter((p) => /\s/.test(p.display_name)).map((p) => `%${p.display_name}%`),
  ];
  const params = [authors, patterns, limit];
  const where = filterSql(filters, params);
  return rows(
    `select ${ITEM}, c.id as chunk_id, coalesce(c.context, '') as context,
            left(coalesce(c.content, si.body_text), 2000) as content,
            left(coalesce(c.content, si.body_text), 240) as snippet,
            extract(epoch from si.occurred_at) as rank
       from source_item si
       left join chunk c on c.source_item_id = si.id and c.ord = 0
      where (si.author_identity = any($1) or si.raw::text ilike any($2)) ${where}
      order by si.occurred_at desc
      limit $3`,
    params
  );
}

// ------------------------------------------------------------------ search --

const LEG_NAMES = ['text', 'meaning', 'person'];

/**
 * @param {string} q
 * @param {object} [opts]
 * @param {number} [opts.limit=12]
 * @param {string[]} [opts.sources]   source filter, applied inside each leg
 * @param {string|Date} [opts.since]  occurred_at lower bound
 * @param {string|Date} [opts.until]  occurred_at upper bound
 * @param {boolean} [opts.rerank=true]
 */
async function search(q, { limit = 12, sources = null, since = null, until = null, rerank: useRerank = true } = {}) {
  const filters = { sources, since, until };
  const pool = Math.max(limit * 3, 30);
  const [lex, vec, ppl] = await Promise.all([
    lexical(q, pool, filters),
    vector(q, pool, filters),
    people(q, pool, filters).catch((err) => {
      log.warn('people leg failed', { message: err.message });
      return [];
    }),
  ]);

  // Lexical is weighted higher on purpose: when someone searches this corpus
  // they usually know a word that was actually in the message. The people leg
  // is a recency list, not a relevance one, so it only nudges.
  let ranked = fuse([lex, vec, ppl], [1.2, 1.0, 0.6]).map((hit) => ({ ...hit, fused: hit.score }));

  let reranked = false;
  if (useRerank && rerankConfigured() && ranked.length > 1) {
    const candidates = ranked.slice(0, config.rerank.candidates);
    const order = await rerank(
      q,
      candidates.map((h) => `${h.row.context || ''}\n${h.row.content || h.row.snippet || ''}`.trim().slice(0, 1600))
    );
    if (order) {
      ranked = order.map((o) => ({ ...candidates[o.index], score: o.score }));
      reranked = true;
    }
  }

  const results = ranked.slice(0, limit).map((hit) => {
    const { content, context, chunk_id, rank, ...row } = hit.row;
    return {
      ...row,
      context,
      // The best chunk's words, for callers that rerank or quote further
      // (recall). Display code uses `snippet`.
      text: content,
      score: hit.score,
      fused: hit.fused,
      matched: [...new Set(hit.sources)].map((s) => LEG_NAMES[s]).join('+'),
    };
  });

  return {
    results,
    reranked,
    lexicalOnly: vec.length === 0,
    embedError: vec.length ? null : lastEmbedError,
    rerankError: useRerank && !reranked ? lastRerankError() : null,
  };
}

module.exports = {
  search,
  backfillEmbeddings,
  backfillContext,
  embed,
  embeddingInput,
  embeddingsConfigured,
  filterSql,
  lastEmbedError: () => lastEmbedError,
};
