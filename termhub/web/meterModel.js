// Meter's model-and-latency panels (plan 7.5): latency per hop (p50/p95), model
// spend per day / model / purpose, and the Claude credit pool. The numbers
// belong to the personal assistant, so they come through the /pa proxy from
// GET /api/meter; without a PA the panels say so and the agent-time page above
// is unaffected. Plain script, no build step; renders into #model-meter.
(function () {
  'use strict';

  const root = document.getElementById('model-meter');
  if (!root) return;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function usd(n) {
    const v = Number(n) || 0;
    return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
  }

  function dur(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  }

  const note = (text) => `<div class="list-note">${esc(text)}</div>`;

  function renderPool(pool) {
    if (!pool || pool.error) return note(pool && pool.error ? `Credit pool unavailable: ${pool.error}` : 'Credit pool unavailable.');
    if (!pool.tracked) {
      return note('The Claude credit pool is not tracked. Set PA_CLAUDE_POOL_USD to the pool\'s monthly size to see what is left.');
    }
    const pct = Math.min(100, Math.round((pool.usedUsd / pool.monthlyUsd) * 100));
    const cls = pool.exhausted ? 'bad' : pct >= 80 ? 'warn' : 'good';
    const resets = pool.resetsAt ? new Date(pool.resetsAt).toLocaleDateString() : '';
    const spent = pool.exhausted
      ? (pool.fallbackApi
        ? ' Spent: claude_session jobs now run on the api runtime.'
        : ' Spent: claude_session jobs keep running (PA_CLAUDE_POOL_FALLBACK_API is off).')
      : '';
    return `<div class="mm-pool ${cls}">`
      + `<div class="mm-pool-nums"><b>${esc(usd(pool.remainingUsd))}</b> left of ${esc(usd(pool.monthlyUsd))}`
      + ` · ${esc(usd(pool.usedUsd))} used in ${pool.calls} runs · resets ${esc(resets)}</div>`
      + `<div class="mm-bar"><span style="width:${pct}%"></span></div>`
      + (spent ? `<div class="mm-sub">${esc(spent.trim())}</div>` : '')
      + `</div>`;
  }

  function renderLatency(rows) {
    if (!rows || rows.error) return note(rows && rows.error ? `Latency unavailable: ${rows.error}` : 'Latency unavailable.');
    if (!rows.length) return note('No spans recorded yet. They appear as voice turns, tool calls, factory calls and deploys run.');
    const worst = Math.max(...rows.map((r) => r.p95 || 0), 1);
    return rows.map((r) => `<div class="mm-row">`
      + `<div class="mm-name" title="${esc(r.hop)}">${esc(r.hop)}</div>`
      + `<div class="mm-bar" title="p95 ${esc(dur(r.p95))}"><span style="width:${Math.round(((r.p95 || 0) / worst) * 100)}%"></span></div>`
      + `<div class="mm-num">p50 <b>${esc(dur(r.p50))}</b> · p95 <b>${esc(dur(r.p95))}</b> · ${r.calls} calls${r.failed ? ` · ${r.failed} failed` : ''}</div>`
      + `</div>`).join('');
  }

  function bars(list, key, limit) {
    const shown = list.slice(0, limit);
    const most = Math.max(...shown.map((x) => x.usd), 0.000001);
    return shown.map((x) => `<div class="mm-row">`
      + `<div class="mm-name" title="${esc(x[key])}">${esc(x[key])}</div>`
      + `<div class="mm-bar"><span style="width:${Math.round((x.usd / most) * 100)}%"></span></div>`
      + `<div class="mm-num"><b>${esc(usd(x.usd))}</b> · ${x.calls} calls</div>`
      + `</div>`).join('');
  }

  function renderSpend(spend) {
    if (!spend || spend.error) return note(spend && spend.error ? `Spend unavailable: ${spend.error}` : 'Spend unavailable.');
    if (!spend.days.length) return note('No model calls recorded in this window.');
    return `<div class="mm-cols">`
      + `<div><h3>per day</h3>${bars(spend.days, 'day', 14)}</div>`
      + `<div><h3>per model</h3>${bars(spend.models, 'model', 8)}</div>`
      + `<div><h3>per purpose</h3>${bars(spend.purposes, 'purpose', 8)}</div>`
      + `</div>`
      + `<div class="mm-sub">Total ${esc(usd(spend.totalUsd))}. A call with no reported cost counts as $0, so totals are a floor.</div>`;
  }

  // The per-run ceilings from the PA's one source (GET /api/workflow-limits, edited on /architecture).
  // Spend is not split by workflow, so this shows the ceiling next to the window's total spend, not a ratio.
  function renderLimits(limits) {
    if (!limits || limits.error) return note(limits && limits.error ? `Ceilings unavailable: ${limits.error}` : 'Ceilings unavailable.');
    const ids = Object.keys(limits);
    if (!ids.length) return note('No workflow has a cost ceiling.');
    return ids.map((id) => {
      const l = limits[id];
      return `<div class="mm-row">`
        + `<div class="mm-name" title="${esc(id)}">${esc(id)}</div><div></div>`
        + `<div class="mm-num">ceiling <b>${esc(usd(l.effective))}</b> per run${l.custom ? ` · set by you (default ${esc(usd(l.default))})` : ''}</div>`
        + `</div>`;
    }).join('');
  }

  function render(data) {
    root.querySelector('[data-mm=limits]').innerHTML = renderLimits(data.limits);
    root.querySelector('[data-mm=pool]').innerHTML = renderPool(data.pool);
    root.querySelector('[data-mm=latency]').innerHTML = renderLatency(data.latency);
    root.querySelector('[data-mm=spend]').innerHTML = renderSpend(data.spend);
  }

  async function load() {
    try {
      const res = await fetch('/pa/api/meter?days=14');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
    } catch (err) {
      const msg = `The personal assistant did not answer (${err.message}). Model spend and latency come from it.`;
      for (const k of ['pool', 'latency', 'spend', 'limits']) root.querySelector(`[data-mm=${k}]`).innerHTML = note(msg);
    }
  }

  load();
  setInterval(load, 60000);
})();
