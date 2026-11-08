'use strict';

// SQLite twin of src/repo/telemetry.js (trace_span).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const COLS = 10;

function create(db: Db) {
  return {
    /** Inserts finished spans in one statement; resolves the number written. */
    async recordSpans(spans: Row[] | null | undefined) {
      if (!spans?.length) return 0;
      const params: unknown[] = [];
      const tuples = spans.map((s, i) => {
        params.push(
          s.traceId,
          s.spanId,
          s.parentSpanId || null,
          s.hop,
          s.name,
          s.source || 'pa',
          s.startedAt,
          Math.max(0, Math.round(Number(s.durationMs))),
          Boolean(s.ok),
          s.attrs ? JSON.stringify(s.attrs) : null
        );
        const o = i * COLS;
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10})`;
      });
      await db.query(
        `insert into trace_span (trace_id, span_id, parent_span_id, hop, name, source, started_at, duration_ms, ok, attrs)
       values ${tuples.join(', ')}`,
        params
      );
      return spans.length;
    },

    /** Each span at or after `since` as {hop, durationMs, ok}, newest first, at most `limit`. */
    async hopDurations(since: Date | string | number, limit: number = 20000) {
      const rows = await db.rows(
        `select hop, duration_ms, ok from trace_span
        where started_at >= $1 order by started_at desc limit $2`,
        [since, limit]
      );
      return rows.map((r) => ({ hop: r.hop, durationMs: Number(r.duration_ms), ok: Boolean(r.ok) }));
    },

    /** Deletes spans that started before `before`; resolves how many. */
    async pruneSpans(before: Row) {
      const r = await db.query(`delete from trace_span where started_at < $1`, [before]);
      return r.rowCount ?? 0;
    },
  };
}

module.exports = { create };
