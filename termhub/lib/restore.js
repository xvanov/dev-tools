'use strict';

// Builds the command that brings an archived agent session back to life.
//
// Split out of sessiond.js because getting this string wrong is silent and
// total: the restored terminal spawns, the CLI prints one line of usage error,
// exits, and the user is left staring at a bare shell where their conversation
// should be. That exact failure shipped — see stripClaudeSessionFlags below —
// so these builders are unit-tested (test/restore.test.js) rather than trusted.

// Nothing here touches a PTY — it is all string surgery on command lines, kept
// free of the node-pty require chain so the tests are a plain `node` run.

// Insert flags right after the claude executable token (the same position
// classifyCommand's own regex matches), so they land before any trailing prompt
// argument rather than tacked onto the end of the string. Used both at launch
// (--session-id) and on restore (--resume).
function injectAfterClaudeExe(command, flags) {
  return String(command).replace(
    /(^|[\\/\s"'])(claude(?:\.exe|\.cmd)?)(?=$|[\s"'])/i,
    (m, pre, exe) => `${pre}${exe} ${flags}`
  );
}

// Flags that pin a Claude conversation's identity, with the value forms the CLI
// accepts (`--flag v`, `--flag=v`) and, for --resume/-r, the fact that the value
// is optional. Anchored on a leading space so `-r` can't match inside a word.
const SESSION_ID_FLAG = /\s--session-id[=\s]+\S+/gi;
const RESUME_FLAG = /\s(?:--resume|-r)(?:[=\s]+[0-9a-fA-F-]{36})?(?=\s|$)/g;
const CONTINUE_FLAG = /\s(?:--continue|-c)(?=\s|$)/g;
const FORK_FLAG = /\s--fork-session(?=\s|$)/gi;

// Remove every conversation-identity flag from a claude command line, so the
// caller can add exactly one and know it's the only one there.
//
// This is the fix for the bug that made restore never work on an up-to-date CLI.
// termhub splices `--session-id <uuid>` into the command it launches (so it can
// find the transcript), and that mutated string is what lands in the archive.
// Restore then appended `--resume <uuid>` to it, producing
//
//   claude --session-id X --dangerously-skip-permissions --resume X
//
// which Claude Code rejects outright: "--session-id can only be used with
// --continue or --resume if --fork-session is also specified." Adding
// --fork-session would satisfy the parser but is the wrong answer — forking
// starts a NEW conversation id, which both duplicates the transcript and
// detaches it from the id termhub tracks. Dropping --session-id and resuming by
// id is right: `claude --resume <id>` (unforked) continues that same id and
// keeps writing to the same `<id>.jsonl`, so the model badge and the voice
// watcher keep resolving the session (verified against CLI 2.1.220).
function stripClaudeSessionFlags(command) {
  const s = String(command);
  const { start, end } = claudeArgRange(s);
  const stripped = s.slice(start, end)
    .replace(SESSION_ID_FLAG, '')
    .replace(FORK_FLAG, '')
    .replace(RESUME_FLAG, '')
    .replace(CONTINUE_FLAG, '');
  return (s.slice(0, start) + stripped + s.slice(end)).replace(/\s{2,}/g, ' ').trim();
}

// The span of a command line that belongs to `claude` itself: from just after
// the executable token to the next shell operator (or the end). Stripping is
// confined to it because `-c` and `-r` are single letters that mean something
// else to other programs — `claude … && grep -c foo` must keep its `-c`, and a
// blanket regex over the whole string silently ate it. Falls back to the whole
// string when there's no claude token (a caller that already knows better).
function claudeArgRange(s) {
  const exe = /(^|[\\/\s"'])claude(?:\.exe|\.cmd)?(?=$|[\s"'])/i.exec(s);
  if (!exe) return { start: 0, end: s.length };
  const start = exe.index + exe[0].length;
  const op = /\s(?:&&|\|\||;|\|)(?=\s|$)/.exec(s.slice(start));
  return { start, end: op ? start + op.index : s.length };
}

// Keep whatever the session was started with, but ensure it resumes a prior
// conversation and stays non-interactive on permissions. When we tracked the
// original conversation's real UUID (see lib/session.js), resume that exact one;
// otherwise fall back to a bare `--resume`, which makes Claude show its resume
// picker scoped to the cwd — the most we can target without knowing the id.
function restoreClaudeCommand(command, agentSessionId) {
  let cmd = (command && String(command).trim()) || 'claude';
  if (agentSessionId) {
    // Strip first, then inject after the executable rather than appending: a
    // command can end in a positional prompt (`claude "fix the build"`), and a
    // flag tacked on after it is at best confusing to read back in the sidebar.
    cmd = injectAfterClaudeExe(stripClaudeSessionFlags(cmd), `--resume ${agentSessionId}`);
  } else if (!/(^|\s)(--resume|-r|--continue|-c)(\s|=|$)/.test(cmd)) {
    cmd = injectAfterClaudeExe(cmd, '--resume');
  }
  if (!/--dangerously-skip-permissions\b/.test(cmd)) cmd += ' --dangerously-skip-permissions';
  return cmd;
}

// Same idea for opencode: resume the exact tracked session with `--session
// <id>` when we discovered it (see lib/opencodeModel.js); otherwise fall back
// to `--continue` (opencode's closest equivalent — there's no interactive
// picker like Claude's bare `--resume` to fall back to).
function restoreOpencodeCommand(command, agentSessionId) {
  let cmd = (command && String(command).trim()) || 'opencode';
  // A restored session gets a fresh --port (the old one belonged to a TUI that
  // is gone, and re-using it would either fail to bind or, worse, adopt whatever
  // took it over). lib/session.js splices the new one in; strip the stale pair
  // here so there is only ever one.
  cmd = stripOpencodeServerFlags(cmd);
  if (agentSessionId) {
    if (!/(^|\s)(--session|-s)(\s|=|$)/.test(cmd)) cmd += ` --session ${agentSessionId}`;
  } else if (!/(^|\s)(--continue|-c|--session|-s)(\s|=|$)/.test(cmd)) {
    cmd += ' --continue';
  }
  return cmd;
}

// Remove `--port <n>` / `--hostname <h>` (and their `=` forms) from an opencode
// command line. Confined to the opencode segment for the same reason
// stripClaudeSessionFlags is: a `--port` belonging to some other command in a
// compound line is none of our business.
function stripOpencodeServerFlags(command) {
  const s = String(command || '');
  const cut = s.search(/\s*(\|\||&&|;|\|)/);
  const head = cut === -1 ? s : s.slice(0, cut);
  const tail = cut === -1 ? '' : s.slice(cut);
  const cleaned = head
    .replace(/(^|\s)--port(=|\s+)\S+/gi, '$1')
    .replace(/(^|\s)--hostname(=|\s+)\S+/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned + tail;
}

// Splice flags in right after the `opencode` executable token — the twin of
// injectAfterClaudeExe above. Appending them instead would land them after a
// `&&` in a compound command, i.e. on the wrong program entirely.
function injectAfterOpencodeExe(command, flags) {
  return String(command).replace(
    /(^|[\\/\s"'])(opencode(?:\.exe|\.cmd)?)(?=$|[\s"'])/i,
    (m, pre, exe) => `${pre}${exe} ${flags}`
  );
}

module.exports = {
  restoreClaudeCommand, restoreOpencodeCommand, stripClaudeSessionFlags, injectAfterClaudeExe,
  stripOpencodeServerFlags, injectAfterOpencodeExe,
};
