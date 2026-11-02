'use strict';

// Brief composition: from the operator's ask and what the assistant gathered
// to the brief a factory job (or a proposal card) carries. The rules are
// composeCore's; this file gathers, searches the repo, and makes one model
// call through PA's own model/provider abstraction (src/llm.js, any
// text-capable provider; PA_COMPOSE_MODEL).
//
//   compose({target, task, done, app, slug, delivery, pipeline})
//     → {brief, composed, by, dropped, hints}
//
// It never fails a dispatch: no model, a model error, an answer that is not
// JSON — each falls back to composeCore.fallbackComposed, which carries the
// operator's own words and the code hints and nothing private. The model is
// swappable for tests (_setModel).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { config } = require('../config');
const C = require('./composeCore');
const { describe: describeDelivery } = require('./deliveryCore');
const { logger } = require('../log');

const exec = promisify(execFile);
const log = logger('compose');

let modelOverride = null;

/** Tests only: replace the model call. fn({system, prompt}) → reply text. */
function _setModel(fn) {
  modelOverride = fn;
}

async function callModel({ system, prompt }) {
  if (modelOverride) return modelOverride({ system, prompt });
  const llm = require('../llm');
  return llm.complete({ system, prompt, model: config.dispatch.composeModel, effort: 'low', maxTokens: 2500, purpose: 'compose' });
}

function extractJson(text) {
  return require('../llm').extractJson(String(text || ''));
}

// --- the repo: what exists that the change should reuse ---------------------------------

async function git(cwd, args) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 15_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout;
}

/**
 * The local checkout to search, if there is one on this machine: the run's
 * repo path, the project's, or the factory app's path when the factory runs
 * here. A remote-only repo gets no hints, and the brief says so.
 */
function localRepo(candidates) {
  for (const p of candidates) {
    if (p && typeof p === 'string' && fs.existsSync(path.join(p, '.git'))) return p;
  }
  return null;
}

async function codeHints(repo, text) {
  if (!repo) return { files: [], reuse: [], conventions: [], keywords: [] };
  const kws = C.keywords(text);
  let files = [];
  try {
    files = (await git(repo, ['ls-files'])).split(/\r?\n/).filter(Boolean).slice(0, 50_000);
  } catch (err) {
    log.debug('git ls-files failed', { message: err.message });
    return { files: [], reuse: [], conventions: [], keywords: kws };
  }
  const hits = {};
  for (const kw of kws) {
    // -F: the keyword is a literal, never a pattern; -l: names only.
    const out = await git(repo, ['grep', '-l', '-i', '-I', '-F', '-e', kw]).catch((err) => String(err.stdout || ''));
    hits[kw] = out.split(/\r?\n/).filter(Boolean).slice(0, 40);
  }
  const { reuse, conventions } = C.rankHints({ files, hits, keywords: kws });
  return { files, reuse, conventions, keywords: kws };
}

// --- gather, compose, render ---------------------------------------------------------------

/**
 * The inputs composeCore reads, from a dispatch target (dispatch.resolveTarget)
 * and the assistant's memory. Private material is gathered so the model can
 * pick the facts the task needs; composeCore keeps it from leaving wholesale.
 */
async function gather({ target, task = null, done = [], app = null, slug = null, appPath = null }) {
  const dispatch = require('./index');
  const [related, memory] = await Promise.all([
    dispatch.relatedContext ? dispatch.relatedContext(target.item).catch(() => []) : [],
    dispatch.memoryContext ? dispatch.memoryContext(target, task).catch(() => ({})) : {},
  ]);
  const operatorAsk = task || null;
  const title = task || target.commitment?.summary || '';
  const repo = localRepo([target.repoPath, target.project?.repo_path, appPath]);
  const hints = await codeHints(repo, [operatorAsk, target.commitment?.summary, target.commitment?.detail, ...(done || [])].filter(Boolean).join('\n'));
  return {
    title,
    operatorAsk,
    summary: target.commitment?.summary || null,
    detail: target.commitment?.detail || null,
    done: done || [],
    message: target.item?.body_text ? { source: target.item.source, body: target.item.body_text } : null,
    related: (related || []).map((r) => r.subject).filter(Boolean),
    facts: (memory?.facts || []).map((f) => ({ subject: f.subject, text: f.text })),
    personNote: memory?.person || null,
    projectNote: memory?.project || null,
    codeHints: hints.reuse,
    conventions: hints.conventions,
    files: hints.files,
    app,
    slug,
    repo,
  };
}

/**
 * Composes from gathered inputs. Pure apart from the model call.
 * @returns {Promise<{composed, by, dropped}>}
 */
async function composeFrom(inputs, { useModel = true } = {}) {
  if (!useModel) return { composed: C.fallbackComposed(inputs), by: 'compose:fallback', dropped: [] };
  try {
    const reply = await callModel(C.buildPrompt(inputs));
    const raw = extractJson(reply);
    if (!raw || typeof raw !== 'object') throw new Error('no JSON in the answer');
    const { composed, dropped } = C.checkComposed(raw, inputs);
    if (dropped.length) log.info('brief: dropped items that broke the rules', { dropped: dropped.map((d) => `${d.field}: ${d.why}`).slice(0, 10) });
    return { composed, by: `compose:${modelOverride ? 'test' : config.dispatch.composeModel}`, dropped };
  } catch (err) {
    log.warn('brief composition fell back to the deterministic brief', { message: String(err.message).slice(0, 200) });
    return { composed: C.fallbackComposed(inputs), by: 'compose:fallback', dropped: [] };
  }
}

/**
 * The whole step: gather, compose, render.
 * @returns {Promise<{brief: string, composed: object, by: string, done: Array<string>, goal: string, hints: number}>}
 */
async function compose({ target, task = null, done = [], app = null, slug = null, appPath = null, delivery, pipeline = null, route = 'factory', useModel = true }) {
  const inputs = await gather({ target, task, done, app, slug, appPath });
  const { composed, by } = await composeFrom(inputs, { useModel });
  const brief = C.render(composed, {
    title: inputs.title,
    app,
    slug,
    delivery,
    deliveryPlain: describeDelivery(delivery, { route }),
    pipeline,
    by,
  });
  return { brief, composed, by, done: composed.done, goal: composed.goal, hints: composed.reuse.length };
}

module.exports = { compose, composeFrom, gather, codeHints, localRepo, _setModel };
