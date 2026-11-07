# User flow

1. Flow: 013-revive-a-story-whose-pr-was-merged-after-ci-block/flow.md
2. Step: 5
3. Evidence: Step depends on observing asynchronous story state transitions on 'the next tick' after a PR merge, but the provided runtime contains no deploy URL, no browser sandbox, and no executable integration environment for queue/tick/PR state changes.
4. Suggestion: Add an integration-ready audit mode with seeded story/PR fixtures so revival transitions can be observed empirically.
