'use strict';

// The settings window: the only page with access to the app (capabilities/
// default.json). The stack window loads a remote page and gets no IPC.

const invoke = window.__TAURI__.core.invoke;
const $ = (id) => document.getElementById(id);

function say(text, err = false) {
  const s = $('status');
  s.textContent = text;
  s.className = err ? 'err' : '';
}

async function render() {
  const { config, autostart } = await invoke('get_config');
  const box = $('stacks');
  box.textContent = '';
  for (const [id, stack] of Object.entries(config.stacks)) {
    const form = $('stack-tpl').content.firstElementChild.cloneNode(true);
    form.classList.toggle('active', id === config.active);
    form.querySelector('h2').textContent = stack.name;
    form.url.value = stack.url || '';
    form.events.value = stack.events || '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await invoke('save_stack', { id, url: form.url.value, events: form.events.value || null });
        say(`${stack.name} saved.`);
        render();
      } catch (err) {
        say(String(err), true);
      }
    });
    form.querySelector('.use').addEventListener('click', async () => {
      try {
        await invoke('switch_stack', { id });
        say(`Switched to ${stack.name}.`);
        render();
      } catch (err) {
        say(String(err), true);
      }
    });
    box.appendChild(form);
  }
  $('notifications').checked = !!config.notifications;
  $('autostart').checked = !!autostart;
}

$('notifications').addEventListener('change', (e) => {
  invoke('set_notifications', { on: e.target.checked }).catch((err) => say(String(err), true));
});
$('autostart').addEventListener('change', async (e) => {
  try {
    e.target.checked = await invoke('set_autostart', { on: e.target.checked });
  } catch (err) {
    say(String(err), true);
  }
});

render().catch((err) => say(String(err), true));
