"""Per-app / per-job model + pipeline routing (operator decision 2026-11-02).

Pinned here:
* provider key + base-URL resolution for the new prefixes (anthropic/,
  openrouter/, openai_compat/), incl. the "no base URL ⇒ refuse" rule for the
  generic OpenAI-compatible endpoint, and the existing missing-key degradation
  for overrides;
* precedence job > app > routes.yaml, resolved at spawn and stamped on the story;
* reviewer independence holds on the EFFECTIVE map and a colliding override is
  refused (``review_independence``), never repaired;
* pipeline: auto → app default → chain; solo accepted on any app (no oracle
  requirement since 2026-11-02) and refused loudly only when the
  ``SOLO_PIPELINE_IMPLEMENTED`` kill switch is off.

No test here makes a model call.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import factory.job_routing as jr
import factory.model_router as mr
from factory.app_config import AcceptanceBootConfig, AppConfig, AppGatesConfig
from factory.chain.state_machine import StoryRecord
from factory.directions.parser import Direction

_PROVIDER_VARS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API_BASE",
    "ANTHROPIC_BASE_URL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_BASE",
    "OPENAI_API_KEY",
    "OPENAI_API_BASE",
    "OPENAI_BASE_URL",
    "OPENAI_COMPAT_API_KEY",
    "OPENAI_COMPAT_API_BASE",
    "FACTORY_ALLOW_REVIEW_COLLISION",
)


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _PROVIDER_VARS:
        monkeypatch.delenv(name, raising=False)
    # Pin the active block: azure_routes (reviewer Kimi, dev deepseek-v4-pro).
    monkeypatch.setenv("FACTORY_PROVIDER", "azure")
    monkeypatch.setenv("AZURE_API_KEY", "test-azure-key")
    mr._KEY_FALLBACK_WARNED.clear()


AZ_REVIEWER = "azure/Kimi-K2.7-Code"
AZ_DEV = "azure/deepseek-v4-pro"


def _cfg(
    *,
    models: dict[str, str] | None = None,
    pipeline_default: str = "chain",
    oracle: bool = False,
    boot: bool = False,
) -> AppConfig:
    return AppConfig(
        name="sacrifice",
        repo="owner/sacrifice",
        models=models or {},
        pipeline_default=pipeline_default,  # type: ignore[arg-type]
        gates=AppGatesConfig(
            acceptance_oracle=oracle,
            acceptance_boot=AcceptanceBootConfig(command="run --port {port}") if boot else None,
        ),
    )


# --------------------------------------------------------------------------- #
# Providers
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("model", "env"),
    [
        ("anthropic/claude-sonnet-4-5", "ANTHROPIC_API_KEY"),
        ("openrouter/anthropic/claude-sonnet-4-5", "OPENROUTER_API_KEY"),
        ("openai_compat/qwen3-coder", "OPENAI_COMPAT_API_KEY"),
        ("openai/gpt-5", "OPENAI_API_KEY"),
        ("azure/gpt-5.4", "AZURE_API_KEY"),
    ],
)
def test_provider_env_key_for_new_prefixes(model: str, env: str) -> None:
    assert mr.provider_env_key(model) == env


def test_base_url_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    assert mr.provider_base_url("anthropic/claude-x") is None
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://proxy.example/anthropic")
    assert mr.provider_base_url("anthropic/claude-x") == "https://proxy.example/anthropic"
    monkeypatch.setenv("ANTHROPIC_API_BASE", "https://primary.example")
    assert mr.provider_base_url("anthropic/claude-x") == "https://primary.example"
    monkeypatch.setenv("OPENROUTER_API_BASE", "https://or.example/api/v1")
    assert mr.provider_base_url("openrouter/x/y") == "https://or.example/api/v1"
    # Azure owns its own base-url resolution in the runner.
    assert mr.provider_base_url("azure/gpt-5.4") is None


def test_openai_compat_is_sent_as_openai_wire_id() -> None:
    assert mr.wire_model_id("openai_compat/qwen3-coder") == "openai/qwen3-coder"
    assert mr.wire_model_id("anthropic/claude-x") == "anthropic/claude-x"


def test_openai_compat_requires_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a base URL LiteLLM would send the key to api.openai.com."""
    from factory.runner import LLMConfig, _resolve_api_key

    monkeypatch.setenv("OPENAI_COMPAT_API_KEY", "k")
    assert mr.provider_ready("openai_compat/m") is False
    assert _resolve_api_key(LLMConfig(model="openai_compat/m")) is None
    monkeypatch.setenv("OPENAI_COMPAT_API_BASE", "http://127.0.0.1:8000/v1")
    assert mr.provider_ready("openai_compat/m") is True
    assert _resolve_api_key(LLMConfig(model="openai_compat/m")) == "k"


def test_runner_resolves_anthropic_and_openrouter_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    from factory.runner import LLMConfig, _resolve_api_key

    assert _resolve_api_key(LLMConfig(model="anthropic/claude-x")) is None
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak")
    monkeypatch.setenv("OPENROUTER_API_KEY", "ok")
    assert _resolve_api_key(LLMConfig(model="anthropic/claude-x")) == "ak"
    assert _resolve_api_key(LLMConfig(model="openrouter/a/b")) == "ok"


def test_override_with_missing_key_degrades_to_fallback(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    overrides = {"dev": "anthropic/claude-sonnet-4-5"}
    with caplog.at_level("WARNING"):
        got = mr.route_with_overrides("dev", "standard", overrides)
    assert got == "azure/deepseek-v4-pro"  # azure_fallback
    assert "ANTHROPIC_API_KEY" in caplog.text
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak")
    assert mr.route_with_overrides("dev", "standard", overrides) == "anthropic/claude-sonnet-4-5"


def test_text_run_passes_wire_id_and_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """The generic endpoint reaches LiteLLM as openai/<m> + base_url; no real call."""
    import litellm

    import factory.runner as runner

    monkeypatch.setenv("OPENAI_COMPAT_API_KEY", "ck")
    monkeypatch.setenv("OPENAI_COMPAT_API_BASE", "http://127.0.0.1:9/v1")
    seen: dict[str, object] = {}

    class _Stop(Exception):
        pass

    def fake_completion(**kwargs: object) -> object:
        seen.update(kwargs)
        raise _Stop

    monkeypatch.setattr(litellm, "completion", fake_completion)
    monkeypatch.setattr(runner, "_log_prompt_metadata", lambda **k: None)
    monkeypatch.setattr(runner, "_log_prompt_body", lambda **k: None)
    with pytest.raises(_Stop):
        runner.text_run("pm", "hi", "openai_compat/qwen3-coder", db_path=Path("/nonexistent/x.db"))
    assert seen["model"] == "openai/qwen3-coder"
    assert seen["base_url"] == "http://127.0.0.1:9/v1"
    assert seen["api_key"] == "ck"


# --------------------------------------------------------------------------- #
# Precedence job > app > routes.yaml
# --------------------------------------------------------------------------- #


def test_precedence_job_over_app_over_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak")
    monkeypatch.setenv("OPENROUTER_API_KEY", "ok")
    app = _cfg(models={"dev": "openrouter/qwen/qwen3-coder", "sm": "openrouter/x/sm"})
    routing = jr.resolve_job_routing(app, job_models={"dev": "anthropic/claude-sonnet-4-5"})
    assert routing.model_overrides == {
        "dev": "anthropic/claude-sonnet-4-5",  # job wins over app
        "sm": "openrouter/x/sm",  # app wins over routes
    }
    assert routing.model_sources == {"dev": "job", "sm": "app"}
    ov = routing.model_overrides
    assert mr.route_with_overrides("dev", "standard", ov) == "anthropic/claude-sonnet-4-5"
    assert mr.route_with_overrides("sm", "standard", ov) == "openrouter/x/sm"
    # Neither names the reviewer → routes.yaml.
    assert mr.route_with_overrides("reviewer", "standard", ov) == AZ_REVIEWER


def test_tiered_key_beats_bare_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak")
    ov = {"dev": "anthropic/claude-sonnet-4-5", "dev.hard": "anthropic/claude-opus-4-5"}
    assert mr.route_with_overrides("dev", "hard", ov) == "anthropic/claude-opus-4-5"
    assert mr.route_with_overrides("dev", "standard", ov) == "anthropic/claude-sonnet-4-5"


def test_no_overrides_is_exactly_routes_yaml() -> None:
    routing = jr.resolve_job_routing(_cfg())
    assert routing.model_overrides == {}
    assert routing.overrides_json() is None
    assert routing.pipeline == "chain"


def test_parse_model_flags() -> None:
    assert jr.parse_model_flags(["dev=anthropic/claude-x", " reviewer = azure/gpt-5.4 "]) == {
        "dev": "anthropic/claude-x",
        "reviewer": "azure/gpt-5.4",
    }
    for bad in (["dev"], ["=x/y"], ["dev="], ["dev=a/b", "dev=c/d"]):
        with pytest.raises(jr.JobRoutingError) as ei:
            jr.parse_model_flags(bad)
        assert ei.value.code == "bad_model_flag"


@pytest.mark.parametrize(
    ("models", "code"),
    [
        ({"devv": "anthropic/x"}, "unknown_persona"),
        ({"dev.extreme": "anthropic/x"}, "unknown_persona"),
        ({"dev": "claude-sonnet"}, "bad_model_id"),
        ({"dev": 3}, "bad_model_id"),
        (["dev=x"], "bad_models"),
    ],
)
def test_bad_model_maps_are_refused(models: object, code: str) -> None:
    with pytest.raises(jr.JobRoutingError) as ei:
        jr.resolve_job_routing(_cfg(), job_models=models)
    assert ei.value.code == code


# --------------------------------------------------------------------------- #
# Reviewer independence after overrides
# --------------------------------------------------------------------------- #


def test_job_dev_override_colliding_with_routes_reviewer_is_refused() -> None:
    with pytest.raises(jr.JobRoutingError) as ei:
        jr.resolve_job_routing(_cfg(), job_models={"dev": AZ_REVIEWER})
    assert ei.value.code == "review_independence"
    assert "dev.standard" in ei.value.message and "dev.hard" in ei.value.message


def test_job_reviewer_override_colliding_with_routes_dev_is_refused() -> None:
    with pytest.raises(jr.JobRoutingError) as ei:
        jr.resolve_job_routing(_cfg(), job_models={"reviewer": AZ_DEV})
    assert ei.value.code == "review_independence"


def test_collision_across_app_and_job_layers_is_refused() -> None:
    """App moves dev to X, job moves reviewer to X: each layer is fine alone."""
    app = _cfg(models={"dev": "anthropic/claude-sonnet-4-5"})
    jr.resolve_job_routing(app)  # app alone: fine
    with pytest.raises(jr.JobRoutingError) as ei:
        jr.resolve_job_routing(app, job_models={"reviewer": "anthropic/claude-sonnet-4-5"})
    assert ei.value.code == "review_independence"
    assert "(app)" in ei.value.message and "(job)" in ei.value.message


def test_hard_tier_only_collision_is_refused() -> None:
    with pytest.raises(jr.JobRoutingError):
        jr.resolve_job_routing(_cfg(), job_models={"dev.hard": AZ_REVIEWER})


def test_reviewer_override_that_would_degrade_onto_dev_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No ANTHROPIC_API_KEY ⇒ the reviewer override degrades to azure_fallback,
    which is the dev model. Configured ids are independent; what runs is not."""
    with pytest.raises(jr.JobRoutingError) as ei:
        jr.resolve_job_routing(_cfg(), job_models={"reviewer": "anthropic/claude-opus-4-5"})
    assert ei.value.code == "review_independence"
    assert "degradation" in ei.value.message
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak")
    ok = jr.resolve_job_routing(_cfg(), job_models={"reviewer": "anthropic/claude-opus-4-5"})
    assert ok.warnings == ()


def test_moving_both_sides_apart_is_accepted() -> None:
    routing = jr.resolve_job_routing(
        _cfg(), job_models={"dev": AZ_REVIEWER, "reviewer": "anthropic/claude-opus-4-5"}
    )
    assert routing.model_overrides["reviewer"] == "anthropic/claude-opus-4-5"
    # The anthropic key is unset here → warned, not refused.
    assert any("reviewer=anthropic/claude-opus-4-5" in w for w in routing.warnings)


def test_routes_dev_tier_degrading_onto_a_job_reviewer_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The other direction: the job leaves dev alone, but routes.yaml's dev has
    no key here and degrades to the fallback — which is the job's reviewer."""
    routes = tmp_path / "routes.yaml"
    routes.write_text(
        "default_provider: direct\n"
        "routes:\n  reviewer: azure/Kimi-K2.7-Code\n"
        "  dev:\n    standard: deepseek/deepseek-coder\n    hard: deepseek/deepseek-coder\n"
        "defaults:\n  fallback: azure/gpt-5.4\n"
    )
    monkeypatch.setenv("FACTORY_PROVIDER", "direct")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(mr, "_load_routes", lambda path=None: mr.yaml.safe_load(routes.read_text()))
    with pytest.raises(jr.JobRoutingError) as ei:
        jr.resolve_job_routing(_cfg(), job_models={"reviewer": "azure/gpt-5.4"})
    assert ei.value.code == "review_independence"
    assert "degradation" in ei.value.message
    # With the dev provider provisioned nothing degrades, and it is accepted.
    monkeypatch.setenv("DEEPSEEK_API_KEY", "dk")
    ok = jr.resolve_job_routing(_cfg(), job_models={"reviewer": "azure/gpt-5.4"})
    assert ok.model_overrides == {"reviewer": "azure/gpt-5.4"}


def test_non_review_overrides_skip_the_runtime_check(monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[bool] = []
    monkeypatch.setattr(jr, "route_with_overrides", lambda *a, **k: called.append(True) or "x/y")
    jr.check_runtime_independence({"pm": "anthropic/claude-x"})
    assert called == []


def test_collision_escape_hatch_does_not_apply_to_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FACTORY_ALLOW_REVIEW_COLLISION", "1")
    with pytest.raises(jr.JobRoutingError):
        jr.resolve_job_routing(_cfg(), job_models={"dev": AZ_REVIEWER})


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #


def test_pipeline_auto_and_absent_resolve_to_chain() -> None:
    for req in (None, "auto", "AUTO", "chain"):
        r = jr.resolve_job_routing(_cfg(), pipeline=req)
        assert r.pipeline == "chain"
    assert jr.resolve_job_routing(_cfg()).pipeline_requested == "auto"


def test_auto_app_default_resolves_to_chain() -> None:
    r = jr.resolve_job_routing(_cfg(pipeline_default="auto"), pipeline="auto")
    assert (r.pipeline, r.pipeline_requested) == ("chain", "auto")
    assert jr.resolve_job_routing(_cfg(pipeline_default="auto")).pipeline == "chain"


def test_pipeline_vocabulary_is_shared_with_app_config() -> None:
    from factory.app_config import PIPELINE_NAMES

    assert jr.PIPELINES == PIPELINE_NAMES == ("chain", "solo", "auto")


def test_reads_the_frontmatter_keys_job_submit_writes() -> None:
    """``factory job submit`` writes ``pipeline:``, ``models:``, ``delivery:``."""

    class _Dir:
        id_slug = "001-x"
        raw_frontmatter = {
            "pipeline": "chain",
            "delivery": "pr",
            "models": {"pm": "anthropic/claude-sonnet-4-5"},
        }

    r = jr.resolve_for_direction(_Dir(), _cfg())
    assert r.pipeline == "chain"
    assert r.model_overrides == {"pm": "anthropic/claude-sonnet-4-5"}
    assert r.model_sources == {"pm": "job"}


def test_bad_pipeline_is_refused() -> None:
    with pytest.raises(jr.JobRoutingError) as ei:
        jr.resolve_job_routing(_cfg(), pipeline="swarm")
    assert ei.value.code == "bad_pipeline"


def test_solo_is_refused_when_the_kill_switch_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jr, "SOLO_PIPELINE_IMPLEMENTED", False)
    with pytest.raises(jr.JobRoutingError) as ei:
        jr.resolve_job_routing(_cfg(oracle=True, boot=True), pipeline="solo")
    assert ei.value.code == "pipeline_unavailable"
    assert "silently run the full chain" in ei.value.message


def test_auto_on_a_solo_default_app_is_refused_not_downgraded_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(jr, "SOLO_PIPELINE_IMPLEMENTED", False)
    with pytest.raises(jr.JobRoutingError) as ei:
        jr.resolve_job_routing(_cfg(pipeline_default="solo"), pipeline="auto")
    assert ei.value.code == "pipeline_unavailable"
    # An explicit chain request on that app still runs chain.
    assert (
        jr.resolve_job_routing(_cfg(pipeline_default="solo"), pipeline="chain").pipeline == "chain"
    )


def test_solo_is_available_on_any_app_without_the_oracle() -> None:
    """Operator decision 2026-11-02: solo does NOT require the oracle."""
    assert jr.SOLO_PIPELINE_IMPLEMENTED is True
    for cfg in (_cfg(), _cfg(oracle=True), _cfg(oracle=True, boot=True)):
        assert jr.resolve_job_routing(cfg, pipeline="solo").pipeline == "solo"
    auto = jr.resolve_job_routing(_cfg(pipeline_default="solo"))
    assert (auto.pipeline, auto.pipeline_requested) == ("solo", "auto")
    assert jr.resolve_job_routing(_cfg(pipeline_default="solo"), pipeline="chain").pipeline == (
        "chain"
    )


# --------------------------------------------------------------------------- #
# Spawn: resolved once, stamped on the story, refused before any story exists
# --------------------------------------------------------------------------- #


def _direction(frontmatter: dict[str, object]) -> Direction:
    return Direction(
        id="901",
        slug="route-me",
        title="Route me",
        type_tag=None,
        why="because",
        has_flow=False,
        has_api_spec=False,
        acceptance=[],
        explore_tag=False,
        artifacts_paths=[],
        app="sacrifice",
        status="pm-validated",
        raw_frontmatter={"title": "Route me", **frontmatter},
        raw_body="# Route me",
        dir_path=Path("."),
        state={"tracker_issue": 1},
    )


_PM = {
    "child_stories": [{"title": "do the thing", "scope": "backend", "points": 2}],
    "confidence": 0.9,
}


def test_spawn_stamps_pipeline_and_merged_overrides(tmp_path: Path) -> None:
    from factory.chain.handlers import handle_stories_spawned

    (tmp_path / "state").mkdir()
    stories = handle_stories_spawned(
        direction=_direction(
            {"models": {"dev": "anthropic/claude-sonnet-4-5"}, "pipeline": "auto"}
        ),
        pm_result=_PM,
        app_config=_cfg(models={"sm": "openrouter/x/sm"}),
        software_factory_root=tmp_path,
        dry_run=True,
    )
    assert len(stories) == 1
    s = stories[0]
    assert s.pipeline == "chain"
    assert json.loads(s.model_overrides_json or "{}") == {
        "dev": "anthropic/claude-sonnet-4-5",
        "sm": "openrouter/x/sm",
    }


def test_spawn_refuses_a_colliding_override_before_creating_stories(tmp_path: Path) -> None:
    from factory.chain.handlers import handle_stories_spawned

    (tmp_path / "state").mkdir()
    with pytest.raises(jr.JobRoutingError) as ei:
        handle_stories_spawned(
            direction=_direction({"models": {"reviewer": AZ_DEV}}),
            pm_result=_PM,
            app_config=_cfg(),
            software_factory_root=tmp_path,
            dry_run=True,
        )
    assert ei.value.code == "review_independence"


def test_spawn_refuses_solo_when_disabled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from factory.chain.handlers import handle_stories_spawned

    monkeypatch.setattr(jr, "SOLO_PIPELINE_IMPLEMENTED", False)
    (tmp_path / "state").mkdir()
    with pytest.raises(jr.JobRoutingError) as ei:
        handle_stories_spawned(
            direction=_direction({"pipeline": "solo"}),
            pm_result=_PM,
            app_config=_cfg(oracle=True, boot=True),
            software_factory_root=tmp_path,
            dry_run=True,
        )
    assert ei.value.code == "pipeline_unavailable"


def test_spawn_stamps_solo_without_the_oracle(tmp_path: Path) -> None:
    from factory.chain.handlers import handle_stories_spawned

    (tmp_path / "state").mkdir()
    stories = handle_stories_spawned(
        direction=_direction({"pipeline": "solo"}),
        pm_result=_PM,
        app_config=_cfg(),
        software_factory_root=tmp_path,
        dry_run=True,
    )
    assert [s.pipeline for s in stories] == ["solo"]


def test_handlers_route_from_the_story_stamp_not_live_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import factory.chain.handlers as handlers

    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak")
    story = StoryRecord(
        direction_id="901",
        app="sacrifice",
        title="t",
        slug="t",
        scope="backend",
        model_overrides_json=json.dumps({"dev": "anthropic/claude-sonnet-4-5"}),
    )
    assert handlers._route_for(story, "dev", "standard") == "anthropic/claude-sonnet-4-5"
    assert handlers._route_for(story, "reviewer") == AZ_REVIEWER
    bare = StoryRecord(direction_id="1", app="a", title="t", slug="t", scope="backend")
    assert handlers._route_for(bare, "dev") == AZ_DEV
    assert jr.route_for_story(story, "dev") == "anthropic/claude-sonnet-4-5"
    # Corrupt stamp degrades to routes.yaml, never crashes a handler.
    bare.model_overrides_json = "{not json"
    assert handlers._route_for(bare, "dev") == AZ_DEV


# --------------------------------------------------------------------------- #
# Triage: a bad routing request is refused before the PM call is paid for
# --------------------------------------------------------------------------- #


def test_pm_sync_refuses_bad_routing_before_pm(tmp_path: Path) -> None:
    import frontmatter

    from factory.chain.pm_sync import pm_sync
    from factory.directions.creator import create_direction

    app_dir = tmp_path / "apps" / "sacrifice"
    app_dir.mkdir(parents=True)
    (app_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: xvanov/sacrifice\nmodels: {}\n", encoding="utf-8"
    )
    for title in ("Healthz", "Colliding job"):
        create_direction(
            app="sacrifice",
            title=title,
            type_tag="feature",
            why="Smoke test wants a stable endpoint.",
            has_ui=False,
            flow_steps=None,
            has_api=True,
            api_spec_lines=['- `GET /healthz` -> 200 {"status":"ok"}'],
            acceptance=["Returns 200", "JSON body has status"],
            explore=False,
            attach_files=None,
            software_factory_root=tmp_path,
        )
    (bad,) = [p for p in (app_dir / "directions").glob("*colliding*/direction.md")]
    post = frontmatter.load(bad)
    post["models"] = {"reviewer": AZ_DEV}
    bad.write_text(frontmatter.dumps(post), encoding="utf-8")

    summary = pm_sync(
        "sacrifice", tmp_path, dry_run=True, state_db_path=tmp_path / "state" / "factory.db"
    )
    assert summary.validated == 1
    assert summary.needs_direction == 1
    assert any("job-routing[review_independence]" in msg for _, msg in summary.errors)
