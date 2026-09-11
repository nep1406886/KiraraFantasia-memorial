// T30 kind 3: versioned masks, selective temporary fields and actual hit paths.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSkills, decodeSkill, enemyMoveset } from "../site/game/rl/skills.js";
import { createWorld } from "../site/game/rl/world.js";
import { createDanmaku } from "../site/game/rl/danmaku.js";
import { attackFrom, tryHit, effectiveStat } from "../site/game/rl/combat.js";
import { skillWords } from "../site/game/rl/ui/infocard.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const shipped = read("skills-rl.json"), weapons = read("weapons-rl.json"), data = read("cards-rl.json");
const table = { ...shipped, weaponChildren: weapons.childSkills };
const cards = Array.isArray(data) ? data : data.cards;
const hitori = cards.find(card => card.id === 46002001);
const decode = id => decodeSkill(table.player[id] || table.weaponChildren[id], id, .35, table.skillCards);
let checks = 0;
function test(label, run) { run(); checks++; console.log("PASS " + label); }
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-7, actual + " != " + expected); }

test("Hitori's authored magic-defence cleanse no longer leaves kind 3 unimplemented", () => {
    assert.ok(!decode(460020001).unhandled.includes(3), "460020001 still cannot remove magic-defence down");
    assert.deepEqual(decode(460020001).statResets, [{ target: 0, stats: ["mdef"], mode: "down" }]);
    near(decode(460020001).cooldown, 9.8);
});
// Delay the new module import so the red test identifies the missing real skill.
const { STAT_KEYS, decodeStatReset, resetStatChanges } = await import("../site/game/rl/statreset.js");
const stats = { statsFor: () => ({ hp: 1000, atk: 100, mgc: 100, def: 100, mdef: 100, spd: 100, luck: 0 }) };
const stepSize = 1 / 120;
function makeWorld(extra = {}) {
    const w = createWorld({ width: 32, height: 24, seed: 300912,
        tables: { stats, skills: extra.table || table } });
    w.spawnPlayer({ card: extra.card || hitori, x: 15, y: 12, level: 1 });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false,
        skill: [false, false, false], ultimate: false };
    w.rng = () => .5;
    return w;
}
function step(w, seconds) {
    for (let left = seconds; left > 1e-9; left -= stepSize) w.update(Math.min(left, stepSize));
}
function cast(w, index = 1) {
    w.inputState.skill[index] = true; w.update(stepSize);
    w.inputState.skill[index] = false; w.update(stepSize);
}
function foe(w, extra = {}) {
    const e = w.spawnEnemy({ x: 19, y: 12, hp: 100000, atk: 500, mgc: 500,
        def: 100, mdef: 100, luck: 0, element: w.player.element, ...extra });
    e.actionTimer = 1e9;
    return e;
}
function resetEffect(keys, mode = "down", target = 0) {
    const args = STAT_KEYS.map(key => keys.includes(key) ? 1 : 0);
    if (mode !== "all") args.push(mode === "down" ? 0 : 1);
    return { kind: 3, target, args };
}
function buffEffect(values, target = 0, turns = 3) {
    return { kind: 2, target, args: [1, turns, values.atk || 0, values.mgc || 0,
        values.def || 0, values.mdef || 0, values.spd || 0, values.luck || 0] };
}
function row(effects, target = 0, extra = {}) {
    return { name: "reset fixture", target, effects, recasts: [28],
        coef: effects.find(e => e.kind === 0)?.args[0] / 1000 || 0,
        magic: !!effects.find(e => e.kind === 0)?.args[1], ...extra };
}
function slot(effects, target = 0) { return decodeSkill(row(effects, target), 990, .35); }
function replaceSlot(effects, ultimate = false, target = 0) {
    const id = ultimate ? hitori.skillIds.chara : hitori.skillIds.class[0];
    return { ...table, player: { ...table.player, [id]: row(effects, target) } };
}
function add(s, values, turns = 3) { s.applySelf({ buff: { turns, ...values } }); }
function fireUntilHit(w, id, dash = false) {
    const moveset = enemyMoveset(table, [id]);
    if (dash) moveset.attacks[0].pattern = "charge";
    const e = foe(w, { moveset, aiType: dash ? "charger" : "sentry" });
    e.actionTimer = 0;
    const mark = w.events.length;
    for (let i = 0; i < 480; i++) {
        w.update(stepSize);
        if (w.events.slice(mark).some(ev => ev.type === "hit" && ev.target === w.player)) break;
    }
    e.actionTimer = 1e9;
    const events = w.events.slice(mark);
    assert.ok(events.some(ev => ev.type === "telegraph" && ev.skill.id === id));
    assert.ok(events.some(ev => ev.type === (dash ? "dash" : "enemySkill") && ev.skill.id === id));
    assert.equal(events.filter(ev => ev.type === "hit" && ev.target === w.player).length, 1);
    return { e, events };
}

test("real player and weapon masks retain their direction and source cooldown", () => {
    assert.deepEqual(decode(170020302).statResets, [{ target: 0, stats: ["atk"], mode: "down" }]);
    assert.deepEqual(decode(321420012).statResets, [{ target: 1, stats: ["atk", "mgc"], mode: "up" }]);
    assert.deepEqual(decode(460020012).statResets, decode(460020001).statResets);
    assert.ok(decode(460020002).unhandled.includes(4), "Isolation is still a separate gap");
    const normalIds = Object.values(weapons.passives).flatMap(p => p.effects
        .filter(e => e.type === 8 && e.args[0] > 0).map(e => e.args[0]));
    assert.ok(normalIds.every(id => !(weapons.childSkills[id]?.effects || []).some(e => e.kind === 3)));
});
for (const target of [0, 1, 2, 3, 4]) test("legal target does not infer reset direction: " + target, () => {
    const effect = resetEffect(["atk"], "up", target), decoded = slot([effect], target);
    assert.equal(decoded.usable, true); assert.equal(decoded.statResets[0].mode, "up");
    assert.equal(decoded.statResets[0].target, target);
});
const invalid = [
    { args: [] }, { args: [1, 0, 0, 0, 0] }, { args: [1, 0, 0, 0, 0, 0, 0, 0] },
    { args: [0, 0, 0, 0, 0, 0] }, { args: [0, 0, 0, 0, 0, 0, 1] },
    { args: [1, 0, 0, 0, 0, 0, 2] }, { args: [1, 0, 0, 0, 0, 0, -1] },
    { args: [.5, 0, 0, 0, 0, 0, 0] }, { args: ["1", 0, 0, 0, 0, 0, 0] },
    { args: [true, 0, 0, 0, 0, 0, 0] }, { args: [NaN, 0, 0, 0, 0, 0, 0] },
    { args: [Infinity, 0, 0, 0, 0, 0, 0] }, { args: "1000000" },
    { target: "0" }, { target: 5 }, { target: -1 }, { target: null },
    { args: Object.assign(Array(7), { 0: 1, 6: 0 }) }
];
invalid.forEach((bad, index) => test("invalid or empty mask stays an unhandled non-action: " + index, () => {
    const effect = { ...resetEffect(["atk"]), ...bad }, decoded = slot([effect], effect.target);
    assert.equal(decoded.usable, false); assert.ok(decoded.unhandled.includes(3));
    assert.deepEqual(decoded.statResets, []); assert.equal(decodeStatReset(effect), null);
}));
test("decoder snapshots and freezes only its reset definition, never source data", () => {
    const effect = resetEffect(["mdef"]), decoded = slot([effect]);
    effect.args[3] = 0; effect.args[0] = 1;
    assert.deepEqual(decoded.statResets[0].stats, ["mdef"]);
    assert.equal(Object.isFrozen(effect.args), false);
    assert.ok(Object.isFrozen(decoded.statResets[0]));
    assert.ok(Object.isFrozen(decoded.statResets[0].stats));
    assert.throws(() => decoded.statResets[0].stats.push("atk"), TypeError);
});
for (const key of ["atk", "mgc", "def", "mdef", "spd", "luck"]) {
    for (const mode of ["down", "up", "all"]) test("selective " + key + " / " + mode, () => {
        const s = createSkills({ table, card: hitori, maxHp: 1000 });
        const positive = Object.fromEntries(STAT_KEYS.map(k => [k, .3]));
        const negative = Object.fromEntries(STAT_KEYS.map(k => [k, -.5]));
        add(s, positive); add(s, negative);
        const before = s.buffs.map(b => b.remaining);
        const changed = s.resetStats(decodeStatReset(resetEffect([key], mode)));
        assert.deepEqual(changed, [key]);
        near(s.statMult(key), mode === "down" ? 1.3 : mode === "up" ? .5 : 1);
        STAT_KEYS.filter(k => k !== key).forEach(k => near(s.statMult(k), .8));
        assert.deepEqual(s.buffs.map(b => b.remaining), before);
    });
}
test("mixed rows keep unrelated fields, aliases and independent expiry", () => {
    const buffs = [{ remaining: 5, turns: 3, mdef: -.5, atk: .2, spd: .5,
        weakElementBonus: .35, resistElement: 4, resistPct: .4, marker: "preserve" },
        { remaining: 2, mdef: .35 }, { remaining: 0, mdef: -.1 }];
    const original = buffs[0], before = structuredClone(buffs);
    assert.deepEqual(resetStatChanges(buffs, decodeStatReset(resetEffect(["mdef"]))), ["mdef"]);
    assert.equal(buffs[0], original); before[0].mdef = 0; assert.deepEqual(buffs, before);
    assert.deepEqual(resetStatChanges(buffs, { stats: ["resistPct"], mode: "all" }), []);
    assert.deepEqual(resetStatChanges(buffs, { stats: ["mdef"], mode: "invalid" }), []);
});
test("opposite stacks are inspected individually, not by their net-zero total", () => {
    const s = createSkills({ table, card: hitori }); add(s, { atk: .5 }); add(s, { atk: -.5 });
    near(s.statMult("atk"), 1); s.resetStats(decodeStatReset(resetEffect(["atk"]))); near(s.statMult("atk"), 1.5);
    add(s, { atk: -.2 }); near(s.statMult("atk"), 1.3);
    s.update(8.4); near(s.statMult("atk"), 1);
});
test("speed uses normalized benefit signs and does not reset cooldown work", () => {
    const s = createSkills({ table, card: hitori });
    s.applySelf(slot([buffEffect({ spd: .5 }), buffEffect({ spd: 2 })]));
    s.slots[2].remaining = 10; near(s.cooldownRate, 1.5);
    s.resetStats(decodeStatReset(resetEffect(["spd"]))); near(s.cooldownRate, 2);
    near(s.slots[2].remaining, 10); s.update(.5); near(s.slots[2].remaining, 9);
    s.resetStats(decodeStatReset(resetEffect(["spd"], "up"))); near(s.cooldownRate, 1);
});
for (const first of [false, true]) test("ordinary self reset and buff preserve source order: reset first=" + first, () => {
    const reset = resetEffect(["atk"], "all"), buff = buffEffect({ atk: 23 });
    const s = createSkills({ table, card: hitori }); add(s, { atk: -.5 });
    s.applySelf(slot(first ? [reset, buff] : [buff, reset]));
    near(s.statMult("atk"), first ? 1.23 : 1);
});
test("Hitori removes -50%, preserves the real +35%, and refreshes defence in the cast frame", () => {
    const w = makeWorld(), p = w.player;
    cast(w, 2); step(w, .5); add(p.skills, { mdef: -.5 }); w.update(stepSize);
    near(p.mdef, 85); const beforeBase = { ...p.base }, beforeGauge = p.skills.gauge;
    w.inputState.skill[1] = true; w.update(stepSize); w.inputState.skill[1] = false;
    near(p.mdef, 135); near(p.skills.slots[1].remaining, 9.8);
    assert.deepEqual(p.skills.barrier, { cut: .5, hits: 1 });
    assert.deepEqual(p.base, beforeBase); assert.equal(p.skills.gauge, beforeGauge);
    const e = foe(w), hit = w.hitPlayerFrom(e, enemyMoveset(table, [16002]).attacks[0]);
    assert.equal(hit.damage, 35); assert.equal(p.hp, 965); assert.equal(p.skills.barrier, null);
    assert.ok(w.events.some(ev => ev.type === "statReset" && ev.unit === p && ev.changed.includes("mdef")));
});
test("valid no-op cleanse spends its cooldown once and reports no removed field", () => {
    const w = makeWorld(), p = w.player; p.skills.addGauge(123);
    cast(w); step(w, .5); cast(w);
    assert.equal(w.events.filter(e => e.type === "skill").length, 1);
    assert.deepEqual(w.events.filter(e => e.type === "statReset").map(e => e.changed), [[]]);
    assert.equal(p.skills.gauge, 123); near(p.speed, 3.5);
    assert.ok(p.skills.slots[1].remaining > 9);
});
test("reset does not wipe barriers, resistance, ailments, regen, next attack, cards or equipment stacks", () => {
    const w = makeWorld(), p = w.player;
    p.skills.applySelf(slot([buffEffect({ atk: -50, spd: 2 })]));
    p.skills.applySelf({ barrier: { cut: .66, hits: 2 }, resists: { target: 0, turns: 3, by: { 4: .2 } },
        weakBonuses: [{ target: 0, turns: 3, pct: .35 }] });
    p.healingLock = 5.6; p.healingLockImmunity = 8.4; p.nextAtkBonus = .5;
    p.regen = { pct: .2, turnsLeft: 3, elapsed: 1 }; p.skillCards.push({ marker: "untouched" });
    p.stackHits = 4; p.stackKills = 3;
    const snapshot = () => JSON.stringify({ base: p.base, hp: p.hp, shield: p.skills.barrier,
        resists: p.skills.resistFor(4), weak: p.skills.weakElementBonus,
        lock: p.healingLock, immunity: p.healingLockImmunity, next: p.nextAtkBonus,
        regen: p.regen, cards: p.skillCards, hits: p.stackHits, kills: p.stackKills });
    const before = snapshot(); p.skills.applySelf(slot([resetEffect(STAT_KEYS, "all")]));
    assert.equal(snapshot(), before); near(p.skills.statMult("atk"), 1); near(p.skills.cooldownRate, 1);
});
for (const target of [1, 2]) test("non-damage enemy reset honours aimed/all targeting: " + target, () => {
    const w = makeWorld({ table: replaceSlot([resetEffect(["atk"], "up", target)], false, target) });
    const a = foe(w, { x: 18, y: 12 }), b = foe(w, { x: 15, y: 16 }), dead = foe(w, { x: 16, dead: true });
    dead.dead = true; dead.sm.force("dead");
    for (const e of [a, b, dead]) e.debuffs = [{ atk: .5, mdef: -.2, remaining: 8 }];
    a.iframes = 100; w.aim = { x: b.x, y: b.y }; cast(w);
    near(effectiveStat(a, "atk"), target === 2 ? 500 : 750);
    near(effectiveStat(b, "atk"), 500); near(effectiveStat(dead, "atk"), 750);
    near(effectiveStat(b, "mdef"), 80);
});
for (const first of [false, true]) test("enemy timed buff/reset preserve source order on direct and projectile delivery: " + first, () => {
    for (const damaging of [false, true]) {
        const reset = resetEffect(["atk"], "all", 1), buff = buffEffect({ atk: 23 }, 1);
        const effects = first ? [reset, buff] : [buff, reset];
        if (damaging) effects.unshift({ kind: 0, target: 1, args: [1000, 0] });
        const w = makeWorld({ table: replaceSlot(effects, false, 1) }), e = foe(w);
        e.debuffs = [{ atk: -.5, remaining: 8 }]; w.aim = e; cast(w); step(w, 1);
        near(effectiveStat(e, "atk"), first ? 615 : 500);
    }
});
test("real type-8 enemy cleanse rides the shot, keeps negative stacks and ignores later unequip", () => {
    const w = makeWorld(), p = w.player, e = foe(w); p.skills.applyWeapon({ skillOverrides: [321420012] });
    e.atk = 100; e.mgc = 100;
    e.debuffs = [{ atk: .8, mgc: .5, remaining: 8 }, { atk: -.3, mgc: -.2, remaining: 8 }];
    e.slow = { pct: .2, remaining: 8 }; e.resists = [{ element: 0, pct: .2, remaining: 8 }];
    w.aim = e; cast(w); near(effectiveStat(e, "atk"), 150);
    let bullet; w.danmaku.forEach(b => { if (b.side === "player") bullet = b; });
    assert.equal(bullet.skillId, 321420012); assert.equal(bullet.statEffects[0].reset.mode, "up");
    p.skills.applyWeapon({}); step(w, 1);
    assert.equal(100000 - e.hp, 312); near(effectiveStat(e, "atk"), 70); near(effectiveStat(e, "mgc"), 80);
    assert.ok(e.slow && e.resists.length); assert.equal(p.skills.gauge, 312);
    assert.equal(w.events.filter(ev => ev.type === "statReset" && ev.unit === e).length, 1);
});
for (const guarded of ["iframes", "barrier", "dead"]) test("outgoing reset obeys the accepted-hit boundary: " + guarded, () => {
    const w = makeWorld(), p = w.player, e = foe(w); p.skills.applyWeapon({ skillOverrides: [321420012] });
    e.debuffs = [{ atk: .5, remaining: 8 }];
    if (guarded === "iframes") e.iframes = 10;
    if (guarded === "barrier") e.skills = { absorb: () => 0 };
    if (guarded === "dead") e.hp = 1;
    w.aim = e; cast(w); step(w, 1);
    near(effectiveStat(e, "atk"), guarded === "barrier" ? 500 : 750);
    assert.equal(w.events.filter(ev => ev.type === "statReset" && ev.unit === e).length, guarded === "barrier" ? 1 : 0);
});
test("projectile damage reads defence before removing its up effect", () => {
    const effects = [{ kind: 0, target: 1, args: [1000, 0] }, resetEffect(["def"], "up", 1)];
    const w = makeWorld({ table: replaceSlot(effects, false, 1) }), e = foe(w);
    e.debuffs = [{ def: 1, remaining: 8 }]; w.aim = e; cast(w); step(w, 1);
    assert.equal(100000 - e.hp, 140); near(effectiveStat(e, "def"), 100);
    assert.equal(tryHit(e, attackFrom(w.player, e, { coef: 1, magic: false }, { crit: false })).damage, 200);
});
for (const side of ["self", "enemy"]) for (const first of [false, true]) test("ultimate atomic order " + side + " reset-first=" + first, () => {
    const damage = { kind: 0, target: 1, args: [1000, 0] };
    const reset = resetEffect([side === "self" ? "atk" : "def"], side === "self" ? "down" : "up", side === "self" ? 0 : 1);
    const w = makeWorld({ table: replaceSlot(first ? [reset, damage] : [damage, reset], true, 1) }), p = w.player, e = foe(w);
    if (side === "self") add(p.skills, { atk: -.5 }); else e.debuffs = [{ def: 1, remaining: 8 }];
    p.skills.addGauge(p.skills.gaugeMax); assert.ok(w.useUltimate());
    assert.equal(100000 - e.hp, first ? 200 : side === "self" ? 70 : 140);
    assert.equal(p.skills.gauge, 0); assert.equal(w.useUltimate(), false);
});
test("ultimate never retargets a dead single target, but an independent reset is not a bullet rider", () => {
    const effects = [{ kind: 0, target: 1, args: [1000, 0] }, resetEffect(["atk"], "up", 1)];
    for (const invincible of [false, true]) {
        const w = makeWorld({ table: replaceSlot(effects, true, 1) }), p = w.player;
        const a = foe(w, { x: 18, hp: 1 }), b = foe(w, { x: 20 });
        a.debuffs = [{ atk: .5, remaining: 8 }]; b.debuffs = [{ atk: .5, remaining: 8 }];
        if (invincible) a.iframes = 10;
        w.aim = a; p.skills.addGauge(p.skills.gaugeMax); assert.ok(w.useUltimate());
        near(effectiveStat(a, "atk"), invincible ? 500 : 750); near(effectiveStat(b, "atk"), 750);
    }
});
test("an empty enemy-only ultimate cannot consume gauge; self no-op reset can", () => {
    for (const target of [0, 1]) {
        const w = makeWorld({ table: replaceSlot([resetEffect(["atk"], "down", target)], true, target) }), p = w.player;
        p.skills.addGauge(p.skills.gaugeMax);
        assert.equal(!!w.useUltimate(), target === 0); assert.equal(p.skills.gauge, target === 0 ? 0 : p.skills.gaugeMax);
    }
});
test("enemy movesets admit only supported opponent-target post-damage resets", () => {
    const all = enemyMoveset(table, [15017, 114074, 143002, 19052, 48006, 157001, 12032, 123003]);
    assert.deepEqual(all.attacks.filter(s => s.hitStatResets.length).map(s => s.id), [15017, 114074, 143002]);
    assert.deepEqual(all.attacks[0].hitStatResets, [{ target: 1, stats: ["atk", "mgc"], mode: "all" }]);
    assert.deepEqual(all.attacks[1].hitStatResets, [{ target: 2, stats: ["spd"], mode: "up" }]);
    assert.ok(all.support.every(s => s.hitStatResets.length === 0));
    const reversed = { ...table, enemy: { 99: { ...table.enemy[15017], effects: table.enemy[15017].effects.slice().reverse() } } };
    assert.equal(enemyMoveset(reversed, [99]).attacks[0].hitStatResets.length, 0);
});
for (const dash of [false, true]) test("real enemy reset reaches the player through telegraph and " + (dash ? "lunge fixture" : "volley"), () => {
    const w = makeWorld(), p = w.player; add(p.skills, { atk: .5, mgc: -.3, mdef: .2 });
    const result = fireUntilHit(w, 15017, dash);
    near(p.atk, 100); near(p.mgc, 100); near(p.mdef, 120);
    assert.equal(result.events.filter(ev => ev.type === "statReset" && ev.unit === p).length, 1);
    assert.equal(p.skills.gauge, 53); assert.equal(p.hp, 947);
});
test("incoming all-reset refreshes defence before the next same-frame hit", () => {
    const w = makeWorld(), p = w.player, e = foe(w); add(p.skills, { def: 1, mdef: 1 }); w.update(stepSize);
    const first = w.hitPlayerFrom(e, enemyMoveset(table, [143002]).attacks[0]);
    assert.equal(first.damage, 30); near(p.def, 100); near(p.mdef, 100);
    p.iframes = 0; const second = w.hitPlayerFrom(e, enemyMoveset(table, [16002]).attacks[0]);
    assert.equal(second.damage, 90); assert.equal(p.hp, 880);
});
for (const guarded of ["iframes", "barrier", "fatal"]) test("incoming reset and shared mitigation: " + guarded, () => {
    const w = makeWorld(), p = w.player, e = foe(w); add(p.skills, { atk: .5 }); w.update(stepSize);
    if (guarded === "iframes") p.iframes = 10;
    if (guarded === "barrier") p.skills.applySelf({ barrier: { cut: 1, hits: 1 } });
    if (guarded === "fatal") p.hp = 1;
    const result = tryHit(p, attackFrom(e, p, enemyMoveset(table, [15017]).attacks[0], { crit: false }));
    near(p.skills.statMult("atk"), guarded === "barrier" ? 1 : 1.5);
    assert.equal((result.statResets || []).length, guarded === "barrier" ? 1 : 0);
});
test("enemy projectile snapshots the reset list and recycled slots clear both carriers", () => {
    const d = createDanmaku({ capacity: 1 }), resets = [decodeStatReset(resetEffect(["spd"], "up", 1))];
    const ops = [{ reset: decodeStatReset(resetEffect(["atk"], "up", 1)) }];
    d.emit("aimed", { x: 1, y: 1 }, { hitStatResets: resets, statEffects: ops });
    let first; d.forEach(b => { first = b; }); resets.length = 0;
    assert.equal(first.hitStatResets.length, 1); d.clear();
    d.emit("aimed", { x: 1, y: 1 }, {});
    d.forEach(b => { assert.equal(b, first); assert.equal(b.hitStatResets, null); assert.equal(b.statEffects, null); });
});
test("freeze, hit-stop, room and death preserve the existing state boundaries", () => {
    const w = makeWorld(), p = w.player; add(p.skills, { mdef: -.5 }); p.skills.addGauge(123);
    w.frozen = true; w.inputState.skill[1] = true; step(w, 2);
    near(p.skills.statMult("mdef"), .5); assert.equal(p.skills.slots[1].remaining, 0);
    w.frozen = false; w.inputState.skill[1] = false; w.update(stepSize);
    w.applyHitStop(.2); w.inputState.skill[1] = true; w.update(stepSize);
    near(p.skills.statMult("mdef"), .5); w.inputState.skill[1] = false; step(w, .3);
    near(p.skills.statMult("mdef"), 1); assert.ok(p.skills.slots[1].remaining > 9);
    add(p.skills, { mdef: -.5 }); const cooldown = p.skills.slots[1].remaining;
    w.setDungeon({ start: 0, rooms: [{ id: 0, type: "start", seed: 1, enemies: [], doors: {} },
        { id: 1, type: "start", seed: 2, enemies: [], doors: {} }] }); w.enterRoom(1);
    near(p.skills.statMult("mdef"), 1); near(p.skills.slots[1].remaining, cooldown); assert.equal(p.skills.gauge, 123);
    add(p.skills, { atk: .5 }); p.dead = true; p.sm.force("dead"); w.update(stepSize);
    assert.equal(p.skills.buffs.length, 0); assert.equal(p.skills.gauge, 123);
});
test("descriptions distinguish down/up/all and player speed adaptation without hiding other gaps", () => {
    assert.match(skillWords(decode(460020001)).join(";"), /解除自身魔防降低.*保留提高/);
    assert.match(skillWords(decode(321420012)).join(";"), /解除敌方单体物攻.*魔攻提高.*保留降低/);
    assert.match(skillWords(slot([resetEffect(["spd"], "all")])).join(";"), /技能恢复速度.*正负变化/);
    assert.ok(!skillWords(decode(460020001)).join(";").includes("未适配：能力"));
    assert.ok(skillWords(decode(460020002)).join(";").includes("未适配：自身异常"));
});
console.log("Stat reset: " + checks + " checks passed.");
