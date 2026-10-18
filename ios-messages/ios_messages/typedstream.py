"""Pull the plain text out of message.attributedBody.

Since iOS 16 many messages leave message.text NULL and store the body only as an
NSAttributedString in Apple's typedstream format. A full typedstream parser is
overkill: the string is the first NSString object, encoded as '+' followed by a
length (1 byte, or 0x81/0x82 + 2/4 little-endian bytes) and UTF-8 bytes.
"""
from __future__ import annotations


def decode_attributed_body(blob: bytes | None) -> str | None:
    if not blob:
        return None
    i = blob.find(b"NSString")
    if i < 0:
        return None
    j = blob.find(b"\x2b", i + 8)
    if j < 0 or j + 1 >= len(blob):
        return None
    j += 1
    n = blob[j]
    j += 1
    width = {0x81: 2, 0x82: 4}.get(n)
    if width:
        n = int.from_bytes(blob[j:j + width], "little")
        j += width
    return blob[j:j + n].decode("utf-8", "replace")


def encode_attributed_body(text: str) -> bytes:
    """Inverse used by the tests to build realistic fixtures."""
    data = text.encode("utf-8")
    n = len(data)
    if n < 0x80:
        length = bytes([n])
    elif n < 0x10000:
        length = b"\x81" + n.to_bytes(2, "little")
    else:
        length = b"\x82" + n.to_bytes(4, "little")
    return (b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00"
            b"\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+"
            + length + data + b"\x86\x84\x02iI\x01")
