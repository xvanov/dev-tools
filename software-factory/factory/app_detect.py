"""Deterministic toolchain detection for ``factory app add``.

Reads a checked-out repository and proposes the four command gates an app
config carries (``lint_command``, ``format_check_command``,
``type_check_command``, ``test_command``) plus an optional smoke command.

Pure and read-only: it opens files, never runs anything, never writes. Every
proposal carries the file that justified it (``sources``), and a gate nothing
justifies is reported in ``missing`` and left EMPTY — never filled with a
guess. An empty gate is "not configured", not "passing"; see
``docs``/the ``factory app add`` output for what that means per gate.

Detection order per gate (first hit wins):

1. ``Makefile`` targets — the commands the humans already run, so the
   factory's gates and local development cannot drift apart (the same reason
   ``apps/template-probe/config.yaml`` uses ``npm run`` scripts).
2. The root toolchain(s): Python (uv / poetry / pip), Node/TS (npm / pnpm /
   yarn / bun scripts), Go, Rust, .NET, JVM (Maven / Gradle), Ruby (Bundler),
   PHP (Composer).
3. Toolchains found one directory down (``backend/``, ``frontend/``, …),
   wrapped as ``(cd <dir> && <cmd>)``. When several subdirectories provide the
   same gate they are joined with ``&&`` so ALL must pass.
"""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

GATE_KEYS: tuple[str, ...] = (
    "lint_command",
    "format_check_command",
    "type_check_command",
    "test_command",
)

# Directories never treated as a sub-project root.
_SKIP_DIRS = {
    ".git",
    ".github",
    ".venv",
    "venv",
    "node_modules",
    "vendor",
    "target",
    "bin",
    "obj",
    "dist",
    "build",
    "__pycache__",
    ".tox",
    "docs",
}

# npm's placeholder ``test`` script — a script that always fails is not a gate.
_NPM_PLACEHOLDER_TEST = 'echo "Error: no test specified" && exit 1'


@dataclass
class Detection:
    """What was found in one repository."""

    toolchains: list[str] = field(default_factory=list)
    gates: dict[str, str] = field(default_factory=dict)
    sources: dict[str, str] = field(default_factory=dict)
    smoke_command: str | None = None
    notes: list[str] = field(default_factory=list)
    #: The repo is documentation: no toolchain, and docs outnumber code files.
    docs_only: bool = False
    #: Gate commands mirrored from the repo's CI workflows (``ci_suggestions``).
    ci: list[dict[str, Any]] = field(default_factory=list)
    #: Per gate field, a proposal for a gate detection left EMPTY:
    #: ``{command, source, requires}`` (``command`` may be ``none``). Never
    #: written to the config by ``app add``; a human confirms it.
    suggested: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def missing(self) -> list[str]:
        return [k for k in GATE_KEYS if not self.gates.get(k)]


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _load_toml(path: Path) -> dict[str, Any]:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def _load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


_MAKE_TARGET = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.\-]*)\s*:(?!=)", re.MULTILINE)


def makefile_targets(repo: Path) -> set[str]:
    for name in ("Makefile", "makefile", "GNUmakefile"):
        p = repo / name
        if p.is_file():
            return set(_MAKE_TARGET.findall(_read(p)))
    return set()


_MAKE_CANDIDATES: dict[str, tuple[str, ...]] = {
    "lint_command": ("lint",),
    "format_check_command": (
        "format-check",
        "format_check",
        "fmt-check",
        "fmt_check",
        "check-format",
        "check-fmt",
    ),
    "type_check_command": ("typecheck", "type-check", "type_check", "types", "mypy"),
    "test_command": ("test", "tests"),
}


# --------------------------------------------------------------------------- #
# per-toolchain detectors — each returns (toolchain_label, {gate: cmd}, notes)
# --------------------------------------------------------------------------- #


def _detect_python(d: Path) -> tuple[str, dict[str, str], list[str]] | None:
    pyproject = d / "pyproject.toml"
    reqs = sorted(d.glob("requirements*.txt"))
    if not (pyproject.is_file() or (d / "setup.py").is_file() or reqs):
        # No Python manifest, but a ruff config: the repo lints its Python
        # from here (e.g. a root ruff.toml over a backend/ package).
        for cfg in ("ruff.toml", ".ruff.toml"):
            if (d / cfg).is_file():
                ruff_only = {
                    "lint_command": "ruff check .",
                    "format_check_command": "ruff format --check .",
                }
                return f"python ({cfg})", ruff_only, []
        return None
    data = _load_toml(pyproject) if pyproject.is_file() else {}
    tool = data.get("tool", {}) if isinstance(data.get("tool"), dict) else {}
    # Every place a dependency name can be mentioned, as one searchable blob.
    blob = _read(pyproject).lower() + "".join(_read(r).lower() for r in reqs)
    blob += _read(d / "setup.cfg").lower() + _read(d / "setup.py").lower()

    if (d / "uv.lock").is_file() or "uv" in tool:
        manager = "uv"
        extras = (data.get("project") or {}).get("optional-dependencies") or {}
        run = "uv run --extra dev" if "dev" in extras else "uv run"
    elif (d / "poetry.lock").is_file() or "poetry" in tool:
        manager, run = "poetry", "poetry run"
    else:
        manager, run = "pip", "python -m"

    def mentions(name: str) -> bool:
        return re.search(rf"(^|[^a-z0-9_-]){re.escape(name)}([^a-z0-9_-]|$)", blob) is not None

    gates: dict[str, str] = {}
    notes: list[str] = []
    has_ruff = "ruff" in tool or (d / "ruff.toml").is_file() or (d / ".ruff.toml").is_file()
    has_ruff = has_ruff or mentions("ruff")
    if has_ruff:
        gates["lint_command"] = f"{run} ruff check ."
        gates["format_check_command"] = f"{run} ruff format --check ."
    else:
        if (d / ".flake8").is_file() or mentions("flake8"):
            gates["lint_command"] = f"{run} flake8 ."
        if "black" in tool or mentions("black"):
            gates["format_check_command"] = f"{run} black --check ."

    mypy_cfg = tool.get("mypy") if isinstance(tool.get("mypy"), dict) else None
    if mypy_cfg is not None or (d / "mypy.ini").is_file() or mentions("mypy"):
        # With ``files`` configured mypy knows its own targets; otherwise ``.``.
        gates["type_check_command"] = f"{run} mypy" + (
            "" if mypy_cfg and mypy_cfg.get("files") else " ."
        )
    elif "pyright" in tool or (d / "pyrightconfig.json").is_file() or mentions("pyright"):
        gates["type_check_command"] = f"{run} pyright"

    has_tests = (d / "tests").is_dir() or (d / "test").is_dir() or (d / "conftest.py").is_file()
    if mentions("pytest") or "pytest" in tool or has_tests:
        gates["test_command"] = f"{run} pytest -q"
    if manager == "pip":
        notes.append(
            "python (pip): commands use `python -m <tool>`; the gate's shell must "
            "already have the dev requirements installed"
        )
    return f"python ({manager})", gates, notes


def _node_pm(d: Path, pkg: dict[str, Any]) -> str:
    declared = str(pkg.get("packageManager") or "").split("@", 1)[0]
    if declared in ("npm", "pnpm", "yarn", "bun"):
        return declared
    if (d / "pnpm-lock.yaml").is_file():
        return "pnpm"
    if (d / "yarn.lock").is_file():
        return "yarn"
    if (d / "bun.lockb").is_file() or (d / "bun.lock").is_file():
        return "bun"
    return "npm"


_NODE_SCRIPTS: dict[str, tuple[str, ...]] = {
    "lint_command": ("lint", "lint:check", "eslint"),
    "format_check_command": (
        "format:check",
        "format-check",
        "fmt:check",
        "prettier:check",
        "check-format",
        "check:format",
    ),
    "type_check_command": (
        "typecheck",
        "type-check",
        "typecheck:all",
        "check-types",
        "tsc",
        "types",
    ),
    "test_command": ("test", "test:unit", "test:ci"),
}


def _detect_node(d: Path) -> tuple[str, dict[str, str], list[str]] | None:
    if not (d / "package.json").is_file():
        return None
    pkg = _load_json(d / "package.json")
    pm = _node_pm(d, pkg)
    scripts = pkg.get("scripts") or {}
    scripts = scripts if isinstance(scripts, dict) else {}
    deps: set[str] = set()
    for key in ("dependencies", "devDependencies"):
        val = pkg.get(key)
        if isinstance(val, dict):
            deps.update(val)
    run = {"npm": "npm run", "pnpm": "pnpm run", "yarn": "yarn run", "bun": "bun run"}[pm]
    exe = {"npm": "npx", "pnpm": "pnpm exec", "yarn": "yarn run", "bun": "bunx"}[pm]

    gates: dict[str, str] = {}
    for gate, names in _NODE_SCRIPTS.items():
        for name in names:
            body = scripts.get(name)
            if not isinstance(body, str) or not body.strip():
                continue
            if name == "test" and body.strip() == _NPM_PLACEHOLDER_TEST:
                continue
            gates[gate] = f"{run} {name}"
            break
    # Fallbacks on the tools themselves when no script names them.
    if "type_check_command" not in gates and (d / "tsconfig.json").is_file():
        gates["type_check_command"] = f"{exe} tsc --noEmit"
    has_prettier = "prettier" in deps or any(d.glob(".prettierrc*")) or "prettier" in pkg
    if "format_check_command" not in gates and has_prettier:
        gates["format_check_command"] = f"{exe} prettier --check ."
    lang = "typescript" if (d / "tsconfig.json").is_file() or "typescript" in deps else "node"
    notes = [
        f"{lang} ({pm}): gates run in a fresh git worktree with no node_modules — "
        "prefix an install step (e.g. `"
        + {
            "npm": "npm ci",
            "pnpm": "pnpm install --frozen-lockfile",
            "yarn": "yarn install --frozen-lockfile",
            "bun": "bun install --frozen-lockfile",
        }[pm]
        + " && …`) if the commands need dependencies"
    ]
    return f"{lang} ({pm})", gates, notes


def _detect_jvm(d: Path) -> tuple[str, dict[str, str], list[str]] | None:
    gradle = [n for n in ("build.gradle", "build.gradle.kts") if (d / n).is_file()]
    if gradle:
        tool = "./gradlew" if (d / "gradlew").is_file() else "gradle"
        build = _read(d / gradle[0]).lower()
        gates = {
            "type_check_command": f"{tool} classes testClasses",
            "test_command": f"{tool} test",
        }
        if "spotless" in build:
            gates["format_check_command"] = f"{tool} spotlessCheck"
        if "checkstyle" in build:
            gates["lint_command"] = f"{tool} checkstyleMain"
        elif "ktlint" in build:
            gates["lint_command"] = f"{tool} ktlintCheck"
        return "jvm (gradle)", gates, []
    if (d / "pom.xml").is_file():
        tool = "./mvnw" if (d / "mvnw").is_file() else "mvn"
        pom = _read(d / "pom.xml").lower()
        gates = {
            "type_check_command": f"{tool} -B -q test-compile",
            "test_command": f"{tool} -B -q test",
        }
        if "spotless" in pom:
            gates["format_check_command"] = f"{tool} -B -q spotless:check"
        if "maven-checkstyle-plugin" in pom:
            gates["lint_command"] = f"{tool} -B -q checkstyle:check"
        return "jvm (maven)", gates, []
    return None


def _detect_ruby(d: Path) -> tuple[str, dict[str, str], list[str]] | None:
    if not (d / "Gemfile").is_file():
        return None
    gemfile = _read(d / "Gemfile") + _read(d / "Gemfile.lock")
    gates: dict[str, str] = {}
    if "rubocop" in gemfile or (d / ".rubocop.yml").is_file():
        gates["lint_command"] = "bundle exec rubocop"
    if "sorbet" in gemfile:
        gates["type_check_command"] = "bundle exec srb tc"
    elif "steep" in gemfile:
        gates["type_check_command"] = "bundle exec steep check"
    if "rspec" in gemfile or (d / "spec").is_dir():
        gates["test_command"] = "bundle exec rspec"
    elif (d / "Rakefile").is_file() and (d / "test").is_dir():
        gates["test_command"] = "bundle exec rake test"
    notes = ["ruby (bundler): gates run in a fresh worktree — prefix `bundle install && …`"]
    return "ruby (bundler)", gates, notes


def _detect_php(d: Path) -> tuple[str, dict[str, str], list[str]] | None:
    if not (d / "composer.json").is_file():
        return None
    pkg = _load_json(d / "composer.json")
    deps: set[str] = set()
    for key in ("require", "require-dev"):
        val = pkg.get(key)
        if isinstance(val, dict):
            deps.update(val)
    raw_scripts = pkg.get("scripts")
    scripts: dict[str, Any] = raw_scripts if isinstance(raw_scripts, dict) else {}
    gates: dict[str, str] = {}
    if "test" in scripts:
        gates["test_command"] = "composer run-script test"
    elif "phpunit/phpunit" in deps:
        gates["test_command"] = "vendor/bin/phpunit"
    elif "pestphp/pest" in deps:
        gates["test_command"] = "vendor/bin/pest"
    if "phpstan/phpstan" in deps:
        gates["type_check_command"] = "vendor/bin/phpstan analyse"
    elif "vimeo/psalm" in deps:
        gates["type_check_command"] = "vendor/bin/psalm"
    if "friendsofphp/php-cs-fixer" in deps:
        gates["format_check_command"] = "vendor/bin/php-cs-fixer fix --dry-run --diff"
    elif "laravel/pint" in deps:
        gates["format_check_command"] = "vendor/bin/pint --test"
    if "squizlabs/php_codesniffer" in deps:
        gates["lint_command"] = "vendor/bin/phpcs"
    notes = ["php (composer): gates run in a fresh worktree — prefix `composer install && …`"]
    return "php (composer)", gates, notes


def _detect_go(d: Path) -> tuple[str, dict[str, str], list[str]] | None:
    if not (d / "go.mod").is_file():
        return None
    golangci = any(
        (d / n).is_file()
        for n in (".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json")
    )
    gates = {
        "lint_command": "golangci-lint run" if golangci else "go vet ./...",
        "format_check_command": 'test -z "$(gofmt -l .)"',
        "type_check_command": "go build ./...",
        "test_command": "go test ./...",
    }
    return "go", gates, []


def _detect_rust(d: Path) -> tuple[str, dict[str, str], list[str]] | None:
    if not (d / "Cargo.toml").is_file():
        return None
    gates = {
        "lint_command": "cargo clippy --all-targets -- -D warnings",
        "format_check_command": "cargo fmt --all -- --check",
        "type_check_command": "cargo check --all-targets",
        "test_command": "cargo test",
    }
    return "rust", gates, []


def _detect_dotnet(d: Path) -> tuple[str, dict[str, str], list[str]] | None:
    slns = sorted([*d.glob("*.sln"), *d.glob("*.slnx")])
    projs = sorted([*d.glob("*.csproj"), *d.glob("*.fsproj"), *d.glob("*.vbproj")])
    if not slns and not projs:
        return None
    notes: list[str] = []
    # ``dotnet`` refuses to guess when a folder holds more than one solution or
    # project file, so name the target explicitly whenever it is unambiguous.
    if len(slns) == 1:
        target = f" {slns[0].name}"
    elif not slns and len(projs) == 1:
        target = f" {projs[0].name}"
    else:
        target = ""
        if len(slns) + len(projs) > 1:
            notes.append(
                ".NET: several solution/project files at the root ("
                + ", ".join(p.name for p in [*slns, *projs])
                + ") — the commands name none; add the right one by hand"
            )
    tools = _load_json(d / ".config" / "dotnet-tools.json").get("tools") or {}
    restore = "dotnet tool restore && " if tools else ""
    if "csharpier" in tools:
        fmt = f"{restore}dotnet csharpier --check ."
    else:
        fmt = f"dotnet format{target} whitespace --verify-no-changes"
    gates = {
        # Analyzer diagnostics at warning+ severity, without rewriting anything.
        "lint_command": f"dotnet format{target} analyzers --verify-no-changes --severity warn",
        "format_check_command": fmt,
        # Compilation IS the type check for C#/F#.
        "type_check_command": f"dotnet build{target} --nologo",
        "test_command": f"dotnet test{target} --nologo",
    }
    return ".net", gates, notes


_DETECTORS = (
    _detect_python,
    _detect_node,
    _detect_go,
    _detect_rust,
    _detect_dotnet,
    _detect_jvm,
    _detect_ruby,
    _detect_php,
)


def _family(label: str) -> str:
    head = label.split(" ", 1)[0]
    return "node" if head in ("node", "typescript") else head


def _detect_dir(d: Path) -> list[tuple[str, dict[str, str], list[str]]]:
    return [hit for det in _DETECTORS if (hit := det(d)) is not None]


# --------------------------------------------------------------------------- #
# docs-only repos
# --------------------------------------------------------------------------- #

_DOC_EXT = {".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"}
_CODE_EXT = {
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".go",
    ".rs",
    ".cs",
    ".fs",
    ".java",
    ".kt",
    ".rb",
    ".php",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".swift",
    ".scala",
    ".sh",
    ".ps1",
}
_WALK_CAP = 5000


def count_doc_and_code(repo: Path) -> tuple[int, int]:
    """(doc files, code files) under ``repo``, skipping vendored/build dirs."""
    docs = code = seen = 0
    stack = [Path(repo)]
    while stack and seen < _WALK_CAP:
        d = stack.pop()
        try:
            entries = list(d.iterdir())
        except OSError:
            continue
        for p in entries:
            if p.is_dir():
                if p.name not in _SKIP_DIRS - {"docs"} and not p.name.startswith("."):
                    stack.append(p)
                continue
            seen += 1
            ext = p.suffix.lower()
            if ext in _DOC_EXT:
                docs += 1
            elif ext in _CODE_EXT:
                code += 1
    return docs, code


def is_docs_only(repo: Path) -> bool:
    """Mostly documentation: at least 3 doc files and 4x as many as code files."""
    docs, code = count_doc_and_code(repo)
    return docs >= 3 and docs >= 4 * code


# --------------------------------------------------------------------------- #
# CI workflows -> suggested gates
# --------------------------------------------------------------------------- #

# First match wins, in this order: a `prettier --check` is a format check even
# though "check" also smells of lint.
_CI_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "format_check_command",
        re.compile(
            r"prettier\b.*--check|format[:_-]check|fmt[:_-]check|check[:_-]format|"
            r"black\b.*--check|ruff\s+format\b.*--check|gofmt\b|cargo\s+fmt\b|"
            r"dotnet\s+format\b.*verify|csharpier\b.*check|pint\b.*--test|spotlessCheck|spotless:check"
        ),
    ),
    (
        "type_check_command",
        re.compile(r"\btsc\b|type[:_-]?check|check[:_-]types|\bmypy\b|\bpyright\b|cargo\s+check\b"),
    ),
    (
        "test_command",
        re.compile(
            # ``test``/``coverage`` only as the verb (``npm test``, ``yarn run
            # test:unit``), never as an argument (``yarn check src tests``).
            r"\blychee\b|markdown-link-check|^(?:\S+\s+){0,2}(?:tests?|coverage)(?::\S+)?(?:\s|$)|"
            r"pytest|\bjest\b|vitest|mocha|rspec|phpunit|\bpest\b|go\s+test\b|cargo\s+test\b|"
            r"dotnet\s+test\b"
        ),
    ),
    (
        "lint_command",
        re.compile(
            r"^(?:\S+\s+){0,2}lint(?::\S+)?(?:\s|$)|eslint|ruff\s+check|flake8|clippy|golangci|markdownlint|\bvale\b|"
            r"shellcheck|hadolint|actionlint|gitleaks|yamllint|codespell|cspell|rubocop|phpcs"
        ),
    ),
)

# Lines that prepare the environment; kept (in order) as a prefix of the job's
# gate commands, because gates run in a fresh worktree with nothing installed.
_CI_SETUP = re.compile(
    r"^(corepack\s+enable|npm\s+(ci|install)\b|yarn(\s+install)?(\s+--\S+)*$|pnpm\s+install|"
    r"bun\s+install|uv\s+sync|poetry\s+install|pip\s+install|python3?\s+-m\s+pip\s+install|"
    r"bundle\s+install|composer\s+install|dotnet\s+(restore|tool\s+restore)|go\s+mod\s+download)"
)

# A gate command's first word that is a separately installed tool: declared as
# ``requires`` so a machine without it is told so up front.
_KNOWN_TOOLS = {
    "docker",
    "lychee",
    "gitleaks",
    "markdownlint",
    "markdownlint-cli2",
    "vale",
    "shellcheck",
    "hadolint",
    "actionlint",
    "yamllint",
    "codespell",
    "cspell",
    "typos",
    "node",
    "npm",
    "npx",
    "yarn",
    "pnpm",
    "bun",
    "deno",
    "uv",
    "poetry",
    "python",
    "python3",
    "go",
    "cargo",
    "dotnet",
    "mvn",
    "gradle",
    "bundle",
    "composer",
    "make",
    "terraform",
    "helm",
    "corepack",
}

# Known GitHub Actions that wrap a CLI: action -> (gate, command builder, tool).
_ACTION_GATES: dict[str, tuple[str, str, str]] = {
    "lycheeverse/lychee-action": ("test_command", "lychee {args}", "lychee"),
    "davidanson/markdownlint-cli2-action": (
        "lint_command",
        "markdownlint-cli2 {globs}",
        "markdownlint-cli2",
    ),
    "gitleaks/gitleaks-action": ("lint_command", "gitleaks detect --no-banner", "gitleaks"),
}


def _tools_in(cmd: str) -> list[str]:
    out: list[str] = []
    for seg in re.split(r"&&|\|\||;|\|", cmd):
        words = seg.strip().lstrip("(").split()
        if words and words[0] in _KNOWN_TOOLS and words[0] not in out:
            out.append(words[0])
    return out


def _classify(cmd: str) -> str | None:
    if "${{" in cmd or "$CI_" in cmd:
        return None  # needs the CI's own expressions/variables
    for gate, pat in _CI_RULES:
        if pat.search(cmd):
            return gate
    return None


def _join_lines(text: str) -> list[str]:
    """A `run:` block as commands: continuation lines joined, comments dropped."""
    out: list[str] = []
    buf = ""
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.endswith("\\"):
            buf += line[:-1].strip() + " "
            continue
        out.append((buf + line).strip())
        buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out


def _in_dir(cmd: str, workdir: str | None) -> str:
    wd = (workdir or "").strip().strip("./") if workdir else ""
    if not wd or "${{" in wd:
        return cmd
    return f"(cd {wd} && {cmd})"


def _job_suggestions(source: str, steps: list[tuple[str, str | None]]) -> list[dict[str, Any]]:
    """``steps``: (command, working dir) in order. Setup lines become a prefix."""
    found: list[dict[str, Any]] = []
    setup: dict[str | None, list[str]] = {}
    for cmd, wd in steps:
        if _CI_SETUP.match(cmd):
            setup.setdefault(wd, []).append(cmd)
            continue
        gate = _classify(cmd)
        if gate is None:
            continue
        full = " && ".join([*setup.get(wd, []), cmd])
        found.append(
            {
                "gate": gate,
                "command": _in_dir(full, wd),
                "requires": _tools_in(full),
                "source": source,
            }
        )
    return found


def _github_ci(repo: Path) -> list[dict[str, Any]]:
    wf_dir = repo / ".github" / "workflows"
    if not wf_dir.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for wf in sorted([*wf_dir.glob("*.yml"), *wf_dir.glob("*.yaml")]):
        try:
            data = yaml.safe_load(_read(wf)) or {}
        except yaml.YAMLError:
            continue
        if not isinstance(data, dict):
            continue
        default_wd = ((data.get("defaults") or {}).get("run") or {}).get("working-directory")
        jobs = data.get("jobs") or {}
        if not isinstance(jobs, dict):
            continue
        for job_name, job in jobs.items():
            if not isinstance(job, dict):
                continue
            job_wd = ((job.get("defaults") or {}).get("run") or {}).get("working-directory")
            steps: list[tuple[str, str | None]] = []
            actions: list[dict[str, Any]] = []
            for step in job.get("steps") or []:
                if not isinstance(step, dict):
                    continue
                uses = str(step.get("uses") or "").split("@", 1)[0].lower()
                if uses in _ACTION_GATES:
                    gate, tmpl, tool = _ACTION_GATES[uses]
                    with_ = step.get("with") or {}
                    args = str(with_.get("args") or ".").replace("\n", " ").strip()
                    globs = str(with_.get("globs") or '"**/*.md"').replace("\n", " ").strip()
                    cmd = tmpl.format(args=args, globs=globs)
                    if "${{" not in cmd:
                        actions.append(
                            {
                                "gate": gate,
                                "command": cmd,
                                "requires": [tool],
                                "source": f"{wf.name} job {job_name} ({uses})",
                            }
                        )
                    continue
                if "run" in step:
                    wd = step.get("working-directory") or job_wd or default_wd
                    steps.extend((c, wd) for c in _join_lines(step["run"]))
            out.extend(actions)
            out.extend(_job_suggestions(f"{wf.name} job {job_name}", steps))
    return out


_GITLAB_RESERVED = {
    "stages",
    "variables",
    "default",
    "include",
    "workflow",
    "image",
    "services",
    "before_script",
    "after_script",
    "cache",
    "pages",
}


def _gitlab_ci(repo: Path) -> list[dict[str, Any]]:
    path = repo / ".gitlab-ci.yml"
    if not path.is_file():
        return []
    try:
        data = yaml.safe_load(_read(path)) or {}
    except yaml.YAMLError:
        return []
    if not isinstance(data, dict):
        return []

    def _lines(v: Any) -> list[str]:
        if isinstance(v, str):
            return _join_lines(v)
        if isinstance(v, list):
            return [ln for item in v for ln in _join_lines(str(item))]
        return []

    default = data.get("default") if isinstance(data.get("default"), dict) else {}
    global_before = _lines(data.get("before_script") or (default or {}).get("before_script"))
    out: list[dict[str, Any]] = []
    for name, job in data.items():
        if name in _GITLAB_RESERVED or str(name).startswith(".") or not isinstance(job, dict):
            continue
        before = _lines(job["before_script"]) if "before_script" in job else global_before
        steps: list[tuple[str, str | None]] = [
            (c, None) for c in [*before, *_lines(job.get("script"))]
        ]
        out.extend(_job_suggestions(f".gitlab-ci.yml job {name}", steps))
    return out


def ci_suggestions(repo: Path) -> list[dict[str, Any]]:
    """Gate commands mirrored from the repo's CI (GitHub Actions, GitLab CI).

    Each: ``{gate, command, requires, source}``. Read-only and best effort: a
    workflow that does not parse contributes nothing.
    """
    repo = Path(repo)
    return [*_github_ci(repo), *_gitlab_ci(repo)]


def _suggest(out: Detection, repo: Path) -> None:
    out.ci = ci_suggestions(repo)
    by_gate: dict[str, list[dict[str, Any]]] = {}
    for s in out.ci:
        by_gate.setdefault(s["gate"], []).append(s)
    for gate in GATE_KEYS:
        if out.gates.get(gate):
            continue
        hits = by_gate.get(gate) or []
        if hits:
            cmds = list(dict.fromkeys(h["command"] for h in hits))
            req = list(dict.fromkeys(t for h in hits for t in h["requires"]))
            out.suggested[gate] = {
                "command": " && ".join(cmds),
                "requires": req,
                "source": "CI: " + "; ".join(dict.fromkeys(h["source"] for h in hits)),
            }
        elif out.docs_only:
            out.suggested[gate] = {
                "command": "none",
                "requires": [],
                "source": "docs-only repo: no such check found",
            }


# --------------------------------------------------------------------------- #
# public entry point
# --------------------------------------------------------------------------- #


def detect(repo: Path) -> Detection:
    """Propose gate commands for the repository checked out at ``repo``."""
    repo = Path(repo)
    out = Detection()

    # 1. Makefile targets.
    targets = makefile_targets(repo)
    for gate, names in _MAKE_CANDIDATES.items():
        for name in names:
            if name in targets:
                out.gates[gate] = f"make {name}"
                out.sources[gate] = f"Makefile target `{name}`"
                break
    if targets:
        out.toolchains.append("make")
    if out.gates:
        out.notes.append(
            "Makefile targets are used as-is: check they do not assume a pre-built local "
            "env (.venv, node_modules) — gates run in a fresh git worktree"
        )
    if "smoke" in targets:
        out.smoke_command = "make smoke"
    elif (repo / "scripts" / "smoke.sh").is_file():
        out.smoke_command = "bash scripts/smoke.sh"

    # 2 + 3. Root toolchains, then one directory down. Per gate and per
    # toolchain family, the SHALLOWEST provider wins: a root ``ruff check .``
    # already covers ``backend/``, but says nothing about ``frontend/``'s npm
    # lint — so a gate collects one command per family, all joined with ``&&``.
    make_gates = set(out.gates)
    collected: dict[str, list[tuple[str, str, str]]] = {}  # gate -> (family, where, cmd)

    def _take(where: str, label: str, gates: dict[str, str]) -> None:
        fam = _family(label)
        for gate, cmd in gates.items():
            if gate in make_gates:
                continue
            have = collected.setdefault(gate, [])
            if where and any(f == fam and not w for f, w, _ in have):
                continue  # the root already covers this family
            have.append((fam, where, cmd))

    for label, gates, notes in _detect_dir(repo):
        out.toolchains.append(label)
        out.notes.extend(notes)
        _take("", label, gates)

    subs = (
        sorted(
            p
            for p in repo.iterdir()
            if p.is_dir() and p.name not in _SKIP_DIRS and not p.name.startswith(".")
        )
        if repo.is_dir()
        else []
    )
    for sub in subs:
        for label, gates, notes in _detect_dir(sub):
            out.toolchains.append(f"{label} in {sub.name}/")
            out.notes.extend(f"{sub.name}/: {n}" for n in notes)
            _take(sub.name, label, gates)

    for gate, entries in collected.items():
        out.gates[gate] = " && ".join(
            cmd if not where else f"(cd {where} && {cmd})" for _, where, cmd in entries
        )
        out.sources[gate] = ", ".join(
            f"{fam} at root" if not where else f"{fam} in {where}/" for fam, where, _ in entries
        )

    if not out.toolchains:
        out.docs_only = is_docs_only(repo) if repo.is_dir() else False
        if out.docs_only:
            out.notes.append(
                "docs-only repo (documentation outnumbers code, no toolchain): gates are "
                "EMPTY; the suggestions mirror its CI, else `none` (skipped). Confirm "
                "them (`factory app set <app> --gate test=none` …) before submitting jobs"
            )
        else:
            out.notes.append(
                "no supported toolchain recognised (make, python, node/ts, go, rust, .net, "
                "jvm, ruby, php): every gate is EMPTY — set them (`factory app set <app> "
                '--gate test="<cmd>"`, or `--gate test=none` for a repo with no tests) '
                "before submitting jobs"
            )

    # A template-derived repo bootstraps its own deps; every gate needs it in a
    # fresh worktree (see apps/template-probe/config.yaml).
    if (repo / "scripts" / "ensure-deps.sh").is_file():
        for gate in list(out.gates):
            out.gates[gate] = f"bash scripts/ensure-deps.sh && {out.gates[gate]}"
        out.notes.append("scripts/ensure-deps.sh found: every gate is prefixed with it")

    if repo.is_dir():
        _suggest(out, repo)
    return out
