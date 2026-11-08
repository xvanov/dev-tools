# Glossary

| Term | Definition |
|------|------------|
| **Ask** | The `/talk` page of the personal-assistant dashboard — a voice/text chat interface for creating tasks and asking questions |
| **Board** | The personal-assistant's task board (`/`) — what's on you, next meeting, replies, runs |
| **Brief** | Output of `pa brief` — what is on the operator today, derived from commitments |
| **Capture** | The ingest pipeline: audio (mic/loopback), Microsoft 365 (mail, calendar, Teams), GitHub, Jira, Claude Code sessions |
| **Card** | A task on the personal-assistant board — one commitment, with source, person, repo and session links |
| **Chain** | The software-factory's persona pipeline: direction -> PM -> SM -> Dev -> Reviewer -> gates -> PR |
| **Commitment** | A typed work item with who asked, for what, by when, and in which repo — the core unit the personal-assistant manages |
| **Direction** | A high-level work order filed to the software-factory, triaged into stories by the PM persona |
| **Dispatch** | The act of handing an approved commitment to a Claude Code session via `pa do` |
| **Distil** | The pass that turns raw ingested data into structured commitments (commitment rows with metadata) |
| **Draft** | A reply message written from a run's diff and the original ask, opened in Teams/Outlook for the operator to send |
| **Factory** | The software-factory orchestrator — an LLM persona pipeline that turns directions into reviewed, tested, merged PRs |
| **Front** | The swappable web UI tier of termhub — serves the xterm.js UI and proxies to sessiond |
| **Gate** | A quality check in the software-factory pipeline (acceptance test, review, merge, smoke) |
| **Jarvis** | The desktop shell brand; also the name for the Bun-based runtime that replaces Node.js for the PA worker and termhub front |
| **Jarvisd** | The Jarvis daemon — TypeScript on Bun, runs the PA worker and termhub front |
| **Land** | To complete a run — its PR is merged, the worktree is removed |
| **Loop 1/2/3** | Software-factory's three loops: Loop 1 builds an app, Loop 2 builds itself (paused), Loop 3 is the human operator watching both |
| **PA** | Personal assistant (the tool) |
| **Pass** | A periodic worker run in the personal-assistant (ingest, distil, recall, draft, ...) |
| **Persona** | A prompt-defined role in the software-factory pipeline (PM, SM, Dev, Reviewer, ...) |
| **Plan** | The personal-assistant dashboard's `Build` page (`/`) — also a mode of work |
| **PTY** | A pseudo-terminal — the OS primitive termhub allocates for each shell session |
| **Ptyd** | The Rust PTY host that replaces node-pty as termhub's terminal backend |
| **Run** | A dispatched unit of work — a Claude Code session in a worktree, doing one task |
| **Sessiond** | termhub's persistent PTY supervisor process — owns terminals and their scrollback |
| **SM** | Story Manager — the software-factory persona that splits a direction into story files |
| **Stack** | A named environment (work, personal) with its own termhub front, PA instance, and data |
| **Story** | A single unit of work in the software-factory — one story file, one PR |
| **Tailnet** | A Tailscale network — the private network overlay termhub uses for connectivity |
| **Tick** | A single pipeline pass by the software-factory (`factory tick`) — drives every in-flight story one step forward |
| **Vault** | The OS credential store (Windows Credential Manager / Linux Secret Service) used for secrets |
| **Worktree** | A separate git checkout used for dispatched runs — one per run, never the main tree |
| **Worker** | The personal-assistant's background process that runs periodic ingest/distil/draft passes |