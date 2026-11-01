#!/usr/bin/env python3
"""Local server for Stretch Miner.

Usage: python3 serve.py [port]   (default 8011)

Plain `python3 -m http.server` usually works too, but older Python versions
serve .mjs / .wasm as a byte stream, which browsers refuse to load as modules —
this script pins the MIME types.
"""
import http.server
import mimetypes
import sys

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".task")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      **{k: v for k, v in mimetypes.types_map.items()}}


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8011
    print(f"Serving http://127.0.0.1:{port}/  (Ctrl+C to quit)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
