---
title: Detect tests that bypass the app entry point
type: infra
priority: p1
explore: false
created_at: '2026-07-30T04:00:05.460960+00:00'
---

<!-- Sibling: flow.md carries the operator flow. -->

# Detect tests that bypass the app entry point

## Why

A test can be structurally incapable of failing, and the slop detector does not
notice. Story 148 (direction 012) shipped this test:

```python
db = tmp_path / "factory.db"
engine = create_engine(f"sqlite:///{db}", echo=False)
SQLModel.metadata.create_all(engine)
assert "directions" in _tables(db)
```

It builds the ORM machinery itself instead of calling the application's
initializer. A SQLModel subclass registers in `SQLModel.metadata` at
class-definition time, so what this asserts is "did THIS TEST FILE import the
model" — never "does the application create the table". Production was broken:
`migrate()`, which every CLI entry point calls, created no `directions` table at
all.

The cost was not one bad test. The dev was then redispatched three times to fix a
red CI, and each time it iterated against a test that could not observe the
defect — one of its commits is literally titled `fix(d012): ensure migrate()
creates the directions table` while `migrate()` still created nothing. The
CI-fix loop only stopped because the identical-failure-signature detector caught
the circling. A competent agent was sent in circles by a mis-specified test.

The existing detector catches four patterns — `assert_on_just_set`,
`mock_only_assertion`, `self_constructed_compare`, `self_throwing_raises` — all
of which are about the ASSERTION being vacuous. This class is different: the
assertion is fine, but the SETUP bypasses the subject, so the test measures the
framework instead of the app.

## What

Add a slop pattern for tests that construct infrastructure the application is
responsible for constructing, and route it through the existing
`tests-meaningful` gate like every other pattern.

The rule is deliberately narrow and mechanical: inside a test file, calling a
known schema/engine bootstrap directly — `SQLModel.metadata.create_all`,
`sqlmodel.create_engine`, `sqlalchemy.create_engine` — is a finding, because the
app owns that step (`factory.observability.schema.migrate`). Broad "is this test
meaningful" judgement is explicitly NOT in scope; this is one checkable rule.

## Acceptance Criteria

- The detector reports a finding with a stable new `kind` when a test file calls
  `SQLModel.metadata.create_all` or a `create_engine` variant directly.
- The finding carries a `why_slop` explanation naming the app initializer the
  test should have called, so the message teaches rather than just blocks.
- A test that obtains its database through the application's initializer produces
  NO finding, so the fixed form of the story-148 test passes cleanly.
- The existing `# noqa: slop` escape hatch suppresses the new finding on a single
  test, for the case where exercising the raw engine IS the subject — for example
  a test of `migrate()` itself.
- `factory/observability/schema.py`'s own tests, which legitimately construct
  engines, either pass or carry the escape hatch — the repository's own suite must
  be green with the new pattern enabled.
- The `tests-meaningful` gate blocks a PR whose diff introduces the new finding,
  through the existing path, with no new gate label.
- A regression test asserts the exact story-148 test body is flagged, and that its
  fixed form is not.

## Out of scope

- Any other slop pattern, or a general "does this test assert something real"
  judgement. One rule, one direction.
- Non-Python test files. The JS/TS scanner keeps its current patterns.
- Changing the CI-fix loop or its cap. Its behaviour was correct; this direction
  removes one reason it gets stuck.
- Retro-fixing existing tests beyond what is needed to keep the suite green.

## Open questions

- Whether the list of bootstrap calls should be configurable per app rather than
  hardcoded. Prefer hardcoded until a second app needs it — a config knob nobody
  sets is a liability.
