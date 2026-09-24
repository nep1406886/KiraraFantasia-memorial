// T30: authored CARD namespace, deterministic scheduling, and real world input.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSkills, decodeSkill } from "../site/game/rl/skills.js";
import { createWorld } from "../site/game/rl/world.js";
import { createDanmaku } from "../site/game/rl/danmaku.js";
import { passiveRuntime, setAffixTable, affixTableFromPassives } from "../site/game/rl/equipment.js";
import { skillWords } from "../site/game/rl/ui/infocard.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const table = read("skills-rl.json"), allCards = read("cards-rl.json").cards;
const weapons = read("weapons-rl.json");
setAffixTable(affixTableFromPassives(weapons.passives));
const card = id => allCards.find(c => c.id === id);
let checks = 0;
const test = (label, fn) => { fn(); checks++; console.log("PASS " + label); };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, a + " != " + b);
const skills = id => createSkills({card: card(id), table, maxHp: 1000});
const decode = (row, cards = table.skillCards) => decodeSkill(row, row.id, .35, cards);

test("Kaoruko's real ultimate installs its authored CARD payload", () => {
    assert.equal(skills(24002001).ultimate.cardPlacements?.length, 1,
        "kind 21 still has no executable card placement");
});

const { placeSkillCard, updateSkillCards, clearSkillCards } = await import("../site/game/rl/skillcards.js");
const { applyHealingLock, clearPlayerStatus } = await import("../site/game/rl/playerstatus.js");
const stats = { statsFor: () => ({ hp: 1000, atk: 100, mgc: 100,
    def: 100, mdef: 100, spd: 100, luck: 0 }) };
function world(id = 24002001, override = table) {
    const w = createWorld({ width: 32, height: 24, seed: 30910, tables: {
        stats, skills: { ...override, weaponChildren: weapons.childSkills } } });
    w.spawnPlayer({ card: card(id), x: 15, y: 12, level: 1 });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false,
        skill: [false, false, false], ultimate: false };
    w.rng = () => .5;
    return w;
}
function step(w, seconds) {
    for (let left = seconds; left > 1e-9; left -= 1 / 60) w.update(Math.min(left, 1 / 60));
}
function cast(w, index) {
    w.inputState.skill[index] = true; w.update(1 / 60);
    w.inputState.skill[index] = false; w.update(1 / 60);
}
function ultimate(w) { w.player.skills.addGauge(1e9); assert.ok(w.useUltimate()); }
function foe(w, x = 19, hp = 100000) {
    const e = w.spawnEnemy({ x, y: 12, hp, atk: 1, def: 100, mdef: 100, element: w.player.element });
    e.actionTimer = 1e9; return e;
}
const placement = (id = 24002001, index = 0) => skills(id).slots[index].cardPlacements[0];
const unit = () => ({ id: 1, kind: "player", dead: false, passives: {}, skillCards: [] });
function install(w, index = 0, id = 24002001) {
    return placeSkillCard(w.player, index, skills(id).slots[index].id, placement(id, index), w.player.skills.turnSeconds);
}
function equip(w, item) {
    const drop = { x: w.player.x, y: w.player.y, items: [item] }; w.drops.push(drop);
    assert.equal(w.takeDrop(drop, item), true);
}
const cardEvents = w => w.events.filter(e => e.type === "skillCard");

for (const [id, ref, heal] of [[12002001, 10001, .2], [21002001, 10004, .2],
    [24002001, 10005, .2], [25002001, 10007, .13], [32002001, 10014, .13]]) {
    test("current card " + id + " resolves the exact CARD healing row " + ref, () => {
        const p = placement(id); assert.equal(p.card.id, ref); assert.equal(p.count, 3);
        near(p.card.effects[0].heal, heal); near(p.card.loadFactor, 1);
        assert.ok(!skills(id).ultimate.unhandled.includes(21));
    });
}
test("Yomi's CARD 10050 is magic 0.5 against all enemies, not its parent 1.16", () => {
    const slot = skills(39002001).slots[1], p = slot.cardPlacements[0];
    near(slot.coef, 1.16); assert.equal(p.card.id, 10050); assert.equal(p.count, 3);
    assert.equal(p.card.effects[0].target, 2); near(p.card.effects[0].coef, .5);
    assert.equal(p.card.effects[0].magic, true);
});
test("the generated CARD namespace is exactly the shipped reference closure", () => {
    const refs = new Set([...Object.values(table.normalAttacks), ...Object.values(table.player),
        ...Object.values(table.enemy), ...Object.values(weapons.childSkills)].flatMap(row =>
        row.effects.filter(e => e.kind === 21).map(e => e.args[1])));
    assert.deepEqual(new Set(Object.keys(table.skillCards).map(Number)), refs);
    for (const id of refs) assert.equal(table.skillCards[id].source, "CARD");
    assert.equal(table.skillCards[10005].effects[0].args[0], 20);
});
for (const [name, change] of [
    ["zero count", row => { row.effects[0].args[0] = 0; }],
    ["fractional count", row => { row.effects[0].args[0] = 1.5; }],
    ["string count", row => { row.effects[0].args[0] = "3"; }],
    ["infinite count", row => { row.effects[0].args[0] = Infinity; }],
    ["missing CARD row", row => { row.effects[0].args[1] = 99999999; }],
    ["string reference", row => { row.effects[0].args[1] = "10005"; }],
    ["unsupported target", row => { row.effects[0].target = 8; }]
]) test("invalid placement stays unusable: " + name, () => {
    const row = { id: 1, target: 4, effects: [{ kind: 21, target: 4, args: [3, 10005] }] };
    change(row); const slot = decode(row);
    assert.equal(slot.usable, false); assert.deepEqual(slot.cardPlacements, []); assert.ok(slot.unhandled.includes(21));
});
for (const [name, change] of [
    ["wrong namespace", row => { row.source = "EN"; }],
    ["wrong ID", row => { row.id = 10001; }],
    ["instant infinite loop", row => { row.loadFactors = [0]; }],
    ["invalid interval", row => { row.loadFactors = [NaN]; }],
    ["missing effects", row => { row.effects = []; }],
    ["null effect", row => { row.effects = [null]; }],
    ["nonfinite heal", row => { row.effects[0].args = [Infinity]; }],
    ["enemy heal", row => { row.effects[0].target = 2; }],
    ["recursive card", row => { row.effects[0] = { kind: 21, target: 4, args: [3, 10005] }; }],
    ["conditional damage", row => { row.effects = [{ kind: 0, target: 2, args: [500, 1, 0, 0, 0, 0, 0, 0, 0, 1, 100] }]; }]
]) test("invalid child remains an explicit gap: " + name, () => {
    const row = structuredClone(table.skillCards[10005]); change(row);
    const slot = decode({ id: 1, target: 4, effects: [{ kind: 21, target: 4, args: [3, 10005] }] }, {10005: row});
    assert.equal(slot.usable, false); assert.ok(slot.unhandled.includes(21));
});
test("a missing child does not remove a valid parent heal or claim a card", () => {
    const slot = decode(table.player[240020010], {});
    assert.equal(slot.usable, true); near(slot.heal, .33); assert.equal(slot.cardPlacements.length, 0);
});
test("first trigger waits a full interval and spends exactly three occurrences", () => {
    const p = unit(), fired = []; const e = placeSkillCard(p, 0, 240020010, placement(), 2.8).entry;
    updateSkillCards(p, 2.79, c => fired.push(c.triggers)); assert.equal(fired.length, 0);
    updateSkillCards(p, .01, c => fired.push(c.triggers)); assert.deepEqual(fired, [1]);
    assert.equal(e.remaining, 2); near(e.next, 2.8);
    updateSkillCards(p, 5.6, c => fired.push(c.triggers)); assert.deepEqual(fired, [1, 2, 3]);
    assert.equal(p.skillCards.length, 0); updateSkillCards(p, 100, () => assert.fail("expired card replayed"));
});
test("same-slot refresh keeps its deadline, original payload, and one timer", () => {
    const p = unit(); const e = placeSkillCard(p, 0, 240020010, placement(), 2.8).entry;
    updateSkillCards(p, 1, () => assert.fail("early")); p.passives.extraCardTriggers = 2;
    const result = placeSkillCard(p, 0, 320020010, placement(32002001), 5);
    assert.equal(result.action, "refreshed"); assert.equal(result.entry, e);
    assert.equal(e.card.id, 10005); near(e.next, 1.8); near(e.interval, 2.8);
    assert.equal(e.remaining, 5); assert.equal(p.skillCards.length, 1);
});
test("multiple sources resolve chronologically and tie by creation, not slot", () => {
    const p = unit(), fired = [];
    placeSkillCard(p, 2, 1, placement(), 2.8);
    placeSkillCard(p, 0, 2, placement(), 1.4);
    updateSkillCards(p, 8.4, e => fired.push(e.sourceSlot));
    assert.deepEqual(fired, [0, 2, 0, 0, 2, 2]); assert.equal(p.skillCards.length, 0);
});
test("pause-sized invalid deltas and invalid source slots cannot create work", () => {
    const p = unit(); placeSkillCard(p, 0, 1, placement(), 2.8);
    const before = JSON.stringify(p);
    for (const dt of [0, -1, Infinity, NaN, "1"]) updateSkillCards(p, dt, () => assert.fail("invalid tick"));
    for (const slot of [-1, 4, 1.5, NaN]) assert.equal(placeSkillCard(p, slot, 1, placement(), 2.8), null);
    assert.equal(JSON.stringify(p), before);
});
test("clearing inside a trigger cannot execute a second due callback", () => {
    const p = unit(); placeSkillCard(p, 0, 1, placement(), 2.8); placeSkillCard(p, 1, 2, placement(), 2.8);
    let count = 0; updateSkillCards(p, 20, () => { count++; clearSkillCards(p); });
    assert.equal(count, 1); assert.equal(p.skillCards.length, 0);
});
test("three skill sources and normal source coexist with a strict four-source bound", () => {
    const p = unit();
    for (let source=0;source<4;source++) placeSkillCard(p,source,100+source,placement(),2.8);
    assert.equal(p.skillCards.length,4);
    assert.equal(placeSkillCard(p,4,200,placement(),2.8),null);
    const fired=[]; updateSkillCards(p,2.8,e=>fired.push(e.sourceSlot));
    assert.deepEqual(fired,[0,1,2,3]); clearSkillCards(p); assert.equal(p.skillCards.length,0);
});
test("Kaoruko ultimate heals to730 then cards to930/1000, with one gauge debit", () => {
    const w = world(), p = w.player; p.hp = 400; ultimate(w);
    assert.equal(p.hp, 730); assert.equal(p.skills.gauge, 0); assert.equal(p.skillCards[0].remaining, 3);
    step(w, 2.8); assert.equal(p.hp, 930); step(w, 2.8); assert.equal(p.hp, 1000);
    step(w, 2.8); assert.equal(p.hp, 1000); assert.equal(p.skillCards.length, 0);
    assert.equal(cardEvents(w).filter(e => e.action === "triggered").length, 3);
    assert.equal(w.events.filter(e => e.type === "ultimateSpent").length, 1);
});
for (const id of [12002001, 21002001, 25002001, 32002001]) {
    test("real ultimate " + id + " installs the right periodic heal", () => {
        const w = world(id), p = w.player; ultimate(w); p.hp = 400;
        step(w, 2.8); assert.equal(p.hp, id === 12002001 || id === 21002001 ? 600 : 530);
        assert.equal(p.skillCards[0].remaining, 2);
    });
}
test("Yomi keyboard-state cast installs once, starts16.8s cooldown, and does not spend nextAtk", () => {
    const w = world(39002001), p = w.player; p.nextAtkBonus = .6; cast(w, 1);
    assert.equal(p.skillCards.length, 1); assert.equal(p.skillCards[0].card.id, 10050);
    near(p.skillCards[0].next, 2.8 - 1 / 60); near(p.skills.slots[1].remaining, 16.8 - 1 / 60);
    step(w, .5); cast(w, 1); assert.equal(cardEvents(w).filter(e => e.action === "placed").length, 1);
    near(p.nextAtkBonus, .6);
});
for (const id of [39002001, 14002001]) test("real normal-override card installs on accepted " + id + " whiffs", () => {
    const w = world(id), p = w.player;
    equip(w, {slot:"armor", rarity:0, affixes:["14032021"]});
    assert.equal(p.skills.normal.id, 140320211);
    w.inputState.attack = true; w.update(1/60); w.inputState.attack = false;
    assert.equal(p.skillCards.length, 1); assert.equal(p.skillCards[0].sourceSlot, 3);
    assert.equal(p.skillCards[0].card.id, 10041); assert.equal(p.skillCards[0].remaining, 1);
    near(p.skillCards[0].next, 2.1); assert.equal(p.skills.gauge, 0);
    step(w, 2.1); assert.deepEqual(p.skills.barrier, {cut:.2,hits:1});
    assert.equal(p.skillCards.length, 0); assert.equal(w.events.filter(e=>e.type==="hit").length, 0);
});
test("repeated normal attacks refresh their own source without delaying its deadline", () => {
    const w = world(), p = w.player;
    equip(w, {slot:"armor", rarity:0, affixes:["14032021"]});
    install(w); w.inputState.attack=true; step(w,.6); w.inputState.attack=false;
    const normal = p.skillCards.find(e=>e.sourceSlot===3);
    assert.ok(normal); assert.equal(p.skillCards.length,2); assert.equal(normal.remaining,1);
    near(normal.next, 2.1 - .6 + 1/60);
    assert.equal(cardEvents(w).filter(e=>e.action==="placed").length,1);
    assert.ok(cardEvents(w).some(e=>e.action==="refreshed"));
    step(w,normal.next); assert.deepEqual(p.skills.barrier,{cut:.2,hits:1});
    assert.equal(p.skillCards.length,1); assert.equal(p.skillCards[0].sourceSlot,0);
});
test("normal inputs refused during freeze or hit recovery cannot place cards", () => {
    const w=world(),p=w.player; equip(w,{slot:"armor",rarity:0,affixes:["14032021"]});
    w.frozen=true; w.inputState.attack=true; w.update(1/60); assert.equal(p.skillCards.length,0);
    w.frozen=false; p.sm.force("hit"); w.update(1/60); assert.equal(p.skillCards.length,0);
});
test("accepted ranged normal still places its card if the projectile pool rejects the shot", () => {
    const w=world(39002001),p=w.player; equip(w,{slot:"armor",rarity:0,affixes:["14032021"]});
    w.danmaku=createDanmaku({capacity:1}); w.danmaku.emit("aimed",{x:1,y:1},{life:10,speed:0});
    w.inputState.attack=true; w.update(1/60); w.inputState.attack=false; step(w,.3);
    assert.ok(w.events.some(e=>e.type==="playerShot" && e.bullets===0));
    assert.equal(p.skillCards.length,1); assert.equal(p.skillCards[0].card.id,10041);
});
test("card damage reads live offence/weakness and awards ordinary gauge without nextAtk", () => {
    const w = world(39002001), p = w.player, e = foe(w); p.nextAtkBonus = .6;
    install(w, 1, 39002001); step(w, 2.8);
    assert.equal(e.hp, 99852); assert.equal(p.skills.gauge, 148); near(p.nextAtkBonus, .6);
    p.base.mgc = 200; step(w, 2.8);
    assert.equal(e.hp, 99497); assert.equal(p.skills.gauge, 503); near(p.nextAtkBonus, .6);
    // Current magic100/200 at coef .5, TEMPO2.6, defence100: 70/200.
    // Only the third activation sees the new favourable element and +.35.
    p.element = 0; e.element = 3;
    p.skills.applySelf({ weakBonuses: [{ target: 0, turns: 3, pct: .35 }] });
    step(w, 2.8); assert.equal(e.hp, 98582); assert.equal(p.skills.gauge, 1400);
    near(p.nextAtkBonus, .6); assert.equal(p.skillCards.length, 0);
    assert.deepEqual(w.events.filter(ev => ev.type === "hit").map(ev => ev.skillCard), [10050, 10050, 10050]);
});
test("empty-room ticks are spent; a late target is only hit by remaining occurrences", () => {
    const w = world(39002001); install(w, 1, 39002001); step(w, 2.8);
    assert.equal(w.player.skillCards[0].remaining, 2); const e = foe(w);
    step(w, 5.6); assert.equal(e.hp, 99704); assert.equal(w.player.skillCards.length, 0);
});
test("all-target cards hit new living enemies, never a dead target or an iframe target", () => {
    const w = world(39002001), first = foe(w); install(w, 1, 39002001); step(w, 2.8);
    first.dead = true; const second = foe(w, 20), immune = foe(w, 21); immune.iframes = 100;
    step(w, 2.8); assert.equal(first.hp, 99852); assert.equal(second.hp, 99852); assert.equal(immune.hp, 100000);
    assert.equal(w.player.skillCards[0].remaining, 1);
});
test("a card kill rewards once and its remaining empty ticks cannot replay the death", () => {
    const w = world(39002001), e = foe(w, 19, 70); install(w, 1, 39002001); step(w, 2.8);
    assert.equal(e.dead, true); const rewards = [w.coin, w.player.exp, w.player.level, w.drops.length];
    assert.ok(w.coin > 0); step(w, 5.6);
    assert.deepEqual([w.coin, w.player.exp, w.player.level, w.drops.length], rewards);
    assert.equal(w.events.filter(ev => ev.type === "hit" && ev.died).length, 1);
});
test("blocked card heals spend ticks, do not clip overheal, and never accumulate backlog", () => {
    const w = world(), p = w.player; p.hp = 400; install(w); applyHealingLock(p, 1, 5.6, () => 0);
    step(w, 2.8); assert.equal(p.hp, 400); assert.equal(p.skillCards[0].remaining, 2);
    step(w, 2.8); assert.equal(p.hp, 600); step(w, 2.8); assert.equal(p.hp, 800);
    assert.equal(p.skillCards.length, 0); assert.ok(w.events.some(e => e.action === "healBlocked"));
    p.hp = 1200; install(w); applyHealingLock(p, 1, 10, () => 0); step(w, 2.8); assert.equal(p.hp, 1200);
    clearPlayerStatus(p); step(w, 2.8); assert.equal(p.hp, 1200);
});
test("card heals honor current maxHP and an existing weapon overheal ceiling", () => {
    const w = world(), p = w.player; p.hp = 900; p.passives.overheal = .2; install(w);
    step(w, 2.8); assert.equal(p.hp, 1100); step(w, 2.8); assert.equal(p.hp, 1200);
    p.maxHp = 2000; p.hp = 400; step(w, 2.8); assert.equal(p.hp, 800);
});
test("damage-card lifesteal follows the same healing lock without reducing damage", () => {
    const w = world(39002001), p = w.player, e = foe(w); p.hp = 400; p.passives.lifesteal = .1;
    install(w, 1, 39002001); applyHealingLock(p, 1, 5.6, () => 0);
    step(w, 2.8); assert.equal(p.hp, 400); assert.equal(e.hp, 99852);
    step(w, 2.8); assert.equal(p.hp, 415); assert.equal(e.hp, 99704);
});
test("CARD source mutation does not change an already compiled placement", () => {
    const altered = structuredClone(table), w = world(24002001, altered), p = w.player;
    p.hp = 400; ultimate(w); altered.skillCards[10005].effects[0].args[0] = 99;
    p.hp = 400; step(w, 2.8); assert.equal(p.hp, 600);
});
test("compiled CARD leaf payloads are immutable without freezing source tables", () => {
    const raw = structuredClone(table.skillCards[10041]);
    const parsed = decode({ id: 1, target: 4, effects: [{ kind: 21, target: 4, args: [2, 10041] }] }, {10041: raw});
    const atom = parsed.cardPlacements[0].card.effects[0];
    assert.throws(() => { atom.barrier.cut = 1; }, TypeError);
    assert.throws(() => { atom.effects[0].args[0] = 100; }, TypeError);
    raw.effects[0].args[0] = 100; near(atom.barrier.cut, .2);
    assert.equal(atom.effects[0].args[0], 20);
});
test("single-target card selects the nearest living target at each activation, not aim", () => {
    const modified = structuredClone(table); modified.skillCards[10050].effects[0].target = 1;
    const w = world(39002001, modified), p = w.player, far = foe(w, 21), close = foe(w, 17);
    w.aim = {x:far.x,y:far.y};
    placeSkillCard(p, 1, 390020001, p.skills.slots[1].cardPlacements[0], 2.8);
    step(w, 2.8); assert.equal(close.hp, 99852); assert.equal(far.hp, 100000);
    close.dead = true; step(w, 2.8); assert.equal(far.hp, 99852);
});
test("real CARD10041 renews its authored20% one-hit shield every2.1s", () => {
    const row = { id: 123, target: 4, effects: [{ kind: 21, target: 4, args: [2, 10041] }] };
    const w = world(), p = w.player, parsed = decode(row).cardPlacements[0];
    placeSkillCard(p, 2, row.id, parsed, 2.8); near(p.skillCards[0].interval, 2.1); step(w, 2.1);
    assert.deepEqual(p.skills.barrier, { cut: .2, hits: 1 });
    assert.equal(p.skills.absorb(100), 80); assert.equal(p.skills.barrier, null);
    step(w, 2.1); assert.deepEqual(p.skills.barrier, { cut: .2, hits: 1 });
});
test("type12 extra counts apply only at placement/refresh and preview is read-only", () => {
    const w = world(21002001), p = w.player; ultimate(w); step(w, .5);
    const item = { slot: "armor", rarity: 0, affixes: ["21002001"] };
    const before = JSON.stringify([p.skillCards, p.equipment, p.hp]); assert.ok(w.previewEquipment(item));
    assert.equal(JSON.stringify([p.skillCards, p.equipment, p.hp]), before);
    assert.equal(passiveRuntime([item]).extraCardTriggers, 2); equip(w, item);
    assert.equal(p.skillCards[0].remaining, 3); const next = p.skillCards[0].next;
    ultimate(w); assert.equal(p.skillCards.length, 1); assert.equal(p.skillCards[0].remaining, 5); near(p.skillCards[0].next, next);
    equip(w, { slot: "armor", rarity: 0, affixes: [] }); assert.equal(p.skillCards[0].remaining, 5);
    assert.equal(p.passives.extraCardTriggers, 0);
});
test("skill recovery buffs cannot secretly accelerate the separate card schedule", () => {
    const w = world(), p = w.player; install(w);
    p.skills.applySelf({ buffs: [{ target: 0, turns: 10, spd: 1 }] });
    step(w, 1.4); assert.equal(p.skillCards[0].remaining, 3); near(p.skillCards[0].next, 1.4);
    assert.equal(p.skills.cooldownRate, 2); step(w, 1.4); assert.equal(p.skillCards[0].remaining, 2);
});
test("table turn seconds and CARD load factor are applied exactly once", () => {
    const modified = structuredClone(table); modified.turnSeconds = 1.5;
    modified.skillCards[10005].loadFactors = [.75, .75, .75];
    const w = world(24002001, modified); ultimate(w);
    near(w.player.skillCards[0].interval, 1.125); step(w, 1.125); assert.equal(w.player.skillCards[0].remaining, 2);
});
test("pause/hit-stop suspend cards; room change/death clear them but not normal resources", () => {
    const w = world(39002001), p = w.player; cast(w, 1); p.skills.addGauge(123);
    const before = JSON.stringify(p.skillCards); w.frozen = true; step(w, 20);
    assert.equal(JSON.stringify(p.skillCards), before); w.frozen = false; w.applyHitStop(.5); step(w, .25);
    assert.equal(JSON.stringify(p.skillCards), before); w.hitStop = 0;
    const cooldown = p.skills.slots[1].remaining;
    w.setDungeon({ start: 0, rooms: [{ id: 0, type: "start", seed: 1, enemies: [], doors: {} },
        { id: 1, type: "start", seed: 2, enemies: [], doors: {} }] });
    w.enterRoom(1); assert.equal(p.skillCards.length, 0); near(p.skills.slots[1].remaining, cooldown); assert.equal(p.skills.gauge, 123);
    install(w, 1, 39002001); p.dead = true; p.sm.force("dead"); w.update(1 / 60); assert.equal(p.skillCards.length, 0);
});
test("door fade never pays due card damage in the old or new room", () => {
    const w = world(); w.setDungeon({ start: 0, rooms: [
        { id: 0, type: "start", seed: 1, enemies: [], doors: {} },
        { id: 1, type: "start", seed: 2, enemies: [], doors: {} }] });
    install(w); w.player.skillCards[0].next = .01; w.transition = { t: 0, to: 1, fromSide: "W" };
    step(w, .3); assert.equal(w.player.skillCards.length, 0); assert.equal(cardEvents(w).filter(e => e.action === "triggered").length, 0);
});
test("player words disclose exact payloads, refresh, time and room boundary", () => {
    const words = skillWords(skills(24002001).ultimate).join(";");
    for (const term of ["放置治疗卡×3次", "2.8秒", "最大生命20%", "受治疗封锁", "不重置倒计时", "换房清除"]) assert.ok(words.includes(term), term);
    assert.ok(!words.includes("未适配：技能卡放置"));
    assert.match(skillWords(skills(39002001).slots[1]).join(";"), /魔法系数0.5/);
});
console.log("Skill cards: " + checks + " checks passed.");
