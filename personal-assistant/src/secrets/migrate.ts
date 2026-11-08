'use strict';

// `pa secrets migrate --from-env`: moves secret values out of `.env` files and
// into the OS keychain (labelled by stack, see platform/<os>.js).
//
// Rules this module keeps, because it handles every credential on the machine:
//
//  - **Names only, ever.** A plan, a report and an error carry names, files and
//    verdicts. A value is read, handed to the vault and dropped; it is not in
//    any return value, log line or message.
//  - **A dry run is the default.** `apply` is a separate, explicit step.
//  - **Only what the code reads back from the keychain moves.** Moving a name
//    that nothing resolves through `secret()` would silently break its reader;
//    those are listed as kept, not moved.
//  - **A line is blanked only after the keychain returns the same value**
//    (read back and compared). A failed write leaves `.env` untouched.
//  - **The line is emptied, not deleted** (`NAME=`): the slot stays visible,
//    and an empty value is "unset" to every reader (config.env, dotenv).
//  - A name already in the keychain with a *different* value is never
//    overwritten: it is reported and the `.env` line stays.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Db = import('../repo/types.ts').Db;

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

// Names the PA resolves through config.secret() (directly, or via the lazy
// keys on config.anthropic / config.embeddings), plus the backup key.
const PA_READABLE = [
  'PA_JIRA_API_TOKEN', 'PA_NTFY_TOPIC', 'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY', 'AZURE_FOUNDRY_API_KEY',
  'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'PA_LOCAL_LLM_API_KEY',
  'PA_BACKUP_KEY',
];

// Secret-shaped names that are not in a file's readable set are reported as
// kept, so nothing sensitive is overlooked.
const LOOKS_SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PAT)$/;

function parseLine(raw: string) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
  if (!m) return null;
  let v = (m[2] as string).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return { name: m[1] as string, value: v };
}

/** The factory's own key names: what its .env.example declares and the factory reads (software-factory/factory/keychain.py). */
function factoryReadable(exampleFile: string) {
  let text = '';
  try {
    text = fs.readFileSync(exampleFile, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const p = parseLine(raw);
    if (p && NAME_RE.test(p.name) && LOOKS_SECRET.test(p.name)) out.push(p.name);
  }
  return out;
}

/** Blanks `NAME=` lines in place (other lines, comments and order kept); the file is written whole, then renamed. */
function blankEnvLines(file: string, names: string[]) {
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const set = new Set(names);
  const lines = text.split(/\r?\n/).map((l: string) => {
    const p = parseLine(l);
    return p && set.has(p.name) ? `${p.name}=` : l;
  });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join(eol), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Pure planning: which names in which files would move, stay, or be skipped.
 * `have(name)` -> null | 'same' | 'different' says whether the keychain
 * already holds it (the caller compares values; this function never sees one).
 *
 * @param {{file: string, readable: string[]}[]} sources
 * @returns {{file: string, name: string, action: 'move'|'dedupe'|'conflict'|'kept'|'empty'}[]}
 */
type Source = { file: string; readable: string[] };
type PlanRow = { file: string; name: string | undefined; action: string; error?: string };
type VaultLike = { available(): boolean; get(n: string): string | null; set(n: string, v: string): void; scrub?: (text: unknown, value?: string) => string };

function plan(sources: Source[], have: (name: string, value: string) => string | null): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const { file, readable } of sources) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const seen = new Set();
    for (const raw of text.split(/\r?\n/)) {
      const p = parseLine(raw);
      if (!p || !NAME_RE.test(p.name) || seen.has(p.name)) continue;
      const movable = readable.includes(p.name as string);
      if (!movable && !LOOKS_SECRET.test(p.name)) continue;
      seen.add(p.name);
      if (!p.value) {
        if (movable) rows.push({ file, name: p.name, action: 'empty' });
        continue;
      }
      if (!movable) {
        rows.push({ file, name: p.name, action: 'kept' });
        continue;
      }
      const h = have(p.name as string, p.value);
      rows.push({ file, name: p.name, action: h === 'same' ? 'dedupe' : h === 'different' ? 'conflict' : 'move' });
    }
  }
  return rows;
}

/** The value of NAME in a file (internal: handed straight to the vault, never returned). */
function valueIn(file: string, name: string) {
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const p = parseLine(raw);
    if (p && p.name === name) return p.value;
  }
  return '';
}

/**
 * @param {{file: string, readable: string[]}[]} sources
 * @param {{vault: {available(): boolean, get(n): string|null, set(n, v): void}, apply?: boolean, onStored?: (name: string) => void}} o
 * @returns {{available: boolean, apply: boolean, rows: object[]}} names, files and verdicts only
 */
function migrate(sources: Source[], { vault, apply = false, onStored = () => {} }: { vault: VaultLike; apply?: boolean; onStored?: (name: string) => void }) {
  if (!vault.available()) return { available: false, apply, rows: [] };
  const have = (name: string, value: string) => {
    let cur: string | null = null;
    try {
      cur = vault.get(name);
    } catch {
      return null;
    }
    return cur === null ? null : cur === value ? 'same' : 'different';
  };
  const rows = plan(sources, have);
  if (!apply) return { available: true, apply, rows };

  const blanks = new Map<string, string[]>(); // file -> names to empty
  for (const r of rows) {
    if (r.action !== 'move' && r.action !== 'dedupe') continue;
    const value = valueIn(r.file, r.name as string);
    if (r.action === 'move') {
      try {
        vault.set(r.name as string, value);
        if (vault.get(r.name as string) !== value) throw new Error('read-back differs');
        onStored(r.name as string);
      } catch (err) {
        r.action = 'failed';
        r.error = vault.scrub ? vault.scrub((err as Error).message, value) : 'could not store';
        continue;
      }
      r.action = 'moved';
    } else {
      r.action = 'deduped';
    }
    if (!blanks.has(r.file)) blanks.set(r.file, []);
    blanks.get(r.file)!.push(r.name as string);
  }
  for (const [file, names] of blanks) blankEnvLines(file, names);
  return { available: true, apply, rows };
}

/** The .env files `pa secrets migrate` looks at by default, with what each may move. */
function defaultSources({ toolDir, repoRoot }: { toolDir?: unknown; repoRoot?: unknown }) {
  const factoryDir = path.join(repoRoot, 'software-factory');
  return [
    { file: path.join(toolDir, '.env'), readable: PA_READABLE },
    { file: path.join(repoRoot, '.env'), readable: PA_READABLE },
    { file: path.join(factoryDir, '.env'), readable: factoryReadable(path.join(factoryDir, '.env.example')) },
  ];
}

module.exports = { PA_READABLE, plan, migrate, defaultSources, factoryReadable, blankEnvLines, parseLine };
