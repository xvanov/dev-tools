"""Sort the property conversations into datasets -- tenants, landlords,
contractors -- so none slip through.

Evidence, strongest first:
  1. config role_overrides: a person's roles, stated outright (a co-host who
     also rents a room is ["partner", "tenant"]);
  2. contact tags: a role word ("Roomies", "Tenant", "Interested", "Landlord",
     "Property manager", "Plumber", "Cleaner") and/or a house address;
  3. house group chats: named after a house, or holding two or more renters --
     everyone in one is a renter even if their contact says nothing;
  4. message content: rental talk for tenants/prospects, and what *they* write
     for the others ("your lease renewal" from a landlord, "estimate"/"invoice"
     from a contractor), which catches unknown numbers and untagged contacts.

Every candidate lands in review.csv with its dataset and reasons; the
`override` column (yes / no / a dataset name) survives re-runs and always wins.
"""
from __future__ import annotations

import csv
import math
import os
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .addresses import HouseRegistry
from .store import SHORT_CODE, Conversation, Store, fmt, norm_handle

DATASETS_DEFAULT = {
    "tenants": ["tenant", "prospect"],
    "landlords": ["landlord"],
    "contractors": ["contractor"],
}
ROLE_ALIASES = {"vendor": "contractor", "cohost": "partner", "co-host": "partner",
                "property manager": "landlord", "renter": "tenant", "cleaner": "contractor"}

# Order matters: the first role whose pattern matches the contact's tags wins.
ROLE_RULES: list[tuple[str, re.Pattern]] = [
    ("other", re.compile(r"^\s*car\b|\b(toyota|chevy|chevrolet|ford|honda|prius|pickup|s10)\b"
                         r"|\$\s?\d|^\s*house\s+\d+b\d+b|salesman|notary", re.I)),
    ("landlord", re.compile(r"landlor|property\s*(manag|owner|mgmt)|(?<!project )(?<!account )(?<!office )(?<!general )(?<!bank )(?<!branch )(?<!sales )(?<!assistant )"
                            r"(?<!store )\bmanager\b|concierge|home\s*owner|\bowner of\b|leasing (office|agent)"
                            r"|\bhoa\b|(?-i:\b[A-Z]\w+ Property\b)", re.I)),
    ("contractor", re.compile(
        r"plumb|hvac|handy\s*man|roofer|roofing|contractor|repair|techn?i?cian|tehcnician"
        r"|clean(er|ers|ing|s)\b|\bmaid\b|housekeep|dumpster|\bjunk\b|haul|laborer|worker"
        r"|electrician|\bmovers?\b|painter|painting|\bpest\b|extermin|termite|landscap|\blawn"
        r"|gardener|tree (service|removal|guy)|locksmith|inspector|appraiser|flooring|carpet"
        r"|drywall|\bmold\b|septic|gutter|\bpool (guy|service)|garage door|appliance|solar"
        r"|install|construction|builder|remodel|\btile\b|\bfence|concrete|paving|chimney"
        r"|\bduct|insulation|water heater|furnace|carpenter|welder|\bmason\b|stucco|siding"
        r"|\bac (repair|guy|service)|\ba/c\b", re.I)),
    ("neighbor", re.compile(r"neighbo", re.I)),
    ("prospect", re.compile(r"interested|potential|potnetial|spare\s*room|craigslist|looking for", re.I)),
    ("tenant", re.compile(r"roomie|room\s*mate|tenant|tenat|renter|\broom\b|bedroom|sublet|subleas"
                          r"|\b(?!a\b|the\b|build\b)[a-z]+\s+house\b", re.I)),
]


def _kw(rows):
    return [(w, name, re.compile(p, re.I)) for w, name, p in rows]


# (weight, pattern) -- each pattern scores once per conversation, plus a little
# for repetition, so one stray "rent" in a friend chat stays below the bar.
TENANT_KEYWORDS = _kw([
    (3, "rent", r"\brent\b(?!\s*a\s*car)|\brent's\b|\brent is\b"),
    (3, "lease", r"\blease\b|\bleasing\b"),
    (3, "sublease", r"sub-?leas|sublet"),
    (3, "deposit", r"\bdeposit\b"),
    (3, "move in/out", r"\bmov(e|ing)[- ]?(in|out)\b|\bmoved (in|out)\b"),
    (3, "tenant/landlord", r"\btenants?\b|\blandlord\b"),
    (3, "roommate", r"room\s?mates?|roomies?\b|housemates?"),
    (3, "room", r"\b(the|a|your|my|private|master|spare|available)\s+(bed)?room\b|room (is )?(still )?available"
                r"|room for rent|\bbedroom\b"),
    (3, "listing site", r"interested in (the|a|your|\d+) ?(room|house|home|apartment|place|property|\w+ (st|rd|dr|ave|way|ct))"
                        r"|(regarding|about) the (room|house|place)"
                        r"|room (you )?(posted|listed|advertised)|rooms? for rent|craigslist|marketplace"
                        r"|spare ?room|roomies\.com|roomster|padsplit|furnished finder|zillow|apartments\.com"
                        r"|hotpads|flexmls|schedule a showing|see the (room|house|place)"),
    (2, "utilities", r"utilit(y|ies)|electric(ity)? bill|water bill|gas bill|power bill|internet bill|trash pickup"),
    (2, "keys/access", r"\bkeys?\b|lockbox|lock box|door code|key ?code|garage (code|opener|remote)"),
    (2, "application", r"background check|credit check|rental application|\bapplication\b|\bproof of income\b"),
    (2, "house", r"\bthe house\b|\bhouse rules\b|\bhouse meeting\b|\bkitchen\b|\blaundry\b"),
    (2, "listing", r"furnished|\bviewing\b|\btour\b|come (see|look)|\bshowing\b|still available"),
    (2, "terms", r"prorat|month[- ]to[- ]month|\bper month\b|/\s?mo\b|a month\b|first month|last month"),
    (2, "payment", r"\bzelle\b|\bvenmo\b|cash ?app|\blate fee\b|\bevict"),
])
# Scored on the other side's messages only: a landlord writes "your lease",
# a tenant writes "my rent".
LANDLORD_KEYWORDS = _kw([
    (3, "your lease/rent", r"\byour (rent|lease|unit|deposit|application|move[- ]?(in|out)|renewal|ledger|balance)\b"),
    (3, "renewal", r"lease renewal|renew (your|the) lease|lease (expires|expiration|ends)"),
    (3, "management", r"property manag|management (company|office)|leasing (office|agent|team)"),
    (3, "portal", r"tenant portal|resident portal|rent ?cafe|appfolio|buildium|obligo|rentec|tenantcloud"
                  r"|cozy\.co|avail\.co|rent (is )?due|ledger"),
    (3, "maintenance", r"maintenance request|work order|we('ll| will) send (a|our|the) "
                       r"(plumber|technician|maintenance|someone)"),
    (2, "inspection", r"\binspection\b|walk[- ]?through|\bnotice to (vacate|enter)\b|\bentry notice\b"),
    (2, "owner terms", r"\bsecurity deposit\b|\bpet (fee|rent|deposit)\b|\bsubletting\b|\bsublet(ting)? is\b"),
])
CONTRACTOR_KEYWORDS = _kw([
    (3, "estimate/invoice", r"\bestimate\b|\bquote\b|\binvoice\b|\bbid\b|\breceipt\b"),
    (3, "trade", r"plumb|hvac|furnace|water heater|\bac unit\b|\ba/c\b|\bleak|\bclog|\bdrain|\bpipe"
                 r"|\bpest|termite|rodent|roach|electrical|breaker|outlet|wiring"),
    (3, "hauling", r"dumpster|haul|\bjunk\b|container"),
    (2, "work", r"\brepair|\binstall|\breplace(d|ment)?\b|\bfix(ed)?\b|\bservice (call|appointment)\b"
                r"|appointment (is )?(confirmed|scheduled)"),
    (2, "on the way", r"technician|\btech (is|will)\b|on (my|our|the) way|en route|arriv(e|ing) (between|in)"),
    (2, "trades", r"\broof|gutter|\bpaint|drywall|flooring|carpet|\btile|\bfence|landscap|\blawn|\bmow|\btree"
                  r"|deep clean|\bcleaning\b|\bmaid\b"),
    (2, "labor", r"\blabor\b|\bmaterials\b|\bparts\b|per hour|/\s?h(ou)?r\b|deposit for (the )?(job|work|materials)"),
])

# A contractor chat has to be about a property, not a car or a day job.
PROPERTY_CONTEXT = re.compile(
    r"\b(house|home|property|unit|tenant|rental|bathroom|kitchen|basement|crawl ?space|attic|garage|yard"
    r"|roof|gutter|water heater|hvac|furnace|plumb\w*|toilet|sink|shower|tub|fridge|refrigerator|washer"
    r"|dryer|dishwasher|appliance|bedroom|room|ceiling|floor|wall|window|door|lock|deck|fence|driveway"
    r"|lawn|tree|pest|termite|mold|leak|outlet|breaker|thermostat|duct|vent|carpet|paint)\b", re.I)
CAR_CONTEXT = re.compile(r"\b(car|truck|vehicle|tires?|engine|brakes?|transmission|oil change|smog|rv|motor"
                         r"|mileage|odometer|bumper|windshield|prius|toyota|honda)\b", re.I)

RENTERISH = {"tenant", "prospect"}
OVERRIDE_YES = {"yes", "y", "1", "true", "include"}
OVERRIDE_NO = {"no", "n", "0", "false", "exclude"}
DATASET_NAME = re.compile(r"^[a-z0-9_-]+$")

# Day-job talk reads like contractor work ("install", "estimate", "framing").
# A keyword-inferred chat dominated by it is vetoed; config day_job_terms adds yours.
DAY_JOB_DEFAULT = ["docker", "github", "gitlab", "bitbucket", "deploy", "deployment", "api", "software",
                   "firmware", "robot", "robots", "robotics", "pull request", "merge request", "jira", "ssh",
                   "python", "kubernetes", "standup", "stand-up", "repo", "codebase", "cad", "solidworks",
                   "plc", "truss", "trusses", "sprint planning", "onboarding", "interview"]


@dataclass
class Person:
    key: str
    handles: set[str]
    label: str
    role: str | None = None  # primary role
    extra_roles: set[str] = field(default_factory=set)
    houses: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    fixed: bool = False  # roles come from config role_overrides; inference leaves them alone

    @property
    def roles(self) -> list[str]:
        return ([self.role] if self.role else []) + sorted(self.extra_roles - {self.role})

    @property
    def role_label(self) -> str:
        return "+".join(self.roles) or "unknown"

    def has(self, *roles: str) -> bool:
        return any(r in self.roles for r in roles)


@dataclass
class Candidate:
    conv: Conversation
    role: str
    house: str | None
    score: int
    reasons: list[str]
    auto_include: bool
    dataset: str | None = None
    override: str = ""

    @property
    def included(self) -> bool:
        o = self.override.lower()
        if o in OVERRIDE_NO:
            return False
        if o:  # yes, or a dataset name that moves the conversation (validated in detect)
            return self.final_dataset is not None
        return self.auto_include and self.dataset is not None

    @property
    def final_dataset(self) -> str | None:
        o = self.override.lower()
        if o and o not in OVERRIDE_YES and o not in OVERRIDE_NO:
            return o
        return self.dataset


@dataclass
class Classification:
    houses: HouseRegistry
    people: dict[str, Person]
    candidates: list[Candidate]
    datasets: dict[str, list[str]] = field(default_factory=lambda: dict(DATASETS_DEFAULT))
    warnings: list[str] = field(default_factory=list)

    @property
    def included(self) -> list[Candidate]:
        return [c for c in self.candidates if c.included]

    def dataset(self, name: str) -> list[Candidate]:
        return [c for c in self.included if c.final_dataset == name]


def role_of(tag_text: str) -> str | None:
    for role, pat in ROLE_RULES:
        if pat.search(tag_text):
            return role
    return None


def canon_role(r: str) -> str:
    r = r.strip().lower()
    return ROLE_ALIASES.get(r, r)


def _score(texts, keywords) -> tuple[int, list[str], Counter]:
    hits: Counter = Counter()
    weights = {}
    for t in texts:
        for w, name, pat in keywords:
            if pat.search(t):
                hits[name] += 1
                weights[name] = w
    score = sum(weights[n] for n in hits) + int(math.log2(1 + sum(hits.values()) / 5))
    return score, [f"{n}x{c}" for n, c in hits.most_common()], hits


def score_messages(conv: Conversation, houses: HouseRegistry) -> tuple[int, list[str]]:
    texts = [m.text for m in conv.messages if m.text]
    score, reasons, _ = _score(texts, TENANT_KEYWORDS)
    house_mentions = sum(1 for t in texts
                         if any(h.house and houses.houses[h.house].rental for h in houses.scan(t)))
    if house_mentions:
        score += 4
        reasons.insert(0, f"rental-address x{house_mentions}")
    return score, reasons


def score_other_side(conv: Conversation, keywords) -> tuple[int, list[str]]:
    score, reasons, _ = _score([m.text for m in conv.messages if m.text and not m.from_me], keywords)
    return score, reasons


def property_context(conv: Conversation, houses: HouseRegistry) -> bool:
    texts = [m.text for m in conv.messages if m.text]
    prop = sum(1 for t in texts if PROPERTY_CONTEXT.search(t) or
               any(h.house and houses.houses[h.house].rental for h in houses.scan(t)))
    car = sum(1 for t in texts if CAR_CONTEXT.search(t))
    return prop >= 1 and car <= prop


def day_job(conv: Conversation, pattern: re.Pattern) -> bool:
    """Most of the talk is your day job rather than a property."""
    texts = [m.text for m in conv.messages if m.text]
    work = sum(1 for t in texts if pattern.search(t))
    prop = sum(1 for t in texts if PROPERTY_CONTEXT.search(t))
    return work >= 3 and work * 2 >= prop


def dataset_of(roles: list[str], datasets: dict[str, list[str]]) -> str | None:
    for name, wanted in datasets.items():
        if any(r in wanted for r in roles):
            return name
    return None


def _match_override(p: Person, key: str) -> bool:
    k = key.strip().lower()
    digits = re.sub(r"\D", "", k)
    if len(digits) >= 10 and norm_handle(k) in p.handles:  # a phone key: handles keep 10 digits
        return True
    return bool(re.search(rf"(?<!\w){re.escape(k)}(?!\w)", p.label.lower()))


def detect(store: Store, config: dict, review_path: str | None = None) -> Classification:
    datasets = {n: [canon_role(r) for r in rs] for n, rs in
                (config.get("datasets") or DATASETS_DEFAULT).items()}
    reserved = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}
    bad = [n for n in datasets if not DATASET_NAME.match(n) or n in reserved]
    if bad:  # dataset names become folder names
        raise ValueError(f"dataset names must be lowercase letters, digits, - or _: {bad}")
    day_job_re = re.compile(r"(?i)(?<!\w)(" + "|".join(
        re.escape(t) for t in DAY_JOB_DEFAULT + list(config.get("day_job_terms", []))) + r")(?!\w)")
    hi = int(config.get("keyword_include_score", 6))
    lo = int(config.get("keyword_review_score", 4))
    houses = HouseRegistry(config.get("house_aliases"))

    # ---- learn houses from contact tags and group names ----
    for c in store.contacts.values():
        houses.learn(c.tag_text, f"contact:{c.id}")
    for conv in store.conversations:
        for n in conv.names:
            houses.learn(n, f"group:{conv.id}")
    for c in store.contacts.values():
        houses.learn_named(c.tag_text, f"contact:{c.id}")
    houses.finalize_aliases()

    # ---- people ----
    people: dict[str, Person] = {}
    for conv in store.conversations:
        for h in conv.members:
            key = store.person_key(h)
            p = people.get(key)
            if p is None:
                p = people[key] = Person(key, set(), store.label(h))
                c = store.contact(h)
                if c:
                    p.role = role_of(c.tag_text)
                    if p.role:
                        p.reasons.append(f"tag:{p.role}")
                    p.houses = list(dict.fromkeys(hh.house for hh in houses.scan(c.tag_text) if hh.house))
            p.handles.add(h)

    # Stated roles win over everything inferred. "partners" is shorthand for ["partner"].
    overrides = {k: [canon_role(r) for r in (v if isinstance(v, list) else [v])]
                 for k, v in (config.get("role_overrides") or {}).items()}
    for name in config.get("partners", []):
        overrides.setdefault(name, ["partner"])
    # Contacts that are never property business (colleagues at your day job...).
    excluded = [e.lower() for e in config.get("exclude_contacts", [])]
    for p in people.values():
        if any(re.search(rf"(?<!\w){re.escape(e)}(?!\w)", p.label.lower()) for e in excluded):
            p.role, p.fixed = "other", True
            p.reasons.append("config: exclude_contacts")

    # "Dana" must not also catch "Dana HVAC": an exact name wins, a partial
    # match only counts when it is the only one, otherwise warn.
    warnings = []
    own_keys = {k.strip().lower() for k in overrides}  # people with their own entry need no warning
    for key, roles in overrides.items():
        hits = [p for p in people.values() if _match_override(p, key)]
        exact = [p for p in hits if p.label.strip().lower() == key.strip().lower()]
        chosen = exact or (hits if len(hits) == 1 else [])
        if not chosen:
            warnings.append(f"role_overrides '{key}' matches " +
                            (f"{len(hits)} people ({'; '.join(sorted(p.label for p in hits))}): "
                             "use the full contact name or a phone number" if hits else "nobody"))
        else:
            others = sorted(p.label for p in hits if p not in chosen and p.label.strip().lower() not in own_keys)
            if others:
                warnings.append(f"role_overrides '{key}' applied to '{chosen[0].label}' only, not {'; '.join(others)}")
        for p in chosen:
            p.role, p.extra_roles, p.fixed = roles[0], set(roles[1:]), True
            p.reasons.append(f"config: {'+'.join(roles)}")

    # ---- overrides from a previous review: read first, so a 1:1 forced into a
    # dataset gives its person a role before the group chats are classified ----
    prior = read_overrides(review_path, datasets, warnings)
    conv_by_id = {c.id: c for c in store.conversations}
    for cid, o in prior.items():
        conv = conv_by_id.get(cid)
        if conv is None or conv.is_group or o in OVERRIDE_NO:
            continue
        p = people[store.person_key(next(iter(conv.members)))]
        ds = o if o in datasets else (dataset_of(p.roles, datasets) or next(iter(datasets)))
        want = datasets[ds][0]
        if not p.has(*datasets[ds]):
            if p.role in (None, "neighbor", "other"):
                p.role = want
            else:
                p.extra_roles.add(want)
            p.reasons.append("override")

    for p in people.values():
        for k in p.houses:
            houses.houses[k].sources.add(f"person:{p.key}")
            if p.has("tenant", "prospect", "landlord"):
                houses.houses[k].rental = True
    for conv in store.conversations:
        for n in conv.names:
            k = houses.resolve(n)
            if k and conv.is_group:
                houses.houses[k].rental = True

    # A bare address on a contact of a rental house means a renter.
    for p in people.values():
        if p.role is None and any(houses.houses[k].rental for k in p.houses):
            p.role = "tenant"
            p.reasons.append("address of a rental house")

    # ---- group chats ----
    scores: dict[str, tuple] = {}

    def group_scores(conv):
        if conv.id not in scores:
            scores[conv.id] = (score_messages(conv, houses), score_other_side(conv, LANDLORD_KEYWORDS),
                               score_other_side(conv, CONTRACTOR_KEYWORDS), property_context(conv, houses))
        return scores[conv.id]

    def classify_groups():
        found: list[Candidate] = []
        tenant_groups: list[tuple[Conversation, str | None]] = []
        for conv in store.conversations:
            if not conv.is_group:
                continue
            # a "no" on the group in review.csv keeps its members from becoming tenants through it
            if prior.get(conv.id) in OVERRIDE_NO:
                continue
            name_house = next((houses.resolve(n) for n in reversed(conv.names) if houses.resolve(n)), None)
            members = [people[store.person_key(h)] for h in conv.members]
            renters = [p for p in members if p.has(*RENTERISH)]
            landlords = [p for p in members if p.has("landlord")]
            contractors = [p for p in members if p.has("contractor")]
            votes = Counter(k for p in renters + landlords for k in p.houses)
            house = name_house or (votes.most_common(1)[0][0] if votes else None)
            reasons = []
            if name_house:
                reasons.append(f"named after {houses.houses[name_house].label}")
            for label, ps in (("renters", renters), ("landlords", landlords), ("contractors", contractors)):
                if ps:
                    reasons.append(f"{len(ps)}/{len(members)} members are {label}")
            (score, kw), (ls, lkw), (cs, ckw), prop = group_scores(conv)
            named_rental = bool(name_house and houses.houses[name_house].rental)
            known = [p for p in members if p.role]
            if known and all(p.role in ("neighbor", "other") for p in known) and not renters:
                continue  # neighbors' or friends' chats: never a dataset

            # Tenants first: a plumber added to a house group doesn't make it a
            # contractor chat. Prospects often arrive as unknown numbers in a
            # group with you and a partner, so strong rental talk alone is enough.
            # A tradesman in a big club chat doesn't make it a contractor chat either.
            if (named_rental and not (landlords and not renters)) or len(renters) >= 2 \
                    or (len(renters) == 1 and not landlords and not contractors
                        and (score >= lo or all(p.has("partner") for p in members if p not in renters))):
                role, ds, auto, why = "house-group", "tenants", True, kw[:6]
            elif landlords:
                role, ds, auto, why = "landlord-group", "landlords", True, lkw[:6] or kw[:6]
            elif contractors and prop and (len(members) <= 4 or cs >= lo):
                role, ds, auto, why = "contractor-group", "contractors", True, ckw[:6]
            elif day_job(conv, day_job_re):
                continue  # keyword evidence only, and it's mostly your day job
            elif score >= hi and score >= ls and score >= cs:
                role, ds, auto, why = "house-group", "tenants", True, kw[:6]
            elif ls >= hi and ls >= cs:
                role, ds, auto, why = "landlord-group", "landlords", True, lkw[:6]
            elif cs >= hi and prop:
                role, ds, auto, why = "contractor-group", "contractors", True, ckw[:6]
            elif max(score, ls, cs) >= lo or renters or contractors:
                best = max((score, "tenants", kw), (ls, "landlords", lkw), (cs, "contractors", ckw),
                           key=lambda t: t[0])
                role, ds, auto, why = "group?", best[1], False, best[2][:6]
            else:
                continue
            if prior.get(conv.id) in datasets:  # a dataset override on a group decides it here too
                ds, auto = prior[conv.id], True
            ds = ds if ds in datasets else None
            found.append(Candidate(conv, role, house, max(score, ls, cs), reasons + why, auto, ds))
            if auto and ds == "tenants":
                tenant_groups.append((conv, house))
        return found, tenant_groups

    def assign_house_group_roles(tenant_groups, find_partners):
        # Someone untagged in house groups for several different houses runs
        # them with you (a business line, a co-host) rather than renting.
        # Tenants get moved between houses too, so the bar is high and anyone
        # with a tag, an address or a stated role is exempt.
        if find_partners:
            min_houses = int(config.get("partner_min_houses", 4))
            spread: dict[str, set] = defaultdict(set)
            for conv, house in tenant_groups:
                for h in conv.members:
                    if house:
                        spread[store.person_key(h)].add(house)
            for key, hs in spread.items():
                p = people[key]
                tagged = p.fixed or p.houses or any(r.startswith("tag:") for r in p.reasons)
                if len(hs) >= min_houses and not tagged and p.role is None:
                    p.role = "partner"
                    p.reasons.append(f"in house groups of {len(hs)} houses")
        # Everyone else in a house group chat lived there or wanted to.
        for conv, house in tenant_groups:
            for h in conv.members:
                p = people[store.person_key(h)]
                if p.role is None:
                    p.role = "tenant"
                    p.reasons.append(f"member of house group {conv.id}")
                if house and house not in p.houses and p.has(*RENTERISH):
                    p.houses.append(house)

    # Repeat until stable: house-group members only become tenants after a
    # pass, and that changes how their other groups classify.
    candidates, tenant_groups = classify_groups()
    assign_house_group_roles(tenant_groups, find_partners=True)
    for _ in range(6):
        before = {k: p.role for k, p in people.items()}
        candidates, tenant_groups = classify_groups()
        assign_house_group_roles(tenant_groups, find_partners=False)
        if before == {k: p.role for k, p in people.items()}:
            break
    else:
        warnings.append("group classification did not settle after 6 passes; results may be order-dependent")

    # ---- one-to-one ----
    for conv in store.conversations:
        if conv.is_group:
            continue
        handle = next(iter(conv.members), "")
        if SHORT_CODE.fullmatch(handle):
            continue
        p = people[store.person_key(handle)]
        house = p.houses[0] if p.houses else None
        ds = dataset_of(p.roles, datasets)
        if ds:
            candidates.append(Candidate(conv, p.role_label, house, 0, list(p.reasons), True, ds))
            continue
        score, kw = score_messages(conv, houses)
        if p.role is not None:  # partner / neighbor / other: listed, in no dataset
            candidates.append(Candidate(conv, p.role_label, house, score, p.reasons + kw[:6], False, None))
            continue
        if day_job(conv, day_job_re):
            continue  # keyword evidence only, and it's mostly your day job
        ls, lkw = score_other_side(conv, LANDLORD_KEYWORDS)
        cs, ckw = score_other_side(conv, CONTRACTOR_KEYWORDS)
        # Landlord chats are full of lease/rent words too, so "your lease" from
        # their side only has to be half as loud as the rental talk to win.
        if ls >= hi and ls * 2 >= score and ls >= cs:
            role, s, why = "landlord", ls, lkw
        elif cs >= hi and cs * 10 >= score * 7 and property_context(conv, houses):
            role, s, why = "contractor", cs, ckw
        elif score >= lo:
            role, s, why = ("prospect" if store.contact(handle) is None else "tenant"), score, kw
        elif ls >= lo or (cs >= lo and property_context(conv, houses)):
            role, s, why = ("landlord", ls, lkw) if ls >= cs else ("contractor", cs, ckw)
            s = min(s, hi - 1)  # without property context or a clear lead: review, don't include
        else:
            continue
        # a landlord or contractor you never answered is a marketing blast
        if role in ("landlord", "contractor") and not any(m.from_me for m in conv.messages):
            s = min(s, hi - 1)
        auto = s >= hi
        ds = dataset_of([role], datasets)
        candidates.append(Candidate(conv, role + ("" if auto else "?"), house, s, why[:8], auto, ds))
        if auto:
            p.role = role
            p.reasons.append(f"message keywords (score {s})")

    # ---- attach the review overrides ----
    by_id = {c.conv.id: c for c in candidates}
    # An override on a conversation that isn't a candidate (any more) still
    # counts: it is added back so it can be forced in, and it stays in review.csv.
    for cid in prior:
        if cid not in by_id and cid in conv_by_id:
            c = Candidate(conv_by_id[cid], "override", None, 0, ["not detected; kept by override"], False, None)
            candidates.append(c)
            by_id[cid] = c
    for c in candidates:
        c.override = prior.get(c.conv.id, "")
        if c.override in OVERRIDE_YES and c.dataset is None:
            roles = [] if c.conv.is_group else people[store.person_key(next(iter(c.conv.members)))].roles
            c.dataset = dataset_of(roles, datasets) or next(iter(datasets))

    order = {"tenants": 0, "landlords": 1, "contractors": 2}
    candidates.sort(key=lambda c: (not c.included, order.get(c.final_dataset or "", 3), -c.score))
    return Classification(houses, people, candidates, datasets, warnings)


def read_overrides(review_path: str | None, datasets: dict, warnings: list) -> dict[str, str]:
    """conv_id -> override from review.csv; unknown values are warned about and ignored."""
    prior: dict[str, str] = {}
    if not review_path or not os.path.exists(review_path):
        return prior
    with open(review_path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            o = (row.get("override") or "").strip().lower()
            if not o:
                continue
            if o not in OVERRIDE_YES and o not in OVERRIDE_NO and o not in datasets:
                warnings.append(f"review.csv: ignoring override '{o}' on {row['conv_id']} "
                                f"(use yes, no, or one of {', '.join(datasets)})")
                continue
            prior[row["conv_id"]] = o
    return prior


def write_review(cls: Classification, store: Store, path: str) -> None:
    """Real names: this file is private. Edit `override`: yes / no / tenants / landlords / contractors."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["conv_id", "override", "included", "dataset", "auto", "kind", "role", "conversation",
                    "members", "house", "score", "reasons", "messages", "first", "last"])
        for c in cls.candidates:
            conv = c.conv
            members = sorted(f"{store.label(h)} [{cls.people[store.person_key(h)].role_label}]"
                             for h in conv.members)
            title = conv.name or (store.label(next(iter(conv.members))) if not conv.is_group
                                  else ", ".join(m.split(" [")[0] for m in members[:4]))
            w.writerow([conv.id, c.override, "yes" if c.included else "no", c.final_dataset or "",
                        "yes" if c.auto_include else "no", "group" if conv.is_group else "1:1", c.role, title,
                        "; ".join(members), cls.houses.houses[c.house].label if c.house else "", c.score,
                        "; ".join(c.reasons), len(conv.messages), fmt(conv.first), fmt(conv.last)])


def summary(cls: Classification) -> dict:
    inc = cls.included
    return {
        "candidates": len(cls.candidates),
        "included": len(inc),
        "by_dataset": {name: {"1:1": sum(1 for c in cls.dataset(name) if not c.conv.is_group),
                              "group": sum(1 for c in cls.dataset(name) if c.conv.is_group)}
                       for name in cls.datasets},
        "review_band": sum(1 for c in cls.candidates if not c.included and c.role.endswith("?")),
        "rental_houses": sum(1 for h in cls.houses.houses.values() if h.rental),
        "partners": sorted(p.label for p in cls.people.values() if p.has("partner")),
    }
