import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorld } from '../site/game/rl/world.js';
import { setAffixTable, affixTableFromPassives } from '../site/game/rl/equipment.js';
import { setAffixPool, rollLoot } from '../site/game/rl/loot.js';
import { createRandom } from '../site/game/rl/random.js';
import { makeGadget, GADGETS } from '../site/game/rl/gadgets.js';
import { buildRunPayload, parseRunSnapshot } from '../site/game/rl/runschema.js';

setAffixTable({ health: { mults: { hp: 1.5 } } });
const truth = { hp: 1000, atk: 100, mgc: 100, def: 100, mdef: 100, spd: 100, luck: 0 };
const skillTable = JSON.parse(fs.readFileSync(new URL('../site/asset/rl/skills-rl.json', import.meta.url), 'utf8'));
const nativeCard = JSON.parse(fs.readFileSync(new URL('../site/asset/rl/cards-rl.json', import.meta.url), 'utf8')).cards.find(c => c.id === 15002001);
const dungeon = { start: 0, rooms: ['start', 'rest', 'battle'].map((type, id) =>
    ({ id, type, seed: 100 + id, doors: {}, enemies: [] })) };
function fixture(type = 'rest', equipment = [], floor = 9) {
    const w = createWorld({ seed: 19, floor, tables: { stats: { statsFor: () => ({ ...truth }) }, skills: skillTable } });
    const p = w.spawnPlayer({ card: nativeCard, equipment });
    w.setDungeon(dungeon); w.enterRoom(type === 'rest' ? 1 : 2);
    if (type === 'altar') w.altar = w.roomState.get(2).altar = { x: 3.2, y: 3.2, used: false };
    w.coin = 100; p.hp = 800; w.drainEvents();
    return w;
}
function snap(w) { return JSON.stringify({ hp: w.player.hp, gauge: w.player.skills.gauge,
    coin: w.coin, equipment: w.player.equipment, claims: w.getRoomClaims(), events: w.events }); }
function payload(w, patch = {}) { return buildRunPayload({ schemaVersion: 3, seed: 19, volume: 1, floor: w.floor,
    cardId: 15002001, level: 1, hp: w.player.hp, gauge: w.player.skills.gauge, coin: w.coin,
    equipment: w.player.equipment, roomClaims: w.getRoomClaims(), ...patch }); }
let checks = 0, failures = 0;
function check(name, run) { checks++; try { run(); console.log('PASS ' + name); }
    catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.stack); } }

check('营地四种选择与祭坛三条道路均有明示收益及代价', () => {
    assert.equal(fixture().getSupplyOffer().options.length, 4);
    for (const option of fixture('altar').getAltarOffer().options) assert.ok(option.benefit && option.cost);
});
check('反复预览不消费、不变更装备、不扰动随机流', () => {
    for (const type of ['rest', 'altar']) {
        const a = fixture(type), b = fixture(type), before = snap(a);
        const offer = () => type === 'rest' ? a.getSupplyOffer() : a.getAltarOffer();
        const first = JSON.stringify(offer());
        for (let i = 0; i < 30; i++) assert.equal(JSON.stringify(offer()), first);
        assert.equal(snap(a), before);
        for (let i = 0; i < 10; i++) assert.equal(a.rng(), b.rng());
    }
});
check('保存拒绝或抛错时保持完整世界状态，不发奖励事件', () => {
    for (const type of ['rest', 'altar']) for (const fail of [() => false, () => { throw Error('quota'); }]) {
        const w = fixture(type), before = snap(w); let attempted = false;
        const reject = patch => { attempted = true; return fail(patch); };
        const result = type === 'rest' ? w.chooseSupply('commission', 1, reject) : w.useAltar('oath', 2, reject);
        assert.equal(attempted, true); assert.equal(result, null); assert.equal(snap(w), before);
    }
});
check('营地确认先提交完整候选，再装备且只扣一次修缮费', () => {
    const w = fixture(), before = snap(w); let written;
    const expectedPrice = {sentry:54,hunter:78,steady:72}[w.getSupplyOffer().options.find(o => o.id === 'commission').item.gadgetId];
    const result = w.chooseSupply('commission', 1, patch => {
        assert.equal(snap(w), before); written = payload(w, patch); return !!written;
    });
    assert.ok(result); assert.equal(w.coin, 100 - expectedPrice); assert.ok(w.player.gadgets.assist >= 2);
    assert.equal(w.assistance.enabled, false); assert.equal(w.chooseSupply('commission', 1), null);
    assert.deepEqual(payload(w).equipment, written.equipment);
    assert.equal(written.roomClaims.find(r => r.id === 1).supply, 'commission');
});
check('生命契约不会致死，资源不足不消耗祭坛', () => {
    const w = fixture('altar'); w.player.hp = 300;
    assert.equal(w.getAltarOffer().options.find(o => o.id === 'oath').enabled, false);
    assert.equal(w.useAltar('oath', 2), null); assert.equal(w.altar.used, false);
    w.coin = 0; assert.equal(w.useAltar('offering', 2), null);
});
check('巡猎誓约按公开生命代价一次提交，原装备被替换', () => {
    const w = fixture('altar', [{ slot: 'armor', rarity: 'rare', affixes: ['health'] }]);
    w.player.hp = 1300; const quote = w.getAltarOffer().options.find(o => o.id === 'oath');
    assert.equal(quote.hpCost, 450); assert.equal(quote.result.hp, 550);
    let saved; assert.ok(w.useAltar('oath', 2, patch => { saved = payload(w, patch); return true; }));
    assert.equal(w.player.hp, 550); assert.equal(w.player.maxHp, 1000);
    assert.deepEqual(w.player.equipment, [quote.item]);
    assert.ok(['hunter','steady'].includes(quote.item.gadgetId));
    assert.equal(saved.hp, w.player.hp); assert.equal(w.useAltar('calm', 2), null);
});
check('取消后或失败后可选另一道路，成功后关闭全部其他道路', () => {
    const w = fixture(); assert.equal(w.chooseSupply('commission', 1, () => false), null);
    assert.ok(w.chooseSupply('tune', 1)); assert.equal(w.coin, 100);
    for (const option of w.getSupplyOffer().options) assert.equal(w.chooseSupply(option.id, 1), null);
});
check('未知选择、过门中、错误房间和死亡均拒绝提交', () => {
    const w = fixture(), before = snap(w);
    assert.equal(w.chooseSupply('__proto__', 1), null); assert.equal(w.chooseSupply('tune', 2), null);
    w.transition = {}; assert.equal(w.chooseSupply('tune', 1), null); w.transition = null;
    assert.equal(snap(w), before); w.player.hp = 0; w.player.sm.force('dead');
    assert.equal(w.chooseSupply('tune', 1), null);
});
check('战斗中不能开启祭坛事件暂停获利', () => {
    const w = fixture('altar'); w.spawnEnemy({ x: 12, y: 12, hp: 100 });
    assert.equal(w.getAltarOffer(), null); assert.equal(w.useAltar('oath', 2), null);
});
check('续档保留新事件记录，旧补给仍兼容，伪造记录拒绝', () => {
    const w = fixture(); w.chooseSupply('tune', 1);
    const saved = parseRunSnapshot(payload(w), 20); assert.ok(saved);
    const restored = fixture(); restored.setDungeon(dungeon, saved.roomClaims); restored.enterRoom(1);
    assert.equal(restored.getSupplyOffer().used, true); assert.equal(restored.chooseSupply('tune', 1), null);
    const raw = payload(w); raw.roomClaims.find(r => r.id === 1).supply = 'unknown';
    assert.equal(parseRunSnapshot(raw, 20), null);
});
check('攻速机制不缩短技能冷却', () => {
    const a = fixture(), b = fixture('rest', [makeGadget('rhythm')]);
    for (const w of [a, b]) {
        w.inputState = { move: { x: 0, y: 0 }, attack: true, skill: [false, false, false] };
        w.player.skills.slots[1].remaining = 12;
        for (let i = 0; i < 60; i++) w.update(1 / 60);
    }
    assert.equal(a.player.skills.slots[1].remaining, b.player.skills.slots[1].remaining);
    assert.ok(b.player.swingId > a.player.swingId);
});
check('十类机制可从第13层具名渠道生成，不夹带原作词条', () => {
    const data = JSON.parse(fs.readFileSync(new URL('../site/asset/rl/weapons-rl.json', import.meta.url), 'utf8'));
    setAffixTable(affixTableFromPassives(data.passives)); setAffixPool(Object.keys(data.passives), []);
    const rng = createRandom(912), seen = new Set();
    for (let i = 0; i < 3000; i++) for (const item of rollLoot(rng, 13, 0, null,
        { source: ['chest', 'elite', 'guardian'][i % 3] })) {
        if (item.gadgetId) { seen.add(item.gadgetId); assert.deepEqual(item.affixes, []); }
    }
    assert.deepEqual([...seen].sort(), GADGETS.map(g => g.id).sort());
});
console.log(checks + ' checks, ' + failures + ' failures'); process.exitCode = failures ? 1 : 0;
