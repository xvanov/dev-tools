#!/usr/bin/env bash
# =============================================================================
# dev-tools :: Raspberry Pi (Ubuntu) bootstrap
# =============================================================================
# Turns a freshly-flashed, freshly-booted Ubuntu Pi into a working dev machine:
# base packages -> Node.js -> Tailscale (joined) -> an SSH key + your git repos
# -> the dev-tools that make sense on a headless box (termhub, statusline).
#
# It is SELF-CONTAINED: copy just this one file to the Pi and run it. It does
# not need the repo to be present first — it clones dev-tools itself (over SSH,
# once the key you generate here is added to GitHub) and runs each tool's own
# installer from that clone.
#
#   scp bootstrap/pi-setup.sh  ubuntu@<pi>:~/
#   ssh ubuntu@<pi>
#   TS_AUTHKEY=tskey-auth-xxxx  ./pi-setup.sh
#
# Every step is idempotent — re-running skips what is already done, so it is
# safe to run again after fixing a value or adding the SSH key to GitHub.
#
# Configure via environment variables (all optional except where noted):
#   TS_AUTHKEY   Tailscale auth key for unattended join. If unset, falls back
#                to interactive `tailscale up` (prints a URL to approve).
#   REPOS        Space-separated GitHub <owner>/<repo> to clone.
#                Default: "xvanov/dev-tools"
#   REPO_ROOT    Where to clone them.                 Default: "$HOME/repos"
#   GIT_NAME     git user.name.                        Default: current $USER
#   GIT_EMAIL    git user.email.                       Default: "$USER@$(hostname)"
#   NEW_HOSTNAME If set, renames the machine (sudo hostnamectl).
#   TOOLS        Space-separated tools to install.
#                Default: "termhub claude-ctx-statusline"
#   NODE_MAJOR   Node.js major version.                Default: 20
#
# Flags:
#   --skip-upgrade   don't run `apt-get upgrade` (faster re-runs)
#   --yes            don't pause for the "add the SSH key to GitHub" step
# =============================================================================
set -euo pipefail

# --- config ----------------------------------------------------------------
TS_AUTHKEY="${TS_AUTHKEY:-}"
REPOS="${REPOS:-xvanov/dev-tools}"
REPO_ROOT="${REPO_ROOT:-$HOME/repos}"
GIT_NAME="${GIT_NAME:-$USER}"
GIT_EMAIL="${GIT_EMAIL:-$USER@$(hostname)}"
NEW_HOSTNAME="${NEW_HOSTNAME:-}"
TOOLS="${TOOLS:-termhub claude-ctx-statusline}"
NODE_MAJOR="${NODE_MAJOR:-20}"

SKIP_UPGRADE=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --skip-upgrade) SKIP_UPGRADE=1 ;;
    --yes|-y)       ASSUME_YES=1 ;;
    -h|--help)      grep -E '^#( |$|=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# --- pretty output ---------------------------------------------------------
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33mWARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "this bootstrap is for Linux (Ubuntu on a Pi)."
command -v apt-get >/dev/null 2>&1 || die "apt-get not found — this expects Ubuntu/Debian."

step "dev-tools Pi bootstrap on $(hostname) ($(uname -m))"
info "repos    : $REPOS"
info "into     : $REPO_ROOT"
info "tools    : $TOOLS"
info "tailscale: $([[ -n "$TS_AUTHKEY" ]] && echo 'unattended (auth key)' || echo 'interactive login')"

# ---------------------------------------------------------------------------
# 1. hostname (optional)
# ---------------------------------------------------------------------------
if [[ -n "$NEW_HOSTNAME" && "$(hostname)" != "$NEW_HOSTNAME" ]]; then
  step "Setting hostname -> $NEW_HOSTNAME"
  sudo hostnamectl set-hostname "$NEW_HOSTNAME"
fi

# ---------------------------------------------------------------------------
# 2. base packages
# ---------------------------------------------------------------------------
step "Updating apt and installing base packages"
sudo apt-get update -y
if [[ "$SKIP_UPGRADE" -eq 0 ]]; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
fi
# build-essential + python3: node-pty (termhub) compiles a native module.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  git curl ca-certificates gnupg jq build-essential python3

# ---------------------------------------------------------------------------
# 3. Node.js (NodeSource -> guaranteed >= 18 on arm64/amd64)
# ---------------------------------------------------------------------------
have_node_ge() { command -v node >/dev/null 2>&1 && \
  [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$1" ]]; }

if have_node_ge 18; then
  step "Node.js already present: $(node --version)"
else
  step "Installing Node.js ${NODE_MAJOR}.x via NodeSource"
  # NodeSource may not yet publish a repo for very new distro releases (e.g.
  # Debian trixie). If its setup script fails, fall back to the distro's own
  # nodejs package — modern Debian/Ubuntu ship Node >= 18, which is enough.
  if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - \
     && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs; then
    info "node $(node --version), npm $(npm --version) (NodeSource)"
  else
    warn "NodeSource install failed — falling back to the distro nodejs/npm packages."
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
  fi
  have_node_ge 18 || die "Node.js >= 18 still not available after install."
  info "node $(node --version), npm $(npm --version)"
fi

# ---------------------------------------------------------------------------
# 4. Tailscale
# ---------------------------------------------------------------------------
if command -v tailscale >/dev/null 2>&1; then
  step "Tailscale already installed: $(tailscale version | head -n1)"
else
  step "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi

if tailscale status >/dev/null 2>&1; then
  step "Tailscale already up: $(tailscale ip -4 2>/dev/null | head -n1)"
else
  step "Joining the tailnet"
  # Non-fatal: a rejected/expired key or a skipped interactive login must not
  # abort the whole bootstrap (git config + tool installs come after this).
  if [[ -n "$TS_AUTHKEY" ]]; then
    sudo tailscale up --authkey "$TS_AUTHKEY" --hostname "$(hostname)" \
      || warn "tailscale up failed (bad/expired auth key?) — continuing without a tailnet."
  else
    warn "no TS_AUTHKEY set — starting interactive login."
    sudo tailscale up --hostname "$(hostname)" \
      || warn "tailscale up did not complete — continuing without a tailnet."
  fi
  info "tailscale ip: $(tailscale ip -4 2>/dev/null | head -n1 || echo 'none')"
fi

# ---------------------------------------------------------------------------
# 5. Git identity + SSH key for GitHub
# ---------------------------------------------------------------------------
step "Configuring git identity"
git config --global user.name  "$GIT_NAME"
git config --global user.email "$GIT_EMAIL"
info "user.name = $GIT_NAME, user.email = $GIT_EMAIL"

SSH_KEY="$HOME/.ssh/id_ed25519"
if [[ ! -f "$SSH_KEY" ]]; then
  step "Generating an SSH key for GitHub"
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  ssh-keygen -t ed25519 -N "" -C "$GIT_EMAIL" -f "$SSH_KEY"
else
  step "SSH key already exists: $SSH_KEY"
fi

# Trust github.com's host key so the clone below isn't an interactive prompt.
if ! ssh-keygen -F github.com >/dev/null 2>&1; then
  ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
fi

# Verify GitHub can see the key; if not, show it and wait.
# NOTE: `ssh -T git@github.com` always exits non-zero (even on success), so we
# must capture its output first — piping it directly would make `pipefail`
# report failure regardless of whether authentication succeeded.
github_ok() {
  local out
  out="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 || true)"
  grep -q "successfully authenticated" <<<"$out"
}

if ! github_ok; then
  step "Add this public key to GitHub, then continue"
  echo "-------------------------------------------------------------------"
  cat "$SSH_KEY.pub"
  echo "-------------------------------------------------------------------"
  info "Add it at: https://github.com/settings/ssh/new"
  if [[ "$ASSUME_YES" -eq 0 ]]; then
    read -r -p "    Press Enter once the key is added (Ctrl-C to abort)... " _
  fi
  github_ok || warn "GitHub auth still failing — private clones may be skipped below."
else
  step "GitHub SSH auth already working"
fi

# ---------------------------------------------------------------------------
# 6. Clone repos
# ---------------------------------------------------------------------------
step "Cloning repos into $REPO_ROOT"
mkdir -p "$REPO_ROOT"
DEVTOOLS_DIR=""
for slug in $REPOS; do
  name="${slug##*/}"
  dest="$REPO_ROOT/$name"
  if [[ -d "$dest/.git" ]]; then
    info "already cloned: $name"
  else
    if git clone "git@github.com:${slug}.git" "$dest"; then
      info "cloned $slug -> $dest"
    else
      warn "failed to clone $slug (SSH key added to GitHub? repo access?) — skipping"
      continue
    fi
  fi
  [[ "$name" == "dev-tools" ]] && DEVTOOLS_DIR="$dest"
done

# If this script was itself run from inside a dev-tools checkout, prefer that.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$DEVTOOLS_DIR" && -f "$SCRIPT_DIR/../README.md" && -d "$SCRIPT_DIR/../termhub" ]]; then
  DEVTOOLS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# 7. Install the dev-tools
# ---------------------------------------------------------------------------
if [[ -z "$DEVTOOLS_DIR" ]]; then
  warn "dev-tools checkout not found — skipping tool installs ($TOOLS)."
  warn "Add the SSH key to GitHub and re-run, or clone dev-tools manually."
else
  for tool in $TOOLS; do
    installer="$DEVTOOLS_DIR/$tool/linux/install.sh"
    if [[ -x "$installer" ]]; then
      step "Installing tool: $tool"
      ( cd "$DEVTOOLS_DIR/$tool" && ./linux/install.sh )
    elif [[ -f "$installer" ]]; then
      step "Installing tool: $tool"
      ( cd "$DEVTOOLS_DIR/$tool" && bash ./linux/install.sh )
    else
      warn "no Linux installer for '$tool' ($installer missing) — skipping."
    fi
  done
fi

# ---------------------------------------------------------------------------
# 8. Keep user services alive after logout (termhub is a --user service)
# ---------------------------------------------------------------------------
step "Enabling lingering so user services survive logout"
sudo loginctl enable-linger "$USER" >/dev/null 2>&1 || \
  warn "could not enable-linger; run 'sudo loginctl enable-linger $USER' manually."

# ---------------------------------------------------------------------------
# done
# ---------------------------------------------------------------------------
step "Bootstrap complete"
TSIP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
[[ -n "$TSIP" ]] && info "Tailscale IP : $TSIP"
if [[ " $TOOLS " == *" termhub "* && -n "$TSIP" ]]; then
  info "termhub      : http://$TSIP:7000"
  info "  status     : systemctl --user status termhub"
fi
info "repos        : $REPO_ROOT"
echo
info "Log out and back in (or reboot) if any group/service changes need a fresh session."
