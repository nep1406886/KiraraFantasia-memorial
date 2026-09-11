#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { affixTableFromPassives, setAffixTable, passiveRuntime } from "../site/game/rl/equipment.js";
import { setWeaponCatalog } from "../site/game/rl/weaponcatalog.js";
import { createSkills } from "../site/game/rl/skills.js";
import { createWorld } from "../site/game/rl/world.js";
import { makeGadget } from "../site/game/rl/gadgets.js";

const load = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const weapons = load("weapons-rl.json"), table = { ...load("skills-rl.json"), weaponChildren: weapons.childSkills };
const raw = load("cards-rl.json"), cards = Array.isArray(raw) ? raw : raw.cards;
const card = cards.find(row => row.id === 14002001);
assert(card?.skillIds?.chara && card.skillIds.class.length === 2);
setAffixTable(affixTableFromPassives(weapons.passives));
setWeaponCatalog(weapons.catalog);
const item = (slot, ...affixes) => ({ slot, rarity: "epic", affixes });
const make = () => createSkills({ table, card, maxHp: 1000 });
const base = make();
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log("PASS", name); passed++; }
    catch (error) { console.error("FAIL", name, error.message); failed++; }
}

test("真实中间空位不把技能3挪到技能2", () => {
    for (const affix of ["12002011", "28012001", "31002001"]) {
        const skills = make(); skills.applyWeapon(passiveRuntime([item("amulet", affix)]));
        assert.equal(skills.slots[0].id, base.slots[0].id);
        assert.equal(skills.slots[1].id, base.slots[1].id);
        assert.equal(skills.slots[2].id, Number(affix + "3"));
    }
});
test("武器优先于其他装备，逐槽覆盖而不拼接", () => {
    const skills = make();
    skills.applyWeapon(passiveRuntime([item("weapon", "12022001"), item("amulet", "10022001")]));
    assert.deepEqual(skills.slots.map(slot => slot.id), [base.slots[0].id, 120220012, 120220013]);
});
test("固定槽位优先级与装备数组顺序无关", () => {
    const equipped = [item("amulet", "12002011"), item("armor", "10022001"), item("charm", "12022001")];
    function permutations(rows) { return rows.length ? rows.flatMap((row, i) => permutations(rows.filter((_, j) => j !== i)).map(tail => [row, ...tail])) : [[]]; }
    for (const order of permutations(equipped)) {
        const skills = make(); skills.applyWeapon(passiveRuntime(order));
        assert.deepEqual(skills.slots.map(slot => slot.id), [base.slots[0].id, 100220012, 120020113]);
    }
    for (const order of permutations([item("weapon", "32112001"), ...equipped])) {
        const skills = make(); skills.applyWeapon(passiveRuntime(order));
        assert.equal(skills.normal.id, 120020111);
        assert.deepEqual(skills.slots.map(slot => slot.id), [base.slots[0].id, 321120012, 120020113]);
    }
});
test("原生被动优先于同件附加词条", () => {
    const native = { slot: "weapon", rarity: "legendary", catalogId: 1202203, affixes: ["10022001"] };
    const skills = make(); skills.applyWeapon(passiveRuntime([native]));
    assert.deepEqual(skills.slots.map(slot => slot.id), [base.slots[0].id, 120220012, 120220013]);
});
test("同件词条后列优先且空位仍保留早先改写", () => {
    const skills = make(); skills.applyWeapon(passiveRuntime([item("armor", "10022001", "12002011")]));
    assert.deepEqual(skills.slots.map(slot => slot.id), [base.slots[0].id, 100220012, 120020113]);
});
test("全部原作type8按参数位置装配，重复行不挤占其他槽", () => {
    for (const [id, passive] of Object.entries(weapons.passives)) {
        const changes = passive.effects.filter(effect => effect.type === 8);
        if (!changes.length) continue;
        const expected = [base.normal.id, base.slots[1].id, base.slots[2].id];
        for (const change of changes) change.args.forEach((value, index) => { if (value > 0) expected[index] = value; });
        const skills = make(); skills.applyWeapon(passiveRuntime([item("charm", id)]));
        assert.deepEqual([skills.normal.id, skills.slots[1].id, skills.slots[2].id], expected, id);
        assert.equal(skills.ultimate, skills.slots[0]);
        assert.equal(skills.slots[0].id, base.slots[0].id);
    }
});
test("聚合结果记录生效和被覆盖来源", () => {
    const rt = passiveRuntime([item("weapon", "12022001"), item("armor", "10022001")]);
    const changes = rt.skillReplacements;
    assert(Array.isArray(changes));
    assert(changes.find(row => row.target === 1 && row.active && row.source.slot === "weapon"));
    assert(changes.find(row => row.target === 1 && !row.active && row.source.slot === "armor"));
});
test("改技被覆盖不取消该装备的其他被动", () => {
    const rt = passiveRuntime([item("amulet", "11022001"), item("weapon", "14002001")]);
    assert.equal(rt.normalOverride, 140020011);
    assert(Math.abs(rt.critDamage - .66) < 1e-9);
    assert(rt.skillReplacements.some(row => row.source.slot === "amulet" && !row.active));
});
test("更换技能继承按键剩余冷却，卸下不取回过期计时", () => {
    const skills = make(); skills.slots[2].remaining = 5;
    skills.applyWeapon(passiveRuntime([item("amulet", "10022001")]));
    assert.equal(skills.slots[2].remaining, 5);
    skills.update(1); skills.applyWeapon(passiveRuntime([]));
    assert.equal(skills.slots[2].remaining, 4);
    skills.applyWeapon(passiveRuntime([item("amulet", "10022001")]));
    assert.equal(skills.slots[2].remaining, 4);
});
test("同ID重算保留对象和冷却，但更新来源", () => {
    const skills = make(); skills.applyWeapon(passiveRuntime([item("armor", "10022001")]));
    const before = skills.slots[1]; before.remaining = 3;
    skills.applyWeapon(passiveRuntime([item("weapon", "10022001"), item("armor", "10022001")]));
    assert.equal(skills.slots[1], before);
    assert.equal(skills.slots[1].remaining, 3);
    assert.equal(skills.sourceFor(1).slot, "weapon");
});
test("只读技能快照隔离嵌套数据，保留原技能和具体来源", () => {
    const skills = make(); skills.applyWeapon(passiveRuntime([item("amulet", "10022001")]));
    const view = skills.describeLoadout();
    assert.equal(view.baseSlots[1].id, base.slots[1].id);
    assert.equal(view.slotSources[1].slot, "amulet");
    assert.equal(view.slots[1].id, skills.slots[1].id);
    const name = skills.slots[1].name; view.slots[1].name = "modified";
    view.slots[1].effects[0].args[0] = -987; view.slotSources[1].slot = "charm";
    assert.equal(skills.slots[1].name, name);
    assert.notEqual(skills.slots[1].effects[0].args[0], -987);
    assert.equal(skills.sourceFor(1).slot, "amulet");
});

const truth = { hp: 1000, atk: 100, mgc: 100, def: 100, mdef: 100, spd: 100, luck: 100 };
function worldWith(equipment = []) {
    const world = createWorld({ width: 32, height: 24, seed: 42, floor: 13,
        tables: { skills: table, stats: { statsFor: () => ({ ...truth }) } } });
    world.spawnPlayer({ card, x: 8, y: 8, equipment });
    return world;
}
function offer(world, candidate) {
    const drop = { x: world.player.x, y: world.player.y, items: [candidate] };
    world.drops.push(drop); return drop;
}
const identity = view => [view.normal.id, view.slots.map(slot => slot.id), view.normalSource, view.slotSources, view.sealedSlots];

test("真实世界预览不消耗随机数或改变技能、冷却、量能和装备", () => {
    const world = worldWith([item("armor", "10022001")]), p = world.player;
    p.skills.slots[2].remaining = 5; p.skills.addGauge(50);
    p.skills.buffs.push({ spd: .25, remaining: 2 });
    const before = JSON.stringify([p.equipment, p.base, p.skills.describeLoadout(), p.skills.buffs, p.skills.gauge]);
    let calls = 0; world.rng = () => { calls++; return .5; };
    const preview = world.previewEquipment(item("amulet", "12002011"));
    assert.equal(preview.skills.candidate.slots[2].id, 120020113);
    assert.equal(preview.skills.candidate.slots[2].remaining, 5);
    assert.equal(preview.skills.candidate.cooldownSeconds[2], p.skills.cooldownSeconds(2));
    preview.skills.current.slots[2].name = "not live";
    assert.equal(JSON.stringify([p.equipment, p.base, p.skills.describeLoadout(), p.skills.buffs, p.skills.gauge]), before);
    assert.equal(calls, 0);
});
test("保存失败不替换，成功提交与同一预览完全一致且只拾取一次", () => {
    const world = worldWith([item("armor", "10022001")]), p = world.player;
    const candidate = item("amulet", "12002011"), drop = offer(world, candidate);
    const expected = identity(world.previewEquipment(candidate).skills.candidate);
    const before = identity(p.skills.describeLoadout());
    assert.equal(world.takeDrop(drop, candidate, () => false), false);
    assert.deepEqual(identity(p.skills.describeLoadout()), before);
    assert.deepEqual(drop.items, [candidate]);
    let persisted;
    assert.equal(world.takeDrop(drop, candidate, payload => { persisted = payload; return true; }), true);
    assert.deepEqual(identity(p.skills.describeLoadout()), expected);
    assert.deepEqual(persisted.equipment, p.equipment);
    assert.equal(world.takeDrop(drop, candidate, () => { throw Error("must not write twice"); }), false);
});
test("真实换装继承冷却并清除身份已变的缓冲施法", () => {
    const world = worldWith(), p = world.player;
    p.skills.slots[2].remaining = 4.25;
    p.actionBuffer = { kind: "skill", slot: 2, remaining: .15 };
    const candidate = item("amulet", "12002011");
    assert(world.takeDrop(offer(world, candidate), candidate));
    assert.equal(p.skills.slots[2].remaining, 4.25);
    assert.equal(p.actionBuffer, null);
    const plain = item("amulet");
    p.skills.update(.25);
    assert(world.takeDrop(offer(world, plain), plain));
    assert.equal(p.skills.slots[2].id, base.slots[2].id);
    assert.equal(p.skills.slots[2].remaining, 4);
});
test("仅更换来源、不改变技能身份时不吞掉有效缓冲输入", () => {
    const world = worldWith([item("armor", "10022001")]), p = world.player;
    const buffer = { kind: "skill", slot: 1, remaining: .15 }; p.actionBuffer = buffer;
    const candidate = item("weapon", "10022001");
    assert(world.takeDrop(offer(world, candidate), candidate));
    assert.equal(p.actionBuffer, buffer);
    assert.equal(p.skills.sourceFor(1).slot, "weapon");
});
test("封印与改写分开显示，封印槽仍保留具体技能及来源", () => {
    const world = worldWith([item("amulet", "12002011")]), p = world.player;
    const binding = makeGadget("binding", undefined, 2);
    const preview = world.previewEquipment(binding);
    assert.equal(preview.skills.candidate.slots[2].id, 120020113);
    assert.equal(preview.skills.candidate.slotSources[2].slot, "amulet");
    assert.deepEqual(preview.skills.candidate.sealedSlots, [2]);
    assert(world.takeDrop(offer(world, binding), binding));
    assert.deepEqual(identity(p.skills.describeLoadout()), identity(preview.skills.candidate));
    assert.equal(p.skills.sourceFor(0), null);
    assert.equal(p.skills.isSealed(0), false);
});
test("存档装备重建技能与来源，不需要保存派生元数据", () => {
    const items = [item("charm", "10022001"), item("amulet", "12002011"), item("armor", "12022001")];
    const original = worldWith(items);
    const saved = JSON.parse(JSON.stringify(original.player.equipment));
    assert(saved.every(row => !Object.hasOwn(row, "skillReplacements") && !Object.hasOwn(row, "source")));
    const restored = worldWith(saved.reverse());
    assert.deepEqual(identity(restored.player.skills.describeLoadout()), identity(original.player.skills.describeLoadout()));
});
console.log(JSON.stringify({ passed, failed }));
process.exitCode = failed ? 1 : 0;
