'use strict';

// Re-checks the project already on each open commitment against the rule the
// distiller now follows (resolve.js): a project stands only when the item's
// own text, its repository or its session's folder backs it. Links set before
// that rule rode on hints — an earlier guess in the thread, recent work, the
// person asking — and on the model reading meaning into repo names, and one
// wrong guess spread to a dozen cards.
//
// A link the text does not back is *listed*; it is cleared only when you ask
// (`--apply`), narrowed to a project or to ids, because "the text does not
// name it" is not the same as "wrong" — a thread about the PBCF app may never
// say PBCF. It is never moved to another project: a guess replacing a guess
// is how this started. A link you set by hand is never touched.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const fs = require('fs');
const path = require('path');
const repo = require('../repo');
const resolve = require('./resolve.ts');
const { candidates: loadCandidates } = require('./index.ts');
const { evidenceText } = require('../distill');

/**
 * The verdict for one commitment. Pure.
 * @param {object} c          {project_id, project_rationale, summary, detail, source, subject, body_text, raw}
 * @param {Array}  candidates projects.candidates()
 * @returns {{action:'keep'|'clear', reason}}
 */
function judge(c: any, candidates: any) {
  if (/^corrected by hand/.test(c.project_rationale || '')) return { action: 'keep', reason: 'set by hand' };
  const current = candidates.find((p: any) => p.id === c.project_id);
  // A retired project's repo is gone; it is not this pass's business.
  if (!current) return { action: 'keep', reason: 'project retired or unknown' };
  const item = { source: c.source, subject: c.subject, body_text: c.body_text, raw: c.raw || {} };
  if (resolve.directMatch(item, candidates)?.projectId === c.project_id) return { action: 'keep', reason: 'the item is from this repo' };
  if (resolve.workdirProject(item.raw.cwd, candidates) === c.project_id) return { action: 'keep', reason: 'the session ran in this repo' };
  if (resolve.corroborates(evidenceText(item, c), current)) return { action: 'keep', reason: 'the text names it' };
  return { action: 'clear', reason: `nothing in the item names ${current.name}` };
}

/**
 * @param {object}   o
 * @param {boolean}  [o.apply]    write; otherwise a dry run
 * @param {string}   [o.project]  only links to this project (name)
 * @param {number[]} [o.ids]      only these commitments
 * @param {string}   [o.logDir]   where the applied rows' old values and undo SQL go
 * @returns {{checked, keep, clear: Array, applied?, logFile}}
 */
async function rescore({ apply = false, project = null, ids = null, logDir = null }: { apply?: boolean; project?: any | null; ids?: any | null; logDir?: any | null } = {}) {
  const candidates = await loadCandidates();
  const list = await repo.commitments.projectLinks(project, ids && ids.length ? ids : null);
  const out: Record<string, any> = { checked: list.length, keep: 0, clear: [] as any[], logFile: null };
  for (const c of list) {
    const v = judge(c, candidates);
    if (v.action === 'keep') {
      out.keep++;
      continue;
    }
    out.clear.push({
      id: c.id,
      summary: c.summary,
      from: c.project,
      reason: v.reason,
      before: { project_id: c.project_id, repo_path: c.repo_path, project_confidence: c.project_confidence, project_rationale: c.project_rationale },
    });
  }
  if (!apply) return out;

  const changed: any[] = [];
  for (const r of out.clear) {
    // Guarded on the old value: a row the worker changed meanwhile is left alone.
    const cleared = await repo.commitments.clearProject(
      r.id,
      `cleared: ${r.reason} (was ${r.from}: ${r.before.project_rationale || 'no reason'})`.slice(0, 500),
      r.before.project_id
    );
    if (cleared) changed.push(r);
  }
  out.applied = changed.length;
  if (logDir && changed.length) {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `project-rescore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const undo = changed.map(
      (r) =>
        `update commitment set project_id = ${Number(r.before.project_id)}, repo_path = ${sqlText(r.before.repo_path)}, ` +
        `project_confidence = ${r.before.project_confidence == null ? 'null' : Number(r.before.project_confidence)}, ` +
        `project_rationale = ${sqlText(r.before.project_rationale)} where id = ${Number(r.id)} and project_id is null;`
    );
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), changed, undo }, null, 2));
    out.logFile = file;
  }
  return out;
}

function sqlText(v: any) {
  return v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
}

module.exports = { rescore, judge };
