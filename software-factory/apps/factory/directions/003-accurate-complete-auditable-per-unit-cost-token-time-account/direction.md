---
title: Accurate, complete, auditable per-unit cost/token/time accounting
type: infra
priority: p1
explore: true
created_at: '2026-07-19T14:21:29.270942+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Accurate, complete, auditable per-unit cost/token/time accounting

## Why

The runs table records tokens_in/tokens_out/cost_usd/duration_s/model/persona per LLM call, and per-story rollups are possible, BUT the accounting is not yet trustworthy for auditing spend per dispatched unit of work. Concrete gaps found 2026-07-19: (1) ATTRIBUTION IS LEAKY — many chain-persona runs have story_id=NULL (observed: 482 dev, 834 sm, 945 onboarder, 351 test_implementer, 252 reviewer runs unattributed), so per-story/per-direction cost is UNDERCOUNTED. Every chain persona run (sm/dev/reviewer/tech_writer/onboarder/test_implementer/docs_enforcer) MUST stamp story_id AND direction_id AND app on its runs row. (2) ~2900 rows have NULL/zero cost — every call must record a real cost, or explicitly flag why it is zero (e.g. cache-only). (3) COST ACCURACY UNVERIFIED — runs show ~93% prompt-cache hit; confirm the cost formula prices cached input tokens at the provider's discounted cache-read rate (not full input price), for every model/provider in model_router; fix if wrong and add a unit test pinning the per-model price math. (4) NO per-direction / per-app rollup and no reconciliation against the real provider bill.

WHAT TO BUILD: (a) thread story_id/direction_id/app into the runner so 100% of chain runs are attributed (add a completeness assertion/metric: unattributed-chain-run count should be ~0); (b) verify+fix cache-aware cost math with tests; (c) an operator audit command (extend `factory spend` or add `factory audit`) that reports tokens_in/tokens_out/cost/wall-time rolled up per story, per direction, and per app, with a flag for any unattributed spend; (d) a reconciliation note comparing summed cost_usd to the provider's billed amount for a window, to validate accuracy.

## Acceptance Criteria

- [ ] Every chain-persona run (sm/dev/reviewer/tech_writer/onboarder/test_implementer/docs_enforcer) records story_id, direction_id, and app; a completeness metric shows ~0 unattributed chain runs.
- [ ] No chain run has NULL/zero cost unless explicitly flagged as cache-only/failed-pre-model, with a reason.
- [ ] Cache-aware cost math is verified per model/provider with unit tests pinning the price (cached input at the discounted read rate).
- [ ] An operator command rolls up tokens_in, tokens_out, cost_usd, and wall-time per story / per direction / per app, and flags any unattributed spend.
- [ ] A reconciliation check compares summed cost_usd against the real provider bill for a window and documents the variance.
