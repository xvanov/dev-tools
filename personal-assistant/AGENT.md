# personal-assistant — working agreement

Read [`PLAN.md`](./PLAN.md) first. This file is the set of things that must stay true no matter
which phase you are in or who is editing.

## Invariants

**Capture is append-only, and raw payloads are kept.** Never let a distillation pass be the
only record of what a message said. Every derived row carries `extracted_by` (prompt/model
version) so history can be re-derived when the prompt improves. Deleting a `source_item` is a
retention action, never a cleanup.

**Nothing is sent without a human.** This tool has no code path that puts a message on the
wire. Drafts — including the ones the worker writes on its own — are delivered by opening them,
already written, in Teams or Outlook (`src/draft/deliver.ts`), and the human presses Send there.
`pa send` and the dashboard's Send button both do exactly that and nothing more. If the
connector is ever granted `Mail.Send`/`ChatMessage.Send`, using them is a conversation, not a
patch — and no worker, cron job, skill or agent may ever trigger a send.

**A dispatched run never touches the main working tree.** Own worktree under
`../.pa-worktrees/<run-id>`, own branch, removed by `pa drop`. The root `CLAUDE.md` is explicit
that a dirty tree breaks termhub's updater — dispatched work must not be able to cause that.
A run on another machine (`--machine`, `src/dispatch/remote.ts`; Windows, Linux or macOS; no
new ones since D28, which refuses `--machine`) got the same: its worktree and the pushurl block are made on that machine through termhub's
`POST /api/exec` (exit codes checked, no shell) before `claude` is typed, and the dispatcher
checks the worktree exists through termhub's API rather than trusting the shell.

**Mode boundaries are enforced by the dispatcher, not requested of the agent.** A `local` run
gets no push credential in its environment: its termhub session starts with GH/GitHub tokens,
`SSH_AUTH_SOCK` and askpass helpers removed, git's credential helpers reset to none through
`GIT_CONFIG_*`, and ssh run with no user config, agent or default key (`remote.noPushEnv`, applied by
termhub's session env and confirmed back as `envApplied`; a termhub that cannot confirm it refuses the
run). `gh` is logged out there too: `GH_CONFIG_DIR` points at an empty private directory of ours (so
the `hosts.yml` in `~/.config/gh` is never read), `GH_HOST`/`GITHUB_TOKEN` and the other tokens
are unset, and `GH_TOKEN`/`GH_ENTERPRISE_TOKEN` are set to a worthless sentinel (`gh` otherwise falls back to the OS
credential store, and `gh auth token --hostname github.com` would print the operator's login; an env token wins for
every host, so `gh auth token` prints the sentinel and `gh api` gets a 401); the shell starts without rc files (termhub `noRc`, confirmed as `rcSkipped`; required on
Windows) and on POSIX the agent's command line re-applies the env after them (`remote.noPushCommand`),
so a `~/.bashrc` that exports a token cannot undo it. `test/dispatchStart.test.js` checks `gh auth
token` fails inside that env. **Residual risk:** that strips what the environment hands the agent, not
what the disk holds — an agent that reads `~/.ssh/id_*` or gh's `hosts.yml` itself and passes it
explicitly can still push; the pushurl block is not credential isolation either (`git push <url>` and
`-c` walk round it). And a run whose mode may push (`branch`, `mr` — so every `draft_pr`, `pr` and
`auto_merge` session) holds the operator's full credentials: its agent, started with
`--dangerously-skip-permissions`, *could* exceed its level (mark its PR ready, merge it, push to main);
the end state is what the PA does, not a limit on what that agent can do. The same holds for a
no-push run: it is the operator's OS user, so `GH_CONFIG_DIR=$HOME/.config/gh gh …` or `~/.ssh/id_*`
restores the login. **The real boundary for work that must never exceed its level is a separate OS
user (or machine) without those credentials — not set up yet; a follow-up.** `pa doctor` says so on
every run (`run isolation`). `PA_SANDBOX=on` (default off; `src/dispatch/sandbox.ts`, native plan
5.2/5.3) is the first step: the session starts inside the factory's OS sandbox, whose environment
is an allowlist (no token, no SSH socket, no gh login) and whose filesystem hides the profile, and
pushes / draft PRs go through a broker capped at the mode's ceiling. It covers `plan` sessions
only: a sandboxed session cannot write the repo's shared `.git`, so it cannot commit, and a code
mode is refused while the flag is on rather than run unsandboxed.

**Unattended levels cannot be started from inside a run — by mitigation, not by boundary.** A
dispatched agent runs as the same user with prompts skipped, so it can reach the dashboard API with
`X-PA: 1`, run `pa`, or fake a TTY. Two cheap layers: (1) every dispatched session's env carries
`PA_DISPATCHED_RUN=<id>`, and `pa do` / `pa answer` refuse `auto_merge` / `push_to_main` while it is
set; (2) the dashboard's endpoints that start or accept those levels also need a page token issued
with each page load and held only in that page's memory (`X-PA-Page`, src/dashboard/server.js), and
Do confirms only the level the page resolved and showed (`confirmedLevel`; anything else is 409 with
the level). An agent that unsets the variable and scrapes a page gets past both: defence in depth. Do not
implement a stop condition as a sentence in the prompt and call it done. Here and on another machine, the push block goes in the worktree's own config
(`extensions.worktreeConfig` + `git config --worktree`; a plain `git config` in a worktree writes
the repo's *shared* config and blocks the main checkout and every run at once) and is **read
back** before the run starts — a block that cannot be verified (a termhub without `/api/exec`,
where it could only be typed) refuses the no-push run instead of starting it unverified. Both
paths call the one `remote.blockPush`, after `remote.clearLegacyBlock` has removed the dead pushurl
older code left in a repo's *shared* config (only that value). Nothing else edits a repo's shared
config: `pa land` lifts no block (a mode that may push never had one). A start that fails after its
run row exists marks the row failed with the reason and removes the session, worktree and branch.

**The dispatcher is not tailnet-reachable.** It executes code by design. Loopback and the WSL
interface only. termhub is the thing that is safe to expose, because its trust model is the
tailnet ACL and it was built for that; this is not.

**The dashboard is the dispatcher's trust model, not termhub's.** Its Dispatch button starts
agents, so `src/dashboard/server.js` binds loopback only, rejects a non-loopback `Host` (DNS
rebinding), and requires an `X-PA: 1` header on every POST (a custom header forces a CORS
preflight the server never answers). Its Send button opens the reply in Teams or Outlook and
then asks whether you sent it; it cannot send. A card's **Open in termhub** is a POST under the
same guards: it opens the termhub session already running that Claude conversation, or starts
the fixed command `claude --resume <uuid>` in the session's own folder on the machine it ran on —
the id must be a UUID and a machine missing from `PA_MACHINES` is refused, never resumed here.
Card links are built server-side from stored URLs and only `http(s)` ones are rendered. The Memory tab's writes (remember, forget,
approve, merge) are POSTs under the same guards, and memory pages reach the browser as a parsed
tree (`src/dashboard/markdown.js`) built with `textContent` — the page has no HTML sink, and
`test/memoryui.test.js` fails if one appears. The Factory page (`/factory`) is the same: its
writes (Cancel, Approve, Open in termhub, New job, and the Repos section's Add repo and gate edits, `factory app add|set` with each value one argv element) are POSTs under the same guards, a job id is
checked against `factoryCore.JOB_ID` before anything, Approve runs only the `approve-direction` the
factory named in that job's own warning (read from the stored list, never from the request), a new
code job at `auto_merge`/`push_to_main` needs the page token and the level confirmed, and a report —
agent-written — arrives as a parsed tree (`test/factoryBoard.test.js` fails on an HTML sink).

The one sanctioned way off loopback is **termhub's `/pa/` proxy** (`TERMHUB_PA_URL`), which
rewrites `Host` to loopback and forwards `X-PA`. That reaches exactly the people who can already
reach termhub — who can open a shell, which is more than the dashboard can do — so it adds no
capability; it is how the dashboard works from a phone. For that the page's own URLs are relative
(`api/...`, `routines.js`), never `/api/...`. Do not expose the dashboard any other way.

**Passkey sessions (plan 7.1) are off by default and add to these guards, never replace them.**
`PA_PASSKEYS=on` makes the dashboard (`src/dashboard/auth.js`, `src/auth/`) require a WebAuthn
passkey session cookie (`pa_session`: HttpOnly, SameSite=Strict, opaque, only its hash stored; idle
30 min and sliding, 12 h hard ceiling) on everything but `/api/auth/*`, `/login`, `/healthz` and
the theme; termhub's front applies the same session to its remote `/api/*` and `/ws/*` by asking
the dashboard (`termhub/lib/passkeyGate.js`). Set `PA_PASSKEY_RP_ID` and `PA_PASSKEY_ORIGINS` to
the name the browser uses (default `localhost:7300`; a passkey is bound to its RP id, so register on
the origin you will use). High-risk approvals (merge, push to main, secret reveal) need a fresh
assertion bound to that exact approval id (`/api/auth/stepup/*`, `paAuth.stepUp(id)` in
`login.client.js`); the grant is one-use, two minutes, and only that endpoint writes one, so voice,
MCP and agents cannot. On the Plan card's \"Waiting for your yes\" prompt and Build's Approve, a refusal that carries \
eedsStepUp\ + \pprovalId\ (the policy engine's, or the two dashboard gates') turns the button into **Approve with passkey**: its next click taps, then repeats the approval; it never appears with the flag off or for an approval that is not high-risk. The policy engine asks `src/auth/stepup.js` `hasStepUp(id, {consume: true})`.
**Recovery, never a lockout:** the gate stays open while no passkey is registered (the first visit to
`/login` registers one); `pa passkeys reset` at an interactive local terminal (type `RESET`)
forgets every passkey and session; `PA_PASSKEYS=off` plus a restart is the last exit. The reset is
not a chat verb and no HTTP route does it. Like the rest of this section the boundary against a
dispatched agent is the OS user, not this cookie.

**The PA chat acts only behind permission prompts.** By default (`PA_CHAT_ENGINE=sdk`) it is a
Claude Agent SDK session inside the worker (below, "On the Agent SDK engine"); with
`PA_CHAT_ENGINE=terminal`, `pa chat` starts one Claude Code session in
termhub. Either way it is homed in `<dataDir>/pa-home` (`src/chat/`), and reads other people's messages all day. The rest of this paragraph is the terminal engine's start-up; the settings and lists apply to both.
It is started *without* `--dangerously-skip-permissions` and *with* `--permission-mode default`; its
`settings.json` sets `defaultMode: "default"` and `disableBypassPermissionsMode: "disable"` (a user-level
`auto` or `acceptEdits` cannot apply), and `verifyClaudeHome` reads the settings back — including a
`settings.local.json` that would outrank them — before the session starts, refusing it otherwise. It
reads only through MCP tools: the read MCP tools, and the read-only `pa` verbs as the MCP tool `pa`
(server `pa-chat`, `--mcp-config pa-home/pa-chat.mcp.json`, `PA_MCP_CHAT_TOOLS=1`). No `pa` shell
command is allowed — a Bash prefix rule cannot tell `pa memory` from `pa memory run` — so every one,
`pa propose` included, asks. The one write it makes without asking is the chat-only MCP tool `task_add`
(a task the user explicitly asked for; reversible). Its structured tools (`src/mcp/chatTools.js`,
chat-only like `pa`) split the same way: the reads (`CHAT_READ_TOOLS`: board, card, factory_jobs,
factory_job, sessions) are allowed; the actions (`CHAT_ACTION_TOOLS`: factory_start, factory_continue,
factory_resume, factory_cancel, factory_approve, session_start) are on no allow list, so every call asks,
and `verifyClaudeHome` refuses a home whose allow list names one or the whole server. The actions are
the dispatch paths themselves (`dispatch.start`, `factory.cancelJob|approve|resume`), never a second
implementation, and an unattended end state from them becomes a card (`suggested by the chat`), as
`pa do` does for a non-interactive caller. Its CLAUDE.md is rewritten from code on every start — change it in
`src/chat/index.js`, not on disk; the user's own additions go in `CLAUDE.local.md`. The chat may run
on opencode instead (`PA_CHAT_AGENT`, `src/chat/agent.js`) only under the same guarantee, enforced
differently because opencode parses a command line its own way and every bash allow-pattern was a
way round it: its `opencode.json` starts from `"*": "ask"` (opencode's defaults allow), makes
**every** shell command ask with no allow-pattern, and gives it the read-only verbs
(`ALLOW_COMMANDS`) as the MCP tool `pa` instead — an enum plus argv, no shell, sub-commands compared
case-insensitively against per-verb allow/deny lists, writing flags (`--force`, `--notify`, `--done`,
`--project`, …) refused on every verb, verbs that write (`notify ack`, `doctor`) not on it at all, and
`runs` run with `PA_READ_ONLY=1` so it does not reconcile — listed only when the chat's own config sets
`PA_MCP_CHAT_TOOLS=1`.

**The voice fast lane only speaks or hands off** (`src/chat/fastLane.js`, `POST /api/talk/turn`). It
calls a model with no tools, and its one side effect is typing the user's own words into the PA chat
through `feed.send` — the same path as typing. Keep it that way: never give it tools or `pa` verbs,
keep `guardDecision` turning an "answer" to an action-like request into a handoff (and one about a
day the snapshot does not hold, `looksBeyondSnapshot`, into a plain hand-off), and keep what is
handed off the verbatim utterance (the model's `task` only as a labelled hint), since its context
snapshot quotes other people's messages. The local default (`local/llama3.2:3b`, forced-JSON
`{label, route, say}` through Ollama's native `/api/chat`, `llm.stream({ format, keepAlive })`) adds
two more guards in the same spirit: a request the model itself labels `action`/`deep_task` is never
"answered", and a hand-off's `say` is held until whole and replaced by the stock acknowledgement when
it reads as an answer or a claim (`spokenAck`). Failing before a decision (Ollama down, or no route
within `PA_FAST_LOCAL_TIMEOUT_MS`) falls back to `PA_FAST_FALLBACK_MODEL` on the text format.
Since 0.6 (D7) the default router is `logprob` (`src/chat/fastRouter.js`): decide, then speak. The
router returns calibrated probabilities from one token's log-probabilities and never words, and the
answerer only speaks above `PA_FAST_ANSWER_THRESHOLD`. Changing its prompt or model invalidates
the calibration: re-run `pa eval router --fit`, paste the printed constants into `fastRouter.js`,
and keep "no action answered here" at 0. Changing the answerer's prompt (`ANSWER_RULES`) or the
snapshot's format: run `pa eval answerer` and `pa eval router`. The eval sets
(`src/eval/router-cases.json`, `src/eval/answerer-cases.json`) are public: people, companies and
meeting titles in them are placeholders only.

**The voice page hears the room; nothing it hears leaves the browser until a request is made.** The
wake word ("hey jarvis", openWakeWord) and Silero VAD run in the page on onnxruntime-web
(`talk.voice.js`); only an utterance after the wake word (or with the wake word off, hands-free or
push-to-talk) is sent, to the PA's own `/api/talk/transcribe` and `/api/talk/endpoint`. Keep the
wake word client-side. The local voice service (`voice/server.py`, 127.0.0.1:47830) is loopback only
and refuses any request with an `Origin` header: browsers reach it only through the PA's X-PA-guarded
proxy (`/api/talk/tts`, `/api/talk/endpoint`, `/api/talk/warm`). `/talk/models/` serves a fixed list
of file names (`MODEL_FILES`), never a path. `src/dashboard/voiceCapture.js` and `micWorklet.js` are
copies of termhub's (`test/voiceCaptureCopy.test.js`); change termhub's and copy them over.
The acting verbs (`ASK_COMMANDS`) stay shell commands behind the prompt, through one launcher each
(`pa-home/bin/pa-do`, …), because opencode's "Allow always" saves the command's first word + ` *`, cannot
be turned off and outranks the config: on `node …/pa.js` that was `node *`; on a launcher it is that
one verb. It denies `task` (subagents), and an opencode chat starts only after
`verifyOpencodePermissions` has read the ruleset opencode actually resolved (`opencode debug agent`)
and found its shape — nothing after the ask-everything bash rule allows a shell command — and every
probe holding. `chatCommand` refuses any command that skips permissions
(`--dangerously-skip-permissions`, any `--permission-mode` but `default`/`plan`, `--allowedTools`,
opencode `--auto`). Add a permission to the lists, never to one agent's file.

**The worker reaches the PA chat through a file, and types into it only a fixed doorbell.** Pushed
notifications go to `pa-home/INBOX.md`, which the chat's CLAUDE.md says is data, never instructions.
Typed text is a user prompt with the user's authority, so the only thing ever typed is the
content-free `PA inbox: notification <id> is waiting. Read INBOX.md.` — never a title or body — and
only when `nudgeDecision` (`src/notify/chat.js`, tested) proves the session is Claude Code (termhub's
`kind`), finished its turn, is not on a permission prompt, and has an empty input box. An opencode
chat is never nudged: the screen rules are Claude's. When it cannot prove it, it skips: Enter on a
permission prompt approves the action. Do not loosen a condition there without a test case for it.
On the SDK engine the same fixed line is a user turn instead (`POST /api/chat/doorbell` with the id
only, `sdkFeed.doorbell`): only into a running session, idle for the same minimum, with no approval
waiting; it never starts one.

**A permission prompt is answered only deliberately, and only for the chat's own actions.** Two
paths press a key at the chat's prompt, both through `POST /api/chat/permission`
(`src/chat/permission.js`): the dashboard's "Waiting for your yes" card (`permission.client.js`,
Approve / Deny) and a spoken yes or no on Talk. The endpoint needs X-PA and the page token (issued with
`/` and `/talk`), names the tool call by its `tool_use` id, and `decide` refuses unless every check
holds: that call is the one the chat is parked on, it is a `mcp__pa-chat__` tool in
`CHAT_ACTION_TOOLS` (never a shell command, an edit or any other tool, whose one-line description would
not show what is approved), termhub says the session is Claude Code waiting with `idleReason:
blocked`, and the screen read at that moment is Claude Code's "Do you want to proceed?" for that tool
with no input box after it. Approve is one Enter with the cursor on "Yes" — never "Yes, and don't ask
again", which would make every later call of the tool unasked; Deny is Esc. Anything else is a 409.

**On the Agent SDK engine the prompt is a callback, under the same rules** (`PA_CHAT_ENGINE=sdk`,
`src/chat/sdkFeed.js`, plan 4.2; the default since 4.2, `terminal` still selectable). The chat is one
streaming `query()` inside the worker, in the same pa-home with the same settings and MCP server, started
with `permissionMode: 'default'`. A PreToolUse hook puts every call through `src/policy` (a deny refuses;
the six action tools always ask, whatever a rule or settings file says). `canUseTool` then waits for the
same two surfaces through the same endpoint: an answer must name the pending call's `tool_use` id, goes
through `policy.enforce` with its channel (a `STEPUP_REQUIRED` is a 403 carrying `needsStepUp` and
`approvalId`, and the prompt keeps waiting; after enforce passes, `policy.consumeStepUp` spends the
passkey grant before the call is released), and allows that one call only (no `updatedPermissions`, i.e.
never "don't ask again"). No answer within `PA_CHAT_APPROVAL_TIMEOUT_MS` is a deny, audited on channel
`timeout`. A prompt for anything else (a `pa` shell verb, an edit, `remember`) gets a generic "allow
once" card on the same surfaces, showing the call's whole input (`genericDetail`: the exact command or
diff, never the model's description; a cut says how much is left out). Voice may answer one only when
that input can be heard whole and the policy does not bar voice (never an edit); otherwise a spoken yes
is a 403. A policy allow for Read/Grep/Glob holds inside pa-home only (`insideHome`). The SDK's environment drops
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, so it runs on the machine's Claude login, never the API.
Tests use a mocked SDK (`test/chatSdk.test.js`); never a real model call in a test.
The SDK chat lives in the worker, so a Z1 roll moves it: on `drain` (`feed.drainChat`) the old
generation denies the prompts still waiting (nobody can answer them there any more), gives the turn in
flight up to 20 s, then closes its query, and refuses new messages with a 503; the new generation
resumes the session by the id in `pa-home/.pa-chat-sdk-session.json` on its first message.
Its Run view is a read-only termhub session following `pa-home/sdk-view/chat.jsonl`
(`src/chat/sdkView.js`). Its cwd is `pa-home/sdk-view`, never pa-home itself: the terminal engine and the
doorbell find the chat by cwd, and must never mistake the view for it. The view strips control
characters from what it prints (the text is the model's and other people's).

**Every tool call goes through one policy function** (`src/policy`, plan 4.3): `evaluate` answers
allow | deny | ask from `src/policy/default.policy.json` plus an untracked per-stack override
(`PA_POLICY_FILE`, default `<data dir>/policy.json`; its rules are tried first, its `locked` ignored).
The defaults are the allow/ask split above, unchanged (`test/policy.test.js` pins them to
`CHAT_READ_TOOLS` / `CHAT_ACTION_TOOLS`): `ask` means the host owns the prompt (Claude Code), the MCP
server still runs the call. It is applied in the MCP server's `handle` (every tool), in `answerPermission`
(a chat approval, with the channel it came from: dashboard or voice) and in `factory.approve`. A locked
rule denies the voice channel anything tagged `merge`, `push_main` or `secret_reveal` and no override
can loosen it (a voice yes to a factory job's approval looks the job's delivery up and is refused for
auto_merge / push_to_main, or when the job cannot be looked up); do not add a path that approves those from voice. With PA_PASSKEYS=on, `enforce` also refuses (`STEPUP_REQUIRED`, rule `stepup-required`) a
non-voice approval tagged merge / push_main / secret_reveal until a passkey grant exists for its
`subject` (src/auth/stepup.js); the policy only looks at the grant, and `consumeStepUp` spends it right
after `enforce` passes: a new caller that runs such an approval must do both.
Each decision is a row of `audit_log` (`src/repo/audit.js`), hash-chained; arguments are stored as a
digest only. `pa audit verify` recomputes the chain, `pa audit tail` lists it, `pa audit check <tool>`
dry-runs the policy. Adding a tool: add it to the default policy (an unlisted tool asks).

**Talk is audio in, audio out, and a spoken yes counts only while awake.** No buttons on `/talk`: the
click path is the dashboard. Jarvis speaks the question the server wrote from the call's structured
input (`transcript.askTool`: "Start a factory job for card 412 on your subscription, opening a PR for
review. Shall I?"), and the next utterance answers it under `createVoiceAsk` (`talk.core.js`, tested):
only from words *begun after* the question was spoken to the end (barge-in or words already on their
way re-ask it), only while awake — woken by "hey Jarvis" or push-to-talk, never asleep and never in
hands-free mode without the wake word — matched strictly by `permissionAnswer` (the whole utterance a
yes or a no, filler aside; anything else is unclear, asked once more, then left on the dashboard, never
guessed), within 60 s of the question. "Jarvis, sleep" / "stop listening" / "go to sleep" put it back
to wake-word-only at once (said aloud); the conversation windows already return it there on their own
(6 s after the wake word, 8 s after an answer, 60 s after a question). Do not add a model to this
decision, and do not let a yes through on any other path.

**One implementation per behaviour.** OpenClaw skills call the `pa` CLI. They do not talk to
Postgres, and they do not reimplement dispatch. When the TUI and the CLI disagree about what
`pa do` means, the bug is that there are two implementations.

**Connector passes run on Claude Code, and nothing else pretends to.** Model strings are
`provider/model` (`src/models.js`); text and JSON passes may run on any provider, but a pass that
needs `toolCalls` — the Microsoft 365 relay and the Jira connector fallback, `PA_CONNECTOR_MODEL` —
needs the claude.ai connector logins only Claude Code holds. `models.route` refuses any other
backend before a call is made, `pa doctor` shows it as not capable, and the worker logs it at
start. Do not add a fallback that runs a connector pass on a model that cannot reach the
connectors: it would "succeed" with nothing read. And an unknown price is `null` in `llm_spend`,
never estimated from a similar-sounding model — `openrouter/anthropic/…` is not Anthropic's price.

**Connector data comes from tool results, never from model text.** Microsoft 365 is reached
through a headless `claude -p` (`llm.toolCalls`), and the model's only job there is to make the
calls. Items are built from the `tool_result` blocks in the event stream, or the file Claude Code
spilled a large one to. A relay that asks the model to *copy* a message body into its reply is
a relay that will one day paraphrase someone's request. (Jira predates this and still parses the
reply; moving it over is fine.)

**The Teams cache is read, never touched, and shares the connector's rows.** `teamsLocal.js`
reads the new Teams client's IndexedDB on this disk (Windows: there is no new Teams desktop client
on Linux, so there it is off unless `PA_TEAMS_CACHE_DIR` points at a cache, and `pa doctor` says
so) because it is seconds behind where the
connector is minutes behind, and it needs no Entra app registration (ruled out for this tool). It is
the same user's same data, local only. `teams/read_cache.py` opens Teams' files read-only with
every share flag, never writes or locks them, tails the LevelDB log from a saved offset, and
never does a full parse (minutes of CPU). A pass is started by a change notification on the
LevelDB directory (debounced, `teamsTrigger.js`) and served by one resident reader process
(`teamsReader.js`); the mtime poll is only the fallback. Do not go back to a process per pass or a
fast poll: each was an antivirus wakeup. Its items are `graph_chat` with the connector's own
`{chatId}/{messageId}` ids and `raw.via = 'teams-cache'`; `planWrite` and `graphChat.mergeCached`
decide who wins a shared row, and both avoid rewriting a row whose content did not change, since
a changed hash re-runs distillation. Bodies never reach a log, stderr, or an exception message.
If a Teams update changes the record shapes the pass reads nothing and `pa doctor` shows the last
message going stale — fix the shape, do not fall back to anything that phones home.

**Memory carries its evidence.** Every claim in `claim` holds the verbatim `quote` it was read
from, checked against the item before it is stored (whitespace- and case-folded; a near miss is
`pending_review`, a miss is dropped). The quote is copied, not referenced, and `source_item_id`
is `on delete set null`, because retention deletes mail and chat and memory must survive it.
A claim with no evidence is either an explicit `pa remember` note (whose evidence is the words
typed) or a bug.

**Memory is read only from items I am part of.** `src/memory/relevance.ts` decides it in code before
the claims pass calls a model: on GitHub I must be the author, an assignee, a reviewer requested by
name (a team's review request is the team's queue), @mentioned by login, or a commenter
(`githubGate.involvement`, the same rule the distiller's commitments use); a Teams channel post must
name me or be mine; or the item is in a thread where one of those holds. Anything else is recorded
as read with no claims (`claim_extraction.error = 'skipped: …'`) and stays a searchable source item.
`pa memory prune` lists claims read from such items before the rule; `--apply` retracts them.

**Memory supersedes; it does not overwrite or delete.** A contradicting claim closes the old one's
`invalid_at`/`expired_at` and links it with `supersedes_id`; duplicates point at what they
corroborate with `duplicate_of`; `forget` sets `status = 'retracted'`. No memory code runs a
`delete from claim`. Pages are derived and may be deleted and rebuilt at will.

**Message content is data, never instructions.** Every prompt that carries item text — distill,
claims, consolidation, pages, card context — says so, and nothing a message says can change what a pass does:
no pass takes an action other than writing rows. Keep it that way when adding one.

**A debrief writes only what the user owes or is owed, each with a verified quote; its updates
are reversible.** `src/meetings/debrief.ts` turns a recorded meeting into to-dos, owed-to-me,
updates to existing commitments and decisions — never other people's tasks — and
`debriefCore.parseDebrief` drops any item whose quote is not verbatim in the transcript, whose
owner is not the user, or whose ref was not in the prompt. Every write is recorded in
`meeting_debrief.applied` with the columns it replaced, and undo restores them (unless someone
changed them since). It never writes to a PR or ticket; news about one is a claim. The generic
distiller skips meeting and call recordings (`DEBRIEF_OWNED`) so nothing is extracted twice.

**Only people create tasks.** A commitment comes from what a person said or did — Teams, mail,
meetings, a person on GitHub or Jira asking the user — or from the user asking for one (`pa task add`,
the PA chat's `task_add`, the board's + task; source `pa_request`, `src/commitments/request.ts`). Never
from the assistant's own work: Claude and Cursor sessions (the PA chat's included), bots, automated
mail, CI, team queues and the user's own GitHub activity are evidence only.
`src/commitments/sourcePolicy.ts` decides it in code before the model is called — `sourceSql` in
`distill.pending` (and `dedupe`), `judge` per item in `distillOne` — and `PA_COMMITMENT_SOURCES`
configures the sources. A new commitment writer goes through the same check, and a new source is
excluded until it is added there. No agent may create a task about its own next step; the PA chat's
`task_add` (the one write it makes without a prompt) is listed only for the chat (`PA_MCP_CHAT_TOOLS`)
and is to be used only on the user's explicit request.

**GitHub puts work on you only where GitHub names you.** `src/distill/githubGate.js` runs on the
distiller's answer for every GitHub item: no commitment at all from an item you are not personally
in (author, assignee, reviewer requested by name, @mentioned by login, or in the thread yourself) —
a team review request, CODEOWNERS, a watched repo or a followed pod board is context only. On a PR
or issue you neither wrote nor are assigned, delivery of the item's own work moves to its author
(owed_to_me), and a reviewer-only role owes only the review. It reads GitHub's records
(`raw.reviewRequested`, `raw.requestedMe`, `raw.author`, assignees), never the model's opinion of
who you are; a new GitHub source must record those or its items owe you nothing.

**A reply closes a commitment only on a verbatim quote of my own message, and reversibly.**
`src/commitments/replyClose.ts` closes an open owed_by_me ask from chat or mail only when
`replyCloseCore.parseVerdict` finds the quote in the reply of mine it names and the verdict is
"discharged" — a promise or a partial answer closes nothing. The close is recorded in
`reply_close.applied` with the columns it replaced, and the row is keyed by the newest reply
judged, so a reopened commitment is not closed again by the same reply.

**A commitment's status changes only through `src/ledger`.** `ledger.transition` is the one
writer of `commitment.status`, `closed_at` and `closed_reason`: you (`pa done`, the dashboard),
reply-close, GitHub reconcile, self-note expiry, the dispatcher and the reconciler all call it,
and each call leaves a `ledger_transition` row with its actor, reason and the columns it replaced,
so any change can be undone unless the row moved since. The assistant may close things on its
own (DURABLE.md), but never silently and never without that row. A new closer calls
`transition`; it does not run `update commitment set status`. (The debrief predates this and
keeps its own reversible log in `meeting_debrief.applied`.)

**Durable tasks act through checkpointed steps and re-read before acting.** Work that waits (a
chase waiting on a reply, a run waiting to end) is an Absurd task (`src/durable`, schema vendored
unchanged in `vendor/absurd/` at the version `absurd-sdk` is pinned to — upgrade it with a new
migration, never by editing the file). Every effect is a `ctx.step` and is itself idempotent
(dedupe keys); a task reads the commitment or run again before it acts, because the event that
woke it is a hint. `awaitEvent` suspends a task by throwing: never catch it except to test for
`TimeoutError` and rethrow everything else. A task that wants a decision creates a `proposal` and
waits on `proposal:<id>`; a proposal with no task runs a typed handler in `src/proposals` — there
is no handler that takes a command or free text.

**A finished run is delivered to the end state I chose for it, and to nothing past it.** Every run
records its delivery level (`run.delivery`, src/dispatch/deliveryCore.ts): `none` < `branch` <
`draft_pr` < `pr` < `auto_merge` < `push_to_main`. It is set only from my side — `--delivery`, the
card's dispatch settings (its ☰ menu), an explicit `--mode`, my own words in `--task`, my per-repo default (`pa delivery
set`), `PA_DELIVERY_DEFAULT` — and never from a third party's message: the planner's offers and a
commitment's text never infer one. Inference from my words reaches at most `pr` (ordinary text says
"runs on push to main"). The two levels with no human step after the yes (`auto_merge`,
`push_to_main`) need an explicit choice and a confirmed start — `D.requireConfirmed` refuses any start
without one: a terminal yes to `pa do` (which prints the end state first), the dashboard's Do, or a
card accepted in the dashboard or from a terminal. Asked for by the chat or any non-interactive
caller, `pa do` puts it on a card labelled "suggested by the chat" instead, and `pa answer` will not
accept such a card without a terminal. There is no ceiling (operator decision 2026-11-02); the card
and `pa do` say what these two do in plain words. A Claude session runs in the mode its level maps to (`D.modeFor`;
`push_to_main` runs as `local`: no push credentials in its environment and its worktree's push blocked
— which stops an accident, not a determined agent, see the residual risk above) and `run_review`
(src/durable/tasks/runReview.ts) does the rest when it ends: merging only on `auto_merge`, pushing
to main only on `push_to_main` (branch first, then a fast-forward to exactly the checked commit), and
either only after `merge.ciGate` passed CI on that commit — polled at most `CI_LIMIT_MS` (30 min),
never before `CI_SETTLE_MS`, every required check present and green (required checks unreadable →
blocked), and with none required the same green set on two polls; no checks at all counts only when
none are required, and is noted on the run. Before a merge `merge.mergeRefusal` re-reads the PR: base
is the default branch, not from a fork, head is the checked commit, and the base has not moved since
CI unless the repo itself requires up-to-date branches. A worktree starts from a freshly fetched
`origin/<default>`. Red, late or refused: branch / PR left, run `blocked`, I am told. A run
recorded before end states (delivery null) keeps the old rule: a draft PR, merged only in a repo on
`PA_MERGE_REPOS` — do not widen that list. The push block is lifted from the worktree's own config
(`liftPushBlock`), the same place `blockPush` put it.

**The planner starts only read-only runs on its own, and few.** `src/agent/planner.ts` may start
a `plan`-mode run (it reads and writes findings; it can neither commit nor push) for an ask it
judged "investigate" with a known repo, at most `PA_EAGER_RUNS_PER_DAY` a day and only while
`budget.allow('eager')` says yes, and tells you it did. Anything that changes code is offered as a
`dispatch` proposal and starts only on your yes. Do not widen the mode it may start alone.

**The factory is THE dispatch target (decision D28), reached only through its contract.**
Every agent session the PA dispatches is a factory job (`src/dispatch/factory.ts`), so it shows
on Build and is metered (the credit pool on `claude_session`, the API keys on `api`): `pa do`,
the dashboard's Do, the planner, accepted cards, and the chat's `factory_start` and
`session_start`. There is no route to pick: `PA_DISPATCH_VIA`, `PA_ROUTE_CHOOSER`, `--via claude`
and `--machine` are gone and refused. `dispatch.startSession` (a raw Claude Code session) has no
production caller and is kept only to seed the land/drop tests (docs/native/PLAN.md 8.6.3); if
anything calls it, it logs and writes an `llm_spend` row of unknown cost. The PA never imports factory code or reads its store: it runs `uv run factory
job|app …` through `runCommand` (`src/dispatch/exec.ts`) and parses the one JSON object the
factory's `docs/JOBS-API.md` says each command prints. Every job is sent with an explicit
`--delivery` (the end state above; a research/report/plan job delivers `none`) and the factory
honours it as asked. A code job changes code, so the planner only ever *offers* one; its own runs
are `plan` mode, a read-only factory `plan` job (JOBS-API v1.8: on `claude_session` Claude Code
runs in its plan permission mode; `test/factoryDispatch.test.js` checks the planner source). A job's end moves its
commitment only through `ledger.transition` (actor `factory`) and only from `dispatched`, and
GitHub reconcile closes only `open` asks, so a merged factory PR is never closed twice. A job id is
checked against `factoryCore.JOB_ID` before it is typed into a terminal. Every job carries a kind
(`code` | `research` | `report` | `plan`) and a runtime (`api` | `claude_session`), JOBS-API v1.2;
whatever a start does not choose comes from the card's dispatch settings (`src/dispatch/settings.ts`:
the card's stored overrides, else runtime `PA_FACTORY_RUNTIME` = claude_session, mode
`PA_DISPATCH_MODE` = full, the kind from `factoryCore.inferKind`, the end state from the factory
app's `delivery.default`). A research/report/plan job needs no repo, delivers `none` (its
deliverable is the factory's report) and its ask is the operator's own words
(`factoryCore.researchAsk`, no composing model). A v1 factory refuses the v1.2 flags in its CLI
parser (`unsupported_option`, before anything is written): a code job on `api` is resent without
them, anything else fails saying so. A code job may continue an existing branch or PR (`job submit --branch|--pr`,
`F.BRANCH` checks the name); a factory without the flag refuses it in its parser and the job fails
saying so — it is never resent without it, which would start fresh work instead. `job resume <id>`
(`factory.resume`) on a factory without it says the factory must be updated. Every code job is
sent with a `--flow-file` (`factoryCore.flowMarkdown`,
deterministic), since the factory parks a job without a flow; content reaches another machine
on the writer's stdin (never argv, where `ps` shows it and a large brief overflows the limit), into
a fresh `mkdtemp` directory (0700) with `O_EXCL|O_NOFOLLOW` files, removed once the factory has the
job (kept while a submit's outcome is unknown, since it may still be read). A submit is idempotent on
`--source pa --external-id <install id>-<run id>` (sql/026 `pa_install`; a first submit answered
`created: false` is someone else's job and is refused); only the factory's known pre-creation refusal
codes (`factoryCore.REFUSAL_CODES`) or a command that never ran (exit 127) fail a run outright; after
any other failure once a submit went out, the run is settled
against `job status`/`job list` (`factory.settle`, `factoryCore.submitVerdict`) — adopted, failed
only after the factory has said "no such job" for `SUBMIT_GRACE_MS`, or `waiting` as
`submit_unknown` for the worker, failed and notified after a day either way — and never left
`starting`. `pa drop` settles such a run first (cancelling a job it finds) and refuses while the
factory cannot be asked. One live run per commitment holds under concurrency: every run insert goes
through `runRow.insertRun`, which re-checks under a transaction-scoped advisory lock.

**A factory brief carries what the task needs, not my private material.** The ask is composed
(`src/dispatch/compose.ts`; every rule pure and tested in `composeCore.js`): goal, done-criteria,
constraints, decisions, facts, pointers to existing files to reuse or extend, and the fixed
instruction to search before writing, extend rather than duplicate, follow conventions and add
tests. Memory pages and message bodies go to the composing model to select from and never into
the brief wholesale (`copiesPrivate`: 12 verbatim words is a dump and is dropped); secrets are
redacted before the model sees anything and again after; reuse paths must be files the repo has.
The model is a mockable seam (`compose._setModel`) and is chosen by `compose.pickModel`: a keyed
path (Anthropic API, else `PA_COMPOSE_FALLBACK_MODEL` with its key present) beats `claude -p`, which
is only the last resort. When it fails, the brief is the deterministic
one, which holds nothing private. What a dispatch card shows is frozen in the proposal
(`src/dispatch/offer.ts`) and is exactly what runs at accept — app, criteria, brief, pipeline,
models, end state (re-rendered, never recomposed, if I change it on the card). Nothing outward
happens before the yes: registering a repo with the factory (`factory app add`) waits for accept.

**Capture never stops for the assistant.** The worker's only levers on `capture.py` are the pause
file (`pa mic pause`) and the roll file, which makes capture finish its file and continue in a
new one. The meeting gate (`src/audio/gate.ts`) writes the pause file between meetings with the
marker `meeting-gate` and removes only a file holding that marker: it never lifts a pause you
made, and it never pauses mid-meeting. A capture file is never opened for writing twice
(`audio/naming.py`).

**Only meetings with other people are stored.** A recording of the user alone — push-to-talk
dictation while coding, the voice page, Jarvis on the speakers — is not a meeting: it is already
in their sessions. The evidence is in `src/audio/selfSpeech.ts` (voice-dictation's speech-activity
log, the voice page's activity log, the gate's log of call apps on the mic): self speech is
dropped before episodes are made, a mic-only episode is `solo` unless a call app held the mic or a
calendar meeting with others overlaps it, and a `solo` episode gets no row, no transcript item
and no debrief, and its audio is deleted once settled. The debrief's `others_present: false`
discards what slips through (`debrief.discard`). Do not reintroduce a rule that turns mic-only
speech into a call because the gate was open (the old ambient→call promotion): the gate opens for
any browser on the mic.

**Agents propose memory; humans decide it.** The MCP server's only memory write is `remember`, which
stores a `pending_review` claim (`origin = 'agent'`) that no read path believes and no
consolidation sees until it is approved in the dashboard. An agent's note may be something it
read in an email. Do not add MCP tools that approve, forget, or write active claims.

**Secret values flow browser → store; no model, log, API response or MCP result ever contains
one.** A credential is asked for with a `secret_request` row (names, purpose, hints — the table
has no value column) and answered in the dashboard or with `pa secret set`; the value goes
straight into the OS vault — Windows Credential Manager (through PowerShell), or the Secret Service
on Linux (through `secret-tool`) — or the gitignored `.env`, and the reply says only where. Every
vault backend gets the value on **stdin, never argv** (`src/secrets/vault.js` is the one facade;
the backends are in `src/platform/`). Entries are **labelled by stack** (`work` on Windows,
`personal` on Linux; `PA_STACK` overrides): Credential Manager resource `dev-tools/<stack>`, Secret
Service `service=dev-tools stack=<stack> name=<NAME>`; entries from before the label (`personal-assistant`)
are still read and move on the next write. `pa secrets migrate --from-env` moves `.env` values into
the keychain: dry run by default, names only, a line is emptied (`NAME=`) only after the keychain
reads back the same value, and only names the code resolves through the keychain move
(`src/secrets/migrate.js`). The software-factory reads its provider keys from the same keychain
when `.env` leaves them unset (`software-factory/factory/keychain.py`). Code reads a
secret with `config.secret(name)` and nothing else; errors are scrubbed of it. Agents may
`request_secret` and ask `secret_status` (configured or not); do not add a tool, endpoint or CLI
verb that shows a value. `test/secrets.test.js` fails if one echoes.

**Routines run typed actions only; repo_sync never switches branches or discards work.** A
routine names an action in `src/routines/actions` with schema-checked params — there is no action
that takes a command string, and adding one is a conversation, not a patch. `repo_sync` writes
nothing but `git fetch --prune` and `git merge --ff-only` on the branch already checked out, and
only when the pure `decide(repoState)` says `ff`; it never checks out, stashes, resets, or moves a
local branch. Any new safety condition goes into `decide` with a test. Suggested routines are
stored `proposed` and only a human enables them; a rejected one is kept so it is never proposed
again. A scheduled slot missed during downtime runs once, never as a backlog.

**OS decisions live in `src/platform/`, and only there.** One implementation per behaviour per
OS (`windows.js`, `linux.js`, `darwin.js`, same contract, listed in `index.js`): data dir, venv
layout, vault, notifications, open/clipboard, who holds the mic, restarting capture, free disk, how
backups reach `pg_dump`, and the Teams cache default. Nothing else tests `process.platform`
(dispatch decides by the *target* machine's OS, which is a different question). Each behaviour's
process is built by a pure `…Command` function so `test/platform.test.js` pins it without side
effects. Where an OS cannot do a thing well, it degrades explicitly and `pa doctor` prints
`DEGRADED` or `UNSUPPORTED` — never silently.

**Raven stays a skill.** Company engineering conventions are read through the existing
`innergy-knowledge` skill. Do not copy that repo into this store; a second stale copy of the
org's conventions is worse than none.

**Retrieval changes are judged by `pa eval run`, not by anecdote.** Run it before and after any
change to `src/search/` or a memory retriever, and put the per-qtype numbers in the commit body.
A new retriever plugs in with one `register(...)` line in `src/eval/retrievers.ts` and is scored
on the same cases. The metrics in `src/eval/metrics.ts` are pure and unit-tested; keep them that
way.

**Eval cases are private data.** `eval_case` holds real questions about real mail, so it lives in
Postgres and nowhere else. Tests use invented names; fixtures never hold a real question.

## Conventions

- **Language:** plain CommonJS JavaScript, matching termhub — which is not TypeScript, and is
  the better for it: no build step means `git pull` is the whole deployment. Tests are
  `assert`-based files run directly by `node`, as termhub's are.
- **Migrations:** plain numbered SQL, applied by a script. No ORM migrations framework.
- **Expand/contract (Z3).** A deploy rolls (`src/supervisor`): the new generation migrates
  while the previous one is still serving, and a rollback runs the previous code again on the
  migrated schema. So every migration is **additive** — new tables, new nullable or defaulted
  columns, new indexes, relaxed constraints — and ships with the code that uses it. The
  cleanup (drop, rename, retype, `set not null`, a new constraint or unique index on an
  existing table, truncate) is a separate **contract** migration that ships at least one
  release after the code stopped needing the old shape, and says so on its own line:
  `-- contract: <expand file>.sql (<commit that shipped the expand>)`. Never edit or delete
  an applied migration; add a new one. `test/migrations.test.js` enforces all of it
  (`src/db/migrationRules.js`; files up to `032` predate the rule) and checks the previous
  release's INSERTs (HEAD with a dirty tree, else HEAD~1; `PA_COMPAT_BASE` overrides)
  against the schema the new migrations produce.
- **No job queue.** "Work to do" is a query — items with no distillation row at the current
  prompt version. A queue table can get stuck, leak, or need draining after a crash; a query
  cannot. The worker is a scheduler of periodic passes, and passes never overlap themselves.
- **How the worker runs.** The `pa-worker` task / unit runs the launcher (`windows/pa-launch.ps1`,`n  `linux/pa-launch.sh`), which starts the supervisor `PA_RUNTIME` names: `node src/supervisor` (Z1,`n  the default) or the compiled `jarvisd supervise` (4.4; JARVISD.md has the switch runbook). It
  owns the dashboard port and proxies to worker generations it forks with
  `PA_SUPERVISED=1`. The supervisor is `src/supervisor/index.ts` (strict TS, plan 4.4; `index.js`
  is a shim), and the compiled jarvisd runs it too: `jarvisd supervise`, whose generations are
  `jarvisd generation` (docs/native/JARVISD.md, "4.4"); a supervised worker binds port 0, reports it over IPC, and answers
  `/healthz` ready only after migrations and its dashboard are up. Keep the supervisor on node
  builtins and never `require` worker code from it — it is the process a deploy must not
  restart. Anything long-lived a worker serves (SSE, WebSocket) must survive being closed and
  reconnected, because a roll closes it.
- **Logs.** The worker logs to stdout, which the Windows task (`conhost --headless`) throws
  away. The supervisor writes its own lines and every generation's output (prefixed
  `[gen N]`) to `<state dir>/logs/supervisor.log`, rotated at 5 MB into `.1`–`.3`: state dir
  is `PA_DATA_DIR`, else `%LOCALAPPDATA%\personal-assistant` on Windows and
  `$XDG_DATA_HOME/personal-assistant` (`~/.local/share/...`) on Linux; `PA_SUPERVISOR_LOG`
  overrides the file. Look there first when a roll fails. A worker logs
  `event loop blocked {ms, running}` for any stall over 1 s (`src/util/lagWatch.js`): a
  blocked loop fails `/healthz`, and the deploy rolls back. Its `running` list is read when
  the loop is free again, so a pass that ended inside the block is not in it. Never call a
  synchronous process (`spawnSync`, `execFileSync`) on a path the worker takes repeatedly: the
  vault's names are listed once, then re-listed every 5 minutes in the background
  (`vault.listAsync`) while the old list answers (`src/config.js`, `inVault`).
- **Deploying (Z4).** `windows/redeploy.ps1` / `linux/redeploy.sh` (called by termhub's
  updater) → `src/supervisor/deploy.js`: verify the pulled commits' SSH signatures
  (`src/supervisor/signing.js`; it only warns until a trusted-signers file exists, and refuses
  after: `docs/native/SIGNED-UPDATES.md`), install, build, roll, watch health 60 s, `rollback`
  if it fails. Its decisions are pure (`plan`, `verdict`, `test/deploy.test.js`); keep them
  so, and keep it on node builtins (it must run when `node_modules` is what broke). The
  scripts keep the old stop/kill/start path for exit codes 3 (no supervisor: bootstrap) and 4
  (the supervisor's own code changed), and rewrite a task/unit still naming `src/worker.js`
  where they may (a task registered elevated refuses). They need not: `node src/worker.js`
  not started by the supervisor becomes the supervisor before loading any worker code
  (`PA_NO_SUPERVISOR=1` runs the bare worker, for debugging).
  A change to `src/supervisor/index.ts` therefore costs one restart gap; keep it rare.
  **One deploy at a time:** `deploy.js` takes a lock file (`<state dir>/deploy.lock`) and the
  supervisor's own deploy lock (`{"cmd":"lock","owner"}`, 15 min ttl) for the roll and the whole
  health watch. A second deploy, or a `roll`/`rollback` from anyone else, is refused with who
  holds it (`deploy.js` exits 5, the scripts say "refused"), and a second roll while one runs is
  refused rather than merged. Two overlapping deploys once dropped each other's rollback target.
- **The deploy test (Z6).** `node src/e2e/deployTest.ts` rolls a supervisor while it hammers
  `/api/version`, holds an `/api/events` stream (reconnecting with `Last-Event-ID`) and a termhub
  terminal, and fails on any failed request, lost/duplicated/out-of-order event, `resync`, or
  dropped terminal. Without flags it runs on a spare port with `test/fixtures/deployWorker.js`
  (no Postgres; `test/deployTest.test.js`); `--live [--deploy [-- <deploy.js args>]]` runs it
  against the stack. What makes events survive a roll: every NOTIFY carries `seq` from
  `pa_event_seq` (sql/035), both generations call it `g<seq>`, and a supervised generation
  starts LISTENing before it says ready (`src/events/bus.js`). Keep those three true. The
  worker itself runs at Normal priority and lowers each child it spawns
  (`src/util/childPriority.js`): a below-normal worker starves whenever other work fills every
  core, and then its `/healthz` does not answer.
- **Single-owner background work (Z2).** Two generations overlap during a roll, so every
  timer, watcher and in-process worker in `src/worker.js` is declared on the scheduler
  (`src/util/scheduler.ts`: `every(...)` for passes, `sched.service(name, start)` for anything
  that returns a stop handle) and runs only while the generation holds the lease
  (`src/util/lease.js`: advisory lock 7300 on a dedicated connection). On `drain` the old
  generation stops its schedulers and releases the lease at once, without waiting for passes
  in flight; each pass run holds its own lock (7301, hashtext(name)), so the new generation
  skips just that pass until the old run ends. Never start a `setInterval`, `fs.watch` or
  worker loop in `worker.js` outside the scheduler — `test/lease.test.js` checks.
- **Views are live, not polled.** A page learns of a change from `GET /api/events` (src/events,
  plan 0.4): row triggers (`sql/034_events_notify.sql`) NOTIFY `pa_events`, and the dashboard's one
  LISTEN connection (opened by the first stream: it serves the dashboard, so a generation opens
  it before it holds the lease) feeds the bus. A new table a view shows gets a trigger there, not a page timer; a payload
  carries ids and states, never content. The same trigger writes each event to `event_outbox`
  (`sql/036`, plan 1.4) under its global number in the writer's transaction: a `g<n>`
  Last-Event-ID the ring no longer holds (a restart, the next generation) is replayed from it, and
  a LISTEN that reconnects backfills from it, so only a client days or 1000 events behind
  resyncs.
- **SQL lives in `src/repo` (plan 1.2).** A module calls `repo.<aggregate>.<method>()` (and
  `repo.withTx(fn)` for a transaction), never `src/db` with a SQL string; each method has a case
  in `test/contract/<aggregate>.contract.js`, run against a real throwaway database by
  `test/repoContract.test.js`. `test/repoBoundary.test.js` lists the modules not converted yet.
- **Two backends (plan 3.1).** `PA_DB=sqlite` swaps Postgres for one SQLite file
  (`src/db/sqlite.js`, schema in `sql-sqlite/`); `createRepos()` then loads
  `src/repo/sqlite/<aggregate>.js`, the twin of each aggregate (same methods, SQLite SQL). A new
  Postgres migration gets its `sql-sqlite/` twin; a new repository method gets its SQLite twin in
  the same commit, or the contract fails on sqlite (`PA_CONTRACT_STRICT=0` reports it as `todo`
  while you work). Contract cases
  and seeds may use plain SQL on `t.db`; on SQLite it goes through `test/contract/_pgish.js`,
  which rewrites `now()`, casts, `= any($n)`, `::vector` and `now() - interval`, nothing more.
- **Secrets:** never in the repo, never in Postgres at all. There are few: GitHub and Microsoft
  365 ride on logins that already exist (`gh`, the claude.ai connectors); Jira prefers an API
  token (`PA_JIRA_API_TOKEN`) and falls back to its connector. A secret resolves real env →
  the OS vault (Credential Manager / Secret Service) → `.env` through `config.secret(name)`; a missing one is `null`,
  shows as "not configured" in `pa doctor`, and code that needs it calls
  `requestSecret({name, purpose, hint})` (`src/secrets`) instead of failing quietly.
- **Times:** store UTC, render local. Every `due_at` the distiller writes is absolute — a row
  that says "Friday" is a bug.
- **Logs:** message bodies are not log material. Log ids, counts, and durations.

## Telemetry and the credit pool (plan 7.5)

Wrap a main hop in `telemetry.span(hop, name, attrs, fn)` (`src/telemetry`), never in a hand-timed log line: it is an
`@opentelemetry/api` span that a local exporter writes to `trace_span`, and it is a no-op in a test process or with
`PA_TELEMETRY=0`, so `fn` must cope with `span === null`. Attributes are ids, names and counts: no prompt, reply or tool
arguments. New hops use the `hop` vocabulary Meter groups by (`voice.turn`, `tool.call`, `factory.cli`, `deploy`, the
factory's `factory.*`). Percentiles are computed in JS over `repo.telemetry.hopDurations`, not in SQL, so SQLite serves them
too. Headless Claude usage is `llm_spend` with backend `cli` (PA) or `claude_session` (the factory, via `POST /api/telemetry`);
`src/claudePool.js` sums both against `PA_CLAUDE_POOL_USD`. A spent pool is a runtime limit like the factory's provider
limits (JOBS-API v1.9), so the API fallback is the one failover policy, `src/dispatch/failover.ts` (`PA_RUNTIME_FAILOVER`,
older name `PA_CLAUDE_POOL_FALLBACK_API`, default off; only when the wait is over `PA_RUNTIME_FAILOVER_MIN_WAIT_MIN`, 30;
always notified). It is applied in one place, `claudePool.route`, called by `dispatch/factory.start`; it fails open. With
the policy on, every job is also submitted with `--failover on`, so the factory may move a job that hits a provider limit. Anything new that runs headless
Claude must record its `total_cost_usd` with one of those two backends, or the pool under-counts.

## Where the store lives

**Linux:** Postgres 16 + pgvector on port 5433, either a dedicated native cluster
(`pg_createcluster 16 pa`, so an existing Postgres on 5432 is untouched) or the
`docker-compose.yml` container — Linux Docker runs Linux images, so compose is the right answer
there. `linux/install.sh` provisions either and records which in `PA_PG_TOOLS` for backups.

### On Windows the store lives in WSL, and WSL will drop it

Docker Desktop on the target machine runs the **Windows** container engine, and there is no
Windows image for Postgres, let alone one with pgvector. So the store is Postgres 16 +
pgvector installed inside the existing WSL Ubuntu distro, on port 5433, reached from Windows
over WSL's localhost forwarding. `docker-compose.yml` stays in the tree as the right answer on
a machine whose Docker runs Linux containers.

The non-obvious part: **WSL terminates a distro once the last `wsl.exe` client exits**, taking
Postgres with it, even though systemd is running it as a service. The symptom is
`ECONNREFUSED 127.0.0.1:5433` at unpredictable intervals, minutes after everything worked. The
fix is the `pa-wsl-keepalive` logon task that `windows/install.ps1` registers (on the Postgres
store only; with `PA_DB=sqlite` it registers none) — one `sleep infinity` holding the distro open. If connections start failing at random, check that
task before suspecting anything in this codebase.

## Reading termhub before writing dispatch

The session substrate is termhub's, and it has already solved most of what dispatch needs:
`POST /api/sessions {cwd, command, title}` to start a Claude session in a directory,
`GET /api/sessions` for state, per-session idle tracking with ntfy escalation, and spoken
announcements driven by reading Claude Code's own transcript. Read `termhub/AGENT.md` before
building anything in that space — in particular the two-tier `front`/`sessiond` split, which
is why sessions survive updates and why the API you want is on `sessiond`.

Claude sessions on other machines are read the same way: termhub serves `~/.claude/projects/`
read-only (`GET /api/claude/transcripts`, `GET /api/claude/transcript?id=`), and
`src/ingest/remoteSessions.js` stores them through the local pass's own parser
(`parseTranscriptAsync`, which yields the event loop) and `toItem` — one parser for both. The
local pass reads only the bytes a transcript gained since its last pass. Their ids and threads are prefixed `<machine>:` so a remote row can never
overwrite a local one. Do not add a second way to fetch them (an SSH copy, a share): termhub is the
one boundary that is already safe to expose.

Typing into a session currently goes over the `/ws/term/*` websocket. Adding
`POST /api/sessions/:id/input` is a unit of work **in termhub**, not a websocket client hidden
in here.

## Definition of done for a unit of work

The root `CLAUDE.md` governs: committed to `main` and pushed, docs corrected in the same
commit, tests green. On top of that, for this tool specifically — if a change alters the schema,
the migration ships in the same commit as the code that reads it, and `pa doctor` is taught to
check whatever new thing can now be misconfigured.
