'use strict';

// Mail ingest, through the Microsoft 365 connector (see m365.js).
//
// Received and sent mail both, from one search across every folder: sent mail
// is where "owed by me" comes from. An assistant that only reads your inbox
// knows what people asked and nothing about what you answered, so it keeps
// reminding you about work you already promised away or already did.
//
// Automated senders are skipped before anything is read. GitHub and Jira mail
// in particular would be a second, worse copy of items their own sources
// already ingest with structure.
//
// The source id stays `graph_mail`: it is what every stored row, the distiller
// and the dashboard already key on.

const m365 = require('./m365');
const { saveItems, getCursor } = require('./store');
const { htmlToText, stripQuoted } = require('../util/text');
const { logger } = require('../log');

const log = logger('mail');

const FIRST_RUN_DAYS = 3;

function addressOf(recipient) {
  const a = recipient?.emailAddress?.address || recipient?.address || recipient;
  return typeof a === 'string' && a.includes('@') ? a.toLowerCase() : null;
}

function bodyOf(full, hit) {
  const body = full?.body;
  if (body?.content) {
    return body.contentType === 'html' ? htmlToText(body.content) : body.content;
  }
  return full?.bodyPreview || hit.summary || '';
}

// `hit` is the search result, `full` the read_resource message when there is
// one. Search gives sender and dates reliably; recipients and the conversation
// id only come with the full read.
function toItem(hit, full, me) {
  const from = addressOf(full?.from) || addressOf(hit.sender);
  return {
    externalId: hit.id,
    threadExternalId: full?.conversationId || hit.conversationId || hit.internetMessageId || null,
    occurredAt: hit.receivedDateTime || hit.sentDateTime || new Date().toISOString(),
    authorIdentity: from,
    subject: hit.subject || '(no subject)',
    bodyText: stripQuoted(bodyOf(full, hit)),
    raw: {
      webLink: hit.webLink || full?.webLink || null,
      fromName: hit.senderName || full?.from?.emailAddress?.name || null,
      to: (full?.toRecipients || []).map(addressOf).filter(Boolean),
      cc: (full?.ccRecipients || []).map(addressOf).filter(Boolean),
      isDraft: !!full?.isDraft,
      folder: me && from === me.mail ? 'sent' : 'inbox',
      importance: hit.importance || null,
      partial: !full,
    },
  };
}

async function run() {
  const me = await m365.whoAmI();
  const cursor = await getCursor('graph_mail');
  const since = m365.sinceFrom(cursor, { firstRunDays: FIRST_RUN_DAYS });
  const passStarted = new Date().toISOString();

  const hits = (
    await m365.search('outlook_email_search', { afterDateTime: since, limit: 25 }, { dateKey: 'receivedDateTime' })
  ).filter((h) => !isDraftFolder(h));
  const wanted = hits.filter((h) => !m365.isAutomated(h.sender) || h.sender === me.mail);

  // Newest first gets the reads when there are more than the cap.
  wanted.sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime)));
  const toRead = wanted.slice(0, m365.MAX_READS).map((h) => h.uri).filter(Boolean);
  const full = await m365.readAll(toRead);

  const items = wanted.map((h) => toItem(h, full.get(h.uri), me));
  const changed = await saveItems('graph_mail', items, {
    source: 'graph_mail',
    deltaToken: null,
    state: { since: m365.nextSince(passStarted) },
  });
  log.info('relayed', { found: hits.length, kept: wanted.length, read: full.size, changed });
  return changed;
}

function isDraftFolder(hit) {
  return /drafts/i.test(String(hit.folderName || hit.parentFolder || ''));
}

module.exports = { run, id: 'graph_mail', toItem, FIRST_RUN_DAYS };
