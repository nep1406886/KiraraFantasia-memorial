#!/usr/bin/env node
// 段级敌人池 harness (spec/02 §3.3, T17's deferred item):
//   data   — encounters.json's mobSegments is a true 4-way partition of mobs
//   world  — spawnRoomEnemies/requestSummon draw from the CURRENT segment's
//            pool (floors 1-5/6-10/11-15/16-20), with the legacy fallbacks
// Pure logic: createWorld with a mocked stats table, the rl_progression
// harness's fixture pattern. Expectations are authored here, never read out
// of the pipeline under test.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld } from "../site/game/rl/world.js";
import { generateDungeon } from "../site/game/rl/dungeon.js";
import { seedFrom } from "../site/game/rl/random.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function assert(cond, msg) {
    if (!cond) {
        console.error("✗", msg);
        failed += 1;
    } else {
        console.log("✓", msg);
    }
}

// --- 1. data: the authored partition -----------------------------------------

console.log("\nGate 1: encounters.json mobSegments is a 4-way partition of mobs");
{
    const volumes = JSON.parse(
        readFileSync(join(ROOT, "asset", "rl", "encounters.json"), "utf8")).volumes;
    assert(volumes.length === 5, "five volumes present");
    volumes.forEach(function (vol) {
        const segs = vol.mobSegments;
        assert(Array.isArray(segs) && segs.length === 4,
            "vol" + vol.vol + " has exactly 4 segment pools");
        assert(segs.every(function (s) { return s.length >= 2; }),
            "vol" + vol.vol + " every segment has >= 2 faces ("
            + segs.map(function (s) { return s.length; }).join("/") + ")");
        const segIds = segs.flat().map(function (m) { return m.id; });
        const mobIds = vol.mobs.map(function (m) { return m.id; });
        // T22e raised the pools from 10 to 16-17; the invariant is that the
        // segments are a partition of mobs (same set, no dupes), not a count.
        assert(segIds.length === mobIds.length
            && mobIds.length >= 15 && mobIds.length <= 20,
            "vol" + vol.vol + " partition covers every mob exactly once ("
            + mobIds.length + " faces, no additions)");
        const segSet = new Set(segIds);
        assert(segSet.size === segIds.length,
            "vol" + vol.vol + " no id appears in two segments");
        assert(mobIds.every(function (id) { return segSet.has(id); }),
            "vol" + vol.vol + " every mobs[] entry is reachable from a segment");
    });
}

// --- fixtures -----------------------------------------------------------------

const mockStats = {
    statsFor: function () {
        return { hp: 100, atk: 10, mgc: 5, def: 2, mdef: 2, spd: 100, luck: 60 };
    },
    enemyStats: function (id) {
        return { hp: 50 + id, atk: 5, mgc: 5, def: 1, mdef: 1, spd: 100, luck: 0 };
    },
    card: function () { return null; }
};

function mob(id) {
    return {
        id: id, name: "m" + id, nameZh: "敌" + id, model: "x", element: 1,
        aiType: "sentry", shadowScale: 2, voiceCueSheet: "", skills: []
    };
}

const SEGMENT_ENCOUNTER = {
    vol: 1, level: 5, playerLevel: 1,
    mobs: [mob(1), mob(2), mob(3), mob(4), mob(5), mob(6)],
    mobSegments: [[mob(1), mob(2)], [mob(3)], [mob(4), mob(5)], [mob(6)]],
    elites: [], boss: null
};

// One fresh world at `floor`, entered into its first battle room. Returns
// the ids of the enemies that spawned there ([] if the room rolled empty,
// which the callers treat as a vacuous pass -- so they also assert nonzero).
function spawnIdsAtFloor(floor, encounter, floorsPerVolume) {
    const world = createWorld({
        seed: 4242,
        volume: 1,
        floor: floor,
        floorsPerVolume: floorsPerVolume,
        tables: { stats: mockStats, encounter: encounter }
    });
    const dungeon = generateDungeon(seedFrom("seg harness floor " + floor)() * 0xFFFFFFFF,
        { roomsMin: 6, roomsMax: 9 });
    world.setDungeon(dungeon);
    const battle = dungeon.rooms.find(function (r) { return r.type === "battle"; });
    if (!battle) {
        return null;
    }
    world.enterRoom(battle.id, "N");
    return world.enemies.map(function (e) { return e.enemyId; });
}

// --- 2. world: the current segment's pool, per floor band ----------------------

console.log("\nGate 2: spawns draw from the current segment's pool");
{
    const bands = [
        { floors: [1, 5], expected: [1, 2] },
        { floors: [6, 10], expected: [3] },
        { floors: [11, 15], expected: [4, 5] },
        { floors: [16, 20], expected: [6] }
    ];
    bands.forEach(function (band) {
        band.floors.forEach(function (floor) {
            const ids = spawnIdsAtFloor(floor, SEGMENT_ENCOUNTER, 20);
            assert(ids !== null && ids.length > 0,
                "floor " + floor + " spawned enemies (not a vacuous check)");
            if (ids && ids.length) {
                const ok = ids.every(function (id) {
                    return band.expected.indexOf(id) >= 0;
                });
                assert(ok, "floor " + floor + " only spawns segment faces "
                    + JSON.stringify(band.expected) + " (saw " + ids.join(",") + ")");
            }
        });
    });
}

// --- 3. world: the fallbacks ---------------------------------------------------

console.log("\nGate 3: legacy shapes keep the union");
{
    const FLAT_ENCOUNTER = {
        vol: 1, level: 5, playerLevel: 1,
        mobs: [mob(1), mob(2), mob(3), mob(4), mob(5), mob(6)],
        elites: [], boss: null
    };
    // No mobSegments at all (an encounter authored before the split).
    const ids = spawnIdsAtFloor(14, FLAT_ENCOUNTER, 20);
    assert(ids && ids.length > 0 && ids.every(function (id) { return id >= 1 && id <= 6; }),
        "a flat encounter still spawns from the union at floor 14 (saw "
        + (ids ? ids.join(",") : "none") + ")");

    // Single-floor worlds (fixtures, legacy gates) ignore segments by design.
    const single = spawnIdsAtFloor(1, SEGMENT_ENCOUNTER, 1);
    assert(single && single.length > 0
        && single.every(function (id) { return id >= 1 && id <= 6; }),
        "a single-floor world spawns from the union (saw "
        + (single ? single.join(",") : "none") + ")");

    // An empty segment pool must not empty the room.
    const HOLE_ENCOUNTER = {
        vol: 1, level: 5, playerLevel: 1,
        mobs: [mob(1), mob(2), mob(3), mob(4), mob(5), mob(6)],
        mobSegments: [[mob(1), mob(2)], [], [mob(4)], []],
        elites: [], boss: null
    };
    const hole = spawnIdsAtFloor(8, HOLE_ENCOUNTER, 20);
    assert(hole && hole.length > 0
        && hole.every(function (id) { return id >= 1 && id <= 6; }),
        "an empty segment pool falls back to the union (saw "
        + (hole ? hole.join(",") : "none") + ")");
}

// --- 4. world: requestSummon draws from the segment pool ------------------------

console.log("\nGate 4: boss adds draw from the current segment's pool");
{
    const world = createWorld({
        seed: 99,
        volume: 1,
        floor: 17,                    // band 3 -> faces [6] only
        floorsPerVolume: 20,
        tables: { stats: mockStats, encounter: SEGMENT_ENCOUNTER }
    });
    const dungeon = generateDungeon(seedFrom("summon")() * 0xFFFFFFFF,
        { roomsMin: 6, roomsMax: 9 });
    world.setDungeon(dungeon);
    world.roomId = dungeon.rooms[0].id;   // requestSummon needs a room
    const fakeBoss = { x: world.width / 2, y: world.height / 2 };
    const made = world.requestSummon(fakeBoss, 2);
    assert(made === 1, "one add per phase flip");
    const added = world.enemies.filter(function (e) { return e.summoned; });
    assert(added.length === 1 && added[0].enemyId === 6,
        "the add is the current segment's face (id "
        + (added[0] && added[0].enemyId) + ", expected 6)");
}

console.log("");
if (failed) {
    console.error("SEGMENTS HARNESS: " + failed + " FAILURES");
    process.exit(1);
}
console.log("SEGMENTS HARNESS: ALL OK");
