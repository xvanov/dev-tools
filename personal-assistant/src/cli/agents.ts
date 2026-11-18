'use strict';

// `pa profile` and `pa agents` — the dashboard's Agents page from a terminal (BUILD-ENRICHMENT.md B).
// Both go through src/agentSettings.ts, the same code the page's routes and the chat's profile_* and
// agent_settings_* tools call.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;

const fs = require('fs');

const HELP = `
  Agent settings (the dashboard's Agents page; chat tools profile_* and agent_settings_*)
    pa profile list [--json]               the Build profiles: model, effort, mode, caps; built-in and edited marks
    pa profile get <name> [--json]         one profile in full (prompt, tools, subagents, caps), and what a built-in ships as
    pa profile set <name> [fields]         create or change a profile; only the fields you give change
        --description "…"  --model haiku|sonnet|opus|fable  --effort low|medium|high|xhigh|max
        --permission-mode bypassPermissions|acceptEdits|auto|dontAsk|plan   (dontAsk: read-only)
        --prompt "…" | --prompt-file <file>   text appended to the base Build prompt ("" clears it)
        --mcp a,b   registered MCP servers (--no-mcp: none)   --allow "rule" --deny "rule"   (repeat; --no-allow / --no-deny clear)
        --subagents-file <file.json>   the whole subagent list (--no-subagents: none)   --subagent-model haiku|sonnet|opus|fable|inherit
        --cost-cap <usd>  --wall-cap <min>  --idle-after <s>  --repo <path>
        --no-<field> sets one back to the default (--no-model, --no-effort, --no-permission-mode, --no-cost-cap, --no-repo …)
    pa profile delete <name>               delete a profile
    pa profile reset <name>                a built-in profile (chore, feature, research, quick) back to what ships, or restore a deleted one
    pa agents get [--json]                 the PA chat's model and each worker pass's model: effective value and its source (store, env, default)
    pa agents set [--chat-model m] [--pass <pass>=<model>]… [--clear-chat-model] [--clear-pass <pass>]…
                                           a model is provider/model (azure/pa, local/llama3.2:3b, cli/claude-opus-5) or a bare Claude name
`;

const FIELDS: Array<[flag: string, key: string, kind: 'text' | 'num']> = [
  ['description', 'description', 'text'], ['model', 'model', 'text'], ['effort', 'effort', 'text'], ['permission-mode', 'permissionMode', 'text'],
  ['subagent-model', 'subagentModel', 'text'], ['cost-cap', 'costCapUsd', 'num'], ['wall-cap', 'wallCapMin', 'num'], ['idle-after', 'idleAfterS', 'num'],
  ['repo', 'repoPath', 'text'],
];

/**
 * Pure. `pa profile set` flags → the patch for agentSettings.setProfile, or { error }. A flag with a value sets the
 * field, `--no-<flag>` (parseArgs: false) clears it to the default, a flag with no value is an error.
 */
function profilePatch(flags: Json, lists: Json, readFile: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')): { patch: Json } | { error: string } {
  const patch: Json = {};
  for (const [flag, key, kind] of FIELDS) {
    const v = flags[flag];
    if (v === undefined) continue;
    if (v === false) patch[key] = null;
    else if (v === true) return { error: `--${flag} needs a value` };
    else if (kind === 'num') {
      const n = Number(v);
      if (!(n > 0)) return { error: `--${flag} must be a positive number` };
      patch[key] = n;
    } else patch[key] = String(v);
  }
  if (flags.prompt !== undefined && flags['prompt-file'] !== undefined) return { error: 'give --prompt or --prompt-file, not both' };
  if (flags.prompt !== undefined) {
    if (flags.prompt === true) return { error: '--prompt needs a value (use --no-prompt to clear it)' };
    patch.prompt = flags.prompt === false ? '' : String(flags.prompt);
  }
  if (typeof flags['prompt-file'] === 'string') {
    try { patch.prompt = readFile(flags['prompt-file']); } catch (e) { return { error: `--prompt-file: ${(e as Error).message}` }; }
  }
  const tools: Json = {};
  if (flags.mcp !== undefined) {
    if (flags.mcp === true) return { error: '--mcp needs a comma-separated list (use --no-mcp for none)' };
    tools.mcp = flags.mcp === false ? [] : String(flags.mcp).split(',').map((s) => s.trim()).filter(Boolean);
  }
  for (const k of ['allow', 'deny']) {
    if (flags[k] === undefined) continue;
    if (flags[k] === true) return { error: `--${k} needs a rule (use --no-${k} to clear them)` };
    tools[k] = flags[k] === false ? [] : (lists[k] || []).map(String);
  }
  if (Object.keys(tools).length) patch.tools = tools;
  if (flags['subagents-file'] !== undefined) {
    if (typeof flags['subagents-file'] !== 'string') return { error: '--subagents-file needs a path' };
    try { patch.subagents = JSON.parse(readFile(flags['subagents-file'])); } catch (e) { return { error: `--subagents-file: ${(e as Error).message}` }; }
  }
  if (flags.subagents === false) patch.subagents = [];
  if (!Object.keys(patch).length) return { error: 'nothing to set: give at least one field (pa help profile)' };
  return { patch };
}

/** Pure. `pa agents set` flags → the patch for agentSettings.setAgents, or { error }. */
function agentsPatch(flags: Json, lists: Json): { patch: Json } | { error: string } {
  const patch: Json = {};
  if (flags['chat-model'] !== undefined) {
    if (typeof flags['chat-model'] !== 'string') return { error: '--chat-model needs a model (--clear-chat-model puts it back to the default)' };
    patch.chatModel = flags['chat-model'];
  }
  if (flags['clear-chat-model'] !== undefined) {
    if (patch.chatModel !== undefined) return { error: 'give --chat-model or --clear-chat-model, not both' };
    patch.chatModel = null;
  }
  const passModels: Json = {};
  for (const entry of lists.pass || []) {
    const eq = String(entry).indexOf('=');
    if (eq < 1) return { error: `--pass ${entry}: want <pass>=<model>` };
    passModels[String(entry).slice(0, eq)] = String(entry).slice(eq + 1);
  }
  for (const k of lists['clear-pass'] || []) passModels[String(k)] = null;
  if (flags.pass === true || flags['clear-pass'] === true) return { error: '--pass wants <pass>=<model>, --clear-pass wants a pass name' };
  if (Object.keys(passModels).length) patch.passModels = passModels;
  if (!Object.keys(patch).length) return { error: 'nothing to set: give --chat-model, --pass <pass>=<model>, --clear-chat-model or --clear-pass <pass>' };
  return { patch };
}

function make(out: (t: string) => void, fail: (m: string) => void) {
  const A = () => require('../agentSettings.ts');
  const caps = (p: Json) => [p.costCapUsd != null ? `$${p.costCapUsd}` : null, p.wallCapMin != null ? `${p.wallCapMin} min` : null, p.idleAfterS != null ? `idle ${p.idleAfterS}s` : null].filter(Boolean).join(', ') || 'default caps';
  const marks = (p: Json) => [p.seed ? 'built in' : null, p.modified ? 'edited' : null].filter(Boolean).join(', ');

  function show(p: Json) {
    out(`${p.name}${marks(p) ? `  (${marks(p)})` : ''}`);
    if (p.description) out(`  ${p.description}`);
    out(`  model ${p.model || 'default'} · effort ${p.effort || 'default'} · permission mode ${p.permissionMode || 'default (bypass)'} · subagent model ${p.subagentModel || 'default'}`);
    out(`  caps: ${caps(p)}${p.repoPath ? ` · repo ${p.repoPath}` : ''}`);
    out(`  tools: mcp [${(p.tools.mcp || []).join(', ')}] · allow ${(p.tools.allow || []).length} · deny ${(p.tools.deny || []).length}`);
    for (const r of p.tools.allow || []) out(`    allow ${r}`);
    for (const r of p.tools.deny || []) out(`    deny  ${r}`);
    for (const s of p.subagents || []) out(`  subagent ${s.name} (${s.model || 'default model'}${s.tools?.length ? `; ${s.tools.join(', ')}` : ''}): ${s.description}`);
    if (p.prompt) out(`  prompt appended:\n${p.prompt.split('\n').map((l: string) => `    ${l}`).join('\n')}`);
  }

  async function profile(args: string[], flags: Json, lists: Json) {
    const sub = (args[0] || 'list').toLowerCase();
    const name = args[1];
    if (sub === 'help') return out(HELP);
    if (sub === 'list') {
      const v = await require('../build/profiles.ts').view();
      if (flags.json) return out(JSON.stringify(v.profiles.map((p: Json) => A().profileLine(p)), null, 2));
      for (const p of v.profiles) out(`${p.name.padEnd(10)} ${String(p.model || '-').padEnd(7)} ${String(p.effort || '-').padEnd(7)} ${String(p.permissionMode || '-').padEnd(12)} ${caps(p).padEnd(28)} ${marks(p)}`);
      if (v.missingSeeds.length) out(`deleted built-ins: ${v.missingSeeds.join(', ')} (pa profile reset <name> brings one back)`);
      return;
    }
    if (!name) return fail(`usage: pa profile ${sub} <name>${sub === 'set' ? ' [fields]  (pa help profile)' : ''}`);
    if (sub === 'get') {
      const p = await A().getProfile(name);
      if (flags.json) return out(JSON.stringify(p, null, 2));
      show(p);
      if (p.default && p.modified) { out('  ships as:'); show(p.default); }
      return;
    }
    if (sub === 'set') {
      const r = profilePatch(flags, lists);
      if ('error' in r) return fail(r.error);
      const p = await A().setProfile(name, r.patch);
      return show(p);
    }
    if (sub === 'delete') {
      const r = await A().deleteProfile(name);
      return out(`deleted ${r.deleted}${r.note ? ` — ${r.note}` : ''}`);
    }
    if (sub === 'reset') {
      const p = await A().resetProfile(name);
      out('reset to what ships:');
      return show(p);
    }
    return fail('usage: pa profile list | get <name> | set <name> [fields] | delete <name> | reset <name>');
  }

  async function agents(args: string[], flags: Json, lists: Json) {
    const sub = (args[0] || 'get').toLowerCase();
    if (sub === 'help') return out(HELP);
    if (sub === 'get') {
      const v = await A().summary();
      if (flags.json) return out(JSON.stringify({ chat: v.chat, passes: v.passes }, null, 2));
      const c = v.chat;
      out(`chat        ${String(c.model || '(Claude Code default)').padEnd(28)} ${c.source}${c.source === 'store' ? ` (without it: ${c.default || 'Claude Code default'})` : ''}`);
      for (const p of v.passes) out(`${p.key.padEnd(18)} ${String(p.model).padEnd(28)} ${p.source}${p.source === 'store' ? ` (without it: ${p.default})` : ''}`);
      return;
    }
    if (sub === 'set') {
      const r = agentsPatch(flags, lists);
      if ('error' in r) return fail(r.error);
      const v = await A().setAgents(r.patch);
      out(`chat ${v.chat.model || '(Claude Code default)'} (${v.chat.source})`);
      for (const k of Object.keys(r.patch.passModels || {})) {
        const p = v.passes.find((x: Json) => x.key === k);
        if (p) out(`${k} ${p.model} (${p.source})`);
      }
      return;
    }
    return fail('usage: pa agents get | set [--chat-model m] [--pass <pass>=<model>]… [--clear-chat-model] [--clear-pass <pass>]…');
  }

  return { profile, agents };
}

module.exports = { make, HELP, profilePatch, agentsPatch };
