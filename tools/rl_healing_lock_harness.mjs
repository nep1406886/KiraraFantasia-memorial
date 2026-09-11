// One T30 status: authored Unhappy semantics plus real input/hit boundaries.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSkills, decodeSkill, enemyMoveset } from "../site/game/rl/skills.js";
import { createWorld } from "../site/game/rl/world.js";
import { createDanmaku } from "../site/game/rl/danmaku.js";
import { attackFrom, tryHit } from "../site/game/rl/combat.js";
import { passiveRuntime, setAffixTable, affixTableFromPassives } from "../site/game/rl/equipment.js";
import { skillWords } from "../site/game/rl/ui/infocard.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const table = read("skills-rl.json"), data = read("cards-rl.json");
const cards = Array.isArray(data) ? data : data.cards;
setAffixTable(affixTableFromPassives(read("weapons-rl.json").passives));
const decode = id => decodeSkill(table.player[id], id, .35);
let checks = 0;
function test(label, run) { run(); checks++; console.log("PASS " + label); }
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test("Kaoruko's real cleanse/immunity slot is executable, not an empty cooldown", () => {
    assert.equal(decode(240020002).usable, true, "240020002 is still an unimplemented empty slot");
});
// Kept after the red gate so the pre-implementation failure identifies the
// actual missing player behaviour, rather than the not-yet-created module.
const { applyHealingLock, cleanseHealingLock, grantHealingLockImmunity,
    updatePlayerStatus, clearPlayerStatus } = await import("../site/game/rl/playerstatus.js");
const stats = { statsFor: () => ({ hp: 1000, atk: 100, mgc: 100,
    def: 10, mdef: 10, spd: 100, luck: 0 }) };
function makeWorld(id = 24002001, extra = {}) {
    const w = createWorld({ width: 32, height: 24, seed: 30909,
        tables: { stats, skills: extra.table || table } });
    w.spawnPlayer({ card: cards.find(c => c.id === id), x: 15, y: 12, level: 1 });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false,
        skill: [false, false, false], ultimate: false };
    return w;
}
function step(w, seconds) {
    for (let left = seconds; left > 1e-9; left -= 1 / 60) w.update(Math.min(left, 1 / 60));
}
function cast(w, slot) {
    w.inputState.skill[slot] = true; w.update(1 / 60);
    w.inputState.skill[slot] = false; w.update(1 / 60);
}
function lock(p, seconds = 5.6) { return applyHealingLock(p, 1, seconds, () => 0); }
function foe(w, extra = {}) {
    const e = w.spawnEnemy({ x: 19, y: 12, hp: 100000, atk: 100, mgc: 100,
        def: 10, mdef: 10, element: w.player.element, ...extra });
    e.actionTimer = 1e9; return e;
}
function curse(w, extra = {}) {
    const moveset = enemyMoveset(table, [138002]);
    if (extra.dash) moveset.attacks[0].pattern = "charge";
    const e = foe(w, { moveset, aiType: extra.dash ? "charger" : "sentry" });
    e.actionTimer = 0; w.rng = () => extra.roll ?? 0;
    for (let i = 0; i < 150 && !w.events.some(ev => ev.type === "hit" && ev.target === w.player); i++) {
        w.update(1 / 60);
    }
    e.actionTimer = 1e9;
    return e;
}

test("current masks and status order are retained without claiming other ailments", () => {
    assert.deepEqual(decode(240020002).statusEffects, [
        { kind: 5, target: 3 }, { kind: 6, target: 3, turns: 3 }
    ]);
    assert.deepEqual(decode(280020002).statusEffects, [
        { kind: 4, target: 0, chance: 1, turns: 2 }, { kind: 6, target: 0, turns: 3 }
    ]);
    assert.ok(decode(240020002).unhandled.includes(5));
    assert.ok(decode(240020002).unhandled.includes(6));
    assert.ok(decode(280020002).unhandled.includes(18));
    assert.ok(decode(321720001).unhandled.includes(4));
    assert.equal(decode(370020001).statusEffects.length, 0, "a Poison-only cleanse is not an Unhappy cleanse");
    near(decode(340020002).slow.pct, .7);
});
for (const target of [0, 3, 4]) test("single-player status target " + target, () => {
    const row = { target, effects: [{ kind: 6, target, args: [1, 3] }] };
    assert.equal(decodeSkill(row, 1, .35).usable, true);
});
for (const effect of [
    { kind: 4, target: 0, args: [0, 0, 0, 0, 0, "100", 0, 0] },
    { kind: 4, target: 0, args: [0, 0, 0, 0, 0, Infinity, 0, 0] },
    { kind: 4, target: 8, args: [0, 0, 0, 0, 0, 100, 0, 0] },
    { kind: 5, target: 2, args: [1, 1, 1, 1, 1, 1, 1, 1] },
    { kind: 5, target: 0, args: [0, 0, 1, 0, 0, 0, 0, 0] },
    { kind: 5, target: 0, args: [0, 0, 0, 0, 0, "1", 0, 0] },
    { kind: 6, target: 1, args: [1, 3] }, { kind: 6, target: 0, args: [1, 0] },
    { kind: 6, target: 0, args: [1, Infinity] }, { kind: 6, target: 0, args: [1, "3"] }
]) test("invalid/unsupported status stays unusable " + JSON.stringify(effect), () => {
    const slot = decodeSkill({ target: effect.target, effects: [effect] }, 1, .35);
    assert.equal(slot.usable, false); assert.ok(slot.unhandled.includes(effect.kind));
});
test("probability bounds and immunity avoid unnecessary random draws", () => {
    const p = makeWorld().player; let draws = 0;
    const rng = () => { draws++; return .32; };
    assert.equal(applyHealingLock(p, .33, 5.6, rng).action, "applied");
    assert.equal(draws, 1); clearPlayerStatus(p);
    assert.equal(applyHealingLock(p, .33, 5.6, () => .33).action, "miss");
    assert.equal(p.healingLock, 0);
    assert.equal(applyHealingLock(p, 0, 5.6, rng), null);
    assert.equal(applyHealingLock(p, 1, 5.6, rng).action, "applied");
    grantHealingLockImmunity(p, 8.4);
    assert.equal(applyHealingLock(p, .33, 5.6, rng).action, "immune");
    assert.equal(draws, 1); near(p.healingLock, 5.6);
    for (const chance of [NaN, Infinity, -1, "1", 2]) assert.equal(applyHealingLock(p, chance, 5.6, rng), null);
    for (const seconds of [NaN, Infinity, -1, "1", 0]) assert.equal(grantHealingLockImmunity(p, seconds), null);
});
test("refresh keeps the longer timer; immunity never cleanses an existing lock", () => {
    const p = makeWorld().player; lock(p); updatePlayerStatus(p, 1);
    lock(p, 2); near(p.healingLock, 4.6);
    grantHealingLockImmunity(p, 8.4); grantHealingLockImmunity(p, 1);
    near(p.healingLockImmunity, 8.4); near(p.healingLock, 4.6);
    assert.equal(cleanseHealingLock(p).action, "cleared");
    assert.equal(cleanseHealingLock(p), null); near(p.healingLockImmunity, 8.4);
    for (const dt of [-1, NaN, Infinity]) updatePlayerStatus(p, dt);
    near(p.healingLockImmunity, 8.4);
    updatePlayerStatus(p, 8.4); assert.equal(p.healingLockImmunity, 0);
});
test("Hanako's real input applies the drawback before immunity and consumes one cooldown", () => {
    const w = makeWorld(28002001), p = w.player; p.hp = 400; cast(w, 2);
    near(p.healingLock, 5.6 - 1 / 60); near(p.healingLockImmunity, 8.4 - 1 / 60);
    near(p.skills.slots[2].remaining, 11.55 - 1 / 60);
    assert.equal(p.hp, 400); assert.equal(p.skills.gauge, 0); near(p.speed, 3.5);
    step(w, .5); cast(w, 2);
    assert.equal(w.events.filter(e => e.type === "skill").length, 1);
    step(w, 5.6); assert.equal(p.healingLock, 0); assert.ok(p.healingLockImmunity > 0);
});
test("Kaoruko's real input clears only the lock, keeps buffs, and protects for three turns", () => {
    const w = makeWorld(), p = w.player; lock(p); p.skills.addGauge(123);
    p.skills.applySelf({ buff: { turns: 3, def: .2 }, barrier: { cut: 1, hits: 3 } });
    cast(w, 2);
    assert.equal(p.healingLock, 0); near(p.healingLockImmunity, 8.4 - 1 / 60);
    near(p.skills.slots[2].remaining, 6.3 - 1 / 60);
    near(p.skills.statMult("def"), 1.2); assert.equal(p.skills.barrier.hits, 3);
    assert.equal(p.skills.gauge, 123);
});
test("ordinary heals fail visibly under lock, consume cooldown, and never cut excess HP", () => {
    for (const hp of [400, 1200]) {
        const w = makeWorld(), p = w.player; p.hp = hp; lock(p); cast(w, 1);
        assert.equal(p.hp, hp); assert.ok(p.skills.slots[1].remaining > 0);
        assert.ok(w.events.some(e => e.type === "playerStatus" && e.action === "healBlocked"));
        assert.ok(!w.events.some(e => e.type === "heal" && e.amount !== 0));
    }
    const w = makeWorld(); w.player.hp = 400; cast(w, 1); assert.equal(w.player.hp, 1000);
});
test("the real Hanako ultimate cleanses before healing to 840, once", () => {
    const w = makeWorld(28002001), p = w.player; p.hp = 400; lock(p);
    p.skills.addGauge(p.skills.gaugeMax); assert.ok(w.useUltimate());
    assert.equal(p.hp, 840); assert.equal(p.healingLock, 0); assert.equal(p.skills.barrier.hits, 3);
    assert.equal(p.skills.gauge, 0); assert.equal(w.useUltimate(), false);
    assert.equal(w.events.filter(e => e.type === "heal").length, 1);
});
test("reversed ultimate sub-effects cannot retroactively unblock an earlier heal", () => {
    const id = 280020010, row = table.player[id];
    const altered = { ...table, player: { ...table.player, [id]: { ...row,
        effects: [row.effects[2], row.effects[1], row.effects[0]] } } };
    const w = makeWorld(28002001, { table: altered }), p = w.player; p.hp = 400; lock(p);
    p.skills.addGauge(p.skills.gaugeMax); assert.ok(w.useUltimate());
    assert.equal(p.hp, 400); assert.equal(p.healingLock, 0); assert.equal(p.skills.barrier.hits, 3);
});
test("Kirara's heal then immunity does not secretly cleanse or refund the gauge", () => {
    const w = makeWorld(32002001), p = w.player; p.hp = 400; lock(p);
    p.skills.addGauge(p.skills.gaugeMax); assert.ok(w.useUltimate());
    assert.equal(p.hp, 400); near(p.healingLock, 5.6); near(p.healingLockImmunity, 8.4);
    assert.equal(p.skills.gauge, 0);
});
test("regen spends blocked ticks without backlog and respects the expiry boundary", () => {
    const w = makeWorld(), p = w.player; p.hp = 400; lock(p);
    p.regen = { pct: .27, turnsLeft: 3, elapsed: 0 };
    step(w, 2.8); assert.equal(p.hp, 400); assert.equal(p.regen.turnsLeft, 2);
    step(w, 2.8); assert.equal(p.hp, 670); assert.equal(p.regen.turnsLeft, 1);
    step(w, 2.8); assert.equal(p.hp, 940); assert.equal(p.regen, null);
});
test("non-default table turn duration is used once, not re-derived", () => {
    const w = makeWorld(28002001, { table: { ...table, turnSeconds: 1.5 } }); cast(w, 2);
    near(w.player.healingLock, 3 - 1 / 60); near(w.player.healingLockImmunity, 4.5 - 1 / 60);
    const move = enemyMoveset({ ...table, turnSeconds: 1.5 }, [138002]).attacks[0];
    near(move.healingLockSeconds, 3);
});
test("enemy rows preserve probability, duration, and target side", () => {
    for (const [id, chance] of [[138002, .33], [163002, .2], [83025, 1]]) {
        const move = enemyMoveset(table, [id]).attacks[0];
        near(move.healingLockChance, chance); near(move.healingLockSeconds, 5.6);
    }
    assert.equal(enemyMoveset(table, [83026]).support[0].healingLockChance, 0);
    assert.equal(enemyMoveset(table, [10021]).attacks[0].healingLockChance, 0);
});
for (const dash of [false, true]) test("real enemy telegraph carries the curse through " + (dash ? "dash" : "bullet"), () => {
    const w = makeWorld(); curse(w, { dash });
    assert.equal(w.player.hp, 986); assert.ok(w.player.healingLock > 5);
    assert.equal(w.events.filter(e => e.type === "playerStatus" && e.action === "applied").length, 1);
});
test("a failed probability roll still deals ordinary damage but no status", () => {
    const w = makeWorld(); curse(w, { roll: .9 });
    assert.equal(w.player.hp, 986); assert.equal(w.player.healingLock, 0);
});
test("iframes block the whole hit, full barriers only block damage, immunity only blocks status", () => {
    for (const mode of ["iframes", "barrier", "immunity"]) {
        const w = makeWorld(), p = w.player;
        if (mode === "iframes") p.iframes = 10;
        if (mode === "barrier") p.skills.applySelf({ barrier: { cut: 1, hits: 1 } });
        if (mode === "immunity") grantHealingLockImmunity(p, 10);
        curse(w);
        assert.equal(p.hp, mode === "immunity" ? 986 : 1000);
        assert.equal(p.healingLock > 0, mode === "barrier");
        if (mode === "immunity") assert.ok(w.events.some(e => e.type === "playerStatus" && e.action === "immune"));
    }
});
test("dead targets reject ailments and a fatal hit leaves no status", () => {
    const w = makeWorld(), p = w.player, e = foe(w); p.hp = 1;
    const hit = tryHit(p, attackFrom(e, p, { coef: 1, healingLockChance: 1, healingLockSeconds: 5.6 }, { rng: () => 0 }));
    assert.equal(hit.died, true); assert.equal(p.healingLock, 0); assert.equal(lock(p), null);
});
test("bullet snapshot survives source mutation and pool reuse clears both new fields", () => {
    const d = createDanmaku({ capacity: 1 }), mods = { healingLockChance: .33, healingLockSeconds: 5.6 };
    d.emit("aimed", { x: 1, y: 1 }, mods); mods.healingLockChance = 1;
    let old; d.forEach(b => { old = b; near(b.healingLockChance, .33); near(b.healingLockSeconds, 5.6); });
    d.clear(); d.emit("aimed", { x: 1, y: 1 }, { side: "player" });
    d.forEach(b => { assert.equal(b, old); assert.equal(b.healingLockChance, 0); assert.equal(b.healingLockSeconds, 0); });
});
test("lifesteal is blocked without changing the landed attack", () => {
    const w = makeWorld(14002001), p = w.player; p.hp = 400; p.passives.lifesteal = .1; lock(p);
    const e = foe(w, { x: 16.5 });
    w.inputState.attack = true; w.update(1 / 60); w.inputState.attack = false; step(w, .5);
    assert.equal(p.hp, 400); assert.equal(e.hp, 99876);
    cleanseHealingLock(p); Object.assign(e, { x: 16.5, y: 12, kx: 0, ky: 0, stun: 0 });
    w.inputState.attack = true; w.update(1 / 60); w.inputState.attack = false; step(w, .5);
    assert.equal(p.hp, 412);
});
test("pause, hit-stop, room change and death keep their existing ownership boundaries", () => {
    const w = makeWorld(28002001), p = w.player; cast(w, 2); p.skills.addGauge(123);
    const snap = () => [p.healingLock, p.healingLockImmunity, p.skills.slots[2].remaining, p.skills.gauge];
    const before = snap(); w.frozen = true; step(w, 20); assert.deepEqual(snap(), before);
    w.frozen = false; w.applyHitStop(.5); step(w, .25); assert.deepEqual(snap(), before); w.hitStop = 0;
    w.setDungeon({ start: 0, rooms: [
        { id: 0, type: "start", seed: 1, enemies: [], doors: {} },
        { id: 1, type: "start", seed: 2, enemies: [], doors: {} }
    ] }); w.enterRoom(1);
    assert.equal(p.healingLock, 0); assert.equal(p.healingLockImmunity, 0);
    near(p.skills.slots[2].remaining, before[2]); assert.equal(p.skills.gauge, 123);
    lock(p); grantHealingLockImmunity(p, 10); p.dead = true; p.sm.force("dead"); w.update(1 / 60);
    assert.equal(p.healingLock, 0); assert.equal(p.healingLockImmunity, 0);
});
test("status text names the actual supported scope instead of promising every ailment", () => {
    const words = skillWords(decode(240020002)).join(";");
    assert.match(words, /解除治疗封锁/); assert.match(words, /治疗封锁免疫/);
    assert.match(words, /其余异常/);
    const hanako = skillWords(decode(280020002)).join(";");
    assert.match(hanako, /治疗封锁/); assert.match(hanako, /2回合/); assert.match(hanako, /补给/);
});
test("the real type-2 passive protects only future applications and survives room clearing", () => {
    const item = { slot: "armor", rarity: 0, affixes: ["11032001"] };
    const rt = passiveRuntime([item]);
    assert.equal(rt.healingLockImmune, true); assert.ok(!rt.noops.includes(2)); assert.ok(rt.noops.includes(3));
    const w = makeWorld(), p = w.player; lock(p);
    const before = JSON.stringify([p.healingLock, p.healingLockImmunity, p.equipment]);
    assert.ok(w.previewEquipment(item)); assert.equal(JSON.stringify([p.healingLock, p.healingLockImmunity, p.equipment]), before);
    function equip(next) {
        const entry = { x: p.x, y: p.y, items: [next] }; w.drops.push(entry);
        assert.equal(w.takeDrop(entry, next), true);
    }
    equip(item); assert.equal(p.passives.healingLockImmune, true); near(p.healingLock, 5.6);
    cleanseHealingLock(p); assert.equal(lock(p).action, "immune"); assert.equal(p.healingLock, 0);
    clearPlayerStatus(p); assert.equal(lock(p).action, "immune");
    equip({ slot: "armor", rarity: 0, affixes: [] });
    assert.equal(p.passives.healingLockImmune, false); assert.equal(lock(p).action, "applied");
});
test("Harumi's existing recovery buffs still work when the new cleanse is used", () => {
    const w = makeWorld(36002001), p = w.player; lock(p); cast(w, 2);
    assert.equal(p.healingLock, 0); near(p.skills.cooldownRate, 23 / 17); near(p.speed, 3.5);
    assert.ok(p.skills.slots[2].remaining > 0);
});
test("a Poison-only cleanse cannot clear Unhappy by treating any mask as all statuses", () => {
    const w = makeWorld(37002001), p = w.player; lock(p); cast(w, 1);
    assert.ok(p.healingLock > 5.5); near(p.skills.statMult("atk"), 1.3);
    assert.ok(!w.events.some(e => e.type === "playerStatus" && e.action === "cleared"));
});
test("a shot retains its curse after its shooter dies, but a missed shot grants no status", () => {
    for (const missed of [false, true]) {
        const w = makeWorld(), p = w.player, e = foe(w);
        w.rng = () => 0;
        w.danmaku.emit("aimed", { x: e.x, y: e.y, angle: missed ? 0 : Math.PI }, {
            side: "enemy", power: 100, coef: .2, element: p.element, srcId: e.id,
            speed: 10, healingLockChance: .33, healingLockSeconds: 5.6
        });
        e.dead = true; e.sm.force("dead"); step(w, .6);
        assert.equal(p.hp, missed ? 1000 : 986); assert.equal(p.healingLock > 0, !missed);
    }
});
test("ordinary body contact does not borrow a curse from an enemy's ranged moveset", () => {
    const w = makeWorld(), p = w.player;
    foe(w, { x: p.x + .5, moveset: enemyMoveset(table, [138002]) });
    w.update(1 / 60); assert.equal(p.hp, 986); assert.equal(p.healingLock, 0);
});
test("door-fade updates decay both timers before the room boundary clears them", () => {
    const w = makeWorld(), p = w.player;
    w.setDungeon({ start: 0, rooms: [
        { id: 0, type: "start", seed: 1, enemies: [], doors: {} },
        { id: 1, type: "start", seed: 2, enemies: [], doors: {} }
    ] });
    lock(p); grantHealingLockImmunity(p, 8.4);
    w.transition = { t: 0, to: 1, fromSide: "W" }; w.update(1 / 60);
    near(p.healingLock, 5.6 - 1 / 60); near(p.healingLockImmunity, 8.4 - 1 / 60);
    step(w, .3); assert.equal(p.healingLock, 0); assert.equal(p.healingLockImmunity, 0);
});
test("non-combat supplies keep their existing once-only heal rule", () => {
    const w = makeWorld(), p = w.player;
    w.setDungeon({ start: 0, rooms: [{ id: 0, type: "rest", seed: 1, enemies: [], doors: {} }] });
    p.hp = 400; lock(p);
    assert.equal(w.chooseSupply("heal", 0).amount, 400); assert.equal(p.hp, 800);
    assert.equal(w.chooseSupply("heal", 0), null); near(p.healingLock, 5.6);
});
test("a survival passive is not turned into a second death by a healing lock", () => {
    const w = makeWorld(), p = w.player; p.hp = 1; p.passives.survival = 1; lock(p);
    curse(w);
    assert.equal(p.hp, 1000); assert.equal(p.dead, false); assert.equal(p.survivalUsed, 1);
    assert.ok(p.healingLock > 0); assert.ok(w.events.some(e => e.type === "survival"));
});
console.log(`Healing lock: ${checks} checks passed.`);
