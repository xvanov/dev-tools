'use strict';

// `pa audit`: the policy engine's audit log (plan 4.3; src/policy, src/repo/audit.js).

const HELP = `pa audit — every decision of the policy engine, hash-chained

  pa audit verify                 walk the whole chain and recompute every hash; exits 1 at the first bad row
                                  and says which. Prints the head hash: keep it somewhere else to also catch
                                  a log that was cut short.
  pa audit tail [-n 20] [--tool t] [--decision allow|deny|ask]
                                  the newest rows, newest first
  pa audit check <tool> [--channel c] [--action call|approve] [--delivery level]
                                  what the policy would decide for a call, without running or logging it
                                  (channels: mcp chat voice dashboard termhub cli factory)

The policy is src/policy/default.policy.json plus your untracked override (PA_POLICY_FILE, default
<data dir>/policy.json).
`;

function make(out, fail) {
  return {
    async audit(args, flags) {
      const sub = args[0] || 'help';
      if (sub === 'help') return out(HELP);
      if (sub === 'verify') {
        const r = await require('../repo').audit.verify();
        if (r.ok) return out(`audit chain ok: ${r.count} row${r.count === 1 ? '' : 's'}, head ${r.head}`);
        out(`audit chain BROKEN at row ${r.brokenAt.seq}: ${r.brokenAt.reason}\n${r.count} row${r.count === 1 ? '' : 's'} verified before it, last good hash ${r.head}`);
        process.exitCode = 1;
        return;
      }
      if (sub === 'tail') {
        const rows = await require('../repo').audit.recent({
          limit: Number(flags.n ?? flags.limit ?? 20) || 20,
          tool: flags.tool ? String(flags.tool) : null,
          decision: flags.decision ? String(flags.decision) : null,
        });
        if (!rows.length) return out('(the audit log is empty)');
        for (const r of rows) out(`#${r.seq} ${r.at} ${r.decision.padEnd(5)} ${r.channel}/${r.action} ${r.tool}${r.subject ? ` [${r.subject}]` : ''} rule=${r.rule}${r.reason ? ` — ${r.reason}` : ''}`);
        return;
      }
      if (sub === 'check') {
        if (!args[1]) return fail('pa audit check <tool> [--channel c] [--action call|approve] [--delivery level]');
        const P = require('../policy');
        const res = P.evaluate({
          tool: args[1],
          action: String(flags.action || 'call'),
          channel: String(flags.channel || 'cli'),
          args: flags.delivery ? { delivery: String(flags.delivery) } : {},
        });
        return out(`${res.decision} (rule ${res.rule}${res.tags.length ? `, tags ${res.tags.join('/')}` : ''})${res.reason ? ` — ${res.reason}` : ''}`);
      }
      return fail(`unknown audit command "${sub}"\n${HELP}`);
    },
  };
}

module.exports = { make, HELP };
