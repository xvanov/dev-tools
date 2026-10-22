'use strict';
// The Routines tab. Loaded after the page's main script and uses its helpers
// (el, post, getJson, toast, ago). Like the rest of the page, every value goes
// in through textContent — never an HTML sink (test/routines-ui.test.js).
//
// Routines are the one part of this page that changes things on the machine,
// so every card says so in words, and every button shows that it is working
// and then what happened. No click is silent.

const ACTION_LABEL = {
  repo_sync: { cls: 'act', text: 'Action — will run git in your repos (fetch, and fast-forward clean default branches)' },
  prompt_report: { cls: 'ro', text: 'Read-only — asks the model and sends you the answer' },
};

const rt = { data: null, poll: null, preview: null };

function actionBadge(action, changes) {
  const known = ACTION_LABEL[action];
  if (known) return el('div', { class: `badge-${known.cls}` }, known.text);
  return changes
    ? el('div', { class: 'badge-act' }, `Action — will change this machine: ${changes}`)
    : el('div', { class: 'badge-ro' }, 'Read-only');
}

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

// Runs fn with the button busy, then writes the outcome into `status` (and a
// toast). Errors stay on screen until the next click.
function rtBusy(button, status, workingText, fn) {
  return async () => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = workingText;
    status.className = 'rt-status working';
    status.textContent = `${workingText}`;
    try {
      const message = await fn();
      status.className = 'rt-status ok';
      status.textContent = message || 'Done.';
      toast(message || 'Done.');
    } catch (err) {
      status.className = 'rt-status err';
      status.textContent = `Error: ${err.message}`;
      toast(`Error: ${err.message}`);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };
}

function lastResult(r) {
  if (r.running) return el('span', { class: 'rt-running' }, 'running now…');
  if (!r.last_summary) return 'never run';
  return el('span', { class: r.last_ok === false ? 'rt-fail' : '' },
    `${r.last_ok === false ? 'failed — ' : ''}${r.last_summary}${r.last_ended_at ? ` (${ago(r.last_ended_at)})` : ''}`);
}

function routineCard(r) {
  const status = el('div', { class: 'rt-status' });
  const buttons = [];
  const add = (text, title, working, fn, cls) => {
    const b = el('button', { title, class: cls || '' }, text);
    b.addEventListener('click', rtBusy(b, status, working, fn));
    buttons.push(b);
  };

  if (r.status === 'proposed') {
    add('Accept', 'Turn this suggestion into an active routine', 'Accepting…', async () => {
      const x = await post(`api/routines/${r.id}/accept`);
      await loadRoutines();
      return `Accepted — first run ${when(x.next_run_at)}.`;
    }, 'primary');
    add('Reject', 'Never propose this again', 'Rejecting…', async () => {
      await post(`api/routines/${r.id}/reject`);
      await loadRoutines();
      return 'Rejected; it will not be proposed again.';
    });
  } else {
    add('Run now', 'Run it now for real', 'Starting…', async () => {
      const x = await post(`api/routines/${r.id}/run`);
      startPolling();
      return `Started (run ${x.runId}) — the result appears below when it finishes.`;
    }, 'primary');
    add('Dry run', 'Show what it would do, changing nothing', 'Starting…', async () => {
      const x = await post(`api/routines/${r.id}/dry-run`);
      startPolling();
      return `Dry run started (run ${x.runId}) — see Run history.`;
    });
    if (r.status === 'active') {
      add('Pause', 'Stop running it on schedule', 'Pausing…', async () => {
        await post(`api/routines/${r.id}/pause`);
        await loadRoutines();
        return 'Paused.';
      });
    } else if (r.status === 'paused') {
      add('Resume', 'Run it on schedule again', 'Resuming…', async () => {
        const x = await post(`api/routines/${r.id}/resume`);
        await loadRoutines();
        return `Resumed — next run ${when(x.next_run_at)}.`;
      });
    }
    add('Delete', 'Remove this routine', 'Deleting…', async () => {
      if (!window.confirm(`Delete routine "${r.title}"?`)) return 'Not deleted.';
      const x = await post(`api/routines/${r.id}/delete`);
      await loadRoutines();
      return x.deleted ? 'Deleted.' : 'Marked rejected (it was a suggestion).';
    });
  }

  const meta = r.status === 'proposed'
    ? [`suggested · schedule ${r.schedule}`]
    : [r.status === 'active' ? `next ${when(r.next_run_at)}` : r.status, `schedule ${r.schedule}`];
  return el('div', { class: `item rt-card rt-${r.status}`, id: `routine-${r.id}` },
    el('div', { class: 'sum' }, r.title, r.status === 'paused' ? el('span', { class: 'tag' }, ' paused') : null),
    actionBadge(r.action, r.changes),
    el('div', { class: 'rt-plain' }, r.plain),
    r.why ? el('div', { class: 'sub' }, `Why: ${r.why}`) : null,
    el('div', { class: 'sub' }, meta.join(' · ')),
    r.status !== 'proposed' ? el('div', { class: 'sub' }, 'Last: ', lastResult(r)) : null,
    el('div', { class: 'actions' }, ...buttons),
    status);
}

function runCard(x) {
  const state = !x.ended_at ? 'running…' : x.ok ? 'ok' : 'failed';
  const lines = (x.detail && x.detail.lines) || [];
  const report = x.detail && x.detail.report;
  const body = [];
  if (lines.length) body.push(el('ol', { class: 'rt-lines' }, ...lines.map((l) => el('li', {}, l))));
  if (report) body.push(el('pre', { class: 'draft' }, report));
  return el('div', { class: 'item' },
    el('div', { class: 'sum' }, x.title, ' ',
      el('span', { class: `tag ${x.ended_at && !x.ok ? 'rt-fail' : ''}` }, x.dry_run ? `dry run · ${state}` : state)),
    el('div', { class: 'sub' }, `${when(x.started_at)}${x.summary ? ` · ${x.summary}` : ''}`),
    body.length ? el('details', { class: 'quote' }, el('summary', {}, `details (${lines.length} lines)`), ...body) : null);
}

function fillList(id, items, render, emptyText) {
  const sec = document.getElementById(id);
  sec.querySelector('.n').textContent = items.length ? String(items.length) : '';
  sec.querySelector('.list').replaceChildren(...(items.length ? items.map(render) : [el('div', { class: 'empty' }, emptyText)]));
}

function renderRoutines() {
  const d = rt.data;
  const proposed = d.routines.filter((r) => r.status === 'proposed');
  const mine = d.routines.filter((r) => r.status === 'active' || r.status === 'paused');
  document.getElementById('rt-suggested').hidden = !proposed.length;
  fillList('rt-suggested', proposed, routineCard, '');
  fillList('rt-active', mine, routineCard, 'No routines yet. Describe one above.');
  fillList('rt-history', d.history, runCard, 'No runs yet.');
  const count = document.getElementById('rtcount');
  if (count) count.textContent = proposed.length ? String(proposed.length) : '';
}

async function loadRoutines() {
  try {
    rt.data = await getJson('api/routines');
    renderRoutines();
    const anyRunning = rt.data.history.some((x) => !x.ended_at);
    if (!anyRunning) stopPolling();
  } catch (err) {
    toast(`Routines: ${err.message}`);
  }
}

function startPolling() {
  loadRoutines();
  if (rt.poll) return;
  rt.poll = setInterval(loadRoutines, 3000);
}

function stopPolling() {
  if (rt.poll) clearInterval(rt.poll);
  rt.poll = null;
}

// ------------------------------------------------------------- the add box --

function showPreview(p) {
  rt.preview = p;
  const box = document.getElementById('rt-preview');
  const status = document.getElementById('rt-add-status');
  const save = el('button', { class: 'primary' }, 'Save routine');
  const cancel = el('button', {}, 'Cancel');
  save.addEventListener('click', rtBusy(save, status, 'Saving…', async () => {
    const x = await post('api/routines', { ...rt.preview, confirmed: true });
    box.hidden = true;
    box.replaceChildren();
    document.getElementById('rt-words').value = '';
    await loadRoutines();
    return `Saved routine #${x.id} — first run ${when(x.next_run_at)}.`;
  }));
  cancel.addEventListener('click', () => {
    box.hidden = true;
    box.replaceChildren();
    status.className = 'rt-status';
    status.textContent = 'Cancelled — nothing saved.';
  });
  box.replaceChildren(
    el('div', { class: 'hint' }, 'This is what I understood. Nothing is saved until you press Save.'),
    el('div', { class: 'sum' }, p.title),
    actionBadge(p.action, p.changes),
    el('div', { class: 'rt-plain' }, p.plain),
    el('div', { class: 'sub' }, `Next runs: ${p.nextRuns.map(when).join(' · ')}`),
    el('div', { class: 'sub' }, `cron ${p.schedule} · action ${p.action} · params ${JSON.stringify(p.params)}`),
    el('div', { class: 'actions' }, save, cancel));
  box.hidden = false;
}

function wireAddBox() {
  const form = document.getElementById('rt-add');
  const input = document.getElementById('rt-words');
  const read = document.getElementById('rt-read');
  const status = document.getElementById('rt-add-status');
  const go = rtBusy(read, status, 'Reading…', async () => {
    const words = input.value.trim();
    if (!words) throw new Error('Describe what should happen and when.');
    const p = await post('api/routines/parse', { words });
    showPreview(p);
    return 'Check it below, then Save or Cancel.';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go();
  });
  const sug = document.getElementById('rt-suggest');
  const sugStatus = document.getElementById('rt-suggest-status');
  sug.addEventListener('click', rtBusy(sug, sugStatus, 'Looking…', async () => {
    const x = await post('api/routines/suggest');
    await loadRoutines();
    return x.proposed.length ? `Proposed ${x.proposed.length} — review them above.` : 'Nothing convincing to propose right now.';
  }));
}

wireAddBox();
window.loadRoutines = loadRoutines;
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#routines')) loadRoutines();
  else stopPolling();
});
// Also keeps the tab's badge (suggestions waiting) current from any tab.
loadRoutines();
setInterval(loadRoutines, 30000);
