'use strict';

// The policy engine (plan 4.3): one function every tool call, approval and
// factory action goes through, answering allow | deny | ask from a declarative
// policy file, and writing each answer to the hash-chained audit log
// (src/repo/audit.js, `pa audit verify`).
//
//   evaluate(request, policy?)   pure: {decision, rule, reason, tags}
//   authorize(request)           evaluate + audit; resolves the decision
//   enforce(request)             authorize, and throws on deny
//
// request: {tool, action: 'call' | 'approve' (default call), channel, actor?,
//           args?, subject?}
//   tool     the bare tool name (factory_start, recall, pa) or verb
//   channel  where it came from: mcp (a coding session), chat (the PA chat's
//            MCP), voice, dashboard, termhub, cli, factory
//   args     used to classify (delivery level, the pa verb) and hashed for the
//            audit row; never stored
//
// Policy file: src/policy/default.policy.json (tracked) plus an untracked
// override (PA_POLICY_FILE, default <data dir>/policy.json). Order of
// evaluation: the default's `locked` rules (deny only, nothing loosens them),
// then the override's `rules`, then the default's `rules`, first match wins,
// then `default` (the override's, else the default's; ask). A rule matches when
// its `tools` (globs, `*`), `actions`, `channels` and `tags` (any of) all do;
// a missing key matches anything. `args` ({delivery: ['pr']}) matches arg values.
//
// Tags are what a call would do, from classify(): merge, push_main,
// secret_reveal. The voice lock is expressed on them.
//
// What `ask` means here: the call is not refused, and the host that owns the
// prompt asks (Claude Code for the chat's action tools). The audit row records
// that it was a prompt case. Nothing in this module answers a prompt.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DECISIONS = ['allow', 'deny', 'ask'];
const DEFAULT_FILE = path.join(__dirname, 'default.policy.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function overrideFile(env = process.env) {
  if (env.PA_POLICY_FILE) return env.PA_POLICY_FILE;
  const { config } = require('../config');
  return path.join(config.dataDir, 'policy.json');
}

function checkRule(r, where) {
  if (!r || typeof r !== 'object') throw new Error(`policy ${where}: a rule is not an object`);
  if (!r.id || typeof r.id !== 'string') throw new Error(`policy ${where}: a rule has no id`);
  if (!DECISIONS.includes(r.decision)) throw new Error(`policy ${where}: rule ${r.id} has decision "${r.decision}"`);
  for (const k of ['tools', 'actions', 'channels', 'tags']) {
    if (r[k] != null && !(Array.isArray(r[k]) && r[k].every((x) => typeof x === 'string'))) throw new Error(`policy ${where}: rule ${r.id}.${k} is not a list of strings`);
  }
}

/** Pure. The effective policy from the tracked default and an optional override object. */
function merge(base, override) {
  for (const r of [...(base.locked || []), ...(base.rules || [])]) checkRule(r, 'default');
  for (const r of base.locked || []) if (r.decision !== 'deny') throw new Error(`policy default: locked rule ${r.id} must deny`);
  const o = override || {};
  for (const r of o.rules || []) checkRule(r, 'override');
  if (o.default != null && !DECISIONS.includes(o.default)) throw new Error(`policy override: default "${o.default}"`);
  return {
    default: o.default || base.default || 'ask',
    locked: base.locked || [],
    // override rules first: a stack may loosen or tighten the default rules, but not the locked ones
    rules: [...(o.rules || []), ...(base.rules || [])],
  };
}

let cached = null;

/** The effective policy, read from disk once per process (`reload` after editing the override). */
function load({ reload = false, env = process.env } = {}) {
  if (cached && !reload) return cached;
  const base = readJson(DEFAULT_FILE);
  let override = null;
  const file = overrideFile(env);
  try {
    override = readJson(file);
  } catch (err) {
    // No override is normal. A broken one must not silently drop a stack's tightening.
    if (err.code !== 'ENOENT') throw new Error(`policy override ${file}: ${err.message}`);
  }
  cached = merge(base, override);
  return cached;
}

const globRe = (g) => new RegExp(`^${g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

/**
 * Pure. What a call would do: any of merge, push_main, secret_reveal. Judged
 * from the tool name and its arguments, conservatively (a name that says merge
 * is a merge).
 */
function classify(tool, args = {}) {
  const tags = new Set();
  const name = String(tool || '');
  const a = args && typeof args === 'object' ? args : {};
  const delivery = String(a.delivery ?? a.delivery_level ?? a.level ?? '').toLowerCase();
  // A job's delivery could not be looked up: unknown is treated as the worst (the voice lock denies it).
  if (a.delivery_unknown === true) tags.add('unverified');
  if (delivery === 'auto_merge' || a.merge === true) tags.add('merge');
  if (delivery === 'push_to_main') tags.add('push_main');
  if (/(^|[_.\-:])merge([_.\-:]|$)/i.test(name)) tags.add('merge');
  if (/push[_\-]?(to[_\-]?)?(main|master)/i.test(name)) tags.add('push_main');
  if (/secret.*(reveal|value|get|show|read)|(reveal|show).*secret/i.test(name)) tags.add('secret_reveal');
  if (name === 'pa' || name === 'secret') {
    const cmd = String(name === 'pa' ? a.command : 'secret').toLowerCase();
    const rest = Array.isArray(a.args) ? a.args.map((x) => String(x).toLowerCase()) : [];
    if (cmd === 'secret' && ['reveal', 'get', 'show', 'value', 'export'].includes(rest[0])) tags.add('secret_reveal');
    if (cmd === 'land' && rest.includes('--main')) tags.add('push_main');
    if (['--delivery', '--delivery-default'].some((f) => rest.includes(f))) {
      const v = rest[rest.findIndex((x) => x === '--delivery' || x === '--delivery-default') + 1];
      if (v === 'auto_merge') tags.add('merge');
      if (v === 'push_to_main') tags.add('push_main');
    }
  }
  return [...tags].sort();
}

function matches(rule, req, tags) {
  if (rule.tools && !rule.tools.some((g) => globRe(g).test(req.tool))) return false;
  if (rule.actions && !rule.actions.includes(req.action)) return false;
  if (rule.channels && !rule.channels.includes(req.channel)) return false;
  if (rule.tags && !rule.tags.some((t) => tags.includes(t))) return false;
  if (rule.args) {
    const a = req.args || {};
    for (const [k, want] of Object.entries(rule.args)) {
      if (!(Array.isArray(want) ? want : [want]).map(String).includes(String(a[k]))) return false;
    }
  }
  return true;
}

/**
 * Pure. The decision for `request` under `policy` (default: the loaded one).
 * @returns {{decision: 'allow'|'deny'|'ask', rule: string, reason: string, tags: string[]}}
 */
function evaluate(request, policy = load()) {
  const req = { action: 'call', channel: 'unknown', ...request, tool: String(request?.tool || '') };
  const tags = classify(req.tool, req.args);
  for (const r of policy.locked) {
    if (matches(r, req, tags)) return { decision: 'deny', rule: r.id, reason: r.reason || '', tags };
  }
  for (const r of policy.rules) {
    if (matches(r, req, tags)) return { decision: r.decision, rule: r.id, reason: r.reason || '', tags };
  }
  return { decision: policy.default, rule: 'default', reason: 'no rule matches', tags };
}

// Approvals of an existing factory job: what they do depends on the job's delivery ceiling.
const JOB_TOOLS = ['factory_approve', 'factory_resume'];

/**
 * For a voice approval of a factory job, looks up the job's delivery and puts
 * it in `args` (so an auto_merge or push_to_main job classifies as merge /
 * push_main and the locked voice rule denies it). Fails closed: when the job
 * cannot be found or looked up, args.delivery_unknown is set and the voice
 * lock denies the request. Other channels and tools are returned as they are.
 * `lookup(jobId)` resolves the job ({delivery}) or null; default: the
 * factory's snapshot.
 */
async function withJobDelivery(request, lookup = null) {
  if (request.channel !== 'voice' || !JOB_TOOLS.includes(request.tool)) return request;
  const args = { ...(request.args || {}) };
  try {
    const find = lookup || ((id) => require('../dispatch/factory').snapshotJob(id));
    const job = args.job ? await find(String(args.job)) : null;
    if (!job) throw new Error('job not found');
    args.delivery = job.delivery || 'none';
    delete args.delivery_unknown;
  } catch {
    delete args.delivery;
    args.delivery_unknown = true;
  }
  return { ...request, args };
}

/** The short, never-secret subject an audit row carries: a card/job id or the pa verb, not content. */
function subjectOf(req) {
  if (req.subject) return String(req.subject);
  const a = req.args || {};
  const parts = [a.job, a.card, a.id, a.command].filter((x) => x != null && x !== '');
  return parts.map((x) => String(x).replace(/\s+/g, ' ').slice(0, 60)).join(' ');
}

const argsHash = (args) => (args == null ? '' : crypto.createHash('sha256').update(JSON.stringify(args) || '').digest('hex'));

/**
 * Evaluates and records. Audit trouble is logged, not thrown: an unreachable
 * database must not turn every read tool into an error. (A deny is still a
 * deny.) Pass `audit: false` to evaluate only (a hot path that logs elsewhere).
 */
async function authorize(request, { audit = true, repo = null } = {}) {
  const res = evaluate(request);
  if (audit) {
    try {
      const r = repo || require('../repo');
      await r.audit.append({
        channel: request.channel || 'unknown',
        actor: request.actor || '',
        action: request.action || 'call',
        tool: request.tool,
        decision: res.decision,
        rule: res.rule,
        reason: res.decision === 'deny' ? res.reason : '',
        subject: subjectOf(request),
        argsHash: argsHash(request.args),
      });
    } catch (err) {
      require('../log').logger('policy').warn('audit write failed', { message: err.message, tool: request.tool });
    }
  }
  return res;
}

/** authorize(), throwing on deny so a caller cannot forget to look. */
async function enforce(request, opts) {
  const res = await authorize(request, opts);
  if (res.decision === 'deny') {
    const err = new Error(`denied by policy (${res.rule}): ${res.reason || request.tool}`);
    err.code = 'POLICY_DENIED';
    err.policy = res;
    throw err;
  }
  return res;
}

module.exports = { evaluate, classify, withJobDelivery, JOB_TOOLS, merge, load, authorize, enforce, overrideFile, argsHash, DEFAULT_FILE, DECISIONS };
