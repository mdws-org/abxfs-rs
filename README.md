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

`--chain` is one of `base`, `base-sepolia`, `ethereum`, `sepolia`, `arbitrum-one`, `arbitrum-sepolia`; without `--rpc` the chain's public endpoint (the first the SDK lists) is used. Every request is a read (`eth_chainId`, `eth_call`, `eth_getCode`); nothing is signed or sent.

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
