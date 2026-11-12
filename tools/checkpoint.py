#!/opt/homebrew/bin/python3
"""Write site/checkpoint.js: for each network, the newest finalized block root that two independent beacon nodes
both report. The root is then given to the light client (tests/light-live.mjs), which must start from it and
reach a finalized execution block; a root it cannot start from is not written.

usage: tools/checkpoint.py [--check]     --check only reports whether the shipped roots are within their 14 days
"""
import datetime
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
FILE = HERE / "site" / "checkpoint.js"
NODE = "/opt/homebrew/bin/node" if Path("/opt/homebrew/bin/node").exists() else "node"
# Two operators per network. The second Sepolia node serves headers but not the light-client routes, which is
# enough to confirm a root.
SOURCES = {
    1: ("mainnet", 1606824023, ["https://lodestar-mainnet.chainsafe.io", "https://ethereum-beacon-api.publicnode.com"]),
    11155111: ("sepolia", 1655733600, ["https://lodestar-sepolia.chainsafe.io", "https://ethereum-sepolia-beacon-api.publicnode.com"]),
}
MAX_AGE_DAYS = 14


def get(url):
    req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "abxfs-checkpoint"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def finalized(base):
    d = get(base + "/eth/v1/beacon/headers/finalized")["data"]
    return d["root"], int(d["header"]["message"]["slot"])


def shipped():
    text = FILE.read_text()
    return {int(i): (root, int(slot)) for i, root, slot in re.findall(r"(\d+): \{ root: '(0x[0-9a-f]{64})', slot: (\d+)", text)}


def check():
    bad = 0
    for chain, (name, genesis, _) in SOURCES.items():
        root, slot = shipped().get(chain, (None, 0))
        age = (time.time() - (genesis + slot * 12)) / 86400
        ok = slot > 0 and age <= MAX_AGE_DAYS
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name}: shipped root at slot {slot} is {age:.1f} days old (limit {MAX_AGE_DAYS})")
    return bad


def write():
    entries = {}
    for chain, (name, genesis, bases) in SOURCES.items():
        seen = [finalized(b) for b in bases]
        if len({r for r, _ in seen}) != 1:
            # The two nodes can be one epoch apart for a moment: wait for them to meet.
            time.sleep(30)
            seen = [finalized(b) for b in bases]
        if len({r for r, _ in seen}) != 1:
            raise SystemExit(f"{name}: the beacon nodes report different finalized roots: {seen}")
        root, slot = seen[0]
        run = subprocess.run([NODE, str(HERE / "tests" / "light-live.mjs"), name, root], capture_output=True, text=True, timeout=300)
        if run.returncode != 0:
            raise SystemExit(f"{name}: the light client could not start from {root}:\n{run.stdout}{run.stderr}")
        date = datetime.datetime.fromtimestamp(genesis + slot * 12, datetime.timezone.utc).strftime("%Y-%m-%d")
        entries[chain] = (root, slot, date)
        print(f"{name}: {root} at slot {slot} ({date}), confirmed by {len(bases)} beacon nodes and the light client")
    text = FILE.read_text()
    for chain, (root, slot, date) in entries.items():
        text, n = re.subn(rf"(\n  {chain}: )\{{[^}}]*\}}", rf"\1{{ root: '{root}', slot: {slot}, date: '{date}' }}", text)
        if n != 1:
            raise SystemExit(f"site/checkpoint.js has no entry for chain {chain}")
    FILE.write_text(text)


if __name__ == "__main__":
    sys.exit(check() if "--check" in sys.argv else write())
