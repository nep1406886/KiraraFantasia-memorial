// Mixed room sizes: physical boundaries, door entries, claims and deterministic layout.
// node tools/rl_roomsize_harness.mjs
import assert from "node:assert/strict";
import * as dungeon from "../site/game/rl/dungeon.js";
import { createWorld } from "../site/game/rl/world.js";
import { createRoomLayout } from "../site/game/rl/view/roomlayout.js";

let failures = 0, checks = 0;
function check(name, run) {
    checks++;
    try { run(); console.log("PASS " + name); }
    catch (error) { failures++; console.error("FAIL " + name + ": " + error.message); }
}
const expected = { start: [20, 16], chest: [16, 12], shop: [20, 16], rest: [20, 16],
    battle: [32, 24], boss: [32, 24] };
const sizeOf = room => dungeon.roomSize ? dungeon.roomSize(room) : dungeon.ROOM_SIZE;
const rooms = Object.keys(expected).map((type, i) => ({ id: i + 1, type, x: i, y: 0, w: 1, h: 1, seed: i + 21, enemies: [] }));
const graph = { rooms, doors: rooms.slice(1).map(r => ({ a: 1, b: r.id, side: "E" })), start: 1, boss: 6 };

for (const room of rooms) {
    check(room.type + " uses its intended physical size", () => {
        const size = sizeOf(room); assert.deepEqual([size.w, size.h], expected[room.type]);
    });
    check(room.type + " world, doors, spawn and interactions agree", () => {
        const world = createWorld({ seed: 72 }); world.spawnPlayer({}); world.setDungeon(graph);
        world.enterRoom(room.id, null);
        const [w, h] = expected[room.type];
        assert.deepEqual([world.width, world.height, world.player.x, world.player.y], [w, h, w / 2, h / 2]);
        for (const at of [world.chest, world.npc, world.altar].filter(Boolean)) {
            assert.ok(at.x > 0 && at.x < w && at.y > 0 && at.y < h);
        }
        const positions = { N: [w / 2, 1.2], S: [w / 2, h - 1.2], W: [1.2, h / 2], E: [w - 1.2, h / 2] };
        for (const [side, at] of Object.entries(positions)) {
            world.enterRoom(room.id, side); assert.deepEqual([world.player.x, world.player.y], at);
        }
        const claim = world.getRoomClaims(); world.setDungeon(graph, claim); world.enterRoom(room.id, null);
        assert.deepEqual([world.width, world.height], [w, h]);
    });
    check(room.type + " layout paths end at real boundaries", () => {
        const [w, h] = expected[room.type], size = { w, h };
        const layout = createRoomLayout(null, ["N", "E", "S", "W"], size);
        assert.deepEqual(layout.center, { x: size.w / 2, y: size.h / 2 });
        for (const p of layout.paths) for (const [x, y] of [[p.x1, p.y1], [p.x2, p.y2]]) {
            assert.ok(x >= 0 && x <= size.w && y >= 0 && y <= size.h);
        }
        for (const bed of layout.beds) assert.ok(bed.x > 0 && bed.x < size.w && bed.y > 0 && bed.y < size.h);
    });
}
check("1000 seeds keep deterministic graphs and correct door coordinates", () => {
    for (let seed = 0; seed < 1000; seed++) {
        const a = dungeon.generateDungeon(seed);
        assert.equal(JSON.stringify(a), JSON.stringify(dungeon.generateDungeon(seed)));
        for (const room of a.rooms) {
            const [w, h] = expected[room.type], size = { w, h };
            const at = { N: { x: size.w / 2, y: 0 }, E: { x: size.w, y: size.h / 2 },
                S: { x: size.w / 2, y: size.h }, W: { x: 0, y: size.h / 2 } };
            for (const door of dungeon.doorsOf(a, room.id)) assert.deepEqual(door.at, at[door.side]);
            for (const e of room.enemies) assert.ok(e.x > 0 && e.x < size.w && e.y > 0 && e.y < size.h);
        }
    }
});
check("room sizing is immutable and never mutates the combat default", () => {
    assert.ok(Object.isFrozen(sizeOf({ type: "rest" })));
    assert.deepEqual(dungeon.ROOM_SIZE, { w: 32, h: 24 });
});
console.log(`${checks - failures}/${checks} passed`);
process.exitCode = failures ? 1 : 0;
