'use strict';

// `pa e2e <workflow>` (plan 8.2): the pure part. The workflows are the Map's
// examples (architecture.json `examples`, each with an 8.1 `acceptance`
// block); this module reads them, scores what a run measured against them,
// and shapes the evidence summary. The runners are in workflows.js.
//
//   workflows(arch)                      ids that have an acceptance block (not out of scope)
//   acceptance(arch, id)                 one workflow's block, or throws
//   scoreHops(hops, measured)            the block's hops with what was measured, ok per hop
//   scoreCost(usd, limits, id, basis)    cost against GET /api/workflow-limits' effective ceiling
//   folderName(id, at, dry)              the run folder's name
//   summary({...})                       the JSON summary written next to the evidence
//   wav(pcm, rate)                       raw 16-bit mono PCM -> a WAV file (TTS output -> transcribe input)
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
  'review-fix': { self: true, needs: 'an existing PR of yours with review comments: --pr <n>' },
  'teams-ask': { self: false, needs: 'a test Teams chat with only you in it: --test-chat <id> (never a colleague)' },
};

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

module.exports = { REAL_RUN, workflows, acceptance, scoreHops, scoreCost, folderName, summary, table, wav, ndjson };
