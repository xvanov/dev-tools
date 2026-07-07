# bootstrap

One-shot provisioning for a **new Linux machine** (built for a Raspberry Pi
running Ubuntu, works on any Ubuntu/Debian arm64/amd64 box). Takes a
freshly-booted machine to: base packages → Node.js → Tailscale (joined) → an
SSH key + your git repos → the dev-tools worth running headless.

## 0. Flash Ubuntu (once, from another machine)

Use **Raspberry Pi Imager** → *Ubuntu Server (64-bit)*. In the imager's advanced
options (gear icon) set the hostname, enable SSH, and create a user — so the Pi
comes up reachable with no monitor. Boot the Pi, then `ssh <user>@<pi>`.

## 1. Get an SSH auth flow ready

- A **Tailscale auth key** for an unattended join — create one at
  <https://login.tailscale.com/admin/settings/keys> (reusable/ephemeral as you
  like). Without it the script falls back to an interactive browser login.
- Access to add an **SSH public key** to your GitHub account (the script
  generates the key and prints it; you paste it at
  <https://github.com/settings/ssh/new>).

## 2. Run the bootstrap

Copy just the one script over and run it:

```bash
scp bootstrap/pi-setup.sh <user>@<pi>:~/
ssh <user>@<pi>
TS_AUTHKEY=tskey-auth-xxxx ./pi-setup.sh
```

It pauses once to let you add the printed SSH key to GitHub, then clones your
repos and installs each tool from the clone. Re-running is safe — every step
skips work already done.

## What it does

| Step | Detail |
|------|--------|
| Hostname | `NEW_HOSTNAME` (optional) via `hostnamectl` |
| Base pkgs | `git curl jq build-essential python3` (build-essential/python3 let termhub compile `node-pty`) |
| Node.js | `NODE_MAJOR` (default 20) via NodeSource — guarantees ≥18 |
| Tailscale | official installer + `tailscale up` (auth key, else interactive) |
| Git | sets `user.name`/`user.email`, generates an ed25519 key, waits for you to add it to GitHub, clones `REPOS` into `REPO_ROOT` |
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

Flags: `--skip-upgrade` (skip `apt upgrade`), `--yes` (don't pause at the
add-key-to-GitHub step), `--help`.

## After it finishes

- termhub: `http://<tailscale-ip>:7000` (from any device on the tailnet, incl. your phone).
- Check the service: `systemctl --user status termhub`.
