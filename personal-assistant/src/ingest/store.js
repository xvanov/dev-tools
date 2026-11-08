'use strict';

// Writing captured items, and the one invariant that makes ingest restartable:
// **items and their cursor advance in the same transaction.**
//
// Write the items, crash, then advance the cursor on restart and the items are
// lost silently — the cursor claims we already have them. Advance the cursor
// first and a crash loses them just as quietly. One transaction, or a
// re-fetched page next pass, which the unique constraint makes harmless.

const repo = require('../repo');
const { contentHash, chunkText } = require('../util/text.ts');
const { chunkContext, CONTEXT_VERSION } = require('../search/context');
const { logger } = require('../log');

const log = logger('ingest');

// The upsert (on conflict do update, so an edited message's newer body is
// kept and re-opens it for distillation) is repo.sources.upsertItem.

function normalise(item) {
  const body = (item.bodyText || '').trim();
  return {
    source: item.source,
    externalId: String(item.externalId),
    threadExternalId: item.threadExternalId ? String(item.threadExternalId) : null,
    occurredAt: item.occurredAt instanceof Date ? item.occurredAt : new Date(item.occurredAt),
    authorIdentity: item.authorIdentity || null,
    subject: item.subject || null,
    bodyText: body,
    raw: item.raw || {},
    hash: contentHash(item.subject, body, item.authorIdentity),
  };
}

// Returns the number of rows that were new or genuinely changed. Unchanged
// items are not counted, so "0 new" in a poll log means exactly that.
async function saveItems(source, items, cursor) {
  return repo.withTx(async (r) => {
    let changed = 0;
    for (const raw of items) {
      const it = normalise({ ...raw, source });
      const row = await r.sources.upsertItem(it);
      if (row) {
        changed++;
        // Chunks are derived state: on a changed body the old ones are wrong.
        await r.sources.deleteChunks(row.id);
        const parts = chunkText(it.bodyText);
        const context = chunkContext({
          source: it.source,
          subject: it.subject,
          occurred_at: it.occurredAt,
          author_identity: it.authorIdentity,
          raw: it.raw,
        });
        for (let i = 0; i < parts.length; i++) {
          await r.sources.upsertChunk(row.id, i, parts[i], context, CONTEXT_VERSION);
        }
        // A changed body means the distillation is stale.
        await r.sources.deleteDistillation(row.id);
      }
    }

    if (cursor) {
      await r.sources.saveCursor({ source: cursor.source, deltaToken: cursor.deltaToken ?? null, state: cursor.state ?? {} });
    }

    log.info('saved', { source, seen: items.length, changed });
    return changed;
  });
}

// A cursor alone, for a pass that read nothing worth saving — without the
// per-save log line, which a five-second pass would turn into noise.
async function saveCursor(cursor) {
  await repo.withTx((r) => r.sources.saveCursor({ source: cursor.source, deltaToken: cursor.deltaToken ?? null, state: cursor.state ?? {} }));
}

async function getCursor(source) {
  return repo.sources.getCursor(source);
}

async function recordError(source, message) {
  await repo.withTx((r) => r.sources.recordCursorError(source, String(message).slice(0, 500)));
}

async function cursors() {
  return repo.sources.cursorList();
}

module.exports = { saveItems, saveCursor, getCursor, recordError, cursors };
