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
every run (`run isolation`). (`PA_SANDBOX=on`, the factory's OS sandbox for plan sessions, was removed with the factory, D32.)

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
`test/memoryui.test.js` fails if one appears. The Build page (`/factory`) is the same: its
writes (Stop, Reply, Send, New run) are POSTs under the same guards (`src/dashboard/buildBoard.ts`), and what an agent wrote (task, notes, tool arguments) is
data: the page sets it with `textContent` only (`test/buildBoard.test.js`).

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

**The PA chat acts on routine things unasked, and behind a permission prompt for the rest** (D33:
prompts for routine actions blocked work — "it should not ask me for this"). By default (`PA_CHAT_ENGINE=sdk`) it is a
Claude Agent SDK session inside the worker (below, "On the Agent SDK engine"); with
`PA_CHAT_ENGINE=terminal`, `pa chat` starts one Claude Code session in
termhub. Either way it is homed in `<dataDir>/pa-home` (`src/chat/`), and reads other people's messages all day. The rest of this paragraph is the terminal engine's start-up; the settings and lists apply to both.
It is started *without* `--dangerously-skip-permissions` and *with* `--permission-mode default`; its
`settings.json` sets `defaultMode: "default"` and `disableBypassPermissionsMode: "disable"` (a user-level
`auto` or `acceptEdits` cannot apply), and `verifyClaudeHome` reads the settings back — including a
`settings.local.json` that would outrank them — before the session starts, refusing it otherwise. It
reads through MCP tools (plus the built-in reads and read-only shell commands below): the read MCP tools, and the read-only `pa` verbs as the MCP tool `pa`
(server `pa-chat`, `--mcp-config pa-home/pa-chat.mcp.json`, `PA_MCP_CHAT_TOOLS=1`). No `pa` shell
command is allowed — a Bash prefix rule cannot tell `pa memory` from `pa memory run` — so every one,
`pa propose` included, asks. The chat-only MCP tool `task_add` (a task the user explicitly asked for;
reversible) runs unasked. Its structured tools (`src/mcp/chatTools.js`, chat-only like `pa`): the reads
(`CHAT_READ_TOOLS`: board, card, sessions, build_runs, build_run, card_plan_propose, …) are allowed
(`card_plan_propose` only stores a proposal and changes no card); the routine actions
(`CHAT_AUTO_TOOLS`: session_start, build_start, build_set_idle, build_reply, build_send, build_stop,
card_edit, card_build_settings, card_plan_apply, profile_set, agent_settings_set) are allowed too and
audited (policy rule `chat-actions-allow`, D33); `CHAT_ASK_TOOLS` (profile_delete, profile_reset) are on
no allow list, so every call asks, and `verifyClaudeHome` refuses a home whose allow list names one or
the whole server. A call tagged merge / push_main / secret_reveal asks whatever the tool (`chat-sensitive-ask`).
Also unasked (D33): ToolSearch; Read/Grep/Glob inside the read roots (pa-home, the PA's data dir —
worktrees, build-runs, build-reports, logs —, the repos root and local `PA_MACHINES` repos roots) and
never on a secret-looking path (`.env*`, `.ssh`, `.aws`, `.azure`, `.config/gh`, `.npmrc`,
`.git-credentials`, keys, `*credential*`/`*secret*`/`*token*`, the PA's env backups and store; Grep
never across the data dir's top); and a Bash command `src/policy/readOnly.ts` proves only reads (every
`&&`/`||`/`;`/`|` segment one of cd, pwd, ls, cat, head, tail, wc, grep, rg, find without -exec/-delete,
git status|log|diff|show|branch (list)|rev-parse|rev-list|ls-files|blame|remote -v|worktree list|stash
list|cherry, gh pr view|list|checks|diff, gh run list|view|watch, gh issue view|list, gh repo view; no
`>`/`>>` but `2>/dev/null`/`2>&1`, no `$`, backticks, `<`, subshells or env-var prefixes; tag
`read_only`, rule `chat-readonly-bash-allow`). The path and shell checks are `src/chat/toolGate.ts`,
shared by both engines: the SDK hook calls it in-process, the terminal chat through a PreToolUse command
hook in its settings.json (`src/chat/toolHook.js`, which exits at once under the SDK). Everything else
asks as before. The actions are the dispatch paths themselves (`dispatch.start`, then `src/build`),
never a second implementation. Its CLAUDE.md is rewritten from code on every start — change it in
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
and keep "no action answered here" at 0. Since D31 the work stack sets `PA_FAST_ROUTER=decision`
(`src/chat/decisionRouter.ts`): Microsoft-Decision-1 on Azure answers four fixed questions (route,
tool, effort, acts_outside) and only `route` decides; its option descriptions are the router's whole
prompt, so keep them in step with `ROUTER_SYSTEM` and re-run `pa eval router --router decision`
after changing them. It never reads the turn aloud and has no tools; the guards above still apply.
Changing the answerer's prompt (`ANSWER_RULES`) or the
snapshot's format: run `pa eval answerer` and `pa eval router`. The eval sets
(`src/eval/router-cases.json`, `src/eval/answerer-cases.json`) are public: people, companies and
meeting titles in them are placeholders only.

**The turn log is the record of what Jarvis heard and answered** (`src/chat/turnLog.ts`, table
`turn_log`): `runTurn` opens a voice turn at its decision (words, snapshot, last two turns, route, p,
signals) and finishes it when done speaking; `deps.handoff(text, { turn })` carries the row to the SDK
chat, whose `send({ turn })`, final text blocks, `tool_use` names and `result` complete it. Typed
messages and doorbells open their own rows. It never throws into a caller and never makes a turn wait
on the store: keep it that way. It holds real words and snapshots, so `pa turns --eval` output is for
review and must be anonymized before anything joins the public eval sets. The test runner sets
`PA_TURN_LOG=off`; `test/turnLog.test.js` turns it on for its own store.

**The voice page hears the room; nothing it hears leaves the browser until a request is made.** The
wake word ("hey jarvis", openWakeWord) and Silero VAD run in the page on onnxruntime-web
(`talk.voice.js`); only an utterance after the wake word (or with the wake word off, hands-free or
push-to-talk) is sent, to the PA's own `/api/talk/transcribe` and `/api/talk/endpoint`. Keep the
wake word client-side. The local voice service (`voice/server.py`, 127.0.0.1:47830) is loopback only
and refuses any request with an `Origin` header: browsers reach it only through the PA's X-PA-guarded
proxy (`/api/talk/tts`, `/api/talk/endpoint`, `/api/talk/warm`). `/talk/models/` serves a fixed list
of file names (`MODEL_FILES`), never a path. The page listens and speaks only while Ask is the view in
front: in the one-tab shell it stays loaded behind Plan, Build, Run, Meter and Map, and `nav.js`'s
`jarvis:view` (an event here, a `postMessage` to frames) makes it stop the mic and only caption
replies until Ask is back. A tab in the background counts as not in front too (desktop as well as
phone): Ask open in its own tab stops the mic when you switch to another tab and picks it up when
you come back. `askInFront` reads the shell's DOM first (its frame's `.on`, the page's `jx-away`) and
`followFront` re-checks every 2 s, so a shell too old to announce views (a long-lived Run tab) is
still followed. A turn the INBOX doorbell started (`nudgeText`) is captioned, never spoken, wherever
you are: Jarvis speaks to answer you, not to read a digest out (`quietTurn`; `test/talk.test.js` keeps
its pattern in step with `src/notify/chat.ts`). `src/dashboard/voiceCapture.js` and `micWorklet.js` are
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
with `permissionMode: 'default'`. A PreToolUse hook puts every call through `src/policy`, then
`src/chat/toolGate.ts` (a deny refuses; a routine action runs only on an explicit policy allow;
profile_delete, profile_reset and a call tagged merge/push_main/secret_reveal ask, whatever a rule or
settings file says; no policy: actions ask). For a call that asks, `canUseTool` then waits for the
same two surfaces through the same endpoint: an answer must name the pending call's `tool_use` id, goes
through `policy.enforce` with its channel (a `STEPUP_REQUIRED` is a 403 carrying `needsStepUp` and
`approvalId`, and the prompt keeps waiting; after enforce passes, `policy.consumeStepUp` spends the
passkey grant before the call is released), and allows that one call only (no `updatedPermissions`, i.e.
never "don't ask again"). No answer within `PA_CHAT_APPROVAL_TIMEOUT_MS` is a deny, audited on channel
`timeout`. A prompt for anything else (a `pa` shell verb, an edit, `remember`) gets a generic "allow
once" card on the same surfaces, showing the call's whole input (`genericDetail`: the exact command or
diff, never the model's description; a cut says how much is left out). Voice may answer one only when
that input can be heard whole and the policy does not bar voice (never an edit); otherwise a spoken yes
is a 403. A call that runs unasked never reaches `canUseTool`, so Talk never asks a spoken yes for it.
A policy allow for Read/Grep/Glob holds inside the read roots and off secret paths only (`toolGate.readAllowed`). The SDK's environment drops
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
The defaults are the allow/ask split above (`test/policy.test.js` pins them to `CHAT_READ_TOOLS`,
`CHAT_AUTO_TOOLS` and `CHAT_ASK_TOOLS`; `test/readOnly.test.js` the shell and path rules): `ask` means the host owns the prompt (Claude Code), the MCP
server still runs the call. It is applied in the MCP server's `handle` (every tool), in `answerPermission`
(a chat approval, with the channel it came from: dashboard or voice) . A locked
rule denies the voice channel anything tagged `merge`, `push_main` or `secret_reveal` and no override
can loosen it; do not add a path that approves those from voice. With PA_PASSKEYS=on, `enforce` also refuses (`STEPUP_REQUIRED`, rule `stepup-required`) a
non-voice approval tagged merge / push_main / secret_reveal until a passkey grant exists for its
`subject` (src/auth/stepup.js); the policy only looks at the grant, and `consumeStepUp` spends it right
after `enforce` passes: a new caller that runs such an approval must do both.
Each decision is a row of `audit_log` (`src/repo/audit.js`), hash-chained; arguments are stored as a
digest only. `pa audit verify` recomputes the chain, `pa audit tail` lists it, `pa audit check <tool>`
dry-runs the policy. Adding a tool: add it to the default policy (an unlisted tool asks).

**Talk is audio in, audio out, and a spoken yes counts only while awake.** No buttons on `/talk`: the
click path is the dashboard. Jarvis speaks the question the server wrote from the call's structured
input (`transcript.askTool`: "Start a Claude Code agent to fix the export. Shall I?"), and the next utterance answers it under `createVoiceAsk` (`talk.core.js`, tested):
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
**A card names its subject.** The distiller's message carries the four items before it in its
thread (`sources.threadBefore`, "EARLIER IN THIS THREAD", context only), and its prompt says to name
what "the issue" or "it" is from them: a card made from "I'm looking into it" alone read
"Investigate the issue raised in the chat". The prompt version stays `distill-v1` (bumping it
re-distills every item); the chat's How to talk also explains a vague title from its details.
**One live debrief per episode:** a newer debrief supersedes the older ones (`supersedeOlder`,
`meeting_debrief.superseded_by`, sql/044 and sql-sqlite/016): every list query filters
`superseded_by is null`. Items the newer one restates (its `skipped` says "already on your list as
#N" or the update is already made) are adopted into it; the rest are undone with `undo`. It never
deletes transcript or audio — that is `discard`. A rewrite of the same transcript retires the old
row's `content_hash` (`retireHash`) so the old row's `applied` is not overwritten. An episode
re-matched to another calendar event is debriefed again (`awaitingDebrief` compares
`event_external_id`). Do not add a debrief list that skips the `superseded_by` filter.

**An imported meeting is an episode the live capture must never touch.** `src/meetings/import.ts`
(`pa meeting import`, `POST /api/debriefs/import`) stores a recording or transcript you were not in
as an `audio_episode` with `state = 'imported'`, `stream = 'loopback'` (so it reads as "Them:") and
no audio. `repo.audio.continuing` and `supersedeWithin` skip `imported` rows — without that, a live
episode covering the same hour would continue the import and overwrite it, or mark it superseded as
a "leftover" — and `awaitingDebrief` needs a mic stream, so only the import itself debriefs it.
`debrief` reads `state = 'imported'` as "the engineer was not there": the prompt says so and a model
verdict of `others_present: false` (a webinar looks like "a video playing") is ignored, never
`discard`. Keep that: discarding deletes the transcript. Chunks are cut under `audioDir/import-*`
and uploads land in `audioDir/import-uploads`, neither in `mic/` or `loopback/`, so audio ingest
never reads them; both are deleted when the import ends.

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
so any change can be undone unless the row moved since. `editCard` (`pa card edit`, the chat's `card_edit`,
the dashboard's Edit) changes a card's title, details, due date, project or notes in place and writes a
same-status ledger row (`before.edit` holds the replaced values; `ledger.undo` refuses such a row). It also stamps
`touched_at`, so re-distillation keeps the card as edited, and `keep.plan` matches a re-extraction of the
original wording to it through that row (`orig_summary`) instead of adding a duplicate.

Several card changes at once are a **card plan** (`src/cardplans.ts`; tables `card_plan` and `card_plan_item`, sql/045 and
sql-sqlite/017; repo aggregate `cardPlans`): `propose` validates every item (cards exist and are open, dates read, project
known; all problems come back together) and stores it without touching a card; `apply` runs the ticked items in order as
`you` (`editCard`; the ledger close plus its duplicate group, as `pa done --dismiss`; `request.add`, as `pa task add`), each
ledger reason starting `card plan #N:`, records applied / skipped / failed per item, goes on past a failure, and never runs an
applied item again (an item is claimed `pending` to `running` first). Item numbers are 1-based as shown. One yes: the
dashboard's "Proposed card changes" card (`cardplan.client.js`, GET `/api/cardplans`, POST `/api/cardplans/:id/apply|discard`),
`pa cardplan list|show|apply [--skip 1,3]|discard`, or the chat's `card_plan_apply`, whose approval card and spoken question
name every change (`cardplans.approvalText`, wired in `sdkFeed.canUseTool`). A new plan posts a feed notice. The assistant may close things on its
own (DURABLE.md), but never silently and never without that row. A new closer calls
`transition`; it does not run `update commitment set status`. (The debrief predates this and
keeps its own reversible log in `meeting_debrief.applied`.)

**A page's JSON file is its only source; everything else is drawn from it.** A Jarvis page (`src/pages`,
README "Pages") lives in `<PA_PAGES_DIR>/<slug>.json`, outside the repo (pages hold private plans; this repo is
public, so tests and fixtures use made-up data). The dashboard's `/pages/<slug>` and the exported `<slug>.html`
are drawn by the same `page.client.js` (textContent only, nothing loaded from elsewhere: `test/pages.test.js`);
the claude.ai Artifact is a copy of the export, never edited there. Task status is read from the cards at
render time and never written back into the page. Pages change no card: the routes are read-only, and
`pa page publish` / the `pages` pass reach the network only through `claude -p` with only the Artifact tool (and Read, which it needs).

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

**Build is THE dispatch target (decisions D28, D30; the software factory was removed, D32).**
Every agent the PA starts is one Claude Code agent in Build (`src/build`): `pa do`, the dashboard's Do, the
planner, accepted cards, and the chat's `build_start` and `session_start`. There is no route to pick:
`PA_DISPATCH_VIA`, `PA_ROUTE_CHOOSER`, `--via`, `--machine` and the factory's flags (`--delivery`,
`--pipeline`, `--runtime`, `--kind`, `--done`, `--app`, `--register`, `--mode`) are refused by name.
`dispatch.startSession` (a raw Claude Code session in a worktree) has no production caller and is kept only to seed
the land/drop tests (docs/native/PLAN.md 8.6.3); if anything calls it, it logs and writes an `llm_spend` row of unknown
cost. The older runs (`runs` table; route `claude`, or `factory` for jobs from before D32) are still managed by
`pa review|land|drop`, but a `factory` run has nothing left to show or cancel. A run's end moves its commitment only
through `ledger.transition` and only from `dispatched`. One live run per commitment holds under concurrency: every
run insert goes through `runRow.insertRun`, which re-checks under a transaction-scoped advisory lock.

**A dispatch card carries what the task needs, not my private material.** What a card shows is frozen in the
proposal (`src/dispatch/offer.ts`) and is exactly what starts at accept: the task, the repo (checked when the card
is made, never re-judged at accept) and the model. Nothing is composed from memory pages or message bodies: the
agent reads the card's own words and the repo, and Build's agent prompt (`src/build/agent-prompt.md`) is one file.
Nothing outward happens before the yes.

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
(`src/secrets/migrate.js`). Code reads a
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
again. A scheduled slot missed during downtime runs once, never as a backlog. `build_run` (a
scheduled Build agent) only *starts* the run through `build.start` and returns — never hold the
routine lock for a run's hours — and every way it declines to start (budget spent, its previous run
live, profile gone) is a recorded skip, not a failure; the suggester must never propose it.

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

## Build: one Claude Code agent per task (D30)

Do on a card (and `pa do`, the planner, accepted cards, the chat's start tools) calls `dispatch.start`, which
hands to `src/build`: one interactive Claude Code session in termhub on the subscription, model haiku | sonnet |
opus | fable (a profile or card setting, default sonnet), in a fresh worktree on a new branch when the card names a repo. The agent
prompt is one file, `src/build/agent-prompt.md`; edit it there. The software factory that used to sit beside it was removed in D32 (git history, `4eee22f`).

- Rows: `build_run`, `build_msg` (`src/repo/buildRuns.ts`; the SQLite twin re-exports it, the SQL is portable).
- **Profiles** (`src/build/profiles.ts`, table `build_profile`, `src/repo/buildProfiles.ts`; BUILD-ENRICHMENT.md A): a
  saved, named agent: model, effort, permission mode, prompt (appended to `agent-prompt.md`), tools (MCP set,
  allow/deny rules), subagent definitions, subagent model, caps, default repo. Seeds `chore`, `feature`,
  `research` (read-only, `dontAsk` permission mode), `quick` are written once and never over an edit. A null field falls
  through; per field the order is **this call > the card's `build.card.<id>` > the profile > the defaults**, so a
  run with no profile and no card setting launches exactly as before. Pick one with `build_start profile`,
  `pa do --profile`, the card menu, or let the planner (task kind: investigate/review → research, coding →
  feature, admin → chore; `dispatch.start mode: 'plan'` = research, which is how its eager research runs are
  read-only). Real Claude Code flags only (checked against `claude --help`): `--model` (fable is `claude-fable-5-2`),
  `--effort low|medium|high|xhigh|max`, `--permission-mode` (for any mode but bypass the `--dangerously-skip-permissions` flag is
  dropped, it would override it; `dontAsk` denies everything not read-only and allows the exact `node "<pa.js>" run *`
  command, Bash and PowerShell rules, so the agent can still report. Verified on claude 2.1.327: `plan` ignores an
  allow rule for a command that writes, so it cannot be a research mode; a mid-rule wildcard such as `*pa.js*` is
  refused by the CLI; and termhub's restore keeps a `--permission-mode`),
  `--strict-mcp-config` always plus `--mcp-config <file>` for the profile's `tools.mcp` (servers named in the
  `build.mcp` setting); allow/deny rules go in the run's `--settings` file (`<worktrees>/build-<run>.settings.json`,
  `permissions.allow/deny`), not as flags: rules hold quotes and spaces that do not survive the pwsh command line. The subagent model has no flag: env
  `CLAUDE_CODE_SUBAGENT_MODEL`. Subagents are `.claude/agents/<name>.md` in the run's folder, listed in the
  worktree's `info/exclude` so the agent never commits them; the repo's own agent of the same name wins. The profile
  is on `build_run` and in `summary.json`.
- **Agent settings and parity** (`src/agentSettings.ts`; BUILD-ENRICHMENT.md B): the dashboard's **Agents** page (`/agents`, linked from
  Build) edits every Build profile (model, effort, permission mode, subagent model, caps, repo, the prompt appended to the read-only
  base prompt, MCP servers, allow/deny rules, subagents; reset a built-in one to what ships; a built-in one cannot be deleted, the planner names it), the PA chat's model and each worker
  pass's model. Profiles live in `build_profile`; the chat and pass models are overrides in the `agent.settings` setting
  (`{chatModel, passModels, summaryEvery, summaryLines}`), and **env stays the default**: `src/models.ts` `refresh()` reads the setting at most every 10 s (the
  worker before each pass, `pa` before each command that can pick a model, `NO_MODELS` in `src/cli/index.ts` lists the ones that
  skip it: `pa run` is the agent's own hot path and the read costs ~1.7 s when it is the first thing to open the store) and writes it into the config field the pass reads, keeping the env/default value
  so clearing an override restores it. Every value is shown with its source (store | env | default). **Parity rule:** every
  dashboard write has a chat tool and a `pa` verb doing the same through shared code, reads allowed and writes asking
  (`profile_list|get|set|delete|reset`, `agent_settings_get|set`; `pa profile list|get|set|delete|reset`, `pa agents get|set`);
  `test/dashboardParity.test.js` lists the dashboard's mutating routes from the source and fails on one with no tool or verb in
  `test/dashboardParity.map.js` (an explicit exception with its reason, or a gap; `maxGaps` only goes down). A new dashboard write
  means a new entry there, with its tool and verb.
- Agent verbs, run id from `$JARVIS_RUN_ID`: `pa run note "<text>"`, `pa run ask "<question>"` (blocks up to
  `PA_BUILD_ASK_TIMEOUT_MIN`, default 240, prints the answer), `pa run done --result "<PR url | report path | one line>"`.
- **Decision queue** (BUILD-ENRICHMENT D; `src/build/decisions.ts`, `messages.ts`): a structured ask batches several
  decisions into one: `pa run ask --q "<question>" [--option a --option b] --q "<next>" …` (each `--option` belongs to the
  `--q` before it; `parseArgs` now returns `ordered` for that) or `pa run ask --json <file>`
  (`{"questions":[{"id","text","options":[],"allowFree":true}]}`, at most 12; ids default to q1..). It is still one `build_msg`
  ask (body `{"decisions":1,"questions":[...]}`, answer `{"answers":{id:text},"text"?}`; no new table), so a plain ask is
  untouched. It blocks like a plain ask and prints one line per question plus a `JSON:` line; unanswered questions say so. On
  timeout the ask is closed (it leaves Needs you) and the agent reads "NO ANSWER YET … carry on with the safest default or
  stop". `needs_you` carries kind `decisions` with `questions`; the Build board shows one Decisions card per run (click an
  option or type, one Submit, drafts survive redraws), and the Plan page shows the same open asks (plain ones too) as a
  "Build agents need you" card (`buildasks.client.js`, `GET /api/build/needs`, same reply route). Answer from anywhere through the same `reply`: the board's
  `POST /api/build/<id>/reply {answers, ask?}`, the chat's `build_reply {run, answers? text?}` (the chat maps what the user
  said, spoken too, onto the question ids; a lone question takes plain `text`), `pa run reply <id> --answer q1=… --answer q2=…`.
  Option-only questions (`allowFree: false`) refuse anything else. The push is the usual `notify` (kind info, priority
  **normal**: it spends the interrupt budget and respects quiet hours; the board and nav pill show it regardless). **Waiting is
  free:** `build_run.waiting_ms`/`waiting_since` (sql/048, sql-sqlite/020) accumulate the time in `waiting`, and `overCap`
  in `track.ts` takes it off the wall-clock cap; a `waiting` run is never idle.
- Jarvis verbs: `pa run list|status|stop <id>`, `pa run reply <id> "<text>"` (answers the open ask),
  `pa run send <id> "<text>"` (typed into the session). Chat tools: `build_runs`, `build_run`, `build_reply`,
  `build_send`, `build_stop`, `build_start` (`profile`, `model`, `effort`, `second_opinion`), `build_set_idle`. An open ask is a "needs you" notice and a lane on Build (`/factory`).
- A run whose session vanishes without `pa run done` is failed at once, with an urgent notice (heartbeat).
- **Heartbeat** (`src/build/heartbeat.ts`, worker pass `build-heartbeat`, every 10 s): stat calls on the
  transcript and subagent transcripts, one sessiond list call (is the session alive, is the PTY busy), the
  newest `build_msg`; no transcript parsing. Silent past the run's own `idle_after_s` (default 240,
  `PA_BUILD_IDLE_AFTER_S`; `build_start idle_after_s`, the card menu, `build_set_idle`,
  `pa run idle <id> <s>`) while `running` makes it `idle`: an urgent notice, and `build_run.activity`
  (last tool call, last output line, idle duration) in `build_runs.needs_you` and on the board. Any sign
  of life puts it back to `running`. A `waiting` run (open `pa run ask`) is never idle.
- **Tool summaries** (`src/build/summaries.ts`; BUILD-ENRICHMENT.md C): every N new tool calls of a live run (`summaryEvery`,
  default 5, `PA_SUMMARY_EVERY`) the new calls from the track view go to the `summary` pass's cheap model (`PA_SUMMARY_MODEL`,
  default `azure/pa`, the same default as blocks and dedupe, so a stack without Azure set up fails it gracefully (shared
  backoff, one log line per distinct error per hour) and wants `PA_SUMMARY_MODEL` or `/agents` pointed at a model it has;
  overridable per pass on `/agents`) and come back as one plain sentence, stored as a `build_msg` row of
  kind `summary` (dir `jarvis`, body `{upto, text}`: the cursor travels with the text, so there is no table and a restart
  loses nothing; heartbeat ignores them, board and chat show them apart from the conversation). The card shows the newest
  `summaryLines` (default 3); `build_run` returns them with `context`, so Talk can answer "what is run 42 doing?". Cost guards,
  all in `maybe()`: nothing new or under N calls is no call; a finished run flushes the rest once; at most
  `PA_SUMMARY_MAX_PER_RUN` (40) per run; one call in flight per run; the newest 40 calls per batch; 30 s timeout; exponential
  backoff after a failure (shared by all runs: the model is one dependency); purpose `build-summary` is in `PA_BUDGET_DISCRETIONARY`, so the daily cap pauses it first;
  `PA_SUMMARY=0` stops it. `track.tick` never awaits it for a live run and it never throws. Spend lands in `llm_spend`.
  `summaryEvery` and `summaryLines` are edited like the models: `/agents`, `agent_settings_set` (`summary_every`,
  `summary_lines`), `pa agents set --summary-every n --summary-lines n`.
- **Context meter and live status:** the track view carries `context {tokens, window, pct}` (tokens in context at the newest
  assistant message; the window from `WINDOWS` in `track.ts`: `[1m]` ids and the Claude 5 family 1M, else 200k, raised when the transcript has
  already passed it, so a wrong row cannot show over 100%). `GET /api/build/status` (cached 5 s) feeds the pill beside the »
  toggle on every page (`nav.js`: the shell polls, frames get it by postMessage): running, need you, Build spend today;
  zero parts hidden. Spend there is notional (runs started today); Jarvis's own model spend today is in its tooltip.
- **Kept runs** (`src/build/track.ts archive`, when a run ends, stops or fails): Claude Code prunes
  `~/.claude/projects` (`cleanupPeriodDays`), so `<dataDir>/build-runs/run-<id>/` holds a copy:
  `<session>.jsonl`, `<session>/subagents/`, `messages.json` (the build_msg rows) and `summary.json`
  (run, card, task, model, profile, effort, permission_mode, repo, branch, base_sha, state, result, error, started/ended, elapsed_s, tokens, cost_usd,
  agents, tool_calls by name, errors). `pa run export [--since <date>]` prints every summary.json as JSONL.
  `base_sha` (also `build_run.base_sha`, sql/050 + sql-sqlite/022) is the commit the worktree started from, set when it is made.
- **Profile eval** (`src/eval/buildEval.ts`, `src/cli/evalBuild.ts`; BUILD-ENRICHMENT.md F): `pa eval build --profiles a,b[,model:effort]
  [--runs ids|--since d|--last N] [--budget-usd X] [--wall-min m] [--no-link-deps] [--yes]` replays finished runs (done, with a PR or report,
  repo still a checkout, base commit known: `base_sha`, else the merge-base of an unmerged branch that still exists, else skipped with the
  reason) on other profiles: a detached throwaway worktree at the base under the worktrees root (`eval-<id>-<n>`), `claude -p
  --output-format json` with the profile's `launchFlags` and a per-trial `--settings` file, scored by the repo's tests (the `build.eval`
  setting `{"tests": {"<path or folder>": "<cmd>"}}`, else `npm test -- --changed` for dev-tools, else `npm test` where package.json is),
  the diff against the base, cost/tokens/turns from claude's JSON, wall time and the original PR's merged/closed state (`gh`, best effort),
  then removed. **No flag launches anything: without `--yes` (or with `--dry-run`) it prints the trial plan and an estimate.** Guards, layered
  because a replay must never touch a real branch or PR: no branch is made; every remote's push URL in the worktree is the dead address
  (`dispatch/remote.ts blockPush`, read back); the session env has no GitHub/GitLab tokens or ssh agent and an empty gh config (`noPushEnv`);
  the settings file denies `git push` and `gh pr` for both shells on top of the profile's own rules (verified to hold under
  `--permission-mode bypassPermissions`: the harness refuses the call, it is not the model's choice); the prompt says no pushing. Dependency
  changes (`npm|pnpm|yarn|bun install/ci/add/...`, edits under `node_modules`) are denied too, because the junctions below write through. Spend: budget
  (`--budget-usd`, `PA_BUILD_EVAL_BUDGET_USD`, default $10) is checked before every trial against its projected cost (median of that profile's
  finished trials, else the original run's cost, bounded by the profile cap), and claude's own `--max-budget-usd` is min(profile cap, budget
  left). A code task passes with a non-empty diff and passing tests (no test command: unscored, `passed` null); a report on being delivered, so
  read the reports in the JSONL. Baseline: the repo's tests run once per base commit in the replay tree before the agent starts (no model,
  cached for the launch), and `tests` is `pass`, `fixed` (base failed, now passes: counts as pass), `regression` (base passed, now fails),
  `still-failing` (failed before and after: unscored) or plain `fail`/`timeout` when the baseline timed out. `node_modules` of the
  checkout (root and one level down) are junctioned into the replay so tests can run (`--no-link-deps` turns that off and the tests then
  usually fail to start). Results: `build_eval_trial` and
  `<dataDir>/build-eval/<id>.jsonl` (with each agent's last message); `pa eval build --report [--eval id] [-v]`, the chat's `eval_build_report`
  (a read, allowed) and the Build board sidebar's table (`GET /api/build/eval`). Launching is CLI-only on purpose (no mutating route, so no
  parity exception): it spends the subscription. `test/buildEval.test.js` keeps real git and worktrees for the first trial of a launch
  (guards, base commit, cleanup) and stands in a plain folder plus an in-process `git` for the scoring/budget scenarios: every git
  step is a process, so the all-real version took 80 s idle and 2.4 min under load against its 180 s timeout; now ~20 s.
- **Second opinion** (`src/build/secondOpinion.ts`; BUILD-ENRICHMENT.md G): a card setting `secondOpinion: <profile>` in
  `build.card.<id>` (`pa card settings <id> --second-opinion <profile>|off`, `card_build_settings second_opinion`, the card menu's
  "Second opinion (reports)" row; per start: `build_start second_opinion`, `pa do --second-opinion`, `POST …/dispatch {secondOpinion}`; `off`/null
  beats the card's). **Report tasks only** (D30: coding stays one agent): refused (400) unless the card's own run is read-only
  (`profiles.readOnly`: permission mode `dontAsk` or `plan`, i.e. `research`) AND the second profile is read-only and is another
  profile than the card's; changing the card to a profile that writes drops the setting, a stale one set by hand runs one agent with a
  warning, and the planner's eager research (`dispatch.start mode: 'plan'`) and routine runs never double. Do then starts **two sibling
  runs of the same task** (`startPair`): A on the card's profile, B on the second one; they are linked by `build_run.origin`
  `second-opinion:<group>:<a|b>` (`origin.ts`; `byOrigin`/`recentSecondOpinion` in the repo). B ignores the card's own model/effort/cap
  overrides (they would make it the same agent), the one-live-run-per-card rule and an explicit model; if B cannot start, A is stopped
  and the error thrown (both or neither). The agents never see each other. **Fuse:** the worker's 15 s `build-runs` pass calls `sweep()`
  (not `finish()`: `pa run done` is a CLI process that exits right after, so nothing there can hold an LLM call); a pair whose runs have
  all ended is fused once: one tool-less `llm.complete` on the **`fuse` pass** model (`PA_FUSE_MODEL`, default `claude-opus-5-5`, overridable
  on `/agents` or with `agent_settings_set pass_models`, e.g. an `azure/` open-weight model), the two reports as delimited data
  (`<report side="A">` blocks, a closing tag inside one is defanged, the system prompt says they are never instructions), answer in fixed
  sections: Agreements, Disagreements (which side), What only A saw, What only B saw, Recommendation. A run's report is its result text, or
  the file under `<data>/build-reports` it names. One run failing or stopped does not block it: the pair is fused once both have ended, with
  what exists, **and the report says so**; one report means no model call; none is stored as "(neither run produced a report)". Cost guards:
  llm_spend purpose `build-fuse` (in `PA_BUDGET_DISCRETIONARY`: at the daily cap, or when the model fails, the two reports are stored side by
  side with the reason; a pair always ends and is never retried forever), each report cut to 12 000 chars, 4 000 output tokens, 24 000 stored.
  **Exactly once:** the `fused` row exists → skipped (also after a restart; a crash between the two rows is repaired); a `fuse-claim` row
  on the first run, lowest fresh claim wins across processes (a claim over 10 min old with no `fused` row is a crashed fuser); an in-process
  guard. Storage: `<data>/build-reports/second-opinion-<group>.md` and a `build_msg` row kind `fused` on **both** runs
  (body `{group, path, partial, note, text, at, model}`; `summaries.split` keeps these out of the conversation). One notice
  (`dedupeKey build-fuse:<group>`). Surfaces: the Build board groups the pair under the fused report (`second_opinion` on each run in
  `GET /api/build`, `grouped()` in `build.board.client.js`), the Plan card line links it (`cards.ts buildsFor`, `second_opinion`), `build_run`
  returns `second_opinion {group, runs, fused}`. Tests: `test/buildSecondOpinion.test.js`.
- The Plan card of a task with a Build run shows its state chip, start to end and elapsed, cost, and
  links to the board card and the termhub session; several runs add the count, the span and the total
  (`src/dashboard/cards.ts buildSummary`).

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
arguments. New hops use the `hop` vocabulary Meter groups by (`voice.turn`, `tool.call`, `deploy`). Percentiles are computed in JS over `repo.telemetry.hopDurations`, not in SQL, so SQLite serves them
too. Headless Claude usage is `llm_spend` with backend `cli` (rows of backend `claude_session` are the removed factory's, history); `src/claudePool.ts` sums both against `PA_CLAUDE_POOL_USD`. A spent pool is shown on Meter and nothing is rerouted (the factory's runtime failover was removed, D32). Anything new that runs headless
Claude must record its `total_cost_usd` with the `cli` backend, or the pool under-counts.

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
