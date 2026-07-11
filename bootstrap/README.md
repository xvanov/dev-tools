# bootstrap

One-shot provisioning for a **new Linux machine** (built for a Raspberry Pi
running Ubuntu, works on any Ubuntu/Debian arm64/amd64 box). Takes a
freshly-booted machine to: base packages → Node.js → Tailscale (joined) → an
SSH key + your git repos → the dev-tools worth running headless.

## 0. Flash Ubuntu (once, from another machine)

Use **Raspberry Pi Imager** → *Ubuntu Server (64-bit)*. In the imager's advanced
options (gear icon) set the hostname, enable SSH, and create a user — so the Pi
comes up reachable with no monitor. Boot the Pi, then `ssh <user>@<pi>`.

## 1. Get an auth flow ready

- A **Tailscale auth key** for an unattended join — create one at
  <https://login.tailscale.com/admin/settings/keys> (reusable/ephemeral as you
  like). Without it the script falls back to an interactive browser login.
- Your **GitHub login** — the script installs the `gh` CLI and runs
  `gh auth login`, an interactive device-code flow: it prints a one-time code
  and a URL, you approve it in any browser. gh then becomes git's credential
  helper (no SSH key to manage).

## 2. Run the bootstrap

Copy just the one script over and run it:

```bash
scp bootstrap/pi-setup.sh <user>@<pi>:~/
ssh <user>@<pi>
TS_AUTHKEY=tskey-auth-xxxx ./pi-setup.sh
```

It pauses once for the GitHub login (copy the code, approve in a browser), then
clones your repos and installs each tool from the clone. Re-running is safe —
every step skips work already done.

## What it does

| Step | Detail |
|------|--------|
| Hostname | `NEW_HOSTNAME` (optional) via `hostnamectl` |
| Base pkgs | `git curl jq build-essential python3` (build-essential/python3 let termhub compile `node-pty`) |
| Node.js | `NODE_MAJOR` (default 20) via NodeSource, with a fallback to the distro's `nodejs`/`npm` — guarantees ≥18 |
| Tailscale | official installer + `tailscale up` (auth key, else interactive; non-fatal if it fails) |
| GitHub | installs `gh`, runs `gh auth login` (device-code flow), wires gh as git's credential helper, rewrites `git@github.com:`→HTTPS, sets `user.name`/`user.email` from your GitHub account, clones `REPOS` into `REPO_ROOT` |
| Tools | runs each tool's own `linux/install.sh` (default: `termhub`, `claude-ctx-statusline`) |
| Linger | `loginctl enable-linger` so systemd `--user` services (termhub) survive logout |

## Configuration

All via environment variables (see the header of `pi-setup.sh` for the full list):

```bash
TS_AUTHKEY=tskey-auth-xxxx \
REPOS="xvanov/dev-tools" \
REPO_ROOT="$HOME/repos" \
TOOLS="termhub claude-ctx-statusline" \
NEW_HOSTNAME=pi-lab \
  ./pi-setup.sh --skip-upgrade
```

Flags: `--skip-upgrade` (skip `apt upgrade`), `--yes` (reserved; kept for
compatibility — the GitHub login is always interactive when needed), `--help`.

## After it finishes

- termhub: `http://<tailscale-ip>:7000` (from any device on the tailnet, incl. your phone).
- Check the service: `systemctl --user status termhub`.
