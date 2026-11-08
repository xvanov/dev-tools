"""E6.1: the API runtime's terminal refuses what the dev prompt forbids.

Evidence: dev-tools:017's dev step (deepseek-v4-pro on Windows) hung
PowerShell at ``>>`` with a multi-line ``git commit -m``, then committed with
``--no-verify``; dev-tools:013's pushed and opened a PR itself.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from factory import terminal_guard as tg
from factory.terminal_guard import (
    BASH,
    POWERSHELL,
    check_command,
    check_input,
    is_continuation_prompt,
)

# The command dev-tools:017 sent (shortened), as the model wrote it.
EVIDENCE_COMMIT = (
    'cd "C:\\Users\\u\\AppData\\Local\\software-factory\\state\\worktrees\\dev-tools-59" ; '
    "git add personal-assistant/src/cli/version.ts ; "
    'git commit -m "feat: add pa version CLI verb\n\n- Add resolveVersion()\n\nCo-authored-by: openhands" 2>&1'
)

MULTILINE = [
    EVIDENCE_COMMIT,
    'node -e "const a = 1;\nconsole.log(a)"',
    "python -c \"import sys\nprint(sys.version)\"",
    "echo 'a\nb'",
]


@pytest.mark.parametrize("shell", [POWERSHELL, BASH])
@pytest.mark.parametrize("command", MULTILINE)
def test_a_newline_inside_a_quoted_argument_is_refused(shell, command):
    msg = check_command(command, shell=shell)
    assert msg is not None and "nothing ran" in msg
    assert "-F <message file>" in msg and "run the file" in msg


@pytest.mark.parametrize(
    "command",
    [
        'cd "C:\\Users\\u\\wt" ; git add a b ; git commit -m "feat: add pa version verb" 2>&1',
        "git --no-pager log --oneline -3 2>&1",
        "Get-ChildItem -Recurse | Select-Object -First 3",
        "Write-Output 'it''s fine'",
        'Write-Output "a `"quoted`" word"',
        "if (Test-Path x) { Remove-Item x }",
        "git commit -F .git/MSG.txt",
        "npm test -- --changed # a comment with a ' quote",
    ],
)
def test_ordinary_powershell_commands_run(command):
    assert check_command(command, shell=POWERSHELL) is None


@pytest.mark.parametrize(
    "command, why",
    [
        ("git status\ngit diff", "newline"),
        ('git commit -m "unterminated', "unterminated quote"),
        ("foreach ($x in 1..3) {", "unclosed bracket"),
        ("Get-ChildItem |", "pipe or a backtick"),
    ],
)
def test_powershell_refuses_what_would_wait_at_the_continuation_prompt(command, why):
    msg = check_command(command, shell=POWERSHELL)
    assert msg is not None and why in msg


@pytest.mark.parametrize(
    "command",
    [
        "cat > notes.md <<'EOF'\nit's a note with \"quotes\"\nEOF",
        "cat <<-EOF > f\n\tdon't\n\tEOF\necho done",
        "for i in 1 2; do\n  echo $i\ndone",
        "# don't\necho hi",
        "printf $'a\\nb'",
        'git commit -m "one line" && git log -1',
        "grep -rn 'x' . <<< \"$y\"",
    ],
)
def test_ordinary_bash_commands_run(command):
    assert check_command(command, shell=BASH) is None


@pytest.mark.parametrize("shell", [POWERSHELL, BASH])
@pytest.mark.parametrize(
    "command, what",
    [
        ('git commit --no-verify -m "feat: x"', "--no-verify"),
        ("git commit -nm 'feat: x'", "git commit -n"),
        ("git commit -a -n -m x", "git commit -n"),
        ("git -c core.hooksPath=/dev/null commit -m x", "core.hooksPath"),
        ("git config core.hooksPath .nohooks", "core.hooksPath"),
        ("$env:DEVTOOLS_SKIP_TESTS=1; git commit -m x", "DEVTOOLS_SKIP_TESTS"),
        ("DEVTOOLS_SKIP_TESTS=1 git commit -m x", "DEVTOOLS_SKIP_TESTS"),
    ],
)
def test_skipping_the_hooks_is_refused(shell, command, what):
    msg = check_command(command, shell=shell)
    assert msg is not None and f"`{what}`" in msg and "hooks must run" in msg


@pytest.mark.parametrize("shell", [POWERSHELL, BASH])
@pytest.mark.parametrize(
    "command",
    [
        "git push -u origin HEAD",
        'git -C "C:\\wt" push origin factory/story-59',
        "& git.exe push",
        "cd wt && git push --force-with-lease",
        "git status; git push",
        'bash -c "git push origin x"',
        "pwsh -NoProfile -Command \"git push\"",
        "python -c \"import os; os.system('git push')\"",
        "gh pr create --fill --draft",
        "gh pr merge 43 --squash",
        "gh -R xvanov/dev-tools pr comment 43 -b done",
        "gh pr edit 43 --title x",
        "gh api -X POST repos/o/r/pulls",
        "gh api repos/o/r/pulls -f title=x -f head=b",
        "gh api --method=PATCH repos/o/r/pulls/1",
        "gh api graphql -F query=@q.graphql",
    ],
)
def test_delivery_is_refused(shell, command):
    msg = check_command(command, shell=shell)
    assert msg is not None and "delivery" in msg and "factory's job" in msg


@pytest.mark.parametrize("shell", [POWERSHELL, BASH])
@pytest.mark.parametrize(
    "command",
    [
        "git log --grep push --oneline",
        'git commit -m "fix: git push timeout in the runner"',
        "git commit -m -n",
        "git commit -am 'feat: x'",
        "git fetch origin && git rebase origin/main",
        "gh pr view 43 --json state",
        "gh pr checks 43",
        "gh pr list --state open",
        "gh api repos/o/r/pulls/43",
        "gh api -X GET search/issues -f q=is:pr",
        "echo pushed",
    ],
)
def test_reads_and_local_git_run(shell, command):
    assert check_command(command, shell=shell) is None


def test_input_to_a_running_process_keeps_the_delivery_rules_only():
    assert check_input("y\nn", shell=POWERSHELL) is None
    assert check_input("C-c", shell=POWERSHELL) is None
    assert check_input("git push", shell=BASH) is not None


@pytest.mark.parametrize(
    "output, expected",
    [
        ("...; $global:LASTEXITCODE = $null\n>>", True),
        ("git commit -m \"a\n>> \n>> b\n>> ", True),
        ("\r\n>> \r\n", True),
        ("a >> b", False),
        ("Write-Output x >> log.txt\nok", False),
        ("", False),
    ],
)
def test_continuation_prompt(output, expected):
    assert is_continuation_prompt(output) is expected


# --------------------------------------------------------------------------
# The executor
# --------------------------------------------------------------------------


class FakeInner:
    is_pooled = False

    def __init__(self, observation: Any) -> None:
        self.observation = observation
        self.calls: list[Any] = []
        self.resets = 0
        self.closed = False

    def __call__(self, action: Any, conversation: Any = None) -> Any:
        self.calls.append(action)
        return self.observation

    def reset(self) -> Any:
        self.resets += 1

    def close(self) -> None:
        self.closed = True


def _obs(text: str, exit_code: int) -> Any:
    from openhands.tools.terminal.definition import TerminalObservation
    from openhands.tools.terminal.metadata import CmdOutputMetadata

    return TerminalObservation.from_text(text=text, command="c", metadata=CmdOutputMetadata(exit_code=exit_code))


def _action(command: str, **kw: Any) -> Any:
    from openhands.tools.terminal.definition import TerminalAction

    return TerminalAction(command=command, **kw)


def test_a_refused_command_never_reaches_the_shell():
    inner = FakeInner(_obs("ok", 0))
    ex = tg.GuardedExecutor(inner, shell=POWERSHELL)
    obs = ex(_action(EVIDENCE_COMMIT))
    assert inner.calls == [] and obs.is_error and "-F <message file>" in obs.text
    obs = ex(_action("git push", is_input=True))
    assert inner.calls == [] and obs.is_error and "delivery" in obs.text


def test_an_allowed_command_runs_unchanged():
    ok = _obs("ok", 0)
    inner = FakeInner(ok)
    ex = tg.GuardedExecutor(inner, shell=POWERSHELL)
    assert ex(_action("git status")) is ok
    assert len(inner.calls) == 1 and inner.resets == 0


def test_powershell_at_the_continuation_prompt_is_reset_at_once():
    inner = FakeInner(_obs("Write-Output 1,; $oh1 = $?\n>> ", -1))
    obs = tg.GuardedExecutor(inner, shell=POWERSHELL)(_action("Write-Output 1,", timeout=120))
    assert inner.resets == 1 and obs.is_error and "reset the terminal" in obs.text


def test_continuation_detection_is_powershell_only_and_needs_a_running_command():
    inner = FakeInner(_obs("x\n>>", -1))
    tg.GuardedExecutor(inner, shell=BASH)(_action("cat"))
    inner2 = FakeInner(_obs("x\n>>", 0))
    tg.GuardedExecutor(inner2, shell=POWERSHELL)(_action("Write-Output x"))
    assert inner.resets == 0 and inner2.resets == 0


def test_the_wrapper_forwards_the_executor_surface():
    inner = FakeInner(_obs("ok", 0))
    inner.working_dir = "/wt"  # type: ignore[attr-defined]
    ex = tg.GuardedExecutor(inner, shell=BASH)
    assert ex.working_dir == "/wt" and ex.is_pooled is False
    ex.close()
    assert inner.closed


# --------------------------------------------------------------------------
# Wiring into an OpenHands agent
# --------------------------------------------------------------------------


class FakeAgent:
    def __init__(self, tools: list[Any]) -> None:
        self.tools = tools

    def model_copy(self, update: dict[str, Any]) -> FakeAgent:
        return FakeAgent(update["tools"])


def test_guard_terminal_swaps_only_the_terminal_spec_and_keeps_its_params():
    from openhands.sdk import Tool

    agent = FakeAgent([Tool(name="terminal", params={"terminal_type": "subprocess", "shell_path": "/x"}), Tool(name="file_editor")])
    out = tg.guard_terminal(agent)
    names = [t.name for t in out.tools]
    assert names == [tg.GUARDED_TOOL, "file_editor"]
    assert out.tools[0].params == {"terminal_type": "subprocess", "shell_path": "/x"}


def test_guard_terminal_leaves_a_toolless_agent_alone():
    agent = object()
    assert tg.guard_terminal(agent) is agent


def test_the_default_agent_gets_the_guarded_terminal():
    from openhands.sdk import LLM
    from openhands.tools.preset.default import get_default_agent
    from pydantic import SecretStr

    agent = get_default_agent(llm=LLM(model="openai/x", api_key=SecretStr("k"), usage_id="t"), cli_mode=True)
    assert "terminal" in [t.name for t in agent.tools]
    guarded = tg.guard_terminal(agent)
    assert tg.GUARDED_TOOL in [t.name for t in guarded.tools]
    assert "terminal" not in [t.name for t in guarded.tools]


def _resolve(tmp_path: Path) -> Any:
    from openhands.sdk import Tool
    from openhands.sdk.tool.registry import resolve_tool

    tg._register()
    params: dict[str, Any] = {} if sys.platform == "win32" else {"terminal_type": "subprocess"}
    conv_state = SimpleNamespace(workspace=SimpleNamespace(working_dir=str(tmp_path)), env_observation_persistence_dir=None)
    (tool,) = resolve_tool(Tool(name=tg.GUARDED_TOOL, params=params), conv_state)  # type: ignore[arg-type]
    return tool


def test_the_resolved_tool_is_still_called_terminal_and_refuses(tmp_path):
    tool = _resolve(tmp_path)
    try:
        assert tool.name == "terminal"
        assert isinstance(tool.executor, tg.GuardedExecutor)
        obs = tool(_action("git push origin HEAD"))
        assert obs.is_error and "delivery" in obs.text
        obs = tool(_action("echo guarded-ok"))
        assert not obs.is_error and "guarded-ok" in obs.text
    finally:
        tool.executor.close()


@pytest.mark.skipif(sys.platform != "win32", reason="PowerShell backend")
def test_real_powershell_continuation_is_reset_and_the_terminal_recovers(tmp_path, monkeypatch):
    tool = _resolve(tmp_path)
    try:
        assert tool.executor.shell == POWERSHELL
        # Without the pre-check, the dev-tools:017 shape reaches PowerShell and hangs at `>>`.
        monkeypatch.setattr(tg, "check_command", lambda *_a, **_k: None)
        obs = tool(_action('Write-Output "line1\n\nline2"', timeout=3))
        assert obs.is_error and "reset the terminal" in obs.text
        obs = tool(_action("Write-Output recovered", timeout=20))
        assert not obs.is_error and "recovered" in obs.text
    finally:
        tool.executor.close()
