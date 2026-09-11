import assert from "node:assert/strict";
import fs from "node:fs";
import { createSkills } from "../site/game/rl/skills.js";
import { createWorld } from "../site/game/rl/world.js";
const read = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));
const table = read("../site/asset/rl/skills-rl.json");
const cards = read("../site/asset/rl/cards-rl.json").cards;
const card = cards.find(row => row.id === 10002001);
const skills = createSkills({ table, card, maxHp: 1000 });
assert.equal(skills.ultimate?.id, 100020010, "evolved card uses its own original ultimate payload");
assert.equal(skills.ultimate.sceneId, "100004", "cinematic is taken from the skill row");
assert.equal(skills.slots[1].id, 100020001, "class slots retain their existing positions");
assert.equal(skills.use(0), null, "ultimate cannot be spent as a short-cooldown skill");
console.log("PASS original ultimate identity and slot ownership");

const stats = { statsFor: () => ({ hp: 1000, atk: 100, mgc: 200,
    def: 10, mdef: 10, spd: 100, luck: 0 }) };
function world(id) {
    const w = createWorld({ width: 30, height: 30, seed: 300908,
        tables: { stats, skills: table } });
    w.spawnPlayer({ card: cards.find(c => c.id === id), x: 15, y: 15, level: 1 });
    w.inputState = { move: { x: 0, y: 0 }, skill: [false,false,false], ultimate: false };
    w.player.skills.addGauge(w.player.skills.gaugeMax);
    return w;
}
function foe(w, x = 18, hp = 10000) {
    const e = w.spawnEnemy({ x, y: 15, hp, atk: 0, mgc: 0, def: 0, mdef: 0, luck: 0,
        element: w.player.element });
    e.actionTimer = 1e9;
    return e;
}
{
    const w = world(15000000), p = w.player;
    assert.equal(w.useUltimate(), false, "no enemy: enemy-only ultimate is not spent");
    assert.equal(p.skills.gauge, p.skills.gaugeMax);
    const a = foe(w), b = foe(w, 22);
    p.nextAtkBonus = .35;
    assert.equal(w.useUltimate().id, 150000000);
    assert.equal(a.hp, 10000 - 619, "original 2.38 coefficient at 100 attack, tempo 2.6");
    assert.equal(b.hp, 10000, "single enemy is the nearest target");
    assert.equal(p.nextAtkBonus, .35, "ultimate preserves next normal swing bonus");
    assert.equal(p.skills.gauge, 0);
    assert.equal(w.useUltimate(), false, "repeat acceptance cannot settle twice");
    assert.equal(w.events.filter(e => e.type === "hit" && e.ultimate).length, 1);
    console.log("PASS single-target damage, empty room, gauge and once-only settlement");
}
{
    const w = world(23001000), a = foe(w), b = foe(w, 22), p = w.player;
    p.nextAtkBonus = .5;
    const used = w.useUltimate();
    assert.equal(used.sceneId, "230001");
    assert.equal(a.hp, 10000 - 988);
    assert.equal(b.hp, 10000 - 988);
    assert.equal(p.nextAtkBonus, .5);
    assert.equal(w.danmaku.active, 0, "ultimate does not emit generic ring bullets");
    console.log("PASS all-target original magical payload");
}
{
    const w = world(10002001), p = w.player;
    p.hp = 100;
    assert.equal(w.useUltimate().id, 100020010);
    assert.equal(p.hp, 590, "original heal power 49 uses existing MaxHP adaptation");
    assert.equal(p.skills.statMult("def"), 1.2);
    assert.equal(w.events.filter(e => e.type === "hit").length, 0);
    console.log("PASS evolved healer heals and buffs without inventing damage");
}
{
    const w = world(46002000), e = foe(w), p = w.player;
    assert.equal(w.useUltimate().sceneId, "460001");
    assert.equal(p.skills.barrier.hits, 3);
    assert.equal(p.skills.barrier.cut, 1);
    assert.ok(e.hp < 10000);
    console.log("PASS Hitori uses scene 460001 with original damage and three-hit shield");
}
{
    const w = world(10002001), p = w.player;
    w.frozen = true;
    assert.equal(w.useUltimate(), false);
    w.frozen = false;
    p.dead = true;
    assert.equal(w.useUltimate(), false);
    assert.equal(p.skills.gauge, p.skills.gaugeMax);
    const missing = createSkills({table, card:{skillIds:{chara:999999999,class:[]}},maxHp:1000});
    missing.addGauge(missing.gaugeMax);
    assert.equal(missing.spendUltimate(), false);
    console.log("PASS frozen, dead and missing-data guards");
}
