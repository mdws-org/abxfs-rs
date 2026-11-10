#!/opt/homebrew/bin/python3
"""Assemble the from-chain viewer into view-dist/.

The viewer's own files live under /_abxfs/ so they cannot collide with a project's paths; index.html is the
start page the host serves for every path until the service worker takes over.
"""
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
    print(f"built {len(OWN) + len(SHARED) + 2} files in {OUT}")


if __name__ == "__main__":
    sys.exit(build())
