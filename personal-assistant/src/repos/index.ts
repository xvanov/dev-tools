'use strict';

// The repo registry: one `project` row per repo you work in, kept current
// from evidence — never from what a conversation happened to mention.
//
// A repo gets here because a source shows you working in it: a clone under
// the repos root, a PR or commit of yours on GitHub, a Claude session that ran
// in its folder on any machine (PA_MACHINES), or `pa repos add`. What it *is*
// comes from raven's repo map when raven covers it, else from a profile the
// cheap model writes from its README and manifests (only when that material
// changes). Your edits (`pa repos set|alias|hide`) live in their own columns
// and always win over what sync finds.
//
// The resolver (src/projects/resolve.js) resolves against these rows, so the
// names, aliases, remote paths and per-machine folders gathered here are the
// vocabulary an ask is matched with.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../config.ts');
const repo = require('../repo');
const projects = require('../projects');
const sources = require('./sources.ts');
const merge = require('./merge.ts');
const { logger } = require('../log.ts');

const log = logger('repos');

async function loadRows() {
  const list = await repo.repos.allRows();
  const aliases = await repo.repos.allAliases();
  const byProject = new Map<any, any>();
  for (const a of aliases) {
    if (!byProject.has(a.project_id)) byProject.set(a.project_id, []);
    byProject.get(a.project_id).push(a.alias);
  }
  return list.map((r: any) => ({
    ...r,
    aliases: byProject.get(r.id) || [],
    paths: Object.values(r.local_paths || {}).flat(),
    remote_paths: (r.remote_urls || []).map((u: any) => projects.pathFromRemote(u)).filter(Boolean),
  }));
}

// A sync's view of one row: the facts gathered this pass, written once at the end.
function draft(row: any) {
  return {
    row,
    forge: row.forge,
    remoteUrls: new Set(row.remote_urls || []),
    localPaths: {} as Record<string, any>,
    defaultBranch: row.default_branch,
    branches: [] as any[],
    lastCommitAt: null,
    lastSessionAt: null,
    sessionCount: 0,
    raven: null,
    ravenDoc: null,
    material: null,
    forgeInfo: null,
  };
}

function addPath(d: any, machine: any, p: any) {
  if (!p) return;
  const list = d.localPaths[machine] || (d.localPaths[machine] = []);
  if (!list.some((x: any) => x.toLowerCase() === p.toLowerCase())) list.push(p);
}

async function insertRow({ name, gitlabPath, forge, origin }: { name?: any | null; gitlabPath?: any | null; forge?: any | null; origin?: any | null }) {
  const id = await repo.repos.insert({ name, gitlabPath, forge, origin });
  if (gitlabPath) {
    await projects.addAlias(id, gitlabPath);
    await projects.addAlias(id, gitlabPath.split('/').pop());
  }
  await projects.addAlias(id, name);
  return id;
}

/**
 * The archived original of a repo that moved forge (GitLab innergy/x →
 * GitHub innergy-dev/x) becomes the moved repo: same name, same commitments,
 * new path. Its old path stays as an alias. Its folder, if gone, is cleared
 * rather than kept as a path dispatch would try to use.
 */
async function takeOver(row: any, fullName: any, forge: any) {
  const keepPath = row.repo_path && fs.existsSync(row.repo_path) ? row.repo_path : null;
  await repo.repos.takeOver(row.id, fullName, forge, keepPath);
  if (row.gitlab_path) await projects.addAlias(row.id, row.gitlab_path);
  await projects.addAlias(row.id, fullName);
}

async function prSince(full: any) {
  if (full) return null;
  const r = await repo.repos.lastPrUpdate();
  if (!r?.at) return null;
  return new Date(new Date(r.at).getTime() - 3 * 86400_000);
}

async function upsertPrs(prs: any, projectIdFor: any) {
  let n = 0;
  for (const p of prs) {
    await repo.repos.upsertPr(projectIdFor(p.repo), p);
    n++;
  }
  return n;
}

/**
 * One pass over every source. Never throws for a dead source: each one's
 * outcome is in `report.sources`.
 * @param {object}  o
 * @param {boolean} [o.full]     re-read every PR, and re-check every repo's profile material
 * @param {boolean} [o.profile]  allow model calls for new/changed repos (default config.repos.profile)
 */
async function sync({ full = false, profile = config.repos.profile }: { full?: boolean; profile?: any } = {}) {
  const host = os.hostname();
  const report: Record<string, any> = { sources: {}, created: [], tookOver: [], prs: 0, profiled: 0 };
  const ok = (name: any, detail: any) => (report.sources[name] = { ok: true, ...detail });
  const fail = (name: any, err: any) => {
    report.sources[name] = { ok: false, error: String(err?.message || err).split('\n')[0]!.slice(0, 300) };
    log.warn('repo source failed', { source: name, error: report.sources[name].error });
  };

  // 1. Clones under the repos root: the existing project seeding and retiring.
  try {
    const seeded = await projects.sync();
    ok('local', { clones: seeded.length, retired: (seeded.retired || []).length });
  } catch (err: any) {
    fail('local', err);
  }

  let all = await loadRows();
  const drafts = new Map<any, any>(all.map((r: any) => [r.id, draft(r)]));
  const refresh = async () => {
    all = await loadRows();
    for (const r of all) if (!drafts.has(r.id)) drafts.set(r.id, draft(r));
    for (const r of all) drafts.get(r.id).row = r;
  };

  // 2. Each clone's facts. Folders sharing a remote (a clone and its copies)
  // all belong to the one project; projects.groupRepos already chose which.
  try {
    let n = 0;
    for (const group of projects.groupRepos(projects.scanRepos(config.reposRoot))) {
      const row = all.find((r: any) => r.active && r.repo_path && r.repo_path.toLowerCase() === group.repoPath.toLowerCase());
      if (!row) continue;
      const d = drafts.get(row.id);
      addPath(d, host, group.repoPath);
      for (const other of group.others) addPath(d, host, path.join(config.reposRoot, other));
      const remote = await sources.git(group.repoPath, ['remote', 'get-url', 'origin']);
      if (remote) {
        d.remoteUrls.add(remote);
        d.forge = merge.forgeOf(remote) || d.forge;
      }
      const facts = await sources.cloneFacts(group.repoPath, { machine: host });
      d.defaultBranch = facts.defaultBranch || d.defaultBranch;
      d.branches.push(...facts.branches);
      d.lastCommitAt = facts.lastCommitAt;
      n++;
    }
    ok('git', { clones: n });
  } catch (err: any) {
    fail('git', err);
  }

  // 3. GitHub: your PRs and commits, and the repos they are in.
  const prRepoIds = new Map<any, any>();
  try {
    const login = await sources.githubLogin();
    const since = await prSince(full);
    const prs = await sources.githubPrs({ login, since });
    let commits: any[] = [];
    try {
      commits = await sources.githubCommits({ login });
    } catch (err: any) {
      fail('github-commits', err);
    }
    const repos = new Set([...prs.map((p: any) => p.repo), ...commits.map((c) => c.repo)]);
    for (const fullName of repos) {
      const place = merge.placeForgeRepo(fullName, all);
      let id = place.id;
      if (place.action === 'insert') {
        id = await insertRow({ name: place.name, gitlabPath: fullName, forge: 'github', origin: 'github' });
        report.created.push(place.name);
      } else if (place.action === 'takeover') {
        await takeOver(all.find((r: any) => r.id === id), fullName, 'github');
        report.tookOver.push(`${place.name} → ${fullName}`);
      }
      if (place.action !== 'use') await refresh();
      prRepoIds.set(fullName.toLowerCase(), id);
      const d = drafts.get(id);
      d.forge = d.forge || 'github';
      const c = commits.find((x) => x.repo === fullName);
      if (c) d.lastCommitAt = merge.latest([d.lastCommitAt, c.at]);
    }
    report.prs = await upsertPrs(prs, (repo: any) => prRepoIds.get(repo.toLowerCase()) || null);
    ok('github', { login, prs: prs.length, since: since ? since.toISOString().slice(0, 10) : 'all', commitRepos: commits.length });
  } catch (err: any) {
    fail('github', err);
  }

  // 4. Claude sessions: which folders you worked in, on every machine.
  try {
    const dirs = await sources.sessionDirs();
    let matched = 0;
    const total = new Map<any, any>();
    for (const s of dirs) total.set(s.dir.toLowerCase(), (total.get(s.dir.toLowerCase()) || 0) + s.count);
    for (const s of dirs) {
      let row = merge.matchDir(s.dir, all);
      // A folder you worked in on two or more sessions (on any machines) is a
      // repo of yours even when no clone or forge here knows it — a repo on
      // the Linux box.
      if (!row && total.get(s.dir.toLowerCase()) >= 2) {
        const id = await insertRow({ name: s.dir, gitlabPath: null, forge: null, origin: 'session' });
        report.created.push(`${s.dir} (sessions on ${s.machine})`);
        await refresh();
        row = all.find((r: any) => r.id === id);
      }
      if (!row) continue;
      matched++;
      const d = drafts.get(row.id);
      addPath(d, s.machine, s.path);
      d.sessionCount += s.count;
      d.lastSessionAt = merge.latest([d.lastSessionAt, s.lastAt]);
      d.branches.push(...s.branches);
    }
    ok('sessions', { folders: dirs.length, matched });
  } catch (err: any) {
    fail('sessions', err);
  }

  // 5. raven: the authoritative description of INNERGY repos.
  // PA_REPOS_RAVEN=0: a stack with no business reading it.
  if (config.repos.raven) {
    try {
      const ravenRow = all.find((r: any) => r.gitlab_path && r.gitlab_path.toLowerCase() === 'innergy-dev/raven');
      const raven = await sources.ravenRepos(ravenRow?.repo_path || null);
      if (raven.error) throw new Error(raven.error);
      let hits = 0;
      for (const d of drafts.values()) {
        const key = String(d.row.gitlab_path || '').toLowerCase();
        if (!key) continue;
        const text = raven.map.get(key);
        const base = key.split('/').pop();
        if (text) {
          d.raven = text;
          hits++;
        }
        if (key.startsWith('innergy-dev/') && (raven.systems || []).includes(base)) {
          d.ravenDoc = `https://github.com/innergy-dev/raven/tree/main/knowledge/systems/${base}`;
        }
      }
      ok('raven', { from: raven.from, repos: raven.map.size, matched: hits });
    } catch (err: any) {
      fail('raven', err);
    }
  }

  // 6. Write the gathered facts, then the stats read back from repo_pr.
  await refresh();
  for (const d of drafts.values()) {
    const r = d.row;
    const touched = Object.keys(d.localPaths).length || d.sessionCount || d.lastCommitAt || d.raven || d.branches.length || d.forge !== r.forge;
    if (!touched) continue;
    const openPrs = await repo.repos.openPrBranches(r.id);
    const prBranches = openPrs.map((p: any) => ({ name: p.head_ref, at: p.updated_at ? new Date(p.updated_at).toISOString() : null, mine: true, pr: p.number, machine: null, source: 'pr' }));
    const branches = merge.mergeBranches([d.branches, prBranches], { defaultBranch: d.defaultBranch });
    // Paths found this pass replace the old ones per machine; a machine not
    // seen this pass keeps what it had.
    const localPaths = { ...(r.local_paths || {}), ...d.localPaths };
    await repo.repos.saveSynced(r.id, {
      forge: d.forge || null, remoteUrls: [...d.remoteUrls], localPaths: JSON.stringify(localPaths), defaultBranch: d.defaultBranch || null,
      branches: JSON.stringify(branches), lastCommitAt: d.lastCommitAt, lastSessionAt: d.lastSessionAt, sessionCount: d.sessionCount,
      profileAdd: JSON.stringify(d.ravenDoc ? { ravenDoc: d.ravenDoc } : {}),
    });
  }
  await repo.repos.markLocalOrigins();
  await repo.repos.refreshPrStats();

  // 7. Profiles: raven's text where raven has one; the model for the rest,
  // only when the material behind the last profile changed.
  try {
    await refresh();
    const queue: any[] = [];
    for (const d of drafts.values()) {
      const r = d.row;
      const e = merge.effective(r);
      if (!r.active || !(merge.contributed(e) || (r.repo_path && fs.existsSync(r.repo_path)))) continue;
      let material = null;
      if (r.repo_path && fs.existsSync(r.repo_path)) material = sources.cloneMaterial(r.repo_path);
      else if (r.forge === 'github' && r.gitlab_path && (!r.profile_hash || full)) {
        const [readme, info] = [await sources.githubReadme(r.gitlab_path), await sources.githubRepoInfo(r.gitlab_path)];
        material = { readme, manifests: info?.language ? [`language: ${info.language}`] : [], top: [] as any[] };
        d.forgeInfo = info;
      }
      if (!material) {
        if (d.raven && r.description !== d.raven) await saveProfile(r, { description: d.raven }, 'raven', r.profile_hash);
        continue;
      }
      const hash = sources.materialHash({ material, raven: d.raven });
      if (hash === r.profile_hash) continue;
      const hasMaterial = material.readme || material.manifests.length || d.raven;
      if (!hasMaterial || !profile) {
        if (d.raven) await saveProfile(r, { description: d.raven }, 'raven', hash);
        continue;
      }
      queue.push({ key: String(r.id), name: r.name, fullName: r.gitlab_path, raven: d.raven, forgeDescription: d.forgeInfo?.description || null, material, hash, row: r });
    }
    const batch = queue.slice(0, config.repos.profilesPerSync);
    if (batch.length) {
      const budget = require('../budget');
      if (!(await budget.allow('repo-profile'))) throw new Error('daily model budget reached');
      const results = await require('./profile.ts').profileAll(batch);
      for (const q of batch) {
        const p = results.get(q.key);
        if (!p && !q.raven) continue;
        const description = q.raven || p?.description || q.forgeDescription || null;
        await saveProfile(q.row, { ...(p || {}), description }, q.raven ? 'raven' : p?.description ? 'model' : 'forge', q.hash);
        report.profiled++;
      }
    }
    ok('profiles', { queued: queue.length, profiled: report.profiled });
  } catch (err: any) {
    fail('profiles', err);
  }

  const counts = await repo.repos.syncCounts();
  report.counts = { active: Number(counts.active), worked: Number(counts.worked), prs: Number(counts.prs) };
  log.info('repos synced', { ...report.counts, created: report.created.length, profiled: report.profiled });
  return report;
}

async function saveProfile(row: any, p: any, source: any, hash: any) {
  const profile = { ...(row.profile || {}) };
  for (const k of ['kind', 'stack', 'owner', 'related']) if (p[k] !== undefined) profile[k] = p[k];
  await repo.repos.saveProfile(row.id, p.description || row.description || null, JSON.stringify(profile), source, hash);
}

// ------------------------------------------------------------- reading ----

/** A repo by name, alias, forge path or folder — retired ones included. */
async function find(ref: any) {
  const s = String(ref || '').trim();
  if (!s) return null;
  return repo.repos.findId(s);
}

/**
 * The Repos tab and `pa repos list`: repos you worked in (or pinned), newest
 * activity first, each with its latest PRs.
 * @param {object} o
 * @param {boolean} [o.all]   every active repo, worked in or not, hidden too
 * @param {number}  [o.prs]   PRs per repo
 */
async function list({ all = false, prs = 5 }: { all?: boolean; prs?: number } = {}) {
  const base = (await repo.repos.activeRows()).map(merge.effective);
  const shown = all ? base : base.filter((r: any) => merge.contributed(r));
  shown.sort((a: any, b: any) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')) || a.name.localeCompare(b.name));
  const ids = shown.map((r: any) => r.id);
  const recent = ids.length
    ? await repo.repos.recentPrs(ids, prs)
    : [];
  return shown.map((r: any) => ({ ...publicRow(r), prs: recent.filter((p: any) => String(p.project_id) === String(r.id)).map(publicPr) }));
}

/** One repo, all of it: profile, paths, branches, aliases, every PR of yours. */
async function show(ref: any) {
  const id = await find(ref);
  if (!id) return null;
  const r = merge.effective(await repo.repos.rowById(id));
  const aliases = await repo.repos.aliasesOf(id);
  const prs = await repo.repos.prsOf(id);
  const commitments = await repo.repos.openCommitments(id);
  return { ...publicRow(r), aliases, prs: prs.map(publicPr), commitments };
}

function publicRow(r: any) {
  return {
    id: Number(r.id),
    name: r.name,
    fullName: r.gitlab_path || null,
    forge: r.forge || null,
    forgeUrl: merge.forgeUrl(r.forge, r.gitlab_path),
    repoPath: r.repo_path || null,
    localPaths: r.local_paths || {},
    defaultBranch: r.default_branch || null,
    description: r.description,
    descriptionSource: r.descriptionSource,
    kind: r.kind,
    stack: r.stack || [],
    owner: r.owner,
    related: r.related || [],
    ravenDoc: (r.profile || {}).ravenDoc || null,
    hidden: !!r.hidden,
    pinned: r.pinned,
    origin: r.origin || 'local',
    branches: r.branches || [],
    prCount: Number(r.pr_count) || 0,
    sessionCount: Number(r.session_count) || 0,
    lastPrAt: r.last_pr_at,
    lastCommitAt: r.last_commit_at,
    lastSessionAt: r.last_session_at,
    lastActivity: r.lastActivity,
    syncedAt: r.synced_at,
  };
}

function publicPr(p: any) {
  return {
    repo: p.repo,
    number: p.number,
    title: p.title,
    state: p.draft && p.state === 'open' ? 'draft' : p.state,
    branch: p.head_ref,
    url: p.url,
    summary: p.summary,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at,
    closedAt: p.closed_at,
  };
}

// ----------------------------------------------------- manual corrections ----

/**
 * `pa repos add`: a repo the sources do not show (yet). `ref` is a forge path
 * (`owner/name`), a folder, or a bare name. Pinned, so it is on the Repos tab.
 */
async function add(ref: any, { name = null }: { name?: any | null } = {}) {
  const s = String(ref || '').trim();
  if (!s) throw new Error('give owner/name, a folder, or a name');
  let id = await find(s);
  if (!id) {
    const isPath = /[\\]|^[a-z]:|^\//i.test(s) && fs.existsSync(s);
    const fullName = !isPath && /^[^/\s]+\/[^/\s]+$/.test(s) ? s : null;
    const repoName = name || (fullName ? fullName.split('/').pop() : path.basename(s));
    const place = fullName ? merge.placeForgeRepo(fullName, await loadRows()) : { action: 'insert', name: repoName };
    if (place.action === 'insert') id = await insertRow({ name: name || place.name, gitlabPath: fullName, forge: fullName ? 'github' : null, origin: 'manual' });
    else id = place.id;
    if (isPath) await repo.repos.setRepoPath(id, s);
  }
  await setManual(id, { pinned: true });
  await repo.repos.revive(id);
  return show(id ? (await repo.repos.nameOf(id)).name : s);
}

async function setManual(id: any, edits: any) {
  const r = await repo.repos.manualOf(id);
  const manual = merge.applyManual(r.manual, edits);
  await repo.repos.setManual(id, JSON.stringify(manual));
  return manual;
}

async function mustFind(ref: any) {
  const id = await find(ref);
  if (!id) throw new Error(`no repo "${ref}" — \`pa repos list --all\` lists them`);
  return id;
}

/** `pa repos set <repo> --description … --owner … --stack a,b --pinned` */
async function set(ref: any, edits: any) {
  const id = await mustFind(ref);
  await setManual(id, edits);
  return show((await repo.repos.nameOf(id)).name);
}

/** `pa repos alias <repo> <alias>`: a name you call it. Human-confirmed, so it outranks seeded aliases. */
async function alias(ref: any, name: any) {
  const id = await mustFind(ref);
  const okAdded = await projects.addAlias(id, name, 'corrected');
  if (!okAdded) throw new Error('an alias needs at least 3 characters');
  return show((await repo.repos.nameOf(id)).name);
}

/** `pa repos hide <repo> [--undo]`: off the Repos tab (the resolver still knows it). */
async function hide(ref: any, hidden: boolean = true) {
  const id = await mustFind(ref);
  await repo.repos.setHidden(id, hidden);
  return { id, hidden };
}

module.exports = { sync, list, show, find, add, set, alias, hide, loadRows };
