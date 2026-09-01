'use strict';

// The BRIEF.md a dispatched session wakes up next to.
//
// This file *is* the product. Everything upstream — capture, distillation,
// identity, the project scorer — exists so that this document can say who
// asked, in their words, for what, in which repo, and where the session must
// stop. A session that starts with this does not need you to re-type the
// context, which was the entire bottleneck.
//
// Two things it deliberately does not do: it does not summarise the ask into
// the assistant's own words where the requester's words exist (paraphrase is
// where meaning goes missing), and it does not repeat the org's engineering
// conventions inline — it points at the `innergy-knowledge` skill, because a
// second copy of those conventions goes stale and then gets trusted.

const { mode: resolveMode, describe } = require('./modes');

function fence(text) {
  const body = String(text || '').trim();
  if (!body) return '_(empty)_';
  const ticks = body.includes('```') ? '````' : '```';
  return `${ticks}text\n${body}\n${ticks}`;
}

function buildBrief({ commitment, item, project, person, modeName, run, related = [] }) {
  const m = resolveMode(modeName);
  const lines = [];

  lines.push(`# ${commitment ? commitment.summary : run.task}`);
  lines.push('');
  lines.push(
    `Dispatched by the personal assistant, run #${run.id}, mode \`${m.name}\` — this session may ${describe(m.name)}.`
  );
  lines.push('');

  lines.push('## Stop condition');
  lines.push('');
  lines.push(m.stopCondition);
  lines.push('');
  if (!m.mayPush) {
    lines.push(
      '> Pushing is blocked at the git level for this run, not merely discouraged. If you find yourself wanting to push, that is the signal to stop and say so.'
    );
    lines.push('');
  }

  lines.push('## The ask');
  lines.push('');
  if (person) lines.push(`**From:** ${person.display_name}${person.primary_email ? ` <${person.primary_email}>` : ''}`);
  if (item) {
    lines.push(`**Where:** ${sourceLabel(item.source)}${item.subject ? ` — ${item.subject}` : ''}`);
    lines.push(`**When:** ${new Date(item.occurred_at).toISOString()}`);
  }
  if (commitment?.due_at) lines.push(`**Due:** ${new Date(commitment.due_at).toISOString().slice(0, 10)}`);
  lines.push('');
  if (item?.body_text) {
    lines.push('In their own words:');
    lines.push('');
    lines.push(fence(item.body_text.slice(0, 6000)));
    lines.push('');
  }
  if (commitment?.detail) {
    lines.push(`**What "done" looks like:** ${commitment.detail}`);
    lines.push('');
  }

  if (project) {
    lines.push('## Where');
    lines.push('');
    lines.push(`**Project:** ${project.name}${project.gitlab_path ? ` (\`${project.gitlab_path}\`)` : ''}`);
    if (run.worktree_path) lines.push(`**Worktree:** \`${run.worktree_path}\``);
    if (run.branch) lines.push(`**Branch:** \`${run.branch}\``);
    if (commitment && commitment.project_confidence !== null && commitment.project_confidence < 0.6) {
      lines.push('');
      lines.push(
        `> The repo was **guessed** (${Math.round(commitment.project_confidence * 100)}% — ${commitment.project_rationale || 'no rationale recorded'}). Check that before you write anything. If it is wrong, stop and say so rather than working in the wrong repo.`
      );
    }
    lines.push('');
  }

  if (related.length) {
    lines.push('## Related context');
    lines.push('');
    for (const r of related.slice(0, 6)) {
      lines.push(`- ${sourceLabel(r.source)} ${new Date(r.occurred_at).toISOString().slice(0, 10)} — ${r.subject || '(no subject)'}`);
    }
    lines.push('');
  }

  lines.push('## Conventions');
  lines.push('');
  lines.push(
    '- Follow this repo\'s own `CLAUDE.md` / `AGENT.md` first; they win over anything below.'
  );
  lines.push(
    '- For cross-repo or org-wide conventions, use the `innergy-knowledge` skill rather than assuming. Do not copy its content in here.'
  );
  lines.push(
    '- The assistant\'s own store is available through the `pa` MCP server: `search_context`, `get_thread`, `who_is`, `open_commitments`. Use it when the ask references something not quoted above.'
  );
  lines.push('');
  lines.push('## When you are done');
  lines.push('');
  lines.push(
    `Leave the working tree in a state a human can read: a clean \`git status\`${m.mayCommit ? ' with your work committed' : ''}, and a one-paragraph summary of what changed and what you deliberately did not do.`
  );
  if (m.mayDraftReply) {
    lines.push('');
    lines.push(
      'Write that summary as a reply to the requester in `REPLY.md`, addressed to them, in plain language, no bullet-point dump. It will be reviewed by a human before anything is sent.'
    );
  }
  lines.push('');

  return lines.join('\n');
}

function sourceLabel(source) {
  return (
    {
      graph_mail: 'Email',
      graph_chat: 'Teams chat',
      graph_event: 'Calendar',
      gitlab_todo: 'GitLab todo',
      gitlab_mr: 'GitLab MR',
      gitlab_issue: 'GitLab issue',
      audio: 'Recorded conversation',
      claude_session: 'Your Claude session',
    }[source] || source
  );
}

// The first thing typed at the session. Short on purpose: the brief is the
// context, and repeating it into the prompt just burns tokens twice.
function openingPrompt(run) {
  return `Read BRIEF.md in this worktree, then do what it asks. It states where you must stop; that boundary is enforced outside this session, so treat it as a fact rather than a preference.`;
}

module.exports = { buildBrief, openingPrompt, sourceLabel };
