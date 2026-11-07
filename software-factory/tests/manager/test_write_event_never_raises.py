"""Verify write_event never raises, even on I/O errors."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch


def test_write_event_survives_open_failure(tmp_path: Path) -> None:
    """Mock builtins.open to raise so we can verify no exception propagates."""
    from factory.manager.signals import write_event

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("disk is full")

    # Patch open inside the signals module to force an I/O error.
    with patch("builtins.open", side_effect=_boom):
        # Should not raise.
        write_event("runs", {"event": "run"}, software_factory_root=tmp_path)


def test_write_event_survives_unserializable_value(tmp_path: Path) -> None:
    """Non-serializable payload values must be repr'd, not raise."""
    from factory.manager.signals import write_event

    class Weird:
        pass

    write_event("runs", {"event": "run", "bad": Weird()}, software_factory_root=tmp_path)
    # If we get here without exception, the test passes.
