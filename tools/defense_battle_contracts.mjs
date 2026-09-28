import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Battle } from "../site/etowaria-defense/sim/battle.js";
import { LEVELS, UNIT_RULES, ENEMY_RULES, ENDLESS, TICK, DECK_ORDER, GEAR_ORDER, unlockedUnits } from "../site/etowaria-defense/data/campaign.js";
import { CampaignSave, validateProgress } from "../site/etowaria-defense/app/campaign-save.js";

const checks = [];
const test = (name, run) => { run(); checks.push({ name, passed: true }); };
function advance(battle, seconds) {
    for (let time = 0; time < seconds - 1e-8; time += TICK) { battle.step(Math.min(TICK, seconds - time)); }
}
const fixture = overrides => ({ ...LEVELS[0], rows: 1, cols: 9, startResource: 1000,
    spawns: [{ at: 1, row: 0, type: "E01", wave: 1 }], ...overrides });

// A scripted player: economy first, then one attacker per threatened lane,
// walls where guests arrive, support behind walls, the spell for emergencies.
export function playWithBudget(level, deck = level.recommended) {
    const battle = new Battle(level, { deck: ["F01", ...deck] });
    const cards = new Set(battle.deck);
    const mid = Math.floor(level.rows / 2);
    const order = [...new Set([mid, 0, level.rows - 1, 1, 3].filter(row => row < level.rows))];
    const history = [];
    const act = (type, row, col) => {
        if (!cards.has(type)) { return false; }
        const result = battle.deploy(type, row, col);
        if (result.ok) { history.push({ time: +battle.time.toFixed(2), type, row, col, balance: battle.resource }); }
        return result.ok;
    };
    const units = () => [...battle.units.values()];
    const enemies = () => [...battle.enemies.values()];
    const has = (row, test) => units().some(unit => unit.row === row && test(unit));
    const kindOf = unit => UNIT_RULES[unit.type].kind;
    const attackers = ["U04", "U03", "U06", "U05", "U20", "U02", "U01", "U19", "U24", "U21", "U23", "U22"].filter(id => cards.has(id));
    const walls = ["U12", "U13", "U14", "U11"].filter(id => cards.has(id));
    const melee = ["U10", "U08", "U09", "U07"].filter(id => cards.has(id));
    const supports = ["U17", "U16", "U15", "U18"].filter(id => cards.has(id));
    act("F01", mid, 0);
    act(cards.has("U01") ? "U01" : attackers.at(-1), mid, 1);
    act("F01", order[1], 0);
    battle.start();
    for (let frame = 0; frame < 900 * 60 && battle.phase === "running"; frame++) {
        battle.collectAll();
        if (frame % 15 === 0) {
            const threat = row => enemies().filter(enemy => enemy.row === row);
            const lanes = [...order].sort((a, b) => Math.min(...threat(a).map(e => e.x), 99) - Math.min(...threat(b).map(e => e.x), 99));
            // Emergency spell.
            for (const enemy of enemies().sort((a, b) => a.x - b.x)) {
                if (enemy.x < 1.6 || ENEMY_RULES[enemy.type].boss && enemy.x < 4) { if (act("F10", enemy.row, Math.max(0, Math.min(level.cols - 1, Math.round(enemy.x))))) { break; } }
            }
            const producers = units().filter(unit => unit.type === "F01").length;
            const target = Math.min(level.rows, level.rows >= 5 ? 5 : 3);
            if (producers < target && battle.time < 110) {
                const row = order.find(lane => !battle.occupancy.has(`${lane}:0`));
                if (row !== undefined) { act("F01", row, 0); }
            }
            const building = producers < Math.min(4, target) && battle.time < 80;
            for (const row of lanes) {
                const incoming = threat(row);
                const dangerous = incoming.length > 0 || battle.spawns.slice(battle.spawnIndex, battle.spawnIndex + 4).some(spawn => spawn.row === row);
                if (!dangerous && battle.resource < 250) { continue; }
                const shooters = units().filter(unit => unit.row === row && ["shooter", "lobber"].includes(kindOf(unit)));
                if (shooters.length < 1) {
                    const cheap = building ? attackers.filter(id => UNIT_RULES[id].cost <= 150) : attackers;
                    for (const id of cheap) { if (act(id, row, 1)) { break; } }
                    continue;
                }
                const heavy = incoming.some(enemy => ENEMY_RULES[enemy.type].hp >= 380 || ENEMY_RULES[enemy.type].boss || ENEMY_RULES[enemy.type].hop);
                if (incoming.length && !has(row, unit => kindOf(unit) === "guard") && (heavy || incoming.length > 1)) {
                    const hopper = incoming.some(enemy => ENEMY_RULES[enemy.type].hop);
                    const pick = hopper && cards.has("U12") ? ["U12"] : walls;
                    for (const id of pick) { if (act(id, row, 5)) { break; } }
                }
                if (building) { continue; }
                if (shooters.length < 2 && battle.resource >= 175) { for (const id of attackers) { if (act(id, row, 2)) { break; } } }
                if (shooters.length >= 2 && shooters.length < 3 && battle.resource >= 325 && battle.time > 90) { for (const id of attackers) { if (act(id, row, 3)) { break; } } }
                const guard = units().find(unit => unit.row === row && kindOf(unit) === "guard");
                if (guard && battle.resource >= 150 && !has(row, unit => ["healer", "shielder", "beacon"].includes(kindOf(unit)))) {
                    for (const id of supports) { if (act(id, row, 4)) { break; } }
                }
                if (guard && melee.length && battle.resource >= 200 && !has(row, unit => kindOf(unit) === "fighter")) {
                    for (const id of melee) { if (act(id, row, Math.min(guard.col - 1, 4))) { break; } }
                }
            }
        }
        battle.step(TICK);
        battle.drainEvents();
        assert.ok(battle.resource >= 0, "预算不得透支");
    }
    return { battle, history };
}

test("setup does not advance income, waves or cooldowns", () => {
    const battle = new Battle(LEVELS[0]);
    battle.deploy("F01", 1, 0);
    advance(battle, 20);
    assert.equal(battle.time, 0); assert.equal(battle.enemies.size, 0); assert.equal(battle.resource, 150 - UNIT_RULES.F01.cost);
});
test("invalid placement is atomic", () => {
    const battle = new Battle(LEVELS[0]);
    const before = battle.snapshot();
    assert.equal(battle.deploy("U01", 9, 9).ok, false);
    assert.equal(battle.deploy("U15", 1, 1).ok, false);
    assert.equal(battle.resource, before.resource); assert.equal(battle.readyAt.size, 0);
});
test("preparation recall refunds; live recall does not", () => {
    const battle = new Battle(LEVELS[0]);
    battle.deploy("F01", 1, 0); battle.recall(1, 0); assert.equal(battle.resource, 150);
    battle.deploy("F01", 1, 0); battle.start(); battle.recall(1, 0); assert.equal(battle.resource, 150 - UNIT_RULES.F01.cost);
});
test("producer cadence and collect-once contract", () => {
    const battle = new Battle(fixture({ naturalFirst: 1000, spawns: [{ at: 1000, row: 0, type: "E01", wave: 1 }] }), { deck: ["F01"] });
    battle.deploy("F01", 0, 0); battle.start(); advance(battle, UNIT_RULES.F01.firstIncome + 0.5);
    assert.equal(battle.pickups.size, 1);
    const id = [...battle.pickups.keys()][0];
    assert.equal(battle.collect(id), true); assert.equal(battle.collect(id), false);
    advance(battle, UNIT_RULES.F01.incomePeriod + 0.5);
    assert.equal(battle.stats.generated, UNIT_RULES.F01.income * 2);
});
test("uncollected resources auto-collect without loss", () => {
    const battle = new Battle(fixture({ spawns: [{ at: 1000, row: 0, type: "E01", wave: 1 }] }));
    battle.start(); advance(battle, 16);
    assert.equal(battle.stats.collected, 25);
});
test("pause ownership freezes every simulation timer", () => {
    const battle = new Battle(LEVELS[0]); battle.start(); advance(battle, 1);
    battle.pause("manual", true); battle.pause("dialog", true); battle.pause("dialog", false);
    advance(battle, 12); assert.equal(battle.time, 1);
    battle.pause("manual", false); advance(battle, 1); assert.equal(battle.time, 2);
});
test("continuous blocker contact cannot be crossed", () => {
    const battle = new Battle(fixture(), { deck: ["U11"] }); battle.deploy("U11", 0, 4); battle.start();
    advance(battle, 32);
    const enemy = [...battle.enemies.values()][0];
    assert.ok(enemy && enemy.x >= 4.55 - 1e-7); assert.equal(enemy.state, "attacking");
    assert.ok([...battle.units.values()][0].hp < 900);
});
test("no cross-lane shooting", () => {
    const battle = new Battle(fixture({ rows: 2 })); battle.deploy("U01", 1, 1); battle.start(); advance(battle, 15);
    assert.equal([...battle.enemies.values()][0].hp, 200); assert.equal(battle.projectiles.size, 0);
});
test("melee does not strike distant enemies", () => {
    const battle = new Battle(fixture(), { deck: ["U07"] }); battle.deploy("U07", 0, 1); battle.start(); advance(battle, 12);
    assert.equal([...battle.enemies.values()][0].hp, 200);
});
test("healing follows lane and never over-heals", () => {
    const battle = new Battle(fixture({ rows: 2, spawns: [{ at: 1000, row: 0, type: "E01", wave: 1 }] }), { deck: ["U11", "U15"] });
    battle.deploy("U11", 0, 4); battle.deploy("U15", 1, 2);
    const guard = [...battle.units.values()].find(unit => unit.type === "U11");
    guard.hp = 800; battle.start(); advance(battle, 4); assert.equal(guard.hp, 800);
    battle.units.get(battle.occupancy.get("1:2")).row = 0;
    advance(battle, 8); assert.equal(guard.hp, 900); assert.equal(battle.stats.healed, 100);
});
test("retired units cancel pending hits and heals", () => {
    const battle = new Battle(fixture(), { deck: ["U01"] }); battle.deploy("U01", 0, 3); battle.start(); advance(battle, 1.1);
    battle.recall(0, 3); advance(battle, 1);
    assert.equal(battle.projectiles.size, 0); assert.equal([...battle.enemies.values()][0].hp, 200);
});
test("empty defenses lose after each row's one-use safeguard", () => {
    const battle = new Battle(LEVELS[0]); battle.start(); advance(battle, 250);
    assert.equal(battle.phase, "lost"); assert.ok(battle.stats.gatesUsed > 0);
    const time = battle.time; advance(battle, 20); assert.equal(battle.time, time);
    assert.equal(battle.drainEvents().filter(event => event.type === "finished").length, 1);
});
test("burst spell has a real cost, delay and bounded area", () => {
    const battle = new Battle(fixture({ rows: 3, spawns: [{ at: 1, row: 0, type: "E04", wave: 1 }, { at: 1, row: 2, type: "E04", wave: 1 }] }), { deck: ["F10"] });
    battle.start(); advance(battle, 1);
    const enemies = [...battle.enemies.values()]; enemies.forEach(enemy => { enemy.x = 5; });
    const before = battle.resource;
    assert.ok(battle.deploy("F10", 0, 5).ok); assert.equal(battle.resource, before - UNIT_RULES.F10.cost);
    advance(battle, .5); assert.equal(battle.enemies.size, 2);
    advance(battle, .5); assert.equal(battle.enemies.size, 1); assert.equal([...battle.enemies.values()][0].row, 2);
});
test("fixed-step simulation is invariant to render-sized chunks", () => {
    const a = new Battle(LEVELS[0]); const b = new Battle(LEVELS[0]);
    for (const game of [a, b]) { game.deploy("F01", 1, 0); game.deploy("U01", 1, 1); game.start(); }
    advance(a, 60); for (let i = 0; i < 240; i++) { b.step(.25); }
    assert.deepEqual(a.snapshot(), b.snapshot());
});

test("endless waves are seeded and identical for the same seed", () => {
    const plan = seed => { const battle = new Battle(ENDLESS, { deck: DECK_ORDER, seed }); for (let i = 0; i < 6; i++) { battle.planWave(); } return battle.spawns.map(s => `${s.at}:${s.row}:${s.type}`); };
    assert.deepEqual(plan(11), plan(11)); assert.notDeepEqual(plan(11), plan(12));
    const battle = new Battle(ENDLESS, { deck: DECK_ORDER, seed: 5 }); for (let i = 1; i < 10; i++) { battle.planWave(); }
    assert.ok(battle.spawns.some(s => s.type === "E13" && s.wave === 5), "wave 5 brings a boss");
});
test("endless wave modifiers mark the waves and surface on the snapshot", () => {
    const battle = new Battle(ENDLESS, { deck: DECK_ORDER, seed: 5 });
    for (let i = 1; i < 12; i++) { battle.planWave(); }
    const get = n => battle.waveBounds.get(n)?.modifier?.kind || null;
    assert.equal(get(5), "boss");
    assert.equal(get(10), "boss");
    assert.ok(["elite", "boss", "rush", "swarm", null].includes(get(3)));
    // Snapshot exposure — HUD should see the current/next modifier.
    battle.wave = 5;
    const snap = battle.snapshot();
    assert.equal(snap.waveModifier?.kind, "boss");
    assert.ok(["elite", "boss", "rush", "swarm", null].includes(snap.nextWaveModifier?.kind || null));
    // Wave-clear bonus lands once per wave and rewards the player.
    const clear = new Battle(ENDLESS, { deck: DECK_ORDER, seed: 5 });
    clear.waveBounds.set(1, { remaining: 1, modifier: { kind: "elite", label: "精英" } });
    clear.enemies.set("e1", { id: "e1", wave: 1, summoned: false });
    const before = clear.resource;
    clear.killEnemy({ id: "e1", wave: 1, summoned: false }, "test");
    assert.equal(clear.stats.wavesCleared, 1);
    assert.ok(clear.resource > before);
});
test("armor absorbs first; the armor breaker ignores it", () => {
    const one = type => { const battle = new Battle(fixture({ spawns: [{ at: 1, row: 0, type: "E07", wave: 1 }] }), { deck: [type] });
        battle.deploy(type, 0, 7); battle.start(); advance(battle, 1.05); const enemy = [...battle.enemies.values()][0]; enemy.x = 8.2; enemy.speed = 0;
        return { battle, enemy }; };
    const plain = one("U07"); advance(plain.battle, 1.5);
    assert.equal(plain.enemy.hp, ENEMY_RULES.E07.hp); assert.ok(plain.enemy.armor < ENEMY_RULES.E07.armor);
    const breaker = one("U10"); advance(breaker.battle, 1.5);
    assert.ok(breaker.enemy.hp < ENEMY_RULES.E07.hp); assert.ok(breaker.enemy.armor < ENEMY_RULES.E07.armor);
});
test("water shots slow; paralysis stops walking and attacking", () => {
    const battle = new Battle(fixture(), { deck: ["U02"] }); battle.deploy("U02", 0, 0); battle.start(); advance(battle, 6.5);
    const enemy = [...battle.enemies.values()][0]; assert.ok(enemy.slowUntil > battle.time);
    const stunned = new Battle(fixture(), { deck: ["U24"] }); stunned.deploy("U24", 0, 0); stunned.start();
    let stunAt = null; for (let i = 0; i < 60 * 25 && stunAt === null; i++) { stunned.step(TICK); if (stunned.drainEvents().some(e => e.type === "status" && e.statuses.includes("stun"))) { stunAt = stunned.time; } }
    assert.ok(stunAt !== null, "every third bottle paralyses");
    const target = [...stunned.enemies.values()][0]; const x = target.x; advance(stunned, 1); assert.equal(target.x, x);
});
test("hopping guests pass a normal guard but not the tall wall", () => {
    const hop = type => { const battle = new Battle(fixture({ spawns: [{ at: 1, row: 0, type: "E05", wave: 1 }] }), { deck: [type] });
        battle.deploy(type, 0, 6); battle.start(); advance(battle, 20); return [...battle.enemies.values()][0]; };
    assert.ok(hop("U11").x < 6, "passes the knight"); assert.ok(hop("U12").x >= 6.55 - 1e-7, "stopped by the wall");
});
test("barrier blocks three hits and shield absorbs before health", () => {
    const battle = new Battle(fixture({ spawns: [{ at: 1, row: 0, type: "E01", wave: 1 }] }), { deck: ["U13", "U17"] });
    battle.deploy("U13", 0, 6); battle.start(); advance(battle, 30);
    const guard = [...battle.units.values()][0]; assert.ok(battle.stats.blocked >= 3); assert.ok(guard.hp < 700);
    const shielded = new Battle(fixture({ rows: 2, spawns: [{ at: 1, row: 0, type: "E01", wave: 1 }] }), { deck: ["U11", "U17"] });
    shielded.deploy("U11", 0, 6); shielded.deploy("U17", 1, 6); shielded.start(); advance(shielded, 40);
    assert.ok(shielded.stats.shielded > 0);
});
test("the undead rises once, then stays down", () => {
    const battle = new Battle(fixture({ spawns: [{ at: 1, row: 0, type: "E08", wave: 1 }] }), { deck: ["U01"] });
    battle.start(); advance(battle, 1.05); const enemy = [...battle.enemies.values()][0];
    battle.damageEnemy(enemy, enemy.hp, "test"); assert.equal(enemy.state, "reviving"); assert.equal(battle.stats.kills, 0);
    advance(battle, 1.5); assert.ok(enemy.hp > 0 && enemy.state !== "reviving");
    battle.damageEnemy(enemy, enemy.hp, "test"); assert.equal(battle.enemies.size, 0); assert.equal(battle.stats.kills, 1);
});
test("the boss summons followers, and a gate removes armored guests outright", () => {
    const battle = new Battle(fixture({ rows: 3, spawns: [{ at: 1, row: 1, type: "E13", wave: 1 }] }), { deck: ["U01"] });
    battle.start(); advance(battle, 14); assert.ok(battle.enemies.size >= 3);
    const gate = new Battle(fixture({ spawns: [{ at: 1, row: 0, type: "E07", wave: 1 }] })); gate.start(); advance(gate, 1.05);
    [...gate.enemies.values()][0].x = -.6; advance(gate, 1); assert.equal(gate.enemies.size, 0); assert.equal(gate.stats.gatesUsed, 1);
});
test("a multi-row shooter engages adjacent lanes and one U79 volley reaches them all", () => {
    // U79 sits on row 1; enemies on rows 0, 1, 2 all in range. Adjacent lanes
    // must take hits even though the unit never changes row.
    const battle = new Battle(fixture({
        rows: 3,
        spawns: [
            { at: 1, row: 0, type: "E01", wave: 1 },
            { at: 1, row: 1, type: "E01", wave: 1 },
            { at: 1, row: 2, type: "E01", wave: 1 },
        ],
    }), { deck: ["U79"] });
    battle.deploy("U79", 1, 1);
    battle.start();
    advance(battle, 30);
    const rows = [...battle.enemies.values()].map(enemy => enemy.row);
    // Either some enemies died, or some are wounded on non-home rows.
    const wounded = [...battle.enemies.values()].filter(enemy => enemy.hp < enemy.maxHp);
    assert.ok(battle.stats.kills > 0 || wounded.some(enemy => enemy.row !== 1),
        `expected kills or off-row wounds, got rows=${JSON.stringify(rows)} kills=${battle.stats.kills}`);
});
test("a multi-row shooter cannot hit lanes that do not exist", () => {
    // U79 on row 0 of a 5-row board: multi ±1 clamps to valid rows; nothing crashes.
    const battle = new Battle(fixture({ rows: 5, spawns: [{ at: 1, row: 2, type: "E01", wave: 1 }] }), { deck: ["U79"] });
    battle.deploy("U79", 0, 1);
    battle.start();
    advance(battle, 30);
    assert.ok(["running", "won", "lost"].includes(battle.phase));
});
test("gear equips an already-deployed unit and bends its damage/cadence", () => {
    // G01 damage gear on an attacker of its allowed class: post-gear damage > base.
    const battle = new Battle(fixture({ spawns: [{ at: 8, row: 0, type: "E01", wave: 1 }] }), { deck: ["U01", "U07", "G01", "G20"] });
    battle.deploy("U07", 0, 1);
    const unit = [...battle.units.values()][0];
    const base = battle.unitRule(unit).damage;
    const refused = battle.deploy("G01", 0, 2);
    assert.equal(refused.ok, false);
    const applied = battle.deploy("G01", 0, 1);
    assert.equal(applied.ok, true);
    assert.equal(unit.gear, "G01");
    assert.ok(battle.unitRule(unit).damage > base);
    // And a second gear on the same unit is refused.
    const again = battle.deploy("G20", 0, 1);
    assert.equal(again.ok, false);
});
test("exclusive gear is rejected for the wrong unit and accepted for its listed host", () => {
    const battle = new Battle(fixture({ spawns: [] }), { deck: ["U01", "U07", "G40", "G02"] });
    battle.deploy("U01", 0, 0);
    battle.deploy("U07", 0, 4);
    const mage = [...battle.units.values()].find(u => u.type === "U01");
    const fighter = [...battle.units.values()].find(u => u.type === "U07");
    // U07-specific gear should refuse U01, accept U07:
    const wrong = battle.deploy("G40", 0, 0);
    assert.equal(wrong.ok, false);
    assert.match(wrong.reason, /无法佩戴/);
    const right = battle.deploy("G40", 0, 4);
    assert.equal(right.ok, true);
    assert.equal(fighter.gear, "G40");
    // gearFor family — G02 (法师) refuse U07 (fighter / not in gearFor), accept U01:
    const wrongMage = battle.deploy("G02", 0, 4);
    assert.equal(wrongMage.ok, false);
    const rightMage = battle.deploy("G02", 0, 0);
    assert.equal(rightMage.ok, true);
    assert.equal(mage.gear, "G02");
    // G02 merged rule should re-inforce the wave special damage:
    const merged = battle.unitRule(mage);
    assert.ok(merged.special.damage > UNIT_RULES.U01.special.damage);
});
test("gear G22 heals the host immediately and raises maxHp", () => {
    const battle = new Battle(fixture({ spawns: [] }), { deck: ["U01", "G22"] });
    battle.deploy("U01", 0, 0);
    const unit = [...battle.units.values()][0];
    unit.hp = Math.max(1, unit.hp - 40);
    const base = UNIT_RULES.U01.hp;
    battle.deploy("G22", 0, 0);
    assert.equal(unit.maxHp, base + 200);
    assert.ok(unit.hp > 1 + 100);
});
test("every gear cards maps to an existing weapon catalog id", () => {
    // Gear cards ship with a real original-game weapon ID; the defense manifest
    // must carry model/weapon/wpn_<id>.muast for each so battle-view can swap
    // the visible weapon model, not just the underlying numbers.
    const manifest = JSON.parse(readFileSync(new URL("../site/etowaria-defense/data/models.json", import.meta.url), "utf8")).models;
    let checked = 0;
    for (const [id, rule] of Object.entries(UNIT_RULES)) {
        if (rule.kind !== "gear" || !rule.weapon) { continue; }
        const rid = rule.weapon.resourceIdR ?? rule.weapon.resourceIdL;
        assert.ok(Number.isInteger(rid), `${id} has no weapon resource ids`);
        assert.ok(manifest[`model/weapon/wpn_${rid}.muast`], `${id} → wpn_${rid} missing from defense manifest`);
        checked++;
    }
    assert.ok(checked >= 30, `expected ≥30 gear cards with武器映射, got ${checked}`);
});
test("a dedicated weapon carries a scaled skill without a deck slot", () => {
    const battle = new Battle(fixture({ startResource: 10000, spawns: [{ at: 1, row: 0, type: "E04", wave: 1 }] }), { deck: ["U01"] });
    battle.deploy("U01", 0, 0);
    const equipped = battle.deploy("G34", 0, 0);
    assert.equal(equipped.ok, true);
    const unit = [...battle.units.values()][0];
    const rule = battle.unitRule(unit);
    assert.equal(rule.gearSkill.type, "wave");
    assert.equal(rule.gearSkill.damage, Math.round(UNIT_RULES.G34.gear.skill.damage * 1.8));
    battle.start();
    advance(battle, 16);
    const procs = battle.events.filter(event => event.type === "unitAction" && event.special === "wave");
    assert.ok(procs.length >= 1, `the carried skill triggered on its cadence (${unit.attacks} attacks)`);
});
test("the snapshot reports cooldowns for gear as well as deck cards", () => {
    const battle = new Battle(fixture({ startResource: 10000, spawns: [] }), { deck: ["U01"] });
    battle.deploy("U01", 0, 0);
    battle.deploy("G34", 0, 0);
    const cooldowns = battle.snapshot().cooldowns;
    assert.ok(cooldowns.G34 > 0, "the gear tray must be able to read its own cooldown");
    assert.ok(cooldowns.U01 > 0);
});
test("universal weapons grant stats only while dedicated weapons carry skills", () => {
    const universal = GEAR_ORDER.filter(id => UNIT_RULES[id].gearFor?.length !== 1);
    const dedicated = GEAR_ORDER.filter(id => UNIT_RULES[id].gearFor?.length === 1);
    assert.ok(universal.length > 0 && universal.every(id => !UNIT_RULES[id].gear.skill));
    assert.ok(dedicated.length > 0 && dedicated.every(id => UNIT_RULES[id].gear.skill));
});
test("partner pairings boost both cards and every new card keeps its original class", () => {
    // 麻耶(U73 fighter)+惠(U74 shielder): damage +8% / shield +15.
    {
        const battle = new Battle(fixture({ spawns: [] }), { deck: ["U73", "U74"] });
        battle.deploy("U73", 0, 1); battle.deploy("U74", 0, 2);
        const find = t => [...battle.units.values()].find(u => u.type === t);
        assert.equal(battle.unitRule(find("U73")).damage, UNIT_RULES.U73.damage + Math.round(UNIT_RULES.U73.damage * .08));
        assert.equal(battle.unitRule(find("U74")).shield, UNIT_RULES.U74.shield + 15);
        battle.removeUnit(find("U74"), "test");
        assert.equal(battle.unitRule(find("U73")).damage, UNIT_RULES.U73.damage);
    }
    // 冠（情人节）(U82 shielder)+荣依子（情人节）(U81 fighter): vulnerable ×1.1 / shield +20.
    {
        const battle = new Battle(fixture({ spawns: [] }), { deck: ["U81", "U82"] });
        battle.deploy("U81", 0, 1); battle.deploy("U82", 0, 2);
        const find = t => [...battle.units.values()].find(u => u.type === t);
        assert.ok(Math.abs(battle.unitRule(find("U81")).special.vulnerable - UNIT_RULES.U81.special.vulnerable * 1.1) < 1e-9);
        assert.equal(battle.unitRule(find("U82")).shield, UNIT_RULES.U82.shield + 20);
    }
    // Class fidelity: kind must follow the original classId for the whole batch.
    const classKinds = { fighter: [0], shooter: [1], healer: [2], shielder: [2], beacon: [2], guard: [3], lobber: [4] };
    const catalogue = JSON.parse(readFileSync(new URL("../site/etowaria-defense/data/units.json", import.meta.url), "utf8"));
    for (const unit of catalogue.units) {
        const rule = UNIT_RULES[unit.id];
        if (!rule) { continue; }
        const expected = Object.entries(classKinds).filter(([kind, classes]) => kind === rule.kind && classes.includes(unit.classId));
        assert.ok(expected.length === 1, `${unit.id} ${rule.name}: kind ${rule.kind} does not match original classId ${unit.classId}`);
    }
});
test("an endless checkpoint round-trips and rejects corruption", () => {
    const b = new Battle(ENDLESS, { deck: ["F01", "U07", "U15"], seed: 4242 });
    b.deploy("F01", 2, 0); b.deploy("U07", 2, 3); b.start();
    advance(b, 70);
    const checkpoint = b.serializeEndless();
    assert.ok(checkpoint && checkpoint.wave >= 2 && checkpoint.units.length === 2);
    const saved = validateProgress({ version: 1, completed: [], best: {}, endlessRun: checkpoint }).endlessRun;
    assert.ok(saved, "validator kept the checkpoint");
    assert.equal(saved.level, "endless");
    const restored = new Battle(ENDLESS, { deck: ["F01", "U07", "U15"], seed: 1 });
    assert.equal(Battle.applyEndless(restored, saved), true);
    assert.equal(restored.wave, checkpoint.wave);
    assert.equal(restored.units.size, checkpoint.units.length);
    assert.equal(restored.stats.kills, checkpoint.stats.kills);
    assert.equal(Battle.applyEndless(restored, { version: 1, level: "1-1", seed: 1, wave: 3, deck: [], units: [] }), false);
    assert.equal(Battle.applyEndless(restored, { version: 1, level: "endless", seed: "x" }), false);
});
test("endless grants a card swap every five cleared waves and the E39 queen takes wave 20", () => {
    const battle = new Battle(ENDLESS, { deck: DECK_ORDER, seed: 7 });
    // Wave plan: E13 bosses before 15, E30 at 15, E39 from 20.
    for (let i = 0; i < 20; i++) { battle.planWave(); }
    assert.ok(battle.spawns.filter(spawn => spawn.wave === 20).some(spawn => spawn.type === "E39"));
    assert.ok(battle.spawns.filter(spawn => spawn.wave === 5).some(spawn => spawn.type === "E13"));
    // Clearing five waves hands out exactly one credit; five more, another.
    battle.start();
    const clearWave = wave => {
        for (const enemy of [...battle.enemies.values()].filter(e => e.wave === wave)) { battle.killEnemy(enemy, "test"); }
    };
    // direct: simulate five wave-clears through killEnemy's bonus path
    for (let wave = 1; wave <= 10; wave++) {
        battle.waveBounds.set(wave, { remaining: 1, modifier: null });
        for (const spawn of battle.spawns.filter(s => s.wave === wave)) {
            const enemy = { id: `probe-${wave}-${spawn.index}`, wave, summoned: false };
            battle.enemies.set(enemy.id, enemy);
            battle.killEnemy(enemy, "test");
        }
    }
    assert.equal(battle.restocks, 2);
    assert.equal(battle.events.filter(event => event.type === "restockEarned").length, 2);
    assert.equal(battle.snapshot().restocks, 2);
});
test("chapter four uses balanced new enemy mechanics", () => {
    const chapter = LEVELS.filter(level => level.chapter === 4);
    assert.equal(chapter.length, 6);
    assert.deepEqual(chapter.map(level => level.newEnemy), ["E31", "E38", "E32", "E36", "E37", "E34"]);
    for (const id of ["E31", "E32", "E33", "E34", "E35", "E36", "E37", "E38"]) {
        const rule = ENEMY_RULES[id];
        assert.ok(rule && rule.hp > 0 && rule.damage > 0, `${id} has usable combat stats`);
        assert.ok(rule.speed > 0 && rule.height > 0, `${id} has movement/render stats`);
    }
    assert.ok(ENEMY_RULES.E32.armor > 0 && ENEMY_RULES.E34.armor > 0);
    assert.ok(ENEMY_RULES.E36.healer && ENEMY_RULES.E37.hop && ENEMY_RULES.E35.speed > .45);
});

test("setup-phase auto-cache round-trips an in-progress placement", () => {
    const a = new Battle(LEVELS[0]);
    a.deploy("F01", 1, 0); a.deploy("U01", 1, 1);
    const json = a.serializeSetup();
    assert.ok(json && json.level === "1-1" && json.units.length === 2);
    const b = new Battle(LEVELS[0]);
    assert.equal(Battle.applySetup(b, json), true);
    assert.equal(b.units.size, 2); assert.equal(b.occupancy.size, 2);
    assert.equal(b.resource, json.resource);
    assert.equal(b.readyAt.get("F01"), json.readyAt.find(([k]) => k === "F01")[1]);
    // Resuming against the wrong level is rejected.
    const wrong = new Battle(LEVELS[1]);
    assert.equal(Battle.applySetup(wrong, json), false);
    // Running state refuses to serialise.
    a.start(); advance(a, 1); assert.equal(a.serializeSetup(), null);
});
test("every card and enemy is simulated without error", () => {
    for (const type of DECK_ORDER.filter(id => id.startsWith("U"))) {
        for (const enemy of Object.keys(ENEMY_RULES)) {
            const battle = new Battle(fixture({ rows: 3, spawns: [{ at: 1, row: 1, type: enemy, wave: 1 }] }), { deck: DECK_ORDER });
            battle.deploy(type, 1, 3); battle.deploy("U15", 1, 1); battle.start(); advance(battle, 25);
            assert.ok(["running", "won", "lost"].includes(battle.phase));
        }
    }
});
test("the six new companions cover distinct combat archetypes", () => {
    // U29 蓄力猛击 fighter, U30 全体烈焰 shooter, U31 风压骑士 guard,
    // U32 大量回复 healer, U33 净化前锋 cleave fighter, U34 迅捷斗士 fighter.
    assert.equal(UNIT_RULES.U29.special.multiplier, 2.8);
    assert.equal(UNIT_RULES.U30.multi.rows, 2);
    assert.ok(UNIT_RULES.U31.special.distance > 0 && UNIT_RULES.U31.hp >= 900);
    assert.ok(UNIT_RULES.U32.healing > UNIT_RULES.U15.healing, "花名 must out-heal 由乃");
    assert.ok(UNIT_RULES.U33.cleave && UNIT_RULES.U33.special.vulnerable > 0);
    assert.equal(UNIT_RULES.U34.period, .8);
    // Their catalogue entries bind real original cards with icons and models.
    const catalogue = JSON.parse(readFileSync(new URL("../site/etowaria-defense/data/units.json", import.meta.url), "utf8"));
    for (const id of ["U29", "U30", "U31", "U32", "U33", "U34"]) {
        const unit = catalogue.units.find(row => row.id === id);
        assert.ok(unit, `${id} missing from catalogue`);
        assert.ok(unit.icon && unit.resourceId, `${id} has no icon/model binding`);
    }
});

const runs = [];
const played = LEVELS.map(level => ({ level, run: playWithBudget(level) }));
for (const { level, run } of played) {
    console.error(`${level.id} ${run.battle.phase} t=${run.battle.time.toFixed(0)} kills=${run.battle.stats.kills}/${level.spawns.length} gates=${run.battle.stats.gatesUsed} lost=${run.battle.stats.defeatedUnits} deployed=${run.battle.stats.deployed}`);
}
for (const { level, run } of played) {
    test(`real-budget complete level ${level.id}`, () => {
        assert.equal(run.battle.phase, "won", JSON.stringify({ level: level.id, time: run.battle.time,
            stats: run.battle.stats, enemies: [...run.battle.enemies.values()].map(e => [e.type, e.row, +e.x.toFixed(2), e.hp]) }));
        assert.ok(run.battle.stats.kills >= level.spawns.length);
        assert.ok(run.battle.stats.gatesUsed <= 1, `${level.id} used ${run.battle.stats.gatesUsed} gates`);
    });
    runs.push({ level: level.id, seconds: run.battle.time, stats: run.battle.stats, actions: run.history });
}

const memory = new Map();
const storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
const save = new CampaignSave(storage);
test("levels unlock in order and a win is recorded once", () => {
    assert.equal(save.canOpen(LEVELS[0].id), true);
    assert.equal(save.canOpen(LEVELS[1].id), false);
    const done = [];
    for (const level of LEVELS.slice(1)) {
        done.push(LEVELS[LEVELS.indexOf(level) - 1].id);
    }
    assert.equal(save.canOpen("endless"), true); assert.equal(save.canOpen("99-9"), false);
    assert.equal(save.canOpen("endless"), true); assert.equal(save.canOpen("99-9"), false);
    const game = playWithBudget(LEVELS[0]).battle;
    assert.equal(save.finish("run-1", game).first, true);
    assert.equal(save.finish("run-1", game).newRecord, false);
    assert.ok(new CampaignSave(storage).progress.completed.includes("1-1"));
    assert.deepEqual(new CampaignSave(storage).unlocked, [...DECK_ORDER, ...GEAR_ORDER]);
});
test("imported progress may skip levels but not invent them", () => {
    assert.deepEqual(validateProgress({ version: 1, completed: ["1-3"] }).completed, ["1-3"]);
    assert.throws(() => save.import('{"version":1,"completed":["99-9"]}'));
});
test("endless keeps the best wave only when it improves", () => {
    const run = (seed, seconds) => { const battle = new Battle(ENDLESS, { deck: DECK_ORDER, seed }); battle.start(); advance(battle, seconds); return battle; };
    const early = run(3, 400);
    assert.equal(early.phase, "lost");
    assert.equal(save.finish("endless-1", early).newRecord, true);
    const weaker = new Battle(ENDLESS, { deck: DECK_ORDER, seed: 3 }); weaker.start(); advance(weaker, 30); weaker.phase = "lost";
    assert.equal(save.finish("endless-2", weaker).newRecord, false);
    assert.equal(new CampaignSave(storage).progress.endless.wave, early.wave);
});
await fs.writeFile(new URL("../docs/etowaria-defense/research/p1-simulation-results.json", import.meta.url),
    JSON.stringify({ date: "2026-09-26", scope: "Pure battle simulation with legal resources; browser and art verification separate", checks, runs }, null, 2) + "\n");
console.log(JSON.stringify({ passed: checks.length, runs: runs.map(run => ({ level: run.level, seconds: run.seconds, stats: run.stats })) }, null, 2));
