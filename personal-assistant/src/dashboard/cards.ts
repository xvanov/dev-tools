'use strict';

// What every card on the dashboard needs to be acted on without guessing:
// links to where it came from (dashboard/links.js, pure) and the stored
// cause-and-effect paragraph (src/commitments/context.js, written by the
// worker). Read-only and model-free: this runs on every /api/state.
//
//   enrich(state)   adds `links` and `context` to board, Needs-you and
//                   Looks-done cards, in place, with a few batched queries
//   openSession(id) opens a Claude session item in termhub (a POST: it can
//                   start `claude --resume`, so it takes the X-PA guard)
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Link = { kind: string; label: string; url: string };
type Session = Row & { role?: string };
/** What forCommitments() knows about one commitment. */
type Info = {
  links: Link[]; sessions: Session[]; context: unknown; context_at: unknown; who: unknown;
  project: unknown; source: unknown; occurred_at: unknown; item: Row; chain: unknown[]; build?: unknown;
};
/** The dashboard state enrich() adds to (server.js's /api/state). */
type State = { commitments?: Row[]; selfNotes?: { items?: Row[] }[]; needsYou?: Row[]; looksDone?: Row[] };

const { config } = require('../config.ts');
const repo = require('../repo');
const L = require('./links.ts');
const log = require('../log.ts').logger('cards');

function hubs() {
  const machines: Record<string, unknown> = {};
  for (const m of Object.values(config.termhub.machines || {}) as { name: string; url: unknown }[]) machines[m.name] = m.url;
  return { local: config.termhub.url, machines };
}

async function details(ids: unknown[]) {
  try {
    return await repo.commitments.cardDetails(ids, true);
  } catch (err) {
    // Before `pa migrate` has added sql/023: links still work.
    if (!/column .*context/.test((err as Error).message)) throw err;
    return repo.commitments.cardDetails(ids, false);
  }
}

function itemOf(d: Row) {
  return {
    id: d.item_id, source: d.source, external_id: d.external_id, thread_external_id: d.thread_external_id,
    subject: d.subject, occurred_at: d.occurred_at, raw: d.raw || {},
  };
}

/** Links and context for a set of commitment ids, keyed by id. */
async function forCommitments(ids: unknown[], { evidenceIds = [] }: { evidenceIds?: unknown[] } = {}) {
  const want = [...new Set(ids.filter((x) => x != null).map(Number))];
  const out = new Map<string, Info>();
  if (!want.length) return { byId: out, evidence: new Map<string, Row>() };
  const [found, runs, ev] = await Promise.all([
    details(want),
    repo.runs.mrLinksFor(want).catch(() => []),
    evidenceIds.length ? repo.ledger.evidenceItems(evidenceIds.map(Number)).catch(() => []) : [],
  ]);
  const h = hubs();
  const chains = await chainsFor(want).catch(() => new Map());
  const builds = await buildsFor(want).catch(() => new Map());
  for (const d of found) {
    const text = [d.summary, d.detail, d.body, d.later].filter(Boolean).join('\n');
    const built = L.cardLinks({
      item: itemOf(d),
      text,
      person: d.who ? { name: d.who, email: d.who_email, github: d.who_github, is_me: d.who_is_me } : null,
      project: d.gitlab_path,
      runs: runs.filter((r: Row) => String(r.commitment_id) === String(d.id)),
      hubs: h,
    });
    out.set(String(d.id), {
      ...built,
      context: d.context || null,
      context_at: d.context_at || null,
      who: d.who_is_me ? null : d.who,
      project: d.project_name,
      source: d.source,
      occurred_at: d.occurred_at,
      item: itemOf(d),
      chain: chains.get(String(d.id)) || [],
      build: builds.get(String(d.id)) || null,
    });
  }
  const evidence = new Map<string, Row>(ev.map((e: Row) => [String(e.evidence_id), e]));
  return { byId: out, evidence, hubs: h };
}

/**
 * Pure: a card's Build runs as the Plan view shows them: the newest run's state,
 * times, notional cost and links (its board card, its termhub session), and, for
 * a task with several runs, the aggregate: how many, the span from the first start
 * to the last end (or now, while one lives), and the summed cost.
 */
function buildSummary(runs: Row[], now = Date.now(), url: string | null = null): Row | null {
  if (!runs.length) return null;
  const last = runs[runs.length - 1] as Row;
  const live = runs.some((r) => ['starting', 'running', 'waiting', 'idle'].includes(String(r.state)));
  const first = Date.parse(String((runs[0] as Row).started_at));
  const end = live ? now : Math.max(...runs.map((r) => Date.parse(String(r.ended_at || r.started_at))));
  const act = (() => { try { return last.activity ? JSON.parse(String(last.activity)) : null; } catch { return null; } })();
  return {
    run: Number(last.id), state: last.state, model: last.model, started_at: last.started_at, ended_at: last.ended_at || null,
    elapsed_s: Math.max(0, Math.round(((last.ended_at ? Date.parse(String(last.ended_at)) : now) - Date.parse(String(last.started_at))) / 1000)),
    cost_usd: Number(last.cost_usd || 0), result: last.result || null, error: last.error || null, idle: last.state === 'idle' ? act : null,
    board: `factory#run-${last.id}`, session_url: url,
    runs: runs.length, span_s: Math.max(0, Math.round((end - first) / 1000)), total_cost_usd: runs.reduce((t, r) => t + Number(r.cost_usd || 0), 0),
  };
}

/** Each commitment's Build runs, summarised (buildSummary), keyed by id. */
async function buildsFor(ids: unknown[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  const rows: Row[] = await repo.buildRuns.forCards(ids);
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(String(r.commitment_id), [...(by.get(String(r.commitment_id)) || []), r]);
  for (const [id, runs] of by) {
    const last = runs[runs.length - 1] as Row;
    const url = last.session_id && !['done', 'failed', 'stopped'].includes(String(last.state))
      ? await require('../dispatch/termhub.ts').sessionUrl(last.session_id).catch(() => null) : null;
    out.set(id, buildSummary(runs, Date.now(), url) as Row);
  }
  return out;
}

/**
 * Plan E1: each commitment's id chain — its latest runs, each with its job,
 * steps (and their sessions) and PRs (factoryCore.runChain), from stored ids
 * (run, run_step, run_pr), never from titles. Keyed by commitment id.
 * @returns {Promise<Map<string, object[]>>}
 */
async function chainsFor(commitmentIds: unknown[], { perCard = 3 }: { perCard?: number } = {}) {
  const want = [...new Set((commitmentIds || []).filter((x) => x != null).map(Number))];
  const out = new Map<string, unknown[]>();
  if (!want.length) return out;
  const runs = await repo.runs.newestPerCommitment(want, perCard);
  if (!runs.length) return out;
  const F = require('../dispatch/factoryCore.ts');
  const stored = await require('../dispatch/factory.ts').chains(runs.map((r: Row) => r.id));
  const termhub = require('../dispatch/termhub.ts');
  for (const r of runs) {
    let sessionUrl: string | null = null;
    if (r.termhub_session_id) {
      try {
        sessionUrl = `${termhub.forMachine(r.machine).base}/#session=${encodeURIComponent(r.termhub_session_id)}`;
      } catch {
        sessionUrl = null;
      }
    }
    const key = String(r.commitment_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key)?.push(F.runChain(r, stored.get(String(r.id)), { sessionUrl }));
  }
  return out;
}

function attach(card: Row, info: Info | null | undefined) {
  if (!info) return card;
  card.links = info.links;
  card.chain = info.chain || [];
  card.build = info.build || null;
  card.sessions = info.sessions;
  card.context = info.context;
  card.context_at = info.context_at;
  if (card.who === undefined) card.who = info.who;
  if (card.project === undefined) card.project = info.project;
  if (card.source === undefined) card.source = info.source;
  if (card.occurred_at === undefined) card.occurred_at = info.occurred_at;
  // The source item: the board shows one card per item and wording (board.js).
  if (card.item_id === undefined) card.item_id = info.item?.id ?? null;
  return card;
}

// Every open commitment folded into one of `ids` (superseded_by chains, any
// depth), with its source item: the places a card's duplicates were said.
async function foldedInto(ids: unknown[]) {
  const want = [...new Set(ids.filter((x) => x != null).map(Number))];
  const out = new Map<string, { id: unknown; item: Row }[]>();
  if (!want.length) return out;
  const found = await repo.commitments.foldedSourceItems(want);
  for (const f of found) {
    const k = String(f.root);
    if (!out.has(k)) out.set(k, []);
    out.get(k)?.push({ id: f.id, item: itemOf(f) });
  }
  return out;
}

/** Adds links and context to the cards in a dashboard state, in place. */
async function enrich(s: State) {
  const board = [...(s.commitments || []), ...(s.selfNotes || []).flatMap((g) => g.items || [])];
  const ids = [
    ...board.map((c) => c.id),
    ...(s.needsYou || []).map((p) => p.commitment_id),
    ...(s.looksDone || []).map((p) => p.commitment_id),
  ];
  const { byId, evidence, hubs: h } = await forCommitments(ids, { evidenceIds: (s.looksDone || []).map((p) => p.id) });
  for (const c of board) attach(c, byId.get(String(c.id)));
  // Where the duplicates folded into each card were said (dashboard/links.js).
  const folded = await foldedInto(board.map((c) => c.id)).catch(() => new Map<string, { id: unknown; item: Row }[]>());
  for (const c of board) {
    const members = folded.get(String(c.id));
    if (members?.length) c.alsoIn = L.alsoLinks(c.links, members);
  }
  for (const p of s.needsYou || []) {
    if (p.commitment_id != null) attach(p, byId.get(String(p.commitment_id)));
  }
  for (const p of s.looksDone || []) {
    const info = byId.get(String(p.commitment_id));
    const e = evidence.get(String(p.id));
    if (!info) continue;
    // The commitment's own links, then the item that suggests it is settled.
    const more = e ? L.cardLinks({ item: info.item, evidence: e, hubs: h }) : { links: [], sessions: [] };
    attach(p, {
      ...info,
      links: dedupe([...info.links, ...more.links.filter((l: Link) => l.kind === 'evidence')]),
      sessions: [...info.sessions, ...more.sessions.filter((x: Session) => x.role === 'evidence')],
    });
  }
  return s;
}

/**
 * Opens one of my Claude sessions in termhub on the machine it ran on: the live
 * termhub session if one is already running that conversation, else a new one
 * that resumes it (`claude --resume <id>` in its folder). The command is fixed
 * and the id must be a UUID: nothing from the item's text reaches a shell.
 */
async function openSession(itemId: number | string) {
  const item = await repo.sources.claudeSessionItem(itemId);
  if (!item) return { ok: false, error: `no Claude session item #${itemId}` };
  const info = L.sessionInfo(item, hubs());
  if (!info.id || !info.cwd) return { ok: false, error: 'this session has no id or folder to resume' };
  const machine = item.raw?.machine || null;
  // termhub.forMachine falls back to this machine for a name it does not know;
  // resuming another machine's folder here would start in the wrong place.
  if (machine && !config.termhub.machines[machine]) {
    return { ok: false, error: `${machine} is not in PA_MACHINES — run \`${info.resume}\` in ${info.cwd} on ${machine}` };
  }
  const hub = require('../dispatch/termhub.ts').forMachine(machine);
  const open = (await hub.listSessions().catch(() => [])).find((s: Row) => s.agentSessionId === info.id);
  if (open) return { ok: true, url: `${hub.base}/#session=${encodeURIComponent(open.id)}`, resumed: false };
  const exe = String(config.termhub.claudeCommand || 'claude').trim().split(/\s+/)[0] || 'claude';
  const spec = {
    cwd: info.cwd,
    command: `${exe} --resume ${info.id}`,
    title: String(item.subject || 'Claude session').slice(0, 60),
  };
  // A dispatched run that may not push is resumed as it was started: without
  // push credentials (src/dispatch/remote.ts), or not at all.
  const run = await repo.runs.modeByWorktree(info.cwd).catch(() => null);
  const mayPush = !run || require('../dispatch/modes.ts').mode(run.mode).mayPush;
  const created = mayPush ? await hub.createSession(spec) : await require('../dispatch/remote.ts').createNoPushSession(hub, spec, machine);
  // Resuming an existing Claude Code session is not a factory job (D28 covers
  // new dispatches): its usage is not metered. Logged and put on the Meter as a
  // call of unknown cost, never silent.
  log.warn('resumed a Claude Code session outside the factory: metered-unknown', { item: Number(itemId), machine });
  await require('../budget.ts').record({ purpose: 'session-resume-unmetered', model: null, backend: 'claude_session_unmetered', costUsd: null, ok: true }).catch(() => {});
  return { ok: true, url: `${hub.base}/#session=${encodeURIComponent(created.id)}`, resumed: true };
}

function dedupe(links: Link[]) {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = l.url.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { enrich, forCommitments, buildSummary, chainsFor, hubs, openSession };
