'use strict';

// Meter's data (plan 7.5):
//   GET  /api/meter?days=N   latency per hop (p50/p95), spend per day/model/
//                            purpose, the Claude credit pool (src/telemetry/meter.js).
//                            Read by termhub's Meter page through /pa/api/meter.
//   POST /api/telemetry      what the Python factory measured: {spans: [...],
//                            usage: [...]}. X-PA guarded like every POST here.
//                            A span is {hop, name, traceId, spanId, parentSpanId,
//                            startedAt, durationMs, ok, attrs}; a usage row is
//                            {purpose, model, costUsd, inputTokens, outputTokens,
//                            durationMs, ok}, a claude_session run's
//                            `total_cost_usd` and `usage`, recorded in llm_spend
//                            with backend claude_session (the credit pool's feed).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;

const MAX_USAGE_ROWS = 100;

async function route(req: Req, res: Res, url: URL, { send, readJson }: { send: Ctx['send']; readJson: Ctx['readJson'] }) {
  if (req.method === 'GET' && url.pathname === '/api/meter') {
    const days = Number(url.searchParams.get('days')) || 7;
    send(res, 200, await require('../telemetry/meter.ts').report({ days }));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/telemetry') {
    if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' }), true;
    const body = await readJson(req);
    const written = { spans: 0, usage: 0 };
    written.spans = await require('../telemetry').ingest(body?.spans);
    const budget = require('../budget.ts');
    for (const u of Array.isArray(body?.usage) ? body.usage.slice(0, MAX_USAGE_ROWS) : []) {
      if (!u || typeof u !== 'object') continue;
      await budget.record({
        purpose: typeof u.purpose === 'string' ? u.purpose : 'factory',
        model: typeof u.model === 'string' ? u.model.slice(0, 80) : null,
        backend: 'claude_session',
        costUsd: Number.isFinite(Number(u.costUsd)) && u.costUsd !== null ? Number(u.costUsd) : null,
        inputTokens: u.inputTokens == null ? null : Number(u.inputTokens),
        outputTokens: u.outputTokens == null ? null : Number(u.outputTokens),
        durationMs: u.durationMs == null ? null : Number(u.durationMs),
        ok: u.ok !== false,
      });
      written.usage++;
    }
    send(res, 200, { ok: true, ...written });
    return true;
  }
  return false;
}

module.exports = { route };
