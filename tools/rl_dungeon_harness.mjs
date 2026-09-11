// Harness for game/rl/dungeon.js (master plan 阶段 2 acceptance).
//
//   node tools/rl_dungeon_harness.mjs
//
// 1. Same seed → byte-identical layout: structure, types AND enemy placement,
//    checked by deep-comparing two runs' JSON.
// 2. Every room reachable from the entrance — 1000 seeds, no exceptions
//    (connectivity is by construction, but the harness proves it).
// 3. Boss room unique and NOT adjacent to the entrance — 1000 seeds.
// 4. Room count within the configured [6, 9] band — 1000 seeds.
// 5. Doors are symmetric and never duplicated; every door connects rooms
//    that actually exist and are grid-adjacent.

import { generateDungeon, bfsDistances, doorsOf, ROOM_SIZE } from "../site/game/rl/dungeon.js";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

const CFG = { roomsMin: 6, roomsMax: 9 };

// --- 1. determinism ---------------------------------------------------------

{
    const a = generateDungeon(12345, CFG);
    const b = generateDungeon(12345, CFG);
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    check("same seed → identical serialized layout", ja === jb);
    // and a different seed must NOT match (vacuity guard for the check above)
    const c = generateDungeon(999, CFG);
    check("vacuity guard: a different seed differs", JSON.stringify(c) !== ja);

    // negative-case proof: the deep compare is not a trivially-true equality.
    // Corrupt one enemy position in a copy and the comparison must fail.
    const tampered = JSON.parse(ja);
    tampered.rooms[0].enemies[0] = tampered.rooms[0].enemies[0] || { x: 1, y: 1 };
    tampered.rooms[0].enemies[0].x += 0.5;
    check("vacuity guard: tampered layout IS detected as different",
        JSON.stringify(tampered) !== ja);
}

// --- 2-4. sweep 1000 seeds ---------------------------------------------------

{
    let unreachable = 0;
    let bossAdjacent = 0;
    let bossNotUnique = 0;
    let outOfBand = 0;
    let countMin = Infinity;
    let countMax = 0;

    for (let seed = 1; seed <= 1000; seed++) {
        const d = generateDungeon(seed, CFG);

        // room count band
        if (d.rooms.length < CFG.roomsMin || d.rooms.length > CFG.roomsMax) {
            outOfBand++;
        }
        countMin = Math.min(countMin, d.rooms.length);
        countMax = Math.max(countMax, d.rooms.length);

        // connectivity: BFS from start must cover every room
        const dist = bfsDistances(d.rooms, d.doors, d.start);
        if (dist.size !== d.rooms.length) {
            unreachable++;
        }

        // boss: unique, and not adjacent to the entrance
        const bosses = d.rooms.filter(function (r) { return r.type === "boss"; });
        if (bosses.length !== 1 || bosses[0].id !== d.boss) {
            bossNotUnique++;
        }
        const startDoors = doorsOf(d, d.start);
        if (startDoors.some(function (door) { return door.to === d.boss; })) {
            bossAdjacent++;
        }
    }

    check("1000 seeds: every room reachable from the entrance", unreachable === 0,
        "unreachable=" + unreachable);
    check("1000 seeds: exactly one boss room", bossNotUnique === 0, "bad=" + bossNotUnique);
    check("1000 seeds: boss room never adjacent to the entrance", bossAdjacent === 0,
        "adjacent=" + bossAdjacent);
    check("1000 seeds: room count stays in [6, 9]", outOfBand === 0,
        "outOfBand=" + outOfBand + " range=[" + countMin + "," + countMax + "]");
}

// --- 5. door sanity -----------------------------------------------------------

{
    let bad = 0;
    let dup = 0;
    for (let seed = 1; seed <= 200; seed++) {
        const d = generateDungeon(seed, CFG);
        const byId = new Map(d.rooms.map(function (r) { return [r.id, r]; }));
        const seen = new Set();
        d.doors.forEach(function (door) {
            const a = byId.get(door.a);
            const b = byId.get(door.b);
            if (!a || !b) { bad++; return; }
            // grid-adjacent with the side matching the offset
            const off = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] }[door.side];
            if (b.x !== a.x + off[0] || b.y !== a.y + off[1]) { bad++; }
            const key = [door.a, door.b].sort().join("-");
            if (seen.has(key)) { dup++; }
            seen.add(key);
        });
        // doorsOf must resolve every door from both endpoints
        d.rooms.forEach(function (room) {
            const mine = doorsOf(d, room.id);
            if (mine.length !== d.doors.filter(function (x) {
                return x.a === room.id || x.b === room.id;
            }).length) { bad++; }
        });
    }
    check("200 seeds: every door connects adjacent existing rooms", bad === 0, "bad=" + bad);
    check("200 seeds: no duplicate doors between the same pair", dup === 0, "dup=" + dup);
}

// --- 6. battle rooms carry enemies; specials don't -----------------------------

{
    let bad = 0;
    for (let seed = 1; seed <= 200; seed++) {
        const d = generateDungeon(seed, CFG);
        d.rooms.forEach(function (room) {
            if ((room.type === "battle" || room.type === "boss") && !room.enemies.length) { bad++; }
            if (room.type === "start" || room.type === "chest" || room.type === "shop" || room.type === "rest") {
                if (room.enemies.length) { bad++; }
            }
            // enemy positions must be inside the room interior
            room.enemies.forEach(function (e) {
                if (e.x < 0 || e.x > ROOM_SIZE.w || e.y < 0 || e.y > ROOM_SIZE.h) { bad++; }
            });
        });
    }
    check("200 seeds: battle/boss rooms spawn enemies, specials don't; positions in-room",
        bad === 0, "bad=" + bad);
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall dungeon checks passed");
process.exit(failures ? 1 : 0);
