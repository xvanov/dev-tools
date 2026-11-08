# Glossary

## Domain terms

| Term | Definition |
|------|------------|
| **Direction** | A markdown work order filed by an operator or ingested from a GitHub issue. The input unit of work for the factory pipeline. |
| **Story** | A decomposed unit of work split from a direction by the SM persona. Contains acceptance criteria and tasks. The unit the chain pipeline processes. |
| **Persona** | A prompt-defined role in the factory pipeline (PM, SM, Dev, Reviewer, Tech-Writer, etc.). Each has a `.md` prompt file. |
| **Chain** | The state-machine-driven pipeline that advances stories through personas and gates. Two variants: `tdd` (code) and `docs` (documentation). |
| **Gate** | A merge-quality check (tests green, smoke green, canonical paths only, docs current). All must pass before a PR is auto-merged. |
| **Tick** | A single pass of the chain engine — picks up in-flight stories, advances them one step. Runs on a timer (5 min systemd timer or `factory tick`). |
| **PM sync** | The process of triaging open directions into stories (run by `factory pm-sync --app <app>`). |
| **Staging twin** | A clone of the factory repo where self-edit diffs are applied and validated before promotion. Only used for loop-2 (paused). |
| **Detector** | A deterministic check that fires on facts (cost spike, stalled stories, conformance breach, etc.) and files directions into the chain. Replaced the deleted LLM-tier manager. |
| **Worktree** | A git worktree where the Dev persona produces code changes in isolation. |
| **SWE-bench** | The external benchmark used to measure the factory's code-generation performance against a hidden oracle. |
| **FMS** | Factory Management System — the old four-tier LLM pipeline (L1 Watcher → L2 Summarizer → L3 Diagnostician → L4 Apply), deleted 2026-08-07. |
| **Loop 1/2/3** | The three operating loops: 1 = factory builds an app, 2 = factory builds itself (paused), 3 = human operator watches and fixes wedges. |
| **Halt** | A factory safety mechanism that stops all spend until an operator runs `factory resume`. |
| **Cutover** | The migration of the factory from its standalone repo (`xvanov/software-factory`) into the `dev-tools` monorepo (`software-factory/`), completed 2026-11-06. |