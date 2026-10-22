'use strict';

// Memory pages are markdown a model wrote from mail and chat — text other
// people chose. So the dashboard never turns them into an HTML string. This
// parses the small subset pages use into a plain tree of blocks and inline
// tokens, and the page builds DOM from it with textContent. A tag in a page
// is shown as the characters it is; there is no path from page text to markup.
//
//   blocks:  {t:'h', level, kids} {t:'p', kids} {t:'ul'|'ol', items:[{depth, kids}]}
//            {t:'pre', text} {t:'quote', kids} {t:'hr'}
//   inline:  {t:'text', v} {t:'code', v} {t:'b'|'i', kids} {t:'link', href, kids}
//            {t:'ref', id}   — a cited item, [#123]; the page links it to the item view

const MAX = 200_000;

function pushText(out, v) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.v += v;
  else out.push({ t: 'text', v });
}

// A bracketed citation: [#12], [#12, #34], [#note]. Ids become refs; anything
// else in the brackets stays text.
function citation(inner, out) {
  pushText(out, '[');
  const parts = inner.split(/(#\d+)/);
  for (const p of parts) {
    const m = p.match(/^#(\d+)$/);
    if (m) out.push({ t: 'ref', id: Number(m[1]) });
    else pushText(out, p);
  }
  pushText(out, ']');
}

const INLINE = new RegExp(
  [
    '`([^`\\n]+)`', // 1 code
    '\\*\\*([^*\\n]+?)\\*\\*', // 2 bold
    '__([^_\\n]+?)__', // 3 bold
    '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)', // 4,5 link
    '\\[(#[^\\]\\n]*)\\]', // 6 citation
    '(?<![\\w*])\\*([^*\\s][^*\\n]*?)\\*(?!\\w)', // 7 italic
    '(?<!\\w)_([^_\\s][^_\\n]*?)_(?!\\w)', // 8 italic
  ].join('|'),
  'g'
);

function parseInline(text, depth = 0) {
  const s = String(text ?? '');
  const out = [];
  let at = 0;
  const re = new RegExp(INLINE.source, 'g');
  let m;
  while ((m = re.exec(s))) {
    pushText(out, s.slice(at, m.index));
    at = m.index + m[0].length;
    const nest = (v) => (depth < 2 ? parseInline(v, depth + 1) : [{ t: 'text', v }]);
    if (m[1] != null) out.push({ t: 'code', v: m[1] });
    else if (m[2] != null || m[3] != null) out.push({ t: 'b', kids: nest(m[2] ?? m[3]) });
    else if (m[4] != null) {
      // Only web links. A javascript: or data: URL in a page is shown as text.
      if (/^https?:\/\/[^\s]+$/i.test(m[5])) out.push({ t: 'link', href: m[5], kids: nest(m[4]) });
      else pushText(out, m[0]);
    } else if (m[6] != null) citation(m[6], out);
    else if (m[7] != null || m[8] != null) out.push({ t: 'i', kids: nest(m[7] ?? m[8]) });
  }
  pushText(out, s.slice(at));
  // Bare citations outside brackets ("see #123") are left as text: a "#1" in
  // prose is too often not an item.
  return out;
}

function parseMarkdown(md) {
  const lines = String(md ?? '').slice(0, MAX).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  let quote = [];

  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', kids: parseInline(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ t: 'quote', kids: parseInline(quote.join(' ')) });
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flushAll();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      blocks.push({ t: 'pre', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flushAll();
      blocks.push({ t: 'h', level: h[1].length, kids: parseInline(h[2]) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      blocks.push({ t: 'hr' });
      continue;
    }
    const q = line.match(/^\s{0,3}>\s?(.*)$/);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      flushQuote();
      const type = /\d/.test(li[2]) ? 'ol' : 'ul';
      const depth = Math.min(4, Math.floor(li[1].replace(/\t/g, '  ').length / 2));
      if (!list || (list.t !== type && depth === 0)) {
        flushList();
        list = { t: type, items: [] };
      }
      list.items.push({ depth, kids: parseInline(li[3]) });
      continue;
    }
    // A continuation line of a list item joins it; anything else is prose.
    if (list && /^\s+\S/.test(line)) {
      const last = list.items[list.items.length - 1];
      last.kids = parseInline(`${inlineText(last.kids)} ${line.trim()}`);
      continue;
    }
    flushList();
    flushQuote();
    para.push(line.trim());
  }
  flushAll();
  return blocks;
}

// The plain text of an inline tree (citations as "[#id]" are dropped).
function inlineText(kids) {
  return (kids || [])
    .map((k) => (k.t === 'text' || k.t === 'code' ? k.v : k.t === 'ref' ? `#${k.id}` : inlineText(k.kids)))
    .join('');
}

// One line to show next to a page's title in a list: the first line of prose
// under the heading, citations and markup stripped.
function pageSummary(body, max = 160) {
  for (const b of parseMarkdown(body)) {
    if (b.t === 'h' || b.t === 'hr' || b.t === 'pre') continue;
    const kids = b.t === 'ul' || b.t === 'ol' ? b.items[0]?.kids : b.kids;
    const text = inlineText(kids)
      .replace(/\s*\[[#\d,\s]*(note)?\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }
  return '';
}

module.exports = { parseMarkdown, parseInline, inlineText, pageSummary };
