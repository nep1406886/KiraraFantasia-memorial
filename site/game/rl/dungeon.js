// Seed-driven room-graph generation (master plan 阶段 2, T08 contract).
//
// generateDungeon(seed, floorCfg) → {
//   rooms: Room[],           // Room = { id, x, y, w, h, type, enemies, seed }
//   doors: Door[],           // Door = { a, b, side }  (side = N|S|E|W from a)
//   start: roomId, boss: roomId,
//   typeOf(room) → string
// }
//
// Pure logic: no three.js, no DOM — node harnesses run this unchanged.
//
// Layout algorithm: a guaranteed spine first, then random growth. The spine
// (a chain of 3-5 rooms from the entrance) exists so the farthest room is
// ALWAYS at BFS distance >= 2 — the boss room can never sit next to the
// entrance, whatever the seed does afterwards. Growth then branches off
// random existing rooms; occasionally an extra door closes a loop, which
// keeps the map from feeling like a pure tree. Every room is placed adjacent
// to an existing one, so the graph is connected by construction — the
// harness still proves it over 1000 seeds.
//
// All randomness flows through random.js createRandom, so identical seeds
// reproduce the layout bit-for-bit (structure, types, enemy placement).

import { createRandom, hash32 } from "./random.js";

export const ROOM_TYPES = ["start", "battle", "chest", "shop", "rest", "boss"];

const DIRS = [
    { name: "N", dx: 0, dy: -1, opposite: "S" },
    { name: "S", dx: 0, dy: 1, opposite: "N" },
    { name: "W", dx: -1, dy: 0, opposite: "E" },
    { name: "E", dx: 1, dy: 0, opposite: "W" }
];

// Physical dimensions are separate from a Room's graph-cell w/h. Combat
// retains its arena; service rooms are compact, not camera-scaled arenas.
//
// 24×18 (T21c, 2026-09-04): the launch 16×12 read as a closet next to
// 东方华彩乱战2's stages — the user's own comparison and the reason the
// rooms grew 1.5× on each axis. The camera framing stays at the original
// game's ortho size (view/camera.js), so the growth is real stage space,
// not a zoom-out illusion. mapview scales its authored prop recipes by
// area to keep the density; the balance instrument is analytic
// (rl_balance_harness models uptime, not geometry), so T16 gates were
// re-run as the safety net, not as the measurer.
export const ROOM_SIZE = Object.freeze({ w: 32, h: 24 });
const SERVICE_ROOM_SIZES = Object.freeze({
    start: Object.freeze({ w: 20, h: 16 }),
    chest: Object.freeze({ w: 16, h: 12 }),
    shop: Object.freeze({ w: 20, h: 16 }),
    rest: Object.freeze({ w: 20, h: 16 })
});

export function roomSize(room) {
    const type = typeof room === "string" ? room : room?.type;
    return Object.hasOwn(SERVICE_ROOM_SIZES, type) ? SERVICE_ROOM_SIZES[type] : ROOM_SIZE;
}

export function generateDungeon(seed, floorCfg) {
    const cfg = Object.assign({
        roomsMin: 6,
        roomsMax: 9,
        spineMin: 3,        // entrance chain length (guarantees boss distance)
        spineMax: 5,
        chest: 1,
        shop: 1,
        rest: 1,
        // 24×18 rooms (T21c) hold more than the 16×12 counts: ×2.25 area,
        // but capped short of it — the same-screen ≤10 perf budget and the
        // threat band both need headroom (spec/06 T21e 密度).
        enemiesMin: 3,      // per battle room (before scaling)
        enemiesMax: 6,
        loopChance: 0.25    // chance an adjacency to an existing room adds a door
    }, floorCfg || {});

    const rng = createRandom(typeof seed === "number" ? seed >>> 0 : hash32(String(seed)));

    const rooms = [];
    const byCell = new Map();      // "x,y" → room
    const doors = [];
    let nextId = 1;

    function place(x, y) {
        const room = {
            id: nextId++,
            x: x,
            y: y,
            w: 1,
            h: 1,
            type: "battle",        // assigned properly once the graph is done
            enemies: [],
            seed: Math.floor(rng() * 0xFFFFFFFF) >>> 0
        };
        rooms.push(room);
        byCell.set(x + "," + y, room);
        return room;
    }

    function connect(a, b, side) {
        doors.push({ a: a.id, b: b.id, side: side });
    }

    // --- spine: entrance plus a chain, so depth >= 2 always exists ----------
    const spineLen = cfg.spineMin + Math.floor(rng() * (cfg.spineMax - cfg.spineMin + 1));
    const start = place(0, 0);
    start.type = "start";
    let cursor = start;
    for (let i = 0; i < spineLen; i++) {
        const free = DIRS.filter(function (d) {
            return !byCell.has((cursor.x + d.dx) + "," + (cursor.y + d.dy));
        });
        if (!free.length) {
            break;      // boxed in; depth is whatever we reached
        }
        const dir = free[Math.floor(rng() * free.length)];
        const next = place(cursor.x + dir.dx, cursor.y + dir.dy);
        connect(cursor, next, dir.name);
        cursor = next;
    }

    // --- growth: branch from random rooms until the target count ------------
    const target = cfg.roomsMin + Math.floor(rng() * (cfg.roomsMax - cfg.roomsMin + 1));
    let guard = 500;
    while (rooms.length < target && guard-- > 0) {
        const from = rooms[Math.floor(rng() * rooms.length)];
        // Fisher-Yates, not sort(-> rng() - 0.5): a comparator that lies
        // about ordering makes the permutation depend on the sort
        // algorithm's internals, and node's V8 and Chromium's V8 disagree —
        // the same seed built different dungeons in the harness and the
        // browser. Fisher-Yates consumes the stream identically everywhere.
        const shuffled = DIRS.slice();
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const swap = shuffled[i];
            shuffled[i] = shuffled[j];
            shuffled[j] = swap;
        }
        let placed = false;
        for (let i = 0; i < shuffled.length && !placed; i++) {
            const dir = shuffled[i];
            const cell = (from.x + dir.dx) + "," + (from.y + dir.dy);
            if (byCell.has(cell)) {
                // adjacency to an existing room: maybe add a loop door, but
                // never duplicate a connection
                const other = byCell.get(cell);
                const already = doors.some(function (d) {
                    return (d.a === from.id && d.b === other.id)
                        || (d.a === other.id && d.b === from.id);
                });
                if (!already && rng() < cfg.loopChance) {
                    connect(from, other, dir.name);
                }
                continue;
            }
            const room = place(from.x + dir.dx, from.y + dir.dy);
            connect(from, room, dir.name);
            placed = true;
        }
    }

    // --- boss: the BFS-farthest room from the entrance ----------------------
    const distance = bfsDistances(rooms, doors, start.id);
    let boss = rooms[rooms.length - 1];
    let best = -1;
    rooms.forEach(function (room) {
        if (room.id === start.id) {
            return;
        }
        const d = distance.get(room.id);
        if (d !== undefined && d > best) {
            best = d;
            boss = room;
        }
    });
    boss.type = "boss";

    // --- special rooms: chest / shop / rest ----------------------------------
    // Handed out from the remaining rooms, farthest-first for the chest so
    // the reward sits deep in the floor; shop/rest pick randomly.
    const candidates = rooms
        .filter(function (r) { return r.type === "battle"; })
        .sort(function (a, b) { return (distance.get(b.id) || 0) - (distance.get(a.id) || 0); });

    function takeSpecial(count, type) {
        let left = count;
        while (left > 0 && candidates.length) {
            const index = type === "chest" ? 0 : Math.floor(rng() * candidates.length);
            candidates.splice(index, 1)[0].type = type;
            left--;
        }
    }
    takeSpecial(cfg.chest, "chest");
    takeSpecial(cfg.shop, "shop");
    takeSpecial(cfg.rest, "rest");

    // --- enemy placement ------------------------------------------------------
    rooms.forEach(function (room) {
        if (room.type !== "battle" && room.type !== "boss") {
            return;
        }
        const roomRng = createRandom(room.seed);
        const count = room.type === "boss"
            ? 1
            : cfg.enemiesMin + Math.floor(roomRng() * (cfg.enemiesMax - cfg.enemiesMin + 1));
        for (let i = 0; i < count; i++) {
            // room-local world coordinates; the game layer maps these to the
            // shared ROOM_SIZE interior and picks the model from the floor's
            // enemy pool (T01 data, stage 3)
            room.enemies.push({
                kind: room.type === "boss" ? "boss" : "sentry",
                x: 2.5 + roomRng() * (ROOM_SIZE.w - 5),
                y: 1.5 + roomRng() * (ROOM_SIZE.h - 3)
            });
        }
    });

    return {
        rooms: rooms,
        doors: doors,
        start: start.id,
        boss: boss.id,
        typeOf: function (room) { return room.type; }
    };
}

export function bfsDistances(rooms, doors, fromId) {
    const adjacent = new Map();
    rooms.forEach(function (room) { adjacent.set(room.id, []); });
    doors.forEach(function (door) {
        if (adjacent.has(door.a)) { adjacent.get(door.a).push(door.b); }
        if (adjacent.has(door.b)) { adjacent.get(door.b).push(door.a); }
    });
    const dist = new Map([[fromId, 0]]);
    const queue = [fromId];
    while (queue.length) {
        const id = queue.shift();
        (adjacent.get(id) || []).forEach(function (next) {
            if (!dist.has(next)) {
                dist.set(next, dist.get(id) + 1);
                queue.push(next);
            }
        });
    }
    return dist;
}

// Doors of one room, resolved to objects: { to: roomId, side, at: {x, y} }
// where `at` is the door's mid-point in room-local world units.
export function doorsOf(dungeon, roomId) {
    const out = [];
    const size = roomSize(dungeon.rooms.find(room => room.id === roomId));
    // Hand-built harness fixtures may carry rooms only — an absent door
    // list means "no doors", not "crash the barrel roll".
    (dungeon.doors || []).forEach(function (door) {
        if (door.a === roomId) {
            out.push({ to: door.b, side: door.side, at: doorAt(door.side, size) });
        } else if (door.b === roomId) {
            const opposite = DIRS.find(function (d) { return d.name === door.side; }).opposite;
            out.push({ to: door.a, side: opposite, at: doorAt(opposite, size) });
        }
    });
    return out;
}

function doorAt(side, size) {
    return {
        N: { x: size.w / 2, y: 0 },
        S: { x: size.w / 2, y: size.h },
        W: { x: 0, y: size.h / 2 },
        E: { x: size.w, y: size.h / 2 }
    }[side];
}
