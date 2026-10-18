# ios-messages

Pull text messages out of an iPhone backup (iMazing or iTunes/Apple Devices), export them as
organized text, sort the property conversations into tenants, landlords and contractors, and pseudonymize those so they can be
shared or analysed without identifying anyone.

```
backup ──extract──▶ db/ (sms.db, AddressBook) ──export──▶ export/   every conversation as text
                                   │
                                   └──classify──▶ private/review.csv ──anonymize──▶ anonymized/ ──audit
```

## Install

```bash
cd ios-messages
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # Linux/macOS: .venv/bin/pip
```

Back up the phone first (iMazing: "Back Up" — a quick *data access only* partial backup is
enough; it lands in iMazing's cache and is found automatically).

## Use

```bash
python ios-messages.py extract --list   # backups found, newest first
python ios-messages.py pipeline --refresh --export
```

`pipeline` = `extract` (with `--refresh`, or when nothing is extracted yet) → `export` (with
`--export`) → `classify` → `anonymize` → `audit`. Each step also runs alone (`renters` is an old
alias of `classify`).

Everything is written under the **work dir**, `~/Documents/ios-messages` (override with `--work` or
`IOS_MESSAGES_WORK`). Nothing personal is ever written inside this repo.

| Path | What | Share? |
|---|---|---|
| `db/` | decrypted `sms.db`, `AddressBook.sqlitedb`, `backup-info.json` | no |
| `export/` | every conversation, one `.txt` each: `Conversations/`, `Group Chats/`, `Unknown Numbers/`, `Businesses & Short Codes/`, plus `INDEX.txt`/`INDEX.csv` | no |
| `config.json` | your settings (created on first run, with a `_help` block) | no |
| `private/review.csv` | every candidate conversation with real names, dataset, reasons and an `override` column | no |
| `private/mapping.json` | real → fake mapping; keeps pseudonyms stable across runs | no |
| `private/residual-names.csv`, `private/leak-report.txt` | what the name audit and leak check found | no |
| `anonymized/` | `tenants/` (`Tenants/`, `Prospects/`, `Group Chats/`), `landlords/` and `contractors/` (`Conversations/`, `Group Chats/`), each with `messages.jsonl` + `INDEX.txt`; shared `people.csv` (roles, datasets, houses), `houses.csv` | yes |

### Decryption

Encrypted backups are opened with the backup password from, in order: the env var named by
`--password-env` (default `IOS_BACKUP_PASSWORD`), the credential iMazing saves in Windows
Credential Manager (`iMazing/<UDID>`), or a prompt. The password is never printed or stored.

Since iOS 16 many messages keep their text only in `attributedBody` (an NSAttributedString
typedstream); `typedstream.py` decodes it, or those messages would export blank.

## Sorting into datasets (`classify`)

Property conversations go into three datasets (configurable with `datasets`):

| Dataset | Roles | What's in it |
|---|---|---|
| `tenants` | tenant, prospect | 1:1s with tenants and prospects, and the house group chats |
| `landlords` | landlord | master landlords and property managers you lease from, and groups with them |
| `contractors` | contractor | plumbers, HVAC, handymen, cleaners, roofers, pest control, haulers… |

Partners/co-hosts, neighbors and everything else stay out of every dataset, but partners keep
their role label wherever they appear in a dataset's group chats.

Recall over precision: anything plausibly property-related lands in `review.csv`, and only
borderline items are left out by default. Evidence, strongest first:

1. **Stated roles.** `role_overrides` maps a contact name (or phone) to roles, first one primary:
   `{"Dana": ["partner", "tenant"]}` for a co-host who also rents a room. Such a person is a
   partner *and* a tenant: their 1:1 goes to `tenants`, `people.csv` shows `partner+tenant`. An
   exact name wins over a partial one, so `"Dana"` doesn't catch `"Dana HVAC"`; ambiguous keys
   print a warning. `partners` is shorthand for `["partner"]`; `exclude_contacts` drops contacts
   that are never property business (colleagues at your day job). Phone keys need all 10 digits.
2. **Contact tags.** Role words in any name field — `Roomies`, `Tenant`/`Tenat`, `Renter`, `Room`,
   `Master Bedroom` → tenant; `Interested`, `Potential`, `SpareRoom`, `Craigslist` → prospect;
   `Landlord`, `Property manager`, `Concierge` → landlord; `Plumber`, `HVAC`, `Handyman`,
   `Cleaner`, `Roofer`, `Pest`, `Dumpster`… → contractor; `Neighbor`; car listings → other.
3. **Houses.** Every numbered address in contacts and group names becomes a house. Variants
   resolve to one house: `1420 Larch Rd`, `1420 larch Rd `, `Larch rd Tenant`, `Larch Rd Home`,
   `back at larch tonight`. A house is a *rental* when it has a group chat or tenant/prospect/
   landlord contacts. A contact with only a rental house's address is a tenant.
4. **Group chats.** Named after a rental house, ≥2 renters, or one renter plus rental talk →
   `tenants`, and **everyone in one is a renter**, even an unknown number. A group with a landlord
   (and no tenants) → `landlords`; a small group with a contractor about a property →
   `contractors`. Classification repeats until roles stop changing, since new tenants change how
   their other groups read. Join/leave/rename events are kept, so who lived where and when can be
   followed.
5. **Partners.** Someone untagged who sits in house groups of ≥`partner_min_houses` (4) houses —
   a business line, a co-host — is a partner, not a tenant.
6. **Message keywords** for untagged contacts and unknown numbers. Rental talk (rent, lease,
   deposit, room listings, showings…) → tenant/prospect. For the others only *their* messages
   count: "your lease renewal", "rent is due", "tenant portal" → landlord; "estimate", "invoice",
   "technician on the way", water heater/pest/leak → contractor, but only when the chat is about a
   property (not a car). A chat that is mostly day-job talk (code, deploys, robots — add yours with
   `day_job_terms`) is never classified from keywords alone, and a landlord or contractor you never
   replied to is a marketing blast, listed but not included. Score ≥ `keyword_include_score` is
   included; ≥ `keyword_review_score` is listed.

Review loop: open `private/review.csv`, set `override` on any row to `yes`, `no`, or a dataset
name (`tenants` / `landlords` / `contractors`) to move it, and re-run. Any other value is ignored
with a warning. Overrides survive re-runs: a conversation that stops being detected keeps its row,
and a `yes`/dataset override pulls it back in (`yes` picks the dataset from the person's role).
Overrides are read before the group chats are classified, so a person you force into a dataset
counts with that role in their groups too. Group chats are keyed by their chat identifier, so
an override sticks even after people join or leave. A group's members are everyone who was ever in
it — current members, anyone who posted, anyone added or removed — not just who is in it today.

## Anonymizing (`anonymize`)

Each real person gets **one** fake name, phone, email and — through their house — fake address,
identical in their 1:1 chat, every group chat and every dataset, so people can be tracked across
conversations (a contractor who shows up in a house group is the same pseudonym in both). A house's
fake city is the same fake the text uses for that real city (read from contacts and from messages
that write "<house>, <city>"). Every person gets their own fake first name (invented names top up
the curated pool), and names that map to no single person draw from a separate pool, so a fake never
means two things; no fake street is also a person's name. A fake is never a real name or street from
your data, never contains one, and never sits a typo away from your own name; one that later collides
with a new contact or street is reassigned. `owner_pseudonym` sets your own fake name. `private/mapping.json`
keeps all of it stable between runs; delete it to reshuffle everyone.

What gets scrubbed in every message, in this order (each replacement is protected from the stages
after it):

- **Links** — only big platforms keep their site (`[link: zillow.com]`); anything else, including
  links typed without `http`, becomes `[link]`, since a domain can name a business, a city or a person.
- **Emails, phone numbers** (10-digit, 7-digit, odd groupings, international; known people get
  their fake number).
- **`redact_terms` and `owner_handles`** — your business and employer names, neighborhoods,
  utilities, universities, your Venmo/Instagram/GitHub handles: anything that gives the owner or the
  region away. Terms match in any case, except: `=Wake` matches only as written (so "wake up" stays),
  and terms of 1-3 letters match as written unless written `~SF` (then "sf" goes too). An
  underscore counts as a word break ("ave_NYC").
- **Numbers** — SSNs, card numbers (Luhn-checked), account numbers (even on the line after
  "Account number"), routing numbers (ABA checksum), any other run of 8+ digits.
- **Secrets** — door/gate/lock/lockbox codes and passwords (the whole token, punctuation included;
  also a bare number written near the word "code", "door", "lock", "código"…, and a message that is
  nothing but a code or password right after one asking about a code, lockbox, door, Wi-Fi or
  password), Wi-Fi network names and passwords (value on the same line or the next — network names
  can be geolocated), standalone password-like tokens ("Acme2024!"), the
  handle after "venmo"/"IG"/"cash app"…, dates of birth (numeric or written out), license plates
  and license numbers.
  Times and quantities are left alone ("garage opens at 10am", "the gate is 10 feet wide").
- **Addresses** — every house variant, other numbered addresses, numberless streets ("on
  Bellflower Ave", "near 28th ave and Quarrel" — cross streets too), a house number before or after
  a replaced street, a number plus a word right before a replaced city ("713 Larkmoor, Springfield"),
  a number before any street your data knows is real, lowercase real streets ("larkmoor st"),
  misspelled house streets and cities (fuzzy match), ZIP codes (after a state, after an address, or
  any 5- or 6-digit number sharing a prefix with a real ZIP in your data), configured cities, and a
  state abbreviation in any case right after a replaced place or before a ZIP ("…, nc 00417").
  Fake ZIPs are 00100–00499, a range no real ZIP uses.
- **Companies** — contacts' organisation names, as whole phrases.
- **Names** — every contact's name tokens (resolved to the right person when they're in the chat),
  your own name in any spelling, case or script (Cyrillic is transliterated, so `Весна` matches
  `Vesna`; repeated letters, one typo, two in a longer capitalised word, or your surname inside a
  longer word all count — checked before anything else, so a misspelling of you never becomes a
  stranger; nicknames go in `owner_names`), and names that are in no contact: capitalised words people almost
  never write in lowercase. Whether a word is a name or a word is learned from how people write it
  mid-sentence across the whole history, leaving out business short codes' boilerplate, so "That",
  "Rent", "Hola" or "Will" stay words, while "Torvin" goes. Word-names (Will, Mark) are replaced when
  someone in the chat has that name (anywhere: "Bathroom: Mark"), a cue precedes them ("his name is
  Will"), a contact has that name and it's capitalised mid-sentence ("check with Mark"), or they sit
  next to another name ("Mark Scarborough"); a surname right after a replaced first name goes too,
  even an ordinary-word one ("… Brown") or a lowercase one, and so does a first name right before a
  replaced surname. A name alone on a message's last line, or after a greeting ("Hi Hope"), counts as
  a name. A first name several contacts share goes to the one you talk to far more.
- **Handles** — `@handles`, `$cashtags`. Attachments are reduced to their type.

Timestamps and amounts are kept. Very long messages are scrubbed in pieces, so no pattern can
stall on pathological input. The automatic name pass favours privacy over prose: a place or a
brand mentioned once may become a fake name; `ignore_names` keeps a word as-is, `extra_names` forces
one, and `private/residual-names.csv` lists both what was replaced and what was left.

Fill in `config.json` before sharing: `owner_names` (first name, nicknames, misspellings),
`owner_surnames`, `owner_phones`, `owner_handles`, `owner_pseudonym`, `cities`, `redact_terms`,
`house_aliases` (`"Hilltop House": "960 Summit Dr"`).

The output is written to `anonymized.tmp`, the mapping is saved, and only then is the new folder
swapped in by renames, so a crash never leaves a half-written shareable folder or an output without
its mapping; anonymize refuses to write to any folder not named `anonymized`. `extract` likewise
decrypts into a fresh folder and replaces `db/` only when it succeeded, so a wrong password never
destroys the last good extraction.

### Leak check (`audit`)

Runs after every `anonymize` (or alone with `audit`). It scans everything under `anonymized/`,
including the text in each `messages.jsonl`. It looks for:

- every real phone number and email in the backup;
- contact full names of any length, contact name tokens (any case) and company names;
- house addresses and streets, real ZIP codes seen while scrubbing, and configured cities;
- real streets other than the houses' (with a suffix or a house number), and a state abbreviation
  right before a ZIP;
- `redact_terms`, your handles, and your names in the same spellings the scrubber catches.

Real names are checked even when they look like a pseudonym (pools never contain real names, so a
match is a leak). Results go to `private/leak-report.txt`, and any hard hit prints a warning. Soft
hits are contact names that are also ordinary words (Will, Deja, Ty): most are the word, so they're
listed for a skim rather than counted as leaks.

What it can't promise: details that identify someone without a name or a listed term (a job, a
school, a neighborhood typed in lowercase) aren't detected. Skim before publishing.

## Tests

```bash
.venv/Scripts/python -m unittest discover -s tests -t .
```

The tests build a synthetic backup (`tests/fixture.py`) and run the whole pipeline end to end:
classification, export, anonymization, and an audit that must catch deliberately planted leaks of
every hard category (phone, email, house address, house street, city, state, full name, name
token, company, redact term, handle, owner name in Cyrillic, ZIP — in transcripts and in
`messages.jsonl`). Pseudonyms are randomly seeded, so run the suite a few times when changing name
handling.

## Keeping real data out of this repo (`guard`)

Examples in code, tests and docs must be invented. `ios-messages.py guard --staged` checks the files
staged for commit against the work dir: contact names, your names and handles, redact terms, cities,
real streets and ZIPs from the mapping, numbers that occur in your messages, and identifier-shaped
tokens (Wi-Fi names, codes) that occur in them. It prints file:line and the kind of match, never the
value. Install it as a pre-commit hook:

```bash
cat > ../.git/hooks/pre-commit <<'HOOK'
#!/bin/sh
cd "$(git rev-parse --show-toplevel)/ios-messages" 2>/dev/null || exit 0
PY=.venv/Scripts/python; [ -x "$PY" ] || PY=.venv/bin/python
[ -x "$PY" ] || exit 0
exec "$PY" ios-messages.py guard --staged
HOOK
chmod +x ../.git/hooks/pre-commit
```

Generic words a contact name happens to contain ("realty", "partners") go in `.guard-allow`.
