'use strict';

// SQLite twin of src/repo/sources.js (source_item, sync_cursor).
// Differences from Postgres: the "agent" flag (pg `body_text ~* pattern`) is
// computed in JS with a case-insensitive JS RegExp of the same pattern; ilike
// is LIKE (ASCII case-insensitive here); window bounds are computed in JS.

const { HOUR, DAY, sinceMs } = require('./_sql');

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
  };
}

module.exports = { create };
