'use strict';

// Cross-encoder reranking through Cohere Rerank on the Azure AI resource that
// already serves embeddings — same endpoint, same key, one more deployment.
//
// Fusion decides what is *in* the candidate set; the reranker decides the
// order. RRF only sees ranks, so it cannot tell a strong match from the best
// of a bad list. A cross-encoder reads query and document together, and its
// score is on an absolute scale — which is also what lets a caller say "nothing
// relevant" instead of returning the least-bad hit.
//
// Optional, like embeddings: unconfigured or failing, search keeps its fused
// order and says so.

const { config } = require('../config');
const { logger } = require('../log');

const log = logger('rerank');

let lastRerankError = null;

function rerankConfigured() {
  return Boolean(config.rerank.enabled && config.embeddings.endpoint && config.embeddings.apiKey);
}

// documents: strings. Returns [{index, score}] best first, or null.
async function rerank(query, documents, { topN = documents.length } = {}) {
  if (!rerankConfigured()) {
    lastRerankError = 'not configured';
    return null;
  }
  if (!documents.length) return [];
  const base = config.embeddings.endpoint.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/providers/cohere/v2/rerank`, {
      method: 'POST',
      headers: { 'api-key': config.embeddings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.rerank.deployment,
        query,
        documents,
        top_n: Math.min(topN, documents.length),
      }),
      signal: AbortSignal.timeout(config.rerank.timeoutMs),
    });
    if (!res.ok) {
      lastRerankError = `endpoint returned ${res.status} for deployment "${config.rerank.deployment}"`;
      log.warn('rerank failed', { status: res.status });
      return null;
    }
    const payload = await res.json();
    lastRerankError = null;
    return payload.results.map((r) => ({ index: r.index, score: r.relevance_score }));
  } catch (err) {
    lastRerankError = err.message;
    log.warn('rerank failed', { message: err.message });
    return null;
  }
}

module.exports = { rerank, rerankConfigured, lastRerankError: () => lastRerankError };
