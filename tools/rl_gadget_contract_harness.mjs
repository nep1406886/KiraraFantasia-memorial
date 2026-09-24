import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as gadgets from '../site/game/rl/gadgets.js';
import { createWorld } from '../site/game/rl/world.js';
import { createDanmaku } from '../site/game/rl/danmaku.js';
import { attackFrom, resolveDamage, tryHit, elementFlag, TEMPO } from '../site/game/rl/combat.js';
import { elementMultiplier } from '../site/game/rl/elements.js';
import { applyEquipment, setAffixTable, affixTableFromPassives } from '../site/game/rl/equipment.js';
import { createRandom } from '../site/game/rl/random.js';
import { restEventChoices, altarEventChoices } from '../site/game/rl/roomevents.js';
import { parseRunSnapshot, buildRunPayload } from '../site/game/rl/runschema.js';
import { grantNextCritical } from '../site/game/rl/nextcritical.js';
import { placeSkillCard } from '../site/game/rl/skillcards.js';
import { PLAYER_TIMING } from '../site/game/rl/actorstate.js';
import { createSkills } from '../site/game/rl/skills.js';
import { PLAYABLE_ROSTER } from '../site/game/rl/rosterids.js';
import { setAffixPool } from '../site/game/rl/loot.js';
import { setWeaponCatalog } from '../site/game/rl/weaponcatalog.js';

const weapons = JSON.parse(fs.readFileSync(new URL('../site/asset/rl/weapons-rl.json', import.meta.url), 'utf8'));
setAffixTable(affixTableFromPassives(weapons.passives));
setAffixPool(Object.keys(weapons.passives), weapons.weapons.map(row => row.id));
setWeaponCatalog(weapons.catalog);
const BASE_IDS = ['rhythm', 'strider', 'reach', 'wide', 'aim', 'sentry', 'hunter'];
const CONTRACTS = { steady: [9, 120], prism: [13, 160], binding: [13, 180] };
const make = (id, slot = 1) => gadgets.makeGadget(id, undefined, id === 'binding' ? slot : undefined);
const plainArmor = { slot: 'armor', rarity: 'common', affixes: [] };
const truth = { hp: 1000, atk: 100, mgc: 100, def: 100, mdef: 100, spd: 100, luck: 1200 };
const damage = (target = 1, coef = 500) => ({ kind: 0, target, args: [coef, 0] });
const grant = { kind: 12, target: 0, args: [] };
function row(id, effects = [damage()]) {
    const hit = effects.find(e => e.kind === 0);
    return { id, name: '契约测试技能' + id, nameZh: '契约测试技能' + id,
        target: hit?.target ?? effects[0].target, coef: hit ? hit.args[0] / 1000 : 0,
        magic: false, recasts: [28], effects };
}
const table = { player: { 9000: row(9000, [grant, damage(2)]), 9001: row(9001), 9002: row(9002) },
    normalAttacks: Object.fromEntries([0, 1, 2, 3, 4].map(id => [id, row(700 + id)])),
    weaponChildren: weapons.childSkills };
const card = { id: 15002001, class: 0, element: 0, skillIds: { chara: 9000, class: [9001, 9002] } };
let checks = 0, failures = 0;
function check(label, fn) { checks++; try { fn(); console.log('PASS ' + label); }
    catch (error) { failures++; console.error('FAIL ' + label + ': ' + error.stack); } }
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, a + ' != ' + b);
function fixture(id, { cls = 0, slot = 1, skillTable = table, equipment, luck = 1200, floor = 13 } = {}) {
    const w = createWorld({ width: 32, height: 24, floor, seed: 20260910,
        tables: { stats: { statsFor: () => ({ ...truth, luck }) }, skills: skillTable } });
    w.spawnPlayer({ card: { ...card, class: cls }, x: 4, y: 12,
        equipment: equipment || (id ? [make(id, slot)] : []) });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false,
        skill: [false, false, false], ultimate: false, assist: false };
    w.rng = () => .01; return w;
}
function step(w, seconds) { for (let t = 0; t < seconds - 1e-9; t += 1 / 120) w.update(Math.min(1 / 120, seconds - t)); }
function foe(w, x = 5.6, element = 0) {
    const e = w.spawnEnemy({ x, y: 12, hp: 1000000, atk: 0, def: 0, mdef: 0, element });
    e.actionTimer = 1e9; return e;
}
function pickup(w, item, persist) { const d = { x: w.player.x, y: w.player.y, items: [item] };
    w.drops.push(d); return { ok: w.takeDrop(d, item, persist), drop: d }; }
function equip(w, item) { assert.equal(pickup(w, item).ok, true); }
function swing(w, seconds = .18) { w.inputState.attack = true; step(w, 1 / 120);
    w.inputState.attack = false; step(w, seconds); }
function cast(w, index = 1) { w.inputState.skill[index] = true; step(w, 1 / 120);
    w.inputState.skill[index] = false; step(w, 1 / 120); }
const hits = w => w.events.filter(e => e.type === 'hit' && e.target.kind !== 'player');
const consumed = w => w.events.filter(e => e.type === 'nextCritical' && e.action === 'used');
const bullets = w => { const list = []; w.danmaku.forEach(b => list.push(b)); return list; };
function payload(equipment, roomClaims = []) { return { schemaVersion: 3, generatorVersion: 't24-1',
    seed: 77, volume: 1, floor: 13, cardId: card.id, level: 1, hp: 1000, equipment, roomClaims }; }

check('禁暴在伤害公式中压过布尔/数值暴击且不改其他乘区', () => {
    for (const crit of [true, 1.83]) near(resolveDamage({ atk: 100, def: 0, skill: .5,
        crit, noCrit: true, tempo: TEMPO }), 208);
    near(resolveDamage({ atk: 100, def: 0, skill: .5, crit: true, tempo: TEMPO }), 311);
});
check('无相只去掉优势及克制增幅：六属性、物魔伤害和耐性完整矩阵', () => {
    for (let a = 0; a < 6; a++) for (let d = 0; d < 6; d++) for (const magic of [false, true]) {
        const attacker = { kind: 'player', atk: 100, mgc: 100, element: a, luck: 0,
            skills: { weakElementBonus: .5 }, gadgets: { noAdvantage: true } };
        const target = { def: 100, mdef: 100, element: d, resists: [{ element: a, pct: .2 }] };
        const spec = attackFrom(attacker, target, { coef: 1, magic }, { crit: false });
        const ring = Math.min(1, elementMultiplier(a, d));
        near(resolveDamage(spec), Math.max(1, Math.round(100 * ring * TEMPO * .8 - 60)));
        assert.equal(spec.hitFlag, Math.min(0, elementFlag(a, d)));
    }
});
check('攻击构造和命中呈现都遵守禁暴，不抽取暴击随机数', () => {
    const p = { kind: 'player', atk: 100, luck: 1200, gadgets: { noCrit: true } };
    const target = { hp: 1000, def: 0, kind: 'enemy', sm: { set() {} } };
    const spec = attackFrom(p, target, .5, { forceCritical: true, rng() { throw Error('禁暴不应抽随机数'); } });
    assert.equal(spec.crit, false); assert.equal(tryHit(target, spec).crit, false);
    const visible = tryHit(target, { atk: 100, skill: .5, crit: 1.83, noCrit: true, hitFlag: 1, noAdvantage: true });
    assert.equal(visible.crit, false); assert.equal(visible.hitFlag, 0);
});
check('旧七件保留，三契约固定身份、品质、价格与门槛', () => {
    assert.equal(gadgets.GADGETS.length, 10);
    for (const id of BASE_IDS) assert.equal(gadgets.gadgetDefinition(make(id)).id, id);
    for (const [id, [minFloor, price]] of Object.entries(CONTRACTS)) {
        const def = gadgets.gadgetDefinition(make(id));
        assert.equal(def.minFloor, minFloor); assert.equal(def.price, price);
        assert.equal(def.slot, 'armor'); assert.equal(def.rarity, 'epic');
        assert.ok(def.benefit && def.cost); assert.equal(gadgets.gadgetRuntime([make(id)]).damage, 1);
        assert.equal(gadgets.gadgetRuntime([make(id)]).defense, 1);
    }
});
check('封印字段严格校验，不能缺失/封R/夹带于普通装备', () => {
    assert.throws(() => gadgets.makeGadget('binding'));
    for (const sealedSlot of [undefined, 0, 3, -1, 1.1, '1', null, NaN]) {
        assert.throws(() => gadgets.gadgetDefinition({ slot: 'armor', rarity: 'epic', affixes: [], gadgetId: 'binding', sealedSlot }));
    }
    for (const item of [plainArmor, make('hunter')]) {
        assert.throws(() => gadgets.gadgetDefinition({ ...item, sealedSlot: 1 }));
    }
    for (const index of [1, 2]) assert.deepEqual(gadgets.gadgetRuntime([make('binding', index)]).sealedSlots, [index]);
});
check('生成一次固定封印：只有选中缚技后才多抽一次', () => {
    for (const value of [0, .999999]) {
        const values = [.999999, value]; let count = 0;
        const item = gadgets.rollGadget(() => values[count++], 'boss', 13);
        assert.equal(item.gadgetId, 'binding'); assert.equal(item.sealedSlot, value ? 2 : 1); assert.equal(count, 2);
        for (let i = 0; i < 10; i++) gadgets.gadgetDefinition(item);
        assert.equal(count, 2);
    }
    let count = 0; gadgets.rollGadget(() => { count++; return 0; }, 'shop', 13); assert.equal(count, 1);
});
check('所有来源和开放层明确，高级契约不混入宝箱/精英', () => {
    for (const source of ['chest', 'elite', 'guardian', 'boss', 'shop']) for (const floor of [8, 9, 12, 13, 20]) {
        const rng = createRandom(1000 + floor), seen = new Set();
        for (let i = 0; i < 4000; i++) {
            const item = gadgets.rollGadget(rng, source, floor); if (!item) continue;
            const def = gadgets.gadgetDefinition(item); assert.ok(floor >= def.minFloor); seen.add(def.id);
        }
        for (const [id, [minFloor]] of Object.entries(CONTRACTS)) {
            assert.equal(seen.has(id), !['chest', 'elite'].includes(source) && floor >= minFloor, source + '/' + floor + '/' + id);
        }
    }
});
check('营地/祭坛契约固定到房间，与装备、预览次数和运行随机流无关', () => {
    for (const source of ['camp', 'altar']) {
        const seen = new Set(), seals = new Set();
        for (let seed = 0; seed < 300; seed++) {
            const quote = () => source === 'camp' ? restEventChoices(seed, 100, 50, 13) : altarEventChoices(seed, 1000, 100, 13);
            const a = quote().at(-1), b = quote().at(-1);
            assert.deepEqual(a, b); seen.add(a.item.gadgetId);
            if (a.item.gadgetId === 'binding') seals.add(a.item.sealedSlot);
        }
        for (const id of Object.keys(CONTRACTS)) assert.ok(seen.has(id), source + '/' + id);
        assert.deepEqual([...seals].sort(), [1, 2]);
    }
});
check('同机制不同封印不是重复，旧品质仍忽略', () => {
    const a = make('binding', 1), b = make('binding', 2);
    assert.equal(gadgets.sameGadgetEffect(a, b), false);
    assert.equal(gadgets.sameGadgetEffect(a, { ...a, rarity: 'common' }), true);
    assert.equal(gadgets.sameGadgetEffect(make('sentry'), make('steady')), false);
});
check('装备/已存货架/已存掉落保留封印值，损坏字段统一拒绝', () => {
    for (const index of [1, 2]) {
        const item = make('binding', index);
        const claims = [{ id: 1, cleared: true, drops: [{ x: 4, y: 4, items: [item] }],
            offer: [{ item, price: 180, bought: false }, { item: null, price: 0, bought: false }, { item: null, price: 0, bought: false }] }];
        const saved = parseRunSnapshot(payload([item], claims), 20); assert.ok(saved);
        const roundtrip = parseRunSnapshot(buildRunPayload(saved), 20); assert.deepEqual(roundtrip, saved);
        assert.equal(roundtrip.equipment[0].sealedSlot, index);
        assert.equal(roundtrip.roomClaims[0].drops[0].items[0].sealedSlot, index);
        assert.equal(roundtrip.roomClaims[0].offer[0].item.sealedSlot, index);
        for (const location of ['equipment', 'drops', 'offer']) {
            const bad = JSON.parse(JSON.stringify(payload([item], claims)));
            const target = location === 'equipment' ? bad.equipment[0] : location === 'drops'
                ? bad.roomClaims[0].drops[0].items[0] : bad.roomClaims[0].offer[0].item;
            delete target.sealedSlot; assert.equal(parseRunSnapshot(bad, 20), null);
        }
    }
    const old = parseRunSnapshot(payload([make('hunter')]), 20);
    assert.equal(old.equipment[0].sealedSlot, undefined);
});
check('面板禁暴/解除完全还原，重复重算不改基础数据', () => {
    for (let i = 0; i < 100; i++) {
        const next = applyEquipment(truth, [make('steady')]); assert.equal(next.critChance, 0); assert.equal(next.atk, 100);
        assert.equal(applyEquipment(truth, []).critChance, 1);
    }
    assert.equal(truth.luck, 1200);
});
check('预览显示当前/候选具体技能，替换有原作改技的护甲时不拿旧技能名冒充', () => {
    const w = fixture(null, { equipment: [{ slot: 'armor', rarity: 'rare', affixes: ['32032001'] }] });
    const before = JSON.stringify(w.player.equipment), current = w.player.skills.slots.map(s => s.name);
    const preview = w.previewEquipment(make('binding', 2));
    assert.deepEqual(preview.skillNames.current, current);
    assert.equal(preview.skillNames.candidate[2], table.player[9002].name);
    assert.notEqual(preview.skillNames.candidate[2], current[2]); assert.equal(JSON.stringify(w.player.equipment), before);
    const terms = gadgets.gadgetTerms(make('binding', 2), preview.skillNames.candidate);
    assert.ok(terms.cost.includes('技能3') && terms.cost.includes(table.player[9002].name));
});
check('拒绝保存不生效，成功拾取后才封印，重试只提交一次', () => {
    const w = fixture(), item = make('binding', 2), p = w.player;
    const attempt = pickup(w, item, () => false); assert.equal(attempt.ok, false);
    assert.equal(p.skills.ready(2), true); assert.deepEqual(p.equipment, []);
    let saved; assert.equal(w.takeDrop(attempt.drop, item, patch => { saved = patch; return true; }), true);
    assert.equal(p.skills.isSealed(2), true); assert.equal(saved.equipment[0].sealedSlot, 2);
    assert.equal(w.takeDrop(attempt.drop, item), false); assert.equal(w.assistance.enabled, false);
});
check('全部当前可玩角色都有技能2/3，固定封印不会抽中R或空槽', () => {
    const data = JSON.parse(fs.readFileSync(new URL('../site/asset/rl/cards-rl.json', import.meta.url), 'utf8')).cards;
    const shipped = JSON.parse(fs.readFileSync(new URL('../site/asset/rl/skills-rl.json', import.meta.url), 'utf8'));
    for (const entry of PLAYABLE_ROSTER) for (const index of [1, 2]) {
        const card = data.find(row => row.id === entry.id); assert.ok(card);
        const sk = createSkills({ card, table: shipped, maxHp: 1000 });
        assert.ok(sk.slots[index]?.usable && !sk.slots[index].ultimate, entry.id + '/' + index);
        sk.applyGadgets(gadgets.gadgetRuntime([make('binding', index)]));
        assert.equal(sk.ready(index), false); assert.equal(sk.ready(index === 1 ? 2 : 1), true);
        assert.equal(sk.isSealed(0), false); assert.equal(sk.ultimate.ultimate, true);
    }
});
check('第13层真实守卫死亡掉出三契约及两个封印变体，清层/重返不再追加', () => {
    const found = new Set();
    for (let seed = 1; seed <= 1000 && found.size < 4; seed++) {
        const w = fixture(); w.rng = createRandom(seed);
        w.setDungeon({ start: 0, boss: 1, rooms: ['start','boss'].map((type,id) => ({id,type,seed:id,doors:{},enemies:[]})) });
        w.enterRoom(1); w.player.x = 2; w.player.y = 2;
        const e = w.spawnEnemy({ x: 8, y: 12, hp: 1, elite: true }); e.actionTimer = 1e9;
        w.danmaku.emit('aimed', {x:7,y:12,angle:0}, {side:'player',power:1000000,coef:1,speed:10,count:1,life:2});
        step(w, .2); assert.equal(e.dead, true); assert.equal(w.drops.flatMap(d => d.items).length, 1);
        const item = w.drops[0].items[0];
        if (item.gadgetId === 'binding') found.add('binding:' + item.sealedSlot);
        else if (['steady','prism'].includes(item.gadgetId)) found.add(item.gadgetId);
        const original = JSON.stringify(w.drops.flatMap(d => d.items));
        step(w, .2); w.enterRoom(0); w.enterRoom(1);
        assert.equal(JSON.stringify(w.drops.flatMap(d => d.items)), original);
        assert.equal(w.floor, 13); assert.deepEqual(w.player.equipment, []);
    }
    assert.deepEqual([...found].sort(), ['binding:1','binding:2','prism','steady']);
});
for (const sealedSlot of [1, 2]) check('封印技能' + (sealedSlot + 1) + '阻止真实输入，不扣冷却且不阻止另一技能/R', () => {
    const w = fixture('binding', { slot: sealedSlot }); foe(w);
    const p = w.player; assert.equal(p.skills.ready(sealedSlot), false);
    cast(w, sealedSlot); assert.equal(p.skills.slots[sealedSlot].remaining, 0);
    assert.equal(w.events.filter(e => e.type === 'skill').length, 0); assert.equal(p.actionBuffer, null);
    cast(w, sealedSlot === 1 ? 2 : 1); assert.equal(w.events.filter(e => e.type === 'skill').length, 1);
    step(w, .5); p.skills.addGauge(p.skills.gaugeMax); assert.ok(w.useUltimate());
});
check('封印冷却照常恢复；重算武器改技与清除增益不解除或刷新冷却', () => {
    const w = fixture(null, { equipment: [{ slot: 'weapon', rarity: 'rare', affixes: ['32032001'] }] });
    const p = w.player; cast(w, 2); step(w, .5); const left = p.skills.slots[2].remaining, id = p.skills.slots[2].id;
    assert.ok(left > 5); equip(w, make('binding', 2)); near(p.skills.slots[2].remaining, left);
    assert.equal(p.skills.slots[2].id, id); p.skills.clearEffects(); assert.equal(p.skills.isSealed(2), true);
    step(w, 1); near(p.skills.slots[2].remaining, left - 1);
    const now = p.skills.slots[2].remaining; equip(w, plainArmor); near(p.skills.slots[2].remaining, now);
    assert.equal(p.skills.isSealed(2), false); assert.equal(p.skills.ready(2), false);
});
check('封印时按住技能，卸装后不偷偷补放；松开再按才施放', () => {
    const w = fixture('binding'), p = w.player; foe(w); w.inputState.skill[1] = true; step(w, .1);
    equip(w, plainArmor); step(w, .1); assert.equal(w.events.filter(e => e.type === 'skill').length, 0);
    w.inputState.skill[1] = false; step(w, .01); cast(w, 1);
    assert.equal(w.events.filter(e => e.type === 'skill').length, 1); assert.equal(p.skills.isSealed(1), false);
});
check('定心真实近战多目标禁暴，仍恰好消费一次必暴', () => {
    const w = fixture('steady'); foe(w); foe(w, 5.7); grantNextCritical(w.player); swing(w);
    assert.equal(hits(w).length, 2); assert.ok(hits(w).every(h => !h.crit && h.damage === 208));
    assert.equal(w.player.nextCritical, false); assert.equal(consumed(w).length, 1);
});
check('普攻开始时承诺契约：开窗前卸装仍禁暴，下一挥击恢复', () => {
    const w = fixture('steady'); foe(w); w.inputState.attack = true; step(w, 1 / 120); w.inputState.attack = false;
    equip(w, plainArmor); step(w, .3); assert.equal(hits(w)[0].crit, false);
    step(w, .4); swing(w); assert.equal(hits(w).at(-1).crit, true);
});
check('普通暴击机会不与禁暴面板混淆：开窗前装上定心不改变上一挥击', () => {
    const w = fixture(); foe(w); w.inputState.attack = true; step(w, 1 / 120); w.inputState.attack = false;
    equip(w, make('steady')); step(w, .3); assert.equal(hits(w)[0].crit, true);
    step(w, .4); swing(w); assert.equal(hits(w).at(-1).crit, false);
});
for (const id of ['steady', 'prism']) for (const type of ['normal', 'skill']) check(id + ' ' + type + '弹体在途换装不改变契约', () => {
    const w = fixture(id, { cls: 1 }), p = w.player; const e = foe(w, 7, 3); grantNextCritical(p);
    if (type === 'normal') swing(w, PLAYER_TIMING.attackHitStart); else cast(w);
    const emitted = bullets(w).filter(b => b.side === 'player'); assert.ok(emitted.length > 0);
    assert.equal(emitted[0][id === 'steady' ? 'noCrit' : 'noAdvantage'], true);
    equip(w, plainArmor); step(w, .8); assert.ok(hits(w).length > 0);
    const hit = hits(w)[0]; assert.equal(hit.crit, id !== 'steady'); assert.equal(hit.hitFlag, id === 'prism' ? 0 : 1);
    assert.equal(1000000 - e.hp, id === 'steady' ? 415 : 311); assert.equal(consumed(w).length, 1);
});
check('发出后才装备禁暴，不撤销旧弹体的暴击承诺', () => {
    const w = fixture(null, { cls: 1 }); foe(w, 7); grantNextCritical(w.player); cast(w);
    equip(w, make('steady')); step(w, .8); assert.equal(hits(w)[0].crit, true); assert.equal(hits(w)[0].damage, 311);
});
for (const cls of [2, 4]) for (const id of ['steady', 'prism']) check(id + ' 贯穿/爆炸传播同一发射契约 ' + cls, () => {
    const w = fixture(id, { cls }); const a = foe(w, 6.3, 3), b = foe(w, cls === 2 ? 7.8 : 6.6, 3);
    if (cls === 4) b.y += .8;
    grantNextCritical(w.player); swing(w, PLAYER_TIMING.attackHitStart); equip(w, plainArmor); step(w, 1);
    assert.equal(hits(w).length, 2); assert.equal(consumed(w).length, 1);
    for (const target of [a, b]) assert.equal(1000000 - target.hp, id === 'steady' ? 415 : 311);
    assert.ok(hits(w).every(h => h.crit === (id !== 'steady') && h.hitFlag === (id === 'steady' ? 1 : 0)));
});
check('禁暴下弹池拒绝不消耗必暴，技能冷却仍按原提交规则', () => {
    const w = fixture('steady'); w.danmaku = createDanmaku({ capacity: 1 });
    w.danmaku.emit('aimed', { x: 25, y: 2, angle: 0 }, { side: 'enemy', speed: 0, life: 9 });
    grantNextCritical(w.player); cast(w); assert.equal(consumed(w).length, 0); assert.equal(w.player.nextCritical, true);
    assert.ok(w.player.skills.slots[1].remaining > 0);
});
for (const id of ['steady', 'prism']) check(id + '真实必杀保留原顺序和一次消费，所有目标同一契约', () => {
    const w = fixture(id); foe(w, 8, 3); foe(w, 9, 3); w.player.skills.addGauge(w.player.skills.gaugeMax);
    assert.ok(w.useUltimate()); assert.equal(hits(w).length, 2);
    assert.ok(hits(w).every(h => h.crit === (id !== 'steady') && h.damage === (id === 'steady' ? 415 : 311)));
    assert.equal(consumed(w).length, 1); assert.equal(w.player.nextCritical, false);
});
check('自主卡按触发时契约，既不消费必暴也不因来源技能封印而停止', () => {
    const w = fixture('steady'); foe(w, 8, 3); const p = w.player;
    const card = { id: 9999, name: '计时卡夹具', loadFactor: 1, effects: [{ damage: true, target: 1, coef: .5, magic: false }] };
    placeSkillCard(p, 1, 9001, { card, count: 3 }, .25); grantNextCritical(p);
    step(w, .26); assert.equal(hits(w)[0].crit, false); assert.equal(p.nextCritical, true);
    equip(w, make('prism')); step(w, .25); assert.equal(hits(w)[1].hitFlag, 0); assert.equal(hits(w)[1].damage, 311);
    equip(w, make('binding')); assert.equal(p.skills.isSealed(1), true); step(w, .25);
    assert.equal(hits(w).length, 3); assert.equal(p.nextCritical, true); assert.equal(p.skillCards.length, 0);
});
check('弹池复用显式重置限制，敌方和下一发不继承契约', () => {
    const pool = createDanmaku({ capacity: 1 });
    pool.emit('aimed', { x: 1, y: 1, angle: 0 }, { side: 'player', noCrit: true, noAdvantage: true });
    let a; pool.forEach(b => { a = b; }); assert.equal(a.noCrit, true); assert.equal(a.noAdvantage, true);
    pool.clear(); pool.emit('aimed', { x: 1, y: 1, angle: 0 }, { side: 'enemy' });
    pool.forEach(b => { assert.equal(b, a); assert.equal(b.noCrit, false); assert.equal(b.noAdvantage, false); });
});

console.log(checks + ' checks, ' + failures + ' failures'); process.exitCode = failures ? 1 : 0;
