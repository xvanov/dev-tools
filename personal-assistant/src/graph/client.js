'use strict';

// A thin Microsoft Graph client: auth header, throttling, paging, delta.
//
// Graph throttles, and it tells you how long to wait in `Retry-After`. Honouring
// that header is the difference between an ingest pass that finishes and one
// that gets progressively more throttled while insisting on retrying
// immediately. 5xx gets a short backoff; 4xx other than 429 is a real error and
// is raised, because retrying a 403 forever hides a missing scope.

const { accessToken } = require('../auth/graphAuth');
const { logger } = require('../log');

const log = logger('graph');
const BASE = 'https://graph.microsoft.com/v1.0';

class GraphError extends Error {
  constructor(status, code, message, url) {
    super(`${status} ${code || ''} ${message || ''} (${url})`.trim());
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { method = 'GET', headers = {}, body, attempt = 0 } = {}) {
  const token = await accessToken();
  const full = url.startsWith('http') ? url : BASE + url;

  const res = await fetch(full, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) {
      const text = await res.text().catch(() => '');
      throw new GraphError(res.status, 'retries_exhausted', text.slice(0, 200), full);
    }
    const retryAfter = Number.parseInt(res.headers.get('retry-after') || '', 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 1000;
    log.warn('backing off', { status: res.status, waitMs, attempt });
    await sleep(waitMs);
    return request(url, { method, headers, body, attempt: attempt + 1 });
  }

  if (!res.ok) {
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      /* not JSON */
    }
    const err = payload.error || {};
    throw new GraphError(res.status, err.code, err.message, full);
  }

  if (res.status === 204) return null;
  return res.json();
}

// Follows @odata.nextLink to the end. Callers get one flat array; the pages are
// an implementation detail nobody downstream benefits from knowing about.
async function getAll(url, { headers } = {}) {
  const items = [];
  let next = url;
  while (next) {
    const page = await request(next, { headers });
    if (Array.isArray(page?.value)) items.push(...page.value);
    next = page?.['@odata.nextLink'] || null;
  }
  return items;
}

// Delta collections are the reason this whole ingest is cheap: given last
// pass's token, Graph returns only what changed. Returns the items *and* the
// token to store for next time — the caller writes both in one transaction.
async function getDelta(startUrl, deltaToken, { headers } = {}) {
  const items = [];
  let next = deltaToken || startUrl;
  let deltaLink = null;

  while (next) {
    const page = await request(next, { headers });
    if (Array.isArray(page?.value)) items.push(...page.value);
    if (page?.['@odata.deltaLink']) {
      deltaLink = page['@odata.deltaLink'];
      break;
    }
    next = page?.['@odata.nextLink'] || null;
  }

  return { items, deltaLink };
}

module.exports = { request, getAll, getDelta, GraphError, BASE };
