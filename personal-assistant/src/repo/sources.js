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
  };
}

module.exports = { create };
