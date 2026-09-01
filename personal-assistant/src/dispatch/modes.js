'use strict';

// Dispatch modes, and the enforcement that makes them mean something.
//
// The mode is chosen per task, never globally — some asks want a branch and an
// MR, some want a scratch change you look at first. What is *not* negotiable is
// that the boundary is enforced by the dispatcher rather than requested of the
// agent: a stop condition written as a sentence in a prompt is a suggestion, and
// this one has to hold on the bad day when the agent misreads it.
//
// So a `local` run's worktree gets a pushurl pointing at a dead address. The
// agent can commit all it likes; `git push` fails with a clear message, and the
// dispatcher restores the real URL only when `pa land` decides the run has
// earned it.

const MODES = {
  plan: {
    order: 0,
    mayCommit: false,
    mayPush: false,
    mayOpenMr: false,
    mayDraftReply: false,
    stopCondition: 'Write the plan and a sketch of the diff. Do not modify any file.',
  },
  local: {
    order: 1,
    mayCommit: true,
    mayPush: false,
    mayOpenMr: false,
    mayDraftReply: false,
    stopCondition:
      'Work in this worktree and commit locally. Do not push and do not open a merge request — pushing is blocked and will fail.',
  },
  branch: {
    order: 2,
    mayCommit: true,
    mayPush: true,
    mayOpenMr: false,
    mayDraftReply: false,
    stopCondition: 'Commit and push the branch. Do not open a merge request.',
  },
  mr: {
    order: 3,
    mayCommit: true,
    mayPush: true,
    mayOpenMr: true,
    mayDraftReply: false,
    stopCondition:
      'Commit, push, and open a DRAFT merge request. Do not mark it ready and do not notify anyone.',
  },
  full: {
    order: 4,
    mayCommit: true,
    mayPush: true,
    mayOpenMr: true,
    mayDraftReply: true,
    stopCondition:
      'Commit, push, open a DRAFT merge request, and write a short reply to the requester into REPLY.md. Do not send anything.',
  },
};

const DEFAULT_MODE = 'local';

function isMode(name) {
  return Object.prototype.hasOwnProperty.call(MODES, name);
}

function mode(name) {
  const key = String(name || DEFAULT_MODE).toLowerCase();
  if (!isMode(key)) {
    throw new Error(`unknown mode "${name}" — one of: ${Object.keys(MODES).join(', ')}`);
  }
  return { name: key, ...MODES[key] };
}

// Sending is never a mode. `full` drafts a reply into the worktree; `pa send`
// is a separate, interactive act by a human.
function describe(name) {
  const m = mode(name);
  const can = [];
  if (m.mayCommit) can.push('commit');
  if (m.mayPush) can.push('push');
  if (m.mayOpenMr) can.push('open a draft MR');
  if (m.mayDraftReply) can.push('draft a reply');
  return can.length ? can.join(', ') : 'read and plan only';
}

module.exports = { MODES, DEFAULT_MODE, mode, isMode, describe };
