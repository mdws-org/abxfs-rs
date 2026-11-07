# Chain tests

`tests/chain.rs` reads real roots with the official CLI and with `abxfs-rs read` and requires byte-identical trees. It runs only with `ABXFS_RS_CHAIN_TESTS=1`:

```
ABXFS_RS_CHAIN_TESTS=1 cargo test --release --test chain -- --test-threads=1
```

The oracle is `tests/oracle_read.py`, which calls nothing but the official CLI (`@artblocks/abxfs-cli` 0.1.2, path overridable with `ABXFS_CLI`): `abxfs read <root> -o <file>` for a file root; for a directory, `abxfs read <root> [--path <dir>]` to list each directory and `abxfs read <root> --path <file> -o <dest>` for each file.

## Roots

All were published through the canonical freeze-3 contracts. They were found read-only from `DirectoryCreated` logs of `DirectoryStore` and `FileCreated` logs of `FileStore`, from each store's deployment block (Base Sepolia 52,713,516; Base 53,439,829) to the head on 2026-11-06.

| Chain | Root | Kind | Content |
| --- | --- | --- | --- |
| base-sepolia | `0xc63421c7cdd9644ade5fcf2ea1605b40b603486dabdf12433165f2e8d0a21944` | directory | 6 files, 3 directories: an empty file, an empty directory, a nested `sub/`, a 122,884-byte JPEG (6 chunks), 86,050 bytes of text (4 chunks) |
| base-sepolia | `0xa2893e53b3067fce8bfac986427ee0e0195b82f2d1cf86ef7b307f914df18ab8` | directory | the same tree with another `style.css` (used by the verify test) |
| base-sepolia | `0x6a905f037744a4240660ed7bf5e11a48832a1c8c7b0f24cedc07a8915bfb60b5` | directory | 3 files, 3 directories |
| base-sepolia | `0xd9537eb4a9b77796909556200362f022a3200d21ef9d9e23f9fd80cc2df8fa67` | directory | 4 files |
| base-sepolia | `0x074dcfcdd0ad8852450742ab0725b606eaa12b6ec15e5708aa95b6b2c3d75c2b` | file | 5,300,000 bytes of text, 216 chunks (44 distinct), FastLZ |
| base | `0x8cd42455acde236bc9ee195565ad2f38e97778850d0be4792e82655b0200f522` | directory | 3 files |
| base | `0xa3c966cf8a3122c3f882bf365a3cd9f08de512f2402d8c52cfcbb925fe4cb0b0` | directory | one `index.html` stored with the `gzip` file codec: 235,822 stored bytes in 11 chunks, 797,054 bytes decoded |
| base | `0xdd9734bb11178f281cfbea5762c17e7a6aa6f1b61f87dc013af08460258835bb` | directory | 2 files |

`tests/chain.rs` reads the first, third, fifth, sixth and seventh. All eight were compared by hand the same way (`diff -r` of the two trees): all byte-identical, empty file and empty directory included.

## By hand

```
python3 tests/oracle_read.py <root> <chain> /tmp/official
target/release/abxfs-rs read <root> --chain <chain> --out /tmp/ours
diff -r /tmp/official /tmp/ours

target/release/abxfs-rs verify <root> /tmp/official --chain <chain>    # exit 0
```

`verify` checks on the same data:

- each official tree against its own root: roots equal, every chunk, node, file and directory present (exit 0);
- the tree of `0xa2893e53…` against root `0xc63421c7…`: exactly one difference, `changed style.css`, the one entry where the CLI's two listings differ (exit 1);
- a copy of `0xc63421c7…` with a changed, an added, a renamed file and a new subdirectory: each reported as changed, missing or extra (exit 1);
- the decoded tree of `0xa3c966…` (base, gzip `index.html`) against its own root: roots differ, `same index.html  same content (stored gzip-encoded)`, exit 0; the same tree with one byte of `index.html` changed: `changed index.html`, exit 1; the decoded tree plus an added file: `missing new.txt` and `same index.html`, exit 1;
- an official tree against `arbitrum-sepolia`, which does not hold it: roots equal, 28 of 29 objects absent (the one present is the empty directory, which exists everywhere) (exit 1).

## Timing

Wall-clock, three runs each, alternating, 5 s apart, from btm on 2026-11-06, same root and endpoint (`ABXFS_RPC_URL` for the CLI, `--rpc` for abxfs-rs). The official CLI writes the file with `abxfs read <root> -o`; abxfs-rs reads and verifies the whole root.

| Root | Endpoint | official `abxfs read` | `abxfs-rs read` |
| --- | --- | --- | --- |
| `0x074dcf…` 5.3 MB file, 216 chunks | `https://sepolia.base.org` | 6.94 s, 8.76 s, 7.22 s (median 7.22) | 2.63 s, 3.03 s, 3.08 s (median 3.03) |
| `0x074dcf…` 5.3 MB file, 216 chunks | `https://base-sepolia-rpc.publicnode.com` | 14.63 s, 17.95 s, 16.42 s (median 16.42) | 2.84 s, 2.36 s, 2.19 s (median 2.36) |
| `0xa3c966…` 797 KB gzip file, 11 chunks (CLI: `--path index.html`) | `https://mainnet.base.org` | 1.78 s, 1.92 s, 1.54 s (median 1.78) | 1.73 s, 2.55 s, 1.64 s (median 1.73) |

An earlier set of runs with an extra round trip gave the same picture (5.3 MB file: CLI 6.9 to 7.7 s vs 1.5 to 2.8 s on `sepolia.base.org`, 15 to 23 s vs 1.8 to 2.3 s on publicnode). The small root is bound by round trips (six in sequence: root, directory node, file info, file node, chunk records, chunk code), so abxfs-rs is on par with the CLI there; the large file is where batching pays. The harness is `scratch/chain/timing.py`.
