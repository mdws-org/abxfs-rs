#!/opt/homebrew/bin/python3
"""Offline verifier for ABX archive bundles, format 1. Python 3.12."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import BinaryIO, Iterable, Iterator


MAX_JSON_INTEGER = (1 << 53) - 1
MAX_CONTENT = 1 << 30
MAX_ENTRIES = 65_536
MAX_DEPTH = 64
MAX_RAW_BLOCK = 1_048_576
MAX_INDEX_BLOCK = 16_777_216
UINT256_MOD = 1 << 256
ZERO32 = bytes(32)

RAW_PREFIX = bytes.fromhex("01551220")
JSON_PREFIX = bytes.fromhex("01a9021220")
HEADER_PREFIX = bytes.fromhex("a265726f6f747381d82a582600")
HEADER_SUFFIX = b"\x67version\x01"

HEX_RE = re.compile(r"0x(?:[0-9a-f]{2})*\Z")
DECIMAL_RE = re.compile(r"[0-9]+\Z")
CID_RE = re.compile(r"b[a-z2-7]+\Z")

COLLECTION_CODE_HASH = bytes.fromhex(
    "52fca2e6744bf60088e9313fac37cda721b968eb7e77c243975ab36b49b0d34c"
)
PORTAL = bytes.fromhex("49048044d57e1c92a77f79988d21fa8faf74e97e")
PORTAL_IMPL = bytes.fromhex("03863ab7f64b733cff85c8ff44a86601c568ca70")
REGISTRY = bytes.fromhex("909f6cf47ed12f010a796527f562bfc26c7f4e72")
REGISTRY_IMPL = bytes.fromhex("4483f964f6711cb55f633820ed174e780369b99d")
FACTORY = bytes.fromhex("43edb88c4b80fdd2adff2412a7bebf9df42cb40e")
FACTORY_IMPL = bytes.fromhex("94eab8f73fd83407d26c006d159923760d483029")
GAME_IMPL = bytes.fromhex("c08b8ffaf04abb1d7013b74a0e57eccbd7fa5a70")
MESSAGE_PASSER = bytes.fromhex("4200000000000000000000000000000000000016")
IMPL_SLOT = bytes.fromhex(
    "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
)
ROLLUP = bytes.fromhex("4dceb440657f21083db8add07665f8ddbe1dcfc0")
ROLLUP_IMPL = bytes.fromhex("7fc126ff51183a78c5e0437467f325f661d8df17")
SECONDARY_SLOT = bytes.fromhex(
    "2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d"
)
SECONDARY_IMPL = bytes.fromhex("6490ba0a60cc7d3a59c9eee135d9eed24553a60d")
BACKEND = bytes.fromhex("91520cdaaab44267e99d08fea7730d7a7c60e9c2")

GAME_HEAD = (
    bytes.fromhex(
        "36602c57343d527f"
        "9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff"
        "593da1005b363d3d373d3d3d3d61030a806062363936013d73"
    )
    + GAME_IMPL
    + bytes.fromhex("5af43d3d93803e606057fd5bf3")
)


class Rejection(Exception):
    def __init__(self, category: str, message: str):
        super().__init__(message)
        self.category = category
        self.message = message


def require(condition: bool, category: str, message: str) -> None:
    if not condition:
        raise Rejection(category, message)


def hx(value: bytes) -> str:
    return "0x" + value.hex()


def word(value: int) -> bytes:
    return value.to_bytes(32, "big")


# Keccak-f[1600], with lanes indexed by x + 5*y.

MASK64 = (1 << 64) - 1
ROTATIONS = (
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
)
ROUND_CONSTANTS = (
    0x0000000000000001,
    0x0000000000008082,
    0x800000000000808A,
    0x8000000080008000,
    0x000000000000808B,
    0x0000000080000001,
    0x8000000080008081,
    0x8000000000008009,
    0x000000000000008A,
    0x0000000000000088,
    0x0000000080008009,
    0x000000008000000A,
    0x000000008000808B,
    0x800000000000008B,
    0x8000000000008089,
    0x8000000000008003,
    0x8000000000008002,
    0x8000000000000080,
    0x000000000000800A,
    0x800000008000000A,
    0x8000000080008081,
    0x8000000000008080,
    0x0000000080000001,
    0x8000000080008008,
)


def rotate64(value: int, count: int) -> int:
    return ((value << count) | (value >> (64 - count))) & MASK64


def keccak_f1600(state: list[int]) -> None:
    for constant in ROUND_CONSTANTS:
        columns = [
            state[x] ^ state[x + 5] ^ state[x + 10]
            ^ state[x + 15] ^ state[x + 20]
            for x in range(5)
        ]
        changes = [
            columns[(x - 1) % 5] ^ rotate64(columns[(x + 1) % 5], 1)
            for x in range(5)
        ]
        for index in range(25):
            state[index] ^= changes[index % 5]

        moved = [0] * 25
        for y in range(5):
            for x in range(5):
                index = x + 5 * y
                moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotate64(
                    state[index], ROTATIONS[index]
                )

        for y in range(5):
            row = 5 * y
            for x in range(5):
                state[row + x] = (
                    moved[row + x]
                    ^ (
                        (~moved[row + (x + 1) % 5])
                        & moved[row + (x + 2) % 5]
                    )
                )
        state[0] ^= constant


class Keccak256:
    RATE = 136

    def __init__(self) -> None:
        self.state = [0] * 25
        self.tail = bytearray()

    @staticmethod
    def absorb(state: list[int], block: bytes | bytearray | memoryview) -> None:
        for lane in range(17):
            start = 8 * lane
            state[lane] ^= int.from_bytes(block[start:start + 8], "little")
        keccak_f1600(state)

    def update(self, data: bytes) -> None:
        view = memoryview(data)
        position = 0
        if self.tail:
            take = min(self.RATE - len(self.tail), len(view))
            self.tail.extend(view[:take])
            position = take
            if len(self.tail) == self.RATE:
                self.absorb(self.state, self.tail)
                self.tail.clear()

        while position + self.RATE <= len(view):
            self.absorb(self.state, view[position:position + self.RATE])
            position += self.RATE

        self.tail.extend(view[position:])

    def digest(self) -> bytes:
        state = self.state.copy()
        final = bytearray(self.RATE)
        final[:len(self.tail)] = self.tail
        final[len(self.tail)] = 0x01
        final[-1] |= 0x80
        self.absorb(state, final)
        return b"".join(value.to_bytes(8, "little") for value in state[:4])


def keccak_parts(parts: Iterable[bytes]) -> bytes:
    digest = Keccak256()
    for part in parts:
        digest.update(part)
    return digest.digest()


def H(*parts: bytes) -> bytes:
    return keccak_parts(parts)


class Blob:
    """A byte string kept as segments to avoid expanding repeated links."""

    def __init__(self, parts: Iterable[bytes] = ()) -> None:
        self.parts = tuple(part for part in parts if part)
        self.length = sum(map(len, self.parts))
        self._keccak: bytes | None = None
        self._sha256: bytes | None = None

    def data(self) -> bytes:
        if len(self.parts) == 1:
            return self.parts[0]
        return b"".join(self.parts)

    def keccak(self) -> bytes:
        if self._keccak is None:
            self._keccak = keccak_parts(self.parts)
        return self._keccak

    def sha256(self) -> bytes:
        if self._sha256 is None:
            digest = hashlib.sha256()
            for part in self.parts:
                digest.update(part)
            self._sha256 = digest.digest()
        return self._sha256

    def write(self, target: BinaryIO) -> None:
        for part in self.parts:
            target.write(part)


def combine_content(blobs: Iterable[Blob]) -> Blob:
    parts: list[bytes] = []
    length = 0
    for blob in blobs:
        length += blob.length
        require(length <= MAX_CONTENT, "content", "content exceeds 1 GiB")
        parts.extend(blob.parts)
    return Blob(parts)


# Container and JSON.


def read_exact(source: BinaryIO, size: int) -> bytes:
    result = source.read(size)
    require(len(result) == size, "container", "truncated container")
    return result


def read_length(
    source: BinaryIO, maximum: int, allow_eof: bool = False
) -> int | None:
    first = source.read(1)
    if not first:
        require(allow_eof, "container", "missing block")
        return None

    value = 0
    groups = 0
    octet = first[0]
    max_groups = (maximum.bit_length() + 6) // 7

    while True:
        groups += 1
        require(groups <= max_groups, "container", "block length is too large")
        payload = octet & 0x7F
        value |= payload << (7 * (groups - 1))

        if not octet & 0x80:
            require(
                groups == 1 or payload != 0,
                "container", "nonminimal varint",
            )
            require(value <= maximum, "container", "block is too large")
            return value

        octet = read_exact(source, 1)[0]


def read_container(source: BinaryIO) -> tuple[bytes, dict[bytes, bytes]]:
    require(
        read_exact(source, 1) == b"\x3b",
        "container", "incorrect CAR header length",
    )
    header = read_exact(source, 59)
    require(
        header[:13] == HEADER_PREFIX and header[50:] == HEADER_SUFFIX,
        "container", "incorrect CAR header",
    )
    index_cid = header[13:50]
    require(
        index_cid.startswith(JSON_PREFIX),
        "container", "header root is not the required dag-json CID",
    )

    length = read_length(source, MAX_INDEX_BLOCK + 37)
    require(length is not None and length >= 37, "container", "short index block")
    block = read_exact(source, length)
    require(block[:37] == index_cid, "container", "first block is not the index")
    index_data = block[37:]
    require(
        hashlib.sha256(index_data).digest() == index_cid[5:],
        "container", "index CID digest mismatch",
    )

    raw: dict[bytes, bytes] = {}
    while True:
        length = read_length(source, MAX_RAW_BLOCK + 36, allow_eof=True)
        if length is None:
            break
        require(length >= 36, "container", "short raw block")
        block = read_exact(source, length)
        cid, data = block[:36], block[36:]
        require(
            cid.startswith(RAW_PREFIX),
            "container", "non-index block is not the required raw CID",
        )
        require(cid not in raw, "container", "duplicate raw CID")
        require(
            hashlib.sha256(data).digest() == cid[4:],
            "container", "raw CID digest mismatch",
        )
        raw[cid] = data

    return index_data, raw


def text_cid(text: object) -> bytes:
    require(
        isinstance(text, str) and CID_RE.fullmatch(text) is not None,
        "container", "invalid link CID text",
    )
    encoded = text[1:]
    padding = "=" * ((-len(encoded)) % 8)
    try:
        binary = base64.b32decode(encoded.upper() + padding)
    except (binascii.Error, ValueError):
        raise Rejection("container", "invalid link CID base32") from None

    canonical = "b" + base64.b32encode(binary).decode("ascii").lower().rstrip("=")
    require(text == canonical, "container", "noncanonical link CID")
    require(
        len(binary) == 36 and binary.startswith(RAW_PREFIX),
        "container", "link does not name a raw SHA-256 CID",
    )
    return binary


def invalid_json_constant(_: str) -> object:
    raise Rejection("index", "non-JSON numeric constant")


def parse_json(data: bytes) -> object:
    try:
        text = data.decode("utf-8")
        require(not text.startswith("\ufeff"), "index", "JSON has a BOM")
        return json.loads(
            text,
            parse_int=Decimal,
            parse_float=Decimal,
            parse_constant=invalid_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, InvalidOperation):
        raise Rejection("index", "invalid UTF-8 JSON") from None
    except RecursionError:
        raise Rejection("index", "JSON nesting cannot match the index schema") from None


def check_raw_walk(index: object, raw: dict[bytes, bytes]) -> None:
    reached: set[bytes] = set()
    order: list[bytes] = []
    stack = [index]

    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            if set(value) == {"/"}:
                cid = text_cid(value["/"])
                require(cid in raw, "container", "link names a missing raw block")
                if cid not in reached:
                    reached.add(cid)
                    order.append(cid)
            else:
                keys = sorted(
                    value,
                    key=lambda key: key.encode("utf-8", "surrogatepass"),
                    reverse=True,
                )
                stack.extend(value[key] for key in keys)
        elif isinstance(value, list):
            stack.extend(reversed(value))

    require(
        order == list(raw),
        "container", "raw blocks are missing, unreferenced, or out of order",
    )


def check_json_values(index: object) -> None:
    stack = [index]
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            stack.extend(value.keys())
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
        elif isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                raise Rejection("index", "JSON contains an unpaired surrogate") from None
        elif isinstance(value, Decimal):
            require(
                value.is_finite()
                and -MAX_JSON_INTEGER <= value <= MAX_JSON_INTEGER,
                "index", "JSON number exceeds the exact integer range",
            )
            require(
                value == value.to_integral_value(),
                "index", "index numbers must be integers",
            )


# Index schema. These functions validate every supplied field, including fields
# belonging to content that will later fail reachability checks.


def object_fields(
    value: object,
    required: Iterable[str],
    optional: Iterable[str] = (),
) -> dict:
    require(isinstance(value, dict), "index", "expected an object")
    required_set = set(required)
    allowed = required_set | set(optional)
    require(required_set <= set(value), "index", "missing object member")
    require(set(value) <= allowed, "index", "unknown object member")
    return value


def array(value: object) -> list:
    require(isinstance(value, list), "index", "expected an array")
    return value


def hex_bytes(value: object, size: int | None = None) -> bytes:
    require(
        isinstance(value, str) and HEX_RE.fullmatch(value) is not None,
        "index", "expected lowercase 0x-prefixed byte hex",
    )
    result = bytes.fromhex(value[2:])
    require(size is None or len(result) == size, "index", "incorrect hex byte length")
    return result


def uint(
    value: object,
    *,
    strings: bool = False,
    string_only: bool = False,
    maximum: int | None = None,
) -> int:
    if isinstance(value, Decimal) and not string_only:
        result = int(value)
    elif (
        isinstance(value, str)
        and (strings or string_only)
        and DECIMAL_RE.fullmatch(value) is not None
    ):
        result = int(value, 10)
    else:
        raise Rejection("index", "expected an unsigned integer")

    require(result >= 0, "index", "negative unsigned integer")
    require(
        maximum is None or result <= maximum,
        "index", "integer is out of range",
    )
    return result


def boolean(value: object) -> bool:
    require(type(value) is bool, "index", "expected a boolean")
    return value


def byte_string(value: object, raw: dict[bytes, bytes]) -> Blob:
    if isinstance(value, str):
        return Blob((hex_bytes(value),))
    links = array(value)
    parts = []
    for link in links:
        obj = object_fields(link, ("/",))
        cid = text_cid(obj["/"])
        require(cid in raw, "container", "link names a missing raw block")
        parts.append(raw[cid])
    return Blob(parts)


def proof_nodes(value: object) -> list[bytes]:
    return [hex_bytes(node) for node in array(value)]


def account_schema(value: object) -> dict:
    obj = object_fields(value, ("address", "proof", "storage"))
    storage = []
    for entry in array(obj["storage"]):
        item = object_fields(entry, ("slot", "proof"))
        storage.append({
            "slot": hex_bytes(item["slot"], 32),
            "proof": proof_nodes(item["proof"]),
        })
    return {
        "address": hex_bytes(obj["address"], 20),
        "proof": proof_nodes(obj["proof"]),
        "storage": storage,
    }


def accounts_schema(value: object) -> list[dict]:
    return [account_schema(item) for item in array(value)]


def layer_schema(value: object, with_codes: bool = False) -> dict:
    keys = ("header", "accounts", "codes") if with_codes else ("header", "accounts")
    obj = object_fields(value, keys)
    result = {
        "header": hex_bytes(obj["header"]),
        "accounts": accounts_schema(obj["accounts"]),
    }
    if with_codes:
        result["codes"] = [hex_bytes(code) for code in array(obj["codes"])]
    return result


def agreed_endpoints(value: object) -> list[str]:
    endpoints = array(value)
    require(len(endpoints) >= 2, "index", "agreed needs at least two endpoints")
    for host in endpoints:
        require(
            isinstance(host, str) and bool(host),
            "index", "endpoint host must be a nonempty string",
        )
        require(
            host.isprintable()
            and not any(character.isspace() for character in host)
            and "," not in host,
            "index", "endpoint host cannot be listed unambiguously",
        )
    require(
        len(set(endpoints)) >= 2,
        "index", "agreed needs at least two distinct endpoint names",
    )
    return endpoints


def proof_schema(value: object) -> dict:
    require(isinstance(value, dict), "index", "proof must be an object")
    kind = value.get("kind")
    require(
        kind in ("ethereum", "base", "arbitrum", "agreed", "logged"),
        "index", "unknown proof kind",
    )

    if kind == "ethereum":
        obj = object_fields(value, ("kind", "header", "accounts"))
        return {
            "kind": kind,
            "header": hex_bytes(obj["header"]),
            "accounts": accounts_schema(obj["accounts"]),
        }

    if kind == "base":
        obj = object_fields(value, ("kind", "final", "l1", "game", "l2"))
        return {
            "kind": kind,
            "final": boolean(obj["final"]),
            "l1": layer_schema(obj["l1"], with_codes=True),
            "game": hex_bytes(obj["game"], 20),
            "l2": layer_schema(obj["l2"]),
        }

    if kind == "arbitrum":
        obj = object_fields(value, ("kind", "l1", "log", "l2"))
        log = object_fields(obj["log"], ("parent", "data"))
        return {
            "kind": kind,
            "l1": layer_schema(obj["l1"]),
            "log": {
                "parent": hex_bytes(log["parent"], 32),
                "data": hex_bytes(log["data"]),
            },
            "l2": layer_schema(obj["l2"]),
        }

    if kind == "agreed":
        obj = object_fields(value, ("kind", "block", "endpoints"))
        return {
            "kind": kind,
            "block": uint(obj["block"], strings=True),
            "endpoints": agreed_endpoints(obj["endpoints"]),
        }

    obj = object_fields(value, ("kind", "block", "tx"))
    return {
        "kind": kind,
        "block": uint(obj["block"], strings=True),
        "tx": hex_bytes(obj["tx"], 32),
    }


def directory_schema(value: object, store: str, raw: dict[bytes, bytes]) -> dict:
    if store != "bamfs1":
        obj = object_fields(value, ("cid", "root"))
        return {
            "cid": hex_bytes(obj["cid"], 32),
            "root": hex_bytes(obj["root"], 32),
        }

    obj = object_fields(value, ("cid", "entries"))
    entries = []
    for entry in array(obj["entries"]):
        item = object_fields(entry, ("name", "cid", "isDir"))
        entries.append({
            "name": byte_string(item["name"], raw),
            "cid": hex_bytes(item["cid"], 32),
            "isDir": boolean(item["isDir"]),
        })
    return {"cid": hex_bytes(obj["cid"], 32), "entries": entries}


def file_schema(value: object, store: str, raw: dict[bytes, bytes]) -> dict:
    required = {"cid", "mime", "outputHash"}
    if store == "abxfs":
        required.update(("root", "codec"))
    elif store == "bamfs2":
        required.update(("root", "compression", "size"))
    else:
        required.update(("chunks", "compression"))

    obj = object_fields(value, required, ("content",))
    result = {
        "cid": hex_bytes(obj["cid"], 32),
        "mime": byte_string(obj["mime"], raw),
        "outputHash": hex_bytes(obj["outputHash"], 32),
    }

    if store == "abxfs":
        result["codec"] = hex_bytes(obj["codec"], 32)
        encoded = result["codec"] != ZERO32
    else:
        result["compression"] = uint(obj["compression"], maximum=255)
        encoded = result["compression"] != 0

    if store == "bamfs1":
        result["chunks"] = [hex_bytes(cid, 32) for cid in array(obj["chunks"])]
    else:
        result["root"] = hex_bytes(obj["root"], 32)

    if store == "bamfs2":
        result["size"] = uint(obj["size"], strings=True)

    require(
        ("content" in obj) == encoded,
        "index", "content is required exactly for an encoded file",
    )
    if encoded:
        result["content"] = byte_string(obj["content"], raw)
    return result


def blob_map(value: object, raw: dict[bytes, bytes]) -> dict[bytes, Blob]:
    require(isinstance(value, dict), "index", "expected an ID-to-bytes object")
    return {
        hex_bytes(key, 32): byte_string(blob, raw)
        for key, blob in value.items()
    }


def chunks_schema(
    value: object, store: str, raw: dict[bytes, bytes]
) -> dict[bytes, object]:
    if store != "abxfs":
        return blob_map(value, raw)

    require(isinstance(value, dict), "index", "chunks must be an object")
    result = {}
    for key, entry in value.items():
        obj = object_fields(entry, ("backend", "inputHash", "data"))
        result[hex_bytes(key, 32)] = {
            "backend": hex_bytes(obj["backend"], 20),
            "inputHash": hex_bytes(obj["inputHash"], 32),
            "data": byte_string(obj["data"], raw),
        }
    return result


def content_schema(value: object, raw: dict[bytes, bytes]) -> dict:
    require(isinstance(value, dict), "index", "content must be an object")
    store = value.get("store")
    require(store in ("abxfs", "bamfs1", "bamfs2"), "index", "unknown content store")
    required = {"store", "dirs", "files", "chunks"}
    if store != "bamfs1":
        required.add("nodes")
    obj = object_fields(value, required)

    return {
        "store": store,
        "dirs": [
            directory_schema(item, store, raw) for item in array(obj["dirs"])
        ],
        "files": [
            file_schema(item, store, raw) for item in array(obj["files"])
        ],
        "nodes": {} if store == "bamfs1" else blob_map(obj["nodes"], raw),
        "chunks": chunks_schema(obj["chunks"], store, raw),
    }


def index_schema(value: object, raw: dict[bytes, bytes]) -> dict:
    obj = object_fields(value, ("format", "project", "root", "proof", "content"))
    require(obj["format"] == "abx-archive/1", "index", "unsupported format")
    project = object_fields(obj["project"], ("chain", "org", "token", "key"))
    chain = uint(project["chain"])
    require(chain in (1, 8453, 42161), "index", "unsupported project chain")
    key = project["key"]
    require(key in ("abxfs.cid", "bamfs.cid"), "index", "unsupported parameter key")
    parsed_project = {
        "chain": chain,
        "org": hex_bytes(project["org"], 20),
        "token": uint(
            project["token"], string_only=True, maximum=UINT256_MOD - 1
        ),
        "key": key,
    }
    root = hex_bytes(obj["root"], 32)
    require(root != ZERO32, "index", "root is zero")
    proof = proof_schema(obj["proof"])
    content = content_schema(obj["content"], raw)

    expected = {1: "ethereum", 8453: "base", 42161: "arbitrum"}[chain]
    require(
        proof["kind"] in (expected, "agreed", "logged"),
        "index", "proof kind does not fit the project chain",
    )
    require(
        (key == "abxfs.cid") == (content["store"] == "abxfs"),
        "index", "content store does not fit the parameter key",
    )
    return {
        "project": parsed_project,
        "root": root,
        "proof": proof,
        "content": content,
    }


# Strict RLP. Lists retain their original encoded size for embedded trie nodes.


class RLPList(list):
    def __init__(self, encoded_size: int):
        super().__init__()
        self.encoded_size = encoded_size


def rlp_item_bounds(
    data: bytes, position: int, limit: int
) -> tuple[bool, int, int]:
    require(position < limit, "proof", "missing RLP item")
    tag = data[position]

    if tag < 0x80:
        return False, position, position + 1

    if tag <= 0xB7:
        start = position + 1
        end = start + tag - 0x80
        require(end <= limit, "proof", "RLP string exceeds its enclosing item")
        require(
            end - start != 1 or data[start] >= 0x80,
            "proof", "noncanonical one-byte RLP string",
        )
        return False, start, end

    if tag <= 0xBF:
        is_list = False
        width = tag - 0xB7
    elif tag <= 0xF7:
        start = position + 1
        end = start + tag - 0xC0
        require(end <= limit, "proof", "RLP list exceeds its enclosing item")
        return True, start, end
    else:
        is_list = True
        width = tag - 0xF7

    length_start = position + 1
    start = length_start + width
    require(start <= limit, "proof", "truncated RLP length")
    require(data[length_start] != 0, "proof", "RLP length has a leading zero")
    length = int.from_bytes(data[length_start:start], "big")
    require(length > 55, "proof", "noncanonical long-form RLP length")
    end = start + length
    require(end <= limit, "proof", "RLP item exceeds its enclosing item")
    return is_list, start, end


def decode_rlp(data: bytes) -> bytes | RLPList:
    is_list, start, end = rlp_item_bounds(data, 0, len(data))
    require(end == len(data), "proof", "bytes follow the outer RLP item")
    if not is_list:
        return data[start:end]

    root = RLPList(end)
    stack = [(end, root)]
    position = start
    while stack:
        limit, current = stack[-1]
        if position == limit:
            stack.pop()
            continue

        item_start = position
        is_list, start, end = rlp_item_bounds(data, position, limit)
        if is_list:
            child = RLPList(end - item_start)
            current.append(child)
            stack.append((end, child))
            position = start
        else:
            current.append(data[start:end])
            position = end
    return root


def rlp_integer(value: object) -> int:
    require(isinstance(value, bytes), "proof", "RLP integer is not a string")
    require(len(value) <= 32, "proof", "RLP integer exceeds 256 bits")
    require(not value or value[0] != 0, "proof", "RLP integer has a leading zero")
    return int.from_bytes(value, "big")


@dataclass(frozen=True)
class Header:
    state_root: bytes
    number: int
    timestamp: int
    block_hash: bytes


def read_header(data: bytes) -> Header:
    items = decode_rlp(data)
    require(
        isinstance(items, RLPList)
        and len(items) >= 15
        and all(isinstance(item, bytes) for item in items),
        "proof", "header must be a list of at least 15 strings",
    )
    require(len(items[3]) == 32, "proof", "header state root is not 32 bytes")
    number = rlp_integer(items[8])
    timestamp = rlp_integer(items[11])
    require(
        number <= MAX_JSON_INTEGER and timestamp <= MAX_JSON_INTEGER,
        "proof", "header number or timestamp is not below 2^53",
    )
    return Header(items[3], number, timestamp, H(data))


def nibbles(data: bytes) -> tuple[int, ...]:
    return tuple(nibble for byte in data for nibble in (byte >> 4, byte & 15))


def hex_prefix(value: object) -> tuple[bool, tuple[int, ...]]:
    require(
        isinstance(value, bytes) and bool(value),
        "proof", "short-node path is not a nonempty string",
    )
    flag = value[0] >> 4
    require(flag <= 3, "proof", "invalid hex-prefix flag")
    odd = flag & 1
    require(odd != 0 or value[0] & 15 == 0, "proof", "nonzero hex-prefix padding")
    decoded = nibbles(value)
    return bool(flag & 2), decoded[1:] if odd else decoded[2:]


def check_child_reference(reference: object, embedded: list[RLPList]) -> None:
    if isinstance(reference, bytes):
        require(
            len(reference) in (0, 32),
            "proof", "child reference is neither empty nor a hash",
        )
        return
    require(isinstance(reference, RLPList), "proof", "invalid child reference")
    require(
        reference.encoded_size < 32,
        "proof", "embedded node is not shorter than 32 RLP bytes",
    )
    embedded.append(reference)


def validate_trie_node(root: object) -> None:
    pending = [root]
    while pending:
        node = pending.pop()
        require(isinstance(node, RLPList), "proof", "trie node is not an RLP list")
        require(len(node) in (2, 17), "proof", "trie node has the wrong arity")
        if len(node) == 17:
            require(node[16] == b"", "proof", "branch holds a value")
            for reference in node[:16]:
                check_child_reference(reference, pending)
        else:
            leaf, _ = hex_prefix(node[0])
            if leaf:
                require(
                    isinstance(node[1], bytes),
                    "proof", "leaf value is not a string",
                )
            else:
                check_child_reference(node[1], pending)


def next_trie_node(
    reference: object,
    position: int,
    encoded: list[bytes],
    decoded: list[bytes | RLPList],
) -> tuple[RLPList, int]:
    if isinstance(reference, RLPList):
        return reference, position
    require(
        isinstance(reference, bytes) and len(reference) == 32,
        "proof", "extension has no child",
    )
    position += 1
    require(position < len(encoded), "proof", "missing referenced trie node")
    require(
        H(encoded[position]) == reference,
        "proof", "trie child hash mismatch",
    )
    return decoded[position], position


def trie_result(
    value: bytes | None, position: int, count: int
) -> bytes | None:
    require(position == count - 1, "proof", "unused trie proof nodes")
    return value


def verify_trie(root: bytes, key: bytes, proof: list[bytes]) -> bytes | None:
    require(1 <= len(proof) <= 64, "proof", "trie proof must have 1 to 64 nodes")
    require(H(proof[0]) == root, "proof", "trie root hash mismatch")
    decoded = [decode_rlp(node) for node in proof]
    for node in decoded:
        validate_trie_node(node)

    path = nibbles(H(key))
    consumed = 0
    array_position = 0
    node = decoded[0]

    while True:
        if len(node) == 17:
            if consumed == len(path):
                return trie_result(None, array_position, len(proof))
            reference = node[path[consumed]]
            consumed += 1
            if reference == b"":
                return trie_result(None, array_position, len(proof))
        else:
            leaf, segment = hex_prefix(node[0])
            remaining = path[consumed:]
            if remaining[:len(segment)] != segment:
                return trie_result(None, array_position, len(proof))
            if leaf:
                value = node[1] if len(segment) == len(remaining) else None
                return trie_result(value, array_position, len(proof))
            consumed += len(segment)
            reference = node[1]

        node, array_position = next_trie_node(
            reference, array_position, proof, decoded
        )


@dataclass(frozen=True)
class Account:
    storage_root: bytes
    code_hash: bytes


def read_account(value: bytes) -> Account:
    items = decode_rlp(value)
    require(
        isinstance(items, RLPList) and len(items) == 4,
        "proof", "account is not a four-item RLP list",
    )
    rlp_integer(items[0])
    rlp_integer(items[1])
    require(
        isinstance(items[2], bytes) and len(items[2]) == 32
        and isinstance(items[3], bytes) and len(items[3]) == 32,
        "proof", "account roots are not 32-byte strings",
    )
    return Account(items[2], items[3])


class Evidence:
    def __init__(
        self,
        state_root: bytes,
        records: list[dict],
        codes: Iterable[bytes] = (),
    ) -> None:
        self.accounts: dict[bytes, Account | None] = {}
        self.storage: dict[bytes, dict[bytes, int]] = {}
        self.codes = {H(code): code for code in codes}

        for record in records:
            address = record["address"]
            require(
                address not in self.accounts,
                "proof", "duplicate account address",
            )
            value = verify_trie(state_root, address, record["proof"])
            account = None if value is None else read_account(value)
            self.accounts[address] = account
            require(
                account is not None or not record["storage"],
                "proof", "storage supplied for an absent account",
            )
            slots: dict[bytes, int] = {}
            self.storage[address] = slots
            for entry in record["storage"]:
                slot = entry["slot"]
                require(slot not in slots, "proof", "duplicate storage slot")
                result = verify_trie(account.storage_root, slot, entry["proof"])
                slots[slot] = 0 if result is None else rlp_integer(decode_rlp(result))

    def account(self, address: bytes) -> Account | None:
        require(address in self.accounts, "proof", "required account evidence missing")
        return self.accounts[address]

    def get_word(self, address: bytes, slot: int | bytes) -> int:
        self.account(address)
        slot_bytes = word(slot) if isinstance(slot, int) else slot
        require(
            slot_bytes in self.storage[address],
            "proof", "required storage evidence missing",
        )
        return self.storage[address][slot_bytes]

    def address_at(self, address: bytes, slot: int | bytes) -> bytes:
        return word(self.get_word(address, slot))[-20:]

    def code(self, address: bytes) -> bytes:
        account = self.account(address)
        require(account is not None, "proof", "code requested for an absent account")
        require(account.code_hash in self.codes, "proof", "matching code missing")
        return self.codes[account.code_hash]


# Semantic failures are deferred so later missing or invalid required evidence
# still receives class "proof", and binding failures precede parameter failures.


class SemanticChecks:
    def __init__(self) -> None:
        self.failures: dict[str, str] = {}

    def check(self, condition: bool, category: str, message: str) -> None:
        if not condition and category not in self.failures:
            self.failures[category] = message

    def binding(self, condition: bool, message: str) -> None:
        self.check(condition, "binding", message)

    def param(self, condition: bool, message: str) -> None:
        self.check(condition, "param", message)

    def finish(self) -> None:
        for category in ("binding", "param"):
            if category in self.failures:
                raise Rejection(category, self.failures[category])


def parameter_slots(project: dict) -> tuple[bytes, bytes]:
    namespace = (int.from_bytes(H(b"abx.storage.params"), "big") - 1) % UINT256_MOD
    base = H(word(namespace))[:-1] + b"\x00"
    key = project["key"].encode("ascii").ljust(32, b"\x00")
    value_slot = H(key, H(word(project["token"]), base))
    flags_slot = word((int.from_bytes(value_slot, "big") + 1) % UINT256_MOD)
    return value_slot, flags_slot


def check_parameter(
    evidence: Evidence, project: dict, root: bytes, checks: SemanticChecks
) -> None:
    address = project["org"]
    account = evidence.account(address)
    checks.param(account is not None, "project account does not exist")
    if account is None:
        return

    collection_code_matches = account.code_hash == COLLECTION_CODE_HASH
    checks.param(collection_code_matches, "collection code hash mismatch")
    if not collection_code_matches:
        return

    value_slot, flags_slot = parameter_slots(project)
    flags = evidence.get_word(address, flags_slot)
    valid_flags = flags >> 16 == 0 and flags & 0x100 != 0 and flags & 1 == 0
    checks.param(
        valid_flags,
        "token parameter flags do not satisfy the parameter rule",
    )
    if not valid_flags:
        return

    value = evidence.get_word(address, value_slot)
    checks.param(value == int.from_bytes(root, "big"), "token parameter root mismatch")


def check_address_word(
    evidence: Evidence,
    address: bytes,
    slot: int | bytes,
    expected: bytes,
    checks: SemanticChecks,
    message: str,
) -> None:
    checks.binding(evidence.address_at(address, slot) == expected, message)


def base_contracts(evidence: Evidence, checks: SemanticChecks) -> int:
    requirements = (
        (PORTAL, IMPL_SLOT, PORTAL_IMPL, "portal implementation mismatch"),
        (PORTAL, 62, REGISTRY, "portal registry mismatch"),
        (REGISTRY, IMPL_SLOT, REGISTRY_IMPL, "registry implementation mismatch"),
        (REGISTRY, 1, FACTORY, "registry factory mismatch"),
        (FACTORY, IMPL_SLOT, FACTORY_IMPL, "factory implementation mismatch"),
        (
            FACTORY,
            H(word(621), word(101)),
            GAME_IMPL,
            "factory game implementation mismatch",
        ),
    )
    for address, slot, expected, message in requirements:
        check_address_word(evidence, address, slot, expected, checks, message)
    registry_word = evidence.get_word(REGISTRY, 6)
    checks.binding(registry_word & 0xFFFFFFFF == 621, "registry game type mismatch")
    return (registry_word >> 32) & ((1 << 64) - 1)


def base_game_arguments(
    evidence: Evidence, game: bytes, checks: SemanticChecks
) -> tuple[bytes, bytes, int] | None:
    account = evidence.account(game)
    checks.binding(account is not None, "game account does not exist")
    if account is None:
        return None

    code = evidence.code(game)
    checks.binding(code.startswith(GAME_HEAD), "game code prefix mismatch")
    long_enough = len(code) >= len(GAME_HEAD) + 136 + 2
    checks.binding(long_enough, "game code is too short")
    if not long_enough:
        return None

    args = code[len(GAME_HEAD):-2]
    root_claim = args[20:52]
    extra = args[84:]
    l2_block = int.from_bytes(extra[:32], "big")
    checks.binding(l2_block <= MAX_JSON_INTEGER, "game L2 block exceeds 2^53 - 1")
    return root_claim, extra, l2_block


def base_factory_record(
    evidence: Evidence,
    game: bytes,
    arguments: tuple[bytes, bytes, int] | None,
    checks: SemanticChecks,
) -> None:
    if arguments is not None:
        root_claim, extra, _ = arguments
        uuid = H(
            word(621), root_claim, word(96), word(len(extra)),
            extra, bytes((-len(extra)) % 32),
        )
        record = evidence.get_word(FACTORY, H(uuid, word(103)))
        checks.binding(word(record)[-20:] == game, "factory record game mismatch")
        checks.binding(record >> 224 == 621, "factory record game type mismatch")

    blacklist_slot = H(game.rjust(32, b"\x00"), word(5))
    checks.binding(
        evidence.get_word(REGISTRY, blacklist_slot) == 0,
        "game is blacklisted",
    )


def base_game_state(
    evidence: Evidence,
    game: bytes,
    retirement: int,
    final: bool,
    checks: SemanticChecks,
) -> None:
    if final:
        check_address_word(
            evidence, REGISTRY, 2, game, checks, "game is not the registry anchor"
        )

    if evidence.account(game) is None:
        return

    state = evidence.get_word(game, 0)
    proof_word = evidence.get_word(game, 7)
    created_at = state & ((1 << 64) - 1)
    status = (state >> 128) & 0xFF
    respected = (state >> 144) & 0xFF
    proof_count = (proof_word >> 64) & 0xFF

    checks.binding(respected != 0, "game was not respected")
    checks.binding(created_at > retirement, "game predates registry retirement")
    if final:
        checks.binding(status == 2, "final game does not have status 2")
    else:
        checks.binding(status in (0, 2), "claimed game has a losing status")
        checks.binding(proof_count >= 1, "claimed game has no accepted proof")


def base_l2(
    header: Header,
    evidence: Evidence,
    arguments: tuple[bytes, bytes, int] | None,
    checks: SemanticChecks,
) -> None:
    passer = evidence.account(MESSAGE_PASSER)
    checks.binding(passer is not None, "message passer account does not exist")
    checks.binding(
        not evidence.storage[MESSAGE_PASSER],
        "message passer evidence must not include storage proofs",
    )
    if arguments is None:
        return

    root_claim, _, number = arguments
    checks.binding(header.number == number, "L2 block number differs from game")
    if passer is not None:
        output_root = H(
            ZERO32, header.state_root, passer.storage_root, header.block_hash
        )
        checks.binding(output_root == root_claim, "Base output root mismatch")


def anchor_line(header: Header) -> str:
    return f"anchor {header.number} {hx(header.block_hash)}"


def verify_ethereum(proof: dict, project: dict, root: bytes) -> list[str]:
    header = read_header(proof["header"])
    evidence = Evidence(header.state_root, proof["accounts"])
    checks = SemanticChecks()
    check_parameter(evidence, project, root, checks)
    checks.finish()
    return [anchor_line(header)]


def verify_base(proof: dict, project: dict, root: bytes) -> list[str]:
    l1 = read_header(proof["l1"]["header"])
    l2 = read_header(proof["l2"]["header"])
    evidence1 = Evidence(
        l1.state_root, proof["l1"]["accounts"], proof["l1"]["codes"]
    )
    evidence2 = Evidence(l2.state_root, proof["l2"]["accounts"])
    checks = SemanticChecks()

    retirement = base_contracts(evidence1, checks)
    arguments = base_game_arguments(evidence1, proof["game"], checks)
    base_factory_record(evidence1, proof["game"], arguments, checks)
    base_game_state(evidence1, proof["game"], retirement, proof["final"], checks)
    base_l2(l2, evidence2, arguments, checks)
    check_parameter(evidence2, project, root, checks)
    checks.finish()

    status = "final" if proof["final"] else "claimed"
    return [
        anchor_line(l1),
        f"l2 {l2.number} {hx(l2.block_hash)} {status}",
    ]


def arbitrum_assertion(
    evidence: Evidence, anchor: Header, checks: SemanticChecks
) -> bytes:
    check_address_word(
        evidence, ROLLUP, IMPL_SLOT, ROLLUP_IMPL,
        checks, "rollup primary implementation mismatch",
    )
    check_address_word(
        evidence, ROLLUP, SECONDARY_SLOT, SECONDARY_IMPL,
        checks, "rollup secondary implementation mismatch",
    )
    assertion = word(evidence.get_word(ROLLUP, 116))
    checks.binding(assertion != ZERO32, "rollup assertion is zero")
    if assertion != ZERO32:
        node = evidence.get_word(ROLLUP, H(assertion, word(117)))
        status = (node >> 200) & 0xFF
        created_at = (node >> 128) & ((1 << 64) - 1)
        checks.binding(status == 2, "rollup assertion is not confirmed")
        checks.binding(
            1 <= created_at <= anchor.number,
            "rollup assertion creation block is out of range",
        )
    return assertion


def arbitrum_log(
    log: dict, assertion: bytes, l2: Header, checks: SemanticChecks
) -> None:
    data = log["data"]
    valid_length = len(data) % 32 == 0 and 20 * 32 <= len(data) <= 40 * 32
    checks.binding(valid_length, "assertion log data is not 20 to 40 words")
    if not valid_length:
        return

    after = data[13 * 32:19 * 32]
    accumulator = data[19 * 32:20 * 32]
    checks.binding(
        H(log["parent"], H(after), accumulator) == assertion,
        "assertion log hash mismatch",
    )
    checks.binding(
        l2.block_hash == after[:32],
        "L2 header hash differs from the assertion",
    )


def verify_arbitrum(proof: dict, project: dict, root: bytes) -> list[str]:
    l1 = read_header(proof["l1"]["header"])
    l2 = read_header(proof["l2"]["header"])
    evidence1 = Evidence(l1.state_root, proof["l1"]["accounts"])
    evidence2 = Evidence(l2.state_root, proof["l2"]["accounts"])
    checks = SemanticChecks()
    assertion = arbitrum_assertion(evidence1, l1, checks)
    arbitrum_log(proof["log"], assertion, l2, checks)
    check_parameter(evidence2, project, root, checks)
    checks.finish()
    return [
        anchor_line(l1),
        f"l2 {l2.number} {hx(l2.block_hash)} confirmed",
    ]


def verify_binding(proof: dict, project: dict, root: bytes) -> list[str]:
    kind = proof["kind"]
    if kind == "ethereum":
        return verify_ethereum(proof, project, root)
    if kind == "base":
        return verify_base(proof, project, root)
    if kind == "arbitrum":
        return verify_arbitrum(proof, project, root)
    if kind == "agreed":
        endpoints = ",".join(proof["endpoints"])
        return [f"not proved agreed {proof['block']} {endpoints}"]
    return [f"not proved logged {proof['block']} {hx(proof['tx'])}"]


# Content trees and names.


def valid_utf8(value: bytes, message: str) -> None:
    try:
        value.decode("utf-8")
    except UnicodeDecodeError:
        raise Rejection("content", message) from None


def normalized_name(value: bytes, bamfs: bool, extracting: bool) -> bytes:
    if bamfs:
        valid_utf8(value, "BAMFS name is not valid UTF-8")
        if value.startswith(b"\xef\xbb\xbf"):
            value = value[3:]
    if extracting:
        require(
            value not in (b"", b".", b"..") and b"/" not in value and b"\x00" not in value,
            "content", "name is unsafe for extraction",
        )
    return value


SAFE_NAME_BYTES = frozenset(
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
)


def escape_name(value: bytes) -> str:
    return "".join(
        chr(byte) if byte in SAFE_NAME_BYTES else f"%{byte:02X}"
        for byte in value
    )


def entry_leaf(blob: bytes) -> Iterator[tuple[bytes, bytes, bool]]:
    require(len(blob) >= 3, "content", "entry leaf is too short")
    count = int.from_bytes(blob[1:3], "big")
    require(count >= 1, "content", "entry leaf has no records")
    base = 3 + 2 * count
    require(
        len(blob) >= base + 35 * count,
        "content", "entry leaf is too short for its records",
    )
    cursor = base

    for index in range(count):
        offset = int.from_bytes(blob[3 + 2 * index:5 + 2 * index], "big")
        require(
            offset == cursor - base,
            "content", "entry leaf offsets do not identify contiguous records",
        )
        require(cursor < len(blob), "content", "truncated entry record")
        name_length = blob[cursor]
        require(name_length >= 1, "content", "entry record has an empty encoded name")
        end = cursor + name_length + 34
        require(end <= len(blob), "content", "truncated entry record")
        name = blob[cursor + 1:cursor + 1 + name_length]
        marker = blob[cursor + 1 + name_length]
        require(marker in (0, 1), "content", "invalid entry isDir byte")
        cid = blob[cursor + 2 + name_length:end]
        yield name, cid, bool(marker)
        cursor = end

    require(cursor == len(blob), "content", "bytes follow the last entry record")


def chunk_leaf(blob: bytes, size_width: int) -> Iterator[tuple[bytes, int]]:
    stride = 32 + size_width
    require(
        len(blob) > 1 and (len(blob) - 1) % stride == 0,
        "content", "invalid chunk leaf length",
    )
    for start in range(1, len(blob), stride):
        cid = blob[start:start + 32]
        size = int.from_bytes(blob[start + 32:start + stride], "big")
        yield cid, size


def unique_cid_map(entries: list[dict]) -> dict[bytes, dict]:
    result = {}
    for entry in entries:
        cid = entry["cid"]
        require(cid not in result, "content", "duplicate CID in content list")
        result[cid] = entry
    return result


@dataclass
class ListedEntry:
    path: str
    names: tuple[bytes, ...]
    data: Blob | None

    @property
    def sort_path(self) -> str:
        return self.path + "/" if self.data is None else self.path

    def line(self) -> str:
        if self.data is None:
            return f"d {self.path}/"
        return f"f {self.path} {self.data.length} {self.data.sha256().hex()}"


class ContentVerifier:
    def __init__(self, content: dict, extracting: bool) -> None:
        self.store = content["store"]
        self.extracting = extracting
        self.dirs = unique_cid_map(content["dirs"])
        self.files = unique_cid_map(content["files"])
        require(
            not (self.dirs.keys() & self.files.keys()),
            "content", "CID occurs in both directories and files",
        )
        self.nodes = content["nodes"]
        self.chunks = content["chunks"]
        self.seen_dirs: set[bytes] = set()
        self.seen_files: set[bytes] = set()
        self.seen_nodes: set[bytes] = set()
        self.seen_chunks: set[bytes] = set()
        self.active_dirs: set[bytes] = set()
        self.node_cache: dict[tuple[bytes, bytes], bytes] = {}
        self.chunk_cache: dict[bytes, Blob] = {}
        self.file_cache: dict[bytes, Blob] = {}
        self.listing: list[ListedEntry] = []
        self.entry_count = 0
        self.file_count = 0
        self.byte_count = 0
        self.root_is_file = False

    def node_blob(self, cid: bytes, prefix: bytes, expected_level: int | None) -> bytes:
        require(cid in self.nodes, "content", "missing content tree node")
        self.seen_nodes.add(cid)
        key = (prefix, cid)
        if key not in self.node_cache:
            blob = self.nodes[cid].data()
            require(H(prefix, blob) == cid, "content", "content node hash mismatch")
            require(bool(blob) and blob[0] <= 3, "content", "invalid content node level")
            self.node_cache[key] = blob
        blob = self.node_cache[key]
        require(
            expected_level is None or blob[0] == expected_level,
            "content", "child node is not one level below its parent",
        )
        return blob

    def tree_items(
        self,
        cid: bytes,
        entry_tree: bool,
        expected_level: int | None = None,
    ) -> Iterator[tuple]:
        if self.store == "abxfs":
            prefix = b"\x42" if entry_tree else b"\x41"
        else:
            prefix = b"\x22" if entry_tree else b"\x21"
        blob = self.node_blob(cid, prefix, expected_level)
        level = blob[0]

        if level == 0:
            if entry_tree:
                yield from entry_leaf(blob)
            else:
                width = 6 if self.store == "abxfs" else 2
                yield from chunk_leaf(blob, width)
            return

        require(len(blob) >= 3, "content", "branch node is too short")
        count = int.from_bytes(blob[1:3], "big")
        stride = 36 if entry_tree else 42
        require(2 <= count <= 128, "content", "branch child count is out of range")
        require(
            len(blob) == 3 + stride * count,
            "content", "branch node length mismatch",
        )
        for start in range(3, len(blob), stride):
            child = blob[start:start + 32]
            yield from self.tree_items(child, entry_tree, level - 1)

    def directory_entries(self, cid: bytes) -> Iterator[tuple[bytes, bytes, bool]]:
        require(cid in self.dirs, "content", "missing directory CID")
        directory = self.dirs[cid]
        if self.store == "bamfs1":
            digest = Keccak256()
            for entry in directory["entries"]:
                digest.update(H(
                    entry["name"].keccak(),
                    entry["cid"],
                    bytes((int(entry["isDir"]),)),
                ))
            require(
                H(b"\x02", digest.digest()) == cid,
                "content", "BAMFS1 directory CID mismatch",
            )
            for entry in directory["entries"]:
                yield entry["name"].data(), entry["cid"], entry["isDir"]
            return

        prefix = b"\x32" if self.store == "abxfs" else b"\x12"
        root = directory["root"]
        require(H(prefix, root) == cid, "content", "directory CID mismatch")
        if self.store == "abxfs" and root == ZERO32:
            return
        yield from self.tree_items(root, True)

    def verified_chunk(self, cid: bytes) -> Blob:
        require(cid in self.chunks, "content", "missing chunk")
        self.seen_chunks.add(cid)
        if cid in self.chunk_cache:
            return self.chunk_cache[cid]

        if self.store == "abxfs":
            entry = self.chunks[cid]
            data = entry["data"]
            require(data.length >= 1, "content", "ABX FS chunk is empty")
            require(data.length <= MAX_CONTENT, "content", "content exceeds 1 GiB")
            actual = H(
                b"\x30", entry["backend"], entry["inputHash"],
                data.keccak(), data.length.to_bytes(6, "big"),
            )
        else:
            data = self.chunks[cid]
            require(data.length <= MAX_CONTENT, "content", "content exceeds 1 GiB")
            digest = Keccak256()
            digest.update(BACKEND)
            for part in data.parts:
                digest.update(part)
            actual = digest.digest()

        require(actual == cid, "content", "chunk ID mismatch")
        self.chunk_cache[cid] = data
        return data

    def tree_chunks(self, root: bytes) -> Iterator[Blob]:
        for cid, size in self.tree_items(root, False):
            data = self.verified_chunk(cid)
            require(data.length == size, "content", "chunk leaf size mismatch")
            yield data

    def encoded_file(self, entry: dict) -> Blob:
        data = entry["content"]
        require(data.length <= MAX_CONTENT, "content", "content exceeds 1 GiB")
        require(
            data.keccak() == entry["outputHash"],
            "content", "encoded file output hash mismatch",
        )
        return data

    def abx_file(self, entry: dict) -> Blob:
        mime = entry["mime"]
        require(1 <= mime.length <= 127, "content", "ABX FS MIME length is out of range")
        codec = entry["codec"]
        require(
            (codec == ZERO32) == (entry["outputHash"] == ZERO32),
            "content", "ABX FS codec and output hash disagree",
        )
        require(
            H(
                b"\x31", entry["root"], mime.keccak(),
                codec, entry["outputHash"],
            ) == entry["cid"],
            "content", "ABX FS file CID mismatch",
        )
        if codec != ZERO32:
            return self.encoded_file(entry)
        if entry["root"] == ZERO32:
            return Blob()
        return combine_content(self.tree_chunks(entry["root"]))

    def bamfs_file(self, entry: dict) -> Blob:
        mime = entry["mime"]
        valid_utf8(mime.data(), "BAMFS MIME is not valid UTF-8")
        compression = entry["compression"]

        if self.store == "bamfs1":
            prefix = b"\x01"
            content_root = keccak_parts(entry["chunks"])
        else:
            prefix = b"\x11"
            content_root = entry["root"]

        require(
            H(
                prefix, content_root, mime.keccak(),
                bytes((compression,)), entry["outputHash"],
            ) == entry["cid"],
            "content", "BAMFS file CID mismatch",
        )

        if compression != 0:
            data = self.encoded_file(entry)
        else:
            require(
                entry["outputHash"] == ZERO32,
                "content", "uncompressed BAMFS file has a nonzero output hash",
            )
            if self.store == "bamfs1":
                data = combine_content(
                    self.verified_chunk(cid) for cid in entry["chunks"]
                )
            else:
                data = combine_content(self.tree_chunks(entry["root"]))

        if self.store == "bamfs2" and compression == 0:
            require(data.length == entry["size"], "content", "BAMFS2 file size mismatch")
        return data

    def file_data(self, cid: bytes) -> Blob:
        require(cid in self.files, "content", "missing file CID")
        self.seen_files.add(cid)
        if cid not in self.file_cache:
            entry = self.files[cid]
            data = self.abx_file(entry) if self.store == "abxfs" else self.bamfs_file(entry)
            self.file_cache[cid] = data
        return self.file_cache[cid]

    def count_entry(self) -> None:
        self.entry_count += 1
        require(
            self.entry_count <= MAX_ENTRIES,
            "content", "content exceeds 65,536 entries",
        )

    def add_file(self, cid: bytes, names: tuple[bytes, ...]) -> None:
        data = self.file_data(cid)
        self.byte_count += data.length
        require(self.byte_count <= MAX_CONTENT, "content", "content exceeds 1 GiB")
        self.file_count += 1
        path = "/".join(escape_name(name) for name in names)
        self.listing.append(ListedEntry(path, names, data))

    def walk_directory(self, cid: bytes, names: tuple[bytes, ...], depth: int) -> None:
        require(depth <= MAX_DEPTH, "content", "directories nest more than 64 deep")
        require(cid not in self.active_dirs, "content", "directory contains itself")
        require(cid in self.dirs, "content", "missing directory CID")
        self.active_dirs.add(cid)
        self.seen_dirs.add(cid)
        seen_names: set[bytes] = set()

        try:
            for raw_name, child, is_dir in self.directory_entries(cid):
                name = normalized_name(
                    raw_name, self.store != "abxfs", self.extracting
                )
                require(name not in seen_names, "content", "duplicate directory name")
                seen_names.add(name)
                self.count_entry()
                child_names = names + (name,)
                if is_dir:
                    path = "/".join(escape_name(part) for part in child_names)
                    self.listing.append(ListedEntry(path, child_names, None))
                    self.walk_directory(child, child_names, depth + 1)
                else:
                    self.add_file(child, child_names)
        finally:
            self.active_dirs.remove(cid)

    def check_reachability(self) -> None:
        comparisons = (
            (self.dirs, self.seen_dirs, "unreached directory"),
            (self.files, self.seen_files, "unreached file"),
            (self.nodes, self.seen_nodes, "unreached content node"),
            (self.chunks, self.seen_chunks, "unreached chunk"),
        )
        for mapping, reached, message in comparisons:
            require(set(mapping) == reached, "content", message)

    def verify(self, root: bytes) -> None:
        if root in self.dirs:
            self.walk_directory(root, (), 0)
        else:
            self.root_is_file = True
            self.count_entry()
            self.add_file(root, ())
        self.check_reachability()
        self.listing.sort(key=lambda entry: entry.sort_path.encode("ascii"))


# Listing and extraction. Existing files are never overwritten. Directory file
# descriptors prevent an existing symlink beneath the destination from being
# followed. Raw non-UTF-8 ABX FS names require a POSIX filesystem interface.


def make_listing(index: dict, binding: list[str], content: ContentVerifier) -> bytes:
    project = index["project"]
    lines = [
        "abx-archive/1",
        (
            f"project {project['chain']} {hx(project['org'])} "
            f"{project['token']} {project['key']}"
        ),
        f"root {hx(index['root'])}",
        *binding,
        f"store {content.store}",
    ]
    lines.extend(entry.line() for entry in content.listing)
    lines.append(f"end {content.file_count} {content.byte_count}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def write_new_file(path: bytes, data: Blob, directory_fd: int | None = None) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o666, dir_fd=directory_fd)
    with os.fdopen(descriptor, "wb") as target:
        data.write(target)


def open_child_directory(root_fd: int, names: tuple[bytes, ...]) -> int:
    current = os.dup(root_fd)
    try:
        for name in names:
            try:
                os.mkdir(name, mode=0o777, dir_fd=current)
            except FileExistsError:
                pass
            child = os.open(
                name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=current,
            )
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def extract_directory(destination: str, entries: list[ListedEntry]) -> None:
    if (
        os.name != "posix"
        or not hasattr(os, "O_NOFOLLOW")
        or not hasattr(os, "O_DIRECTORY")
        or os.open not in os.supports_dir_fd
        or os.mkdir not in os.supports_dir_fd
    ):
        raise OSError("directory extraction requires POSIX directory descriptors")

    destination_bytes = os.fsencode(destination)
    os.makedirs(destination_bytes, exist_ok=True)
    root_fd = os.open(
        destination_bytes, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    )
    try:
        for entry in entries:
            names = entry.names if entry.data is None else entry.names[:-1]
            directory_fd = open_child_directory(root_fd, names)
            try:
                if entry.data is not None:
                    write_new_file(entry.names[-1], entry.data, directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        os.close(root_fd)


def extract(destination: str, content: ContentVerifier) -> None:
    entries = content.listing
    if content.root_is_file:
        entry = entries[0]
        entries = [ListedEntry("file", (b"file",), entry.data)]
    extract_directory(destination, entries)


def report_other_failure(error: BaseException) -> None:
    message = " ".join(str(error).splitlines()) or type(error).__name__
    try:
        sys.stderr.write(f"error {type(error).__name__}: {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="verify.py", add_help=False)
    parser.add_argument("bundle")
    parser.add_argument("--out", metavar="DIR")
    args = parser.parse_args(argv)

    try:
        # Decimal strings in the index have no specified digit-count limit.
        sys.set_int_max_str_digits(0)

        with open(args.bundle, "rb") as source:
            index_data, raw = read_container(source)

        parsed = parse_json(index_data)
        check_raw_walk(parsed, raw)
        check_json_values(parsed)
        index = index_schema(parsed, raw)

        binding = verify_binding(index["proof"], index["project"], index["root"])
        content = ContentVerifier(index["content"], extracting=args.out is not None)
        content.verify(index["root"])
        listing = make_listing(index, binding, content)

        if args.out is not None:
            extract(args.out, content)

        sys.stdout.buffer.write(listing)
        sys.stdout.buffer.flush()
        return 0

    except Rejection as error:
        message = " ".join(error.message.splitlines())
        try:
            sys.stdout.write(f"reject {error.category} {message}\n")
            sys.stdout.flush()
        except Exception as output_error:
            report_other_failure(output_error)
            return 2
        return 1
    except (Exception, KeyboardInterrupt) as error:
        report_other_failure(error)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
