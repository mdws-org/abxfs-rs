# If the archive outlives its keeper

This note is for anyone who finds the ABX archive with nobody left to run it. It says what exists, how to get the art back, how to check it, and how to keep the archive going. Nothing here depends on the person who started it, on a company, or on a paid service.

## What exists

- `archive/ARCHIVE.md`: the format of a bundle. A bundle is one file that holds one version of one ABX project: every byte of its files, and the proof that the project named that version at a stated Ethereum block. This document is the whole definition.
- `archive/manifest.json`: the list of every bundle made, with its IPFS CID, its proof kind and its anchor block. The from-chain viewer serves a copy at `/_abxfs/archive/manifest.json` on its hosts.
- The bundles themselves, pinned on IPFS on two servers, and kept as files on the machine that made them.
- Verifiers that read only the bundle: `abxfs-rs verify-bundle` (Rust, in this repository), and two others written from the specification by other authors (`archive/verifiers/`).
- `archive/vectors/`: test bundles, each with the output a verifier must give.

## Get a bundle

1. Find the project and version in `archive/manifest.json`. A version has one or more bundles. Use one whose `proof` is not `agreed` or `logged` when there is one.
2. Fetch the bundle file by its CID from any IPFS node or gateway: `ipfs dag export <cid> > bundle.car`. The file is the same byte for byte wherever it comes from.
3. If no IPFS node has it, look for a copy of the file anywhere: its name is not important, because the check below does not trust where it came from.

## Check a bundle and get the files

1. Run any verifier: `abxfs-rs verify-bundle bundle.car --out files/`. If two verifiers are at hand, run both: they must print the same lines.
2. If it prints `reject`, the bundle is damaged or forged. Do not use its files.
3. Read the `anchor` line. It names an Ethereum block number and hash. Look that block up on any Ethereum explorer or node you trust. If the hash matches, the files are what the project held at that block. A bundle that prints `not proved` has checked content but no proof of which project named it.
4. Open `files/index.html` (or another file from the listing) in a browser. Most ABX projects are pages that run from their own files.

## Keep the archive going

The daily run needs a machine with Node 22 and a Rust toolchain, and an IPFS node to pin into. It uses only public JSON-RPC endpoints, Ethereum consensus endpoints, and Blockscout's public API (for the logs of Ethereum collections).

1. Clone this repository and build the reader: `cargo build --release --locked`.
2. Run `node tools/archive/daily.mjs <state dir>` once a day. It finds new versions, makes the bundles they lack, and writes `<state dir>/manifest.json`. Keep `<state dir>` between runs: `state.json` remembers what is done.
3. Pin each new bundle: `ipfs dag import --pin-roots <bundle>.car`.
4. Publish the manifest where others can find it, and keep the bundle files somewhere other than one IPFS node.

## What stops it, and what to do

- **A rollup contract is upgraded.** Base and Arbitrum One bundles prove their root through contracts whose implementations section 5 of the format names. After an upgrade, proofs fail with "is not the one format 1 was written for", and the run makes `agreed` bundles instead. To fix it, read the new contracts' verified source, write format 2 with the new constants and rules, and give it new test vectors. Bundles of format 1 stay valid.
- **The light client's starting block is older than 14 days.** The Ethereum proof needs a recent starting block (`site/checkpoint.js`). The repository refreshes it each week. If that stops, take a finalized block root from any two Ethereum consensus nodes and put it in that file.
- **Public endpoints disappear or refuse proofs.** Use any Ethereum and rollup node that serves `eth_getProof`, including your own: `tools/archive/proof.mjs` takes its endpoint lists from `site/proved.js`, `site/base.js` and `site/arbitrum.js`.
- **Blockscout's API disappears.** Past versions are found from the collections' logs. Any explorer or archive node that returns `eth_getLogs` for the event in section 6.6 of the format can replace it.
- **The project contracts or the ABX FS stores are no longer served.** New bundles cannot be made. Existing bundles still check, because they hold every byte and every proof they need.

## License

The code and the format are MIT licensed (see `LICENSE`). The art in the bundles belongs to its artists; the archive keeps it, and does not license it.
