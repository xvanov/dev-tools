"""factory.events — shared NDJSON event-stream utilities.

Houses cross-cutting helpers for the append-only ``state/events/*.ndjson``
streams that both the chain and the FMS manager read/write. The first
occupant is :mod:`factory.events.rotation`, which caps unbounded stream
growth and provides efficient tail reads for the hot summarizer/watcher
scan paths.
"""

from __future__ import annotations
