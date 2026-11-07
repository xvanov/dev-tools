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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../config');
const { query, rows, one } = require('../db');
const projects = require('../projects');
const sources = require('./sources');
const merge = require('./merge');
const { logger } = require('../log');

const log = logger('repos');

const ROW_COLUMNS = `id, name, gitlab_path, repo_path, active, forge, remote_urls, local_paths, default_branch, description,
  profile, profile_source, profile_hash, profiled_at, manual, hidden, origin, branches, last_pr_at, last_commit_at,
  last_session_at, pr_count, session_count, synced_at, retired_at, retired_reason`;

async function loadRows() {
  const list = await rows(`select ${ROW_COLUMNS} from project order by id`);
  const aliases = await rows('select project_id, alias from project_alias');
  const byProject = new Map();
  for (const a of aliases) {
    if (!byProject.has(a.project_id)) byProject.set(a.project_id, []);
    byProject.get(a.project_id).push(a.alias);
  }
  return list.map((r) => ({
    ...r,
    aliases: byProject.get(r.id) || [],
    paths: Object.values(r.local_paths || {}).flat(),
    remote_paths: (r.remote_urls || []).map((u) => projects.pathFromRemote(u)).filter(Boolean),
  }));
}

// A sync's view of one row: the facts gathered this pass, written once at the end.
function draft(row) {
  return {
    row,
    forge: row.forge,
    remoteUrls: new Set(row.remote_urls || []),
    localPaths: {},
    defaultBranch: row.default_branch,
    branches: [],
    lastCommitAt: null,
    lastSessionAt: null,
    sessionCount: 0,
    raven: null,
    ravenDoc: null,
    material: null,
    forgeInfo: null,
  };
}

function addPath(d, machine, p) {
  if (!p) return;
  const list = d.localPaths[machine] || (d.localPaths[machine] = []);
  if (!list.some((x) => x.toLowerCase() === p.toLowerCase())) list.push(p);
}

async function insertRow({ name, gitlabPath, forge, origin }) {
  const r = await one(
    `insert into project (name, gitlab_path, forge, origin, active) values ($1, $2, $3, $4, true)
     on conflict (name) do update set name = excluded.name
     returning id`,
    [name, gitlabPath, forge, origin]
  );
  if (gitlabPath) {
    await projects.addAlias(r.id, gitlabPath);
    await projects.addAlias(r.id, gitlabPath.split('/').pop());
  }
  await projects.addAlias(r.id, name);
  return r.id;
}

/**
 * The archived original of a repo that moved forge (GitLab innergy/x →
 * GitHub innergy-dev/x) becomes the moved repo: same name, same commitments,
 * new path. Its old path stays as an alias. Its folder, if gone, is cleared
 * rather than kept as a path dispatch would try to use.
 */
async function takeOver(row, fullName, forge) {
  const keepPath = row.repo_path && fs.existsSync(row.repo_path) ? row.repo_path : null;
  await query(
    `update project set gitlab_path = $2, forge = $3, active = true, retired_at = null, retired_reason = null, repo_path = $4
      where id = $1`,
    [row.id, fullName, forge, keepPath]
  );
  if (row.gitlab_path) await projects.addAlias(row.id, row.gitlab_path);
  await projects.addAlias(row.id, fullName);
}

async function prSince(full) {
  if (full) return null;
  const r = await one('select max(updated_at) as at from repo_pr');
  if (!r?.at) return null;
  return new Date(new Date(r.at).getTime() - 3 * 86400_000);
}

async function upsertPrs(prs, projectIdFor) {
  let n = 0;
  for (const p of prs) {
    await query(
      `insert into repo_pr (project_id, forge, repo, number, title, state, draft, head_ref, base_ref, url, author,
                            created_at, updated_at, merged_at, closed_at, summary, body, synced_at)
       values ($1,'github',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       on conflict (forge, repo, number) do update set
         project_id = excluded.project_id, title = excluded.title, state = excluded.state, draft = excluded.draft,
         head_ref = excluded.head_ref, base_ref = excluded.base_ref, url = excluded.url,
         updated_at = excluded.updated_at, merged_at = excluded.merged_at, closed_at = excluded.closed_at,
         summary = excluded.summary, body = excluded.body, synced_at = now()`,
      [projectIdFor(p.repo), p.repo, p.number, p.title, p.state, p.draft, p.headRef, p.baseRef, p.url, p.author,
        p.createdAt, p.updatedAt, p.mergedAt, p.closedAt, p.summary, p.body]
    );
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
async function sync({ full = false, profile = config.repos.profile } = {}) {
  const host = os.hostname();
  const report = { sources: {}, created: [], tookOver: [], prs: 0, profiled: 0 };
  const ok = (name, detail) => (report.sources[name] = { ok: true, ...detail });
  const fail = (name, err) => {
    report.sources[name] = { ok: false, error: String(err?.message || err).split('\n')[0].slice(0, 300) };
    log.warn('repo source failed', { source: name, error: report.sources[name].error });
  };

  // 1. Clones under the repos root: the existing project seeding and retiring.
  try {
    const seeded = await projects.sync();
    ok('local', { clones: seeded.length, retired: (seeded.retired || []).length });
  } catch (err) {
    fail('local', err);
  }

  let all = await loadRows();
  const drafts = new Map(all.map((r) => [r.id, draft(r)]));
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
      const row = all.find((r) => r.active && r.repo_path && r.repo_path.toLowerCase() === group.repoPath.toLowerCase());
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
  } catch (err) {
    fail('git', err);
  }

  // 3. GitHub: your PRs and commits, and the repos they are in.
  const prRepoIds = new Map();
  try {
    const login = await sources.githubLogin();
    const since = await prSince(full);
    const prs = await sources.githubPrs({ login, since });
    let commits = [];
    try {
      commits = await sources.githubCommits({ login });
    } catch (err) {
      fail('github-commits', err);
    }
    const repos = new Set([...prs.map((p) => p.repo), ...commits.map((c) => c.repo)]);
    for (const fullName of repos) {
      const place = merge.placeForgeRepo(fullName, all);
      let id = place.id;
      if (place.action === 'insert') {
        id = await insertRow({ name: place.name, gitlabPath: fullName, forge: 'github', origin: 'github' });
        report.created.push(place.name);
      } else if (place.action === 'takeover') {
        await takeOver(all.find((r) => r.id === id), fullName, 'github');
        report.tookOver.push(`${place.name} → ${fullName}`);
      }
      if (place.action !== 'use') await refresh();
      prRepoIds.set(fullName.toLowerCase(), id);
      const d = drafts.get(id);
      d.forge = d.forge || 'github';
      const c = commits.find((x) => x.repo === fullName);
      if (c) d.lastCommitAt = merge.latest([d.lastCommitAt, c.at]);
    }
    report.prs = await upsertPrs(prs, (repo) => prRepoIds.get(repo.toLowerCase()) || null);
    ok('github', { login, prs: prs.length, since: since ? since.toISOString().slice(0, 10) : 'all', commitRepos: commits.length });
  } catch (err) {
    fail('github', err);
  }

  // 4. Claude sessions: which folders you worked in, on every machine.
  try {
    const dirs = await sources.sessionDirs();
    let matched = 0;
    const total = new Map();
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
        row = all.find((r) => r.id === id);
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
  } catch (err) {
    fail('sessions', err);
  }

  // 5. raven: the authoritative description of INNERGY repos.
  // PA_REPOS_RAVEN=0: a stack with no business reading it.
  if (config.repos.raven) {
    try {
      const ravenRow = all.find((r) => r.gitlab_path && r.gitlab_path.toLowerCase() === 'innergy-dev/raven');
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
    } catch (err) {
      fail('raven', err);
    }
  }

  // 6. Write the gathered facts, then the stats read back from repo_pr.
  await refresh();
  for (const d of drafts.values()) {
    const r = d.row;
    const touched = Object.keys(d.localPaths).length || d.sessionCount || d.lastCommitAt || d.raven || d.branches.length || d.forge !== r.forge;
    if (!touched) continue;
    const openPrs = await rows(
      `select number, head_ref, updated_at from repo_pr where project_id = $1 and state = 'open' and head_ref is not null`,
      [r.id]
    );
    const prBranches = openPrs.map((p) => ({ name: p.head_ref, at: p.updated_at ? new Date(p.updated_at).toISOString() : null, mine: true, pr: p.number, machine: null, source: 'pr' }));
    const branches = merge.mergeBranches([d.branches, prBranches], { defaultBranch: d.defaultBranch });
    // Paths found this pass replace the old ones per machine; a machine not
    // seen this pass keeps what it had.
    const localPaths = { ...(r.local_paths || {}), ...d.localPaths };
    await query(
      `update project set forge = $2, remote_urls = $3, local_paths = $4, default_branch = $5, branches = $6,
              last_commit_at = coalesce($7, last_commit_at), last_session_at = coalesce($8, last_session_at),
              session_count = case when $9 > 0 then $9 else session_count end,
              profile = profile || $10::jsonb, synced_at = now()
        where id = $1`,
      [r.id, d.forge || null, [...d.remoteUrls], JSON.stringify(localPaths), d.defaultBranch || null, JSON.stringify(branches),
        d.lastCommitAt, d.lastSessionAt, d.sessionCount, JSON.stringify(d.ravenDoc ? { ravenDoc: d.ravenDoc } : {})]
    );
  }
  await query(`update project set origin = 'local' where origin is null and repo_path is not null`);
  await query(
    `update project p set pr_count = s.n, last_pr_at = s.last
       from (select project_id, count(*)::int as n, max(coalesce(merged_at, updated_at)) as last
               from repo_pr where project_id is not null group by project_id) s
      where s.project_id = p.id`
  );

  // 7. Profiles: raven's text where raven has one; the model for the rest,
  // only when the material behind the last profile changed.
  try {
    await refresh();
    const queue = [];
    for (const d of drafts.values()) {
      const r = d.row;
      const e = merge.effective(r);
      if (!r.active || !(merge.contributed(e) || (r.repo_path && fs.existsSync(r.repo_path)))) continue;
      let material = null;
      if (r.repo_path && fs.existsSync(r.repo_path)) material = sources.cloneMaterial(r.repo_path);
      else if (r.forge === 'github' && r.gitlab_path && (!r.profile_hash || full)) {
        const [readme, info] = [await sources.githubReadme(r.gitlab_path), await sources.githubRepoInfo(r.gitlab_path)];
        material = { readme, manifests: info?.language ? [`language: ${info.language}`] : [], top: [] };
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
      const results = await require('./profile').profileAll(batch);
      for (const q of batch) {
        const p = results.get(q.key);
        if (!p && !q.raven) continue;
        const description = q.raven || p?.description || q.forgeDescription || null;
        await saveProfile(q.row, { ...(p || {}), description }, q.raven ? 'raven' : p?.description ? 'model' : 'forge', q.hash);
        report.profiled++;
      }
    }
    ok('profiles', { queued: queue.length, profiled: report.profiled });
  } catch (err) {
    fail('profiles', err);
  }

  const counts = await one(
    `select count(*) filter (where active) as active,
            count(*) filter (where active and (pr_count > 0 or last_commit_at is not null or session_count > 0 or (manual->>'pinned')::boolean)) as worked,
            (select count(*) from repo_pr) as prs
       from project`
  );
  report.counts = { active: Number(counts.active), worked: Number(counts.worked), prs: Number(counts.prs) };
  log.info('repos synced', { ...report.counts, created: report.created.length, profiled: report.profiled });
  return report;
}

async function saveProfile(row, p, source, hash) {
  const profile = { ...(row.profile || {}) };
  for (const k of ['kind', 'stack', 'owner', 'related']) if (p[k] !== undefined) profile[k] = p[k];
  await query(
    `update project set description = $2, profile = $3, profile_source = $4, profile_hash = $5, profiled_at = now() where id = $1`,
    [row.id, p.description || row.description || null, JSON.stringify(profile), source, hash]
  );
}

// ------------------------------------------------------------- reading ----

/** A repo by name, alias, forge path or folder — retired ones included. */
async function find(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  const r = await one(
    `select id from project
      where lower(name) = lower($1) or lower(gitlab_path) = lower($1)
         or id = (select project_id from project_alias where lower(alias) = lower($1) limit 1)
         or lower(repo_path) = lower($1)
      order by active desc, (lower(name) = lower($1)) desc limit 1`,
    [s]
  );
  return r ? r.id : null;
}

/**
 * The Repos tab and `pa repos list`: repos you worked in (or pinned), newest
 * activity first, each with its latest PRs.
 * @param {object} o
 * @param {boolean} [o.all]   every active repo, worked in or not, hidden too
 * @param {number}  [o.prs]   PRs per repo
 */
async function list({ all = false, prs = 5 } = {}) {
  const base = (await rows(`select ${ROW_COLUMNS} from project where active order by name`)).map(merge.effective);
  const shown = all ? base : base.filter((r) => merge.contributed(r));
  shown.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')) || a.name.localeCompare(b.name));
  const ids = shown.map((r) => r.id);
  const recent = ids.length
    ? await rows(
        `select * from (
           select project_id, repo, number, title, state, draft, head_ref, url, summary, created_at, updated_at, merged_at, closed_at,
                  row_number() over (partition by project_id order by updated_at desc nulls last) as rn
             from repo_pr where project_id = any($1::bigint[])) x
          where rn <= $2 order by updated_at desc`,
        [ids, prs]
      )
    : [];
  return shown.map((r) => ({ ...publicRow(r), prs: recent.filter((p) => String(p.project_id) === String(r.id)).map(publicPr) }));
}

/** One repo, all of it: profile, paths, branches, aliases, every PR of yours. */
async function show(ref) {
  const id = await find(ref);
  if (!id) return null;
  const r = merge.effective(await one(`select ${ROW_COLUMNS} from project where id = $1`, [id]));
  const aliases = await rows('select alias, origin from project_alias where project_id = $1 order by origin, alias', [id]);
  const prs = await rows(
    `select project_id, repo, number, title, state, draft, head_ref, url, summary, created_at, updated_at, merged_at, closed_at
       from repo_pr where project_id = $1 order by updated_at desc nulls last limit 200`,
    [id]
  );
  const commitments = await rows(
    `select id, summary, status from commitment where project_id = $1 and status in ('open','dispatched') and superseded_by is null order by id desc limit 20`,
    [id]
  );
  return { ...publicRow(r), aliases, prs: prs.map(publicPr), commitments };
}

function publicRow(r) {
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

function publicPr(p) {
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
async function add(ref, { name = null } = {}) {
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
    if (isPath) await query('update project set repo_path = $2 where id = $1', [id, s]);
  }
  await setManual(id, { pinned: true });
  await query('update project set active = true, hidden = false, retired_at = null, retired_reason = null where id = $1', [id]);
  return show(id ? (await one('select name from project where id = $1', [id])).name : s);
}

async function setManual(id, edits) {
  const r = await one('select manual from project where id = $1', [id]);
  const manual = merge.applyManual(r.manual, edits);
  await query('update project set manual = $2 where id = $1', [id, JSON.stringify(manual)]);
  return manual;
}

async function mustFind(ref) {
  const id = await find(ref);
  if (!id) throw new Error(`no repo "${ref}" — \`pa repos list --all\` lists them`);
  return id;
}

/** `pa repos set <repo> --description … --owner … --stack a,b --pinned` */
async function set(ref, edits) {
  const id = await mustFind(ref);
  await setManual(id, edits);
  return show((await one('select name from project where id = $1', [id])).name);
}

/** `pa repos alias <repo> <alias>`: a name you call it. Human-confirmed, so it outranks seeded aliases. */
async function alias(ref, name) {
  const id = await mustFind(ref);
  const okAdded = await projects.addAlias(id, name, 'corrected');
  if (!okAdded) throw new Error('an alias needs at least 3 characters');
  return show((await one('select name from project where id = $1', [id])).name);
}

/** `pa repos hide <repo> [--undo]`: off the Repos tab (the resolver still knows it). */
async function hide(ref, hidden = true) {
  const id = await mustFind(ref);
  await query('update project set hidden = $2 where id = $1', [id, hidden]);
  return { id, hidden };
}

module.exports = { sync, list, show, find, add, set, alias, hide, loadRows };
