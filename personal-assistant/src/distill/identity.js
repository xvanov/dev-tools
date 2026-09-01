'use strict';

// Identity resolution: one human, many spellings.
//
// The same colleague is an SMTP address in Outlook, an AAD object id in Teams,
// a `gitlab:username` in GitLab and a display name in a meeting transcript.
// Every distilled row points at a `person`, so this is the join that makes
// "what did they ask me this week" answerable at all.
//
// The merge rule is deliberately conservative: identities are matched on exact
// identifier, or on an email match, and never on display name alone. Two people
// called "Alex" merged into one is a data-loss bug you find out about by
// sending the wrong person a message.

const { one, query } = require('../db');

function parseIdentity(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value === 'me') return { kind: 'self', value: 'me' };
  if (value.startsWith('aad:')) return { kind: 'aad_oid', value: value.slice(4) };
  if (value.startsWith('gitlab:')) return { kind: 'gitlab_username', value: value.slice(7) };
  if (value.includes('@')) return { kind: 'smtp', value: value.toLowerCase() };
  return { kind: 'display_name', value };
}

async function me() {
  return one('select * from person where is_me limit 1');
}

async function setMe({ displayName, email }) {
  const existing = await me();
  if (existing) {
    await query('update person set display_name = $2, primary_email = $3 where id = $1', [
      existing.id,
      displayName || existing.display_name,
      (email || existing.primary_email || '').toLowerCase() || null,
    ]);
    if (email) await addIdentity(existing.id, 'smtp', email.toLowerCase());
    return existing.id;
  }
  const row = await one(
    'insert into person (display_name, primary_email, is_me) values ($1,$2,true) returning id',
    [displayName || 'me', (email || '').toLowerCase() || null]
  );
  if (email) await addIdentity(row.id, 'smtp', email.toLowerCase());
  return row.id;
}

async function addIdentity(personId, kind, value) {
  await query(
    'insert into person_identity (person_id, kind, value) values ($1,$2,$3) ' +
      'on conflict (kind, value) do nothing',
    [personId, kind, value]
  );
}

// Resolves an identity string to a person, creating one when it is genuinely
// new. `displayName` is used only for the label on a newly created row — never
// to match an existing one.
async function resolve(rawIdentity, displayName) {
  const parsed = parseIdentity(rawIdentity);
  if (!parsed) return null;

  if (parsed.kind === 'self') {
    const self = await me();
    return self ? self.id : null;
  }

  if (parsed.kind === 'display_name') {
    // A bare name is not an identity. Match one only if it is unambiguous.
    const hits = await query(
      'select id from person where lower(display_name) = lower($1) limit 2',
      [parsed.value]
    );
    return hits.rows.length === 1 ? hits.rows[0].id : null;
  }

  const found = await one('select person_id from person_identity where kind = $1 and value = $2', [
    parsed.kind,
    parsed.value,
  ]);
  if (found) return found.person_id;

  // An email we have not seen as an identity may still belong to a person whose
  // primary_email matches — that happens when the person row came from a
  // calendar attendee list before any message arrived.
  if (parsed.kind === 'smtp') {
    const byEmail = await one('select id from person where lower(primary_email) = $1', [
      parsed.value,
    ]);
    if (byEmail) {
      await addIdentity(byEmail.id, 'smtp', parsed.value);
      return byEmail.id;
    }
  }

  const created = await one(
    'insert into person (display_name, primary_email) values ($1,$2) returning id',
    [displayName || parsed.value, parsed.kind === 'smtp' ? parsed.value : null]
  );
  await addIdentity(created.id, parsed.kind, parsed.value);
  return created.id;
}

// Merges `fromId` into `intoId`. Manual, because it is the one operation here
// that can destroy information, and it should be a decision you typed.
async function merge(intoId, fromId) {
  if (intoId === fromId) return;
  await query('update person_identity set person_id = $1 where person_id = $2', [intoId, fromId]);
  await query('update commitment set counterparty_person_id = $1 where counterparty_person_id = $2', [
    intoId,
    fromId,
  ]);
  await query('delete from person where id = $1', [fromId]);
}

module.exports = { resolve, me, setMe, addIdentity, merge, parseIdentity };
