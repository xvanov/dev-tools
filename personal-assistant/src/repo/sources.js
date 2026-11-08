'use strict';

// Aggregate: sources. Tables: source_item, sync_cursor (and ingest health).
// Owner while plan 1.2 is converting: chunk F (repos, ingest, routines).

function create(db) {
  return {
    // --- for src/worker.js (the retention pass)

    /**
     * Retention: deletes mail and chat items older than `days` days (their
     * derived rows keep what they need). Resolves the number deleted.
     */
    async deleteOldMessages(days) {
      const r = await db.query(
        `delete from source_item
        where source in ('graph_mail','graph_chat')
          and occurred_at < now() - ($1 || ' days')::interval`,
        [String(days)]
      );
      return r.rowCount || 0;
    },

    // --- for audio/gate.js

    /**
     * Calendar events from 12 hours before `now` to 1 hour after.
     * @param {number} now  epoch ms
     * @returns {Promise<{subject: string, occurred_at: Date, raw: object}[]>}
     */
    async calendarAroundNow(now) {
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
    async calendarWindow(fromIso, toIso) {
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
    async idByExternal(source, externalId) {
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
     * Calendar events from two hours ago to a day ahead (20).
     * @returns {Promise<{subject: string, occurred_at: Date, raw: object}[]>}
     */
    async calendarToday() {
      return db.rows(
        `select subject, occurred_at, raw
       from source_item
      where source = 'graph_event'
        and occurred_at between now() - interval '2 hours' and now() + interval '1 day'
      order by occurred_at
      limit 20`
      );
    },

    // --- for meetings/index.js

    /**
     * Calendar events between two instants, oldest first.
     * @param {Date} from
     * @param {Date} to
     * @returns {Promise<object[]>}  id, external_id, subject, body_text, occurred_at, author_identity, raw
     */
    async eventsBetween(from, to) {
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
    async eventsBySubject(like) {
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
    async eventById(id) {
      return db.one(`select ${EVENT_COLS} from source_item where source = 'graph_event' and id = $1`, [id]);
    },

    /**
     * One calendar event by its external (Graph) id.
     * @returns {Promise<object|null>}  as eventsBetween
     */
    async eventByExternalId(externalId) {
      return db.one(`select ${EVENT_COLS} from source_item where source = 'graph_event' and external_id = $1`, [externalId]);
    },

    /**
     * The `sync_cursor.state` of a connector, or null.
     * @param {string} source  e.g. 'm365', 'github'
     * @returns {Promise<{state: object}|null>}
     */
    async cursorState(source) {
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
    async prsByAuthorBetween(author, from, to, agentPattern) {
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
    async jiraAssignedBetween(from, to, assignees) {
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
    async claudeSessionsBetween(from, to) {
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
    async openJiraAssigned(assignees, limit) {
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
    async openPrsRecent(author, now, agentPattern) {
      return db.rows(
        `select id, subject, raw, body_text ~* $3 as agent from source_item
        where source = 'github_pr' and author_identity = $1 and raw->>'state' = 'opened'
          and occurred_at > $2::timestamptz - interval '14 days'
        order by occurred_at desc limit 5`,
        [author, now, agentPattern]
      );
    },

    /** A GitHub author's open PRs that carry a label matching %block% (3). */
    async blockedPrs(author) {
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
    async threadsFromAddress(email, now) {
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
    async threadsFromIdentities(identities, now) {
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
    async chatsAround(startIso, endIso) {
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
    async openPrsByAuthor(author) {
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
    async calendarBefore(now) {
      return db.rows(
        `select external_id, subject, occurred_at, raw from source_item
      where source = 'graph_event' and occurred_at between $1::timestamptz - interval '12 hours' and $1::timestamptz`,
        [now]
      );
    },

    // --- for ledger/reconcile.js

    /** These items' {id, source, author_identity, occurred_at, subject, body_text, raw}, in no order. */
    async itemsByIds(ids) {
      return db.rows(
        `select id, source, author_identity, occurred_at, subject, body_text, raw from source_item where id = any($1::bigint[])`,
        [ids]
      );
    },

    // --- for src/commitments/request.js, src/projects/index.js

    /** An item's subject and body, or null. @returns {Promise<{subject, body_text}|null>} */
    async subjectAndBody(id) {
      return db.one('select subject, body_text from source_item where id = $1', [id]);
    },

    // --- for src/backup.js

    /**
     * Rewinds the date-based sync cursors (those with a `since`) of `sources`
     * (all when empty) to `since`, dropping their delta tokens, so the next
     * pass fetches again from there. Resolves the sources rewound.
     */
    async rewindCursors(since, sources) {
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
    async cursorRow(source) {
      return db.one('select last_run_at, last_error, state from sync_cursor where source = $1', [source]);
    },

    /** One Claude session item by id, or null (another source's id is null too). */
    async claudeSessionItem(id) {
      return db.one(
        `select id, source, external_id, subject, occurred_at, raw from source_item where id = $1 and source = 'claude_session'`,
        [id]
      );
    },

    /** The newest twelve items of a thread, newest first (body cut to 600 chars). */
    async threadItems(threadExternalId) {
      return db.rows(
        `select id, author_identity, occurred_at, left(body_text, 600) as body from source_item
          where thread_external_id = $1 order by occurred_at desc limit 12`,
        [threadExternalId]
      );
    },
  };
}

const EVENT_COLS = 'id, external_id, subject, body_text, occurred_at, author_identity, raw';

module.exports = { create };