'use strict';

// Chasing what I am owed (durable task `chase`, one per owed-to-me commitment).
//
// Someone promised me something in chat or mail. First it asks me, in "Needs
// you", when to follow up: in 4 hours, tomorrow, in 2 days, in a week, or not
// at all — the answer I last gave for that person marked usual. No answer by
// the default time (a working morning two days later, just after it was due,
// or my usual cadence for them) and it goes with the default. Then it sleeps
// until that time unless the commitment closes first — the ledger emits `closed:<id>` on every close,
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

// The cadence I last picked for this person, if any.
async function usualCadence(personId) {
  const r = await one(
    `select p.answer from proposal p join commitment c on c.id = p.commitment_id
      where p.payload->>'on' = 'cadence' and p.status = 'accepted' and c.counterparty_person_id = $1
      order by p.decided_at desc limit 1`,
    [personId]
  );
  return r?.answer || null;
}

async function run({ commitmentId }, ctx) {
  const first = await ctx.step('read', async () => {
    // Judged first: an answer may already be in, and asking "when should I
    // chase?" about something already answered is the noise this exists to end.
    await require('../../ledger/reconcile').pass({ ids: [commitmentId] }).catch(() => null);
    const c = await read(commitmentId);
    if (!c || !C.worthChasing(c)) return null;
    const usual = await usualCadence(c.counterparty_person_id);
    const at = usual ? C.chaseAtFor(usual, c.asked_at) : C.firstChaseAt(c);
    if (at === null) return { never: true, usual };
    // A usual cadence already past (an old ask): the default rule instead.
    return { at: (at && at > new Date() ? at : C.firstChaseAt(c)).toISOString(), usual };
  });
  if (!first) return { result: 'not worth chasing' };

  const asked = await ctx.step('ask', async () => {
    const c = await read(commitmentId);
    const when = first.never ? 'I will not chase it' : `I follow up ${new Date(first.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    const p = await require('../../proposals').create({
      kind: 'question',
      commitmentId,
      title: `When should I follow up with ${c.who || 'them'}? ${c.summary}`.slice(0, 280),
      body: `Without an answer, ${when}. Answering earlier than that takes effect from now.`,
      options: C.cadenceOptions(first.usual),
      payload: { task: name, on: 'cadence' },
      dedupeKey: `chase-cadence:${commitmentId}`,
      expiresAt: first.never ? new Date(Date.now() + 2 * 86400_000) : new Date(first.at),
    });
    return p ? { id: Number(p.id) } : null;
  });

  let answer = null;
  if (asked) {
    try {
      answer = await ctx.awaitEvent(`proposal:${asked.id}`, {
        stepName: 'wait-cadence',
        timeout: C.secondsUntil(first.never ? new Date(Date.now() + 2 * 86400_000) : first.at),
      });
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err;
    }
  }
  const plan = await ctx.step('cadence', async () => {
    const value = answer?.accepted ? answer.answer : null;
    const at = value ? C.chaseAtFor(value, new Date()) : undefined;
    if (at === null || (at === undefined && first.never)) return { never: true, value };
    return { at: (at || new Date(first.at)).toISOString(), value: value || first.usual };
  });
  if (plan.never) return { result: 'you said not to chase' };
  if (await closedBy(ctx, 'wait-first', commitmentId, plan.at)) return { result: 'closed before the chase' };

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

  if (await closedBy(ctx, 'wait-second', commitmentId, C.secondChaseAt(nudged.at, plan.value))) return { result: 'closed after the nudge' };

  await ctx.step('remind', async () => {
    const c = await read(commitmentId);
    if (!c || c.status !== 'open') return null;
    await require('../../notify').notify({
      kind: 'info',
      title: `No answer yet from ${c.who || 'them'}: ${c.summary}`.slice(0, 200),
      body: 'Followed up and still nothing. Chase again, or dismiss it if it no longer matters.',
      dedupeKey: `chase-again:${commitmentId}`,
    });
    return true;
  });
  return { result: 'reminded' };
}

module.exports = { name, run, read };
