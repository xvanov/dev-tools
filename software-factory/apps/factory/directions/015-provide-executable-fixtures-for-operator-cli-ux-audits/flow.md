# User flow

1. Flow: 012-persist-direction-status-in-the-database/flow.md
2. Step: 1
3. Evidence: Flow requires CLI commands (`factory tick --app factory`) and database/state inspection, but runtime context shows `Scheduler transport: text_run` and `Deploy: disabled`; no live app/browser sandbox was available to execute or observe the documented operator step.
4. Suggestion: Run this audit only when the sandbox can execute the factory CLI against a provisioned app state, or provide captured command outputs as audit fixtures.
