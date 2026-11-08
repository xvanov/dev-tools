'use strict';

// Deciding which project — and therefore which repo — an ask belongs to.
//
// This is deliberately a *scorer*, not a classifier call: it is pure, it is
// cheap, it runs over every candidate, and it explains itself. The distiller
// gets this ranking as evidence and may override it, but the ranking is what
// makes overriding rare.
//
// The scoring weights encode three beliefs, in order of strength:
//
//  1. **An explicit token wins.** A repo path, a GitLab namespace or a branch
//     name in the text is near-conclusive; nothing else comes close.
//  2. **Your own corrections outrank seeded guesses.** A `corrected` alias is
//     a phrase a human confirmed once. That is better evidence than a
//     directory name that happened to look similar.
//  3. **Recency, authorship and thread are hints, not answers.** They break
//     ties between two projects the text already points at; they never carry
//     a match on their own. A candidate with nothing in the text (or the
//     session's folder) pointing at it is not ranked at all, however recent.
//
// That last rule is load-bearing. These hints feed on earlier guesses — a
// thread's earlier commitment, the projects "you worked in recently", the
// repos "the person asking works in" are all read back from commitment rows —
// so a hint that could carry a match on its own snowballed: one guess in a
// chat thread put every later ask in that thread, and every ask from the same
// people, on the same repo (a Docebo/HubSpot thread ended up on a training
// matrix repo, and from there a dozen unrelated cards with it).
//
// A candidate with no evidence at all is dropped — "unknown" that asks you
// once beats a wrong repo that a session then works in.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const EXPLICIT_TOKEN = 5;
const ALIAS_HIT = 3;
const NAME_HIT = 2.5;
const RECENT_TOUCH = 1;
const AUTHOR_AFFINITY = 1;
const THREAD_CONTINUITY = 2;
const WORKDIR = 4;

const STOPWORDS = new Set([
  'api', 'app', 'web', 'core', 'main', 'test', 'tests', 'the', 'and', 'for', 'new', 'old',
  'service', 'services', 'client', 'server', 'ui', 'db', 'data', 'docs', 'repo', 'project',
]);

// Separators all collapse to spaces, hyphens included: "estimating-api",
// "estimating_api" and "estimating api" are the same phrase to a human and have
// to be the same phrase here, or half the aliases never match the way people
// actually type them.
function normalise(s: any) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_/\\.-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Word-boundary containment on the normalised forms. Substring matching would
// make "pa" match "compare"; token matching alone would miss "estimating-api"
// inside "the estimating-api rewrite".
function containsPhrase(haystack: any, needle: any) {
  const n = normalise(needle);
  if (!n || n.length < 3) return false;
  const h = ` ${normalise(haystack)} `;
  return h.includes(` ${n} `) || h.includes(` ${n}s `);
}

// Things that only appear when someone is talking about a specific codebase:
// a path, a branch, a namespace. Extracted separately because they score
// highest and their absence is informative.
function explicitTokens(text: any) {
  const out = new Set<any>();
  const source = String(text || '');
  for (const m of source.matchAll(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g)) out.add(m[0].toLowerCase());
  for (const m of source.matchAll(/\b(?:feature|fix|bugfix|hotfix|chore)\/[A-Za-z0-9_.-]+/gi)) {
    out.add(m[0].toLowerCase());
  }
  for (const m of source.matchAll(/\b[\w-]+\.(?:ts|js|cs|py|sql|ps1|razor|tsx|jsx|vue|go|rb|java)\b/gi)) {
    out.add(m[0].toLowerCase());
  }
  return [...out];
}

// Does a path-like token name this candidate's repo? Only a whole path
// segment counts: "innergy-dev/optimizer" names the optimizer repo, and the
// `innergy` inside its owner segment must not make it name a repo called
// `innergy` as well. That substring match is what sent every innergy-dev PR
// to the old monorepo. The full owner/repo path also counts, wherever it sits.
//
// The repo registry's other forge paths and per-machine folders
// (c.remotePaths, c.paths) name the repo just as its main path and clone do.
function tokenNamesRepo(token: any, c: any) {
  const t = ` ${normalise(token)} `;
  for (const full of [c.gitlabPath, ...(c.remotePaths || [])]) {
    const whole = normalise(full);
    if (whole && whole.includes(' ') && t.includes(` ${whole} `)) return true;
  }
  const names = new Set(
    [
      c.name,
      c.repoPath ? c.repoPath.split(/[\\/]/).pop() : null,
      c.gitlabPath ? c.gitlabPath.split('/').pop() : null,
      ...(c.paths || []).map((p: any) => String(p).split(/[\\/]/).filter(Boolean).pop()),
    ]
      .map(normalise)
      .filter((n) => n.length >= 3 && !STOPWORDS.has(n))
  );
  return String(token)
    .split(/[\\/]+/)
    .some((seg) => names.has(normalise(seg)));
}

function cleanPath(p: any) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * The project an item names outright, before any scoring. A GitHub item
 * carries its repository's full name, which is conclusive.
 * @returns {{projectId, name, repoPath, confidence, rationale}|null} — with
 *   projectId null when the item names a repo that has no active project here
 *   (not in the registry, or retired): unknown beats the nearest-looking
 *   wrong repo. A registry repo with no clone here still matches, with
 *   repoPath null — dispatch then asks for a folder instead of guessing one.
 *   null when the item names no repo at all.
 */
function directMatch(item: any, candidates: any) {
  const raw = item?.raw || {};
  const repo =
    String(item?.source || '').startsWith('github') && typeof raw.project === 'string' && /^[^/\s]+\/[^/\s]+$/.test(raw.project)
      ? raw.project
      : null;
  if (!repo) return null;
  const want = repo.toLowerCase();
  const hit =
    (candidates || []).find((c: any) => c.gitlabPath && c.gitlabPath.toLowerCase() === want) ||
    (candidates || []).find((c: any) => (c.remotePaths || []).some((p: any) => String(p).toLowerCase() === want));
  if (hit) return { projectId: hit.id, name: hit.name, repoPath: hit.repoPath, confidence: 0.99, rationale: `the item is from ${repo}` };
  return { projectId: null, name: null, repoPath: null, confidence: null, rationale: `${repo} is not in the repo registry (pa repos add ${repo})` };
}

/**
 * The project whose folder a Claude session ran in, or null. Evidence for the
 * scorer, not a verdict: a session in one repo often talks about another.
 */
function workdirProject(cwd: any, candidates: any) {
  const dir = cleanPath(cwd);
  if (!dir) return null;
  let best = null;
  let bestLen = 0;
  for (const c of candidates || []) {
    // The clone here, and the folders the registry knows it by on other
    // machines (a session on mv-automated-vm ran in C:\source\mv-assistant).
    for (const raw of [c.repoPath, ...(c.paths || [])]) {
      const p = cleanPath(raw);
      if (!p || p.length <= bestLen) continue;
      if (dir === p || dir.startsWith(`${p}\\`)) {
        best = c;
        bestLen = p.length;
      }
    }
  }
  return best ? best.id : null;
}

/**
 * @param {string} text            the ask, plus any subject line
 * @param {Array}  candidates      [{id, name, gitlabPath, repoPath, aliases:[{alias,weight,origin}], lastTouchedAt}]
 * @param {object} context         {recentProjectIds, authorProjectIds, threadProjectId, workdirProjectId, now}
 * @returns {Array} ranked [{projectId, name, score, confidence, rationale}]
 */
function scoreCandidates(text: any, candidates: any, context: any = {}) {
  const now = context.now ? new Date(context.now) : new Date();
  const tokens = explicitTokens(text);
  const recent = new Set(context.recentProjectIds || []);
  const authored = new Set(context.authorProjectIds || []);

  const scored = candidates.map((c: any) => {
    let score = 0;
    const why: any[] = [];
    // Evidence from the text or the session's folder; the hints below only
    // count for a candidate that has some.
    let evidence = false;

    for (const token of tokens) {
      if (tokenNamesRepo(token, c)) {
        score += EXPLICIT_TOKEN;
        evidence = true;
        why.push(`explicit token "${token}"`);
        break;
      }
    }

    if (context.workdirProjectId && context.workdirProjectId === c.id) {
      score += WORKDIR;
      evidence = true;
      why.push('the session ran in this repo');
    }

    for (const alias of c.aliases || []) {
      if (STOPWORDS.has(normalise(alias.alias))) continue;
      if (containsPhrase(text, alias.alias)) {
        const weight = Number(alias.weight) || 1;
        score += ALIAS_HIT * weight;
        evidence = true;
        why.push(`alias "${alias.alias}"${alias.origin === 'corrected' ? ' (you corrected this before)' : ''}`);
        break;
      }
    }

    if (!STOPWORDS.has(normalise(c.name)) && containsPhrase(text, c.name)) {
      score += NAME_HIT;
      evidence = true;
      why.push(`project name "${c.name}"`);
    }

    if (context.threadProjectId && context.threadProjectId === c.id) {
      score += THREAD_CONTINUITY;
      why.push('earlier commitment in this thread');
    }

    if (recent.has(c.id)) {
      score += RECENT_TOUCH;
      why.push('you worked here recently');
    }

    if (authored.has(c.id)) {
      score += AUTHOR_AFFINITY;
      why.push('the person asking works in this repo');
    }

    if (c.lastTouchedAt) {
      const days = ((now as any) - (new Date(c.lastTouchedAt) as any)) / 86400_000;
      if (days <= 14) score += 0.5;
    }

    return { projectId: c.id, name: c.name, repoPath: c.repoPath, score, why, evidence };
  });

  const ranked = scored.filter((s: any) => s.evidence && s.score > 0).sort((a: any, b: any) => b.score - a.score);
  if (!ranked.length) return [];

  // Confidence is about *separation*, not absolute score: a strong match with
  // an equally strong runner-up is a coin flip, and should be reported as one.
  const top = ranked[0];
  const runnerUp = ranked[1]?.score ?? 0;
  const separation = (top.score - runnerUp) / top.score;
  const strength = Math.min(1, top.score / (EXPLICIT_TOKEN + ALIAS_HIT));
  top.confidence = Math.max(0.1, Math.min(0.99, 0.35 * strength + 0.65 * strength * separation));

  for (const r of ranked.slice(1)) {
    r.confidence = Math.min(0.4, r.score / (top.score * 2.5));
  }

  return ranked.map(({ evidence, ...r }: any) => ({ ...r, rationale: r.why.join('; ') }));
}

// Words that say nothing about which repo: English filler, the company and
// its divisions (every message mentions INNERGY or ENGINEERING), and the
// generic halves of repo names ("internal apps", "assistant", "tools").
const GENERIC_WORDS = new Set([
  ...STOPWORDS,
  'with', 'from', 'that', 'this', 'have', 'will', 'into', 'about', 'when', 'what', 'them', 'they',
  'your', 'after', 'before', 'there', 'their', 'than', 'then', 'just', 'only', 'also', 'some',
  'innergy', 'engineering', 'internal', 'apps', 'assistant', 'tool', 'tools', 'toolkit', 'library',
  'infrastructure', 'infra', 'platform', 'system', 'team', 'work', 'update', 'review', 'build',
  'main', 'analytics', 'server', 'service', 'integration', 'setup', 'template',
]);

function distinctiveWords(phrase: any) {
  return [...new Set(normalise(phrase).split(' ').filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w)))];
}

/**
 * Whether the text itself backs a project the distiller picked. The model
 * reads meaning into a list of repo names ("Docebo is a training platform, so
 * this is the training matrix repo"), and a card linked to the wrong repo is
 * worse than one linked to none. So its pick stands only when the text names
 * the project as the scorer would (a path, an alias, its name), or shares at
 * least two distinctive words with one of its names — "Docebo … HubSpot video
 * engagement" with "PeAk (Docebo) ↔ HubSpot Video Engagement Analytics", but
 * not "training" alone with "INNERGY Engineering Training Matrix".
 */
function corroborates(text: any, candidate: any) {
  if (!candidate) return false;
  if (scoreCandidates(text, [candidate]).length) return true;
  const words = new Set(normalise(text).split(' '));
  const names = [candidate.name, candidate.gitlabPath, ...(candidate.aliases || []).map((a: any) => a.alias)];
  return names.some((n) => {
    const distinct = distinctiveWords(n);
    return distinct.length >= 2 && distinct.filter((w) => words.has(w) || words.has(`${w}s`)).length >= 2;
  });
}

module.exports = { scoreCandidates, corroborates, explicitTokens, containsPhrase, normalise, tokenNamesRepo, directMatch, workdirProject };
