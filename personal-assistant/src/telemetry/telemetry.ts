'use strict';

// OpenTelemetry for the PA (plan 7.5): the instrument side. Code wraps a hop in
//
//   await telemetry.span('tool.call', name, { tool: name }, async (span) => { ... });
//
// and gets a trace span written to the local `trace_span` table (src/repo/
// telemetry.js) by a local exporter: no collector, no cloud. `hop` is the bounded
// vocabulary Meter groups by (voice.turn, tool.call, factory.submit, deploy,
// ...); `name` is the specific thing.
//
// Instruments go through @opentelemetry/api, so they are no-ops until a provider
// is installed. The first span() installs one for the process (async-local
// context, so a span opened inside another becomes its child; a batch processor
// that flushes every few seconds and at exit). It is never installed in a test
// process (PA_TESTING, or started as `node ...test.js`) or with PA_TELEMETRY=0:
// then span() just runs the function. A test that wants it calls install() with
// its own exporter.
//
// Best effort by contract: nothing here throws into a caller, and a store that
// cannot take the spans loses them (one warning). No prompt, reply or argument
// text goes in an attribute; callers pass ids, names, counts.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Attrs = Record<string, string | number | boolean>;
interface SpanHandle {
  setStatus(s: { code: number; message?: string }): unknown;
  end(): unknown;
}
interface Provider {
  forceFlush(): Promise<unknown>;
  shutdown(): Promise<unknown>;
}
type SpanFn = (s: SpanHandle | null) => any;

const { trace, context, SpanStatusCode } = require('@opentelemetry/api');
const { config } = require('../config.ts');
const { logger } = require('../log.ts');
const { HOP_ATTR, SOURCE_ATTR } = require('./exporter.ts');

const log = logger('telemetry');
const TRACER = 'personal-assistant';

let provider: Provider | null = null;
let installedFor: 'default' | 'custom' | null = null; // 'default' | 'custom'
let warned = false;

function isTestProcess() {
  return Boolean(process.env.PA_TESTING) || /\.test\.js$/i.test(process.argv[1] || '');
}

function off() {
  return !config.telemetry.enabled || isTestProcess();
}

/**
 * Installs the provider for this process. `exporter` defaults to the local one;
 * `{ simple: true }` exports each span as it ends (tests). Returns false when
 * one is already installed. @returns {boolean}
 */
function install({ exporter = null, simple = false }: { exporter?: object | null; simple?: boolean } = {}) {
  if (provider) return false;
  const { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
  const { LocalSpanExporter } = require('./exporter.ts');
  const exp =
    exporter ||
    new LocalSpanExporter({
      onError: (err: unknown) => {
        if (warned) return;
        warned = true;
        log.warn('trace spans not recorded — is the store migrated?', { message: (err as Error).message });
      },
    });
  const processor = simple
    ? new SimpleSpanProcessor(exp)
    : new BatchSpanProcessor(exp, { scheduledDelayMillis: 5000, maxExportBatchSize: 256, maxQueueSize: 2048 });
  provider = new BasicTracerProvider({ spanProcessors: [processor] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  installedFor = exporter ? 'custom' : 'default';
  if (!simple) process.once('beforeExit', () => void flush());
  return true;
}

/** Writes any spans still queued (a short-lived process calls this before it exits). */
async function flush() {
  try {
    await provider?.forceFlush();
  } catch {
    /* best effort */
  }
}

/** Uninstalls the provider (tests). */
async function reset() {
  const p = provider;
  provider = null;
  installedFor = null;
  warned = false;
  trace.disable();
  context.disable();
  try {
    await p?.shutdown();
  } catch {
    /* nothing to do */
  }
}

function installed() {
  return installedFor;
}

/**
 * Runs `fn(span)` inside a span of `hop`/`name` and ends it: ok when `fn`
 * returns or resolves, error (and the error rethrown) when it throws or rejects.
 * `attrs` are small scalars. With telemetry off, runs `fn(null)`.
 */
function span(hop: string, name: string, attrs?: Attrs | SpanFn | null, fn?: SpanFn): any {
  if (typeof attrs === 'function') {
    fn = attrs;
    attrs = {};
  }
  if (!provider && !off()) {
    try {
      install();
    } catch (err) {
      log.warn('telemetry could not start', { message: (err as Error).message });
    }
  }
  if (!fn) return undefined;
  const run: SpanFn = fn;
  if (!provider) return run(null);
  const tracer = trace.getTracer(TRACER);
  return tracer.startActiveSpan(String(name || hop), { attributes: { ...clean(attrs), [HOP_ATTR]: hop } }, (s: SpanHandle) => {
    const end = (err?: unknown) => {
      try {
        if (err) s.setStatus({ code: SpanStatusCode.ERROR, message: String((err as Error).message || err).slice(0, 120) });
        s.end();
      } catch {
        /* a span must never break its caller */
      }
    };
    let out: any;
    try {
      out = run(s);
    } catch (err) {
      end(err);
      throw err;
    }
    if (out && typeof out.then === 'function') {
      return out.then(
        (v: unknown) => {
          end();
          return v;
        },
        (err: unknown) => {
          end(err);
          throw err;
        }
      );
    }
    end();
    return out;
  });
}

function clean(attrs: unknown) {
  const out: Attrs = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Marks the current span failed without throwing (a hop that reports `ok: false`). */
function fail(s: SpanHandle | null | undefined, message: string) {
  try {
    s?.setStatus({ code: SpanStatusCode.ERROR, message: String(message || '').slice(0, 120) });
  } catch {
    /* ignore */
  }
}

/**
 * Records spans another process measured (the factory's, from POST
 * /api/telemetry). `spans` are rows as repo.telemetry.recordSpans takes them,
 * validated here. @returns {Promise<number>} rows written
 */
async function ingest(spans: unknown) {
  const rows: Record<string, unknown>[] = [];
  for (const s of (Array.isArray(spans) ? spans.slice(0, 500) : []) as Record<string, any>[]) {
    const durationMs = Number(s?.durationMs);
    const startedAt = new Date(s?.startedAt);
    if (typeof s?.hop !== 'string' || !s.hop || !Number.isFinite(durationMs) || Number.isNaN(startedAt.getTime())) continue;
    const attrs: Attrs = {};
    for (const [k, v] of Object.entries(s.attrs && typeof s.attrs === 'object' ? s.attrs : {})) {
      if (typeof v === 'string') attrs[String(k).slice(0, 64)] = v.slice(0, 200);
      else if (typeof v === 'number' || typeof v === 'boolean') attrs[String(k).slice(0, 64)] = v;
    }
    rows.push({
      traceId: String(s.traceId || '').slice(0, 32) || '0'.repeat(32),
      spanId: String(s.spanId || '').slice(0, 16) || '0'.repeat(16),
      parentSpanId: s.parentSpanId ? String(s.parentSpanId).slice(0, 16) : null,
      hop: s.hop.slice(0, 64),
      name: String(s.name || s.hop).slice(0, 128),
      source: s.source === 'pa' ? 'pa' : 'factory',
      startedAt,
      durationMs: Math.max(0, durationMs),
      ok: s.ok !== false,
      attrs: Object.keys(attrs).length ? attrs : null,
    });
  }
  if (!rows.length) return 0;
  return require('../repo').telemetry.recordSpans(rows);
}

module.exports = { span, fail, install, flush, reset, installed, ingest, isTestProcess };
