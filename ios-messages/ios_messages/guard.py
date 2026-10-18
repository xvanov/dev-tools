"""Keep real data out of the repo: check files against the private work dir.

Words in the files are compared with everything real the work dir knows --
contact name tokens, your names, handles and redact terms, configured cities,
house streets, real streets/ZIPs/names from mapping.json -- and numbers of 4+
digits with every number that occurs in your messages (codes, house numbers,
ZIPs). Meant as a git pre-commit hook (`ios-messages.py guard --staged`); it
prints file:line and the matched kind, never the value itself.
"""
from __future__ import annotations

import json
import os
import re
import subprocess

from .anonymize import ROLE_VOCAB, corpus_freq, fold, name_tokens, token_parts
from .store import load, load_contacts

WORD = re.compile(r"[^\W\d_]{3,}")
TOKEN = re.compile(r"(?<![\w])[A-Za-z0-9][A-Za-z0-9_-]{4,}(?![\w])")


def odd_shape(t: str) -> bool:
    """Shaped like an identifier rather than a word: qeRTWv, QWERTYU, ab12cd."""
    letters = [c for c in t if c.isalpha()]
    return bool(letters) and (any(c.isdigit() for c in t) and any(c.isalpha() for c in t)
                              or (any(c.islower() for c in t[1:]) and any(c.isupper() for c in t[1:]))
                              or (t.isupper() and len(t) >= 5))
NUMBER = re.compile(r"(?<!\d)\d{4,}(?!\d)")
# Words that are real in the data but too common to mean anything in code.
ALLOW = set("""
the and for with that this from have your about what when where which there their into will would could
house home room rent lease street road drive avenue lane court place city state test tests name names
""".split())


def private_terms(work: str) -> tuple[dict[str, str], set[str], set[str]]:
    """{folded word: kind}, numbers seen in messages, identifier-shaped tokens seen in messages."""
    terms: dict[str, str] = {}
    db = os.path.join(work, "db")
    contacts, _ = load_contacts(os.path.join(db, "AddressBook.sqlitedb"))
    for c in contacts.values():
        for t in name_tokens(f"{c.first} {c.last} {c.org}", set(), set()):
            for p in token_parts(t):
                if len(p) >= 4:
                    terms.setdefault(fold(p), "contact name")
    cfg_path = os.path.join(work, "config.json")
    if os.path.exists(cfg_path):
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
        for key, kind in (("owner_names", "owner name"), ("owner_surnames", "owner name"),
                          ("owner_handles", "owner handle"), ("redact_terms", "redact term"),
                          ("cities", "city"), ("extra_names", "name"), ("exclude_contacts", "employer"),
                          ("partners", "contact name")):
            for v in cfg.get(key, []):
                for w in WORD.findall(v.lstrip("=")):
                    terms[fold(w)] = kind
        for k in cfg.get("role_overrides", {}):
            for w in WORD.findall(k):
                terms[fold(w)] = "contact name"
    map_path = os.path.join(work, "private", "mapping.json")
    numbers: set[str] = set()
    if os.path.exists(map_path):
        with open(map_path, encoding="utf-8") as f:
            m = json.load(f)
        for key in m.get("houses", {}):
            for w in WORD.findall(key.split("|", 1)[-1]):
                terms[fold(w)] = "house street"
            numbers.add(key.split("|", 1)[0]) if key.split("|", 1)[0].isdigit() else None
        for core in m.get("streets", {}):
            for w in WORD.findall(core):
                terms.setdefault(fold(w), "street")
        for k in m.get("tokens", {}):
            w = k.split(":", 1)[-1]
            if len(w) >= 4:
                terms.setdefault(fold(w), "name")
        numbers.update(m.get("zips", {}))
    # message bodies the way the tool reads them (many live only in attributedBody)
    texts = [m.text for conv in load(db).conversations for m in conv.messages if m.text]         if os.path.exists(os.path.join(db, "sms.db")) else []
    odd: set[str] = set()
    for text in texts:
        numbers.update(NUMBER.findall(text))
        odd.update(t for t in TOKEN.findall(text) if odd_shape(t))
    # A word people write in lowercase is a word ("backup", "plumber"), not an identifier,
    # unless it names a place, a street or you.
    lower, _ = corpus_freq(texts)
    strict = {"owner name", "owner handle", "house street", "employer"}
    for w, kind in list(terms.items()):
        if w in ALLOW or w in ROLE_VOCAB or (kind not in strict and lower[w] >= 3):
            del terms[w]
    return terms, numbers, odd


def staged_files(repo: str) -> list[str]:
    out = subprocess.run(["git", "-C", repo, "diff", "--cached", "--name-only", "--diff-filter=ACM"],
                         capture_output=True, text=True, check=True).stdout
    return [os.path.join(repo, p) for p in out.splitlines() if p.strip()]


def load_allow(repo_tool_dir: str) -> set[str]:
    """Generic words a contact name happens to contain ("realty", "partners"): .guard-allow."""
    p = os.path.join(repo_tool_dir, ".guard-allow")
    if not os.path.exists(p):
        return set()
    with open(p, encoding="utf-8") as f:
        return {fold(w) for line in f for w in line.split("#", 1)[0].split()}


def check(paths: list[str], work: str, allow_numbers=frozenset(), show: bool = False) -> list[str]:
    terms, numbers, odd = private_terms(work)
    allow = load_allow(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    problems = []
    for path in paths:
        if not os.path.isfile(path) or not path.endswith((".py", ".md", ".txt", ".json", ".ps1", ".sh", ".js")):
            continue
        # the fake-name pools are lists of common names; a real contact sharing one is no leak
        pools = os.path.basename(path) == "fakes.py"
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f, 1):
                line = re.sub(r"\\[bBdDwWsSnt]", " ", line)  # a regex escape like \b before "rent" is not a name
                for t in TOKEN.findall(line):
                    if t in odd and fold(t) not in allow:
                        problems.append(f"{path}:{n}: token seen in your messages ({len(t)} chars)"
                                        + (f" [{t}]" if show else ""))
                for w in ([] if pools else WORD.findall(line)):
                    kind = terms.get(fold(w))
                    if kind and fold(w) not in allow:
                        problems.append(f"{path}:{n}: {kind} ({len(w)} letters)" + (f" [{w}]" if show else ""))
                for num in NUMBER.findall(line):
                    if num in numbers and num not in allow_numbers and len(num) >= 5 and not num.endswith("000"):
                        problems.append(f"{path}:{n}: number seen in your messages ({len(num)} digits)"
                                        + (f" [{num}]" if show else ""))
    return problems
