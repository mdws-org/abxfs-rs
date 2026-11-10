#!/opt/homebrew/bin/python3
"""Serve view-dist/ on 127.0.0.1 the way the viewer's host does: the same files on every hostname, the start
page for any path that is not a file, and the response headers from _headers.

usage: tools/view-serve.py [port]   (default 8853; open http://<label>.localhost:<port>/)
"""
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "view-dist"
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https:; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
# What the host serves as files: everything the build wrote except its own header rules.
FILES = {f.relative_to(ROOT).as_posix() for f in ROOT.rglob("*") if f.is_file()} - {"_headers"}


class Viewer(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        # The request path is only ever compared with the list of built files, never used to build a path.
        if self.path.split("?", 1)[0].lstrip("/") not in FILES:
            self.path = "/index.html"
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        if self.path.split("?", 1)[0] == "/_abxfs/sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8853
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Viewer).serve_forever()
