'use strict';

// `pa e2e <workflow>` (plan 8.2): each workflow in the Map (architecture.json
// `examples`) run against the live stack, with evidence for the reviewer
// sessions (8.3): per-hop timings against the workflow's 8.1 acceptance
// block, every link, transcripts, a screenshot of each view except Ask (that one
// is the tool check: summary views.ask, method tool, an excerpt of the answer),
// and cost against
// the effective ceiling (GET /api/workflow-limits). Everything lands in a run
// folder (<PA data dir>/e2e/<stamp>-<workflow>[-dry]/) with summary.json.
//
// Dummy inputs only where a real one would reach other people: teams-ask needs
// a test chat with only you in it. Nothing
// here ever messages anyone. `--on <machine>` runs the workflow on that stack
// (goldenPath.remote) and brings its summary back.
//
//   whats-on     TTS'd question, replayed as the talk page: warm, smart-turn + transcribe, turn, TTS at the first piece
//   build-pr, build-continue-pr, research   Build runs (buildRunners.ts)
//   teams-ask    --test-chat <id> (a chat with only you in it): you type the phrase it prints; it follows that
//                message stored -> distilled -> card on the board -> new_ask toast, checks person/due/link, drops the card
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
/** goldenPath's deps plus this module's (deps0()); tests hand over partial fakes. */
type Deps = Json;
/** goldenPathCore.parseOptions()'s options plus question, pr, testChat (parse()). */
type Options = Json;
/** A workflow's 8.1 acceptance block (architecture.json), read key by key. */
type Acceptance = Json;
type Flags = Record<string, string | boolean | undefined>;
type Lists = { timeout?: string[] };
type Check = { view: string; check: string; ok: boolean; detail?: string };
type Measured = Record<string, number | { ms: number | null; note?: string } | null>;
/** `ready`: a JS expression the page must satisfy before its shot (screens.ts; default: the view's own signal). */
type Page = { name: string; url: string; ready?: string | null | undefined };
/** What one runner hands back to main(). */
type RunOut = {
  measured: Measured; checks: Check[]; transcripts: string[]; links: Json; notes: string[]; cleanup: string[]; errors: string[];
  usd: number | null; pages: Page[]; shots?: { shots: Json[]; note: string | null } | undefined; golden?: Json;
  ask?: { method: 'tool'; tool: string; excerpt: string } | undefined;
};
type Runner = (acc: Acceptance, o: Options, deps: Deps, folder: string) => Promise<Partial<RunOut>>;

const fs = require('fs');
const path = require('path');
const W = require('./workflowsCore.ts');
const C = require('./goldenPathCore.ts');
const G = require('./goldenPath.ts');
const S = require('./screens.ts');


function deps0(): Deps {
  const d = G.defaultDeps();
  const factory = require('../dispatch/factory.ts');
  const repo = require('../repo');
  return {
    ...d,
    arch: () => require('../dashboard/architecture.json'),
    async post(url: string, body: Json | Buffer, { raw = false, timeoutMs = 60_000, onChunk = null }: { raw?: boolean; timeoutMs?: number; onChunk?: ((chunk: Buffer) => void) | null } = {}) {
      const isBuf = Buffer.isBuffer(body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'X-PA': '1', 'Content-Type': isBuf ? 'audio/wav' : 'application/json' },
        body: isBuf ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${res.status} on ${url}: ${(await res.text()).slice(0, 160)}`);
      if (onChunk && res.body) {
        const reader = res.body.getReader();
        const parts: Buffer[] = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parts.push(Buffer.from(value));
          onChunk(Buffer.from(value));
        }
        return raw ? Buffer.concat(parts) : Buffer.concat(parts).toString('utf8');
      }
      return raw ? Buffer.from(await res.arrayBuffer()) : res.text();
    },
    spendToday: () => require('../budget.ts').status().then((s: Json) => s.today),
    jobReport: (id: string) => factory.report(id),
    // On the factory's own machine (where --on runs the dry run), claude as the factory finds it: termhub's exec PATH lacks ~/.local/bin (8.4.43).
    claudeAuth: () => {
      const m = factory.machine();
      return d.runCommand(m, [m ? 'claude' : require('../config.ts').claudeBinary(), 'auth', 'status'], { timeoutMs: 30_000 });
    },
    fastLaneOn: () => Boolean(d.config.fastLane?.enabled),
    hubBase: (machine: string | null | undefined) => require('../dispatch/termhub.ts').forMachine(machine || null).base,
    capture: (dir: string, pages: Page[]) => S.capture(dir, pages),
    browser: () => S.browser(),
    write(file: string, text: string | Buffer) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    root: () => path.join(d.config.dataDir, 'e2e'),
    // teams-ask: the store's view of the test chat and of the one message the run follows.
    chatAuthors: (chat: string) => repo.sources.chatAuthors(chat),
    chatHead: async (chat: string) => (await repo.sources.chatHeads([chat]))[0] || null,
    owner: async () => ({ me: await repo.people.meRow(), identities: await repo.people.myIdentities() }),
    chatItemWith: (chat: string, marker: string) => repo.sources.chatItemWith(chat, marker),
    itemCommitments: (itemId: number | string) => repo.commitments.ofItem(itemId),
    notificationByKey: (key: string) => repo.notifications.byKey(key),
    // What you must do now: stderr, unprefixed, so --json's stdout stays the summary.
    say: (text: string) => process.stderr.write(`${text}\n`),
  };
}

function check(view: string, name: string, ok: unknown, detail?: unknown): Check {
  return { view, check: name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) };
}

/**
 * The views' screenshots, always back by `deps.shotMs` a page (8.4.40): a
 * capture that throws or stalls comes back as shot errors (failed checks in
 * the summary), so the run still writes its summary and cleans up.
 */
async function screenshots(deps: Deps, dir: string, pages: Page[]): Promise<{ shots: Json[]; note: string | null }> {
  if (!pages.length) return { shots: [], note: null };
  const ms = pages.length * (deps.shotMs || 150_000);
  const failed = (why: string) => ({ shots: pages.map((p) => ({ view: p.name, url: p.url, file: null, error: why })), note: null });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ shots: Json[]; note: string | null }>((r) => { timer = setTimeout(() => r(failed(`no screenshots after ${Math.round(ms / 1000)} s`)), ms); });
  try {
    return await Promise.race([Promise.resolve().then(() => deps.capture(dir, pages)), deadline])
      .catch((err: Error) => failed(`screenshots failed: ${(err?.message || String(err)).slice(0, 200)}`));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------- dry checks ----

async function commonDry(id: string, acc: Acceptance, deps: Deps): Promise<{ checks: Check[]; limits: Json | null }> {
  const out: Check[] = [];
  out.push(check('map', `acceptance block for ${id}`, acc && Array.isArray(acc.hops), `${acc.hops.length} hops, ${acc.rubric?.length || 0} rubric items`));
  const lim = await G.safely(() => deps.getJson(`${deps.paBase}/api/workflow-limits`));
  out.push(check('map', 'GET /api/workflow-limits', lim.ok && lim.value?.limits?.[id], lim.ok ? `effective $${lim.value?.limits?.[id]?.effective}` : lim.error));
  return { checks: out, limits: lim.ok ? lim.value : null };
}

async function claudeDry(deps: Deps): Promise<Check> {
  const r = await G.safely(() => deps.claudeAuth());
  const ok = r.ok && r.value.code === 0 && /claude\.ai|subscription|"loggedIn":\s*true/i.test(r.value.stdout + r.value.stderr);
  return check('run', 'claude logged in (subscription)', ok, r.ok ? (r.value.stdout || r.value.stderr).trim().split('\n')[0] : r.error);
}

async function dry(id: string, acc: Acceptance, o: Options, deps: Deps): Promise<{ checks: Check[]; limits: Json | null; notes: string[] }> {
  const { checks, limits } = await commonDry(id, acc, deps);
  const notes: string[] = [];
  if (id === 'whats-on') {
    const v = await G.safely(() => deps.getJson(`${deps.paBase}/api/talk/voice`));
    checks.push(check('ask', 'voice service (GET /api/talk/voice)', v.ok && v.value?.tts?.ok, v.ok ? (v.value?.tts?.ok ? `TTS on ${v.value.tts.device}` : v.value?.tts?.error || 'down') : v.error));
    checks.push(check('ask', 'fast lane on (PA_FAST_LANE)', deps.fastLaneOn()));
  } else if (id === 'build-pr' || id === 'build-continue-pr' || id === 'research') {
    const tools = require('../mcp/chatTools.ts');
    checks.push(check('ask', 'chat tool build_start', tools.CHAT_ACTION_TOOL_NAMES.includes('build_start')));
    checks.push(G.policyDry('build_start'));
    const b = await G.safely(() => deps.getJson(`${deps.paBase}/api/build?limit=1`));
    checks.push(check('build', 'GET /api/build answers', b.ok && Array.isArray(b.value?.runs), b.error));
    checks.push(await claudeDry(deps));
    if (id !== 'research') {
      const r = await G.safely(() => deps.gh(['repo', 'view', o.repo, '--json', 'viewerPermission'], G.owner(o.repo)));
      checks.push(check('github', `gh as ${G.owner(o.repo)} can write ${o.repo}`, r.ok && r.value.code === 0 && /WRITE|MAINTAIN|ADMIN/.test(r.value.stdout), r.ok ? r.value.stdout.trim() : r.error));
    }
    if (id === 'build-continue-pr') notes.push('a real run opens its own draft PR with a review comment (GitHub API) and closes it at the end');
  } else if (id === 'teams-ask') {
    const st = await G.safely(() => deps.getJson(`${deps.paBase}/api/state`));
    const sources: Json[] = st.ok ? (st.value?.sources || []) : [];
    const teams = sources.filter((s) => /teams|graph_chat/i.test(JSON.stringify([s.source, s.name, s.id])));
    checks.push(check('run', 'a Teams source is ingesting', teams.length && teams.some((s) => !s.error && !s.failing), st.ok ? `${teams.length} Teams source(s)` : st.error));
    checks.push(check('run', 'board answers (GET /api/state)', st.ok && Array.isArray(st.value?.commitments), st.error));
    if (o.testChat) {
      const tc = await G.safely(() => testChat(deps, o.testChat));
      checks.push(...(tc.ok ? tc.value.checks : [check('run', `test chat ${o.testChat} read from the store`, false, tc.error)]));
      notes.push('the real run prints a phrase for you to type into the test chat and follows that message; it sends nothing');
    } else notes.push('a real run needs --test-chat <id>: a Teams chat with only you in it (your self chat is 48:notes). Never a colleague; nothing is sent to anyone. Add --test-chat to the dry run to check it.');
  }
  const b = deps.browser();
  notes.push(b ? `screenshots by ${path.basename(b)}` : 'screenshots will be skipped: no headless Chromium found');
  return { checks, limits, notes };
}

// --------------------------------------------------------------- runs ----

// The talk page's turn (talk.page.js), replayed headless in real time:
//   speech starts  POST /api/talk/warm (the page's warmVoice), then the question's own length
//   end of speech  t0. Smart-turn is asked after TURN_DEFAULTS.sureCheckMs of silence (the
//                  VAD's shortcut: a wait here, not a measurement)
//   the check      POST /api/talk/endpoint and POST /api/talk/transcribe together: the page
//                  transcribes early and keeps that text when smart-turn says done; not done,
//                  it waits out endMs of silence and transcribes again
//   the turn       POST /api/talk/turn, its deltas through createUtteranceStream({ firstClause: true })
//   first piece    POST /api/talk/tts at once, while the turn still streams; first audio is
//                  its first PCM byte
// Not measurable headless: Silero's own frame, and the browser starting playback.
async function whatsOn(acc: Acceptance, o: Options, deps: Deps, folder: string): Promise<Partial<RunOut>> {
  const T = require('../dashboard/talk.core');
  const { StringDecoder } = require('string_decoder');
  const measured: Measured = {};
  const transcripts: string[] = [];
  const checks: Check[] = [];
  const notes = ['not measured headless: Silero\'s VAD frame (32 ms) before the silence wait starts, and the browser starting playback after the first audio byte'];
  const spentBefore = await G.safely(() => deps.spendToday());
  const question = o.question || "What's on today?";
  const pcm: Buffer = await deps.post(`${deps.paBase}/api/talk/tts`, { text: question }, { raw: true, timeoutMs: 30_000 });
  // What the page holds at the check: the question at 16 kHz, then the silence it waited.
  const samples = new Float32Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  const sure: number = T.TURN_DEFAULTS.sureCheckMs;
  const voiced: Float32Array = T.downsample(samples, 24000, 16000);
  const utter = new Float32Array(voiced.length + Math.round((sure * 16000) / 1000));
  utter.set(voiced);
  const wav = Buffer.from(T.encodeWav(utter, 16000));
  const tail = Buffer.from(T.floatToPcm16(utter.subarray(Math.max(0, utter.length - 8 * 16000))));
  const stamp = (p: Promise<Json>): Promise<{ v: Json; at: number }> => p.then((v) => ({ v, at: deps.now() as number }));
  const transcribe = () => stamp(G.safely(() => deps.post(`${deps.paBase}/api/talk/transcribe`, wav, { timeoutMs: 30_000 })));

  await G.safely(() => deps.post(`${deps.paBase}/api/talk/warm`, {}, { timeoutMs: 5000 }));
  await deps.sleep(Math.round(samples.length / 24));
  const t0: number = deps.now();
  await deps.sleep(sure);
  const tCheck: number = deps.now();
  const smartP = stamp(G.safely(() => deps.post(`${deps.paBase}/api/talk/endpoint`, tail, { timeoutMs: 10_000 })));
  const earlyP = transcribe();
  const smart = await smartP;
  const verdict: Json = smart.v.ok ? JSON.parse(smart.v.value) : null;
  const smartNote = verdict ? `smart-turn ${smart.at - tCheck} ms (model ${verdict.ms} ms), p ${verdict.probability}` : `smart-turn failed: ${smart.v.error}`;
  let tReq = tCheck;
  let tr = await earlyP;
  if (!verdict?.complete) {
    // Not done (or no answer): the turn ends at endMs of silence, transcribed then.
    await deps.sleep(Math.max(0, t0 + T.TURN_DEFAULTS.endMs - deps.now()));
    tReq = deps.now();
    tr = await transcribe();
  }
  if (!tr.v.ok) throw new Error(`transcription failed: ${tr.v.error}`);
  const said0: Json = JSON.parse(tr.v.value);
  const heard = String(said0.text || '').trim();
  // The turn starts once the text is back and smart-turn has said done.
  const tTurn = verdict?.complete ? Math.max(tr.at, smart.at) : tr.at;
  measured['talk-page'] = {
    ms: tReq - t0,
    note: verdict?.complete
      ? `${sure} ms VAD wait (TURN_DEFAULTS.sureCheckMs, not measured); ${smartNote}, alongside the transcription`
      : `${smartNote}: not done, so the turn ended at endMs (${T.TURN_DEFAULTS.endMs} ms) of silence`,
  };
  measured.whisper = heard
    ? { ms: tr.at - tReq, note: `request ${tr.at - tReq} ms, whisper ${said0.ms} ms` }
    : { ms: null, note: `transcription came back empty in ${tr.at - tReq} ms` };
  if (!heard) notes.push('transcription was empty: the rest of the turn was timed with the question text itself, so the hops after it are a lower bound');

  const lines = T.createLineReader();
  const words = T.createUtteranceStream({ firstClause: true });
  const utf8 = new StringDecoder('utf8');
  let full = '';
  const mark: { token: number | null; piece: { text: string; at: number } | null; audio: number | null; speaking: Promise<unknown> | null } = { token: null, piece: null, audio: null, speaking: null };
  const speak = (text: string) => {
    mark.piece = { text, at: deps.now() };
    mark.speaking = G.safely(() => deps.post(`${deps.paBase}/api/talk/tts`, { text }, { raw: true, timeoutMs: 30_000, onChunk: () => { if (mark.audio == null) mark.audio = deps.now(); } }));
  };
  const turnText: string = await deps.post(`${deps.paBase}/api/talk/turn`, { text: heard || question }, {
    timeoutMs: 60_000,
    onChunk: (c: Buffer) => {
      for (const ev of lines.push(utf8.write(c))) {
        if (ev.type !== 'delta') continue;
        if (mark.token == null) mark.token = deps.now();
        full += ev.text || '';
        const got: string[] = words.push(full);
        if (got.length && !mark.piece) speak(got[0] as string);
      }
    },
  });
  if (!mark.piece) {
    const rest: string[] = words.finish(full);
    if (rest.length) speak(rest[0] as string);
  }
  if (mark.speaking) await mark.speaking;
  const events: Json[] = W.ndjson(turnText);
  const decision: Json = events.find((e) => e.type === 'decision') || {};
  const done: Json = events.find((e) => e.type === 'done') || {};
  const said = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  const { piece, audio } = mark;
  const route = decision.route || done.route || '?';
  measured['fast-lane'] = piece
    ? { ms: piece.at - tTurn, note: `route ${route}; first token ${mark.token == null ? '?' : mark.token - tTurn} ms; first piece "${piece.text}" (${piece.text.split(/\s+/).length} words)` }
    : { ms: null, note: `no spoken answer (route ${route})` };
  if (piece && audio != null) {
    measured.voice = { ms: audio - t0, note: `end of speech to first audio byte; TTS first byte ${audio - piece.at} ms after the first piece; the turn waited ${tTurn - tCheck} ms after the check` };
  }
  checks.push(check('ask', 'transcribed the question', /what/i.test(heard), heard || 'empty transcription'));
  checks.push(check('ask', 'smart-turn said the question was done', verdict?.complete, smartNote));
  checks.push(check('ask', 'answered locally (route answer)', (decision.route || done.route) === 'answer', `route ${decision.route || done.route || 'none'}`));
  checks.push(check('ask', 'spoke an answer', said.trim().length > 0));
  transcripts.push(deps.writeEvidence(folder, 'transcripts/turn.txt', [`question (TTS): ${question}`, `transcribed: ${said0.text}`, `route: ${decision.route || done.route}`, `first piece spoken: ${piece ? piece.text : ''}`, `answer: ${said}`].join('\n')));
  transcripts.push(deps.writeEvidence(folder, 'transcripts/turn.ndjson', turnText));
  const spentAfter = await G.safely(() => deps.spendToday());
  const usd = spentBefore.ok && spentAfter.ok ? Math.max(0, spentAfter.value - spentBefore.value) : null;
  notes.push('cost is the PA spend delta over the turn; another pass spending at the same moment would show here too');
  return { measured, transcripts, checks, notes, usd, links: { ask: `${deps.paBase}/talk` }, pages: [], ask: W.askView('chat', said) };
}

// ------------------------------------------------------------- teams-ask ----

const TEAMS_POLL_MS = 500;
/** How long a found card may take to show in GET /api/state, and its toast to land. */
const TEAMS_BOARD_WAIT_MS = 10_000;
const TEAMS_TOAST_WAIT_MS = 15_000;

/** The test chat as the store has it, held to W.testChatChecks, and you. */
async function testChat(deps: Deps, chat: string): Promise<{ checks: Check[]; me: Json | null }> {
  const T = require('../ingest/teamsThreads.ts');
  const [authors, head, owner] = await Promise.all([deps.chatAuthors(chat), deps.chatHead(chat), deps.owner()]);
  const mine = W.ownerIds(owner?.me, owner?.identities || []);
  return { me: owner?.me || null, checks: W.testChatChecks(chat, { authors, head, mine, system: T.isSystemThread(chat), self: T.isSelfChat(chat) }) };
}

const onBoard = (st: Json, id: number | string) => [...(st?.board?.onMe || []), ...(st?.board?.waiting || [])].some((c: Json) => String(c.id) === String(id));

function payloadOf(e: Json): Json | null {
  if (typeof e?.payload !== 'string') return e?.payload || null;
  try { return JSON.parse(e.payload); } catch { return null; }
}

// The Map's teams-ask, for real, sending nothing: the PA has no Teams send
// path, and automation typing into the client could land in whichever chat
// has focus. So the run prints a phrase (an ask of yourself, with a date and
// a marker no other message holds) for you to type into the test chat, then
// follows that one message: stored by the cache reader, distilled to an
// owed_by_me card, the card on the board the way the page gets it (its board
// event, then GET /api/state), the new_ask toast. Hops are timed on the rows'
// own clocks. The card is dropped afterwards; your message stays in Teams.
async function teamsAsk(acc: Acceptance, o: Options, deps: Deps, folder: string): Promise<Partial<RunOut>> {
  const chat: string | null = o.testChat;
  if (!chat) throw new Error('a real teams-ask run needs --test-chat <id>: a Teams chat with only you in it (your self chat is 48:notes)');
  const checks: Check[] = [];
  const notes: string[] = ['cost is the PA spend delta from the phrase to the end; another pass spending meanwhile shows here too'];
  const cleanup: string[] = [];
  const transcripts: string[] = [];
  const tc = await testChat(deps, chat);
  checks.push(...tc.checks);
  const bad = tc.checks.filter((c) => !c.ok);
  if (bad.length) {
    throw Object.assign(new Error(`--test-chat ${chat} is not a test chat with only you in it: ${bad.map((c) => `${c.check}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}`), {
      partial: { checks, cleanup: ['nothing was created'] },
    });
  }
  const marker = W.teamsMarker(deps.uuid());
  const phrase = W.teamsPhrase(marker, deps.now());
  const waitS: number = o.timeouts.teams;
  const askS: number = o.timeouts.ask;
  transcripts.push(deps.writeEvidence(folder, 'phrase.txt', `${phrase.text}\n`));
  const spentBefore = await G.safely(() => deps.spendToday());

  // The page's path to a new card: its board event, then GET /api/state.
  const board = new Map<string, number>();
  const fetching: Promise<unknown>[] = [];
  let events = 0;
  const unsubscribe: () => void = deps.subscribe(`${deps.paBase}/api/events?topics=board`, (e: Json) => {
    const p = payloadOf(e);
    if (e?.topic !== 'board' || p?.table !== 'commitment' || p?.op !== 'insert' || p.id == null) return;
    events++;
    const id = String(p.id);
    fetching.push(G.safely(() => deps.getJson(`${deps.paBase}/api/state`)).then((st: Json) => {
      if (st.ok && !board.has(id) && onBoard(st.value, id)) board.set(id, deps.now());
    }));
  });
  let item: Json | null = null;
  let rows: Json[] = [];
  try {
    deps.say([
      '',
      `teams-ask: type this into the test chat (${chat}) in Teams, as one message, exactly as written:`,
      '',
      `    ${phrase.text}`,
      '',
      `Also in ${path.join(folder, 'phrase.txt')}. This run sends nothing; it waits up to ${waitS} s for the message to be stored.`,
      '',
    ].join('\n'));
    const until = deps.now() + waitS * 1000;
    while (!(item = await deps.chatItemWith(chat, marker))) {
      if (deps.now() > until) {
        throw new Error(`no message with the marker reached the store in ${waitS} s. Type the phrase into the test chat (${chat}) with Teams running and its cache reader resident (pa doctor shows the teams-cache source), or allow longer with --timeout teams=<s>. Nothing was created.`);
      }
      await deps.sleep(TEAMS_POLL_MS);
    }
    const it: Json = item;
    deps.log(`stored as item #${it.id}`);

    const askUntil = deps.now() + askS * 1000;
    let card: Json | null = null;
    for (;;) {
      const cur: Json = (await deps.chatItemWith(chat, marker)) || it;
      if (cur.distill_error) throw new Error(`item #${it.id} failed to distill: ${String(cur.distill_error).slice(0, 200)}`);
      if (cur.distilled_at) {
        rows = await deps.itemCommitments(it.id);
        card = rows.find((r) => r.direction === 'owed_by_me' && r.status === 'open' && r.superseded_by == null) || null;
        if (card) break;
        const folded = rows.find((r) => r.direction === 'owed_by_me' && r.superseded_by != null);
        if (folded) throw new Error(`item #${it.id} was distilled, but its ask was folded into card #${folded.superseded_by} (dedupe): no new card to time`);
        throw new Error(`item #${it.id} was distilled with ${rows.length} commitment(s) and no open owed_by_me one (the policy or the model read no ask in it)`);
      }
      if (deps.now() > askUntil) throw new Error(`item #${it.id} was stored but not distilled in ${askS} s: is the worker's distill pass running (pa doctor)? Allow longer with --timeout ask=<s>`);
      await deps.sleep(TEAMS_POLL_MS);
    }
    const cardId = String(card.id);
    deps.log(`card #${cardId}`);

    const tCard = deps.now();
    while (!board.has(cardId) && deps.now() - tCard < TEAMS_BOARD_WAIT_MS) await deps.sleep(100);
    await Promise.all(fetching);
    let boardAt: number | null = board.get(cardId) ?? null;
    let boardNote: string | undefined;
    if (boardAt == null) {
      const st = await G.safely(() => deps.getJson(`${deps.paBase}/api/state`));
      if (st.ok && onBoard(st.value, cardId)) {
        boardAt = deps.now();
        boardNote = `no board event for the card reached the run (${events} commitment insert(s) seen): timed by the run's own GET /api/state, an upper bound`;
      } else boardNote = st.ok ? `GET /api/state does not hold card #${cardId}` : `GET /api/state: ${st.error}`;
    }

    const key = `new-ask:${it.id}`;
    let n: Json | null = null;
    const toastUntil = deps.now() + TEAMS_TOAST_WAIT_MS;
    for (;;) {
      n = await deps.notificationByKey(key);
      if ((n && (n.toasted_at || n.delivery !== 'push')) || deps.now() > toastUntil) break;
      await deps.sleep(250);
    }
    const toastNote = !n
      ? 'no new_ask notification: the ask was under the confidence floor or not fresh (src/notify/newAsk.ts)'
      : n.toasted_at ? `extracted_at to toasted_at (delivery ${n.delivery}, priority ${n.priority})`
        : n.delivery !== 'push' ? `held, delivery ${n.delivery}: quiet hours or the interrupt budget (PA_QUIET_HOURS, PA_PUSH_BUDGET); run it inside working hours`
          : 'pushed, but no toast channel on this machine';
    checks.push(check('dashboard', `card #${cardId} on the board`, boardAt != null, boardNote));
    checks.push(check('notify', 'a new_ask notification for the item', n && n.kind === 'new_ask', n ? `${n.kind}, ${n.delivery}` : 'none'));
    checks.push(check('notify', 'toasted', n?.toasted_at, toastNote));

    const detail = await G.safely(() => deps.getJson(`${deps.paBase}/api/commitments/${cardId}`));
    if (detail.ok && detail.value && !detail.value.error) checks.push(...W.teamsCardChecks(detail.value, { item: it, due: phrase.due, meName: tc.me?.display_name || null }));
    else checks.push(check('card', `GET /api/commitments/${cardId}`, false, detail.ok ? detail.value?.error : detail.error));

    const storedAt = it.raw?.storedAt || null;
    const measured = W.teamsHops({
      sent: it.occurred_at, stored: storedAt || it.fetched_at, storedHow: storedAt ? 'raw.storedAt' : 'fetched_at: the row has no storedAt',
      card: card.extracted_at, board: boardAt, boardNote, toast: n?.toasted_at || null, toastNote,
    });
    transcripts.push(deps.writeEvidence(folder, 'transcripts/teams-ask.txt', [
      `phrase: ${phrase.text}`, `expected due: ${phrase.due}`, `item #${it.id} sent ${new Date(it.occurred_at).toISOString()}, stored ${storedAt || `${new Date(it.fetched_at).toISOString()} (fetched_at)`}`,
      `card #${cardId} extracted ${new Date(card.extracted_at).toISOString()}; on the board ${boardAt == null ? 'never' : new Date(boardAt).toISOString()}`,
      `notification: ${n ? `${n.kind} ${n.delivery}, toasted ${n.toasted_at ? new Date(n.toasted_at).toISOString() : 'no'}` : 'none'}`,
    ].join('\n')));
    // Screenshots now, while the card still exists.
    const shots = await deps.capture(path.join(folder, 'screenshots'), [{ name: 'run', url: `${deps.paBase}/`, ready: S.readyFor('plan', `#${cardId}`) }]);
    const spentAfter = await G.safely(() => deps.spendToday());
    const usd = spentBefore.ok && spentAfter.ok ? Math.max(0, spentAfter.value - spentBefore.value) : null;
    return {
      measured, checks, transcripts, notes, cleanup, usd, shots, pages: [],
      links: { chat, item: it.id, card: cardId, message: detail.ok ? detail.value?.web_url || null : null, board: `${deps.paBase}/` },
    };
  } catch (err) {
    throw Object.assign(err as Error, { partial: { checks, notes, cleanup, transcripts } });
  } finally {
    unsubscribe();
    if (!item) cleanup.push('nothing was created');
    else if (o.keep) cleanup.push(`kept (--keep): item #${item.id}'s cards`);
    else {
      if (!rows.length) rows = await G.safely(() => deps.itemCommitments(item?.id)).then((r: Json) => (r.ok ? r.value : []));
      for (const r of rows.filter((x: Json) => x.status === 'open' && x.superseded_by == null)) {
        const c = await G.safely(() => deps.closeCard(r.id));
        cleanup.push(c.ok ? `card #${r.id} dropped` : `card #${r.id} NOT dropped: ${c.error}`);
      }
      cleanup.push(`your message stays in the test chat (item #${item.id}); delete it in Teams if you like`);
    }
  }
}

// build-pr, build-continue-pr and research run on Build (buildRunners.ts).
const RUNNERS: Record<string, Runner> = { 'whats-on': whatsOn, 'teams-ask': teamsAsk, ...require('./buildRunners.ts').RUNNERS };

// ---------------------------------------------------------------- main ----

function parse(id: string, flags: Flags, lists: Lists): Options {
  const o: Options = C.parseOptions({ ...flags }, lists);
  o.repoPath = typeof flags['repo-path'] === 'string' ? flags['repo-path'] : null;
  o.question = typeof flags.question === 'string' ? flags.question : null;
  o.pr = flags.pr != null && flags.pr !== true ? Number(String(flags.pr).replace(/^#/, '')) : null;
  if (flags.pr != null && !(Number.isInteger(o.pr) && o.pr > 0)) throw Object.assign(new Error(`--pr is a PR number (got "${flags.pr}")`), { usage: true });
  o.testChat = typeof flags['test-chat'] === 'string' ? flags['test-chat'] : null;
  return o;
}

/** `pa e2e <workflow>`: dry run or real run, evidence in a run folder. Returns the summary. */
async function main(id: string, flags: Flags = {}, lists: Lists = {}, deps: Deps = deps0()): Promise<Json> {
  // research=, review=, teams= and ask= (seconds) cap this module's own waits; the golden path's parser does not know them.
  const OWN = /^(research|ci|teams|ask)=/;
  const golden = { ...lists, timeout: (lists.timeout || []).filter((t) => !OWN.test(t)) };
  const acc: Acceptance = W.acceptance(deps.arch(), id);
  const o = parse(id, flags, golden);
  const own = (k: string, dflt = 5400) => Number(String((lists.timeout || []).find((t) => t.startsWith(`${k}=`)) || '').split('=')[1]) || dflt;
  o.timeouts.research = own('research');
  o.timeouts.ci = own('ci', 900);
  // teams-ask: for you to type the phrase, then for the stored message to become a card.
  o.timeouts.teams = own('teams', 600);
  o.timeouts.ask = own('ask', 600);
  // --on <machine>: the same workflow on that stack (the golden path's remote), its summary back here.
  if (o.on) return G.remote(o, flags, lists, deps, { workflow: id });
  const startedAt = new Date(deps.now()).toISOString();
  const folder: string = path.join(deps.root(), W.folderName(id, deps.now(), o.dryRun));
  deps.writeEvidence = (dir: string, rel: string, text: string | Buffer) => {
    const file = path.join(dir, rel);
    deps.write(file, text);
    return path.relative(dir, file).replace(/\\/g, '/');
  };

  if (o.dryRun) {
    const d = await dry(id, acc, o, deps);
    const s = W.summary({ workflow: id, kind: 'dry-run', folder, startedAt, hops: W.scoreHops(acc.hops, {}), cost: W.scoreCost(null, d.limits, id, acc.cost?.basis), checks: d.checks, rubric: acc.rubric, notes: d.notes });
    s.hops = [];
    deps.write(path.join(folder, 'summary.json'), JSON.stringify(s, null, 2));
    return s;
  }

  const runner = RUNNERS[id];
  if (!runner) {
    const need = W.REAL_RUN[id]?.needs || 'a dummy input';
    const s = W.summary({ workflow: id, kind: 'run', folder, startedAt, errors: [`a real ${id} run is not automated yet: it needs ${need}. Run --dry-run; 8.3's reviewer drives it by hand with that dummy input.`] });
    deps.write(path.join(folder, 'summary.json'), JSON.stringify(s, null, 2));
    return s;
  }

  // A run held on a promise nothing will settle ends when Node runs out of
  // work: exit 0, no summary, and `--on` waits out its timeout (8.4.40).
  // Write the summary and the report then, and exit non-zero.
  const at = { stage: 'the run' };
  const stalled = () => {
    process.exitCode = 1;
    const s = W.summary({ workflow: id, kind: 'run', folder, startedAt, errors: [`the run stopped in ${at.stage} with nothing left to run (a step never settled): no summary was reached and its cleanup did not run; look for its job and sessions`] });
    deps.write(path.join(folder, 'summary.json'), JSON.stringify(s, null, 2));
    if (typeof flags.report === 'string') G.writeReport(flags.report, s);
  };
  process.once('beforeExit', stalled);
  try {
    return await realRun(id, acc, o, deps, runner, folder, startedAt, at);
  } finally {
    process.removeListener('beforeExit', stalled);
  }
}

async function realRun(id: string, acc: Acceptance, o: Options, deps: Deps, runner: Runner, folder: string, startedAt: string, at: { stage: string }): Promise<Json> {
  const limits = await G.safely(() => deps.getJson(`${deps.paBase}/api/workflow-limits`));
  let r: RunOut = { measured: {}, checks: [], transcripts: [], links: {}, notes: [], cleanup: [], errors: [], usd: null, pages: [] };
  at.stage = `the ${id} runner`;
  try {
    r = { ...r, ...(await runner(acc, o, deps, folder)) } as RunOut;
  } catch (err) {
    // A runner that stopped may say what it checked and cleaned up first.
    const partial: Partial<RunOut> = (err as { partial?: Partial<RunOut> })?.partial || {};
    r = { ...r, ...partial } as RunOut;
    r.errors = [...(r.errors || []), (err as Error)?.message || String(err)];
  }
  at.stage = 'the screenshots';
  let shots = r.shots || { shots: [], note: null };
  if (r.pages.length) shots = await screenshots(deps, path.join(folder, 'screenshots'), r.pages);
  at.stage = 'the summary';
  const notes = [...(r.notes || []), ...(shots.note ? [shots.note] : [])];
  const rel = (f: string) => path.relative(folder, f).replace(/\\/g, '/');
  const s: Json = W.summary({
    workflow: id, kind: 'run', folder, startedAt,
    hops: W.scoreHops(acc.hops, r.measured),
    cost: W.scoreCost(r.usd, limits.ok ? limits.value : null, id, acc.cost?.basis),
    links: r.links,
    views: {
      ...Object.fromEntries((shots.shots || []).map((x: Json) => [x.view, {
        url: x.url, screenshot: x.file ? rel(x.file) : null,
        ...(x.text ? { text: rel(x.text) } : {}), ...(x.ready != null ? { ready: x.ready, waitedMs: x.waitedMs } : {}), ...(x.how ? { how: x.how } : {}), ...(x.error ? { error: x.error } : {}),
      }])),
      // Ask is the tool check (8.4.47): headless /talk never gets ready.
      ...(r.ask ? { ask: r.ask } : {}),
    },
    transcripts: r.transcripts, screenshots: (shots.shots || []).filter((x: Json) => x.file).map((x: Json) => rel(x.file)),
    checks: [...r.checks, ...W.shotChecks(shots.shots)], rubric: acc.rubric, errors: r.errors || [], cleanup: r.cleanup || [], notes,
  });
  if (r.golden) s.golden = { hops: r.golden.hops, ids: r.golden.ids, feed: r.golden.feed };
  deps.write(path.join(folder, 'summary.json'), JSON.stringify(s, null, 2));
  return s;
}

module.exports = { main, dry, parse, screenshots, RUNNERS, deps0 };
