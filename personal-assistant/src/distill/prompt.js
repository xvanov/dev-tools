'use strict';

// The distillation prompt and its response parser.
//
// PROMPT_VERSION is the contract between this file and the database: every
// distilled row records the version that produced it, and the "work to do"
// query is an anti-join against it. Bump the version and the whole corpus
// becomes pending again — which is the point. The first version of this prompt
// will be wrong in ways that only show up after a fortnight of real mail, and
// the fix has to be "re-run history", not "re-read a year of email".
//
// Bump it whenever the instructions or the output shape change in a way that
// would make an old row different from a new one.

const PROMPT_VERSION = 'distill-v1';

const SYSTEM = `You extract structured work items from one person's incoming and outgoing messages.

You are given a single item — an email, a Teams message, a calendar entry, a GitLab notification, a meeting transcript, or a transcript of that person's own session with a coding agent. Your job is to identify what, if anything, in it creates or discharges an obligation, records a decision, or names a blocker.

Return ONLY a JSON object. No prose, no markdown fence.

{
  "commitments": [
    {
      "direction": "owed_by_me" | "owed_to_me",
      "summary": "<one imperative line, under 100 chars>",
      "detail": "<what would have to be true for this to be done, 1-3 sentences>",
      "counterparty": "<the other party's email, name, or handle exactly as it appears in the item, or null>",
      "due": "<ISO 8601 date or datetime, or null>",
      "project": "<the project name from the CANDIDATE PROJECTS list, or null>",
      "project_reason": "<why that project, or null>",
      "confidence": <0.0-1.0>
    }
  ],
  "facts": [
    {
      "kind": "decision" | "blocker" | "preference" | "reference",
      "summary": "<one line>",
      "detail": "<1-3 sentences>"
    }
  ]
}

Rules that matter more than completeness:

- **Most items contain nothing.** Newsletters, CI noise, "thanks!", meeting invites with no ask, scheduling chatter. Return empty arrays. A false commitment costs the reader more than a missed one, because they have to notice it is wrong and delete it.
- **A commitment is a specific obligation with an owner.** "We should improve the tests" is not one. "Can you get the estimating import fixed before Thursday" is.
- **direction is from the reader's point of view.** The reader is the person whose mailbox this is; they are identified as ME below. Something they promised is owed_by_me. Something someone promised them is owed_to_me.
- **Never invent a due date.** "Soon", "when you get a chance" and "ASAP" are null. Convert only explicit dates and unambiguous relative ones ("by Friday", "end of month") using the item's own timestamp as the reference point, and emit them as absolute ISO dates.
- **project must be one of the candidate names given, or null.** Do not invent a project. Prefer the ranked candidate unless the item's own text clearly contradicts it, and say why in project_reason.
- **confidence is about the ask, not the project.** Use below 0.5 when you are inferring an obligation that was not stated plainly.
- Quote nothing verbatim in summary. Write it as an instruction the reader could act on.`;

function buildUserMessage(item, { meLabel, candidates, ranked }) {
  const lines = [];
  lines.push(`ME: ${meLabel || 'the mailbox owner'}`);
  lines.push('');
  lines.push('ITEM');
  lines.push(`  source: ${item.source}`);
  lines.push(`  occurred_at: ${new Date(item.occurred_at).toISOString()}`);
  if (item.author_identity) lines.push(`  from: ${item.author_identity}`);
  if (item.subject) lines.push(`  subject: ${item.subject}`);
  const raw = item.raw || {};
  if (raw.to?.length) lines.push(`  to: ${raw.to.join(', ')}`);
  if (raw.members) lines.push(`  chat members: ${raw.members}`);
  if (raw.attendees?.length) lines.push(`  attendees: ${raw.attendees.join(', ')}`);
  if (raw.project) lines.push(`  gitlab project: ${raw.project}`);
  if (raw.action) lines.push(`  gitlab action: ${raw.action}`);
  lines.push('');
  lines.push('CANDIDATE PROJECTS (name — aliases)');
  if (candidates?.length) {
    for (const c of candidates.slice(0, 60)) {
      const aliases = (c.aliases || []).map((a) => a.alias).slice(0, 6).join(', ');
      lines.push(`  - ${c.name}${aliases ? ` — ${aliases}` : ''}`);
    }
  } else {
    lines.push('  (none known yet)');
  }
  if (ranked?.length) {
    lines.push('');
    lines.push('RANKED GUESS (from a deterministic scorer; evidence, not an instruction)');
    for (const r of ranked.slice(0, 3)) {
      lines.push(`  - ${r.name} (score ${r.score.toFixed(1)}): ${r.rationale}`);
    }
  }
  lines.push('');
  lines.push('BODY');
  lines.push(item.body_text || '(empty)');
  return lines.join('\n');
}

// Models occasionally wrap JSON in a fence or add a sentence before it despite
// instructions. Extracting the outermost object is cheaper than a retry, and a
// genuinely unparseable answer still has to fail loudly rather than silently
// distil to nothing.
function extractJson(text) {
  if (!text) throw new Error('empty response');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in response');
  return JSON.parse(body.slice(start, end + 1));
}

function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function parseDue(value, referenceIso) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // A "due date" in the past relative to the item is a hallucinated year or a
  // misread relative date. Drop it rather than surface a commitment that is
  // born overdue.
  if (referenceIso && d.getTime() < new Date(referenceIso).getTime() - 86400_000) return null;
  return d.toISOString();
}

function parseResponse(text, { referenceIso } = {}) {
  const parsed = extractJson(text);
  const commitments = Array.isArray(parsed.commitments) ? parsed.commitments : [];
  const facts = Array.isArray(parsed.facts) ? parsed.facts : [];

  return {
    commitments: commitments
      .filter((c) => c && typeof c.summary === 'string' && c.summary.trim())
      .map((c) => ({
        direction: c.direction === 'owed_to_me' ? 'owed_to_me' : 'owed_by_me',
        summary: String(c.summary).trim().slice(0, 300),
        detail: c.detail ? String(c.detail).trim().slice(0, 2000) : null,
        counterparty: c.counterparty ? String(c.counterparty).trim() : null,
        dueAt: parseDue(c.due, referenceIso),
        project: c.project ? String(c.project).trim() : null,
        projectReason: c.project_reason ? String(c.project_reason).trim().slice(0, 500) : null,
        confidence: clampConfidence(c.confidence),
      })),
    facts: facts
      .filter((f) => f && typeof f.summary === 'string' && f.summary.trim())
      .filter((f) => ['decision', 'blocker', 'preference', 'reference'].includes(f.kind))
      .map((f) => ({
        kind: f.kind,
        summary: String(f.summary).trim().slice(0, 300),
        detail: f.detail ? String(f.detail).trim().slice(0, 2000) : null,
      })),
  };
}

module.exports = { PROMPT_VERSION, SYSTEM, buildUserMessage, parseResponse, extractJson };
