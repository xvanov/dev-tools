"""Per-app context root (plan item 2.4): ``AppConfig.context_dir`` drives every context path."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from factory.app_config import load_app_config
from factory.context import canonical_paths as cp
from factory.context.enforcer import scan_pr_diff
from factory.context.loader import compose_context_prelude
from factory.context.updater import ContextUpdate, ForbiddenContextPathError, apply_context_updates
from factory.personas.loader import CONTEXT_DIR_TOKEN, available_personas, read_persona_prompt

FACTORY_ROOT = Path(__file__).resolve().parent.parent
DEVTOOLS_ROOT = "software-factory/apps/dev-tools/context"

_OLD_CANONICAL = [
    "prd.md",
    "context/project.md",
    "context/current-state.md",
    "context/architecture-diagrams.md",
    "context/navigation.md",
    "context/glossary.md",
    "context/sprint-status.yaml",
    "context/modules/*.md",
    "stories/*.md",
]
_OLD_FORBIDDEN = [
    "context/decisions/*",
    "context/decisions/**/*",
    "context/changelog.md",
    "context/history.md",
    "context/old-*.md",
    "context/old-*/**",
    "context/archive/*",
    "context/archive/**/*",
    "docs/decisions/*",
    "docs/adr/*",
]


def test_default_root_paths_are_unchanged() -> None:
    assert cp.CANONICAL_CONTEXT_PATHS == _OLD_CANONICAL
    assert cp.FORBIDDEN_DOC_PATTERNS == _OLD_FORBIDDEN
    assert cp.canonical_context_paths(None) == _OLD_CANONICAL
    assert cp.forbidden_doc_patterns("context") == _OLD_FORBIDDEN
    assert cp.context_files()[0] == "context/project.md"


@pytest.mark.parametrize("raw", ["", ".", "./context", "context/", "\\context"])
def test_normalize_defaults(raw: str) -> None:
    assert cp.normalize_context_dir(raw) == "context"


def test_normalize_rejects_escape() -> None:
    with pytest.raises(ValueError):
        cp.normalize_context_dir("../outside")


def test_devtools_app_resolves_under_its_folder() -> None:
    cfg = load_app_config("dev-tools", FACTORY_ROOT)
    assert cfg.context_dir == DEVTOOLS_ROOT
    assert cp.is_canonical_doc_path(f"{DEVTOOLS_ROOT}/project.md", cfg.context_dir)
    assert cp.is_canonical_doc_path(f"{DEVTOOLS_ROOT}/modules/x.md", cfg.context_dir)
    assert not cp.is_canonical_doc_path("context/project.md", cfg.context_dir)
    assert cp.is_forbidden_doc_path(f"{DEVTOOLS_ROOT}/changelog.md", cfg.context_dir)
    # the root is tracked (a .gitkeep ships it), like apps/factory
    assert (FACTORY_ROOT.parent / DEVTOOLS_ROOT).is_dir()


def test_enforcer_uses_configured_root() -> None:
    files = [f"{DEVTOOLS_ROOT}/random.md", f"{DEVTOOLS_ROOT}/project.md", "src/a.py"]
    v = scan_pr_diff(files, DEVTOOLS_ROOT)
    assert [(x.path, x.reason) for x in v] == [(f"{DEVTOOLS_ROOT}/random.md", "not_canonical")]
    assert scan_pr_diff(["context/random.md"], DEVTOOLS_ROOT) == []
    assert scan_pr_diff(["context/random.md"])  # default root still enforced


def test_updater_writes_under_configured_root(tmp_path: Path) -> None:
    upd = [ContextUpdate(path=f"{DEVTOOLS_ROOT}/modules/a.md", action="create", content="x")]
    apply_context_updates(upd, tmp_path, DEVTOOLS_ROOT)
    assert (tmp_path / DEVTOOLS_ROOT / "modules" / "a.md").read_text() == "x"
    with pytest.raises(ForbiddenContextPathError):
        apply_context_updates(
            [ContextUpdate(path="context/modules/a.md", action="create", content="x")],
            tmp_path,
            DEVTOOLS_ROOT,
        )


def test_loader_reads_configured_root(tmp_path: Path) -> None:
    root = tmp_path / DEVTOOLS_ROOT
    root.mkdir(parents=True)
    (root / "project.md").write_text("P", encoding="utf-8")
    (root / "navigation.md").write_text("N", encoding="utf-8")
    out = compose_context_prelude(persona="dev", app_repo_path=tmp_path, context_dir=DEVTOOLS_ROOT)
    assert f"## {DEVTOOLS_ROOT}/project.md" in out
    assert f"## {DEVTOOLS_ROOT}/navigation.md" in out
    # default root finds nothing here and names the default in the notice
    missing = compose_context_prelude(persona="dev", app_repo_path=tmp_path)
    assert "NO CONTEXT AVAILABLE" not in missing and "Onboarder" not in missing
    assert "`context/project.md`" in missing and "Continue from the code and the task." in missing
    other = compose_context_prelude(
        persona="dev", app_repo_path=tmp_path / "nope", context_dir="docs/ctx"
    )
    assert "`docs/ctx/project.md`" in other


def test_persona_prompts_render_configured_root() -> None:
    for name in ("onboarder", "tech_writer", "sm", "dev"):
        custom = read_persona_prompt(name, context_dir=DEVTOOLS_ROOT)
        default = read_persona_prompt(name)
        assert CONTEXT_DIR_TOKEN not in custom and CONTEXT_DIR_TOKEN not in default
        assert f"{DEVTOOLS_ROOT}/project.md" in custom or f"{DEVTOOLS_ROOT}/" in custom
        assert not re.search(r"(?<![\w/.\-])context/", custom), name
        assert "context/" in default


def test_placeholder_never_leaks() -> None:
    for name in available_personas():
        assert CONTEXT_DIR_TOKEN not in read_persona_prompt(name)


# --- no new hard-coded ``context/`` literal outside canonical_paths ---------------------

_LITERAL = re.compile(r"(?<![\w/.\-])context/")
# file (relative to factory/) -> why a literal is legitimate there
_ALLOW = {
    "context/canonical_paths.py": "the single source of truth",
    "manager/self_context.py": "factory's own self-context under the factory root, not an app root",
    "cli.py": "factory self-context CLI help text (apps/factory/context/modules/)",
}


def _string_literals(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docstrings.add(id(body[0].value))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) not in docstrings:
                yield node.lineno, node.value


def test_no_hardcoded_context_literals_outside_canonical_paths() -> None:
    offenders: list[str] = []
    for py in (FACTORY_ROOT / "factory").rglob("*.py"):
        rel = py.relative_to(FACTORY_ROOT / "factory").as_posix()
        if rel in _ALLOW:
            continue
        for lineno, value in _string_literals(py):
            if _LITERAL.search(value):
                offenders.append(f"{rel}:{lineno}: {value[:70]!r}")
    assert not offenders, "route these through canonical_paths.context_path:\n" + "\n".join(
        offenders
    )
