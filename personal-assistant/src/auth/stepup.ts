'use strict';

// Step-up for high-risk approvals (plan 7.1, DESIGN "Approvals"): a merge, a
// push to main and a secret reveal need a FRESH passkey assertion bound to
// that exact approval id, on top of whatever the policy engine (4.3) decides.
// The assertion is made in the dashboard (POST /api/auth/stepup/verify) and
// recorded by src/repo/passkeys.js; nothing else writes a grant, so a voice
// turn, an MCP call or an agent cannot produce one. The policy engine calls
// hasStepUp() when an approval for one of these kinds would resolve to allow.
//
// With PA_PASSKEYS off nothing here applies: requiresStepUp() is false and the
// approval path is whatever it was before.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Repos = Record<string, any>;

const { enabled } = require('./settings.ts');

/** The approval kinds that always need a passkey tap. */
const HIGH_RISK = new Set(['merge', 'push_main', 'secret_reveal']);

/** Whether an approval of `kind` needs a passkey step-up right now. */
function requiresStepUp(kind: string) {
  return enabled() && HIGH_RISK.has(String(kind));
}

/**
 * Whether `approvalId` has a live step-up grant. Pass `consume: true` at the
 * moment the action runs: the grant is then used up, and a second action with
 * the same approval id needs a new tap. Without it the grant is only looked at
 * (so a policy preview does not burn it).
 *
 * @param {string} approvalId
 * @param {{repos?: object, now?: Date, consume?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function hasStepUp(approvalId: number | string, { repos, now = new Date(), consume = false }: { repos?: Repos | undefined; now?: Date | null | undefined; consume?: boolean } = {}) {
  if (!approvalId || typeof approvalId !== 'string') return { ok: false, reason: 'no approval id' };
  const r = repos || require('../repo');
  const ok = consume ? await r.passkeys.consumeStepUp(approvalId, now) : await r.passkeys.hasStepUp(approvalId, now);
  return ok ? { ok: true, reason: 'passkey step-up' } : { ok: false, reason: 'needs a fresh passkey assertion for this approval' };
}

const KIND_BY_DELIVERY: Record<string, string> = { auto_merge: 'merge', push_to_main: 'push_main' };

/**
 * The dashboard's own gate for the two delivery levels that run with no human
 * step after them (auto_merge, push_to_main), used where a card is accepted and
 * a factory job is created. `approvalId` is built by the SERVER from the exact
 * thing being approved (never taken from the request), so a tap made for one
 * card or job cannot be spent on another.
 *
 * @returns {Promise<null | {status: number, body: object}>} null to go ahead
 *   (the grant is used up); else the refusal to send, which tells the page
 *   which approval id to ask a passkey tap for (paAuth.stepUp) before retrying.
 */
async function demandForDelivery(level: string, approvalId: number | string, { repos, now }: { repos?: Repos | undefined; now?: Date | null | undefined } = {}) {
  const kind = KIND_BY_DELIVERY[level];
  if (!kind || !requiresStepUp(kind)) return null;
  const r = await hasStepUp(approvalId, { repos, now, consume: true });
  if (r.ok) return null;
  return {
    status: 403,
    body: { error: `this ${level === 'push_to_main' ? 'pushes to main' : 'merges automatically'}: tap your passkey to approve it`, needsStepUp: true, approvalId, kind },
  };
}

/**
 * The JSON body for an error a dashboard route sends: {error}, and when the
 * policy engine (or demandForDelivery) refused an approval only for want of a
 * passkey tap, 
eedsStepUp and the pprovalId to ask the tap for, which is
 * what makes the page show "Approve with passkey" instead of a dead end.
 */
function errorBody(err: any) {
  const body: { error: string; needsStepUp?: boolean; approvalId?: string } = { error: String(err && err.message || err) };
  if (err && err.needsStepUp && typeof err.approvalId === 'string') {
    body.needsStepUp = true;
    body.approvalId = err.approvalId;
  }
  return body;
}

module.exports = { HIGH_RISK, requiresStepUp, hasStepUp, demandForDelivery, errorBody, enabled };
