'use strict';

// `pa task add` — a task because you said so (src/commitments/request.js) —
// and `pa policy`, which sources may create tasks at all
// (src/commitments/sourcePolicy.js) and closing the cards it would not have made.

const { flagBool } = require('./parseArgs');

const HELP = `
  Tasks
    pa task add "<what>" [--due <when>] [--for <person>] [--owed-to-me] [--project <name>]
                                         a task on your board because you asked for it
                                         --due: friday, tomorrow 3pm, 2d, 2026-11-20
                                         --for: who it is for (or, with --owed-to-me, who owes it to you)
    pa policy                            which sources may create tasks (PA_COMMITMENT_SOURCES)
    pa policy close [--apply]            close open cards the policy would not have created
                                         (dry run without --apply; cards you acted on are kept)
`;

/**
 * Pure. `pa task add …` argv (after `task`) → request.add's options.
 * The text is every positional after `add`; a boolean flag that swallowed a
 * word (`--owed-to-me Fix it`) gives the word back.
 */
function addOptions(args, flags) {
  const words = args.slice(1).map(String);
  let owedToMe = false;
  const o = flags['owed-to-me'];
  if (typeof o === 'string') {
    owedToMe = true;
    words.unshift(o);
  } else owedToMe = flagBool(flags, 'owed-to-me');
  const str = (name) => (typeof flags[name] === 'string' ? flags[name] : null);
  return { text: words.join(' '), due: str('due'), for: str('for'), owedToMe, project: str('project'), via: 'cli' };
}

function make(out, fail) {
  return {
    async task(args, flags) {
      const sub = String(args[0] || '').toLowerCase();
      if (sub !== 'add') return fail(require('../commitments/request.ts').USAGE);
      const request = require('../commitments/request.ts');
      const r = await request.add(addOptions(args, flags));
      out(request.describe(r));
    },

    async policy(args, flags) {
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
      if (sub !== 'close') return fail('usage: pa policy [close [--apply]]');
      const apply = flagBool(flags, 'apply');
      const pc = require('../commitments/policyClose.ts');
      const r = await pc.run({ apply });
      out(pc.report(r, { apply }));
    },
  };
}

module.exports = { make, HELP, addOptions };
