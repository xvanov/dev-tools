'use strict';

// Typing into a session over plain HTTP.
//
// The UI streams over `/ws/term/:id` because it needs the output too, and that
// stays the right shape for a terminal. But "send one line to a session" is a
// different act — a script nudging a stuck agent, another tool on the tailnet
// handing work over — and making each of those speak the PTY stream protocol
// just to write one frame is a lot of ceremony for a keystroke.
//
// Split out of `sessiond.js` so the contract can be tested without a PTY: what
// matters here is *what gets written*, and the PTY host has nothing to say about
// that.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

/**
 * @param {{write: (data: string) => void} | undefined} session
 * @param {{data?: unknown, submit?: unknown}} body
 * @returns {{status: number, payload: object}}
 */
function applyInput(session: any, body: any) {
  if (!session) return { status: 404, payload: { error: 'no such session' } };

  // Not coerced. `String(undefined)` types the literal word "undefined" at an
  // agent, which is both wrong and very hard to notice afterwards.
  if (typeof body?.data !== 'string') {
    return { status: 400, payload: { error: 'data must be a string' } };
  }

  session.write(body.data);

  // Return is pressed unless the caller says otherwise: the common case is
  // "send this line". `submit: false` stages text in the prompt without sending
  // it, which is what you want when the words were written by a model and a
  // human should read them first.
  if (body.submit !== false) session.write('\r');

  return { status: 200, payload: { ok: true, bytes: Buffer.byteLength(body.data) } };
}

module.exports = { applyInput };
