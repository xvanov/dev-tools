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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Config = import('../types.ts').Config;
type ModelCall = (o: { system: string; prompt: string }) => Promise<string> | string;
type Hint = { path: string; why: string };
type Hints = { files: string[]; reuse: Hint[]; conventions: string[]; keywords: string[] };
/** composeCore's Composed; its type cannot be named across a CommonJS module yet. */
type Composed = Json;
/** A dispatch target (dispatch.resolveTarget): store rows, read column by column. */
type Target = Json;
type GatherOptions = { target: Target; task?: string | null; done?: string[] | null; app?: string | null; slug?: string | null; appPath?: string | null };

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { config } = require('../config.ts');
const C = require('./composeCore.ts');
const { describe: describeDelivery } = require('./deliveryCore.ts');
const { logger } = require('../log.ts');

const exec = promisify(execFile);
const log = logger('compose');

let modelOverride: ModelCall | null = null;

/** Tests only: replace the model call. fn({system, prompt}) → reply text. */
function _setModel(fn: ModelCall | null): void {
  modelOverride = fn;
}

/**
 * The model string compose calls. A bare Claude model with no Anthropic key
 * would go through `claude -p` (~4 s of startup per brief), so when a keyed
 * path exists it is preferred: the Anthropic API (key set), else
 * PA_COMPOSE_FALLBACK_MODEL, when it routes off the CLI and its key is
 * present. An explicit provider-prefixed PA_COMPOSE_MODEL is
 * respected as is. Nothing keyed: the configured model, i.e. `claude -p`.
 * Pure: `c`, `read` and `hasAnthropicKey` are injectable for tests.
 */
function pickModel({ c = config, read, hasAnthropicKey = Boolean(c.anthropic.apiKey) }: { c?: Config; read?: (name: string) => string | null | undefined; hasAnthropicKey?: boolean } = {}): string {
  const models = require('../models.ts');
  const configured: string = c.dispatch.composeModel;
  const keyed = (value: string | null | undefined): boolean => {
    if (!value) return false;
    try {
      const r = models.route(value, { hasAnthropicKey });
      if (r.backend === 'cli') return false;
      // Azure also needs its endpoint; a keyed call that cannot be sent would
      // end in the deterministic brief, which is worse than `claude -p`.
      if (r.provider === 'azure' && !c.providers?.azure?.endpoint) return false;
      return r.backend === 'api' || r.provider === 'local' || Boolean(models.providerKey(r.provider, read));
    } catch {
      return false;
    }
  };
  if (keyed(configured)) return configured;
  // PA_MODEL, when set, already is `configured` (config.js modelEnv).
  if (keyed(c.dispatch.composeFallbackModel)) return c.dispatch.composeFallbackModel;
  return configured;
}

let lastModel: string | null = null;

async function callModel({ system, prompt }: { system: string; prompt: string }): Promise<string> {
  if (modelOverride) return modelOverride({ system, prompt });
  const llm = require('../llm.ts');
  const model = pickModel();
  lastModel = model;
  const started = Date.now();
  try {
    const reply = await llm.complete({ system, prompt, model, effort: 'low', maxTokens: 2500, purpose: 'compose' });
    log.info('compose model call', { model, ms: Date.now() - started });
    return reply;
  } catch (err) {
    log.warn('compose model call failed', { model, ms: Date.now() - started, message: (err as Error).message });
    throw err;
  }
}

function extractJson(text: unknown): Json | null {
  return require('../llm.ts').extractJson(String(text || ''));
}

// --- the repo: what exists that the change should reuse ---------------------------------

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 15_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout;
}

/**
 * The local checkout to search, if there is one on this machine: the run's
 * repo path, the project's, or the factory app's path when the factory runs
 * here. A remote-only repo gets no hints, and the brief says so.
 */
function localRepo(candidates: unknown[]): string | null {
  for (const p of candidates) {
    if (p && typeof p === 'string' && fs.existsSync(path.join(p, '.git'))) return p;
  }
  return null;
}

async function codeHints(repo: string | null, text: string): Promise<Hints> {
  if (!repo) return { files: [], reuse: [], conventions: [], keywords: [] };
  const kws: string[] = C.keywords(text);
  // ls-files reads only the index, so it does not slow the grep's tree scan.
  const [listed, hits] = await Promise.all([
    git(repo, ['ls-files']).catch((err: Error) => {
      log.debug('git ls-files failed', { message: err.message });
      return null;
    }),
    keywordHits(repo, kws),
  ]);
  if (listed == null) return { files: [], reuse: [], conventions: [], keywords: kws };
  const files: string[] = listed.split(/\r?\n/).filter(Boolean).slice(0, 50_000);
  const { reuse, conventions } = C.rankHints({ files, hits, keywords: kws });
  return { files, reuse, conventions, keywords: kws };
}

const SCAN_MS = 6000; // one scan of a big checkout (47k files) takes ~5 s; a slower one is cut short
const HITS_PER_KEYWORD = 40;
const MAX_SCANNED_FILES = 4000;

/**
 * The files (first HITS_PER_KEYWORD each, in git order) that contain each
 * keyword, case-insensitively, text files only. One `git grep` over all the
 * keywords finds the files that match any of them; which keyword matched
 * where is then read off those few files. (One grep per keyword scanned the
 * whole tree eight times: 60 s on a 47k-file repo, and running them in
 * parallel is slower still, since they fight over the disk.) A scan that
 * overruns SCAN_MS keeps what it found.
 */
async function keywordHits(repo: string, kws: string[]): Promise<Record<string, string[]>> {
  const hits: Record<string, string[]> = Object.fromEntries(kws.map((k) => [k, []]));
  if (!kws.length) return hits;
  // -F: the keywords are literals, never patterns; -l: names only.
  const args = ['grep', '-l', '-i', '-I', '-F', ...kws.flatMap((k) => ['-e', k])];
  let out = '';
  let cut = false;
  try {
    out = await new Promise<string>((resolve, reject) => {
      execFile('git', args, { cwd: repo, maxBuffer: 16 * 1024 * 1024, timeout: SCAN_MS, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err: (Error & { killed?: boolean; code?: unknown }) | null, stdout: unknown) => {
        if (err && err.killed) cut = true;
        // exit 1 is "no match"; a timeout keeps the partial list.
        if (err && !err.killed && err.code !== 1) reject(err);
        else resolve(String(stdout || ''));
      });
    });
  } catch (err) {
    log.debug('git grep failed', { message: (err as Error).message });
    return hits;
  }
  const lines = out.split(/\r?\n/).filter(Boolean);
  if (cut) lines.pop(); // may be half a path
  const files = lines.slice(0, MAX_SCANNED_FILES);
  const lower = kws.map((k) => k.toLowerCase());
  const full = (): boolean => kws.every((k) => (hits[k] as string[]).length >= HITS_PER_KEYWORD);
  for (let i = 0; i < files.length && !full(); i += 64) {
    const batch = files.slice(i, i + 64);
    const texts: Array<string | null> = await Promise.all(batch.map((f) => fs.promises.readFile(path.join(repo, f)).then((b: Buffer) => (b.length > 2_000_000 ? null : b.toString('utf8').toLowerCase())).catch(() => null)));
    batch.forEach((f, j) => {
      const text = texts[j];
      if (text == null) return;
      lower.forEach((k, n) => {
        const list = hits[kws[n] as string] as string[];
        if (list.length < HITS_PER_KEYWORD && text.includes(k)) list.push(f);
      });
    });
  }
  return hits;
}

// --- gather, compose, render ---------------------------------------------------------------

/**
 * The inputs composeCore reads, from a dispatch target (dispatch.resolveTarget)
 * and the assistant's memory. Private material is gathered so the model can
 * pick the facts the task needs; composeCore keeps it from leaving wholesale.
 */
async function gather({ target, task = null, done = [], app = null, slug = null, appPath = null }: GatherOptions): Promise<Json> {
  const dispatch = require('./index.ts');
  const operatorAsk = task || null;
  const title = task || target.commitment?.summary || '';
  const repo = localRepo([target.repoPath, target.project?.repo_path, appPath]);
  // Independent of each other, so concurrent: the repo search (seconds on a
  // big checkout) no longer waits for the memory recall, nor the reverse.
  const [related, memory, hints] = await Promise.all([
    dispatch.relatedContext ? dispatch.relatedContext(target.item).catch(() => []) : [],
    dispatch.memoryContext ? dispatch.memoryContext(target, task).catch(() => ({})) : {},
    codeHints(repo, [operatorAsk, target.commitment?.summary, target.commitment?.detail, ...(done || [])].filter(Boolean).join('\n')),
  ]);
  return {
    title,
    operatorAsk,
    summary: target.commitment?.summary || null,
    detail: target.commitment?.detail || null,
    done: done || [],
    message: target.item?.body_text ? { source: target.item.source, body: target.item.body_text } : null,
    related: ((related || []) as Json[]).map((r) => r.subject).filter(Boolean),
    facts: ((memory?.facts || []) as Json[]).map((f) => ({ subject: f.subject, text: f.text })),
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

/** Composes from gathered inputs. Pure apart from the model call. */
async function composeFrom(inputs: Json, { useModel = true }: { useModel?: boolean } = {}): Promise<{ composed: Composed; by: string; dropped: Array<{ field: string; why: string }> }> {
  if (!useModel) return { composed: C.fallbackComposed(inputs), by: 'compose:fallback', dropped: [] };
  try {
    const reply = await callModel(C.buildPrompt(inputs));
    const raw = extractJson(reply);
    if (!raw || typeof raw !== 'object') throw new Error('no JSON in the answer');
    const { composed, dropped } = C.checkComposed(raw, inputs);
    if (dropped.length) log.info('brief: dropped items that broke the rules', { dropped: (dropped as Array<{ field: string; why: string }>).map((d) => `${d.field}: ${d.why}`).slice(0, 10) });
    return { composed, by: `compose:${modelOverride ? 'test' : lastModel || config.dispatch.composeModel}`, dropped };
  } catch (err) {
    log.warn('brief composition fell back to the deterministic brief', { message: String((err as Error).message).slice(0, 200) });
    return { composed: C.fallbackComposed(inputs), by: 'compose:fallback', dropped: [] };
  }
}

/** The whole step: gather, compose, render. */
async function compose({
  target,
  task = null,
  done = [],
  app = null,
  slug = null,
  appPath = null,
  delivery,
  pipeline = null,
  route = 'factory',
  useModel = true,
}: GatherOptions & { delivery: string | null; pipeline?: string | null; route?: string; useModel?: boolean }): Promise<{ brief: string; composed: Composed; by: string; done: string[]; goal: string; hints: number; ms: { gather: number; model: number } }> {
  const started = Date.now();
  const inputs = await gather({ target, task, done, app, slug, appPath });
  const gathered = Date.now();
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
  return { brief, composed, by, done: composed.done, goal: composed.goal, hints: composed.reuse.length, ms: { gather: gathered - started, model: Date.now() - gathered } };
}

module.exports = { compose, composeFrom, gather, codeHints, localRepo, pickModel, _setModel };
