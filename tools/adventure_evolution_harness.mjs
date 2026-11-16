import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyEvolution, normalizeEvolution, defenseEvolutionCost } from '../site/core/evolution.js';
import { Battle } from '../site/etowaria-defense/sim/battle.js';
import { LEVELS, ENDLESS, UNIT_RULES } from '../site/etowaria-defense/data/campaign.js';
import { CampaignSave, validateProgress } from '../site/etowaria-defense/app/campaign-save.js';
import * as save from '../site/game/rl/save.js';
import { createMeta, mergeState, pagesForVolume, FINALE_PAGES } from '../site/game/rl/meta.js';
import { createProfileValidator } from '../site/game/rl/profileschema.js';
import { createStats } from '../site/asset/rl/stats.js';
import { ACHIEVEMENTS } from '../site/game/rl/achievements.js';
import { RUN_GENERATOR_VERSION } from '../site/game/rl/runschema.js';
import { createWorld } from '../site/game/rl/world.js';
import { setAffixTable, affixTableFromPassives, calculateLoadout } from '../site/game/rl/equipment.js';
import { setWeaponCatalog } from '../site/game/rl/weaponcatalog.js';

const read = path => JSON.parse(readFileSync(new URL('../site/' + path, import.meta.url), 'utf8'));
const catalogue = read('etowaria-defense/data/units.json'), weapons = read('asset/rl/weapons-rl.json');
const stats = createStats({ cards: read('asset/rl/cards-rl.json').cards, growth: read('asset/rl/growth.json'), enemies: read('asset/rl/enemies.json').enemies });
const skills = read('asset/rl/skills-rl.json'); skills.weaponChildren = weapons.childSkills || {};
save.setImportValidator(createProfileValidator({ stats, weapons, mergeMeta: mergeState,
    pageIds: [1, 2, 3, 4, 5].flatMap(pagesForVolume).concat(FINALE_PAGES), achievementIds: ACHIEVEMENTS.map(row => row.id) }));
setWeaponCatalog(weapons.catalog); setAffixTable(affixTableFromPassives(weapons.passives));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function storage() { const memory = new Map(); return { memory, getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key),
    get length() { return memory.size; }, key: index => [...memory.keys()][index] ?? null }; }
const clone = value => JSON.parse(JSON.stringify(value)), card = stats.card(14002001);
const run = { schemaVersion: 3, generatorVersion: RUN_GENERATOR_VERSION, seed: 12345, volume: 1, floor: 1,
    cardId: card.id, level: 1, exp: 0, hp: 100, gauge: 0, coin: 100, stackHits: 0, stackKills: 0,
    equipment: [], roomClaims: [], appearance: 'base', evolved: false };
function campWith(evolution = emptyEvolution()) {
    save.setStorage(storage()); save.write('meta', mergeState({ evolution })); save.initializeStorage();
    const camp = createMeta(); camp.read(); return camp;
}
function battleReady(level = LEVELS[0]) {
    const b = new Battle(level, { deck: ['U01'], seed: 55, runId: 'growth-check' });
    b.resource = 999; assert.ok(b.deploy('U01', 0, 1).ok); b.phase = 'running'; b.time = 20; return b;
}
function worldReady(options = {}) {
    const w = createWorld({ seed: 13, tables: { stats, skills } });
    w.spawnPlayer({ card, level: 1, ...options }); w.floor = 2; w.coin = 100; return w;
}
test('原作进化配方与双卡面绑定一致', () => {
    const recipes = new Map(read('asset/rl/_raw/CharacterEvolutionList.json').map(row => [row.m_SrcCharaID, row.m_DestCharaID]));
    for (const unit of catalogue.units) {
        assert.equal(unit.forms.evolved.cardId, recipes.get(unit.forms.base.cardId));
        assert.notEqual(unit.forms.base.card, unit.forms.evolved.card);
    }
});
test('旧永久记录继续读取，非法字段被过滤', () => {
    const old = { experience: { U01: 3, unknown: 99 }, evolved: ['U01', 'U01', 'unknown'], pearls: [3, -1, 99999] };
    const normalized = normalizeEvolution(old, ['U01']);
    assert.deepEqual(normalized, { experience: { U01: 3 }, evolved: ['U01'], pearls: [3, 0, 9999, 0, 0, 0] });
    assert.deepEqual(validateProgress({ version: 1, completed: [], evolution: old }).evolution, normalized);
});
test('巡守进化要求驻场与应援，设施不可进化', () => {
    const b = battleReady(); b.time = 19.9; assert.equal(b.evolve('U01').ok, false);
    b.time = 20; b.resource = defenseEvolutionCost(UNIT_RULES.U01.cost) - 1;
    assert.equal(b.evolve('U01').ok, false); b.resource++; assert.ok(b.evolutionQuote('U01').ok);
    assert.equal(b.evolve('F01').ok, false);
});
test('巡守暂停、撤离、战斗结束均不可扣费', () => {
    for (const block of [b => b.pauses.add('manual'), b => b.units.clear(), b => b.phase = 'won']) {
        const b = battleReady(); block(b); const resource = b.resource;
        assert.equal(b.evolve('U01').ok, false); assert.equal(b.resource, resource); assert.equal(b.evolved.size, 0);
    }
});
test('同卡进化保留装备、生命比例和技能计时，只扣费一次', () => {
    const b = battleReady(), first = [...b.units.values()][0]; b.readyAt.clear(); assert.ok(b.deploy('U01', 1, 1).ok);
    const gear = Object.values(UNIT_RULES).find(row => row.kind === 'gear' && row.gear.maxHp);
    b.applyGear(first, gear); first.hp = Math.floor(first.maxHp * .6); first.nextAction = 27; first.attacks = 3; first.shield = 12;
    const hp = first.hp, maxHp = first.maxHp, resource = b.resource, spent = b.stats.spent;
    assert.ok(b.evolve('U01').ok);
    assert.equal(first.maxHp, maxHp + Math.round(UNIT_RULES.U01.hp * 1.15) - UNIT_RULES.U01.hp);
    assert.equal(first.hp, Math.floor(hp / maxHp * first.maxHp));
    assert.equal(first.nextAction, 27); assert.equal(first.attacks, 3); assert.equal(first.shield, 12); assert.equal(first.gear, gear.id);
    const cost = defenseEvolutionCost(UNIT_RULES.U01.cost);
    assert.equal(b.resource, resource - cost); assert.equal(b.stats.spent, spent + cost);
    assert.equal(b.evolve('U01').ok, false); assert.equal(b.resource, resource - cost);
    b.readyAt.clear(); assert.ok(b.deploy('U01', 2, 1).ok); assert.ok([...b.units.values()].every(unit => unit.evolved));
});
test('新巡守清空进化，布阵与无尽续档保持能力且拒绝坏数据', () => {
    const b = battleReady(); b.evolve('U01'); b.phase = 'setup';
    const snapshot = b.serializeSetup(), restored = new Battle(LEVELS[0], { deck: ['U01'] });
    assert.ok(Battle.applySetup(restored, snapshot)); assert.ok(restored.evolved.has('U01'));
    assert.equal([...restored.units.values()][0].maxHp, [...b.units.values()][0].maxHp);
    delete snapshot.evolved; const legacy = new Battle(LEVELS[0]); assert.ok(Battle.applySetup(legacy, snapshot));
    assert.equal([...legacy.units.values()][0].maxHp, UNIT_RULES.U01.hp); assert.equal(battleReady().evolved.size, 0);
    const endless = battleReady(ENDLESS); endless.evolve('U01'); const snap = endless.serializeEndless();
    const resumed = new Battle(ENDLESS); assert.ok(Battle.applyEndless(resumed, snap)); assert.ok(resumed.evolved.has('U01'));
    for (const mutate of [s => s.evolved = 'U01', s => s.units[0].evolved = false, s => s.units[0].evolved = 'yes']) {
        const bad = clone(snap); mutate(bad); const target = new Battle(ENDLESS), before = target.serializeEndless();
        assert.equal(Battle.applyEndless(target, bad), false); assert.deepEqual(target.serializeEndless(), before);
    }
});
test('巡守与无尽奖励不再增加永久进化材料', () => {
    const campaign = new CampaignSave(storage()), b = battleReady();
    const old = { experience: { U01: 3 }, evolved: ['U01'], pearls: [3, 0, 0, 0, 0, 0] };
    campaign.progress.evolution = clone(old); b.phase = 'won'; campaign.finish('won', b); assert.deepEqual(campaign.progress.evolution, old);
    const endless = battleReady(ENDLESS); while (endless.plannedWave < 5) endless.planWave();
    endless.wave = 5; endless.settledWaves.add(5); endless.waveBounds.get(5).remaining = 0;
    assert.ok(campaign.settleEndlessReward({ runId: endless.runId, wave: 5, drops: [], bonusDrops: [], checkpoint: endless.serializeEndless() }).applied);
    assert.deepEqual(campaign.progress.evolution, old);
});
test('冒险成长只计清理过的战斗房，第二层满足成长条件', () => {
    const w = worldReady(); w.floor = 1;
    w.dungeon = { rooms: [{ id: 0, type: 'rest' }, { id: 1, type: 'battle' }, { id: 2, type: 'boss' }, { id: 3, type: 'battle' }] };
    for (const room of w.dungeon.rooms) w.roomState.set(room.id, { cleared: room.id < 3 });
    assert.equal(w.evolutionQuote().progress, 2); assert.equal(w.evolvePlayer().ok, false);
    w.roomState.get(3).cleared = true; assert.ok(w.evolutionQuote().ok);
    w.roomState.clear(); w.floor = 2; assert.ok(w.evolutionQuote().ok);
});
test('冒险金币、死亡、过场与未清理敌人阻止进化', () => {
    for (const block of [w => w.coin = 59, w => w.player.dead = true, w => w.transition = {},
        w => { w.roomId = 1; w.dungeon = { rooms: [{ id: 1, type: 'battle' }] }; w.enemies.push({ dead: false }); }]) {
        const w = worldReady(); block(w); const coin = w.coin;
        assert.equal(w.evolvePlayer().ok, false); assert.equal(w.coin, coin); assert.equal(w.player.evolved, false);
    }
});
test('保存失败或抛错时，冒险金币与能力不变', () => {
    for (const persist of [() => false, () => { throw Error('quota'); }]) {
        const w = worldReady(), p = w.player, before = { hp: p.hp, maxHp: p.maxHp, base: clone(p.base) };
        assert.equal(w.evolvePlayer(persist).ok, false); assert.equal(w.coin, 100); assert.equal(p.evolved, false);
        assert.deepEqual({ hp: p.hp, maxHp: p.maxHp, base: p.base }, before);
    }
});
test('冒险先保存再进化，保留生命比例、装备、技能冷却与必杀槽', () => {
    const w = worldReady(), p = w.player, truth = stats.statsFor(card.id, 1);
    p.hp = Math.floor(p.maxHp * .6); p.skills.slots[0].remaining = 4.5; p.skills.addGauge(.4);
    const before = { hp: p.hp, maxHp: p.maxHp, gauge: p.skills.gauge, equipment: p.equipment }; let patch;
    assert.ok(w.evolvePlayer(next => { assert.equal(w.coin, 100); assert.equal(p.evolved, false); patch = next; return true; }).ok);
    assert.equal(w.coin, 40); assert.equal(p.appearance, 'evolved'); assert.equal(p.maxHp, Math.round(truth.hp * 1.15));
    assert.equal(p.hp, Math.floor(before.hp / before.maxHp * p.maxHp)); assert.equal(p.hp, patch.hp);
    assert.equal(p.atk, p.base.atk); assert.equal(p.base.atk, truth.atk * 1.12);
    assert.equal(p.skills.slots[0].remaining, 4.5); assert.equal(p.skills.gauge, before.gauge); assert.equal(p.equipment, before.equipment);
    assert.equal(w.evolvePlayer().ok, false); assert.equal(w.coin, 40);
});
test('进化后反复换装不叠加能力，不制造回复', () => {
    const w = worldReady(); w.evolvePlayer(); const p = w.player, truth = p.truthBase; p.hp = Math.floor(p.maxHp * .6);
    const weapon = weapons.catalog.find(row => row.class === card.class && row.charaId < 0 && row.rare === 3);
    const item = { slot: 'weapon', rarity: 'rare', affixes: [], catalogId: weapon.id }, expected = calculateLoadout(truth, [item], p).stats;
    for (let i = 0; i < 8; i++) {
        const hp = p.hp, ratio = p.hp / p.maxHp, drop = { x: p.x, y: p.y, items: [clone(item)] }; w.drops.push(drop);
        assert.ok(w.takeDrop(drop, drop.items[0])); assert.deepEqual(p.base, expected);
        assert.ok(p.hp / p.maxHp <= ratio + 1e-9); if (i) assert.equal(p.hp, hp);
    }
    assert.deepEqual(p.truthBase, truth);
});
test('冒险进化事务可续档与导入，新局恢复基础能力', () => {
    campWith(); const started = save.beginRun(run), w = worldReady();
    assert.ok(w.evolvePlayer(patch => save.write('run', { ...save.load('run'), ...patch }, { runId: started.runId })).ok);
    const exported = save.exportSave(); save.setStorage(storage()); assert.ok(save.importSave(exported).ok);
    const snapshot = save.load('run'); assert.equal(snapshot.evolved, true); assert.equal(snapshot.appearance, 'evolved'); assert.equal(snapshot.coin, 40);
    assert.equal(worldReady({ evolved: snapshot.evolved }).player.maxHp, w.player.maxHp); assert.equal(worldReady().player.evolved, false);
});
test('旧永久记录可导入，楼层和终局奖励不再改变它', () => {
    const old = { experience: { [card.id]: 3 }, evolved: [String(card.id)], pearls: [3, 2, 1, 0, 0, 0] };
    const camp = campWith(old), started = save.beginRun(run);
    assert.ok(camp.descendRun(started.runId, save.load('run')).ok); assert.deepEqual(camp.state.evolution, old);
    const exported = save.exportSave(); save.setStorage(storage()); assert.ok(save.importSave(exported).ok);
    const restored = createMeta(); restored.read(); assert.deepEqual(restored.state.evolution, old);
    for (const outcome of ['victory', 'defeat']) {
        const camp = campWith(old), started = save.beginRun({ ...run, floor: 20 });
        assert.ok(camp.settleRun(started.runId, { outcome, volume: 1, floor: 20, cardId: card.id, level: 1, coin: 0, items: [] }).receipt);
        assert.deepEqual(camp.state.evolution, old);
    }
});
console.log(JSON.stringify({ passed }));
