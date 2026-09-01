'use strict';

// Mail ingest: inbox and sent items, both on delta cursors.
//
// Sent mail is not an afterthought — it is where "owed by me" comes from. An
// assistant that only reads your inbox knows what people asked and nothing
// about what you answered, so it will keep reminding you about work you already
// promised away or already did.
//
// `$select` is not decoration either: without it Graph returns the full message
// resource per item, which is mostly headers nobody reads and a body we already
// asked for separately.

const { getDelta } = require('../graph/client');
const { saveItems, getCursor } = require('./store');
const { htmlToText, stripQuoted } = require('../util/text');

const SELECT =
  '$select=id,conversationId,subject,receivedDateTime,sentDateTime,from,sender,toRecipients,ccRecipients,bodyPreview,body,webLink,isDraft';

const FOLDERS = [
  { key: 'inbox', path: '/me/mailFolders/inbox/messages/delta' },
  { key: 'sent', path: '/me/mailFolders/sentitems/messages/delta' },
];

function addressOf(recipient) {
  return recipient?.emailAddress?.address?.toLowerCase() || null;
}

function toItem(msg) {
  const html = msg.body?.contentType === 'html' ? msg.body?.content : null;
  const text = html ? htmlToText(html) : msg.body?.content || msg.bodyPreview || '';
  return {
    externalId: msg.id,
    threadExternalId: msg.conversationId || null,
    occurredAt: msg.receivedDateTime || msg.sentDateTime || new Date().toISOString(),
    authorIdentity: addressOf(msg.from) || addressOf(msg.sender),
    subject: msg.subject || '(no subject)',
    bodyText: stripQuoted(text),
    raw: {
      webLink: msg.webLink,
      to: (msg.toRecipients || []).map(addressOf).filter(Boolean),
      cc: (msg.ccRecipients || []).map(addressOf).filter(Boolean),
      isDraft: !!msg.isDraft,
      folder: msg.__folder,
    },
  };
}

async function run() {
  let changed = 0;

  for (const folder of FOLDERS) {
    const cursorKey = `graph_mail:${folder.key}`;
    const cursor = await getCursor(cursorKey);
    const start = `${folder.path}?${SELECT}`;

    const { items, deltaLink } = await getDelta(start, cursor?.delta_token, {
      headers: { Prefer: 'odata.maxpagesize=50' },
    });

    // Deletions come back as `@removed`. We keep the item — a message you
    // deleted still happened, and the commitment it created still stands until
    // you say otherwise.
    const usable = items
      .filter((m) => m.id && !m['@removed'])
      .map((m) => toItem({ ...m, __folder: folder.key }));

    changed += await saveItems('graph_mail', usable, {
      source: cursorKey,
      deltaToken: deltaLink,
    });
  }

  return changed;
}

module.exports = { run, id: 'graph_mail', toItem };
