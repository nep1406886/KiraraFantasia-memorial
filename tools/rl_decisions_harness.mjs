// T26: real command boundaries, independent prices and resource expectations.
import assert from "node:assert/strict";
import { createWorld } from "../site/game/rl/world.js";
import * as equipment from "../site/game/rl/equipment.js";
import { setAffixPool } from "../site/game/rl/loot.js";
import { createMeta } from "../site/game/rl/meta.js";
import * as save from "../site/game/rl/save.js";
import { parseRunSnapshot, buildRunPayload } from "../site/game/rl/runschema.js";

equipment.setAffixTable({
    attack: { mults: { atk: 1.5 } },
    defence: { mults: { def: 2 } },
    stacked: { mults: {}, special: [{ type: 0, trigger: 2, args: [10, 0, 0, 0] }] }
});
setAffixPool(["attack", "defence"], []);
const truth = { hp: 1000, atk: 100, mgc: 80, def: 50, mdef: 40, spd: 100, luck: 0 };
const item = (affix = "attack") => ({ slot: "weapon", rarity: "common", affixes: [affix] });
const dungeon = { start: 0, rooms: ["start", "shop", "chest", "rest", "battle"].map((type, id) =>
    ({ id, type, seed: 122 + id, doors: {}, enemies: [] })) };
function world() {
    const w = createWorld({ seed: 7, tables: { stats: { statsFor: () => ({ ...truth }) }, skills: {} } });
    w.spawnPlayer({ card: { id: 15000000, class: 0, element: 0 }, x: 12, y: 9 });
    w.setDungeon(dungeon);
    w.drainEvents();
    return w;
}
function snapshot(w) {
    return buildRunPayload({ schemaVersion: 3, seed: 7, volume: 1, floor: 1,
        cardId: 15000000, level: 1, hp: w.player.hp, coin: w.coin,
        gauge: w.player.skills.gauge, equipment: w.player.equipment,
        roomClaims: w.getRoomClaims() });
}
let checks = 0, failures = 0;
function test(label, run) {
    checks++;
    try { run(); console.log("PASS " + label); }
    catch (error) { failures++; console.error("FAIL " + label + ": " + error.message); }
}
test("approaching loot offers a choice without changing equipment", () => {
    const w = world(), p = w.player, drop = { x: p.x, y: p.y, items: [item()] };
    w.drops.push(drop); w.update(1 / 60);
    assert.equal(p.base.atk, 100); assert.equal(p.equipment.length, 0);
    assert.equal(w.drops[0], drop);
    assert.ok(w.drainEvents().some(e => e.type === "lootOffer" && e.drop === drop));
    w.update(1 / 60); assert.ok(!w.drainEvents().some(e => e.type === "lootOffer"));
    p.x += 5; w.update(1 / 60); p.x -= 5; w.update(1 / 60);
    assert.ok(w.drainEvents().some(e => e.type === "lootOffer"));
});
test("preview uses existing stack counts without mutating any run state", () => {
    const w = world(), p = w.player;
    p.stackKills = 3;
    const before = JSON.stringify([p.base, p.equipment, p.hp, p.skills.gauge, w.events]);
    const view = w.previewEquipment(item("stacked"));
    assert.equal(view.current.atk, 100); assert.equal(view.candidate.atk, 130);
    assert.equal(JSON.stringify([p.base, p.equipment, p.hp, p.skills.gauge, w.events]), before);
});
test("confirmation equips once, rejects stale or distant drops", () => {
    const w = world(), p = w.player, candidate = item();
    const drop = { x: p.x, y: p.y, items: [candidate] };
    w.drops.push(drop);
    assert.equal(w.takeDrop(drop, candidate), true);
    assert.equal(p.base.atk, 150); assert.equal(w.drops.length, 0);
    assert.equal(w.takeDrop(drop, candidate), false);
    const far = { x: p.x + 10, y: p.y, items: [item("defence")] };
    w.drops.push(far); assert.equal(w.takeDrop(far, far.items[0]), false);
    w.enterRoom(2); assert.equal(w.takeDrop(far, far.items[0]), false);
});
test("invalid affix cannot partially charge or equip a shop item", () => {
    const w = world(); w.enterRoom(1); w.coin = 100;
    const entry = w.getShopOffer()[0]; entry.item = item("missing"); entry.price = 30;
    assert.equal(w.previewEquipment(entry.item), null);
    assert.equal(w.buyShopItem(0, entry.item), null);
    assert.equal(w.coin, 100); assert.equal(entry.bought, false);
    assert.equal(w.player.equipment.length, 0);
});
test("shop confirms the same item and debits exactly one price", () => {
    const w = world(); w.enterRoom(1); w.coin = 100;
    const entry = w.getShopOffer()[0]; entry.item = item(); entry.price = 30;
    assert.equal(w.buyShopItem(0, item()), null);
    assert.equal(w.coin, 100);
    assert.ok(w.buyShopItem(0, entry.item)); assert.equal(w.coin, 70);
    assert.equal(w.buyShopItem(0, entry.item), null); assert.equal(w.coin, 70);
});
test("room claims round trip with purchased stock and opened chest", () => {
    const w = world(); w.enterRoom(1); w.coin = 100;
    const entry = w.getShopOffer()[0]; entry.item = item(); entry.price = 30;
    w.buyShopItem(0, entry.item); w.enterRoom(2); w.openChest();
    const saved = parseRunSnapshot(JSON.parse(JSON.stringify(snapshot(w))), 20);
    assert.ok(saved);
    const restored = world(); restored.coin = saved.coin;
    restored.setDungeon(dungeon, saved.roomClaims);
    restored.enterRoom(1);
    assert.equal(restored.getShopOffer()[0].bought, true);
    assert.equal(restored.buyShopItem(0), null); assert.equal(restored.coin, 70);
    restored.enterRoom(2); assert.equal(restored.openChest(), null);
    restored.setDungeon(dungeon); restored.enterRoom(1);
    assert.equal(restored.getShopOffer()[0].bought, false);
});
test("supply reports real gains and its alternatives are mutually exclusive", () => {
    const w = world(); w.enterRoom(3); w.player.hp = 800;
    const offer = w.getSupplyOffer();
    assert.equal(offer.heal, 200); assert.equal(offer.gauge, 490);
    assert.equal(w.player.hp, 800); assert.equal(w.player.skills.gauge, 0);
    assert.ok(w.chooseSupply("gauge", 3));
    assert.equal(w.player.hp, 800); assert.equal(w.player.skills.gauge, 490);
    assert.equal(w.chooseSupply("heal", 3), null);
    assert.equal(w.restHeal(), 0);
    const restored = world(); restored.setDungeon(dungeon, snapshot(w).roomClaims);
    restored.enterRoom(3); assert.equal(restored.getSupplyOffer().used, true);
    assert.equal(restored.chooseSupply("heal", 3), null);
});
test("supply rejects no benefit and stale-room confirmations", () => {
    const w = world(); w.enterRoom(3);
    w.player.hp = 1100;
    assert.equal(w.getSupplyOffer().heal, 0);
    assert.equal(w.chooseSupply("heal", 3), null); assert.equal(w.player.hp, 1100);
    w.player.skills.addGauge(1400);
    assert.equal(w.chooseSupply("gauge", 3), null);
    w.enterRoom(0); assert.equal(w.chooseSupply("heal", 3), null);
});
test("v2 migrates to v3 with empty claims; malformed v3 claims are rejected", () => {
    const v2 = { schemaVersion: 2, generatorVersion: "t24-1", seed: 7,
        volume: 1, floor: 1, cardId: 15000000, level: 20, hp: 100, equipment: [] };
    const migrated = parseRunSnapshot(v2, 20);
    assert.equal(migrated.schemaVersion, 3); assert.deepEqual(migrated.roomClaims, []);
    for (const claims of [null, {}, [{ id: -1 }], [{ id: 1 }, { id: 1 }],
        [{ id: 1, rested: "yes" }], [{ id: 1, barrels: [-1] }],
        [{ id: 1, offer: [{ item: item(), price: -1, bought: false }] }]]) {
        assert.equal(parseRunSnapshot({ ...v2, schemaVersion: 3, roomClaims: claims }, 20), null);
    }
    assert.equal(parseRunSnapshot({ ...v2, schemaVersion: 4 }, 20), null);
});
test("camp quotes and confirms existing costs; invalid targets leave state intact", () => {
    const memory = new Map();
    save.setStorage({ getItem: k => memory.get(k) || null,
        setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) });
    const m = createMeta(); m.read(); m.state.gems = 1000;
    assert.equal(m.trainingQuote(15000000, 5).cost, 60);
    assert.equal(m.limitBreakQuote(15000000).cost, 500);
    const before = JSON.stringify(m.state);
    for (const target of [NaN, Infinity, 2.5]) assert.ok(m.train(15000000, target).reason);
    assert.ok(m.train(999, 2).reason); assert.ok(m.limitBreak(999).reason);
    assert.equal(JSON.stringify(m.state), before);
    assert.equal(m.train(15000000, 5).spent, 60); assert.equal(m.gems(), 940);
    assert.equal(m.limitBreak(15000000).spent, 500); assert.equal(m.levelCap(15000000), 85);
    const reloaded = createMeta(); reloaded.read();
    assert.equal(reloaded.levelOf(15000000), 5); assert.equal(reloaded.gems(), 440);
    assert.equal(reloaded.limitBreak(15000000).reason, "poor");
});
console.log(`T26: ${checks - failures}/${checks} passed`);
if (failures) process.exitCode = 1;
