import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Battle } from "../site/etowaria-defense/sim/battle.js";
import { LEVELS, UNIT_RULES, TICK, unlockedUnits } from "../site/etowaria-defense/data/campaign.js";
import { CampaignSave, validateProgress } from "../site/etowaria-defense/app/campaign-save.js";

const checks = [];
const test = (name, run) => { run(); checks.push({ name, passed: true }); };
function advance(battle, seconds) {
    for (let time = 0; time < seconds - 1e-8; time += TICK) { battle.step(Math.min(TICK, seconds - time)); }
}
const fixture = overrides => ({ ...LEVELS[0], rows: 1, cols: 9, startResource: 1000,
    spawns: [{ at: 1, row: 0, type: "E01", wave: 1 }], ...overrides });

export function playWithBudget(level, completed = []) {
    const battle = new Battle(level, { deck: unlockedUnits(completed) });
    battle.deploy("F01", Math.floor(level.rows / 2), 0);
    battle.deploy("U01", Math.floor(level.rows / 2), 1);
    battle.start();
    const history = [];
    const act = (type, row, col) => {
        const result = battle.deploy(type, row, col);
        if (result.ok) { history.push({ time: battle.time, type, row, col, balance: battle.resource }); }
        return result.ok;
    };
    const order = [...new Set([Math.floor(level.rows / 2), 0, level.rows - 1, 1, 3].filter(row => row < level.rows))];
    let guardActions = 0;
    for (let frame = 0; frame < 600 * 60 && battle.phase === "running"; frame++) {
        battle.collectAll();
        if (frame % 15 === 0) {
            const units = [...battle.units.values()];
            const producers = units.filter(unit => unit.type === "F01");
            if (producers.length < 2 && battle.time < 35) {
                const row = order.find(row => !battle.occupancy.has(`${row}:0`));
                if (row !== undefined) { act("F01", row, 0); }
            }
            const missing = order.filter(row => ![...battle.units.values()].some(unit => unit.type === "U01" && unit.row === row));
            const threats = missing.filter(row => [...battle.enemies.values()].some(enemy => enemy.row === row));
            const row = threats[0] ?? missing[0];
            if (row !== undefined) { act("U01", row, 1); }
            const lanesCovered = order.every(lane => [...battle.units.values()].some(unit => unit.type === "U01" && unit.row === lane));
            if (battle.deck.has("U11") && lanesCovered) {
                const activeGuards = [...battle.units.values()].filter(unit => unit.type === "U11");
                const needsHealer = battle.deck.has("U15") && activeGuards.find(unit => !battle.occupancy.has(`${unit.row}:2`));
                if (needsHealer) { act("U15", needsHealer.row, 2); }
                const tanks = [...battle.enemies.values()].filter(enemy => enemy.type === "E04").sort((a, b) => a.x - b.x);
                for (const tank of tanks) {
                    if (!needsHealer && !battle.occupancy.has(`${tank.row}:4`) && tank.x > 4.8) {
                        if (act("U11", tank.row, 4)) { guardActions++; }
                    }
                    if (battle.deck.has("U15") && battle.occupancy.has(`${tank.row}:4`) && !battle.occupancy.has(`${tank.row}:2`)) {
                        act("U15", tank.row, 2);
                    }
                    if (!battle.deck.has("U15") && battle.deck.has("U07") && battle.occupancy.has(`${tank.row}:4`) && !battle.occupancy.has(`${tank.row}:3`)) {
                        act("U07", tank.row, 3);
                    }
                }
            }
        }
        battle.step(TICK);
        battle.drainEvents();
        assert.ok(battle.resource >= 0, "预算不得透支");
    }
    return { battle, history, guardActions };
}

test("setup does not advance income, waves or cooldowns", () => {
    const battle = new Battle(LEVELS[0]);
    battle.deploy("F01", 1, 0);
    advance(battle, 20);
    assert.equal(battle.time, 0); assert.equal(battle.enemies.size, 0); assert.equal(battle.resource, 100);
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
    battle.deploy("F01", 1, 0); battle.start(); battle.recall(1, 0); assert.equal(battle.resource, 100);
});
test("producer cadence and collect-once contract", () => {
    const battle = new Battle(fixture({ naturalFirst: 1000, spawns: [{ at: 1000, row: 0, type: "E01", wave: 1 }] }), { deck: ["F01"] });
    battle.deploy("F01", 0, 0); battle.start(); advance(battle, 12);
    assert.equal(battle.pickups.size, 1);
    const id = [...battle.pickups.keys()][0];
    assert.equal(battle.collect(id), true); assert.equal(battle.collect(id), false);
    advance(battle, 24); assert.equal(battle.stats.generated, 50);
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

const runs = [];
for (let index = 0; index < LEVELS.length; index++) {
    const completed = LEVELS.slice(0, index).map(level => level.id);
    const run = playWithBudget(LEVELS[index], completed);
    test(`real-budget complete level ${LEVELS[index].id}`, () => {
        assert.equal(run.battle.phase, "won", JSON.stringify({ level: LEVELS[index].id, time: run.battle.time,
            stats: run.battle.stats, enemies: [...run.battle.enemies.values()], actions: run.history }));
        assert.equal(run.battle.stats.kills, LEVELS[index].spawns.length);
        assert.equal(run.battle.stats.gatesUsed, 0);
    });
    runs.push({ level: LEVELS[index].id, seconds: run.battle.time, stats: run.battle.stats, actions: run.history });
}

const memory = new Map();
const storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
const save = new CampaignSave(storage);
test("progress unlocks only after a legitimate preceding win", () => {
    assert.equal(save.canOpen("1-2"), false);
    const game = playWithBudget(LEVELS[0]).battle;
    assert.deepEqual(save.finish("run-1", game), ["U11"]);
    assert.deepEqual(save.finish("run-1", game), []);
    assert.equal(save.canOpen("1-2"), true); assert.equal(save.canOpen("1-3"), false);
    assert.ok(new CampaignSave(storage).unlocked.includes("U11"));
});
test("corrupt and non-contiguous imported progress is rejected", () => {
    assert.throws(() => validateProgress({ version: 1, completed: ["1-3"] }));
    assert.throws(() => save.import('{"version":1,"completed":["99-9"]}'));
});

await fs.writeFile(new URL("../docs/etowaria-defense/research/p1-simulation-results.json", import.meta.url),
    JSON.stringify({ date: "2026-09-24", scope: "Pure battle simulation with legal resources; browser and art verification separate", checks, runs }, null, 2) + "\n");
console.log(JSON.stringify({ passed: checks.length, runs: runs.map(run => ({ level: run.level, seconds: run.seconds, stats: run.stats })) }, null, 2));
