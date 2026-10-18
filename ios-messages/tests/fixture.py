"""Build a tiny synthetic sms.db + AddressBook.sqlitedb with the columns the tool reads.

Every name, number and address here is invented."""
import os
import sqlite3
from datetime import datetime, timezone

from ios_messages.typedstream import encode_attributed_body

EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)

CONTACTS = [
    # id, First, Last, Org, phones
    (1, "Ilvane", "12 Juniper Rd Tenant", None, ["+1 (555) 201-0001"]),
    (2, "Oskar", "12 Juniper Rd", None, ["5552010002"]),          # address only
    (3, "Roomies | Delphine", None, None, ["5552010003"]),          # role only
    (4, "Bram", "Plumber 12 Juniper Rd", None, ["5552010004"]),     # vendor
    (5, "Aunt", "Gertrude", None, ["5552010005"]),                  # family, not a renter
    (6, "Northwind Holdings", None, None, ["5552010006"]),          # business line
    (7, "Ines", "40 Quarry Ln", None, ["5552010007"]),
    (8, "Pavel", "77 Orchard Way", None, ["5552010008"]),
    (9, "Lotte", "9 Bramble Ct", None, ["5552010009"]),
    (10, "Hal", "12 Juniper Rd Landlord", None, ["5552010010"]),    # master landlord
    (11, "Dana", None, None, ["5552010011"]),                       # co-host who also rents a room
    (12, "Dana", "HVAC", None, ["5552010012"]),                     # same first name, a contractor
    (13, "Rex", "Acme Robotics", None, ["5552010013"]),             # day-job colleague
    (14, "Vesna", "12 Juniper Rd", None, ["5552010014"]),          # writes her name in Cyrillic
    (15, "Wes", None, None, ["5552010015"]),                        # untagged, day-job chat
    (16, "Torvin", "Quist", None, ["5552010016"]),                   # mentioned by others
    (17, None, None, "Larkfield Plumbing Supply", ["5552010017"]),  # organisation-only contact
    (18, "Mercy", "Vale", None, ["5552010018"]),                # a name that is also a word
    (19, "Mark", "12 Juniper Rd", None, ["5552010019"]),            # word-name, in the house group
]
LATE_JOINER = "+15552014444"  # posted in the house group, no longer a member
UNKNOWN_LANDLORD = "+15552017777"
UNKNOWN_CONTRACTOR = "+15552016666"
UNKNOWN_MECHANIC = "+15552015555"
MARKETING = "+15552013333"
UNKNOWN_PROSPECT = "+15552019999"
UNKNOWN_GROUP_MEMBER = "+15552018888"


def ts(day: int, minute: int = 0) -> int:
    dt = datetime(2024, 3, day, 12, minute, tzinfo=timezone.utc)
    return int((dt - EPOCH).total_seconds() * 1e9)


def build(dir_: str) -> None:
    os.makedirs(dir_, exist_ok=True)
    ab = sqlite3.connect(os.path.join(dir_, "AddressBook.sqlitedb"))
    ab.executescript("""
        create table ABPerson (ROWID integer primary key, First text, Last text, Organization text, Note text);
        create table ABMultiValue (record_id integer, property integer, value text);""")
    for cid, first, last, org, phones in CONTACTS:
        ab.execute("insert into ABPerson values (?,?,?,?,?)", (cid, first, last, org, None))
        for p in phones:
            ab.execute("insert into ABMultiValue values (?,3,?)", (cid, p))
    ab.commit()
    ab.close()

    db = sqlite3.connect(os.path.join(dir_, "sms.db"))
    db.executescript("""
        create table handle (ROWID integer primary key, id text);
        create table chat (ROWID integer primary key, chat_identifier text, display_name text, style integer);
        create table chat_handle_join (chat_id integer, handle_id integer);
        create table message (ROWID integer primary key, text text, attributedBody blob, date integer,
            is_from_me integer, service text, handle_id integer, associated_message_type integer default 0,
            item_type integer default 0, group_action_type integer default 0, other_handle integer default 0,
            group_title text, date_edited integer default 0, date_retracted integer default 0);
        create table chat_message_join (chat_id integer, message_id integer);
        create table attachment (ROWID integer primary key, transfer_name text, filename text, mime_type text);
        create table message_attachment_join (message_id integer, attachment_id integer);""")
    handles = {}

    def handle(raw):
        if raw not in handles:
            handles[raw] = len(handles) + 1
            db.execute("insert into handle values (?,?)", (handles[raw], raw))
        return handles[raw]

    chats = {}

    def chat(key, members, name=None):
        cid = len(chats) + 1
        chats[key] = cid
        db.execute("insert into chat values (?,?,?,?)",
                   (cid, members[0] if len(members) == 1 else f"chat{cid}", name, 43 if len(members) > 1 else 45))
        for m in members:
            db.execute("insert into chat_handle_join values (?,?)", (cid, handle(m)))
        return cid

    mid = [0]

    def msg(chat_key, sender, text, day, minute=0, attributed=False, **kw):
        mid[0] += 1
        db.execute("""insert into message (ROWID, text, attributedBody, date, is_from_me, service, handle_id,
                      item_type, group_action_type, other_handle, group_title, associated_message_type)
                      values (?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (mid[0], None if attributed else text, encode_attributed_body(text) if attributed else None,
                    ts(day, minute) if day else 0, 1 if sender is None else 0, "iMessage",
                    0 if sender in (None, "") else handle(sender),
                    kw.get("item_type", 0), kw.get("group_action_type", 0),
                    handle(kw["other"]) if kw.get("other") else 0, kw.get("group_title"), kw.get("assoc", 0)))
        db.execute("insert into chat_message_join values (?,?)", (chats[chat_key], mid[0]))

    chat("ilvane", ["+15552010001"])
    msg("ilvane", "+15552010001", "Hi, rent for March sent. Gate code is 4471 right?", 1)
    msg("ilvane", None, "Thanks Ilvane! Yes. Oskar moves in Friday at 12 Juniper Rd.", 1, 5)
    msg("ilvane", "+15552010001", "My SSN for the application is 123-45-6789, email ilvane.k@mail.test", 2,
        attributed=True)
    msg("ilvane", None, "Call me at (555) 201-0002 if Oskar is late. My wifi password: Bluebird77", 2, 3)

    chat("oskar", ["5552010002"])
    msg("oskar", "5552010002", "Hey Zarek, which room is mine? See https://maps.example.com/12-juniper", 3)
    msg("oskar", None, "The back bedroom. -Zarek Wolanski", 3, 1)

    chat("delphine", ["5552010003"])
    msg("delphine", "5552010003", "Can I pay the deposit by zelle?", 4)

    chat("bram", ["5552010004"])
    msg("bram", "5552010004", "Leak fixed at Juniper, invoice attached.", 5)

    chat("gert", ["5552010005"])
    msg("gert", "5552010005", "Happy birthday dear! Call your mother.", 6)

    chat("prospect", [UNKNOWN_PROSPECT])
    msg("prospect", UNKNOWN_PROSPECT, "Hi, I saw your craigslist ad - is the room still available? "
                                      "What is the rent per month and the deposit?", 7)
    msg("prospect", None, "Yes! $900 a month, utilities included. Want to schedule a showing?", 7, 2)
    msg("prospect", UNKNOWN_PROSPECT, "Yes please, can I move in on the 1st?", 7, 4)

    chat("house", ["+15552010001", "5552010002", UNKNOWN_GROUP_MEMBER, "5552010006"], "12 Juniper Rd")
    msg("house", None, "Welcome everyone to the 12 Juniper Rd group!", 8)
    msg("house", UNKNOWN_GROUP_MEMBER, "Thanks! Ilvane, is the trash day Tuesday?", 8, 1)
    msg("house", "+15552010001", "Yes, Tuesday. Bins by the curb.", 8, 2)
    msg("house", None, "", 8, 3, item_type=1, group_action_type=0, other="5552010002")

    # the business line sits in house groups for four houses -> partner, not tenant
    for i, (tenant, house) in enumerate([("5552010007", "40 Quarry Ln"), ("5552010008", "77 Orchard Way"),
                                         ("5552010009", "9 Bramble Ct")]):
        chat(f"h{i}", [tenant, "5552010006"], house)
        msg(f"h{i}", tenant, "Rent sent for this month.", 9 + i)

    chat("hal", ["5552010010"])
    msg("hal", "5552010010", "Your lease renewal for Juniper is attached; rent goes up in June.", 12)
    chat("ll", [UNKNOWN_LANDLORD])
    msg("ll", UNKNOWN_LANDLORD, "Reminder from the leasing office: your rent is due on the 1st and your "
                                "lease renewal is ready in the tenant portal.", 13)
    msg("ll", UNKNOWN_LANDLORD, "We'll send a technician for the maintenance request at your unit.", 13, 1)
    msg("ll", None, "Thanks, Tuesday works.", 13, 2)
    chat("blast", ["+15552013333"])  # marketing nobody answered
    msg("blast", "+15552013333", "Spring special! Free estimate on roof repair and gutter install for your house. "
                                 "Our technician is on the way to your area, invoice-free quote.", 24)
    chat("fix", [UNKNOWN_CONTRACTOR])
    msg("fix", UNKNOWN_CONTRACTOR, "Here is the estimate to replace the water heater at the house: $1,400 "
                                   "parts and labor. Technician on the way Tuesday.", 14)
    msg("fix", None, "Approved, the garage door code is 2580.", 14, 1)
    chat("car", [UNKNOWN_MECHANIC])
    msg("car", UNKNOWN_MECHANIC, "Estimate for your car: brakes and tires, $600 parts and labor. "
                                 "We can install Tuesday.", 15)
    chat("dana", ["5552010011"])
    msg("dana", "5552010011", "Paid my rent for the back room. Also, I showed the room to two people.", 16)
    chat("danahvac", ["5552010012"])
    msg("danahvac", "5552010012", "Furnace repair estimate for the house attached.", 16, 1)
    chat("rex", ["5552010013"])
    msg("rex", "5552010013", "Can you install the new truss software and send the invoice estimate?", 17)
    # Dana co-hosts: she's in the house group alongside the tenants
    chat("house2", ["+15552010001", "5552010011", UNKNOWN_GROUP_MEMBER, "5552010019"], "12 Juniper Rd")
    msg("house2", "5552010011", "Cleaning rota for the house is on the fridge.", 18)
    msg("house2", "5552010011", "Bathroom: Mark\nKitchen: Ilvane\nMark, did you take the bins out? "
                                "Mercy moved out, his Venmo is cvale-88.", 18, 1)
    msg("house2", "5552010019", "Done. Wi-Fi name: qeRTWv and the router is in the hall.", 18, 2)
    chat("vesna", ["5552010014"])
    msg("vesna", "5552010014", "Привет, это Весна. Rent is sent for my room.", 19)
    msg("vesna", None, "Thanks Весна! Ask Torvin about the keys; Torvin Quist has the spare set.", 19, 1)
    msg("vesna", None, "A message whose timestamp got lost.", None)
    chat("wes", ["5552010015"])
    for i, t in enumerate(["Pushed the fix to github, can you deploy it?", "The docker image needs the api key",
                           "Install the robotics firmware and send me the estimate for the repo work",
                           "Standup moved; review my pull request before you install it on the house demo"]):
        msg("wes", "5552010015", t, 20, i)
    chat("supply", ["5552010017"])
    msg("supply", "5552010017", "Larkfield Plumbing Supply: your water heater order is ready, estimate attached.", 21)
    msg("house", LATE_JOINER, "Moving out Friday, keys on the counter. Account number\n 123456789 for the deposit.",
        22)
    msg("house", "", "", 22, 1, item_type=2, group_title="Juniper crew")
    msg("ilvane", None, "Bank: routing 021000021. Plate ABC1234. Old cell 555-1234. Mail to 9 Oak St Springfield "
                       "62704. See larkfieldsupply.com/order/88 and zillow.com/x. The garage opens at 10am.", 23)
    db.commit()
    db.close()
