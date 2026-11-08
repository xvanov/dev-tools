# Setup — where every value comes from

Click-by-click. Each section ends with the line to paste into `.env`.

`.env` lives at `C:\repos\dev-tools\personal-assistant\.env`. Start it by copying the template:

```powershell
cd C:\repos\dev-tools\personal-assistant
copy .env.example .env
notepad .env
```

On Linux it is `personal-assistant/.env` in your clone, and `linux/install.sh` writes it from the
template (mode 600); the commands below are the same with `/` for `\` (`node bin/pa.js doctor`).

Format is `NAME=value` — no quotes, no spaces around the `=`, one per line. It is gitignored.

Microsoft 365, GitHub and Jira need nothing in `.env` at all: each goes through a login that
already exists on the machine. Jira works better with an API token, and that does not go in
`.env` either — the dashboard asks for it under **Needs a credential or sign-in** and stores it in the OS keyring:
Windows Credential Manager, or the Secret Service on Linux (or `pa secret set PA_JIRA_API_TOKEN`).
A Linux box with no keyring (`pa doctor`: `secret store … DEGRADED`) stores it in `.env` instead.

---

## 1. Microsoft 365 — the claude.ai connector

There is no app registration. Mail, calendar and Teams are read through the **claude.ai
Microsoft 365 connector**, which a headless `claude -p` can call with your own sign-in. What it
may read is decided by IT on the connector's enterprise app (*M365 MCP Client for Claude*);
until IT assigns you to it, sign-in fails with `AADSTS50105`.

1. In Claude Code, type `/mcp`.
2. Pick **claude.ai Microsoft 365** → **Authenticate**, and finish the browser sign-in.
3. Back in a terminal:

```powershell
node bin\pa.js login     # calls the connector's get_me and records who "me" is
node bin\pa.js doctor    # the "microsoft 365" line lists how many scopes IT granted
```

Optional knobs, all with working defaults:

```
PA_TEAMS_CHANNELS=mentions        # channel posts kept only when they name you; or all / off
PA_M365_POLL_SECONDS=180          # mail + Teams
PA_M365_CALENDAR_POLL_SECONDS=900
```

### What this does *not* get you

- **Teams meeting transcripts.** The connector is granted the scope, but the tenant switches
  Graph transcript access off. Meetings are recorded locally instead, which needs nobody's
  permission.
- **Sending.** The grant is read-only. Approved drafts open prefilled in Teams or Outlook, and
  you press Send there.

---

## 2. Anthropic — `ANTHROPIC_API_KEY` (optional)

The model is what turns messages into commitments and writes reply drafts. **You can skip this
step.** With no key, every model call runs through a headless `claude -p` on your own Claude
Code login (see `src/llm.js`) — no separate billing, nothing to create. `pa doctor` shows which
route each pass uses on its `model · <pass>` lines. Set a key only if you would rather bill the API directly.

**pa on a subscription of its own.** If you switch Claude subscriptions, pin pa to one so its
connectors do not vanish with the switch. Give it a Claude Code config folder of its own and sign
that folder in once:

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-pa"
claude          # then /login with pa's account, and /mcp → claude.ai Microsoft 365
```

Then set `PA_CLAUDE_CONFIG_DIR=~/.claude-pa` in `.env` and restart the worker
(`Stop-ScheduledTask pa-worker; Start-ScheduledTask pa-worker`, or on Linux
`systemctl --user restart pa-worker`). Only pa's own `claude -p`
calls use it: agent runs dispatched through termhub keep the login of the machine they run on,
and the PA chat session runs in termhub on your default login. `pa doctor` names the account on
its `claude login` line. Connect connectors in a browser signed in to that same account, or
claude.ai answers "Account mismatch".

To bill the API directly instead, set a key:

1. Open **<https://console.anthropic.com/settings/keys>** and sign in. (It may redirect to
   `platform.claude.com` — same place.)
2. Click **Create Key**.
3. Name it `personal-assistant`. Pick your workspace if you are asked.
4. **Copy it immediately.** The key is shown exactly once; close the dialog and you have to
   revoke it and make another. It starts with `sk-ant-`.
5. The account needs a payment method on file or requests fail — **Settings → Billing**.

```
ANTHROPIC_API_KEY=sk-ant-...
```

> This is a real secret. It is in `.env`, which is gitignored — do not paste it into a commit,
> a chat, or a screenshot.

### Other providers

Any pass can run on Azure OpenAI, OpenAI, OpenRouter, DeepSeek or a local OpenAI-compatible
server instead: set its `*_MODEL` variable (or `PA_MODEL` for all of them) to `provider/model`, e.g.
`PA_RECONCILE_MODEL=azure/gpt-5.4`, and give the provider its key with `pa secret set
OPENROUTER_API_KEY` (Azure reuses `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` from step 3).
The README's *Models and providers* has the full list. Two limits: `PA_CONNECTOR_MODEL` stays on
Claude Code (Microsoft 365 and the Jira connector need its logins), and a non-Claude model's cost
is recorded as unknown unless you give its price in `PA_MODEL_PRICES`. Run `pa doctor` after any
change: it prints one line per pass and refuses a pass whose backend cannot do its job.

### Cost

Every captured item over 40 characters (a Teams DM, self-chat note or mention from 6) that may
create tasks gets one model call, on `claude-sonnet-5-5` by default: about $0.02 a call, less
within a pass, which reads the project list from the prompt cache. `PA_DISTILL_EFFORT=low` is the
default and is the right lever; leave `PA_DISTILL_MODEL` alone. Watch it for the first few days
with `pa doctor` — the "awaiting distillation" number tells you how much is queued.

---

## 3. Embeddings and rerank — optional, improve search

Without embeddings, search is full-text only: excellent at names, ticket ids and `GridHelpers`,
weaker when you phrase a query differently from the message you are looking for. Without the
reranker, results keep their fused order and carry no absolute relevance score.

Both live on the Azure AI resource whose endpoint and key are in the repo-root `.env`
(`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, shared with `summarize-recording`).

**Embeddings.** The resource needs an embedding deployment; `text-embedding-3-large` with
`PA_EMBED_DIMENSIONS=1536` fits the `vector(1536)` column. Set its deployment name as
`PA_EMBED_DEPLOYMENT`. To find it: <https://ai.azure.com> → your project → **Deployments** — the
deployment name is the one *you* gave it, often not the model name.

**Rerank.** Deploy `Cohere-rerank-v4.0-fast` (pay per use, about $2 per thousand searches) on the
same resource:

```
az cognitiveservices account deployment create -n <resource> -g <resource-group>   --deployment-name cohere-rerank-v4-fast --model-name Cohere-rerank-v4.0-fast   --model-version 1 --model-format Cohere --sku-name GlobalStandard --sku-capacity 200
```

Capacity is a rate limit, not a price: 1 unit is one request and 1,000 tokens a minute, and one
search sends about 40 documents. At capacity 1 every search after the first in a minute is
throttled. The deployment name defaults to `cohere-rerank-v4-fast` (`PA_RERANK_DEPLOYMENT`);
`PA_RERANK=0` turns reranking off.

`pa doctor` probes both rather than trusting the config: a wrong deployment name looks exactly
like a working one until results quietly get worse.

Skipping this entirely is a legitimate choice. Nothing breaks.

---

## 4. Everything else

These have working defaults and need no accounts:

| Variable | Default | Change it if |
|---|---|---|
| `PA_DATABASE_URL` | `postgres://pa:pa@127.0.0.1:5433/pa` | never, unless you moved the database |
| `PA_TERMHUB_URL` | `http://127.0.0.1:7000` | termhub runs on a different port |
| `PA_REPOS_ROOT` | `C:\repos` (Windows), `~/repos` (Linux) | your repos live elsewhere |
| `PA_PG_TOOLS` | `wsl:Ubuntu` (Windows); set by `linux/install.sh` | the store moved between a native cluster (`native`) and the container (`docker:pa-postgres`) |
| `PA_TEAMS_CACHE_DIR` | the new Teams client's cache (Windows); none (Linux) | you want to try a Teams web cache on Linux (experimental) |
| `PA_CLAUDE_COMMAND` | `claude --dangerously-skip-permissions` | you want dispatched sessions to ask before acting |
| `PA_TRANSCRIBE_PORT` | `47821` | you changed voice-dictation's server port |
| `PA_AUDIO_ENABLED` | `1` | set `0` to disable recording entirely |
| `PA_RETENTION_RAW_DAYS` | `180` | you want raw mail and chat bodies kept for longer or shorter |

---

## 5. Check it

```powershell
node bin\pa.js doctor
```

Every line should read `ok`. What the failures mean:

| Line | Means |
|---|---|
| `postgres ... ECONNREFUSED` | Windows: WSL dropped the distro. `Start-ScheduledTask pa-wsl-keepalive`. Linux: `docker compose up -d` (container) or `sudo systemctl start postgresql@16-pa` (native). |
| `secret store … DEGRADED` (Linux) | no Secret Service: `sudo apt install libsecret-tools` and a running keyring (GNOME Keyring / KWallet). Until then secrets live in `.env`. |
| `sound server … DEGRADED` (Linux) | `pactl` missing: `sudo apt install pulseaudio-utils` (it talks to PipeWire too). |
| `capture units … not installed` (Linux) | `linux/install.sh`, or `PA_AUDIO_ENABLED=0` if this box records nothing. |
| `backup … BROKEN: pg_dump N is older than the server` | Linux: install the matching `postgresql-client-NN`, or `PA_PG_TOOLS=docker:pa-postgres` for the container. |
| dashboard refuses to connect, or a pass runs twice | an old worker outlived a restart: `Stop-ScheduledTask` ends the wrapper, not node. Restart with `Stop-ScheduledTask pa-worker; Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| ? CommandLine -match 'src\\worker\.js' \| % { Stop-Process -Id $_.ProcessId -Force }; Start-ScheduledTask pa-worker`. A second worker waits on a database lock rather than running beside the first. |
| `microsoft 365 — ... /mcp` | step 1 not finished, the connector sign-in expired, or IT has not assigned you |
| `anthropic — not set` | step 2 not done |
| `embeddings — endpoint returned 404` | step 3: wrong or missing deployment name |
| `rerank — endpoint returned 429` | step 3: deployment capacity too low |
| `termhub — ECONNREFUSED` | termhub is not running on this machine |

Then:

```powershell
node bin\pa.js sync      # first real ingest and distillation — takes a few minutes
node bin\pa.js brief
```

And when you want it running by itself:

```powershell
.\windows\install.ps1                      # registers the worker and capture tasks
Start-ScheduledTask pa-worker              # ingest + distil on a timer
Start-ScheduledTask pa-capture-mic         # start recording — your call, and reversible
Start-ScheduledTask pa-capture-loopback
```

On Linux:

```bash
linux/install.sh                                             # the store, the venv, the systemd user units
systemctl --user start pa-worker
systemctl --user start pa-capture@mic pa-capture@loopback    # your call, and reversible
```
