'use strict';

// Short one-line labels for cards and notifications: a long title cut to a
// fixed width with a trailing ellipsis.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

function ellipsize(text: string, limit: number): string {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new RangeError('limit must be an integer ≥ 1');
  }
  if (text.length <= limit) return text;
  // The ellipsis takes one of the `limit` characters, so the result is exactly `limit` long.
  return text.slice(0, limit - 1) + '…';
}

module.exports = { ellipsize };
