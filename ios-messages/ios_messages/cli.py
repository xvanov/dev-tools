"""ios-messages: pull, export, classify and anonymize text messages from an iPhone backup.

  extract    find the newest backup (iMazing / iTunes), decrypt sms.db + contacts
  export     every conversation as a text file, organized, with an index
  classify   sort conversations into tenants / landlords / contractors -> private/review.csv
  anonymize  classify, pseudonymize the included conversations -> anonymized/, then audit
  audit      grep anonymized/ for any real phone, email, name, address, ZIP or city
  pipeline   [extract] -> [export] -> classify -> anonymize -> audit
  guard      check repo files for real data from the work dir (git pre-commit hook)

All data lives under the work dir (default ~/Documents/ios-messages), never in the repo.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

from . import backup as backup_mod
from .addresses import find_numbered
from .anonymize import ROLE_VOCAB, anonymize
from .audit import HARD, audit
from .classify import detect, summary, write_review
from .export_text import export_all
from .store import load

DEFAULT_WORK = os.path.join(os.path.expanduser("~"), "Documents", "ios-messages")
DEFAULT_CONFIG = {
    "owner_names": [],
    "owner_surnames": [],
    "owner_phones": [],
    "owner_handles": [],
    "owner_pseudonym": {},
    "cities": [],
    "redact_terms": [],
    "extra_names": [],
    "ignore_names": [],
    "auto_residual_names": True,
    "house_aliases": {},
    "partners": [],
    "role_overrides": {},
    "exclude_contacts": [],
    "day_job_terms": [],
    "partner_min_houses": 4,
    "datasets": {"tenants": ["tenant", "prospect"], "landlords": ["landlord"], "contractors": ["contractor"]},
    "keyword_include_score": 6,
    "keyword_review_score": 4,
}
CONFIG_HELP = {
    "owner_names": "your first name and the ways others misspell it (any script); replaced by your pseudonym's first name",
    "owner_surnames": "your surname(s) and misspellings",
    "owner_phones": "your own numbers (the backup's number is added automatically)",
    "owner_handles": "your Venmo / Cash App / Instagram / GitHub handles: redacted wherever they appear",
    "owner_pseudonym": "optional {\"first\": ..., \"last\": ...} for your own fake name",
    "cities": "city names to replace with fake cities (cities seen after contact addresses are added automatically)",
    "redact_terms": "phrases replaced by [redacted] wherever they appear: your business and employer names, "
                    "neighborhoods, utilities or universities that give away the region. Any case matches; "
                    "write \"=Wake\" to match only as written (so \"wake up\" stays); 1-3 letter terms are case-sensitive",
    "extra_names": "names the residual audit flagged (private/residual-names.csv) that should be pseudonymized",
    "ignore_names": "words wrongly treated as names (e.g. a contact called 'Ikea')",
    "auto_residual_names": "pseudonymize capitalised words that are never written lowercase (likely names not in contacts)",
    "house_aliases": "nicknames for a house -> its address, e.g. {\"Hilltop House\": \"960 Summit Dr\"}",
    "partners": "contacts who run houses with you (co-host, business line): shorthand for role_overrides [\"partner\"]",
    "role_overrides": "contact name or 10-digit phone -> roles, first is primary, e.g. {\"Dana\": [\"partner\", \"tenant\"]} "
                      "for a co-host who also rents",
    "exclude_contacts": "contact-name words that are never property business (e.g. your employer)",
    "day_job_terms": "extra words of your day job; untagged chats dominated by them are never classified",
    "partner_min_houses": "untagged people in house groups of this many houses are treated as partners",
    "datasets": "output datasets -> roles whose chats go there (tenant, prospect, partner, landlord, contractor, "
                "neighbor, other); names become folder names",
    "keyword_include_score": "message-keyword score at which an untagged chat is included automatically",
    "keyword_review_score": "score at which it is listed in review.csv for a decision",
}


def paths(work: str) -> dict:
    return {k: os.path.join(work, v) for k, v in {
        "db": "db", "export": "export", "private": "private", "anon": "anonymized",
        "config": "config.json", "review": os.path.join("private", "review.csv")}.items()}


def load_config(work: str) -> dict:
    p = paths(work)["config"]
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            cfg.update({k: v for k, v in json.load(f).items() if not k.startswith("_")})
    else:
        os.makedirs(work, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"_help": CONFIG_HELP, **DEFAULT_CONFIG}, f, indent=2)
        print(f"created {p} -- fill in owner_names before sharing anonymized output")
    return cfg


def detected_cities(store) -> set[str]:
    """'1420 Larch Rd, Springfield, IL' -> Springfield. Words right after a contact's address."""
    out = set()
    for c in store.contacts.values():
        t = c.tag_text
        for a in find_numbered(t):
            m = re.match(r"[\s,]+([A-Za-z]+(?:\s[A-Z][a-z]+)?)", t[a.end:])
            if m:
                w = m.group(1).strip()
                if len(w) > 2 and not w.isupper() and not any(x in ROLE_VOCAB for x in w.lower().split()):
                    out.add(w.title())
    return out


def meta(work: str) -> dict:
    p = os.path.join(paths(work)["db"], "backup-info.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {}


def cmd_extract(a):
    backups = backup_mod.find_backups([a.backup] if a.backup else None)
    if a.backup:
        backups = [b for b in backups if os.path.normcase(b.path).startswith(os.path.normcase(a.backup))] or backups
    if not backups:
        sys.exit("No iPhone backup found. Back up with iMazing or Apple Devices first, or pass --backup.")
    if getattr(a, "list", False):
        for b in backups:
            print(f"{b.modified:%Y-%m-%d %H:%M}  {b.source:<15} {'encrypted' if b.encrypted else 'plain':<9} "
                  f"{b.device or '-':<20} {b.path}")
        return
    b = backups[0]
    print(f"backup: {b.device or b.udid} ({b.source}, {b.modified:%Y-%m-%d %H:%M}, "
          f"{'encrypted' if b.encrypted else 'not encrypted'})")
    m = backup_mod.extract(b, paths(a.work)["db"], a.password_env)
    print(f"extracted {', '.join(m['files'])} -> {paths(a.work)['db']}")


def _store(a):
    db = paths(a.work)["db"]
    if not os.path.exists(os.path.join(db, "sms.db")):
        sys.exit(f"No decrypted sms.db in {db}: run `extract` first.")
    return load(db)


def cmd_export(a):
    store = _store(a)
    out = getattr(a, "out", None) or paths(a.work)["export"]
    r = export_all(store, out)
    print(f"{r['conversations']} conversations, {r['messages']} messages -> {out}")


def _classify(a, store, cfg):
    p = paths(a.work)
    cls = detect(store, cfg, p["review"])
    write_review(cls, store, p["review"])
    s = summary(cls)
    print(f"classify: {s['included']} conversations included of {s['candidates']} candidates; "
          f"{s['review_band']} borderline to review; {s['rental_houses']} rental houses")
    for name, n in s["by_dataset"].items():
        print(f"  {name:<12} {n['1:1']:>4} 1:1  {n['group']:>4} group")
    for w in cls.warnings:
        print(f"  warning: {w}")
    if s["partners"]:
        print(f"  partners: {', '.join(s['partners'])}")
    print(f"  review: {p['review']}  (override = yes / no / {' / '.join(cls.datasets)}, then re-run)")
    return cls


def _config_with_detected(a, store):
    cfg = load_config(a.work)
    cfg["cities"] = sorted(set(cfg.get("cities", [])) | detected_cities(store))
    return cfg


def cmd_classify(a):
    store = _store(a)
    _classify(a, store, _config_with_detected(a, store))


def cmd_anonymize(a):
    store = _store(a)
    cfg = _config_with_detected(a, store)
    if not cfg.get("owner_names"):
        print("warning: config owner_names is empty -- your own name will not be pseudonymized")
    cls = _classify(a, store, cfg)
    p = paths(a.work)
    r = anonymize(store, cls, cfg, p["private"], p["anon"], meta(a.work).get("owner_phone", ""))
    print(f"anonymized: {r['conversations']} conversations, {r['messages']} messages, {r['people']} people, "
          f"{r['houses']} houses -> {p['anon']}")
    for ds, t in r["datasets"].items():
        print(f"  {ds + os.sep:<13} {t['conversations']:>4} conversations  {t['messages']:>6} messages")
    print(f"  {r['auto_names']} names outside contacts pseudonymized automatically; "
          f"{r['residual_name_candidates']} capitalised words left as-is")
    print(f"  review: {os.path.join(p['private'], 'residual-names.csv')} "
          f"(config extra_names to replace, ignore_names to keep)")
    _audit(a, store, cls, cfg)


def _audit(a, store, cls, cfg):
    p = paths(a.work)
    report = os.path.join(p["private"], "leak-report.txt")
    r = audit(store, cls, cfg, p["anon"], report, p["private"])
    print(f"audit: {', '.join(f'{k} {v}' for k, v in sorted(r.items())) or 'no real values found'}")
    if any(r.get(k) for k in HARD):
        print("  WARNING: real identifiers remain in anonymized/ -- see " + report)
    else:
        soft = sum(v for k, v in r.items() if k not in HARD)
        print(f"  no hard identifiers (phones, emails, addresses, ZIPs, cities, names, companies)"
              f"{f'; {soft} soft hits to skim' if soft else ''}. details: {report}")


def cmd_audit(a):
    store = _store(a)
    cfg = _config_with_detected(a, store)
    _audit(a, store, detect(store, cfg, paths(a.work)["review"]), cfg)


def cmd_guard(a):
    from .guard import check, staged_files
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if not os.path.isdir(paths(a.work)["db"]):
        print("guard: no work dir data, nothing to compare against")
        return
    files = staged_files(repo) if a.staged else [os.path.abspath(p) for p in a.paths]
    problems = check(files, a.work)
    for line in problems:
        print(line)
    if problems:
        sys.exit(f"guard: {len(problems)} possible real values; replace them with invented ones "
                 f"(or add a generic word to ios-messages/.guard-allow)")
    print(f"guard: {len(files)} files clean")


def cmd_pipeline(a):
    if a.refresh or not os.path.exists(os.path.join(paths(a.work)["db"], "sms.db")):
        cmd_extract(a)
    if a.export:
        cmd_export(a)
    cmd_anonymize(a)


def main(argv=None):
    # contact names and warnings go to the console; never die on a cp1252 pipe
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(prog="ios-messages", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=os.environ.get("IOS_MESSAGES_WORK", DEFAULT_WORK),
                    help=f"work dir for decrypted data and outputs (default {DEFAULT_WORK})")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def backup_args(p):
        p.add_argument("--backup", help="backup folder (default: newest found)")
        p.add_argument("--password-env", default="IOS_BACKUP_PASSWORD",
                       help="env var holding the backup password (default IOS_BACKUP_PASSWORD)")

    p = sub.add_parser("extract", help="decrypt sms.db + contacts from the newest backup")
    backup_args(p)
    p.add_argument("--list", action="store_true", help="only list backups found")
    p.set_defaults(fn=cmd_extract)
    p = sub.add_parser("export", help="text export of every conversation")
    p.add_argument("--out", help="output dir (default <work>/export)")
    p.set_defaults(fn=cmd_export)
    sub.add_parser("classify", aliases=["renters"],
                   help="sort conversations into datasets, write review.csv").set_defaults(fn=cmd_classify)
    sub.add_parser("anonymize", help="classify, pseudonymize, audit").set_defaults(fn=cmd_anonymize)
    sub.add_parser("audit", help="check anonymized output for real values").set_defaults(fn=cmd_audit)
    p = sub.add_parser("guard", help="check files for real data from the work dir")
    p.add_argument("--staged", action="store_true", help="check the files staged for commit")
    p.add_argument("paths", nargs="*", help="files to check")
    p.set_defaults(fn=cmd_guard)
    p = sub.add_parser("pipeline", help="[extract] -> [export] -> classify -> anonymize -> audit")
    backup_args(p)
    p.add_argument("--refresh", action="store_true", help="re-extract from the newest backup first")
    p.add_argument("--export", action="store_true", help="also write the full text export")
    p.set_defaults(fn=cmd_pipeline)

    a = ap.parse_args(argv)
    a.work = os.path.abspath(os.path.expanduser(a.work))
    a.fn(a)
