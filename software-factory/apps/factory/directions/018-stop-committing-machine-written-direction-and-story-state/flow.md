# Operator flow — a tree that stays clean

1. **Start from a clean tree.** The operator runs `git status` and sees nothing
   pending.

2. **Run a tick that changes state.** `factory tick --app factory` advances a
   story and transitions a direction.

3. **Check the tree again.** `git status` is still clean. Today this step shows
   modified `state.yaml` files and untracked `stories/*.md`.

4. **Read the state anyway.** The operator opens
   `apps/factory/directions/<id>/state.yaml` and reads the current status, without
   querying the database — the file is still written, just not tracked.

5. **Simulate a fresh clone.** The operator clones the repo somewhere new and sees
   no `state.yaml` and no `stories/*.md`.

6. **Reconstruct them.** The operator runs the regenerate command and sees every
   direction's `state.yaml` written from the database, with statuses matching the
   source repo — and `git status` in the clone is still clean afterwards.

7. **Confirm a hand-written direction still works.** The operator writes a new
   direction directory by hand in the clone, runs `factory directions-backfill`,
   and sees it imported rather than ignored.
