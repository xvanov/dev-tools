'use strict';

// Where a Build run came from, as the one text column build_run.origin holds.
// null: somebody pressed Do or typed `pa run`/`build_start`. 'routine:<id>:<name>':
// a routine's `build_run` action fired it (src/routines/actions/buildRun.ts).
// 'second-opinion:<group>:<a|b>': one of the two runs of a second opinion (src/build/secondOpinion.ts).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** The stored text for a run a routine started. */
function ofRoutine(routine: { id: number | string; title?: string | null }): string {
  return `routine:${Number(routine.id)}:${String(routine.title || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}

/** The routine a stored origin names, or null. */
function parse(origin: unknown): { routine: number; name: string } | null {
  const m = /^routine:(\d+):(.*)$/.exec(String(origin ?? ''));
  return m ? { routine: Number(m[1]), name: m[2] ?? '' } : null;
}

/** The stored text for one side ('a' = the card's profile, 'b' = the second opinion) of a second-opinion pair. */
function ofSecondOpinion(group: string, side: 'a' | 'b'): string {
  return `second-opinion:${group}:${side}`;
}

/** The pair a stored origin names (BUILD-ENRICHMENT G), or null. */
function parseSecondOpinion(origin: unknown): { group: string; side: 'a' | 'b' } | null {
  const m = /^second-opinion:([0-9a-f]{4,16}):([ab])$/.exec(String(origin ?? ''));
  return m ? { group: m[1] as string, side: m[2] as 'a' | 'b' } : null;
}

/** The SQL `like` pattern of both runs of a second-opinion pair. */
function likeSecondOpinion(group: string): string {
  return `second-opinion:${group}:%`;
}

/** What the board card shows: "scheduled: <routine name>" or "second opinion (A)", or null for a run somebody started. */
function label(origin: unknown): string | null {
  const so = parseSecondOpinion(origin);
  if (so) return `second opinion (${so.side.toUpperCase()})`;
  const p = parse(origin);
  return p ? `scheduled: ${p.name || `routine #${p.routine}`}` : null;
}

/** The SQL `like` pattern of every run a routine started. */
function likeRoutine(routineId: number | string): string {
  return `routine:${Number(routineId)}:%`;
}

module.exports = { ofRoutine, parse, label, likeRoutine, ofSecondOpinion, parseSecondOpinion, likeSecondOpinion };
