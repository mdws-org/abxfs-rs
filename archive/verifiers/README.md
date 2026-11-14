# Independent verifiers

These verifiers of archive bundles were each written from `archive/ARCHIVE.md` alone, with no access to the Rust verifier in `src/` or to each other. They exist so that the format rests on its text and not on one program: all three must print the same listing for every bundle.

- `python/verify.py`: Python 3.12, standard library only. `python3 verify.py <bundle.car> [--out DIR]`
- `go/`: Go 1.27, standard library only. `go build -o abxverify . && ./abxverify <bundle.car> [--out DIR]`

Each has its own Keccak-256, because neither standard library has one.

Do not edit these files to match the Rust verifier. If one of them disagrees with another verifier on a bundle, look for a passage of the specification that can be read two ways, then for a wrong test vector, then for a bug. Fix the specification first, and then the program that does not follow it.

To run every test vector through a verifier:

```
tools/archive/check-vectors.sh python3 archive/verifiers/python/verify.py
tools/archive/check-vectors.sh archive/verifiers/go/abxverify
```
