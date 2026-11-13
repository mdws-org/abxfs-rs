#!/opt/homebrew/bin/python3
"""Materialise an ABX FS root with the official CLI only: `abxfs read` lists each directory, and
`abxfs read <root> --path <p> -o <file>` writes each file. Usage: oracle_read.py <root> <chain> <out>.
The CLI's endpoint can be set with ABXFS_RPC_URL."""
import os, subprocess, sys

CLI = os.environ.get("ABXFS_CLI", "abxfs")  # the official CLI, on PATH or named by ABXFS_CLI

def cli(*args):
    r = subprocess.run([CLI, *args], capture_output=True)
    if r.returncode != 0:
        sys.exit(f"abxfs {' '.join(args)} failed: {r.stderr.decode(errors='replace')}")
    return r.stdout

def listing(root, chain, path):
    args = ["read", root, "--chain", chain, "--max-entries", "1000000"] + (["--path", path] if path else [])
    out = cli(*args).decode()
    lines = out.splitlines()
    head = lines[0].split()
    if head[0] == "file":
        return "file", []
    entries = []
    for line in lines[1:]:
        kind, cid, name = line.strip().split(" ", 2)
        entries.append((kind, cid, name))
    return "dir", entries

def walk(root, chain, path, dst):
    kind, entries = listing(root, chain, path)
    if kind == "file":
        return
    os.makedirs(dst, exist_ok=True)
    for k, _, name in entries:
        p = f"{path}/{name}" if path else name
        d = os.path.join(dst, name)
        if k == "d":
            walk(root, chain, p, d)
        else:
            cli("read", root, "--chain", chain, "--path", p, "-o", d)

def main():
    root, chain, out = sys.argv[1:4]
    if os.path.exists(out):
        sys.exit(f"{out} exists")
    r = subprocess.run([CLI, "read", root, "--chain", chain, "-o", out], capture_output=True)
    if r.returncode == 0:
        return
    if b"is a directory" not in r.stderr:
        sys.exit(f"abxfs read {root} failed: {r.stderr.decode(errors='replace')}")
    walk(root, chain, "", out)

if __name__ == "__main__":
    main()
