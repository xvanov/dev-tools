#!/usr/bin/env node
'use strict';

// The SDK chat's Run view (plan 4.2): a read-only termhub session that shows
// the conversation as it happens, like E2's `pretty --follow` does for an API
// run. src/chat/sdkFeed.js appends every chat event it keeps (user, assistant,
// activity, permission, status; never the streamed partials) to
// pa-home/sdk-view/chat.jsonl; this follows that file:
//
//   node src/chat/sdkView.js --follow <chat.jsonl>
//
// It renders the last part of the file, then what is appended, and never
// exits on its own (the chat is long-lived). Typing into the session does
// nothing: stdin is not read. Every line is handled in a try/catch.

const fs = require('fs');

const TAIL_BYTES = 256 * 1024;
const POLL_MS = 300;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function clock(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
}

// Terminal control characters in quoted text would drive the terminal.
const clean = (s) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, '');

/** Pure. The lines for one chat event (null: nothing to show). Never throws. */
function renderEvent(e, { color = true } = {}) {
  try {
    if (!e || typeof e !== 'object') return null;
    const c = color ? C : Object.fromEntries(Object.keys(C).map((k) => [k, (s) => s]));
    const t = c.dim(clock(e.at));
    switch (e.type) {
      case 'user': {
        const via = e.source === 'voice' ? ' (spoken)' : e.source === 'typed' ? '' : ' (doorbell)';
        return `\n${t} ${c.bold(c.cyan(`you${via}`))}\n${clean(e.text)}`;
      }
      case 'assistant':
        if (e.partial) return null;
        return `${t} ${c.bold('Jarvis')}${e.final === false ? c.dim(' (step)') : ''}\n${clean(e.text)}`;
      case 'activity':
        return c.dim(`${t}   · ${clean(e.text)}`);
      case 'permission':
        if (e.cleared) {
          if (e.answered === 'yes') return c.green(`${t}   ✓ approved`);
          if (e.answered === 'no') return c.red(`${t}   ✗ denied`);
          return null;
        }
        return c.yellow(`${t}   ? waiting for your yes: ${clean(e.ask || e.text)}${e.detail ? `\n${clean(e.detail).replace(/^/gm, '     ')}` : ''}`);
      case 'status':
        return e.text === 'idle' ? c.dim(`${t} ─ idle`) : e.text === 'offline' ? c.dim(`${t} ─ session closed`) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Pure. Renders complete lines of `chunk` (plus a carried partial line); returns {out, rest}. */
function renderChunk(rest, chunk, opts) {
  const lines = (rest + chunk).split('\n');
  const tail = lines.pop();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const r = renderEvent(e, opts);
    if (r) out.push(r);
  }
  return { out, rest: tail };
}

function follow(file, write = (s) => process.stdout.write(s)) {
  let offset = 0;
  let rest = '';
  let first = true;
  write(`${C.bold('PA chat (Agent SDK)')} ${C.dim('read-only: talk to it on Ask or the dashboard')}\n`);
  const tick = () => {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    if (st.size < offset) {
      offset = 0; // rotated
      rest = '';
    }
    if (first && st.size > TAIL_BYTES) offset = st.size - TAIL_BYTES;
    if (st.size === offset) {
      first = false;
      return;
    }
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      let text = buf.toString('utf8');
      if (first && offset > 0) text = text.slice(text.indexOf('\n') + 1);
      offset = st.size;
      const r = renderChunk(rest, text);
      rest = r.rest;
      for (const s of r.out) write(`${s}\n`);
    } catch {
      /* next tick */
    }
    first = false;
  };
  tick();
  return setInterval(tick, POLL_MS);
}

if (require.main === module) {
  const i = process.argv.indexOf('--follow');
  const file = i >= 0 ? process.argv[i + 1] : null;
  if (!file) {
    process.stderr.write('usage: node sdkView.js --follow <chat.jsonl>\n');
    process.exit(2);
  }
  follow(file);
}

module.exports = { renderEvent, renderChunk, follow };
