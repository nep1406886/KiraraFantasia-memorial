// T03 acceptance gate (spec/02 §2, spec/06 T03): structural validation of the
// mapkit output. Node 20+, no dependencies.
//
//   node tools/rl_mapkit_harness.mjs
//
// What "passes" means here:
//   * every mapkit.json entry's GLB exists, parses (magic/chunks/JSON), and
//     its accessor/bufferView/node/skin references are all in bounds
//   * the contract fields hold (category enum, positive footprint, texture
//     file exists, biome known)
//   * an _edge shell ships in the same unit GLB as its body, never in a
//     sibling unit (orphan edges -- body not exported -- are allowed and
//     reported)
//   * no duplicate kit biomes, kit.units matches the entry count, the mapkit
//     directory is within the 8 MB budget
//   * no runtime-hotlink domains in the manifest
//   * the negatives actually fire: each check is re-run against deliberately
//     broken copies of the data and must reject (a negative that "passes"
//     means the injection never ran)
//
// The "edge follows the body across three placements" half of the spec's
// acceptance is a runtime property of T09's mapview; the structural half --
// same GLB, same root -- is what this gate can prove from disk.

import { readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAPKIT_DIR = path.join(ROOT, "site", "asset", "img", "rl", "mapkit");
const MANIFEST = path.join(ROOT, "site", "asset", "rl", "mapkit.json");
const BUDGET_BYTES = 8 * 1024 * 1024;
const CATEGORIES = new Set(["floor", "wall", "prop", "water", "animated"]);
const HOTLINK_DOMAINS = [
    "asset.kirafan.cn", "voice-cri.kirafan.cn", "kirafan.gitlab.io",
    "database.kirafan.cn", "kirafan.moe",
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

// --- GLB structural parse ---------------------------------------------------

function parseGlb(bytes, label) {
    const problems = [];
    if (bytes.length < 20) {
        return { problems: [label + ": shorter than a GLB header"] };
    }
    if (bytes.readUInt32LE(0) !== 0x46546C67) {
        problems.push(label + ": bad magic");
        return { problems };
    }
    if (bytes.readUInt32LE(4) !== 2) {
        problems.push(label + ": not glTF 2.0");
    }
    const declared = bytes.readUInt32LE(8);
    if (declared !== bytes.length) {
        problems.push(label + ": length " + declared + " != file size " + bytes.length);
    }
    let offset = 12;
    let json = null;
    let bin = null;
    while (offset + 8 <= bytes.length) {
        const chunkLength = bytes.readUInt32LE(offset);
        const chunkType = bytes.readUInt32LE(offset + 4);
        if (offset + 8 + chunkLength > bytes.length) {
            problems.push(label + ": chunk overruns the file");
            break;
        }
        const chunk = bytes.subarray(offset + 8, offset + 8 + chunkLength);
        if (chunkType === 0x4E4F534A && json === null) {
            try {
                json = JSON.parse(chunk.toString("utf8"));
            } catch (error) {
                problems.push(label + ": JSON chunk unparseable (" + error.message + ")");
            }
        } else if (chunkType === 0x004E4942 && bin === null) {
            bin = chunk;
        }
        offset += 8 + chunkLength;
    }
    if (!json) {
        problems.push(label + ": no JSON chunk");
    }
    return { problems, json, bin };
}

function validateGlbReferences(json, bin, label) {
    const problems = [];
    if (!json.bufferViews || !json.accessors || !json.nodes) {
        problems.push(label + ": missing bufferViews/accessors/nodes");
        return problems;
    }
    if (!bin) {
        problems.push(label + ": no BIN chunk");
        return problems;
    }
    json.bufferViews.forEach(function (view, i) {
        if (view.byteOffset + view.byteLength > bin.length) {
            problems.push(label + ": bufferView " + i + " out of bounds");
        }
    });
    json.accessors.forEach(function (acc, i) {
        const view = json.bufferViews[acc.bufferView];
        if (!view) {
            problems.push(label + ": accessor " + i + " has no bufferView");
            return;
        }
        const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type] || 0;
        if (!size) {
            problems.push(label + ": accessor " + i + " unknown type " + acc.type);
        }
        const width = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType] || 0;
        if (!width) {
            problems.push(label + ": accessor " + i + " bad componentType");
        }
        const end = (acc.byteOffset || 0) + view.byteOffset + acc.count * size * width;
        if (size && width && end > view.byteOffset + view.byteLength) {
            problems.push(label + ": accessor " + i + " overruns its bufferView");
        }
    });
    json.nodes.forEach(function (node, i) {
        if (node.mesh !== undefined && !json.meshes[node.mesh]) {
            problems.push(label + ": node " + i + " references missing mesh " + node.mesh);
        }
        if (node.skin !== undefined) {
            const skin = json.skins && json.skins[node.skin];
            if (!skin) {
                problems.push(label + ": node " + i + " references missing skin " + node.skin);
                return;
            }
            skin.joints.forEach(function (joint) {
                if (!json.nodes[joint]) {
                    problems.push(label + ": skin joint " + joint + " is not a node");
                }
            });
            if (skin.skeleton !== undefined && !json.nodes[skin.skeleton]) {
                problems.push(label + ": skin skeleton " + skin.skeleton + " is not a node");
            }
            if (!json.accessors[skin.inverseBindMatrices]) {
                problems.push(label + ": skin has no inverseBindMatrices accessor");
            }
        }
    });
    return problems;
}

// --- contract validation ----------------------------------------------------

function validateEntry(entry, kitBiomes, dirOf) {
    const problems = [];
    if (!kitBiomes.has(entry.biome)) {
        problems.push("biome " + entry.biome + " has no kit record");
    }
    if (!CATEGORIES.has(entry.category)) {
        problems.push("category " + entry.category + " not in the enum");
    }
    if (!Array.isArray(entry.footprint) || entry.footprint.length !== 2
        || !(entry.footprint[0] > 0) || !(entry.footprint[1] > 0)) {
        problems.push("footprint " + JSON.stringify(entry.footprint) + " not [w>0, h>0]");
    }
    if (!entry.file || !entry.file.endsWith(".glb.gz")) {
        problems.push("file " + entry.file + " is not a .glb.gz");
    } else {
        try {
            const bytes = gunzipSync(readFileSync(dirOf(entry)));
            const parsed = parseGlb(bytes, entry.biome + "/" + entry.name);
            problems.push(...parsed.problems);
            if (parsed.json && parsed.bin) {
                problems.push(...validateGlbReferences(parsed.json, parsed.bin,
                    entry.biome + "/" + entry.name));
            }
        } catch (error) {
            problems.push(entry.biome + "/" + entry.name + ": " + error.message);
        }
    }
    if (!entry.texture) {
        problems.push("no texture");
    } else {
        const texPath = path.join(MAPKIT_DIR, entry.biome, entry.texture);
        try {
            statSync(texPath);
        } catch {
            problems.push("texture missing on disk: " + entry.biome + "/" + entry.texture);
        }
    }
    return problems;
}

// The edge rule: a mesh named <stem>_<thing>_edge must live in the same unit
// GLB as the mesh <stem>_<thing>. An edge whose body was never exported may
// stand alone (orphan) but must never ride along in a *different* unit.
function validateEdgeGrouping(byKit) {
    const problems = [];
    for (const [biome, units] of byKit) {
        // mesh name -> unit name that carries it
        const ownerOf = new Map();
        for (const [unit, meshes] of units) {
            for (const mesh of meshes) {
                ownerOf.set(mesh, unit);
            }
        }
        for (const [unit, meshes] of units) {
            for (const mesh of meshes) {
                if (!mesh.endsWith("_edge")) {
                    continue;
                }
                const body = mesh.slice(0, -5);
                const owner = ownerOf.get(body);
                if (owner !== undefined && owner !== unit) {
                    problems.push(biome + ": edge " + mesh + " is in unit " + unit
                        + " but its body is in unit " + owner);
                }
            }
        }
    }
    return problems;
}

// --- run --------------------------------------------------------------------

function main() {
    const manifestText = readFileSync(MANIFEST, "utf8");
    const manifest = JSON.parse(manifestText);

    const kits = manifest.kits || [];
    const entries = manifest.entries || [];
    check(kits.length > 0, "mapkit.json has kits");
    check(entries.length > 0, "mapkit.json has entries");

    const kitBiomes = new Set(kits.map(function (k) { return k.biome; }));
    check(kitBiomes.size === kits.length, "kit biomes are unique");

    const entriesByBiome = new Map();
    for (const entry of entries) {
        entriesByBiome.set(entry.biome, (entriesByBiome.get(entry.biome) || 0) + 1);
    }
    for (const kit of kits) {
        const actual = entriesByBiome.get(kit.biome) || 0;
        check(actual === kit.units,
            "kit " + kit.biome + " unit count",
            "record says " + kit.units + ", entries say " + actual);
    }

    const dirOf = (entry) => path.join(MAPKIT_DIR, entry.biome, entry.file);
    const problems = [];
    for (const entry of entries) {
        problems.push(...validateEntry(entry, kitBiomes, dirOf));
    }
    check(problems.length === 0, "all entries pass structural validation",
        problems.slice(0, 8).join("; "));

    // mesh inventory per kit for the edge rule
    const byKit = new Map();
    const orphanEdges = [];
    for (const biome of readdirSync(MAPKIT_DIR)) {
        const dir = path.join(MAPKIT_DIR, biome);
        const units = new Map();
        for (const file of readdirSync(dir)) {
            if (!file.endsWith(".glb.gz")) {
                continue;
            }
            const parsed = parseGlb(gunzipSync(readFileSync(path.join(dir, file))), biome + "/" + file);
            const meshes = (parsed.json && parsed.json.meshes || []).map(function (m) {
                return m.name;
            });
            units.set(file.replace(/\.glb\.gz$/, ""), meshes);
            for (const mesh of meshes) {
                if (mesh.endsWith("_edge") && !meshes.includes(mesh.slice(0, -5))) {
                    orphanEdges.push(biome + "/" + mesh);
                }
            }
        }
        byKit.set(biome, units);
    }
    const edgeProblems = validateEdgeGrouping(byKit);
    check(edgeProblems.length === 0, "edge shells ship with their bodies",
        edgeProblems.slice(0, 5).join("; "));
    if (orphanEdges.length) {
        console.log("note: " + orphanEdges.length + " orphan edge shells (body not exported): "
            + orphanEdges.slice(0, 4).join(", ") + (orphanEdges.length > 4 ? " …" : ""));
    }

    let total = 0;
    for (const biome of readdirSync(MAPKIT_DIR)) {
        for (const file of readdirSync(path.join(MAPKIT_DIR, biome))) {
            total += statSync(path.join(MAPKIT_DIR, biome, file)).size;
        }
    }
    check(total <= BUDGET_BYTES, "mapkit dir within 8 MB budget",
        (total / 1048576).toFixed(2) + " MB");

    const hotlinks = HOTLINK_DOMAINS.filter(function (domain) {
        return manifestText.includes(domain);
    });
    check(hotlinks.length === 0, "no runtime-hotlink domains in mapkit.json",
        hotlinks.join(", "));

    // --- negatives: each must actually reject --------------------------------
    // A mutation that still passes means the check never ran, which is the
    // failure mode that reads as "the gate passed" while proving nothing.
    // Every case therefore asserts both that the injected value took hold
    // and that the validator named it.
    function expectRejection(label, problems, expect, injected) {
        check(injected, "negative: " + label + " (injection took hold)");
        check(problems.some(function (p) { return expect.test(p); }),
            "negative: " + label, problems.join("; ") || "no problems reported");
    }

    const negativeEntry = function (mutate, expect, label) {
        const entry = JSON.parse(JSON.stringify(entries[0]));
        const before = JSON.stringify(entry);
        mutate(entry);
        const injected = JSON.stringify(entry) !== before;
        const problems = validateEntry(entry, kitBiomes, dirOf);
        expectRejection(label, problems, expect, injected);
    };

    negativeEntry(
        (e) => { e.category = "sky"; },
        /category .* not in the enum/,
        "bad category is rejected");

    negativeEntry(
        (e) => { e.footprint = [0, 0.5]; },
        /footprint .* not \[w>0, h>0\]/,
        "non-positive footprint is rejected");

    negativeEntry(
        (e) => { e.file = "no_such_unit.glb.gz"; },
        /no_such_unit|ENOENT/,
        "missing GLB file is rejected");

    {
        // corrupt a real GLB's magic in place, point a copied entry at it
        const source = path.join(MAPKIT_DIR, entries[0].biome, entries[0].file);
        const bytes = gunzipSync(readFileSync(source));
        bytes.writeUInt32LE(0x44444444, 0);
        const corruptPath = path.join(MAPKIT_DIR, entries[0].biome, "__corrupt__.glb.gz");
        writeFileSync(corruptPath, gzipSync(bytes));
        const entry = JSON.parse(JSON.stringify(entries[0]));
        entry.file = "__corrupt__.glb.gz";
        const problems = validateEntry(entry, kitBiomes, dirOf);
        expectRejection("corrupted GLB magic is rejected", problems, /bad magic/,
            statSync(corruptPath).size > 0);
        rmSync(corruptPath, { force: true });
    }

    {
        // split an edge shell out of its body's unit: the grouping rule must
        // name the separation, or the kit had no such pair to split (in which
        // case this negative cannot run and must fail loudly, not pass)
        const biome = "1011_0";
        const units = byKit.get(biome);
        // This kit ships every edge as an orphan (its body was never
        // exported), so there is no real pair to split — inject one instead:
        // the body unit's mesh name must be exactly the edge's derived stem,
        // because that is the name the validator looks up.
        const edgeName = (function () {
            for (const [, meshes] of units) {
                const hit = meshes.find(function (m) { return m.endsWith("_edge"); });
                if (hit) { return hit; }
            }
            return null;
        })();
        if (!edgeName) {
            check(false, "negative: edge separated from its body is rejected",
                "injection never ran: " + biome + " has no edge mesh to name");
        } else {
            const mutated = new Map(units);
            mutated.set("__body__", [edgeName.slice(0, -5)]);
            mutated.set("__edge__", [edgeName]);
            const problems = validateEdgeGrouping(new Map([[biome, mutated]]));
            expectRejection("edge separated from its body is rejected", problems,
                /edge .* is in unit .* but its body is in unit/,
                mutated.get("__edge__").length === 1);
        }
    }

    console.log("\n" + passed + " passed, " + failed + " failed");
    if (failed > 0) {
        process.exitCode = 1;
    }
}

main();
