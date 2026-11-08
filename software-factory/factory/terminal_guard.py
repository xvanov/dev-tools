"""Deterministic guard on the API runtime's terminal (E6.1).

The API dev agent (OpenHands, DeepSeek) broke rules its prompt states plainly
(73e824d): on Windows it sent ``git commit -m "line1\\n\\nline2"`` and
multi-line ``python -c`` / ``node -e`` scripts to PowerShell, which then sat at
a ``>>`` continuation prompt for minutes until a terminal reset (Ctrl-C did
not clear it); it then committed with ``--no-verify`` because it took the hang
for a slow hook, and once (dev-tools:013) pushed its branch and opened a PR
with ``gh`` itself. A prompt cannot hold that, so the terminal refuses:

* a newline inside a quoted argument (PowerShell: any newline, and an
  unterminated quote or bracket), with an error that says to write a file;
* ``--no-verify``, ``git commit -n``, ``core.hooksPath`` and
  ``DEVTOOLS_SKIP_TESTS``: the repo's hooks must run;
* ``git push``, ``gh pr`` writes and ``gh api`` writes: delivery is the
  factory's job.

:func:`check_command` is the pure rule. :func:`guard_terminal` swaps the
agent's ``terminal`` tool for one whose executor applies it before a command
reaches the shell, and on PowerShell resets the session when an observation
shows it waiting at ``>>``. Only the API runtime builds OpenHands agents, so
``claude_session`` runs never see it.
"""

from __future__ import annotations

import re
import shlex
import sys
from typing import Any

POWERSHELL = "powershell"
BASH = "bash"

#: The registry name of the guarded tool spec. The model still sees ``terminal``.
GUARDED_TOOL = "factory_guarded_terminal"

_REFUSED = "Refused by the factory before it reached the shell; nothing ran."

MULTILINE_MESSAGE = (
    f"{_REFUSED} {{what}} A newline inside a quoted argument hangs this terminal "
    "(PowerShell waits at a `>>` continuation prompt). Write the text to a file "
    "and pass the file instead: `git commit -F <message file>` for a commit message, "
    "and for a script longer than one line write it to a file and run the file "
    "(`python <file>.py`, `node <file>.js`) instead of `python -c` or `node -e`."
)

HOOKS_MESSAGE = (
    f"{_REFUSED} `{{what}}` skips the repository's git hooks. The hooks must run: if a "
    "hook fails, fix what it reports and commit again. If a commit seems to hang, the "
    "terminal is most likely waiting at a `>>` prompt, not the hook."
)

DELIVERY_MESSAGE = (
    f"{_REFUSED} `{{what}}` is delivery, and delivery (pushing the branch, opening or "
    "changing pull requests, writing through the GitHub API) is the factory's job. "
    "Commit your work on the current branch and stop; the factory pushes and opens "
    "the pull request."
)

CONTINUATION_MESSAGE = (
    "PowerShell was waiting at a `>>` continuation prompt (an unclosed quote or "
    "bracket, a newline inside a quoted argument, or a trailing pipe or backtick), "
    "so the factory reset the terminal: the command did not run, and the working "
    "directory and environment variables are back to their defaults. Send the "
    "command again on one line with balanced quotes, or write it to a script file "
    "and run the file; for a commit message use `git commit -F <message file>`."
)

_HOOK_SKIPS = (
    (re.compile(r"--no-verify\b", re.IGNORECASE), "--no-verify"),
    (re.compile(r"core\.hooksPath", re.IGNORECASE), "core.hooksPath"),
    (re.compile(r"\bDEVTOOLS_SKIP_TESTS\b", re.IGNORECASE), "DEVTOOLS_SKIP_TESTS"),
)

#: ``gh pr`` subcommands that only read.
_GH_PR_READS = frozenset({"view", "list", "status", "checks", "diff", "checkout"})
#: ``gh api`` flags that send a body, which makes the default method POST.
_GH_API_BODY_FLAGS = frozenset({"-f", "-F", "--field", "--raw-field", "--input"})
#: git options before the subcommand that take a separate value.
_GIT_VALUE_OPTS = frozenset({"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"})
#: ``git commit`` short options that take a value (the rest of the cluster or the next word).
_COMMIT_VALUE_SHORTS = frozenset("mFCctS")
#: Leading words that run the next word as the command.
_WRAPPERS = frozenset({"env", "sudo", "command", "exec", "nohup", "time", "call", "start", "start-process", "&", "."})
#: Flags whose value is a script another interpreter runs (checked recursively).
_SCRIPT_FLAGS = frozenset({"-c", "-command", "/c", "/k", "-e", "--eval", "-encodedcommand"})
_SEPARATORS = frozenset({";", "&&", "||", "|", "&", "(", ")", "\n"})


def check_command(command: str, *, shell: str) -> str | None:
    """The refusal message for ``command`` in ``shell``, or ``None`` when it may run."""
    if not command.strip():
        return None
    refusal = _delivery_refusal(command, shell)
    if refusal is not None:
        return refusal
    what = _powershell_continuation(command) if shell == POWERSHELL else _bash_quoted_newline(command)
    return MULTILINE_MESSAGE.format(what=what) if what else None


def check_input(text: str, *, shell: str) -> str | None:
    """Like :func:`check_command` for text sent to a running process (``is_input``).

    Only the delivery and hook rules: the text may answer a prompt, so
    newlines are not refused, but a shell at its prompt would still run it.
    """
    if not text.strip():
        return None
    return _delivery_refusal(text, shell)


def is_continuation_prompt(output: str) -> bool:
    """True when PowerShell's last output line is its ``>>`` continuation prompt."""
    lines = [ln.rstrip() for ln in output.replace("\r", "").split("\n")]
    lines = [ln for ln in lines if ln]
    return bool(lines) and lines[-1] == ">>"


# --------------------------------------------------------------------------
# Delivery and hook rules
# --------------------------------------------------------------------------


def _delivery_refusal(command: str, shell: str, depth: int = 0) -> str | None:
    for pattern, what in _HOOK_SKIPS:
        if pattern.search(command):
            return HOOKS_MESSAGE.format(what=what)
    for words in _simple_commands(command, shell):
        refusal = _refusal_for(words, shell, depth)
        if refusal is not None:
            return refusal
    return None


def _refusal_for(words: list[str], shell: str, depth: int) -> str | None:
    words = _strip_wrappers(words)
    if not words:
        return None
    prog = _program(words[0])
    if prog == "git":
        return _git_refusal(words[1:])
    if prog == "gh":
        return _gh_refusal(words[1:])
    if depth >= 3:
        return None
    # A script handed to another interpreter (bash -c, pwsh -Command, cmd /c,
    # python -c, node -e) can push too: check every string in it.
    for i, word in enumerate(words[1:-1], start=1):
        if word.lower() in _SCRIPT_FLAGS:
            script = words[i + 1]
            refusal = _delivery_refusal(script, shell, depth + 1)
            if refusal is None and depth == 0:
                for literal in _string_literals(script):
                    refusal = _delivery_refusal(literal, shell, depth + 1)
                    if refusal is not None:
                        break
            if refusal is not None:
                return refusal
    return None


def _git_refusal(args: list[str]) -> str | None:
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in _GIT_VALUE_OPTS else 1
    if i >= len(args):
        return None
    sub, rest = args[i].lower(), args[i + 1 :]
    if sub == "push":
        return DELIVERY_MESSAGE.format(what="git push")
    if sub == "commit" and _commit_skips_hooks(rest):
        return HOOKS_MESSAGE.format(what="git commit -n")
    return None


def _commit_skips_hooks(args: list[str]) -> bool:
    """``-n`` (``--no-verify``) in ``git commit``'s short options."""
    skip_next = False
    for arg in args:
        if skip_next:
            skip_next = False
            continue
        if arg == "--":
            return False
        if not arg.startswith("-") or arg.startswith("--") or len(arg) < 2:
            continue
        for j, ch in enumerate(arg[1:]):
            if ch == "n":
                return True
            if ch in _COMMIT_VALUE_SHORTS:
                skip_next = j == len(arg) - 2
                break
    return False


def _gh_refusal(args: list[str]) -> str | None:
    words = list(args)
    # Global flags before the command group (-R/--repo take a value).
    while words and words[0].startswith("-"):
        words = words[2:] if words[0] in ("-R", "--repo") else words[1:]
    if not words:
        return None
    group, rest = words[0].lower(), words[1:]
    if group == "pr":
        sub = next((w.lower() for w in rest if not w.startswith("-")), "")
        if sub and sub not in _GH_PR_READS:
            return DELIVERY_MESSAGE.format(what=f"gh pr {sub}")
        return None
    if group == "api" and _gh_api_method(rest) != "GET":
        return DELIVERY_MESSAGE.format(what="gh api (a write)")
    return None


def _gh_api_method(args: list[str]) -> str:
    method: str | None = None
    has_body = False
    for i, arg in enumerate(args):
        low = arg.lower()
        if arg in ("-X", "--method") and i + 1 < len(args):
            method = args[i + 1]
        elif low.startswith("--method="):
            method = arg.split("=", 1)[1]
        elif arg.startswith("-X") and len(arg) > 2:
            method = arg[2:]
        elif arg in _GH_API_BODY_FLAGS or any(arg.startswith(f + "=") for f in _GH_API_BODY_FLAGS if f.startswith("--")):
            has_body = True
    if method is None:
        return "POST" if has_body else "GET"
    return method.strip().upper()


def _strip_wrappers(words: list[str]) -> list[str]:
    i = 0
    while i < len(words):
        w = words[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w) or w.lower() in _WRAPPERS:
            i += 1
            continue
        break
    return words[i:]


def _program(word: str) -> str:
    name = re.split(r"[\\/]", word)[-1].lower()
    for ext in (".exe", ".cmd", ".bat"):
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


def _simple_commands(command: str, shell: str) -> list[list[str]]:
    """``command`` split into simple commands (word lists) on ``; && || | & ( )`` and newlines."""
    lexer = shlex.shlex(command.replace("\r", ""), posix=True, punctuation_chars=";&|()\n")
    lexer.whitespace = " \t"
    lexer.whitespace_split = True
    lexer.commenters = ""
    if shell == POWERSHELL:
        lexer.escape = "`"
    tokens: list[str] = []
    try:
        for tok in lexer:
            tokens.append(tok)
    except ValueError:
        # An unterminated quote: fall back to a plain split, which still sees
        # the command words before the quote.
        tokens = re.findall(r"[;&|()\n]+|[^\s;&|()]+", command.replace('"', " ").replace("'", " "))
    commands: list[list[str]] = []
    current: list[str] = []
    for tok in tokens:
        if tok in _SEPARATORS or (tok and set(tok) <= set(";&|()\n")):
            if current:
                commands.append(current)
            current = []
        else:
            current.append(tok)
    if current:
        commands.append(current)
    return commands


def _string_literals(script: str) -> list[str]:
    return [m.group(2) for m in re.finditer(r"(['\"])(.*?)\1", script, re.DOTALL)]


# --------------------------------------------------------------------------
# Multi-line rules
# --------------------------------------------------------------------------

_PS_SINGLE = "'\u2018\u2019\u201a\u201b"
_PS_DOUBLE = '"\u201c\u201d\u201e'


def _powershell_continuation(command: str) -> str | None:
    """Why PowerShell would wait at ``>>`` for ``command`` (``None`` when it would not)."""
    if "\n" in command or "\r" in command:
        return "This command has a newline in it; send PowerShell one line."
    quote: str | None = None
    depth = 0
    i = 0
    while i < len(command):
        ch = command[i]
        if quote == "'":
            if ch in _PS_SINGLE:
                if i + 1 < len(command) and command[i + 1] in _PS_SINGLE:
                    i += 1
                else:
                    quote = None
        elif quote == '"':
            if ch == "`":
                i += 1
            elif ch in _PS_DOUBLE:
                if i + 1 < len(command) and command[i + 1] in _PS_DOUBLE:
                    i += 1
                else:
                    quote = None
        elif ch == "`":
            i += 1
        elif ch in _PS_SINGLE:
            quote = "'"
        elif ch in _PS_DOUBLE:
            quote = '"'
        elif ch == "#" and (i == 0 or command[i - 1] in " \t;"):
            break
        elif ch in "({[":
            depth += 1
        elif ch in ")}]":
            depth -= 1
        i += 1
    if quote is not None:
        return "This command has an unterminated quote."
    if depth > 0:
        return "This command has an unclosed bracket."
    if command.rstrip().endswith(("|", "`")):
        return "This command ends in a pipe or a backtick."
    return None


_HEREDOC = re.compile(r"<<(-?)[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")


def _bash_quoted_newline(command: str) -> str | None:
    """Why bash would read ``command`` across lines inside a quote (``None`` when it would not).

    Here-documents are fine (their bodies are not quoted arguments) and are skipped.
    """
    quote: str | None = None
    heredocs: list[tuple[str, bool]] = []
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if quote == "'":
            if ch == "'":
                quote = None
            elif ch == "\n":
                return "This command has a newline inside a quoted argument."
        elif quote in ('"', "$'"):
            if ch == "\\":
                i += 1
            elif (quote == '"' and ch == '"') or (quote == "$'" and ch == "'"):
                quote = None
            elif ch == "\n":
                return "This command has a newline inside a quoted argument."
        elif ch == "\\":
            i += 1
        elif ch == "$" and i + 1 < n and command[i + 1] == "'":
            quote = "$'"
            i += 1
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or command[i - 1] in " \t\n;&|("):
            while i < n and command[i] != "\n":
                i += 1
            continue
        elif ch == "<" and command.startswith("<<", i) and not command.startswith("<<<", i):
            m = _HEREDOC.match(command, i)
            if m:
                heredocs.append((m.group(3), m.group(1) == "-"))
                i = m.end()
                continue
        elif ch == "\n" and heredocs:
            i = _skip_heredoc_bodies(command, i + 1, heredocs)
            heredocs = []
            continue
        i += 1
    if quote is not None:
        return "This command has an unterminated quote."
    return None


def _skip_heredoc_bodies(command: str, i: int, heredocs: list[tuple[str, bool]]) -> int:
    for word, strip_tabs in heredocs:
        while i < len(command):
            end = command.find("\n", i)
            line = command[i:] if end == -1 else command[i:end]
            i = len(command) if end == -1 else end + 1
            if (line.lstrip("\t") if strip_tabs else line) == word:
                break
    return i


# --------------------------------------------------------------------------
# OpenHands integration
# --------------------------------------------------------------------------

_registered = False


def guard_terminal(agent: Any) -> Any:
    """``agent`` with its ``terminal`` tool replaced by the guarded one (same params)."""
    if not getattr(agent, "tools", None):
        return agent
    from openhands.sdk import Tool
    from openhands.tools.terminal import TerminalTool

    _register()
    tools = [
        Tool(name=GUARDED_TOOL, params=dict(t.params or {})) if t.name == TerminalTool.name else t
        for t in agent.tools
    ]
    return agent.model_copy(update={"tools": tools})


def _register() -> None:
    global _registered
    if _registered:
        return
    from openhands.sdk.tool import ToolExecutor, register_tool

    ToolExecutor.register(GuardedExecutor)
    register_tool(GUARDED_TOOL, _guarded_tool_class())
    _registered = True


def _guarded_tool_class() -> Any:
    from typing import ClassVar

    from openhands.tools.terminal import TerminalTool

    def guarded(inner: Any) -> Any:
        return GuardedExecutor(inner)

    class GuardedTerminalTool(TerminalTool):
        """OpenHands' terminal with :func:`check_command` in front of its executor."""

        name: ClassVar[str] = TerminalTool.name

        @classmethod
        def create(cls, *args: Any, **kwargs: Any) -> Any:
            return [t.set_executor(guarded(t.executor)) for t in super().create(*args, **kwargs)]

    return GuardedTerminalTool


def _shell_of(executor: Any) -> str:
    try:
        if not getattr(executor, "is_pooled", False) and executor.session.terminal.is_powershell():
            return POWERSHELL
    except Exception:  # noqa: BLE001 - fall back to the platform
        return POWERSHELL if sys.platform == "win32" else BASH
    return BASH


class GuardedExecutor:
    """Wraps an OpenHands ``TerminalExecutor``: refuse, or run and watch for ``>>``."""

    def __init__(self, inner: Any, shell: str | None = None) -> None:
        self._inner = inner
        self.shell = shell or _shell_of(inner)

    def __getattr__(self, name: str) -> Any:
        if name == "_inner":
            raise AttributeError(name)
        return getattr(self._inner, name)

    def __call__(self, action: Any, conversation: Any = None) -> Any:
        command = action.command or ""
        if action.is_input:
            refusal = check_input(command, shell=self.shell)
        else:
            refusal = check_command(command, shell=self.shell)
        if refusal is not None:
            print(f"[terminal_guard] refused: {command[:200]!r}")
            return _error_observation(refusal, command)
        observation = self._inner(action, conversation)
        if self.shell == POWERSHELL and _still_running(observation) and is_continuation_prompt(observation.text):
            print(f"[terminal_guard] >> continuation prompt; resetting the terminal after {command[:200]!r}")
            try:
                self._inner.reset()
            except Exception as exc:  # noqa: BLE001 - the error below still stands
                print(f"[terminal_guard] reset failed: {exc}")
            return _error_observation(CONTINUATION_MESSAGE, command)
        return observation

    def close(self) -> None:
        self._inner.close()


def _still_running(observation: Any) -> bool:
    meta = getattr(observation, "metadata", None)
    code = getattr(meta, "exit_code", None) if meta is not None else None
    if code is None:
        code = getattr(observation, "exit_code", None)
    return code is None or code == -1


def _error_observation(text: str, command: str) -> Any:
    from openhands.tools.terminal.definition import TerminalObservation

    return TerminalObservation.from_text(text=text, is_error=True, command=command)
