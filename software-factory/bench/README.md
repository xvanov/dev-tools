# `bench/bench.py` — the convergence harness (NOT the graded benchmark)

> **This harness does not answer "is the factory as good as Claude Code".**
> It grades the factory on **sacrifice's own gates** — tests the factory wrote —
> so it measures convergence, not correctness. For the externally graded answer
> read **[`swebench/README.md`](swebench/README.md)** and
> **[`swebench/results.md`](swebench/results.md)**.

> **SUPERSEDED 2026-08-15 — see
> [`swebench/BENCHMARK-RECORDS.md`](swebench/BENCHMARK-RECORDS.md) for the current
> record.** A nine-arm campaign (n=8, k=1) has since re-tested this on a different
> engine and different models. **The central claim below is reconfirmed and
> strengthened**: adding a planner to a DeepSeek-V3.2 builder scored **5/8 against
> the bare builder's 6/8** — zero planner-only wins, one loss — at 1.6× the cost.
> The winning pipeline is **builder DeepSeek-V4-Flash · reviewer gpt-5.4**, 6/8 at
> **$0.472/task, 4.0× cheaper than the V3.2 baseline at equal quality**. Cost per
> resolved instance for the planner graph vs the bare builder is now **$4.875 vs
> $2.510 (1.9×)**, not the 2.8× quoted below. The `swebench/results.md` pointer
> below is also stale — that file now holds the 2026-08-11 single-arm replay
> (10/17 = 59%), not the 2026-08-04 five-arm table.

**The measured answer, 2026-08-04, five arms, SWE-rebench n=19, k=1** (full table
and caveats in `swebench/results.md`):

| arm | harness × model | resolved / valid | rate | 95% CI |
|---|---|---:|---:|---|
| claude-5 | Claude Code CLI × `claude-opus-5` | 15/19 | 79% | [54%, 94%] |
| claude-4.8 | the SAME CLI × `claude-opus-4-8` | 14/19 | 74% | [49%, 91%] |
| openhands | OpenHands single agent, no chain × `azure/deepseek-v4-pro` | 10/19 | 53% | [29%, 76%] |
| factory | the chain on OpenHands × deepseek-v4-pro + gpt-5.3-codex + gpt-5.4 | 7/19 | 37% | [16%, 62%] |
| bare | hand-rolled text loop, no tool calls × deepseek-v4-pro | 1/18 | 6% | [0%, 27%] |

- **The chain shows no measurable lift**: 37% vs 53% against a single OpenHands
  agent on the same model, prompt and tools — McNemar exact **p=0.375**, n=19
  (later archive `2026-08-04T23-19-24.998844Z`, the one `results.md` re-derives
  from; the earlier archive reads 44% / p=0.625 — same conclusion). Our lift
  comes from using a competent agent loop, not from the chain.
- **The lift is tooling**: `openhands` 53% vs `bare` 6%, **p=0.004**.
- **Cost moves the wrong way**: $5.13 per resolved instance for the chain vs
  $1.82 for one agent — 2.8× for no measurable gain.
- Claude Code is ~2× the factory (p=0.008), but that pair varies harness **and**
  model, so it is a reference point, not a scaffold deficit.
- n=19, k=1, MDE ≈ ±38 pp. "No measurable lift" — not "the chain hurts".

## What this harness is still good for

Convergence and cost-per-attempt on real backlog tasks at a frozen base commit:
does the chain drive a story to gates-green unattended, and what does that cost?

Historical baseline (the "before" picture, from `state/factory.db`): ~0.68
merged stories/day, mean $17/shipped story, median ~17 calendar days/story.

## Arms

| arm | what runs | accounting |
|---|---|---|
| `factory` | improved chain (Azure open models, dev convergence ON) in an **isolated bench root** — own state db/settings/worktrees; production scheduler untouched | tokens from the bench db's `runs` rows; `$` derived from the recorded price table |
| `claude` | one-shot `claude -p` at a **pinned `--model`** in a worktree, same prompt text | tokens + `total_cost_usd` from the CLI JSON |

Both arms get the same frozen `base_sha`, the same prompt (the real
direction/story markdown), and the same done-oracle: sacrifice's own gate
commands run via the factory's `_isolated_test_env`, plus a blind LLM-judge
rubric (judge never sees which arm made the diff).

**There is no `openhands` arm here, so no comparison in this file can attribute a
result to the chain.** That is why the graded harness exists.

## Tokens are the metric; dollars are a view

Report and compare **tokens** — they are provider-reported and exact. Dollars
are derived, and the factory arm's rate table carries an **estimated**
deepseek-v4-pro cache-read rate (no Azure meter publishes one for this
deployment, and the account lacks the Cost Management RBAC role to reconcile
against the real bill). Every `result.json` therefore serializes the full price
table plus its content hash, so a later price correction re-derives every past
dollar figure without re-running anything — and only the `$` column moves.

In `summary.md`, `?` means **not reported**. It is not zero.

## Reproducibility invariants

- **`base_sha` is pinned to a literal 40-char SHA.** It used to be `""` and
  resolved `origin/main` at run time, which made the base tree a function of
  *when* an arm ran; two arms a week apart silently compared different code.
  `_base_sha` now refuses an empty or abbreviated value instead of resolving it.
- **The Claude arm pins `--model`.** Without it the CLI picks whatever it
  currently defaults to, so the arm has no stable identity across a campaign.
  Both the requested and the resolved model id land in `result.json`.
- **`clean()` keeps `bench/runs/`.** It used to end in
  `shutil.rmtree(RUNS_DIR)`, which is why all 20 rows in the July 2026
  `summary.md` have no surviving `result.json` — routine cleanup destroyed the
  evidence behind every published number. Use `clean --purge-runs` to delete
  them deliberately. Worktrees and branches are still removed; those are
  reproducible from the pinned SHA.
- **Every `result.json` records its provenance**: `base_sha`, `routes_sha`,
  `price_table_sha` (+ the table itself) and `bench_sha`. `report` surfaces
  these and prints a loud warning if the rows it is tabulating do not share a
  base SHA, because such rows are not comparable.

## Protocol

1. Freeze the campaign: set `base_sha` in `tasks.yaml` to a real 40-char SHA
   (`git -C ../sacrifice rev-parse origin/main`).
2. Per task (see `tasks.yaml`; N=2 for t1–t7, N=1 for the epic t8):
   ```bash
   uv run python bench/bench.py run-claude  --task <id> --run <n> [--model <id>]
   uv run python bench/bench.py run-factory --task <id> --run <n>
   uv run python bench/bench.py gate   --task <id> --arm <arm> --run <n>
   uv run python bench/bench.py rubric --task <id> --arm <arm> --run <n>
   ```
3. `uv run python bench/bench.py report` → `bench/results/summary.md`.

## Preconditions

- Azure credentials in `.env` (the factory arm runs entirely on the
  mv-coding-agent-foundry deployments: gpt-5.4 / gpt-5.3-codex / deepseek-v4-pro).
- `sacrifice-db` container startable (`make -C ../sacrifice up-db`) — the
  smoke gate boots isolated backends against it.
- Claude subscription authed on this machine (`claude -p` works).
- Don't run two arms of the same task concurrently (they share uv/docker).

## Success definition — and why it is not evidence

Parity: factory gates-pass rate ≥ claude on t1–t7 at ≤ 1/5 the token cost.
t8 (epic) measures the remaining long-horizon ceiling gap and is expected
to favor Claude Code.

**That bar was met in July 2026 and it did not mean what it looked like.** The
gate is the factory's own tests, so "gates-pass" is close to a tautology for the
arm that wrote them. Against a hidden oracle the same chain resolves 37% and
Claude Code resolves 79%. Treat a gates-pass rate from this harness as a
convergence measurement and nothing more — see `CAMPAIGN-2026-07-17.md`'s
superseded-by header.

## Known confounds (accepted + why)

- **Retries**: the factory gets its retry budget inside one invocation
  (convergence loop); claude gets one shot with in-session iteration. This is
  the design difference under test, not a bug — both are "the tool as used".
- **Judge**: gpt-5.4 is also a factory-arm persona model; mitigated by
  blinding (anonymous diffs, no arm labels). No model exists that is in
  neither arm and free of family bias in some direction.
- **Shared db container**: smoke runs of both arms use the sacrifice-db
  container with throwaway rows; journeys are register-fresh each run.
- **Missing matched arm (invalidating for any product claim)**: `factory` vs
  `claude` confounds *scaffold* with *model*. An absolute factory score measures
  the models in `routes.yaml`, which are a config value that gets swapped as
  cheaper models ship. The number that measures the PRODUCT is
  **`factory` − `openhands`**: one OpenHands agent on the same deployment, same
  prompt, same tools, no chain. **Not `factory` − bare** — that varies the chain
  and the tool interface at once, which is exactly how the retracted "+58 pp
  scaffold lift" happened. Measured 2026-08-04: `factory` − `openhands` = −16 pp,
  p=0.375 (−7 pp / p=0.625 on the earlier archive), while `openhands` − `bare` =
  +47 pp, p=0.004. See `STATUS.md`. Never report a factory number without the
  matched `openhands` number beside it.
- **Contaminated task pool**: the six directions behind t1–t6 (`023`–`028`) are
  now `closed` — the factory has since shipped them, so they can no longer be
  used as held-out tasks. The 45 `pm-validated` directions are the held-out pool for
  SacrificeBench — see the archived plan (`docs/archive/PLAN-2026-08-07-retired.md`, Phase D) and `STATUS.md`.
