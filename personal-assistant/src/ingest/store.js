'use strict';

// Writing captured items, and the one invariant that makes ingest restartable:
// **items and their cursor advance in the same transaction.**
//
// Write the items, crash, then advance the cursor on restart and the items are
// lost silently — the cursor claims we already have them. Advance the cursor
// first and a crash loses them just as quietly. One transaction, or a
// re-fetched page next pass, which the unique constraint makes harmless.

const { withTx, one, rows } = require('../db');
const { contentHash, chunkText } = require('../util/text');
const { logger } = require('../log');

const log = logger('ingest');

// `on conflict do update` rather than `do nothing`: an edited Teams message or
// a mail that gained a category comes back through delta with the same id, and
// the newer body is the one worth keeping. The content hash changing is also
// what re-opens it for distillation.
const UPSERT = `
  insert into source_item
    (source, external_id, thread_external_id, occurred_at, author_identity,
     subject, body_text, raw, content_hash)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  on conflict (source, external_id) do update set
    thread_external_id = excluded.thread_external_id,
    occurred_at        = excluded.occurred_at,
    author_identity    = excluded.author_identity,
    subject            = excluded.subject,
    body_text          = excluded.body_text,
    raw                = excluded.raw,
    content_hash       = excluded.content_hash,
    fetched_at         = now()
  where source_item.content_hash is distinct from excluded.content_hash
  returning id, content_hash
`;

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
  return withTx(async (client) => {
    let changed = 0;
    for (const raw of items) {
      const it = normalise({ ...raw, source });
      const res = await client.query(UPSERT, [
        it.source,
        it.externalId,
        it.threadExternalId,
        it.occurredAt,
        it.authorIdentity,
        it.subject,
        it.bodyText,
        it.raw,
        it.hash,
      ]);
      if (res.rows.length) {
        changed++;
        // Chunks are derived state: on a changed body the old ones are wrong.
        await client.query('delete from chunk where source_item_id = $1', [res.rows[0].id]);
        const parts = chunkText(it.bodyText);
        for (let i = 0; i < parts.length; i++) {
          await client.query(
            'insert into chunk (source_item_id, ord, content) values ($1,$2,$3) ' +
              'on conflict (source_item_id, ord) do update set content = excluded.content',
            [res.rows[0].id, i, parts[i]]
          );
        }
        // A changed body means the distillation is stale.
        await client.query('delete from distillation where source_item_id = $1', [res.rows[0].id]);
      }
    }

    if (cursor) {
      await client.query(
        `insert into sync_cursor (source, delta_token, last_run_at, last_error, state)
         values ($1,$2,now(),null,$3)
         on conflict (source) do update set
           delta_token = excluded.delta_token,
           last_run_at = excluded.last_run_at,
           last_error  = null,
           state       = excluded.state`,
        [cursor.source, cursor.deltaToken ?? null, cursor.state ?? {}]
      );
    }

    log.info('saved', { source, seen: items.length, changed });
    return changed;
  });
}

async function getCursor(source) {
  return one('select * from sync_cursor where source = $1', [source]);
}

async function recordError(source, message) {
  await withTx(async (client) => {
    await client.query(
      `insert into sync_cursor (source, last_run_at, last_error)
       values ($1, now(), $2)
       on conflict (source) do update set last_run_at = now(), last_error = excluded.last_error`,
      [source, String(message).slice(0, 500)]
    );
  });
}

async function cursors() {
  return rows('select source, last_run_at, last_error, delta_token is not null as has_token from sync_cursor order by source');
}

module.exports = { saveItems, getCursor, recordError, cursors };
