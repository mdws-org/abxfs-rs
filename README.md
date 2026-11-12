# abxfs-rs

An independent Rust implementation of the ABX FS content layer. It computes, offline, every id the official TypeScript SDK computes for a folder upload: FastCDC chunk boundaries, Solady FastLZ per-chunk compression and backend choice, chunk ids, chunk-node and entry-node trees, file CIDs, directory CIDs, the root, and each file's IPFS CIDv1. Files are selected and typed the way the official CLI selects them (`abxfs upload`). It also reads roots back from chain, checking every id against the bytes returned, and compares a local folder with a root on chain.

Implements the ABX FS content layer as specified by Art Blocks' MIT-licensed @artblocks/abxfs-sdk; not affiliated with Art Blocks.

## Build

```
cargo build --release
```

The binary is `target/release/abxfs-rs`.

## Usage

```
abxfs-rs plan <folder> [--no-fastlz] [--include-hidden] [--no-empty-dirs] [--json]
```

- Without `--json`, the command prints the root CID and totals.
- With `--json`, the command prints the whole plan in the field layout of `oracle/golden.mjs`, so a structural diff against the reference output works.
- `--no-fastlz` stores every chunk through the raw backend.
- `--include-hidden` includes dot-files and `.git`, as the CLI's `--include-hidden` does. `.well-known` is always included.
- Empty directories are planned by default, because `abxfs upload` passes them to the SDK. Use `--no-empty-dirs` to plan the scanned files only, which is what `oracle/golden.mjs` does.

```
abxfs-rs read <root> --chain <name> [--rpc URL] [--out PATH] [--in-flight N] [--stats]
abxfs-rs verify <root> <local folder or file> --chain <name> [--rpc URL] [--in-flight N] [--include-hidden] [--no-fastlz] [--stats]
```

`--chain` is one of `base`, `base-sepolia`, `ethereum`, `sepolia`, `arbitrum-one`, `arbitrum-sepolia`, `robinhood`; without `--rpc` the chain's public endpoint (the first the SDK lists) is used. Every request is a read (`eth_chainId`, `eth_call`, `eth_getCode`); nothing is signed or sent.

`read` walks the root breadth-first, all pending objects at once, so the round trips grow with the tree's depth, not its size:

- the first round checks the endpoint's chain id and that the stores and Multicall3 have code, and asks `directoryExists`, `fileExists`, `rootOf` and `getFileInfo` of the root;
- directories: `rootOf`, checked against `keccak256(0x32 ‖ root)`, then every entry node through `DirectoryStore.getNode`, checked against `keccak256(0x42 ‖ blob)` and parsed;
- files: `getFileInfo`, checked against the file CID, then every chunk node through `FileStore.getNode` (`keccak256(0x41 ‖ blob)`);
- chunks: `ChunkStore.recordOf` gives the backend and SSTORE2 pointer. For the two canonical backends the stored input is the pointer's code after its STOP byte, fetched with `eth_getCode` (no `eth_call` gas cap applies), inflated locally for FastLZ, and the chunk id is recomputed from `keccak256(input)`, `keccak256(data)` and the size. Another backend is read with `ChunkStore.read` and `backend.retrieve` and checked the same way;
- branch prefix sums, node levels, `getNode` counts and sizes, `chunkCount` and `size` are checked against the children; a file with a codec (`gzip`, `deflate`, `br`, `zstd`) is decoded and must hash to its `outputHash`.

Views are packed into Multicall3 `aggregate3` calls (sized by estimated return bytes and gas, 25M per call at first); several calls and `eth_getCode`s go in one JSON-RPC batch; at most `--in-flight` (default 8) HTTP requests are open at once. A call the node refuses is split in halves (a gas refusal also halves the budget for the rest); an empty revert inside a group is retried alone; a refused batch is split; HTTP 429/5xx and rate-limit errors back off and retry. Any mismatch stops the read with the object and both values.

With `--out`, a file root is written to PATH and a directory root becomes a new directory at PATH (empty directories included); without it, `read` prints a listing.

`verify` plans the local folder (as `abxfs upload` would, empty directories included) or single file (mime from its name) offline. If its root equals `<root>`, every chunk, chunk node, file, entry node and directory the plan needs is probed for existence on chain. Otherwise the chain's directory structure is read and every path is reported as `missing` (local only), `extra` (chain only) or `changed` (another kind or another CID; a directory whose CID differs only because a file under it is stored codec-encoded, as below, is not listed). `--include-hidden` and `--no-fastlz` plan as for an upload made with them. Planning applies no file codec, and re-encoding locally cannot reproduce the chain's bytes (the SDK does not pin encoder output), so a file uploaded with a file codec (gzip, deflate, br, zstd) never matches by CID. For each `changed` file whose chain copy carries a codec and the same MIME type as the local plan, `verify` reads it (chunk ids checked, decoded, keccak of the decoded bytes checked against `outputHash`) and compares the decoded bytes with the local file, re-planned to the same CID so a file replaced after planning is refused; if equal, the path is listed as `same <path>  same content (stored <codec>-encoded)` and is not counted as a difference. Exit 0 on a full match, or when the roots differ and every differing path is such a codec-encoded file with equal content (the output then says the roots differ only because of the encoding, so a plain root comparison will not match); 1 on any other mismatch; 2 on an error.

Chunk ids are bound to the canonical backend addresses (`Sstore2Backend` 0x3C3AE36F5d8Aff2Dd60c37cA9103D93803c4c844, `FastLzSstore2Backend` 0x80a4Ec4A4F98358022A5a060F7cB467188fb68E1).

## Tests

```
cargo test --release
```

`tests/golden.rs` plans each `oracle/corpus-*` folder with and without FastLZ and compares the result field by field with `oracle/golden/*.json`, which Art Blocks' own SDK and CLI scanner produced. A failure names the first differing JSON path. If `scratch/extra.json` exists (made by `scratch/make-extra.mjs` and `oracle/golden.mjs`), the extra corpus is compared too.

`tests/chain.rs` reads real roots on Base and Base Sepolia with the official CLI and with `abxfs-rs read` and requires byte-identical trees; it runs only with `ABXFS_RS_CHAIN_TESTS=1`. Roots, commands and timings: `tests/README-chain.md`.

## Scope

No writes and no gas estimates. Planning does not encode file codecs (gzip, brotli and the others), because their CIDs depend on the encoder's exact output; reading decodes them and checks `outputHash`. The SDK's single-call gas ceiling check on a plan is not run; the level cap is enforced.

## WebAssembly build and the fs.abx page

`site/` is the page at https://fs.abx.thebenmeadows.com/: it plans a folder in the browser with the same code (`site/pkg/abxfs_bg.wasm`, built from this crate's `wasm` feature) and looks a root up on chain. The built module and its JavaScript glue are committed, so the page deploys without a build step (Cloudflare Pages, Git-connected, headers in `site/_headers`).

To rebuild them (Rust stable, `rustup target add wasm32-unknown-unknown`, `cargo install wasm-bindgen-cli --version 0.2.129`; the glue must come from the same wasm-bindgen version the crate depends on):

```
cargo build --release --target wasm32-unknown-unknown --no-default-features --features wasm
wasm-bindgen --target web --out-dir site/pkg --no-typescript target/wasm32-unknown-unknown/release/abxfs.wasm
node tests/wasm-golden.mjs
```

The committed build (2026-11-06):

```
sha256 827dcdfde48ae7edf1a8fbf71da726690e9b9146e8c78358df2d0593d304e012  site/pkg/abxfs_bg.wasm
sha256 04f952c55d63630d2c6db5fd7eb51e19cb4960cab98bfa28b73e96c45f95cc93  site/pkg/abxfs.js
```

`shasum -a 256 site/pkg/abxfs_bg.wasm site/pkg/abxfs.js` must print these after a rebuild from the same sources and toolchain; a different hash means a different toolchain or different sources, and the page must then be re-tested (`tests/wasm-golden.mjs`, `tests/page-cases.mjs`, `tests/page-check.mjs`).

## Reference material

`SPEC.md` cites `@artblocks/abxfs-sdk` 0.2.0 unpacked at `ref/abxfs-sdk-0.2.0/`. That directory is not in this repository; recreate it with `npm pack @artblocks/abxfs-sdk@0.2.0` and unpack the tarball there. `oracle/golden/` holds the reference outputs produced from it, and the tests compare against those files. The edge-case corpus those outputs were made from is generated, not stored: `node oracle/make-corpus.mjs oracle/corpus-edge` (seeded, so the bytes are the same on every run); the golden and chain tests need it present.

## From-chain viewer

`view/` is a web page that opens an ABX FS project or root by reading it from chain in the browser, with no gateway. A service worker answers every request for its origin from chain reads (`site/chain.js`, shared with the page's root lookup) and checks each file back to the root before serving it: chunks against their records and chunk ids, chunk-tree and directory nodes against their ids, files against their file CIDs, directories against their directory CIDs, and a codec's output against `outputHash`.

The hostname names what is shown, so every project and every root is its own web origin (`site/target.js`):

- `<chain id>-<org address, 40 hex>-<token id>` is a project. Its current root is the token's `abxfs.cid` param. No hash covers that read, so every configured endpoint is asked at the same block (the lowest any of them reports). At least two must answer and all that answer must agree. On Ethereum and Sepolia the root is also read by proof and the two are compared; see "Proving a project's current root" below.
- `r<chain id>-<root, 52 base32 characters>` is one root. Nothing is taken from an endpoint unchecked.

A project's scripts run in the viewer's origin and can write its storage, so nothing stored is trusted. The worker stores raw chain replies only, and each one passes the same checks as a fresh reply every time it is used. Checked results are held in the worker's memory. A reply that fails a check is read again from the same endpoint, then from the next one.

The host serves the same static files on every subdomain and `index.html` for any path that is not one of them. That fallback is required: a browser fetches a service worker script from the host, never through the viewer, so a project that tries to register its own worker gets HTML and is refused. `view/_headers` lists the response headers the host must send. `/_abxfs/info.html` on any viewer hostname lists what was read and checked, and can reset the viewer for that address.

### Proving a project's current root

On Ethereum and Sepolia the viewer reads a project's current root a second way, with no server believed, and compares the result with what the endpoints give.

1. `site/light.js` is a light client for Ethereum's consensus layer. It starts from a finalized block root built into the viewer (`site/checkpoint.js`), fetches that block's sync committee, and follows the committee from period to period up to the present. For each header it uses, it checks the BLS aggregate signature of the sync committee (at least 342 of the 512 members must have signed) and the Merkle branches that tie a committee, a finalized header and an execution block hash to a signed header. The result is the hash of the newest finalized execution block. Both header forms are read: the Electra and Fulu form, and the Gloas form, in which a header carries an execution block hash and no state root.
2. `site/proof.js` takes that block's header from any execution endpoint and re-hashes it. A header that hashes to the proved block hash gives a state root that can be believed. An account proof against the state root gives the contract's code hash and storage root, and a storage proof against the storage root gives one storage word.
3. `site/proved.js` computes where an ABX collection keeps a token parameter: ERC-7201 namespace `abx.storage.params`, slot `keccak(key . keccak(tokenId . base))`, with the `isSet` flag in the next slot. A collection is a 44-byte proxy that can only run one implementation, so the layout cannot change. The viewer proves that the account's code hash is the hash of those 44 bytes and reads nothing from any other contract.

A finalized block is about a quarter of an hour behind the head. The endpoints are therefore asked for the root at the finalized block as well as at the head, and `site/verdict.js` compares:

| At the finalized block | At the head | Verdict |
|---|---|---|
| At least two endpoints answered, and each gives the proved root | The same root | Proved |
| At least two endpoints answered, and each gives the proved root | Another root | Published since the finalized block; agreed by the endpoints, not yet provable |
| An endpoint gives a root that differs from the proof | Any | Mismatch |
| Fewer than two endpoints answered | Any | Agreed by the endpoints; the proof could not be compared |
| No proof could be made | Any | Agreed by the endpoints, with the reason |

The endpoints are asked at the finalized block by its hash, so an endpoint cannot answer for another block. The proved block must also be within 400 blocks of the block the endpoints are at: the light client decides what is recent by the device's clock, and this is a second reading of the time.

On a mismatch the project is not shown. One of the two readings is wrong and the viewer cannot tell which, so the page lists both roots, the block, which endpoint gave which root, and a fixed-root address for each version. The service worker waits 20 seconds for the proof before it answers a page. If the proof arrives later and does not match, the mismatch stands from then on.

A project's own hostname states no verdict. A project's scripts run there and can rewrite any text the viewer shows, the info page included. The verdict is on the check page, `check.<host>/#<chain id>-<org address>-<token id>`, which has no service worker and which a project's scripts cannot reach. Links to a project must open the check page first.

The light client is hand-written and follows the consensus-specs light-client sync protocol; function names match the specification. The curve arithmetic and SHA-256 are `@noble/curves` and `@noble/hashes`, copied into `site/vendor/noble/` by `tools/vendor-noble.py`. `tools/build-view.py` stops if a vendored file does not match `site/vendor/noble/SHA256SUMS`.

The proof depends on three things:

- The block root in `site/checkpoint.js`. `tools/checkpoint.py` writes it only when two independent beacon nodes report the same finalized root and the light client can start from it. The light client refuses a root older than 14 days (the weak-subjectivity period at mainnet's stake is 15.7 days), so a build that is never refreshed stops proving. `.github/workflows/checkpoint.yml` proposes a new root each week as a pull request.
- Fewer than two thirds of each sync committee since that block signing a false header. Committee members are not penalised for doing so. The comparison with the endpoints exists for this case and for a fault in the viewer's own checks.
- The fork schedule in `site/light.js`. A fork can change the header fields and the Merkle positions. `tools/fork-watch.py` exits 1 when a beacon node reports a fork that `light.js` does not list, and `.github/workflows/watch.yml` runs it every day. A header from an unknown fork fails its checks, and the viewer then shows the endpoints' root with no proof.

The host can switch proving off for every installed viewer by serving `{"proof": false}` at `/_abxfs/switch.json`. Use it if a fault is found in the proof code. A worker that has read the switch as off keeps proving off for as long as it runs. The switch cannot turn proving on, and it cannot change a verdict.

### Base

Base's state reaches Ethereum as claims. Every 6,000 Base blocks a claim about Base's state is posted as a contract on Ethereum (a dispute game). A claim becomes final 5 days after it is posted if nobody wins a challenge to it. In the ten days measured, every claim carried one proof, from Base's own permissioned prover.

`site/base.js` reads the claims by proof at the finalized Ethereum block of the section above:

1. OptimismPortal2, AnchorStateRegistry and DisputeGameFactory are upgradeable. Each one's implementation address is proved and must be the one whose storage layout was read from verified source. After an upgrade nothing is claimed until `base.js` is brought up to date.
2. The registry gives the anchor game (the newest claim that has become final), the respected game type, and the time before which games are retired. The factory gives the newest game. Anyone may add a game of another type to the factory's list, so the newest game of Base's type among the last four entries is taken, and the check page says why when it does not count.
3. A game is a 98-byte clone of the AggregateVerifier implementation with its claim in its code. The game's code hash is proved, the code an endpoint gives must hash to it, and the claim and the Base block number are read from it. The factory's record of the game is proved, as are its status, that it is not blacklisted, and that it is not retired.
4. A claim is an output root: `keccak(0 . state root . message passer storage root . block hash)`. The Base block's header, re-hashed, and the message passer's account proof must give the claimed output root. The project's root is then read by storage proof at that Base block, as on Ethereum.

The check page compares the endpoints' current root with the root at each claim (`judgeRollup` in `site/verdict.js`):

| The current root equals | Verdict |
|---|---|
| The root at the anchor claim | Matches the state Base has made final on Ethereum |
| The root at the newest claim | Matches Base's newest claim on Ethereum, which is not final |
| Neither | Agreed by the endpoints; published after the newest claim |

A verdict on Base never stops a page. A claim that is not final rests on Base's own prover, and a final one is days old, so the page shown is always the current root the endpoints agree on.

Proofs at the anchor's Base block need an endpoint that keeps state for 5 days. One public endpoint was found that does (`BASE_PROOF_ENDPOINTS` in `site/base.js`). If it does not answer, the anchor comparison is not made and the check page says so.

### BAMFS projects

BAMFS is the file store ABX FS grew out of. A project published to it keeps its root in the token parameter `bamfs.cid`, and its files in older store contracts that the ABX FS stores do not know. BAMFS's own gateway no longer serves them.

When a token has no `abxfs.cid`, the viewer reads `bamfs.cid` under the same agreement rule, and `site/bamfs.js` reads the tree. It covers both generations of the store. The second generation (FileStoreV2, DirectoryStoreV2) keeps directories and files as trees of nodes; the first keeps flat lists. In both, every reply is checked back to the root: node ids, directory and file CIDs, chunk hashes, and for a compressed file the hash of its decoded bytes. Which generation a root belongs to is settled by which store knows it and then by the hashes. A fixed-root address (`r<chain id>-<root>`) works for a BAMFS root as well.

The root of a BAMFS project is proved and compared like any other, with `bamfs.cid` as the parameter that is read.

### Token pages

Many ABX contracts keep their artwork in `tokenURI` and have no ABX FS root: image tokens, and code projects whose page the contract assembles from stored script. For those the viewer serves the token's own page at the same hostname (`site/token.js`). `tokenURI` (or `uri` on an ERC-1155 contract) is asked of every endpoint at one block, each host name once. At least two must answer, and all that answer must return the same bytes. An empty reply counts as an answer. The reply must be a `data:` URI holding JSON. Its `animation_url`, when it is an HTML `data:` URI, is the page; otherwise its `image`, when it is an image `data:` URI, is. The page is exactly those bytes.

A code project whose `tokenURI` points at a resolver still has its page on chain. ABX's generator contract (one per chain, `GENERATORS` in `site/token.js`) builds the page from the script the collection stores, the libraries it names and the token's data. When `tokenURI` holds no page, the viewer asks the generator for `onChainStatus(collection)` and `document(collection, token)` under the same agreement rule and serves that document. A document of a megabyte is more than some endpoints compute in one call, so the proof endpoints are asked as well when fewer than two of the usual ones answer. The check page says when the document loads a library the chain does not hold.

When the metadata, the art it names, or a project's code is at an address off the chain, the viewer says where and shows nothing. It does not fetch it.

A `tokenURI` reply is computed by the contract, so no storage proof covers it. On Base, Arbitrum One and Robinhood Chain the check page says "Agreed by the endpoints. Not proved." for a token page.

### Token pages on Ethereum: the call is run here

On Ethereum and Sepolia the check page runs the contract's call itself. `site/evm.js` is an EVM for view calls, and `site/evm-state.js` gives it state at the finalized block the light client reached: every account, storage word and contract code the call asks for is fetched with a Merkle proof and checked against that block's state root. The endpoints are then asked for the same call at that block, by block hash.

| Check page | What it means |
| --- | --- |
| Recomputed here from proved state, and the endpoints give the same | The reply computed here, the reply of at least two endpoints at the finalized block, and the reply the page is made from are the same bytes |
| Agreed, not yet provable | The reply has changed since the finalized block |
| Warning: this viewer and an endpoint compute different pages | An endpoint returns another reply at the finalized block, or returns one where the call fails here. The page stays open; either the endpoint or this EVM is wrong |
| Agreed by the endpoints. Not proved | The EVM does not run something the call uses, fewer than two endpoints answered at that block, the state could not be read, or the finalized block is more than 400 blocks from the endpoints' |

The EVM runs a fixed list of opcodes and stops at anything else: a write to storage or transient storage, a log, contract creation, a call that sends value, `SELFDESTRUCT`, `CALLCODE`, `BLOCKHASH`, `BLOBBASEFEE`, an account that delegates its code (EIP-7702), and every precompile but SHA-256 and identity. A call that stops is reported as not run. It never produces a reply. Gas is charged as the Osaka rules charge it, so a call given too little gas fails here as it does on chain. A node left to choose gives a call its own gas limit (25, 50, 500 and 550 million were seen on public endpoints), and a contract can read what it has left. So every `eth_call` this viewer compares names 500,000,000 gas (`CALL_GAS` in `site/proved.js`), and the EVM starts with the same amount less what a node takes before the code runs: 21,000, and 4 or 16 for each zero or other byte of call data. An endpoint with a lower limit runs the call with less. `BASEFEE` reads zero and the caller is the zero address, as on a node for a call that names neither a gas price nor a sender. `tests/evm-context-live.mjs` checks 18 such values against the live endpoints.

An endpoint is asked which accounts and storage words the call touches (`eth_createAccessList`) so they can be fetched together. That answer only decides what is fetched early. A word it leaves out is fetched and proved when the EVM asks for it. A 1 MB generator document reads 71 accounts and about 1 MB of contract code and takes about 20 seconds. Most tokens take 2 to 4.

A generator document is shown because of two other replies: the generator's status for the collection, and a `tokenURI` that holds no page. Both calls are run here as well, and "recomputed" is said only when they give what the endpoints gave. When the document loads a library from an address off the chain, the check page says that nothing covers what that address serves.

The call runs in a worker (`view/evm-worker.js`), so the page stays responsive. A run stops after 60 seconds of computing or 120 seconds of fetching, and at 600 requests; the page ends the worker itself after 200 seconds. A browser that cannot start a worker gets "Agreed by the endpoints. Not proved." What a hint asks for may use half of those requests and 4,000 storage words.

The viewer's own pages (the service worker) still serve the reply the endpoints agree on. Only the check page says whether that reply was also recomputed.

### Arbitrum One and Robinhood Chain

Both run the same rollup contract on Ethereum (`site/arbitrum.js`). Its storage holds the hash of the newest confirmed assertion, read by proof at the finalized Ethereum block. An assertion's hash is `keccak(parent . keccak(state after it) . inbox accumulator)`, and the state after it holds the hash of a rollup block. What the hash was made from comes from the `AssertionCreated` log an endpoint gives, and must hash to it. The rollup block's header, re-hashed, gives its state root, and the project's root is read there by storage proof. The rollup contract is a proxy with two implementations; both addresses are proved and must be the pinned ones.

A confirmed assertion is about 6.4 days old. The check page says "Matches the state Arbitrum One has made final on Ethereum" when the endpoints' current root is the root at that block, and "Agreed by the endpoints" otherwise. No public endpoint was found that serves proofs on Robinhood Chain at a block that old, so for Robinhood the assertion is read and the root is not, and the check page says so.

What is left to trust, and how to reduce it:

- The host serves the viewer's own code. `tools/build-view.py` prints one SHA-256 for the build and writes each file's hash to `_abxfs/files.js`; the info page shows both, so any host can be compared with this repository. Once a project has been opened, the worker and its pages keep working if the host stops answering (`tests/host-gone.mjs`).
- The endpoints are public servers run by other people. A reader can name their own on the info page, such as their own node. It is asked first for every read that is checked against the root, and never for a project's current root: the setting lives in storage a project's scripts can write, so it is kept out of the one unchecked read (`tests/endpoint-setting.mjs`).

Limits: the two canonical SSTORE2 backends only, files up to 64 MiB and 16,384 chunks, and the codecs the browser's `DecompressionStream` has (`gzip` and `deflate` in every current browser). A project's own service worker does not run, and a project folder named `_abxfs` cannot be opened. The host that serves the viewer's code is trusted to serve this code.

Run it locally:

```
tools/build-view.py
tools/view-serve.py        # then open http://8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0.localhost:8853/
```

Tests. The first two take a folder written by `abxfs-rs read <root> --chain <chain> --out <folder>`:

```
node tests/chain-read.mjs base <root> <folder>            # same bytes as abxfs-rs; no changed reply is accepted
node tests/view-check.mjs http://<label>.localhost:8853/ <folder>   # the same, through the service worker in a browser
node tests/head-rule.mjs                                  # the current-root rule against made-up endpoints
node tests/host-gone.mjs http://<label>.localhost:8853/ <pid of view-serve.py>   # a project still opens after the host is stopped
node tests/endpoint-setting.mjs http://<label>.localhost:8853/   # the reader's own endpoint: refused, saved, planted, cleared
node tests/hostile-page.mjs http://<label>.localhost:8853/ /index.html   # what a project's own scripts can try: a worker of their own, rewriting storage
```

Tests of the proof. All but the three marked "live" run offline, and `.github/workflows/ci.yml` runs the offline ones on every push:

```
node tests/spec-vectors.mjs     # the official single_merkle_proof vectors: light.js's Merkle positions and branch function
node tests/light-replay.mjs     # recorded mainnet and Sepolia replies, then one lie planted at a time; each must be refused
node tests/light-synth.mjs      # a made-up chain whose committee keys the test holds: 341 and 342 signers, cancelling keys, padded branches
node tests/light-mutants.mjs    # light.js with one check removed at a time; each removal must fail a test
node tests/proof-replay.mjs     # recorded proofs from four chains, RLP cases, hand-built tries
node tests/proof-mutants.mjs    # proof.js with one check removed at a time
node tests/verdict.mjs          # the verdict table
node tests/verdict-mutants.mjs  # the rule for computed pages with one condition removed at a time
node tests/token.mjs            # reading a tokenURI reply, and the agreement rule against made-up endpoints
node tests/bamfs-replay.mjs     # recorded reads of both BAMFS generations, then altered and targeted lies; FastLZ cases
node tests/bamfs-mutants.mjs    # bamfs.js with one check removed at a time
node tests/base-rules.mjs       # each rule for Base's contracts on Ethereum, against a made-up state
node tests/base-replay.mjs      # a recorded read on Base at a claim's block, then one digit changed in every reply
node tests/base-mutants.mjs     # base.js with one rule removed at a time
node tests/arbitrum-rules.mjs   # each rule for an Arbitrum-family rollup contract, against a made-up state
node tests/arbitrum-mutants.mjs # arbitrum.js with one rule removed at a time
node tests/settle.mjs           # the service worker stops on a mismatch and only on a mismatch
node tests/light-live.mjs mainnet            # live: from a finalized root two beacon nodes report to an execution block
node tests/proved-live.mjs                   # live: a project's root by proof through each proof endpoint
node tests/base-live.mjs                     # live: Base's anchor and newest claims, and a project's root at each
node tests/arbitrum-live.mjs                 # live: the confirmed assertion of Arbitrum One and Robinhood Chain
node tests/token-page.mjs                    # live: token pages in a browser equal an independent read of tokenURI
node tests/worker-page.mjs                   # live: the check page's worker runs a call, is ended when it never answers, and may be missing
node tests/evm-context-live.mjs              # live: gas left, base fee, caller and 15 more values, the same here and on the endpoints
node tests/evm-live.mjs                      # live: 8 real calls run here over proved state equal eth_call at the finalized block
EVM_DIR=<dir> node tests/evm-fuzz.mjs 3000   # generated programs here and in @ethereumjs/evm: the same outcome, output and gas
EVM_DIR=<dir> node tests/evm-mutants.mjs     # evm.js with one rule or cost changed at a time; each must fail the comparison
node tests/bamfs-live.mjs [dir]              # live: every file of four BAMFS projects, checked to the root; writes them to dir
node tests/check-page.mjs                    # live: the check page in a browser (needs tools/view-serve.py running)
LODESTAR_DIR=<dir> node tests/light-lodestar.mjs   # the same recordings and lies given to Lodestar's light client
```
