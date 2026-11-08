'use strict';

// Where the registry's facts come from. Each reader returns plain data and
// never throws for a source that is unavailable: it returns what it could and
// an `error` the sync reports, so one dead source never stops the others.
//
//   github   your PRs (GraphQL search, author = the signed-in `gh` user) and
//            commits (commit search) — through `gh`, no token in `.env`
//   git      each clone under the repos root: remote HEAD, branches, the
//            date of your last commit
//   sessions Claude sessions already ingested (source_item claude_session):
//            which folders you worked in, on which machine, on which branch
//   raven    INNERGY's knowledge base: the authoritative repo map
//   readme   a clone's README and manifests, the material for a profile
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { config } = require('../config.ts');
const repo = require('../repo');
const { gh } = require('../ingest/github.ts');
const merge = require('./merge.ts');

function git(dir: any, args: any, timeoutMs: number = 20_000) {
  return new Promise<any>((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err: any, stdout: any) =>
      resolve(err ? null : String(stdout).trim())
    );
  });
}

// ------------------------------------------------------------- github ----

const PR_SEARCH = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title state isDraft url body createdAt updatedAt mergedAt closedAt
        headRefName baseRefName author { login } repository { nameWithOwner }
      }
    }
  }
}`;

async function githubLogin() {
  return String(await gh(['api', 'user', '--jq', '.login'])).trim();
}

/**
 * Your PRs, newest-updated first. `since` limits it to PRs updated since then
 * (the hourly pass); without it, everything the search API will return (1000).
 */
async function githubPrs({ login, since = null, maxPages = 10 }: { login?: any | null; since?: any | null; maxPages?: number } = {}) {
  const q = `is:pr author:${login} sort:updated-desc${since ? ` updated:>=${new Date(since).toISOString().slice(0, 10)}` : ''}`;
  const out: any[] = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const args = ['api', 'graphql', '-f', `query=${PR_SEARCH}`, '-f', `q=${q}`];
    if (after) args.push('-f', `after=${after}`);
    const data = JSON.parse(await gh(args, { timeoutMs: 90_000 }));
    const s = data.data.search;
    for (const n of s.nodes || []) {
      if (!n || !n.repository) continue;
      out.push({
        repo: n.repository.nameWithOwner,
        number: n.number,
        title: n.title,
        state: merge.prState(n),
        draft: !!n.isDraft,
        url: n.url,
        body: (n.body || '').slice(0, 8000),
        summary: merge.prSummary(n.body),
        headRef: n.headRefName || null,
        baseRef: n.baseRefName || null,
        author: n.author?.login || login,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        mergedAt: n.mergedAt,
        closedAt: n.closedAt,
      });
    }
    if (!s.pageInfo.hasNextPage) break;
    after = s.pageInfo.endCursor;
  }
  return out;
}

/** Last commit you authored per repo, from GitHub's commit search. */
async function githubCommits({ login, limit = 300 }: { login?: any | null; limit?: number } = {}) {
  const raw = await gh(
    ['search', 'commits', '--author', login, '--sort', 'committer-date', '--order', 'desc', '--limit', String(limit), '--json', 'repository,commit'],
    { timeoutMs: 90_000 }
  );
  const byRepo = new Map<any, any>();
  for (const c of JSON.parse(raw)) {
    const repo = c.repository?.fullName;
    const at = c.commit?.committer?.date || c.commit?.author?.date;
    if (!repo || !at) continue;
    const prev = byRepo.get(repo);
    if (!prev || new Date(at) > new Date(prev.at)) byRepo.set(repo, { repo, at, count: (prev?.count || 0) + 1 });
    else prev.count++;
  }
  return [...byRepo.values()];
}

/** A GitHub repo's metadata, for a repo with no clone here. */
async function githubRepoInfo(fullName: any) {
  try {
    const r = JSON.parse(await gh(['api', `repos/${fullName}`]));
    return { description: r.description || null, defaultBranch: r.default_branch || null, language: r.language || null, archived: !!r.archived };
  } catch {
    return null;
  }
}

async function githubReadme(fullName: any) {
  try {
    return String(await gh(['api', `repos/${fullName}/readme`, '-H', 'Accept: application/vnd.github.raw'])).slice(0, 6000);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- git ----

let emailCache: Set<string> | null = null;
async function myEmails(dir: any) {
  if (!emailCache) {
    const global = await new Promise<string>((resolve) =>
      execFile('git', ['config', '--global', 'user.email'], { windowsHide: true }, (err: any, out: any) => resolve(err ? '' : String(out).trim()))
    );
    emailCache = new Set([global].filter(Boolean).map((e) => e.toLowerCase()));
  }
  const local = await git(dir, ['config', 'user.email']);
  const out = new Set(emailCache);
  if (local) out.add(local.toLowerCase());
  return out;
}

/**
 * One clone: its remote HEAD, current branch, recent branches (yours marked)
 * and your last commit. `git log --author` is bounded to a year, so a large
 * history (the ERP) is not walked end to end every hour.
 */
async function cloneFacts(dir: any, { machine = os.hostname() }: { machine?: any } = {}) {
  const emails = await myEmails(dir);
  const head = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const defaultBranch = head ? head.replace(/^origin\//, '') : null;
  const current = await git(dir, ['branch', '--show-current']);
  const refs = await git(dir, ['for-each-ref', '--sort=-committerdate', '--count=15', 'refs/heads', '--format=%(refname:short)%09%(committerdate:iso-strict)%09%(authoremail)']);
  const branches = (refs || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l: any) => {
      const [name, at, email] = l.split('\t');
      return { name, at, mine: emails.has(String(email || '').replace(/[<>]/g, '').toLowerCase()), current: name === current, machine, source: 'local' };
    });
  let lastCommitAt = null;
  if (emails.size) {
    const authors = [...emails].map((e) => `--author=${e}`);
    lastCommitAt = (await git(dir, ['log', '-1', '--all', '--since=1.year', '--format=%cI', ...authors], 30_000)) || null;
  }
  return { defaultBranch, current, branches, lastCommitAt };
}

// ----------------------------------------------------------- sessions ----

/**
 * Claude sessions grouped by the repo folder they ran in, per machine.
 * Remote machines' roots come from PA_MACHINES; this machine's is the repos
 * root. A session outside every root (a temp dir, the home folder) is not
 * evidence of any repo and is skipped.
 * @returns {Array<{machine, dir, path, count, lastAt, branches:[{name, at}]}>}
 */
async function sessionDirs({ machines = config.termhub.machines, reposRoot = config.reposRoot, hostname = os.hostname() }: { machines?: any; reposRoot?: any; hostname?: any } = {}) {
  const list = await repo.sources.claudeSessionFolders();
  const rootsFor = (m: any) => {
    if (!m || m === hostname) return [reposRoot];
    const conf = machines?.[m];
    return conf?.reposRoot ? [conf.reposRoot] : [];
  };
  const groups = new Map<any, any>();
  for (const s of list) {
    const machine = s.machine || hostname;
    const hit = merge.sessionDir(s.cwd, rootsFor(s.machine));
    if (!hit) continue;
    const key = `${machine}\u0000${hit.dir.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { machine, dir: hit.dir, path: hit.path, count: 0, lastAt: null, branches: new Map<any, any>() });
    const g = groups.get(key);
    g.count++;
    const at = s.occurred_at ? new Date(s.occurred_at).toISOString() : null;
    if (at && (!g.lastAt || at > g.lastAt)) g.lastAt = at;
    if (s.branch && s.branch !== 'HEAD') {
      const prev = g.branches.get(s.branch);
      if (!prev || (at && at > prev.at)) g.branches.set(s.branch, { name: s.branch, at, machine, mine: true, source: 'session' });
    }
  }
  return [...groups.values()].map((g) => ({ ...g, branches: [...g.branches.values()] }));
}

// -------------------------------------------------------------- raven ----

const RAVEN_REPOS = 'knowledge/systems/repositories.md';

/**
 * raven's repo map: live from GitHub main (what the innergy-knowledge skill
 * reads), else a local clone's copy.
 * @returns {{map: Map, from: string}|{map: Map, error: string}}
 */
async function ravenRepos(localClone: any | null = null) {
  try {
    const md = await gh(['api', `repos/innergy-dev/raven/contents/${RAVEN_REPOS}`, '-H', 'Accept: application/vnd.github.raw']);
    return { map: merge.parseRavenRepos(md), from: 'github', systems: await ravenSystems() };
  } catch (err: any) {
    if (localClone) {
      try {
        const md = fs.readFileSync(path.join(localClone, RAVEN_REPOS), 'utf8');
        let systems: any[] = [];
        try {
          systems = fs.readdirSync(path.join(localClone, 'knowledge', 'systems'), { withFileTypes: true }).filter((e: any) => e.isDirectory()).map((e: any) => e.name);
        } catch {
          /* no systems dir */
        }
        return { map: merge.parseRavenRepos(md), from: 'local', systems };
      } catch {
        /* fall through */
      }
    }
    return { map: new Map<any, any>(), error: String(err.message).split('\n')[0] };
  }
}

// The per-system folders (knowledge/systems/erp/, design/, …): a repo with one
// has a deep doc, and its card links to it.
async function ravenSystems() {
  try {
    const list = JSON.parse(await gh(['api', 'repos/innergy-dev/raven/contents/knowledge/systems']));
    return list.filter((e: any) => e.type === 'dir').map((e: any) => e.name);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- readme ----

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'requirements.txt', 'Directory.Build.props', 'global.json'];

function readSafe(p: any, max: any) {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return null;
  }
}

/**
 * What a model needs to say what a repo is: its README's head and its
 * manifests' identifying parts. Plus a hash of exactly that, so a profile is
 * made again only when the material changes.
 */
function cloneMaterial(dir: any) {
  let readme = null;
  for (const name of ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README']) {
    readme = readSafe(path.join(dir, name), 5000);
    if (readme) break;
  }
  const manifests: any[] = [];
  for (const m of MANIFESTS) {
    const text = readSafe(path.join(dir, m), 4000);
    if (!text) continue;
    if (m === 'package.json') {
      try {
        const pkg = JSON.parse(text);
        const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).slice(0, 25);
        manifests.push(`package.json: name=${pkg.name || ''} description=${pkg.description || ''} deps=${deps.join(',')}`);
      } catch {
        manifests.push(`package.json (unparseable)`);
      }
    } else manifests.push(`${m}: ${text.slice(0, 600)}`);
  }
  let top: any[] = [];
  try {
    top = fs.readdirSync(dir).filter((n: any) => !n.startsWith('.')).slice(0, 40);
    if (top.some((n) => /\.sln$/i.test(n))) manifests.push(`solution: ${top.filter((n) => /\.sln$/i.test(n)).join(', ')}`);
  } catch {
    /* unreadable dir */
  }
  return { readme, manifests, top };
}

function materialHash(m: any) {
  return crypto.createHash('sha1').update(JSON.stringify(m)).digest('hex').slice(0, 16);
}

module.exports = {
  git,
  githubLogin,
  githubPrs,
  githubCommits,
  githubRepoInfo,
  githubReadme,
  cloneFacts,
  sessionDirs,
  ravenRepos,
  cloneMaterial,
  materialHash,
};
