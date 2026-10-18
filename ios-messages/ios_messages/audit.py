"""Leak check: grep the anonymized output for anything real.

Looks for every real phone number and email in the backup (in any formatting),
contact full names (any length) and name tokens, company names, house streets
and numbers, real ZIP codes seen while scrubbing, the owner's names in any
script, configured cities and redact_terms. Writes private/leak-report.txt (it
quotes real values, so it stays private) and returns counts per category.

Hard categories should be zero before sharing. "soft" ones are words that are
also ordinary words (a contact called Will, Grace, Lane): they need a human
look, since most hits are the word, not the person.
"""
from __future__ import annotations

import json
import os
import re
from collections import Counter, defaultdict

from . import fakes
from .addresses import AMBIGUOUS_STREETS
from .anonymize import (ROLE_VOCAB, corpus_freq, corpus_texts, fold, is_wordlike, levenshtein1, name_tokens,
                        redact_regex, token_parts)
from .classify import Classification
from .store import Store, norm_handle

PHONE_ANY = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")
EMAIL_ANY = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
WORD = re.compile(r"[^\W\d_]{2,}")
HARD = ("phone", "email", "house address", "owner name", "owner handle", "contact full name", "company",
        "redact term",
        "zip", "city", "house street", "contact name token")
SOFT = ("contact name token (common word)",)


def _read_all(out_dir: str) -> list[tuple[str, str]]:
    files = []
    for root, _, names in os.walk(out_dir):
        for n in names:
            if n.endswith((".txt", ".csv", ".jsonl")):
                p = os.path.join(root, n)
                with open(p, encoding="utf-8-sig") as f:
                    text = f.read()
                if n.endswith(".jsonl"):  # check what a reader sees, not JSON escapes
                    # split on \n only: U+2028 inside a JSON string is not a record break
                    text = "\n".join(json.loads(line).get("text", "") for line in text.split("\n") if line)
                files.append((os.path.relpath(p, out_dir), text))
    return files


def audit(store: Store, cls: Classification, config: dict, out_dir: str, report_path: str,
          private_dir: str | None = None) -> dict:
    files = _read_all(out_dir)
    real_handles = set(store.raw_handle) | {h for c in store.contacts.values() for h in c.handles}
    real_phones = {h for h in real_handles if h.isdigit() and len(h) == 10}
    real_phones |= {norm_handle(p) for p in config.get("owner_phones", [])}
    real_emails = {h for h in real_handles if "@" in h}
    real_zips = set()
    if private_dir and os.path.exists(os.path.join(private_dir, "mapping.json")):
        with open(os.path.join(private_dir, "mapping.json"), encoding="utf-8") as f:
            real_zips = set(json.load(f).get("zips", {}))

    house_cores = {h.core for h in cls.houses.houses.values()}
    cities = {c.lower() for c in config.get("cities", [])}
    ignore = {fold(w) for w in config.get("ignore_names", [])}
    full_names, tokens, orgs = set(), set(), set()
    for c in store.contacts.values():
        if c.org and len(c.org) >= 5:
            orgs.add(c.org)
        if not (c.first or c.last):
            continue
        toks = [fold(p) for t in name_tokens(f"{c.first} {c.last}", set(), set()) for p in token_parts(t)]
        if len(toks) >= 2 and not any(t in fakes.NON_NAMES for t in toks):
            full_names.add(" ".join(toks))
        tokens.update(t for t in toks if len(t) >= 2)
    # Real tokens are checked even when they look like a fake: the pools drop any
    # entry equal to a real name, so a match is a real leak, not a pseudonym.
    tokens -= ROLE_VOCAB | ignore | {"unknown", "someone", "partner", "prospect"}  # labels the output itself writes
    owner = {fold(t) for n in config.get("owner_names", []) + config.get("owner_surnames", []) for t in n.split()}
    owner_near = [t for t in owner if len(t) >= 4]
    handles = [h.strip().lstrip("@").lower() for h in config.get("owner_handles", []) if h.strip()]
    redact = [t for t in config.get("redact_terms", []) if t.strip()]
    max_n = max((len(n.split()) for n in full_names), default=2)
    lower, cap = corpus_freq(corpus_texts(store))
    orgs = {o.lower() for o in orgs
            if any(not is_wordlike(fold(w), lower, cap) and fold(w) not in ROLE_VOCAB for w in WORD.findall(o))}

    findings: dict[str, Counter] = defaultdict(Counter)
    examples: dict[tuple, str] = {}

    def hit(kind, value, path, text, pos):
        findings[kind][value] += 1
        examples.setdefault((kind, value), f"{path}: ...{text[max(0, pos - 50):pos + 50]}...".replace("\n", " "))

    numbered = [(h.number, h.core, re.compile(rf"\b{re.escape(h.number)}\w?\s+{re.escape(h.core)}\b", re.I))
                for h in cls.houses.houses.values() if h.number]
    street_cores = sorted((c for c in house_cores if len(c) >= 4 and not c[:1].isdigit()
                           and c not in AMBIGUOUS_STREETS), key=len, reverse=True)
    core_re = re.compile(r"\b(" + "|".join(re.escape(c) for c in street_cores) + r")\b", re.I) \
        if street_cores else None
    phrase_res = [(kind, re.compile(r"(?<!\w)" + re.escape(v).replace(r"\ ", r"\s+") + r"(?!\w)",
                                    0 if len(v) < 4 else re.I))
                  for kind, vals in (("city", cities), ("company", orgs)) for v in vals]
    phrase_res.append(("redact term", redact_regex(redact)))  # same "=Term" rule as the scrubber
    zip_re = re.compile(r"(?<!\d)(" + "|".join(map(re.escape, real_zips)) + r")(?!\d)") if real_zips else None

    for path, text in files:
        for m in PHONE_ANY.finditer(text):
            if norm_handle(m.group(0)) in real_phones:
                hit("phone", norm_handle(m.group(0)), path, text, m.start())
        for m in EMAIL_ANY.finditer(text):
            if m.group(0).lower() in real_emails:
                hit("email", m.group(0).lower(), path, text, m.start())
        for n, c, r in numbered:
            for m in r.finditer(text):
                hit("house address", f"{n} {c}", path, text, m.start())
        if core_re:
            for m in core_re.finditer(text):
                hit("house street", m.group(1).lower(), path, text, m.start())
        low_text = text.lower()
        for hnd in handles:
            for m in re.finditer(rf"(?<![\w.]){re.escape(hnd)}(?![\w])", low_text):
                hit("owner handle", hnd, path, text, m.start())
        for kind, r in phrase_res:
            for m in r.finditer(text):
                hit(kind, m.group(0).lower(), path, text, m.start())
        if zip_re:
            for m in zip_re.finditer(text):
                hit("zip", m.group(1), path, text, m.start())
        words = list(WORD.finditer(text))
        folded = [fold(w.group(0)) for w in words]
        for i in range(len(words)):
            for n in range(2, max_n + 1):
                if i + n > len(words):
                    break
                if " ".join(folded[i:i + n]) in full_names and \
                        all(text[words[j].end():words[j + 1].start()] == " " for j in range(i, i + n - 1)):
                    hit("contact full name", " ".join(folded[i:i + n]), path, text, words[i].start())
        for w, low in zip(words, folded):
            if low in owner or (len(low) >= 4 and not is_wordlike(low, lower, cap)
                                and any(levenshtein1(low, t) for t in owner_near)):
                hit("owner name", low, path, text, w.start())  # any case, one typo away included
            elif low in tokens:
                if not is_wordlike(low, lower, cap):
                    if w.group(0)[:1].isupper() or len(low) >= 4:  # "jesus vilchis" in lowercase too
                        hit("contact name token", low, path, text, w.start())
                elif w.group(0)[:1].isupper() and low not in fakes.NON_NAMES and                         (low in fakes.COMMON_WORD_NAMES or lower[low] < 20 * max(1, cap[low])):
                    # Will, Grace, Hope: maybe the person, maybe the word. Words people
                    # write in lowercase twenty times as often ("hello", "it") aren't worth a look.
                    hit("contact name token (common word)", low, path, text, w.start())

    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("Leak report for the anonymized output (quotes real values: keep private)\n")
        f.write("Hard categories should be 0. Soft ones are names that are also words: skim them.\n\n")
        for kind in HARD + SOFT:
            c = findings.get(kind, Counter())
            f.write(f"== {kind}{' (soft)' if kind in SOFT else ''}: {sum(c.values())} hits, {len(c)} distinct\n")
            for value, n in c.most_common(60):
                f.write(f"  {n:>5}  {value}  | {examples[(kind, value)]}\n")
            f.write("\n")
    return {k: sum(v.values()) for k, v in findings.items()}
