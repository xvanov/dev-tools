'use strict';

// What a session belongs to: the ids that tie a terminal to the work it runs.
//
// The personal assistant and the software factory start sessions for a card, a
// PA run, a factory job and one step of it. Until these were stored, the only
// way back from a terminal to its job was reading the title (`pa#12 factory · …`),
// which a rename breaks. Callers send `links` on `POST /api/sessions` (and may
// add to them with `PATCH /api/sessions/:id`); termhub keeps them with the
// session (and its archive entry, so a restore keeps them), returns them from
// `GET /api/sessions`, and the Run view renders them as links.
//
// The contract is deliberately forgiving: links are metadata, so a key this
// build does not know, or a value that is not a plain id, is dropped and the
// session still starts. An older termhub ignores the field entirely, which is
// what keeps old and new callers compatible both ways. `features` in
// /api/info carries `session-links` for a caller that wants to know.
//
//   card      the PA commitment id (Plan)
//   run       the PA run id
//   job       the factory job id (`<app>:<direction>`, Build)
//   step      the factory's run row id for one agent step
//   story     the factory story id
//   external  the job's external id (`<pa install>-<run id>`)
//   pr        a PR number, or its http(s) URL
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const KEYS = ['card', 'run', 'job', 'step', 'story', 'external', 'pr'];
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const URL_RE = /^https?:\/\/[^\s"'<>]{1,400}$/;

function cleanValue(key: any, v: any) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (key === 'pr' && URL_RE.test(s)) return s;
  return ID.test(s) ? s : null;
}

/**
 * Pure. The `links` of a request body, cleaned: known keys with id-shaped
 * values only. `null` when there is nothing to keep (or nothing was sent).
 * @param {unknown} raw
 * @returns {Record<string,string>|null}
 */
function parseLinks(raw: any) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Json = {};
  for (const k of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    const v = cleanValue(k, raw[k]);
    if (v !== null) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Pure. `next` laid over `prev` (a PATCH adds or replaces keys; a key sent as
 * null removes it). `null` when nothing is left.
 */
function mergeLinks(prev: any, raw: any) {
  const out = { ...(prev || {}) };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      if (raw[k] === null) { delete out[k]; continue; }
      const v = cleanValue(k, raw[k]);
      if (v !== null) out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { KEYS, parseLinks, mergeLinks };
