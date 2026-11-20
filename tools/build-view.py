#!/opt/homebrew/bin/python3
"""Assemble the from-chain viewer into view-dist/.

The viewer's own files live under /_abxfs/ so they cannot collide with a project's paths; index.html is the
start page the host serves for every path until the service worker takes over.
"""
import hashlib
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SITE, VIEW, OUT = HERE / "site", HERE / "view", HERE / "view-dist"
OWN = ["boot.js", "sw.js", "info.html", "info.js", "check.html", "check.js", "evm-worker.js", "view.css"]
SHARED = ["chain.js", "keccak-lookup.js", "target.js", "light.js", "proof.js", "proved.js", "verdict.js", "checkpoint.js", "base.js", "arbitrum.js", "token.js", "bamfs.js", "evm.js", "evm-state.js", "start.js", "published.js", "refuse.js"]
VENDOR = SITE / "vendor" / "noble"
STARTING_BLOCK = "/_abxfs/checkpoint.js"


def vendored():
    """The vendored files, each checked against SHA256SUMS: a file that was edited in place stops the build."""
    out = []
    for line in (VENDOR / "SHA256SUMS").read_text().splitlines():
        want, rel = line.split("  ", 1)
        f = VENDOR / rel
        if hashlib.sha256(f.read_bytes()).hexdigest() != want:
            raise SystemExit(f"site/vendor/noble/{rel} does not match SHA256SUMS; run tools/vendor-noble.py again")
        out.append(rel)
    return out


def list_hash(sums):
    """One hash over a list of files: the SHA-256 of its "hash  path" lines, in path order."""
    return hashlib.sha256("".join(f"{h}  {p}\n" for p, h in sorted(sums.items())).encode()).hexdigest()


def build():
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "_abxfs").mkdir(parents=True)
    for name in ("index.html", "_headers"):
        shutil.copyfile(VIEW / name, OUT / name)
    for name in OWN:
        shutil.copyfile(VIEW / name, OUT / "_abxfs" / name)
    for name in SHARED:
        shutil.copyfile(SITE / name, OUT / "_abxfs" / name)
    vendor = vendored()
    for rel in vendor:
        to = OUT / "_abxfs" / "vendor" / "noble" / rel
        to.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(VENDOR / rel, to)
    # The switch that turns proving off is the one file a host may change, so it is not part of the build's hashes.
    shutil.copyfile(VIEW / "switch.json", OUT / "_abxfs" / "switch.json")
    # The archive manifest (archive/ARCHIVE.md section 13) changes as bundles are made, so it is not hashed either.
    manifest = VIEW.parent / "archive" / "manifest.json"
    if manifest.exists():
        (OUT / "_abxfs" / "archive").mkdir()
        shutil.copyfile(manifest, OUT / "_abxfs" / "archive" / "manifest.json")
    # files.js: the SHA-256 of every file the viewer is made of, and one hash over that list. The worker imports
    # it to check its kept copies; the info page shows it, so a reader can compare a host with this repository.
    listed = {"/index.html": OUT / "index.html"}
    listed.update({f"/_abxfs/{name}": OUT / "_abxfs" / name for name in OWN + SHARED})
    listed.update({f"/_abxfs/vendor/noble/{rel}": OUT / "_abxfs" / "vendor" / "noble" / rel for rel in vendor})
    sums = {path: hashlib.sha256(f.read_bytes()).hexdigest() for path, f in sorted(listed.items())}
    build_hash = list_hash(sums)
    # The light client's starting block is replaced every week (tools/checkpoint.py), so the build hash changes
    # every week with no change to the code. The code hash leaves that one file out: it is what a build published
    # on chain is compared by (site/published.js), and it changes only when the viewer's code does.
    code_hash = list_hash({p: h for p, h in sums.items() if p != STARTING_BLOCK})
    (OUT / "_abxfs" / "files.js").write_text(
        "// Written by tools/build-view.py: the SHA-256 of each viewer file, of the list itself (BUILD), and of\n"
        "// the list without the light client's starting block (CODE).\n"
        f"export const BUILD = {json.dumps(build_hash)};\n"
        f"export const CODE = {json.dumps(code_hash)};\n"
        f"export const FILES = {json.dumps(sums, indent=2)};\n")
    print(f"built {len(sums) + 2} files in {OUT}")
    print(f"viewer build {build_hash}")
    print(f"viewer code {code_hash}")


if __name__ == "__main__":
    sys.exit(build())
