# termhub

A simple, self-hosted **web terminal** for your tailnet. Run one small server on each
machine you want to reach; from your phone or laptop, open that machine's URL in a browser
tab and manage its terminals — open several, switch between them, scroll back, and reattach
after a disconnect with full scrollback intact. Includes a one-click **Claude Code** launcher.

Works on Linux and Windows. Mobile-friendly. No tmux, no complex shortcuts.

## How you use it

You run `termhub` **separately on each machine** (1 Linux + 2 Windows, say). Every machine
serves its own UI. From a single device (phone/laptop) you open **one browser tab per
machine** at that machine's Tailscale address:

```
phone / laptop
  ├─ tab → http://linux-box:7000      (terminals on the Linux box)
  ├─ tab → http://win-1:7000          (terminals on Windows #1)
  └─ tab → http://win-2:7000          (terminals on Windows #2)
```

Each tab is independent and self-contained — there is no central hub, proxy, or config of
other machines to maintain.

## Features

- **Terminals in the browser** — powered by [xterm.js](https://xtermjs.org): proper colors,
  wide chars, scrollback. Full TUIs like `htop`/`vim` render correctly.
- **Real keys, including on mobile** — send `Ctrl-C`, arrows, `Esc`, `Tab`, and respond to
  interactive prompts. An on-screen key bar provides these (phone keyboards lack them), plus
  a sticky **Ctrl** modifier (tap `Ctrl`, then a letter → `Ctrl-<letter>`).
- **Survives disconnects *and updates*** — the PTY and its scrollback live in a persistent
  supervisor (`sessiond`), separate from the swappable web/proxy tier (`front`). Close your
  phone and reopen later, *or* deploy a new version with `update.ps1`, and your sessions keep
  running; the browser auto-reconnects and replays scrollback either way.
- **Claude Code launcher** — a directory field that autocompletes against the filesystem
  as you type (recents when blank), and a single editable command box (default
  `claude --dangerously-skip-permissions`, with presets you can pick or type over, or clear
  for a plain shell); it opens a terminal there and runs it.
- **Spoken announcements (opt-in per session)** — arm a Claude session with the 🔊 toggle and
  termhub tells you, out loud, when that session stops and is waiting on you. It watches Claude
  Code's own conversation transcript for the end of a turn, condenses the reply into two or
  three speakable sentences, and synthesises it locally with
  [kokoro](https://github.com/thewh1teagle/kokoro-onnx) — or [piper](https://github.com/OHF-Voice/piper1-gpl)
  where kokoro isn't installed. Nothing leaves the machine, and each turn is announced exactly
  once. When Claude stops on a question or a permission prompt it writes nothing to the
  transcript until you answer, so termhub notices that differently — a silent terminal — and
  tells you the session is asking something, without being able to say what. Needs no setup
  beyond having one of the two engines installed; without either, the toggle simply reports
  that speech is unavailable and everything else works as before.
- **Voice commands** — say **"Sputnik"** and the rest of the sentence drives termhub itself
  instead of being typed at the agent: hold a send, switch sessions, ask what's running, mute,
  read the last message in full. Anything that destroys work asks first and waits for a spoken
  *yes*. See [Voice commands](#voice-commands).
- **Idle tracking, and a phone that tells you** — termhub measures how long each agent session
  sits waiting on *you*, for every session, whether or not a browser is open. The sidebar shows a
  live stopwatch per session and today's total above the list; when a session has been waiting
  two minutes your phone gets an [ntfy](https://ntfy.sh) push whose notification opens straight
  into that terminal, escalating at 5 / 15 / 30 minutes. Hitting a usage or spend limit gets its
  own push and **stops** the clock — you can't un-idle a session that's out of tokens. Off until
  you write a topic into `notify.json`; the measuring runs regardless. See
  [Idle tracking](#idle-tracking).
- **Update from the UI** — a ⟳ Update button checks GitHub (once a day in the background, and
  on demand) and, when the termhub tool itself has changed, opens a terminal that runs the
  safe blue-green updater. See [Updating safely](#updating-safely-terminals-survive).
- **Mobile-friendly** — responsive layout, slide-out session drawer, on-screen keys.
- **Tailscale-native** — binds to the Tailscale interface only; no login screen, trust is
  delegated to your tailnet ACLs.

## Architecture

Two processes per machine — a **persistent** PTY supervisor and a **swappable** front, so
updates don't kill terminals:

```
                         Tailscale Serve  (https://<host>:7000, tailnet IP only)
                                    │
                                    ▼
browser tab ──http+ws──►  front  (UI + proxy, 127.0.0.1:7000)  ◄── http://127.0.0.1:7000
                              │   proxies /api/*, /ws/term/* and /ws/voice to ↓
                              ▼
                          sessiond  (127.0.0.1:7010)
                              └─► PTYs (node-pty) + scrollback  ← survive every update
```

Serve binds only the *tailnet* IP, so the front can hold `127.0.0.1:7000` at the same time: one port
number, and `https://<host>:7000/` and `http://127.0.0.1:7000/` are the same server. That's the
default (*single-port*) mode. `windows\start.ps1 -BlueGreen` moves the front to `7001`⇆`7002` and has
Serve re-pointed between them instead, which makes the update cutover atomic at the cost of
`http://127.0.0.1:7000` no longer being a thing — see `AGENT.md` → *Port modes*.

- **`sessiond`** owns the terminals (the `node-pty` PTYs and their scrollback). It's long-lived
  and only restarting *it* loses sessions.
- **`front`** serves the web UI and reverse-proxies to `sessiond`. Updates replace it and verify the
  replacement (healthy, *and* the right pid running the commit just pulled) before keeping it — the
  browser reconnects through the new `front` to the *same* PTYs and replays scrollback.

Sessions still don't survive a full **reboot** (the supervisor restarts) — by design, no tmux.
For local dev, `node server.js` runs both tiers in one process on `:7000` (no update-survival,
which is fine for dev). It refuses to start if a real deployment is already running, since it would
otherwise shadow `sessiond` and serve stale code on the publish port; give it its own ports instead:
`TERMHUB_PORT=7100 TERMHUB_SESSIOND_PORT=7110 node server.js`.

## Install (on each machine)

### Linux (systemd user service)

```bash
git clone https://github.com/xvanov/dev-tools.git
cd dev-tools/termhub
./linux/install.sh
```

Compiles `node-pty`, writes `~/.config/systemd/user/termhub.service`, starts it, and installs the
**watchdog** timer (see *Keeping it up* below). The installer prints the URL
(`http://<tailscale-ip>:7000`).

Run `sudo loginctl enable-linger $USER` on a headless box, or both termhub and its watchdog stop
when you log out. On Linux termhub is a **single process** (`server.js`, both tiers in one), so a
restart — including the one an update does — ends every terminal. That is the one behavioural
difference from Windows, where `sessiond` keeps them alive across updates.

### Windows (Tailscale Serve)

```powershell
cd termhub
Set-ExecutionPolicy -Scope Process Bypass
.\windows\install.ps1
```

On Windows the installer binds termhub to **loopback** and publishes it on your tailnet with
**Tailscale Serve** (HTTPS), giving you `https://<machine>.<tailnet>.ts.net:7000/`. This is the
mechanism that actually works from a phone: a raw port on the Tailscale interface is dropped by
Windows' default inbound-block firewall and just hangs. Requires the Tailscale CLI signed in,
and HTTPS/MagicDNS enabled for your tailnet (the default).

Auto-start adapts to privileges: **elevated** → a Scheduled Task (at logon, auto-restart);
**non-admin** → a hidden launcher in your Startup folder. The Serve config is persisted by
`tailscaled` and restored on boot. The installer also registers the **watchdog** task, so a new
machine is supervised from the start — run it **elevated** and the watchdog keeps working when
you're logged off (see below).

It also compiles `node-pty` itself, working around two common Windows build failures
(`GetCommitHash.bat` and Spectre-lib `MSB8040`) — see [AGENT.md](./AGENT.md). Needs the Visual
Studio Build Tools (Desktop development with C++ workload).

**That's the whole per-machine setup**: `install.ps1` (elevated) handles deps, the native build,
the `Termhub` logon task, the watchdog task, and brings both tiers up. Prerequisites are Node 18+,
the Tailscale CLI signed in, VS Build Tools, and — if you want the watchdog's LLM escalation —
the `claude` CLI on `PATH` (`.\watchdog\watchdog.ps1 -TestClaude` verifies it). For a
**plain-HTTP** machine (raw tailnet ports reachable, no Serve), run
`.\windows\start-http.ps1 -Port 7000` once afterwards to switch modes.

### Run manually (no service)

```bash
npm install
node server.js
```

Then browse to `http://<this-machine-tailscale-ip>:7000`.

## Updating safely (terminals survive)

The easiest way is the **⟳ Update** button in the sidebar header — it opens a terminal that
runs the updater for you. To do it by hand instead, from **any termhub terminal on the machine**
(so you can do it remotely from your phone/laptop):

```powershell
cd <project-dir>
.\windows\update.ps1
```

It's deterministic and reversible:

1. `git pull --ff-only` (records the old commit for rollback; aborts cleanly if not a fast-forward).
2. Starts a new **green** `front` on the alternate loopback port and health-checks it
   (front up, `sessiond` reachable, proxy + static both serving).
3. **Healthy** → re-points Tailscale Serve to green, then stops the old front. The published URL
   never changes; browsers reconnect to the same sessions and replay scrollback.
4. **Unhealthy** → kills green, `git reset --hard` to the old commit, leaves the old front
   serving. Zero downtime, terminals untouched.
5. Runs `claude update` to keep the Claude Code CLI at or above the version termhub is pinned to
   (`termhub.claudeCli` in `package.json`). Last and non-fatal: an offline or rate-limited CLI
   update prints a warning and leaves the finished termhub update in place. Running `claude`
   sessions keep the build they started with.

Because only `front` is swapped — `sessiond` and its PTYs are never touched — even the terminal
running `update.ps1` survives the update.

> **First-time bootstrap:** moving from the old single-process layout to the two-tier one
> requires one restart that *does* clear current sessions. Run `.\windows\install.ps1` (or
> `.\windows\start.ps1`) once; every `update.ps1` after that is non-disruptive.

## Keeping it up (the watchdog)

The `Termhub` scheduled task starts termhub **at logon and never again**, so a `front` that
dies mid-session stays dead until somebody notices. `watchdog/` fixes that, and does it in a
way that gets better over time:

```powershell
.\watchdog\install-watchdog.ps1     # Windows: a scheduled task, every 2 min + at boot
.\watchdog\watchdog.ps1 -Probe      # full diagnosis, changes nothing
```
```bash
bash watchdog/install-watchdog.sh   # Linux: a systemd --user timer, every 2 min + at boot
bash watchdog/watchdog.sh --probe
```

**You normally run none of that: clicking ⟳ Update installs and updates the watchdog too**, on
both platforms, and so does the platform installer. A fresh machine is watched immediately, and an
existing one picks the watchdog up the next time it updates. Update also re-enables it if it was
disabled, re-points it if the checkout moved, and tells you if the kill switch is still sitting
there.

The watchdog needs **no restart to update itself**. Its supervisor runs
`powershell -File watchdog.ps1` / `bash watchdog.sh` fresh every cycle, so a `git pull` is live on
the next tick with no resident process holding old code — unlike termhub itself, which is
long-lived and must be restarted deliberately.

**Linux differs in one way that matters.** There termhub is a single process, so restarting it
ends every terminal — the watchdog therefore only restarts when nothing is being served anyway,
and escalates instead of restarting a service that is merely unhealthy. systemd's
`Restart=on-failure` already covers a plain crash; the watchdog covers what it can't (a unit
stopped, disabled, or given up on after its start limit; a port squatted; a process alive but not
listening).

Every outage is classified into a stable **signature**. If `watchdog\remedies\<signature>.ps1`
exists it runs — repair in about a second, no model involved. If the failure is novel (or the
remedy failed), the watchdog escalates to **Claude Code**, which fixes the outage *and* writes
the remedy for that signature, then commits it. So each kind of failure needs a model once, and
is mechanical after that.

It will not restart `sessiond` to fix a `front` problem (that would end every live terminal),
will not kill an unidentified process to free a port, and stands down while `update.ps1` is
swapping the front. Details, the signature table, the escalation budget and the kill switch:
[watchdog/README.md](watchdog/README.md).

Both tiers now write stdout/stderr to `%LOCALAPPDATA%\termhub\logs\`, which is where to look
first when one of them has died.

## Using it

- **+ New terminal** — optionally a starting directory (it autocompletes against the
  filesystem as you type; leave blank for home) and a command. The **Command** box is a
  single editable combobox: type a command, pick a preset from the list, or clear it for a
  plain shell. The command runs in a fresh shell, so when it exits you still have a shell.
- **⟳ Update** (sidebar header) — opens a panel showing whether termhub is behind GitHub and
  whether the tool itself changed, with the incoming commit list. **Update now** opens a
  terminal that runs the safe updater (see below). It also checks once a day in the background
  and highlights the button when an update is waiting. The panel also reports your **Claude Code
  CLI** version against the one termhub is pinned to, with an **Update Claude** button — termhub
  drives the CLI through `--session-id`/`--resume` and its on-disk transcripts, so a CLI too old
  for the pin can break session restore and the model badge. `Update now` updates the CLI too.
- Switch terminals via the sidebar — the only place session control lives. The **✕** next
  to a session **kills** it; there's no separate soft-close, so what you see is what happens.
- **Collapse** (« in the sidebar header, desktop only) tucks the sidebar away for full-width
  terminal real estate; a floating **»** button brings it back. Remembered across reloads.
- **📎 (key bar) attaches a file** — the reliable way to get something onto the remote machine,
  and the only one that works on a phone. It opens the normal file picker (on iOS: Photo
  Library / Take Photo / Browse), takes several files at once, and shows upload progress and
  any failure as a notice above the key bar. **Pasting or dragging** a file onto the terminal
  does the same thing where the browser allows it.
  - An **image** is staged onto the remote machine's own OS clipboard and pasted into the
    running agent (Claude Code / opencode) exactly like a local screenshot paste would.
    On a machine with no clipboard to stage it on — a headless Linux box has no X or Wayland
    display, and no installed tool changes that — the image is saved to
    `<data dir>/attachments/` instead and its **path** is typed into the terminal input;
    Claude Code and opencode both read an image given a path. Attachments older than a week are
    cleaned up in the background. They deliberately do *not* go in the session's working
    directory: that's usually a git checkout, and pasted screenshots have no business in it.
  - **Any other file** (PDF, `.md`, `.txt`, …) is saved into the session's working directory
    and its path is typed into the terminal input for you to use.
  - Caps: **100 MB** per file, and per image too on a machine that saves images to disk — so a
    20 MB phone photo is fine. The tighter **15 MB** image cap applies only where the image goes
    onto a real OS clipboard, which is what can't take a larger one. Over the cap you're told
    immediately, rather than after a long upload.
  - Pasting text that happens to carry an image (copied out of a document or a web page) pastes
    the **text** — attach the image with 📎 if you wanted the picture.
- **🔊 next to a session** arms spoken announcements for it — **Claude Code and opencode**
  sessions; a plain shell has no turns to read and the toggle says so if you tap it. When that
  session finishes a turn and is waiting on you, termhub speaks a short summary of what it said; with
  more than one session armed, the summary is prefixed with the session's title so you know
  who's talking. A session that starts working again cancels an announcement that hasn't been
  spoken yet. Toggling it off is immediate and forgets nothing else.
  - **On an opencode session termhub can also tell you what it's asking.** opencode publishes
    its questions and permission prompts over its own API, so instead of Claude's generic
    "it's asking you something", you get the question and its options read out. (Only for
    opencode sessions termhub started itself — it needs to have opened the API port.)
- **Enable voice** — browsers (iOS Safari especially) refuse to play audio until you've tapped
  something, so the first armed session puts an amber **Enable voice** strip above the key bar.
  One tap unlocks audio for the rest of the page's life; until you tap it, the 🔊 toggles glow
  amber to say *armed, but you won't hear it*. Announcements still appear as text.
- **Hands-free replies.** After an announcement finishes speaking, termhub opens the microphone
  on its own. Talk normally; what it hears appears live under the status line. When you stop,
  it reads back the first few words — *"sending: yes, open a pull request…"* — and gives you
  **three seconds** with a big red **Cancel** button to stop it. Saying "stop", "cancel",
  "wait" or "no" does the same thing, and is caught as you say it rather than after. Cancelling
  keeps what you said in an editable box, so you can fix a word and send rather than start over.
  Otherwise the text is typed into that session and Enter is pressed for you.
  - You get a short chime the instant a session finishes, ahead of the speech — writing the
    summary can take several seconds, and the chime is how you know it's coming.
  - The mic is never open while audio is playing (on Bluetooth headphones every switch flips
    the audio route, so termhub does it as rarely as it can), and it closes itself after 45
    seconds of silence rather than listening to an empty room. A toast tells you when it does.
- **🎤 (key bar)** — talk to the session you're looking at without waiting to be asked. Tap
  once to listen, again to stop. On a browser with no speech recognition it opens a text box
  that sends the same way, so the button always does something.
### Voice commands

Say **"Sputnik"** and the rest of the sentence drives termhub instead of being typed at the
agent. Anything that does *not* start with the wake word is dictation, exactly as before.

| Say | What happens |
|---|---|
| **Sputnik wait** · *hold on* · *hang on* | Cancels the pending send. Keeps listening, keeps what you've said; the next thing you say is added to it |
| **Sputnik send it** · *send that* | Sends now, skipping the 4-second wait |
| **Sputnik scratch that** · *clear* · *start over* | Throws the draft away, keeps listening |
| **Sputnik never mind** · *forget it* | Throws the draft away and closes the mic |
| **Sputnik switch to \<name\>** · *go to \<name\>* | Opens that session. Names are matched loosely against the sidebar; if two are close it reads back the candidates rather than guessing |
| **Sputnik what's running** · *list sessions* | Reads the session list with each one's state |
| **Sputnik new terminal in \<dir\>** | Starts a Claude session there. The directory is matched against your recents and the open sessions' working directories; an unknown one is refused rather than guessed |
| **Sputnik close this session** | ⚠ Kills it. Names it and waits for a spoken **yes** first |
| **Sputnik stop this session** · *interrupt* | ⚠ Interrupts what the agent is doing (Escape) without destroying the session. Also asks first |
| **Sputnik mute** · *quiet* | Stops announcing. The session stays armed and the mic still opens — you just don't get read to |
| **Sputnik unmute** | Announcements back on |
| **Sputnik read that again** · *repeat* | Re-reads the last summary |
| **Sputnik read the last message in full** | Reads Claude's actual last message rather than the summary. Skips the summariser, so it's also the fast one |
| **Sputnik louder** / **quieter** | Playback volume, in steps |
| **Sputnik slower** / **faster** | Playback speed, 0.7× to 1.8× |

Four things worth knowing:

- **Every command is acknowledged** — a couple of spoken words, or a blip for the trivial ones
  (*wait*, *scratch that*, *mute*). A command that succeeded silently is indistinguishable from
  one that was never heard.
- **Destructive commands ask.** *Close* and *stop* name the session out loud and wait. Anything
  that isn't a clear yes cancels, and the question times out after 15 seconds.
- **Commands are recognised on the final transcript only**, never on the interim guesses that
  stream while you're still talking — an interim "Sputnik wait" that resolves to something else
  must not cancel a send. But the pending send timer *is* frozen the moment an interim starts
  with the wake word, because the 4-second window can otherwise expire while you're still
  saying the command. If the final turns out to be ordinary dictation, the timer simply re-arms.
- **The wake word only counts at the start of an utterance.** "We launched Sputnik in 1957" is
  text. If the wake word lands but the command doesn't parse, termhub says "didn't catch that"
  and drops it rather than typing a half-heard command at the agent.

Change the word with `TERMHUB_WAKE_WORD`. It is matched exactly (against a short list of
plausible mishearings — *sputnick*, *spud nik*, *sput nick*) rather than fuzzily: "Sputnik" is
a proper noun the recogniser already knows, so it comes back clean, and a loose matcher would
only buy false positives. `npm test` runs the matcher against both the accepted variants and a
list of near-miss dictation that must *not* trigger.

- On mobile: tap **☰** for the session drawer, **＋** for a new terminal, and use the key bar
  at the bottom for `Esc` / `Ctrl` / `Tab` / arrows / `^C` — swipe that group sideways for the
  ones that don't fit. **⌨ Copy Paste 🎤 📎** are pinned to the right of the bar and never
  scroll away, because each is the only way to do its job on a phone:
  - **⌨** brings the keyboard back if a tap on the terminal doesn't.
  - **Copy** is how you get text *out*. The terminal is drawn on a `<canvas>`, so there is
    nothing on screen for a long-press to select; Copy shows the same text as real text you
    can select natively, with **Copy all** / **Copy selection** and a Screen ↔ All-scrollback
    toggle.
  - **Paste** is how you get text *in* — Safari won't show its own long-press paste menu over
    the terminal. Multi-line pastes arrive as one paste, not as one Enter per line.
  - Drag anywhere on the terminal to scroll; **↓ Latest** appears when there's newer output
    below and takes you straight to the bottom.

> **Voice input and paste need the HTTPS address.** Both `SpeechRecognition` and
> `navigator.clipboard` are exposed only to a secure origin, so on the plain
> `http://<tailnet-ip>:7000` URL you get announcements but no microphone, and Paste falls back to
> a manual paste box. Use the machine's **MagicDNS** address —
> `https://<machine>.<tailnet>.ts.net:<serve-port>/` — since Serve's certificate covers that name
> and not the raw `100.x` IP. termhub shows you the exact address, read from Serve itself; check it
> from a shell with `curl -s http://<host>:7000/api/secure-url`. If you have an old bookmark on the
> HTTP address, this is why.

## Idle tracking

The thing being measured is **the time an agent spent waiting on you** — the gap between "Claude
stopped and needs an answer" and "you answered". Nothing else counts: work in progress is not
idle, a shell sitting at its prompt is not idle (that's what a shell is *for*), and a session
that hit a usage limit is not idle either, because there is nothing you could have done.

It runs in `sessiond`, so it counts with the browser closed, the phone asleep and the laptop lid
shut. There is nothing to arm and nothing to turn on.

**In the UI**: each waiting session shows a stopwatch in the sidebar — amber, turning red once
it's past the notification threshold — and the bar above the session list shows today's total,
how many sessions are running vs waiting, how many handoffs there were, and peak parallelism.

**On your phone**: push notifications via [ntfy](https://ntfy.sh), the same way docrag's listing
monitor does it. Create a topic (any long random string — **the topic is the only secret**; ntfy
has no accounts) and write it into the data dir:

```jsonc
// %LOCALAPPDATA%\termhub\notify.json   (Linux: ~/.local/termhub/notify.json)
{ "topic": "termhub-idle-<something long and random>", "server": "https://ntfy.sh" }
```

Then subscribe to that topic in the ntfy app. Or set `TERMHUB_NTFY_TOPIC`, which wins over the
file. No topic configured = no pushes, and everything else still works.

| | |
|---|---|
| first push | 2 min of waiting |
| then | +5 min, +15 min, then every 30 min |
| priority | `default`, raised to `high` past 15 min |
| tapping it | opens `https://<machine>/#session=<id>` — that terminal, not the session list |
| usage/spend limit | its own push, once, and the clock stops for that session |
| looking at it | a visible browser tab showing that session suppresses the push (but **not** the counting) |

**The log** lives in `<data dir>/idle/YYYY-MM-DD.jsonl`, one line per episode
(`{start, end, ms, state, reason, id, title, cwd, kind}`), append-only. `GET /api/idle` is
today's live picture; `GET /api/idle/history` rolls up every recorded day.

### The dashboard (`/dashboard`)

A separate page — the idle bar in the sidebar links to it. It shows, for whichever day you pick:

- **Idle share** — `waiting / (waiting + working)`, as a ring. This is the headline rather than
  raw minutes, because raw minutes punish a long day and flatter a short one. Under 15% counts as
  a win, and consecutive wins are a streak.
- **Tiles** — idle, working, handoffs, **idle per handoff** (the fairest single number: when the
  agent handed the work back, how long did it sit?), peak parallelism, sessions, and time lost to
  usage limits when there was any.
- **A month calendar**, each day shaded by idle share, click one to load it.
- **A timeline** — one row per session, bands across the 24 hours: green working, amber waiting,
  hatched out-of-tokens. This is what answers "what was actually going on at 3pm".
- **That day's sessions**, with a link back: **open** if it's still live, **restore** if it's in
  the restorable list, and *ended* if only the record survives.

## Configuration

All optional environment variables:

| Variable | Default | Notes |
|---|---|---|
| `TERMHUB_PORT` | `7000` | Front port for the single-process dev server (`node server.js`) |
| `TERMHUB_SESSIOND_PORT` | `7010` | Supervisor (`sessiond`) loopback port |
| `TERMHUB_FRONT_PORT` | `7001` | Front loopback port. The Windows scripts set it from `state.json`: the publish port in single-port mode (default), else `7001`⇆`7002` for blue/green |
| `TERMHUB_BIND` | auto | Front bind address. Auto-detects the Tailscale IP (`tailscale ip -4`, else a 100.64.0.0/10 interface), falling back to `127.0.0.1`. On Windows the installer pins it to `127.0.0.1` (Tailscale Serve does the exposure). `sessiond` always binds loopback regardless. |
| `TERMHUB_MACHINE` | hostname | Name shown in the UI |
| `TERMHUB_SHELL` | `$SHELL` / `pwsh`→`powershell` | Shell to spawn |
| `TERMHUB_SCROLLBACK_BYTES` | `2097152` (2 MB) | Per-session replay buffer size |
| `TERMHUB_DATA_DIR` | `~/.local/termhub` (Win: `%LOCALAPPDATA%\termhub`) | Where recent dirs, the session archive and `attachments/` are stored |
| `TERMHUB_TTS_ENGINE` | `kokoro` if installed, else `piper` | Which speech engine to use. An engine that isn't installed silently yields to the other one |
| `TERMHUB_TTS_VOICE` | `af_heart` (kokoro) / `~/.claude/tts-voice.txt`, else `en_US-lessac-medium` (piper) | Voice **within the active engine**. A value the active engine doesn't have is ignored rather than fatal |
| `TERMHUB_TTS_VOICE_DIR` | `~/.claude/piper-voices` | piper: directory holding `<voice>.onnx` + `<voice>.onnx.json` |
| `TERMHUB_KOKORO_PYTHON` | `~/.local/kokoro-venv/bin/python` | kokoro: interpreter with `kokoro_onnx` + `soundfile` |
| `TERMHUB_KOKORO_DIR` | `~/.claude/kokoro` | kokoro: directory holding `kokoro-v1.0.onnx` + `voices-v1.0.bin` |
| `TERMHUB_TTS_IDLE_MS` | `600000` (10 min) | How long the resident kokoro worker stays loaded with nothing to say. It holds ~750 MB |
| `TERMHUB_WAKE_WORD` | `sputnik` | The spoken wake word for voice commands |
| `TERMHUB_NTFY_TOPIC` | — | ntfy topic for idle notifications. Wins over `<data dir>/notify.json`; unset and unconfigured means no pushes. **The topic is the secret** — anyone who knows it can read them |
| `TERMHUB_NTFY_SERVER` | `https://ntfy.sh` | Point at a self-hosted ntfy instead |

On Linux set these with `systemctl --user edit termhub`; on Windows via `setx` + restart the task.

## Files

| Path | Purpose |
|---|---|
| `sessiond.js` | **Persistent supervisor**: HTTP API + terminal WebSocket; owns the PTYs (loopback) |
| `front.js` | **Swappable front**: serves the static UI + reverse-proxies `/api/*`, `/ws/term/*` and `/ws/voice` to `sessiond` |
| `server.js` | Single-process dev entrypoint — runs both tiers in one process (`npm start`) |
| `lib/session.js` | PTY lifecycle (`node-pty`), scrollback ring buffer, replay |
| `lib/claudeModel.js` | Locates a Claude session's transcript and tails it for the model badge |
| `lib/opencodeApi.js` | Talks to an opencode TUI's own HTTP API (termhub launches each with `--port`): model, turns, and its event stream |
| `lib/opencodeModel.js` | Fallback for an opencode session with no API port — reads the model via `opencode export` |
| `lib/claudeTranscript.js` | Reads the last turn from that transcript and decides whether it's waiting on you |
| `lib/summarize.js` | Condenses a turn into speakable prose (`claude -p --model haiku`, with a local fallback) |
| `lib/tts.js` | Speech synthesis — kokoro or piper, engine selection, voice discovery, WAV rendering, small LRU |
| `lib/kokoro_helper.py` | The resident kokoro worker `lib/tts.js` spawns: loads the model once, takes text on stdin, writes WAV on stdout |
| `web/voiceCommands.js` | Wake-word matching and command parsing (pure, no DOM — see `test/voiceCommands.test.js`) |
| `lib/voiceHub.js` | Watches armed sessions and broadcasts `waiting`/`busy` over `/ws/voice` |
| `lib/limit.js` | Concurrency gate bounding the synthesis / `claude -p` children sessiond will fork |
| `lib/idleState.js` | The idle state machine — working / waiting / limited — as a pure function |
| `lib/idleHub.js` | Runs that machine once a second over every agent session; logs episodes and pushes to your phone |
| `lib/idleStore.js` | The append-only episode log (`<data dir>/idle/YYYY-MM-DD.jsonl`) and its rollups |
| `lib/notify.js` | ntfy client — best-effort, never throws, silent when no topic is configured |
| `web/dashboard.html`, `web/dashboard.js`, `web/dashboard.css` | The idle dashboard served at `/dashboard` |
| `test/idle.test.js` | Idle state-machine and episode-log tests |
| `test/voiceCommands.test.js` | Wake-word and command-parser tests — `npm test`, no framework, no deps |
| `lib/state.js` | Deployment state (`state.json`) + pid-file helpers shared by the tiers and scripts |
| `lib/dirs.js` | Directory autocomplete for the new-terminal dialog |
| `lib/shell.js` | Default-shell resolution per OS |
| `lib/recents.js` | Recent-directory persistence |
| `lib/bind.js` | Tailscale-address detection |
| `lib/paths.js` | Per-user data directory resolution |
| `lib/clipboard.js` | Native OS clipboard image staging, and whether this host has a clipboard at all |
| `lib/uploads.js` | Saving attachments: files into the session cwd, images into `<data dir>/attachments/` |
| `web/` | xterm.js single-page UI (sidebar, key bar, dialogs) + vendored xterm assets |
| `windows/start.ps1` | Boots both tiers and publishes the front via Tailscale Serve (run by the scheduled task) |
| `windows/update.ps1` | Safe blue-green updater (run from any terminal; terminals survive) |
| `windows/common.ps1` | Shared PowerShell helpers (state, pid files, health checks) |
| `linux/`, `windows/` | Installers + the systemd service definition |
| `AGENT.md` | Detailed install / troubleshooting guide |

## Troubleshooting

- **`node-pty` fails to build** — needs a C/C++ toolchain. Linux: `build-essential`,
  `python3`. Windows: Visual Studio Build Tools (Desktop development with C++).
- **Bound to loopback / unreachable from other devices** — no Tailscale IP detected. Set
  `TERMHUB_BIND` to this machine's tailnet IP (`tailscale ip -4`).
- **Session disappeared after a reboot** — expected; sessions live in the server's memory.
- **On iPhone the page zooms when typing** — inputs use 16px font to avoid this; if it still
  happens, ensure you're on the current build (hard-refresh the tab).
- **Garbled output / wrong size** — the terminal refits on focus, rotate, and keyboard
  show/hide; switch sessions or resize to force a refit.
- **🔊 says speech is unavailable** — `GET /api/voice/status` tells you which half is missing:
  `tts.available` false means neither engine is usable — no kokoro venv/model under
  `TERMHUB_KOKORO_DIR` **and** no `piper` on `PATH` (or no usable `.onnx` in
  `TERMHUB_TTS_VOICE_DIR` — note that partially-downloaded voice files are skipped on purpose).
  `tts.engine` says which one won. `summarizer.available` false only means summaries will be
  trimmed locally instead of by `claude -p`, which still speaks fine.
- **Announcements sound robotic** — you're on piper. `tts.engine` in `/api/voice/status` will
  say so; kokoro wasn't found. If it *is* installed, check that `TERMHUB_KOKORO_PYTHON` can
  `import kokoro_onnx` — a worker that fails to load demotes the engine to piper for five
  minutes rather than failing the announcement.
- **A voice command wasn't heard** — commands only fire on the *final* transcript, and only
  when the utterance **begins** with the wake word. "We launched Sputnik in 1957" is dictation,
  by design. If the wake word landed but the command didn't parse, termhub says "didn't catch
  that" and drops it — it will never type a half-heard command at the agent.
- **Armed but never speaks** — announcements come from Claude Code's transcript, so the session
  must be `kind: claude` (the 🔊 toggle refuses anything else) and Claude must actually be
  writing one. If Claude warns in the terminal that transcript saving is off, it was started as
  a child of another Claude session and writes nothing; termhub strips the inherited
  `CLAUDE_CODE_*` identity from every terminal it spawns to prevent exactly that, so this should
  only show up for a `claude` you launched some other way. A session that's mid-tool-call is
  never announced either — that's deliberate.

See [AGENT.md](./AGENT.md) for a deeper walkthrough.
