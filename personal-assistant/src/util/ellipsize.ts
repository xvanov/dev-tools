'use strict';

// Short one-line labels for cards and notifications: a long title cut to a
// fixed width with a trailing ellipsis.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

function ellipsize(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '…';
}

module.exports = { ellipsize };
