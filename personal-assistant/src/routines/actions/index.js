'use strict';

// The action registry: the only things a routine can do.
//
// A routine never holds a shell string. It names one of these, with params
// checked against the action's schema, so the worst a bad parse of your words
// can produce is the wrong *typed* action — never `rm -rf` because a model
// misheard. Adding an action is one entry here:
//
//   register({
//     name: 'repo_sync',
//     summary: 'one line the parser and the dashboard show',
//     changes: 'what it changes on the machine, or null if read-only',
//     params: { root: { type: 'string', doc: '…', default: '…' } },
//     describe: (params) => 'plain words for this instance',
//     run: async (params, { dryRun, log }) => ({ ok, summary, lines, notable, detail }),
//   });
//
// `run` returns { ok, summary, lines, notable, detail }: `summary` is one line,
// `lines` the numbered list a notification shows, `notable` false lets a quiet
// run skip the toast (it is still logged and still in the feed).

const TYPES = ['string', 'number', 'boolean'];
const registry = new Map();

function register(action) {
  for (const k of ['name', 'summary', 'describe', 'run']) {
    if (!action[k]) throw new Error(`action is missing "${k}"`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(action.name)) throw new Error(`bad action name "${action.name}"`);
  if (registry.has(action.name)) throw new Error(`action "${action.name}" is registered twice`);
  for (const [key, spec] of Object.entries(action.params || {})) {
    if (!TYPES.includes(spec.type)) throw new Error(`${action.name}.${key}: type must be one of ${TYPES.join('/')}`);
  }
  registry.set(action.name, { params: {}, changes: null, ...action });
  return action;
}

function get(name) {
  const a = registry.get(String(name || ''));
  if (!a) throw new Error(`unknown action "${name}" — known: ${[...registry.keys()].join(', ')}`);
  return a;
}

function names() {
  return [...registry.keys()];
}

/**
 * Checks params against the action's schema and returns a clean copy:
 * defaults filled in, unknown keys dropped, types enforced. Throws on a
 * missing required value or a wrong type.
 */
function validateParams(name, params) {
  const a = get(name);
  const input = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const out = {};
  for (const [key, spec] of Object.entries(a.params)) {
    let v = input[key];
    if (v === undefined || v === null || v === '') {
      if (spec.required) throw new Error(`${name}: "${key}" is required`);
      if (spec.default !== undefined) out[key] = spec.default;
      continue;
    }
    if (spec.type === 'number' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    if (spec.type === 'boolean' && (v === 'true' || v === 'false')) v = v === 'true';
    if (typeof v !== spec.type || (spec.type === 'number' && !Number.isFinite(v))) {
      throw new Error(`${name}: "${key}" must be a ${spec.type}`);
    }
    if (spec.type === 'number' && spec.min !== undefined && v < spec.min) throw new Error(`${name}: "${key}" must be ≥ ${spec.min}`);
    if (spec.type === 'number' && spec.max !== undefined && v > spec.max) throw new Error(`${name}: "${key}" must be ≤ ${spec.max}`);
    if (spec.type === 'string' && spec.maxLength && v.length > spec.maxLength) {
      throw new Error(`${name}: "${key}" is longer than ${spec.maxLength} characters`);
    }
    out[key] = v;
  }
  return out;
}

/** What the plain-words parser is allowed to choose from. */
function catalog() {
  return [...registry.values()].map((a) => ({
    action: a.name,
    does: a.summary,
    changesTheMachine: a.changes || 'no — read-only',
    params: Object.fromEntries(
      Object.entries(a.params).map(([k, s]) => [k, `${s.type}${s.required ? ', required' : ''}${s.default !== undefined ? `, default ${JSON.stringify(s.default)}` : ''} — ${s.doc || ''}`])
    ),
  }));
}

function describe(name, params) {
  return get(name).describe(validateParams(name, params));
}

module.exports = { register, get, names, validateParams, catalog, describe, registry };

// The built-in actions. Required last so they can require this module.
require('./repoSync');
require('./promptReport');
