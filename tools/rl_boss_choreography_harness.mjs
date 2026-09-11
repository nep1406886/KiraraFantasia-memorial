// Ground commitments use the real world hit funnel. Fixtures isolate geometry
// and input timing; they are not player win-rate measurements.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWorld } from "../site/game/rl/world.js";
import { createStateMachine } from "../site/game/rl/actorstate.js";
import { enemyMoveset } from "../site/game/rl/skills.js";
import { ENEMY_ROLES, enemyRole } from "../site/game/rl/enemyroles.js";
import { CHOREOGRAPHY_STATES, PHASE_RECOVERY, SPECIAL_THREAT_LIMIT,
    inEnemyArea, updateEnemyAction } from "../site/game/rl/enemyactions.js";
import { stopCircle, circleOverlapsRect } from "../site/game/rl/geometry.js";
import { loadMeasurementData, createMeasurementWorld } from "./rl_world_balance.mjs";

const DT = 1 / 60, data = loadMeasurementData();
const facts = JSON.parse(readFileSync(new URL("../docs/enemy-choreography-source.json", import.meta.url), "utf8"));
const specs = new Map(data.encounters.flatMap(v => [v.boss, ...v.elites, ...v.mobs]).map(s => [s.id, s]));
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); }
}
function near(a, b, eps = 1e-5) { assert.ok(Math.abs(a - b) < eps, a + " != " + b); }
function tick(w, count = 1) {
    const events = [];
    for (let i = 0; i < count; i++) { w.update(DT); events.push(...w.drainEvents()); }
    return events;
}
function until(w, done, seconds = 10) {
    const events = [];
    for (let i = 0; i < Math.ceil(seconds / DT) && !done(); i++) { events.push(...tick(w)); }
    assert.ok(done(), "condition did not become true in " + seconds + "s");
    return events;
}
function fixture(id = 99038006, key = null, options = {}) {
    const w = createWorld({ seed: 17, width: 32, height: 28 });
    const p = w.spawnPlayer({ x: 13.2, y: 12, hp: 1000000, atk: 100, def: 0, mdef: 0 });
    const spec = specs.get(id);
    const e = w.spawnEnemy({ enemyId: id, aiType: "boss", elite: !!options.elite,
        x: 10, y: 12, radius: .5, hp: 1000000, atk: 120, mgc: 120, def: 0, mdef: 0,
        spd: 100, luck: 0, moveset: enemyMoveset(data.skills, spec.skills), ...options });
    assert.ok(e.choreography, "spawn must bind its owner's choreography");
    if (key) { e.choreography = { ...e.choreography, rotations: [[key]] }; }
    e.actionTimer = 0;
    w.drainEvents();
    return { w, p, e };
}
function begin(f) { const events = tick(f.w); assert.equal(f.e.action?.stage, "windup"); return events; }
function playerBullet(f, power) {
    f.w.danmaku.emit("aimed", { x: f.e.x, y: f.e.y, angle: 0 }, {
        side: "player", srcId: f.p.id, power, coef: 1, speed: 0, offset: 0, life: 1, radius: .1
    });
}
const playerHits = events => events.filter(e => e.type === "hit" && e.target.kind === "player");

test("16份编排只绑定自身真实技能，原系数、物魔位与SAP不被改写", () => {
    assert.equal(Object.keys(ENEMY_ROLES).length, 16);
    for (const [id, authored] of Object.entries(ENEMY_ROLES)) {
        const spec = specs.get(Number(id)); assert.ok(spec, id);
        const moveset = enemyMoveset(data.skills, spec.skills), role = enemyRole(id, moveset);
        assert.equal(role.moves.length, authored.moves.length, id);
        for (const move of role.moves) {
            const raw = data.skills.enemy[move.skillId];
            const owner = facts.rows.find(row => row.enemyId === Number(id));
            const source = owner.skills.find(row => row.skillId === move.skillId);
            const damage = source.content.find(row => row.m_Type === 0);
            assert.ok(owner.ownerSkillIds.includes(move.skillId));
            assert.equal(move.skill.coef, damage.m_Args[0] / 1000);
            assert.equal(move.skill.magic, !!damage.m_Args[1]); assert.equal(move.skill.sap, source.sap);
            assert.ok(spec.skills.includes(move.skillId));
            assert.equal(move.skill, moveset.attacks.find(s => s.id === move.skillId));
            assert.equal(move.skill.coef, raw.coef); assert.equal(move.skill.magic, !!raw.magic);
            assert.equal(move.skill.sap, raw.sap || "");
            assert.ok(move.warning >= .8 && move.active > 0 && move.recovery >= .8);
            assert.ok(move.counter && move.label);
        }
        for (const rotation of role.rotations) {
            assert.ok(rotation.length);
            assert.ok(rotation.every(key => role.moves.some(move => move.key === key)));
        }
    }
    assert.equal(enemyRole(0, { attacks: [] }), null);
    assert.equal(enemyRole(99038006, { attacks: [] }), null);
});
test("不完整技能表不会留下空阶段或借用其他敌人的技能", () => {
    const spec = specs.get(99038006), set = enemyMoveset(data.skills, spec.skills);
    const only = set.attacks.find(s => s.id === 38003);
    const role = enemyRole(99038006, { attacks: [only] });
    assert.equal(role.moves.length, 1);
    assert.ok(role.rotations.every(keys => keys.length && keys.every(key => key === "eye")));
    assert.equal(enemyRole(99038006, enemyMoveset(data.skills, specs.get(99248003).skills)), null);
});
test("圆、环、扇形与圆端通道在八方向使用真实身体边缘", () => {
    for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4, c = Math.cos(angle), s = Math.sin(angle);
        const body = (x, y, radius = .4) => ({ x: 10 + x * c - y * s, y: 10 + x * s + y * c, radius });
        const sector = { kind: "sector", x: 10, y: 10, angle, radius: 4, arc: Math.PI / 2 };
        assert.ok(inEnemyArea(sector, body(4.39, 0)));
        assert.ok(!inEnemyArea(sector, body(4.41, 0)));
        assert.ok(inEnemyArea(sector, body(2 * Math.cos(Math.PI / 4 + .15), 2 * Math.sin(Math.PI / 4 + .15))));
        assert.ok(!inEnemyArea(sector, body(2 * Math.cos(Math.PI / 4 + .3), 2 * Math.sin(Math.PI / 4 + .3))));
        assert.ok(inEnemyArea(sector, body(-.3, 0)));
        assert.ok(!inEnemyArea(sector, body(-.5, 0)));
        const ring = { kind: "annulus", x: 10, y: 10, inner: 2, outer: 4 };
        assert.ok(!inEnemyArea(ring, body(1.59, 0))); assert.ok(inEnemyArea(ring, body(1.61, 0)));
        assert.ok(inEnemyArea(ring, body(4.39, 0))); assert.ok(!inEnemyArea(ring, body(4.41, 0)));
        const disc = { kind: "disc", x: 10, y: 10, radius: 2 };
        assert.ok(inEnemyArea(disc, body(2.39, 0))); assert.ok(!inEnemyArea(disc, body(2.41, 0)));
        const lane = { kind: "lane", x1: 10, y1: 10, x2: 10 + c * 4, y2: 10 + s * 4, radius: .5 };
        assert.ok(inEnemyArea(lane, body(4.75, .4)));
        assert.ok(!inEnemyArea(lane, body(4.85, .4)), "round end, not expanded rectangle");
        assert.ok(inEnemyArea(lane, body(2, .89))); assert.ok(!inEnemyArea(lane, body(2, .91)));
    }
});
test("冲刺八向扫掠在细柱与圆角前截停，绝不沿墙滑移", () => {
    for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, dx = Math.cos(a), dy = Math.sin(a);
        const wall = { x: 10 + 5 * dx, y: 10 + 5 * dy, hw: .1, hh: .1 };
        const end = stopCircle({ x: 10, y: 10, radius: .5 }, 10 * dx, 10 * dy, [wall]);
        const expected = 5 - .5 - .1 * (i % 2 ? Math.SQRT2 : 1);
        near(Math.hypot(end.x - 10, end.y - 10), expected);
        near((end.x - 10) * dy - (end.y - 10) * dx, 0);
        assert.ok(!circleOverlapsRect(end.x, end.y, .5, wall));
    }
    const bounds = { minX: .5, minY: .5, maxX: 9.5, maxY: 9.5 };
    const end = stopCircle({ x: 8, y: 8, radius: .5 }, 3, 1.5, [], bounds);
    near(end.x, 9.5); near(end.y, 8.75);
    const invalid = { x: 5, y: 5, radius: .5 };
    assert.deepEqual(stopCircle(invalid, 3, 1, [{ x: 5, y: 5, hw: 1, hh: 1 }], bounds), { x: 5, y: 5 });
    assert.deepEqual(stopCircle({ x: -1, y: 5, radius: .5 }, 3, 1, [], bounds), { x: -1, y: 5 });
});
test("真实五卷第20层入口接入主首领，层守卫不是三阶段复制", () => {
    for (let volume = 1; volume <= 5; volume++) {
        const w = createMeasurementWorld({ cardId: 14002001, volume, mode: "boss", floor: 20 }).world;
        assert.ok(w.enemies[0].choreography, "volume " + volume);
        assert.equal(w.enemies[0].kind, "boss");
    }
    for (const id of Object.keys(ENEMY_ROLES).map(Number).filter(id => !data.encounters.some(v => v.boss.id === id))) {
        const f = fixture(id, null, { elite: true }); f.e.hp = f.e.maxHp * .2;
        const events = tick(f.w);
        assert.equal(f.e.phase, 1); assert.ok(!events.some(e => e.type === "bossPhase"));
        assert.equal(f.e.choreography.rotations.length, 1);
    }
});
test("全部编排按自身阶段序列执行，不只核对目录存在", () => {
    for (const id of Object.keys(ENEMY_ROLES).map(Number)) {
        const boss = data.encounters.some(v => v.boss.id === id);
        for (let phase = 1; phase <= (boss ? 3 : 1); phase++) {
            const f = fixture(id, null, { elite: !boss });
            f.e.phase = phase; f.e.hp = f.e.maxHp * [1, .65, .35][phase - 1];
            const role = f.e.choreography, rotation = role.rotations[phase - 1];
            const seen = [];
            for (let frame = 0; frame < 3000 && seen.length < rotation.length * 2; frame++) {
                for (const event of tick(f.w)) { if (event.type === "telegraph") { seen.push(event.skill.id); } }
            }
            const expected = rotation.concat(rotation).map(key => role.moves.find(move => move.key === key).skillId);
            assert.deepEqual(seen, expected, id + " phase " + phase);
        }
    }
});
test("没有专属目录的敌人与无表样本仍走原有AI", () => {
    const w = createWorld({ seed: 17 }); w.spawnPlayer({ x: 4, y: 6, hp: 10000 });
    const e = w.spawnEnemy({ x: 8, y: 6, aiType: "sentry", atk: 10,
        moveset: { attacks: [{ id: 1, coef: 1, magic: false, pattern: "aimed" }] } });
    e.actionTimer = 0; tick(w); assert.equal(e.choreography, null);
    assert.equal(e.sm.state, "telegraph"); tick(w, 43);
    assert.ok(w.danmaku.active > 0);
});
test("完整预警期间零伤害，区域锁定且不可变，静止者执行期只中一次", () => {
    const f = fixture(99038006, "claw"), { w, e, p } = f;
    const initial = p.hp, events = begin(f), action = e.action, snapshot = JSON.stringify(action.shapes);
    assert.ok(Object.isFrozen(action.shapes) && action.shapes.every(Object.isFrozen));
    assert.equal(events[0].duration, action.move.warning);
    let elapsed = 0;
    while (e.action.stage === "windup") { assert.equal(p.hp, initial); tick(w); elapsed += DT; }
    assert.ok(elapsed + 1e-8 >= action.move.warning); assert.equal(p.hp, initial);
    const hits = until(w, () => e.action?.stage === "recover");
    assert.equal(playerHits(hits).length, 1); assert.ok(p.hp < initial);
    assert.equal(JSON.stringify(action.shapes), snapshot);
    assert.equal(w.danmaku.active, 0);
});
test("正常行走可离开锁定落点，提示不追踪玩家新位置", () => {
    const f = fixture(99248003, "spice"); begin(f);
    const shapes = JSON.stringify(f.e.action.shapes), hp = f.p.hp;
    f.w.inputState = { move: { x: 1, y: 0 } };
    until(f.w, () => f.e.action?.stage === "recover");
    assert.ok(f.p.x > 16); assert.equal(f.p.hp, hp);
    assert.equal(JSON.stringify(f.e.action.shapes), shapes);
});
test("正常横移可避开锁定的冲刺路径", () => {
    const f = fixture(99038006, "dive"); begin(f);
    const path = f.e.action.shapes[0], hp = f.p.hp;
    f.w.inputState = { move: { x: 0, y: 1 } };
    until(f.w, () => f.e.action?.stage === "recover");
    near(f.e.y, path.y2); assert.ok(f.p.y > 15); assert.equal(f.p.hp, hp);
});
test("正常闪避输入的无敌帧阻断整个短执行窗口", () => {
    const f = fixture(99038006, "claw"); begin(f);
    // Deliberately stay inside the sector even after the dodge displacement.
    f.p.x = f.e.x; f.p.y = f.e.y;
    until(f.w, () => f.e.action?.stage === "active");
    const hp = f.p.hp;
    f.w.inputState = { move: { x: 1, y: 0 }, dodge: true };
    const first = tick(f.w); assert.equal(f.p.sm.state, "dodge");
    f.w.inputState.dodge = false;
    const rest = until(f.w, () => f.e.action?.stage === "recover");
    assert.equal(playerHits([...first, ...rest]).length, 0); assert.equal(f.p.hp, hp);
});
test("已承诺冲刺实际路径与预警相同，被击退也不会侧滑，单招至多一次命中", () => {
    const f = fixture(99038006, "dive"), { w, e, p } = f;
    w.setRoomColliders([{ x: 15, y: 12, hw: .05, hh: 2 }]); begin(f);
    const path = e.action.shapes[0]; assert.ok(path.x2 < 14.46);
    const events = [];
    until(w, () => e.action?.stage === "active");
    while (e.action.stage === "active") {
        e.kx = 30; e.ky = 30; p.iframes = 0;
        events.push(...tick(w)); near(e.y, path.y1); assert.ok(e.x <= path.x2 + 1e-6);
    }
    near(e.x, path.x2); assert.equal(playerHits(events).length, 1);
});
test("相对扫掠能命中执行期中途横穿路径的玩家", () => {
    const f = fixture(99038006, "dive"); begin(f);
    until(f.w, () => f.e.action?.stage === "active");
    const a = f.e.action, path = a.shapes[0];
    a.previousPlayer = { x: 11.5, y: 10 }; f.p.x = 11.5; f.p.y = 14;
    // Direct fixed-world action tick isolates the continuous two-body crossing.
    updateEnemyAction(f.e, f.w, .42, [.7, .4]);
    assert.ok(playerHits(f.w.drainEvents()).length === 1);
    near(f.e.x, path.x2);
});
test("恢复窗口至少0.8秒，贴身反击不触发隐形接触伤害", () => {
    const f = fixture(99038006, "claw"); begin(f);
    until(f.w, () => f.e.action?.stage === "recover");
    const action = f.e.action, hp = f.p.hp;
    f.p.x = f.e.x; f.p.y = f.e.y; f.p.iframes = 0;
    assert.ok(action.recovery >= .8);
    const events = tick(f.w, Math.floor(.8 / DT));
    assert.equal(f.e.action, action); assert.equal(f.e.action.stage, "recover");
    assert.equal(playerHits(events).length, 0); assert.equal(f.p.hp, hp);
    until(f.w, () => f.e.action === null);
    assert.equal(f.e.sm.state, "idle");
});
test("五卷切阶段先取消旧招式并恢复，不同帧环弹、召援或伤害", () => {
    for (const volume of data.encounters) {
        const f = fixture(volume.boss.id); begin(f);
        f.e.hp = f.e.maxHp * .69;
        const hp = f.p.hp, events = tick(f.w);
        assert.equal(f.e.phase, 2); assert.equal(f.e.action, null);
        assert.equal(f.e.recoveryWindow, PHASE_RECOVERY);
        assert.equal(f.p.hp, hp); assert.equal(f.w.danmaku.active, 0);
        assert.deepEqual(events.map(e => e.type), ["bossPhase"]);
        tick(f.w, 60); assert.equal(f.e.action, null);
        until(f.w, () => f.e.action?.stage === "windup");
        until(f.w, () => f.e.action?.stage === "active");
        f.e.hp = f.e.maxHp * .39;
        assert.deepEqual(tick(f.w).map(e => e.type), ["bossPhase"]);
        assert.equal(f.e.phase, 3); assert.equal(f.e.action, null);
    }
});
test("眩晕通过真实玩家弹体打断承诺，眩晕结束也不会补发旧招式", () => {
    const f = fixture(99038006, "dive"); begin(f); const old = f.e.action;
    f.e.stun = 99; playerBullet(f, 10);
    const events = tick(f.w);
    assert.ok(events.some(e => e.type === "stun")); assert.ok(f.e.stunTimer > 0);
    assert.equal(f.e.action, null); assert.equal(f.e.pending, null); assert.equal(f.e.dash, null);
    until(f.w, () => f.e.stunTimer === 0, 4);
    tick(f.w, 40); assert.equal(f.e.action, null);
    until(f.w, () => f.e.action?.stage === "windup"); assert.notEqual(f.e.action, old);
});
test("死亡经统一命中立即清除承诺，没有死亡后残留地面伤害", () => {
    const f = fixture(99038006, "dive"); begin(f); playerBullet(f, 10000000);
    tick(f.w); assert.ok(f.e.dead); assert.equal(f.e.action, null);
    assert.equal(f.e.pending, null); assert.equal(f.e.recoveryWindow, 0);
    const hp = f.p.hp; tick(f.w, 90); assert.equal(f.p.hp, hp);
});
test("晚到的房间碰撞取消旧路径，不能穿过新障碍或隐式瞬移", () => {
    const f = fixture(99038006, "dive"); begin(f);
    const x = f.e.x, y = f.e.y;
    f.w.setRoomColliders([{ x: 11, y: 12, hw: .05, hh: 1 }]);
    assert.equal(f.e.action, null); assert.ok(f.e.recoveryWindow >= .8);
    near(f.e.x, x); near(f.e.y, y);
    until(f.w, () => f.e.action?.stage === "windup");
    assert.ok(f.e.action.shapes[0].x2 < 10.46);
});
test("离房取消旧动作，当前世界拒绝迟到或死亡攻击者的命中", () => {
    const { world: w } = createMeasurementWorld({ cardId: 14002001, volume: 1, mode: "boss" });
    const e = w.enemies[0]; e.actionTimer = 0;
    until(w, () => e.action?.stage === "windup");
    const skill = e.action.move.skill, hp = w.player.hp;
    w.enterRoom(w.dungeon.start);
    assert.equal(e.action, null); assert.equal(w.hitPlayerFrom(e, skill).hit, false);
    assert.equal(w.player.hp, hp);
    const current = w.spawnEnemy({ enemyId: 99038006, x: 5, y: 5,
        moveset: enemyMoveset(data.skills, specs.get(99038006).skills) });
    current.dead = true;
    assert.equal(w.hitPlayerFrom(current, skill).hit, false);
});
test("新入口保留屏障、濒死被动及受击事件，而非直接扣血", () => {
    const f = fixture(), { w, p, e } = f;
    let absorbed = 0;
    p.skills = { absorb(damage) { absorbed++; return damage / 2; } };
    const move = e.choreography.moves[0], hp = p.hp;
    let result = w.hitPlayerFrom(e, move.skill, { enemyAction: move.key });
    assert.ok(result.hit && result.damage > 0); assert.equal(absorbed, 1);
    assert.equal(hp - p.hp, result.damage);
    let events = w.drainEvents(); assert.equal(playerHits(events).length, 1);
    assert.equal(playerHits(events)[0].enemyAction, move.key);
    p.iframes = 0; p.hp = 1; p.passives.survival = 1;
    result = w.hitPlayerFrom(e, move.skill);
    events = w.drainEvents(); assert.ok(result.hit && !result.died && !p.dead);
    assert.equal(p.hp, p.maxHp); assert.ok(events.some(event => event.type === "survival"));
});
test("终章落点保留自身原作治疗封锁，闪避仍阻断状态附加", () => {
    const f = fixture(90238005, "verdict"); begin(f);
    const events = until(f.w, () => f.e.action?.stage === "recover");
    assert.ok(f.p.healingLock > 5);
    const status = events.find(e => e.type === "playerStatus");
    assert.equal(status.action, "applied"); assert.equal(status.remaining, 5.6);
    const blocked = fixture(90238005, "verdict"); begin(blocked);
    until(blocked.w, () => blocked.e.action?.stage === "active");
    blocked.w.inputState = { move: { x: 1, y: 0 }, dodge: true };
    tick(blocked.w); blocked.w.inputState.dodge = false;
    until(blocked.w, () => blocked.e.action?.stage === "recover");
    assert.equal(blocked.p.healingLock || 0, 0);
});
test("真实角色受新区域攻击的伤害只给一次量能", () => {
    const w = createMeasurementWorld({ cardId: 14002001, level: 80, volume: 1, mode: "boss" }).world;
    const p = w.player, e = w.enemies[0], hp = p.hp;
    p.x = e.x - 3.2; p.y = e.y; e.actionTimer = 0;
    const events = until(w, () => p.hp < hp);
    const hits = playerHits(events); assert.equal(hits.length, 1);
    assert.equal(p.skills.gauge, Math.min(p.skills.gaugeMax,
        hits[0].damage * p.passives.gaugeMult + p.skills.gaugeMax * p.passives.gaugeOnHit));
    assert.ok(p.skills.gauge > 0);
});
test("六个特殊敌人的威胁上限为二，轮转不会令后排饥饿", () => {
    const skill = enemyMoveset(data.skills, specs.get(99619003).skills).attacks.find(s => s.id === 19052);
    const move = { key: "test", kind: "line", skill, label: "fixture", counter: "fixture",
        warning: .8, active: .18, recovery: .8, range: 12, radius: .55 };
    const w = { width: 32, height: 28, player: { x: 16, y: 12, radius: .4 }, enemies: [], events: [],
        roomColliders: [], enemyActionCursor: 4, hitPlayerFrom: () => ({ hit: false }) };
    for (let i = 0; i < 6; i++) { w.enemies.push({ id: i, kind: "enemy", x: i + 1, y: 5,
        radius: .5, spd: 100, stunTimer: 0, dead: false, phase: 1, actionTimer: 0,
        choreography: { moves: [move], rotations: [["test"]] }, choreographyCursor: 0,
        action: null, recoveryWindow: 0, sm: createStateMachine("idle", CHOREOGRAPHY_STATES) }); }
    const starts = [], counts = new Array(6).fill(0);
    for (let frame = 0; frame < 1800; frame++) {
        for (const e of w.enemies) { e.sm.update(DT); updateEnemyAction(e, w, DT, [.7, .4]); }
        const busy = w.enemies.filter(e => e.action && ["windup", "active"].includes(e.action.stage));
        assert.ok(busy.length <= SPECIAL_THREAT_LIMIT);
        for (const event of w.events.splice(0)) { if (event.type === "telegraph") {
            starts.push(event.unit.id); counts[event.unit.id]++;
        } }
    }
    assert.deepEqual(starts.slice(0, 6), [4, 5, 0, 1, 2, 3]);
    assert.ok(Math.min(...counts) >= 5); assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, counts.join(","));
});
console.log("Boss choreography: " + passed + " passed, " + failed + " failed");
if (failed) { process.exitCode = 1; }
