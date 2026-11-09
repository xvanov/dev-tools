'use strict';

// Whether ME is part of a source item, and so whether what it says may become
// memory.
//
// Memory is about ME's working world, but the sources carry far more than
// that: a review requested from a team ME is in brings every teammate's PR,
// a channel brings every other team's thread. Read as memory, those became
// beliefs like "faas-mvproductlibrary-ui adds upload flows on detail pages" —
// a coworker's PR ME never touched, filed as a fact about a project. 8.9k of
// the work stack's 10k claims came from `team_review_requested`
// notifications. So the claims pass reads only items ME is in:
//
//   - ME wrote it (any of ME's identities: GitHub login, email, AAD id, `me`)
//   - on GitHub, GitHub's own record names ME: author, assignee, reviewer
//     requested by name (not through a team), @mentioned by login, a
//     commenter (src/distill/githubGate.ts decides this for commitments too)
//   - a Teams channel post that names ME (a chat ME is in is addressed to ME
//     by construction; every other source is ME's own mailbox, calendar,
//     sessions or microphone)
//   - or it is in a thread where any item passes one of the rules above —
//     a thread ME took part in.
//
// Everything else stays a source item: searchable, citable, context for a
// draft. It just never becomes a claim, so it never reaches a Memory page.
//
// Pure: no I/O. `extract.run` and `prune` load the thread siblings.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Item = {
  id?: unknown;
  source?: string | null;
  thread_external_id?: string | null;
  author_identity?: string | null;
  subject?: string | null;
  body_text?: string | null;
  raw?: Record<string, any> | null;
};
/** Who ME is: the GitHub login, and every identity as source_item.author_identity spells it. */
type Me = { login: string | null; authors: Set<string> };
type Verdict = { ok: boolean; why: string };

const githubGate = require('../distill/githubGate.ts');

// Notification reasons that are about ME without a login to check against.
const PERSONAL_REASONS = new Set(['author', 'assign', 'review_requested', 'mention', 'comment', 'manual', 'state_change']);

/**
 * ME from person_identity rows ({kind, value}) of the is_me person.
 * author_identity is `github:<login>`, `gitlab:<login>`, `aad:<oid>`, a
 * lower-cased email, or `me` for what ME's own tools record.
 */
function meFrom(identities: { kind: string; value: unknown }[] | null | undefined): Me {
  const authors = new Set<string>(['me']);
  let login: string | null = null;
  for (const i of identities || []) {
    const v = String(i.value ?? '').trim();
    if (!v) continue;
    if (i.kind === 'github_username') {
      login = login || v;
      authors.add(`github:${v}`.toLowerCase());
    } else if (i.kind === 'gitlab_username') authors.add(`gitlab:${v}`.toLowerCase());
    else if (i.kind === 'aad_oid') authors.add(`aad:${v}`.toLowerCase());
    else if (i.kind === 'smtp') authors.add(v.toLowerCase());
  }
  return { login, authors };
}

function wroteIt(item: Item, me: Me) {
  const a = String(item.author_identity || '').trim().toLowerCase();
  return !!a && me.authors.has(a);
}

/** The direct rule: whether this one item, on its own, involves ME. */
function direct(item: Item, me: Me): Verdict {
  const raw = item.raw || {};
  if (wroteIt(item, me)) return { ok: true, why: 'yours' };

  if (githubGate.SOURCES.has(item.source)) {
    if (me.login) {
      const inv = githubGate.involvement(item, me.login);
      if (inv.personal) return { ok: true, why: [...inv.roles].join(', ') };
      const reason = item.source === 'github_notification' ? raw.action || 'unknown' : null;
      return { ok: false, why: reason ? `GitHub "${reason}": not you personally` : 'a GitHub item you are not on' };
    }
    // No login yet: judge a notification by its reason, keep the rest.
    if (item.source === 'github_notification') {
      const reason = String(raw.action || '');
      if (reason === 'review_requested' && raw.requestedMe === false) return { ok: false, why: 'review requested from a team' };
      return PERSONAL_REASONS.has(reason) ? { ok: true, why: reason } : { ok: false, why: `GitHub "${reason || 'unknown'}": not you personally` };
    }
    return { ok: true, why: 'GitHub login unknown' };
  }

  if (item.source === 'graph_chat' && raw.chatType === 'channel') {
    return raw.mentionsMe ? { ok: true, why: 'names you' } : { ok: false, why: 'a channel post that does not name you' };
  }
  return { ok: true, why: 'your own mailbox, chats, calendar or sessions' };
}

/**
 * Splits items into those whose content may become memory and those it may not.
 * `siblings`: other items in the same threads (any order, may include `items`);
 * a thread where any item involves ME directly makes all of it ME's.
 * @returns {{keep: Item[], skip: {item: Item, why: string}[]}}
 */
function partition(items: Item[], me: Me, siblings: Item[] = []) {
  const threads = new Set<string>();
  for (const s of [...siblings, ...items]) {
    const key = threadKey(s);
    if (key && direct(s, me).ok) threads.add(key);
  }
  const keep: Item[] = [];
  const skip: { item: Item; why: string }[] = [];
  for (const item of items) {
    const v = direct(item, me);
    if (v.ok) keep.push(item);
    else if (threadKey(item) && threads.has(threadKey(item) as string)) keep.push(item);
    else skip.push({ item, why: v.why });
  }
  return { keep, skip };
}

// GitHub's sources share threads (a PR's notification and the PR itself
// carry the same html_url); every other source threads only within itself.
// A GitHub notification with no PR or issue falls back to the repository's
// URL, which is not a conversation: being in one PR does not make the
// whole repository yours.
function threadKey(item: Item): string | null {
  const t = item.thread_external_id;
  if (!t) return null;
  const github = String(item.source || '').startsWith('github');
  if (github && !/\/(pull|issues)\/\d+/.test(t)) return null;
  return `${github ? 'github' : item.source}|${t}`;
}

module.exports = { meFrom, direct, partition, threadKey };
