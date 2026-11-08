'use strict';

// A deliberately small argv parser, hand-rolled rather than pulled in.
//
// termhub ships with two runtime dependencies and is the better for it; a CLI
// with a dozen verbs does not need a framework. The grammar is:
//
//   pa <command> [positional ...] [--flag value] [--flag=value] [--bool] [-b]
//
// Two behaviours that are decisions rather than accidents:
//
//  - `--flag` followed by another flag is a boolean, not a flag whose value is
//    "--other". `pa do 42 --mode --verbose` is a typo, and reading `--verbose`
//    as the mode would dispatch a run in a mode nobody asked for.
//  - Everything after a bare `--` is positional, verbatim. `pa say 7 -- --help`
//    has to be able to type "--help" at an agent.
//  - A repeated flag keeps its last value in `flags`, as before; every value it
//    was given is in `lists[name]`, in order, for the few verbs that take a
//    flag more than once (`pa do --done a --done b`).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

function parseArgs(argv: string[]) {
  const args = [];
  const flags: Json = {};
  const lists: Json = {};
  const set = (name: any, value: any) => {
    flags[name] = value;
    if (typeof value === 'string') (lists[name] = lists[name] || []).push(value);
  };
  let command = null;
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (literal) {
      args.push(token);
      continue;
    }
    if (token === undefined) continue;
    if (token === '--') {
      literal = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith('no-')) {
        flags[body.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        set(body, next);
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        set(body, next);
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (command === null) command = token;
    else args.push(token);
  }

  return { command, args, flags, lists };
}

// Flags arrive as strings; commands that mean numbers should say so once here
// rather than sprinkling Number() through the handlers.
function flagInt(flags: any, name: any, fallback: any | null = null) {
  const v = flags[name];
  if (v === undefined || v === true || v === false) return fallback;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function flagBool(flags: any, name: any, fallback: boolean = false) {
  const v = flags[name];
  if (v === undefined) return fallback;
  if (v === true || v === false) return v;
  return !/^(0|false|no)$/i.test(String(v));
}

module.exports = { parseArgs, flagInt, flagBool };
