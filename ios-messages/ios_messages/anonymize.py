"""Pseudonymize the property conversations.

One real person -> one fake name, phone, email and (through their house) one
fake address, the same in every 1:1, group chat and dataset, so people can be
followed across conversations without being identifiable. The mapping lives in
private/mapping.json and is reused on every run, so pseudonyms are stable.

Scrubbing runs in stages over each message body. Each replacement is wrapped in
private-use marker characters so later stages never rewrite an inserted fake
(a fake street can't then be mistaken for a real name). Markers are stripped at
the end.
"""
from __future__ import annotations

import csv
import json
import os
import random
import re
import secrets
import shutil
import unicodedata
from difflib import get_close_matches
from collections import Counter, defaultdict
from urllib.parse import urlparse

from . import fakes
from .addresses import DIRECTIONS, SUFFIXES, find_numbered, find_streets
from .classify import Classification
from .export_text import render_lines, safe_filename, unique_path
from .store import APPLE_EPOCH, SHORT_CODE, Store, fmt, norm_handle, renderable

OPEN, CLOSE = "", ""
PROTECTED = re.compile(f"{OPEN}.*?{CLOSE}", re.S)

CYRILLIC = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
                    "a b v g d e e zh z i y k l m n o p r s t u f h ts ch sh sht a y _ e yu ya".split()))


def P(s: str) -> str:
    return f"{OPEN}{s}{CLOSE}"


def fold(s: str) -> str:
    """Case-, accent- and script-insensitive key: Chloé/CHLOE/chloe meet, and so do
    Весна/Vesna, so a name typed in Cyrillic matches its Latin contact."""
    s = "".join(ch for ch in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(ch))
    return "".join(CYRILLIC.get(ch, ch) for ch in s).replace("_", "")


def unmark(s: str) -> str:
    return s.replace(OPEN, "").replace(CLOSE, "")


def sub_free(pattern: re.Pattern, repl, text: str) -> str:
    """re.sub that leaves already-replaced (protected) spans alone."""
    out, pos = [], 0
    for m in PROTECTED.finditer(text):
        out.append(pattern.sub(repl, text[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(pattern.sub(repl, text[pos:]))
    return "".join(out)


def redact_regex(terms) -> re.Pattern:
    """redact_terms match in any case ("AcmeCo", "nevada"), except a term written
    "=Wake", which matches only as written, so "wake up" stays. Terms of 1-3
    letters match as written unless written "~SF" (then "sf" and "Sf" go too)."""
    terms = [t.strip() for t in terms if t.strip()]
    exact = [t[1:] for t in terms if t.startswith("=")]
    loose = [t[1:] for t in terms if t.startswith("~")]
    plain = [t for t in terms if t[0] not in "=~"]
    return phrase_regex(plain + exact + loose, exact=exact, any_case=loose)


def phrase_regex(phrases, min_len: int = 4, exact=(), any_case=()) -> re.Pattern:
    """Whole-phrase matcher. Short phrases ("NC") and those in `exact` match
    case-sensitively so they don't fire on ordinary lowercase text; `any_case`
    phrases match in any case whatever their length. "_" counts as a boundary
    ("ave_NYC")."""
    exact = {e.strip() for e in exact}
    any_case = {e.strip() for e in any_case}
    long_ = sorted({p.strip() for p in phrases if (len(p.strip()) >= min_len or p.strip() in any_case)
                    and p.strip() not in exact}, key=len, reverse=True)
    short = sorted({p.strip() for p in phrases if 0 < len(p.strip()) < min_len and p.strip() not in any_case}
                   | exact, key=len, reverse=True)
    parts = []
    if long_:
        parts.append("(?i:" + "|".join(re.escape(p).replace(r"\ ", r"\s+") for p in long_) + ")")
    if short:
        parts.append("|".join(re.escape(p) for p in short))
    return re.compile(r"(?<![^\W_])(?:" + ("|".join(parts) or r"(?!x)x") + r")(?![^\W_])")


# ---------------------------------------------------------------- name tokens

ROLE_VOCAB = set("""
roomies roomie roommate tenant tenat renter renters room rooms bedroom master spare spareroom interested in
potential potnetial landlord landlor property manager concierge neighbor neighbour uphill downhill
plumber hvac handyman roofer roofing contractor repair repairs technicians technician tehcnicians
cleans cleaner house home old new phone number other correct deprecated dperecated delete deleted
eliminado lady guy black white chinese american support wed am pm craigslist office of short term
rentals rental homes worker looking for more than per hour friend car truck toyota chevy pickup ford
prius salesman notary the and a an to at from my sim gps puk ra mr mrs ms dr jr sr apt unit
""".split())

NAME_TOKEN = re.compile(r"[^\W\d_][^\W\d_'’.-]*(?:['’-][^\W\d_]+)*")


def name_tokens(text: str, house_cores: set[str], cities: set[str]) -> list[str]:
    """Given-name-ish words of a contact name: drop addresses, roles, digits, places."""
    for a in find_numbered(text):
        text = text[:a.start] + " " * (a.end - a.start) + text[a.end:]
    toks = []
    for t in NAME_TOKEN.findall(text):
        low = t.lower()
        if (len(low) < 2 or low in ROLE_VOCAB or low in SUFFIXES or low in DIRECTIONS
                or low in house_cores or low in cities):
            continue
        toks.append(t)
    return toks


def token_parts(tok: str) -> list[str]:
    """'Zelda-Quin' and "D'Andre" are matched word by word in text."""
    return [p for p in re.split(r"['’-]", tok) if len(p) >= 2]


# ---------------------------------------------------------------- mapping

class Mapping:
    """Real -> fake, persisted. Keys are real identifiers: keep the file private."""

    def __init__(self, path: str, blocked: set[str], owner: tuple = ()):
        self.path = path
        self.data = {"persons": {}, "houses": {}, "streets": {}, "addresses": {}, "phones": {},
                     "emails": {}, "cities": {}, "tokens": {}, "zips": {}, "convs": {}, "seed": None}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.data.update(json.load(f))
        if not self.data["seed"]:
            self.data["seed"] = secrets.token_hex(8)
        self.rng = random.Random(self.data["seed"] + str(sum(len(v) for v in self.data.values()
                                                              if isinstance(v, dict))))
        self.blocked = {b.lower() for b in blocked}
        # nor may a fake contain a real name: "Juniperton" would echo a real Juniper St
        long_blocked = [b for b in self.blocked if len(b) >= 5]

        owner = sorted({fold(o) for o in owner})

        def ok(n: str) -> bool:
            low = n.lower()
            # nor may a fake look like you: no name a typo or two from yours
            return low not in self.blocked and not any(b in low for b in long_blocked) \
                and not owner_variant(fold(n), owner, True)

        # one generated stream cut into three, so first names, surnames and
        # stand-ins never share a value, and no street is also a person's name
        gen = fakes.generated_names(11000, "pools")
        self.first_pool = [n for n in fakes.FIRST + gen[:4000] if ok(n)]
        self.last_pool = [n for n in fakes.LAST + gen[4000:7000] if ok(n) and n not in fakes.FIRST]
        self.token_pool = [n for n in gen[7000:] if ok(n)]
        people_names = {n.lower() for n in self.first_pool + self.last_pool}
        self.street_pool = [n for n in fakes.STREETS if ok(n) and n.lower() not in people_names]
        self.city_pool = [n for n in fakes.CITIES if ok(n)]
        self._used_full = {f"{p['first']} {p['last']}" for p in self.data["persons"].values()}
        self._used_streets = {h["street"] for h in self.data["houses"].values()} | \
                             {s["street"] for s in self.data["streets"].values()}
        self._used_phones = set(self.data["phones"].values()) | \
                            {p["phone"] for p in self.data["persons"].values()}
        # a fake chosen before a contact existed may now equal a real name: redo it
        for key, p in list(self.data["persons"].items()):
            if key != "owner" and (not ok(p["first"]) or not ok(p["last"])):
                del self.data["persons"][key]
                self.person(key)["id"] = p["id"]
        for k, v in list(self.data["tokens"].items()):
            if not ok(v):
                del self.data["tokens"][k]
        # a real street or city found since may now equal a fake one: redraw those
        for k, h in list(self.data["houses"].items()):
            if h["street"].lower() in self.blocked or h["city"].lower() in self.blocked:
                del self.data["houses"][k]
                self.house(k)["id"] = h["id"]
        for k, st in list(self.data["streets"].items()):
            if st["street"].lower() in self.blocked:
                del self.data["streets"][k]
        for k, c in list(self.data["cities"].items()):
            if c.lower() in self.blocked:
                del self.data["cities"][k]

    def set_owner(self, first: str, last: str) -> None:
        """Your own pseudonym, if config names one."""
        o = self.person("owner")
        o.update(first=first, last=last, email=f"{first.lower()}.{last.lower()}@example.com")

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=1, ensure_ascii=False)
        os.replace(tmp, self.path)

    def _fake_phone(self) -> str:
        while True:
            p = f"({self.rng.randint(201, 989)}) 555-01{self.rng.randint(0, 99):02d}"
            if p not in self._used_phones:
                self._used_phones.add(p)
                return p

    def _pick(self, pool: list[str], used: set[str]) -> str:
        free = [x for x in pool if x not in used]
        return self.rng.choice(free or pool)

    def person(self, key: str) -> dict:
        p = self.data["persons"].get(key)
        if p is None:
            used_first = {q["first"] for q in self.data["persons"].values()} | set(self.data["tokens"].values())
            # spread first names: reuse only once the pool runs out
            for _ in range(10000):
                first = self._pick(self.first_pool, used_first)
                last = self.rng.choice(self.last_pool)
                if f"{first} {last}" not in self._used_full:
                    break
            self._used_full.add(f"{first} {last}")
            p = self.data["persons"][key] = {
                "id": f"P{len(self.data['persons']) + 1:04d}", "first": first, "last": last,
                "phone": self._fake_phone(),
                "email": f"{first.lower()}.{last.lower()}@example.com"}
        return p

    def _street(self) -> str:
        s = self._pick(self.street_pool, self._used_streets)
        self._used_streets.add(s)
        return s

    def city(self, real: str) -> str:
        k = real.lower()
        if k not in self.data["cities"]:
            self.data["cities"][k] = self._pick(self.city_pool, set(self.data["cities"].values()))
        return self.data["cities"][k]

    def house(self, key: str, real_city: str | None = None) -> dict:
        h = self.data["houses"].get(key)
        if h is None:
            h = self.data["houses"][key] = {
                "id": f"H{len(self.data['houses']) + 1:02d}", "number": str(self.rng.randint(100, 9899)),
                "street": self._street(), "suffix": self.rng.choice(fakes.SUFFIXES),
                # the same fake city the text uses for that real city
                "city": self.city(real_city) if real_city else self._pick(self.city_pool, set())}
        return h

    def street(self, core: str) -> dict:
        s = self.data["streets"].get(core)
        if s is None:
            s = self.data["streets"][core] = {"street": self._street(),
                                              "suffix": self.rng.choice(fakes.SUFFIXES)}
        return s

    def generic_number(self, real: str) -> str:
        k = "n:" + real
        if k not in self.data["addresses"]:
            self.data["addresses"][k] = str(self.rng.randint(100, 9899))
        return self.data["addresses"][k]

    def phone(self, norm: str) -> str:
        if norm not in self.data["phones"]:
            self.data["phones"][norm] = self._fake_phone()
        return self.data["phones"][norm]

    def short_phone(self, real: str) -> str:
        k = "7:" + real
        if k not in self.data["phones"]:
            self.data["phones"][k] = f"555-01{self.rng.randint(0, 99):02d}"
        return self.data["phones"][k]

    def email(self, real: str) -> str:
        k = real.lower()
        if k not in self.data["emails"]:
            self.data["emails"][k] = f"user{len(self.data['emails']) + 1:04d}@example.com"
        return self.data["emails"][k]

    def token(self, real: str, last: bool = False) -> str:
        """Fake for a name mentioned in text that maps to no single person. Drawn
        away from the names people already carry, so it can't be mistaken for one."""
        k = ("L:" if last else "F:") + real
        if k not in self.data["tokens"]:
            taken = {p["first"] for p in self.data["persons"].values()} | \
                    {p["last"] for p in self.data["persons"].values()} | set(self.data["tokens"].values())
            self.data["tokens"][k] = self._pick(self.token_pool, taken)
        return self.data["tokens"][k]

    def zip(self, real: str) -> str:
        if real not in self.data["zips"]:
            # 00100-00499: no US ZIP starts that low, so a fake can never be a real place
            self.data["zips"][real] = f"00{self.rng.randint(100, 499)}"
        return self.data["zips"][real]

    def conv(self, real_id: str) -> str:
        if real_id not in self.data["convs"]:
            self.data["convs"][real_id] = f"C{len(self.data['convs']) + 1:04d}"
        return self.data["convs"][real_id]


# ---------------------------------------------------------------- scrubbing

EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
URL = re.compile(r"\b(?:https?://|www\.)[^\s<>\"']+", re.I)
# "indow.com/jane-doe", "bit.ly/x": links typed without a scheme
BARE_URL = re.compile(
    r"(?<![@\w.-])(?:[a-z0-9-]+\.)+(?:com|org|net|gov|edu|io|co|us|ly|me|app|homes|info|biz|ai|link|site"
    r"|online|realty|house|properties|page|gl|be|uk|ca|de|fr|es|it|nl|au|in|mx|br|bg|ru|eu|tv|cc|ch|se|no"
    r"|dk|pl|ie|nz|jp|cn|kr)(?:/[^\s<>\"']*)?(?![\w.-]*\w)", re.I)
# Links keep their site only for big platforms; anything else could name a
# business, a city or a person.
LINK_ALLOW = set("""
zillow.com craigslist.org google.com goo.gl facebook.com fb.com fb.me instagram.com apple.com apple.co
icloud.com amazon.com a.co youtube.com youtu.be venmo.com paypal.com paypal.me cash.app zellepay.com
airbnb.com vrbo.com spareroom.com roomies.com roomster.com apartments.com hotpads.com trulia.com
redfin.com realtor.com padsplit.com furnishedfinder.com docusign.net docusign.com dropbox.com
microsoft.com office.com outlook.com live.com yahoo.com gmail.com linkedin.com twitter.com x.com
tiktok.com whatsapp.com wa.me t.me uber.com lyft.com doordash.com homedepot.com lowes.com ikea.com
costco.com walmart.com target.com usps.com ups.com fedex.com bit.ly tinyurl.com zoom.us
""".split())
PHONE = re.compile(r"(?<![\w$.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4,5}(?!\w)")
PHONE_INTL = re.compile(r"(?<![\w$.])\+(?!1[\s.-]?\(?\d{3})\d{1,3}(?:[\s.-]?\(?\d{1,5}\)?){2,5}(?!\w)")
PHONE7 = re.compile(r"(?<![\w$.\-/:])\d{3}[-.]\d{4}(?![\w\-/])")
SSN = re.compile(r"\b\d{3}[- ]\d{2}[- ]\d{4}\b")
CARD = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")
# "Account number\n 2370...": the number may sit on the next line
ACCOUNT = re.compile(r"(?i)\b(routing|account|acct|iban|swift|aba)\b([^\d]{0,30}?)(\d[\d -]{3,}\d)")
ROUTING = re.compile(r"(?<![\d.,$])\d{9}(?![\d.,]?\d)")
LONG_DIGITS = re.compile(r"(?<![\d.,$/:])\d{8,}(?![\d,.]?\d)")
_SECRET_KEY = (r"(?i)\b(code|pin|passcode|password|passwd|pass|pw|combo|combination|lockbox|lock box|lock"
               r"|gate|garage|wi-?fi|network|ssid|keypad|key pad)\b")
WEAK_SECRET_KEYS = {"pass", "gate", "garage", "network", "combo", "combination"}
# "gate is 10 feet", "pass 100 exams": a quantity, not a code
UNIT_AFTER = re.compile(r"(?i)\s?(ft|feet|foot|inch(es)?|lbs?|pounds?|miles?|mi|exams?|people|dollars|bucks"
                        r"|times|years?|yrs?|weeks?|months?|sq|square|percent|units?|rooms?|beds?|baths?|cars?"
                        r"|spots?|k)\b")
# "gate code is 4421", "PIN: 818 590 649#": the lazy gap stretches until a value
# with a digit turns up, so an earlier keyword can't swallow the later one
CODE = re.compile(_SECRET_KEY + r"([^\n:=#]{0,20}?)(\s*[:#=]\s*|\s+is\s+|\s+to\s+|\s+)"
                  r"(\d[\d \-‬]*\d(?![A-Za-z\d])|(?=\S*\d)\S{3,60})")  # the whole token: "Xk2,~qa9" is one password
# "password: sunshine": a word value only right after an explicit separator
CODE_WORD = re.compile(_SECRET_KEY + r"(\s*)(\s*[:=]\s*(?:\n\s*)?|\s+is\s+)(\S{4,60})")
# "Wi-Fi name: qeRTWv", "WiFi Name:\nZOPLAXE": a network name can be geolocated
WIFI = re.compile(r"(?i)\b(wi-?fi|wireless|network|ssid)(\s*(?:name|network|ssid|id|password|pass|pw)?)"
                  r"(\s*(?:[:=]|-\s|\bis\b)\s*(?:\n\s*)?)(\S{3,60})")
# a bare number in a message about a door, gate or code is the code
CODE_CONTEXT = re.compile(r"(?i)\b(codes?|door|gate|lockbox|lock box|locks?|keypad|key pad|pin|garage|c[oó]digo"
                          r"|clave|combo|wi-?fi|password|passcode|contraseña)\b")
# a message that is nothing but a code or a password: "4471#", "Xk2!fQ"
SOLO_SECRET = re.compile(r"^\s*#?(?:\d{3,8}|(?=\S*\d)\S{4,40}|\S{6,40})#?\s*$")
BARE_CODE = re.compile(r"(?<![\d$.,:/#\-])\d{4,8}(?!\d|[,.:/\-]\d)")
# "venmo: some.handle", "IG ilvanek_art": the token after a payment/social app
APP_HANDLE = re.compile(r"(?i)\b(venmo|cash ?app|paypal|zelle|ig|insta(?:gram)?|handle|username|user name"
                        r"|snap(?:chat)?|tiktok|twitter|telegram)\b(\s*(?:is|:|-|=)?\s*(?:\n\s*)?)"
                        r"(@?[A-Za-z0-9_][A-Za-z0-9_.\-]{2,29})")
WORD_SECRET_KEYS = {"password", "passwd", "passcode", "pw", "ssid", "wifi", "wi-fi", "network"}
NOT_A_SECRET = set("""down working slow fast out not the still back fine good broken off on up
there here same new old changed reset again now open closed locked unlocked and or for in at
please will should would is are was has have""".split())
TIME_AFTER = re.compile(r"(?i)\s?(am|pm|a\.m|p\.m|o'?clock|min|mins|minutes|hours?|hrs?|days?|%|th\b|st\b|nd\b|rd\b|:)")
TIME_BEFORE = re.compile(r"(?i)\b(at|by|until|till|before|after|around|from|to)\s*$")
DOB = re.compile(r"(?i)\b(dob|d\.o\.b|date of birth|born on|born|birthday)\b([^\n\d]{0,15})"
                 r"(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}"
                 r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4})")
LICENSE = re.compile(r"(?i)\b(license plate|plate number|plate|tag number|driver'?s? licen[cs]e|dl|license (?:no|number|#)"
                     r"|license)\b"
                     r"([^\n\w]{0,4}(?:\w+\s){0,2}?[^\n\w]{0,3})\b([A-Z0-9]{1,4}[ -]?[A-Z0-9]{2,6})\b")
# mixed case + digit, no spaces: "Acme2024!" sent on its own is a password
SECRET_TOKEN = re.compile(r"(?<![\w@/.])(?=\S*[A-Z])(?=\S*[a-z])(?=\S*\d)[A-Za-z0-9!@#$%^&*_+=.?-]{6,40}(?![\w/])")
# "His name is Will", "ask Grace": a word-name right after these is a name
# a sign-off line before a name makes it a signature
SIGN_OFF = re.compile(r"(?i)(regards|thanks|thank you|best|cheers|sincerely|respectfully|warmly|love|xo|-|—|~)[,!.]?\s*$")
NAME_CUE = re.compile(r"(?i)\b(name is|named|called|this is|i'?m|i am|meet|ask|tell|text|call"
                      r"|thanks|thank you|hi|hey|hello|dear|mr\.?|mrs\.?|ms\.?)[\s,]*$")
WORD = re.compile(r"(?<![\w@])[^\W\d_]{2,}(?!\w)")
SURNAME_AFTER = re.compile(f"{OPEN}([^{CLOSE}]+){CLOSE}([ \\t]+)([A-Za-z][a-z]+)(?!\\w)")
NAME_BEFORE = re.compile(f"(?<![\\w{CLOSE}])([A-Z][a-z]+)([ \\t]+){OPEN}([^{CLOSE}]+){CLOSE}")
LOWER_STREET = re.compile(r"(?i)\b([a-z]{3,})(\s+)(st|ave|rd|blvd|ln|ct|dr|way|pl|cir|street|avenue|road|drive|lane)\b")
HANDLE = re.compile(r"(?<![\w@.])@[A-Za-z0-9_][A-Za-z0-9_.-]{2,}")
CASHTAG = re.compile(r"(?<![\w$])\$[A-Za-z][A-Za-z0-9_-]{2,}")
STATES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ "
          "NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split()
# State abbreviations only in capitals ("pay me 12000" is not Maine); full names in any case
_STATE = r"(?:\b(?:" + "|".join(STATES) + r")\b|(?i:\b(?:" + "|".join(fakes.STATE_NAMES) + r")\b))"
STATE_ZIP = re.compile(r"(" + _STATE + r")(\s*,?\s*)(\d{5})(?:-\d{4})?\b")
ZIP_AFTER = re.compile(f"({CLOSE}[,\\s]{{0,3}})(\\d{{5}})(?:-\\d{{4}})?(?!\\d)")
FIVE_DIGITS = re.compile(r"(?<![\d$.,/:#-])(\d{5})(?:-\d{4})?(?![\d,.]?\d)")
STATE_AFTER_CITY = re.compile(f"({CLOSE},?[ \\t]+)([A-Za-z]{{2}})(?![^\\W_])")
STATE_BEFORE_ZIP = re.compile(f"(?<![^\\W_])([A-Za-z]{{2}})(,?[ \\t]+{OPEN}\\d{{5}})")
NUMBERED_BEFORE_PLACE = re.compile(f"(?<![\\w{CLOSE}])(\\d{{2,6}})[ \\t]+([A-Z][a-z]{{3,}})(,?[ \\t]+{OPEN})")
NUMBERED_REAL = re.compile(r"(?<![\w$.,])(\d{2,6})[ \t]+([A-Z][a-z]{3,})()(?![^\W_])")
SIX_DIGITS = re.compile(r"(?<![\d$.,/:#-])(\d{6})(?![\d,.]?\d)")  # "627041": a ZIP with a typo
ZIP_SEED = re.compile(r"(?:" + _STATE + r"|(?i:\bzip(?:\s?code)?\b))\W{0,3}(\d{5})\b")


def corpus_freq(texts) -> tuple[Counter, Counter]:
    """How each word is written across the whole history: lowercase vs Capitalised."""
    lower, cap = Counter(), Counter()
    for t in texts:
        # "someone@mail.com" and URL paths are not how anyone writes a word
        t = BARE_URL.sub(" ", URL.sub(" ", EMAIL.sub(" ", t)))
        for m in WORD.finditer(t):
            w = m.group(0)
            if w.islower():
                lower[fold(w)] += 1
            elif w[0].isupper() and w[1:].islower():
                # only mid-sentence capitals count: every word is capitalised
                # at the start of a sentence ("Reply STOP", "Hola")
                prev = t[:m.start()].rstrip(" \t")
                if prev and (prev[-1].islower() or prev[-1] in ",;"):
                    cap[fold(w)] += 1
    return lower, cap


def corpus_texts(store: Store) -> list[str]:
    """Message texts that show how people write: business short codes are
    automated boilerplate, so they're left out."""
    return [m.text for conv in store.conversations
            if conv.is_group or not SHORT_CODE.fullmatch(next(iter(conv.members), ""))
            for m in conv.messages if m.text]


def collapse(s: str) -> str:
    """'Zaaarrekkk' -> 'zarek': repeated letters don't make a different name."""
    return re.sub(r"(.)\1+", r"\1", s)


def osa(a: str, b: str, cap: int = 3) -> int:
    """Edit distance counting a swap of neighbours as one edit."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] != b[j - 1]))
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[-1][-1]


def owner_variant(low: str, owner: list[str], titled: bool) -> str | None:
    """The owner token `low` is a variant of: same after collapsing repeats, one
    edit away (5+ letters), two away when capitalised and 6+ letters, or an
    owner surname of 6+ letters inside a longer word ("Surnamestroy")."""
    k = collapse(low)
    for t in owner:
        ct = collapse(t)
        if len(ct) < 5:
            continue
        if k == ct or (len(k) >= 5 and osa(k, ct) <= (2 if titled and len(k) >= 6 else 1)):
            return t
        if len(ct) >= 6 and ct in k:
            return t
    return None


def is_wordlike(low: str, lower: Counter, cap: Counter) -> bool:
    """A word people mostly write in lowercase ("that", "rent", "will") is a word,
    not a name; so are the listed common words and anything two letters long."""
    return (len(low) <= 2 or low in fakes.COMMON_WORD_NAMES or low in fakes.NON_NAMES
            or (lower[low] >= 5 and lower[low] >= cap[low]))


def luhn(digits: str) -> bool:
    d = [int(c) for c in digits][::-1]
    return (sum(d[0::2]) + sum(sum(divmod(2 * x, 10)) for x in d[1::2])) % 10 == 0


def aba(digits: str) -> bool:
    """US bank routing number checksum."""
    d = [int(c) for c in digits]
    return len(d) == 9 and (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + d[2] + d[5] + d[8]) % 10 == 0


def registrable(host: str) -> str:
    parts = host.lower().split(":")[0].split(".")
    keep = 3 if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in ("co", "com", "org", "net") else 2
    return ".".join(parts[-keep:])


class Scrubber:
    def __init__(self, store: Store, cls: Classification, mapping: Mapping, config: dict,
                 owner_phone: str = ""):
        self.store, self.cls, self.map = store, cls, mapping
        houses = cls.houses
        # named houses ("Lakeview House") are often a person's name: leave those
        # words to the name stage, exclude only real street names
        self.house_cores = {h.core for h in houses.houses.values() if h.number}
        self.cities = {c.lower() for c in config.get("cities", [])}
        self.ignore = {fold(w) for w in config.get("ignore_names", [])}

        # name token indexes over every contact (so mentions of anyone are caught).
        # Organisation-only contacts are matched as whole phrases instead: their
        # words ("Heating & Air", "Management") are ordinary words one by one.
        self.first_of: dict[str, set] = defaultdict(set)
        self.last_of: dict[str, set] = defaultdict(set)
        self.folded_tokens: dict[str, set] = {}
        orgs = set()
        for c in store.contacts.values():
            if c.org:
                orgs.add(c.org)
            if not (c.first or c.last):
                continue
            toks = name_tokens(f"{c.first} {c.last}", self.house_cores, self.cities)
            if not toks:
                continue
            pk = f"c{c.id}"
            parts = [token_parts(t) for t in toks]
            self.folded_tokens[pk] = {fold(p) for ps in parts for p in ps}
            for p in parts[0]:
                self.first_of[fold(p)].add(pk)
            for ps in parts[1:]:
                for p in ps:
                    self.last_of[fold(p)].add(pk)
        self._orgs = orgs
        self.org_re = phrase_regex([])  # built in learn_corpus, once ordinary words are known
        self.zip_prefixes: set[str] = set()
        self.owner_first = {fold(t) for n in config.get("owner_names", []) for t in n.split()}
        self.owner_tokens = self.owner_first | {fold(t) for n in config.get("owner_surnames", [])
                                                for t in n.split()}
        self.extra = {fold(t) for t in config.get("extra_names", [])}
        # a set lookup per word: a regex alternation of ~1500 names is retried at
        # every character and took minutes over a full message history
        self.name_set = (set(self.first_of) | set(self.last_of) | self.owner_tokens | self.extra) - self.ignore
        name_like = set(self.first_of) | set(self.last_of)
        city_list = [c for c in self.cities if c not in name_like]
        alt = "|".join(re.escape(c).replace(r"\ ", r"\s+")
                       for c in sorted(city_list, key=len, reverse=True)) or r"(?!x)x"
        self.city_re = re.compile(rf"(?<![^\W_])({alt})(?![^\W_])", re.IGNORECASE)  # "_" is a boundary
        terms = list(config.get("redact_terms", [])) + list(config.get("owner_handles", []))
        self.redact_re = redact_regex(terms)
        self.redact_terms = {fold(t.lstrip("=")) for t in terms}
        self._inserted: set[str] = set()  # fake names inserted by the current scrub() call
        self.real_streets: set[str] = {c for c in self.house_cores if " " not in c} | set(mapping.data["streets"])
        # Misspellings of what matters most ("Quarrell", "Springfeild", "Zareck") are
        # caught by a fuzzy match against house streets, cities and your names.
        self.fuzzy_targets: dict[str, tuple[str, str]] = {}
        for core in self.house_cores:
            if " " not in core and len(core) >= 6 and not core[:1].isdigit():
                self.fuzzy_targets[core] = ("street", core)
        for city in self.cities:
            if len(city) >= 6:
                self.fuzzy_targets[fold(city)] = ("city", city)
        self.owner_fuzzy = sorted(self.owner_tokens)
        self.owner_phones = {norm_handle(p) for p in config.get("owner_phones", []) + [owner_phone] if p}
        self.msg_count: Counter = Counter()
        for conv in store.conversations:
            for h in conv.members:
                self.msg_count[store.person_key(h)] += len(conv.messages)
        self.lower_freq: Counter = Counter()
        self.cap_freq: Counter = Counter()

    def learn_corpus(self, texts):
        texts = list(texts)
        self.lower_freq, self.cap_freq = corpus_freq(texts)
        # A company name is only worth a phrase match if it isn't ordinary words
        # (a contact whose organisation is "Landlord" must not eat every "landlord").
        self.org_re = phrase_regex(
            [o for o in self._orgs if any(not self.wordlike(fold(w)) and fold(w) not in ROLE_VOCAB
                                          for w in WORD.findall(o))], min_len=5)
        # ZIPs: whatever follows a state or "zip code" anywhere, plus contact tags.
        # Their 3-digit prefixes then catch bare ZIPs ("rooms in 62701 and 62711").
        for t in texts + [c.tag_text for c in self.store.contacts.values()]:
            self.zip_prefixes.update(z[:3] for z in ZIP_SEED.findall(t))

    def wordlike(self, low: str) -> bool:
        return is_wordlike(low, self.lower_freq, self.cap_freq)

    # -- individual stages --
    def _url(self, m):
        u = m.group(0)
        host = registrable(urlparse(u if "://" in u else "http://" + u).netloc)
        return P(f"[link: {host}]" if host in LINK_ALLOW else "[link]")

    def _email(self, m):
        e = m.group(0).lower()
        if norm_handle(e) in self.store.contact_of or e in self.store.raw_handle:
            return P(self.map.person(self.store.person_key(e))["email"])
        return P(self.map.email(e))

    def _phone(self, m):
        n = norm_handle(m.group(0))
        if n in self.owner_phones:
            return P(self.map.person("owner")["phone"])
        if n in self.store.contact_of or n in self.store.raw_handle:
            return P(self.map.person(self.store.person_key(n))["phone"])
        return P(self.map.phone(n))

    def _card(self, m):
        digits = re.sub(r"\D", "", m.group(0))
        return P("[card number]") if 13 <= len(digits) <= 19 and luhn(digits) else m.group(0)

    @staticmethod
    def _code(m):
        key, sep, val = m.group(1).lower(), m.group(3), m.group(4)
        # "garage at 10am", "the gate opens at 7:30": a time, not a code
        if TIME_AFTER.match(m.string, m.end()) or TIME_BEFORE.search(m.group(2) + sep):
            return m.group(0)
        # "the gate is 10 feet wide": a quantity; codes have 3+ digits
        if UNIT_AFTER.match(m.string, m.end()) or sum(ch.isdigit() for ch in val) < 3 and val.isdigit():
            return m.group(0)
        # weak keywords ("pass", "gate") need an explicit "is"/":" before the value
        if key in WEAK_SECRET_KEYS and sep.strip() not in (":", "=", "#", "is") and "code" not in m.group(2).lower():
            return m.group(0)
        return m.group(1) + m.group(2) + sep + P("[redacted]")

    def _wifi(self, m):
        val = m.group(4)
        if self.wordlike(fold(val)) or val.lower().strip(".!?") in NOT_A_SECRET:
            return m.group(0)
        return m.group(1) + m.group(2) + m.group(3) + P("[redacted]")

    def _app_handle(self, m):
        val = m.group(3)
        low = val.lower().lstrip("@").strip(".-")
        if low in NOT_A_SECRET or low in ("me", "you", "him", "her", "them", "it", "him.", "only") or \
                (val.isalpha() and self.wordlike(fold(val))):
            return m.group(0)
        return m.group(1) + m.group(2) + P("[handle]")

    @staticmethod
    def _bare_codes(t: str) -> str:
        if not CODE_CONTEXT.search(PROTECTED.sub(" ", t)):
            return t

        def one(m):
            v = m.group(0)
            if len(v) == 4 and 1950 <= int(v) <= 2039:  # a year
                return v
            if TIME_AFTER.match(m.string, m.end()) or UNIT_AFTER.match(m.string, m.end()):
                return v
            # near the word: "Try this 481926 ... that code", not any number in a long message
            window = m.string[max(0, m.start() - 60):m.end() + 60]
            return P("[redacted]") if CODE_CONTEXT.search(window) else v
        return sub_free(BARE_CODE, one, t)

    @staticmethod
    def _code_word(m):
        if m.group(1).lower() in WORD_SECRET_KEYS and m.group(4).lower().strip(".!?") not in NOT_A_SECRET:
            return m.group(1) + m.group(2) + m.group(3) + P("[redacted]")
        return m.group(0)

    @staticmethod
    def _license(m):
        val = m.group(3)
        if len(re.sub(r"[ -]", "", val)) >= 5 and any(ch.isdigit() for ch in val):
            return m.group(1) + m.group(2) + P("[redacted]")
        return m.group(0)

    def _address(self, text: str) -> str:
        out, pos = [], 0
        for h in self.cls.houses.scan(text):
            out.append(text[pos:h.start])
            orig = text[h.start:h.end]
            trail = orig[len(orig.rstrip()):]
            if h.house:
                f = self.map.house(h.house)
                if h.kind in ("numbered", "numbered-known"):
                    rep = f"{f['number']}{h.unit} {f['street']} {f['suffix']}"
                elif h.kind in ("named", "alias"):
                    rep = f"{f['street']} House"
                else:
                    rep = f["street"] + (f" {f['suffix']}" if h.suffix else "")
            elif h.number:
                s = self.map.street(h.core)
                rep = f"{self.map.generic_number(h.number + '|' + h.core)}{h.unit} {s['street']} {s['suffix']}"
            else:
                s = self.map.street(h.core)
                rep = s["street"] + (f" {s['suffix']}" if h.suffix else "")
            # "6016 Quarrel @ 36th Ave": a number right before a replaced street is its house number
            if not h.number and out:
                num = re.search(r"\b(\d{1,6})([A-Za-z]?)[ \t]+$", out[-1])
                if num:
                    out[-1] = out[-1][:num.start()]
                    rep = f"{self.map.generic_number(num.group(1) + '|' + h.core)}{num.group(2)} {rep}"
            # "Service Address: Elm Rd 8812": a number right after a replaced street is its house number
            after = re.match(r"([ \t]+)(\d{1,6})\b(?![:.,]?\d|\s?(?:am|pm|%))", text[h.end:]) if not h.number else None
            if after:
                rep = f"{rep}{after.group(1)}{self.map.generic_number(after.group(2) + '|' + h.core)}"
                pos = h.end + after.end()
            else:
                pos = h.end
            out.append(P(rep) + trail)
        out.append(text[pos:])
        return "".join(out)

    def _lower_street(self, m):
        """'banks st' in lowercase: a street the data knows is real."""
        if fold(m.group(1)) in self.real_streets:
            s = self.map.street(fold(m.group(1)))
            return P(f"{s['street']}{m.group(2)}{m.group(3)}")
        return m.group(0)

    def _addresses(self, t: str) -> str:
        out, pos = [], 0
        for m in PROTECTED.finditer(t):
            out.append(self._address(t[pos:m.start()]))
            out.append(m.group(0))
            pos = m.end()
        out.append(self._address(t[pos:]))
        return "".join(out)

    def _name(self, m, participants: set[str], text: str):
        tok = m.group(0)
        low = fold(tok)
        if low in self.ignore:
            return tok
        before = text[:m.start()].rstrip(f" \t{OPEN}{CLOSE}")
        sentence_start = not before or before[-1] in ".!?\n:"
        mine = {pk for pk in participants if low in self.folded_tokens.get(pk, ())}
        titled = tok[:1].isupper()
        if low not in self.owner_tokens and self.wordlike(low):
            # "Hello everyone", "I will", "Rent is due": only a name when capitalised
            # and either cued ("his name is Will") or mid-sentence and someone in
            # this chat is called that. Your own name goes in any case.
            # part of a full name: "Mark Scarborough" -- the neighbour is a name too
            nxt = re.match(r"[ \t]+([^\W\d_]+)", text[m.end():])
            in_full_name = bool(titled and nxt and nxt.group(1)[:1].isupper()
                                and fold(nxt.group(1)) in self.name_set and not self.wordlike(fold(nxt.group(1))))
            cued = titled and low not in fakes.NON_NAMES and (NAME_CUE.search(before) or in_full_name)
            # someone in this chat has the name: "Mark, did you do the yard?",
            # "Bathroom: Mark" -- replace it wherever it stands
            # "check with Mark", "But Mark is": a contact's word-name capitalised
            # mid-sentence is the person (months and weekdays excluded)
            mid_name = (titled and not sentence_start and low in fakes.COMMON_WORD_NAMES
                        and low not in fakes.NON_NAMES and (low in self.first_of or low in self.last_of))
            if not (cued or (titled and mine) or mid_name):
                return tok
        if low in self.owner_tokens:
            o = self.map.person("owner")
            rep = o["first"] if low in self.owner_first else o["last"]
        else:
            firsts = self.first_of.get(low, set())
            lasts = self.last_of.get(low, set())
            pick = (mine & firsts) or (mine & lasts)
            if pick:
                pk = sorted(pick)[0]
                rep = self.map.person(pk)["first" if pk in firsts else "last"]
            elif len(firsts | lasts) == 1:
                pk = next(iter(firsts | lasts))
                rep = self.map.person(pk)["first" if pk in firsts else "last"]
            elif self._dominant(firsts | lasts):
                # several contacts share the name, but you talk to one of them far
                # more: "Dana" in your texts is almost always that Dana
                pk = self._dominant(firsts | lasts)
                rep = self.map.person(pk)["first" if pk in firsts else "last"]
            else:
                rep = self.map.token(low, last=not firsts and bool(lasts))
        self._inserted.add(rep)
        if tok.isupper() and len(tok) > 1:
            rep = rep.upper()
        return P(rep)

    def _dominant(self, keys: set[str]) -> str | None:
        ranked = sorted(keys, key=lambda k: -self.msg_count[k])
        if len(ranked) >= 2 and self.msg_count[ranked[0]] >= 5 * max(1, self.msg_count[ranked[1]]):
            return ranked[0]
        return None

    def _surname(self, m):
        """'Soren Brown' after the first name was replaced: the surname goes too,
        even an ordinary-word one, or a lowercase one ("soren vilmar")."""
        fake, gap, word = m.group(1), m.group(2), m.group(3)
        low = fold(word)
        if fake not in self._inserted or low in self.ignore or low in fakes.NON_NAMES or low in SUFFIXES:
            return m.group(0)
        surname_word = word[:1].isupper() and low in fakes.SURNAME_WORDS
        never_lower = self.lower_freq[low] == 0 and low not in self.name_set
        if surname_word or (never_lower and not self.wordlike(low)):
            return P(fake) + gap + P(self.map.token(low, last=True))
        return m.group(0)

    def _name_before(self, m):
        """'Wenna Ravenscroft' where only the surname was a known name: the first
        name before it goes too."""
        word, gap, fake = m.group(1), m.group(2), m.group(3)
        low = fold(word)
        if fake not in self._inserted or low in self.ignore or low in fakes.NON_NAMES or self.wordlike(low):
            return m.group(0)
        if self.lower_freq[low] * 2 <= self.cap_freq[low] or self.lower_freq[low] == 0:
            return P(self.map.token(low)) + gap + P(fake)
        return m.group(0)

    def _owner(self, tok: str) -> str | None:
        """Your own name in any spelling: "zarec", "Zaaarek", "Zareck", "Zarekconstruction"."""
        low = fold(tok)
        if self.wordlike(low) and low not in self.owner_tokens:
            return None
        hit = owner_variant(low, self.owner_fuzzy, tok[:1].isupper())
        if not hit:
            return None
        o = self.map.person("owner")
        return o["first"] if hit in self.owner_first else o["last"]

    def _fuzzy(self, tok: str) -> str | None:
        low = fold(tok)
        if len(low) < 6 or not tok[:1].isupper() or self.wordlike(low):
            return None
        hit = get_close_matches(low, self.fuzzy_targets, n=1, cutoff=0.84)
        if not hit:
            return None
        kind, real = self.fuzzy_targets[hit[0]]
        if kind == "street":
            house = self.cls.houses.best_for_core(real)
            return self.map.house(house.key)["street"] if house else self.map.street(real)["street"]
        return self.map.city(real)

    def _word(self, m, participants: set[str]) -> str:
        tok = m.group(0)
        low = fold(tok)
        if low in self.ignore:
            return tok
        # your own name before the automatic name pass gets a chance to call it someone else;
        # a real contact with a similar name keeps their own pseudonym
        if low not in self.first_of and low not in self.last_of:
            rep = self._owner(tok)
            if rep:
                self._inserted.add(rep)
                return P(rep.upper() if tok.isupper() and len(tok) > 1 else rep)
        if low in self.name_set:
            return self._name(m, participants, m.string)
        rep = self._fuzzy(tok)
        return P(rep) if rep else tok

    def scrub(self, text: str, participants: set[str] = frozenset()) -> str:
        if not text:
            return text
        text = text.replace(OPEN, " ").replace(CLOSE, " ")  # the markers are ours alone
        if len(text) > 4000:
            # some patterns are quadratic on pathological input; scrub long texts in
            # pieces, cut after whitespace so no word is split
            pieces = re.findall(r".{1,2000}(?:\s+|$)|.{2000}", text, re.S)
            return "".join(self.scrub(p, participants) for p in pieces)
        self._inserted = set()
        t = sub_free(EMAIL, self._email, text)
        t = sub_free(URL, self._url, t)
        t = sub_free(BARE_URL, self._url, t)
        t = sub_free(self.redact_re, lambda m: P("[redacted]"), t)
        t = sub_free(SSN, lambda m: P("[ssn]"), t)
        t = sub_free(CARD, self._card, t)
        t = sub_free(ACCOUNT, lambda m: m.group(1) + m.group(2) + P("[account number]"), t)
        t = sub_free(ROUTING, lambda m: P("[routing number]") if aba(m.group(0)) else m.group(0), t)
        t = sub_free(PHONE, self._phone, t)
        t = sub_free(PHONE_INTL, lambda m: P("[phone]") if sum(ch.isdigit() for ch in m.group(0)) >= 8
                     else m.group(0), t)
        t = sub_free(PHONE7, lambda m: P(self.map.short_phone(m.group(0))), t)
        t = sub_free(LONG_DIGITS, lambda m: P("[number]"), t)
        t = sub_free(DOB, lambda m: m.group(1) + m.group(2) + P("[date]"), t)
        t = sub_free(LICENSE, self._license, t)
        t = sub_free(CODE, self._code, t)
        t = sub_free(CODE_WORD, self._code_word, t)
        t = sub_free(WIFI, self._wifi, t)
        t = sub_free(APP_HANDLE, self._app_handle, t)
        t = sub_free(SECRET_TOKEN, lambda m: P("[redacted]"), t)
        t = self._addresses(t)
        t = sub_free(self.org_re, lambda m: P("[company]"), t)
        # cities before ZIPs: in "Fake St Springfield 62701" the city sits between them
        t = sub_free(self.city_re, lambda m: P(self.map.city(m.group(1))), t)
        # "Springfield, nc 00417": a state right after a city, in any case
        t = STATE_AFTER_CITY.sub(lambda m: m.group(1) + P("[state]") if m.group(2).upper() in STATES
                                 else m.group(0), t)
        t = sub_free(STATE_ZIP, lambda m: m.group(1) + m.group(2) + P(self.map.zip(m.group(3))), t)
        t = ZIP_AFTER.sub(lambda m: m.group(1) + P(self.map.zip(m.group(2))), t)
        t = sub_free(FIVE_DIGITS, lambda m: P(self.map.zip(m.group(1))) if m.group(1)[:3] in self.zip_prefixes
                     else m.group(0), t)
        t = sub_free(SIX_DIGITS, lambda m: P(self.map.zip(m.group(1)[:5])) if m.group(1)[:3] in self.zip_prefixes
                     else m.group(0), t)
        t = self._bare_codes(t)  # after addresses and ZIPs, so those numbers are already handled
        t = sub_free(HANDLE, lambda m: P("@[handle]"), t)
        t = sub_free(CASHTAG, lambda m: P("$[handle]"), t)
        t = sub_free(WORD, lambda m: self._word(m, participants), t)
        t = SURNAME_AFTER.sub(self._surname, t)
        t = NAME_BEFORE.sub(self._name_before, t)
        t = sub_free(LOWER_STREET, self._lower_street, t)
        # places the name stage replaced can carry a state too: "Blava, TX", "highlands, ca 00442"
        t = STATE_AFTER_CITY.sub(lambda m: m.group(1) + P("[state]") if m.group(2).upper() in STATES
                                 else m.group(0), t)
        t = STATE_BEFORE_ZIP.sub(lambda m: P("[state]") + m.group(2) if m.group(1).upper() in STATES
                                 else m.group(0), t)
        t = NUMBERED_BEFORE_PLACE.sub(self._numbered_before_place, t)
        # "48213 Larkmoor house": a number before a street the data knows is real
        t = sub_free(NUMBERED_REAL, lambda m: self._numbered_before_place(m)
                     if fold(m.group(2)) in self.real_streets else m.group(0), t)
        return t

    def _numbered_before_place(self, m):
        """'713 Larkmoor, Springfield': a number and a word right before a replaced
        place is a street address even without "St"."""
        num, word, gap = m.group(1), m.group(2), m.group(3)
        low = fold(word)
        if self.wordlike(low) and low not in self.real_streets:
            return m.group(0)
        st = self.map.street(low)
        return P(f"{self.map.generic_number(num + '|' + low)} {st['street']}") + gap


# ---------------------------------------------------------------- residual audit

CAP_WORD = re.compile(r"(?<![\w@])([^\W\d_]{3,})(?!\w)")
SIGNATURE_TAIL = re.compile(r"[ \t]+[^\W\d_][^\W\d_]+[ \t]*(?:\n|$)")


def residual_names(texts: list[str], scrub: Scrubber, skip: set[str] = frozenset(),
                   strict: bool = True) -> list[tuple[str, int, str]]:
    """Capitalised words that are almost never written lowercase: likely names
    the contacts don't cover. Counts mid-sentence words, cued words ("ask Wenna")
    and signature lines ("Wenna Strode" alone on a line).
    strict: the bar for replacing automatically; otherwise the bar for reporting."""
    seen: Counter = Counter()
    strong: Counter = Counter()
    sample: dict[str, str] = {}
    for t in texts:
        free = PROTECTED.sub(" ", t)
        for m in CAP_WORD.finditer(free):
            w = m.group(1)
            if not (w[0].isupper() and w[1:].islower()):
                continue
            before = free[:m.start()]
            mid = bool(re.search(r"[^\W\d_][,;]?[ \t]$", before))
            cued = bool(NAME_CUE.search(before.rstrip()))
            line_start = before == "" or before.endswith("\n")
            prev_line = before.rstrip("\n").rsplit("\n", 1)[-1] if before.rstrip("\n") else ""
            rest = free[m.end():]
            signature = line_start and bool(SIGNATURE_TAIL.match(free, m.end())) and bool(SIGN_OFF.search(prev_line)) \
                or bool(re.search(r"(?:^|\n)\s*[-—~]\s*$", before)) \
                or (line_start and bool(before.strip()) and not rest.strip(" \t.!\n"))  # a name alone on the last line
            if not (mid or cued or signature):
                continue
            seen[w] += 1
            if cued or signature:
                strong[w] += 1
            sample.setdefault(w, free[max(0, m.start() - 40):m.end() + 40].replace("\n", " "))
    out = []
    for w, n in seen.items():
        low = fold(w)
        if low in skip or low in SUFFIXES or low in fakes.NON_NAMES:
            continue
        # "Hi Hope": a word-name with a cue in front still counts (it's replaced only where cued)
        if scrub.wordlike(low) and not (strong[w] and low in fakes.COMMON_WORD_NAMES):
            continue
        # one stray lowercase "dan" mustn't save a name written "Dan" 26 times
        # Privacy over prose: once is enough. A place or brand may become a fake
        # name, but a friend mentioned once must not stay real.
        if strict and not (scrub.lower_freq[low] * 2 <= scrub.cap_freq[low] or low in fakes.COMMON_WORD_NAMES):
            continue
        if not strict and scrub.lower_freq[low] > max(1, n // 5):
            continue
        out.append((w, n, sample[w]))
    return sorted(out, key=lambda r: -r[1])


# ---------------------------------------------------------------- writer

def attachment_label(name: str, mime: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    kind = (mime.split("/")[0] if mime else "") or "file"
    return f"{kind}{' ' + ext if ext else ''}"


def _span(cur_first, cur_last, first, last):
    firsts = [d for d in (cur_first, first) if d]
    lasts = [d for d in (cur_last, last) if d]
    return (min(firsts) if firsts else None), (max(lasts) if lasts else None)


def solo_secrets(conv) -> None:
    """A code or password sent as its own message after "what's the lockbox code?"
    or "here's the wifi": blank it in place (in memory only)."""
    recent: list[str] = []
    for m in conv.messages:
        if m.text and SOLO_SECRET.match(m.text) and any(CODE_CONTEXT.search(r) for r in recent) \
                and not TIME_AFTER.match(m.text.strip()[-3:]) and not m.text.strip().isalpha():
            m.text = "[redacted]"
        if m.text:
            recent = (recent + [m.text])[-2:]


def house_cities(store: Store, cls: Classification, cities: set[str], texts=()) -> dict[str, str]:
    """The real city of each house, read from the contacts that name it and from
    messages that write "<house>, <city>", so the house's fake city is the same
    fake the text uses for that city."""
    out = {}
    text_votes: dict[str, Counter] = defaultdict(Counter)
    folded = {fold(c): c for c in cities}
    for t in texts:
        for h in cls.houses.scan(t):
            if h.house:
                m = re.match(r"[ \t,]+([^\W\d_]+(?: [^\W\d_]+)?)", t[h.end:])
                if m:
                    for cand in (m.group(1), m.group(1).split()[0]):
                        if fold(cand) in folded:
                            text_votes[h.house][folded[fold(cand)]] += 1
                            break
    for key, h in cls.houses.houses.items():
        votes: Counter = Counter(text_votes.get(key, {}))
        for src in h.sources:
            if src.startswith("contact:"):
                c = store.contacts.get(int(src.split(":")[1]))
                for city in cities:
                    if c and re.search(rf"\b{re.escape(city)}\b", c.tag_text, re.I):
                        votes[city] += 1
        if votes:
            out[key] = votes.most_common(1)[0][0]
    return out


def anonymize(store: Store, cls: Classification, config: dict, private_dir: str, out_dir: str,
              owner_phone: str = "") -> dict:
    if os.path.basename(os.path.normpath(out_dir)) != "anonymized":
        raise ValueError("refusing to write anywhere but a folder named 'anonymized'")
    included = cls.included
    os.makedirs(private_dir, exist_ok=True)
    blocked = set()
    house_cores = {h.core for h in cls.houses.houses.values() if h.number}
    cities = {c.lower() for c in config.get("cities", [])}
    for c in store.contacts.values():
        blocked.update(t.lower() for t in name_tokens(f"{c.first} {c.last} {c.org}", set(), set()))
    for core in house_cores:
        blocked.update(core.split())
    blocked |= cities | {t.lower() for n in config.get("owner_names", []) for t in n.split()}
    # real streets mentioned anywhere must not come back as a fake street
    for t in (m.text for c in included for m in c.conv.messages if m.text):
        for h in find_numbered(t) + find_streets(t):
            blocked.update(h.core.split())
    if os.path.exists(os.path.join(private_dir, "mapping.json")):
        with open(os.path.join(private_dir, "mapping.json"), encoding="utf-8") as f:
            blocked.update(w for core in json.load(f).get("streets", {}) for w in core.split())
    owner_all = [t for n in config.get("owner_names", []) + config.get("owner_surnames", []) for t in n.split()]
    mapping = Mapping(os.path.join(private_dir, "mapping.json"), blocked, owner_all)
    owner_fake = config.get("owner_pseudonym") or {}
    if owner_fake.get("first") and owner_fake.get("last"):
        mapping.set_owner(owner_fake["first"], owner_fake["last"])
    scrub = Scrubber(store, cls, mapping, config, owner_phone)
    scrub.learn_corpus(corpus_texts(store))
    raw = [m.text for c in included for m in c.conv.messages if m.text]
    real_city = house_cities(store, cls, cities, raw)
    for key, city in real_city.items():
        mapping.house(key, city)  # fix each house's fake city before any text claims the house

    # Names that are in no contact (a tenant's friend, a misspelling of someone)
    # surface as capitalised words that are almost never written lowercase.
    # Pseudonymize them up front; residual-names.csv lists them for review and
    # config ignore_names keeps a word as-is.
    auto_names = []
    skip = scrub.name_set | scrub.ignore | scrub.cities | house_cores | scrub.redact_terms
    if config.get("auto_residual_names", True):
        auto_names = residual_names(raw, scrub, skip, strict=True)
        scrub.name_set |= {fold(w) for w, _, _ in auto_names}

    # Build the new output beside the old one and swap at the end, so a crash
    # never leaves a half-written shareable folder.
    final_dir, out_dir = out_dir, out_dir + ".tmp"
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)

    people = cls.people
    pk_of = store.person_key

    def fake_name(handle: str) -> str:
        p = mapping.person(pk_of(handle))
        return f"{p['first']} {p['last']}"

    def house_label(key: str | None) -> str:
        if not key:
            return ""
        f = mapping.house(key)
        return f"{f['number']} {f['street']} {f['suffix']}, {f['city']}"

    used: set = set()
    index, jsonl_rows, scrubbed_all = defaultdict(list), defaultdict(list), []
    stats = defaultdict(lambda: {"first": None, "last": None, "sent": 0, "convs": set(), "houses": set(),
                                 "datasets": set()})
    house_groups: dict[tuple, list] = defaultdict(list)
    for c in included:
        if c.conv.is_group and c.house:
            house_groups[(c.house, c.final_dataset)].append(c)
    group_no = {}
    for key, cs in house_groups.items():
        for i, c in enumerate(sorted(cs, key=lambda c: c.conv.first or APPLE_EPOCH)):
            group_no[c.conv.id] = i + 1 if len(cs) > 1 else 0

    group_word = {"tenants": "group", "landlords": "landlord group", "contractors": "contractor group"}
    for c in included:
        conv = c.conv
        ds = c.final_dataset
        base = os.path.join(out_dir, ds)
        cid = mapping.conv(conv.id)
        participants = {pk_of(h) for h in conv.members}
        if conv.is_group:
            folder = os.path.join(base, "Group Chats")
            if c.house:
                n = group_no.get(conv.id, 0)
                title = f"{house_label(c.house)} - {group_word.get(ds, 'group')}" + (f" {n}" if n else "")
            else:
                title = unmark(scrub.scrub(conv.name, participants)) if conv.name else f"Group {cid}"
        else:
            handle = next(iter(conv.members))
            p = people[pk_of(handle)]
            if ds == "tenants":
                sub = "Prospects" if p.has("prospect") and not p.has("tenant") else "Tenants"
            else:
                sub = "Conversations"
            folder = os.path.join(base, sub)
            title = fake_name(handle) + (f" - {house_label(c.house)}" if c.house else "")

        memo: dict[str, str] = {}

        def marked(s, _p=participants, _memo=memo):
            if s not in _memo:
                _memo[s] = scrub.scrub(s, _p)
            return _memo[s]

        def text_of(s):
            return unmark(marked(s))

        solo_secrets(conv)
        lines = render_lines(conv, fake_name, text_of, attachment_label)
        count = sum(1 for l in lines if l.startswith("[") and not l.split("] ", 1)[-1].startswith("["))
        if not count:
            continue
        os.makedirs(folder, exist_ok=True)
        path = unique_path(folder, safe_filename(title), used)
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"{title}\n")
            f.write(f"Conversation: {cid}  |  {ds}  |  {'group' if conv.is_group else '1:1'}  |  "
                    f"{count} messages  |  {fmt(conv.first)} to {fmt(conv.last)}\n")
            if c.house:
                f.write(f"House: {mapping.house(c.house)['id']}  {house_label(c.house)}\n")
            f.write("People:\n")
            for h in sorted(conv.members, key=fake_name):
                pp = people[pk_of(h)]
                fp = mapping.person(pk_of(h))
                hl = "; ".join(house_label(k) for k in pp.houses) or "-"
                f.write(f"  {fp['id']}  {fp['first']} {fp['last']}  ({pp.role_label})"
                        f"  {fp['phone']}  house: {hl}\n")
            f.write("=" * 70 + "\n")
            f.write("\n".join(lines) + "\n")
        index[ds].append((conv.last, count, "group" if conv.is_group else "1:1", title,
                          os.path.relpath(path, base), cid))

        for m in conv.messages:
            if m.sender and m.item_type == 0:
                stats[pk_of(m.sender)]["sent"] += 1
            body = text_of(m.text) if m.text else ""
            if body:
                scrubbed_all.append(marked(m.text))
            if m.item_type == 0 and renderable(m) and (body or m.attachments):
                sender = "me" if m.from_me else mapping.person(pk_of(m.sender))["id"] if m.sender else "someone"
                jsonl_rows[ds].append({
                    "conv": cid, "dataset": ds, "type": "group" if conv.is_group else "1:1",
                    "house": mapping.house(c.house)["id"] if c.house else None,
                    "ts": m.dt.isoformat() if m.dt else None, "sender": sender,
                    "sender_name": "Me" if m.from_me else (fake_name(m.sender) if m.sender else "Someone"),
                    "text": body, "attachments": [attachment_label(n, t) for n, t in m.attachments],
                    "edited": m.edited})
        for h in conv.members:
            s = stats[pk_of(h)]
            s["convs"].add(cid)
            s["datasets"].add(ds)
            s["first"], s["last"] = _span(s["first"], s["last"], conv.first, conv.last)
            pp = people[pk_of(h)]
            s["houses"].update(pp.houses)
            if c.house and conv.is_group:
                s["houses"].add(c.house)

    # people.csv / houses.csv / messages.jsonl / INDEX.txt
    with open(os.path.join(out_dir, "people.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "roles", "datasets", "phone", "email", "houses", "first_seen", "last_seen",
                    "messages_sent", "conversations"])
        for pk, s in sorted(stats.items(), key=lambda kv: mapping.person(kv[0])["id"]):
            fp = mapping.person(pk)
            pp = people.get(pk)
            w.writerow([fp["id"], f"{fp['first']} {fp['last']}", pp.role_label if pp else "unknown",
                        " ".join(sorted(s["datasets"])),
                        fp["phone"], fp["email"], "; ".join(sorted(house_label(k) for k in s["houses"])),
                        fmt(s["first"]), fmt(s["last"]), s["sent"], " ".join(sorted(s["convs"]))])
    house_rows = defaultdict(lambda: {"people": set(), "groups": 0, "first": None, "last": None,
                                      "roles": Counter()})
    for pk, s in stats.items():
        for k in s["houses"]:
            house_rows[k]["people"].add(pk)
            for r in (people[pk].roles if pk in people else []):
                house_rows[k]["roles"][r] += 1
    for c in included:
        if c.house:
            r = house_rows[c.house]
            r["groups"] += c.conv.is_group
            r["first"], r["last"] = _span(r["first"], r["last"], c.conv.first, c.conv.last)
    with open(os.path.join(out_dir, "houses.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "address", "people", "tenants", "landlords", "contractors", "group_chats",
                    "first_activity", "last_activity"])
        for k, r in sorted(house_rows.items(), key=lambda kv: mapping.house(kv[0])["id"]):
            w.writerow([mapping.house(k)["id"], house_label(k), len(r["people"]),
                        r["roles"]["tenant"] + r["roles"]["prospect"], r["roles"]["landlord"],
                        r["roles"]["contractor"], r["groups"], fmt(r["first"]), fmt(r["last"])])
    note = ("Names, phones, emails, addresses, cities, links, codes and account numbers are fake or "
            "redacted.\nThe same person keeps the same pseudonym in every dataset (see ../people.csv).\n\n")
    totals = {}
    for ds, rows in index.items():
        base = os.path.join(out_dir, ds)
        with open(os.path.join(base, "messages.jsonl"), "w", encoding="utf-8") as f:
            for row in sorted(jsonl_rows[ds], key=lambda r: (r["conv"], r["ts"] or "")):
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        rows.sort(key=lambda r: r[0] or APPLE_EPOCH, reverse=True)
        totals[ds] = (len(rows), sum(r[1] for r in rows))
        with open(os.path.join(base, "INDEX.txt"), "w", encoding="utf-8") as f:
            f.write(f"Anonymized {ds}: {totals[ds][0]} conversations, {totals[ds][1]} messages\n" + note)
            for last, n, kind, title, rel, cid in rows:
                f.write(f"{fmt(last) or '----------'}  {cid}  {n:>6}  {kind:<5}  {title}\n")
    with open(os.path.join(out_dir, "INDEX.txt"), "w", encoding="utf-8") as f:
        f.write(f"Anonymized property conversations: {sum(t[0] for t in totals.values())} conversations, "
                f"{sum(t[1] for t in totals.values())} messages, {len(stats)} people, {len(house_rows)} houses\n")
        f.write(note.replace("../people.csv", "people.csv"))
        for ds in cls.datasets:
            if ds in totals:
                f.write(f"  {ds + '/':<14} {totals[ds][0]:>5} conversations  {totals[ds][1]:>7} messages\n")
        f.write("\npeople.csv  one row per person: pseudonym, roles (e.g. partner+tenant), datasets, houses\n"
                "houses.csv  one row per house: fake address, tenants/landlords/contractors, activity\n")

    # save the mapping before the swap, so output never exists without the mapping that made it
    mapping.save()
    # swap by renames: a locked file on Windows can fail a delete, never a half-deleted output
    old_dir = final_dir + ".old"
    if os.path.isdir(old_dir):
        shutil.rmtree(old_dir)
    if os.path.isdir(final_dir):
        os.replace(final_dir, old_dir)
    os.replace(out_dir, final_dir)
    shutil.rmtree(old_dir, ignore_errors=True)

    residual = residual_names(scrubbed_all, scrub, scrub.ignore | scrub.redact_terms, strict=False)
    with open(os.path.join(private_dir, "residual-names.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["word", "count", "status", "example"])
        for word, n, ex in auto_names:
            w.writerow([word, n, "pseudonymized (auto)", ex])
        for word, n, ex in residual:
            w.writerow([word, n, "LEFT IN OUTPUT", unmark(ex)])
    mapping.save()
    return {"conversations": sum(t[0] for t in totals.values()),
            "messages": sum(t[1] for t in totals.values()), "people": len(stats),
            "datasets": {ds: {"conversations": t[0], "messages": t[1]} for ds, t in totals.items()},
            "houses": len(house_rows), "auto_names": len(auto_names), "residual_name_candidates": len(residual)}
