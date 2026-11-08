#!/usr/bin/env python3
"""Changed-files mode for software-factory's pytest suite (the sibling of `run-tests.js --changed`).

    python scripts/changed-pytest.py [--list] [--since REF] [-- extra pytest args]

Runs only the test files that import, transitively, a module changed against HEAD (staged plus
unstaged, untracked included). Standard library only: the import graph comes from `ast`, no
testmon database, no plugins. A test file is selected when

  * it is itself changed, or
  * a project module it imports (directly or through other project modules) changed, or
  * a conftest.py above it changed or is reached, or
  * a data file named in a string literal of the test or of a module it reaches changed
    (`"fixtures/job.yaml"`: matched by base name; over-selecting is fine, under-selecting is the bug).

pyproject.toml / uv.lock / pytest config changes select everything. Nothing changed -> nothing runs.
Exit status is pytest's (0 when nothing was selected).
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

TOP = Path(__file__).resolve().parent.parent
FACTORY = TOP / "software-factory"
GLOBAL = {"pyproject.toml", "uv.lock", "pytest.ini", "tox.ini", "setup.cfg"}
DATA_LITERAL = re.compile(r"""['"]([^'"\n]*?[\w-]\.(?:ya?ml|json|md|txt|toml|sql|csv|html|j2|cfg|ini|sh|py))['"]""")
IMPORT_RE = re.compile(
    r"^[ \t]*(?:import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)"
    r"|from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*))",
    re.MULTILINE,
)
SKIP_DIRS = {".venv", "venv", "node_modules", "__pycache__", ".git", "state", "bench"}


def git(*args: str) -> list[str]:
    out = subprocess.run(["git", *args], cwd=TOP, capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line]


def changed_files(since: str) -> set[Path]:
    names = set(git("diff", "--name-only", "--no-renames", since, "--")) | set(git("ls-files", "--others", "--exclude-standard"))
    return {(TOP / n).resolve() for n in names}


def project_files() -> dict[Path, str]:
    """Every .py file under software-factory -> its dotted module name (rooted at software-factory)."""
    out: dict[Path, str] = {}
    for dirpath, dirnames, filenames in os.walk(FACTORY):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            p = Path(dirpath, fn).resolve()
            rel = p.relative_to(FACTORY).with_suffix("")
            parts = list(rel.parts)
            if parts[-1] == "__init__":
                parts.pop()
            out[p] = ".".join(parts)
    return out


class Graph:
    def __init__(self) -> None:
        self.by_path = project_files()
        self.by_mod = {m: p for p, m in self.by_path.items() if m}
        self._deps: dict[Path, tuple[set[Path], set[str]]] = {}

    def _resolve(self, dotted: str) -> Path | None:
        return self.by_mod.get(dotted)

    def deps(self, path: Path) -> tuple[set[Path], set[str]]:
        """(project files `path` imports, lowercase data-file base names it mentions)."""
        if path in self._deps:
            return self._deps[path]
        files: set[Path] = set()
        names: set[str] = set()
        try:
            src = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            self._deps[path] = (files, names)
            return files, names
        pkg = self.by_path.get(path, "")
        is_init = path.name == "__init__.py"
        pkg_parts = pkg.split(".") if pkg else []
        if not is_init:
            pkg_parts = pkg_parts[:-1]
        # Regexes, not ast: parsing every module cost ~8 s on Windows, far over a pre-commit budget.
        # Imports anywhere in the file count (function-level lazy imports are deps too).
        for m in IMPORT_RE.finditer(src):
            if m.group(1) is not None:  # import a.b, c.d as e
                for part in m.group(1).split(","):
                    name = part.strip().split(" ")[0]
                    if name:
                        self._add_chain(name, files)
                continue
            dots, modname, imported = m.group(2), m.group(3), m.group(4)
            level = len(dots)
            if level:
                base = pkg_parts[: len(pkg_parts) - (level - 1)] if level - 1 <= len(pkg_parts) else []
                mod = ".".join(base + ([modname] if modname else []))
            else:
                mod = modname or ""
            if mod:
                self._add_chain(mod, files)
            for item in re.split(r"[,\s()]+", imported):  # `from pkg import submodule`
                if item and item != "as":
                    full = f"{mod}.{item}" if mod else item
                    sub = self._resolve(full)
                    if sub:
                        files.add(sub)
                        self._add_chain(full, files)
        for m in DATA_LITERAL.finditer(src):
            names.add(os.path.basename(m.group(1)).lower())
        files.discard(path)
        self._deps[path] = (files, names)
        return files, names

    def _add_chain(self, dotted: str, files: set[Path]) -> None:
        # importing a.b.c runs a/__init__, a/b/__init__ and a/b/c
        parts = dotted.split(".")
        for i in range(1, len(parts) + 1):
            p = self._resolve(".".join(parts[:i]))
            if p:
                files.add(p)

    def _add_parents(self, dotted: str, files: set[Path]) -> None:
        self._add_chain(dotted, files)


def is_test(p: Path) -> bool:
    return p.suffix == ".py" and (p.name.startswith("test_") or p.name.endswith("_test.py")) and "tests" in p.relative_to(FACTORY).parts[:1]


def conftests_for(test: Path) -> list[Path]:
    out = []
    d = test.parent
    while True:
        c = d / "conftest.py"
        if c.exists():
            out.append(c.resolve())
        if d == FACTORY or d == d.parent:
            break
        d = d.parent
    return out


def select(since: str) -> tuple[bool, str, list[Path], list[Path]]:
    changed = {p for p in changed_files(since) if FACTORY in p.parents or p == FACTORY}
    all_tests = sorted(p for p in project_files() if is_test(p))
    if not changed:
        return False, f"no software-factory changes against {since}", [], []
    for p in changed:
        if p.name in GLOBAL and p.parent == FACTORY:
            return True, f"{p.name} changed", all_tests, sorted(changed)
    graph = Graph()
    by_base: dict[str, list[Path]] = {}
    for p in changed:
        by_base.setdefault(p.name.lower(), []).append(p)
    chosen = []
    for t in all_tests:
        seen: set[Path] = set()
        stack = [t, *conftests_for(t)]
        hit = False
        while stack and not hit:
            f = stack.pop()
            if f in seen:
                continue
            seen.add(f)
            if f in changed:
                hit = True
                break
            files, names = graph.deps(f)
            if any(n in by_base for n in names):
                hit = True
                break
            stack.extend(files)
        if hit:
            chosen.append(t)
    return False, "", chosen, sorted(changed)


def main(argv: list[str]) -> int:
    extra: list[str] = []
    if "--" in argv:
        i = argv.index("--")
        argv, extra = argv[:i], argv[i + 1 :]
    list_only = "--list" in argv
    since = "HEAD"
    if "--since" in argv:
        since = argv[argv.index("--since") + 1]
    run_all, reason, tests, changed = select(since)
    rel = [str(t.relative_to(FACTORY)).replace("\\", "/") for t in tests]
    if list_only:
        print("\n".join(rel))
        return 0
    if not tests:
        print(f"changed mode (software-factory): nothing to run ({reason or 'no test reaches a changed file'})", file=sys.stderr)
        return 0
    why = f"{reason}: running everything" if run_all else f"{len(changed)} changed file(s)"
    print(f"changed mode (software-factory): {why}; {len(tests)} test file(s) selected", file=sys.stderr)
    venv_py = FACTORY / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if venv_py.exists():
        cmd = [str(venv_py), "-m", "pytest"]
    elif subprocess.run(["uv", "--version"], capture_output=True).returncode == 0:
        cmd = ["uv", "run", "pytest"]
    else:
        cmd = [sys.executable, "-m", "pytest"]
    if len(tests) > 8 and "-n" not in extra:
        cmd += ["-n", "auto", "--dist", "loadfile"]
    return subprocess.run([*cmd, "-q", *extra, *rel], cwd=FACTORY).returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
