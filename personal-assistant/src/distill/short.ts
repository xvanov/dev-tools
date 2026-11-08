'use strict';

// Short messages addressed to you (plan 8.4.36). Distill reads nothing under
// MIN_BODY_CHARS (40), which kept "ok" and "thanks" away from the model but
// also every short ask on Teams ("can you check?", "ping me when it's up").
// A 1:1 chat, the self chat or a message that mentions you is read from
// DIRECT_MIN_CHARS instead, and one that is only a courtesy ("thank you so
// much!", "sounds good", "approved", your name and a ^) is marked done here
// without a model call. A question is never a courtesy: it may be the ask.
// Eval set: src/eval/short-asks-cases.json (test/distillShort.test.js).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const DIRECT_MIN_CHARS = 6;
// A short message older than this stays unread, as before: lowering the bar
// must not send a backlog of old one-liners to the model in one go.
const DIRECT_WINDOW_MS = 7 * 24 * 3600_000;

const COURTESY = new Set(
  `thanks thank thx ty tysm tyvm cheers you u ya so very much lot a appreciate appreciated really
   i ok okay k kk cool great nice good awesome perfect excellent sounds sound yes yeah yep yup sure
   no nope worries problem np got it gotcha noted ack approved done lgtm agreed hi hello hey
   morning afternoon evening night welcome and all the for your help helps helped this that worked works lol haha
   oh ah wow`
    .split(/\s+/)
    .filter(Boolean)
);
const THANKS = new Set(['thanks', 'thank', 'thx', 'ty', 'tysm', 'tyvm', 'cheers']);

function words(text: string) {
  return text.match(/[\p{L}\p{N}'’]+/gu) || [];
}

/**
 * True when `text` says nothing but a courtesy. `names` are the owner's names
 * (a mention reads as the name); after a thank-you, any capitalised word is
 * taken for a name ("thanks Person A and Person B").
 */
function courtesy(text: unknown, names: string[] = []) {
  const s = String(text ?? '').trim();
  if (s.includes('?')) return false;
  const mine = new Set(names.flatMap((n) => words(String(n || '').toLowerCase())));
  const raw = words(s);
  if (!raw.length) return true;
  let thanked = false;
  for (const w of raw) {
    const lw = w.toLowerCase().replace(/['’]/g, '');
    if (mine.has(w.toLowerCase())) continue;
    if (thanked && /^\p{Lu}/u.test(w)) continue;
    if (!COURTESY.has(lw)) return false;
    if (THANKS.has(lw)) thanked = true;
  }
  return true;
}

/** Why a short message is skipped without a model call, or null to distill it. */
function skip(item: { body_text?: unknown }, names: string[], minChars: number) {
  const body = String(item.body_text ?? '');
  if ([...body].length >= minChars) return null;
  return courtesy(body, names) ? 'a short courtesy, not an ask' : null;
}

/** The pendingDistill option for short direct messages, as of `now`. */
function direct(now: number = Date.now()) {
  return { minChars: DIRECT_MIN_CHARS, since: new Date(now - DIRECT_WINDOW_MS).toISOString() };
}

module.exports = { DIRECT_MIN_CHARS, DIRECT_WINDOW_MS, courtesy, skip, direct };
