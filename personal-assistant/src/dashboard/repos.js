'use strict';

// The dashboard's Repos tab: JSON over src/repos. Reads are GETs; the writes
// (hide, unhide, sync) are POSTs, which server.js only lets through with the
// X-PA header.
//
//   GET  /api/repos                 repos you work in, newest activity first, latest PRs each
//   GET  /api/repos?all=1           every active repo, hidden ones too
//   GET  /api/repos/<name>          one repo: profile, folders, branches, every PR, linked asks
//   POST /api/repos/<name>/hide     off the tab (unhide puts it back)
//   POST /api/repos/sync            start a sync; answers at once, the page re-reads later

const repos = () => require('../repos');

let syncing = null;

async function route(method, url) {
  const parts = url.pathname.replace(/^\/api\/repos\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (method === 'GET' && parts.length === 0) {
    const list = await repos().list({ all: url.searchParams.get('all') === '1', prs: 5 });
    return { repos: list, syncing: !!syncing };
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'sync') {
    if (!syncing) {
      syncing = repos()
        .sync()
        .catch((err) => ({ error: err.message }))
        .finally(() => {
          syncing = null;
        });
    }
    return { started: true };
  }
  if (method === 'GET' && parts.length === 1) {
    const r = await repos().show(parts[0]);
    return r || { error: 'not found' };
  }
  if (method === 'POST' && parts.length === 2 && (parts[1] === 'hide' || parts[1] === 'unhide')) {
    return repos().hide(parts[0], parts[1] === 'hide');
  }
  return undefined;
}

module.exports = { route };
