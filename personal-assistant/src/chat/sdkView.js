#!/usr/bin/env node
'use strict';

// The SDK chat's Run view entry, kept at this path: src/chat/sdkFeed spawns
// `node src/chat/sdkView.js --follow <chat.jsonl>` in a termhub session. The
// view itself is sdkView.ts (plan 4.1).
const view = require('./sdkView.ts');

module.exports = view;

if (require.main === module) view.cli();
