# Build enrichment plan (A–G)

Status: active, 2026-11-18. Builds on D30 (Build = one Claude Code agent per task) and D32
(software-factory removed). Source: IndyDevDan's agentic-engineering videos, mainly the three "Tiny Software
Factories" lessons (2026-11-02 `1v7ldJiyH-Y`, 2026-11-09 `GRlcm3wmOqs`, 2026-11-16 `hYIymEMB9x4`);
transcripts and idea notes in `C:\repos\curator\data\transcripts\indydevdan\`.

The idea: Jarvis stays one agent per task, but each agent is **specialized and configurable**, and
everything it does is **observable, schedulable and answerable from anywhere** — human *near* the loop,
not in it. No multi-persona pipelines. Anything multi-agent must first beat a single agent on G/F's eval.

Each step ships on its own: implementation commit(s) on `main`, a separate review pass, CI green.
Update `architecture.json`, `personal-assistant/AGENT.md`/`README.md` and this file (tick the box with the
short hash) in the same commits.

## A. Build profiles

A *profile* is a saved, named, specialized Build agent (the "core four": context, model, prompt, tools):

- `name`, `description`
- `model` (haiku | sonnet | opus | fable; Fable is `claude-fable-5-2`) and `effort` (low | medium | high | max)
- `prompt` — text appended to `src/build/agent-prompt.md` for this profile
- `tools` — which MCP servers / tool groups the session gets (Build launches with `--strict-mcp-config`)
- `subagents` — optional subagent definitions (name, model, prompt, tools) written into the run's worktree
  as `.claude/agents/*.md`; default subagent model
- caps: `cost_cap_usd`, `wall_cap_min`, `idle_after_s`
- optional default `repo`

Stored in the PA store (new table + migration, both backends the repo layer supports). Ships with seed
profiles: `chore` (sonnet, low), `feature` (opus or fable, medium), `research` (sonnet, read-only report),
`quick` (haiku, low). A card picks a profile (card menu, `build_start profile`, `pa do --profile`);
the planner picks a default from the task kind; per-card overrides of model/effort/caps still work.
Existing `build.card.<id>` settings keep working. Verify the real Claude Code flags/env for effort and
subagent model with `claude --help` before wiring them.

The `research` profile runs read-only (Claude Code's dontAsk permission mode: `plan` ignores allow rules for commands that write, so the agent could not run `pa run done`). The planner's eager research
runs pass `mode: 'plan'`, which Build has ignored since D30, so they are not read-only today: honour it
through the profile.

Done when: a run started with a profile launches with that profile's model, effort, prompt, MCP set and
subagents; the run's `summary.json` records the profile; tests cover profile resolution and launch args.

## B. Settings per agent, with agent access parity

- One settings view per agent in the dashboard: each Build profile (A), the PA chat, and the worker passes'
  model choices. Shows model, effort, prompt (read + editable append), tools, caps, context thresholds.
  Settings move from env-only to the store (env stays the default/fallback).
- **Parity:** every settings action in the UI has a matching chat tool and `pa` verb
  (`profile_list|get|set`, `pa profile ...`), going through the policy engine (writes ask, reads allowed).
  The chat can change settings within policy limits ("set chore to fable medium").
- A test enumerates the dashboard's mutating API routes and fails when one has no chat tool or `pa` verb
  (an explicit allowlist for deliberate exceptions).
- Landed in fd4f7bb as the `/agents` page, `src/agentSettings.ts`, `pa profile` / `pa agents` and
  `test/dashboardParity.test.js`. Not in it yet: the context thresholds (C adds them, with the tool-summary
  N and visible lines, to the same page, tool and verb: an `agent_settings` key each).

## C. Tool summaries and live status

- A light model (`PA_SUMMARY_MODEL`, default haiku-class or `azure/pa`) summarizes a run's tool calls every
  N calls into one plain sentence, from what `src/build/track.ts` already parses. N and visible lines are
  settings (B). Summaries are stored with the run and shown on the run's card/timeline (closes PLAN 8.8.3).
  The chat's `build_run` returns the latest summaries, so Talk can answer "what is run 42 doing?".
- Context meter per run (tokens used vs window) on the Build board.
- Global nav shows live agent status: running count, waiting-for-you count, spend today.

## D. Decision queue (questionnaire asks)

- `pa run ask` gains a structured form: several questions, each with options + free text
  (`pa run ask --json <file>` or repeated `--q/--option`). Plain `pa run ask "<text>"` keeps working.
- Open asks appear as one queued "decisions" card in Needs you; answer each by click, typed text or voice;
  answers go back to the agent in one reply. Push notification through the existing notify path,
  respecting the interrupt budget.
- A run waiting on decisions does not burn its wall-clock cap and is never marked idle.

## E. Scheduled Build runs

- New routine action `build_run`: name + schedule + prompt + profile (+ repo). On fire it starts a Build run
  exactly like Do on a card, under the daily budget (`PA_DAILY_BUDGET_USD`) and the profile's caps.
  Results wait for review (draft PR / report) — near the loop.
- Created from the dashboard routines page, the chat (`routine_add` already exists — extend it), or
  `pa routine add`. Preview shows the next 3 runs, as routines do today.

## F. Profile eval

- `pa eval build`: take N finished runs (from `build-runs/run-*/summary.json`) that ended with a PR or report,
  replay each task from its base commit in fresh worktrees across a set of profiles (or model×effort),
  and score: CI/tests pass, diff size, cost, wall time, plus the original run's human verdict when known.
  Writes a JSONL + a small table on the Meter/Build board. Budget-capped; dry-run lists what it would run.
- Used to set the planner's default profile per task kind. Any multi-agent idea must beat a single agent here.

## G. Second opinion

- Opt-in per card for research/report tasks: run the task on two profiles (different models, e.g. Claude +
  an Azure open-weight model through the existing `azure/` provider for report-only work), then a fuse step
  writes one report: agreements, disagreements, and what each saw that the other missed.
- Fuse follows a "respond only when addressed" contract; no free-running agent chat.
- Coding tasks stay single-agent (D30).

## Order and status

- [x] Remove software-factory (D32) (d315af1, a6748f3, d90efe8)
- [x] A. Build profiles (4bb5989)
- [x] B. Settings per agent + parity (fd4f7bb)
- [x] C. Tool summaries + live status (7ed8a43)
- [x] D. Decision queue (6b73436)
- [x] E. Scheduled Build runs (4ec0262)
- [ ] F. Profile eval
- [ ] G. Second opinion

Later, only if F shows a win: small agent teams with a lead orchestrator (Fable 5.2 as lead).
