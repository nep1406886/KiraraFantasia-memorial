import assert from 'node:assert/strict';
import { createWorld } from '../site/game/rl/world.js';
import { setAffixTable } from '../site/game/rl/equipment.js';
import { setAffixPool } from '../site/game/rl/loot.js';
import { buildRunPayload, parseRunSnapshot } from '../site/game/rl/runschema.js';

setAffixTable({ attack: { mults: { atk: 1.2 } } });
setAffixPool(['attack'], []);
const truth = { hp: 1000, atk: 100, mgc: 80, def: 50, mdef: 40, spd: 100, luck: 0 };
const dungeon = { start: 0, boss: 1, rooms: ['start', 'boss', 'chest'].map((type, id) =>
    ({ id, type, seed: 122 + id, doors: {}, enemies: [] })) };
function fixture(seed = 7, floor = 1, snapshot = null) {
    const w = createWorld({ seed, floor, tables: { stats: { statsFor: () => ({ ...truth }) }, skills: {} } });
    w.spawnPlayer({ card: { id: 15002001, class: 0, element: 0 }, equipment: snapshot?.equipment || [] });
    w.floor = floor; w.coin = snapshot?.coin || 0;
    w.setDungeon(dungeon, snapshot?.roomClaims); w.drainEvents();
    return w;
}
function payload(w, patch = {}) {
    return buildRunPayload({ schemaVersion: 3, seed: 7, volume: 1, floor: w.floor,
        cardId: 15002001, level: 1, hp: w.player.hp, coin: w.coin,
        gauge: w.player.skills.gauge, equipment: w.player.equipment,
        roomClaims: w.getRoomClaims(), ...patch });
}
function kill(w) {
    w.enterRoom(1); w.player.x = 3; w.player.y = 3;
    const enemy = w.spawnEnemy({ x: 16, y: 12, hp: 1, aiType: 'boss', elite: w.floor < 20 });
    enemy.actionTimer = 1e9;
    w.danmaku.emit('aimed', { x: 15, y: 12, angle: 0 },
        { side: 'player', power: 9999999, coef: 1, count: 1, speed: 10, life: 3 });
    for (let i = 0; i < 60 && !enemy.dead; i++) w.update(1 / 60);
    assert.equal(enemy.dead, true, '必须从实际伤害管线击杀');
    assert.equal(w.roomState.get(1).cleared, true);
    return w;
}
function atDrop(w) {
    const drop = w.drops[0]; assert.ok(drop, '首领奖励非空');
    w.player.x = drop.x; w.player.y = drop.y; w.drainEvents();
    return drop;
}
function state(w) { return JSON.stringify({ payload: payload(w), drops: w.drops,
    base: w.player.base, events: w.events }); }
let checks = 0, failures = 0;
function check(label, run) {
    checks++; try { run(); console.log('PASS ' + label); }
    catch (e) { failures++; console.error('FAIL ' + label + ': ' + e.stack); }
}
check('守卫和最终首领真实击杀均有一份保底；死亡前不开放离层', () => {
    for (const floor of [1, 5, 20]) for (let seed = 1; seed <= 32; seed++) {
        const w = fixture(seed, floor); assert.equal(w.floorExitReady, false);
        kill(w); assert.equal(w.drops.length, 1); assert.equal(w.drops[0].items.length, 1);
        assert.equal(w.floorExitReady, true); assert.equal(w.player.equipment.length, 0);
    }
});
check('清层保存包含原位置和装备；房间返回恢复同一物品且不重发击杀奖励', () => {
    const w = kill(fixture()), coin = w.coin, expected = JSON.parse(JSON.stringify(w.drops));
    const snap = payload(w), claim = snap.roomClaims.find(c => c.id === 1);
    assert.equal(claim.cleared, true); assert.deepEqual(claim.drops, expected);
    w.enterRoom(0); assert.equal(w.floorExitReady, false); w.enterRoom(1);
    assert.deepEqual(w.getRoomClaims().find(c => c.id === 1).drops, expected); assert.equal(w.floorExitReady, true);
    assert.equal(w.enemies.length, 0); assert.equal(w.coin, coin);
    assert.equal(w.events.filter(e => e.type === 'coinGain').length, 1);
});
check('续档清空状态和未拾取物品都保留，不把 offered 暂态写入存档', () => {
    const w = kill(fixture()); atDrop(w); w.update(1 / 60);
    const snap = parseRunSnapshot(payload(w), 20); assert.ok(snap);
    assert.ok(!Object.hasOwn(snap.roomClaims.find(c => c.id === 1).drops[0], 'offered'));
    const restored = fixture(7, 1, snap); restored.enterRoom(1);
    assert.equal(restored.floorExitReady, true); assert.equal(restored.enemies.length, 0);
    assert.deepEqual(payload(restored).roomClaims, snap.roomClaims);
    atDrop(restored); restored.update(1 / 60);
    assert.equal(restored.events.filter(e => e.type === 'lootOffer').length, 1);
});
check('拾取保存拒绝或异常时完全不变，重试成功先提交再装备且只消费一次', () => {
    for (const reject of [() => false, () => { throw Error('quota'); }]) {
        const w = kill(fixture()), drop = atDrop(w), item = drop.items[0], before = state(w);
        assert.equal(w.takeDrop(drop, item, reject), false); assert.equal(state(w), before);
        let saved; assert.equal(w.takeDrop(drop, item, patch => {
            assert.equal(state(w), before); saved = payload(w, patch); return !!saved;
        }), true);
        assert.deepEqual(payload(w), saved); assert.equal(w.drops.length, 0);
        assert.equal(w.takeDrop(drop, item, () => { throw Error('不应再次保存'); }), false);
        const restored = fixture(7, 1, parseRunSnapshot(saved, 20)); restored.enterRoom(1);
        assert.equal(restored.drops.length, 0); assert.equal(restored.enemies.length, 0);
        assert.deepEqual(restored.player.equipment, [item]);
    }
});
check('过门、死亡、陈旧物品和远距离不允许拾取或离层', () => {
    const w = kill(fixture()), drop = atDrop(w), item = drop.items[0];
    w.transition = {}; assert.equal(w.floorExitReady, false); assert.equal(w.takeDrop(drop, item), false);
    w.transition = null; w.player.x += 2; assert.equal(w.takeDrop(drop, item), false);
    w.player.x = drop.x; w.player.dead = true; assert.equal(w.floorExitReady, false);
    assert.equal(w.takeDrop(drop, item), false);
});
check('已开启宝箱的战利品不会因换房或续档消失', () => {
    const w = fixture(); w.enterRoom(2); w.player.x = w.chest.x; w.player.y = w.chest.y;
    assert.ok(w.openChest()); const snap = payload(w); assert.ok(snap.roomClaims.find(c => c.id === 2).drops.length);
    const restored = fixture(7, 1, parseRunSnapshot(snap, 20)); restored.enterRoom(2);
    assert.equal(restored.chest.opened, true); assert.equal(restored.openChest(), null);
    assert.deepEqual(restored.getRoomClaims().find(c => c.id === 2).drops, snap.roomClaims.find(c => c.id === 2).drops);
});
check('旧 v3 消费记录仍可读取；畸形清空标记、坐标、数量和装备均拒绝', () => {
    const base = payload(kill(fixture()));
    const old = structuredClone(base); old.roomClaims.forEach(c => { delete c.cleared; delete c.drops; });
    assert.ok(parseRunSnapshot(old, 20));
    for (const alter of [c => { c.cleared = 1; }, c => { c.drops = 'bad'; },
        c => { c.drops[0].x = Infinity; }, c => { c.drops[0].y = -1; },
        c => { c.drops = Array(65).fill(c.drops[0]); },
        c => { c.drops[0].items = []; }, c => { c.drops[0].items[0].slot = 'unknown'; }]) {
        const raw = structuredClone(base); alter(raw.roomClaims.find(c => c.id === 1));
        assert.equal(parseRunSnapshot(raw, 20), null);
    }
});
check('雕像只属于首领房；战斗中或远处不可祈愿，拾取不是前置条件', () => {
    const w = fixture(); assert.equal(w.floorShrine, null);
    w.enterRoom(1); assert.ok(w.floorShrine); assert.equal(w.canCommuneAtShrine, false);
    kill(w); assert.equal(w.canCommuneAtShrine, false);
    const shrine = w.floorShrine;
    w.player.x = shrine.x; w.player.y = shrine.y + 1.5;
    assert.equal(w.canCommuneAtShrine, true); assert.ok(w.drops.length);
    const claimBefore = payload(w); assert.equal(w.canCommuneAtShrine, true);
    assert.deepEqual(payload(w), claimBefore, '查看祈愿条件不消费状态');
    const d = atDrop(w); assert.ok(w.takeDrop(d, d.items[0]));
    w.player.x = shrine.x; w.player.y = shrine.y + 1.5;
    assert.equal(w.canCommuneAtShrine, true); assert.equal(w.drops.length, 0);
    w.player.dead = true; assert.equal(w.canCommuneAtShrine, false);
    w.player.dead = false; w.transition = {}; assert.equal(w.canCommuneAtShrine, false);
    w.transition = null; w.enterRoom(0); assert.equal(w.floorShrine, null);
    assert.equal(w.canCommuneAtShrine, false);
});
check('雕像锚点可重建，碰撞从入房开始生效；刷新和重入不重复追加', () => {
    const w = kill(fixture()), shrine = structuredClone(w.floorShrine);
    assert.ok(shrine); const snapshot = payload(w), restored = fixture(7, 1, snapshot);
    restored.enterRoom(1); assert.deepEqual(restored.floorShrine, shrine);
    const p = restored.player; p.x = shrine.x; p.y = shrine.y + 3;
    restored.inputState = { move: { x: 0, y: -1 } };
    for (let i = 0; i < 90; i++) restored.update(1 / 60);
    assert.ok(p.y >= shrine.y + shrine.hh + p.radius - .01, '不能走进雕像底座');
    assert.ok(p.y < shrine.y + 2, '必须能正常走到交互范围');
    assert.equal(restored.canCommuneAtShrine, true);
    restored.setRoomColliders([]); restored.setRoomColliders([]);
    assert.equal(restored.roomColliders.filter(c => c.x === shrine.x && c.y === shrine.y).length, 1);
});
console.log(checks + ' checks, ' + failures + ' failures'); process.exitCode = failures ? 1 : 0;
