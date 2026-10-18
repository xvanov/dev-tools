"""Recognise street addresses and resolve the many ways one house gets written.

A contact tagged "1420 Larch Rd", another "Larch rd Tenant", a group named
"1420 larch Rd " and a text saying "back at larch tonight" all mean one house.
The registry learns houses from numbered addresses (number + street + suffix),
then resolves numberless or suffixless mentions against the streets it knows.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

SUFFIXES = {
    "st": "St", "street": "St", "rd": "Rd", "road": "Rd", "ave": "Ave", "av": "Ave",
    "avenue": "Ave", "dr": "Dr", "drive": "Dr", "way": "Way", "ln": "Ln", "lane": "Ln",
    "ct": "Ct", "court": "Ct", "blvd": "Blvd", "boulevard": "Blvd", "pl": "Pl",
    "place": "Pl", "cir": "Cir", "circle": "Cir", "pkwy": "Pkwy", "parkway": "Pkwy",
    "ter": "Ter", "terrace": "Ter", "trl": "Trl", "trail": "Trl", "hwy": "Hwy",
    "highway": "Hwy", "loop": "Loop", "sq": "Sq", "square": "Sq",
}
SUFFIX_RE = "|".join(sorted(SUFFIXES, key=len, reverse=True))
DIRECTIONS = {"n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"}

# Words that can sit between a number and "way"/"st"/"dr" in ordinary chat
# ("5 pm way too late", "2 more st") and so must never start a street name.
NOT_STREET = set("""
a an the to and or of my your our their his her its this that these those is was are be
am pm min mins minute minutes hr hrs hour hours day days week weeks month months year years
any all one some every other same more less much many few long half which there here no
people times dollars bucks k grand percent ok yes yep text call way st dr rd ave
at in on by for from near off with room rooms unit apt suite bed beds bath baths floor
best only right wrong easy hard either what whatever same long
""".split())
_NOT_ALT = "|".join(sorted(NOT_STREET, key=len, reverse=True))

# Street names that are also common words or names: only trust them with a
# suffix ("Elm St") or a house number in front, never bare.
AMBIGUOUS_STREETS = set("""
north south east west main station park lake hill oak pine maple cedar elm church
king queen market center central union mill spring river high school college
""".split())

# A street word may not be a filler word or a bare number, so in "room 2 at
# 1420 Larch Rd" the "2" can't swallow "at 1420 larch" and hide the address.
_STREET_WORD = rf"(?!(?:{_NOT_ALT})\b)(?!\d+\b)[A-Za-z0-9][\w'.-]*"
NUMBERED = re.compile(
    rf"\b(\d{{1,6}})([A-Za-z])?\s+((?:{_STREET_WORD}\s+){{1,3}}?)({SUFFIX_RE})\b\.?",
    re.IGNORECASE)
# "on Bellflower Ave", "near 28th ave", "corner of Copperline st": a street with a
# suffix and no number. The street word must be capitalised or an ordinal, and
# "Dr" is left out (Dr. Okoro), so "no way" and "by the way" stay prose.
NAMED_SUFFIX_RE = "|".join(sorted((k for k in SUFFIXES if k != "dr"), key=len, reverse=True))
STREET_NAMED = re.compile(
    rf"\b((?:(?:(?!(?i:{_NOT_ALT})\b)[A-Z][a-z]+|\d{{1,3}}(?:st|nd|rd|th))\s+){{1,2}})"
    rf"((?i:{NAMED_SUFFIX_RE}))\b\.?")
# "28th Ave and Quarrel", "36th @ Brindle": the cross street after a street
CROSS_STREET = re.compile(r"[ \t]+(?:and|&|@|at|/)[ \t]+([A-Z][a-z]{2,}|\d{1,3}(?:st|nd|rd|th))\b(?![ \t]+[A-Z])")


def _clean_core(words: str) -> str:
    toks = [t.strip(".,'").lower() for t in words.split()]
    toks = [t for t in toks if t]
    if toks and toks[0] in DIRECTIONS and len(toks) > 1:
        toks = toks[1:]
    return " ".join(toks)


def _valid_core(core: str, number: str, raw_words: str) -> bool:
    if not core or core.split()[0] in NOT_STREET:
        return False
    if any(t in NOT_STREET for t in core.split()):
        return False
    # a one-digit house number is real ("7 Fernhollow Dr") but so is "5 pm way";
    # demand a capitalised street before believing it
    if len(number) == 1 and not raw_words.strip()[:1].isupper() and not raw_words.strip()[:1].isdigit():
        return False
    return True


@dataclass
class AddressHit:
    start: int
    end: int
    number: str
    unit: str
    core: str
    suffix: str  # canonical, "" if absent
    kind: str  # "numbered", "numbered-known", "bare", "named", "alias", "street"
    house: str | None = None  # registry key when it resolves to a known house


def find_numbered(text: str) -> list[AddressHit]:
    hits = []
    for m in NUMBERED.finditer(text):
        core = _clean_core(m.group(3))
        if _valid_core(core, m.group(1), m.group(3)):
            hits.append(AddressHit(m.start(), m.end(), m.group(1), (m.group(2) or "").upper(),
                                   core, SUFFIXES[m.group(4).lower()], "numbered"))
    return hits


def find_streets(text: str) -> list[AddressHit]:
    """Numberless 'Bellflower Ave' style mentions."""
    hits = []
    for m in STREET_NAMED.finditer(text):
        core = _clean_core(m.group(1))
        suffix_word = m.group(2)
        # a lowercase suffix ("st", "way") only after an ordinal or a capitalised name
        if not core or (suffix_word.islower() and suffix_word in ("way", "place", "square", "loop", "court")):
            continue
        hits.append(AddressHit(m.start(), m.end(), "", "", core, SUFFIXES[suffix_word.lower()], "street"))
        x = CROSS_STREET.match(text, m.end())
        if x and x.group(1).lower() not in NOT_STREET:
            hits.append(AddressHit(x.start(1), x.end(1), "", "", _clean_core(x.group(1)), "", "street"))
    return hits


@dataclass
class House:
    key: str
    number: str
    core: str
    suffixes: Counter = field(default_factory=Counter)
    refs: int = 0
    rental: bool = False
    sources: set = field(default_factory=set)

    @property
    def suffix(self) -> str:
        return self.suffixes.most_common(1)[0][0] if self.suffixes else ""

    @property
    def label(self) -> str:
        if not self.number:
            return f"{self.core.title()} House"
        return f"{self.number} {self.core.title()} {self.suffix}".strip()


class HouseRegistry:
    def __init__(self, aliases: dict[str, str] | None = None):
        self.houses: dict[str, House] = {}
        self.alias_text = {k.lower().strip(): v for k, v in (aliases or {}).items()}
        self.alias_keys: dict[str, str] = {}
        self._compiled = None
        self._by_core: dict[str, list[House]] = {}

    # ---- learning ----
    @staticmethod
    def key_for(number: str, core: str) -> str:
        return f"{number}|{core}" if number else f"name|{core}"

    def add(self, number: str, core: str, suffix: str = "", source: str = "") -> House:
        key = self.key_for(number, core)
        h = self.houses.get(key)
        if h is None:
            h = self.houses[key] = House(key, number, core)
        if suffix:
            h.suffixes[suffix] += 1
        h.refs += 1
        if source:
            h.sources.add(source)
        self._compiled = None
        return h

    def learn(self, text: str, source: str = "") -> list[str]:
        """Record every numbered address in `text`; return their keys."""
        return [self.add(a.number, a.core, a.suffix, source).key for a in find_numbered(text)]

    def learn_named(self, text: str, source: str = "") -> list[str]:
        """'Lakeview House' style names that do not resolve to a known street."""
        keys = []
        for m in re.finditer(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?i:house|home)\b", text):
            name = m.group(1).lower()
            if name.split()[-1] in {"the", "a", "my", "our", "this", "that", "your"}:
                continue
            if self.resolve(name) or name in self.alias_text:
                continue
            keys.append(self.add("", name, "", source).key)
        return keys

    def finalize_aliases(self) -> None:
        """Turn alias targets ("960 Summit Dr") into house keys."""
        resolved = {}
        for text, target in self.alias_text.items():
            hits = find_numbered(target)
            if hits:
                a = hits[0]
                key = self.add(a.number, a.core, a.suffix, "alias").key
            else:
                key = self.resolve(target) or self.add("", target.lower(), "", "alias").key
            resolved[text] = key
        self.alias_keys = resolved
        self._compiled = None

    # ---- resolving ----
    def cores(self) -> dict[str, list[House]]:
        """Numbered houses by street name; rebuilt with the patterns whenever a house is added."""
        self._patterns()
        return self._by_core

    def best_for_core(self, core: str) -> House | None:
        cands = self.cores().get(core)
        if not cands:
            return None
        return max(cands, key=lambda h: (h.rental, h.refs))

    def resolve(self, text: str) -> str | None:
        """Single best house key mentioned in text, or None."""
        hits = self.scan(text)
        for h in hits:
            if h.house:
                return h.house
        return None

    def _patterns(self):
        if self._compiled is not None:
            return self._compiled
        by_core: dict[str, list[House]] = {}
        for h in self.houses.values():
            if h.number:
                by_core.setdefault(h.core, []).append(h)
        core_alt = "|".join(re.escape(c).replace(r"\ ", r"\s+")
                            for c in sorted(by_core, key=len, reverse=True)) or r"(?!x)x"
        dirs = "|".join(sorted(DIRECTIONS, key=len, reverse=True))
        known_numbered = re.compile(
            rf"\b(\d{{1,6}})([A-Za-z])?\s+(?:(?:{dirs})\.?\s+)?({core_alt})\b(?:\s+({SUFFIX_RE})\b\.?)?",
            re.IGNORECASE)
        bare = re.compile(rf"\b(?:(?:{dirs})\.?\s+)?({core_alt})\b(?:\s+({SUFFIX_RE})\b\.?)?",
                          re.IGNORECASE)
        named_cores = [h.core for h in self.houses.values() if not h.number]
        named_alt = "|".join(re.escape(c).replace(r"\ ", r"\s+")
                             for c in sorted(named_cores, key=len, reverse=True)) or r"(?!x)x"
        named = re.compile(rf"\b({named_alt})\s+(?:house|home)\b", re.IGNORECASE)
        alias_alt = "|".join(re.escape(a).replace(r"\ ", r"\s+")
                             for a in sorted(self.alias_keys, key=len, reverse=True)) or r"(?!x)x"
        alias = re.compile(rf"\b({alias_alt})\b", re.IGNORECASE)
        self._compiled = (known_numbered, bare, named, alias)
        self._by_core = by_core
        return self._compiled

    def scan(self, text: str) -> list[AddressHit]:
        """All address mentions, non-overlapping, earliest-longest first.
        Unknown numbered addresses come back with house=None."""
        known_numbered, bare, named, alias = self._patterns()
        hits: list[AddressHit] = []
        for m in alias.finditer(text):
            key = self.alias_keys.get(re.sub(r"\s+", " ", m.group(1).lower()))
            hits.append(AddressHit(m.start(), m.end(), "", "", m.group(1).lower(), "", "alias", key))
        for a in find_numbered(text):
            key = self.key_for(a.number, a.core)
            a.house = key if key in self.houses else None
            hits.append(a)
        for m in known_numbered.finditer(text):
            core = re.sub(r"\s+", " ", m.group(3).lower())
            key = self.key_for(m.group(1), core)
            sfx = SUFFIXES[m.group(4).lower()] if m.group(4) else ""
            hits.append(AddressHit(m.start(), m.end(), m.group(1), (m.group(2) or "").upper(), core,
                                   sfx, "numbered-known", key if key in self.houses else None))
        for m in named.finditer(text):
            core = re.sub(r"\s+", " ", m.group(1).lower())
            hits.append(AddressHit(m.start(), m.end(), "", "", core, "", "named",
                                   self.key_for("", core)))
        for m in bare.finditer(text):
            core = re.sub(r"\s+", " ", m.group(1).lower())
            sfx = SUFFIXES[m.group(2).lower()] if m.group(2) else ""
            house = self.best_for_core(core)
            ambiguous = core in AMBIGUOUS_STREETS or core[:1].isdigit() or len(core) < 4
            # "back at larch tonight": a rental house's street said bare is the
            # house, unless it's a compass word (North Dakota)
            house_word = (house is not None and house.rental and core not in DIRECTIONS
                          and core != "main" and len(core) >= 4)
            if ambiguous and not sfx and not house_word:
                continue
            hits.append(AddressHit(m.start(), m.end(), "", "", core, sfx, "bare",
                                   house.key if house else None))
        hits.extend(find_streets(text))  # after the known ones: longest-first keeps a known house
        # keep longest non-overlapping
        hits.sort(key=lambda h: (h.start, -(h.end - h.start)))
        out, end = [], -1
        for h in hits:
            if h.start >= end:
                out.append(h)
                end = h.end
        return out
