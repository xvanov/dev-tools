'use strict';

// The Plan tab's "Pages" card: every Jarvis page (src/pages) with its progress
// bar, percent, what is being worked on, and a link to open it. Read-only:
// GET api/pages (relative, so termhub's /pa/ works), refreshed every 30 s.
// Self-contained: one <script src="pages.list.js"> in index.html; the card goes
// in <main id="today"> after "On me". Hidden while there are no pages. Text
// only - no HTML sinks.

(function () {
  const STYLE = `
#pages-card[hidden] { display: none; }
#pages-card .pg-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 8px 0; border-top: 1px solid var(--line, #d9dce1); }
#pages-card .pg-row:first-child { border-top: 0; }
#pages-card .pg-title { font-weight: 600; }
#pages-card .pg-pct { font-variant-numeric: tabular-nums; }
#pages-card .pg-bar { grid-column: 1 / -1; height: 6px; border-radius: 3px; background: var(--line, #e3e5e8); overflow: hidden; }
#pages-card .pg-bar > span { display: block; height: 100%; background: var(--ok, #1f8a4c); }
#pages-card .pg-meta { grid-column: 1 / -1; font-size: 12px; opacity: 0.8; }`;

  let card = null;

  function el(tag, props, kids) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const k of kids || []) e.append(k);
    return e;
  }

  function ensureCard() {
    if (card) return card;
    const main = document.getElementById('today');
    if (!main) return null;
    document.head.append(el('style', { textContent: STYLE }));
    const list = el('div', { className: 'list' });
    const count = el('span', { className: 'n' });
    const summary = el('summary', {}, [el('h2', { textContent: 'Pages', title: 'Plans with a map and a task list, kept in step with your cards (pa page). Each opens here and can be published to claude.ai.' }), count]);
    const details = el('details', {}, [summary, el('div', { className: 'psec-body' }, [list])]);
    details.open = true;
    details.dataset.fold = 'pages';
    card = el('section', { id: 'pages-card', className: 'psec', hidden: true }, [details]);
    card._list = list;
    card._count = count;
    const after = document.getElementById('onme');
    if (after && after.parentNode === main) after.after(card);
    else main.prepend(card);
    return card;
  }

  function row(p) {
    const pr = p.progress || { percent: 0, done: 0, total: 0, doing: [] };
    const fill = el('span');
    fill.style.width = Math.max(0, Math.min(100, Number(pr.percent) || 0)) + '%';
    const link = el('a', { className: 'pg-title', href: 'pages/' + encodeURIComponent(p.slug), textContent: p.title || p.slug });
    const meta = [pr.done + '/' + pr.total + ' done'];
    if (pr.doing && pr.doing.length) meta.push('working on: ' + pr.doing.join(' · '));
    if (p.project) meta.push('project ' + p.project);
    if (p.publishedUrl) meta.push('published');
    if (p.error) meta.push('error: ' + p.error);
    const kids = [link, el('span', { className: 'pg-pct', textContent: pr.percent + '%' }), el('div', { className: 'pg-bar' }, [fill]), el('div', { className: 'pg-meta', textContent: meta.join(' · ') })];
    if (p.publishedUrl && /^https:\/\/claude\.ai\//.test(p.publishedUrl)) {
      kids[3].append(' · ', el('a', { href: p.publishedUrl, target: '_blank', rel: 'noopener noreferrer', textContent: 'claude.ai copy' }));
    }
    return el('div', { className: 'pg-row' }, kids);
  }

  async function load() {
    const c = ensureCard();
    if (!c) return;
    try {
      const r = await fetch('api/pages', { cache: 'no-store' });
      if (!r.ok) return;
      const { pages } = await r.json();
      c._list.replaceChildren(...(pages || []).map(row));
      c._count.textContent = pages && pages.length ? String(pages.length) : '';
      c.hidden = !(pages && pages.length);
    } catch {
      /* the next tick tries again */
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
  setInterval(load, 30000);
})();
