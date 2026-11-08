# Cutover: the live factory moves into dev-tools

The live factory on k-911-x17 ran from `/home/k/software-factory`, a checkout of
`xvanov/software-factory`. From this cutover it runs from
`/home/k/dev-tools/software-factory`, a subdirectory of this repo. The old checkout
stays on disk, untouched except for its `state/` (moved) and a
`MOVED-TO-DEV-TOOLS.txt` note.

The script is `scripts/cutover-to-dev-tools.sh`. Run it on k-911-x17 as user `k`.

## Before you run it

1. Merge the v1.2 commits to `main`, then on the box:
   `cd ~/dev-tools && git pull --ff-only`. The script refuses a new tree without
   `factory/jobs/tasks.py` or with local changes.
2. No job may be `in_progress` (`uv run factory job list --active --no-github` in
   the old tree). The script checks this and refuses. It also refuses while
   `apps/factory` has a live story, because that story would open a PR against
   `xvanov/software-factory`.
3. Preview: `scripts/cutover-to-dev-tools.sh --dry-run`. It prints every action
   and changes nothing.

## What the script does

In this order. Each step that changes something is printed as it runs.

1. **Preflight** (read only): the checks above, the list of factory tick timers
   to restart, and a warning for any other user unit that names the old path.
2. **Stop** every `factory-tick@*.timer` and `factory-self-deploy.timer`, then
   wait for a running tick to finish (`DRAIN_TIMEOUT_S`, default 600 s). If it
   does not finish, the timers are restarted and the script stops with nothing
   else changed.
3. **Back up** `factory-tick@.service` (+ drop-ins), the self-deploy units and the
   timer list to `~/.factory-cutover-backup-<UTC stamp>/`.
4. **Retire self-deploy.** `factory-self-deploy` synced the live tree from
   `xvanov/software-factory` `origin/main`, which is no longer the source of
   truth. The timer is disabled and its unit files are removed (kept in the
   backup), so `factory on`, which starts every installed factory unit, cannot
   bring it back.
5. **Move `state/`**: every entry of the old `state/` (the sqlite db, events, logs,
   locks, acceptance oracles, story worktrees, …) is moved into the new `state/`.
   Moved, not copied, so there is one live database. Each story worktree is then
   re-linked to its app repo with `git worktree repair`.
6. **Carry over untracked app files**: `rsync -a --ignore-existing old/apps/
   new/apps/`. That brings the configs of apps this public repo does not track
   (`apps/sacrifice`, `apps/bonus-pilot`, …), untracked directions
   (`apps/*/directions/*`), the machine-written `state.yaml` files and story
   markdown. Files the new tree tracks (`apps/factory`, `apps/template-probe`)
   keep the new version.
7. **Pin app repo paths.** An app whose `app_repo_path` is relative or missing
   (`../sacrifice`, the default `../<name>`) resolved against the old root. From
   the new root it would point inside `~/dev-tools`. The script rewrites it to the
   absolute path it resolved to before (`/home/k/sacrifice`) and leaves a comment.
   `apps/factory` keeps `"."` (it is paused, below).
8. **`.env`**: copied (mode 600) unless the new tree already has one. If
   `FACTORY_TERMHUB_PUBLIC_URL` is not set, it is added from termhub's
   `/api/secure-url`, so a `claude_session` run's link is the Tailscale HTTPS
   address and not `127.0.0.1`.
9. **Agent memory**: `~/.claude/projects/-home-k-software-factory/memory` is copied
   to the new working directory's project key, so loop-3 sessions started in the
   new tree see the failure-class changelog.
10. **`uv sync --all-extras`** in the new tree, then a smoke test
    (`factory job list --json --no-github` must answer).
11. **Repoint** `factory-tick@.service`'s `WorkingDirectory` to the new tree,
    `daemon-reload`, and start the timers recorded in step 1.

## The factory's self-edit app is paused

`apps/factory` (repo `xvanov/software-factory`, `app_repo_path: "."`) is the loop
that builds the factory itself. After the cutover `"."` is a subdirectory of the
dev-tools checkout while `repo` still names the old repository, so a self-edit
would open a PR against a repo that is no longer the source of truth.

So `apps/factory/config.yaml` sets `self_tick_enabled: false` (tracked in this
repo; the script refuses to run without it). pm-sync then never turns factory
directions into stories. Its tick timer keeps running: it drives nothing for this
app, but every tick also starts queued research/report jobs.

Re-enabling self-edit needs, at least:

- `repo: xvanov/dev-tools`, and branch/PR handling for a monorepo (a self-edit
  must touch only `software-factory/`);
- the staging twin (`factory/manager/staging.py`) and the gate commands to clone
  and run from the `software-factory/` subdirectory;
- a self-deploy that follows `xvanov/dev-tools` `main` (the old script assumes the
  factory is the repo root and syncs `factory/**` only);
- then `self_tick_enabled: true`, and the self-deploy units reinstalled.

## After the cutover

- Point the personal assistant at the new tree: set `PA_FACTORY_PATH` to
  `/home/k/dev-tools/software-factory` wherever the PA runs, and restart it.
- `uv run factory power` from the new tree: the tick timers are up,
  `factory-self-deploy.timer` is gone.
- Watch two ticks: `journalctl --user -u 'factory-tick@*' -n 50`.
- Updating the factory is now `cd ~/dev-tools && git pull --ff-only` (the next
  tick picks up chain code; `uv sync --all-extras` when `uv.lock` changed).
- Anything else that names `/home/k/software-factory` (the script warns about
  other user units; `bench/swebench_adapter.py` has it as a default) still points
  at the old tree.

## Rollback

```bash
/home/k/dev-tools/software-factory/scripts/cutover-to-dev-tools.sh --rollback ~/.factory-cutover-backup-<stamp>
```

This stops the timers (and waits for a tick), moves `state/` back to the old tree
(with whatever the new tree wrote meanwhile), repairs the worktrees, restores the
unit files from the backup (old `WorkingDirectory`, self-deploy units), re-enables
`factory-self-deploy.timer`, removes the `MOVED-TO-DEV-TOOLS.txt` note and starts
the timers again. Files copied into the new tree (app configs, `.env`, memory)
stay there; they are inert while nothing runs from it. Point `PA_FACTORY_PATH`
back at `/home/k/software-factory`.

The rollback can also be previewed with `--dry-run`.

It moves the new tree's `state/`, so it predates `factory state migrate`
(docs/WINDOWS.md, "State lives outside the repo"). Once the new tree's state is
outside the repo (`software-factory/.state-dir` exists), that `state/` holds only
its `.gitignore`: move the state back first (the directory `factory state where`
prints, into `state/`, then delete `.state-dir`) or the rollback carries nothing.
