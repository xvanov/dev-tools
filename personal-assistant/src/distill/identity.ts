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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const repo = require('../repo');

function parseIdentity(raw: any) {
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
  return repo.people.meRow();
}

// Your own handle of one kind (`github_username`), or null before that
// source has signed in and claimed it.
async function myHandle(kind: any) {
  const r = await repo.people.myHandle(kind);
  return r?.value || null;
}

async function setMe({ displayName, email }: { displayName?: any | null; email?: any | null }) {
  const existing = await me();
  if (existing) {
    await repo.people.setNames(
      existing.id,
      displayName || existing.display_name,
      (email || existing.primary_email || '').toLowerCase() || null
    );
    if (email) await addIdentity(existing.id, 'smtp', email.toLowerCase());
    return existing.id;
  }
  const row = await repo.people.insertMe(displayName || 'me', (email || '').toLowerCase() || null);
  if (email) await addIdentity(row.id, 'smtp', email.toLowerCase());
  return row.id;
}

async function addIdentity(personId: any, kind: any, value: any) {
  await repo.people.addIdentity(personId, kind, value);
}

// Resolves an identity string to a person, creating one when it is genuinely
// new. `displayName` is used only for the label on a newly created row — never
// to match an existing one.
async function resolve(rawIdentity: any, displayName: any) {
  const parsed = parseIdentity(rawIdentity);
  if (!parsed) return null;

  if (parsed.kind === 'self') {
    const self = await me();
    return self ? self.id : null;
  }

  if (parsed.kind === 'display_name') {
    // A bare name is not an identity. Match one only if it is unambiguous.
    const hits = await repo.people.byDisplayName(parsed.value);
    return hits.length === 1 ? hits[0].id : null;
  }

  const found = await repo.people.identityOwner(parsed.kind, parsed.value);
  if (found) {
    await healName(found.person_id, parsed, displayName);
    return found.person_id;
  }

  // An email we have not seen as an identity may still belong to a person whose
  // primary_email matches — that happens when the person row came from a
  // calendar attendee list before any message arrived.
  if (parsed.kind === 'smtp') {
    const byEmail = await repo.people.byPrimaryEmail(parsed.value);
    if (byEmail) {
      await addIdentity(byEmail.id, 'smtp', parsed.value);
      return byEmail.id;
    }
  }

  const created = await repo.people.insert(nameFor(parsed, displayName), parsed.kind === 'smtp' ? parsed.value : null);
  await addIdentity(created.id, parsed.kind, parsed.value);
  return created.id;
}

// "shane.govenor@innergy.com" -> "Shane Govenor"; null unless it is first.last.
function nameFromEmail(email: any) {
  const m = /^([a-z]{2,})[._]([a-z]{2,})@/i.exec(String(email || ''));
  return m ? [m[1], m[2]].map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') : null;
}

// The label for a new person. The Teams cache gives an author's address and no
// name, and a card must not name its asker as a bare address.
function nameFor(parsed: any, displayName: any) {
  if (looksHuman(displayName)) return displayName;
  return (parsed.kind === 'smtp' && nameFromEmail(parsed.value)) || displayName || parsed.value;
}

// A person filed under a bare address gets a human name once one is known.
async function healName(personId: any, parsed: any, displayName: any) {
  const row = await repo.people.rowById(personId);
  if (!row || row.is_me || looksHuman(row.display_name)) return;
  const name = nameFor(parsed, displayName);
  if (looksHuman(name)) await repo.people.renameKeepingEmail(personId, name, row.primary_email);
}

// Binds an account handle to the `is_me` person, creating that person if no
// sign-in has yet (GitHub may well be the first source to run). An earlier
// pass that already filed the handle as a stranger is merged back, so "who"
// stops naming you as the person you owe.
async function claimForMe(kind: any, value: any, { displayName, email }: { displayName?: any | null; email?: any | null } = {}) {
  const meId = (await me())?.id || (await setMe({ displayName, email }));
  const owner = await repo.people.identityOwner(kind, value);
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
async function merge(intoId: any, fromId: any) {
  if (String(intoId) === String(fromId)) return { claims: 0 };
  return repo.withTx(async (r: any) => {
    const both = await r.people.pair(intoId, fromId);
    const into = both.find((p: any) => String(p.id) === String(intoId));
    const from = both.find((p: any) => String(p.id) === String(fromId));
    if (!into || !from) throw Object.assign(new Error('no such person'), { status: 404 });
    if (from.is_me) {
      throw Object.assign(new Error('cannot merge yourself away; merge the other person into you'), { status: 409 });
    }

    await r.people.moveIdentities(intoId, fromId);
    await r.commitments.reassignCounterparty(intoId, fromId);

    const name = !looksHuman(into.display_name) && looksHuman(from.display_name) ? from.display_name : into.display_name;
    const moved = into.is_me ? await r.memory.repointClaimsToMe(intoId, fromId) : await r.memory.repointClaims(intoId, fromId, name);
    await r.memory.deletePersonPage(fromId);
    await r.people.deleteById(fromId);
    // After the delete: primary_email is unique, and the two may share it.
    await r.people.renameKeepingEmail(intoId, name, from.primary_email);
    return { claims: moved, isMe: into.is_me };
  });
}

// A display name a human would write, rather than an address or a handle.
function looksHuman(name: any) {
  return /\s/.test(String(name || '').trim()) && !/@|^(github|gitlab|aad):/i.test(String(name));
}

module.exports = { nameFromEmail, nameFor, resolve, me, myHandle, setMe, addIdentity, claimForMe, merge, parseIdentity, looksHuman };
