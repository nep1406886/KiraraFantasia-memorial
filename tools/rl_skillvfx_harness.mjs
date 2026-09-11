// Test the actual original-effect catalogue selection, not source spellings
// from the removed procedural Points implementation. GPU ownership/lifetime,
// hitbox pixels and real input are checked by rl_projectile_visual_browser.py.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { graphicFor, projectileEvent, normalEffectConfig, ELEMENT_NAMES } from "../site/game/rl/view/effectcatalog.js";
import { weaponProfile } from "../site/game/rl/weaponprofile.js";
const root = new URL("../", import.meta.url);
const index = JSON.parse(readFileSync(new URL("site/asset/rl/native/index.json", root), "utf8"));
const before = JSON.stringify(index);
const classes = ["Fighter", "Magician", "Priest", "Knight", "Alchemist"];
const elements = ["fire", "water", "earth", "wind", "moon", "sun"];
assert.deepEqual(ELEMENT_NAMES, elements, "六属性的原作编号必须为火水土风月阳");
let checks = 1;
for (let job = 0; job < 5; job++) {
    for (let element = 0; element < 6; element++) {
        const unit = { element, card: { class: job } };
        const expected = index.graphics[classes[job] + "_attack:" + elements[element]];
        assert.ok(expected && expected.events.length, "原作普攻目录必须有实际事件");
        assert.equal(graphicFor(index, unit, null), expected);
        const crossClass = { element, card: { class: (job + 1) % 5 }, weaponProfile: { classId: job } };
        assert.equal(graphicFor(index, crossClass, null), expected, "普攻跟随装备职业，而非卡牌旧职业");
        const swing = { weaponProfile: weaponProfile({ class: job }), gadgets: { rate: 1.2, range: 1.25, width: 1.1 } };
        const saved = JSON.stringify(swing), effect = normalEffectConfig(swing);
        assert.equal(effect.duration, .25 / 1.2, "近战适配不改变当前攻速与特效寿命");
        assert.equal(effect.startFrame, job === 0 ? 9 : job === 3 ? 11 : undefined,
            "只对已过前摇的剑/枪衔接明确的原作出手帧");
        assert.equal(effect.combatPivot, job === 0 || job === 3 ? true : undefined,
            "身体支点不猜测套用到法术/治疗等原作场景");
        assert.equal(JSON.stringify(swing), saved, "表现配置不修改装备和世界快照");
        checks++;
        for (const event of expected.events.filter(row => row.kind.startsWith("Effect"))) {
            const asset = index.effects[event.effect];
            assert.ok(asset && asset.source.bundle && asset.source.sha256, "来源可追溯 " + event.effect);
            assert.equal(statSync(new URL(asset.file, root)).size, asset.bytes);
            assert.ok(statSync(new URL(asset.timeline, root)).size > 20);
        }
        checks++;
    }
}
// Projectile delivery is class-specific: Magician ships an authored
// EffectProjectile, Priest has to carry its EffectPlay line, and Alchemist has
// to carry its authored EffectAttach. Fighter/Knight are melee and must not
// invent a projectile from the same catalogue.
for (let element = 0; element < 6; element++) {
    const carried = (classId, skillId) => projectileEvent(
        graphicFor(index, { element, card: { class: classId }, weaponProfile: { classId } }, { id: skillId }));
    const magic = carried(1, 2);
    assert.equal(magic.effect, "ef_btl_magician_attack_" + elements[element] + "_01", "魔法师原作弹体");
    assert.equal(magic.kind, "EffectProjectile_Straight");
    const priest = carried(2, 3);
    assert.equal(priest.effect, "ef_btl_priest_attack_" + elements[element] + "_00", "牧师原作贯穿线");
    assert.deepEqual(priest.frameRange, [11, 19]);
    assert.equal(priest.flipLineV, element !== 5, "五条已测偏移线需要适配，阳属性本身已对齐");
    const alchemist = carried(4, 5);
    assert.equal(alchemist.effect, "ef_btl_alchemist_attack_" + elements[element] + "_01", "炼金术师原作投掷弹");
    assert.equal(alchemist.kind, "EffectAttach");
    assert.deepEqual(alchemist.frameRange, [12, 19]);
    assert.equal(carried(0, 1), null, "剑士普攻不投射弹体");
    assert.equal(carried(3, 4), null, "骑士普攻不投射弹体");
    checks++;
}
for (const [id, source] of Object.entries(index.skills)) {
    for (let element = 0; element < 6; element++) {
        const expected = index.graphics[source + ":" + elements[element]];
        if (!expected) { continue; }
        assert.equal(graphicFor(index, { element, card: { class: 0 } }, { id }), expected,
            "显式技能行优先于默认职业：" + id);
    }
    checks++;
}
assert.deepEqual(graphicFor({ skills: {}, graphics: {} }, { element: 0, card: { class: 1 } }, null),
    { source: "Magician_attack", events: [] }, "无原作映射必须明确回退，不能伪造来源");
assert.equal(JSON.stringify(index), before, "查询不修改共享目录");
checks += 2;
console.log("Skill VFX catalogue: " + checks + " checks passed; GPU results are separate");
