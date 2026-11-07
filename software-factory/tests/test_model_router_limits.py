"""Per-model output-token caps resolved through ``max_output_tokens_for``.

Replaces the legacy single ``_STRONG_MAX_TOKENS = 8192`` constant in
``factory.chain.handlers`` — Claude 4.x supports 32k output, GPT-5.4
supports 16k, DeepSeek-V4 caps at 8k. Hard-coding 8192 either
truncates the strong-model outputs mid-JSON or leaves headroom unused.
"""

from __future__ import annotations

from pathlib import Path

from factory.model_router import max_output_tokens_for


def _routes(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "routes.yaml"
    p.write_text(body, encoding="utf-8")
    return p


def test_explicit_model_limit_wins(tmp_path: Path) -> None:
    path = _routes(
        tmp_path,
        """
default_provider: direct
routes: {sm: deepseek/deepseek-chat}
model_limits:
  deepseek/deepseek-chat: {max_output_tokens: 8192}
  anthropic/claude-opus-4-7: {max_output_tokens: 32768}
defaults:
  fallback: deepseek/deepseek-chat
""",
    )
    assert max_output_tokens_for("deepseek/deepseek-chat", routes_path=path) == 8192
    assert max_output_tokens_for("anthropic/claude-opus-4-7", routes_path=path) == 32768


def test_falls_back_to_defaults_extra(tmp_path: Path) -> None:
    path = _routes(
        tmp_path,
        """
default_provider: direct
routes: {sm: some/unknown-model}
defaults:
  fallback: some/unknown-model
defaults_extra:
  max_output_tokens_default: 4096
""",
    )
    assert max_output_tokens_for("some/unknown-model", routes_path=path) == 4096


def test_falls_back_to_hard_default_when_unset(tmp_path: Path) -> None:
    # No model_limits, no defaults_extra → 8192 hard fallback.
    path = _routes(
        tmp_path,
        """
default_provider: direct
routes: {sm: some/unknown-model}
defaults:
  fallback: some/unknown-model
""",
    )
    assert max_output_tokens_for("some/unknown-model", routes_path=path) == 8192


def test_invalid_entries_fall_through(tmp_path: Path) -> None:
    # A malformed entry (non-int, zero, missing key) should not crash —
    # the helper falls through to defaults_extra / hard default.
    path = _routes(
        tmp_path,
        """
default_provider: direct
routes: {sm: x}
model_limits:
  bad/model-1: not-a-number
  bad/model-2: {max_output_tokens: 0}
  bad/model-3: {other_field: 100}
defaults_extra:
  max_output_tokens_default: 12345
""",
    )
    assert max_output_tokens_for("bad/model-1", routes_path=path) == 12345
    assert max_output_tokens_for("bad/model-2", routes_path=path) == 12345
    assert max_output_tokens_for("bad/model-3", routes_path=path) == 12345


def test_shipped_routes_yaml_covers_current_fleet() -> None:
    """The committed routes.yaml must declare a limit for every model the
    chain actually routes to. Drift between routes and limits is a foot-gun."""
    import yaml

    factory_root = Path(__file__).resolve().parents[1]
    data = yaml.safe_load((factory_root / "factory" / "routes.yaml").read_text())

    # Collect every model id referenced by ``routes`` / ``azure_routes``.
    used: set[str] = set()
    for block in ("routes", "azure_routes"):
        for entry in (data.get(block, {}) or {}).values():
            if isinstance(entry, str):
                used.add(entry)
            elif isinstance(entry, dict):
                for v in entry.values():
                    if isinstance(v, str):
                        used.add(v)

    limits = data.get("model_limits", {}) or {}
    missing = sorted(m for m in used if m not in limits)
    assert not missing, f"models routed but missing model_limits entries: {missing}"
