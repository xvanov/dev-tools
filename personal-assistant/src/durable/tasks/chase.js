'use strict';

// Chasing what I am owed (durable task `chase`, one per owed-to-me commitment).
//
// Someone promised me something in chat or mail. The task sleeps until a
// working morning two days later (or just after it was due) unless the
// commitment closes first — the ledger emits `closed:<id>` on every close,
// and the reconciler closes it the moment their answer arrives. If it is still
// open, it drafts a short follow-up in the same thread (it lands in "Replies
// to send"; I press Send, as with every draft) and tells me. Three days later,
// still open: one reminder, and the task ends. It never chases twice in a day
// more than MAX_NUDGES_PER_DAY times across all commitments — an overflow
// waits for the next morning.

const { TimeoutError } = require('absurd-sdk');
const { one } = require('../../db');
const C = require('./chaseCore');

const name = 'chase';

async function read(commitmentId) {
  return one(
    `select c.id, c.status, c.direction, c.summary, c.due_at, c.counterparty_person_id,
            coalesce(per.is_me, false) as counterparty_is_me, per.display_name as who,
            si.source, si.occurred_at as asked_at
       from commitment c join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
      where c.id = $1`,
    [commitmentId]
  );
}

// Waits for the close event until `at`. True: it closed.
async function closedBy(ctx, stepName, commitmentId, at) {
  try {
    await ctx.awaitEvent(`closed:${commitmentId}`, { stepName, timeout: C.secondsUntil(at) });
    return true;
  } catch (err) {
    if (err instanceof TimeoutError) return false;
    throw err;
  }
}

async function run({ commitmentId }, ctx) {
  const first = await ctx.step('read', async () => {
    const c = await read(commitmentId);
    return c && C.worthChasing(c) ? { at: C.firstChaseAt(c).toISOString() } : null;
  });
  if (!first) return { result: 'not worth chasing' };
  if (await closedBy(ctx, 'wait-first', commitmentId, first.at)) return { result: 'closed before the chase' };

  // A slot today, or the next morning: never more than a few nudges a day.
  for (let i = 0; i < 5; i++) {
    const slot = await ctx.step('slot', async () => {
      const r = await one(`select count(*)::int as n from draft where origin = 'nudge' and created_at >= date_trunc('day', now())`);
      return r.n < C.MAX_NUDGES_PER_DAY ? null : C.workingMorning(new Date(Date.now() + 86400_000)).toISOString();
    });
    if (!slot) break;
    if (await closedBy(ctx, 'wait-slot', commitmentId, slot)) return { result: 'closed while queued' };
  }

  const nudged = await ctx.step('nudge', async () => {
    const c = await read(commitmentId);
    if (!c || c.status !== 'open') return null;
    const draft = await require('../../draft').composeNudge(commitmentId);
    await require('../../notify').notify({
      kind: 'info',
      title: `Still waiting on ${c.who || 'someone'}: ${c.summary}`.slice(0, 200),
      body: 'A follow-up is drafted in "Replies to send" — edit it or send it.',
      dedupeKey: `chase:${commitmentId}`,
    });
    return { at: new Date().toISOString(), draftId: Number(draft.id) };
  });
  if (!nudged) return { result: 'closed before the nudge' };

  if (await closedBy(ctx, 'wait-second', commitmentId, C.secondChaseAt(nudged.at))) return { result: 'closed after the nudge' };

  await ctx.step('remind', async () => {
    const c = await read(commitmentId);
    if (!c || c.status !== 'open') return null;
    await require('../../notify').notify({
      kind: 'info',
      title: `No answer yet from ${c.who || 'them'}: ${c.summary}`.slice(0, 200),
      body: 'Followed up three days ago. Chase again, or dismiss it if it no longer matters.',
      dedupeKey: `chase-again:${commitmentId}`,
    });
    return true;
  });
  return { result: 'reminded' };
}

module.exports = { name, run, read };
