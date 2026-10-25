'use strict';

// Card context: the "cause and effect" paragraph on a dashboard card
// (sql/023, contextCore.js for the prompt).
//
// Lazy and small. Only commitments that are on a card — Needs you, Looks
// done?, On you, Waiting on others — get one, a few per worker tick, one model
// call each, and only while the daily budget allows discretionary work
// (purpose `card-context`, src/budget.js). Never on the HTTP request path: the
// dashboard shows what is stored and says "not written yet" otherwise.
//
// Written again when the thread it came from has items fetched after it was
// written (a reply, an edit, the session going on) — at most every
// REFRESH_MINUTES, so a live Claude session does not rewrite it every pass —
// or when the prompt version changes. Message content is data, never
// instructions (the system prompt says so); the only thing this pass writes is
// the paragraph.

const llm = require('../llm');
const { config } = require('../config');
const { rows, one, query } = require('../db');
const { logger } = require('../log');
const K = require('./contextCore');

const log = logger('card-context');

const PURPOSE = 'card-context';
const BATCH = 3;
const REFRESH_MINUTES = 30;

// Who wrote an item, as a name: the connector's display name, the person the
// identity resolves to, or the raw identity.
const AUTHOR = (t) => `coalesce(${t}.raw->>'fromName',
  (select p.display_name from person_identity pi join person p on p.id = pi.person_id
    where lower(pi.value) = lower(regexp_replace(coalesce(${t}.author_identity, ''), '^github:', '')) limit 1),
  ${t}.author_identity)`;

/** Commitments on a card whose context is missing or stale, most visible first. */
async function due(limit = BATCH) {
  const { SELF_NOTE } = require('./selfNotes');
  return rows(
    `with card as (
       select p.commitment_id as id, 0 as prio from proposal p
        where p.status = 'pending' and p.commitment_id is not null and (p.expires_at is null or p.expires_at > now())
       union all
       select e.commitment_id, 1 from ledger_evidence e
        where e.effect in ('closes','moot') and not e.applied and e.decision is null
       union all
       select c.id, 2 from commitment c
         join source_item si on si.id = c.source_item_id
         left join person per on per.id = c.counterparty_person_id
        where c.status in ('open','dispatched') and c.superseded_by is null and not ${SELF_NOTE}
     )
     select c.id, min(card.prio) as prio
       from card join commitment c on c.id = card.id
       join source_item si on si.id = c.source_item_id
      where c.status in ('open','dispatched') and c.superseded_by is null
        and (c.context_at is null
             or (c.context_at < now() - make_interval(mins => $3)
                 and (c.context is null or c.context_by is distinct from $2
                      or exists (select 1 from source_item t
                                  where t.fetched_at > c.context_at
                                    and (t.id = si.id or (si.source <> 'claude_session' and si.thread_external_id is not null
                                         and t.source = si.source and t.thread_external_id = si.thread_external_id))))))
      group by c.id
      order by min(card.prio), c.id desc
      limit $1`,
    [limit, `${K.VERSION} ${config.reconcile.model}`, REFRESH_MINUTES]
  );
}

/** Everything the prompt needs for one commitment. */
async function material(id) {
  const c = await one(
    `select c.id, c.summary, c.detail, c.direction, c.status, c.due_at, c.kind,
            coalesce(p.gitlab_path, p.name) as project, per.display_name as who,
            si.id as item_id, si.source, si.subject, si.occurred_at, si.thread_external_id,
            si.raw - 'members' - 'memberEmails' - 'audioPaths' as raw,
            left(si.body_text, 20000) as body, ${AUTHOR('si')} as author
       from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id = $1`,
    [id]
  );
  if (!c) return null;
  // The messages around the source in its thread: a few before, more after —
  // what led to it, and what has happened since. A session's "thread" is its
  // folder, i.e. other sessions: not context for this one.
  let thread = [];
  if (c.thread_external_id && c.source !== 'claude_session') {
    const cols = `t.id, t.occurred_at, left(t.body_text, 900) as body, ${AUTHOR('t')} as author`;
    thread = await rows(
      `(select ${cols} from source_item t
         where t.source = $1 and t.thread_external_id = $2 and t.occurred_at < $3 and t.id <> $4
         order by t.occurred_at desc limit 4)
       union all
       (select ${cols} from source_item t
         where t.source = $1 and t.thread_external_id = $2 and (t.occurred_at >= $3 or t.id = $4)
         order by t.occurred_at asc limit 9)`,
      [c.source, c.thread_external_id, c.occurred_at, c.item_id]
    );
    thread.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
    thread = thread.map((t) => ({ ...t, is_source: String(t.id) === String(c.item_id) }));
  }
  const runs = await rows(
    `select id, status, mode, branch, mr_url, started_at from run where commitment_id = $1 order by started_at desc limit 3`,
    [id]
  );
  const evidence = await rows(
    `select effect, quote, confidence from ledger_evidence
      where commitment_id = $1 and effect in ('closes','moot') and not applied and decision is null
      order by created_at desc limit 2`,
    [id]
  );
  return { c, thread, runs, evidence };
}

let meName = null;
async function me() {
  if (meName) return meName;
  const r = await one('select display_name from person where is_me order by id limit 1').catch(() => null);
  meName = r?.display_name || 'the user';
  return meName;
}

/** Writes the context for one commitment. Returns the paragraph, or null. */
async function write(id) {
  const m = await material(id);
  if (!m) return null;
  const { c } = m;
  const prompt = K.buildPrompt({
    c,
    me: await me(),
    item: { source: c.source, subject: c.subject, occurred_at: c.occurred_at, author: c.author, body: c.body, raw: c.raw },
    thread: m.thread,
    runs: m.runs,
    evidence: m.evidence,
  });
  const reply = await llm.complete({
    system: K.SYSTEM,
    prompt,
    model: config.reconcile.model,
    effort: 'low',
    maxTokens: 600,
    purpose: PURPOSE,
  });
  const text = K.parseContext(reply);
  // Stamped even when the reply was unusable, so one bad item is not retried
  // every tick; a new thread item or prompt version tries it again.
  await query(`update commitment set context = coalesce($2, context), context_at = now(), context_by = $3 where id = $1`, [
    id,
    text,
    `${K.VERSION} ${config.reconcile.model}`,
  ]);
  return text;
}

/** One worker tick: a few cards, while the budget allows. */
async function pass({ limit = BATCH } = {}) {
  if (!config.cardContext.enabled) return { written: 0 };
  const budget = require('../budget');
  const todo = await due(limit);
  let written = 0;
  for (const t of todo) {
    if (!(await budget.allow(PURPOSE))) break;
    try {
      if (await write(Number(t.id))) written += 1;
    } catch (err) {
      log.warn('context failed', { commitment: Number(t.id), message: err.message });
      // Tried again after REFRESH_MINUTES, not on every tick.
      await query('update commitment set context_at = now() where id = $1', [t.id]).catch(() => {});
    }
  }
  if (written) log.info('written', { written, due: todo.length });
  return { written, due: todo.length };
}

module.exports = { pass, write, due, material, PURPOSE };
