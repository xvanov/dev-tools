'use strict';

// A local OpenTelemetry SpanExporter: finished spans go into the PA's own
// database (repo.telemetry.recordSpans), not to a collector. Best effort by
// contract: a store that cannot be reached costs the spans, never the caller.

// OpenTelemetry's ExportResultCode (a transitive dependency; the values are the API).
const ExportResultCode = { SUCCESS: 0, FAILED: 1 };

const HOP_ATTR = 'pa.hop';
const SOURCE_ATTR = 'pa.source';
// OpenTelemetry's SpanStatusCode.ERROR.
const STATUS_ERROR = 2;
// Attribute values stay small and scalar: ids, counts, states.
const MAX_ATTR_CHARS = 200;

const ms = (t) => t[0] * 1000 + t[1] / 1e6;

/** A ReadableSpan as the row recordSpans takes. */
function toRow(span) {
  const attrs = {};
  for (const [k, v] of Object.entries(span.attributes || {})) {
    if (k === HOP_ATTR || k === SOURCE_ATTR) continue;
    if (typeof v === 'string') attrs[k] = v.slice(0, MAX_ATTR_CHARS);
    else if (typeof v === 'number' || typeof v === 'boolean') attrs[k] = v;
  }
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanId || null,
    hop: String(span.attributes?.[HOP_ATTR] || span.name).slice(0, 64),
    name: String(span.name).slice(0, 128),
    source: String(span.attributes?.[SOURCE_ATTR] || 'pa'),
    startedAt: new Date(ms(span.startTime)),
    durationMs: ms(span.duration),
    ok: span.status?.code !== STATUS_ERROR,
    attrs: Object.keys(attrs).length ? attrs : null,
  };
}

class LocalSpanExporter {
  /** @param {{record?: (rows: object[]) => Promise<unknown>, onError?: (err: Error) => void}} [o] */
  constructor({ record, onError } = {}) {
    this.record = record || ((rows) => require('../repo').telemetry.recordSpans(rows));
    this.onError = onError || (() => {});
  }

  export(spans, resultCallback) {
    Promise.resolve()
      .then(() => this.record(spans.map(toRow)))
      .then(
        () => resultCallback({ code: ExportResultCode.SUCCESS }),
        (err) => {
          this.onError(err);
          resultCallback({ code: ExportResultCode.FAILED, error: err });
        }
      );
  }

  shutdown() {
    return Promise.resolve();
  }
}

module.exports = { LocalSpanExporter, toRow, HOP_ATTR, SOURCE_ATTR };
