"""``review_ready`` delivery: take a green ``draft_pr`` / ``pr`` PR to "ready for
human review" — marked ready, the review bot's (CodeRabbit's) comments addressed.

Why: CodeRabbit reviews only NON-draft PRs (``.coderabbit.yaml``
``auto_review.drafts: false``), so a PR left as a draft never gets the review a
human would otherwise start from. Opt-in per app (``delivery.review_ready``);
the factory still never merges.

All GitHub access is here (``gh``), behind small functions the CI watch calls
(``auto_merge._watch_ci_then_deliver``) and tests replace. Never raises.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any

#: Rounds of "dev addresses the bot's comments" before delivering anyway.
MAX_REVIEW_ROUNDS = 3
#: How long to wait for the bot's review of the current head (after marking
#: ready, or after pushing a review fix) before delivering with a note.
REVIEW_WAIT_S = 20 * 60

EVENT_MARKED = "review_ready_marked"
EVENT_RESOLVED = "review_threads_resolved"

_QUERY = """
query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){
pullRequest(number:$pr){isDraft headRefOid
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:60){nodes{
__typename ... on StatusContext{context state} ... on CheckRun{name conclusion}}}}}}}
reviews(last:50){nodes{author{login} commit{oid}}}
reviewThreads(first:100){nodes{id isResolved isOutdated path line
comments(first:5){nodes{author{login} body}}}}}}}
"""


def is_review_bot(login: Any) -> bool:
    return str(login or "").lower().startswith("coderabbit")


def _gh(args: list[str], timeout: int = 60) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            ["gh", *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return False, repr(exc)
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "").strip()[:300]
    return True, proc.stdout


def mark_ready(repo: str, pr: int) -> str | None:
    """``gh pr ready``. None on success, else the error text."""
    ok, out = _gh(["pr", "ready", str(pr), "--repo", repo])
    return None if ok else out


def read_state(repo: str, pr: int) -> dict[str, Any] | None:
    """``{"head", "is_draft", "reviewed_heads": [oid], "open_threads":
    [{"id", "path", "line", "body"}]}`` for the bot's review of ``pr``; None
    when GitHub could not be read. Open threads = unresolved threads the bot
    started."""
    owner, _, name = repo.partition("/")
    ok, out = _gh(
        [
            "api",
            "graphql",
            "-f",
            f"query={_QUERY}",
            "-f",
            f"owner={owner}",
            "-f",
            f"name={name}",
            "-F",
            f"pr={pr}",
        ]
    )
    if not ok:
        return None
    try:
        node = json.loads(out)["data"]["repository"]["pullRequest"]
        reviews = node["reviews"]["nodes"]
        threads = node["reviewThreads"]["nodes"]
        rollup = ((node["commits"]["nodes"] or [{}])[0].get("commit") or {}).get(
            "statusCheckRollup"
        )
        contexts = ((rollup or {}).get("contexts") or {}).get("nodes") or []
    except (ValueError, KeyError, TypeError):
        return None
    heads = sorted(
        {
            str((r.get("commit") or {}).get("oid"))
            for r in reviews
            if is_review_bot((r.get("author") or {}).get("login"))
            and (r.get("commit") or {}).get("oid")
        }
    )
    open_threads: list[dict[str, Any]] = []
    for t in threads:
        comments = (t.get("comments") or {}).get("nodes") or []
        # An outdated thread points at code the PR no longer has: nothing to fix.
        if t.get("isResolved") or t.get("isOutdated") or not comments:
            continue
        if not is_review_bot((comments[0].get("author") or {}).get("login")):
            continue
        open_threads.append(
            {
                "id": t.get("id"),
                "path": t.get("path"),
                "line": t.get("line"),
                "body": str(comments[0].get("body") or "")[:3000],
            }
        )
    # The bot's own check finishing on the head also means "reviewed": an
    # incremental review with nothing to say posts no review object.
    bot_done = any(
        is_review_bot(c.get("context") or c.get("name"))
        and str(c.get("state") or c.get("conclusion") or "").upper() == "SUCCESS"
        for c in contexts
    )
    if bot_done and node.get("headRefOid"):
        heads = sorted({*heads, str(node["headRefOid"])})
    return {
        "head": node.get("headRefOid"),
        "is_draft": bool(node.get("isDraft")),
        "reviewed_heads": heads,
        "open_threads": open_threads,
    }


def reply_and_resolve(thread_id: str, body: str) -> str | None:
    """Reply on a review thread, then resolve it. None on success, else error."""
    ok, out = _gh(
        [
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!,$b:String!){addPullRequestReviewThreadReply(input:"
            "{pullRequestReviewThreadId:$id,body:$b}){comment{id}}}",
            "-f",
            f"id={thread_id}",
            "-f",
            f"b={body}",
        ]
    )
    if not ok:
        return out
    ok, out = _gh(
        [
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}",
            "-f",
            f"id={thread_id}",
        ]
    )
    return None if ok else out


def review_finding(pr: int, threads: list[dict[str, Any]], rnd: int) -> dict[str, str]:
    """The dev's finding: the bot's open comments, verbatim."""
    parts = [f"--- {t.get('path')}:{t.get('line')}\n{t.get('body')}" for t in threads]
    return {
        "severity": "high",
        "criterion": "review",
        "location": f"CodeRabbit review (PR #{pr})",
        "what": (
            f"CodeRabbit left {len(threads)} open review comment(s) on PR #{pr} "
            f"(review round {rnd}/{MAX_REVIEW_ROUNDS}). For each: fix it if it is valid. If it "
            "is wrong or out of scope, leave the code alone and say why in your final "
            "summary. Keep every fix minimal and keep the tests green.\n\n" + "\n\n".join(parts)
        ),
    }
