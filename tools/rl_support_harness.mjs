// Enemy support module gate (2026-09-18): the decoded support rows actually
// cast — telegraph once, apply, never fire danmaku for it. Covers the heal
// cast, the half-line cap, the boss exclusion, the kind-19 exclusion and the
// no-wounded-ally negative case. Owns nothing beyond world/ai simulation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWorld } from "../site/game/rl/world.js";
import { createStats } from "../site/asset/rl/stats.js";
import { enemyMoveset } from "../site/game/rl/skills.js";
import { setAffixTable, affixTableFromPassives } from "../site/game/rl/equipment.js";
import { generateDungeon, doorsOf } from "../site/game/rl/dungeon.js";
import { hash32 } from "../site/game/rl/random.js";

let checks = 0;
function test(name, fn) { fn(); checks++; console.log("PASS " + name); }

const read = n => JSON.parse(readFileSync("site/asset/rl/" + n, "utf8"));
const weapons = read("weapons-rl.json");
setAffixTable(affixTableFromPassives(weapons.passives));
const stats = createStats({ cards: read("cards-rl.json").cards,
    growth: read("growth.json"), enemies: read("enemies.json").enemies });
const table = read("skills-rl.json");
const cards = read("cards-rl.json").cards;

function freshWorld() {
    const w = createWorld({ seed: 5, volume: 1, floor: 1, floorsPerVolume: 20,
        tables: { stats, skills: table, encounter: read("encounters.json").volumes[0] } });
    w.spawnPlayer({ card: cards.find(c => c.id === 22002001), level: 20, x: 8, y: 8 });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false,
        skill: [false, false, false], ultimate: false };
    const dungeon = generateDungeon(hash32("support-gate"), { roomsMin: 6, roomsMax: 9 });
    w.setDungeon(dungeon);
    const room = dungeon.rooms.find(r => r.type === "battle");
    w.enterRoom(room.id, doorsOf(dungeon, room.id)[0]?.side || null);
    w.setRoomColliders([]);
    w.enemies.length = 0;
    return w;
}

function drive(w, frames) {
    const seen = new WeakSet();
    const out = [];
    for (let i = 0; i < frames; i++) {
        w.update(1 / 60);
        for (const ev of w.drainEvents()) {
            if (seen.has(ev)) { continue; }
            seen.add(ev); out.push(ev);
        }
    }
    return out;
}

test("a wounded healer telegraphs and heals through the real dispatch", () => {
    const w = freshWorld();
    const moveset = enemyMoveset(table, [163001]);   // the in-play healer
    const e = w.spawnEnemy({ x: 12, y: 8, hp: 1000, atk: 10, mgc: 10, def: 5, mdef: 5,
        spd: 100, luck: 0, aiType: "sentry", moveset: moveset, model: null, nameZh: "测试" });
    e.hp = 400;   // below the half line
    const events = drive(w, 3600);
    assert.ok(events.some(ev => ev.type === "telegraph" && ev.unit === e && ev.support),
        "support telegraph fired");
    assert.ok(events.some(ev => ev.type === "enemySupport" && ev.kind === "heal" && ev.unit === e),
        "the heal applied");
    assert.ok(!events.some(ev => ev.type === "enemySkill" && ev.unit === e),
        "the support cast never fires danmaku");
});

test("a full-HP healer never wastes the slot", () => {
    const w = freshWorld();
    const moveset = enemyMoveset(table, [163001]);
    const e = w.spawnEnemy({ x: 12, y: 8, hp: 1000, atk: 10, mgc: 10, def: 5, mdef: 5,
        spd: 100, luck: 0, aiType: "sentry", moveset: moveset, model: null, nameZh: "测试" });
    const events = drive(w, 3600);
    assert.ok(!events.some(ev => ev.type === "enemySupport" && ev.unit === e),
        "nothing to heal -> no cast");
});

test("heals stop at the half line; the boss is never healed by a mob", () => {
    const w = freshWorld();
    const moveset = enemyMoveset(table, [163001]);
    const boss = w.spawnEnemy({ x: 12, y: 8, hp: 400000, atk: 10, mgc: 10, def: 5, mdef: 5,
        spd: 100, luck: 0, aiType: "boss", moveset: moveset, model: null, nameZh: "boss测试" });
    boss.kind = "boss";
    boss.hp = 100000;   // 25% of max: wounded
    const healer = w.spawnEnemy({ x: 14, y: 8, hp: 1000, atk: 10, mgc: 10, def: 5, mdef: 5,
        spd: 100, luck: 0, aiType: "sentry", moveset: moveset, model: null, nameZh: "测试" });
    healer.hp = 400;
    const events = drive(w, 3600);
    const bossHeals = events.filter(ev => ev.type === "enemySupport" && ev.unit === boss);
    assert.equal(bossHeals.length, 0, "a mob healer must not top up the boss");
    const selfHeals = events.filter(ev => ev.type === "enemySupport" && ev.unit === healer);
    assert.ok(selfHeals.length > 0, "the wounded mob heals");
    assert.equal(healer.hp, 500, "healed to exactly the half line (cap)");
});

test("a row carrying a turn-charge effect (kind 19) is never dispatched", () => {
    const w = freshWorld();
    // 19051 英国は不滅！: heal 50% + shield + charge — the charge part has no
    // gauge in this game, so the whole row stays undispatched.
    const moveset = enemyMoveset(table, [19051]);
    const e = w.spawnEnemy({ x: 12, y: 8, hp: 1000, atk: 10, mgc: 10, def: 5, mdef: 5,
        spd: 100, luck: 0, aiType: "sentry", moveset: moveset, model: null, nameZh: "测试" });
    e.hp = 200;
    const events = drive(w, 3600);
    assert.ok(!events.some(ev => ev.type === "enemySupport" && ev.unit === e),
        "kind-19-bearing rows stay undispatched");
});

console.log("Support: " + checks + " checks passed.");
