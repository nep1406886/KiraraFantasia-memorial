// core/mvmanifest.js expand() を node で回して、出来た manifest を JSON で吐く。
// tools/check_mv_manifest.py がそれを読める形の物と突き合わせる。
//
// browser を立てないのは、これが「path が正しいか」の検査で、描画は関係ないから。
// path が違うと症状は load 時の 404 一つだけで、どの model が欠けたのかは
// 画面を見ても分からない。
//
// usage: node tools/mv_manifest_harness.mjs <mvmanifest.mjs> <manifest-mv.json>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
const compactPath = process.argv[3];

const mod = await import(pathToFileURL(modulePath).href);
const compact = JSON.parse(readFileSync(compactPath, "utf-8"));

const out = { ok: true };
try {
    out.expanded = mod.expand(compact);
} catch (err) {
    out.ok = false;
    out.error = String(err && err.message ? err.message : err);
}

// keyOf() が知らない前置で throw するか。黙って通すと loader が
// 「asset not in manifest」で落ちて、名前の出所が辿れなくなる。
out.unknownPrefixThrows = false;
try {
    mod.keyOf("model_zz_1");
} catch (err) {
    out.unknownPrefixThrows = true;
}

// models の無い物を渡したときに throw するか。
out.emptyThrows = false;
try {
    mod.expand({ version: 2 });
} catch (err) {
    out.emptyThrows = true;
}

process.stdout.write(JSON.stringify(out));
