# Operator flow — adopting database-backed direction status

The operator-visible behaviour of this change. Each step is something a person
does and can observe the result of.

1. **Deploy the change and start a tick.** The operator runs `factory tick --app
   factory`. The tick completes normally; no direction changes status merely
   because the schema grew.

2. **Inspect what would be imported.** The operator runs `factory
   directions-backfill --app factory` (dry-run is the default) and reads a count
   of directions that have no database row yet. Nothing is written.

3. **Import the existing directions.** The operator re-runs the command with
   `--real-run` and sees `imported=<n> skipped=0`. Every direction under
   `apps/factory/directions/` now has a row whose status matches the status that
   was in its `state.yaml`.

4. **Re-run the import.** The operator runs the same command again and sees
   `imported=0 skipped=<n>`. Running it twice changes nothing, so a nervous
   operator can always check rather than guess.

5. **Confirm the database is now authoritative.** The operator deletes one
   direction's `state.yaml`, runs `factory pm-sync --app factory`, and observes
   that the direction is NOT re-triaged and does not reappear as `created` — its
   status survived the file's deletion.

6. **Confirm the file is still there for humans.** The operator looks at the same
   direction's directory and sees `state.yaml` has been rewritten from the
   database, carrying the same status.

7. **Confirm a persona now receives ancestor-story context.** The operator files
   a direction with `parent_direction` pointing at a direction that has already
   shipped, dispatches it, and reads the composed prelude in that story's run
   record: it contains a "Merged Story / Dev Agent Record" section naming the
   parent's deployed story. Before this change that section was always absent.
