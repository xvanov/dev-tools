'use strict';

// Aggregate: telemetry. Table: trace_span (one row per finished span of a main
// hop: voice turn, tool call, factory hop, deploy). Callers: src/telemetry.
// Percentiles are computed by the caller over `hopDurations`, not in SQL, so
// the same method serves every backend.

/**
 * @typedef {object} SpanRow
 * @property {string} traceId
 * @property {string} spanId
 * @property {string|null} [parentSpanId]
 * @property {string} hop
 * @property {string} name
 * @property {string} [source]        'pa' | 'factory'
 * @property {Date|string} startedAt
 * @property {number} durationMs
 * @property {boolean} ok
 * @property {object|null} [attrs]
 */

const COLS = 10;

function create(db) {
  return {
    /** Inserts finished spans in one statement. @param {SpanRow[]} spans @returns {Promise<number>} rows written */
    async recordSpans(spans) {
      if (!spans?.length) return 0;
      const params = [];
      const tuples = spans.map((s, i) => {
        params.push(
          s.traceId,
          s.spanId,
          s.parentSpanId || null,
          s.hop,
          s.name,
          s.source || 'pa',
          s.startedAt,
          Math.max(0, Math.round(s.durationMs)),
          Boolean(s.ok),
          s.attrs ? JSON.stringify(s.attrs) : null
        );
        const o = i * COLS;
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}::jsonb)`;
      });
      await db.query(
        `insert into trace_span (trace_id, span_id, parent_span_id, hop, name, source, started_at, duration_ms, ok, attrs)
       values ${tuples.join(', ')}`,
        params
      );
      return spans.length;
    },

    /**
     * Each span at or after `since` as {hop, durationMs, ok}, newest first, at
     * most `limit` (the percentile window). @returns {Promise<Array<{hop: string, durationMs: number, ok: boolean}>>}
     */
    async hopDurations(since, limit = 20000) {
      const rows = await db.rows(
        `select hop, duration_ms::int as duration_ms, ok from trace_span
        where started_at >= $1 order by started_at desc limit $2`,
        [since, limit]
      );
      return rows.map((r) => ({ hop: r.hop, durationMs: Number(r.duration_ms), ok: Boolean(r.ok) }));
    },

    /** Deletes spans that started before `before`. @returns {Promise<number>} rows deleted */
    async pruneSpans(before) {
      const r = await db.query(`delete from trace_span where started_at < $1`, [before]);
      return r.rowCount ?? 0;
    },
  };
}

module.exports = { create };
