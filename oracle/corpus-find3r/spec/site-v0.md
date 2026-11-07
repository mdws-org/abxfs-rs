# Onchain Web v0 — retrieval spike

Status: implemented read path and Find3r static browser; proposed address convention.
See [Find3r client boundaries](find3r-v0.md). No extension is required.
Source review: 2026-10-02. No Art Blocks API, indexer, gateway, or event logs are
required by the implementation.

## 1. Reuse the deployed BAMFS representation

BAMFS already supplies directory nodes, file metadata, compression identifiers,
chunk records, and ABX project identity. There is no additional site manifest.
An entrypoint is normally `/index.html`; directory indexes and browser navigation
are renderer work, not part of this byte-recovery spike.

ABX's generic `AbxChunkStore` is a different storage interface. A BAMFS site should
be read through BAMFS `DirectoryStore`, `FileStore`, and `ContentStore`, not by
assuming that its CID is an ABX reader pointer or scraping `tokenURI` artifacts.

Sources: [BAMFS architecture](https://docs.bamfs.xyz/docs/protocol),
[projects](https://docs.bamfs.xyz/docs/using-bamfs/projects),
[ABX storage](https://docs.abx.io/docs/protocol/onchain-storage),
[ABX parameters](https://docs.abx.io/docs/protocol/params).

## 2. Identity and versions

Proposed reader address:

```text
web3://COLLECTION:CHAIN_ID/TOKEN_ID/v/VERSION/path
```

The parser requires an address, explicit chain, unsigned decimal token, and a
positive version. A bare `/TOKEN_ID/` normalizes to `/TOKEN_ID/v/1/` in this
prototype. **It never means latest.** Version belongs in the displayed canonical
address. Paths cannot contain encoded separators, traversal segments, control
characters, or ambiguous percent-encoded names.

BAMFS projects are mutable NFTs; `bamfs.cid` identifies their current head.
The hook stores append-only numbered history. A fixed version selects one root
without relying on the current head, owner, mutable tag, ENS, or hosted metadata.
Read the fixed hook deployment directly, including for an old version whose
collection configuration might subsequently change. A retrieved root CID is
also retained in receipts for direct content recovery.

This token-style path is **not generic ERC-4804 compliance**. In ERC-4804 auto
mode the first path component is a Solidity method name, not a token id.
Manual mode requires the target contract to implement the corresponding resolver.
This client explicitly implements a narrow BAMFS convention; a standard adapter
or different standard-native address is still needed for interoperability with
other web3 clients. ERC-6860 remains a draft. Sources:
[ERC-4804](https://eips.ethereum.org/EIPS/eip-4804),
[ERC-6860](https://eips.ethereum.org/EIPS/eip-6860).

## 3. Deployment map

These are protocol addresses, not RPC endpoints. They were checked against the
[published deployment table](https://docs.bamfs.xyz/docs/reference/deployments)
and the BAMFS web client's public ABIs.

| Component | Address on Base 8453 and Base Sepolia 84532 |
| --- | --- |
| ContentStore | `0xd4a0FFa88a58ee7Bb7e802E7079EE90C8DA52250` |
| FileStore | `0xaa79Ce91da95367fD79bF5d718B055d31EB9CfD3` |
| DirectoryStore | `0x16FA2Ecac2B898FB91dc17bae843C7D0E6d8531f` |
| BamfsProjectHook | `0xc2Aa83414a6860b6e6Fd9151ea4e53fC3A0bdb28` |
| StorageBackend | `0x91520CDaaaB44267e99D08FEA7730D7A7C60E9c2` |

| Chain | ABX BAMFS project collection |
| --- | --- |
| 8453 | `0x10DDfcbcD62E784c522D0B466eD109FC65B2a855` |
| 84532 | `0x7015Ab36fA7d62dAf286561114E7f3c250511E31` |

These are the original shared-collection deployments, retained for historical
retrieval. New orgs use the separate generation below. Hash verification is not
an audit of contract authority or a consensus-verifying light client.

### Org generation and content v2 (2026-10-12)

`orgs.json` records the immutable factory `0xf3AE3a2C811fC60526793c88a051cf1Bc2CDd3F6`,
hook `0x8556b2f339e5B5e652EA94cBb6EC80399c978e13`, enumeration
`0x0c6B1113cC434F8829439FE51e63Ba10f4dB4f56`, FileStoreV2
`0x13036662e483335Ff9C6F30e8852A4694E9A2154` and DirectoryStoreV2
`0xB9411b8fc6Fa3CCe85eFb6dd3fFa11f83A54eF72`. ContentStore is shared with v1.
Find3r checks this generation on its four supported networks: Ethereum, Base,
Arbitrum One and Base Sepolia. BAMFS also deploys Arbitrum Sepolia; that network
is not yet exposed by this client. Sources: [deployment table](https://docs.bamfs.xyz/docs/reference/deployments),
[architecture](https://docs.bamfs.xyz/docs/protocol), and the published frontend ABIs.

An arbitrary org address is authenticated by `isOrg(address) returns(bool)` on
the factory, using the pinned block. False is not an app collection. A name,
`abxVersion`, or `bamfs.cid` field alone never authenticates it. Wallet discovery
uses `orgsHeldCount(address) returns(uint256)`,
`orgsHeldSlice(address,uint256 start,uint256 count) returns(address[])`, then
`balanceOfTracked(address org,address owner) returns(uint256)` and the same
`tokensOfOwnerSlice` signature as v1. Org admins are never treated as holders.
The history/param-name ABI is unchanged, using the new hook/collection addresses.

V2 read sequence, after factory authentication and `versionAt`:

1. DirectoryStoreV2: `rootOf(bytes32 cid) returns(bytes32)`.
2. Both v2 stores: `getNode(bytes32 id) returns(bytes blob,uint8 level,uint32 count,uint48 size)`.
   Walk the node children; independently decode and hash each blob. Returned
   count/size/level metadata is not trusted in place of the committed bytes.
3. FileStoreV2: `getFileInfo(bytes32 cid) returns((bytes32 root,uint8 rootLevel,uint256 chunkCount,uint256 size,string mimeType,uint8 compression,bytes32 outputHash))`.
   Verify metadata CID, walk its chunk-node root, compare counts, sizes and level.
4. Read the committed chunk hashes through the same ContentStore calls as v1.
   Verify chunk hashes and sizes, concatenate, decompress codec 6 or leave codec
   0 unchanged, and verify the logical output hash as before.

V2 commitments (`H` is Keccak-256; concatenation uses packed widths):

```text
fileCid = H(0x11 || rootNode || H(UTF8(mime)) || uint8(codec) || outputHash)
directoryCid = H(0x12 || rootNode)
chunkNodeId = H(0x21 || blob)
entryNodeId = H(0x22 || blob)
```

All node integers are big-endian. The first byte is level (0–3). A chunk leaf
is `uint8(0) || (bytes32 hash || uint16 storedSize)*`, with at least one chunk.
An entry leaf is `uint8(0) || uint16 entryCount || uint16 offsets[entryCount] || records`.
Offsets are relative to the records section. A record is
`uint8 nameBytes || UTF8(name) || uint8 isDirectory || bytes32 cid`.
Names are unique and sorted by UTF-8 bytes across the entire directory tree.
A branch is `uint8 level || uint16 childCount || children`, with 2–128 children.
Each directory child is `bytes32 id || uint32 cumulativeEntryCount`;
each file child adds `uint48 cumulativeStoredSize`. Child levels equal parent
level minus one; counts/sizes are recomputed from verified children. Truncation,
extra bytes, invalid offsets, false cumulative totals and over-limit trees fail.
The reader retains existing application limits (512 directory entries/files,
1024 chunks, 16 MiB per file, 32 MiB per package) and caps node traversal at 4096.
Files larger than these bounds need a different client; the protocol supports
larger trees. `core/bamfs-v2.js` is the complete independent implementation.

Historical shared collections always use v1 stores and hashes. Org v2 collections
always use their recorded v2 pair. Never substitute current stores for an older
publication. Other factory generations require documented addresses and adapters.

## 4. Exact raw JSON-RPC sequence

All arguments/results below use standard Solidity ABI encoding. Function selectors
are the first four bytes of Keccak-256 of each function's canonical signature.
The reader uses viem only for ABI and Keccak primitives; not BAMFS/ABX SDKs.

1. `eth_chainId`, with `params: []`. Reject the wrong chain.
2. `eth_blockNumber`, with `params: []`. Pin every subsequent read to that block.
3. `eth_call` to the hook:

   ```solidity
   versionAt(address collection, uint256 tokenId, uint256 version)
       returns ((bytes32 cid, uint40 publishedAt, address publisher))
   ```

4. `eth_call` to DirectoryStore, recursively for the root and child directories:

   ```solidity
   listDirectory(bytes32 cid)
       returns ((string name, bytes32 cid, bool isDirectory)[])
   ```

5. For each file, `eth_call` to FileStore:

   ```solidity
   getFile(bytes32 cid)
       returns ((bytes32[] chunkHashes, string mimeType,
                 uint8 compression, bytes32 outputHash))
   ```

6. For each chunk hash in order, two `eth_call`s to ContentStore:

   ```solidity
   getStorageRecord(bytes32 hash) returns (address backend, bytes32 pointer)
   read(bytes32 hash) returns (bytes data)
   ```

   `read` invokes the recorded backend, which reads SSTORE2 bytecode. No publisher
   service participates. Individual chunk reads avoid one enormous file-wide
   `eth_call` and its gas ceiling. The returned `bytes` is the payload; do not
   strip another STOP byte from it. The ABI wrapper is decoded first.

7. Concatenate payloads in file order. For compression 6, inflate the complete
   FastLZ level 1 stream. Compression 0 means no transformation. Other codecs
   (including gzip, Brotli and per-chunk codecs) are explicitly rejected in v0.
8. Verify content commitments, then write the original bytes unchanged.

Every call has the JSON shape:

```json
{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x…","data":"0xSELECTOR_AND_ABI_ARGUMENTS"},"0xBLOCK_NUMBER"]}
```

The repository's evidence/base-project-0.rpc.json records a complete real
request trace, including addresses and exact calldata.
The standalone file command starts at step 5 after pinning the chain/block.

## 5. Content verification

`H` is Keccak-256; `||` is concatenation. Integers and booleans shown as one-byte
fields really occupy one byte; address occupies 20 bytes; hashes occupy 32.

```text
chunkHash = H(backendAddress || storedChunkBytes)
fileCid = H(0x01 || H(chunkHash[0] || ... || chunkHash[n])
               || H(UTF8(mimeType)) || uint8(compression) || outputHash)
entryHash = H(H(UTF8(name)) || childCid || uint8(isDirectory))
directoryCid = H(0x02 || H(entryHash[0] || ... || entryHash[n]))
```

BAMFS stores entries in sorted order. Preserve their order when verifying.
For compressed files, `outputHash = H(originalBytes)`. For uncompressed files it
must be zero; the chunk hashes already bind the bytes. Reject mismatches at every
level. These checks verify internal content consistency against the selected root;
the RPC is still trusted for chain state and the root binding. This is not a
consensus-verifying light client.

Sources: [format](https://docs.bamfs.xyz/docs/protocol),
[compression](https://docs.bamfs.xyz/docs/using-bamfs/compression).

## 6. Transport and resource limits

The caller selects its RPC. HTTPS is accepted; local nodes may use HTTP on
localhost/127.0.0.1/::1. Redirects and browser cookies are disabled. Provider URLs
and error bodies are excluded from progress, errors and saved traces. Each call
times out after 30 seconds. Sequential calls pause 250 ms between requests; a
public provider may still rate-limit or refuse historical reads.

Limits: 8 MB RPC response, 16 MiB stored/decompressed file, 32 MiB recovered site,
512 files, 1,024 chunks/file, and 16 levels of directory nesting. Invalid paths,
duplicate names, malformed streams, and unsupported compression fail closed.
The CLI requires new destinations and does not overwrite existing files.

The future extension must keep this reader in its privileged context and give
only site bytes to a sandbox. Never send its configured RPC URL to the page.
Find3r supplies an opaque sandbox renderer and a bridge serving only verified
package files. No RPC capability, credentials, or preference state cross that
bridge. Persistent rendered-site storage and wallet injection are not implemented.
