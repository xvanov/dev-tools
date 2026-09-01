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
//  3. **Recency and authorship are hints, not answers.** They break ties
//     between two plausible projects; they never carry a match on their own.
//
// A candidate with no evidence at all scores zero and stays there — "unknown"
// that asks you once beats a wrong repo that a session then works in.

const EXPLICIT_TOKEN = 5;
const ALIAS_HIT = 3;
const NAME_HIT = 2.5;
const RECENT_TOUCH = 1;
const AUTHOR_AFFINITY = 1;
const THREAD_CONTINUITY = 2;

const STOPWORDS = new Set([
  'api', 'app', 'web', 'core', 'main', 'test', 'tests', 'the', 'and', 'for', 'new', 'old',
  'service', 'services', 'client', 'server', 'ui', 'db', 'data', 'docs', 'repo', 'project',
]);

// Separators all collapse to spaces, hyphens included: "estimating-api",
// "estimating_api" and "estimating api" are the same phrase to a human and have
// to be the same phrase here, or half the aliases never match the way people
// actually type them.
function normalise(s) {
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
function containsPhrase(haystack, needle) {
  const n = normalise(needle);
  if (!n || n.length < 3) return false;
  const h = ` ${normalise(haystack)} `;
  return h.includes(` ${n} `) || h.includes(` ${n}s `);
}

// Things that only appear when someone is talking about a specific codebase:
// a path, a branch, a namespace. Extracted separately because they score
// highest and their absence is informative.
function explicitTokens(text) {
  const out = new Set();
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

/**
 * @param {string} text            the ask, plus any subject line
 * @param {Array}  candidates      [{id, name, gitlabPath, repoPath, aliases:[{alias,weight,origin}], lastTouchedAt}]
 * @param {object} context         {recentProjectIds, authorProjectIds, threadProjectId, now}
 * @returns {Array} ranked [{projectId, name, score, confidence, rationale}]
 */
function scoreCandidates(text, candidates, context = {}) {
  const now = context.now ? new Date(context.now) : new Date();
  const tokens = explicitTokens(text);
  const recent = new Set(context.recentProjectIds || []);
  const authored = new Set(context.authorProjectIds || []);

  const scored = candidates.map((c) => {
    let score = 0;
    const why = [];

    for (const token of tokens) {
      const repoName = c.repoPath ? c.repoPath.split(/[\\/]/).pop() : null;
      if (
        (c.gitlabPath && token.includes(normalise(c.gitlabPath).replace(/ /g, '/'))) ||
        (repoName && containsPhrase(token, repoName)) ||
        containsPhrase(token, c.name)
      ) {
        score += EXPLICIT_TOKEN;
        why.push(`explicit token "${token}"`);
        break;
      }
    }

    for (const alias of c.aliases || []) {
      if (STOPWORDS.has(normalise(alias.alias))) continue;
      if (containsPhrase(text, alias.alias)) {
        const weight = Number(alias.weight) || 1;
        score += ALIAS_HIT * weight;
        why.push(`alias "${alias.alias}"${alias.origin === 'corrected' ? ' (you corrected this before)' : ''}`);
        break;
      }
    }

    if (!STOPWORDS.has(normalise(c.name)) && containsPhrase(text, c.name)) {
      score += NAME_HIT;
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
      const days = (now - new Date(c.lastTouchedAt)) / 86400_000;
      if (days <= 14) score += 0.5;
    }

    return { projectId: c.id, name: c.name, repoPath: c.repoPath, score, why };
  });

  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
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

  return ranked.map((r) => ({ ...r, rationale: r.why.join('; ') }));
}

module.exports = { scoreCandidates, explicitTokens, containsPhrase, normalise };
