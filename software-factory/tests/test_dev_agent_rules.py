"""The API dev agent's working rules (job dev-tools:013, 2026-11-08).

That run's agent ran test files one by one instead of the gate's command, hung
PowerShell four times on multi-line quoted arguments, then committed with
``--no-verify``, pushed and opened a draft PR itself.
"""

from __future__ import annotations

from factory import runner
from factory.chain import solo
from factory.personas.loader import read_persona_prompt


def test_solo_brief_names_the_gate_test_command() -> None:
    brief = solo.build_solo_brief(None, test_command="node scripts/gate-changed.js")
    assert "`node scripts/gate-changed.js`" in brief
    assert "one by one" in brief


def test_solo_brief_without_a_test_command_names_none() -> None:
    assert "The test command is" not in solo.build_solo_brief(None)


def test_windows_terminal_rules_forbid_multiline_quoted_arguments() -> None:
    rules = runner._terminal_rules("win32")
    assert "PowerShell" in rules
    assert "git commit -F" in rules
    assert "python -c" in rules and "node -e" in rules


def test_no_terminal_rules_off_windows() -> None:
    assert runner._terminal_rules("linux") == ""
    assert runner._terminal_rules("darwin") == ""


def test_dev_persona_leaves_delivery_to_the_factory() -> None:
    text = read_persona_prompt("dev")
    assert "never `git push`" in text
    assert "--no-verify" in text
