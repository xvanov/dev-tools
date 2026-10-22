'use strict';

// `pa routine` — recurring typed actions. Kept in its own file so
// cli/index.js only has to wire it in.

const readline = require('readline');
const { flagInt, flagBool } = require('./parseArgs');

const HELP = `
  Routines (actions that change things on this machine, on a schedule)
    pa routine add "<words>" [--yes]   e.g. "every weekday at 8 pull main on all repos";
                                       shows what it understood and asks before saving
    pa routine list [--all]            active, paused and proposed routines
    pa routine run <id> [--dry-run] [--no-fetch]   run now; --dry-run changes nothing
    pa routine pause|resume <id>
    pa routine accept|reject <id>      a suggested routine
    pa routine delete <id>             (a suggestion is marked rejected instead)
    pa routine history [<id>] [-n 20]
    pa routine suggest                 look for routines worth proposing now
    pa routine actions                 what a routine is allowed to do
`;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function when(v) {
  if (!v) return '—';
  const d = new Date(v);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function make(out, fail) {
  const R = () => require('../routines');

  function showPreview(p) {
    out(`  ${p.title}`);
    out(`  ${p.plain}`);
    out(p.changes ? `  ACTION — will change things on this machine: ${p.changes}` : '  Read-only — changes nothing on this machine');
    out(`  schedule: ${p.schedule}   next: ${p.nextRuns.map(when).join(' · ')}`);
  }

  function line(r) {
    const flags = [r.status, r.origin === 'suggested' ? 'suggested' : null].filter(Boolean).join(', ');
    const last = r.last_summary ? `  last: ${r.last_ok === false ? 'FAILED ' : ''}${r.last_summary}` : '';
    return [
      `  #${r.id} ${r.title}  (${flags})`,
      `      ${R().plainWords(r)}`,
      r.status === 'active' ? `      next: ${when(r.next_run_at)}${last}` : last ? `    ${last}` : null,
      r.why ? `      why: ${r.why}` : null,
    ].filter(Boolean).join('\n');
  }

  async function routine(args, flags) {
    const sub = (args[0] || 'list').toLowerCase();
    const id = args[1];
    const routines = R();

    if (sub === 'help') return out(HELP);

    if (sub === 'add') {
      const words = args.slice(1).join(' ').trim();
      if (!words) return fail('usage: pa routine add "every weekday at 8 pull main on all repos"');
      out('Reading that…');
      const p = await routines.parseWords(words);
      showPreview(p);
      if (!(flagBool(flags, 'yes') || (await ask('Save this routine? [y/N]')))) return out('not saved');
      const row = await routines.create(p);
      return out(`saved routine #${row.id}; first run ${when(row.next_run_at)}`);
    }

    if (sub === 'list' || sub === 'ls') {
      const list = await routines.list({ statuses: flagBool(flags, 'all') ? null : ['active', 'paused', 'proposed'] });
      if (!list.length) return out('No routines. Add one: pa routine add "every weekday at 8 pull main on all repos"');
      return out(list.map(line).join('\n'));
    }

    if (sub === 'actions') {
      for (const a of routines.actions.catalog()) {
        out(`  ${a.action}: ${a.does}\n      changes: ${a.changesTheMachine}`);
        for (const [k, v] of Object.entries(a.params)) out(`      ${k}: ${v}`);
      }
      return;
    }

    if (sub === 'history') {
      const runs = await routines.history({ routineId: id || null, limit: flagInt(flags, 'n', 20) });
      if (!runs.length) return out('No runs yet.');
      for (const x of runs) {
        out(`  run ${x.id} · #${x.routine_id} ${x.title} · ${when(x.started_at)} · ${x.ended_at ? (x.ok ? 'ok' : 'FAILED') : 'running'}`);
        if (x.summary) out(`      ${x.summary}`);
      }
      return;
    }

    if (sub === 'suggest') {
      out('Looking for routines worth proposing…');
      const rows = await require('../routines/suggest').suggest();
      if (!rows.length) return out('Nothing convincing to propose.');
      return out(rows.map(line).join('\n') + '\n\nAccept with: pa routine accept <id>');
    }

    if (!id || !/^\d+$/.test(id)) return fail(`usage: pa routine ${sub} <id>`);

    if (sub === 'run') {
      const dryRun = flagBool(flags, 'dry-run');
      const r = await routines.getRoutine(id);
      out(`${dryRun ? 'Dry run of' : 'Running'} #${r.id} ${r.title}…`);
      const run = await routines.runRoutine(id, { dryRun, fetch: flags.fetch !== false });
      out(`${run.ok ? '' : 'FAILED: '}${run.summary}`);
      run.lines.forEach((l, i) => out(`  ${i + 1}. ${l}`));
      return;
    }
    if (['pause', 'resume', 'accept', 'reject'].includes(sub)) {
      const r = await routines.setStatus(id, sub);
      return out(`#${r.id} is now ${r.status}${r.status === 'active' ? `; next run ${when(r.next_run_at)}` : ''}`);
    }
    if (sub === 'delete' || sub === 'rm') {
      const r = await routines.remove(id);
      return out(r.deleted ? `deleted #${r.id}` : `#${r.id} was a suggestion; marked rejected so it is not proposed again`);
    }
    return fail(`unknown routine verb "${sub}" — try \`pa help routine\``);
  }

  return { routine, routines: routine };
}

module.exports = { make, HELP };
