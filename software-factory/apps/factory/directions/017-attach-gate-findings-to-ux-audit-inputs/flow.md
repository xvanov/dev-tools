# User flow

1. Flow: 014-detect-tests-that-bypass-the-app-entry-point/flow.md
2. Step: 2
3. Evidence: Step requires observing PR gate output (`tests-meaningful` red) naming file and line, but current invocation is `text_run` with no CI/PR surface, browser access, or captured gate artifact attached to the prompt.
4. Suggestion: Expose CI finding artifacts or a reproducible local gate command output to the audit so message clarity can be checked against the documented expectation.
