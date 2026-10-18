"""Load a decrypted sms.db + AddressBook.sqlitedb into plain Python objects.

Everything downstream (text export, renter detection, anonymization) works on
these objects, never on SQL, so the tests can build a tiny synthetic database
and exercise the whole pipeline.
"""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .typedstream import decode_attributed_body

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
GROUP_STYLE = 43  # chat.style for group conversations
SHORT_CODE = re.compile(r"\d{3,6}")  # businesses texting from 3-6 digit numbers


def fmt(dt: datetime | None, pattern: str = "%Y-%m-%d") -> str:
    """strftime that tolerates a missing timestamp."""
    return dt.strftime(pattern) if dt else ""


def apple_time(v: int | None) -> datetime | None:
    if not v:
        return None
    if v > 1e11:  # nanoseconds since iOS 11
        v = v / 1e9
    return (APPLE_EPOCH + timedelta(seconds=v)).astimezone()


def norm_handle(h: str | None) -> str:
    """Canonical form of a phone/email so +1 (650) 555-0100 and 6505550100 meet."""
    if not h:
        return ""
    h = h.strip().strip("‪‬").lower()
    if "@" in h:
        return h
    d = re.sub(r"\D", "", h)
    return d[-10:] if len(d) >= 10 else (d or h)


@dataclass
class Contact:
    id: int
    first: str = ""
    last: str = ""
    org: str = ""
    note: str = ""
    handles: set[str] = field(default_factory=set)

    @property
    def display(self) -> str:
        name = " ".join(x for x in (self.first, self.last) if x).strip()
        return re.sub(r"\s+", " ", name or self.org or "").strip()

    @property
    def tag_text(self) -> str:
        """Every free-text field a user might have stuffed an address or role into."""
        return " | ".join(x for x in (self.first, self.last, self.org, self.note) if x)


@dataclass
class Message:
    id: int
    chat_id: int
    dt: datetime | None
    from_me: bool
    sender: str  # normalized handle; "" when from_me
    text: str
    attachments: list[tuple[str, str]]  # (filename, mime)
    service: str = ""
    edited: bool = False
    retracted: bool = False
    item_type: int = 0
    group_action_type: int = 0
    other: str = ""  # target handle of add/remove events
    group_title: str | None = None
    assoc_type: int = 0

    @property
    def is_event(self) -> bool:
        return self.item_type != 0


@dataclass
class Conversation:
    key: tuple  # ("P", frozenset of one handle) or ("G", chat_identifier)
    is_group: bool
    members: set[str]  # normalized handles, excluding me: current members, past senders, add/remove targets
    chat_ids: list[int] = field(default_factory=list)
    names: list[str] = field(default_factory=list)  # chat display names seen
    messages: list[Message] = field(default_factory=list)

    @property
    def id(self) -> str:
        part = self.key[1] if isinstance(self.key[1], str) else ",".join(sorted(self.key[1]))
        raw = self.key[0] + "|" + part
        return ("g" if self.is_group else "p") + hashlib.sha1(raw.encode()).hexdigest()[:10]

    @property
    def name(self) -> str:
        return self.names[-1] if self.names else ""

    @property
    def first(self) -> datetime | None:
        return next((m.dt for m in self.messages if m.dt), None)

    @property
    def last(self) -> datetime | None:
        return next((m.dt for m in reversed(self.messages) if m.dt), None)


@dataclass
class Store:
    contacts: dict[int, Contact]
    contact_of: dict[str, int]  # normalized handle -> contact id
    raw_handle: dict[str, str]  # normalized handle -> as stored in sms.db
    conversations: list[Conversation]

    def contact(self, handle: str) -> Contact | None:
        cid = self.contact_of.get(handle)
        return self.contacts.get(cid) if cid is not None else None

    def label(self, handle: str) -> str:
        c = self.contact(handle)
        return (c.display if c and c.display else None) or self.raw_handle.get(handle, handle) or "Unknown"

    def person_key(self, handle: str) -> str:
        """One key per human: a contact with three numbers is one person."""
        cid = self.contact_of.get(handle)
        return f"c{cid}" if cid is not None else f"h{handle}"


def load_contacts(path: str) -> tuple[dict[int, Contact], dict[str, int]]:
    contacts: dict[int, Contact] = {}
    contact_of: dict[str, int] = {}
    if not os.path.exists(path):
        return contacts, contact_of
    db = sqlite3.connect(path)
    for rid, first, last, org, note in db.execute(
            "select ROWID, First, Last, Organization, Note from ABPerson"):
        contacts[rid] = Contact(rid, (first or "").strip(), (last or "").strip(),
                                (org or "").strip(), (note or "").strip())
    for rid, value in db.execute(
            "select record_id, value from ABMultiValue where property in (3, 4) and value is not null"):
        if rid in contacts:
            h = norm_handle(value)
            contacts[rid].handles.add(h)
            contact_of.setdefault(h, rid)
    db.close()
    return contacts, contact_of


def load(db_dir: str) -> Store:
    contacts, contact_of = load_contacts(os.path.join(db_dir, "AddressBook.sqlitedb"))
    db = sqlite3.connect(os.path.join(db_dir, "sms.db"))
    db.row_factory = sqlite3.Row
    cols = {r[1] for r in db.execute("pragma table_info(message)")}

    def col(name: str, default: str = "null") -> str:
        return f"m.{name}" if name in cols else f"{default} as {name}"

    handle_by_rowid: dict[int, str] = {}
    raw_handle: dict[str, str] = {}
    for r in db.execute("select ROWID, id from handle"):
        n = norm_handle(r["id"])
        handle_by_rowid[r["ROWID"]] = n
        raw_handle.setdefault(n, r["id"])

    members: dict[int, set[str]] = defaultdict(set)
    for r in db.execute("select chat_id, handle_id from chat_handle_join"):
        if r["handle_id"] in handle_by_rowid:
            members[r["chat_id"]].add(handle_by_rowid[r["handle_id"]])

    attachments: dict[int, list[tuple[str, str]]] = defaultdict(list)
    for r in db.execute("""select maj.message_id, a.transfer_name, a.filename, a.mime_type
                           from message_attachment_join maj
                           join attachment a on a.ROWID = maj.attachment_id"""):
        name = r["transfer_name"] or os.path.basename(r["filename"] or "") or "file"
        attachments[r["message_id"]].append((name, r["mime_type"] or ""))

    # One-to-one threads key by the other person, so the SMS, iMessage and RCS
    # threads with them merge. Groups key by their chat identifier: the member
    # table only lists who is in the group *now*, so a member-set key would
    # change (and lose review overrides) every time someone leaves.
    convs: dict[tuple, Conversation] = {}
    conv_of_chat: dict[int, Conversation] = {}
    for r in db.execute("select ROWID, chat_identifier, display_name, style from chat order by ROWID"):
        mem = members.get(r["ROWID"]) or {norm_handle(r["chat_identifier"])}
        is_group = r["style"] == GROUP_STYLE or len(mem) > 1
        key = ("G", r["chat_identifier"] or f"chat{r['ROWID']}") if is_group else ("P", frozenset(mem))
        conv = convs.get(key)
        if conv is None:
            conv = convs[key] = Conversation(key, is_group, set(mem))
        conv.chat_ids.append(r["ROWID"])
        if r["display_name"] and r["display_name"].strip():
            conv.names.append(r["display_name"].strip())
        conv_of_chat[r["ROWID"]] = conv

    q = f"""
        select m.ROWID, m.text, m.attributedBody, m.date, m.is_from_me, m.service, m.handle_id,
               {col('associated_message_type', '0')}, {col('item_type', '0')},
               {col('group_action_type', '0')}, {col('other_handle', '0')}, {col('group_title')},
               {col('date_edited', '0')}, {col('date_retracted', '0')}, cmj.chat_id
        from message m join chat_message_join cmj on cmj.message_id = m.ROWID
        order by m.date, m.ROWID"""
    for r in db.execute(q):
        conv = conv_of_chat.get(r["chat_id"])
        if conv is None:
            continue
        text = r["text"] or decode_attributed_body(r["attributedBody"]) or ""
        text = text.replace("￼", "").strip()
        conv.messages.append(Message(
            id=r["ROWID"], chat_id=r["chat_id"], dt=apple_time(r["date"]),
            from_me=bool(r["is_from_me"]),
            sender="" if r["is_from_me"] else handle_by_rowid.get(r["handle_id"], ""),
            text=text, attachments=attachments.get(r["ROWID"], []), service=r["service"] or "",
            edited=bool(r["date_edited"]), retracted=bool(r["date_retracted"]),
            item_type=r["item_type"] or 0, group_action_type=r["group_action_type"] or 0,
            other=handle_by_rowid.get(r["other_handle"] or 0, ""), group_title=r["group_title"],
            assoc_type=r["associated_message_type"] or 0))
    db.close()

    out = [c for c in convs.values() if c.messages]
    for c in out:
        c.messages.sort(key=lambda m: (m.dt or APPLE_EPOCH, m.id))
        if c.is_group:  # people who posted or were added/removed belong to the group too
            c.members |= {m.sender for m in c.messages if m.sender} | {m.other for m in c.messages if m.other}
    out.sort(key=lambda c: c.last or APPLE_EPOCH, reverse=True)
    return Store(contacts, contact_of, raw_handle, out)


def renderable(m: Message) -> bool:
    """Drop tapback removals and content-free system rows."""
    if 3000 <= m.assoc_type < 4000:
        return False
    if m.item_type == 0:
        return bool(m.text or m.attachments or m.retracted)
    if m.item_type == 1:
        return m.group_action_type in (0, 1)
    if m.item_type == 2:
        return m.group_title is not None
    if m.item_type == 3:
        return m.group_action_type == 0
    return False


def event_text(m: Message, who: str, other: str) -> str:
    """Human wording for group membership / rename events."""
    if m.item_type == 1:
        return f"[{who} added {other}]" if m.group_action_type == 0 else f"[{who} removed {other}]"
    if m.item_type == 2:
        return f'[{who} renamed the group to "{m.group_title}"]'
    if m.item_type == 3:
        return f"[{who} left the group]"
    return ""
