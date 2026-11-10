'use strict';

// The Factory layer (Alt+3): every software-factory job, grouped Needs you /
// Running / Delivered / Failed-Cancelled, with its stories, PRs, CI, cost,
// report and live runs, and the actions on it.
//
//   GET  /factory                     the page (factory.html, factory.client.js)
//   GET  /api/factory                 the board, from the worker's stored list
//   GET  /api/factory/report?job=     a research/report job's markdown, parsed
//   POST /api/factory/jobs            a new job: title, ask, kind, runtime, repo, delivery
//   POST /api/factory/jobs/<id>/cancel|approve|open
//   POST /api/factory/events          a factory pushes job status changes (live feed)
//   GET|POST /api/factory/apps[/<app>] the Repos section: registered repos, gates, add/edit
//                                     (factoryApps.ts; page script factory.apps.client.js)
//   GET  /api/factory/board           the Board view: `factory job board` (factoryBoard.ts)
//   GET  /api/factory/steps/<id>/events one step's turns, paginated, long-polled
//                                     (`factory job step`; page script factory.board.client.js)
//
// The page never makes the factory work per request: the board is the
// `factory job list` the worker stored (factory.refreshBoard, sql/031). Only a
// click — Read report, Cancel, Approve, Open, New job — calls the factory.
// Same guards as every dashboard write: loopback, X-PA on every POST; a new
// job that would merge or push to main with no human step also needs the
// page's token and the level confirmed on the page (server.js).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;

const fs = require('fs');
const path = require('path');
const { config } = require('../config.ts');
const F = require('../dispatch/factoryCore.ts');

const PAGE = path.join(__dirname, 'factory.html');
const CLIENT = path.join(__dirname, 'factory.client.js');
const APPS_CLIENT = path.join(__dirname, 'factory.apps.client.js');
const BOARD_CLIENT = path.join(__dirname, 'factory.board.client.js');

const KIND_LABEL: Record<string, string> = { code: 'code — change a repo', research: 'research — answer a question, write a report', report: 'report — write a document', plan: 'plan — read-only: an implementation plan, change nothing' };
const RUNTIME_LABEL: Record<string, string> = { api: 'API models (metered)', claude_session: 'Claude session (subscription)' };

/** The kind and runtime pickers, for the New job form. */
function pickers() {
  return {
    kinds: F.KINDS.map((k: string) => ({ value: k, label: KIND_LABEL[k] })),
    runtimes: F.RUNTIMES.map((r: string) => ({ value: r, label: RUNTIME_LABEL[r] })),
    defaultRuntime: F.runtime(config.factory.runtime),
  };
}

/** Pure. `/api/factory/jobs/<id>/<verb>` → {jobId, verb}, or null. */
function jobAction(pathname: unknown) {
  const m = /^\/api\/factory\/jobs\/([^/]+)\/(cancel|approve|open)$/.exec(pathname as string);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  return F.JOB_ID.test(id) ? { jobId: id, verb: m[2] } : null;
}

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Pure. The New job form, checked, as dispatch.start's options — or throws a
 * 400. Code needs a repo (owner/name or a known project's path); research and
 * report need none and deliver `none`.
 */
function newJob(body: Row) {
  const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const title = str(body?.title, 200);
  const ask = str(body?.ask, 20_000);
  if (!title) throw bad('a job needs a title');
  let kind;
  let runtime;
  try {
    kind = F.jobKind(body?.kind || 'code');
    runtime = F.runtime(body?.runtime || config.factory.runtime);
  } catch (err) {
    throw bad((err as Error).message);
  }
  const repo = str(body?.repo, 300) || null;
  if (repo && /[\r\n]/.test(repo)) throw bad('one repo');
  if (kind === 'code' && !repo) throw bad('a code job needs a repo (owner/name)');
  if (kind !== 'code' && repo && !SLUG.test(repo)) throw bad('a research/report job names its repo as owner/name');
  const D = require('../dispatch/deliveryCore.ts');
  const delivery = str(body?.delivery, 40) || null;
  if (delivery && !D.isDelivery(delivery)) throw bad(`unknown delivery "${delivery}"`);
  if (kind !== 'code' && delivery && delivery !== 'none') throw bad(`a ${kind} job delivers a report — its end state is none`);
  const done = (Array.isArray(body?.done) ? body.done : String(body?.done || '').split(/\r?\n/))
    .map((d) => String(d).trim()).filter(Boolean).slice(0, 12).map((d) => d.slice(0, 500));
  return {
    title,
    task: ask || title,
    jobKind: kind,
    runtime,
    repoPath: repo,
    via: 'factory',
    delivery: kind === 'code' ? delivery : null,
    done,
    // You typed this repo on your own page: a repo the factory does not know
    // yet is registered with it (`factory app add`) rather than refused.
    register: kind === 'code',
    routeReason: 'you started it on the Factory page',
  };
}

function termhubUrl(r: Row) {
  if (!r.termhub_session_id) return null;
  try {
    return `${require('../dispatch/termhub.ts').forMachine(r.machine).base}/#session=${encodeURIComponent(r.termhub_session_id as string)}`;
  } catch {
    return null;
  }
}

/** The page's data: the stored list as a board, with the PA's runs and spend. */
async function boardData() {
  const factory = require('../dispatch/factory.ts');
  if (!factory.enabled()) return { enabled: false };
  const snap = await factory.snapshot();
  const ids = snap.jobs.map((j: Row) => j.job_id).filter((id: unknown) => F.JOB_ID.test(String(id || '')));
  const runs = ids.length
    ? await require('../repo').runs.latestRunPerJob(ids).catch(() => [])
    : [];
  // Plan E1: the run that submitted a job, and its card, so Build links back to Plan.
  const paRuns = new Map(runs.map((r: Row) => [r.factory_job_id, { id: Number(r.id), url: termhubUrl(r), card: r.commitment_id }]));
  const spend = await require('../budget.ts').status().catch(() => null);
  return {
    enabled: true,
    polledAt: snap.polledAt,
    error: snap.error,
    errorAt: snap.errorAt,
    pollSeconds: config.factory.pollSeconds,
    machine: config.factory.machine || null,
    ...F.board(snap.jobs, { paRuns, paSpendToday: spend ? spend.today : null }),
    spendCap: spend ? spend.cap : null,
    ...pickers(),
    deliveries: require('../dispatch/deliveryCore.ts').DELIVERIES.map((d: string) => ({ value: d, plain: require('../dispatch/deliveryCore.ts').describe(d) })),
  };
}

function pageHtml(token: string) {
  return fs.readFileSync(PAGE, 'utf8').replace('</head>', `<meta name="pa-page" content="${token}">\n</head>`);
}

async function route(req: Req, res: Res, url: URL, { send, readJson, issuePageToken, pageTokenOk }: { send: Ctx['send']; readJson: Ctx['readJson']; issuePageToken: Ctx['issuePageToken']; pageTokenOk: Ctx['pageTokenOk'] }) {
  if (req.method === 'GET' && url.pathname === '/factory') {
    send(res, 200, pageHtml(issuePageToken()), 'text/html; charset=utf-8');
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/factory.js') {
    send(res, 200, fs.readFileSync(CLIENT, 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/factory-apps.js') {
    send(res, 200, fs.readFileSync(APPS_CLIENT, 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/factory-board.js') {
    send(res, 200, fs.readFileSync(BOARD_CLIENT, 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  // The Board view (factoryBoard.ts, plan 8.8.2): the factory's snapshot and one step's turns.
  if (await require('./factoryBoard.ts').route(req, res, url, { send })) return true;
  if (req.method === 'GET' && url.pathname === '/api/factory') {
    send(res, 200, await boardData());
    return true;
  }
  // The Repos section (factoryApps.ts): registered apps, their gates, add/edit.
  if (req.method === 'GET' && (url.pathname === '/api/factory/apps' || url.pathname.startsWith('/api/factory/apps/'))) {
    send(res, 200, await require('./factoryApps.ts').get(url));
    return true;
  }
  // A report arrives parsed (dashboard/markdown.js) and is built with
  // textContent: an agent wrote it, so it never becomes an HTML string.
  if (req.method === 'GET' && url.pathname === '/api/factory/report') {
    const jobId = url.searchParams.get('job') || '';
    if (!F.JOB_ID.test(jobId)) {
      send(res, 400, { error: 'not a factory job id' });
      return true;
    }
    const r = await require('../dispatch/factory.ts').report(jobId);
    send(res, 200, { jobId: r.jobId, title: r.title, path: r.path, none: Boolean(r.none), blocks: require('./markdown.ts').parseMarkdown(r.markdown || '') });
    return true;
  }
  if (req.method !== 'POST' || !url.pathname.startsWith('/api/factory/')) return false;
  if (req.headers['x-pa'] !== '1') {
    send(res, 403, { error: 'missing X-PA header' });
    return true;
  }
  const body = await readJson(req);
  const factory = require('../dispatch/factory.ts');

  if (url.pathname === '/api/factory/apps' || url.pathname.startsWith('/api/factory/apps/')) {
    send(res, 200, await require('./factoryApps.ts').post(url.pathname, body));
    return true;
  }
  if (url.pathname === '/api/factory/jobs') {
    const o: ReturnType<typeof newJob> & { confirmedUnattended?: boolean } = newJob(body);
    const D = require('../dispatch/deliveryCore.ts');
    // A code job's end state, as the start will resolve it, confirmed on the
    // page when nothing human follows it — the same rule as a card's Do.
    if (o.jobKind === 'code') {
      const resolved = await require('../dispatch').previewDelivery({ task: o.task, delivery: o.delivery, repoPath: o.repoPath });
      if (D.unattended(resolved.delivery)) {
        if (!(body.confirmedLevel === resolved.delivery && pageTokenOk(req))) {
          send(res, 409, { error: `this would ${resolved.delivery === 'push_to_main' ? 'push straight to main' : 'merge automatically'} (${resolved.delivery}) — confirm that level on the page`, delivery: resolved.delivery, plain: D.describe(resolved.delivery) });
          return true;
        }
        // With passkeys on, a tap bound to exactly this task, repo and level (the server derives the id).
        const digest = require('crypto').createHash('sha256').update(JSON.stringify([o.task, o.repoPath || null, resolved.delivery])).digest('hex').slice(0, 32);
        const need = await require('../auth/stepup.ts').demandForDelivery(resolved.delivery, `job:${digest}`);
        if (need) {
          send(res, need.status, need.body);
          return true;
        }
        o.delivery = resolved.delivery;
        o.confirmedUnattended = true;
      }
    }
    const run = await require('../dispatch').start(o);
    await factory.refreshBoard().catch(() => {});
    send(res, 200, {
      id: run.id, jobId: run.jobId || null, jobKind: run.jobKind || o.jobKind, runtime: run.runtime || o.runtime, delivery: run.delivery || null,
      url: run.url || null, submitUnknown: Boolean(run.submitUnknown), warnings: run.warnings || [],
    });
    return true;
  }
  // A factory on this machine pushing its job status changes (plan item 0.4):
  // {job_id, state, why?, updated_at?} or {jobs: [...]}. Merged into the stored
  // list for the live feed; the next `job list` overwrites it with the truth.
  if (url.pathname === '/api/factory/events') {
    send(res, 200, await factory.pushed(body));
    return true;
  }
  const a = jobAction(url.pathname);
  if (!a) {
    send(res, 404, { error: 'not found' });
    return true;
  }
  if (a.verb === 'cancel') send(res, 200, await factory.cancelJob(a.jobId));
  else if (a.verb === 'approve') send(res, 200, await factory.approve(a.jobId, { channel: 'dashboard' }));
  else send(res, 200, await factory.openFollow(a.jobId, `factory · ${a.jobId} (follow)`, { job: a.jobId }));
  return true;
}

module.exports = { route, pickers, jobAction, newJob, boardData };
