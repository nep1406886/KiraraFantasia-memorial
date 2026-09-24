// T28 release prep (read-only): what must a deployment actually ship for the
// five-volume roguelike? Walks the reachable closure from the authored data —
// playable roster player models, the five volumes' enemy models, class-action
// packages, anchor clips, facial JSONs, native effect bundles, images, audio
// sheets the voices/bossvoice indexes cite, and the code — and prints the
// size table against the 1 GB Pages limit. No decisions are made here.
//
//   node tools/rl_deploy_closure.mjs [--json out.json]
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const argv = process.argv.slice(2);
const jsonOut = argv.indexOf("--json") >= 0 ? argv[argv.indexOf("--json") + 1] : null;

const manifest = JSON.parse(readFileSync(join(SITE, "asset/models/manifest.json"), "utf8")).models;
const cards = JSON.parse(readFileSync(join(SITE, "asset/rl/cards-rl.json"), "utf8")).cards;
const roster = JSON.parse(readFileSync(join(SITE, "asset/rl/playable-roster.json"), "utf8")).cards;
const encounters = JSON.parse(readFileSync(join(SITE, "asset/rl/encounters.json"), "utf8")).volumes;
const voices = JSON.parse(readFileSync(join(SITE, "asset/rl/voices.json"), "utf8"));
const bossVoices = JSON.parse(readFileSync(join(SITE, "asset/rl/bossvoices.json"), "utf8"));
const floors = JSON.parse(readFileSync(join(SITE, "asset/rl/floors.json"), "utf8"));

const files = new Set();          // site-relative paths in the closure
function add(abs) {
    if (!abs.startsWith(SITE)) { return; }
    const rel = abs.slice(SITE.length + 1).split("\\").join("/");
    if (!existsSync(abs) || !statSync(abs).isFile()) { return; }
    files.add(rel);
}
function addDir(abs) {
    if (!existsSync(abs)) { return; }
    for (const name of readdirSync(abs)) {
        const full = join(abs, name);
        if (statSync(full).isDirectory()) { addDir(full); } else { add(full); }
    }
}

// --- 1. code ------------------------------------------------------------
addDir(join(SITE, "game"));
// page-level scripts roguelike.html loads as plain <script src>
add(join(SITE, "asset/gacha/cards.js"));
add(join(SITE, "asset/original-characters.js"));
addDir(join(SITE, "asset/battle"));
addDir(join(SITE, "core"));
addDir(join(SITE, "vendor"));

// --- 2. authored data ---------------------------------------------------
for (const name of readdirSync(join(SITE, "asset/rl"))) {
    const full = join(SITE, "asset/rl", name);
    if (statSync(full).isDirectory()) {
        // native/ holds every effect bundle the game may acquire; the
        // per-scene/timeline dirs are the 必杀 cinematics the roster's 41
        // sceneIds cite. Reachability below trims nothing here — these load
        // on demand, and shipping them whole is 48 MB total.
        addDir(full);
    } else {
        add(full);
    }
}

// --- 3. images ----------------------------------------------------------
addDir(join(SITE, "asset/img/rl"));

// --- 4. player models: base + evolved rows of the 41 --------------------
const modelKeyOf = (resourceId) => `model/player/model_pl_${resourceId}.muast`;
for (const row of roster) {
    const card = cards.find(c => c.id === row.id);
    for (const rid of [card.resourceId, card.evolvedResourceId]) {
        if (!rid) { continue; }
        const entry = manifest[modelKeyOf(rid)];
        if (!entry) { continue; }
        add(join(SITE, entry.file.split("?")[0]));
        if (entry.facial) { add(join(SITE, entry.facial.split("?")[0])); }
        // the model directory may carry extra clips (anchors, dead/abnormal)
        const dir = join(SITE, dirname(entry.file.split("?")[0]));
        addDir(dir);
    }
}

// --- 5. enemy models: the five volumes' mobs/elites/bosses --------------
for (const vol of encounters) {
    const specs = [vol.boss, ...(vol.elites || []), ...(vol.mobs || [])];
    for (const spec of specs) {
        const entry = manifest[spec.model];
        if (!entry) { continue; }
        add(join(SITE, entry.file.split("?")[0]));
        const dir = join(SITE, dirname(entry.file.split("?")[0]));
        addDir(dir);
    }
}

// --- 6. class-action packages + anchor clips ----------------------------
const classActions = join(SITE, "asset/models/class-actions");
addDir(classActions);
// The anchors supplement lives next to the anim clips (actorview.js reads
// ../asset/rl/anim/anchors.glb.gz relative to the view module).
addDir(join(SITE, "asset/rl/anim"));
// The plain-<script> indexes the uniqueskill loader fetches before play.
add(join(SITE, "asset/uniqueskill/scene-index.json"));
add(join(SITE, "asset/uniqueskill/timeline-index.json"));

// --- 6b. 必杀 cinematics: the 41 playable sceneIds' scene GLBs, timelines,
// and the textures those scenes reference (content-digest PNGs in a shared
// dir). The full tree is 1.2 GB across 1188 identities; the game stages only
// the roster's 41.
const gunzip = (await import("node:zlib")).gunzipSync;
const sceneIndex = JSON.parse(readFileSync(join(SITE, "asset/uniqueskill/scene-index.json"), "utf8"));
const sceneRids = new Set();
for (const row of roster) {
    const card = cards.find(c => c.id === row.id);
    const skillId = card.skillIds.chara;
    const row2 = JSON.parse(readFileSync(join(SITE, "asset/rl/skills-rl.json"), "utf8")).player[skillId];
    if (row2 && row2.sceneId) { sceneRids.add(String(row2.sceneId)); }
}
for (const rid of sceneRids) {
    const entry = sceneIndex.scenes[rid];
    if (!entry) { continue; }
    add(join(SITE, entry.file.split("?")[0]));
    const glbPath = join(SITE, entry.file.split("?")[0]);
    if (!existsSync(glbPath)) { continue; }
    try {
        const gz = readFileSync(glbPath);
        const glb = gunzip(gz);
        // GLB header: 12 bytes, then chunks (len, type, data). The first
        // chunk is JSON; its images[].uri are the texture digest names.
        const jsonLen = glb.readUInt32LE(12);
        const gltf = JSON.parse(glb.slice(20, 20 + jsonLen).toString("utf8"));
        for (const image of gltf.images || []) {
            if (image.uri) { add(join(SITE, "asset/uniqueskill/texture", image.uri)); }
        }
    } catch (error) {
        console.warn("scene texture parse failed for", rid, String(error).slice(0, 80));
    }
    add(join(SITE, "asset/uniqueskill/timeline", rid + ".json"));
}

// --- 7. audio: the voice sheets the indexes cite + BGM ------------------
for (const row of Object.values(voices)) {
    for (const rel of Object.values(row.cues || {})) {
        add(join(SITE, "audio/voice", rel));
    }
}
for (const sheet of Object.keys(bossVoices.sheets || {})) {
    const dir = join(SITE, "audio/voice", sheet);
    addDir(dir);
}
addDir(join(SITE, "audio/bgm"));

function sizeOf(rel) {
    return statSync(join(SITE, rel)).size;
}
let total = 0;
const byCategory = {};
for (const rel of files) {
    const size = sizeOf(rel);
    total += size;
    const category = rel.startsWith("asset/models") ? "models"
        : rel.startsWith("asset/rl") ? "data+effects"
        : rel.startsWith("asset/img") ? "images"
        : rel.startsWith("audio") ? "audio"
        : rel.startsWith("game/") ? "game code"
        : rel.startsWith("core/") ? "core code"
        : rel.startsWith("vendor/") ? "vendor"
        : "other";
    byCategory[category] = (byCategory[category] || 0) + size;
}
const MiB = n => (n / 1048576).toFixed(1) + " MiB";
console.log("deployment closure (reachable files only):", files.size, "files,", MiB(total));
for (const [cat, size] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log("  " + cat.padEnd(14), MiB(size));
}
console.log("Pages limit 1.00 GiB ->", total < 1073741824 ? "FITS" : "OVER by " + MiB(total - 1073741824));
if (jsonOut) {
    const out = { total, byCategory, files: [...files].sort() };
    (await import("node:fs")).writeFileSync(jsonOut, JSON.stringify(out, null, 1) + "\n");
    console.log("wrote", jsonOut);
}
