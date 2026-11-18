'use strict';

// The Agents page (/agents): GET api/agents, and one POST per action (api/agents/settings,
// api/agents/profiles/<name>[/delete|/reset]), each with the X-PA header. Text only - no HTML sinks.
// Relative URLs, so the page works under termhub's /pa/ proxy too.

(function () {
  let data = null;

  function el(tag, props, kids) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const k of kids || []) if (k != null) e.append(k);
    return e;
  }
  function toast(msg, bad) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' err' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = ''; }, 3500);
  }
  async function api(path, body) {
    const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA': '1' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || res.statusText);
    return out;
  }
  const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const num = (s) => (String(s).trim() === '' ? null : Number(s));
  const orNull = (s) => (String(s).trim() === '' ? null : String(s).trim());

  function select(values, current, emptyLabel) {
    const s = el('select');
    s.append(el('option', { value: '', textContent: emptyLabel }));
    for (const v of values) s.append(el('option', { value: v, textContent: v, selected: v === current }));
    return s;
  }
  function field(label, input) { return el('label', {}, [label, input]); }

  // ---------------------------------------------------------------- profiles ----

  function profilePanel(p, opt) {
    const d = opt.buildDefaults;
    const f = {};
    f.description = el('input', { value: p.description || '' });
    f.model = select(opt.models, p.model, `default (${d.model})`);
    f.effort = select(opt.efforts, p.effort, 'default (Claude Code\'s)');
    f.permissionMode = select(opt.permissionModes, p.permissionMode, 'default (bypass in the run\'s worktree)');
    f.subagentModel = select(opt.subagentModels, p.subagentModel, 'default');
    f.costCapUsd = el('input', { type: 'number', min: '0', step: 'any', value: p.costCapUsd == null ? '' : p.costCapUsd, placeholder: `default ${d.costCapUsd}` });
    f.wallCapMin = el('input', { type: 'number', min: '0', step: 'any', value: p.wallCapMin == null ? '' : p.wallCapMin, placeholder: `default ${d.wallCapMin}` });
    f.idleAfterS = el('input', { type: 'number', min: '0', step: 'any', value: p.idleAfterS == null ? '' : p.idleAfterS, placeholder: `default ${d.idleAfterS}` });
    f.repoPath = el('input', { value: p.repoPath || '', placeholder: 'a checkout path (optional)' });
    f.prompt = el('textarea', { className: 'tall', value: p.prompt || '', placeholder: 'Appended to the base agent prompt for this profile' });
    f.allow = el('textarea', { value: (p.tools.allow || []).join('\n'), placeholder: 'One rule per line, e.g. Bash(git status)' });
    f.deny = el('textarea', { value: (p.tools.deny || []).join('\n'), placeholder: 'One rule per line, e.g. Bash(git push:*)' });
    f.subagents = el('textarea', { className: 'tall', value: JSON.stringify(p.subagents || [], null, 2), spellcheck: false });

    const mcp = el('div', { className: 'checks' });
    const servers = Array.from(new Set([...(opt.mcpServers || []), ...(p.tools.mcp || [])]));
    const boxes = servers.map((name) => {
      const b = el('input', { type: 'checkbox', checked: (p.tools.mcp || []).includes(name) });
      mcp.append(el('label', {}, [b, name]));
      return [name, b];
    });
    if (!servers.length) mcp.append(el('span', { className: 'muted', textContent: 'No MCP servers registered (the build.mcp setting): the run gets none.' }));

    const base = el('details', { className: 'base' }, [el('summary', { textContent: 'Base prompt (read only; the text above is appended after it)' }), el('pre', { textContent: opt.basePrompt || '(not found)' })]);

    const status = el('span', { className: 'muted' });
    async function save() {
      let subagents;
      try { subagents = JSON.parse(f.subagents.value || '[]'); } catch (e) { status.textContent = `subagents is not valid JSON: ${e.message}`; status.className = 'err'; return; }
      const body = {
        description: f.description.value, model: orNull(f.model.value), effort: orNull(f.effort.value), permissionMode: orNull(f.permissionMode.value),
        prompt: f.prompt.value, subagentModel: orNull(f.subagentModel.value), costCapUsd: num(f.costCapUsd.value), wallCapMin: num(f.wallCapMin.value),
        idleAfterS: num(f.idleAfterS.value), repoPath: orNull(f.repoPath.value),
        tools: { mcp: boxes.filter(([, b]) => b.checked).map(([n]) => n), allow: lines(f.allow.value), deny: lines(f.deny.value) },
        subagents,
      };
      try { await api(`api/agents/profiles/${encodeURIComponent(p.name)}`, body); toast(`${p.name} saved`); await load(); } catch (e) { status.textContent = e.message; status.className = 'err'; }
    }
    async function act(kind, confirmText) {
      if (confirmText && !confirm(confirmText)) return;
      try { await api(`api/agents/profiles/${encodeURIComponent(p.name)}/${kind}`, {}); toast(`${p.name} ${kind === 'delete' ? 'deleted' : 'reset'}`); await load(); } catch (e) { status.textContent = e.message; status.className = 'err'; }
    }

    const actions = el('div', { className: 'actions' }, [el('button', { className: 'primary', textContent: 'Save', onclick: save })]);
    if (p.seed) actions.append(el('button', { textContent: 'Reset to default', onclick: () => act('reset', `Put "${p.name}" back to what ships? Your edits to it are lost.`) }));
    else actions.append(el('button', { className: 'danger', textContent: 'Delete', onclick: () => act('delete', `Delete the profile "${p.name}"?`) }));
    actions.append(status);

    const sum = el('summary', {}, [
      el('b', { textContent: p.name }),
      el('span', { className: 'chip mono', textContent: [p.model || 'default model', p.effort || 'default effort'].join(' · ') }),
      p.permissionMode ? el('span', { className: 'chip', textContent: p.permissionMode }) : null,
      p.seed ? el('span', { className: 'chip', textContent: 'built in' }) : null,
      p.modified ? el('span', { className: 'chip mod', textContent: 'edited' }) : null,
      el('span', { className: 'muted', textContent: p.description || '' }),
    ]);
    return el('details', { className: 'panel' }, [
      sum,
      field('Description', f.description),
      el('div', { className: 'grid' }, [
        field('Model', f.model), field('Effort', f.effort), field('Permission mode', f.permissionMode), field('Subagent model', f.subagentModel),
        field('Cost cap (USD)', f.costCapUsd), field('Wall-clock cap (min)', f.wallCapMin), field('Idle after (s)', f.idleAfterS), field('Repo', f.repoPath),
      ]),
      field('Prompt (appended to the base prompt)', f.prompt),
      base,
      el('fieldset', {}, [el('legend', { textContent: 'Tools' }), el('div', { className: 'muted', textContent: 'MCP servers the run gets (it always runs --strict-mcp-config)' }), mcp,
        el('div', { className: 'grid' }, [field('Allow rules', f.allow), field('Deny rules', f.deny)])]),
      field('Subagents (JSON: name, description, model, prompt, tools)', f.subagents),
      actions,
    ]);
  }

  function renderProfiles() {
    const box = document.getElementById('profiles');
    // A save re-renders the list; the panels that were open stay open.
    const open = new Set(Array.from(box.querySelectorAll('details.panel[open] > summary > b')).map((b) => b.textContent));
    box.replaceChildren(...data.profiles.map((p) => {
      const panel = profilePanel(p, data.options);
      panel.open = open.has(p.name);
      return panel;
    }));
    if (data.missingSeeds.length) {
      const row = el('div', { className: 'actions' }, [el('span', { className: 'muted', textContent: 'Deleted built-in profiles:' })]);
      for (const n of data.missingSeeds) {
        row.append(el('button', { textContent: `Restore ${n}`, onclick: async () => { try { await api(`api/agents/profiles/${encodeURIComponent(n)}/reset`, {}); toast(`${n} restored`); await load(); } catch (e) { toast(e.message, true); } } }));
      }
      box.append(row);
    }
  }

  document.getElementById('newgo').addEventListener('click', async () => {
    const name = document.getElementById('newname').value.trim();
    const hint = document.getElementById('newhint');
    try {
      await api(`api/agents/profiles/${encodeURIComponent(name)}`, { description: document.getElementById('newdesc').value });
      document.getElementById('newname').value = '';
      document.getElementById('newdesc').value = '';
      hint.textContent = '';
      toast(`${name} created`);
      await load();
    } catch (e) { hint.textContent = e.message; hint.className = 'err'; }
  });

  // -------------------------------------------------------------------- models ----

  const HINTS = ['haiku', 'sonnet', 'opus', 'fable', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'azure/pa', 'local/llama3.2:3b'];

  function sourceChip(src) { return el('span', { className: `chip${src === 'store' ? ' store' : ''}`, textContent: src }); }

  function modelRow(label, sub, row, apply) {
    const input = el('input', { value: row.source === 'store' ? row.model : '', placeholder: row.model || 'Claude Code default', autocomplete: 'off' });
    input.setAttribute('list', 'modelhints');
    const msg = el('span', { className: 'muted' });
    const save = async (value) => {
      try { await apply(value); toast(`${label} ${value ? 'set' : 'cleared'}`); await load(); } catch (e) { msg.textContent = e.message; msg.className = 'err'; }
    };
    return el('tr', {}, [
      el('td', {}, [el('b', { textContent: label }), el('div', { className: 'muted', textContent: sub })]),
      el('td', { className: 'mono', textContent: row.model || '(Claude Code default)' }),
      el('td', {}, [sourceChip(row.source), el('div', { className: 'muted hide', textContent: `without an override: ${row.default || '(Claude Code default)'}` })]),
      el('td', {}, [input, msg]),
      el('td', {}, [el('button', { className: 'primary', textContent: 'Set', onclick: () => save(input.value.trim()) }), ' ',
        el('button', { textContent: 'Clear', disabled: row.source !== 'store', onclick: () => save('') })]),
    ]);
  }

  function table(rows) {
    return el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Agent', 'Model now', 'From', 'Override', ''].map((h) => el('th', { textContent: h })))]),
      el('tbody', {}, rows),
    ]);
  }

  // The whole-number settings (summaryEvery, summaryLines): value now, where it comes from, and an override.
  function numberRow(key, row) {
    const input = el('input', { type: 'number', min: row.min, max: row.max, step: 1, value: row.source === 'store' ? row.value : '', placeholder: String(row.value) });
    const msg = el('span', { className: 'muted' });
    const save = async (value) => {
      try { await api('api/agents/settings', { [key]: value }); toast(`${key} ${value === null ? 'cleared' : 'set'}`); await load(); } catch (e) { msg.textContent = e.message; msg.className = 'err'; }
    };
    return el('tr', {}, [
      el('td', {}, [el('b', { textContent: key }), el('div', { className: 'muted', textContent: `${row.what} (${row.env}; ${row.min}-${row.max})` })]),
      el('td', { className: 'mono', textContent: String(row.value) }),
      el('td', {}, [sourceChip(row.source)]),
      el('td', {}, [input, msg]),
      el('td', {}, [el('button', { className: 'primary', textContent: 'Set', onclick: () => save(num(input.value)) }), ' ',
        el('button', { textContent: 'Clear', disabled: row.source !== 'store', onclick: () => save(null) })]),
    ]);
  }

  function renderModels() {
    document.getElementById('numbers').replaceChildren(el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Setting', 'Now', 'From', 'Override', ''].map((h) => el('th', { textContent: h })))]),
      el('tbody', {}, Object.entries(data.settings || {}).map(([k, row]) => numberRow(k, row))),
    ]));
    document.getElementById('modelhints').replaceChildren(...HINTS.map((h) => el('option', { value: h })));
    const c = data.chat;
    document.getElementById('chat').replaceChildren(table([
      modelRow('PA chat', c.note, c, (v) => api('api/agents/settings', { chatModel: v || null })),
    ]));
    document.getElementById('passes').replaceChildren(table(data.passes.map((p) =>
      modelRow(p.key, `${p.what} (${p.env}; needs ${p.needs})`, p, (v) => api('api/agents/settings', { passModels: { [p.key]: v || null } })))));
  }

  async function load() {
    try {
      data = await api('api/agents');
      renderProfiles();
      renderModels();
    } catch (e) {
      document.getElementById('profiles').replaceChildren(el('p', { className: 'err', textContent: `Could not load: ${e.message}` }));
    }
  }
  load();
})();
