'use strict';

// Workflow cost ceilings. The default of each is architecture.json's
// acceptance.cost.max_usd; the user can override it from the /architecture page
// (stored by src/repo/workflowLimits.js). This is the one place that says what
// the effective ceiling is: the page, the 8.2 e2e runner, the 8.3 reviewers and
// Meter all read it from here.
//
//   GET  /api/workflow-limits   { limits: { <workflow>: { default, override, effective, custom } } }
//   POST /api/workflow-limits   { workflow, max_usd }  set an override (USD, >= 0)
//                               { workflow, max_usd: null }  reset to the default
//                               answers the same body as the GET
//
// A POST needs X-PA, like every write (server.js). Not a merge-or-push, so no
// page token.

const MAX_USD = 100000;

/** Pure. The workflows with a ceiling: { id: default } from architecture.json's examples. */
function defaults(arch) {
  const out = {};
  for (const x of arch.examples || []) {
    const c = x.acceptance && x.acceptance.cost;
    if (c && Number.isFinite(c.max_usd)) out[x.id] = c.max_usd;
  }
  return out;
}

/** Pure. { <workflow>: {default, override, effective, custom} }; overrides: {workflow, max_usd}[]. */
function effective(arch, overrides) {
  const byWf = new Map((overrides || []).map((o) => [o.workflow, Number(o.max_usd)]));
  const out = {};
  for (const [id, def] of Object.entries(defaults(arch))) {
    const o = byWf.has(id) ? byWf.get(id) : null;
    out[id] = { default: def, override: o, effective: o ?? def, custom: o !== null };
  }
  return out;
}

/** Pure. A POST body's {workflow, max_usd} checked against the known workflows, or { error }. */
function parseChange(arch, body) {
  const wf = body && body.workflow;
  if (typeof wf !== 'string' || !(wf in defaults(arch))) return { error: 'unknown workflow' };
  if (body.max_usd === null) return { workflow: wf, max_usd: null };
  const n = body.max_usd;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_USD) return { error: `max_usd must be a number from 0 to ${MAX_USD}, or null to reset` };
  return { workflow: wf, max_usd: Math.round(n * 10000) / 10000 };
}

async function current({ arch, repo }) {
  return { limits: effective(arch, await repo.workflowLimits.all()) };
}

/** The route. Returns true when it answered. `repo` and `arch` are injectable for tests. */
async function route(req, res, url, { send, readJson, repo = require('../repo'), arch = require('./architecture').load() }) {
  if (url.pathname !== '/api/workflow-limits') return false;
  try {
    if (req.method === 'GET') {
      send(res, 200, await current({ arch, repo }));
    } else if (req.method === 'POST') {
      if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' }), true;
      const ch = parseChange(arch, await readJson(req));
      if (ch.error) return send(res, 400, { error: ch.error }), true;
      if (ch.max_usd === null) await repo.workflowLimits.reset(ch.workflow);
      else await repo.workflowLimits.set(ch.workflow, ch.max_usd);
      send(res, 200, await current({ arch, repo }));
    } else {
      send(res, 405, { error: 'method not allowed' });
    }
  } catch (err) {
    send(res, 500, { error: err.message });
  }
  return true;
}

module.exports = { route, defaults, effective, parseChange, MAX_USD };
