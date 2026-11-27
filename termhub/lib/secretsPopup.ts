'use strict';

// The secrets popup: a page on this machine where you type a secret's value and it
// goes straight into the store (lib/secrets.ts). Nothing else sees the value.
//
// Safety, enforced here:
//   - bound to 127.0.0.1 only (TERMHUB_SECRETS_PORT, default 7040);
//   - the Host header must be localhost or 127.0.0.1, which blocks DNS-rebinding
//     from a web page the browser might open;
//   - POST requests must carry the token printed on this page (a per-start random
//     value), so another page cannot submit a form to it;
//   - a value is never echoed back, logged, or put in a URL;
//   - request bodies are capped at 8 KB.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const http = require('http');
const crypto = require('crypto');
const secrets = require('./secrets.ts');

const PORT = Number(process.env.TERMHUB_SECRETS_PORT || 7040);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MAX_BODY = 8 * 1024;

const TOKEN = crypto.randomBytes(24).toString('hex');

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Secrets</title>
<style>
  :root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#d2d2d7;--ok:#1a7f37;--warn:#9a6700;--btn:#0a66c2}
  @media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#1c1c1e;--fg:#f5f5f7;--mut:#a1a1a6;--line:#3a3a3c;--ok:#4ac26b;--warn:#e3b341;--btn:#4da3ff}}
  :root[data-theme="dark"]{--bg:#1c1c1e;--fg:#f5f5f7;--mut:#a1a1a6;--line:#3a3a3c;--ok:#4ac26b;--warn:#e3b341;--btn:#4da3ff}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;padding:16px}
  main{max-width:640px;margin:0 auto}
  h1{font-size:20px;margin:4px 0 12px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
  .mut{color:var(--mut);font-size:13px}
  .present{color:var(--ok)} .missing{color:var(--warn)}
  form{border:1px solid var(--line);border-radius:10px;padding:14px}
  label{display:block;margin:10px 0 4px;font-weight:600}
  input[type=password],input[type=text]{width:100%;box-sizing:border-box;padding:10px;font:inherit;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg)}
  button{margin-top:12px;padding:10px 16px;font:inherit;border:0;border-radius:8px;background:var(--btn);color:#fff;cursor:pointer}
  button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
  .flash{padding:10px 12px;border-radius:8px;border:1px solid var(--line);margin-bottom:14px}
  a{color:var(--btn)}
</style></head><body><main>${body}</main></body></html>`;
}

function listPage(flash: string, selected: string | null): string {
  const rows = secrets.readSpec().map((s: any) => {
    const st = secrets.status(s.name);
    return `<tr><td><a href="?name=${encodeURIComponent(s.name)}"><b>${esc(s.name)}</b></a><div class="mut">${esc(s.description)}</div></td>
<td class="mut">${esc(s.destination)}</td><td class="${st}">${st}</td></tr>`;
  }).join('');
  const sel = selected ? secrets.findSpec(selected) : null;
  let form = '';
  if (sel) {
    const st = secrets.status(sel.name);
    form = `<form method="post" action="/api/set" autocomplete="off">
<input type="hidden" name="token" value="${TOKEN}">
<input type="hidden" name="name" value="${esc(sel.name)}">
<div class="mut">${esc(sel.description)}</div>
<div class="mut">Read by: ${esc(sel.destination)} · Currently: <span class="${st}">${st}</span></div>
<label for="v">Value for ${esc(sel.name)}</label>
<input id="v" name="value" type="password" autocomplete="new-password" spellcheck="false" required>
<button type="submit">Save</button>
</form>
${st === 'present' ? `<form method="post" action="/api/clear" style="margin-top:10px">
<input type="hidden" name="token" value="${TOKEN}"><input type="hidden" name="name" value="${esc(sel.name)}">
<button class="secondary" type="submit">Remove stored value</button></form>` : ''}`;
  }
  return page(`<h1>Secrets</h1>
${flash ? `<div class="flash">${flash}</div>` : ''}
<table><tr><th>Name</th><th>Read by</th><th>Status</th></tr>${rows || '<tr><td colspan="3" class="mut">No secrets in the spec yet.</td></tr>'}</table>
${form}`);
}

function send(res: any, code: number, type: string, body: string): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function readForm(req: any): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) out[k] = v;
      resolve(out);
    });
    req.on('error', reject);
  });
}

function handler(req: any, res: any): void {
  if (!HOSTS.has(String(req.headers.host || ''))) return send(res, 421, 'text/plain', 'misdirected');
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const name = url.searchParams.get('name');
    const flash = url.searchParams.get('saved') ? `Saved ${esc(url.searchParams.get('saved'))} to the store. The value is not shown here.` : '';
    return send(res, 200, 'text/html; charset=utf-8', listPage(flash, name));
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const out = secrets.readSpec().map((s: any) => ({ name: s.name, status: secrets.status(s.name) }));
    return send(res, 200, 'application/json', JSON.stringify(out));
  }

  if (req.method === 'POST' && (url.pathname === '/api/set' || url.pathname === '/api/clear')) {
    readForm(req).then((f) => {
      if (f.token !== TOKEN) return send(res, 403, 'text/plain', 'bad token');
      const name = f.name || '';
      try {
        if (url.pathname === '/api/set') {
          secrets.setSecret(name, f.value || '');
          res.writeHead(303, { Location: `/?saved=${encodeURIComponent(name)}` });
          return res.end();
        }
        secrets.clearSecret(name);
        res.writeHead(303, { Location: `/?name=${encodeURIComponent(name)}` });
        return res.end();
      } catch (e: any) {
        // The message names the failing step, never the value.
        return send(res, 400, 'text/html; charset=utf-8', page(`<h1>Not saved</h1><div class="flash">${esc(e.message)}</div><a href="/">Back</a>`));
      }
    }).catch(() => send(res, 413, 'text/plain', 'too large'));
    return;
  }

  return send(res, 404, 'text/plain', 'not found');
}

/** Start the popup server on loopback. Returns the server (for tests and shutdown). */
function start(port: number = PORT, host: string = '127.0.0.1'): any {
  const server = http.createServer(handler);
  server.listen(port, host);
  return server;
}

module.exports = { start, handler, TOKEN, PORT };

if (require.main === module) {
  start();
  console.log(`secrets popup on http://127.0.0.1:${PORT}/`);
}
