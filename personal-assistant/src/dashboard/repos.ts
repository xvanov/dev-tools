'use strict';

// The dashboard's Repos tab: JSON over src/repos. Reads are GETs; the writes
// (hide, unhide, sync) are POSTs, which server.js only lets through with the
// X-PA header.
//
//   GET  /api/repos                 repos you work in, newest activity first, latest PRs each,
//                                   and `open`: review requests and board items still open
//   GET  /api/repos?all=1           every active repo, hidden ones too
//   GET  /api/repos/<name>          one repo: profile, folders, branches, every PR, linked asks
//   POST /api/repos/<name>/hide     off the tab (unhide puts it back)
//   POST /api/repos/sync            start a sync; answers at once, the page re-reads later
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;

const repos = () => require('../repos');

let syncing: Promise<unknown> | null = null;

// What Plan's "Code & boards" section used to list: GitHub and Jira items from
// the last three weeks that are still open or ask something of you.
async function openItems() {
  const items = await require('../brief').recentReviews();
  // One line per item: GitHub sends a notification per review request, so the
  // same PR can come several times. Newest first, so the first one seen stays.
  const seen = new Set();
  return items
    .filter((r: Row) => (r.raw as Row | undefined)?.state === 'opened' || (r.raw as Row | undefined)?.action)
    .filter((r: Row) => {
      const k = `${r.subject}|${(r.raw as Row | undefined)?.project || ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 15)
    .map((r: Row) => ({
      subject: r.subject,
      source: r.source,
      project: (r.raw as Row | undefined)?.project || null,
      url: /^https?:\/\//.test(String((r.raw as Row | undefined)?.webUrl || '')) ? (r.raw as Row).webUrl : null,
      at: r.occurred_at,
    }));
}

async function route(method: string, url: URL) {
  const parts = url.pathname.replace(/^\/api\/repos\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (method === 'GET' && parts.length === 0) {
    const list = await repos().list({ all: url.searchParams.get('all') === '1', prs: 5 });
    const open = await openItems().catch(() => []);
    return { repos: list, open, syncing: !!syncing };
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'sync') {
    if (!syncing) {
      syncing = repos()
        .sync()
        .catch((err: Error) => ({ error: err.message }))
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

module.exports = { route, openItems };
