'use strict';

// Aggregate: sources. Tables: source_item, sync_cursor (and ingest health).
// Owner while plan 1.2 is converting: chunk F (repos, ingest, routines).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

function create(db: Db) {
  return {
    // --- for src/worker.js (the retention pass)

    /**
     * Retention: deletes mail and chat items older than `days` days (their
     * derived rows keep what they need). Resolves the number deleted.
     */
    async deleteOldMessages(days: number) {
      const r = await db.query(
        `delete from source_item
        where source in ('graph_mail','graph_chat')
          and occurred_at < now() - ($1 || ' days')::interval`,
        [String(days)]
      );
      return r.rowCount || 0;
    },

    // --- for audio/gate.ts

    /**
     * Calendar events from 12 hours before `now` to 1 hour after.
     * @param {number} now  epoch ms
     * @returns {Promise<{subject: string, occurred_at: Date, raw: object}[]>}
     */
    async calendarAroundNow(now: Date | string | number) {
      return db.rows(
        `select subject, occurred_at, raw from source_item
      where source = 'graph_event'
        and occurred_at between $1::timestamptz - interval '12 hours' and $1::timestamptz + interval '1 hour'`,
        [new Date(now)]
      );
    },

    // --- for ingest/audio.js

    /**
     * Calendar events within two hours of [fromIso, toIso], oldest first.
     * @returns {Promise<{external_id: string, subject: string, occurred_at: Date, raw: object}[]>}
     */
    async calendarWindow(fromIso: unknown, toIso: unknown) {
      return db.rows(
        `select external_id, subject, occurred_at, raw from source_item
      where source = 'graph_event'
        and occurred_at between $1::timestamptz - interval '2 hours' and $2::timestamptz + interval '2 hours'
      order by occurred_at`,
        [fromIso, toIso]
      );
    },

    /**
     * The id of a stored item by source and external id.
     * @returns {Promise<{id: number|string}|null>}
     */
    async idByExternal(source: string, externalId: number | string) {
      return db.one('select id from source_item where source = $1 and external_id = $2', [source, externalId]);
    },

    // --- for brief/index.js

    /**
     * Pull requests, GitHub notifications, project items and Jira issues of
     * the last three weeks, newest first (20).
     * @returns {Promise<{subject: string, source: string, raw: object, occurred_at: Date}[]>}
     */
    async recentReviews() {
      return db.rows(
        `select subject, source, raw, occurred_at
       from source_item
      where source in ('github_pr','github_notification','github_project_item','jira_issue')
        and occurred_at > now() - interval '21 days'
      order by occurred_at desc
      limit 20`
      );
    },

    /**
     * Calendar events from two hours ago to `until` (default: a day ahead), oldest first (40).
     * @returns {Promise<{subject: string, occurred_at: Date, raw: object}[]>}
     */
    async calendarToday(until: Date | string | number | null = null) {
      return db.rows(
        `select subject, occurred_at, raw
       from source_item
      where source = 'graph_event'
        and occurred_at between now() - interval '2 hours' and coalesce($1::timestamptz, now() + interval '1 day')
      order by occurred_at
      limit 40`,
        [until == null ? null : new Date(until as string | number | Date)]
      );
    },

    // --- for meetings/index.js

    /**
     * Calendar events between two instants, oldest first.
     * @param {Date} from
     * @param {Date} to
     * @returns {Promise<object[]>}  id, external_id, subject, body_text, occurred_at, author_identity, raw
     */
    async eventsBetween(from: Date | string | number, to: string) {
      return db.rows(
        `select ${EVENT_COLS} from source_item
      where source = 'graph_event' and occurred_at between $1 and $2
      order by occurred_at`,
        [from, to]
      );
    },

    /**
     * Calendar events whose subject matches an ilike pattern, oldest first.
     * @param {string} like
     * @returns {Promise<object[]>}  as eventsBetween
     */
    async eventsBySubject(like: unknown) {
      return db.rows(
        `select ${EVENT_COLS} from source_item
      where source = 'graph_event' and subject ilike $1
      order by occurred_at`,
        [like]
      );
    },

    /**
     * One calendar event by its item id.
     * @returns {Promise<object|null>}  as eventsBetween
     */
    async eventById(id: number | string) {
      return db.one(`select ${EVENT_COLS} from source_item where source = 'graph_event' and id = $1`, [id]);
    },

    /**
     * One calendar event by its external (Graph) id.
     * @returns {Promise<object|null>}  as eventsBetween
     */
    async eventByExternalId(externalId: number | string) {
      return db.one(`select ${EVENT_COLS} from source_item where source = 'graph_event' and external_id = $1`, [externalId]);
    },

    /**
     * The `sync_cursor.state` of a connector, or null.
     * @param {string} source  e.g. 'm365', 'github'
     * @returns {Promise<{state: object}|null>}
     */
    async cursorState(source: string) {
      return db.one(`select state from sync_cursor where source = $1`, [source]);
    },

    /**
     * A GitHub author's PRs active in a window (6, newest first), with the
     * first 600 chars of the body and whether `agentPattern` matches it.
     * @param {string} author   'github:<login>'
     * @param {Date} from
     * @param {Date} to
     * @param {string} agentPattern  a Postgres regex
     */
    async prsByAuthorBetween(author: unknown, from: Date | string | number, to: string, agentPattern: unknown) {
      return db.rows(
        `select id, subject, occurred_at, raw, left(body_text, 600) as body,
              body_text ~* $4 as agent from source_item
        where source = 'github_pr' and author_identity = $1 and occurred_at between $2 and $3
        order by occurred_at desc limit 6`,
        [author, from, to, agentPattern]
      );
    },

    /**
     * Jira issues assigned to any of `assignees` (lowercased names or emails)
     * that changed in a window (6, newest first).
     */
    async jiraAssignedBetween(from: Date | string | number, to: string, assignees: unknown) {
      return db.rows(
        `select id, subject, occurred_at, raw from source_item
      where source = 'jira_issue' and occurred_at between $1 and $2
        and (lower(raw->>'assignee') = any($3::text[]))
      order by occurred_at desc limit 6`,
        [from, to, assignees]
      );
    },

    /**
     * Claude Code sessions in a window, longest first (8), with the first 600
     * chars of the opening prompt.
     */
    async claudeSessionsBetween(from: Date | string | number, to: string) {
      return db.rows(
        `select id, subject, occurred_at, raw, left(body_text, 600) as body from source_item
      where source = 'claude_session' and occurred_at between $1 and $2
      order by coalesce((raw->>'turns')::int, 0) desc limit 8`,
        [from, to]
      );
    },

    /**
     * Open Jira issues assigned to any of `assignees`, newest first.
     * @param {string[]} assignees  lowercased names or emails
     * @param {number} limit
     */
    async openJiraAssigned(assignees: unknown, limit: number) {
      return db.rows(
        `select id, subject, raw from source_item
      where source = 'jira_issue' and raw->>'state' = 'opened' and lower(raw->>'assignee') = any($1::text[])
      order by occurred_at desc limit ${Number(limit)}`,
        [assignees]
      );
    },

    /**
     * A GitHub author's open PRs of the last 14 days before `now` (5), with
     * whether `agentPattern` matches the body.
     */
    async openPrsRecent(author: unknown, now: Date | string | number, agentPattern: unknown) {
      return db.rows(
        `select id, subject, raw, body_text ~* $3 as agent from source_item
        where source = 'github_pr' and author_identity = $1 and raw->>'state' = 'opened'
          and occurred_at > $2::timestamptz - interval '14 days'
        order by occurred_at desc limit 5`,
        [author, now, agentPattern]
      );
    },

    /** A GitHub author's open PRs that carry a label matching %block% (3). */
    async blockedPrs(author: unknown) {
      return db.rows(
        `select id, subject, raw from source_item
        where source = 'github_pr' and author_identity = $1 and raw->>'state' = 'opened'
          and exists (select 1 from jsonb_array_elements_text(coalesce(raw->'labels','[]'::jsonb)) l where l ilike '%block%')
        limit 3`,
        [author]
      );
    },

    /**
     * Chat and mail from one address in the 21 days before `now` (6, newest first).
     * @param {string} email  lowercased
     */
    async threadsFromAddress(email: string, now: Date | string | number) {
      return db.rows(
        `select id, source, subject, occurred_at, left(body_text, 220) as snippet from source_item
            where source in ('graph_chat','graph_mail') and lower(author_identity) = $1
              and occurred_at > $2::timestamptz - interval '21 days'
            order by occurred_at desc limit 6`,
        [email, now]
      );
    },

    /**
     * Chat and mail from any of `identities` in the 21 days before `now` (6, newest first).
     * @param {string[]} identities
     */
    async threadsFromIdentities(identities: unknown, now: Date | string | number) {
      return db.rows(
        `select id, source, subject, occurred_at, left(body_text, 220) as snippet from source_item
      where source in ('graph_chat','graph_mail') and author_identity = any($1::text[])
        and occurred_at > $2::timestamptz - interval '21 days'
      order by occurred_at desc limit 6`,
        [identities, now]
      );
    },

    // --- for meetings/debrief.js

    /**
     * Teams chats (not channels) from 5 minutes before `startIso` to 2 minutes
     * after `endIso`, oldest first (16).
     */
    async chatsAround(startIso: unknown, endIso: unknown) {
      return db.rows(
        `select subject, author_identity, occurred_at, left(body_text, 240) as body, raw
       from source_item
      where source = 'graph_chat'
        and occurred_at between $1::timestamptz - interval '5 minutes' and $2::timestamptz + interval '2 minutes'
        and coalesce(raw->>'chatType', '') <> 'channel'
      order by occurred_at asc limit 16`,
        [startIso, endIso]
      );
    },

    /** A GitHub author's open PRs of the last 60 days (15, newest first). */
    async openPrsByAuthor(author: unknown) {
      return db.rows(
        `select id, subject, raw from source_item
        where source = 'github_pr' and author_identity = $1 and raw->>'state' = 'opened'
          and occurred_at > now() - interval '60 days'
        order by occurred_at desc limit 15`,
        [author]
      );
    },

    /**
     * Calendar events of the 12 hours up to `now`.
     * @param {Date} now
     * @returns {Promise<{external_id: string, subject: string, occurred_at: Date, raw: object}[]>}
     */
    async calendarBefore(now: Date | string | number) {
      return db.rows(
        `select external_id, subject, occurred_at, raw from source_item
      where source = 'graph_event' and occurred_at between $1::timestamptz - interval '12 hours' and $1::timestamptz`,
        [now]
      );
    },

    // --- for ledger/reconcile.js

    /** These items' {id, source, author_identity, occurred_at, subject, body_text, raw}, in no order. */
    async itemsByIds(ids: unknown[]) {
      return db.rows(
        `select id, source, author_identity, occurred_at, subject, body_text, raw from source_item where id = any($1::bigint[])`,
        [ids]
      );
    },

    // --- for src/commitments/request.js, src/projects/index.js

    /** An item's subject and body, or null. @returns {Promise<{subject, body_text}|null>} */
    async subjectAndBody(id: number | string) {
      return db.one('select subject, body_text from source_item where id = $1', [id]);
    },

    // --- for src/backup.js

    /**
     * Rewinds the date-based sync cursors (those with a `since`) of `sources`
     * (all when empty) to `since`, dropping their delta tokens, so the next
     * pass fetches again from there. Resolves the sources rewound.
     */
    async rewindCursors(since: Date | string | number, sources: unknown[]) {
      const r = await db.query(
        `update sync_cursor
        set state = jsonb_set(state, '{since}', to_jsonb($1::text)), delta_token = null
      where state ? 'since' and (cardinality($2::text[]) = 0 or source = any($2))
      returning source`,
        [since, sources]
      );
      return r.rows.map((x) => x.source);
    },

    // --- for cli/index.js, dashboard/cards.js, dashboard/server.js

    /** A connector's cursor: {last_run_at, last_error, state}, or null. */
    async cursorRow(source: string) {
      return db.one('select last_run_at, last_error, state from sync_cursor where source = $1', [source]);
    },

    /** One Claude session item by id, or null (another source's id is null too). */
    async claudeSessionItem(id: number | string) {
      return db.one(
        `select id, source, external_id, subject, occurred_at, raw from source_item where id = $1 and source = 'claude_session'`,
        [id]
      );
    },

    /** The newest twelve items of a thread, newest first (body cut to 600 chars). */
    async threadItems(threadExternalId: number | string) {
      return db.rows(
        `select id, author_identity, occurred_at, left(body_text, 600) as body from source_item
          where thread_external_id = $1 order by occurred_at desc limit 12`,
        [threadExternalId]
      );
    },

    // --- for src/ingest/store.js (chunk F): the ingest write path. Items and
    // their cursor advance in one transaction: call these inside repo.withTx.

    /**
     * Inserts an item, or updates it when its content hash changed (an edited
     * message). Resolves {id, content_hash} when new or changed, null when
     * unchanged. `it`: a normalised item (ingest/store.js normalise()).
     */
    async upsertItem(it: Row) {
      const res = await db.query(UPSERT_ITEM, [
        it.source, it.externalId, it.threadExternalId, it.occurredAt, it.authorIdentity, it.subject, it.bodyText, it.raw, it.hash,
      ]);
      return res.rows[0] || null;
    },

    /** Drops an item's chunks (derived state: a changed body makes them wrong). */
    async deleteChunks(itemId: number | string) {
      await db.query('delete from chunk where source_item_id = $1', [itemId]);
    },

    /** Writes chunk `ord` of an item; a rewrite clears its embedding. */
    async upsertChunk(itemId: number | string, ord: number, content: unknown, context: unknown, contextV: number) {
      await db.query(
        'insert into chunk (source_item_id, ord, content, context, context_v) values ($1,$2,$3,$4,$5) ' +
          'on conflict (source_item_id, ord) do update set content = excluded.content, ' +
          'context = excluded.context, context_v = excluded.context_v, embedding = null',
        [itemId, ord, content, context, contextV]
      );
    },

    /** Drops an item's distillation (its body changed, so it is distilled again). */
    async deleteDistillation(itemId: number | string) {
      await db.query('delete from distillation where source_item_id = $1', [itemId]);
    },

    /** Advances a connector's cursor: delta token and state, run now, error cleared. */
    async saveCursor({ source, deltaToken = null, state = {} }: { source?: string | null; deltaToken?: unknown; state?: unknown }) {
      await db.query(CURSOR_UPSERT, [source, deltaToken, state]);
    },

    /** A connector's whole cursor row, or null. */
    async getCursor(source: string) {
      return db.one('select * from sync_cursor where source = $1', [source]);
    },

    /** Records a failed run of a connector (its cursor otherwise unchanged). */
    async recordCursorError(source: string, message: string) {
      await db.query(
        `insert into sync_cursor (source, last_run_at, last_error)
       values ($1, now(), $2)
       on conflict (source) do update set last_run_at = now(), last_error = excluded.last_error`,
        [source, message]
      );
    },

    /** Every cursor: {source, last_run_at, last_error, has_token}, by source. */
    async cursorList() {
      return db.rows('select source, last_run_at, last_error, delta_token is not null as has_token from sync_cursor order by source');
    },

    // --- for src/ingest/health.js

    /** Every cursor with the newest item it brought: {source, last_run_at, last_error, last_item_at}. */
    async cursorHealth() {
      return db.rows(
        `select sc.source, sc.last_run_at, sc.last_error,
            (select max(si.fetched_at) from source_item si where si.source = sc.source) as last_item_at
       from sync_cursor sc order by sc.source`
      );
    },

    // --- for src/ingest/jira.js

    /** The signed-in Microsoft 365 address the m365 cursor remembers ({mail}), or null. */
    async m365Mail() {
      return db.one(`select state->'me'->>'mail' as mail from sync_cursor where source = 'm365'`);
    },

    // --- for src/ingest/graphChat.js

    /**
     * Teams chat messages of the last 14 days that arrived empty and may be
     * fetched again (fewer than `maxTries` repairs), newest first.
     */
    async emptyChatMessages(limit: number, maxTries: number) {
      return db.rows(
        `select id, external_id, thread_external_id, subject, author_identity, raw from source_item
      where source = 'graph_chat' and body_text = '' and occurred_at > now() - interval '14 days'
        and coalesce((raw->>'repairTries')::int, 0) < $2
        and thread_external_id like '19:%' and split_part(external_id, '/', 2) ~ '^[0-9]+$'
      order by occurred_at desc limit $1`,
        [limit, maxTries]
      );
    },

    /** Fills a repaired message's body (marked repaired, so the reconciler may judge it again). */
    async repairBody(id: number | string, text: string, hash: string) {
      await db.query(
        `update source_item set body_text = $2, content_hash = $3, fetched_at = now(),
                raw = raw || '{"repaired": true}'::jsonb where id = $1`,
        [id, text, hash]
      );
    },

    /** Counts one more failed repair of a message. */
    async countRepairTry(id: number | string) {
      await db.query(`update source_item set raw = jsonb_set(raw, '{repairTries}', to_jsonb(coalesce((raw->>'repairTries')::int, 0) + 1)) where id = $1`, [id]);
    },

    /** Chat messages stored from the Teams cache, by external id. */
    async cachedChatMessages(externalIds: unknown[]) {
      return db.rows(
        `select external_id, occurred_at, author_identity, subject, body_text, raw
       from source_item
      where source = 'graph_chat' and external_id = any($1) and raw->>'via' = 'teams-cache'`,
        [externalIds]
      );
    },

    // --- for src/ingest/teamsLocal.js

    /** Per chat and display name, the newest address it was seen with: {chat, name, email}. */
    async chatSenderEmails(threads: unknown[]) {
      return db.rows(
        `select distinct on (thread_external_id, raw->>'fromName') thread_external_id as chat, raw->>'fromName' as name,
            lower(author_identity) as email
       from source_item
      where source = 'graph_chat' and thread_external_id = any($1)
        and author_identity like '%@%' and raw->>'fromName' is not null
      order by thread_external_id, raw->>'fromName', occurred_at desc`,
        [threads]
      );
    },

    /** Per chat, its newest message's subject and raw, preferring ones from the connector: {chat, subject, raw}. */
    async chatHeads(conversationIds: unknown[]) {
      return db.rows(
        `select distinct on (thread_external_id) thread_external_id as chat, subject, raw
       from source_item
      where source = 'graph_chat' and thread_external_id = any($1)
      order by thread_external_id, (raw->>'via' is null) desc, occurred_at desc`,
        [conversationIds]
      );
    },

    /** Who wrote in one chat: [{author (lowercased, or null), n}], most messages first. */
    async chatAuthors(thread: string) {
      return db.rows(
        `select lower(author_identity) as author, count(*)::int as n from source_item
          where source = 'graph_chat' and thread_external_id = $1
          group by lower(author_identity) order by n desc, author`,
        [thread]
      );
    },

    /** A chat's first message whose body holds `marker` (never Teams' local copy, id -1), with its distillation, or null. */
    async chatItemWith(thread: string, marker: string) {
      return db.one(
        `select si.id, si.external_id, si.occurred_at, si.fetched_at, si.author_identity, si.raw,
                d.extracted_at as distilled_at, d.commitments as distilled, d.error as distill_error
           from source_item si left join distillation d on d.source_item_id = si.id
          where si.source = 'graph_chat' and si.thread_external_id = $1 and si.external_id not like '%/-1'
            and strpos(si.body_text, $2) > 0
          order by si.occurred_at, si.id limit 1`,
        [thread, marker]
      );
    },

    /** Chat messages by external id: {external_id, occurred_at, author_identity, subject, raw, fetched_at}. */
    async chatMessagesByExternalId(externalIds: unknown[]) {
      return db.rows(
        `select external_id, occurred_at, author_identity, subject, raw, fetched_at
       from source_item where source = 'graph_chat' and external_id = any($1)`,
        [externalIds]
      );
    },

    // --- for src/repos/sources.js

    /** Every Claude session's folder, machine, branch and time. */
    async claudeSessionFolders() {
      return db.rows(
        `select raw->>'cwd' as cwd, raw->>'machine' as machine, raw->>'gitBranch' as branch, occurred_at
       from source_item where source = 'claude_session' and raw->>'cwd' is not null`
      );
    },

    // --- for src/routines/suggest.js

    /** Claude session items of the last `days` days, newest first, at most 400: {id, occurred_at, body_text}. */
    async recentClaudeSessions(days: number) {
      return db.rows(
        `select id, occurred_at, body_text from source_item
      where source = 'claude_session' and occurred_at > now() - ($1 || ' days')::interval
      order by occurred_at desc limit 400`,
        [String(days)]
      );
    },

    // --- for src/dispatch/index.ts, src/mcp/server.js

    /** One item row by id, or null. */
    async rowById(id: number | string) {
      return db.one('select * from source_item where id = $1', [id]);
    },

    /** The six newest other items of a thread: {id, source, subject, occurred_at}. */
    async relatedInThread(threadExternalId: number | string, exceptId: number | string) {
      return db.rows(
        `select id, source, subject, occurred_at from source_item
      where thread_external_id = $1 and id <> $2
      order by occurred_at desc limit 6`,
        [threadExternalId, exceptId]
      );
    },

    /** Every item of a thread in one source, oldest first (whole rows). */
    async threadRows(source: string, threadExternalId: number | string) {
      return db.rows('select * from source_item where source = $1 and thread_external_id = $2 order by occurred_at', [source, threadExternalId]);
    },

    /** The twenty newest code items (PRs, issues, notifications, project items) of a forge project. */
    async codeItemsOf(gitlabPath: string) {
      return db.rows(
        `select source, subject, raw, occurred_at from source_item
          where source in ('github_pr','github_issue','github_notification','github_project_item')
            and raw->>'project' = $1
          order by occurred_at desc limit 20`,
        [gitlabPath]
      );
    },

    /** The ten newest items written by a person (by identity or `email`). */
    async recentByPerson(personId: number | string, email: string) {
      return db.rows(
        `select si.id, si.source, si.subject, si.occurred_at from source_item si
          where si.author_identity in (select value from person_identity where person_id = $1)
             or si.author_identity = $2
          order by si.occurred_at desc limit 10`,
        [personId, email]
      );
    },
  };
}

// `on conflict do update` rather than `do nothing`: an edited Teams message or
// a mail that gained a category comes back through delta with the same id, and
// the newer body is the one worth keeping. The content hash changing is also
// what re-opens it for distillation.
const UPSERT_ITEM = `
  insert into source_item
    (source, external_id, thread_external_id, occurred_at, author_identity,
     subject, body_text, raw, content_hash)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  on conflict (source, external_id) do update set
    thread_external_id = excluded.thread_external_id,
    occurred_at        = excluded.occurred_at,
    author_identity    = excluded.author_identity,
    subject            = excluded.subject,
    body_text          = excluded.body_text,
    raw                = excluded.raw,
    content_hash       = excluded.content_hash,
    fetched_at         = now()
  where source_item.content_hash is distinct from excluded.content_hash
  returning id, content_hash
`;

const CURSOR_UPSERT = `insert into sync_cursor (source, delta_token, last_run_at, last_error, state)
         values ($1,$2,now(),null,$3)
         on conflict (source) do update set
           delta_token = excluded.delta_token,
           last_run_at = excluded.last_run_at,
           last_error  = null,
           state       = excluded.state`;

const EVENT_COLS = 'id, external_id, subject, body_text, occurred_at, author_identity, raw';

module.exports = { create };