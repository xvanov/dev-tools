'use strict';

// Hybrid retrieval over captured items.
//
// Three legs, fused, then reranked:
//
//  - **lexical** â€” first-class, not a fallback. The queries this store gets are
//    full of what embeddings are worst at: surnames, ticket keys, branch names,
//    `GridHelpers`, `INNERGY`. Two tsvectors: `english` (stemmed) for prose and
//    `simple` for exact tokens. `websearch_to_tsquery` first (AND of terms);
//    when that finds little â€” a long question from an agent rarely has every
//    word in one message â€” an OR of the same terms tops the list up.
//  - **vector** â€” rescues a query phrased differently from the message.
//  - **people** â€” a query that names a colleague pulls their recent items
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

const repo = require('../repo');
const { config } = require('../config');
const { fuse } = require('./fuse');
const { chunkContext, CONTEXT_VERSION } = require('./context');
const { mentionedPeople } = require('./entities');
const { rerank, rerankConfigured, lastRerankError } = require('./rerank');
const { logger } = require('../log');
const budget = require('../budget');
const { createQueryEmbedder, tableStore } = require('./embedCache');

const log = logger('search');

function embeddingsConfigured() {
  return Boolean(config.embeddings.endpoint && config.embeddings.apiKey);
}

// Returns null when embeddings are unavailable for any reason â€” unconfigured,
// wrong deployment name, endpoint down. `lastEmbedError` carries the why, so
// the CLI can say "the endpoint 404s" instead of "not configured", which sends
// you looking in the wrong place.
let lastEmbedError = null;

//
// Every call is metered: tokens come from the endpoint's own `usage`, the price
// from config.embeddings.usdPerMTokens, and the row lands in llm_spend under
// `purpose` (so `pa spend` and the dashboard's Meter show embedding spend).
// The result is the array of vectors, with `.usage = {tokens, usd}` attached.
async function embed(texts, { purpose = 'embed' } = {}) {
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
  const started = Date.now();
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
    await budget.record({
      purpose, model: config.embeddings.deployment, backend: 'azure', costUsd: 0,
      durationMs: Date.now() - started, ok: false,
    });
    return null;
  }
  lastEmbedError = null;
  const payload = await res.json();
  const out = payload.data.map((d) => d.embedding);
  const tokens = embedTokens(payload, texts);
  const usd = (tokens * config.embeddings.usdPerMTokens) / 1e6;
  await budget.record({
    purpose, model: config.embeddings.deployment, backend: 'azure', costUsd: usd, inputTokens: tokens,
    durationMs: Date.now() - started, ok: true,
  });
  out.usage = { tokens, usd };
  return out;
}

// The endpoint reports tokens; if it ever does not, ~4 characters per token.
function embedTokens(payload, texts) {
  const n = Number(payload?.usage?.total_tokens ?? payload?.usage?.prompt_tokens);
  if (Number.isFinite(n) && n >= 0) return n;
  return texts.reduce((sum, s) => sum + Math.ceil(String(s).length / 4), 0);
}

// Query-time embeds only (never ingest): normalized text -> vector, from an LRU
// in memory, then the query_embedding_cache table, then the endpoint. Returns
// one vector or null; throws what embed() throws.
const queryEmbedder = createQueryEmbedder({
  embedFn: async (text) => (await embed([text], { purpose: 'embed-query' }))?.[0] || null,
  model: () => config.embeddings.deployment,
  dims: () => config.embeddings.dimensions,
  max: config.embeddings.cacheEntries,
  store: tableStore({ maxRows: config.embeddings.cacheRows }),
});
const embedQuery = (q) => queryEmbedder.get(q);

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
  const stale = await repo.search.staleChunks(CONTEXT_VERSION, limit);
  for (const c of stale) {
    await repo.search.reheadChunk(c.id, chunkContext(c), CONTEXT_VERSION);
  }
  if (stale.length) log.info('re-headed chunks', { count: stale.length });
  return stale.length;
}

// Backfills embeddings for chunks that have none. Runs from the worker; the
// search path never blocks on it, which is why lexical has to stand alone.
async function backfillEmbeddings({ limit = 128 } = {}) {
  await backfillContext();
  if (!embeddingsConfigured()) return { embedded: 0, skipped: true };

  const pending = await repo.search.chunksMissingEmbedding(limit);
  if (!pending.length) return { embedded: 0, skipped: false };

  let embedded = 0;
  // The endpoint takes a batch, but a few hundred long chunks in one request
  // runs into its token limit; 64 at a time stays well under.
  for (let i = 0; i < pending.length; i += 64) {
    const batch = pending.slice(i, i + 64);
    const vectors = await embed(batch.map(embeddingInput), { purpose: 'embed-chunk' });
    if (!vectors) break;
    for (let j = 0; j < batch.length; j++) {
      await repo.search.setChunkEmbedding(batch[j].id, toVectorLiteral(vectors[j]));
    }
    embedded += batch.length;
  }
  if (embedded) log.info('embedded', { count: embedded });
  return { embedded, skipped: embedded === 0 };
}

// ------------------------------------------------------------- the legs ---

// The SQL of every leg (and filterSql, which builds their source/date filter)
// lives in src/repo/search.js.

async function lexicalPass(q, limit, filters, strict) {
  return repo.search.lexicalPass(q, limit, filters, strict);
}

async function lexical(q, limit, filters) {
  const strict = await lexicalPass(q, limit, filters, true);
  if (strict.length >= Math.ceil(limit / 3)) return strict;
  const loose = await lexicalPass(q, limit, filters, false);
  const seen = new Set(strict.map((r) => r.id));
  return [...strict, ...loose.filter((r) => !seen.has(r.id))].slice(0, limit);
}

async function vector(q, limit, filters) {
  const qv = await embedQuery(q);
  if (!qv) return [];
  return repo.search.vectorPass(toVectorLiteral(qv), limit, filters);
}

let peopleCache = { at: 0, list: [] };
async function knownPeople() {
  if (Date.now() - peopleCache.at < 5 * 60_000) return peopleCache.list;
  const list = await repo.search.knownPeople();
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
  return repo.search.peopleItems(authors, patterns, limit, filters);
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
  embedTokens,
  embedQuery,
  queryEmbedder,
  embeddingInput,
  embeddingsConfigured,
  filterSql: require('../repo/search.ts').filterSql,
  lastEmbedError: () => lastEmbedError,
};
