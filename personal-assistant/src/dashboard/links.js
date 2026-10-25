'use strict';

// Where a card came from, as links: the message, the person, the repo, the PRs
// it mentions, the Claude session it was read from. Pure and deterministic —
// built from what ingest already stored, never from a model — so a card can be
// checked against its source in one click (test/links.test.js).
//
//   sourceLinks(item, hubs)        the source item: Teams message, mail, PR, Jira, session
//   personLinks(person)            a Teams chat with them, their GitHub
//   repoLink(path)                 github.com/<owner>/<repo>
//   mentionedLinks(text)           GitHub PR/issue/branch/commit and Jira URLs in the text
//   cardLinks({...})               all of the above for one card, deduplicated
//
// A link is `{kind, label, url}`; a Claude session is `{machine, cwd, id, at,
// resume, transcriptUrl, itemId}` because the useful thing about one is where it
// ran and how to get back into it, not a URL. `hubs` is `{local, machines}`:
// this machine's termhub URL and each PA_MACHINES name's.

const SOURCE_LABEL = {
  graph_mail: 'Email', graph_chat: 'Teams message', graph_event: 'Calendar event',
  github_notification: 'GitHub', github_pr: 'GitHub PR', github_issue: 'GitHub issue',
  github_project_item: 'GitHub board item', jira_issue: 'Jira',
};

function isHttp(url) {
  return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url);
}

// Teams ids are `{chatId}/{messageId}`: when the connector gave no webUrl, the
// message deep link is the same one Teams itself builds.
function teamsMessageUrl(externalId) {
  const m = /^(19:[^/]+)\/(\d+)$/.exec(String(externalId || ''));
  if (!m) return null;
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(m[1])}/${m[2]}?context=${encodeURIComponent('{"contextType":"chat"}')}`;
}

/** A Teams 1:1 chat with someone, by their work address. */
function teamsChatUrl(email) {
  const e = String(email || '').trim();
  if (!/^[^\s@/?#]+@[^\s@/?#]+\.[^\s@/?#]+$/.test(e)) return null;
  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(e)}`;
}

/** github.com/<owner>/<repo> for a project path, or null if it is not one. */
function repoLink(path) {
  const p = String(path || '').trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(p)) return null;
  return { kind: 'repo', label: p, url: `https://github.com/${p}` };
}

/** The termhub base URL for a machine name ('' or unknown: this machine). */
function hubFor(hubs, machine) {
  const base = (machine && hubs?.machines?.[machine]) || hubs?.local || null;
  return base ? String(base).replace(/\/+$/, '') : null;
}

// termhub serves ~/.claude/projects as `<project>/<file>.jsonl`. A remote
// session's raw.transcript is already that id; a local one is the full path.
function transcriptId(transcript) {
  const parts = String(transcript || '').split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2 || !/\.jsonl$/i.test(parts[parts.length - 1])) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** A Claude session item, as where it ran and how to get back into it. */
function sessionInfo(item, hubs) {
  if (!item || item.source !== 'claude_session') return null;
  const raw = item.raw || {};
  const machine = raw.machine || null;
  const ext = String(item.external_id || '');
  const id = machine && ext.startsWith(`${machine}:`) ? ext.slice(machine.length + 1) : ext;
  const base = hubFor(hubs, machine);
  const tid = transcriptId(raw.transcript);
  return {
    itemId: item.id != null ? Number(item.id) : null,
    machine: machine || 'this machine',
    remote: Boolean(machine),
    cwd: raw.cwd || null,
    branch: raw.gitBranch || null,
    id: /^[0-9a-f-]{36}$/i.test(id) ? id : null,
    at: item.occurred_at || null,
    title: item.subject || null,
    resume: /^[0-9a-f-]{36}$/i.test(id) ? `claude --resume ${id}` : null,
    transcriptUrl: base && tid ? `${base}/api/claude/transcript?id=${encodeURIComponent(tid)}` : null,
  };
}

/** Links to a source item itself. `label` names the kind of thing it opens. */
function sourceLinks(item, { kind = 'source', prefix = '' } = {}) {
  if (!item) return [];
  const raw = item.raw || {};
  const out = [];
  const add = (label, url) => {
    if (isHttp(url)) out.push({ kind, label: prefix ? `${prefix} ${label}` : label, url });
  };
  switch (item.source) {
    case 'graph_chat': {
      const where = raw.chatTopic ? ` in “${raw.chatTopic}”` : raw.chatType === 'oneOnOne' ? ' (1:1 chat)' : '';
      add(`Teams message${where}`, raw.webUrl || teamsMessageUrl(item.external_id));
      break;
    }
    case 'graph_mail':
      add('Email in Outlook', raw.webLink);
      break;
    case 'graph_event':
      add('Calendar event', raw.webLink);
      break;
    case 'jira_issue': {
      const key = String(item.subject || '').match(/^[A-Z][A-Z0-9]+-\d+/);
      add(key ? `Jira ${key[0]}` : 'Jira issue', raw.webUrl);
      break;
    }
    default:
      if (String(item.source || '').startsWith('github')) {
        add(githubLabel(raw.webUrl) || SOURCE_LABEL[item.source] || 'GitHub', raw.webUrl || (isHttp(item.thread_external_id) ? item.thread_external_id : null));
        if (raw.boardUrl && raw.boardUrl !== raw.webUrl) add(`board ${raw.board || ''}`.trim(), raw.boardUrl);
      } else {
        add(SOURCE_LABEL[item.source] || 'source', raw.webUrl || raw.webLink || raw.url);
      }
  }
  return out;
}

// A label for a GitHub URL: "PR owner/repo#12", "issue owner/repo#3",
// "branch owner/repo:name", "commit owner/repo@abc1234", or the repo itself.
function githubLabel(url) {
  const m = /^https?:\/\/github\.com\/([\w.-]+\/[\w-]+(?:\.(?!git\b)[\w-]+)*)(?:\/(pull|issues|tree|commit|compare|blob)\/([^\s?#]+))?/i.exec(String(url || ''));
  if (!m) return null;
  const [, repo, what, rest] = m;
  if (!what) return repo;
  if (/^blob$/i.test(what)) return `file ${repo}/${decodeURIComponent(rest).split('/').slice(1).join('/')}`;
  const ref = decodeURIComponent(rest.replace(/[/.,;:)\]]+$/, ''));
  if (/^pull$/i.test(what)) return `PR ${repo}#${ref.split('/')[0]}`;
  if (/^issues$/i.test(what)) return `issue ${repo}#${ref.split('/')[0]}`;
  if (/^tree$/i.test(what)) return `branch ${repo}:${ref}`;
  if (/^commit$/i.test(what)) return `commit ${repo}@${ref.slice(0, 7)}`;
  return `compare ${repo} ${ref}`;
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]}|]+/gi;

/** GitHub and Jira links found in free text, labelled and deduplicated. */
function mentionedLinks(text, { limit = 6 } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(URL_RE)) {
    let url = m[0].replace(/[.,;:!?*_]+$/, '');
    let label = null;
    if (/^https?:\/\/github\.com\//i.test(url)) {
      // A PR's sub-page (files, a comment anchor) is still that PR.
      const pr = /^(https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+)/i.exec(url);
      if (pr) url = pr[1];
      label = githubLabel(url);
      // github.com itself, an org or a user page: not a thing the card is about.
      if (!label) continue;
      // A repo named in passing may not be the card's project.
      if (!/ /.test(label)) url = `https://github.com/${label}`;
    } else {
      const jira = /^https?:\/\/[\w.-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(url);
      if (!jira) continue;
      url = jira[0];
      label = `Jira ${jira[1]}`;
    }
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'mention', label, url });
    if (out.length >= limit) break;
  }
  return out;
}

/** A Teams chat with the person, and their GitHub. Nothing for me. */
function personLinks(person) {
  if (!person || person.is_me || !person.name) return [];
  const out = [];
  const chat = teamsChatUrl(person.email);
  if (chat) out.push({ kind: 'person', label: `Chat with ${person.name}`, url: chat });
  if (person.github && /^[\w-]+$/.test(person.github)) {
    out.push({ kind: 'person', label: `${person.name} on GitHub`, url: `https://github.com/${person.github}` });
  }
  return out;
}

/**
 * Everything a card links to, in reading order: where it came from, who, which
 * repo, what it mentions, any PR a run opened, and — for a "Looks done?" card —
 * the item that suggests it is settled. Each URL once.
 *
 * @param {object} o
 * @param {object} o.item       the commitment's source_item {id, source, external_id, thread_external_id, raw, subject, occurred_at}
 * @param {string} [o.text]     text to look for mentioned links in
 * @param {object} [o.person]   {name, email, github, is_me}
 * @param {string} [o.project]  project path (owner/repo)
 * @param {Array}  [o.runs]     [{id, mr_url}]
 * @param {object} [o.evidence] the evidence source_item, same shape as item
 * @param {object} [o.hubs]     {local, machines}
 */
function cardLinks({ item, text = '', person = null, project = null, runs = [], evidence = null, hubs = {} }) {
  const all = [
    ...sourceLinks(item),
    ...personLinks(person),
    ...[repoLink(project)].filter(Boolean),
    ...mentionedLinks(text),
    ...(runs || []).filter((r) => isHttp(r.mr_url)).map((r) => ({ kind: 'run', label: `${githubLabel(r.mr_url) || 'PR'} (run #${r.id})`, url: r.mr_url })),
    ...(evidence ? sourceLinks(evidence, { kind: 'evidence', prefix: 'evidence:' }) : []),
  ];
  const seen = new Set();
  const links = [];
  for (const l of all) {
    const key = l.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(l);
  }
  const sessions = [sessionInfo(item, hubs), evidence ? sessionInfo(evidence, hubs) : null]
    .map((s, i) => (s ? { ...s, role: i === 0 ? 'source' : 'evidence' } : null))
    .filter(Boolean);
  return { links, sessions };
}

module.exports = {
  cardLinks, sourceLinks, personLinks, repoLink, mentionedLinks, sessionInfo, teamsChatUrl,
  teamsMessageUrl, githubLabel, transcriptId, hubFor,
};
