// Types shared across the PA's TypeScript modules (plan 4.1). Types only: no
// module requires this file at run time. Each one names what it needs with a
// type query, `type Config = import('./types.ts').Config;`, which erases to
// nothing, so the modules stay CommonJS (docs/native/JARVISD.md).

/**
 * config.ts's `config` object. Loose until config.ts switches to ES exports:
 * a CommonJS module's exports cannot be named in a type, so its shape is not
 * visible to callers yet.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Config = Record<string, any>;

/**
 * A JSON value read or built key by key: model output, a JS module's result,
 * a report bag. Loose on purpose, and documented where used; tighten it as the
 * producer becomes TypeScript with ES exports.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

/** An Error with the fields Node and the PA put on errors. */
export type ErrorWithCode = Error & { code?: string; status?: number };
