import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld } from '../site/game/rl/world.js';
import { setAffixTable, affixTableFromPassives } from '../site/game/rl/equipment.js';
import { setWeaponCatalog } from '../site/game/rl/weaponcatalog.js';
import { GADGETS, gadgetRuntime, makeGadget } from '../site/game/rl/gadgets.js';
import { equipmentBrief } from '../site/game/rl/ui/equipmentbrief.js';

const json = name => JSON.parse(readFileSync(new URL('../site/asset/rl/' + name, import.meta.url), 'utf8'));
const weapons = json('weapons-rl.json'), cards = json('cards-rl.json').cards;
const table = { ...json('skills-rl.json'), weaponChildren: weapons.childSkills };
const card = cards.find(row => row.id === 22002001);
setAffixTable(affixTableFromPassives(weapons.passives)); setWeaponCatalog(weapons.catalog);
const truth = { hp: 1000, atk: 100, mgc: 100, def: 100, mdef: 100, spd: 100, luck: 100 };
const item = (slot, ...affixes) => ({ slot, rarity: 'epic', affixes });
const words = brief => [...brief.benefits, ...brief.costs, ...brief.notes].join('；');
function worldWith(equipment = []) {
    const world = createWorld({ width: 32, height: 24, seed: 42, floor: 13,
        tables: { skills: table, stats: { statsFor: () => ({ ...truth }) } } });
    world.spawnPlayer({ card, x: 8, y: 8, equipment }); return world;
}
let passed = 0, failed = 0;
function test(name, run) {
    try { run(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}

test('无有效预览时不伪造收益', () => {
    assert.deepEqual(equipmentBrief(null), { benefits: [], costs: [], notes: [], more: 0 });
});
test('简述只读，预览复用实际结算的被动与机制快照', () => {
    const world = worldWith([item('amulet', '12002011')]), p = world.player;
    p.skills.slots[2].remaining = 4; p.skills.addGauge(30);
    const before = JSON.stringify([p.base, p.equipment, p.passives, p.gadgets, p.skills.describeLoadout(), p.skills.gauge]);
    const candidate = makeGadget('binding', undefined, 2), view = world.previewEquipment(candidate);
    const source = JSON.stringify(view);
    for (let i = 0; i < 100; i++) equipmentBrief(view);
    assert.equal(JSON.stringify(view), source);
    assert.equal(JSON.stringify([p.base, p.equipment, p.passives, p.gadgets, p.skills.describeLoadout(), p.skills.gauge]), before);
    assert.deepEqual(view.gadgets.candidate, gadgetRuntime([...p.equipment, candidate]));
    assert.notStrictEqual(view.passives.current, p.passives);
    const drop = { x: p.x, y: p.y, items: [candidate] }; world.drops.push(drop);
    assert(world.takeDrop(drop, candidate));
    assert.deepEqual(p.base, view.candidate); assert.deepEqual(p.passives, view.passives.candidate);
    assert.deepEqual(p.gadgets, view.gadgets.candidate);
});
for (const row of GADGETS) {
    test(row.id + '使用实际机制参数，强力代价不折叠', () => {
        const view = worldWith().previewEquipment(makeGadget(row.id, undefined, row.sealSkill ? 2 : undefined));
        const brief = equipmentBrief(view), text = words(brief);
        assert(text.length > 0); assert(brief.benefits.length <= 3);
        if (row.rate) assert(text.includes('普攻速度 +20%'));
        if (row.attackMove) assert(text.includes('55%移速'));
        if (row.range) assert(text.includes('普攻距离 +25%'));
        if (row.width) assert(text.includes('普攻宽度 +30%'));
        if (row.normalDamage) assert(brief.costs.some(word => word.includes('普攻伤害')));
        if (row.damage) assert(brief.costs.some(word => word.includes('物攻')) && brief.costs.some(word => word.includes('魔攻')));
        if (row.defense) assert(brief.costs.some(word => word.includes('物防')) && brief.costs.some(word => word.includes('魔防')));
        if (row.noCrit) assert(brief.costs.includes('不能暴击（含必暴）'));
        if (row.noAdvantage) assert(brief.costs.includes('失去有利属性加成'));
        if (row.sealSkill) assert(brief.costs.some(word => word.includes('技能 3「' + view.skills.candidate.slots[2].name + '」被封印')));
        if (row.assist >= 2) assert(brief.benefits.some(word => word.includes('可开启')));
    });
}
test('改技只列实际变化，不把被覆盖的技能当收益', () => {
    const world = worldWith([item('amulet', '12002011')]);
    const view = world.previewEquipment(item('armor', '10022001')), brief = equipmentBrief(view);
    assert(brief.benefits.some(word => word.includes('技能 2 → ' + view.skills.candidate.slots[1].name)));
    assert(!brief.benefits.some(word => word.includes('技能 3')));
    assert(brief.notes.some(word => word.includes('技能 3改写被覆盖')));
    assert(!words(brief).includes('R 必杀'));
});
test('相同技能只换来源时不伪称得到新技能', () => {
    const world = worldWith([item('armor', '10022001')]);
    const brief = equipmentBrief(world.previewEquipment(item('amulet', '10022001')));
    assert(!brief.benefits.some(word => word.includes('技能 2') || word.includes('技能 3')));
});
test('自动追敌已经生效时，瞄准饰章不伪造额外索敌收益', () => {
    const world = worldWith([makeGadget('hunter')]);
    const brief = equipmentBrief(world.previewEquipment(makeGadget('aim')));
    assert(!brief.benefits.some(word => word.includes('瞄准') || word.includes('自动')));
});
test('切换契约解除旧代价，新代价与真实技能身份保留', () => {
    const world = worldWith([makeGadget('binding', undefined, 2), item('amulet', '12002011')]);
    const brief = equipmentBrief(world.previewEquipment(makeGadget('steady')));
    assert(brief.benefits.includes('技能 3恢复可用'));
    assert(brief.costs.includes('不能暴击（含必暴）'));
    assert(brief.costs.includes('不再自动追敌'));
    assert(!words(brief).includes('被封印'));
});
test('跨职业熟练度折损在默认简述中可见', () => {
    const row = weapons.catalog.find(row => row.charaId < 0 && row.class !== card.class);
    const candidate = { slot: 'weapon', rarity: 'rare', catalogId: row.id, affixes: [] };
    const view = worldWith().previewEquipment(candidate), brief = equipmentBrief(view);
    assert.equal(view.style.candidate.proficiency, .65);
    assert(brief.costs.some(word => word.includes('65%')));
});
test('净差值来自完整配装，而不是候选装备的裸加成', () => {
    const world = worldWith([makeGadget('rhythm')]);
    const brief = equipmentBrief(world.previewEquipment(makeGadget('wide')));
    // rhythm's calibrated normalDamage is .75; adding wide gives .75 * .88,\n    // so the complete-loadout net is 12% below the current rhythm loadout.\n    assert(brief.costs.includes('普攻伤害 −12%'));\n    assert(!brief.costs.some(word => word.includes('普攻速度')));
    assert(brief.benefits.includes('普攻宽度 +30%'));
});
test('收益最多三项并计数，所有负向面板变化始终保留', () => {
    const view = worldWith().previewEquipment(item('armor'));
    // Deliberately synthetic large summary; this does not change live combat.
    for (const key of Object.keys(truth)) view.candidate[key] = view.current[key] + 10;
    const positive = equipmentBrief(view);
    assert.equal(positive.benefits.length, 3); assert.equal(positive.more, 4);
    for (const key of Object.keys(truth)) view.candidate[key] = view.current[key] - 10;
    const negative = equipmentBrief(view);
    assert.equal(negative.costs.length, 7); assert.equal(negative.more, 0);
});
test('全原作词条简述有界、不改预览、不输出未定义值', () => {
    const world = worldWith();
    for (const id of Object.keys(weapons.passives)) {
        const view = world.previewEquipment(item('amulet', id));
        assert(view, id); const before = JSON.stringify(view), brief = equipmentBrief(view);
        assert(brief.benefits.length <= 3, id); assert.equal(JSON.stringify(view), before, id);
        assert(!/undefined|NaN|Infinity/.test(words(brief)), id);
    }
});
console.log(JSON.stringify({ passed, failed }));
process.exitCode = failed ? 1 : 0;
