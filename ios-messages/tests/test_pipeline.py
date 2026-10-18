import csv
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def read(path):
    with open(path, encoding="utf-8-sig") as f:
        return f.read()


from ios_messages.addresses import HouseRegistry, find_numbered  # noqa: E402
from ios_messages.anonymize import Scrubber, anonymize, collapse, fold, osa, unmark  # noqa: E402
from ios_messages.audit import audit  # noqa: E402
from ios_messages.export_text import export_all  # noqa: E402
from ios_messages.classify import detect, role_of, write_review  # noqa: E402
from ios_messages.store import load, norm_handle  # noqa: E402
from ios_messages.typedstream import decode_attributed_body, encode_attributed_body  # noqa: E402
from tests import fixture  # noqa: E402

CONFIG = {
    "owner_names": ["Zarek"], "owner_surnames": ["Wolanski"], "owner_phones": [],
    "cities": [], "extra_names": [], "ignore_names": [], "house_aliases": {}, "partners": [],
    "keyword_include_score": 6, "keyword_review_score": 4,
    "role_overrides": {"Dana": ["partner", "tenant"]}, "exclude_contacts": ["Acme Robotics"],
    "cities": ["Springfield"], "redact_terms": ["Acme Robotics", "=Wake"], "owner_handles": ["zarekw"],
}


class Units(unittest.TestCase):
    def test_typedstream_roundtrip(self):
        for text in ["hi", "x" * 200, "ünïcødé ✓" * 50, "y" * 70000]:
            self.assertEqual(decode_attributed_body(encode_attributed_body(text)), text)
        self.assertIsNone(decode_attributed_body(b"garbage"))

    def test_norm_handle(self):
        self.assertEqual(norm_handle("+1 (555) 201-0001"), "5552010001")
        self.assertEqual(norm_handle("‪+15552010001‬"), "5552010001")
        self.assertEqual(norm_handle("Me@Mail.test"), "me@mail.test")

    def test_numbered_addresses(self):
        cores = [(a.number, a.core, a.suffix) for a in find_numbered(
            "at 1420 larch Rd, then 118 Queen Anne Ct and 88B Elm St. 75 12th ave")]
        self.assertEqual(cores, [("1420", "larch", "Rd"), ("118", "queen anne", "Ct"),
                                 ("88", "elm", "St"), ("75", "12th", "Ave")])
        self.assertEqual(find_numbered("see you at 5 pm way too late, 2 more st"), [])

    def test_registry_resolves_variants(self):
        r = HouseRegistry({"Hilltop House": "960 Summit Dr"})
        r.learn("1420 Larch Rd")
        r.learn("Hal 1420 larch rd Landlord")
        r.learn("52 North St")
        r.houses["1420|larch"].rental = True
        r.finalize_aliases()
        for text in ["Larch rd Tenant", "1420 larch Rd ", "back at Larch tonight", "Tenant Larch"]:
            self.assertEqual(r.resolve(text), "1420|larch", text)
        self.assertEqual(r.resolve("the Hilltop House group"), "960|summit")
        self.assertIsNone(r.resolve("I live in North Dakota"))
        self.assertEqual(r.resolve("52 north st oakton"), "52|north")

    def test_roles(self):
        cases = {"Roomies | Jo": "tenant", "Dana | Tenant Larch Rd": "tenant", "Tavi | Tenat Larch": "tenant",
                 "Priya Renter": "tenant", "Kit Potential Tenant": "prospect",
                 "Interested 52 North St": "prospect", "Lou 9 Fern St Landlord": "landlord",
                 "Plumber 1420 Larch Rd": "contractor", "Neighbor 1402": "neighbor",
                 "Car 88 Toyota Pickup $5.5K": "other", "Odessa Cleaning Lady": "contractor",
                 "Oak Realty Property Management": "landlord", "Pest Control Joe": "contractor", "Guy Who Wants To Build A House": None,
                 "Noor 75 12th Ave": None}
        for tag, role in cases.items():
            self.assertEqual(role_of(tag), role, tag)

    def test_fold(self):
        self.assertEqual(fold("Chloé"), fold("CHLOE"))


class Pipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db = os.path.join(cls.tmp, "db")
        fixture.build(cls.db)
        cls.store = load(cls.db)
        cls.cls = detect(cls.store, CONFIG)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def included_titles(self, dataset=None):
        out = set()
        for c in (self.cls.dataset(dataset) if dataset else self.cls.included):
            if c.conv.is_group:
                out.add(c.conv.name)
            else:
                out.add(self.store.label(next(iter(c.conv.members))))
        return out

    def test_attributed_body_is_read(self):
        texts = [m.text for c in self.store.conversations for m in c.messages]
        self.assertTrue(any("123-45-6789" in t for t in texts))

    def test_detection(self):
        tenants = self.included_titles("tenants")
        for want in ["Ilvane 12 Juniper Rd Tenant", "Oskar 12 Juniper Rd", "Roomies | Delphine",
                     fixture.UNKNOWN_PROSPECT, "12 Juniper Rd", "40 Quarry Ln", "Dana"]:
            self.assertIn(want, tenants)
        self.assertEqual(self.included_titles("landlords"), {"Hal 12 Juniper Rd Landlord", fixture.UNKNOWN_LANDLORD})
        self.assertEqual(self.included_titles("contractors"),
                         {"Bram Plumber 12 Juniper Rd", fixture.UNKNOWN_CONTRACTOR, "Dana HVAC",
                          "Larkfield Plumbing Supply"})
        everything = self.included_titles()
        for unwanted in ["Aunt Gertrude", "Northwind Holdings", fixture.UNKNOWN_MECHANIC, "Rex Acme Robotics",
                         fixture.MARKETING]:
            self.assertNotIn(unwanted, everything)

    def test_cohost_who_rents(self):
        dana = self.cls.people["c11"]
        self.assertEqual(dana.roles, ["partner", "tenant"])
        self.assertEqual(dana.role_label, "partner+tenant")
        self.assertIn("12|juniper", dana.houses)
        self.assertEqual(self.cls.people["c12"].role, "contractor")  # "Dana" must not catch "Dana HVAC"
        self.assertTrue(any("Dana HVAC" in w for w in self.cls.warnings))

    def test_group_member_without_contact_is_tenant(self):
        p = self.cls.people[self.store.person_key(norm_handle(fixture.UNKNOWN_GROUP_MEMBER))]
        self.assertEqual(p.role, "tenant")
        self.assertEqual(p.houses, ["12|juniper"])

    def test_business_line_is_partner(self):
        self.assertEqual(self.cls.people["c6"].role, "partner")

    def test_review_override_wins(self):
        review = os.path.join(self.tmp, "review.csv")
        write_review(self.cls, self.store, review)
        with open(review, encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        self.assertFalse(any(r["conversation"] == "Aunt Gertrude" for r in rows))  # family: never a candidate
        target = next(r for r in rows if r["conversation"] == "Bram Plumber 12 Juniper Rd")
        target["override"] = "no"
        with open(review, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=rows[0].keys())
            w.writeheader()
            w.writerows(rows)
        cls = detect(self.store, CONFIG, review)
        self.assertNotIn(target["conv_id"], {c.conv.id for c in cls.included})
        # a dataset name moves a conversation
        dana = next(r for r in rows if r["conversation"] == "Dana")
        dana["override"] = "contractors"
        with open(review, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=rows[0].keys())
            w.writeheader()
            w.writerows(rows)
        cls = detect(self.store, CONFIG, review)
        self.assertIn(dana["conv_id"], {c.conv.id for c in cls.dataset("contractors")})

    def test_export_all(self):
        out = os.path.join(self.tmp, "export")
        r = export_all(self.store, out)
        self.assertEqual(r["conversations"], len(self.store.conversations))
        self.assertTrue(os.path.exists(os.path.join(out, "INDEX.csv")))
        group = "".join(read(os.path.join(out, "Group Chats", f))
                        for f in os.listdir(os.path.join(out, "Group Chats")) if f.startswith("12 Juniper"))
        self.assertIn("[Me added Oskar 12 Juniper Rd]", group)

    def test_anonymize(self):
        priv, out = os.path.join(self.tmp, "private"), os.path.join(self.tmp, "anonymized")
        r = anonymize(self.store, self.cls, CONFIG, priv, out)
        self.assertGreater(r["conversations"], 5)
        blob = ""
        for root, _, files in os.walk(out):
            for f in files:
                blob += read(os.path.join(root, f))
        for real in ["Ilvane", "Oskar", "Delphine", "Juniper", "Zarek", "Wolanski", "201-0002", "5552010001",
                     "123-45-6789", "ilvane.k@mail.test", "4471", "Bluebird77", "maps.example.com/12",
                     "Весна", "Vesna", "Torvin", "Quist", "123456789", "021000021", "ABC1234", "555-1234",
                     "62704", "Springfield", "larkfield", "Larkfield", "Mark", "Mercy", "Vale", "cvale-88",
                     "qeRTWv", "8826"]:
            self.assertIsNone(re.search(rf"(?<!\w){re.escape(real)}(?!\w)", blob), real)
        self.assertIn("See [link]", blob)  # a site that could identify someone loses even its name
        self.assertEqual(audit(self.store, self.cls, CONFIG, out, os.path.join(priv, "leak.txt")), {})

        # one person, one pseudonym, in the 1:1 and the house group
        mapping = json.loads(read(os.path.join(priv, "mapping.json")))
        ilvane = mapping["persons"]["c1"]
        fake = f"{ilvane['first']} {ilvane['last']}"
        gdir = os.path.join(out, "tenants", "Group Chats")
        groups = [read(os.path.join(gdir, f)) for f in os.listdir(gdir)]
        juniper = next(g for g in groups if "trash day" in g)
        self.assertIn(fake, juniper)
        oskar = mapping["persons"]["c2"]
        self.assertIn(f"[Me added {oskar['first']} {oskar['last']}]", juniper)
        self.assertTrue(any(f.startswith(fake) for f in os.listdir(os.path.join(out, "tenants", "Tenants"))))
        # three datasets, one mapping
        self.assertEqual(set(r["datasets"]), {"tenants", "landlords", "contractors"})
        hal = mapping["persons"]["c10"]
        landlord_files = os.listdir(os.path.join(out, "landlords", "Conversations"))
        self.assertTrue(any(f.startswith(f"{hal['first']} {hal['last']}") for f in landlord_files))
        self.assertTrue(os.listdir(os.path.join(out, "contractors", "Conversations")))
        self.assertNotIn("2580", blob)
        people = read(os.path.join(out, "people.csv"))
        dana = mapping["persons"]["c11"]
        self.assertIn(f"{dana['first']} {dana['last']},partner+tenant", people)
        # Ilvane's own name in text resolves to her pseudonym's first name
        self.assertIn(f"Thanks {ilvane['first']}!", blob)

        # stable across runs
        anonymize(self.store, self.cls, CONFIG, priv, out)
        again = json.loads(read(os.path.join(priv, "mapping.json")))
        self.assertEqual(again["persons"]["c1"], ilvane)

    def test_store_membership_and_dates(self):
        house = next(c for c in self.store.conversations if c.name == "12 Juniper Rd" and len(c.messages) > 2)
        self.assertIn(norm_handle(fixture.LATE_JOINER), house.members)  # posted, then left
        vesna_chat = next(c for c in self.store.conversations if norm_handle("5552010014") in c.members)
        self.assertIsNotNone(vesna_chat.first)  # an undated message doesn't blank the span
        late = self.cls.people[self.store.person_key(norm_handle(fixture.LATE_JOINER))]
        self.assertEqual(late.role, "tenant")

    def test_group_id_survives_membership_change(self):
        house = next(c for c in self.store.conversations if c.name == "12 Juniper Rd" and len(c.messages) > 2)
        self.assertTrue(house.id.startswith("g"))
        self.assertNotIn(fixture.LATE_JOINER, house.id)
        self.assertEqual(house.key[0], "G")
        self.assertIsInstance(house.key[1], str)  # keyed by chat identifier, not by members

    def test_day_job_and_org_contacts(self):
        everything = self.included_titles()
        self.assertNotIn("Wes", everything)
        self.assertIn("Larkfield Plumbing Supply", self.included_titles("contractors"))

    def test_override_validation_and_noncandidates(self):
        review = os.path.join(self.tmp, "review2.csv")
        write_review(self.cls, self.store, review)
        with open(review, encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        gert = next(c for c in self.store.conversations if norm_handle("5552010005") in c.members)
        rows[0]["override"] = "tenant"  # singular: not a dataset
        rows.append(dict(rows[0], conv_id=gert.id, override="landlords"))
        with open(review, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=rows[0].keys())
            w.writeheader()
            w.writerows(rows)
        cls = detect(self.store, CONFIG, review)
        self.assertTrue(any("ignoring override 'tenant'" in w for w in cls.warnings))
        self.assertIn(gert.id, {c.conv.id for c in cls.dataset("landlords")})  # forced in although never detected
        write_review(cls, self.store, review)
        with open(review, encoding="utf-8-sig") as f:
            self.assertIn(gert.id, f.read())  # and it stays in the sheet

    def test_no_warning_for_people_with_their_own_override(self):
        cfg = dict(CONFIG, role_overrides={"Dana": ["partner", "tenant"], "Dana HVAC": ["contractor"]})
        cls = detect(self.store, cfg)
        self.assertFalse(any("Dana HVAC" in w for w in cls.warnings))

    def test_refuses_other_output_dirs(self):
        with self.assertRaises(ValueError):
            anonymize(self.store, self.cls, CONFIG, os.path.join(self.tmp, "p3"), os.path.join(self.tmp, "Documents"))

    def test_audit_catches_planted_leaks(self):
        priv, out = os.path.join(self.tmp, "private4"), os.path.join(self.tmp, "x", "anonymized")
        anonymize(self.store, self.cls, CONFIG, priv, out)
        with open(os.path.join(out, "planted.txt"), "w", encoding="utf-8") as f:
            f.write("Call Ilvane at (555) 201-0001, she lives at 12 Juniper Rd in Springfield. Torvin Quist knows. "
                    "Mail ilvane.k@mail.test or drop by Juniper, Westfield, IL 00417.")
        zips = json.loads(read(os.path.join(priv, "mapping.json")))["zips"]
        with open(os.path.join(out, "tenants", "messages.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"text": "Залин here, Larkfield Plumbing Supply quote; ask zarekw. Acme Robotics. "
                                        f"zip {next(iter(zips), '62704')} and Зарек"}) + "\n")
        r = audit(self.store, self.cls, CONFIG, out, os.path.join(priv, "leak.txt"), priv)
        for kind in ("phone", "house address", "city", "contact full name", "contact name token", "company",
                     "redact term", "owner handle", "owner name", "zip", "email", "house street", "state"):
            self.assertTrue(r.get(kind), kind)

    def test_round_two_privacy(self):
        from ios_messages.anonymize import Mapping
        m = Mapping(os.path.join(self.tmp, "m5.json"), set())
        s = Scrubber(self.store, self.cls, m, CONFIG)
        s.learn_corpus(["time to wake up now"] * 8 + ["Mail it to Springfield, IL 62704 please"])
        cases = {
            "my venmo is zarek-w88": "zarek-w88", "IG ilvanek_art for photos": "ilvanek_art",
            "send it to zarekw on cashapp": "zarekw", "thanks zarec!": "zarec",
            "Torvin Brown came by": "Brown", "WiFi Name:\nZOPLAXE": "ZOPLAXE",
            "close to 28th ave and Quarrel": "Quarrel", "Try this 481926, that code works": "481926",
            "SSN 123 45 6789": "123 45 6789", "plate ABC 1234": "ABC 1234", "born March 3, 1990": "March 3, 1990",
            "call +44 20 7946 0958": "7946", "see shop.example.co.uk/x": "example.co.uk",
            "Wake Electric is out": "Wake",
        }
        for text, secret in cases.items():
            self.assertNotIn(secret, unmark(s.scrub(text)), text)
        self.assertNotIn("Mark", unmark(s.scrub("I will check with Mark tomorrow")))  # a contact, mid-sentence
        for text in ["time to wake up", "the gate is 10 feet wide", "pay me 12000", "Venmo me later",
                     "I will see you in May", "Mark the date"]:
            self.assertEqual(unmark(s.scrub(text)), text)
        self.assertTrue(m.zip("62704").startswith("00"))  # fake ZIPs can't be real places

    def test_long_inputs_stay_fast(self):
        import time
        from ios_messages.anonymize import Mapping
        s = Scrubber(self.store, self.cls, Mapping(os.path.join(self.tmp, "m7.json"), set()), CONFIG)
        for text in ("a." * 30000, "Ab1-" * 20000, "x" * 60000):
            t0 = time.time()
            s.scrub(text)
            self.assertLess(time.time() - t0, 10, text[:8])

    def test_round_three_privacy(self):
        from ios_messages.anonymize import Mapping, residual_names
        m = Mapping(os.path.join(self.tmp, "m8.json"), set())
        cfg = dict(CONFIG, owner_names=["Zarek", "Zak"], redact_terms=["~GG"])
        s = Scrubber(self.store, self.cls, m, cfg)
        s.learn_corpus(["ok see you"] * 6)
        s.real_streets.add("larkmoor")
        cases = {
            "Zaaarekkk is here": "Zaaarekkk", "call Wolanskistroy about it": "Wolanskistroy",
            "Electronic lock 5521 works": "5521", "wifi password: Xk2,~qa9": "~qa9",
            "Bryla Quist is here": "Bryla", "Torvin vilmarq came by": "vilmarq",
            "Fakeville Springfield, nc 62704": ", nc", "meet at Springfield_ave": "Springfield",
            "gg park at noon": "gg park", "Service Address: Juniper Rd 8812": "8812", "meet at larkmoor st": "larkmoor",
            "lives at 713 Larkmoor, Springfield": "713", "Mail: Springfield, ca 62704": ", ca",
            "the 48213 Larkmoor house on Craigslist": "48213",
        }
        for text, secret in cases.items():
            self.assertNotIn(secret, unmark(s.scrub(text)), text)
        self.assertEqual(unmark(s.scrub("Jak and the crew")), "Jak and the crew")  # no fuzzy on short names
        found = {w for w, _, _ in residual_names(["Thanks for the update\nOkonkwo", "Hi Hope, the rent is in"], s)}
        self.assertIn("Okonkwo", found)  # a name alone on the last line
        self.assertIn("Hope", found)  # a word-name with a cue in front

    def test_group_no_override_stops_tenancy(self):
        review = os.path.join(self.tmp, "review3.csv")
        write_review(self.cls, self.store, review)
        with open(review, encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        house = next(c for c in self.store.conversations if c.name == "12 Juniper Rd"
                     and norm_handle(fixture.LATE_JOINER) in c.members)
        for r in rows:
            if r["conv_id"] == house.id:
                r["override"] = "no"
        with open(review, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=rows[0].keys())
            w.writeheader()
            w.writerows(rows)
        cls = detect(self.store, CONFIG, review)
        self.assertNotEqual(cls.people[self.store.person_key(norm_handle(fixture.LATE_JOINER))].role, "tenant")

    def test_pools_are_unique_and_collisions_redone(self):
        from ios_messages.anonymize import Mapping
        path = os.path.join(self.tmp, "m6.json")
        m = Mapping(path, set())
        self.assertFalse(set(m.first_pool) & set(m.token_pool) or set(m.last_pool) & set(m.token_pool)
                         or set(m.first_pool) & set(m.last_pool))
        self.assertFalse({x.lower() for x in m.street_pool} & {x.lower() for x in m.first_pool + m.last_pool})
        near = Mapping(os.path.join(self.tmp, "m9.json"), set(), ["Zarek"])
        self.assertFalse(any(osa(collapse(n.lower()), "zarek") <= 1 for n in near.first_pool))  # no fake looks like you
        firsts = [m.person(f"x{i}")["first"] for i in range(1500)]
        self.assertEqual(len(set(firsts)), 1500)
        toks = {m.token(f"w{i}") for i in range(200)}
        self.assertFalse(toks & set(firsts))
        m.data["persons"]["x0"]["first"] = "Thaddeus"
        m.save()
        again = Mapping(path, {"thaddeus"})  # a contact called Thaddeus appeared since
        self.assertNotEqual(again.data["persons"]["x0"]["first"], "Thaddeus")

    def test_scrub_stages(self):
        from ios_messages.anonymize import Mapping
        m = Mapping(os.path.join(self.tmp, "m2.json"), set())
        s = Scrubber(self.store, self.cls, m, CONFIG)
        out = s.scrub("lockbox 0912, PIN: 818 590 649#, card 4111 1111 1111 1111, @ilvane_k, "
                      "routing 021000021, acct\n 99887766, see bit.ly/abc and coolplumbers.com/jane-doe", {"c1"})
        for real in ["0912", "818 590", "4111", "@ilvane_k", "021000021", "99887766", "coolplumbers", "jane-doe"]:
            self.assertNotIn(real, out)
        self.assertIn("[link: bit.ly]", unmark(out))
        self.assertIn("opens at 10am", unmark(s.scrub("the garage opens at 10am")))
        self.assertIn("WiFi Password: [redacted]", unmark(s.scrub("WiFi Password: Xy12ab")))
        self.assertEqual(s.scrub("That would work. Who is coming?"), "That would work. Who is coming?")
        s.learn_corpus(["Mail it to Springfield, IL 62704 please"] * 6 + ["the landlord said so"] * 6)
        self.assertNotIn("62705", s.scrub("rooms open in 62705 and 62799"))
        self.assertIn("price is 45000", s.scrub("price is 45000"))  # not a ZIP prefix seen in the data
        s._orgs.add("Landlord")
        s.learn_corpus(["Mail it to Springfield, IL 62704 please"] * 6 + ["the landlord said so"] * 6)
        self.assertIn("landlord", s.scrub("ask the landlord"))  # an organisation that is an ordinary word
        self.assertNotIn("Junper", unmark(s.scrub("see you at Junper tonight")))  # misspelt house street
        self.assertNotIn("Zareck", unmark(s.scrub("thanks Zareck")))  # misspelt owner name
        self.assertIn("wifi is down", s.scrub("wifi is down"))
        self.assertEqual(s.scrub("Hello everyone"), "Hello everyone")
        named = Scrubber(self.store, self.cls, m, dict(CONFIG, extra_names=["Will"]))
        self.assertEqual(named.scrub("I will call you"), "I will call you")
        self.assertEqual(named.scrub("Will do."), "Will do.")
        self.assertNotIn("Will", unmark(named.scrub("His name is Will.")))


if __name__ == "__main__":
    unittest.main()
