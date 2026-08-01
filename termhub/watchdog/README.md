# termhub watchdog — self-healing infrastructure

Watches termhub. Repairs failures it has seen before with a **script**, and escalates ones
it hasn't to **Claude Code** — which fixes the outage *and* writes the script, so that
failure never needs a model again.

```
probe ──healthy?────────────────────────────────────────────────► done
      │
      ├─ a deploy script is running? ──────────────────────────► stand down
      │
      ├─ confirm 3× over ~15s (a front swap is a 1–2s gap) ────► recovered? done
      │
      ├─ remedies\<signature>.ps1 exists? ──► run it ──► verify ──► fixed? done   ~3s, no LLM
      │
      └─ novel, or the remedy failed ──► claude -p ──► fixes it
                                                   └─► WRITES remedies\<signature>.ps1
                                                   └─► commits + pushes
```

The remedy library is the product. Every escalation is supposed to be the last one of its
kind: the model's job is to convert a novel outage into a deterministic script, so
escalations get rarer while coverage grows. A signature that has been seen before is
repaired in about a second by a script with no model in the loop at all.

## Install

```powershell
.\watchdog\install-watchdog.ps1                    # every 2 min + at boot (admin ⇒ survives logoff)
.\watchdog\install-watchdog.ps1 -IntervalMinutes 5
.\watchdog\install-watchdog.ps1 -Uninstall
```

A scheduled task rather than a resident loop, for two reasons. The watchdog is then itself
supervised — a wedged cycle is replaced by the next run, whereas a daemon that dies leaves
nothing watching the thing it was watching, and a watchdog that fails silently is worse
than none because it is trusted. It also keeps the watchdog out of any terminal's process
tree, so it can't share the fate of the console it was started from.

`MultipleInstances IgnoreNew` is load-bearing: an escalation can hold the task for minutes,
and a 2-minute trigger would otherwise stack watchdogs that all diagnose the same outage
and all try to repair it at once.

## Use

```powershell
.\watchdog\watchdog.ps1 -Probe          # full diagnosis, changes nothing
.\watchdog\watchdog.ps1                 # one cycle (what the task runs)
.\watchdog\watchdog.ps1 -Loop           # foreground, every 60s
.\watchdog\watchdog.ps1 -NoEscalate     # remedies only, never call the model
.\watchdog\watchdog.ps1 -TestClaude     # is the escalation path actually wired up?
Start-ScheduledTask TermhubWatchdog     # run a cycle now
```

State lives in `%LOCALAPPDATA%\termhub\watchdog\`:

| file | what |
|---|---|
| `watchdog.log` | every cycle, every repair, every escalation (capped at 4 MB, one `.prev`) |
| `escalations.json` | the ledger — what was escalated, when, and the outcome. Also the rate-limit input |
| `escalation-<stamp>.prompt.txt` / `.out.txt` | exactly what the model was asked and what it said |
| `DISABLED` | **kill switch.** Present ⇒ the watchdog does nothing (`TERMHUB_WATCHDOG_DISABLED=1` also works) |

Tier stdout/stderr — which did not exist before this watchdog and is the reason the first
outage could not be explained — is in `%LOCALAPPDATA%\termhub\logs\`:
`front-7000.out.log`, `front-7000.err.log`, `sessiond.out.log`, and one `.prev.log`
generation each. See `Get-TermhubLogDir` in `windows\common.ps1`.

## Signatures

An outage is reduced to one of a small set of stable slugs, and that slug is the filename of
its remedy. Signatures are deliberately **coarse** — they name the *shape* of the failure
(which tier is missing, who holds the port), never a pid, port or error string. A signature
that encoded specifics would mint a new one every outage and the library would never
accumulate. Classification lives in `lib\diagnose.ps1`; the table of signatures and which
ones are deliberately left to escalate is in [remedies/README.md](remedies/README.md).

## What it will not do

- **Restart `sessiond` to fix a front problem.** `sessiond` holds every live terminal as an
  in-memory PTY. Restarting it ends the user's running work and the sessions come back only
  as *Restorable*. Only signatures that say sessiond is already gone may start one.
- **Kill an unidentified process to free a port.** An unrecognised listener is far more
  likely to be something else on the machine than a termhub tier, so
  `publish-port-squatted` escalates every time instead of self-healing. Same judgement as
  `Clear-PortSquatter`.
- **Fight a deploy.** `update.ps1` and `restart-front.ps1` stop the front and start another;
  in single-port and plain-HTTP mode that is a real ~1–2s window with nothing on the port.
  The watchdog stands down while a deploy script is running, and confirms any outage three
  times over ~15s before acting.
- **Escalate in a loop.** Minimum 10 minutes between escalations, at most 3/hour and 8/day.
  Past that it logs that termhub is down and needs a human, which is the honest outcome — a
  failure the model cannot fix should not become a model running every two minutes forever.

## The escalation

`claude -p --dangerously-skip-permissions`, with the diagnostic bundle (topology, probes,
listeners, pid files, node processes, Serve config, git HEAD, tier logs) on stdin. It is
told to fix the outage, write the remedy under the signature it was called for, commit and
push, and report. Two constraints in that prompt are worth knowing about:

- **It must not touch sessiond** unless the signature says sessiond is already down. The
  prompt states this as a hard rule with the reason, because "restart it" is the obvious
  wrong move for a model that has just been told a service is down.
- **It must commit and push.** Not bookkeeping: termhub deploys by `git pull --ff-only`,
  which fails on a dirty tree, so a remedy left uncommitted in the working tree would block
  every future update on every machine. Committing is the *safe* option here, not the bold
  one.

`--dangerously-skip-permissions` is required — nobody is present to answer a prompt. That is
a real grant of autonomy on this machine, bounded by the escalation budget, the kill switch,
and the fact that every prompt and reply is written to disk before and after the fact.
