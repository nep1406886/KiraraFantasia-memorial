#!/usr/bin/env node
/**
 * Node equivalent of tools/serve.py — a static file server with caching
 * turned off, so a reload never runs a new index.html against an old ES
 * module. The published site is served by GitHub Pages with proper ETags,
 * so this only affects development.
 *
 *     node tools/serve.mjs [port]
 */

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2]) || 8643;

// Types the shipped pages fetch that Node has no table for at all.
// .glb.gz in particular: the site fetches it and inflates with
// DecompressionStream, so it must arrive as an opaque body, not something
// the browser tries to decode.
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gz": "application/octet-stream",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".hca": "application/octet-stream",
  ".awb": "application/octet-stream",
  ".acb": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const fail = (code, text) => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
  };

  try {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      return fail(400, "bad request");
    }
    if (urlPath.endsWith("/")) urlPath += "index.html";

    // Resolve inside ROOT only; encode each segment back so %-tricks or ".."
    // cannot escape the site directory.
    const rel = path.normalize(urlPath).replace(/^([/\\])+/, "");
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return fail(403, "forbidden");

    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) {
      console.error(`404 ${urlPath}`);
      return fail(404, "not found");
    }

    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      // No-store + no Last-Modified: the browser must not reuse modules.
      "Cache-Control": "no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    (await fs.open(file, "r")).createReadStream().pipe(res);
  } catch (err) {
    console.error(err);
    fail(500, "internal error");
  }
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}  (no-store)`);
});
