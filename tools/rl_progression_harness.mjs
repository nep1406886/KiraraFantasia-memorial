#!/usr/bin/env node
// Progression harness (spec/04 §10): pickup, equipment replacement, exp/level,
// coin economy, shop purchase, rest heal.
//
// Pure-logic: drives createWorld directly with a mocked stats table, the way
// rl_combat_harness.mjs drives fixture worlds. The affix pool/table are
// injected test fixtures — the harness must not read its expectations from
// the pipeline under test.

import {
    createWorld, PICKUP_RADIUS, EXP_PER_KILL, COIN_PER_KILL, SHOP_PRICES,
    REST_HEAL_FRACTION, expToNext
} from "../site/game/rl/world.js";
import { generateDungeon } from "../site/game/rl/dungeon.js";
import { setAffixPool } from "../site/game/rl/loot.js";
import { setAffixTable } from "../site/game/rl/equipment.js";
import { GADGETS } from "../site/game/rl/gadgets.js";

let failed = 0;
function assert(cond, msg) {
    if (!cond) {
        console.error("✗", msg);
        failed += 1;
    } else {
        console.log("✓", msg);
    }
}

// --- fixtures ----------------------------------------------------------------

// Deterministic affix world: two affixes with known multipliers.
setAffixPool(["t_atk", "t_def"], []);
setAffixTable({
    t_atk: { mults: { atk: 1.5 } },
    t_def: { mults: { def: 2.0 } }
});

const mockStats = {
    statsFor: function (id, level) {
        return {
            hp: 100 * level, atk: 10 * level, mgc: 5 * level,
            def: 2 * level, mdef: 2 * level, spd: 100, luck: 60
        };
    },
    card: function () { return null; }
};

function makeWorld() {
    const world = createWorld({
        seed: 12345,
        tables: { stats: mockStats }
    });
    world.spawnPlayer({ card: { id: 7, element: 1 }, x: 5, y: 5 });
    return world;
}

function step(world, n) {
    for (let i = 0; i < n; i++) {
        world.update(1 / 60);
    }
}

function drain(world) {
    return world.drainEvents();
}

// --- 1. pickup ----------------------------------------------------------------

console.log("\nGate 1: proximity offers; confirmation equips");
{
    const world = makeWorld();
    const p = world.player;
    const beforeAtk = p.base.atk;
    world.drops.push({
        x: p.x, y: p.y,
        items: [{ slot: "weapon", rarity: "rare", affixes: ["t_atk"] }]
    });
    step(world, 1);
    const events = drain(world);
    assert(events.some(function (e) { return e.type === "lootOffer"; }),
        "walking onto a drop offers comparison");
    assert(p.equipment.length === 0 && p.base.atk === beforeAtk, "preview leaves equipment intact");
    world.takeDrop(world.drops[0], world.drops[0].items[0]);
    assert(drain(world).some(e => e.type === "pickup"), "confirmation emits pickup");
    assert(world.drops.length === 0, "the drop leaves the ledger");
    assert(p.equipment.length === 1, "the item is equipped");
    assert(p.base.atk === beforeAtk * 1.5,
        "atk base is rescaled by the affix multiplier (乘区)");
    assert(p.maxHp === 100 && p.hp === 100,
        "an atk affix leaves hp untouched");
}

console.log("\nGate 2: same-slot replacement, no stacking");
{
    const world = makeWorld();
    const p = world.player;
    world.drops.push({
        x: p.x, y: p.y,
        items: [{ slot: "armor", rarity: "common", affixes: ["t_def"] }]
    });
    step(world, 1);
    world.takeDrop(world.drops[0], world.drops[0].items[0]);
    drain(world);
    world.drops.push({
        x: p.x, y: p.y,
        items: [{ slot: "armor", rarity: "epic", affixes: ["t_def", "t_def"] }]
    });
    step(world, 1);
    world.takeDrop(world.drops[0], world.drops[0].items[0]);
    drain(world);
    assert(p.equipment.length === 1,
        "a second same-slot item replaces, not appends");
    assert(p.base.def === 2 * 2.0 * 2.0,
        "replacement recomputes from truth, not from the equipped base ("
        + p.base.def + ")");
}

console.log("\nGate 3: out of radius does not pick up");
{
    const world = makeWorld();
    const p = world.player;
    world.drops.push({
        x: p.x + PICKUP_RADIUS + 1, y: p.y,
        items: [{ slot: "charm", rarity: "common", affixes: ["t_atk"] }]
    });
    step(world, 3);
    const events = drain(world);
    assert(!events.some(function (e) { return e.type === "pickup"; }),
        "a drop beyond PICKUP_RADIUS stays on the floor");
    assert(world.drops.length === 1, "ledger keeps the distant drop");
}

// --- 2. exp / level ------------------------------------------------------------

console.log("\nGate 4: kills award coin always, exp with a card");
{
    const world = makeWorld();
    const p = world.player;
    // no-card fixture world still earns coin (shop math must be testable)
    const bare = createWorld({ seed: 999 });
    const bp = bare.spawnPlayer({ hp: 50, atk: 99, x: 5, y: 5 });
    const foe = bare.spawnEnemy({ x: 5.3, y: 5, hp: 1, atk: 0 });
    bare.inputState = { move: { x: 0, y: 0 }, attack: true, dodge: false, skill: [false, false, false], ultimate: false };
    let bareDead = false;
    for (let i = 0; i < 120 && !bareDead; i++) {
        bare.update(1 / 60);
        bareDead = foe.dead;
    }
    assert(bareDead, "fixture player kills the fixture enemy");
    assert(bare.coin === COIN_PER_KILL.enemy,
        "a kill awards COIN_PER_KILL.enemy coin without tables (" + bare.coin + ")");
    assert(bp.level === 1, "no card -> no level growth (fixture contract)");
}

console.log("\nGate 5: exp accumulates and levels up through statsFor");
{
    const world = makeWorld();
    const p = world.player;
    assert(p.expNext === expToNext(1), "expNext starts at expToNext(level)");
    // weaken the player's offence is not needed: mock atk 10 vs hp 1
    const kills = Math.ceil(expToNext(1) / EXP_PER_KILL.enemy);
    world.inputState = { move: { x: 0, y: 0 }, attack: true, dodge: false, skill: [false, false, false], ultimate: false };
    let levelups = 0;
    for (let k = 0; k < kills + 2; k++) {
        const foe = world.spawnEnemy({ x: p.x + 0.5, y: p.y, hp: 1, atk: 0 });
        for (let i = 0; i < 120 && !foe.dead; i++) {
            world.update(1 / 60);
        }
        assert(foe.dead, "enemy " + (k + 1) + " died");
        world.drainEvents().forEach(function (e) {
            if (e.type === "levelup") { levelups += 1; }
        });
    }
    assert(levelups >= 1, "enough kills raised the level");
    assert(p.level >= 2, "player level grew: " + p.level);
    assert(p.maxHp === 100 * p.level,
        "maxHp follows the new level's truth curve (" + p.maxHp + ")");
    assert(world.coin === (kills + 2) * COIN_PER_KILL.enemy,
        "coin accumulates per kill: " + world.coin);
    drain(world);
}

console.log("\nGate 6: level-up re-applies equipment on the new curve");
{
    const world = makeWorld();
    const p = world.player;
    world.drops.push({
        x: p.x, y: p.y,
        items: [{ slot: "weapon", rarity: "rare", affixes: ["t_atk"] }]
    });
    step(world, 1);
    world.takeDrop(world.drops[0], world.drops[0].items[0]);
    drain(world);
    // Kill rolls would drop more items and could replace the test weapon —
    // empty the roll pool so loot cannot fire; the affix table stays live.
    setAffixPool([], []);
    const kills = Math.ceil(expToNext(1) / EXP_PER_KILL.enemy);
    world.inputState = { move: { x: 0, y: 0 }, attack: true, dodge: false, skill: [false, false, false], ultimate: false };
    for (let k = 0; k < kills + 1; k++) {
        const foe = world.spawnEnemy({ x: p.x + 0.5, y: p.y, hp: 1, atk: 0 });
        for (let i = 0; i < 120 && !foe.dead; i++) {
            world.update(1 / 60);
        }
    }
    drain(world);
    assert(p.level >= 2, "levelled up");
    assert(p.base.atk === 10 * p.level * 1.5,
        "equipped multiplier rides the new level's curve: " + p.base.atk);
}

// --- 3. shop -------------------------------------------------------------------

console.log("\nGate 7: shop offer and purchase");
{
    // Gate 6 emptied the roll pool; the shop needs it live again.
    setAffixPool(["t_atk", "t_def"], []);
    const world = makeWorld();
    const dungeon = generateDungeon(20260903, { roomsMin: 6, roomsMax: 9 });
    world.setDungeon(dungeon);
    const shopRoom = dungeon.rooms.find(function (r) { return r.type === "shop"; });
    assert(!!shopRoom, "the generated dungeon has a shop room");
    world.enterRoom(shopRoom.id, "S");
    const offer = world.getShopOffer();
    assert(!!offer, "entering the shop room rolls an offer");
    assert(offer.length === 3, "three items on offer");
    offer.forEach(function (entry, i) {
        if (entry.item) {
            const gadget = GADGETS.find(row => row.id === entry.item.gadgetId);
            assert(entry.price === (gadget ? gadget.price : SHOP_PRICES[entry.item.rarity]),
                "item " + i + " priced by its lane (" + (gadget ? gadget.id + " gadget" : entry.item.rarity) + ")");
        }
    });
    // with the test affix pool every roll succeeds, so at least one real item
    const withItem = offer.filter(function (e) { return e.item; });
    assert(withItem.length >= 1, "offer has real items under a live pool");

    assert(world.buyShopItem(0) === null,
        "purchase refused when coin is short");
    world.coin = SHOP_PRICES[withItem[0].item.rarity];
    const firstIdx = offer.indexOf(withItem[0]);
    const bought = world.buyShopItem(firstIdx);
    assert(!!bought, "purchase succeeds with enough ink");
    assert(world.coin === 0, "coin is deducted");
    assert(world.player.equipment.some(function (it) { return it === bought; }),
        "bought item is equipped");
    assert(world.buyShopItem(firstIdx) === null,
        "a sold slot cannot be bought twice");
    const events = drain(world);
    assert(events.some(function (e) { return e.type === "purchase"; }),
        "purchase event is pushed");
}

console.log("\nGate 8: rest heals once per room");
{
    const world = makeWorld();
    const p = world.player;
    p.hp = 10;
    const dungeon = generateDungeon(20260903, { roomsMin: 6, roomsMax: 9 });
    world.setDungeon(dungeon);
    const restRoom = dungeon.rooms.find(function (r) { return r.type === "rest"; });
    assert(!!restRoom, "the generated dungeon has a rest room");
    world.enterRoom(restRoom.id, "S");
    const healed = world.restHeal();
    assert(healed === Math.round(p.maxHp * REST_HEAL_FRACTION),
        "rest heals REST_HEAL_FRACTION of maxHp (" + healed + ")");
    assert(world.restHeal() === 0, "resting twice in one room does nothing");
    const events = drain(world);
    assert(events.some(function (e) { return e.type === "rest"; }),
        "rest event is pushed");
}

// --- 4. room-local drops --------------------------------------------------------

console.log("\nGate 9: unclaimed loot stays room-local across re-entry");
{
    const world = makeWorld();
    const dungeon = generateDungeon(20260903, { roomsMin: 6, roomsMax: 9 });
    world.setDungeon(dungeon);
    const originId = world.roomId;
    world.drops.push({ x: 1, y: 1, items: [{ slot: "charm", rarity: "common", affixes: ["t_atk"] }] });
    const other = dungeon.rooms.find(function (r) { return r.id !== originId; });
    world.enterRoom(other.id, "S");
    assert(world.drops.length === 0,
        "the destination room starts with its own empty loot ledger");
    world.enterRoom(originId, "S");
    assert(world.drops.length === 1,
        "unclaimed loot stays in the origin room after a room change");
}

console.log("\n" + "=".repeat(60));
if (failed === 0) {
    console.log("✓ All progression gates passed");
    console.log("✓ pickup / equip-replace / exp-level / coin / shop / rest");
} else {
    console.error("✗", failed, "gate(s) failed");
    process.exit(1);
}
