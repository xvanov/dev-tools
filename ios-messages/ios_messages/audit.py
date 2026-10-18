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
from .addresses import AMBIGUOUS_STREETS, SUFFIX_RE
from .anonymize import (ROLE_VOCAB, STATES, corpus_freq, corpus_texts, fold, is_wordlike, name_tokens,
                        owner_variant, redact_regex, token_parts)
from .classify import Classification
from .store import Store, norm_handle

PHONE_ANY = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")
EMAIL_ANY = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
WORD = re.compile(r"[^\W\d_]{2,}")
HARD = ("phone", "email", "house address", "owner name", "owner handle", "contact full name", "company",
        "street", "state",
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
    real_zips, real_streets, persons = set(), set(), []
    if private_dir and os.path.exists(os.path.join(private_dir, "mapping.json")):
        with open(os.path.join(private_dir, "mapping.json"), encoding="utf-8") as f:
            data = json.load(f)
        real_zips = set(data.get("zips", {}))
        persons = list(data.get("persons", {}).values()) + [{"first": v, "last": v} for v in data.get("tokens", {}).values()]
        real_streets = set(data.get("streets", {}))

    house_cores = {h.core for h in cls.houses.houses.values()}
    cities = set(config.get("cities", []))  # as written: short ones ("SF") match case-sensitively
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
    owner_list = sorted(owner)
    handles = [h.strip().lstrip("@").lower() for h in config.get("owner_handles", []) if h.strip()]
    redact = [t for t in config.get("redact_terms", []) if t.strip()]
    max_n = max((len(n.split()) for n in full_names), default=2)
    lower, cap = corpus_freq(corpus_texts(store))
    orgs = {o.lower() for o in orgs
            if any(not is_wordlike(fold(w), lower, cap) and fold(w) not in ROLE_VOCAB for w in WORD.findall(o))}
    # real streets other than the houses' (from mapping.json), when they aren't ordinary words
    other_streets = sorted({c for c in real_streets if len(c) >= 4 and not c[:1].isdigit() and c not in house_cores
                            and c not in AMBIGUOUS_STREETS and not all(is_wordlike(fold(w), lower, cap)
                                                                         for w in c.split())}, key=len, reverse=True)
    # a real street counts with a suffix or a house number: "pecan" alone is a nut
    alt = "|".join(re.escape(c).replace(r"\ ", r"\s+") for c in other_streets)
    street_re = re.compile(rf"(?:\b\d{{1,6}}\s+({alt})(?![^\W_])|(?<![^\W_])({alt})\s+(?:{SUFFIX_RE})\b)",
                           re.I) if other_streets else None

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
    state_re = re.compile(r"(?<![^\W_])([A-Za-z]{2}),?\s+\d{5}(?!\d)")
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
        if street_re:
            for m in street_re.finditer(text):
                hit("street", (m.group(1) or m.group(2)).lower(), path, text, m.start())
        for m in state_re.finditer(text):  # "Springfield, nc 00417": the state still says where
            if m.group(1).upper() in STATES:
                hit("state", m.group(1).upper(), path, text, m.start())
        words = list(WORD.finditer(text))
        folded = [fold(w.group(0)) for w in words]
        for i in range(len(words)):
            for n in range(2, max_n + 1):
                if i + n > len(words):
                    break
                if " ".join(folded[i:i + n]) in full_names and \
                        all(text[words[j].end():words[j + 1].start()] == " " for j in range(i, i + n - 1)):
                    hit("contact full name", " ".join(folded[i:i + n]), path, text, words[i].start())
        fakes_seen = {p["first"].lower() for p in persons} | {p["last"].lower() for p in persons}
        for w, low in zip(words, folded):
            if text[w.end():w.end() + 1] == "…":  # a truncated tapback quote, not a word
                continue
            if low in fakes_seen and low not in owner:  # a pseudonym we wrote
                continue
            if low in owner or ((not is_wordlike(low, lower, cap) or low in owner)
                                and owner_variant(low, owner_list, w.group(0)[:1].isupper())):
                hit("owner name", low, path, text, w.start())  # same spellings the scrubber catches
            elif low in tokens:
                if not is_wordlike(low, lower, cap):
                    if w.group(0)[:1].isupper() or len(low) >= 3:  # lowercase names too
                        hit("contact name token", low, path, text, w.start())
                elif w.group(0)[:1].isupper() and low not in fakes.NON_NAMES and \
                        (low in fakes.COMMON_WORD_NAMES or lower[low] < 20 * max(1, cap[low])):
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
