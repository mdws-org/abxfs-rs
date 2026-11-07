# ABX FS content layer: implementation spec for an independent Rust port

Reference: `@artblocks/abxfs-sdk` 0.2.0 (MIT, Art Blocks), unpacked at `ref/abxfs-sdk-0.2.0/`. Every `src/<file>.ts:<line>` below points into that tree. Cross-checked against the public content-layer spec `specs/abx-fs.md` (https://raw.githubusercontent.com/ArtBlocks/abxfs/main/specs/abx-fs.md, build `abx-fs-freeze-3`) and https://docs.fs.abx.io/docs/protocol. Where the SDK and the spec text agree it is noted as "spec §N agrees"; no disagreement was found.

Scope: chunking, per-chunk compression, every id and CID, directory entries, IPFS CIDs, the read path, the write path and bundling. Orgs, projects, tags, secret scanning and pinning are out of scope.

Conventions in this document:

- `‖` is byte concatenation. All multi-byte integers inside ids and node blobs are **big-endian, unsigned**.
- `keccak256` is Ethereum Keccak-256 (not NIST SHA3-256).
- `u16(x)`, `u32(x)`, `u48(x)` are fixed-width big-endian encodings (`src/nodes.ts:124-141`); a value that does not fit throws.
- "data" = bytes a backend's `retrieve` returns (what readers get per chunk). "input" = bytes handed to the backend (FastLZ stream, or the data itself). "content" = what a reader finally gets for a file (data, or `decode(codec, data)` when a file codec is set).

---

## 0. Canonical addresses

Same address on every chain (CREATE2 through the keyless deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`). `src/canonical.ts:25-38`.

| Contract | Address |
| --- | --- |
| `ChunkStore` | `0x56317b1F45E4c15310135Ea72Fa4d768ca902BCc` |
| `Sstore2Backend` (raw) | `0x3C3AE36F5d8Aff2Dd60c37cA9103D93803c4c844` |
| `FastLzSstore2Backend` | `0x80a4Ec4A4F98358022A5a060F7cB467188fb68E1` |
| `FileStore` | `0x8b6077a1d6953D96687005B9408D56A655b4d155` |
| `DirectoryStore` | `0x4273E4E078F47303Ca15b11959eeb61F3FC94c11` |
| `IpfsCidResolver` (optional) | `0x7CE58c2945CbE3C2bDb0D3d276Ba3b9bD294008d` |

Chains with these deployed: Base 8453, Base Sepolia 84532, Ethereum 1, Sepolia 11155111, Arbitrum One 42161, Arbitrum Sepolia 421614 (`src/canonical.ts:69-112`).

The backend address is hashed into every chunk id (as its 20 raw bytes), so CIDs only match other clients when these two backend addresses are used (`src/plan.ts:14-16`, `src/plan.ts:397-408`).

---

## 1. Pipeline overview

`planFile` (`src/plan.ts:131-177`), the only planning path; dry-run, draft and real upload all call it (`src/upload.ts:258-282`, `src/draft.ts:245-274`):

```
mime    = args.mimeType || inferMimeType(path)                       # plan.ts:143
max     = backends.maxInputSize ?? 24_575                             # plan.ts:144, :36
codec   = (bytes.len == 0) ? ZERO : (args.codec ?? ZERO)              # plan.ts:145
data    = codec != ZERO ? encode(codec, bytes) : bytes                # plan.ts:148
outHash = codec != ZERO ? keccak256(bytes) : ZERO                     # plan.ts:149
pieces  = data.len == 0 ? [] : fastcdcSplit(data, defaultParamsFor(max))   # plan.ts:150
chunks  = pieces.map(p => planChunk(p, backends, fastLz = (codec == ZERO && args.fastLz != false)))  # plan.ts:151
tree    = packChunkTree(chunks.ids, chunks.sizes)                     # nodes.ts:247-282
fileCid = keccak256(0x31 ‖ tree.root ‖ keccak256(utf8(mime)) ‖ codec ‖ outHash)   # nodes.ts:383-396
```

Directories: `planDirectoryTree` folds `path → fileCid` into a tree, packs each directory's entries, and returns directories children-first (`src/plan.ts:223-274`).

---

## 2. Chunking (FastCDC with a Gear hash)

Entry point: `chunkBytes(bytes, { backendMax })` = `fastcdcSplit(bytes, defaultParamsFor(backendMax))` (`src/chunking/index.ts:38-41`). The planner always passes `backendMax = 24_575` (`src/plan.ts:36`, `:150`). Content-defined, not fixed-size.

### 2.1 Parameters

`defaultParamsFor(max)` (`src/chunking/fastcdc.ts:52-60`):

| Param | Formula | Value for 24,575 |
| --- | --- | --- |
| `min` | `floor(max * 0.5)` | 12,287 |
| `target` | `floor(max * 0.75)` | 18,431 |
| `hardMax` | `max` | 24,575 |

Masks (`src/chunking/fastcdc.ts:74-77`, `:101-102`):

```
log2   = floor(log2(max(2, target)))     # 14 for 18,431
strict = log2 + 1                        # 15  -> strictMask = 0x7FFF
loose  = max(1, log2 - 1)                # 13  -> looseMask  = 0x1FFF
```

Spec §5 "Canonical packing" agrees (min 12,287, target 18,431, max 24,575, low 15 bits before `target`, low 13 bits after).

### 2.2 Gear table

256 `u32` values from Mulberry32 seeded with `0xba5e5eed`, table[i] = i-th output (`src/chunking/gear-table.ts:18-42`):

```
s = 0xba5e5eed                            # u32
for i in 0..256:
    s = s.wrapping_add(0x6d2b79f5)
    t = s
    t = (t ^ (t >> 15)).wrapping_mul(t | 1)
    t = t ^ ( t.wrapping_add( (t ^ (t >> 7)).wrapping_mul(t | 61) ) )
    GEAR[i] = t ^ (t >> 14)
```

All arithmetic is `u32` wrapping; `>>` is logical. This is equivalent to the JS (`Math.imul`, `>>> 0`, and `t ^= t + imul(...)` where the JS sum is reduced mod 2^32 by `^=`'s ToInt32).

Check values (computed for this spec with an independent Python port of the above, not by running the SDK; confirm against `GEAR_TABLE` exported at `src/chunking/gear-table.ts:53`):

| | Value |
| --- | --- |
| `GEAR[0..8]` | `0xdfdc2d53 0xaa637a57 0xd20ff763 0x682331f8 0xfe950442 0x441c029e 0x4f2e6f0f 0x23e06a5d` |
| `GEAR[255]` | `0xc4b3875b` |
| XOR of all 256 | `0x59df477b` |
| sum mod 2^32 | `0x3e55e013` |
| entries with low 15 bits zero / low 13 bits zero | none / none |

The last row agrees with spec §5: "with this gear table no single byte matches the 15-bit mask from a fresh hash".

### 2.3 Split algorithm (exact)

`src/chunking/fastcdc.ts:92-163`:

```
fn fastcdc_split(bytes, min, target, hard_max) -> Vec<&[u8]>:
    n = bytes.len()
    if n == 0: return []                                   # :97
    if n <= min: return [bytes[0..n]]                      # :98
    out = []; pos = 0
    while pos < n:
        remaining = n - pos
        if remaining <= min: out.push(bytes[pos..n]); break          # :109-112
        search_start = pos + min
        target_end   = min(pos + target,   n)
        hard_end     = min(pos + hard_max, n)
        h: u32 = 0                                         # fresh hash per chunk, :119
        cut = None
        i = search_start
        while i < target_end:                              # phase 1, strict mask, :127-139
            h = (h << 1) ^ GEAR[bytes[i]]                  # u32 wrapping shift
            if h & strict_mask == 0: cut = i + 1; break
            i += 1
        if cut is None:
            while i < hard_end:                            # phase 2, loose mask, :144-153
                h = (h << 1) ^ GEAR[bytes[i]]              # h CONTINUES from phase 1
                if h & loose_mask == 0: cut = i + 1; break
                i += 1
        if cut is None: cut = hard_end                     # :156
        out.push(bytes[pos..cut]); pos = cut
    return out
```

Resulting bounds: every non-final chunk is `min+1 ..= hard_max` bytes; the final chunk is whatever remains (it may be ≤ `min`, or up to `hard_max` when the end of input arrives before a boundary).

---

## 3. Per-chunk compression and backend choice

### 3.1 Decision

`planChunk(data, backends, { fastLz })` (`src/plan.ts:106-122`):

```
max = backends.maxInputSize ?? 24_575
require data.len >= 1
backend = backends.raw; input = data
if backends.fastLz is set and fastLz != false:
    packed = flz_compress(data)
    if packed.len < data.len and packed.len <= max:        # STRICT shrink, plan.ts:113
        backend = backends.fastLz; input = packed
require input.len <= max
inputHash = keccak256(input)
dataHash  = (input is data) ? inputHash : keccak256(data)
id = chunkId(backend, inputHash, dataHash, data.len)
```

When FastLZ is on (default): `fastLz` is `codec == ZERO && args.fastLz !== false` (`src/plan.ts:151`). With a file codec, every chunk goes to the raw backend.

| Case | Backend |
| --- | --- |
| no codec, FastLZ strictly shrinks the chunk | `FastLzSstore2Backend 0x80a4…68E1` |
| no codec, FastLZ does not shrink (≥ data length) | `Sstore2Backend 0x3C3A…c844` |
| file codec set (gzip etc.) | `Sstore2Backend` always |
| `fastLz: false` option | `Sstore2Backend` always |

Inputs under 16 bytes never compress (the compressor emits pure literals, at least `len + 1` bytes), so they always go raw.

### 3.2 FastLZ compressor (Solady `LibZip.flzCompress`, level 1)

Port of Solady's assembly, byte-identical to it (`src/fastlz.ts:1-19`; spec §10 "the SDK's compressor is byte-identical to Solady's `flzCompress` (pinned by golden vectors)"). Not ariya's reference FastLZ. Exact algorithm (`src/fastlz.ts:21-121`):

```
HASH_SIZE = 0x2000                                     # 8192 entries, i32, zero-initialised (:21, :37)
u24(p)   = d[p] | d[p+1] << 8 | d[p+2] << 16           # little-endian (:24-26)
hash(v)  = ((2654435769 * v) >> 19) & 0x1fff          # v < 2^24, product fits u64 (:29-31)

literals(runs, src):                                   # :40-50
    while runs >= 32: emit 0x1f, d[src..src+32]; src += 32; runs -= 32
    if runs == 0: return
    emit runs-1, d[src..src+runs]

mt(l, dist):                                           # :53-69
    dd = dist - 1
    while l >= 263: emit 224 + (dd >> 8), 253, dd & 0xff; l -= 262
    if l >= 7:      emit 224 + (dd >> 8), l - 7, dd & 0xff; return
    emit (l << 5) + (dd >> 8), dd & 0xff

cmp(p, q, e):                                          # :75-83
    e = e - q; l = 0
    while l < e:
        if d[p+l] != d[q+l]: return l + 1              # deliberate +1
        l += 1
    return l

set_next_hash(ip): htab[hash(u24(ip))] = ip; return ip + 1   # :85-88

compress(d):
    len = d.len; ip_limit = len - 13 (signed); a = 0; ip = 2         # :90-92
    while ip < ip_limit:
        loop:                                                         # :98-109
            s = u24(ip); h = hash(s)
            r = htab[h]; htab[h] = ip
            dist = ip - r
            if !(ip < ip_limit): break
            ip += 1
            if dist <= 0x1fff and s == u24(r): break
        if !(ip < ip_limit): break                                    # :110
        ip -= 1
        if ip > a: literals(ip - a, a)
        l = cmp(r + 3, ip + 3, ip_limit + 9)                          # :113
        mt(l, dist)
        ip = set_next_hash(set_next_hash(ip + l))                    # :115
        a = ip
    literals(len - a, a)                                              # :119
```

Notes that matter for byte equality:

- Unset hash slots hold offset 0, so position 0 is a real match candidate (`src/fastlz.ts:37`, `:101`).
- `ip_limit` is signed; for `len <= 15` the main loop never runs and the output is pure literals (`src/fastlz.ts:93-94`). Solady works on memory pointers, so it never underflows either.
- The match end bound is `ip_limit + 9 = len - 4`.
- Opcode layout: top 3 bits of the control byte `t = c >> 5`; `t == 0` literal run of `c+1` bytes; `1..6` short match of length `t+2`, distance `((c & 0x1f) << 8 | next) + 1`; `7` long match, next byte `+9` is the length, then the distance low byte (`src/fastlz.ts:146-170`).

### 3.3 FastLZ decompressor (reference only)

`src/fastlz.ts:131-173`. Readers never need it: `ChunkStore.read` inflates on chain (spec §10). It throws on truncated runs and on back-references before the output start, where Solady would read out of bounds; and caps output at 256 MiB by default.

### 3.4 File-level codecs (off chain)

`src/compression.ts`. A label is a `bytes32`: a lowercase ASCII token matching `^[a-z0-9][a-z0-9._+-]{0,31}$`, left-aligned, zero-padded (`src/compression.ts:27-35`). Zero means none. Known labels: `gzip`, `br`, `zstd`, `deflate` (zlib format, RFC 1950) (`src/compression.ts:60-64`). `codecName` rejects non-zero bytes after the first zero (`src/compression.ts:41-58`).

| | No codec | With codec |
| --- | --- | --- |
| Chunked bytes | content | `encode(content)` |
| Per-chunk FastLZ | yes when it shrinks | no, all raw |
| `outputHash` | zero | `keccak256(content)` |
| Empty content | n/a | codec forced to zero (`src/plan.ts:145`) |

Encoders in the SDK: Node `zlib.gzip/brotliCompress/deflate` with default options (`src/compression.ts:117-119`), or the browser `CompressionStream` (`src/web-codecs.ts:77-91`). See open question Q1: the encoded bytes, and therefore the CID, depend on that encoder.

---

## 4. Ids and CIDs

### 4.1 Domain prefixes

`src/cid.ts:36`, `src/nodes.ts:57-60`; spec §2 agrees.

| Prefix | Id |
| --- | --- |
| `0x30` | chunk id |
| `0x31` | file CID |
| `0x32` | directory CID |
| `0x41` | chunk node id |
| `0x42` | entry node id |

### 4.2 Chunk id

`src/cid.ts:50-66` (= `ChunkStore.chunkId`):

```
chunkId = keccak256( 0x30 ‖ backend:20 ‖ inputHash:32 ‖ dataHash:32 ‖ u48(size) )
```

| Offset | Len | Field |
| --- | --- | --- |
| 0 | 1 | `0x30` |
| 1 | 20 | backend address (raw bytes) |
| 21 | 32 | `keccak256(input)` |
| 53 | 32 | `keccak256(data)` |
| 85 | 6 | `size` = data length, big-endian, `1 ..= 2^48-1` |

Preimage length 91 bytes. For a raw chunk `inputHash == dataHash`.

### 4.3 Node ids

`nodeId = keccak256(prefix ‖ blob)` (`src/nodes.ts:113-118`), prefix `0x41` for chunk nodes, `0x42` for entry nodes. Blob 1 ..= 24,575 bytes (`NODE_MAX_BYTES`, `src/node-gas.ts:66`).

#### Chunk leaf (level 0)

`src/nodes.ts:262-273`, `src/node-gas.ts:138`. No count field.

| Offset | Len | Field |
| --- | --- | --- |
| 0 | 1 | `0x00` (level) |
| 1 + 38·i | 32 | chunk id i |
| 33 + 38·i | 6 | `u48(data size of chunk i)` |

Blob size `1 + 38·n`, `1 ≤ n ≤ 512` in the SDK (contract accepts 646). Throws if the leaf's byte total exceeds 2^48-1 (`src/nodes.ts:275`).

#### Branch (level k = 1..3), both kinds

`src/nodes.ts:183-197`, `src/node-gas.ts:140`.

| Offset | Len | Field |
| --- | --- | --- |
| 0 | 1 | `k` (level) |
| 1 | 2 | `u16(n)` children, `2 ≤ n ≤ 128` |
| 3 + S·i | 32 | child node id i |
| 3 + S·i + 32 | 4 | `u32(cumulativeCount_i)` |
| 3 + S·i + 36 | 6 | `u48(cumulativeBytes_i)`, **file branches only** |

`S = 42` for file (chunk-node) branches, `36` for directory (entry-node) branches. Cumulative fields are inclusive prefix sums: `cumulativeCount_i = Σ_{j≤i} child_j.count` (items, i.e. chunks or entries, in the whole subtree), `cumulativeBytes_i = Σ_{j≤i} child_j.size` (data bytes). Directory nodes have size 0 and carry no bytes field.

#### Entry leaf (level 0)

`src/nodes.ts:343-371`, `src/node-gas.ts:142`; spec §5 "Entry leaf" agrees.

```
0x00 ‖ u16(count) ‖ u16(offset_0) … u16(offset_{count-1}) ‖ record_0 … record_{count-1}
record_i = u8(nameLen) ‖ nameBytes ‖ u8(isDirectory ? 1 : 0) ‖ cid:32
offset_i = byte offset of record_i from the START OF THE RECORDS AREA (i.e. from blob offset 3 + 2·count); offset_0 = 0
```

Blob size `3 + 2·count + 34·count + Σ nameLen`. Records are in sorted name order (§5.2).

### 4.4 File CID

`src/nodes.ts:383-396` (= `FileStore.fileCid`):

```
fileCid = keccak256( 0x31 ‖ root:32 ‖ keccak256(utf8(mimeType)):32 ‖ codec:32 ‖ outputHash:32 )
```

Preimage 129 bytes. Rules (each throws, mirroring `createFile` reverts): mime UTF-8 length 1..127 bytes; `codec == 0` iff `outputHash == 0`; root zero (empty file) requires codec zero. `root` is the tree root id (the single leaf if there is one leaf), or `0x00…00` for the empty file.

### 4.5 Directory CID

`src/nodes.ts:399-404` (= `DirectoryStore.directoryCid`):

```
directoryCid  = keccak256( 0x32 ‖ root:32 )
EMPTY_DIRECTORY = keccak256( 0x32 ‖ 0x00×32 )      # exists on chain without being created
```

### 4.6 Content-defined node partition (canonical packing)

All constants in `src/node-gas.ts:65-96`; spec §5 table agrees. Every one is part of every CID.

| Constant | Value | Line |
| --- | --- | --- |
| `NODE_MAX_BYTES` | 24,575 | :66 |
| `NODE_MAX_LEVEL` | 3 | :68 |
| `BRANCH_MAX_CHILDREN` | 128 | :70 |
| `CHUNK_LEAF_MAX_HASHES` | 512 | :72 |
| `CHUNK_LEAF_MIN_HASHES` | 32 | :74 |
| `CHUNK_LEAF_BOUNDARY_ODDS` | 128 (threshold 2^25) | :76 |
| `ENTRY_LEAF_MIN_BYTES` | 4,096 | :78 |
| `ENTRY_LEAF_TARGET_BYTES` | 4,096 | :80 |
| `BRANCH_BOUNDARY_ODDS` | 32 (threshold 2^27) | :82 |
| `ENTRY_LEAF_GAS_CAP` | 7,000,000 | :87 |
| `ENTRY_LEAF_PACKING` | `{ base 75,000, perByte 205, perRecord 11,000, perNameByte 170 }` | :96 |

Keys (`src/node-gas.ts:248-255`):

```
hashKey(id32)   = u32::from_be_bytes(id32[0..4])            # top 32 bits of a chunk id or node id
nameKey(name)   = hashKey(keccak256(nameBytes))             # name bytes only, no length prefix
```

**Chunk leaves** (`src/node-gas.ts:340-353`), keys = `hashKey(chunkId)` in file order:

```
out = []; cur = 0
for k in keys:
    cur += 1
    if cur == 512 or (cur >= 32 and k < 2^25): out.push(cur); cur = 0
if cur > 0: out.push(cur)
```

**Entry leaves** (`src/node-gas.ts:308-337`), items = `(nameLen, nameKey)` in sorted name order:

```
blob(c, b)  = 3 + 2c + 34c + b
cost(c, b)  = 75_000 + 205·blob(c,b) + 11_000·c + 170·b           # frozen, node-gas.ts:99-106
out = []; count = 0; nb = 0
for (len, key) in items:
    if count > 0 and (blob(count+1, nb+len) > 24_575 or cost(count+1, nb+len) > 7_000_000):
        out.push(count); count = 0; nb = 0                          # flush BEFORE adding
    count += 1; nb += len
    recordBytes = 36 + len                                          # 2 offset + 1 len + name + 1 flag + 32 cid
    if blob(count, nb) >= 4096 and key < floor(recordBytes · 2^32 / 4096):   # = recordBytes << 20
        out.push(count); count = 0; nb = 0
if count > 0: out.push(count)
```

The frozen cost cap binds before the byte cap for every name length (60 records at 255-byte names, 323 at 8-byte names). `packEntryTree` accepts an `opts.leafGasCap` override (`src/nodes.ts:328`), but every planner path uses the default 7,000,000 (`src/plan.ts:270`).

**Branch grouping** (`src/node-gas.ts:263-288`), keys = `hashKey(childNodeId)` of the current level's nodes in order, `n ≥ 2`:

```
sizes = []; cur = 0
for i in 0..n:
    cur += 1
    if cur == 128 or (cur >= 2 and keys[i] < 2^27): sizes.push(cur); cur = 0
if cur > 0: sizes.push(cur)
last = sizes.len - 1
if sizes[last] == 1 and last > 0:
    if sizes[last-1] < 128: sizes.pop(); sizes[last-1] += 1
    else: sizes[last-1] = 127; sizes[last] = 2
```

**Stacking** (`src/nodes.ts:155-223`): `current = leaves; level = 0; while current.len > 1 { level += 1; if level > 3 throw PlanTooLargeError(levels); group current by branchGroupSizes; build branch blobs at this level; current = branches }`. Root = the last node built; a single leaf is the root at level 0. Nodes are emitted leaves first, then each level (children before parents). No items → root zero, no nodes (`src/nodes.ts:109-111`).

Early refusal: `assertTreeLevels` uses the minimum-level bound `branchLevelsNeeded(ceil(n/512))` for files and the real leaf count for directories (`src/nodes.ts:229-241`, `:255`, `:340`; `src/node-gas.ts:294-302`). The real check is during stacking.

Gas fields on nodes (`estimatedGas`, the `edges` map in `stackBranches`) do not enter any blob or id; only `ENTRY_LEAF_PACKING`/`ENTRY_LEAF_GAS_CAP` affect layout.

---

## 5. Directories and entries

### 5.1 Name rules and encoding

Contract rules, enforced by `assertEntryName` (`src/nodes.ts:289-300`; spec §5 agrees): 1..255 bytes; not `.` or `..`; no `0x2f` (`/`) and no `0x5c` (`\`). Nothing else (NUL, control bytes, invalid UTF-8 are legal on chain).

Name bytes (`src/names.ts`):

- Names from a file system or a person are literal text: UTF-8 encoded as given, with **no Unicode normalization**. A backslash anywhere in an upload path is refused, as is a lone UTF-16 surrogate (`src/names.ts:170-180`, `src/plan.ts:196-202`).
- Names read from chain keep their exact bytes (`nameBytes`); their text form is UTF-8 with `\xHH` (lowercase hex) for each byte not in a well-formed sequence (`src/names.ts:78-104`), and `encodeEntryName` inverts it exactly (`src/names.ts:126-145`). Packing uses `nameBytes` when present, else `encodeEntryName(name)` (`src/names.ts:162-164`). A Rust port can carry `Vec<u8>` names and skip the text form except for display and path parsing.

Upload path rules (`src/util.ts:82-91`, `src/plan.ts:183-202`): non-empty, not starting with `/`, `/`-separated, no empty, `.` or `..` segment; no backslash; each file path unique. A segment may not be both a file and a directory (`src/plan.ts:234`, `:244`).

### 5.2 Sorting and packing

Entries are sorted by unsigned byte-lexicographic order of name bytes, shorter prefix first (`src/nodes.ts:303-307`, `:321`); duplicates throw (`src/nodes.ts:322-326`). Rust `Vec<u8>`/`[u8]` `Ord` is exactly this order. Then `partitionEntryLeaves` (§4.6), leaf blobs (§4.3), `stackBranches` with prefix `0x42` (`src/nodes.ts:315-375`).

Each entry: `cid` = the child's file CID, or directory CID (`EMPTY_DIRECTORY` for an empty subdirectory); `isDirectory` = 1 for directories.

### 5.3 Folding paths into a tree

`planDirectoryTree(files, { emptyDirectories })` (`src/plan.ts:223-274`):

```
root = {files: map, dirs: map}
for (path, cid) in files: split on '/', descend creating dirs, insert file name -> cid
for d in emptyDirectories: validate, descend(d.split('/'))          # creates empty dirs
walk(node, path):                                                   # post-order
    entries = files as (name, cid, false) + for each subdir: (name, walk(child), true)
    pack, cid = directoryCid(root)
    height = 0 if no subdir else 1 + max(child heights)
    emit {cid, path, entries sorted, tree, height}
```

Insertion order is irrelevant (packing sorts). Output is children-first; the root directory (path `""`) is last.

### 5.4 Mime type

Default `inferMimeType(path)` (`src/util.ts:43-79`): `ext = path.toLowerCase().split(".").pop()`; map lookup; fallback `application/octet-stream`. Map: html/htm `text/html`, css `text/css`, js/mjs `application/javascript`, json `application/json`, md `text/markdown`, txt `text/plain`, csv `text/csv`, xml `application/xml`, svg `image/svg+xml`, png `image/png`, jpg/jpeg `image/jpeg`, gif `image/gif`, webp `image/webp`, avif `image/avif`, ico `image/x-icon`, wasm `application/wasm`, pdf `application/pdf`, woff `font/woff`, woff2 `font/woff2`, ttf `font/ttf`, otf `font/otf`, mp3 `audio/mpeg`, mp4 `video/mp4`, webm `video/webm`, zip `application/zip`, gz `application/gzip`, br `application/brotli`. The mime describes the final content (spec §5). An explicit `mimeType` is used verbatim (no case folding); empty string falls back to inference (`src/plan.ts:143`, `src/upload.ts:104`, `:197`). Any path is accepted for inference; see trap T14.

### 5.5 Single-file vs directory upload

| | `uploadFiles` (`src/upload.ts:95-164`) | `uploadSingleFile` (`src/upload.ts:189-202`) |
| --- | --- | --- |
| Root | directory CID of the folded tree, even for one file | the file CID itself |
| `rootKind` | `"directory"` | `"file"` |
| Directories written | all from `planDirectoryTree` | none |

A one-file `uploadFiles` wraps the file in a root directory with one entry named by its path. Draft/publish: `draftRootIsDirectory` treats a draft as file-kind when it has exactly one live file whose CID equals the root and no empty directories (`src/draft.ts:385-390`); `applyFileReplacement` names that file `"file"` by default (cosmetic, `src/draft.ts:753`).

### 5.6 Hidden files and ignore lists

The SDK planner filters nothing: every path given is planned. The folder walkers (CLI and web app, not in this package) read `src/upload-skip.ts:7-23`: never walk `node_modules`, `.DS_Store`, `dist`, `build`, `out`, `.next`, `.turbo`, `cache`, `broadcast`; `.git` skipped unless hidden files are included; `.well-known` uploaded even when other dot-names are skipped. Spec §8 says ABX FS keeps dotfiles (`ipfs add --hidden`). See open question Q2.

---

## 6. IPFS CIDs

`src/cid.ts`; spec §8 agrees on every point below. Profile = `ipfs add -r --cid-version=1 --hidden` with Kubo defaults.

| Parameter | Value | Line |
| --- | --- | --- |
| CID | v1, sha2-256, lowercase base32 (RFC 4648, no padding), prefix `b` | `cid.ts:89-92` |
| CID bytes | `0x01 ‖ codec ‖ 0x12 ‖ 0x20 ‖ sha256` (36 bytes for both codecs here) | `cid.ts:256` |
| Raw codec | `0x55` | |
| dag-pb codec | `0x70` | |
| Leaf size | 262,144 (256 KiB), fixed | `cid.ts:23` |
| Max links | 174 | `cid.ts:24` |
| Shard threshold | estimate **>** 262,144 | `cid.ts:253`, `:279-283` |

### 6.1 Files

Derived over **content** (decoded codec, inflated FastLZ), so independent of backends and codec (`src/plan.ts:20-21`, `src/verify.ts:194-204`).

```
ipfs_file(bytes):                                   # cid.ts:110-118
    if len <= 262_144: return (raw_cid(sha256(bytes)), tsize = len)      # inclusive; includes len 0
    leaves = 262,144-byte slices, last one shorter; each raw CID, totalSize = cumulative = len
    layer = leaves
    while layer.len > 1:                            # cid.ts:183-191
        layer = [wrap(layer[i..i+174]) for i in step 174]
    return root.cid, tsize = root.cumulative

wrap(children):                                     # cid.ts:195-219
    filesize = Σ child.totalSize
    Data  = 0x08 0x02 ‖ 0x18 varint(filesize) ‖ for c: 0x20 varint(c.totalSize)   # cid.ts:221-233
    Links = for c: { Hash = c.cid bytes, Name = "" , Tsize = c.cumulative }
    block = dag-pb encode(Links, Data); cid = dag-pb CID(sha256(block))
    cumulative = block.len + Σ child.cumulative
```

`blocksizes` are content sizes (`totalSize`); `Tsize` is cumulative serialized size. Varints are unsigned LEB128 (`src/cid.ts:235-244`).

### 6.2 dag-pb encoding

Links first, then Data (`src/cid.ts:349-362`):

```
PBLink = 0x0a varint(len(hash)) hash ‖ 0x12 varint(len(name)) name ‖ 0x18 varint(tsize)
node   = for link: 0x12 varint(len(PBLink)) PBLink   ‖   0x0a varint(len(Data)) Data
```

`Name` is always emitted, even when empty (`0x12 0x00`) (spec §8 "PBLink"). File nodes are encoded by `@ipld/dag-pb` (not shipped in the package); spec §8 states the same layout.

### 6.3 Directories

`src/cid.ts:320-337`:

```
links = entries.map(e => (nameBytes(e), CID bytes of child, child tsize))
if Σ (name.len + cid.len) > 262_144: error DirectoryNeedsSharding            # every entry counts, subdirs too
sort links by unsigned byte order of name; duplicate name -> error
Data  = 0x08 0x01                                     # UnixFS Type = Directory; empty dir block = 0a020801
block = encode(links, Data); cid = dag-pb CID
tsize(dir) = block.len + Σ child tsize                # verify.ts:221-222
```

Child tsize: a file's `tsize` from §6.1; a subdirectory's from this formula. Spec §13 vectors: empty file `bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku`; empty directory `bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354` (block `0a020801`, tsize 4).

---

## 7. Read path

All reads are `eth_call`s. Signatures from the ABI mirror (`src/abi.ts`; generated from `forge inspect`).

### 7.1 Contract views

`ChunkStore 0x56317b1F…2BCc`:

| Function | Returns |
| --- | --- |
| `chunkId(address backend, bytes32 inputHash, bytes32 dataHash, uint48 size)` pure | `bytes32` |
| `exists(bytes32 id)` | `bool` |
| `read(bytes32 id)` | `bytes data` (checked against record; inflated for FastLZ; reverts `RetrieveFailed(id, backend)` / `DataMismatch(id)` / `ChunkNotFound(id)`) |
| `recordOf(bytes32 id)` | `(address backend, uint48 size, bytes32 pointer, bytes32 dataHash)` |
| `sizeOf(bytes32 id)` | `uint48` |
| `multicall(bytes[] data)` payable | `bytes[]` |

`FileStore 0x8b6077a1…d155`:

| Function | Returns |
| --- | --- |
| `fileExists(bytes32 cid)` | `bool` |
| `getFileInfo(bytes32 cid)` | `(bytes32 root, uint8 rootLevel, uint256 chunkCount, uint256 size, string mimeType, bytes32 codec, bytes32 outputHash)` as one tuple |
| `chunkCount(bytes32 cid)` | `uint256` |
| `getChunkId(bytes32 cid, uint256 index)` | `bytes32` |
| `getChunkIds(bytes32 cid, uint256 start, uint256 end)` | `bytes32[]` (`[start, end)`) |
| `locateByte(bytes32 cid, uint256 offset)` | `(uint256 index, uint256 chunkStart, bytes32 chunkId, uint256 chunkSize)` |
| `readChunk(bytes32 cid, uint256 index)` | `bytes` (through `ChunkStore.read`) |
| `getNode(bytes32 nodeId)` | `(bytes blob, uint8 level, uint32 count, uint48 size)` |
| `nodeExists(bytes32 nodeId)` | `bool` |
| `fileCid(bytes32 rootNode, string mimeType, bytes32 codec, bytes32 outputHash)` pure | `bytes32` |
| `chunkStore()` | `address` |

`DirectoryStore 0x4273E4E0…4c11`:

| Function | Returns |
| --- | --- |
| `directoryExists(bytes32 cid)` | `bool` (true for `EMPTY_DIRECTORY`) |
| `rootOf(bytes32 cid)` | `bytes32` |
| `entryCount(bytes32 cid)` | `uint256` |
| `getEntry(bytes32 cid, uint256 index)` | `(string name, bytes32 cid, bool isDirectory)` |
| `getEntries(bytes32 cid, uint256 start, uint256 end)` | `(string name, bytes32 cid, bool isDirectory)[]` |
| `lookup(bytes32 dirCid, string name)` | `(bytes32 cid, bool isDirectory)` |
| `resolvePath(bytes32 rootCid, string path)` | `(bytes32 cid, bool isDirectory)`; ≤ 32 segments per call (`PathTooDeep`) |
| `getNode(bytes32 nodeId)` / `nodeExists(bytes32)` | as FileStore |
| `directoryCid(bytes32 rootNode)` pure, `EMPTY_DIRECTORY()`, `fileStore()` | |

Backend views (`storageBackendAbi`, `src/abi.ts:8-92`): `retrieve(bytes32 pointer) → bytes`, `readable() → bool`, `retrieval() → (bytes32 scheme, string instructions)`, `maxInputSize() → uint256`, `store(bytes input, address caller) → bytes32` (ChunkStore only).

### 7.2 How the SDK walks a root back to bytes

File (`readFile`, `src/read.ts:431-461`):

1. `getFileInfo(cid)`.
2. Chunk ids: `getChunkIds(cid, s, e)` in pages of `PAGE_MAX = 100` (`src/read.ts:48`, `:358-397`), 4 pages in flight.
3. Chunk data: `ChunkStore.multicall([read(id)...])` via `eth_call` (`src/read.ts:586-746`). Slicing: ≤ `BLIND_READ_CHUNKS` (computed 8) in one call with no records; ≤ 64 tried as one call, then sized on refusal; more than 64 always sized from `recordOf` (256 per call). Slice budget 25,000,000 estimated gas, ≤ 64 chunks; estimates: raw backend `30_000 + 6·size`, any other backend `30_000 + 125·size`, plus memory `3·words + words²/512` (`src/read.ts:52-106`, `:530-556`). A refused call is halved; a gas refusal halves the budget for the rest; Erigon's `--rpc.returndata.limit` message re-plans within that limit.
4. Join in order. If `codec ≠ 0`: decode, require `keccak256(content) == outputHash` (`src/read.ts:451-458`).

Directory (`readDirectory`, `src/read.ts:773-848`): `entryCount`, then `getEntries` in pages of 100. The SDK decodes the `string` outputs of `getEntries`/`getEntry` as raw `bytes` (same ABI encoding), never as UTF-8 text (`src/read.ts:163-176`, `:784-804`). `lookup`/`resolvePath` send names as raw bytes ABI-encoded in the `string` slot when they are not plain UTF-8 (`src/read.ts:200-219`). Paths deeper than 32 segments are resolved in runs of 32 from the directory the last run ended at (`src/read.ts:901-920`).

A reader that wants to verify structure can instead walk `getNode` blobs and parse §4.3; the SDK does not.

### 7.3 Kind of a root

CIDs carry no kind bit. Ask both `DirectoryStore.directoryExists` and `FileStore.fileExists` (`src/kind.ts:25-43`).

---

## 8. Write path

### 8.1 Write calls

| Call | Contract | Args |
| --- | --- | --- |
| `write(address backend, bytes input, bytes32 dataHash, uint48 size) → bytes32 id` | ChunkStore | `size` = data length (`src/multicall.ts:578-596`) |
| `putChunkNode(bytes blob) → bytes32` | FileStore | blob from §4.3 |
| `createFile(bytes32 rootNode, string mimeType, bytes32 codec, bytes32 outputHash) → bytes32 cid` | FileStore | the empty file is `createFile(0, mime, 0, 0)` |
| `putEntryNode(bytes blob) → bytes32` | DirectoryStore | blob from §4.3 |
| `createDirectory(bytes32 rootNode) → bytes32 cid` | DirectoryStore | never sent for the empty directory |

All writes are idempotent (an existing id is a no-op). Each store inherits Solady `Multicallable`: a bundle is `store.multicall(bytes[] innerCalldata)` sent to that same store (delegatecall to itself, so `msg.sender` is the signer), not Multicall3 (`src/multicall.ts:94-176`, `src/gas.ts:4-6`).

### 8.2 Probe, then stages

`probeContentPlan` (`src/content-write.ts:157-250`), three batched rounds (`multicall` of views, 150 per `eth_call`, `src/multicall.ts:335`, `:523-571`):

1. `fileExists` / `directoryExists` for every planned file/directory (deduplicated by CID, first occurrence wins).
2. `nodeExists` for every node of the missing ones (deduped by id). An entry node's `wave` = the lowest `height` of any missing directory containing it (`src/content-write.ts:184-192`).
3. `exists` for chunk ids named by **missing leaves only** (an existing leaf implies its chunks exist), in order of first appearance (`src/content-write.ts:202-228`).

Stages, in order (`src/content-write.ts:295-407`); empty stages omitted:

1. `chunks`: `ChunkStore.write` for every missing chunk.
2. `chunk-nodes`: one stage per level ascending (0, 1, 2, 3).
3. `files`: `createFile` for every missing file.
4. For each wave (directory height) ascending: `entry-nodes` one stage per level ascending, then `directories` (`createDirectory`) for directories of that height.

Before simulating each stage the executor polls existence of everything the previous stage wrote until visible (`src/content-write.ts:428-437`, `:475-512`); at the end it waits for the root itself.

### 8.3 Gas estimates (only affect bundling, never ids)

Schedules (`src/gas-schedule.ts:46-69`):

| | legacy | eip8037 |
| --- | --- | --- |
| `codeDepositPerByte` | 200 | 1,530 |
| `newAccount` | 32,000 | 183,600 |
| `newSlot` | 22,100 | 97,920 |
| `newSlotExecution` | 0 | 12,100 |
| `newAccountExecution` | 0 | 12,000 |
| `stateGasDimension` | false | true |

`stateGas(code, accounts, slots) = code·codeDeposit + accounts·newAccount + slots·newSlot` (`src/gas-schedule.ts:78-84`). Detection: `eth_estimateGas` of a CREATE2 of 1 byte through the keyless deployer, `> 120,000` means eip8037; fallback by chain id (Sepolia 11155111 = eip8037, else legacy) (`src/gas-schedule.ts:101-145`).

Per call, `estimatedGas = execution + state`, `estimatedStateGas = state`:

- `ChunkStore.write` (`src/gas.ts:292-311`): execution `30_000 + 24·inputLen + decode + 3·newSlotExec + newAccountExec`; `decode = 0` when `dataLen == inputLen`, else `140·literals + 270·matches + 58·steps + 6·dataLen` from `flzDecodeWork(input)` (`src/fastlz.ts:193-214`: `steps += ceil(l / min(s, 32))` per match); state `stateGas(inputLen + 1, 1, 3)`.
- Node (`src/node-gas.ts:153-159`, `:166-222`): execution = the kind's execution + `newSlotExec + newAccountExec`; state `stateGas(blobLen + 1, 1, 1)`. Executions, with `nodeBase 30_000`, `nodePerByte 25`:
  - chunk leaf: `30_000 + 25·blob + 8_500·n`
  - entry leaf: `30_000 + 25·blob + 5_900·count + 12·nameBytes`
  - file branch: `30_000 + 25·blob + 4_000·n`
  - directory branch: `30_000 + 25·blob + 11_900·n + 6_500·2·(n-1)·(level-1) + 4·edgeNameBytes`, where `edgeNameBytes = Σ over adjacent child pairs of (last name length under left child + first name length under right child)` (`src/nodes.ts:198-208`; 255 assumed if unknown).
- `createFile` (`src/node-gas.ts:225-240`): `slots = (mimeBytes ≤ 31 ? 1 : 1 + ceil(mimeBytes/32)) + (root ≠ 0 ? 1 : 0) + (codec ≠ 0 ? 2 : 0)`; execution `15_000 + (1_000 + newSlotExec)·slots`; state `slots·newSlot`.
- `createDirectory` (`src/node-gas.ts:243-245`): execution 25,000; state `newSlot`.

### 8.4 Bundle packing

Greedy first-fit, order preserved, one target per bundle (`src/gas.ts:217-255`):

```
new bundle: gas = 5_000 (multicallBase) + 5_000 (dispatch) + call.gas; state = call.state; bytes = 4 + 64 + calldataOf(call)
append if same target and calls < 100 (MAX_BUNDLE_CALLS) and
    gas + 5_000 + call.gas <= maxBundleGas and
    (gas - state) + 5_000 + (call.gas - call.state) <= maxBundleExecutionGas and
    bytes + calldataOf(call) <= maxBundleCalldataBytes
calldataOf(call) = ceil(innerLen/32)·32 + 64
```

Limits (`src/gas.ts:418-467`; caller default `bundleGasBudget = 12_000_000`, `src/upload.ts:239`):

| | legacy | eip8037 |
| --- | --- | --- |
| `maxBundleGas` | `min(budget, floor(2^24·0.75) = 12,582,912, floor(blockGasLimit·0.8) if known)` | `min(floor(simCap·0.9), floor(blockGasLimit·0.8) if known)`, `simCap` default 50,000,000 → 45,000,000 |
| `maxBundleExecutionGas` | unbounded | `min(budget, 12,582,912)` |
| `maxBundleCalldataBytes` | `floor(12,582,912 / 40) = 314,572` | `floor(12,582,912 / 64) = 196,608` |

`2^24 = 16,777,216` (EIP-7825, `src/gas-schedule.ts:87`). Single-call refusal ceilings (no layout effect): legacy `floor(2^24·0.97)`; eip8037 total `floor(simCap·0.97)`, execution `floor(2^24·0.97)` (`src/gas.ts:478-509`).

Sending (`src/multicall.ts:94-176`): bundles are sent sequentially; each is simulated (`multicall` on the target), then sent; a local key manages its own nonce and doubles fees on a 45 s stall up to 3 times. A bundle refused for gas before sending (empty revert data, or Solady `DeploymentFailed()` selector `0x30116425`) is split in halves (`ceil(n/2)` first) up to depth 3 (`src/multicall.ts:35-75`, `:153-158`).

---

## 9. Traps (things a naive port gets wrong)

| # | Trap | Where |
| --- | --- | --- |
| T1 | Chunking is FastCDC, not fixed 24 KiB. The hash is reset at offset `min` of every chunk, not at the chunk start, and is NOT reset between the strict and loose phases. | `src/chunking/fastcdc.ts:119-153` |
| T2 | The cut includes the matching byte (`cut = i + 1`). A tail of ≤ `min` bytes is one chunk; input ≤ `min` is one chunk. | `src/chunking/fastcdc.ts:98`, `:109-112`, `:136` |
| T3 | Gear values are Mulberry32 `u32` outputs with JS int32 semantics; the shift in the rolling hash is a `u32` wrapping `<< 1`. Using a 64-bit gear or another table changes every boundary. | `src/chunking/gear-table.ts:26-35`; `src/chunking/fastcdc.ts:134` |
| T4 | FastLZ must be Solady's variant: hash table zero-initialised (offset 0 is a candidate), `ip` starts at 2, `ip_limit = len − 13`, match bound `len − 4`, `cmp` returns matched+1, distance cap 0x1fff. ariya FastLZ or `lz4_flex` produce other bytes and other chunk ids. | `src/fastlz.ts:21-121` |
| T5 | FastLZ is used only on a STRICT shrink (`packed.len < data.len`); equal length goes raw. | `src/plan.ts:113` |
| T6 | `size` in the chunk id and in leaf records is the DATA length (uncompressed), `inputHash` is over the compressed stream. | `src/cid.ts:50-66`; `src/plan.ts:119-121`; `src/nodes.ts:271` |
| T7 | The backend address is part of the chunk id; using any other raw/FastLZ backend address forks every CID. | `src/cid.ts:65`; `src/plan.ts:397-408` |
| T8 | Chunk leaves have no count header (`0x00 ‖ records`), while branches and entry leaves do (`u16`). | `src/nodes.ts:262-273` vs `:184-185`, `:347` |
| T9 | Branch cumulative fields are inclusive prefix sums, not per-child values; file branches carry a 6-byte byte total, directory branches do not (stride 42 vs 36). | `src/nodes.ts:161-197` |
| T10 | Entry-leaf offsets are relative to the records area, not the blob start. | `src/nodes.ts:348-358` |
| T11 | Node boundaries come from hash keys (top 32 bits, big-endian, of the chunk id / child node id / `keccak256(name)`), with minimums, maximums and the trailing-one-child fix; filling leaves front to back gives other ids. | `src/node-gas.ts:248-353` |
| T12 | The entry-leaf maximum is the frozen cost `75,000 + 205·blob + 11,000·count + 170·nameBytes ≤ 7,000,000`, checked before adding a record; it binds long before the 24,575-byte cap. It is not the tunable `NODE_GAS` model. | `src/node-gas.ts:87-106`, `:318-322` |
| T13 | The entry boundary threshold uses `recordBytes = 36 + nameLen` (includes the 2-byte offset), and the leaf minimum is on the whole blob size (`>= 4096`, header included). | `src/node-gas.ts:325-329` |
| T14 | `inferMimeType` lowercases the whole path and takes the text after the LAST `.` of the whole path: `README` → `application/octet-stream` (ext "readme"), a top-level file named exactly `html` → `text/html`, `a.b/c` → fallback. The mime string is hashed, so any difference forks the file CID. No mime normalization (case, parameters) is applied to an explicit mime. | `src/util.ts:43-79`; `src/plan.ts:143` |
| T15 | Mime is hashed separately: `keccak256(utf8(mime))` inside the file CID preimage, not the raw string. | `src/nodes.ts:393-395` |
| T16 | Empty content: no chunks, root `0x00…00`, codec forced to zero even if one was asked for, but `createFile` is still required. The empty directory is never created (it exists). | `src/plan.ts:145`, `:150`; `src/nodes.ts:109-111`, `:404` |
| T17 | With a file codec, chunking runs over the ENCODED stream, all chunks are raw, `outputHash = keccak256(original)`. IPFS CIDs are still over the original content. | `src/plan.ts:145-151`; `src/plan.ts:387-391` |
| T18 | Names are bytes, sorted unsigned byte-wise, shorter prefix first; never decode `getEntries` names with a lossy UTF-8 decoder (U+FEFF stripping, U+FFFD replacement merge names). No Unicode normalization anywhere: NFC vs NFD (macOS) names are different entries and different CIDs. | `src/names.ts:1-28`; `src/read.ts:163-176`; `src/nodes.ts:303-307` |
| T19 | A one-file directory upload is a directory root wrapping that file; a single-file upload's root is the file CID. | `src/upload.ts:95-202` |
| T20 | `packEntryTree` takes a `leafGasCap` override that changes CIDs; canonical packing is always the default. | `src/nodes.ts:328` |
| T21 | IPFS `Tsize` is cumulative (block + all descendants); `blocksizes` are content sizes; empty `Name` is still emitted; directory Data is exactly `08 01`; a file of exactly 262,144 bytes is one raw block. | `src/cid.ts:110-118`, `:195-233`, `:332`; spec §8 |
| T22 | Kubo sharding test is `Σ(nameLen + 36) > 262,144` over all entries including subdirectories, strictly greater; such a directory has no flat IPFS CID and must be refused, not derived flat. | `src/cid.ts:253-283`, `:326` |
| T23 | Reading FastLZ chunks is expensive (inflated on every `read`); 64 per call can pass a 50M `eth_call` cap. Plan slices from `recordOf` sizes. | `src/read.ts:52-106`, `:586-746` |
| T24 | `resolvePath` accepts at most 32 segments per call; chain longer paths. | `src/read.ts:854`, `:901-920` |
| T25 | Bundles must use each store's own `multicall(bytes[])`; a bundle may not mix targets; ChunkStore passes `msg.sender` to the backend as `caller`. | `src/gas.ts:204-216`; spec §4 |
| T26 | Under EIP-8037 a full chunk write is ~38.7M total gas: one chunk per transaction. Packing only by a 2^24 total refuses or mis-splits on Sepolia. | `src/gas.ts:436-467`; `src/gas-schedule.ts:1-25` |
| T27 | Gas estimates and the `edges` map never touch blobs or ids; changing the gas model must not change packing. | `src/nodes.ts:198-217`; `src/node-gas.ts:89-96` |

---

## 10. Open questions

- **Q1. File codec output is not pinned.** With `gzip`/`br`/`deflate`/`zstd`, chunks are cut from `encode(content)` produced by Node `zlib` defaults (`src/compression.ts:117-119`) or the browser `CompressionStream` (`src/web-codecs.ts:87`). Header bytes (gzip OS byte, mtime) and deflate output can differ between zlib builds and between Node and browsers, so a gzip file's CID may not be reproducible across clients even in the reference SDK. A Rust port can only match a given SDK run by reproducing that exact encoder. Recommend: Rust port treats codec files as "CID reproducible only with identical encoded bytes", and the codec-less default path as the byte-exact target.
- **Q2. Hidden-file and ignore rules.** The walker logic (when dotfiles are skipped, how `--hidden` interacts with `.git` and `.well-known`) lives in the CLI/web packages, not in this SDK; only the name lists are here (`src/upload-skip.ts`). Spec §8 says ABX FS keeps dotfiles. Matching CLI-produced roots for a folder needs the CLI source.
- **Q3. Path normalization in the CLI.** The SDK does no Unicode normalization; whether the CLI normalizes file-system names (e.g. NFC on macOS) before calling the SDK is unknown.
- **Q4. Golden vectors are not in the npm package.** `test/nodes.test.ts`, `test/fixtures/*`, and `contracts-core/test/GoldenVectors.t.sol` pin chunk ids, node splits and FastLZ outputs. They are in the GitHub repo `ArtBlocks/abxfs`; fetch them for the Rust test suite rather than generating vectors from this port.
- **Q5. IPFS multi-level layout.** The SDK groups leaves bottom-up in runs of 174 (`src/cid.ts:183-191`). This should equal Kubo's balanced builder for all sizes (including a trailing one-child node); the package carries no test above 174 × 256 KiB = 44.5 MiB to confirm it.
- **Q6. `@ipld/dag-pb` behaviour for file nodes.** File nodes go through `dagPB.prepare`/`encode` (not shipped here). The spec states Name is always emitted and links precede Data; the local directory encoder (`src/cid.ts:349-362`) writes the same layout. Confirm with a Kubo vector for a > 256 KiB file.
- **Q7. Hash-of-mime input.** `fileCid` hashes `TextEncoder` UTF-8 of the JS string (`src/nodes.ts:384`); a mime containing a lone surrogate would encode as U+FFFD. Irrelevant for ASCII mimes; a Rust port should reject non-UTF-8 mimes.
