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
OWN = ["boot.js", "sw.js", "info.html", "info.js", "view.css"]
SHARED = ["chain.js", "keccak-lookup.js", "target.js"]


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
    # files.js: the SHA-256 of every file the viewer is made of, and one hash over that list. The worker imports
    # it to check its kept copies; the info page shows it, so a reader can compare a host with this repository.
    listed = {"/index.html": OUT / "index.html"}
    listed.update({f"/_abxfs/{name}": OUT / "_abxfs" / name for name in OWN + SHARED})
    sums = {path: hashlib.sha256(f.read_bytes()).hexdigest() for path, f in sorted(listed.items())}
    build_hash = hashlib.sha256("".join(f"{h}  {p}\n" for p, h in sums.items()).encode()).hexdigest()
    (OUT / "_abxfs" / "files.js").write_text(
        "// Written by tools/build-view.py: the SHA-256 of each viewer file, and of the list itself.\n"
        f"export const BUILD = {json.dumps(build_hash)};\n"
        f"export const FILES = {json.dumps(sums, indent=2)};\n")
    print(f"built {len(sums) + 2} files in {OUT}")
    print(f"viewer build {build_hash}")


if __name__ == "__main__":
    sys.exit(build())
