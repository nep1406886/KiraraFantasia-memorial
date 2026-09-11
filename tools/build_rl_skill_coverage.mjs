// Generate the T25 coverage ledger without overwriting authored design.
// node tools/build_rl_skill_coverage.mjs [--check]
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeSkill, PLAYER_RECOVERY_RATE } from "../site/game/rl/skills.js";
import { PLAYABLE_ROSTER } from "../site/game/rl/rosterids.js";
import { weaponProfile } from "../site/game/rl/weaponprofile.js";
import { skillWords } from "../site/game/rl/ui/infocard.js";

const root = new URL("../", import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const cardsData = read("site/asset/rl/cards-rl.json");
const cards = Array.isArray(cardsData) ? cardsData : cardsData.cards;
const table = read("site/asset/rl/skills-rl.json");
const sceneIndex = read("site/asset/uniqueskill/scene-index.json").scenes;
const weapons = read("site/asset/rl/weapons-rl.json");
const design = read("docs/combat-identities.json");
const roster = PLAYABLE_ROSTER;
assert.ok(roster.length > 0, "playable roster is not empty");
assert.equal(new Set(roster.map(row => row.id)).size, roster.length, "roster IDs are unique");
assert.deepEqual(read("site/asset/rl/playable-roster.json").cards, roster, "generated roster sources agree");
assert.equal(new Set(design.profiles.map(p => p.class)).size, 5, "historical representatives retain five classes");
const classes = ["战士", "魔法使", "僧侣", "骑士", "炼金术士"];
const elements = ["火", "水", "土", "风", "月", "阳"];
const reasons = {
    3: "该能力解除的目标或掩码未适配；合法六位清正负变化，七位末项0/1分别仅清降低/提高。",
    4: "自身异常仅支持不幸（治疗封锁）；其余异常未适配，不转嫁给敌人。",
    5: "仅支持玩家治疗封锁解除；其余异常掩码或敌方目标尚未适配。",
    6: "当前仅免疫治疗封锁，不清除已有封锁；其余原作异常免疫未适配。",
    7: "异常概率修正没有对应的概率结算管线。",
    9: "战斗中属性变更尚未接入。",
    10: "该克制强化的目标或参数未适配；有效友方效果只提高有利属性倍率。",
    12: "该必暴的目标或参数未适配；仅支持玩家目标0/3/4的空参数授予，敌方支援脚本仍待调度。",
    16: "技能来源的必杀槽获取倍率尚未接入。",
    17: "实时战斗没有原作行动队列。",
    18: "单人模式敌人始终瞄准玩家，仇恨变化无作用。",
    19: "没有原作回合蓄力槽。",
    20: "没有多人连携倍率。",
    21: "该技能卡引用、目标或子效果尚未适配；不创建无载荷的计时器。",
    22: "玩家没有原作眩晕槽。",
    24: "后续版本效果，现存旧版枚举不足以确认其参数含义。"
};
const passiveNotes = {
    0: "常驻或受击/击杀叠层属性", 1: "单人仇恨，无实际作用",
    2: "常驻治疗封锁免疫；其他异常未适配", 3: "玩家无眩晕槽，无实际作用",
    4: "眩晕累积倍率", 5: "受击获得量能", 6: "量能倍率",
    7: "暴击伤害", 8: "替换普攻与职业技能行", 9: "超上限治疗",
    10: "伤害回血", 11: "每层致死保护", 12: "放置/刷新时增加技能卡触发次数",
    13: "原作生命曲线效果未适配", 14: "受击后敌方攻击减益"
};

function skill(row, id, ultimate = false) {
    assert.ok(row, "missing skill row " + id);
    const decoded = decodeSkill(row, id, table.recastSeconds, table.skillCards);
    decoded.ultimate = ultimate;
    const unsupported = decoded.unhandled.map(kind => ({ kind,
        reason: reasons[kind] || "没有已验证的实时适配，保留原参数。" }));
    for (const effect of row.effects || []) {
        if (effect.kind === 0 && effect.args.slice(2).some(v => v !== 0)) {
            unsupported.push({ kind: 0, field: "extraArgs", reason: "条件伤害等附加参数未适配，仅使用原行基础系数与物理/魔法类型。" });
        }
    }
    return {
        id, role: ultimate ? "ultimate" : "skill",
        original: { name: row.name, detail: row.detail, target: row.target,
            action: row.action || null, sceneId: row.sceneId || null,
            coef: row.coef, magic: row.magic, effects: row.effects },
        executable: { damage: decoded.damage, coef: decoded.coef, magic: decoded.magic,
            target: decoded.target, delivery: ultimate ? "original-target" : decoded.delivery,
            cooldown: ultimate ? null : decoded.cooldown, usable: decoded.usable,
            heal: decoded.heal, buffs: decoded.buffs, barrier: decoded.barrier,
            recastMod: decoded.recastMod, gauge: decoded.gauge,
            nextAtk: decoded.nextAtk, regen: decoded.regen, slow: decoded.slow,
            resists: decoded.resists, weakBonuses: decoded.weakBonuses, statusEffects: decoded.statusEffects,
            cardPlacements: decoded.cardPlacements, statResets: decoded.statResets, nextCriticals: decoded.nextCriticals },
        labels: skillWords(decoded, table.turnSeconds), unsupported
    };
}

const records = roster.map(identity => {
    const id = identity.id;
    const row = cards.find(c => c.id === id);
    assert.ok(row, "missing roster card " + id);
    assert.equal(row.class, identity.class, "playable class " + id);
    assert.equal(row.rare, 5, "playable five-star card " + id);
    assert.equal(row.resourceId, identity.resourceId, "playable model " + id);
    const historical = design.profiles.find(p => p.cardId === identity.legacyId);
    const profile = (design.currentProfiles || []).find(p => p.cardId === id);
    if (profile) assert.equal(profile.class, row.class, "current representative class " + id);
    const attack = weaponProfile(row);
    const ids = [row.skillIds.chara, ...row.skillIds.class];
    assert.equal(ids.length, 3, "one ultimate and two character skills " + id);
    const skills = ids.map((skillId, i) => skill(table.player[skillId], skillId, i === 0));
    const normal = table.normalAttacks[row.class];
    const mappings = row.dedicatedWeapon
        ? weapons.weapons.filter(w => w.weaponId === row.dedicatedWeapon.id) : [];
    const passives = mappings.map(m => weapons.passives[m.charaId]).filter(Boolean);
    const children = [...new Set(passives.flatMap(p => p.effects
        .filter(e => e.type === 8).flatMap(e => e.args).filter(child => child > 0)))];
    return {
        cardId: id, sourceId: identity.sourceId, legacyId: identity.legacyId,
        resourceId: row.resourceId, name: row.characterZh || row.nameZh || row.name,
        class: { id: row.class, name: classes[row.class] },
        element: { id: row.element, name: elements[row.element] },
        normal: skill(normal, normal.id), skills,
        ultimate: { sourceSkillId: row.skillIds.chara,
            originalEffects: table.player[row.skillIds.chara].effects,
            sceneId: table.player[row.skillIds.chara].sceneId,
            presentation: !table.player[row.skillIds.chara].sceneId ? "原作职业动作"
                : sceneIndex[table.player[row.skillIds.chara].sceneId] ? "原作完整场景" : "本地场景缺失，战场动作回退",
            execution: "独立满槽消费，按原作顺序执行支持的子效果；单体锁最近存活敌人，全体锁当前存活敌人；不消费普攻强化、不从自身伤害回充，演出失败不重复结算。",
            status: skills[0].executable.usable ? "已接入支持的战斗载荷，特殊效果缺口见 unsupported" : "无可执行效果，禁止消费" },
        weapon: { dedicated: row.dedicatedWeapon, mappings,
            passives: passives.map(p => ({ charaId: p.charaId, detail: p.detail,
                effects: p.effects.map(e => ({ ...e, adaptation: passiveNotes[e.type] || "未确认" })) })),
            childSkills: children.map(child => skill(weapons.childSkills[child], child)),
            note: "专武与进化行按 weaponId 关联；普通掉落还可抽取全局词缀，详情由装备运行时决定。" },
        defaultAttack: attack,
        effectiveRange: "默认职业普攻：" + attack.name + "，距离 " + attack.range
            + " 单位；命中宽度/半径见 defaultAttack，换武器会改变普攻。普通单体伤害技能为指向弹，全体为环形弹；非伤害单体减益选最近存活敌人；必杀按原行目标直接结算。",
        resources: ["两个独立技能冷却", "生命", "独立必杀槽"],
        identity: profile || { cycle: "尚未逐人设计独特循环；本行仅审计现有可执行效果。" },
        validation: profile && profile.validation ? profile.validation : {
            logic: { status: "仅字段审计，当前卡的逐角色实战未完成" },
            browser: { status: "当前卡的完整输入/生态段验证待完成" }
        },
        historicalEvidence: historical ? {
            cardId: historical.cardId, class: historical.class,
            transferable: false, sameClass: historical.class === row.class,
            reason: "仅保留旧卡证据；同名、同职业或叙事身份相同均不代表技能行相同。",
            identity: historical, validation: design.validation
        } : null
    };
});
const report = {
    schemaVersion: 3,
    sources: ["site/asset/rl/playable-roster.json", "site/game/rl/rosterids.js", "site/asset/rl/cards-rl.json",
        "site/asset/rl/skills-rl.json", "site/asset/rl/weapons-rl.json", "site/game/rl/weaponprofile.js"],
    design: "docs/combat-identity-design.md",
    playerSpeedAdaptation: { source: "docs/skill-recovery-design.md", affects: "ordinary-skill-recovery",
        rate: PLAYER_RECOVERY_RATE, movementAndBasicAttacksUnchanged: true },
    weakElementAdaptation: { source: "docs/weak-element-bonus-design.md",
        appliesTo: "favourable-element-coefficient", projectileTiming: "offence-snapshot" },
    skillCardAdaptation: { source: "docs/skill-card-design.md", namespace: "CARD",
        interval: "turnSeconds * loadFactors[0]", sourceSlotLimit: 4, normalSourceSlot: 3, persisted: false,
        references: Object.keys(table.skillCards || {}).map(Number) },
    playerStatusAdaptation: { source: "docs/healing-lock-design.md", supportedIndex: 5,
        turns: 2, blocks: ["ordinary-skill-heal", "ultimate-heal", "regen", "lifesteal"],
        otherAilmentsUnsupported: true, persisted: false },
    statResetAdaptation: { source: "docs/stat-reset-design.md", legacySixMasks: "both-signs",
        seventhFlag: { 0: "down-only", 1: "up-only" }, temporaryStatsOnly: true,
        playerStats: ["atk", "mgc", "def", "mdef", "spd", "luck"],
        enemyHitRows: [15017, 114074, 143002], enemySelfAndSupportUnimplemented: true, persisted: false },
    nextCriticalAdaptation: { source: "docs/next-critical-design.md", weaponChild: 320320013,
        consumption: "committed-player-damage-action", includes: ["normal", "skill", "ultimate"],
        excludes: ["CARD", "enemy-support"], projectileTiming: "launch-snapshot",
        whiffRefund: false, rejectedEmissionConsumes: false, persisted: false },
    characters: records,
    totals: { characters: records.length, activeSkills: records.length * 2, ultimates: records.length,
        sourceSkills: records.reduce((n, c) => n + c.skills.length, 0),
        representatives: (design.currentProfiles || []).length,
        historicalRepresentatives: design.profiles.length,
        unusableSourceSkills: records.reduce((n, c) => n + c.skills.filter(s => !s.executable.usable).length, 0),
        sourceSkillsWithGaps: records.reduce((n, c) => n + c.skills.filter(s => s.unsupported.length).length, 0) }
};
const md = s => String(s).replace(/\|/g, "／").replace(/[\r\n]+/g, " ");
const lines = ["# T30：当前 " + report.totals.characters + " 人技能覆盖账本", "",
    "由 `node tools/build_rl_skill_coverage.mjs` 生成；`--check` 检查账本是否与当前代码、数据和验收记录一致。", "",
    "逐技能的原作参数、可执行字段、专武进化行与未处理理由见 [完整 JSON](skill-coverage.json)。手写决策见 [适配设计](combat-identity-design.md)。", "",
    "覆盖 " + report.totals.characters + " 人、" + report.totals.activeSkills + " 个普通技能及 "
        + report.totals.ultimates + " 个独立必杀，共 " + report.totals.sourceSkills + " 个来源槽位。字段齐全不等于每人都完成实战。", "",
    "可玩名单只由 rosterids.js 与 playable-roster.json 决定，不按持久身份集合计数。旧五代表按 historicalEvidence 保留，绝不自动转移到当前进化卡。名单与时间适配决定见 [当前设计](skill-recovery-design.md)。", "",
    "必杀已接入原作支持效果与精确场景编号，见 [技能与演出设计](skill-playback-design.md)。玩家速度适配为普通技能恢复，合计限0.5–2倍，不改变移动/普攻；其余未适配效果继续明确披露。", "",
    "| 角色／ID | 职业／属性 | 必杀与普通技能效果 | 未处理效果 | 循环与验收 |", "|---|---|---|---|---|"];
for (const c of records) {
    const gaps = [...new Set(c.skills.flatMap(s => s.unsupported.map(u => u.reason)))];
    lines.push("| " + [c.name + "／" + c.cardId, c.class.name + "／" + c.element.name,
        c.skills.map((s, i) => (i === 0 ? "R 必杀" : "技能 " + (i + 1)) + ": " + s.labels.join("、")).join("；"),
        gaps.join("；") || "三技能未发现未处理种类；不含上方全局缺口",
        c.identity.cycle + " 逻辑：" + c.validation.logic.status + "；浏览器：" + c.validation.browser.status
    ].map(md).join(" | ") + " |");
}
lines.push("", "原作技能中存在明确未适配项的槽位：" + report.totals.sourceSkillsWithGaps + "／" + report.totals.sourceSkills + "；没有可执行载荷的槽位：" + report.totals.unusableSourceSkills + "。", "",
    "距离与主要资源、普攻／必杀和武器逐行证据均在 JSON 中；账本再生成不运行浏览器，验收状态只引用手写设计文件中的已记录结果。", "");

for (const [path, content] of [
    ["docs/skill-coverage.json", JSON.stringify(report, null, 2) + "\n"],
    ["docs/skill-coverage.md", lines.join("\n")]
]) {
    if (process.argv.includes("--check")) {
        assert.equal(readFileSync(new URL(path, root), "utf8"), content, "stale generated ledger: " + path);
    } else {
        writeFileSync(new URL(path, root), content);
    }
}
console.log("Skill coverage: " + report.totals.characters + " characters, " + report.totals.activeSkills
    + " ordinary skills, " + report.totals.ultimates + " ultimates, "
    + report.totals.sourceSkillsWithGaps + " slots with documented gaps; historical evidence is not transferred");
