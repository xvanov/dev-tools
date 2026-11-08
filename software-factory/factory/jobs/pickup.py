"""``factory job submit --branch / --pr`` — resolve existing work on GitHub (v1.3).

Submit asks GitHub, in one GraphQL read, what the job will continue on (the PR
or branch and the PR's review threads), and refuses anything it cannot safely
work on. What it resolves is written to the direction's
frontmatter as ``base: {branch, pr, into}`` (``factory/chain/pickup.py`` reads
it at spawn). Every GitHub read goes through ``factory.jobs.github._run_gh``,
the seam the tests fake.

Refusals (stable ``error`` codes, docs/JOBS-API.md § v1.3):

* ``invalid_argument`` — both ``--branch`` and ``--pr``; a non-code kind;
  ``--pr`` not a positive integer.
* ``invalid_branch`` — not a usable branch name.
* ``branch_is_default`` — the app's default branch (that is ``push_to_main``).
* ``branch_not_found`` — no such branch on GitHub.
* ``pr_not_found`` / ``pr_not_open`` (merged or closed) / ``pr_from_fork``.
* ``github_unavailable`` — GitHub could not be asked. Fail safe: a job never
  starts on a branch nobody verified.
* ``branch_busy`` — another unfinished job already works on that branch
  (checked by submit, under its lock).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from factory.jobs import github as gh_mod
from factory.jobs.common import JobError

#: Unresolved review threads fed to the dev (a snapshot taken at submit).
MAX_REVIEW_THREADS = 30
_COMMENT_CHARS = 1200

_BAD_BRANCH = re.compile(r"(^[-/.])|([/.]$)|\.\.|//|@\{|[\x00-\x20~^:?*\[\\]|\.lock$|/\.")


@dataclass
class Pickup:
    branch: str
    pr: int | None = None
    into: str | None = None
    pr_url: str | None = None
    draft: bool | None = None
    review_md: str = ""
    warnings: list[str] = field(default_factory=list)

    def frontmatter(self) -> dict[str, Any]:
        return {"branch": self.branch, "pr": self.pr, "into": self.into}


def validate_branch_name(name: str) -> str:
    branch = (name or "").strip()
    if branch.startswith("refs/heads/"):
        branch = branch[len("refs/heads/") :]
    if not branch or _BAD_BRANCH.search(branch) or len(branch) > 250:
        raise JobError("invalid_branch", f"--branch {name!r} is not a usable branch name")
    return branch


def _gh(args: list[str]) -> Any:
    try:
        return gh_mod._run_gh(args)
    except Exception as exc:  # noqa: BLE001 - any failure = cannot ask
        raise JobError("github_unavailable", f"gh failed: {exc}") from exc


def _json(proc: Any, what: str) -> Any:
    try:
        return json.loads(proc.stdout or "null")
    except json.JSONDecodeError as exc:
        raise JobError("github_unavailable", f"{what}: gh returned non-JSON") from exc


def _not_found(proc: Any) -> bool:
    err = (proc.stderr or "") + (proc.stdout or "")
    return any(
        s in err for s in ("Not Found", "404", "no pull requests found", "Could not resolve")
    )


_PR_NODE = """
  number state url headRefName baseRefName isCrossRepository isDraft
  reviewThreads(first: 100) {
    nodes {
      isResolved
      isOutdated
      path
      line
      comments(first: 5) { nodes { author { login } body } }
    }
  }
"""

#: One read for ``--pr``: the PR and its review threads together (8.4.26: the
#: three serial calls this replaced cost seconds per submit).
_PR_QUERY = (
    "query($owner: String!, $name: String!, $number: Int!) {\n"
    "  repository(owner: $owner, name: $name) {\n"
    "    pullRequest(number: $number) {" + _PR_NODE + "}\n"
    "  }\n"
    "}\n"
)

#: One read for ``--branch``: the branch (null when missing) and its open PRs.
_BRANCH_QUERY = (
    "query($owner: String!, $name: String!, $ref: String!) {\n"
    "  repository(owner: $owner, name: $name) {\n"
    "    ref(qualifiedName: $ref) {\n"
    "      name\n"
    "      associatedPullRequests(states: OPEN, first: 10) { nodes {" + _PR_NODE + "} }\n"
    "    }\n"
    "  }\n"
    "}\n"
)


def _graphql(repo: str, query: str, what: str, **variables: Any) -> dict[str, Any]:
    """``repository`` from one GraphQL read. Raises ``JobError``.

    A missing repository or PR is GitHub's NOT_FOUND: ``pr_not_found`` (the
    caller reads it as "no such PR"); anything else is ``github_unavailable``.
    """
    owner, _, name = repo.partition("/")
    args = ["api", "graphql", "-f", f"query={query}", "-F", f"owner={owner}", "-F", f"name={name}"]
    for key, value in variables.items():
        # -F types an int; a branch ref stays a string (-f).
        args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    proc = _gh(args)
    if proc.returncode != 0:
        if _not_found(proc):
            raise JobError("pr_not_found", f"{what} not found in {repo}")
        raise JobError(
            "github_unavailable", f"{what}: gh failed: {(proc.stderr or '').strip()[:200]}"
        )
    data = _json(proc, what)
    if not isinstance(data, dict) or data.get("errors"):
        errors = data.get("errors") if isinstance(data, dict) else None
        if errors and all((e or {}).get("type") == "NOT_FOUND" for e in errors):
            raise JobError("pr_not_found", f"{what} not found in {repo}")
        raise JobError("github_unavailable", f"{what}: {str(errors or data)[:200]}")
    repository = (data.get("data") or {}).get("repository")
    if not isinstance(repository, dict):
        raise JobError("pr_not_found", f"{what}: no repository {repo}")
    return repository


def read_pr(repo: str, number: int) -> dict[str, Any]:
    """The PR and its review threads in one read. Raises ``JobError``."""
    pr = _graphql(repo, _PR_QUERY, f"PR #{number}", number=number).get("pullRequest")
    if not isinstance(pr, dict):
        raise JobError("pr_not_found", f"no PR #{number} in {repo}")
    return pr


def _check_pr(data: dict[str, Any], repo: str) -> None:
    number = data.get("number")
    state = str(data.get("state") or "").upper()
    if state != "OPEN":
        raise JobError("pr_not_open", f"PR #{number} in {repo} is {state.lower() or 'not open'}")
    if data.get("isCrossRepository"):
        raise JobError(
            "pr_from_fork",
            f"PR #{number} comes from a fork; the factory can only push to branches of {repo}",
        )


def read_branch(repo: str, branch: str) -> tuple[bool, dict[str, Any] | None]:
    """Whether ``branch`` exists, and its open same-repo PR, in one read."""
    found = _graphql(repo, _BRANCH_QUERY, f"branch {branch!r}", ref=f"refs/heads/{branch}")
    ref = found.get("ref")
    if not isinstance(ref, dict):
        return False, None
    nodes = ((ref.get("associatedPullRequests") or {}).get("nodes")) or []
    own = [
        r
        for r in nodes
        if isinstance(r, dict)
        and not r.get("isCrossRepository")
        and str(r.get("headRefName") or "") == branch
    ]
    return True, (own[0] if own else None)


def review_threads_md(pr: dict[str, Any]) -> tuple[str, str | None]:
    """The PR's UNRESOLVED review threads as markdown (a submit-time snapshot).

    ``pr`` is a node from :func:`read_pr` / :func:`read_branch`, threads
    included. Returns ``(markdown, warning)``: threads it cannot read are a
    warning, never a refusal (the PR itself is verified).
    """
    number = pr.get("number")
    try:
        nodes = pr["reviewThreads"]["nodes"]
    except (KeyError, TypeError):
        return "", f"could not read PR #{number} review threads"
    lines: list[str] = []
    open_threads = [n for n in nodes or [] if isinstance(n, dict) and not n.get("isResolved")]
    for thread in open_threads[:MAX_REVIEW_THREADS]:
        where = str(thread.get("path") or "(general)")
        if thread.get("line"):
            where += f":{thread['line']}"
        if thread.get("isOutdated"):
            where += " (outdated)"
        comments = ((thread.get("comments") or {}).get("nodes")) or []
        for i, c in enumerate(comments):
            author = ((c or {}).get("author") or {}).get("login") or "?"
            body = " ".join(str((c or {}).get("body") or "").split())[:_COMMENT_CHARS]
            prefix = f"- `{where}` — **{author}**: " if i == 0 else f"  - reply **{author}**: "
            lines.append(prefix + body)
    if not lines:
        return "", None
    more = len(open_threads) - MAX_REVIEW_THREADS
    if more > 0:
        lines.append(f"- … and {more} more unresolved thread(s) on the PR")
    return "\n".join(lines), None


def resolve_pickup(repo: str, default_branch: str, *, branch: str | None, pr: int | None) -> Pickup:
    """Ask GitHub what ``--branch`` / ``--pr`` names. Raises ``JobError``."""
    if branch and pr is not None:
        raise JobError("invalid_argument", "pass only one of --branch or --pr")
    if pr is not None:
        if int(pr) <= 0:
            raise JobError("invalid_argument", f"--pr must be a positive PR number, got {pr}")
        data = read_pr(repo, int(pr))
        _check_pr(data, repo)
        head = str(data.get("headRefName") or "")
        if not head:
            raise JobError("github_unavailable", f"PR #{pr} reported no head branch")
        found: dict[str, Any] | None = data
        name = head
    else:
        name = validate_branch_name(branch or "")
        exists, found = read_branch(repo, name)
        if not exists:
            raise JobError("branch_not_found", f"no branch {name!r} in {repo}")
    if name == (default_branch or "main"):
        raise JobError(
            "branch_is_default",
            f"{name!r} is {repo}'s default branch; a job cannot work on it directly "
            "(use --delivery push_to_main without --branch)",
        )
    out = Pickup(branch=name, into=default_branch or "main")
    if found is not None:
        out.pr = int(found["number"])
        out.into = str(found.get("baseRefName") or "") or out.into
        out.pr_url = str(found.get("url") or "") or None
        out.draft = bool(found.get("isDraft"))
        md, warning = review_threads_md(found)
        out.review_md = md
        if warning:
            out.warnings.append(warning)
        if out.into != (default_branch or "main"):
            out.warnings.append(
                f"PR #{out.pr} merges into {out.into!r}, not the default branch; the factory "
                "refreshes and pushes against it, but its local gates still diff against "
                f"{default_branch or 'main'!r}"
            )
    return out


__all__ = [
    "Pickup",
    "read_branch",
    "read_pr",
    "resolve_pickup",
    "review_threads_md",
    "validate_branch_name",
]
