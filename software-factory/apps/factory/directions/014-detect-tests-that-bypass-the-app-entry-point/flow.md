# Operator flow — catching a test that cannot fail

1. **A story ships a test that bypasses the app.** A dev writes a test that calls
   `SQLModel.metadata.create_all` directly and asserts a table exists.

2. **The gate blocks the PR.** The operator sees `tests-meaningful` red on that
   PR, with a slop finding naming the file, the line, and the offending call —
   not a generic "test quality" complaint.

3. **The message says what to do.** The finding's explanation names the
   application initializer the test should have driven
   (`factory.observability.schema.migrate`), so the fix is obvious without
   reading the detector's source.

4. **The dev fixes it and the gate clears.** The rewritten test drives the app's
   initializer, produces no finding, and the PR goes green — and now genuinely
   fails when production is broken.

5. **A legitimate raw-engine test is not blocked.** The operator marks a test
   whose actual subject IS the engine or `migrate()` itself with `# noqa: slop`,
   and the gate accepts it.

6. **The existing suite stays green.** The operator runs the full suite with the
   new pattern enabled and sees no new failures, so enabling the rule does not
   itself become a migration project.
