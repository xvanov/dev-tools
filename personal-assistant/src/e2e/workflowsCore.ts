'use strict';

// `pa e2e <workflow>` (plan 8.2): the pure part. The workflows are the Map's
// examples (architecture.json `examples`, each with an 8.1 `acceptance`
// block); this module reads them, scores what a run measured against them,
// and shapes the evidence summary. The runners are in workflows.ts.
//
//   workflows(arch)                      ids that have an acceptance block (not out of scope)
//   acceptance(arch, id)                 one workflow's block, or throws
//   scoreHops(hops, measured)            the block's hops with what was measured, ok per hop
//   scoreCost(usd, limits, id, basis)    cost against GET /api/workflow-limits' effective ceiling
//   missingViews(views, ...names)        the block's views no screenshot covers yet
//   shotChecks(shots)                    a failed check per view the browser could not shoot
//   folderName(id, at, dry)              the run folder's name
//   summary({...})                       the JSON summary written next to the evidence
//   wav(pcm, rate)                       raw 16-bit mono PCM -> a WAV file (TTS output -> transcribe input)
//   prFacts / prReady / reviewFixChecks  review-fix: its PR before and after the job, held to the outcome
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
/** architecture.json, read key by key. */
type Arch = Json;
type Hop = { c: string; what: string; max_ms?: number | null; unbounded?: string | null };
/** A measured hop: ms, or {ms, note} when it carries a note (or could not be measured). */
type Measured = Record<string, number | { ms?: number | null; note?: string } | null | undefined>;
type HopRow = { c: string; what: string; max_ms: number | null; unbounded: string | null; ms?: number | null; ok?: boolean | null; note?: string };
type Cost = { usd: number | null; max_usd: number | null; custom: boolean; basis: string | null; ok: boolean | null };
type Check = { view?: string; check: string; ok: boolean; detail?: string };
type Summary = {
  ok: boolean; workflow: string; kind: string; folder: string | null; startedAt: string | null; hops: HopRow[]; cost: Cost | null;
  links: Json; views: Json; transcripts: Json[]; screenshots: Json[]; rubric: Array<{ id: string; check: string; result: null }>;
  checks: Check[]; failed: string[]; errors: string[]; cleanup: string[]; notes: string[];
};

const REAL_RUN: Record<string, { self: boolean; needs: string }> = {
  // What a real run needs and touches. `self: false` means a real input would
  // reach other people: the run then needs a dummy input the user names, and
  // never messages anyone.
  'whats-on': { self: true, needs: 'the voice service and the fast lane (local models)' },
  research: { self: true, needs: 'the factory (claude_session research job)' },
  'deepseek-pr': { self: true, needs: 'the factory API runtime with a DeepSeek model (Azure deployment by default)' },
  'review-fix': { self: true, needs: 'an open PR of yours with unresolved review comments: --pr <n> [--repo owner/name] (left open; only the fix is pushed)' },
  'teams-ask': { self: false, needs: 'a test Teams chat with only you in it: --test-chat <id> (never a colleague)' },
};

// --- review-fix: one PR read, before and after the job ----------------------------------------

/** One GraphQL read: the PR (head, state, threads, CI on its head) and the repo's newest PR. */
const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number state merged isDraft isCrossRepository url headRefName headRefOid baseRefName
      reviewThreads(first: 100) { nodes { isResolved } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
    }
    pullRequests(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number } }
  }
}`;

/** What review-fix reads about its PR (PR_QUERY), flattened. */
type PrFacts = {
  number: number; state: string; merged: boolean; draft: boolean; fork: boolean; url: string | null;
  branch: string | null; head: string | null; base: string | null; unresolved: number; threads: number;
  ci: string | null; newestPr: number | null;
};

/** Pure. PR_QUERY's answer as PrFacts; null when the PR is not there. */
function prFacts(raw: Json | null | undefined): PrFacts | null {
  const repo = raw?.data?.repository;
  const pr = repo?.pullRequest;
  if (!pr || typeof pr !== 'object') return null;
  const threads: Json[] = Array.isArray(pr.reviewThreads?.nodes) ? pr.reviewThreads.nodes : [];
  const last = Array.isArray(pr.commits?.nodes) ? pr.commits.nodes[0]?.commit : null;
  const newest = Number(repo?.pullRequests?.nodes?.[0]?.number);
  return {
    number: Number(pr.number), state: String(pr.state || ''), merged: Boolean(pr.merged), draft: Boolean(pr.isDraft), fork: Boolean(pr.isCrossRepository),
    url: pr.url || null, branch: pr.headRefName || null, head: pr.headRefOid || null, base: pr.baseRefName || null,
    unresolved: threads.filter((t) => t && !t.isResolved).length, threads: threads.length,
    ci: last && (!pr.headRefOid || last.oid === pr.headRefOid) ? (last.statusCheckRollup?.state || 'NONE') : null,
    newestPr: Number.isInteger(newest) ? newest : null,
  };
}

/** Pure. Whether a PR can be review-fixed: there, open, ours, with something to fix. */
function prReady(pr: PrFacts | null, n: number, repo: string): Check[] {
  const view = 'github';
  if (!pr) return [{ view, check: `PR #${n} exists in ${repo}`, ok: false, detail: 'not found' }];
  return [
    { view, check: `PR #${n} exists in ${repo}`, ok: true, detail: `${pr.branch} → ${pr.base}, head ${String(pr.head).slice(0, 10)}` },
    { view, check: `PR #${n} is open`, ok: pr.state === 'OPEN' && !pr.merged, detail: pr.merged ? 'merged' : pr.state.toLowerCase() },
    { view, check: `PR #${n} is from a branch of ${repo}`, ok: !pr.fork, ...(pr.fork ? { detail: 'from a fork: the factory cannot push to it' } : {}) },
    { view, check: `PR #${n} has unresolved review threads`, ok: pr.unresolved > 0, detail: `${pr.unresolved} of ${pr.threads} unresolved` },
  ];
}

/** CI rollup states that are still running (GitHub StatusState). */
const CI_PENDING = new Set(['PENDING', 'EXPECTED']);

/**
 * Pure. The review-fix outcome (8.4.25): the same PR got new commits by
 * fast-forward (`compare` = GitHub's compare of the old head to the new:
 * status `ahead` means the old head is an ancestor, so nothing was force-pushed),
 * no new PR was opened, nothing was merged, CI is green on the new head.
 */
function reviewFixChecks(before: PrFacts, after: PrFacts | null, compare: Json | null): Check[] {
  const view = 'github';
  if (!after) return [{ view, check: `PR #${before.number} still there after the job`, ok: false, detail: 'not found' }];
  const moved = Boolean(after.head && after.head !== before.head);
  const ff = moved && compare?.status === 'ahead';
  return [
    { view, check: `PR #${before.number} got new commits`, ok: moved, detail: moved ? `${String(before.head).slice(0, 10)} → ${String(after.head).slice(0, 10)}${compare?.ahead_by != null ? ` (+${compare.ahead_by})` : ''}` : 'head unchanged' },
    { view, check: 'pushed fast-forward (no force push)', ok: ff, detail: !moved ? 'nothing pushed' : compare ? `compare ${compare.status}${compare.behind_by ? `, ${compare.behind_by} behind` : ''}` : 'compare not readable' },
    { view, check: 'same branch, no new PR opened', ok: after.branch === before.branch && after.newestPr === before.newestPr, detail: `newest PR #${after.newestPr} (was #${before.newestPr})` },
    { view, check: 'nothing merged; the PR is still open', ok: after.state === 'OPEN' && !after.merged, detail: after.merged ? 'merged' : after.state.toLowerCase() },
    { view, check: 'CI green on the new head', ok: moved && after.ci === 'SUCCESS', detail: `CI ${after.ci || 'unknown'}${after.ci && CI_PENDING.has(after.ci) ? ' (still running at the deadline)' : ''}` },
  ];
}

function workflows(arch: Arch | null | undefined): string[] {
  return ((arch?.examples || []) as Json[]).filter((x) => x.acceptance && !x.acceptance.outOfScope).map((x) => x.id);
}

function acceptance(arch: Arch | null | undefined, id: string): Json {
  const x = ((arch?.examples || []) as Json[]).find((e) => e.id === id);
  if (!x) throw Object.assign(new Error(`no workflow "${id}" in the Map; one of: ${workflows(arch).join(', ')}`), { usage: true });
  if (!x.acceptance || x.acceptance.outOfScope) {
    throw Object.assign(new Error(`workflow "${id}" is out of scope: ${x.acceptance?.outOfScope || 'no acceptance block'}`), { usage: true });
  }
  return { id: x.id, title: x.title, say: x.say, ...x.acceptance };
}

/**
 * Pure. Each acceptance hop with the measured ms (keyed by the hop's component
 * `c`, or `c:n` when a component appears twice). A hop with `max_ms` passes
 * when measured within it; an `unbounded` hop is reported, never failed; a hop
 * that could not be measured headless says why and is not counted as a pass.
 */
function scoreHops(hops: Hop[] = [], measured: Measured = {}): HopRow[] {
  const seen: Record<string, number> = {};
  return hops.map((h) => {
    const n = (seen[h.c] || 0) + 1;
    seen[h.c] = n;
    const key = n > 1 ? `${h.c}:${n}` : h.c;
    const m = measured[key];
    const row: HopRow = { c: h.c, what: h.what, max_ms: h.max_ms ?? null, unbounded: h.unbounded || null };
    if (m == null || (typeof m === 'object' && m.ms == null)) {
      row.ms = null;
      row.ok = h.unbounded ? true : null;
      row.note = (typeof m === 'object' && m?.note) || 'not measured';
      return row;
    }
    const ms = (typeof m === 'object' ? m.ms : m) as number;
    row.ms = Math.round(ms);
    if (typeof m === 'object' && m.note) row.note = m.note;
    row.ok = h.max_ms != null ? ms <= h.max_ms : true;
    return row;
  });
}

/**
 * Pure. The jarvis hop (8.4.22): factory_start's round trip less the brief's
 * composing model call, which the hop's target excludes. factory_start reports
 * it in `timings_ms.compose_model`; a PA that does not is timed whole and says so.
 */
function toolCallMs(call: { ms: number } | null | undefined, started: Json | null | undefined): { ms: number | null; note: string } {
  if (!call) return { ms: null, note: 'factory_start was not called' };
  const model = Number(started?.timings_ms?.compose_model);
  if (!Number.isFinite(model) || model < 0) return { ms: call.ms, note: 'factory_start round trip, including the brief composing model (no timings_ms.compose_model)' };
  return { ms: Math.max(0, call.ms - model), note: `factory_start round trip ${Math.round(call.ms)} ms less the composing model's ${Math.round(model)} ms` };
}

/** Pure. Cost against the effective ceiling (the user's override, else the Map's default). */
function scoreCost(usd: number | string | null | undefined, limits: Json | null | undefined, id: string, basis: string | null = null): Cost {
  const lim = limits?.limits?.[id] || null;
  const max = lim ? Number(lim.effective) : null;
  const spent = usd == null ? null : Math.round(Number(usd) * 10000) / 10000;
  return {
    usd: spent,
    max_usd: max != null && Number.isFinite(max) ? max : null,
    custom: Boolean(lim?.custom),
    basis,
    ok: spent == null || max == null ? null : spent <= max + 1e-9,
  };
}

/** Pure. The acceptance block's views that no shot or page name covers (`run-<session>` covers run). */
function missingViews(views: unknown, ...names: string[][]): string[] {
  const have = new Set(names.flat().map((n) => String(n).split('-')[0]));
  return (Array.isArray(views) ? views.map(String) : []).filter((v) => !have.has(v));
}

/** Pure. A failed check for each view a browser could not shoot (8.4.40); none when no browser was found (the run's note says so). */
function shotChecks(shots: Json[] | null | undefined): Check[] {
  return (Array.isArray(shots) ? shots : []).filter((x) => x && !x.file).map((x) => ({ view: 'evidence', check: `screenshot of ${x.view}`, ok: false, detail: String(x.error || 'no file').slice(0, 300) }));
}

function folderName(id: string, at: Date | number | string = new Date(), dry = false): string {
  const stamp = new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${id}${dry ? '-dry' : ''}`;
}

/** Pure. The run's JSON summary. `ok` needs no failed check, hop or cost and no error. */
function summary({ workflow, kind, folder, startedAt, hops = [], cost = null, links = {}, views = {}, transcripts = [], screenshots = [], checks = [], rubric = [], errors = [], cleanup = [], notes = [] }: {
  workflow: string; kind: string; folder: string | null; startedAt: string | null; hops?: HopRow[]; cost?: Cost | null; links?: Json; views?: Json;
  transcripts?: Json[]; screenshots?: Json[]; checks?: Check[]; rubric?: Array<{ id: string; check: string }>; errors?: string[]; cleanup?: string[]; notes?: string[];
}): Summary {
  const failed = [
    ...checks.filter((c) => !c.ok).map((c) => `${c.view || 'check'}: ${c.check}${c.detail ? ` (${c.detail})` : ''}`),
    ...hops.filter((h) => h.ok === false).map((h) => `hop ${h.c} (${h.what}): ${h.ms} ms > ${h.max_ms} ms`),
    ...(cost && cost.ok === false ? [`cost $${cost.usd} > ceiling $${cost.max_usd}`] : []),
  ];
  return {
    ok: !errors.length && !failed.length,
    workflow,
    kind,
    folder,
    startedAt,
    hops,
    cost,
    links,
    views,
    transcripts,
    screenshots,
    // The rubric is scored by the reviewer session (8.3) from this evidence.
    rubric: rubric.map((r) => ({ id: r.id, check: r.check, result: null })),
    checks,
    failed,
    errors,
    cleanup,
    notes,
  };
}

/** Pure. A one-screen text view of a summary. */
function table(s: Summary): string {
  const lines = [`pa e2e ${s.workflow} ${s.kind} · ${s.folder || ''}`];
  if (s.hops.length) {
    lines.push('');
    for (const h of s.hops) {
      const target = h.max_ms != null ? `≤ ${h.max_ms} ms` : 'unbounded';
      const got = h.ms != null ? `${h.ms} ms` : h.note || '-';
      lines.push(`  ${h.ok === false ? 'FAIL' : h.ok ? 'ok  ' : '--  '} ${h.c.padEnd(15)} ${got.padEnd(28)} ${target}  ${h.what}`);
    }
  }
  if (s.cost) lines.push(`  cost $${s.cost.usd ?? '?'} of $${s.cost.max_usd ?? '?'}${s.cost.custom ? ' (your ceiling)' : ''}${s.cost.basis ? ` · ${s.cost.basis}` : ''}`);
  const byView = new Map<string | undefined, { ok: number; n: number }>();
  for (const c of s.checks) {
    const v = byView.get(c.view) || { ok: 0, n: 0 };
    v.n++;
    if (c.ok) v.ok++;
    byView.set(c.view, v);
  }
  if (byView.size) lines.push(`  checks: ${[...byView].map(([v, x]) => `${v} ${x.ok}/${x.n}`).join(' · ')}`);
  for (const f of s.failed) lines.push(`  FAIL ${f}`);
  for (const e of s.errors) lines.push(`  ERROR ${e}`);
  for (const n of s.notes) lines.push(`  note ${n}`);
  for (const c of s.cleanup) lines.push(`  cleanup ${c}`);
  if (s.screenshots.length) lines.push(`  screenshots: ${s.screenshots.length}`);
  lines.push('', s.ok ? '  OK' : '  FAILED');
  return lines.join('\n');
}

/** Pure. Raw 16-bit little-endian mono PCM -> a WAV file. */
function wav(pcm: Buffer | Uint8Array | number[], rate = 24000): Buffer {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Pure. NDJSON text (a fast-lane turn) -> events; a bad line is skipped. */
function ndjson(text: unknown): Json[] {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean) as Json[];
}

module.exports = { REAL_RUN, PR_QUERY, CI_PENDING, prFacts, prReady, reviewFixChecks, workflows, acceptance, scoreHops, toolCallMs, scoreCost, missingViews, shotChecks, folderName, summary, table, wav, ndjson };
