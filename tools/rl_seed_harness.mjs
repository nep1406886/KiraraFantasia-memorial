// T24 acceptance (spec/07 §6): one uint32 run seed drives the layout stream,
// v1 saves migrate deterministically, and a corrupted run slot never reaches
// the fight. The pure logic lives in game/rl/runschema.js, so this harness
// pins exactly what the browser reads — without a renderer.
//
//   node tools/rl_seed_harness.mjs

import {
    RUN_SCHEMA_VERSION, RUN_GENERATOR_VERSION,
    parseRunSnapshot, buildRunPayload, layoutSeedFor, legacySeedFor, isUint32
} from "../site/game/rl/runschema.js";
import { generateDungeon } from "../site/game/rl/dungeon.js";
import * as save from "../site/game/rl/save.js";
import { checkProfileEnvelope } from "../site/game/rl/profileschema.js";

// This transport fixture predates the content-aware import gate in rl_storage_harness.
save.setImportValidator(checkProfileEnvelope);

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

const floorCfg = { roomsMin: 6, roomsMax: 9 };
const snapshot = {
    schemaVersion: RUN_SCHEMA_VERSION,
    roomClaims: [],
    generatorVersion: RUN_GENERATOR_VERSION,
    seed: 0xC0FFEE01,
    volume: 2,
    floor: 13,
    cardId: 403100,
    level: 7,
    exp: 120,
    hp: 42,
    gauge: 55.5,
    coin: 88,
    stackHits: 3,
    stackKills: 1,
    equipment: [
        {
            slot: "weapon", rarity: "rare", affixes: ["atk"], weaponId: "w1"
        },
        { slot: "charm", rarity: "common", affixes: [] }
    ]
};

// --- 1. same seed → byte-identical layout -------------------------------------

const layoutA = generateDungeon(layoutSeedFor(snapshot.seed, snapshot.floor), floorCfg);
const layoutB = generateDungeon(layoutSeedFor(snapshot.seed, snapshot.floor), floorCfg);
check("same seed/floor → byte-identical layout",
    JSON.stringify(layoutA) === JSON.stringify(layoutB));

// Different seeds actually build a different map. One floor differing is
// enough (hashes cannot be proven disjoint in general, but 2/2 is strong
// evidence the stream is really seed-driven and not accidentally constant).
let differ = 0;
for (const floor of [1, 2, 3]) {
    if (JSON.stringify(generateDungeon(layoutSeedFor(1, floor), floorCfg))
            !== JSON.stringify(generateDungeon(layoutSeedFor(2, floor), floorCfg))) {
        differ += 1;
    }
}
check("different seeds build different layouts (3/3 floors)", differ === 3);

// --- 2. migration is deterministic ---------------------------------------------

const legacy = JSON.parse(JSON.stringify(snapshot));
delete legacy.schemaVersion;
delete legacy.generatorVersion;
delete legacy.seed;
const migrated = parseRunSnapshot(legacy, 20);
check("v1 snapshot migrates with a deterministic uint32 seed",
    migrated !== null && isUint32(migrated.seed)
    && migrated.seed === legacySeedFor(legacy.volume)
    && migrated.seed === parseRunSnapshot(
        JSON.parse(JSON.stringify(legacy)), 20).seed);
check("migration rewrites the envelope to the current version",
    buildRunPayload(migrated).schemaVersion === RUN_SCHEMA_VERSION
    && buildRunPayload(migrated).generatorVersion === RUN_GENERATOR_VERSION);

// --- 3. corrupt snapshots are refused ------------------------------------------

function rejects(label, mutate) {
    const broken = JSON.parse(JSON.stringify(snapshot));
    mutate(broken);
    check(label, parseRunSnapshot(broken, 20) === null);
}
rejects("schemaVersion 0 rejected", function (s) { s.schemaVersion = 0; });
rejects("future schemaVersion rejected", function (s) { s.schemaVersion = 4; });
rejects("non-finite seed rejected", function (s) { s.seed = Infinity; });
rejects("negative seed rejected", function (s) { s.seed = -1; });
rejects("fractional seed rejected", function (s) { s.seed = 1.5; });
rejects("wrong generator rejected", function (s) { s.generatorVersion = "old"; });
rejects("floor past the ladder rejected", function (s) { s.floor = 21; });
rejects("volume 0 rejected", function (s) { s.volume = 0; });
rejects("cardId 0 rejected", function (s) { s.cardId = 0; });
rejects("fractional level rejected", function (s) { s.level = 1.5; });
rejects("non-finite hp rejected", function (s) { s.hp = Infinity; });
rejects("non-finite exp rejected", function (s) { s.exp = Infinity; });
rejects("non-finite coin rejected", function (s) { s.coin = Infinity; });
rejects("non-finite gauge rejected", function (s) { s.gauge = Infinity; });
rejects("non-finite stackHits rejected", function (s) { s.stackHits = Infinity; });
rejects("duplicate equipment slot rejected", function (s) {
    s.equipment[1].slot = "weapon";
});
rejects("unknown rarity rejected", function (s) {
    s.equipment[0].rarity = "exotic";
});
rejects("non-string affix rejected", function (s) {
    s.equipment[0].affixes[0] = 7;
});

// --- 4. import validates the whole bundle ---------------------------------------

// exportSave enumerates a Storage-shaped backend (length/key), so the harness
// uses the same fake the save harness does — a raw Map breaks the loop.
function fakeStorage() {
    const memory = new Map();
    return {
        getItem: function (k) { return memory.has(k) ? memory.get(k) : null; },
        setItem: function (k, v) { memory.set(k, String(v)); },
        removeItem: function (k) { memory.delete(k); },
        get length() { return memory.size; },
        key: function (i) { return Array.from(memory.keys())[i] || null; }
    };
}

// Schema-invalid run slots are refused at boot (section 3); importSave's job
// is the T24 whole-bundle JSON guarantee: every entry must parse, and nothing
// is written unless ALL entries do.
const origin = fakeStorage();
save.setStorage(origin);
save.write("meta", { volumes: 3 });
save.write("run", snapshot);
const exported = save.exportSave();

const clean = fakeStorage();
save.setStorage(clean);
check("clean re-import lands both slots", save.importSave(exported).ok
    && save.load("meta").volumes === 3
    && save.load("run").seed === snapshot.seed);

const oneBadEntry = JSON.parse(exported);
oneBadEntry["run"] = "{truncated";
const target = fakeStorage();
save.setStorage(target);
save.write("meta", { volumes: 1 });
save.write("run", snapshot);
check("one corrupt entry fails the whole import, target untouched",
    !save.importSave(JSON.stringify(oneBadEntry)).ok
    && save.load("run").seed === snapshot.seed
    && save.load("meta").volumes === 1);

console.log(failures === 0 ? "\nALL GREEN" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
