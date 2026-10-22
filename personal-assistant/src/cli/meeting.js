'use strict';

// `pa meeting …` — pre-meeting briefs from the terminal (src/meetings).

const HELP = `pa meeting — pre-meeting briefs

  pa meeting next                     the next meeting that would be briefed, and its kind
  pa meeting list [--hours 24]        upcoming meetings: kind, briefed or why skipped
  pa meeting brief <event-id|next>    write the brief now and print it
        [--notify]                    also deliver it (toast + dashboard feed)
        [--force]                     rewrite even if a fresh one exists
        [--evidence]                  print the labelled evidence instead (no model call)
  pa meeting kind <title> <kind>      correct a series' kind: ${'standup one_on_one planning review retro external interview other'}
  pa meeting learn                    learn from transcripts of meetings that just ended
  pa meeting debrief [episode-id|last] after a recorded meeting: your to-dos, updates to
        [--dry-run]                   your open work and decisions, each with its quote
        [--notify]                    also deliver it (toast + dashboard feed)
  pa meeting debriefs [--days 7]      recent debriefs and what they applied
  pa meeting undo <debrief-id> <n>    take back item n of a debrief
`;

function make(out, fail) {
  const { flagInt, flagBool } = require('./parseArgs');
  const local = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });

  function printBrief(r) {
    const b = r.brief;
    out(`${local(r.meeting.start)} · ${r.meeting.subject} · ${r.kind} (${r.kindSource})`);
    out('');
    out(b.body || '(empty)');
    const refs = b.refs || {};
    if (Object.keys(refs).length) {
      out('');
      out('Sources:');
      for (const [label, ref] of Object.entries(refs)) out(`  ${label}  ${ref.key}${ref.url ? `  ${ref.url}` : ''}`);
    }
    out('');
    out(`brief #${b.id} · ${b.notification_id ? `notified #${b.notification_id}` : 'not notified'} · event ${r.meeting.eventId.slice(0, 24)}…`);
  }

  return {
    async meeting(args, flags) {
      const meetings = require('../meetings');
      const sub = args[0] || 'help';
      if (sub === 'help') return out(HELP);

      if (sub === 'next') {
        const ctx = await meetings.context();
        const m = await meetings.resolveTarget('next', { ctx });
        const { kind, source } = await meetings.classify(m, ctx, { allowModel: false });
        out(`${local(m.start)} · ${m.subject}`);
        out(`  kind ${kind} (${source}) · ${m.minutes} min · ${m.attendees.length} invited${m.joinUrl ? ' · has join link' : ''}`);
        out(`  event ${m.eventId}`);
        return;
      }

      if (sub === 'list') {
        const list = await meetings.upcoming({ hours: flagInt(flags, 'hours', 24), limit: 25 });
        if (!list.length) return out('no meetings in that window');
        for (const m of list) {
          const state = !m.eligible ? `skip: ${m.skipReason}` : m.brief?.error ? `failed: ${m.brief.error.slice(0, 60)}` : m.brief ? `briefed #${m.brief.id}` : 'not briefed yet';
          out(`${local(m.start).padEnd(22)} ${String(m.kind || '?').padEnd(11)} ${m.subject.slice(0, 50).padEnd(50)} ${state}`);
        }
        return;
      }

      if (sub === 'brief') {
        const target = args[1] || 'next';
        if (flagBool(flags, 'evidence', false)) {
          const ctx = await meetings.context();
          const m = await meetings.resolveTarget(target, { ctx });
          const { kind } = await meetings.classify(m, ctx);
          const ev = await meetings.gatherEvidence(m, kind, ctx);
          const { buildBriefPrompt } = require('../meetings/prompt');
          return out(buildBriefPrompt(ev).prompt);
        }
        const r = await meetings.brief(target, { deliver: flagBool(flags, 'notify', false), force: flagBool(flags, 'force', false) });
        return printBrief(r);
      }

      if (sub === 'kind') {
        if (args.length < 3) return fail('usage: pa meeting kind <title> <kind>');
        const row = await meetings.setKind(args.slice(1, -1).join(' '), args[args.length - 1]);
        return out(`"${row.label}" is now ${row.kind} (manual)`);
      }

      if (sub === 'learn') {
        const n = await meetings.learnRecent({ limit: flagInt(flags, 'limit', 5) });
        return out(`learned from ${n} occurrence${n === 1 ? '' : 's'}`);
      }

      if (sub === 'debrief') {
        const debrief = require('../meetings/debrief');
        // `--dry-run last` would read "last" as the flag's value.
        const dry = flags['dry-run'];
        const target = args[1] || (typeof dry === 'string' && dry !== 'true' ? dry : 'last');
        const dryRun = dry !== undefined && dry !== false && dry !== 'false';
        const r = await debrief.debrief(target, { dryRun, deliver: flagBool(flags, 'notify', false) });
        out(`${local(r.meeting.start)} · ${r.meeting.title} · episode ${r.episode.id} (${r.meeting.kind})${dryRun ? ' · DRY RUN, nothing written' : ''}`);
        const { itemLine } = require('../meetings/debriefCore');
        const items = r.debrief ? r.debrief.applied.items : r.plan.items;
        if (!items.length) out('  nothing for you in this one');
        items.forEach((it, i) => {
          out(`  ${i + 1}. ${itemLine(it)}${it.commitmentId && it.type !== 'update' ? `  (#${it.commitmentId})` : ''}`);
          out(`     "${it.quote}"`);
        });
        for (const s of r.plan.skipped) out(`  skipped: ${s.summary} — ${s.reason}`);
        if (r.plan.dropped.length) out(`  dropped ${r.plan.dropped.length} item(s) whose quote was missing, not in the transcript, or not yours`);
        if (r.debrief) out(`debrief #${r.debrief.id}${r.debrief.notification_id ? ` · notified #${r.debrief.notification_id}` : ''}`);
        return;
      }

      if (sub === 'debriefs') {
        const list = await require('../meetings/debrief').recent({ days: flagInt(flags, 'days', 7) });
        if (!list.length) return out('no debriefs in that window');
        for (const d of list) {
          out(`#${d.id}  ${local(d.startedAt)} · ${d.title} — ${d.counts.todos} to-dos, ${d.counts.updates} updated, ${d.counts.decisions} decisions`);
          for (const it of d.items) out(`    ${it.index + 1}. ${it.line}${it.undone_at ? '  (undone)' : ''}`);
        }
        return;
      }

      if (sub === 'undo') {
        if (args.length < 3) return fail('usage: pa meeting undo <debrief-id> <item-number>');
        const r = await require('../meetings/debrief').undo(Number(args[1]), Number(args[2]) - 1);
        return out(r.already ? 'already undone' : r.result);
      }

      return fail(`unknown: pa meeting ${sub} — try \`pa meeting help\``);
    },
  };
}

module.exports = { make, HELP };
