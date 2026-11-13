# ABX archive bundles, format 1

An archive bundle holds one version of one ABX project, every byte of its files, and the evidence that the project named that version at a stated block. It is checked offline: no network, no node, no trust in whoever made it or served it. Anyone can write a verifier from this document alone. This document is the whole definition: where a verifier and this text disagree, the verifier is wrong; where two verifiers disagree on a test vector, this text is ambiguous and gets fixed.

A bundle proves two things, and says which of them it could prove:

1. **Content.** The files are exactly the content the root names. This rests only on keccak-256 and is always proved.
2. **Binding.** The project's token parameter held that root at a block, which rests on Merkle proofs up to one Ethereum block hash (the **anchor**). A verifier cannot know that the anchor is on the canonical chain; it prints the anchor's number and hash, and the reader compares them with any Ethereum explorer or node. A bundle of kind `agreed` (section 6.5) has no binding proof and says so.

Notation: `H(x)` is keccak-256 (the original Keccak padding, as Ethereum uses, not SHA3-256). `‖` is concatenation. `word(n)` is n as a 32-byte big-endian integer. `u16`, `u48` are big-endian unsigned integers of 2 and 6 bytes. Hex in this document and in bundles is lowercase with a `0x` prefix. An *address* is 20 bytes; the address in a storage word is its low 20 bytes (bytes 12..32), and its high 12 bytes are not checked unless a rule says so. Bit `n` of a word is counted from the least significant bit.

## 1. Container

A bundle is one file in CAR version 1 (the IPFS content-addressed archive format).

```
bundle  = varint(len(header)) ‖ header ‖ block*
header  = the 59 bytes below
block   = varint(len(cid) + len(data)) ‖ cid ‖ data
```

`varint` is the unsigned LEB128 varint of multiformats (7 bits per byte, low bits first, high bit set on all bytes but the last, no superfluous trailing 0x80 bytes).

Every `cid` is a CID version 1 with a SHA-256 multihash, in binary:

| Codec | Binary CID | Used for |
| --- | --- | --- |
| dag-json (0x0129) | `01 a9 02 12 20` ‖ sha256(data) (37 bytes) | the index block (section 2) |
| raw (0x55) | `01 55 12 20` ‖ sha256(data) (36 bytes) | every other block |

The header is DAG-CBOR `{"roots": [<index cid>], "version": 1}`, which is always these 59 bytes:

```
a2                      map of 2
65 726f6f7473           "roots"
81                      array of 1
d8 2a                   tag 42 (CID)
58 26 00 <37-byte index cid>     byte string of 38: a zero byte, then the binary CID
67 76657273696f6e       "version"
01                      1
```

so `varint(len(header))` is the single byte `3b`.

Rules (each failure is class `container`):

- The header is exactly as above.
- The first block is the index block, and its CID is the one in the header. Every other block is raw.
- `sha256(data)` equals the digest in each block's CID.
- Raw blocks follow the index block in the order a walk of the index first reaches a link to each, with no CID twice. The walk takes an object's members in ascending order of their keys' UTF-8 bytes and an array's items in order, and descends into each value before going to the next. (This is the order in which IPFS exports the blocks under the index, so `ipfs dag export <index cid>` gives the bundle back byte for byte.)
- No raw block is larger than 1,048,576 bytes. The index block is no larger than 16,777,216 bytes.
- Every raw block is referred to by the index at least once. Nothing follows the last block.

A **byte string** in the index is one of: a hex string (for values of at most 1,024 bytes), or a JSON array of links, each `{"/": "<cid>"}`, whose blocks concatenated in order are the value. `<cid>` is the CID in its text form: `b` followed by the binary CID in RFC 4648 base32, lowercase, without padding. A link names a raw block in this bundle; one that names no block is class `container`. A builder uses a hex string for values of at most 1,024 bytes and links for longer values, splitting a value into blocks of 1,048,576 bytes with a shorter last block; a verifier accepts either form for any length.

## 2. Index

The index block is UTF-8 JSON (RFC 8259) with no byte-order mark. A builder writes object keys in ascending order of their UTF-8 bytes, no insignificant whitespace, and integers in shortest decimal form, so that the same evidence always gives the same bundle; a verifier parses any valid JSON and does not check that form. Unknown keys are class `index`. Integers in the index are at most 2^53 - 1; larger values are decimal strings.

```
{
  "format":  "abx-archive/1",
  "project": { "chain": <chain id>, "org": <address>, "token": "<decimal>", "key": "abxfs.cid" | "bamfs.cid" },
  "root":    <32-byte hex>,
  "proof":   { "kind": "ethereum" | "base" | "arbitrum" | "agreed", ... },     section 6
  "content": { "store": "abxfs" | "bamfs1" | "bamfs2", ... }                 sections 7 to 9
}
```

`project.chain` is 1 (Ethereum), 8453 (Base) or 42161 (Arbitrum One), and the proof kind must fit it: `ethereum` for 1, `base` for 8453, `arbitrum` for 42161, `agreed` for any. `content.store` is `abxfs` when `key` is `abxfs.cid`, and `bamfs1` or `bamfs2` when it is `bamfs.cid`. A mismatch is class `index`.

The root is never all zeros: a project that published nothing has no bundle.

## 3. Ethereum primitives

### 3.1 RLP

Recursive length prefix as in the Ethereum Yellow Paper, appendix B. Decoding is strict, and anything else is class `proof`: a single byte below 0x80 is not wrapped as a one-byte string; lengths have no leading zero bytes; a long-form length is over 55; the item ends exactly where its length says; no bytes follow the outermost item.

An RLP *integer* is a string of at most 32 bytes with no leading zero byte; zero is the empty string.

### 3.2 Block headers

A header is given as its RLP bytes. It is a list of at least 15 items, all strings. Its hash is `H(rlp)`. The fields used here: item 3, the state root (32 bytes); item 8, the block number (an RLP integer below 2^53); item 11, the timestamp (an RLP integer below 2^53). The same rules hold for Ethereum, Base and Arbitrum One headers.

### 3.3 Merkle-Patricia proofs

An account or storage proof is the array of trie nodes from the root down, as `eth_getProof` returns them (EIP-1186), each an RLP byte string in hex. Verifying `proof` for `key` against `root`:

- The path is the 64 nibbles of `H(key)`, where `key` is the 20-byte address for an account and the 32-byte slot for a storage word.
- The first node must satisfy `H(node) == root`. Each node is a branch (a list of 17 items) or a short node (a list of 2 items whose first item is a hex-prefix encoded path, Yellow Paper appendix C: flag nibble 0 or 1 for an extension, 2 or 3 for a leaf, an odd flag carrying one nibble of path).
- A child reference in a branch or extension is either a 32-byte string, the hash of the next node in the array, or a list (an embedded node of under 32 bytes of RLP), which is the next node itself and takes no array entry. An empty string means no child.
- The walk ends at a leaf whose remaining path equals the remaining key path: its value is the second item. Or it ends with **absence**, when a branch has no child at the next nibble, a short node's path diverges from the key path, or a branch's 17th item is reached (which never holds a value in these tries). Absence is only valid when the last node in the array is where the walk stopped.
- Every node in the array is used exactly once; a node left over, a reference that does not match, or a value at a branch is class `proof`. At most 64 nodes.

An **account** is the RLP list `[nonce, balance, storageRoot, codeHash]` (two integers, two 32-byte strings). An account proof that ends in absence means the account does not exist. A **storage word** is an RLP string holding an RLP integer; absence means zero.

### 3.4 Account evidence

```
{ "address": <address>, "proof": [<hex node>, ...], "storage": [ { "slot": <32-byte hex>, "proof": [<hex node>, ...] }, ... ] }
```

Read against a state root: the account proof gives the account (or its absence), and each storage proof is read against that account's storage root. Storage of an absent account is class `proof`. A list of these, `accounts`, gives a lookup `word(address, slot)`. A rule that needs a word that no entry in the list supplies is class `proof`; so is an address that appears twice in one list, or a slot twice under one address.

`codes` is a list of hex byte strings; `code(address)` is the one whose `H` equals that address's proved code hash, and none matching is class `proof`.

## 4. Token parameter

Every ABX collection is a 45-byte minimal proxy to the one implementation `0x785cd3f74e86e4495c178b5ffcd047c57e699270`, so its storage layout is fixed. Its code hash is

```
COLLECTION_CODE_HASH = H( 3d3d3d3d363d3d37363d73 ‖ 785cd3f74e86e4495c178b5ffcd047c57e699270 ‖ 5af43d3d93803e602a57fd5bf3 )
                     = 0x52fca2e6744bf60088e9313fac37cda721b968eb7e77c243975ab36b49b0d34c
```

A token parameter is kept in the ERC-7201 namespace `abx.storage.params`:

```
BASE  = H( word( uint256(H("abx.storage.params")) - 1 ) ) with its low byte set to zero
KEY   = the parameter name in ASCII, left-aligned and zero-padded to 32 bytes
VALUE_SLOT = H( KEY ‖ H( word(token) ‖ BASE ) )
FLAGS_SLOT = VALUE_SLOT + 1  (as a 256-bit integer)
```

For token 0 and `abxfs.cid` this gives `VALUE_SLOT = 0xcf53182b08e96a80a3594b8136d4fd6393838c5f6f5d0679d5178dcb9e2abb6a`.

The parameter rule, given a state root and the account evidence for the project's `org` (class `param` unless a proof itself fails):

- The account exists and its code hash is `COLLECTION_CODE_HASH`.
- `flags = word(org, FLAGS_SLOT)`: no bit above bit 15 is set; bit 8 (is set) is 1; bit 0 (value is a hash) is 0.
- `word(org, VALUE_SLOT)` equals the bundle's `root`.

## 5. Constants of the rollups

As read from verified source on 2026-11-11. When one of these contracts is upgraded, bundles of format 1 can no longer be made under it, and a new format says what changed. All addresses are on Ethereum.

Base:

| Name | Value |
| --- | --- |
| OptimismPortal2 | `0x49048044d57e1c92a77f79988d21fa8faf74e97e`, implementation `0x03863ab7f64b733cff85c8ff44a86601c568ca70` |
| AnchorStateRegistry | `0x909f6cf47ed12f010a796527f562bfc26c7f4e72`, implementation `0x4483f964f6711cb55f633820ed174e780369b99d` |
| DisputeGameFactory | `0x43edb88c4b80fdd2adff2412a7bebf9df42cb40e`, implementation `0x94eab8f73fd83407d26c006d159923760d483029` |
| game type | 621 |
| game implementation | `0xc08b8ffaf04abb1d7013b74a0e57eccbd7fa5a70` |
| EIP-1967 implementation slot | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` |
| L2-to-L1 message passer (on Base) | `0x4200000000000000000000000000000000000016` |

Arbitrum One:

| Name | Value |
| --- | --- |
| rollup | `0x4dceb440657f21083db8add07665f8ddbe1dcfc0` |
| primary implementation (EIP-1967 slot above) | `0x7fc126ff51183a78c5e0437467f325f661d8df17` |
| secondary implementation, slot `0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d` | `0x6490ba0a60cc7d3a59c9eee135d9eed24553a60d` |

## 6. Binding proofs

Every failure in this section is class `proof` (a proof that does not verify) or class `binding` (proofs that verify but do not say what the bundle claims).

### 6.1 `ethereum`

```
{ "kind": "ethereum", "header": <hex RLP>, "accounts": [ <account evidence for org> ] }
```

The anchor is `header`: its hash and number are printed. The parameter rule (section 4) holds at its state root.

### 6.2 `base`

```
{ "kind": "base", "final": true | false,
  "l1": { "header": <hex RLP>, "accounts": [...], "codes": [<hex>, ...] },
  "game": <address>,
  "l2": { "header": <hex RLP>, "accounts": [ <message passer, no storage>, <org> ] } }
```

The anchor is `l1.header`. Words below are read from `l1.accounts` at its state root.

1. `word(PORTAL, IMPL_SLOT)` names the portal implementation, and `word(PORTAL, 62)` names the registry.
2. `word(REGISTRY, IMPL_SLOT)` names the registry implementation; `word(REGISTRY, 1)` names the factory. `r6 = word(REGISTRY, 6)`: bits 0..31 equal 621; `retirement` is bits 32..95.
3. `word(FACTORY, IMPL_SLOT)` names the factory implementation; `word(FACTORY, H(word(621) ‖ word(101)))` names the game implementation.
4. The game: the account `game` exists. `code = code(game)`. Let `HEAD` be the 98 bytes
   `36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b363d3d373d3d3d3d61030a806062363936013d73 ‖ c08b8ffaf04abb1d7013b74a0e57eccbd7fa5a70 ‖ 5af43d3d93803e606057fd5bf3`.
   `code` starts with `HEAD` and is at least 98 + 136 + 2 bytes long. `args` is `code` without `HEAD` and without its last 2 bytes. `rootClaim = args[20..52]`; `extra = args[84..]`; `l2Block` = `extra[0..32]` as an integer, at most 2^53 - 1.
5. The factory's record of it: `uuid = H( word(621) ‖ rootClaim ‖ word(96) ‖ word(len(extra)) ‖ extra ‖ zero bytes to a multiple of 32 )`; `rec = word(FACTORY, H(uuid ‖ word(103)))`: its low 20 bytes are `game` and bits 224..255 equal 621.
6. `word(REGISTRY, H(word(game) ‖ word(5)))` is zero (not blacklisted). Here `word(game)` is the address left-padded with zeros.
7. `s0 = word(game, 0)`: `createdAt` bits 0..63, `status` bits 128..135, `respected` bits 144..151. `respected` is not zero; `createdAt > retirement`. `s7 = word(game, 7)`: `proofCount` is bits 64..71.
8. If `final` is true: `game` is the address `word(REGISTRY, 2)` names, and `status` is 2. If `final` is false: `status` is 0 or 2, and `proofCount` is at least 1. (`final: false` is a claim that a proof was accepted for and nobody has won a challenge against, as of the anchor; it may still be overturned.)
9. The L2 block: `h2 = l2.header`, `blockHash = H(h2)`. Its number equals `l2Block`. The message passer's account exists at its state root, and `H( word(0) ‖ stateRoot ‖ passerStorageRoot ‖ blockHash ) == rootClaim`.
10. The parameter rule holds at the L2 state root, with the org's evidence from `l2.accounts`.

Printed: the anchor, then the L2 block's number and hash, and `final` or `claimed`.

### 6.3 `arbitrum`

```
{ "kind": "arbitrum",
  "l1": { "header": <hex RLP>, "accounts": [...] },
  "log": { "parent": <32-byte hex>, "data": <hex> },
  "l2": { "header": <hex RLP>, "accounts": [ <org> ] } }
```

1. `word(ROLLUP, IMPL_SLOT)` names the primary implementation, `word(ROLLUP, SECONDARY_SLOT)` the secondary one.
2. `assertion = word(ROLLUP, 116)`, not zero. `node = word(ROLLUP, H(assertion ‖ word(117)))`: bits 200..207 equal 2 (confirmed); `createdAt` bits 128..191 is at least 1 and at most the anchor's number.
3. `log.data` is 20 to 40 words. `after` is words 13 to 18 (six words), `acc` is word 19: `H( log.parent ‖ H(after[0] ‖ … ‖ after[5]) ‖ acc ) == assertion`. `blockHash = after[0]`.
4. `H(l2.header) == blockHash`. The parameter rule holds at its state root.

The log is not proved and need not be: whatever is given must hash to the proved assertion. Printed: the anchor, then the L2 block's number and hash, and `confirmed`.

### 6.4 Which block is the anchor

The anchor block is not checked to be finalized or canonical: no offline check can. The builder takes it from a sync-committee light client's finalized block. The reader decides whether to believe it by looking its hash up elsewhere.

### 6.5 `agreed`

```
{ "kind": "agreed", "block": <number>, "endpoints": [<host>, ...] }
```

No binding is proved: at least two public endpoints, named here, answered the same root for the token parameter at that block of the project's own chain when the bundle was made. A verifier checks only the content and prints `not proved`. A builder makes these only for a version no proof reaches yet, and a later bundle of the same version can carry a proof.

## 7. Content: ABX FS (`abxfs`)

```
{ "store": "abxfs",
  "dirs":   [ { "cid": <32>, "root": <32> }, ... ],
  "files":  [ { "cid": <32>, "root": <32>, "mime": <byte string>, "codec": <32>, "outputHash": <32>, "content": <byte string> (only when codec is not zero) }, ... ],
  "nodes":  { "<32-byte hex id>": <byte string>, ... },
  "chunks": { "<32-byte hex id>": { "backend": <address>, "inputHash": <32>, "data": <byte string> }, ... } }
```

Prefixes: chunk id `0x30`, file `0x31`, directory `0x32`, chunk node `0x41`, entry node `0x42`. Every failure here is class `content`.

The bundle's `root` is a directory if `dirs` holds an entry with that `cid`, otherwise a file and `files` must hold it. A CID in both lists, a CID twice in one list, or anything in `dirs`, `files`, `nodes` or `chunks` that the walk below does not reach is a failure.

**Directory** `{cid, root}`: `cid == H(0x32 ‖ root)`. If `root` is all zeros the directory is empty. Otherwise walk the entry-node tree from `root`:

- A node `id` is `nodes[id]`, and `H(0x42 ‖ blob) == id`. Its first byte is its level, 0 to 3; a child is exactly one level below its parent.
- A **branch** (level 1 to 3): `level ‖ u16(n) ‖ n × ( id:32 ‖ u32 count )`, `2 ≤ n ≤ 128`, length exactly `3 + 36·n`. Children in order.
- A **leaf** (level 0): `0x00 ‖ u16(n) ‖ n × u16(offset) ‖ n × record`, `n ≥ 1`. Records start at byte `3 + 2·n`; `offset_i` is record i's start counted from there, and `offset_0 = 0`. `record = u8(len) ‖ name[len] ‖ u8(isDir) ‖ cid:32`, `isDir` 0 or 1, `len ≥ 1`. The records end exactly at the end of the blob.

The entries are the leaves' records in order. Two entries with the same name bytes are a failure. A directory entry names a CID that `dirs` must hold, and a file entry one that `files` must hold. A directory reached again while it is being walked (it contains itself) is a failure; the same directory under two different parents is not.

**File** `{cid, root, mime, codec, outputHash, content}`: `mime` is 1 to 127 bytes. `cid == H( 0x31 ‖ root ‖ H(mime) ‖ codec ‖ outputHash )`. `codec` is zero exactly when `outputHash` is zero.

- `codec` not zero: the file's bytes are `content`, and `H(content) == outputHash`. `root` is not walked.
- `codec` zero and `root` all zeros: the file is empty.
- `codec` zero otherwise: walk the chunk-node tree from `root`. A node is `nodes[id]` with `H(0x41 ‖ blob) == id`, level byte 0 to 3, each child one level below its parent. A **branch**: `level ‖ u16(n) ‖ n × ( id:32 ‖ u32 count ‖ u48 bytes )`, `2 ≤ n ≤ 128`, length exactly `3 + 42·n`. A **leaf**: `0x00 ‖ m × ( chunkId:32 ‖ u48 size )`, `m ≥ 1`, length exactly `1 + 38·m`. The file's bytes are its chunks' `data` in order. Each chunk `chunks[chunkId]` satisfies `chunkId == H( 0x30 ‖ backend ‖ inputHash ‖ H(data) ‖ u48(len(data)) )`, `len(data) ≥ 1`, and `len(data)` equals the leaf's `size`.

The branch counts are covered by the node ids and are not checked.

## 8. Content: BAMFS second generation (`bamfs2`)

```
{ "store": "bamfs2",
  "dirs":   [ { "cid": <32>, "root": <32> }, ... ],
  "files":  [ { "cid": <32>, "root": <32>, "mime": <byte string>, "compression": <0..255>, "outputHash": <32>, "size": <integer>, "content": <byte string> (only when compression is not 0) }, ... ],
  "nodes":  { "<32-byte hex id>": <byte string>, ... },
  "chunks": { "<32-byte hex id>": <byte string>, ... } }
```

`BACKEND = 0x91520cdaaab44267e99d08fea7730d7a7c60e9c2`. Lists, reachability and duplicates as in section 7. Failures are class `content`.

**Directory**: `cid == H(0x12 ‖ root)`. Walk nodes from `root`: `H(0x22 ‖ blob) == id`, level byte 0 to 3, each child one level below its parent; a branch is `level ‖ u16(n) ‖ n × ( id:32 ‖ 4 more bytes )`, `2 ≤ n ≤ 128`, length exactly `3 + 36·n`; a leaf is as in section 7 (same layout of offsets and records). Entries, duplicates and loops as in section 7.

**File**: `mime` is valid UTF-8; `cid == H( 0x11 ‖ root ‖ H(mime) ‖ u8(compression) ‖ outputHash )`.

- `compression` not 0: the file's bytes are `content`, and `H(content) == outputHash`.
- `compression` 0: `outputHash` is zero. Walk from `root`: `H(0x21 ‖ blob) == id`, a branch is `level ‖ u16(n) ‖ n × ( id:32 ‖ 10 more bytes )`, length exactly `3 + 42·n`; a leaf is `0x00 ‖ m × ( id:32 ‖ u16 size )`, `m ≥ 1`, length exactly `1 + 34·m`. The bytes are the chunks in order; each chunk `chunks[id]` satisfies `H(BACKEND ‖ chunk) == id` and its length equals the leaf's `size`.
- Either way the file's length equals `size`.

## 9. Content: BAMFS first generation (`bamfs1`)

```
{ "store": "bamfs1",
  "dirs":   [ { "cid": <32>, "entries": [ { "name": <byte string>, "cid": <32>, "isDir": true | false }, ... ] }, ... ],
  "files":  [ { "cid": <32>, "chunks": [<32>, ...], "mime": <byte string>, "compression": <0..255>, "outputHash": <32>, "content": <byte string> (only when compression is not 0) }, ... ],
  "chunks": { "<32-byte hex id>": <byte string>, ... } }
```

Failures are class `content`.

**Directory**: `entryHash_i = H( H(name_i) ‖ cid_i ‖ u8(isDir_i) )`; `cid == H( 0x02 ‖ H(entryHash_0 ‖ … ‖ entryHash_{n-1}) )` (for no entries, `H` of the empty string). Duplicates and loops as in section 7.

**File**: `mime` is valid UTF-8; `cid == H( 0x01 ‖ H(chunk_0 ‖ … ‖ chunk_{k-1}) ‖ H(mime) ‖ u8(compression) ‖ outputHash )`, the chunk ids concatenated.

- `compression` not 0: the bytes are `content`, and `H(content) == outputHash`. The chunk ids are not read.
- `compression` 0: `outputHash` is zero. The bytes are the chunks in order, each `chunks[id]` with `H(BACKEND ‖ chunk) == id`.

## 10. Names

Names are bytes. BAMFS names and types must be valid UTF-8 (anything else is class `content`), and a leading byte-order mark (`ef bb bf`) is dropped from a name before it is compared or listed, as a browser's `TextDecoder` drops it; two names equal after that are duplicates. ABX FS names are compared and listed as raw bytes. A verifier does not refuse a name for its characters: the listing escapes it (section 11).

## 11. Output

A verifier that accepts a bundle writes exactly this to standard output and exits with status 0:

```
abx-archive/1
project <chain> <org> <token> <key>
root <root>
anchor <number> <hash>                     (absent for agreed)
l2 <number> <hash> <final|claimed|confirmed>   (base and arbitrum only)
not proved <block> <endpoint>,<endpoint>…  (agreed only, in the bundle's order)
store <store>
<one line per directory and file>
end <files> <bytes>
```

Lines end with a single line feed. Each directory line is `d <path>/`; each file line is `f <path> <length> <sha256 hex of its bytes>`. A path is the names from the root joined with `/`, each name's bytes percent-encoded: a byte is written as itself when it is one of `A`-`Z`, `a`-`z`, `0`-`9`, `-`, `.`, `_`, `~`, and as `%` and two uppercase hex digits otherwise (after the BOM rule of section 10 for BAMFS). Lines are sorted by the bytes of the path as printed, a directory's with its trailing `/`; the root directory itself has no line. When the root is a file, the one line is `f  <length> <sha256>` (an empty path). `end` counts file lines and their total bytes.

A verifier that rejects writes one line, `reject <class> <message>`, and exits with status 1. The classes are `container`, `index`, `proof`, `binding`, `param` and `content`, checked in this order: container, index, the binding proof (proof, binding, param), then content. Messages are free text. Any other failure (unreadable file, out of memory) exits with status 2.

When a verifier is also given an output directory, it writes each file under it at its path, with the names percent-decoded, and refuses a bundle with a name that is empty, `.`, `..`, or holds `/` or a zero byte.

## 12. Limits

A verifier may refuse, as class `content`, a bundle whose content is more than 1 GiB in total, nests directories more than 64 deep, or has more than 65,536 entries. Bundles within these limits are accepted.

## 13. Manifest

A manifest is the list of bundles made for a set of projects. It is UTF-8 JSON, written as the index is:

```
{ "format": "abx-archive-manifest/1",
  "versions": [ { "project": {...as in the index...}, "root": <32>, "seen": { "chain block": <number>, "date": "<YYYY-MM-DD>" },
                  "bundles": [ { "bundle": {"/": "<index cid>"}, "proof": "ethereum" | "base final" | "base claimed" | "arbitrum" | "agreed", "anchor": <number or null>, "bytes": <bundle length> }, ... ] }, ... ] }
```

Versions are sorted by chain, org, token, key, then the block they were first seen at; a version's bundles in the order they were made. The manifest is a list, not a proof: each bundle is checked on its own. A bundle can be fetched from IPFS by its index CID: `ipfs dag export <cid>` gives the bundle file back byte for byte.

## 14. Test vectors

`archive/vectors/` holds bundles and, beside each, `<name>.out`: the exact standard output and exit status a verifier must give. Every vector whose name starts with `bad-` must be rejected with the class its `.out` names. A verifier that agrees with all vectors and with section 11 on the real bundles is conforming.
