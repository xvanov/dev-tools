#!/usr/bin/env node
'use strict';

// The terminal-engine PA chat's PreToolUse hook (PA_CHAT_ENGINE=terminal,
// D33): pa-home/.claude/settings.json runs `node src/chat/toolHook.js` before
// every built-in Bash/Read/Grep/Glob call. It asks the same policy, audited,
// and answers with the same toolGate decision as the SDK engine's in-process
// hook (src/chat/sdkFeed.ts), so a read-only command or a read inside the read
// roots runs unasked in both engines. No opinion (no output) leaves it to
// Claude Code's settings, i.e. a prompt.
//
// The SDK engine loads the same settings.json; there its own hook already
// decided, so this one exits at once (CLAUDE_AGENT_SDK_CLIENT_APP).

const SDK_APP = 'personal-assistant/pa-chat';

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

async function main() {
  if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP === SDK_APP) return null;
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    return null;
  }
  const name = String(input.tool_name || '');
  const args = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const G = require('./toolGate.ts');
  const home = require('./index.ts').homeDir();
  let res = null;
  try {
    // Audited like the SDK hook's built-in calls; a slow store must not hold the call (the row is still
    // written before the process exits: see pendingAudit).
    const authorize = require('../policy').authorize({ tool: name, action: 'call', channel: 'chat', actor: 'pa-chat', args });
    pendingAudit = authorize.catch(() => {});
    res = await Promise.race([authorize, new Promise((r) => setTimeout(() => r(require('../policy').evaluate({ tool: name, action: 'call', channel: 'chat', args })), 4000))]);
  } catch {
    return null;
  }
  const cwd = input.cwd || home;
  const d = G.gate(name, args, res, { roots: G.readRoots(home), cwd, dataDir: require('../config.ts').config.dataDir });
  if (!d) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason, ...(d.updatedInput ? { updatedInput: d.updatedInput } : {}) } };
}

// The audit write main() started; the process waits for it (up to the hook's budget) before it exits.
let pendingAudit = Promise.resolve();
const AUDIT_GRACE_MS = 4000;

module.exports = { main, SDK_APP };

if (require.main === module) {
  main()
    .then((out) => {
      if (out) process.stdout.write(JSON.stringify(out));
    })
    .catch(() => {})
    .then(() => Promise.race([pendingAudit, new Promise((r) => setTimeout(r, AUDIT_GRACE_MS).unref())]))
    .finally(() => process.exit(0));
}
