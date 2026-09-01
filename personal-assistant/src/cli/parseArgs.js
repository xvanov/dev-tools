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

function parseArgs(argv) {
  const args = [];
  const flags = {};
  let command = null;
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (literal) {
      args.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (body.startsWith('no-')) {
        flags[body.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
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
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (command === null) command = token;
    else args.push(token);
  }

  return { command, args, flags };
}

// Flags arrive as strings; commands that mean numbers should say so once here
// rather than sprinkling Number() through the handlers.
function flagInt(flags, name, fallback = null) {
  const v = flags[name];
  if (v === undefined || v === true || v === false) return fallback;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function flagBool(flags, name, fallback = false) {
  const v = flags[name];
  if (v === undefined) return fallback;
  if (v === true || v === false) return v;
  return !/^(0|false|no)$/i.test(String(v));
}

module.exports = { parseArgs, flagInt, flagBool };
