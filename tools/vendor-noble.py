#!/opt/homebrew/bin/python3
"""Copy the part of @noble/curves and @noble/hashes that BLS12-381 verification needs into site/vendor/noble/,
keeping their module layout, with bare '@noble/hashes/x.js' imports rewritten to relative paths so the files
load in a browser with no bundler. Only real import and export statements are followed, not examples in comments.
Writes site/vendor/noble/SHA256SUMS; tools/build-view.py refuses to build when a vendored file does not match it.

usage: tools/vendor-noble.py <node_modules holding the two packages>
"""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "site" / "vendor" / "noble"
ENTRY = [("curves", "bls12-381.js"), ("hashes", "sha2.js")]
STATEMENT = re.compile(r"""^(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"]+)\1""", re.M | re.S)


def target(pkg, rel, spec):
    if spec.startswith("@noble/hashes/"):
        return "hashes", spec[len("@noble/hashes/"):]
    if spec.startswith("@noble/curves/"):
        return "curves", spec[len("@noble/curves/"):]
    if spec.startswith("."):
        return pkg, os.path.normpath(os.path.join(os.path.dirname(rel), spec))
    raise SystemExit(f"unexpected import {spec!r} in {pkg}/{rel}")


def main():
    nm = Path(sys.argv[1])
    roots = {"curves": nm / "@noble/curves", "hashes": nm / "@noble/hashes"}
    todo, files = list(ENTRY), {}
    while todo:
        pkg, rel = todo.pop()
        if (pkg, rel) in files:
            continue
        src = (roots[pkg] / rel).read_text()

        def fix(m, pkg=pkg, rel=rel):
            tgt = target(pkg, rel, m.group(2))
            todo.append(tgt)
            path = os.path.relpath(os.path.join(*tgt), os.path.join(pkg, os.path.dirname(rel)))
            path = path if path.startswith(".") else "./" + path
            return m.group(0).replace(m.group(1) + m.group(2) + m.group(1), m.group(1) + path + m.group(1))

        files[(pkg, rel)] = STATEMENT.sub(fix, src)
    sums = []
    for (pkg, rel), text in sorted(files.items()):
        p = OUT / pkg / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        sums.append(f"{hashlib.sha256(text.encode()).hexdigest()}  {pkg}/{rel}")
    versions = {pkg: json.loads((roots[pkg] / "package.json").read_text())["version"] for pkg in roots}
    for pkg in roots:
        (OUT / pkg / "LICENSE").write_text((roots[pkg] / "LICENSE").read_text())
    (OUT / "SHA256SUMS").write_text("\n".join(sums) + "\n")
    (OUT / "VERSIONS").write_text("".join(f"@noble/{pkg} {v}\n" for pkg, v in sorted(versions.items())))
    print("\n".join(sums))
    print(versions)


if __name__ == "__main__":
    main()
