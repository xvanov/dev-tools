'use strict';

// Turning source payloads into the plain text everything downstream reads.
//
// Mail and Teams messages arrive as HTML. A real HTML parser is not warranted
// here: the consumers are an LLM and a full-text index, both of which want the
// words and neither of which wants the markup. What *does* matter is that
// block elements become line breaks — losing them glues the end of one
// paragraph to the start of the next, and quoted-reply detection downstream
// depends on lines.

const crypto = require('crypto');

const BLOCK = /<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article)\s*>/gi;

function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

// Long quoted trails are most of the bytes in a mail thread and none of the
// signal — the quoted text is already its own source_item. Cut at the first
// marker, but only if enough survives to be worth keeping.
const QUOTE_MARKERS = [
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*From:.*\n\s*Sent:/im,
  /^\s*On .{5,80} wrote:\s*$/im,
  /^\s*_{10,}\s*$/m,
];

function stripQuoted(text) {
  if (!text) return '';
  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const head = text.slice(0, cut).trim();
  return head.length >= 40 ? head : text.trim();
}

function contentHash(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(String(p ?? ''), 'utf8');
  return h.digest('hex').slice(0, 32);
}

// Chunks for retrieval. Paragraph-aware, with a small overlap so a sentence
// spanning a boundary is still findable from either side.
function chunkText(text, { size = 1200, overlap = 150 } = {}) {
  const clean = (text || '').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks = [];
  const paragraphs = clean.split(/\n{2,}/);
  let current = '';

  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > size) {
      chunks.push(current.trim());
      current = current.slice(Math.max(0, current.length - overlap));
    }
    current += (current ? '\n\n' : '') + para;
    while (current.length > size) {
      chunks.push(current.slice(0, size).trim());
      current = current.slice(size - overlap);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

module.exports = { htmlToText, stripQuoted, contentHash, chunkText, truncate };
