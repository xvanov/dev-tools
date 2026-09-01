'use strict';

// Hybrid retrieval over captured items.
//
// Lexical first-class, not as a fallback. The queries this store actually gets
// are full of the things embeddings are worst at — surnames, ticket ids, branch
// names, `GridHelpers`, `INNERGY`. Full-text finds those exactly; the vector
// side is what rescues a query phrased differently from the message. Fusing
// ranks (see fuse.js) keeps both honest.
//
// Embeddings are optional. With no Azure endpoint configured this degrades to
// lexical-only search and says so, rather than returning nothing.

const { rows, query } = require('../db');
const { config } = require('../config');
const { fuse } = require('./fuse');
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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': config.embeddings.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, dimensions: config.embeddings.dimensions }),
  });
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

// Backfills embeddings for chunks that have none. Runs from the worker; the
// search path never blocks on it, which is why lexical has to stand alone.
async function backfillEmbeddings({ limit = 128 } = {}) {
  if (!embeddingsConfigured()) return { embedded: 0, skipped: true };

  const pending = await rows(
    'select id, content from chunk where embedding is null order by id desc limit $1',
    [limit]
  );
  if (!pending.length) return { embedded: 0, skipped: false };

  const vectors = await embed(pending.map((c) => c.content.slice(0, 8000)));
  if (!vectors) return { embedded: 0, skipped: true };

  for (let i = 0; i < pending.length; i++) {
    await query('update chunk set embedding = $2::vector where id = $1', [
      pending[i].id,
      toVectorLiteral(vectors[i]),
    ]);
  }
  log.info('embedded', { count: pending.length });
  return { embedded: pending.length, skipped: false };
}

const SELECT_ITEM = `
  si.id, si.source, si.subject, si.occurred_at, si.author_identity,
  si.thread_external_id
`;

async function lexical(q, limit) {
  return rows(
    `select ${SELECT_ITEM},
            -- StartSel/StopSel are emptied deliberately: these snippets are
            -- read in a terminal and fed to a model, and neither wants <b>.
            ts_headline('english', c.content, plainto_tsquery('english', $1),
                        'MaxFragments=1,MaxWords=28,MinWords=8,StartSel=,StopSel=') as snippet,
            ts_rank(c.tsv, plainto_tsquery('english', $1)) as rank
       from chunk c join source_item si on si.id = c.source_item_id
      where c.tsv @@ plainto_tsquery('english', $1)
      order by rank desc, si.occurred_at desc
      limit $2`,
    [q, limit]
  );
}

async function vector(q, limit) {
  const vectors = await embed([q]);
  if (!vectors) return [];
  return rows(
    `select ${SELECT_ITEM},
            left(c.content, 240) as snippet,
            1 - (c.embedding <=> $1::vector) as rank
       from chunk c join source_item si on si.id = c.source_item_id
      where c.embedding is not null
      order by c.embedding <=> $1::vector
      limit $2`,
    [toVectorLiteral(vectors[0]), limit]
  );
}

async function search(q, { limit = 12, sources = null } = {}) {
  const pool = Math.max(limit * 3, 30);
  const [lex, vec] = await Promise.all([lexical(q, pool), vector(q, pool)]);

  // Lexical is weighted higher on purpose: when someone searches this corpus
  // they usually know a word that was actually in the message.
  const fused = fuse([lex, vec], [1.2, 1.0]);

  const seen = new Set();
  const out = [];
  for (const hit of fused) {
    if (seen.has(hit.row.id)) continue;
    seen.add(hit.row.id);
    if (sources && !sources.includes(hit.row.source)) continue;
    out.push({ ...hit.row, score: hit.score, matched: hit.sources.length > 1 ? 'both' : hit.sources[0] === 0 ? 'text' : 'meaning' });
    if (out.length >= limit) break;
  }

  return { results: out, lexicalOnly: vec.length === 0, embedError: vec.length ? null : lastEmbedError };
}

module.exports = {
  search,
  backfillEmbeddings,
  embed,
  embeddingsConfigured,
  lastEmbedError: () => lastEmbedError,
};
