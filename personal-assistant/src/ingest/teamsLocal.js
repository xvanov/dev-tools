'use strict';

// Teams in seconds: messages read from the new Teams client's own cache.
//
// The connector pass (graphChat.js) is minutes behind by construction — a
// headless `claude -p` every three minutes, over a Microsoft Search index that
// itself lags new messages by minutes more. Graph change notifications would
// need an app registration, which this tool does not have and will not get.
// But the new Teams is a WebView2 app that writes every message it shows into
// Chromium IndexedDB on this disk, within a second or two of it arriving. This
// is the same data the connector reads, already on the machine, for the same
// signed-in user.
//
// A pass runs teams/read_cache.py, which reads the LevelDB log from where the
// last pass stopped (KB, not the ~100 MB store) and prints the new messages
// as JSON lines. What starts a pass (`watch` below):
//
//  - a change notification on the LevelDB directory (fs.watch, which is
//    ReadDirectoryChangesW on Windows: the kernel tells us, nothing is opened
//    or stat'ed to find out), debounced to the end of the write burst
//    (teamsTrigger.js). A message is in the store well under a second after
//    Teams writes it, and a quiet Teams costs nothing at all;
//  - a slow fallback poll (PA_TEAMS_CACHE_FALLBACK_SECONDS, 60) that compares
//    the directory's newest mtime, in case a notification is lost (the
//    watcher's buffer overflowed, Teams replaced the directory on an update).
//    It also re-arms a watcher that errored or closed;
//  - while no watcher is armed, the old fast poll (PA_TEAMS_CACHE_POLL_SECONDS,
//    5), so a broken watcher costs latency, never messages.
//
// The reader stays resident between passes (teamsReader.js): a trigger is a
// line on a pipe, not an interpreter start. Items are written as `graph_chat` with the
// connector's own ids — `{chatId}/{messageId}` is the same pair in both — so
// the two sources land on one row, never two:
//
//  - a message the connector already has is left alone (edits excepted);
//  - a message read here first is the connector's to upgrade later (a sender
//    address where only an AAD id was known), but never to overwrite with its
//    250-character search summary.
//
// Privacy: message bodies go to the store and nowhere else. Logs carry counts
// and timings; the reader never writes to Teams' files or keeps one open.

const fs = require('fs');
const path = require('path');

const { config } = require('../config');
const repo = require('../repo');
const { saveItems, saveCursor, getCursor, recordError } = require('./store');
const { htmlToText } = require('../util/text');
const { namesMe } = require('./graphChat');
const { logger } = require('../log');
const platform = require('../platform');
const trigger = require('./teamsTrigger');
const readers = require('./teamsReader');

const log = logger('teams-cache');

const SCRIPT = path.join(__dirname, '..', '..', 'teams', 'read_cache.py');
const CURSOR = 'teams_cache';

// A message older than this is history, not news: Teams rewrites old reply
// chains when you scroll back, and those are the connector's to backfill.
const LOOKBACK_MS = 6 * 3600_000;
const FIRST_RUN_MS = 30 * 60_000;
const MAX_LDB_PER_PASS = 3;
const CURSOR_PERSIST_MS = 60_000;

// What a person typed. Cards are bots; Event/*, ThreadActivity/* and call
// records are the system talking.
const PERSON_TYPES = new Set(['Text', 'RichText/Html', 'RichText']);

// ---------------------------------------------------------------- pure --

function oidOf(mri) {
  const m = String(mri || '').match(/^8:orgid:([0-9a-f-]{36})$/i);
  return m ? m[1].toLowerCase() : null;
}

function isSystem(msg) {
  if (!msg || !msg.id || !msg.conversationId) return true;
  if (msg.deleted) return true;
  if (!PERSON_TYPES.has(msg.messageType)) return true;
  // 8: is a person; 28: a bot or app; 19: the thread itself.
  return !String(msg.creator || '').startsWith('8:');
}

// The connector's chatType vocabulary: oneOnOne, group, meeting, channel.
function chatTypeOf(conversationId, conv, known) {
  const id = String(conversationId || '');
  if (/@thread\.tacv2$/i.test(id)) return 'channel';
  if (known) return known;
  if (/@unq\.gbl\.spaces$/i.test(id)) return 'oneOnOne';
  if (/^19:meeting_/i.test(id) || /meeting/i.test(String(conv?.threadType || conv?.productThreadType || ''))) {
    return 'meeting';
  }
  return 'group';
}

function bodyOf(msg) {
  return msg.messageType === 'Text' ? String(msg.content || '').trim() : htmlToText(msg.content);
}

function mentionsMe(msg, text, me) {
  const mine = me?.id ? `8:orgid:${String(me.id).toLowerCase()}` : null;
  const mentioned = (msg.mentions || []).map((m) => String(m).toLowerCase());
  return Boolean(mine && mentioned.includes(mine)) || namesMe(text, me);
}

// Teams deep links: open the message itself, in a chat or a channel thread.
function webUrlFor(msg, chatType, conv) {
  const base = `https://teams.microsoft.com/l/message/${encodeURIComponent(msg.conversationId)}/${msg.id}`;
  if (chatType !== 'channel') return `${base}?context=${encodeURIComponent('{"contextType":"chat"}')}`;
  const q = new URLSearchParams();
  if (conv?.groupId) q.set('groupId', conv.groupId);
  q.set('parentMessageId', msg.parentMessageId || msg.id);
  return `${base}?${q}`;
}

function iso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

// One cache message → the item shape graphChat.toItem produces, or null for
// what graph_chat does not keep. `ctx`:
//   me          the connector's profile {id, mail, displayName} (m365 cursor)
//   conv        the reader's conversation record, when the cache had one
//   thread      the newest graph_chat row of this chat: {subject, raw}
//   authorEmail the sender's address, when the store already knows it
//   policy      config.m365.teamsChannels
function toItem(msg, ctx = {}) {
  if (isSystem(msg)) return null;
  const { me = null, conv = null, thread = null, authorEmail = null, policy = 'mentions' } = ctx;
  const known = thread?.raw?.chatType || null;
  const chatType = chatTypeOf(msg.conversationId, conv, known);
  const text = bodyOf(msg);
  const atMe = mentionsMe(msg, text, me);

  // The connector's channel policy, applied the same way: a channel post is
  // kept when it is yours or names you, unless the policy says all or none.
  if (chatType === 'channel') {
    if (policy === 'off') return null;
    if (policy !== 'all' && !msg.mine && !atMe) return null;
  }

  const oid = oidOf(msg.creator);
  const author = msg.mine
    ? me?.mail || (oid ? `aad:${oid}` : null)
    : authorEmail || (oid ? `aad:${oid}` : msg.fromName || null);
  const traw = thread?.raw || {};
  const channel = chatType === 'channel';
  const edited = Boolean(msg.version && String(msg.version) !== String(msg.id));
  return {
    externalId: `${msg.conversationId}/${msg.id}`,
    threadExternalId: msg.conversationId,
    occurredAt: iso(msg.arrival) || new Date().toISOString(),
    authorIdentity: author,
    // The subject the connector already gave this chat, so the two sources
    // hash alike; then the cache's own topic.
    subject: channel ? 'Teams channel' : thread?.subject || conv?.topic || traw.members || 'Teams chat',
    bodyText: text,
    raw: {
      chatType,
      chatTopic: (channel ? null : conv?.topic) || traw.chatTopic || null,
      members: traw.members || null,
      memberEmails: Array.isArray(traw.memberEmails) ? traw.memberEmails : [],
      fromName: msg.fromName || null,
      fromId: oid,
      webUrl: webUrlFor(msg, chatType, conv),
      importance: msg.importance || null,
      mentionsMe: atMe,
      teamId: channel ? conv?.groupId || traw.teamId || null : null,
      channelId: channel ? msg.conversationId : null,
      messageId: msg.id,
      replyToId: msg.parentMessageId && String(msg.parentMessageId) !== String(msg.id) ? msg.parentMessageId : null,
      partial: false,
      editedAt: edited ? iso(msg.version) : null,
      via: 'teams-cache',
    },
  };
}

// What to write given the row already stored under the same id (or null):
//  - none: the item as read;
//  - a connector row: left alone — it got there first — unless the message
//    was edited after that row was fetched; the edit's body then wins, with
//    the row's author and subject kept so nothing else churns;
//  - a row this reader wrote: rewritten from the cache, keeping an address
//    the connector upgraded it to, so a re-read never downgrades it.
function planWrite(item, existing) {
  if (!item) return null;
  if (!existing) return item;
  const fromCache = existing.raw?.via === 'teams-cache';
  const editedAt = item.raw.editedAt ? new Date(item.raw.editedAt) : null;
  if (!fromCache && !(editedAt && editedAt > new Date(existing.fetched_at))) return null;
  const keepAuthor = String(existing.author_identity || '').includes('@') || !item.authorIdentity;
  return {
    ...item,
    occurredAt: existing.occurred_at || item.occurredAt,
    authorIdentity: keepAuthor ? existing.author_identity : item.authorIdentity,
    subject: existing.subject || item.subject,
    raw: {
      ...(existing.raw || {}),
      ...Object.fromEntries(Object.entries(item.raw).filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length))),
      via: existing.raw?.via ?? (fromCache ? 'teams-cache' : undefined),
    },
  };
}

// A new message worth distilling now rather than at the next tick: someone
// else's, in a chat, or naming you in a channel.
function isFresh(item) {
  return Boolean(item) && item.raw.via === 'teams-cache' && !item.mine && (item.raw.chatType !== 'channel' || item.raw.mentionsMe);
}

function parseOutput(stdout) {
  const out = { messages: [], convs: new Map(), status: null };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.t === 'msg') out.messages.push(rec);
    else if (rec.t === 'conv' && rec.id) out.convs.set(rec.id, rec);
    else if (rec.t === 'status') out.status = rec;
  }
  return out;
}

// ------------------------------------------------------------ the pass --

function paths() {
  const base = config.teamsCache.dir;
  return { leveldb: `${base}.leveldb`, blobs: `${base}.blob` };
}

// Newest mtime and the active log's size: changes whenever Teams writes.
function signature(dir) {
  let newest = 0;
  let logs = '';
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(log|ldb)$/.test(name)) continue;
    const st = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
    if (!st) continue;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    if (name.endsWith('.log')) logs += `${name}:${st.size};`;
  }
  return `${newest}|${logs}`;
}

// One-shot by default (`pa sync`, which must exit when done); `watch` swaps
// in the resident reader for the worker's lifetime.
const readerOpts = () => ({ python: config.teamsCache.python, script: SCRIPT, timeoutMs: config.teamsCache.timeoutMs });
let reader = null;
function runReader(args) {
  if (!reader) reader = readers.oneShot(readerOpts());
  return reader.request(args);
}

// Whether a file-change notification names something a pass would read: the
// log and tables. LOG, LOCK, MANIFEST and CURRENT change alongside them and
// add nothing. No name (allowed by the API) counts.
function relevantChange(filename) {
  return !filename || /\.(log|ldb)$/i.test(String(filename));
}

// Sender addresses the store already knows: by AAD id (person_identity), and
// by display name within the same chat (the connector's rows carry both).
async function knownAuthors(messages) {
  const oids = [...new Set(messages.map((m) => oidOf(m.creator)).filter(Boolean))];
  const byOid = new Map();
  if (oids.length) {
    for (const r of await repo.people.emailsByAadOid(oids)) {
      if (r.email) byOid.set(r.oid, r.email.toLowerCase());
    }
  }
  const threads = [...new Set(messages.map((m) => m.conversationId))];
  const byName = new Map();
  for (const r of await repo.sources.chatSenderEmails(threads)) {
    byName.set(`${r.chat}\n${r.name}`, r.email);
  }
  return (m) => byOid.get(oidOf(m.creator)) || byName.get(`${m.conversationId}\n${m.fromName}`) || null;
}

// The newest connector row of each chat: its subject and members are what
// the cache does not carry.
async function threadInfo(conversationIds) {
  const map = new Map();
  for (const r of await repo.sources.chatHeads(conversationIds)) {
    map.set(r.chat, { subject: r.subject, raw: r.raw || {} });
  }
  return map;
}

async function existingRows(externalIds) {
  const map = new Map();
  for (const r of await repo.sources.chatMessagesByExternalId(externalIds)) {
    map.set(r.external_id, r);
  }
  return map;
}

let lastSignature = null;
let lastPersist = 0;
let memo = null; // cursor state between persists

// One pass. Returns { changed, fresh, skipped? }. Never throws for a missing
// Teams or venv — those are states, reported by `pa doctor`. `force` reads
// without comparing the directory's signature first: a change notification
// already says something moved, so the readdir and stats would be waste.
async function pass({ force = false } = {}) {
  if (!config.teamsCache.enabled) return { changed: 0, fresh: 0, skipped: 'off' };
  const { leveldb, blobs } = paths();
  if (!fs.existsSync(leveldb)) return { changed: 0, fresh: 0, skipped: 'no cache' };
  if (!fs.existsSync(config.teamsCache.python) || !fs.existsSync(SCRIPT)) {
    return { changed: 0, fresh: 0, skipped: 'no venv' };
  }
  const sig = force ? null : signature(leveldb);
  if (!force && sig === lastSignature) return { changed: 0, fresh: 0, skipped: 'unchanged' };

  if (!memo) memo = (await getCursor(CURSOR))?.state || {};
  const first = !memo.log;
  const now = Date.now();
  const args = [
    '--src', leveldb, '--blobs', blobs,
    '--work', path.join(config.dataDir, 'teams-cache-work'),
    '--since-ms', String(now - (first ? FIRST_RUN_MS : LOOKBACK_MS)),
    '--max-ldb', String(MAX_LDB_PER_PASS),
  ];
  if (memo.log) args.push('--log', `${memo.log.name}:${memo.log.offset}`);
  if (memo.maxLdb != null) args.push('--after-ldb', String(memo.maxLdb));

  const { messages, convs, status } = parseOutput(await runReader(args));
  if (sig) lastSignature = sig;
  if (!status) throw new Error('reader printed no status');

  const newest = Math.max(Number(memo.newestArrival) || 0, ...messages.map((m) => Number(m.arrival) || 0));
  const state = {
    log: status.log || memo.log || null,
    maxLdb: status.maxLdb ?? memo.maxLdb ?? null,
    newestArrival: newest || null,
    lastReadAt: new Date(now).toISOString(),
  };

  let changed = 0;
  let fresh = 0;
  let kept = 0;
  if (messages.length) {
    const cursor = await getCursor('m365');
    const me = cursor?.state?.me || null;
    const authorOf = await knownAuthors(messages);
    const threads = await threadInfo([...new Set(messages.map((m) => m.conversationId))]);
    const items = messages
      .map((m) => {
        const item = toItem(m, {
          me,
          conv: convs.get(m.conversationId) || null,
          thread: threads.get(m.conversationId) || null,
          authorEmail: authorOf(m),
          policy: config.m365.teamsChannels,
        });
        if (item) item.mine = Boolean(m.mine);
        return item;
      })
      .filter(Boolean);
    const existing = await existingRows(items.map((i) => i.externalId));
    const writes = items.map((i) => planWrite(i, existing.get(i.externalId) || null)).filter(Boolean);
    fresh = writes.filter((w) => !existing.has(w.externalId) && isFresh(w)).length;
    kept = writes.length;
    if (writes.length) {
      changed = await saveItems('graph_chat', writes.map(({ mine, ...w }) => w), { source: CURSOR, deltaToken: null, state });
      lastPersist = now;
    }
    const lags = writes.filter((w) => !existing.has(w.externalId)).map((w) => Math.round((now - Date.parse(w.occurredAt)) / 100) / 10);
    log.info('read', { messages: messages.length, kept, changed, fresh, lagSeconds: lags, ms: status.ms, bytes: status.bytes });
  }
  if (!kept && (now - lastPersist > CURSOR_PERSIST_MS || first)) {
    await saveCursor({ source: CURSOR, deltaToken: null, state });
    lastPersist = now;
  }
  if (status.ldbSkipped) log.debug('tables skipped after a compaction', { skipped: status.ldbSkipped });
  if (status.decodeErrors) log.debug('records not decoded', { count: status.decodeErrors });
  memo = state;
  return { changed, fresh };
}

// The worker's entry point. A failure is recorded on the cursor for `pa
// doctor` and logged once per distinct message, not every five seconds.
let lastError = null;
async function tick(opts) {
  try {
    const r = await pass(opts);
    lastError = null;
    return r;
  } catch (err) {
    if (err.message !== lastError) log.warn('pass failed', { message: err.message });
    lastError = err.message;
    await recordError(CURSOR, err.message).catch(() => {});
    return { changed: 0, fresh: 0, error: err.message };
  }
}

// The worker's driver: change notifications, debounced, plus the fallback
// poll (see the top of this file). `onResult` gets every pass's result.
// Returns { stop, stats }. Injectable fs.watch and timers for tests.
function watch({ onResult = () => {}, fsWatch = fs.watch, timers = { setTimeout, clearTimeout }, now = Date.now } = {}) {
  const tc = config.teamsCache;
  if (tc.resident) {
    if (reader) reader.close();
    reader = readers.resident(readerOpts());
  }
  let watcher = null;
  let stopped = false;
  let fallbackTimer = null;
  let wantForce = false; // a notification asked for this pass
  let heard = 0; // relevant notifications, ever
  let heardAtCheck = 0; // ... as of the last fallback check
  let silent = false; // no notification between the last two fallback checks
  const stats = { notifications: 0, passes: 0, fallbackChecks: 0, rearms: 0 };

  const sched = trigger.scheduler({
    quietMs: tc.debounceMs,
    maxWaitMs: tc.maxWaitMs,
    timers,
    now,
    run: async () => {
      const force = wantForce;
      wantForce = false;
      const before = lastSignature;
      const wasSilent = silent;
      silent = false;
      stats.passes++;
      const r = await tick({ force });
      // The fallback saw the directory change, but no notification arrived
      // since the previous check: the watcher is alive but deaf (the
      // directory was replaced under it). Open a new one.
      if (!force && wasSilent && watcher && before && lastSignature !== before) {
        log.info('watcher missed a change — re-arming');
        drop(watcher);
        arm();
      }
      onResult(r);
    },
  });

  function drop(w) {
    if (watcher === w) watcher = null;
    try {
      w.close();
    } catch {
      /* already closed */
    }
  }

  function arm() {
    if (watcher || stopped || !tc.watch) return;
    const { leveldb } = paths();
    let w;
    try {
      w = fsWatch(leveldb, { persistent: false }, (_type, filename) => {
        if (stopped || !relevantChange(filename)) return;
        stats.notifications++;
        heard++;
        wantForce = true;
        sched.poke();
      });
    } catch (err) {
      // No directory (Teams not installed or mid-update): the fast poll
      // runs and tries again.
      log.debug('watch not armed', { code: err.code || err.message });
      return;
    }
    stats.rearms++;
    const lost = (why) => {
      if (watcher !== w) return;
      log.info('watcher lost — polling until re-armed', { why });
      drop(w);
      sched.poke(); // whatever it missed
      scheduleFallback();
    };
    w.on('error', (err) => lost(err.code || err.message));
    w.on('close', () => lost('closed'));
    watcher = w;
  }

  function scheduleFallback() {
    if (fallbackTimer) timers.clearTimeout(fallbackTimer);
    fallbackTimer = null;
    if (stopped) return;
    const seconds = watcher ? tc.fallbackSeconds : tc.pollSeconds;
    fallbackTimer = timers.setTimeout(() => {
      fallbackTimer = null;
      if (!watcher) arm();
      stats.fallbackChecks++;
      silent = heard === heardAtCheck;
      heardAtCheck = heard;
      sched.poke();
      scheduleFallback();
    }, seconds * 1000);
  }

  arm();
  // One read at start, as the poll did: whatever arrived while the worker was down.
  sched.poke();
  scheduleFallback();

  return {
    stats: () => ({ ...stats, watching: Boolean(watcher), reader: reader?.stats?.() || null }),
    stop() {
      stopped = true;
      sched.stop();
      if (fallbackTimer) timers.clearTimeout(fallbackTimer);
      if (watcher) drop(watcher);
      if (reader) reader.close();
      reader = null;
    },
  };
}

// For the ingest registry (`pa sync --source teams_cache`): always reads.
async function run() {
  const r = await pass({ force: true });
  if (r.skipped) log.info('skipped', { reason: r.skipped });
  return r.changed;
}

// `pa doctor`: where the cache is and how fresh the newest message read was.
async function status() {
  if (config.teamsCache.unsupported) {
    // Off by platform, not by you (src/platform): say so, and point at a
    // Teams web cache if one exists, which PA_TEAMS_CACHE_DIR can try.
    const found = typeof platform.teamsWebCaches === 'function' ? platform.teamsWebCaches() : [];
    return {
      ok: true,
      detail:
        `UNSUPPORTED on ${platform.label}: ${config.teamsCache.unsupported} (every ${config.m365.pollSeconds}s)` +
        (found.length ? ` · a Teams web cache exists — PA_TEAMS_CACHE_DIR=${found[0]} tries it (experimental)` : ''),
    };
  }
  if (!config.teamsCache.enabled) return { ok: true, detail: 'off (PA_TEAMS_CACHE=0)' };
  const { leveldb } = paths();
  if (!fs.existsSync(leveldb)) return { ok: false, detail: 'not found — is the new Teams installed?' };
  const experimental = platform.teamsCache.supported ? '' : ' · EXPERIMENTAL (a Teams web cache, untested record shapes)';
  if (!fs.existsSync(config.teamsCache.python)) {
    return { ok: false, detail: `reader venv missing (${config.teamsCache.python}) — see README, Teams in seconds` };
  }
  const cursor = await getCursor(CURSOR).catch(() => null);
  const st = cursor?.state || {};
  if (cursor?.last_error) return { ok: false, detail: `last pass failed: ${String(cursor.last_error).slice(0, 80)}` };
  if (!st.lastReadAt) return { ok: false, detail: 'never read — is the worker running?' };
  const ago = (t) => `${Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000))}s ago`;
  return {
    ok: Date.now() - Date.parse(st.lastReadAt) < 10 * 60_000,
    detail: `last message ${st.newestArrival ? ago(Number(st.newestArrival)) : 'none yet'} · last read ${ago(st.lastReadAt)}${experimental}`,
  };
}

module.exports = {
  id: CURSOR,
  run,
  pass,
  tick,
  watch,
  status,
  relevantChange,
  // pure, for tests
  toItem,
  planWrite,
  isFresh,
  isSystem,
  chatTypeOf,
  webUrlFor,
  parseOutput,
  oidOf,
};
