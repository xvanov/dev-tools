"""factory.chain — the story pipeline (orchestrator, handlers, gates, workers).

Importing this package installs the control-plane state-write trace listener
(see ``factory.observability.state_trace``). It is done here, at package level,
rather than per-module because several modules in this package write
``StoryRecord.state`` through their own ``Session`` and would each have to
remember to instrument themselves — the by-discipline coverage the trace exists
to replace.

Because ``StoryRecord`` itself lives in this package, no code can write a story
state without first importing ``factory.chain``, so the listener is guaranteed
to be registered before any write. ``tests/test_conformance.py`` pins that
invariant in a fresh interpreter.
"""

from factory.observability.state_trace import install as _install_state_trace

_install_state_trace()
