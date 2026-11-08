'use strict';

// SQLite twin of src/repo/sources.js (source_item, sync_cursor).
// Differences from Postgres: the "agent" flag (pg `body_text ~* pattern`) is
// computed in JS with a case-insensitive JS RegExp of the same pattern; ilike
// is LIKE (ASCII case-insensitive here); window bounds are computed in JS.

const { NOW, HOUR, DAY, sinceMs } = require('./_sql');

const EVENT_COLS = 'id, external_id, subject, body_text, occurred_at, author_identity, raw';
const MIN = 60_000;

/** The instant `ms` after `t` (Date, ISO or epoch ms), as stored. */
const shift = (t, ms) => new Date(new Date(t).getTime() + ms).toISOString();

/** Sets row.agent from the full body (row._body) by `pattern`, case-insensitive; drops _body. */
function flagAgent(rows, pattern) {
  const re = pattern == null ? null : new RegExp(pattern, 'i');
  for (const r of rows) {
    r.agent = re && r._body != null ? re.test(r._body) : null;
    delete r._body;
  }
  return rows;
}

function create(db) {
  return {
    /** Retention: deletes mail and chat items older than `days` days. Resolves the number deleted. */
    async deleteOldMessages(days) {
      const r = await db.query(
        `delete from source_item
        where source in ('graph_mail','graph_chat')
          and occurred_at < $1`,
        [sinceMs(Number(days) * DAY)]
      );
      return r.rowCount || 0;
    },

    /** Calendar events from 12 hours before `now` (epoch ms) to 1 hour after. */
    async calendarAroundNow(now) {
      return db.rows(
        `select subject, occurred_at, raw from source_item
      where source = 'graph_event' and occurred_at between $1 and $2`,
        [shift(now, -12 * HOUR), shift(now, HOUR)]
      );
    },

    /** Calendar events within two hours of [fromIso, toIso], oldest first. */
    async calendarWindow(fromIso, toIso) {
      return db.rows(
        `select external_id, subject, occurred_at, raw from source_item
      where source = 'graph_event' and occurred_at between $1 and $2
      order by occurred_at`,
        [shift(fromIso, -2 * HOUR), shift(toIso, 2 * HOUR)]
      );
    },

    /** The id of a stored item by source and external id. */
    async idByExternal(source, externalId) {
      return db.one('select id from source_item where source = $1 and external_id = $2', [source, externalId]);
    },

    /** Pull requests, GitHub notifications, project items and Jira issues of the last three weeks, newest first (20). */
    async recentReviews() {
      return db.rows(
        `select subject, source, raw, occurred_at
       from source_item
      where source in ('github_pr','github_notification','github_project_item','jira_issue')
        and occurred_at > $1
      order by occurred_at desc
      limit 20`,
        [sinceMs(21 * DAY)]
      );
    },

    /** Calendar events from two hours ago to a day ahead (20). */
    async calendarToday() {
      const now = Date.now();
      return db.rows(
        `select subject, occurred_at, raw
       from source_item
      where source = 'graph_event' and occurred_at between $1 and $2
      order by occurred_at
      limit 20`,
        [shift(now, -2 * HOUR), shift(now, DAY)]
      );
    },

    /** Calendar events between two instants, oldest first. */
    async eventsBetween(from, to) {
      return db.rows(
        `select ${EVENT_COLS} from source_item
      where source = 'graph_event' and occurred_at between $1 and $2
      order by occurred_at`,
        [from, to]
      );
    },

    /** Calendar events whose subject matches an ilike pattern, oldest first. */
    async eventsBySubject(like) {
      return db.rows(
        `select ${EVENT_COLS} from source_item
      where source = 'graph_event' and subject like $1 escape '\\'
      order by occurred_at`,
        [like]
      );
    },

    /** One calendar event by its item id. */
    async eventById(id) {
      return db.one(`select ${EVENT_COLS} from source_item where source = 'graph_event' and id = $1`, [id]);
    },

    /** One calendar event by its external (Graph) id. */
    async eventByExternalId(externalId) {
      return db.one(`select ${EVENT_COLS} from source_item where source = 'graph_event' and external_id = $1`, [externalId]);
    },

    /** The `sync_cursor.state` of a connector, or null. */
    async cursorState(source) {
      return db.one('select state from sync_cursor where source = $1', [source]);
    },

    /** A GitHub author's PRs active in a window (6, newest first), body head and the agent flag. */
    async prsByAuthorBetween(author, from, to, agentPattern) {
      const rows = await db.rows(
        `select id, subject, occurred_at, raw, substr(body_text, 1, 600) as body, body_text as _body from source_item
        where source = 'github_pr' and author_identity = $1 and occurred_at between $2 and $3
        order by occurred_at desc limit 6`,
        [author, from, to]
      );
      return flagAgent(rows, agentPattern);
    },

    /** Jira issues assigned to any of `assignees` that changed in a window (6, newest first). */
    async jiraAssignedBetween(from, to, assignees) {
      return db.rows(
        `select id, subject, occurred_at, raw from source_item
      where source = 'jira_issue' and occurred_at between $1 and $2
        and lower(json_extract(raw, '$.assignee')) in (select value from json_each($3))
      order by occurred_at desc limit 6`,
        [from, to, assignees || []]
      );
    },

    /** Claude Code sessions in a window, longest first (8), with the opening prompt's head. */
    async claudeSessionsBetween(from, to) {
      return db.rows(
        `select id, subject, occurred_at, raw, substr(body_text, 1, 600) as body from source_item
      where source = 'claude_session' and occurred_at between $1 and $2
      order by coalesce(cast(json_extract(raw, '$.turns') as integer), 0) desc limit 8`,
        [from, to]
      );
    },

    /** Open Jira issues assigned to any of `assignees`, newest first. */
    async openJiraAssigned(assignees, limit) {
      return db.rows(
        `select id, subject, raw from source_item
      where source = 'jira_issue' and json_extract(raw, '$.state') = 'opened'
        and lower(json_extract(raw, '$.assignee')) in (select value from json_each($1))
      order by occurred_at desc limit ${Number(limit)}`,
        [assignees || []]
      );
    },

    /** A GitHub author's open PRs of the last 14 days before `now` (5), with the agent flag. */
    async openPrsRecent(author, now, agentPattern) {
      const rows = await db.rows(
        `select id, subject, raw, body_text as _body from source_item
        where source = 'github_pr' and author_identity = $1 and json_extract(raw, '$.state') = 'opened'
          and occurred_at > $2
        order by occurred_at desc limit 5`,
        [author, shift(now, -14 * DAY)]
      );
      return flagAgent(rows, agentPattern);
    },

    /** A GitHub author's open PRs that carry a label matching %block% (3). */
    async blockedPrs(author) {
      return db.rows(
        `select id, subject, raw from source_item
        where source = 'github_pr' and author_identity = $1 and json_extract(raw, '$.state') = 'opened'
          and exists (select 1 from json_each(raw, '$.labels') l where l.value like '%block%')
        limit 3`,
        [author]
      );
    },

    /** Chat and mail from one address in the 21 days before `now` (6, newest first). */
    async threadsFromAddress(email, now) {
      return db.rows(
        `select id, source, subject, occurred_at, substr(body_text, 1, 220) as snippet from source_item
            where source in ('graph_chat','graph_mail') and lower(author_identity) = $1
              and occurred_at > $2
            order by occurred_at desc limit 6`,
        [email, shift(now, -21 * DAY)]
      );
    },

    /** Chat and mail from any of `identities` in the 21 days before `now` (6, newest first). */
    async threadsFromIdentities(identities, now) {
      return db.rows(
        `select id, source, subject, occurred_at, substr(body_text, 1, 220) as snippet from source_item
      where source in ('graph_chat','graph_mail') and author_identity in (select value from json_each($1))
        and occurred_at > $2
      order by occurred_at desc limit 6`,
        [identities || [], shift(now, -21 * DAY)]
      );
    },

    /** Teams chats (not channels) from 5 minutes before `startIso` to 2 minutes after `endIso`, oldest first (16). */
    async chatsAround(startIso, endIso) {
      return db.rows(
        `select subject, author_identity, occurred_at, substr(body_text, 1, 240) as body, raw
       from source_item
      where source = 'graph_chat'
        and occurred_at between $1 and $2
        and coalesce(json_extract(raw, '$.chatType'), '') <> 'channel'
      order by occurred_at asc limit 16`,
        [shift(startIso, -5 * MIN), shift(endIso, 2 * MIN)]
      );
    },

    /** A GitHub author's open PRs of the last 60 days (15, newest first). */
    async openPrsByAuthor(author) {
      return db.rows(
        `select id, subject, raw from source_item
        where source = 'github_pr' and author_identity = $1 and json_extract(raw, '$.state') = 'opened'
          and occurred_at > $2
        order by occurred_at desc limit 15`,
        [author, sinceMs(60 * DAY)]
      );
    },

    /** Calendar events of the 12 hours up to `now`. */
    async calendarBefore(now) {
      return db.rows(
        `select external_id, subject, occurred_at, raw from source_item
      where source = 'graph_event' and occurred_at between $1 and $2`,
        [shift(now, -12 * HOUR), now]
      );
    },

    /** These items' {id, source, author_identity, occurred_at, subject, body_text, raw}, in no order. */
    async itemsByIds(ids) {
      return db.rows(
        'select id, source, author_identity, occurred_at, subject, body_text, raw from source_item where id in (select value from json_each($1))',
        [(ids || []).map(Number)]
      );
    },

    /** An item's subject and body, or null. */
    async subjectAndBody(id) {
      return db.one('select subject, body_text from source_item where id = $1', [id]);
    },

    /**
     * Rewinds the date cursors (state.since) of `sources` (all when empty) to
     * `since`, dropping delta tokens. Resolves the sources rewound.
     */
    async rewindCursors(since, sources) {
      const at = since instanceof Date ? since.toISOString() : String(since);
      const r = await db.rows(
        `update sync_cursor
        set state = json_set(state, '$.since', $1), delta_token = null
      where json_type(state, '$.since') is not null
        and (json_array_length($2) = 0 or source in (select value from json_each($2)))
      returning source`,
        [at, sources || []]
      );
      return r.map((x) => x.source);
    },

    /** One Claude session item by id, or null (another source's id is null too). */
    async claudeSessionItem(id) {
      return db.one(
        `select id, source, external_id, subject, occurred_at, raw from source_item where id = $1 and source = 'claude_session'`,
        [id]
      );
    },

    /** A connector's cursor: {last_run_at, last_error, state}, or null. */
    async cursorRow(source) {
      return db.one('select last_run_at, last_error, state from sync_cursor where source = $1', [source]);
    },

    /** The newest twelve items of a thread, newest first (body cut to 600 chars). */
    async threadItems(threadExternalId) {
      return db.rows(
        `select id, author_identity, occurred_at, substr(body_text, 1, 600) as body from source_item
          where thread_external_id = $1 order by occurred_at desc, id desc limit 12`,
        [threadExternalId]
      );
    },

    // --- for src/ingest (chunk F)

    /** Inserts an item, or updates it when its content hash changed. {id, content_hash} when new or changed, null when unchanged. */
    async upsertItem(it) {
      return db.one(
        `insert into source_item
    (source, external_id, thread_external_id, occurred_at, author_identity, subject, body_text, raw, content_hash)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  on conflict (source, external_id) do update set
    thread_external_id = excluded.thread_external_id,
    occurred_at        = excluded.occurred_at,
    author_identity    = excluded.author_identity,
    subject            = excluded.subject,
    body_text          = excluded.body_text,
    raw                = excluded.raw,
    content_hash       = excluded.content_hash,
    fetched_at         = ${NOW}
  where source_item.content_hash is not excluded.content_hash
  returning id, content_hash`,
        [it.source, it.externalId, it.threadExternalId, it.occurredAt, it.authorIdentity, it.subject, it.bodyText, it.raw, it.hash]
      );
    },

    /** Drops an item's chunks (derived state: a changed body makes them wrong). */
    async deleteChunks(itemId) {
      await db.query('delete from chunk where source_item_id = $1', [itemId]);
    },

    /** Writes chunk `ord` of an item; a rewrite clears its embedding (the FTS tables follow by trigger). */
    async upsertChunk(itemId, ord, content, context, contextV) {
      await db.query(
        `insert into chunk (source_item_id, ord, content, context, context_v) values ($1,$2,$3,$4,$5)
         on conflict (source_item_id, ord) do update set content = excluded.content,
           context = excluded.context, context_v = excluded.context_v, embedding = null`,
        [itemId, ord, content, context, contextV]
      );
    },

    /** Drops an item's distillation (its body changed, so it is distilled again). */
    async deleteDistillation(itemId) {
      await db.query('delete from distillation where source_item_id = $1', [itemId]);
    },

    /** Advances a connector's cursor: delta token and state, run now, error cleared. */
    async saveCursor({ source, deltaToken = null, state = {} }) {
      await db.query(
        `insert into sync_cursor (source, delta_token, last_run_at, last_error, state)
         values ($1,$2,${NOW},null,$3)
         on conflict (source) do update set
           delta_token = excluded.delta_token,
           last_run_at = excluded.last_run_at,
           last_error  = null,
           state       = excluded.state`,
        [source, deltaToken, typeof state === 'string' ? state : JSON.stringify(state ?? {})]
      );
    },

    /** A connector's whole cursor row, or null. */
    async getCursor(source) {
      return db.one('select * from sync_cursor where source = $1', [source]);
    },

    /** Records a failed run of a connector (its cursor otherwise unchanged). */
    async recordCursorError(source, message) {
      await db.query(
        `insert into sync_cursor (source, last_run_at, last_error)
       values ($1, ${NOW}, $2)
       on conflict (source) do update set last_run_at = ${NOW}, last_error = excluded.last_error`,
        [source, message]
      );
    },

    /** Every cursor: {source, last_run_at, last_error, has_token}, by source. */
    async cursorList() {
      const rows = await db.rows('select source, last_run_at, last_error, delta_token is not null as has_token from sync_cursor order by source');
      for (const r of rows) r.has_token = Boolean(r.has_token);
      return rows;
    },

    /** Every cursor with the newest item it brought: {source, last_run_at, last_error, last_item_at}. */
    async cursorHealth() {
      const rows = await db.rows(
        `select sc.source, sc.last_run_at, sc.last_error,
            (select max(si.fetched_at) from source_item si where si.source = sc.source) as last_item_at
       from sync_cursor sc order by sc.source`
      );
      for (const r of rows) if (r.last_item_at != null) r.last_item_at = new Date(r.last_item_at);
      return rows;
    },

    /** The signed-in Microsoft 365 address the m365 cursor remembers ({mail}), or null. */
    async m365Mail() {
      return db.one(`select json_extract(state, '$.me.mail') as mail from sync_cursor where source = 'm365'`);
    },

    /**
     * Teams chat messages of the last 14 days that arrived empty and may be
     * fetched again (fewer than `maxTries` repairs), newest first. pg's
     * split_part(external_id, '/', 2) ~ '^[0-9]+$' is spelled with instr/substr/glob.
     */
    async emptyChatMessages(limit, maxTries) {
      return db.rows(
        `select id, external_id, thread_external_id, subject, author_identity, raw from (
           select *, case when instr(substr(external_id, instr(external_id, '/') + 1), '/') > 0
                          then substr(substr(external_id, instr(external_id, '/') + 1), 1, instr(substr(external_id, instr(external_id, '/') + 1), '/') - 1)
                          else substr(external_id, instr(external_id, '/') + 1) end as part2
             from source_item
            where source = 'graph_chat' and body_text = '' and occurred_at > $3
              and coalesce(cast(json_extract(raw, '$.repairTries') as integer), 0) < $2
              and thread_external_id like '19:%' and instr(external_id, '/') > 0)
          where part2 <> '' and part2 not glob '*[^0-9]*'
          order by occurred_at desc limit $1`,
        [limit, maxTries, sinceMs(14 * DAY)]
      );
    },

    /** Fills a repaired message's body (marked repaired, so the reconciler may judge it again). */
    async repairBody(id, text, hash) {
      await db.query(
        `update source_item set body_text = $2, content_hash = $3, fetched_at = ${NOW},
                raw = json_set(raw, '$.repaired', json('true')) where id = $1`,
        [id, text, hash]
      );
    },

    /** Counts one more failed repair of a message. */
    async countRepairTry(id) {
      await db.query(
        `update source_item set raw = json_set(raw, '$.repairTries', coalesce(cast(json_extract(raw, '$.repairTries') as integer), 0) + 1) where id = $1`,
        [id]
      );
    },

    /** Chat messages stored from the Teams cache, by external id. */
    async cachedChatMessages(externalIds) {
      return db.rows(
        `select external_id, occurred_at, author_identity, subject, body_text, raw
       from source_item
      where source = 'graph_chat' and external_id in (select value from json_each($1)) and json_extract(raw, '$.via') = 'teams-cache'`,
        [externalIds || []]
      );
    },

    /** Per chat and display name, the newest address it was seen with: {chat, name, email}. */
    async chatSenderEmails(threads) {
      return db.rows(
        `select chat, name, email from (
           select thread_external_id as chat, json_extract(raw, '$.fromName') as name, lower(author_identity) as email,
                  row_number() over (partition by thread_external_id, json_extract(raw, '$.fromName') order by occurred_at desc, id desc) as rn
             from source_item
            where source = 'graph_chat' and thread_external_id in (select value from json_each($1))
              and author_identity like '%@%' and json_extract(raw, '$.fromName') is not null)
          where rn = 1 order by chat, name`,
        [threads || []]
      );
    },

    /** Per chat, its newest message's subject and raw, preferring ones from the connector: {chat, subject, raw}. */
    async chatHeads(conversationIds) {
      const rows = await db.rows(
        `select chat, subject, raw from (
           select thread_external_id as chat, subject, raw,
                  row_number() over (partition by thread_external_id
                                     order by (json_extract(raw, '$.via') is null) desc, occurred_at desc, id desc) as rn
             from source_item
            where source = 'graph_chat' and thread_external_id in (select value from json_each($1)))
          where rn = 1 order by chat`,
        [conversationIds || []]
      );
      for (const r of rows) if (typeof r.raw === 'string') r.raw = JSON.parse(r.raw);
      return rows;
    },

    /** Chat messages by external id: {external_id, occurred_at, author_identity, subject, raw, fetched_at}. */
    async chatMessagesByExternalId(externalIds) {
      return db.rows(
        `select external_id, occurred_at, author_identity, subject, raw, fetched_at
       from source_item where source = 'graph_chat' and external_id in (select value from json_each($1))`,
        [externalIds || []]
      );
    },

    /** Every Claude session's folder, machine, branch and time. */
    async claudeSessionFolders() {
      return db.rows(
        `select json_extract(raw, '$.cwd') as cwd, json_extract(raw, '$.machine') as machine, json_extract(raw, '$.gitBranch') as branch, occurred_at
       from source_item where source = 'claude_session' and json_extract(raw, '$.cwd') is not null`
      );
    },

    /** Claude session items of the last `days` days, newest first, at most 400: {id, occurred_at, body_text}. */
    async recentClaudeSessions(days) {
      return db.rows(
        `select id, occurred_at, body_text from source_item
      where source = 'claude_session' and occurred_at > $1
      order by occurred_at desc, id desc limit 400`,
        [sinceMs(Number(days) * DAY)]
      );
    },
  };
}

module.exports = { create };
