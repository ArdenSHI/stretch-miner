#!/usr/bin/env python3
"""启动 Stretch Miner 的本地服务器。

用法：python3 serve.py [端口]   （默认 8011）

直接用 `python3 -m http.server` 大多也能跑，但老版本 Python 会把 .mjs /
.wasm 当成二进制流返回，浏览器会拒绝加载模块 —— 这个脚本把 MIME 固定好。
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
    print(f"Serving http://127.0.0.1:{port}/  (Ctrl+C 退出)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
