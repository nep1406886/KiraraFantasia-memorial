// Harness for game/rl/world.js movement (master plan 阶段 1 acceptance).
//
//   node tools/rl_move_harness.mjs
//
// 1. Straight-line speed: 1s of pure right input moves the player exactly
//    PLAYER_TIMING.moveSpeed (3.5) world units.
// 2. Diagonal input is normalized: 1s of (1,1) covers no more ground than
//    the straight-line speed in any axis or in magnitude.
// 3. Walls: driving into a wall for 2s leaves the player inside
//    [radius, width - radius]; no penetration.
// 4. Dodge: moves the player, grants exactly dodgeIframes of invulnerability
//    at the start, and decays it over time.
//
// The world imports nothing from three or the DOM, so this runs in plain node.

import { createWorld } from "../site/game/rl/world.js";
import { PLAYER_TIMING } from "../site/game/rl/actorstate.js";
import { generateDungeon, doorsOf } from "../site/game/rl/dungeon.js";
import { tryHit } from "../site/game/rl/combat.js";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

function freshInput() {
    return { move: { x: 0, y: 0 }, attack: false, dodge: false, skill: [false, false, false], ultimate: false, menu: false };
}

const W = 30;   // a big room so wall clamps don't interfere with speed tests
const H = 30;

// --- 1. straight-line speed ----------------------------------------------

{
    const world = createWorld({ width: W, height: H });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 15, y: 15 });
    input.move.x = 1;
    for (let i = 0; i < 60; i++) { world.update(1 / 60); }
    const moved = p.x - 15;
    check("1s right input moves exactly moveSpeed units",
        Math.abs(moved - PLAYER_TIMING.moveSpeed) < 1e-9,
        "moved=" + moved.toFixed(6) + " speed=" + PLAYER_TIMING.moveSpeed);
    check("no drift on the perpendicular axis", Math.abs(p.y - 15) < 1e-9);
}

// --- 2. diagonal normalization --------------------------------------------

{
    const world = createWorld({ width: W, height: H });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 5, y: 5 });
    input.move.x = 1; input.move.y = 1;
    for (let i = 0; i < 60; i++) { world.update(1 / 60); }
    const dx = p.x - 5;
    const dy = p.y - 5;
    const dist = Math.hypot(dx, dy);
    check("diagonal displacement magnitude <= straight speed",
        dist <= PLAYER_TIMING.moveSpeed + 1e-9,
        "dist=" + dist.toFixed(6) + " speed=" + PLAYER_TIMING.moveSpeed);
    check("diagonal axis components <= straight speed",
        dx <= PLAYER_TIMING.moveSpeed + 1e-9 && dy <= PLAYER_TIMING.moveSpeed + 1e-9,
        "dx=" + dx.toFixed(4) + " dy=" + dy.toFixed(4));
    // 45° input must split evenly: dx == dy when both axes held equally.
    check("45° input splits evenly between axes",
        Math.abs(dx - dy) < 1e-9, "dx=" + dx.toFixed(6) + " dy=" + dy.toFixed(6));
}

// --- 3. wall clamp ---------------------------------------------------------

{
    const world = createWorld({ width: 10, height: 8 });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 5, y: 4 });
    input.move.x = -1;                       // drive into the west wall
    for (let i = 0; i < 120; i++) { world.update(1 / 60); }
    check("west wall: player clamped at radius",
        Math.abs(p.x - p.radius) < 1e-9, "x=" + p.x);
    input.move.x = 0; input.move.y = -1;     // north wall
    for (let i = 0; i < 120; i++) { world.update(1 / 60); }
    check("north wall: player clamped at radius",
        Math.abs(p.y - p.radius) < 1e-9, "y=" + p.y);
    input.move.y = 0; input.move.x = 1;      // east wall
    // the player is at x=0.45 after the west test; 9.1 units to travel needs
    // 2.6s, so run 3s
    for (let i = 0; i < 180; i++) { world.update(1 / 60); }
    check("east wall: player clamped at width - radius",
        Math.abs(p.x - (world.width - p.radius)) < 1e-9, "x=" + p.x);
    // and the corner: both axes pressed stays inside on both
    input.move.x = 1; input.move.y = 1;
    for (let i = 0; i < 120; i++) { world.update(1 / 60); }
    check("corner clamp holds both axes",
        p.x <= world.width - p.radius + 1e-9 && p.y <= world.height - p.radius + 1e-9,
        "x=" + p.x.toFixed(4) + " y=" + p.y.toFixed(4));
}

// --- 4. dodge ---------------------------------------------------------------

{
    const world = createWorld({ width: W, height: H });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 15, y: 15 });
    const startX = p.x;
    input.dodge = true;
    world.update(1 / 60);                    // dodge starts on this tick
    input.dodge = false;
    check("dodge entered", p.sm.state === "dodge", p.sm.state);
    check("dodge grants iframes on start",
        Math.abs(p.iframes - PLAYER_TIMING.dodgeIframes) < 1e-9,
        "iframes=" + p.iframes);
    for (let i = 0; i < 59; i++) { world.update(1 / 60); }  // 1s total
    const moved = p.x - startX;
    // move input is (0,0) the whole time, so the only displacement is the
    // dodge burst itself: speed * mult * duration.
    const expected = PLAYER_TIMING.moveSpeed * PLAYER_TIMING.dodgeSpeedMult * PLAYER_TIMING.dodgeDuration;
    check("dodge moves the player by the burst distance",
        Math.abs(moved - expected) < 1e-6,
        "moved=" + moved.toFixed(4) + " expected=" + expected.toFixed(4));
    check("dodge ends back in idle", p.sm.state === "idle", p.sm.state);
    check("iframes decayed to zero", p.iframes === 0, "iframes=" + p.iframes);
}

// --- 5. attack locks movement -------------------------------------------------

{
    const world = createWorld({ width: W, height: H });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 15, y: 15 });
    const startX = p.x;
    input.attack = true;
    world.update(1 / 60);
    input.attack = false;
    check("attack entered", p.sm.state === "attack", p.sm.state);
    input.move.x = 1;    // try to walk mid-swing
    for (let i = 0; i < 10; i++) { world.update(1 / 60); }
    check("movement locked during attack", p.x === startX, "x=" + p.x);
    for (let i = 0; i < 60; i++) { world.update(1 / 60); }
    check("after the swing, held move input resumes movement",
        p.sm.state === "move" && p.x > startX, p.sm.state + " x=" + p.x.toFixed(3));
}

// --- 6. room transitions (stage 2) -------------------------------------------

{
    // a known-fixed dungeon: seed 7, checked for its door layout below
    const dungeon = generateDungeon(7, { roomsMin: 6, roomsMax: 9 });
    const world = createWorld();
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({});
    world.setDungeon(dungeon);
    check("setDungeon enters the start room", world.roomId === dungeon.start,
        "roomId=" + world.roomId + " start=" + dungeon.start);

    // walk east through the east door if the start room has one; otherwise
    // pick whichever door exists and walk that way
    const doors = doorsOf(dungeon, dungeon.start);
    check("start room has at least one door", doors.length >= 1, "doors=" + doors.length);
    const door = doors.find(function (d) { return d.side === "E"; })
        || doors.find(function (d) { return d.side === "S"; })
        || doors[0];
    const dir = { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 }, E: { x: 1, y: 0 } }[door.side];

    // The entrance spawns at room center, already aligned with each door.
    // Bound the walk by real distance, not the old 24-unit room's 4 seconds.
    const maxSteps = Math.ceil((Math.hypot(p.x - door.at.x, p.y - door.at.y)
        / PLAYER_TIMING.moveSpeed + 1) * 60);
    input.move.x = dir.x; input.move.y = dir.y;
    for (let i = 0; i < maxSteps && world.roomId === dungeon.start; i++) {
        world.update(1 / 60);
    }
    const entered = world.roomId !== dungeon.start;
    check("walking into a door transitions to the next room", entered,
        "roomId=" + world.roomId);

    if (entered) {
        // player lands just inside the opposite wall
        const inset = 1.2;
        const inside = p.x > p.radius && p.x < world.width - p.radius
            && p.y > p.radius && p.y < world.height - p.radius;
        check("player lands inside the new room", inside,
            "x=" + p.x.toFixed(2) + " y=" + p.y.toFixed(2));
        // the room they came FROM is remembered as visited
        const state = world.roomState.get(dungeon.start);
        check("previous room marked visited", state && state.visited === true);
    }

    // battle rooms lock their doors until cleared — pick one not yet visited
    const battleRoom = dungeon.rooms.find(function (r) {
        return r.type === "battle" && !world.roomState.get(r.id).visited;
    });
    world.enterRoom(battleRoom.id, "S");
    check("fresh battle room spawned enemies", world.enemies.length >= 1,
        "enemies=" + world.enemies.length);
    input.move.x = 0; input.move.y = 0;
    for (let i = 0; i < 5; i++) { world.update(1 / 60); }
    check("battle room with live enemies is locked", world.roomLocked === true);
    // kill everything with direct hits, then the lock must lift
    world.enemies.forEach(function (e) {
        while (!e.dead) { tryHit(e, 99); }
    });
    // one update to process deaths and room-clear
    world.update(1 / 60);
    check("cleared battle room unlocks", world.roomLocked === false);
    const st = world.roomState.get(battleRoom.id);
    check("cleared room recorded as cleared", st && st.cleared === true);

    // revisiting a cleared room spawns nothing
    world.enterRoom(battleRoom.id, "S");
    check("revisiting a cleared room spawns no enemies", world.enemies.length === 0,
        "enemies=" + world.enemies.length);
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall move checks passed");
process.exit(failures ? 1 : 0);
