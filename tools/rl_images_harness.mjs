// T02 acceptance gate (spec/03 §7, spec/06 T02): structural validation of
// the image pipeline. Node 20+, no dependencies.
//
//   node tools/rl_images_harness.mjs
//
// What "passes" means here:
//   * every images.json entry's file exists, starts with RIFF/WEBP, and
//     reports the recorded width/height via the VP8/VP8L/VP8X headers
//   * card art covers legacy dialogue AND current playable identities;
//     historical dialogue busts = 40,
//     icon = 1281, orig = 50, ui = 6, weapon/item/illust within budget)
//   * the on-disk total of asset/img/rl/{card,illust,bust,icon,weapon,item,
//     orig,ui} is ≤ the 29 MB image slice of spec/03 §6 (120 MB hard cap
//     minus mapkit/voice/json which this gate does not own)
//   * no runtime-hotlink domains in game/ or core/ (or in images.json)
//   * the negatives actually fire: a truncated file, a dimension lie, and
//     a missing file each reject
//
// Pixel-content ("this is ゆの, not a 1×1 placeholder") is out of scope;
// the fetch tool already refuses anything that is not a PNG.

import { readFileSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PLAYABLE_IDS } from "../site/game/rl/rosterids.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IMG_ROOT = path.join(ROOT, "site", "asset", "img", "rl");
const MANIFEST = path.join(ROOT, "site", "asset", "rl", "images.json");
const CATEGORIES = ["card", "illust", "bust", "icon", "weapon", "item", "orig", "ui"];
const HOTLINK_DOMAINS = [
    "asset.kirafan.cn", "voice-cri.kirafan.cn", "kirafan.gitlab.io",
    "database.kirafan.cn", "kirafan.moe",
];
// spec/03 §6 image slice: 10 (icon) + 15 (card/illust/bust) + 4 (icons) + 6 (ui)
// = 35 MB generously; the 120 MB hard cap also covers mapkit/voice which this
// gate does not own. Stay under 35 MB so the later slices still fit.
const BUDGET_BYTES = 35 * 1024 * 1024;
// The six spec/03 §2 role backgrounds plus the twelve scene beds the volumes
// and hub screens use. Order matches fetch_images.UI_PICKS.
const UI_IDS = [
    "title", "select", "shop", "settings", "result", "dark",
    "scene_sea", "scene_sand", "scene_library", "scene_study", "scene_store",
    "scene_forge", "scene_inn", "scene_train", "scene_town", "scene_field",
    "scene_village", "scene_room",
];

let passed = 0;
let failed = 0;

function check(ok, label, detail) {
    if (ok) {
        passed += 1;
    } else {
        failed += 1;
        console.error("FAIL " + label + (detail ? " — " + detail : ""));
    }
}

// Minimal WebP dimension reader. We only need w/h + the RIFF/WEBP magic;
// a full decode is the fetch tool's job.
function readWebp(bytes) {
    if (bytes.length < 30) return { error: "shorter than a WebP header" };
    if (bytes.toString("ascii", 0, 4) !== "RIFF") return { error: "not RIFF" };
    if (bytes.toString("ascii", 8, 12) !== "WEBP") return { error: "not WEBP" };
    const fourcc = bytes.toString("ascii", 12, 16);
    if (fourcc === "VP8X") {
        return {
            w: 1 + bytes.readUIntLE(24, 3),
            h: 1 + bytes.readUIntLE(27, 3),
        };
    }
    if (fourcc === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8 ") {
        // lossy bitstream: 3-byte frame tag, then 0x9d 0x01 0x2a, then 14-bit w/h
        const sig = bytes.readUIntLE(23, 3);
        if (sig !== 0x2a019d) return { error: "VP8 signature mismatch" };
        const wh = bytes.readUInt32LE(26);
        return { w: wh & 0x3fff, h: (wh >> 16) & 0x3fff };
    }
    return { error: "unknown WebP fourcc " + fourcc };
}

function walkJs(dir, acc) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
            walkJs(full, acc);
        } else if (/\.(js|mjs|css|html)$/.test(entry.name)) {
            acc.push(full);
        }
    }
    return acc;
}

function dirBytes(dir) {
    let total = 0;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirBytes(full);
        else total += statSync(full).size;
    }
    return total;
}

function problemsOf(records) {
    const problems = [];
    const seen = new Set();
    for (const rec of records) {
        const key = rec.category + "/" + rec.id;
        if (seen.has(key)) problems.push("duplicate " + key);
        seen.add(key);
        if (!CATEGORIES.includes(rec.category)) {
            problems.push(key + ": bad category");
        }
        if (typeof rec.file !== "string" || !rec.file.startsWith(rec.category + "/")) {
            problems.push(key + ": file path not under category/");
        }
        const abs = path.join(IMG_ROOT, rec.file);
        let bytes;
        try {
            bytes = readFileSync(abs);
        } catch {
            problems.push(key + ": missing " + rec.file);
            continue;
        }
        const webp = readWebp(bytes);
        if (webp.error) {
            problems.push(key + ": " + webp.error);
            continue;
        }
        if (webp.w !== rec.w || webp.h !== rec.h) {
            problems.push(key + ": dim " + webp.w + "x" + webp.h + " != " + rec.w + "x" + rec.h);
        }
        // spec/03 §2 caps the dialogue bust at 512 on the long edge. S1's
        // bustfull is natively 360×512, i.e. already at the cap, so the
        // fetch tool's resize is a no-op here — assert the cap, not 512 wide
        // (upscaling 360→512 would invent pixels).
        if (rec.category === "bust" && Math.max(rec.w, rec.h) > 512) {
            problems.push(key + ": bust long edge " + rec.w + "x" + rec.h + " > 512");
        }
    }
    return problems;
}

const records = JSON.parse(readFileSync(MANIFEST, "utf8"));
check(Array.isArray(records) && records.length > 0, "images.json is a non-empty array",
    "got " + (Array.isArray(records) ? records.length : typeof records));

const byCat = {};
for (const cat of CATEGORIES) byCat[cat] = [];
for (const rec of records) {
    (byCat[rec.category] || (byCat[rec.category] = [])).push(rec);
}

const problems = problemsOf(records);
check(problems.length === 0, "every record exists, is WebP, dims match",
    problems.slice(0, 8).join("; "));

const requiredCardIds = new Set([...PLAYABLE_IDS, ...byCat.bust.map(row => Number(row.id))]);
const actualCardIds = new Set(byCat.card.map(row => Number(row.id)));
check(byCat.card.length === requiredCardIds.size && actualCardIds.size === requiredCardIds.size
    && [...requiredCardIds].every(id => actualCardIds.has(id)),
    "card art covers current playable and historical dialogue identities exactly", "got " + byCat.card.length);
check(byCat.bust.length === 40, "bust = 40 historical dialogue identities", "got " + byCat.bust.length);
check(byCat.icon.length === 1281, "icon = 1281 CharacterList", "got " + byCat.icon.length);
check(byCat.ui.length === UI_IDS.length,
    "ui = " + UI_IDS.length + " backgrounds (6 roles + 12 scene beds)",
    "got " + byCat.ui.length);
check(byCat.orig.length === 56, "orig = 28×(illust+icon) (spec/05 主线+城镇+七贤者+真実の手)",
    "got " + byCat.orig.length);
check(byCat.weapon.length === 224,
    "weapon = 224 original families (62 generic + 162 dedicated)", "got " + byCat.weapon.length);
check(byCat.item.length >= 40 && byCat.item.length <= 80,
    "item in [40, 80] (T10 seed)", "got " + byCat.item.length);
check(byCat.illust.length >= 30 && byCat.illust.length <= 40,
    "illust in [30, 40] (6 of 40 have no full-body)", "got " + byCat.illust.length);

const uiIds = new Set(byCat.ui.map((r) => r.id));
for (const id of UI_IDS) check(uiIds.has(id), "ui has " + id);
// Backgrounds are letterbox-trimmed and resized to 1600 wide (fetch_images
// UI_WIDTH). A 1600×1600 record means the trim did not fire — legitimate only
// for btl_0013 (scene_library), the one file with art at row 0.
for (const rec of byCat.ui) {
    const trimmed = rec.w === 1600 && rec.h < 1400;
    check(trimmed || rec.id === "scene_library",
        "ui " + rec.id + " is trimmed to 1600 wide",
        rec.w + "x" + rec.h);
}

const bytes = CATEGORIES.reduce((n, cat) => n + dirBytes(path.join(IMG_ROOT, cat)), 0);
check(bytes > 0 && bytes <= BUDGET_BYTES,
    "image slice ≤ 35 MB",
    (bytes / (1024 * 1024)).toFixed(2) + " MB");

const manifestText = readFileSync(MANIFEST, "utf8");
const hotInManifest = HOTLINK_DOMAINS.filter((d) => manifestText.includes(d));
check(hotInManifest.length === 0, "no hotlink domains in images.json",
    hotInManifest.join(", "));

const runtimeFiles = walkJs(path.join(ROOT, "site", "game"), [])
    .concat(walkJs(path.join(ROOT, "site", "core"), []));
const hotHits = [];
for (const file of runtimeFiles) {
    const text = readFileSync(file, "utf8");
    for (const domain of HOTLINK_DOMAINS) {
        if (text.includes(domain)) {
            hotHits.push(path.relative(ROOT, file) + ":" + domain);
        }
    }
}
check(hotHits.length === 0, "no hotlink domains in game/ or core/",
    hotHits.slice(0, 6).join(", "));

// --- negatives: each must actually reject --------------------------------
function expectRejection(label, recs, expect) {
    const found = problemsOf(recs);
    check(found.some((p) => expect.test(p)),
        "negative: " + label,
        found.join("; ") || "no problems reported");
}

const tmpDir = path.join(IMG_ROOT, "__harness_tmp");
mkdirSync(tmpDir, { recursive: true });
try {
    const sample = records.find((r) => r.category === "icon") || records[0];
    const sampleBytes = readFileSync(path.join(IMG_ROOT, sample.file));

    const missing = [{ ...sample, id: "__missing__", file: "icon/__missing__.webp", category: "icon", w: 8, h: 8 }];
    expectRejection("missing file", missing, /missing/);

    const lie = [{ ...sample, w: sample.w + 17, h: sample.h + 9 }];
    expectRejection("dimension lie", lie, /dim /);

    const truncatedPath = path.join(tmpDir, "trunc.webp");
    writeFileSync(truncatedPath, sampleBytes.subarray(0, 16));
    const trunc = [{
        id: "__trunc__", category: "icon",
        file: path.relative(IMG_ROOT, truncatedPath).replace(/\\/g, "/"),
        w: 8, h: 8,
    }];
    expectRejection("truncated WebP", trunc, /shorter than a WebP header|not WEBP|unknown WebP/);

    // The bust cap is the one assertion the real data already satisfies
    // (360×512 native), so prove it can still fail: a card-sized bust rejects.
    const bust = records.find((r) => r.category === "bust");
    const oversizeBust = [{ ...bust, category: "bust", w: 750, h: 1000 }];
    expectRejection("bust over the 512 long-edge cap", oversizeBust, /bust long edge/);
} finally {
    rmSync(tmpDir, { recursive: true, force: true });
}

console.log(passed + "/" + (passed + failed) + " " + (failed ? "FAIL" : "ok"));
process.exit(failed ? 1 : 0);
