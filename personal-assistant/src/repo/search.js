'use strict';

// Aggregate: search. Tables: chunk (the retrieval index over source_item) and
// query_embedding_cache. Callers: src/search (index.js, embedCache.js),
// src/recall.
//
// The lexical and vector legs use Postgres features (tsvector, websearch_to_
// tsquery, ts_headline, pgvector `<=>`, `set local hnsw.ef_search`); each is one
// method, so phase 3 can reimplement it for SQLite (FTS5 / sqlite-vec) without
// touching the fusion in src/search. Embeddings travel as the '[0.1,...]'
// literal callers format. The filters object is {sources, since, until}.

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

/**
 * @typedef {object} LegRow  one item's best chunk, as every retrieval leg returns it
 * @property {number|string} id  the source_item id
 * @property {string} source
 * @property {string|null} subject
 * @property {Date} occurred_at
 * @property {string|null} author_identity
 * @property {string|null} thread_external_id
 * @property {number|string} chunk_id
 * @property {string|null} context
 * @property {string} content
 * @property {string} snippet
 * @property {number} rank  leg-specific relevance, only meaningful as an order
 */

function create(db) {
  return {
    /** Chunks whose context header predates `contextVersion`, with their item. */
    async staleChunks(contextVersion, limit) {
      return db.rows(
        `select c.id, si.source, si.subject, si.occurred_at, si.author_identity, si.raw
       from chunk c join source_item si on si.id = c.source_item_id
      where c.context_v <> $1
      order by c.id desc limit $2`,
        [contextVersion, limit]
      );
    },

    /** Re-heads a chunk and clears its embedding so the next backfill redoes it. */
    async reheadChunk(id, context, contextVersion) {
      await db.query('update chunk set context = $2, context_v = $3, embedding = null where id = $1', [
        id,
        context,
        contextVersion,
      ]);
    },

    /** Chunks with no embedding, newest first. */
    async chunksMissingEmbedding(limit) {
      return db.rows('select id, context, content from chunk where embedding is null order by id desc limit $1', [limit]);
    },

    /** Sets a chunk's embedding (a '[...]' literal). */
    async setChunkEmbedding(id, vector) {
      await db.query('update chunk set embedding = $2::vector where id = $1', [id, vector]);
    },

    /**
     * Lexical leg: the best chunk per item for the query, ranked by ts_rank over
     * the stemmed and exact tsvectors, with a headline snippet.
     * @param {boolean} strict  websearch syntax (all terms) when true, any term when false
     * @returns {Promise<LegRow[]>}
     */
    async lexicalPass(q, limit, filters, strict) {
      const params = [q, limit];
      const where = filterSql(filters, params);
      return db.rows(
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
    },

    /**
     * Vector leg: the nearest chunk per item (pgvector cosine). A filtered query
     * scans exactly (pgvector 0.6 has no iterative scan, so HNSW + a filter can
     * return nothing); an unfiltered one uses the index with ef_search 200.
     * @param {string} vector  the query's '[...]' literal
     * @returns {Promise<LegRow[]>}
     */
    async vectorPass(vector, limit, filters) {
      const params = [vector, limit, limit * 4];
      const where = filterSql(filters, params);
      return db.withTx(async (client) => {
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
    },

    /** Everyone with their identity strings ('kind:value'), for the people leg's name matching. */
    async knownPeople() {
      return db.rows(
        `select p.id, p.display_name, p.is_me,
            coalesce(array_agg(pi.kind || ':' || pi.value) filter (where pi.id is not null), '{}') as identities
       from person p left join person_identity pi on pi.person_id = p.id
      group by p.id`
      );
    },

    /**
     * People leg: recent items authored by, or mentioning, the named people.
     * @param {string[]} authors   author_identity spellings
     * @param {string[]} patterns  ilike patterns over the raw payload
     * @returns {Promise<LegRow[]>}
     */
    async peopleItems(authors, patterns, limit, filters) {
      const params = [authors, patterns, limit];
      const where = filterSql(filters, params);
      return db.rows(
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
    },

    /** Items by id, with their first chunk's words (recall: the items behind claims). */
    async itemsById(ids) {
      return db.rows(
        `select si.id, si.source, si.subject, si.occurred_at, si.author_identity, si.thread_external_id,
            c.context, left(coalesce(c.content, si.body_text), 2000) as text,
            left(coalesce(c.content, si.body_text), 240) as snippet
       from source_item si left join chunk c on c.source_item_id = si.id and c.ord = 0
      where si.id = any($1::bigint[])`,
        [ids]
      );
    },

    // ----------------------------------------- query_embedding_cache (embedCache.js)

    /**
     * Counts a hit and returns the cached vector as text ('[...]'), or null.
     * Best effort by contract: callers treat a throw as a miss.
     */
    async cacheGet(model, dims, norm) {
      const r = await db.query(
        `update query_embedding_cache set hits = hits + 1, last_used_at = now()
          where model = $1 and dims = $2 and query_norm = $3 returning embedding::text as embedding`,
        [model, dims, norm]
      );
      return r.rows && r.rows[0] ? r.rows[0].embedding : null;
    },

    /** Stores a vector (a '[...]' literal) under the normalized query; a repeat refreshes last_used_at. */
    async cachePut(model, dims, norm, vector) {
      await db.query(
        `insert into query_embedding_cache (model, dims, query_norm, embedding) values ($1, $2, $3, $4::vector)
         on conflict (model, dims, query_norm) do update set last_used_at = now()`,
        [model, dims, norm, vector]
      );
    },

    /** Keeps the newest `maxRows` entries by last use. */
    async cacheTrim(maxRows) {
      await db.query(
        `delete from query_embedding_cache where (model, dims, query_norm) in (
             select model, dims, query_norm from query_embedding_cache order by last_used_at desc offset $1)`,
        [maxRows]
      );
    },
  };
}

module.exports = { create, filterSql };
