'use strict';
// The Repos tab: every repo you work in (the registry, src/repos), newest
// activity first — what it is, where it lives, your latest PRs and branches —
// and a detail view per repo at #repos/<name>.
//
// Self-contained on purpose: the main board (index.html) is being reworked
// separately, so this file brings its own helpers, styles and view, and
// touches the page only through three things: the `#tab-repos` link, a
// `repos-on` class on <body> that hides the other views in `.jmain` while this
// tab is open, and its own `#repos-view` element. Everything is inside one function
// scope, so nothing here can collide with the page's globals
// (test/dashboard.test.js). Every value goes in through textContent — no
// HTML sinks.

(function reposTab() {
  const S = { list: null, detail: null, filter: '', all: false, loading: false };

  const style = document.createElement('style');
  style.textContent = `
  body.repos-on .jmain > *:not(#repos-view) { display: none !important; }
  #repos-view { max-width: 1100px; margin: 0 auto; padding: 20px var(--gutter, 16px) 40px; }
  #repos-view .rp-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0 12px; }
  #repos-view .rp-bar input[type=search] { flex: 1 1 220px; font: inherit; font-size: 13px; padding: 4px 8px;
    border: 1px solid var(--line, #ddd); border-radius: 6px; background: var(--panel, #fff); color: var(--ink, #111); }
  #repos-view .rp-meta { color: var(--muted, #666); font-size: 12px; }
  #repos-view .rp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 480px), 1fr)); gap: 12px; }
  #repos-view .rp-card { background: var(--panel, #fff); border: 1px solid var(--line, #ddd); border-radius: 10px; padding: 12px 14px; min-width: 0; }
  #repos-view .rp-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  #repos-view .rp-name { font-weight: 600; font-size: 15px; color: var(--ink, #111); text-decoration: none; }
  #repos-view .rp-name:hover { text-decoration: underline; }
  #repos-view a { color: var(--accent, #2f5bd3); text-decoration: none; overflow-wrap: anywhere; }
  #repos-view .rp-desc { margin: 6px 0; font-size: 13px; line-height: 1.45; }
  #repos-view .rp-chips { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0; }
  #repos-view .rp-chip { background: var(--chip, #eee); color: var(--muted, #666); border-radius: 999px; padding: 1px 8px; font-size: 11px; }
  #repos-view .rp-sec { margin-top: 8px; }
  #repos-view .rp-sec h4 { margin: 0 0 4px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted, #666); font-weight: 600; }
  #repos-view .rp-pr { padding: 3px 0; font-size: 13px; border-top: 1px solid var(--line, #eee); }
  #repos-view .rp-pr:first-of-type { border-top: 0; }
  #repos-view .rp-sum { color: var(--muted, #666); font-size: 12px; margin-top: 1px; }
  #repos-view .rp-state { display: inline-block; min-width: 48px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  #repos-view .rp-state.merged { color: #8250df; }
  #repos-view .rp-state.open { color: var(--ok, #2f7d4f); }
  #repos-view .rp-state.draft { color: var(--muted, #666); }
  #repos-view .rp-state.closed { color: var(--bad, #b3261e); }
  #repos-view .rp-path { font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
  #repos-view .rp-detail section { background: var(--panel, #fff); border: 1px solid var(--line, #ddd); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
  #repos-view .rp-empty { color: var(--muted, #666); padding: 24px 0; }
  `;
  document.head.append(style);

  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k);
    return n;
  }

  function since(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 5400) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 129600) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function clip(text, max) {
    const t = String(text || '');
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
  }

  function say(text) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(say.timer);
    say.timer = setTimeout(() => t.classList.remove('show'), 4000);
  }

  async function api(path, method) {
    const res = await fetch(path, method === 'POST' ? { method, headers: { 'Content-Type': 'application/json', 'X-PA': '1' }, body: '{}' } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // ---------------------------------------------------------------- view ----

  const view = h('div', { id: 'repos-view', hidden: true });
  // Inside the page's main column (theme.css .jmain), so the panel and its
  // toggle stay where they are while this view shows.
  const host = document.querySelector('.jmain');
  if (host) host.prepend(view);
  else document.body.prepend(view);

  const nav = document.querySelector('nav.tabs');
  let tab = document.getElementById('tab-repos');
  if (!tab && nav) {
    tab = h('a', { href: '#repos', id: 'tab-repos', title: 'Every repo you work in: what it is, your latest PRs' }, 'Repos');
    nav.append(tab);
  }

  function prRow(p) {
    const when = p.state === 'merged' ? p.mergedAt : p.updatedAt;
    return h(
      'div',
      { class: 'rp-pr' },
      h('span', { class: `rp-state ${p.state}` }, p.state),
      ' ',
      h('a', { href: p.url, target: '_blank', rel: 'noopener' }, `#${p.number}`),
      ' ',
      p.title,
      when ? h('span', { class: 'rp-meta' }, ` · ${since(when)}`) : null,
      p.branch && p.state !== 'merged' ? h('span', { class: 'rp-meta' }, ` · ${p.branch}`) : null,
      p.summary ? h('div', { class: 'rp-sum' }, clip(p.summary, 200)) : null
    );
  }

  function chips(r) {
    const list = [r.kind, ...(r.stack || []).slice(0, 4), r.owner ? `owner: ${r.owner}` : null].filter(Boolean);
    return list.length ? h('div', { class: 'rp-chips' }, list.map((c) => h('span', { class: 'rp-chip' }, c))) : null;
  }

  function where(r) {
    const out = [];
    if (r.forgeUrl) out.push(h('a', { href: r.forgeUrl, target: '_blank', rel: 'noopener' }, r.fullName));
    else if (r.fullName) out.push(r.fullName);
    for (const [machine, paths] of Object.entries(r.localPaths || {})) {
      out.push(h('span', { class: 'rp-path', title: machine }, `${machine}: ${paths[0]}${paths.length > 1 ? ` +${paths.length - 1}` : ''}`));
    }
    const parts = [];
    for (const o of out) {
      if (parts.length) parts.push(' · ');
      parts.push(o);
    }
    return h('div', { class: 'rp-meta' }, parts);
  }

  function activity(r) {
    const bits = [
      r.lastActivity ? `active ${since(r.lastActivity)}` : null,
      r.prCount ? `${r.prCount} PR${r.prCount === 1 ? '' : 's'}` : null,
      r.sessionCount ? `${r.sessionCount} session${r.sessionCount === 1 ? '' : 's'}` : null,
      r.lastCommitAt ? `last commit ${since(r.lastCommitAt)}` : null,
    ].filter(Boolean);
    return h('div', { class: 'rp-meta' }, bits.join(' · '));
  }

  function branchList(r, max) {
    const list = (r.branches || []).slice(0, max);
    if (!list.length) return null;
    return h(
      'div',
      { class: 'rp-sec' },
      h('h4', null, 'Branches'),
      list.map((b) =>
        h(
          'div',
          { class: 'rp-meta' },
          h('span', { class: 'rp-path' }, b.name),
          b.current ? ' (checked out)' : '',
          b.pr ? ` · PR #${b.pr}` : '',
          b.at ? ` · ${since(b.at)}` : '',
          b.machine ? ` · ${b.machine}` : '',
          b.mine === false ? ' · not yours' : ''
        )
      )
    );
  }

  function card(r) {
    return h(
      'div',
      { class: 'rp-card' },
      h(
        'div',
        { class: 'rp-head' },
        h('a', { class: 'rp-name', href: `#repos/${encodeURIComponent(r.name)}` }, r.name),
        r.hidden ? h('span', { class: 'rp-chip' }, 'hidden') : null,
        r.pinned ? h('span', { class: 'rp-chip' }, 'pinned') : null
      ),
      where(r),
      chips(r),
      r.description ? h('div', { class: 'rp-desc' }, clip(r.description, 280)) : h('div', { class: 'rp-desc rp-meta' }, 'No description yet.'),
      activity(r),
      r.prs && r.prs.length ? h('div', { class: 'rp-sec' }, h('h4', null, 'Your latest PRs'), r.prs.slice(0, 4).map(prRow)) : null,
      branchList(r, 3)
    );
  }

  function renderList() {
    const q = S.filter.trim().toLowerCase();
    const list = (S.list || []).filter(
      (r) => !q || [r.name, r.fullName, r.description, r.kind, ...(r.stack || [])].some((x) => String(x || '').toLowerCase().includes(q))
    );
    const search = h('input', { type: 'search', placeholder: 'Filter repos…', value: S.filter });
    search.addEventListener('input', () => {
      S.filter = search.value;
      const pos = search.selectionStart;
      renderList();
      const again = view.querySelector('input[type=search]');
      if (again) {
        again.focus();
        again.setSelectionRange(pos, pos);
      }
    });
    const allBox = h('input', { type: 'checkbox' });
    allBox.checked = S.all;
    allBox.addEventListener('change', () => {
      S.all = allBox.checked;
      load();
    });
    const syncBtn = h('button', { title: 'Re-read clones, GitHub, sessions and raven now (the worker does this hourly)' }, 'Sync now');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      try {
        await api('api/repos/sync', 'POST');
        say('Repo sync started — this takes about a minute');
        setTimeout(load, 60_000);
      } catch (err) {
        say(err.message);
      } finally {
        setTimeout(() => {
          syncBtn.disabled = false;
          syncBtn.textContent = 'Sync now';
        }, 5000);
      }
    });
    view.replaceChildren(
      h(
        'div',
        { class: 'rp-bar' },
        search,
        h('label', { class: 'rp-meta' }, allBox, ' every repo'),
        syncBtn,
        h('span', { class: 'rp-meta' }, `${list.length} repo${list.length === 1 ? '' : 's'}`)
      ),
      list.length ? h('div', { class: 'rp-grid' }, list.map(card)) : h('div', { class: 'rp-empty' }, S.list ? 'No repos match.' : 'Loading…')
    );
  }

  function renderDetail(r) {
    const hideBtn = h('button', null, r.hidden ? 'Show on the Repos tab' : 'Hide from the Repos tab');
    hideBtn.addEventListener('click', async () => {
      hideBtn.disabled = true;
      try {
        await api(`api/repos/${encodeURIComponent(r.name)}/${r.hidden ? 'unhide' : 'hide'}`, 'POST');
        say(r.hidden ? `${r.name} is back on the tab` : `${r.name} hidden`);
        S.list = null;
        openDetail(r.name);
      } catch (err) {
        say(err.message);
        hideBtn.disabled = false;
      }
    });
    const facts = [
      r.defaultBranch ? `default branch ${r.defaultBranch}` : null,
      r.descriptionSource ? `description from ${r.descriptionSource}` : null,
      r.origin ? `found via ${r.origin}` : null,
    ].filter(Boolean);
    view.replaceChildren(
      h(
        'div',
        { class: 'rp-detail' },
        h('div', { class: 'rp-bar' }, h('a', { href: '#repos' }, '← All repos'), hideBtn),
        h(
          'section',
          null,
          h('div', { class: 'rp-head' }, h('span', { class: 'rp-name' }, r.name)),
          where(r),
          chips(r),
          r.description ? h('div', { class: 'rp-desc' }, r.description) : h('div', { class: 'rp-desc rp-meta' }, 'No description yet — `pa repos set ' + r.name + ' --description "…"`'),
          r.related && r.related.length ? h('div', { class: 'rp-meta' }, `Related: ${r.related.join(', ')}`) : null,
          r.ravenDoc ? h('div', { class: 'rp-meta' }, 'raven: ', h('a', { href: r.ravenDoc, target: '_blank', rel: 'noopener' }, 'knowledge/systems doc')) : null,
          activity(r),
          facts.length ? h('div', { class: 'rp-meta' }, facts.join(' · ')) : null
        ),
        Object.keys(r.localPaths || {}).length
          ? h(
              'section',
              null,
              h('h4', { class: 'rp-meta' }, 'FOLDERS'),
              Object.entries(r.localPaths).map(([m, paths]) => h('div', { class: 'rp-meta' }, `${m}: `, h('span', { class: 'rp-path' }, paths.join(', '))))
            )
          : null,
        r.branches && r.branches.length ? h('section', null, branchList(r, 20)) : null,
        r.commitments && r.commitments.length
          ? h('section', null, h('h4', { class: 'rp-meta' }, 'OPEN ASKS LINKED HERE'), r.commitments.map((c) => h('div', { class: 'rp-pr' }, `#${c.id} ${c.summary}`)))
          : null,
        h('section', null, h('h4', { class: 'rp-meta' }, `YOUR PRS (${r.prCount})`), r.prs && r.prs.length ? r.prs.map(prRow) : h('div', { class: 'rp-meta' }, 'None found.')),
        r.aliases && r.aliases.length
          ? h('section', null, h('h4', { class: 'rp-meta' }, 'ALSO KNOWN AS'), h('div', { class: 'rp-meta' }, r.aliases.map((a) => a.alias).join(' · ')))
          : null
      )
    );
  }

  async function load() {
    if (S.loading) return;
    S.loading = true;
    try {
      const data = await api(`api/repos${S.all ? '?all=1' : ''}`);
      S.list = data.repos || [];
      if (current().list) renderList();
    } catch (err) {
      say(err.message);
    } finally {
      S.loading = false;
    }
  }

  async function openDetail(name) {
    view.replaceChildren(h('div', { class: 'rp-empty' }, 'Loading…'));
    try {
      renderDetail(await api(`api/repos/${encodeURIComponent(name)}`));
    } catch (err) {
      view.replaceChildren(h('div', { class: 'rp-empty' }, `${name}: ${err.message}`), h('a', { href: '#repos' }, '← All repos'));
    }
  }

  function current() {
    const hash = location.hash || '';
    if (!hash.startsWith('#repos')) return { on: false };
    const rest = hash.slice('#repos'.length).replace(/^\//, '');
    return rest ? { on: true, name: decodeURIComponent(rest) } : { on: true, list: true };
  }

  // Runs after the page's own hashchange handler (registered first), so the
  // tab highlight set here is the last word while this tab is open.
  function show() {
    const c = current();
    document.body.classList.toggle('repos-on', c.on);
    view.hidden = !c.on;
    if (tab) tab.classList.toggle('on', c.on);
    if (!c.on) return;
    if (nav) for (const a of nav.querySelectorAll('a')) if (a !== tab) a.classList.remove('on');
    if (c.name) openDetail(c.name);
    else {
      renderList();
      if (!S.list) load();
    }
  }

  window.addEventListener('hashchange', show);
  show();
})();
