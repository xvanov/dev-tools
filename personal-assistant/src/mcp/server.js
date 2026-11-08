'use strict';

// The MCP server's entry, kept at this path: Claude Code registrations
// (integrations/claude-code/README.md) and the chat's own spawn
// (src/chat/agent.js, src/chat/index.js) run `node src/mcp/server.js`. The server
// itself is server.ts (plan 4.1, docs/native/JARVISD.md).
const server = require('./server.ts');

module.exports = server;

if (require.main === module) server.run();
