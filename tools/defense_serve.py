"""Local static preview for the new game; the shipped game needs no backend."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from urllib.parse import urlsplit

SITE = Path(__file__).resolve().parents[1] / "site"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        location = urlsplit(self.path)
        if location.path == "/":
            target = "/etowaria-defense/"
            if location.query:
                target += "?" + location.query
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8674
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(SITE)))
    print(f"Etowaria defense preview: http://localhost:{port}/etowaria-defense/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
