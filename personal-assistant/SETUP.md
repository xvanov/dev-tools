# Setup — where every value comes from

Click-by-click. Each section ends with the line to paste into `.env`.

`.env` lives at `C:\repos\dev-tools\personal-assistant\.env`. Start it by copying the template:

```powershell
cd C:\repos\dev-tools\personal-assistant
copy .env.example .env
notepad .env
```

Format is `NAME=value` — no quotes, no spaces around the `=`, one per line. It is gitignored.

Microsoft 365, GitHub and Jira need nothing in `.env` at all: each goes through a login that
already exists on the machine.

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
route is in use on its `model` line. Set a key only if you would rather bill the API directly:

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

### Cost

Every captured item over 40 characters gets one model call. `PA_DISTILL_EFFORT=low` is the
default and is the right lever; leave `PA_DISTILL_MODEL` alone. Watch it for the first few days
with `pa doctor` — the "awaiting distillation" number tells you how much is queued.

---

## 3. Embeddings — optional, improves search

Without this, search is full-text only: excellent at names, ticket ids and `GridHelpers`,
weaker when you phrase a query differently from the message you are looking for.

The repo-root `.env` already has `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` (shared with
`summarize-recording`), but that resource currently has **no embedding deployment** — `pa doctor`
reports `endpoint returned 404 for deployment "text-embedding-3-small"`. Two ways to fix it:

**a. Point at a deployment you already have**

1. Open **<https://ai.azure.com>**, sign in, and select the project matching the endpoint in
   your repo-root `.env`.
2. Left sidebar → **Deployments** (older portals: **Model deployments**).
3. Look for a model whose name contains `embedding`. Copy its **deployment name** — that is the
   name *you* gave it, which is often not the model name.
4. Put that in `.env`:

```
PA_EMBED_DEPLOYMENT=<the deployment name you copied>
```

**b. Deploy one**

Same page → **+ Deploy model** → **Deploy base model** → search `text-embedding-3-small` →
**Confirm**. Keep the default deployment name and you can leave `.env` as it is.

If the endpoint in the repo root is not the right one, set these here instead — values from
**Azure AI Foundry → your project → Overview → Endpoints and keys**:

```
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_API_KEY=<key>
```

Skipping this entirely is a legitimate choice. Nothing breaks.

---

## 4. Everything else

These have working defaults and need no accounts:

| Variable | Default | Change it if |
|---|---|---|
| `PA_DATABASE_URL` | `postgres://pa:pa@127.0.0.1:5433/pa` | never, unless you moved the database |
| `PA_TERMHUB_URL` | `http://127.0.0.1:7000` | termhub runs on a different port |
| `PA_REPOS_ROOT` | `C:\repos` | your repos live elsewhere |
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
| `postgres ... ECONNREFUSED` | WSL dropped the distro. `Start-ScheduledTask pa-wsl-keepalive`. |
| `microsoft 365 — ... /mcp` | step 1 not finished, the connector sign-in expired, or IT has not assigned you |
| `anthropic — not set` | step 2 not done |
| `embeddings — endpoint returned 404` | step 3: wrong or missing deployment name |
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
