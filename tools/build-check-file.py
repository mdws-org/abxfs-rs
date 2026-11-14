#!/opt/homebrew/bin/python3
"""Make the check page as one self-contained file: view-dist-file/abxfs-check.html, and build.txt beside it.

The file needs no host. It holds the page, its style, and every module the check page and its worker import, as
text. A short script at the end turns each module into a blob: address, in an order where a module's imports
already have theirs, and starts the page. A reader can keep the file, open it from disk, or serve it from
anywhere, and can compare its SHA-256 with a published one. Run tools/build-view.py first: the modules are
taken from view-dist/, so the file is the build that view-dist/ is.

The same input gives the same bytes.
"""
import base64
import hashlib
import json
import posixpath
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SRC, OUT = HERE / "view-dist" / "_abxfs", HERE / "view-dist-file"
ENTRY, WORKER = "check.js", "evm-worker.js"
IMPORT = re.compile(r"""(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}/[^'"]+)\2""")
MARK = "abxfs-module:"


def graph():
    """Every module the two entries reach, with its imports rewritten to names, in an order where imports come first."""
    done, order = {}, []

    def visit(name, trail=()):
        if name in done:
            return
        if name in trail:
            raise SystemExit(f"modules import each other in a circle: {' > '.join(trail + (name,))}")
        text = (SRC / name).read_text(encoding="utf-8")
        if MARK in text:
            raise SystemExit(f"{name} holds the text {MARK!r}, which this tool uses to name modules")
        deps = []

        def named(m):
            dep = posixpath.normpath(posixpath.join(posixpath.dirname(name), m.group(3)))
            deps.append(dep)
            return f"{m.group(1)}{m.group(2)}{MARK}{dep}{m.group(2)}"
        text = IMPORT.sub(named, text)
        if re.search(r"""(?:\bfrom|\bimport)\s*['"]\.""", text):
            raise SystemExit(f"{name} still names a module by a path after its imports were rewritten")
        if re.search(r"\bimport\s*\(", text):
            raise SystemExit(f"{name} imports at run time, which this file cannot hold")
        for dep in deps:
            visit(dep, trail + (name,))
        done[name] = text
        order.append(name)
    visit(WORKER)
    visit(ENTRY)
    return [[name, done[name]] for name in order]


LOADER = """(() => {
  const modules = %s;
  // Each module becomes a blob: address, in an order where its imports already have theirs.
  const link = function (list) {
    const at = {};
    for (const [name, text] of list) {
      const body = text.replace(/(['"])%s([^'"]+)\\1/g, (all, quote, dep) => JSON.stringify(at[dep]));
      at[name] = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
    }
    return at;
  };
  // The worker links the modules again for itself: a page opened from disk cannot hand its blob: addresses to a
  // worker. Messages that arrive before the worker's module has loaded are kept and given to it then.
  const inWorker = `const early = []; self.onmessage = (e) => early.push(e);
const at = (${link})(${JSON.stringify(modules)});
import(at[${JSON.stringify(%s)}]).then(() => { for (const e of early) self.onmessage(e); }, (e) => setTimeout(() => { throw e; }));`;
  // A policy in the page cannot forbid framing, so the page refuses to run inside another.
  if (top !== self) { document.getElementById('verdict').textContent = 'This page does not run inside another page. Open it in a tab of its own.'; return; }
  globalThis.ABXFS_WORKER_URL = URL.createObjectURL(new Blob([inWorker], { type: 'text/javascript' }));
  import(link(modules)[%s]).catch((e) => { document.getElementById('verdict').textContent = `This copy of the check page could not start: ${e && e.message ? e.message : e}`; });
})();
"""


def sri(text):
    return "sha256-" + base64.b64encode(hashlib.sha256(text.encode()).digest()).decode()


def build():
    page = (SRC / "check.html").read_text(encoding="utf-8")
    style = (SRC / "view.css").read_text(encoding="utf-8")
    if "</" in style:
        raise SystemExit("view.css holds the letters that end a style element")
    # Text inside a script element must not hold the letters that end one.
    data = json.dumps(graph(), ensure_ascii=True, separators=(",", ":")).replace("</", "<\\/").replace("<!--", "<\\!--")
    script = LOADER % (data, MARK, json.dumps(WORKER), json.dumps(ENTRY))
    policy = (f"default-src 'none'; script-src '{sri(script)}' blob:; worker-src blob:; style-src '{sri(style)}'; "
              "connect-src https: http://localhost:* http://127.0.0.1:*; base-uri 'none'; form-action 'none'")
    for find, put in [
        ('        <link rel="stylesheet" href="/_abxfs/view.css" />\n', f'        <meta http-equiv="Content-Security-Policy" content="{policy}" />\n        <style>{style}</style>\n'),
        ('        <script type="module" src="/_abxfs/check.js"></script>\n', ""),
        ("    </body>\n", f"        <script>{script}</script>\n    </body>\n"),
    ]:
        if page.count(find) != 1:
            raise SystemExit(f"check.html does not hold this line once: {find.strip()}")
        page = page.replace(find, put)
    found = re.search(r'export const BUILD = "([0-9a-f]{64})"', (SRC / "files.js").read_text(encoding="utf-8"))
    if not found:
        raise SystemExit("files.js holds no build hash; run tools/build-view.py first")
    build_hash = found.group(1)
    OUT.mkdir(exist_ok=True)
    # Bytes are written as they are: no line-end translation, so every machine writes the same file.
    data = page.encode("utf-8")
    file_hash = hashlib.sha256(data).hexdigest()
    (OUT / "abxfs-check.html").write_bytes(data)
    # With --ipfs <cid>, a third line names the IPFS CID of the whole viewer as built (tools/archive: the deploy job
    # pins view-dist and passes its CID here).
    cid = sys.argv[sys.argv.index("--ipfs") + 1] if "--ipfs" in sys.argv else ""
    if cid and not re.fullmatch(r"b[a-z2-7]{20,100}", cid):
        raise SystemExit("--ipfs takes a CIDv1 in base32")
    (OUT / "build.txt").write_bytes((f"build {build_hash}\nsha256 {file_hash}  abxfs-check.html\n" + (f"ipfs {cid}\n" if cid else "")).encode())
    print(f"abxfs-check.html: {len(data):,} bytes, sha256 {file_hash}")
    print(f"build.txt: build {build_hash}")


if __name__ == "__main__":
    sys.exit(build())
