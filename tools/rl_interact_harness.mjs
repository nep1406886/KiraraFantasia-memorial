// Harness for the T22g room interactables (world.js logic layer, spec/06):
// 宝箱 (open-on-E, one roll, persists), 木桶 (battle-room placement off the
// room seed, melee-window break, authored loot, persists), 祭坛 (event
// point: deterministic presence, one blessing, persists), and the campfire
// NPC record (talk heals once, first/repeat distinction, persists).
//
//   node tools/rl_interact_harness.mjs
//
// No tables: the world runs on the stage-2 literals, which is exactly the
// layer these verbs live at (the views are the browser gates' job).

import { createWorld, BARREL_LOOT, BARREL_MIN_COUNT, BARREL_MAX_COUNT, ALTAR_CHANCE } from "../site/game/rl/world.js";
import { generateDungeon, doorsOf, ROOM_SIZE } from "../site/game/rl/dungeon.js";
import { PLAYER_TIMING } from "../site/game/rl/actorstate.js";
import { setAffixPool } from "../site/game/rl/loot.js";

let failures = 0;
function assert(ok, label) {
    console.log((ok ? "ok   " : "FAIL ") + label);
    if (!ok) {
        failures += 1;
    }
}

const mockStats = {
    card: function () { return null; },
    statsFor: function () { return { hp: 40, atk: 10, mgc: 8, def: 2, mdef: 2, spd: 5, luck: 0 }; },
    all: function () { return []; }
};

function makeWorld(seed) {
    const world = createWorld({ seed: seed || 12345, tables: { stats: mockStats } });
    world.spawnPlayer({ card: { id: 7, element: 1 }, x: 5, y: 5 });
    world.inputState = {
        move: { x: 0, y: 0 }, attack: false, dodge: false,
        skill: [false, false, false], ultimate: false, menu: false
    };
    return world;
}

function step(world, n) {
    for (let i = 0; i < n; i++) {
        world.update(1 / 60);
    }
}

function eventsOf(world, type) {
    return world.drainEvents().filter(function (e) { return e.type === type; });
}

// The dungeon every gate below shares: seeded so chest/shop/rest/battle all
// exist (roomsMin 6 always yields at least one plain battle room). The affix
// pool is the progression harness's test pool, so every chest roll succeeds.
setAffixPool(["t_atk", "t_def"], []);
function builtWorld(dungeonSeed) {
    const world = makeWorld(12345);
    const dungeon = generateDungeon(dungeonSeed || 20260904, { roomsMin: 6, roomsMax: 9 });
    world.setDungeon(dungeon);
    return { world: world, dungeon: dungeon };
}

function roomOf(dungeon, type) {
    return dungeon.rooms.find(function (r) { return r.type === type; });
}

// --- 1. 宝箱 ---------------------------------------------------------------------

console.log("\nGate 1: the chest opens on E, once, and persists");
{
    const t = builtWorld();
    const world = t.world;
    const chestRoom = roomOf(t.dungeon, "chest");
    assert(!!chestRoom, "the generated dungeon has a chest room");
    world.enterRoom(chestRoom.id, "S");
    world.drainEvents();

    assert(!!world.chest, "entering binds the chest handle");
    assert(world.chest.x === world.width / 2
        && world.chest.y === world.height / 2 - 2.5,
        "chest sits north of centre (" + world.chest.x + "," + world.chest.y + ")");
    // T22g's rule change: entry no longer auto-spills the roll.
    assert(world.drops.length === 0, "entry alone rolls no loot");

    assert(world.openChest() === true, "openChest pays once");
    assert(world.drops.length === 1, "opening rolls exactly one guaranteed drop");
    assert(world.drops[0].items.length > 0, "the drop is never empty (guaranteed)");
    const opened = eventsOf(world, "chestOpen");
    assert(opened.length === 1 && opened[0].x === world.chest.x,
        "chestOpen event is pushed at the chest");

    assert(world.openChest() === null, "a second open is refused");

    // persistence: leave and come back
    const other = t.dungeon.rooms.find(function (r) {
        return r.id !== chestRoom.id && r.type !== "boss";
    });
    world.enterRoom(other.id, "S");
    world.enterRoom(chestRoom.id, "N");
    world.drainEvents();
    assert(world.chest.opened === true, "re-entry shows the chest still open");
    assert(world.openChest() === null, "and it cannot be re-opened");
    assert(world.drops.length === 1 && world.drops[0].items.length > 0, "unclaimed loot keeps its identity through the round trip");
}

// --- 2. 木桶: placement ----------------------------------------------------------

console.log("\nGate 2: barrels place deterministically and clear of doors");
{
    const t = builtWorld();
    const battle = roomOf(t.dungeon, "battle");
    assert(!!battle, "the generated dungeon has a battle room");
    t.world.enterRoom(battle.id, "S");
    t.world.drainEvents();
    const barrels = t.world.barrels;
    assert(barrels.length >= BARREL_MIN_COUNT && barrels.length <= BARREL_MAX_COUNT,
        "2-3 barrels per battle room (" + barrels.length + ")");
    barrels.forEach(function (b) {
        assert(b.x > 2 && b.x < ROOM_SIZE.w - 2 && b.y > 1.5 && b.y < ROOM_SIZE.h - 2,
            "barrel inside the room bounds (" + b.x.toFixed(1) + "," + b.y.toFixed(1) + ")");
        const doors = doorsOf(t.dungeon, battle.id);
        assert(doors.every(function (d) {
            return Math.hypot(d.at.x - b.x, d.at.y - b.y) >= 2.4;
        }), "barrel clear of every door corridor");
    });

    // determinism: leaving and re-entering the same room rebuilds identical
    // slots (the stream is keyed on the room's own seed)
    const t3 = builtWorld();
    const battle3 = roomOf(t3.dungeon, "battle");
    t3.world.enterRoom(battle3.id, "S");
    const firstPass = t3.world.barrels.slice();
    t3.world.enterRoom(roomOf(t3.dungeon, "rest").id, "S");
    t3.world.enterRoom(battle3.id, "N");
    assert(t3.world.barrels.every(function (b, i) {
        const first = firstPass[i];
        return first && b.x === first.x && b.y === first.y;
    }) && t3.world.barrels.length === firstPass.length,
        "re-entering the room rebuilds identical slots");

    // colliders: the view's setRoomColliders appends the intact barrels
    t.world.setRoomColliders([]);
    const withBarrels = t.world.roomColliders.filter(function (c) {
        return barrels.some(function (b) { return b.x === c.x && b.y === c.y; });
    });
    assert(withBarrels.length === barrels.length,
        "every intact barrel owns a collider");
}

// --- 3. 木桶: the break ---------------------------------------------------------

console.log("\nGate 3: a melee swing breaks a barrel and pays its loot");
{
    const t = builtWorld();
    const world = t.world;
    const battle = roomOf(t.dungeon, "battle");
    world.enterRoom(battle.id, "S");
    world.drainEvents();
    const barrel = world.barrels[0];
    const p = world.player;

    // stand in front of the barrel and swing
    p.x = barrel.x - 1.0;
    p.y = barrel.y;
    p.facing = 0;       // east, toward the barrel
    const coinBefore = world.coin;
    const hpBefore = p.hp;
    world.inputState.attack = true;
    world.update(1 / 60);
    world.inputState.attack = false;
    // 0.12s window: tick until the window has opened (7+ ticks, combat gate 1)
    step(world, 10);
    const breaks = eventsOf(world, "barrelBreak");
    assert(breaks.length === 1, "the swing broke the barrel");
    assert(breaks[0].x === barrel.x && breaks[0].y === barrel.y,
        "the break is reported at the barrel");
    const loot = breaks[0] && breaks[0].loot;
    assert(loot && ["coin", "heal", "none"].indexOf(loot.kind) >= 0,
        "loot kind is authored (" + (loot && loot.kind) + ")");
    if (loot && loot.kind === "coin") {
        assert(world.coin === coinBefore + loot.amount
            && loot.amount >= BARREL_LOOT.coinMin && loot.amount <= BARREL_LOOT.coinMax,
            "coin loot lands in the wallet inside the authored band");
    } else if (loot && loot.kind === "heal") {
        assert(p.hp === Math.min(p.maxHp, hpBefore + loot.amount),
            "heal loot landed on the player");
    } else {
        assert(world.coin === coinBefore && p.hp === hpBefore,
            "empty barrel pays nothing");
    }
    assert(world.barrels[0].broken === true, "the record is marked broken");

    // one swing breaks each barrel at most once (all in the arc at once)
    assert(world.roomColliders.every(function (c) {
        return c.x !== barrel.x || c.y !== barrel.y;
    }), "the broken barrel's collider is gone");

    // persistence across re-entry
    world.enterRoom(roomOf(t.dungeon, "rest").id, "S");
    world.enterRoom(battle.id, "N");
    assert(world.barrels[0].broken === true,
        "re-entry keeps the barrel broken");
}

// --- 4. 祭坛 ---------------------------------------------------------------------

console.log("\nGate 4: the altar rolls deterministically and pays once");
{
    // Determinism of presence: scan many rooms' seeds through the same
    // stream shape world.js uses.
    let present = 0;
    const probes = [];
    for (let i = 0; i < 200; i++) {
        const t = builtWorld(70000 + i * 13);
        const battle = roomOf(t.dungeon, "battle");
        t.world.enterRoom(battle.id, "S");
        probes.push({ world: t.world, battle: battle, has: !!t.world.altar });
        if (t.world.altar) { present += 1; }
    }
    assert(present > 60 && present < 140,
        "altar presence straddles " + ALTAR_CHANCE + " (" + present + "/200)");
    probes.forEach(function (probe) {
        if (!probe.has) { return; }
        const a = probe.world.altar;
        assert(a.used === false, "a fresh altar is unused");
        assert(a.x < 4 || a.x > ROOM_SIZE.w - 4 || a.y < 4 || a.y > ROOM_SIZE.h - 4,
            "the altar claims a corner (" + a.x + "," + a.y + ")");
    });

    // the full verb chain on one altar room
    const withAltar = probes.find(function (pr) { return pr.has; });
    assert(!!withAltar, "a probe room rolled an altar");
    const world = withAltar.world;
    world.drainEvents();
    const p = world.player;
    p.x = world.altar.x;
    p.y = world.altar.y;
    world.enemies.forEach(e => { e.hp = 0; e.sm.force('dead'); e.dead = true; });
    p.hp = Math.floor(p.maxHp / 2);
    const coinBefore = world.coin;
    const hpBefore = p.hp, offer = world.getAltarOffer();
    const outcome = world.useAltar('calm', world.roomId);
    assert(!!outcome, "an explicit prayer pays at the cleared altar");
    const used = eventsOf(world, "altarUse");
    assert(used.length === 1, "altarUse event is pushed");
    assert(world.coin === coinBefore && p.hp === hpBefore + offer.options.find(o => o.id === 'calm').heal,
        'the displayed prayer amount lands without a hidden random reward');
    assert(world.useAltar('calm', world.roomId) === null, "the altar pays once");
    world.enterRoom(roomOf(world.dungeon, "rest").id, "S");
    world.enterRoom(withAltar.battle.id, "N");
    assert(world.altar.used === true, "re-entry keeps the altar used");
}

// --- 5. NPC record ----------------------------------------------------------------

console.log("\nGate 5: the campfire guest talks and heals once per room");
{
    const t = builtWorld();
    const world = t.world;
    const restRoom = roomOf(t.dungeon, "rest");
    world.enterRoom(restRoom.id, "S");
    world.drainEvents();
    assert(!!world.npc, "entering a rest room binds the npc handle");

    const p = world.player;
    p.hp = Math.floor(p.maxHp / 2);
    const hpBefore = p.hp;
    const first = world.talkNpc();
    assert(first && first.first === true, "the first talk reports first");
    assert(first.healed === 0 && p.hp === hpBefore, "talking leaves the supply choice open");
    const supply = world.chooseSupply("heal", restRoom.id);
    assert(supply.amount === Math.min(p.maxHp - hpBefore, Math.round(p.maxHp * 0.4)),
        "choosing healing restores the existing rest fraction");
    const evs = world.drainEvents();
    const talks = evs.filter(function (e) { return e.type === "npcTalk"; });
    const rests = evs.filter(function (e) { return e.type === "supply"; });
    assert(talks.length === 1 && talks[0].first === true,
        "npcTalk event is pushed with first=true");
    assert(rests.length === 1,
        "the supply receipt fired once");

    const again = world.talkNpc();
    assert(again && again.first === false, "a repeat talk reports not-first");
    assert(again.healed === 0, "a repeat talk heals nothing");
    assert(p.hp === Math.min(p.maxHp, hpBefore + supply.amount),
        "hp moved exactly once");

    world.enterRoom(roomOf(t.dungeon, "battle").id, "S");
    world.enterRoom(restRoom.id, "N");
    assert(world.npc.talked === true, "re-entry keeps the guest talked-to");
    assert(world.talkNpc().first === false, "and a later talk is not a first");
}

console.log(failures === 0 ? "\nALL GREEN" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
