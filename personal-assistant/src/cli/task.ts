'use strict';

// `pa task add` — a task because you said so (src/commitments/request.js) —
// and `pa policy`, which sources may create tasks at all
// (src/commitments/sourcePolicy.js) and closing the cards it would not have made.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

const { flagBool } = require('./parseArgs.ts');

const HELP = `
  Tasks
    pa task add "<what>" [--due <when>] [--for <person>] [--owed-to-me] [--project <name>]
                                         a task on your board because you asked for it
                                         --due: friday, tomorrow 3pm, 2d, 2026-11-20
                                         --for: who it is for (or, with --owed-to-me, who owes it to you)
    pa card edit <id> [--title "…"] [--details "…"] [--due <when>|--no-due] [--project <name>|--no-project]
                      [--note "…"] [--reason "…"]
                                         change a card in place instead of dismissing and recreating it:
                                         keeps its id, source link, runs and history; each edit is a row in
                                         pa ledger <id> (before, who, why) and pins the card against re-distillation
                                         --due: friday, tomorrow 3pm, 2d, 2026-11-20 (not a past date)
                                         --note: appended to the details as a dated line
    pa cardplan list|show <id>           the card changes waiting for your yes (one set, approved once; dashboard: Proposed card changes)
    pa cardplan apply <id> [--skip 1,3]  run the plan's changes in order (as you); --skip leaves those item numbers out
    pa cardplan discard <id>             drop the plan; nothing changes
    pa policy                            which sources may create tasks (PA_COMMITMENT_SOURCES)
    pa policy close [--teams] [--apply]  close open cards the policy would not have created
                                         (dry run without --apply; cards you acted on are kept;
                                         --teams: only the Teams cache's system threads and local copies)
`;

/**
 * Pure. `pa task add …` argv (after `task`) → request.add's options.
 * The text is every positional after `add`; a boolean flag that swallowed a
 * word (`--owed-to-me Fix it`) gives the word back.
 */
function addOptions(args: any, flags: any) {
  const words = args.slice(1).map(String);
  let owedToMe = false;
  const o = flags['owed-to-me'];
  if (typeof o === 'string') {
    owedToMe = true;
    words.unshift(o);
  } else owedToMe = flagBool(flags, 'owed-to-me');
  const str = (name: any) => (typeof flags[name] === 'string' ? flags[name] : null);
  return { text: words.join(' '), due: str('due'), for: str('for'), owedToMe, project: str('project'), via: 'cli' };
}

const CARD_USAGE = 'usage: pa card edit <id> [--title "…"] [--details "…"] [--due <when>|--no-due] [--project <name>|--no-project] [--note "…"] [--reason "…"]';

/**
 * Pure. `pa card edit <id> …` flags → editCard's edit, or an error string.
 * `--no-due` / `--no-project` arrive as `due: false` / `project: false` (parseArgs).
 */
function editOptions(flags: any): { edit: Json } | { error: string } {
  const edit: Json = {};
  const text = (name: string) => (typeof flags[name] === 'string' ? flags[name] : undefined);
  for (const name of ['title', 'details', 'note', 'reason']) {
    if (flags[name] === true) return { error: `--${name} needs a value. ${CARD_USAGE}` };
  }
  if (text('title') !== undefined) edit.title = text('title');
  if (text('details') !== undefined) edit.details = text('details');
  if (text('note') !== undefined) edit.note = text('note');
  if (text('reason') !== undefined) edit.reason = text('reason');
  if (flags.due === false) edit.due = null;
  else if (flags.due === true) return { error: `--due needs a date. ${CARD_USAGE}` };
  else if (text('due') !== undefined) edit.due = text('due');
  if (flags.project === false) edit.project = null;
  else if (flags.project === true) return { error: `--project needs a name. ${CARD_USAGE}` };
  else if (text('project') !== undefined) edit.project = text('project');
  return { edit };
}

function make(out: any, fail: any) {
  return {
    async task(args: any, flags: any) {
      const sub = String(args[0] || '').toLowerCase();
      if (sub !== 'add') return fail(require('../commitments/request.ts').USAGE);
      const request = require('../commitments/request.ts');
      const r = await request.add(addOptions(args, flags));
      out(request.describe(r));
    },

    async card(args: any, flags: any) {
      if (String(args[0] || '').toLowerCase() !== 'edit') return fail(CARD_USAGE);
      const id = Number(args[1]);
      if (!id) return fail(CARD_USAGE);
      const o = editOptions(flags);
      if ('error' in o) return fail(o.error);
      const r = await require('../commitments.ts').editCard(id, o.edit);
      if (!r.changed.length) return out(`#${r.id} unchanged · ${r.card.summary}`);
      out(`#${r.id} edited (${r.changed.join(', ')}) · ${r.card.summary}`);
      for (const [k, v] of Object.entries(r.before)) out(`  ${k}: ${v == null ? '(none)' : String(v).replace(/\s+/g, ' ').slice(0, 100)} -> ${r.after[k] == null ? '(none)' : String(r.after[k]).replace(/\s+/g, ' ').slice(0, 100)}`);
    },

    async cardplan(args: any, flags: any) {
      const sub = String(args[0] || 'list').toLowerCase();
      const plans = require('../cardplans.ts');
      const MARK: Record<string, string> = { applied: '✓', failed: '✗', skipped: '-', pending: ' ', running: '…' };
      const print = (p: Json) => {
        out(`plan #${p.id} · ${p.status} · ${p.title}${p.items.length ? ` · ${p.items.length} change${p.items.length === 1 ? '' : 's'}` : ''}`);
        if (p.rationale) out(`  ${p.rationale}`);
        for (const s of p.sources || []) out(`  source: ${s}`);
        for (const i of p.items) out(`  ${i.n}. [${MARK[i.status] || '?'}] ${i.enabled ? '' : '(unticked) '}${i.line}${i.error ? ` — ${i.error}` : ''}`);
      };
      if (sub === 'list') {
        const all = await plans.list({});
        if (!all.length) return out('no card plans waiting');
        for (const p of all) print(p);
        return;
      }
      const id = Number(args[1]);
      if (!['show', 'apply', 'discard'].includes(sub) || !id) return fail('usage: pa cardplan list | show <id> | apply <id> [--skip 1,3] | discard <id>');
      if (sub === 'show') return print(await plans.show(id));
      if (sub === 'discard') return print(await plans.discard(id));
      if (flags.skip === true) return fail('--skip needs item numbers, e.g. --skip 1,3');
      const r = await plans.apply(id, { skip: typeof flags.skip === 'string' ? flags.skip : [] });
      print(r);
      out(`${r.applied} applied · ${r.failed} failed · ${r.skipped} skipped${r.ran === 0 ? ' (nothing left to run)' : ''}`);
    },

    async policy(args: any, flags: any) {
      const sub = String(args[0] || '').toLowerCase();
      const policy = require('../commitments/sourcePolicy.ts');
      if (!sub || sub === 'show') {
        const d = policy.describe();
        out(`PA_COMMITMENT_SOURCES=${d.spec}`);
        out(`  create tasks:   ${d.allowed.join(', ') || '(none)'}`);
        out(`  evidence only:  ${d.excluded.join(', ') || '(none)'}`);
        if (d.unknown.length) out(`  not a known source or group: ${d.unknown.join(', ')}`);
        out('  Within those, only a person asking counts: no bots or automated mail, not your own GitHub activity.');
        return;
      }
      if (sub !== 'close') return fail('usage: pa policy [close [--teams] [--apply]]');
      const apply = flagBool(flags, 'apply');
      const teams = flagBool(flags, 'teams');
      const pc = require('../commitments/policyClose.ts');
      const r = await pc.run({ apply, teams });
      out(pc.report(r, { apply, teams }));
    },
  };
}

module.exports = { make, HELP, addOptions, editOptions };
