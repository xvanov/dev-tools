'use strict';

// Per-session environment changes: `POST /api/sessions {env?, unsetEnv?}`.
//
// A session normally inherits termhub's own environment. The personal
// assistant starts a dispatched run that may not push WITHOUT push
// credentials (no GH_TOKEN, no SSH agent, git's credential helpers reset), so
// a session can set and remove variables on top of that. This adds no
// capability: whoever can create a session can already type `export` into it.
// It is here so the change is made before the shell starts — and reported
// back (`envApplied: true`), so the caller can refuse a termhub that ignored
// it instead of trusting it.
//
// The spec survives a restore (it is in the archive entry): a no-push run
// restored after a reboot must not come back with the credentials.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VARS = 64;
const MAX_VALUE = 4096;

/**
 * Pure. Validates the request's `env`/`unsetEnv`. Returns { spec } (spec is
 * null when neither was given) or { error }.
 */
function parseEnvSpec(body: any) {
  const env = body ? body.env : undefined;
  const unset = body ? body.unsetEnv : undefined;
  if (env == null && unset == null) return { spec: null };
  const spec: { env: Record<string, string>; unset: string[] } = { env: {}, unset: [] };
  if (env != null) {
    if (typeof env !== 'object' || Array.isArray(env)) return { error: 'env must be an object of strings' };
    const keys = Object.keys(env);
    if (keys.length > MAX_VARS) return { error: `env: at most ${MAX_VARS} variables` };
    for (const k of keys) {
      if (!NAME.test(k)) return { error: `env: bad variable name "${k.slice(0, 64)}"` };
      if (typeof env[k] !== 'string' || env[k].length > MAX_VALUE || env[k].includes('\0')) return { error: `env: ${k} must be a string` };
      spec.env[k] = env[k];
    }
  }
  if (unset != null) {
    if (!Array.isArray(unset) || unset.length > MAX_VARS) return { error: `unsetEnv must be an array of at most ${MAX_VARS} names` };
    for (const k of unset) {
      if (typeof k !== 'string' || !NAME.test(k)) return { error: `unsetEnv: bad variable name "${String(k).slice(0, 64)}"` };
      spec.unset.push(k);
    }
  }
  return { spec };
}

/**
 * Pure. `base` with `spec` applied: removals first (case-insensitively on
 * Windows, where GH_TOKEN and gh_token are one variable), then sets.
 */
function applyEnvSpec(base: any, spec: any, platform: any = process.platform) {
  const out = { ...base };
  if (!spec) return out;
  const fold = platform === 'win32';
  for (const name of [...(spec.unset || []), ...Object.keys(spec.env || {})]) {
    for (const k of Object.keys(out)) {
      if (k === name || (fold && k.toUpperCase() === name.toUpperCase())) delete out[k];
    }
  }
  for (const [k, v] of Object.entries(spec.env || {})) out[k] = v;
  return out;
}

module.exports = { parseEnvSpec, applyEnvSpec };
