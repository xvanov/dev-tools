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

const { one, query, withTx } = require('../db');

function parseIdentity(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value === 'me') return { kind: 'self', value: 'me' };
  if (value.startsWith('aad:')) return { kind: 'aad_oid', value: value.slice(4) };
  if (value.startsWith('gitlab:')) return { kind: 'gitlab_username', value: value.slice(7) };
  if (value.startsWith('github:')) return { kind: 'github_username', value: value.slice(7) };
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

// Binds an account handle to the `is_me` person, creating that person if no
// sign-in has yet (GitHub may well be the first source to run). An earlier
// pass that already filed the handle as a stranger is merged back, so "who"
// stops naming you as the person you owe.
async function claimForMe(kind, value, { displayName, email } = {}) {
  const meId = (await me())?.id || (await setMe({ displayName, email }));
  const owner = await one('select person_id from person_identity where kind = $1 and value = $2', [kind, value]);
  if (owner && String(owner.person_id) !== String(meId)) await merge(meId, owner.person_id);
  else if (!owner) await addIdentity(meId, kind, value);
  return meId;
}

// Merges `fromId` into `intoId`. Manual (the dashboard's Merge, or claimForMe
// for your own handles), because it is the one operation here that can destroy
// information, and it should be a decision you made.
//
// Everything that points at a person moves with it: identities, commitments,
// and memory — claims about `fromId` become claims about `intoId` (or about
// `me`, when merging into yourself), so a merge never strands what was learnt
// under a person id that no longer exists. The merged-away page is deleted;
// it is derived, and the caller regenerates the survivor's (memory.mergePeople).
// The survivor keeps its own name unless it only had a handle and the other
// had a real one.
async function merge(intoId, fromId) {
  if (String(intoId) === String(fromId)) return { claims: 0 };
  return withTx(async (tx) => {
    const both = await tx.query('select * from person where id = any($1::bigint[])', [[intoId, fromId]]);
    const into = both.rows.find((p) => String(p.id) === String(intoId));
    const from = both.rows.find((p) => String(p.id) === String(fromId));
    if (!into || !from) throw new Error('no such person');
    if (from.is_me) throw new Error('cannot merge yourself away; merge the other person into you');

    await tx.query('update person_identity set person_id = $1 where person_id = $2', [intoId, fromId]);
    await tx.query('update commitment set counterparty_person_id = $1 where counterparty_person_id = $2', [
      intoId,
      fromId,
    ]);

    const name = !looksHuman(into.display_name) && looksHuman(from.display_name) ? from.display_name : into.display_name;
    const moved = into.is_me
      ? await tx.query(
          `update claim set subject_kind = 'me', subject_id = $1, subject_label = 'me'
            where subject_kind = 'person' and subject_id = $2`,
          [intoId, fromId]
        )
      : await tx.query(
          `update claim set subject_id = $1, subject_label = $3 where subject_kind = 'person' and subject_id = $2`,
          [intoId, fromId, name]
        );
    await tx.query(`delete from memory_page where kind = 'person' and subject_id = $1`, [fromId]);
    await tx.query('delete from person where id = $1', [fromId]);
    // After the delete: primary_email is unique, and the two may share it.
    await tx.query('update person set display_name = $2, primary_email = coalesce(primary_email, $3) where id = $1', [
      intoId,
      name,
      from.primary_email,
    ]);
    return { claims: moved.rowCount, isMe: into.is_me };
  });
}

// A display name a human would write, rather than an address or a handle.
function looksHuman(name) {
  return /\s/.test(String(name || '').trim()) && !/@|^(github|gitlab|aad):/i.test(String(name));
}

module.exports = { resolve, me, setMe, addIdentity, claimForMe, merge, parseIdentity, looksHuman };
