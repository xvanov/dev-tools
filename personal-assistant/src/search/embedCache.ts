'use strict';

// Query-embedding cache (docs/native/PLAN.md 0.2, Embeddings policy D5).
//
// A search embeds the user's query on every call. The same question again must
// cost nothing: the vector is kept under the normalized query text (trimmed,
// whitespace collapsed, lower-cased) plus the model and dimensions that made
// it, in an in-memory LRU backed by the `query_embedding_cache` table so it
// survives a worker restart and is shared with `pa` processes.
//
// Query-time embeds only. Ingest embeds (chunks, claims, pages, commitments)
// are embedded once and stored on their own rows; they never come through here.
//
// The persistent store is best effort by contract: a missing table or a dropped
// connection costs the hit, never the search.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;

// "  What did   Acme say?\n" and "what did acme say?" are one question.
function normalizeQuery(q: string) {
  return String(q == null ? '' : q).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Map keeps insertion order: the first key is the least recently used.
class Lru {
  max: number;
  map: Map<number | string, any>;
  constructor(max: number) {
    this.max = Math.max(1, Number(max) || 1);
    this.map = new Map();
  }
  get(key: number | string) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: number | string, value: unknown) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as number | string);
  }
  get size() {
    return this.map.size;
  }
}

function toVectorLiteral(values: unknown[]) {
  return `[${values.map((v: unknown) => Number(v).toFixed(6)).join(',')}]`;
}

function parseVector(text: string) {
  const s = String(text || '').replace(/^\[|\]$/g, '');
  if (!s) return null;
  const out = s.split(',').map(Number);
  return out.every(Number.isFinite) ? out : null;
}

/**
 * The table-backed store (SQL in src/repo/search.js). `db` is an injectable
 * backend with a `query`; by default the process's repository set, loaded lazily.
 */
function tableStore({ db, maxRows = 5000 }: { db?: Row; maxRows?: number } = {}) {
  const s = () => (db ? require('../repo').createRepos(db) : require('../repo')).search;
  let puts = 0;
  return {
    async get(model: string, dims: number, norm: string) {
      return parseVector(await s().cacheGet(model, dims, norm));
    },
    async put(model: string, dims: number, norm: string, vector: unknown[]) {
      await s().cachePut(model, dims, norm, toVectorLiteral(vector));
      // Trim to the newest `maxRows` by last use, every so often rather than on every write.
      if (++puts % 25 === 0) await s().cacheTrim(maxRows);
    },
  };
}

/**
 * @param {object} o
 * @param {(text: string) => Promise<number[]|null>} o.embedFn embeds ONE already-normalized text
 * @param {() => string} o.model  current deployment name (read per call: config can change)
 * @param {() => number} o.dims   current dimensions
 * @param {number} [o.max]        in-memory entries
 * @param {{get: Function, put: Function}|null} [o.store] persistent layer; null = memory only
 */
function createQueryEmbedder({ embedFn, model, dims, max = 500, store = null }: { embedFn: (text: string) => Promise<number[] | null>; model: () => string; dims: () => number; max?: number; store?: { get(m: string, d: number, n: string): Promise<number[] | null>; put(m: string, d: number, n: string, v: number[]): unknown } | null }) {
  const lru = new Lru(max);
  const stats = { memoryHits: 0, storeHits: 0, misses: 0 };
  let warned = false;
  const soft = (err: any) => {
    if (!warned) {
      warned = true;
      try {
        require('../log.ts').logger('embedCache').warn('query-embedding store unavailable — is the store migrated?', { message: err.message });
      } catch {}
    }
  };

  async function get(q: string) {
    const norm = normalizeQuery(q);
    if (!norm) return null;
    const m = model();
    const d = dims();
    const key = `${m}|${d}|${norm}`;

    const hit = lru.get(key);
    if (hit) {
      stats.memoryHits++;
      return hit;
    }
    if (store) {
      try {
        const v = await store.get(m, d, norm);
        if (v && v.length === d) {
          lru.set(key, v);
          stats.storeHits++;
          return v;
        }
      } catch (err) {
        soft(err);
      }
    }
    stats.misses++;
    // The normalized text is what is embedded, so a hit and a miss return the same vector.
    const v = await embedFn(norm);
    if (!v) return null; // failures are never cached
    lru.set(key, v);
    if (store) await Promise.resolve(store.put(m, d, norm, v)).catch(soft);
    return v;
  }

  return { get, stats, size: () => lru.size, clear: () => lru.map.clear() };
}

module.exports = { normalizeQuery, Lru, createQueryEmbedder, tableStore, parseVector, toVectorLiteral };
