#!/usr/bin/env python3
"""Static file server for development, with caching turned off.

`python -m http.server` sends no cache headers beyond Last-Modified, which leaves
the browser applying heuristic caching. For ES modules that is worse than it
sounds: each file caches independently, so a reload can end up running a new
index.html against an old module, and the resulting behaviour matches neither
version of the code. Debugging that costs more than the bandwidth ever saved.

The published site is served by GitHub Pages with proper ETags, so this only
affects development.

    python tools/serve.py [port]
"""

from __future__ import annotations

import functools
import http.server
import socketserver
import sys

DEFAULT_PORT = 8643

# Types the shipped pages fetch that Python's own table gets wrong or misses.
# .glb.gz in particular: the site fetches it and inflates with DecompressionStream,
# so it must arrive as an opaque body, not something the browser tries to decode.
EXTRA_TYPES = {
    ".glb": "model/gltf-binary",
    ".gz": "application/octet-stream",
    ".webp": "image/webp",
    ".wasm": "application/wasm",
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".hca": "application/octet-stream",
    ".awb": "application/octet-stream",
    ".acb": "application/octet-stream",
}


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        **EXTRA_TYPES,
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_header(self, keyword, value):
        # Last-Modified is what the browser bases heuristic caching on, and
        # no-store alone does not always stop a module from being reused.
        if keyword == "Last-Modified":
            return
        super().send_header(keyword, value)

    def log_message(self, fmt, *args):
        # One line per asset is thousands of lines for a single page load here.
        # Errors still print, which is the part worth seeing.
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith(("4", "5")):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    # Without this a restart on the same port fails with "address already in use"
    # for as long as the old socket sits in TIME_WAIT.
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = functools.partial(NoCacheHandler, directory=".")
    with Server(("", port), handler) as httpd:
        print(f"serving . on http://localhost:{port}  (no-store)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
