"""Plain-text export of every conversation, one file each, plus an index."""
from __future__ import annotations

import csv
import os
import re
from datetime import datetime

from .store import APPLE_EPOCH, SHORT_CODE, Conversation, Store, event_text, fmt, renderable

# Windows refuses these as file names whatever the extension.
RESERVED = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}


def safe_filename(name: str, maxlen: int = 120) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f‪‬]', "_", name).strip(" .")
    name = name[:maxlen].rstrip(" .") or "Unknown"
    return name + "_" if name.split(".")[0].lower() in RESERVED else name


def unique_path(folder: str, base: str, used: set) -> str:
    name, n = base, 2
    while (folder, name.lower()) in used:
        name = f"{base} ({n})"
        n += 1
    used.add((folder, name.lower()))
    return os.path.join(folder, name + ".txt")


def render_lines(conv: Conversation, who_of, text_of=lambda s: s, attachment_of=None) -> list[str]:
    """Day-grouped transcript lines. `who_of(handle)` names a sender;
    `text_of` post-processes bodies (the anonymizer plugs in here)."""
    attachment_of = attachment_of or (lambda name, mime: name)

    def who(handle: str) -> str:
        return who_of(handle) if handle else "Someone"  # system rows with no sender handle

    lines, day = [], None
    for m in conv.messages:
        if not renderable(m):
            continue
        sender = "Me" if m.from_me else who(m.sender)
        if m.item_type == 2:
            body = f'[{sender} renamed the group to "{text_of(m.group_title or "")}"]'
        elif m.is_event:
            body = event_text(m, sender, who(m.other).replace("Someone", "someone"))
        elif m.retracted:
            body = "[unsent a message]"
        else:
            body = text_of(m.text)
            if m.attachments:
                att = " ".join(f"[Attachment: {attachment_of(n, t)}]" for n, t in m.attachments)
                body = f"{body} {att}" if body else att
            if 2000 <= m.assoc_type < 3000 and len(body) > 100:
                body = body[:90].rstrip() + "…”"  # a tapback quotes the whole message it reacts to
            if m.edited:
                body += " (edited)"
        if m.dt and m.dt.date() != day:
            day = m.dt.date()
            lines.append(f"\n--- {m.dt:%A, %B %d, %Y} ---")
        stamp = fmt(m.dt, "%I:%M %p") or "--:--"
        body = body.replace("\n", "\n    ")
        lines.append(f"[{stamp}] {body}" if m.is_event else f"[{stamp}] {sender}: {body}")
    return lines


def export_all(store: Store, out_dir: str) -> dict:
    folders = {k: os.path.join(out_dir, v) for k, v in {
        "person": "Conversations", "group": "Group Chats",
        "short": "Businesses & Short Codes", "unknown": "Unknown Numbers"}.items()}
    used: set = set()
    index = []
    for conv in store.conversations:
        people = sorted(store.label(h) for h in conv.members)
        if conv.is_group:
            title = conv.name or ", ".join(people[:5]) + (f" +{len(people) - 5}" if len(people) > 5 else "")
            kind = "group"
        else:
            title = people[0] if people else "Unknown"
            handle = next(iter(conv.members), "")
            kind = ("short" if SHORT_CODE.fullmatch(handle) else
                    "unknown" if store.contact(handle) is None else "person")
        lines = render_lines(conv, store.label)
        if not any(l.startswith("[") for l in lines):
            continue
        os.makedirs(folders[kind], exist_ok=True)
        path = unique_path(folders[kind], safe_filename(title), used)
        count = sum(1 for l in lines if l.startswith("["))
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"{title}\n")
            if conv.is_group:
                f.write(f"Participants: Me, {', '.join(people)}\n")
            else:
                f.write(f"Handles: {', '.join(sorted(store.raw_handle.get(h, h) for h in conv.members))}\n")
            f.write(f"Messages: {count}  |  {fmt(conv.first)} to {fmt(conv.last)}\n")
            f.write("=" * 70 + "\n")
            f.write("\n".join(lines) + "\n")
        index.append((conv.last, conv.first, count, kind, title, os.path.relpath(path, out_dir)))

    index.sort(key=lambda r: r[0] or APPLE_EPOCH, reverse=True)
    with open(os.path.join(out_dir, "INDEX.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Last message", "First message", "Messages", "Type", "Conversation", "File"])
        for last, first, n, kind, title, rel in index:
            w.writerow([fmt(last, "%Y-%m-%d %H:%M"), fmt(first), n, kind, title, rel])
    total = sum(r[2] for r in index)
    with open(os.path.join(out_dir, "INDEX.txt"), "w", encoding="utf-8") as f:
        f.write(f"Text message export - {datetime.now():%Y-%m-%d %H:%M}\n")
        f.write(f"{len(index)} conversations, {total} messages, newest activity first\n\n")
        for last, first, n, kind, title, rel in index:
            f.write(f"{fmt(last) or '----------'}  {n:>6}  {kind:<7}  {title}\n")
    return {"conversations": len(index), "messages": total}
