<!-- This file is CURRENT-STATE-ONLY. Do not preserve past states. -->
---
name: "{{app_name}}"
repo: "{{repo_url}}"
stack:
  - "{{primary_language}}"
  - "{{primary_framework}}"
---

# {{app_name}}

## Identity

One paragraph: what this app IS, who uses it, what problem it solves. Slow-changing.

## Stack

* Language: {{primary_language}}
* Framework: {{primary_framework}}
* Persistence: {{persistence}}
* Deploy target: {{deploy_target}}
* Test runner: {{test_runner}}

## Where things live (top-level layout)

```
{{layout_tree}}
```

## Active constraints (in-effect, not historical)

* [Hard constraint that is true right now, e.g. "Python 3.12 minimum"]
* [Hard constraint that is true right now, e.g. "All HTTP endpoints under /api/v1"]
