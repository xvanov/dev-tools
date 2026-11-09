'use strict';

// DO NOT MERGE. Dummy for the review-fix acceptance run (plan 8.3).
// Not used by the product. Two deliberate flaws, called out in the PR review.

// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

function clipLabel(text: string, limit: number): string {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`clipLabel: limit must be an integer >= 1, got ${limit}`);
  }
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit - 1) + '…';
}

module.exports = { clipLabel };
