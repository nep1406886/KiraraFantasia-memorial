import assert from "node:assert/strict";
import fs from "node:fs";
import { createWorld } from "../site/game/rl/world.js";
import { createDanmaku } from "../site/game/rl/danmaku.js";
const table = JSON.parse(fs.readFileSync(new URL("../site/asset/rl/skills-rl.json", import.meta.url)));
const card = JSON.parse(fs.readFileSync(new URL("../site/asset/rl/cards-rl.json", import.meta.url))).cards.find(c => c.id === 10002001);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("PASS " + name); }
function fresh() {
    const stats = { statsFor: () => ({ hp: 1000, atk: 100, mgc: 100, def: 10, mdef: 10, spd: 100, luck: 0 }) };
    const w = createWorld({ width: 40, height: 40, tables: { stats, skills: table } });
    w.spawnPlayer({ card, x: 20, y: 20 });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false, ultimate: false, skill: [false, false, false] };
    return w;
}
const tick = (w, n = 1) => { for (let i = 0; i < n; i++) w.update(1 / 60); };
const events = (w, type) => w.events.filter(e => e.type === type);
test("held dodge is one burst, a new press starts the next", () => {
    const w = fresh(); w.inputState.dodge = true; tick(w, 120);
    assert.equal(events(w, "dodge").length, 1);
    w.inputState.dodge = false; tick(w); w.inputState.dodge = true; tick(w);
    assert.equal(events(w, "dodge").length, 2);
});
test("short dodge input survives attack recovery, but cannot cancel startup", () => {
    const w = fresh(); w.inputState.attack = true; tick(w); w.inputState.attack = false; tick(w, 5);
    w.inputState.dodge = true; tick(w); w.inputState.dodge = false;
    assert.equal(w.player.sm.state, "attack"); tick(w, 8);
    assert.equal(w.player.sm.state, "dodge"); assert.equal(events(w, "dodge").length, 1);
});
test("skill pressed near recovery executes once after commitment", () => {
    const w = fresh(); w.inputState.attack = true; tick(w); w.inputState.attack = false; tick(w, 14);
    w.inputState.skill[1] = true; tick(w); w.inputState.skill[1] = false; tick(w, 16);
    assert.equal(events(w, "skill").length, 1); assert.equal(events(w, "skill")[0].slot, 1);
});
test("stale early inputs expire instead of unexpectedly casting later", () => {
    const w = fresh(); w.inputState.dodge = true; tick(w); w.inputState.dodge = false;
    w.inputState.skill[1] = true; tick(w); w.inputState.skill[1] = false; tick(w, 60);
    assert.equal(events(w, "skill").length, 0);
});
test("hit-stop buffers input; a paused menu discards it", () => {
    const w = fresh(); w.applyHitStop(.08); w.inputState.dodge = true; tick(w);
    w.inputState.dodge = false; tick(w, 12); assert.equal(events(w, "dodge").length, 1);
    tick(w, 40); w.frozen = true; w.inputState.dodge = true; tick(w); w.inputState.dodge = false; tick(w);
    w.frozen = false; tick(w, 40); assert.equal(events(w, "dodge").length, 1);
});
const enemy = (id, x, y = 5) => ({ id, x, y, radius: .45, dead: false, iframes: 0 });
function shot(dm, mods = {}) { dm.emit("aimed", { x: 0, y: 5, angle: 0 }, { offset: 0, side: "player", radius: .1, speed: 100, ...mods }); }
test("swept bullets hit the nearest body rather than spawn order", () => {
    const dm = createDanmaku(); const hits = []; shot(dm);
    dm.update(.1, { enemies: [enemy(2, 8), enemy(1, 3)], onHit: (b, e) => hits.push(e.id) });
    assert.deepEqual(hits, [1]); assert.equal(dm.active, 0);
});
test("piercing order and dedupe remain correct across several frames", () => {
    const dm = createDanmaku(); const hits = []; shot(dm, { pierce: 2 });
    const ctx = { enemies: [enemy(3, 9), enemy(1, 3), enemy(2, 6)], onHit: (b, e) => hits.push(e.id) };
    dm.update(.07, ctx); dm.update(.04, ctx);
    assert.deepEqual(hits, [1, 2, 3]); assert.equal(dm.active, 0);
});
test("recycled non-piercing bullet has no stale target blacklist", () => {
    const dm = createDanmaku({ capacity: 1 }); const hits = [];
    const ctx = { enemies: [enemy(1, 3)], onHit: (b, e) => hits.push(e.id) };
    shot(dm, { pierce: 1 }); dm.update(.04, ctx); dm.clear(); shot(dm); dm.update(.04, ctx);
    assert.deepEqual(hits, [1, 1]);
});
test("relative sweep catches moving bodies, invulnerability still wins", () => {
    const dm = createDanmaku(); const p = enemy(1, 0, 8); const hits = [];
    shot(dm, { side: "enemy", speed: 0 });
    const ctx = { player: p, previousPosition: () => ({ x: 0, y: 2 }), onHit: () => hits.push(1) };
    p.iframes = .1; dm.update(.1, ctx); assert.equal(hits.length, 0); assert.equal(dm.active, 1);
    p.iframes = 0; dm.update(.1, ctx); assert.equal(hits.length, 1);
});
test("last live segment can hit, but not beyond lifetime", () => {
    const dm = createDanmaku(); const hits = []; shot(dm, { life: .05 });
    dm.update(.2, { enemies: [enemy(1, 3), enemy(2, 9)], onHit: (b, e) => hits.push(e.id) });
    assert.deepEqual(hits, [1]); assert.equal(dm.active, 0);
});
console.log(passed + " action feel checks passed");
