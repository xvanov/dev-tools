# Module: personas

**Path:** `software-factory/factory/personas/`

## Purpose

Prompt-defined roles that make up the factory pipeline. Each persona is a markdown prompt file loaded and composed by the loader. The model used per persona is configured in `factory/routes.yaml`.

## Personas

| File | Role | Chain variant |
|------|------|---------------|
| `pm.md` | Product Manager — triages directions, classifies, splits into stories | tdd, docs |
| `sm.md` | Story Manager — writes individual story files from direction output | tdd, docs |
| `dev.md` | Developer — writes code + tests in an OpenHands sandbox | tdd |
| `reviewer.md` | Reviewer — reviews diffs, produces concrete FIND/REPLACE edits | tdd |
| `tech_writer.md` | Technical Writer — refreshes context docs after story completion | tdd, docs |
| `onboarder.md` | Onboarder — produces canonical context/ set for an app repo | docs |
| `acceptance_author.md` | Acceptance Author — writes acceptance test criteria | tdd |
| `analyst.md` | Analyst — research/report job persona | research, report |
| `researcher.md` | Researcher — research job persona | research |
| `contract.md` | Contract — writes interface contracts | tdd |
| `security.md` | Security — security review persona | tdd |
| `test_designer.md` | Test Designer — designs test plans | tdd |
| `test_implementer.md` | Test Implementer — implements tests | tdd |
| `ux_auditor.md` | UX Auditor — audits user experience of generated output | tdd |
| `factory_self_context.md` | Factory Self Context — context for factory self-edit stories | tdd |

## Support files

| File | Role |
|------|------|
| `__init__.py` | Empty package init |
| `loader.py` | Loads and composes persona prompts from markdown files |
| `validator.py` | Validates persona prompt structure and required sections |

## Dependencies

- `factory/routes.yaml` — persona-to-model routing
- `factory/model_router.py` — model resolution per persona
- `factory/runner.py` — sandbox_run / text_run entry points that consume persona prompts