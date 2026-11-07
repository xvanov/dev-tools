"""``factory on`` / ``factory off`` — the process-level kill switch.

Must be idempotent and correct from ANY starting state (active, inactive,
disabled, failed, half-up), and must shut down CLEANLY: timers first so no new
work starts, then drain an in-flight tick, then the daemons.

``systemctl`` is injected so these tests never touch real units.

Note on ``_SERVICE_UNITS``: production ``factory.power._SERVICE_UNITS`` is an
empty tuple since 2026-08-07 (the FMS L1 manager daemon it used to name was
deleted along with the other three LLM tiers — see ``factory.manager`` and
STATUS.md). power.py keeps its service-stop/service-start code path for a
future long-running service, so several tests here ``monkeypatch`` a fake
service name into ``_SERVICE_UNITS`` to keep that path under real coverage
without hardcoding a unit that no longer exists.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import factory.power as power_module
from factory.power import (
    discover_units,
    power_off,
    power_on,
    power_status,
    unit_state,
)

# A fake long-running service, injected into ``_SERVICE_UNITS`` by the tests
# that need to exercise power.py's service (not just timer) handling.
_FAKE_SERVICE = "fake-manager.service"

_INSTALLED = (
    "factory-tick@.timer\nfactory-tick@.service\n" + _FAKE_SERVICE + "\n"
    "factory-self-deploy.timer\nsacrifice-redeploy-main.timer\n"
)


@pytest.fixture
def root(tmp_path: Path) -> Path:
    for app in ("sacrifice", "factory"):
        d = tmp_path / "apps" / app
        d.mkdir(parents=True)
        (d / "config.yaml").write_text("name: x\nrepo: a/b\n", encoding="utf-8")
    return tmp_path


@pytest.fixture
def fake_service(monkeypatch: pytest.MonkeyPatch) -> str:
    """Inject one fake service unit into ``_SERVICE_UNITS`` for this test."""
    monkeypatch.setattr(power_module, "_SERVICE_UNITS", (_FAKE_SERVICE,))
    return _FAKE_SERVICE


class FakeSystemctl:
    """Records every systemctl invocation and serves scripted states."""

    def __init__(
        self,
        *,
        active: dict[str, str] | None = None,
        enabled: dict[str, str] | None = None,
        running_ticks: list[str] | None = None,
        unit_files: str = _INSTALLED,
        start_fails: set[str] | None = None,
    ) -> None:
        self.calls: list[list[str]] = []
        self.active = active or {}
        self.enabled = enabled or {}
        self.running_ticks = list(running_ticks or [])
        self.unit_files = unit_files
        self.start_fails = start_fails or set()

    def __call__(self, cmd: list[str]) -> subprocess.CompletedProcess[str]:
        self.calls.append(cmd)
        args = cmd[2:]  # strip ["systemctl", "--user"]
        verb = args[0] if args else ""
        target = args[1] if len(args) > 1 else ""

        if verb == "list-unit-files":
            return self._ok(self.unit_files)
        if verb == "list-units":
            return self._ok("\n".join(f"{t} loaded active running x" for t in self.running_ticks))
        if verb == "is-active":
            return self._ok(self.active.get(target, "inactive"))
        if verb == "is-enabled":
            if target in self.enabled:
                return self._ok(self.enabled[target])
            # Real systemctl reports ``not-found`` (exit 4) for a unit it does not
            # know about — model that, so ``UnitState.installed`` is exercised
            # faithfully rather than every unknown unit looking merely disabled.
            return self._ok("disabled" if self._is_installed(target) else "not-found")
        if verb == "stop":
            self.active[target] = "inactive"
            self.running_ticks = [t for t in self.running_ticks if t != target]
            return self._ok("")
        if verb == "disable":
            self.enabled[target] = "disabled"
            return self._ok("")
        if verb == "enable":
            self.enabled[target] = "enabled"
            return self._ok("")
        if verb == "start":
            if target in self.start_fails:
                return subprocess.CompletedProcess(cmd, 1, "", f"{target} boom")
            self.active[target] = "active"
            return self._ok("")
        if verb == "reset-failed":
            if self.active.get(target) == "failed":
                self.active[target] = "inactive"
            return self._ok("")
        return self._ok("")

    def _is_installed(self, unit: str) -> bool:
        """Mirror systemd's template rule: ``foo@bar.service`` ← ``foo@.service``."""
        names = set(self.unit_files.split())
        if unit in names:
            return True
        if "@" in unit:
            base, _, suffix = unit.partition("@")
            return f"{base}@.{suffix.rsplit('.', 1)[-1]}" in names
        return False

    @staticmethod
    def _ok(out: str) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(["x"], 0, out, "")

    def verbs_for(self, unit: str) -> list[str]:
        return [c[2] for c in self.calls if len(c) > 3 and c[3] == unit]

    def order_of(self, verb: str) -> list[str]:
        return [c[3] for c in self.calls if len(c) > 3 and c[2] == verb]


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #


def test_discovers_per_app_and_global_units(root: Path, fake_service: str) -> None:
    fake = FakeSystemctl()
    names = {u.name for u in discover_units(root=root, runner=fake)}
    assert "factory-tick@sacrifice.timer" in names
    assert "factory-tick@factory.timer" in names, "per-app units come from apps/*/config.yaml"
    assert fake_service in names
    assert "factory-self-deploy.timer" in names
    assert "sacrifice-redeploy-main.timer" in names


def test_discovers_only_timers_when_no_service_units_registered(root: Path) -> None:
    """Production default: ``_SERVICE_UNITS`` is empty, so no service unit is ever
    a candidate — half-up detection still works with timers alone."""
    fake = FakeSystemctl()
    units = discover_units(root=root, runner=fake)
    assert all(u.kind == "timer" for u in units)
    assert {u.name for u in units} == {
        "factory-tick@sacrifice.timer",
        "factory-tick@factory.timer",
        "factory-self-deploy.timer",
        "sacrifice-redeploy-main.timer",
    }


def test_uninstalled_units_are_skipped(root: Path) -> None:
    """A machine without an optional unit must not error on it."""
    fake = FakeSystemctl(unit_files="factory-tick@.timer\n")
    names = {u.name for u in discover_units(root=root, runner=fake)}
    assert names == {"factory-tick@sacrifice.timer", "factory-tick@factory.timer"}


def test_no_units_installed_is_not_an_error(tmp_path: Path) -> None:
    fake = FakeSystemctl(unit_files="")
    assert discover_units(root=tmp_path, runner=fake) == []
    assert power_status(root=tmp_path, runner=fake) == []


# --------------------------------------------------------------------------- #
# off
# --------------------------------------------------------------------------- #


def test_off_stops_timers_before_services(root: Path, fake_service: str) -> None:
    """Order is the whole point: no new work may start while we drain."""
    fake = FakeSystemctl(active={fake_service: "active"})
    power_off(root=root, runner=fake, wait=False)

    stops = fake.order_of("stop")
    assert fake_service in stops
    service_at = stops.index(fake_service)
    timer_idxs = [i for i, n in enumerate(stops) if n.endswith(".timer")]
    assert timer_idxs, "timers should have been stopped"
    assert max(timer_idxs) < service_at, "every timer must stop before the daemon"


def test_off_is_idempotent_when_already_off(root: Path) -> None:
    fake = FakeSystemctl()
    report = power_off(root=root, runner=fake, wait=False)
    assert report["already_off"] is True
    assert not [s for s in report["units"] if s.running]


def test_off_clears_sticky_failed_state(root: Path, fake_service: str) -> None:
    """A unit left ``failed`` must read ``inactive`` afterwards, not ``failed``."""
    fake = FakeSystemctl(active={fake_service: "failed"})
    report = power_off(root=root, runner=fake, wait=False)
    assert "reset-failed" in fake.verbs_for(fake_service)
    states = {s.name: s.active for s in report["units"]}
    assert states[fake_service] == "inactive"


def test_off_waits_for_inflight_tick_then_confirms_stopped(root: Path) -> None:
    fake = FakeSystemctl(running_ticks=["factory-tick@sacrifice.service"])
    slept: list[float] = []

    def _sleep(s: float) -> None:
        slept.append(s)
        fake.running_ticks = []  # the tick finishes on its own

    report = power_off(root=root, runner=fake, wait=True, sleep=_sleep)

    assert slept, "should have waited for the in-flight tick"
    assert report["drained"] == ["factory-tick@sacrifice.service"]
    assert report["drain_timed_out"] is False


def test_off_now_does_not_wait_but_still_stops_the_tick(root: Path) -> None:
    fake = FakeSystemctl(running_ticks=["factory-tick@sacrifice.service"])
    slept: list[float] = []
    report = power_off(root=root, runner=fake, wait=False, sleep=lambda s: slept.append(s))

    assert slept == [], "--now must not wait"
    assert "factory-tick@sacrifice.service" in fake.order_of("stop")
    assert report["drained"] == []


def test_off_reports_drain_timeout_and_stops_anyway(root: Path) -> None:
    """A tick that never finishes must not hang the command forever."""
    fake = FakeSystemctl(running_ticks=["factory-tick@sacrifice.service"])
    report = power_off(
        root=root, runner=fake, wait=True, drain_timeout_s=4, sleep=lambda _s: None
    )
    assert report["drain_timed_out"] is True
    assert "factory-tick@sacrifice.service" in fake.order_of("stop")
    assert not [s for s in report["units"] if s.running]


def test_off_disables_so_a_reboot_does_not_restart_it(root: Path) -> None:
    fake = FakeSystemctl(enabled={"factory-tick@sacrifice.timer": "enabled"})
    report = power_off(root=root, runner=fake, wait=False)
    assert "disable" in fake.verbs_for("factory-tick@sacrifice.timer")
    assert all(s.enabled != "enabled" for s in report["units"])


# --------------------------------------------------------------------------- #
# on
# --------------------------------------------------------------------------- #


def test_on_starts_services_before_timers(root: Path, fake_service: str) -> None:
    """A long-running service should be watching before the ticks that feed it."""
    fake = FakeSystemctl()
    power_on(root=root, runner=fake)

    starts = fake.order_of("start")
    assert fake_service in starts
    svc_at = starts.index(fake_service)
    timer_idxs = [i for i, n in enumerate(starts) if n.endswith(".timer")]
    assert min(timer_idxs) > svc_at


def test_on_recovers_from_failed_state(root: Path, fake_service: str) -> None:
    """The 'it won't come back up' case: a failed unit must still start."""
    fake = FakeSystemctl(active={fake_service: "failed"})
    report = power_on(root=root, runner=fake)

    verbs = fake.verbs_for(fake_service)
    assert verbs.index("reset-failed") < verbs.index("start"), "must clear failure BEFORE starting"
    assert report["failed"] == []
    assert all(s.running for s in report["units"])


def test_on_is_idempotent_when_already_on(root: Path, fake_service: str) -> None:
    fake = FakeSystemctl(
        active={
            fake_service: "active",
            "factory-tick@sacrifice.timer": "active",
            "factory-tick@factory.timer": "active",
            "factory-self-deploy.timer": "active",
            "sacrifice-redeploy-main.timer": "active",
        }
    )
    report = power_on(root=root, runner=fake)
    assert report["already_on"] is True
    assert all(s.running for s in report["units"])


def test_on_reports_a_unit_that_refuses_to_start(root: Path, fake_service: str) -> None:
    fake = FakeSystemctl(start_fails={fake_service})
    report = power_on(root=root, runner=fake)
    assert [n for n, _ in report["failed"]] == [fake_service]
    assert "boom" in report["failed"][0][1]


def test_off_then_on_round_trips(root: Path, fake_service: str) -> None:
    fake = FakeSystemctl(
        active={fake_service: "active", "factory-tick@sacrifice.timer": "active"}
    )
    off = power_off(root=root, runner=fake, wait=False)
    assert not [s for s in off["units"] if s.running]

    on = power_on(root=root, runner=fake)
    assert on["failed"] == []
    assert all(s.running for s in on["units"])
    assert all(s.enabled == "enabled" for s in on["units"])


def test_half_up_state_is_visible(root: Path, fake_service: str) -> None:
    fake = FakeSystemctl(active={fake_service: "active"})
    states = power_status(root=root, runner=fake)
    running = [s for s in states if s.running]
    assert len(running) == 1 and len(states) > 1, "half-up must be distinguishable from on/off"


def test_unit_state_never_raises_on_unknown_unit(root: Path) -> None:
    fake = FakeSystemctl(enabled={}, active={})
    st = unit_state("does-not-exist.service", runner=fake)
    assert st.installed is False
    assert st.running is False
