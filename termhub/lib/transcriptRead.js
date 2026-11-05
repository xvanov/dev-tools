'use strict';

// Pick the transcript reader for a session kind (Claude Code vs Cursor agent).

const claude = require('./claudeTranscript');
const cursor = require('./cursorTranscript');

function forKind(kind) {
  return kind === 'cursor' ? cursor : claude;
}

module.exports = { forKind };
