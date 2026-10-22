'use strict';

// The line of context every chunk carries into both indexes.
//
// A chunk on its own is a paragraph with no idea where it came from: "yes,
// ship it Thursday" matches nothing a person would search for. Prefixing where,
// when, who and about-what before embedding and before building the tsvector is
// the cheap half of Anthropic's contextual retrieval — deterministic, no model
// call, and it makes "what did Brannoc say about the export" findable by name
// and topic even when the chunk itself mentions neither.
//
// Kept in its own column, not glued onto `content`: snippets shown to people
// and models stay the message's own words.

const LABELS = {
  graph_mail: 'Email',
  graph_chat: 'Teams chat',
  graph_event: 'Calendar',
  github_notification: 'GitHub notification',
  github_pr: 'GitHub PR',
  github_issue: 'GitHub issue',
  github_project_item: 'GitHub board item',
  jira_issue: 'Jira issue',
  audio: 'Recorded conversation',
  claude_session: 'Claude session',
};

// Bump when the header format changes: chunks whose `context_v` differs are
// re-headed and re-embedded by the backfill.
const CONTEXT_VERSION = 1;

function day(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function chunkContext(item) {
  const raw = item.raw || {};
  const parts = [LABELS[item.source] || item.source];
  const topic = raw.chatTopic || raw.board || null;
  if (topic) parts.push(`"${topic}"`);
  if (raw.project) parts.push(raw.project);
  const when = day(item.occurred_at ?? item.occurredAt);
  if (when) parts.push(when);
  const from = raw.fromName || raw.reporter || null;
  const author = item.author_identity ?? item.authorIdentity;
  if (from) parts.push(`from ${from}`);
  else if (author && author !== 'me') parts.push(`from ${author}`);
  const subject = item.subject;
  let line = parts.join(' · ');
  if (subject) line += ` — ${String(subject).slice(0, 160)}`;
  return line;
}

module.exports = { chunkContext, CONTEXT_VERSION, LABELS };
