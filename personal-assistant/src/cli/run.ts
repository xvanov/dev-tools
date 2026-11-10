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
    pa run reply <id> "<answer>" [--ask <n>]   answer the run's open question
    pa run send <id> "<text>"           type text into its live session
    Inside an agent (the run id is $JARVIS_RUN_ID):
    pa run note "<text>"                progress or an FYI; does not wait
    pa run ask "<question>"             needs a human: waits up to 30 min and prints the answer
    pa run done --result "<PR url | report path | one line>"
`;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function make(out: (s: string) => void, fail: (s: string) => void) {
  const B = () => require('../build/index.ts');
  const M = () => require('../build/messages.ts');

  /**
   * The run id. Jarvis's verbs take it as the first word (`pa run reply 7 "…"`);
   * an agent's (`note`, `ask`, `done`) get it from $JARVIS_RUN_ID first, so a
   * number in its own text is never read as one.
   */
  function runId(args: string[], flags: Row): { id: number; used: boolean } {
    const agent = ['note', 'ask', 'done'].includes(String(args[0]));
    const first = /^\d+$/.test(String(args[1] ?? '')) ? Number(args[1]) : null;
    const env = Number(process.env.JARVIS_RUN_ID) || null;
    const id = Number(flags.run) || (agent ? env || first : first || env);
    if (!Number.isInteger(id) || (id as number) <= 0) throw new Error('which run? give its id (inside an agent, $JARVIS_RUN_ID is set)');
    return { id: id as number, used: id === first && !(agent && env) };
  }

  /** The words after the verb, without the run id when it was given as one. */
  const words = (args: string[], used: boolean): string => args.slice(used ? 2 : 1).map(String).join(' ');

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
        const r = await B().get(runId(args, flags).id);
        if (!r) return fail('no such run');
        out(line(r));
        if (r.url) out(`  open: ${r.url}`);
        if (r.branch) out(`  branch: ${r.branch}`);
        if (r.error) out(`  note: ${r.error}`);
        return;
      }
      if (sub === 'stop') {
        const r = await B().stop(runId(args, flags).id);
        out(`run #${r.id} ${r.state}`);
        return;
      }
      if (sub === 'done') {
        const w = runId(args, flags);
        const r = await B().done(w.id, str(flags.result) || words(args, w.used));
        out(`run #${r.id} done`);
        return;
      }
      if (sub === 'note') {
        const w = runId(args, flags);
        await M().note(w.id, words(args, w.used));
        out('noted');
        return;
      }
      if (sub === 'ask') {
        const w = runId(args, flags);
        const r = await M().ask(w.id, words(args, w.used));
        out(r.answered ? r.answer : 'NO ANSWER: nobody answered in time. Make the most reasonable choice yourself, note it with `pa run note`, and carry on.');
        return;
      }
      if (sub === 'reply') {
        const w = runId(args, flags);
        const r = await M().reply(w.id, words(args, w.used), flags.ask != null ? Number(flags.ask) : null);
        out(`answered #${r.id} on run #${r.run_id}`);
        return;
      }
      if (sub === 'send') {
        const w = runId(args, flags);
        await M().send(w.id, words(args, w.used));
        out('sent');
        return;
      }
      fail(HELP);
    },
  };
}

module.exports = { make, HELP };
