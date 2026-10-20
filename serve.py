#!/usr/bin/env python3
"""Static dev server for the web flasher: localhost only, caching disabled."""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
print(f"Serving on http://localhost:{port}  (Ctrl+C to stop)")
ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
