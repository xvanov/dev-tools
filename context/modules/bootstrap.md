# Module: bootstrap

**Path:** `bootstrap/`

## Purpose

One-shot provisioning for a new Linux machine (Raspberry Pi / Ubuntu): base packages, Node.js, Tailscale, SSH key + git repos, and the dev-tools — all from one self-contained script. Re-runnable and idempotent.

## Key files

| File | Role |
|------|------|
| `pi-setup.sh` | Main provisioning script. |

## Tech

- Bash script
- Supports Raspberry Pi and Ubuntu targets