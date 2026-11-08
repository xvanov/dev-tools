'use strict';

// Pick the transcript reader for a session kind (Claude Code vs Cursor agent).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const claude = require('./claudeTranscript.ts');
const cursor = require('./cursorTranscript.ts');

function forKind(kind: any) {
  return kind === 'cursor' ? cursor : claude;
}

module.exports = { forKind };
