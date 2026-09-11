import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSkills, decodeSkill } from "../site/game/rl/skills.js";
import { skillBrief } from "../site/game/rl/ui/skilltooltip.js";
import { PLAYABLE_IDS } from "../site/game/rl/rosterids.js";

const json = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const table = json("skills-rl.json"), cards = json("cards-rl.json").cards;
let checks = 0;
function check(name, run) { run(); checks++; console.log("PASS " + name); }

for (const id of PLAYABLE_IDS) {
    check("当前卡 " + id + " 的三个技能简述只读且使用实际效果", () => {
        const skills = createSkills({ table, card: cards.find(card => card.id === id), maxHp: 1000 });
        for (const slot of skills.slots) {
            if (!slot) continue;
            const before = JSON.stringify(slot), brief = skillBrief(slot, skills.turnSeconds);
            assert.equal(JSON.stringify(slot), before);
            assert.ok(brief.effects.length > 0 || brief.note.includes("未适配"));
            assert.ok(brief.effects.length <= 3);
            assert.ok(!JSON.stringify(brief).includes("undefined"));
            if (slot.damage) assert.ok(brief.effects.some(effect => effect.includes("系数 " + slot.coef)));
            if (slot.unhandled.length) assert.ok(brief.note.includes("未适配："));
        }
    });
}
check("多效果简述说明省略数量而不伪装成完整技能", () => {
    const slot = decodeSkill({ target: 0, effects: [{ kind:2,target:0,args:[1,3,10,20,30,40,1,10] }] }, 1, .35);
    const brief = skillBrief(slot);
    assert.equal(brief.effects.length, 3); assert.ok(brief.note.includes("另有 2 项效果"));
});
check("缺失资料有明确降级而非空白气泡", () => {
    assert.equal(skillBrief(null).note, "暂无技能资料");
});
console.log(checks + " skill brief checks passed");
