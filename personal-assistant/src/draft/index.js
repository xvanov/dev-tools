'use strict';

// Drafting the reply, and the one guarantee this module makes: it does not
// send. `compose()` writes a row; `send()` is a separate call that a human
// makes, after reading it, with the scopes that were deliberately left out of
// the default token.
//
// The draft is written from three things — the original ask in the requester's
// words, what the run actually changed, and where it ended up. Not from the
// agent's own summary of itself, which is reliably more confident than the diff
// justifies.

const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');
const { one, rows, query } = require('../db');
const { request } = require('../graph/client');
const { truncate } = require('../util/text');
const dispatch = require('../dispatch');
const { logger } = require('../log');

const log = logger('draft');

const SYSTEM = `You write short replies on behalf of a software engineer, reporting work they had done.

Constraints:
- Write as the engineer, in first person, to the person who asked. Plain sentences.
- Lead with whether the thing they asked for is done, in the first line.
- Say what changed in terms of what they will notice, not in terms of files or functions.
- If the diff does not actually cover the whole ask, say what is left. Never claim more than the changes support.
- Include the merge request link if one is given.
- No greeting more elaborate than "Hi <name>," and no sign-off beyond a name placeholder.
- Under 140 words. No bullet lists unless there are genuinely three or more separate outcomes.
- Never invent a timeline, a test result, or a review you did not do.`;

function client() {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const Ctor = Anthropic.default || Anthropic;
  return new Ctor({ apiKey: config.anthropic.apiKey });
}

async function context(runId) {
  const run = await dispatch.get(runId);
  if (!run) throw new Error(`no run #${runId}`);

  const commitment = run.commitment_id
    ? await one('select * from commitment where id = $1', [run.commitment_id])
    : null;
  const item = commitment
    ? await one('select * from source_item where id = $1', [commitment.source_item_id])
    : null;
  const person = commitment?.counterparty_person_id
    ? await one('select * from person where id = $1', [commitment.counterparty_person_id])
    : null;

  const review = await dispatch.review(runId).catch(() => ({ stat: '', commits: '' }));
  return { run, commitment, item, person, review };
}

function channelFor(item) {
  if (!item) return 'email';
  return item.source === 'graph_chat' ? 'teams' : 'email';
}

async function compose(runId, { channel = null } = {}) {
  const ctx = await context(runId);
  const chosen = channel || channelFor(ctx.item);

  const prompt = [
    `THE ASK (from ${ctx.person?.display_name || 'the requester'})`,
    ctx.item?.body_text ? truncate(ctx.item.body_text, 3000) : ctx.run.task,
    '',
    'WHAT THE RUN ACTUALLY CHANGED',
    ctx.review.stat || '(no diff recorded)',
    '',
    'COMMITS',
    ctx.review.commits || '(none)',
    '',
    `MERGE REQUEST: ${ctx.run.mr_url || '(none opened)'}`,
    `MODE: ${ctx.run.mode} — ${require('../dispatch/modes').describe(ctx.run.mode)}`,
    '',
    `CHANNEL: ${chosen} (${chosen === 'teams' ? 'a chat message; keep it to a few lines' : 'an email; a short paragraph or two'})`,
  ].join('\n');

  const response = await client().messages.create({
    model: config.anthropic.model,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`model declined to draft: ${response.stop_details?.category || 'unknown'}`);
  }

  const body = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const subject =
    chosen === 'email'
      ? ctx.item?.subject
        ? `Re: ${ctx.item.subject.replace(/^re:\s*/i, '')}`
        : ctx.run.task
      : null;

  const draft = await one(
    `insert into draft (run_id, channel, to_identity, subject, body, status)
     values ($1,$2,$3,$4,$5,'pending') returning *`,
    [runId, chosen, recipientOf(ctx), subject, body]
  );

  log.info('drafted', { run: runId, draft: draft.id, channel: chosen });
  return { draft, context: ctx };
}

function recipientOf(ctx) {
  if (ctx.person?.primary_email) return ctx.person.primary_email;
  if (ctx.item?.source === 'graph_chat') return ctx.item.thread_external_id; // the chat id
  return ctx.item?.author_identity || null;
}

async function get(draftId) {
  return one('select * from draft where id = $1', [draftId]);
}

async function pending(runId = null) {
  return runId
    ? rows(`select * from draft where run_id = $1 order by created_at desc`, [runId])
    : rows(`select * from draft where status = 'pending' order by created_at desc limit 20`);
}

async function edit(draftId, body) {
  await query(`update draft set body = $2, status = 'edited' where id = $1`, [draftId, body]);
  return get(draftId);
}

async function discard(draftId) {
  await query(`update draft set status = 'discarded' where id = $1`, [draftId]);
}

// Sending. Requires scopes the default token does not have — that is the point.
// The error names the remedy rather than surfacing a raw 403.
async function send(draftId) {
  const draft = await get(draftId);
  if (!draft) throw new Error(`no draft #${draftId}`);
  if (draft.status === 'sent') throw new Error(`draft #${draftId} was already sent`);
  if (!draft.to_identity) throw new Error(`draft #${draftId} has no recipient`);

  try {
    if (draft.channel === 'email') {
      await request('/me/sendMail', {
        method: 'POST',
        body: {
          message: {
            subject: draft.subject || '(no subject)',
            body: { contentType: 'Text', content: draft.body },
            toRecipients: [{ emailAddress: { address: draft.to_identity } }],
          },
          saveToSentItems: true,
        },
      });
    } else {
      await request(`/me/chats/${encodeURIComponent(draft.to_identity)}/messages`, {
        method: 'POST',
        body: { body: { contentType: 'text', content: draft.body } },
      });
    }
  } catch (err) {
    if (err.status === 403 || /scope|permission/i.test(err.message)) {
      throw new Error(
        `sending needs a scope the read-only token does not have. Add ` +
          `${draft.channel === 'email' ? 'Mail.Send' : 'ChatMessage.Send'} to PA_GRAPH_SCOPES and run \`pa login\` again.\n` +
          `Underlying error: ${err.message}`
      );
    }
    throw err;
  }

  await query(`update draft set status = 'sent', sent_at = now() where id = $1`, [draftId]);
  log.info('sent', { draft: draftId, channel: draft.channel });
  return true;
}

module.exports = { compose, get, pending, edit, discard, send, context };
