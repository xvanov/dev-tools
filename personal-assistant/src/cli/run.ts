'use strict';

// `pa run` — Build agents (PLAN.md D30). The agent calls note|ask|done (its run
// id is $JARVIS_RUN_ID); Jarvis and you call list|status|reply|send|stop.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;

const HELP = `
  Build agents (one Claude Code agent per task)
    pa run list [--all]                 live runs (--all: recent ones too)
    pa run status <id>                  one run: state, cost, steps, messages
    pa run stop <id>                    kill its session
    Inside an agent (the run id is $JARVIS_RUN_ID):
    pa run done --result "<PR url | report path | one line>"
`;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function make(out: (s: string) => void, fail: (s: string) => void) {
  const B = () => require('../build/index.ts');

  /** The run id: the first number after the verb, else $JARVIS_RUN_ID. */
  function runId(args: string[], flags: Row): number {
    const given = args.slice(1).find((a) => /^\d+$/.test(String(a)));
    const id = Number(given || flags.run || process.env.JARVIS_RUN_ID);
    if (!Number.isInteger(id) || id <= 0) throw new Error('which run? give its id (inside an agent, $JARVIS_RUN_ID is set)');
    return id;
  }

  const money = (n: unknown) => `$${Number(n || 0).toFixed(2)}`;
  const line = (r: Row) => `#${r.id}  ${String(r.state).padEnd(8)}  ${String(r.model).padEnd(6)}  ${money(r.cost_usd).padStart(6)}  ${String(r.task).slice(0, 70)}${r.result ? `  → ${r.result}` : ''}`;

  return {
    async run(args: string[], flags: Row) {
      const sub = String(args[0] || '').toLowerCase();
      if (sub === 'list') {
        const rows: Row[] = await B().list({ live: !flags.all, limit: 30 });
        out(rows.length ? rows.map(line).join('\n') : 'no runs');
        return;
      }
      if (sub === 'status') {
        const r = await B().get(runId(args, flags));
        if (!r) return fail('no such run');
        out(line(r));
        if (r.url) out(`  open: ${r.url}`);
        if (r.branch) out(`  branch: ${r.branch}`);
        if (r.error) out(`  note: ${r.error}`);
        return;
      }
      if (sub === 'stop') {
        const r = await B().stop(runId(args, flags));
        out(`run #${r.id} ${r.state}`);
        return;
      }
      if (sub === 'done') {
        const rest = args.slice(1).filter((a) => !/^\d+$/.test(String(a))).join(' ');
        const r = await B().done(runId(args, flags), str(flags.result) || rest);
        out(`run #${r.id} done`);
        return;
      }
      fail(HELP);
    },
  };
}

module.exports = { make, HELP };
