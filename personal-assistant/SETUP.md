# Setup — where every value comes from

Click-by-click. Each section ends with the line to paste into `.env`.

`.env` lives at `C:\repos\dev-tools\personal-assistant\.env`. Start it by copying the template:

```powershell
cd C:\repos\dev-tools\personal-assistant
copy .env.example .env
notepad .env
```

Format is `NAME=value` — no quotes, no spaces around the `=`, one per line. It is gitignored.

Do them in this order. The Microsoft one is first because it is the only one that can be
refused by someone other than you, and everything else is a five-minute job.

---

## 1. Microsoft — `PA_GRAPH_CLIENT_ID` and `PA_GRAPH_TENANT_ID`

**What "Entra" is:** Microsoft renamed Azure Active Directory to *Microsoft Entra ID* in 2023.
It is the thing that holds your work account. "Registering an app" means telling it that a
program on your laptop is allowed to ask you for permission to read your own mail. You are not
installing anything into the company tenant and you are not asking for anyone else's data —
you are creating an identity for a program that then acts strictly as you.

### Step by step

1. Open **<https://entra.microsoft.com>** and sign in with your INNERGY work account.

2. In the left sidebar: **Applications** → **App registrations**.

   *If you cannot see "App registrations", or the page says you do not have access:* your tenant
   restricts who may register applications. Stop here and ask IT for either (a) the ability to
   register an app, or (b) an app registration created for you with the four delegated scopes in
   step 5. Nothing else in this guide depends on it — GitLab, Anthropic and audio capture all
   work without it.

3. Click **+ New registration** at the top.

   - **Name:** `personal-assistant` (only you ever see this)
   - **Supported account types:** *Accounts in this organizational directory only (INNERGY only
     - Single tenant)*
   - **Redirect URI:** leave it empty. Device-code sign-in does not use one.
   - Click **Register**.

4. You land on the app's **Overview** page. Two values you need are right here:

   - **Application (client) ID** → this is `PA_GRAPH_CLIENT_ID`
   - **Directory (tenant) ID** → this is `PA_GRAPH_TENANT_ID`

   Copy both now. They are GUIDs, like `3f9c1b2a-....`. Neither is secret — they identify the
   app, they do not authorise anything.

5. Left sidebar of the app → **Manage** → **API permissions**.

   - Click **+ Add a permission**
   - Choose **Microsoft Graph**
   - Choose **Delegated permissions** — *not* Application permissions. Delegated means "acting
     as the signed-in user". Application permissions would mean "acting as the app, over the
     whole tenant", which is both far more than you need and certain to be refused.
   - In the search box, tick each of these (search one at a time):
     - `Mail.Read`
     - `Calendars.Read`
     - `Chat.Read`
     - `User.Read` (usually already there by default)
   - Click **Add permissions**.

   You will see a table with a **Status** column. If it says *"Not granted for INNERGY"* with a
   warning triangle, that is normal and not necessarily a problem — you will find out at sign-in
   whether you can consent yourself. See "if it asks for admin approval" below.

6. Left sidebar of the app → **Manage** → **Authentication**.

   - Scroll to the bottom, to **Advanced settings**
   - **Allow public client flows** → set to **Yes**
   - Click **Save** at the top

   This is the step that makes device-code sign-in work. Without it, `pa login` fails with an
   error about the client not being public.

7. Put both values in `.env`:

```
PA_GRAPH_CLIENT_ID=<the Application (client) ID from step 4>
PA_GRAPH_TENANT_ID=<the Directory (tenant) ID from step 4>
```

8. Sign in:

```powershell
node bin\pa.js login
```

It prints something like *"To sign in, use a web browser to open the page
https://microsoft.com/devicelogin and enter the code ABCD-EFGH"*. Do that in a browser, approve
the consent screen, and come back — the command finishes on its own and prints your name.

### If it asks for admin approval

The consent screen may say **"Need admin approval"**. That is a tenant-wide setting (*User
consent for applications* set to "Do not allow"), not a property of the permissions you picked —
`Mail.Read`, `Calendars.Read` and `Chat.Read` are all documented as not requiring admin consent
by themselves.

[`IT-REVIEW.md`](./IT-REVIEW.md) is written to be pasted into that ticket — it answers cost,
scoping, revocation and where data goes, and raises the two things IT would otherwise find on
their own. Short version to open with:

> Please grant admin consent for the app registration `personal-assistant`
> (client ID `<yours>`) for the delegated Microsoft Graph permissions `Mail.Read`,
> `Calendars.Read`, `Chat.Read` and `User.Read`. Delegated only — the app acts as me and can
> see nothing I cannot already see. No application permissions, no write access, no ability to
> send.

Until that clears, leave `PA_GRAPH_CLIENT_ID` blank. Everything else still works; `pa doctor`
will simply report Microsoft as unconfigured.

### What this does *not* get you

Two things need admin consent no matter what, which is why the tool does not use them:

- **Team channel messages** (`ChannelMessage.Read.All`) — admin consent required by definition.
  Only your 1:1 and group chats are read.
- **Teams meeting transcripts via Graph** — needs application permissions, admin consent, a
  PowerShell-assigned Application Access Policy *and* a tenant toggle. Meetings are recorded
  locally instead, which needs nobody's permission.

---

## 2. Anthropic — `ANTHROPIC_API_KEY`

This is what turns messages into commitments and writes reply drafts. Without it the store
still fills up and search still works, but nothing gets distilled.

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

## 3. GitLab — `PA_GITLAB_URL` and `PA_GITLAB_TOKEN`

1. Open GitLab and sign in.
2. Your **avatar** (top right) → **Edit profile**.
3. Left sidebar → **Access** → **Personal access tokens**.
   Direct URL: `https://<your-gitlab-host>/-/user_settings/personal_access_tokens`
4. Click **Add new token** (on some versions: **Generate token** → **Legacy token**).
   - **Token name:** `personal-assistant`
   - **Expiration date:** whatever your policy allows. Note it — the tool will start reporting
     GitLab errors in `pa doctor` when it lapses.
   - **Scopes:** tick **`read_api`**. That is read access to the whole API — issues, merge
     requests, todos, pipelines.
     - Tick **`api`** *instead* only if you want `pa land` to open draft merge requests for you.
       `api` is read **and write**, so only do this if you want that.
     - If your instance does not offer `read_api`, `api` is the only option.
5. Click **Create personal access token** and copy the value from the green banner. Shown once.

The URL is the base of your instance, no trailing path — the same host you see in the browser:

```
PA_GITLAB_URL=https://gitlab.example.com
PA_GITLAB_TOKEN=glpat-...
```

---

## 4. Embeddings — optional, improves search

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

## 5. Everything else

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

## 6. Check it

```powershell
node bin\pa.js doctor
```

Every line should read `ok`. What the failures mean:

| Line | Means |
|---|---|
| `postgres ... ECONNREFUSED` | WSL dropped the distro. `Start-ScheduledTask pa-wsl-keepalive`. |
| `microsoft sign-in — run pa login` | step 1 not finished, or the token expired |
| `gitlab — PA_GITLAB_TOKEN not set` | step 3 not done, or the token expired |
| `anthropic — not set` | step 2 not done |
| `embeddings — endpoint returned 404` | step 4: wrong or missing deployment name |
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
