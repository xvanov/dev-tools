// The Keys view (Run tab > Keys): see lib/secretsApi.ts for what the server does.
//
// Rules this page keeps:
//   - a stored value is never shown or fetched; the server does not send one;
//   - a value typed here is sent once, then the box is cleared;
//   - every piece of server text goes in with textContent, never innerHTML.
(function () {
  'use strict';

  var app = document.getElementById('app');
  var view = document.getElementById('keys-view');
  var buttons = document.querySelectorAll('[data-run-view]');
  if (!app || !view || !buttons.length) return;

  var HEADERS = { 'Content-Type': 'application/json', 'X-Termhub': '1' };

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function api(path, body) {
    var opts = body
      ? { method: 'POST', headers: HEADERS, body: JSON.stringify(body) }
      : { method: 'GET', headers: { 'X-Termhub': '1' } };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var err = new Error(j.error || ('request failed: ' + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  function setView(name) {
    var keys = name === 'keys';
    app.classList.toggle('view-keys', keys);
    buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-run-view') === name));
    });
    if (keys) load();
  }

  function badge(status) {
    return el('span', { class: 'key-badge key-' + status }, status === 'present' ? 'saved' : 'not set');
  }

  function keyCard(s, onChange) {
    var card = el('div', { class: 'key-card' });
    var head = el('div', { class: 'key-head' });
    head.appendChild(el('code', { class: 'key-name' }, s.name));
    head.appendChild(badge(s.status));
    card.appendChild(head);
    card.appendChild(el('div', { class: 'key-desc' }, s.description || ''));
    card.appendChild(el('div', { class: 'key-dest' }, 'Read by: ' + (s.destination || '—')));

    var row = el('div', { class: 'key-row' });
    var input = el('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: s.status === 'present' ? 'enter a new value to replace' : 'enter value', 'aria-label': 'Value for ' + s.name });
    var save = el('button', { type: 'button' }, s.status === 'present' ? 'Replace' : 'Save');
    var msg = el('div', { class: 'key-msg', role: 'status' });

    save.addEventListener('click', function () {
      var value = input.value;
      if (!value) { msg.textContent = 'Type a value first.'; return; }
      save.disabled = true;
      api('/api/secrets/set', { name: s.name, value: value }).then(function () {
        input.value = '';
        msg.textContent = 'Saved. The value is not shown here.';
        onChange();
      }).catch(function (e) {
        msg.textContent = e.message;
      }).then(function () { save.disabled = false; });
    });
    row.appendChild(input);
    row.appendChild(save);
    card.appendChild(row);

    var actions = el('div', { class: 'key-actions' });
    if (s.status === 'present') {
      var clear = el('button', { type: 'button', class: 'secondary' }, 'Remove value');
      clear.addEventListener('click', function () {
        if (!window.confirm('Remove the stored value for ' + s.name + '?')) return;
        api('/api/secrets/clear', { name: s.name }).then(onChange).catch(function (e) { msg.textContent = e.message; });
      });
      actions.appendChild(clear);
    }
    var drop = el('button', { type: 'button', class: 'secondary danger' }, 'Delete entry');
    drop.addEventListener('click', function () {
      if (!window.confirm('Delete the entry for ' + s.name + '? The stored value (if any) stays until you remove it.')) return;
      api('/api/secrets/spec-remove', { name: s.name }).then(onChange).catch(function (e) { msg.textContent = e.message; });
    });
    actions.appendChild(drop);
    card.appendChild(actions);
    card.appendChild(msg);
    return card;
  }

  // Add a key: a name and a value, nothing else.
  function addForm(onChange) {
    var box = el('details', { class: 'key-add' });
    box.appendChild(el('summary', null, 'Add a key'));
    var name = el('input', { type: 'text', placeholder: 'NAME_LIKE_THIS', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Name' });
    var value = el('input', { type: 'password', placeholder: 'value', spellcheck: 'false', autocomplete: 'new-password', 'aria-label': 'Value' });
    var row = el('div', { class: 'key-row' });
    row.appendChild(name);
    row.appendChild(value);
    box.appendChild(row);
    var go = el('button', { type: 'button' }, 'Save');
    var msg = el('div', { class: 'key-msg', role: 'status' });
    go.addEventListener('click', function () {
      var n = name.value.trim();
      var v = value.value;
      if (!n || !v) { msg.textContent = 'Type a name and a value.'; return; }
      api('/api/secrets/add', { name: n, value: v }).then(function () {
        name.value = '';
        value.value = '';
        msg.textContent = 'Saved ' + n + '. The value is not shown here.';
        onChange();
      }).catch(function (e) { msg.textContent = e.message; });
    });
    box.appendChild(go);
    box.appendChild(msg);
    return box;
  }

  function load() {
    view.textContent = '';
    view.appendChild(el('h2', { class: 'keys-title' }, 'Keys'));
    view.appendChild(el('p', { class: 'keys-intro' }, 'Keys and account passwords for the stack. Values go straight into the password store on this machine; this page only shows names and whether each is saved.'));
    var list = el('div', { class: 'keys-list' }, 'Loading…');
    view.appendChild(list);
    view.appendChild(addForm(load));
    api('/api/secrets').then(function (j) {
      list.textContent = '';
      if (!j.secrets.length) list.appendChild(el('p', { class: 'keys-intro' }, 'No keys yet. Add one below.'));
      j.secrets.forEach(function (s) { list.appendChild(keyCard(s, load)); });
      view.appendChild(el('p', { class: 'keys-foot' }, 'Store: ' + j.store + ' · Every change is logged by name and time, never the value.'));
    }).catch(function (e) {
      list.textContent = '';
      list.appendChild(el('p', { class: 'key-msg' }, e.message));
      if (e.status === 401 || e.status === 403) {
        var go = el('a', { href: '/pa/login', class: 'key-signin' }, 'Open sign-in');
        list.appendChild(go);
      }
    });
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-run-view')); });
  });
})();
