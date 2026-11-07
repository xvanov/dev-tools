# Jarvis native rebuild: design summary

Why the plan in [PLAN.md](PLAN.md) looks the way it does. Condensed from four research tracks
(runtime, storage, infrastructure, measured latency), 7 Nov 2026. Decisions are in PLAN.md's
decision log; where this file and the log disagree, the log wins.

## The finding that drives everything

The servers and database are already fast (Postgres 0.6 ms, the board 80 ms). The waiting comes
from how parts call each other: a new process per call, Python start-up, polling, and audio that
isn't streamed. The two largest costs:

- every `claude -p` costs ~4 s before the model starts (the factory brief uses one);
- every factory call starts Python: 0.3 s on Linux, 0.8 s in WSL.

So speed comes from long-lived processes, in-process calls, streaming, and a database on the
host. That holds in any language; the language choice matters for memory, start-up, safety,
sandboxing and the phone.

## Where the time goes today (work laptop, warm)

| Flow | Today | Main overhead | Target |
|---|---|---|---|
| Voice, end of speech to first audio | 1.3–2.0 s | batch STT after the turn, fixed 200 ms silence wait, TTS waits for a full sentence | < 0.7 s |
| Jarvis tool call | 4–10 s | a node process per `pa` tool (0.3 s), uncached query embedding (0.3–1 s) | 2–5 s less |
| Start a factory job | 10–25 s | `claude -p` (4 s), `uv run` spawns, board refresh up to 150 s late | < 1 s to "started" |
| Open Build | 60–120 ms + reload | full page loads, 30 s / 120 s polling | instant, pushed |

## Target shape

Identical on every machine. The work and personal stacks run the same binaries with separate
data, keys and certificate authorities, and never connect.

- **Clients:** browser shell (Ask, Plan, Build, Run, Meter, Map); later a Tauri desktop and phone
  app with wake word, VAD and STT on the device.
- **jarvisd** (TypeScript on Bun, one executable per OS, in-process typed modules): gateway
  (static UI, ConnectRPC, SSE, MCP, CSRF/Host guards), board and memory, ingest, orchestrator
  (the factory: queue, run tree, budgets, kill switch), policy and approvals, secret broker,
  audit and cost.
- **Store:** SQLite (WAL, FTS5, vectors, SQLCipher), one file per stack, owned by jarvisd; the
  queue, event outbox and audit log live in it; Litestream backup.
- **Supervised children** over a Unix socket / named pipe with a typed protocol: `ptyd` (Rust:
  terminals that survive restarts, OS sandbox per session), agent runs (Claude Code / Agent SDK,
  API models, opencode, local; sandboxed, egress allowlist), `voiced` (streaming STT/TTS), local
  LLM (fast-lane router).

## Language (D1: TypeScript core + small Rust kernel)

Rust where it pays: `ptyd` (~2k lines; no GC pauses in the byte stream, a few MB of memory,
survives core restarts, runs each agent in an OS sandbox: Seatbelt, Landlock/bubblewrap,
restricted tokens). Later a shared offline core for the phone.

TypeScript for the rest: ~140k lines of glue around LLMs, git and agent CLIs that Rust doesn't
make faster; agents write and fix TS faster; MCP and the Agent SDK are first-class in TS; the
existing JS becomes strict TS module by module.

| Option | Score /105 | Note |
|---|---|---|
| TS core + small Rust kernel | 96 | chosen |
| All TypeScript | 84 | no proper sandbox host, node-pty native-addon trouble |
| All Rust | 81 | slowest to iterate, little latency gained on glue |
| Go | 81 | credible kernel substitute, a third language with no unique benefit |
| Keep the Python factory | 58 | POSIX-only, start-up cost per call |

## Storage (D2: SQLite) and memory

SQLite with WAL, FTS5, vectors as BLOBs, SQLCipher. jarvisd is the only writer and batches
writes; queries run in-process in microseconds; runs on every OS including phones; backup is one
file. Upgrade path: libSQL/Turso for built-in nearest-neighbour indexes and replicas.

| Option | Verdict | Reason |
|---|---|---|
| SQLite + vectors + FTS5 | chosen | fastest, every OS and phones, one file, encrypted |
| Postgres as a child process | rejected (was plan B) | pgvector has no official Windows build, no phone path |
| PGlite | no | WASM speed, single backend, JS only |
| DuckDB + vss | no | vector index persistence experimental |
| LanceDB / Qdrant beside a DB | no | two stores per write; our scale doesn't need it |

~590 SQL call sites use Postgres-only features (jsonb, arrays, tsvector, advisory locks), so step
one is a repository interface with contract tests on today's Postgres; SQLite is swapped in behind
it.

Memory:

- Facts are structured (people, projects, commitments, claims, each with when it was true) and
  looked up by entity, not similarity. No graph DB needed.
- Messages use hybrid search: BM25 + vectors + rerank, abstaining if nothing fits.
- Embeddings (D5): keep Azure `text-embedding-3-small`, 1536 dims, embed once, copy vectors on
  migration. Measured 7 Nov 2026: 31k chunks, 10k claims, 105 pages, 242 commitment vectors,
  ~7M tokens, ≈ $0.15 in total. Exact vector scans take 10–30 ms; add an index only past ~1M.
- No vectors for identifiers, board state or key-based dedupe. Code and docs aren't ingested;
  agents use repo tools over MCP.

## How the parts talk

- Inside jarvisd: typed function calls; each module behind an interface so it can move into its
  own process later.
- Every boundary: one protobuf schema source, ConnectRPC (JSON-debuggable with curl).
- Events: one SSE stream backed by an outbox table, so a reconnecting client misses nothing;
  WebSocket only for terminals and audio.
- To LLMs: MCP at the tool edge only; the policy engine authorizes every call.
- Agents: one AgentRuntime interface; each run is a row in a tree with a budget carved from its
  parent, a capability set, a delivery ceiling and its own process group.
- Plugins: built-in module, WASM (Extism), MCP server, or child service.

## Security, made structural

- **Prompt injection:** any context that read untrusted text (mail, chat, tickets, web) gets no
  write or outbound tools and returns schema-checked output only; actions run in a clean context;
  proposals from untrusted text need approval, shown with their source.
- **Approvals:** bound to one exact tool call, expiring, reaching voice (while awake), the Plan
  card, and phone notifications. Merges, pushes to main and secret reveals need a passkey tap.
- **Agent sandbox:** sandbox-runtime on macOS/Linux, restricted account on Windows, network via
  an allowlist proxy; keys stay in a broker.
- **Access:** Tailscale ACLs, identity headers, passkey sessions; per-stack CA with mTLS so the
  stacks refuse each other even if the network is misconfigured; secrets in the OS keychain.

## Voice under 700 ms

Stream every step: streaming STT (Moonshine on device, Parakeet on GPU); start the LLM on partial
words while end-of-turn decides; TTS at the first clause; stream audio frames; keep the fast-lane
prompt warm (first turn 1.1 s, warm 0.25 s). A pipeline, not speech-to-speech: speech-to-speech
models are fast but weak at tools; good pipelines reach 500–800 ms.

## System 1 (the fast lane) and decision models (D7)

Today the fast lane is a local `llama3.2:3b` that, in one call, both decides and writes the reply
as JSON `{label, route, say}`. Because it generates text, it can be confidently wrong: it answered
"check my mail from <name>" itself instead of handing off.

"System One" decision models (TypeSafe's Jev, early access since Sep 2026) return structured
decisions (yes/no probabilities, scores) instead of text, in ~0.1 s, with all context supplied
per call. They remove generation failures but not wrong predictions (vendor benchmark 67.8%, level
with a mid-tier frontier model). It is a paid third-party service.

We take the idea, not the service: a local router scores fixed yes/no questions from single-token
log-probabilities (later, a small classifier on the turn embedding trained on logged turns), and
the small model only speaks when the router is confident the turn is answerable locally.

## Risks

Subscription billing change (15 Jun 2026, headless use has its own credit pool); Windows
sandboxing maturity; SQLite dialect and FTS ranking drift; moving specs (MCP auth, Tauri mobile,
sqlite-vec nearest-neighbour index).
