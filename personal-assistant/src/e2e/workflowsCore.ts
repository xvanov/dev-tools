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
//   jobPrs(job)                          review-fix: the PRs and branches a job status calls its own
//   teamsMarker / teamsPhrase            teams-ask: what you type into the test chat (the run sends nothing)
//   ownerIds / testChatChecks            teams-ask: the test chat is stored and only you are in it
//   teamsHops / teamsCardChecks          teams-ask: the hops on the rows' own clocks; person, due, link
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
  'teams-ask': { self: false, needs: 'a test Teams chat with only you in it: --test-chat <id> (your self chat; never a colleague). You type the phrase the run prints; nothing is sent' },
};

// --- teams-ask: your own message in a test chat ------------------------------------------------

const TEAMS_MARKER_MIN = 40;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The run's marker, `e2e-teams-<uuid>`: long enough that no other message in the chat holds it. */
function teamsMarker(uuid: string): string {
  const m = `e2e-teams-${uuid}`;
  if (m.length < TEAMS_MARKER_MIN) throw new Error(`teams-ask marker too short (${m.length} < ${TEAMS_MARKER_MIN})`);
  return m;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * What you type into the test chat: an ask of yourself with an absolute due
 * date (the next Friday on this machine's calendar, a week out when today is
 * one) and the marker. `due` is that day, YYYY-MM-DD.
 */
function teamsPhrase(marker: string, now: Date | number = Date.now()): { text: string; due: string } {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + (((5 - d.getDay() + 7) % 7) || 7));
  const day = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return { text: `Note to self: send the e2e test numbers to the team by ${day}. ${marker}`, due: ymd(d) };
}

/** Your identities as chat authors are stored: lowercased addresses and `aad:<oid>`. */
function ownerIds(me: Json | null | undefined, identities: Json[] = []): Set<string> {
  const out = new Set<string>();
  if (me?.primary_email) out.add(String(me.primary_email).toLowerCase());
  for (const i of identities || []) {
    const v = String(i?.value || '').toLowerCase();
    if (!v) continue;
    if (i.kind === 'smtp') out.add(v);
    else if (i.kind === 'aad_oid') out.add(`aad:${v}`);
  }
  return out;
}

/**
 * The dry run's word on --test-chat, from the store alone: the chat is there,
 * it is a chat (not one of Teams' own threads), only you wrote in it, and
 * only you are in it (your self chat, or a member list of your addresses).
 * Details carry counts, never who the others are.
 */
function testChatChecks(chat: string, { authors = [], head = null, mine, system = false, self = false }: { authors?: Json[]; head?: Json | null; mine: Set<string>; system?: boolean; self?: boolean }): Check[] {
  const total = authors.reduce((n: number, a: Json) => n + Number(a.n || 0), 0);
  const others = authors.filter((a: Json) => !a.author || !mine.has(String(a.author)));
  const otherMsgs = others.reduce((n: number, a: Json) => n + Number(a.n || 0), 0);
  const emails: string[] = Array.isArray(head?.raw?.memberEmails) ? head.raw.memberEmails.map((e: unknown) => String(e).toLowerCase()) : [];
  const strangers = emails.filter((e) => !mine.has(e));
  const isSelf = self || head?.raw?.chatType === 'self';
  const chk = (name: string, ok: unknown, detail?: string): Check => ({ view: 'run', check: name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  return [
    chk(`test chat ${chat} is in the store`, total > 0, total ? `${total} message(s)` : 'no message from it is stored: write one there first, or check the id'),
    chk("test chat is a chat, not one of Teams' own threads", !system || isSelf, system && !isSelf ? 'drafts, mentions and notifications threads are skipped by ingest (8.4.35)' : undefined),
    chk('only you wrote in it', total > 0 && otherMsgs === 0, otherMsgs ? `${otherMsgs} of ${total} message(s) by ${others.length} other author(s)` : total ? `${total} message(s), all yours` : undefined),
    chk('only you are in it', isSelf || (emails.length > 0 && strangers.length === 0),
      isSelf ? 'your self chat' : emails.length ? (strangers.length ? `${strangers.length} other member(s)` : `${emails.length} member address(es), all yours`) : 'no member list stored for it'),
  ];
}

const ms = (v: unknown) => (v == null ? null : new Date(v as string).getTime());

/**
 * The hops, each from the rows' own clocks (Teams' arrival stamp, the row's
 * storedAt, the commitment's extracted_at) to the next, plus what the run saw:
 * the card in GET /api/state after its board event, the toast's toasted_at.
 * A hop not reached is {ms: null, note}.
 */
function teamsHops(t: { sent?: unknown; stored?: unknown; storedHow?: string; card?: unknown; board?: number | null; boardNote?: string; toast?: unknown; toastNote?: string }): Measured {
  const [sent, stored, card, toast] = [ms(t.sent), ms(t.stored), ms(t.card), ms(t.toast)];
  const out: Measured = {};
  out.ingest = sent != null && stored != null
    ? { ms: stored - sent, note: `Teams' arrival stamp to the stored row (${t.storedHow || 'raw.storedAt'}); the cache write follows the arrival, so this is an upper bound` }
    : { ms: null, note: 'the message was not stored' };
  out.commitments = stored != null && card != null ? { ms: card - stored, note: 'stored row to the commitment (extracted_at)' } : { ms: null, note: 'no owed_by_me commitment' };
  out.dashboard = card != null && t.board != null
    ? { ms: t.board - card, note: t.boardNote || 'extracted_at to GET /api/state holding the card, refetched on its board event' }
    : { ms: null, note: t.boardNote || 'the card never showed on the board' };
  out.notify = card != null && toast != null ? { ms: toast - card, note: t.toastNote || 'extracted_at to the toast (toasted_at)' } : { ms: null, note: t.toastNote || 'no toast' };
  return out;
}

/**
 * The rubric on the card as the board reads it (GET /api/commitments/<id>):
 * person (in your own test chat the asker is you), due (the phrase's day, in
 * this machine's calendar or UTC, as the model may write either), link (the
 * Teams deep link to this very message, never the local copy's -1).
 */
function teamsCardChecks(card: Json, { item, due, meName }: { item: Json; due: string; meName: string | null }): Check[] {
  const chk = (name: string, ok: unknown, detail?: string): Check => ({ view: 'card', check: name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  const dueAt = card?.due_at ? new Date(card.due_at) : null;
  const days = dueAt && !Number.isNaN(dueAt.getTime()) ? [ymd(dueAt), dueAt.toISOString().slice(0, 10)] : [];
  const msgId = String(item?.raw?.messageId ?? String(item?.external_id || '').split('/').pop() ?? '');
  const url = String(card?.web_url || '');
  const isYou = Boolean(meName) && String(card?.who || '').trim().toLowerCase() === String(meName).trim().toLowerCase();
  return [
    chk('owed_by_me', card?.direction === 'owed_by_me', card?.direction || 'no direction'),
    chk('person: names who asked (you, in your own test chat)', card?.who && isYou, card?.who ? (isYou ? 'you' : 'someone else') : 'no person on the card'),
    chk(`due: ${due}`, days.includes(due), dueAt ? `due_at ${dueAt.toISOString()}` : 'no due date'),
    chk('link: opens this message', msgId && msgId !== '-1' && /^https:\/\/teams\.microsoft\.com\/l\/message\//.test(url) && url.includes(`/${msgId}`), url ? `message ${msgId}` : 'no Teams link'),
  ];
}

// --- review-fix: one PR read, before and after the job ----------------------------------------

/** One GraphQL read: the PR (head, state, threads, CI on its head) and the repo's newest PRs with their branches. */
const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number state merged isDraft isCrossRepository url headRefName headRefOid baseRefName
      reviewThreads(first: 100) { nodes { isResolved } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
    }
    pullRequests(first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number headRefName } }
  }
}`;

/** What review-fix reads about its PR (PR_QUERY), flattened. */
type PrFacts = {
  number: number; state: string; merged: boolean; draft: boolean; fork: boolean; url: string | null;
  branch: string | null; head: string | null; base: string | null; unresolved: number; threads: number;
  ci: string | null; newestPr: number | null; recent: Array<{ number: number; branch: string | null }>;
};
/** What the job says is its own (job status): its PRs' numbers and the branches it pushed. */
type JobPrs = { prs: number[]; branches: string[] };

/** Pure. PR_QUERY's answer as PrFacts; null when the PR is not there. */
function prFacts(raw: Json | null | undefined): PrFacts | null {
  const repo = raw?.data?.repository;
  const pr = repo?.pullRequest;
  if (!pr || typeof pr !== 'object') return null;
  const threads: Json[] = Array.isArray(pr.reviewThreads?.nodes) ? pr.reviewThreads.nodes : [];
  const last = Array.isArray(pr.commits?.nodes) ? pr.commits.nodes[0]?.commit : null;
  const nodes: Json[] = Array.isArray(repo?.pullRequests?.nodes) ? repo.pullRequests.nodes : [];
  const newest = Number(nodes[0]?.number);
  return {
    number: Number(pr.number), state: String(pr.state || ''), merged: Boolean(pr.merged), draft: Boolean(pr.isDraft), fork: Boolean(pr.isCrossRepository),
    url: pr.url || null, branch: pr.headRefName || null, head: pr.headRefOid || null, base: pr.baseRefName || null,
    unresolved: threads.filter((t) => t && !t.isResolved).length, threads: threads.length,
    ci: last && (!pr.headRefOid || last.oid === pr.headRefOid) ? (last.statusCheckRollup?.state || 'NONE') : null,
    newestPr: Number.isInteger(newest) ? newest : null,
    recent: nodes.filter((p) => Number.isInteger(Number(p?.number))).map((p) => ({ number: Number(p.number), branch: p.headRefName || null })),
  };
}

/** Pure. The job's own PRs and branches from its status (`pr_urls`, its stories' PRs and branches, its base). */
function jobPrs(job: Json | null | undefined): JobPrs {
  const prs = new Set<number>();
  const branches = new Set<string>();
  const num = (url: unknown) => Number((/\/pull\/(\d+)/.exec(String(url || '')) || [])[1]);
  for (const u of Array.isArray(job?.pr_urls) ? job.pr_urls : []) if (num(u) > 0) prs.add(num(u));
  for (const s of Array.isArray(job?.stories) ? job.stories : []) {
    const n = Number(s?.pr_number) || num(s?.pr_url);
    if (n > 0) prs.add(n);
    if (s?.branch) branches.add(String(s.branch));
  }
  if (job?.base?.branch) branches.add(String(job.base.branch));
  return { prs: [...prs], branches: [...branches] };
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
 * the job opened no new PR, nothing was merged, CI is green on the new head.
 * A new PR is the job's when the job links it (`job`: jobPrs) or its head is
 * one of the job's branches; others' PRs opened meanwhile do not count (8.4.42:
 * a second factory works the same repo).
 */
function reviewFixChecks(before: PrFacts, after: PrFacts | null, compare: Json | null, job: JobPrs = { prs: [], branches: [] }): Check[] {
  const view = 'github';
  if (!after) return [{ view, check: `PR #${before.number} still there after the job`, ok: false, detail: 'not found' }];
  const moved = Boolean(after.head && after.head !== before.head);
  const ff = moved && compare?.status === 'ahead';
  const branches = new Set([before.branch, ...job.branches].filter(Boolean));
  const opened = after.recent.filter((p) => p.number > (before.newestPr ?? before.number) && p.number !== before.number);
  const ours = [...new Set([...job.prs.filter((n) => n !== before.number), ...opened.filter((p) => p.branch && branches.has(p.branch)).map((p) => p.number)])].sort((a, b) => a - b);
  const others = opened.filter((p) => !ours.includes(p.number)).map((p) => p.number);
  const prDetail = ours.length
    ? `new PR${ours.length > 1 ? 's' : ''} ${ours.map((n) => `#${n}`).join(', ')} from the job`
    : `the job's only PR is #${before.number}${others.length ? `; ${others.map((n) => `#${n}`).join(', ')} opened meanwhile from other branches, not counted` : ''}`;
  return [
    { view, check: `PR #${before.number} got new commits`, ok: moved, detail: moved ? `${String(before.head).slice(0, 10)} → ${String(after.head).slice(0, 10)}${compare?.ahead_by != null ? ` (+${compare.ahead_by})` : ''}` : 'head unchanged' },
    { view, check: 'pushed fast-forward (no force push)', ok: ff, detail: !moved ? 'nothing pushed' : compare ? `compare ${compare.status}${compare.behind_by ? `, ${compare.behind_by} behind` : ''}` : 'compare not readable' },
    { view, check: 'same branch, no new PR opened', ok: after.branch === before.branch && !ours.length, detail: after.branch === before.branch ? prDetail : `branch ${after.branch} (was ${before.branch}); ${prDetail}` },
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

module.exports = { REAL_RUN, TEAMS_MARKER_MIN, teamsMarker, teamsPhrase, ownerIds, testChatChecks, teamsHops, teamsCardChecks, PR_QUERY, CI_PENDING, prFacts, prReady, jobPrs, reviewFixChecks, workflows, acceptance, scoreHops, toolCallMs, scoreCost, missingViews, shotChecks, folderName, summary, table, wav, ndjson };
