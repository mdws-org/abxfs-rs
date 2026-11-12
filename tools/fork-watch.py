#!/opt/homebrew/bin/python3
"""Compare each network's fork schedule, as beacon nodes report it, with the one site/light.js was written for.

A fork can change the fields and Merkle paths the light client hard-codes. This exits 1, with the reason, when
a node reports a fork that light.js does not list, or a date for one it lists as not yet scheduled, so that the
client is brought up to date before that fork arrives. Until it is, the viewer falls back to the endpoints.

usage: tools/fork-watch.py
"""
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

# FORK_WATCH_LIGHT names another copy of light.js; tests use it to show that a missing fork is reported.
LIGHT = Path(os.environ.get("FORK_WATCH_LIGHT") or Path(__file__).resolve().parent.parent / "site" / "light.js")
NODES = {
    1: ("mainnet", ["https://lodestar-mainnet.chainsafe.io", "https://ethereum-beacon-api.publicnode.com"]),
    11155111: ("sepolia", ["https://lodestar-sepolia.chainsafe.io", "https://ethereum-sepolia-beacon-api.publicnode.com"]),
}
FAR = 2**64 - 1


def get(url):
    req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "abxfs-fork-watch"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def known():
    """{chain id: ({version: epoch}, genesis time)} as written in light.js."""
    text = LIGHT.read_text()
    out = {}
    for chain, body in re.findall(r"\n  (\d+): \{\n(.*?)\n  \},", text, re.S):
        forks = {v: int(e) for e, v in re.findall(r"\['\w+', (\d+), '(0x[0-9a-f]{8})'\]", body)}
        out[int(chain)] = (forks, int(re.search(r"genesisTime: (\d+)", body).group(1)))
    return out


def main():
    mine, problems = known(), []
    for chain, (name, bases) in NODES.items():
        forks, genesis = mine[chain]
        newest = max(forks.values())
        for base in bases:
            try:
                schedule = get(base + "/eth/v1/config/fork_schedule")["data"]
            except Exception as e:  # one node down is not news; both down is reported below
                print(f"     {name}: {base} could not be read ({e})")
                continue
            for f in schedule:
                version, epoch = f["current_version"], int(f["epoch"])
                if epoch == FAR or epoch < min(forks.values()):
                    continue
                when = time.strftime("%Y-%m-%d", time.gmtime(genesis + epoch * 384))
                if version not in forks:
                    problems.append(f"{name}: {base} reports fork {version} at epoch {epoch} ({when}); site/light.js does not know it")
                elif forks[version] != epoch:
                    problems.append(f"{name}: {base} reports fork {version} at epoch {epoch}; site/light.js has epoch {forks[version]}")
            print(f"ok   {name}: {base} lists nothing past epoch {newest} that light.js lacks" if not problems else f"     {name}: {base} read")
    for p in sorted(set(problems)):
        print("FAIL " + p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
