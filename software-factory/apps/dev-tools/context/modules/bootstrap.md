# bootstrap — Machine Provisioning Scripts

## What it does

One-shot provisioning scripts for Linux machines (Raspberry Pi, Ubuntu).
Installs system packages, configures Tailscale, sets up SSH, clones the
dev-tools repository, and runs the tool-specific installers. On Windows, the
root `install.ps1` serves a similar bootstrap role for the full stack.

## Language / Runtime

Bash (Linux) / PowerShell (Windows). No external dependencies beyond standard
OS packages.

## Platforms

Linux (Raspberry Pi OS, Ubuntu) and Windows (via root `install.ps1`).

## Test command

No automated tests (provisioning scripts run once per machine).

```
echo "No tests"
```

## Install / Deploy

- Run `bootstrap/pi-setup.sh` on a fresh Linux machine or Raspberry Pi
- On Windows, run the root `install.ps1` to install the full dev-tools stack
- Both scripts require network access (clone repos, install packages) and
  interactive credentials (Tailscale auth, GitHub token)