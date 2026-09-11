// Equipment explanations consume the same resolved slots/sources as combat.
import { passiveRuntime, SKILL_OVERRIDE_PRIORITY } from "../equipment.js";
import { decodeSkill, RECAST_SECONDS, TURN_SECONDS } from "../skills.js";
import { skillWords } from "./infocard.js";

const SLOTS = { weapon: "武器", amulet: "护符", armor: "护甲", charm: "饰品" };
const TARGETS = ["普攻", "技能 2", "技能 3"];
const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
};

export function skillSourceLabel(source) {
    if (!source) return "角色原技能";
    if (source.style) return "武器职业普攻";
    return (SLOTS[source.slot] || "装备") + " · "
        + (source.native ? "原生被动" : "附加词条 " + (source.affixIndex + 1));
}

const sourceKey = source => source ? [source.slot, source.affixId, source.affixIndex, source.native, source.style].join(":") : "";
const cooldown = skill => "基础冷却 " + Number((skill.cooldown || 0).toFixed(2)) + " 秒";

export function equipmentSkillRules() {
    const box = node("details", "equipment-skill-rules");
    box.appendChild(node("summary", "", "改技规则与优先级"));
    const rules = node("ul");
    for (const text of [
        "改技固定对应普攻、技能 2 或技能 3；未写改动的槽位不挪用。R 必杀永远保留角色原招。",
        "同一槽位只生效一条改技：" + SKILL_OVERRIDE_PRIORITY.map(slot => SLOTS[slot]).join(" > ") + "，不看拾取或装配顺序。",
        "同件装备：原生被动优先；多个附加词条冲突时，列表中靠后的词条优先。只覆盖声明的技能槽，不使整件装备失效。",
        "更换技能继承该按键的剩余冷却，不通过换装刷新；下次施放按新技能计算。这里展示基础冷却，不含临时恢复效果。",
        "封印不改变技能身份，只禁止施放；更换缚技护甲后解除，原有冷却继续计算。"
    ]) rules.appendChild(node("li", "", text));
    box.appendChild(rules);
    return box;
}

function facts(skill, turnSeconds, normal = false) {
    const body = node("div", "equipment-skill-facts");
    if (!skill) {
        body.appendChild(node("p", "skill-unadapted", "技能资料未加载，不能据此判断效果。"));
        return body;
    }
    body.appendChild(node("p", "skill-cooldown", skill.ultimate ? "R 必杀 · 消耗整条量能"
        : normal ? "普攻间隔随攻击方式与攻速变化" : cooldown(skill)));
    const list = node("ul");
    for (let word of skillWords(skill, turnSeconds)) {
        // Normal attacks use the held-weapon action geometry, not the turn-based
        // row's target count. Do not advertise an original all-target row as a ring.
        if (normal && ["自身", "环形", "指向"].includes(word)) continue;
        if (skill.damage && (word === "物理" || word === "魔法")) {
            word += "伤害 · 系数 " + skill.coef;
        }
        list.appendChild(node("li", word.startsWith("未适配：") ? "skill-unadapted" : "", word));
    }
    if (normal) list.appendChild(node("li", "", "范围由当前普攻动作与范围词条决定，不代表全屏攻击"));
    if (!skill.usable && !normal) list.prepend(node("li", "skill-unadapted", "当前没有已适配的可用效果"));
    body.appendChild(list);
    return body;
}

function skillCard(label, skill, source, sealed, turnSeconds, normal = false) {
    const card = node("section", "equipment-skill-card");
    card.dataset.skillId = skill?.id || "";
    card.dataset.sourceSlot = source?.slot || "character";
    card.dataset.sealed = String(!!sealed);
    card.append(node("h5", "", label), node("p", "equipment-skill-name", skill?.name || "无技能"),
        node("p", "equipment-skill-source", "来源：" + (normal && !source ? "角色职业普攻" : skillSourceLabel(source))));
    if (sealed) card.appendChild(node("p", "skill-seal-note", "缚技契约封印 · 更换护甲后可用"));
    card.appendChild(facts(skill, turnSeconds, normal));
    return card;
}

function entries(view) {
    return [{ key: "normal", label: "普攻", skill: view.normal, base: view.baseNormal,
        source: view.normalSource, normal: true, sealed: false },
    ...view.slots.map((skill, index) => ({ key: String(index), label: skill.ultimate ? "R 必杀" : "技能 " + (index + 1),
        skill, base: view.baseSlots[index], source: view.slotSources[index], normal: false,
        sealed: view.sealedSlots.includes(index) }))];
}

export function equipmentSkillComparison(preview) {
    if (!preview?.skills) return null;
    const { current, candidate } = preview.skills;
    const before = entries(current), after = entries(candidate);
    const section = node("section", "equipment-skill-comparison");
    section.append(node("h3", "", "本次技能变化"),
        node("p", "decision-muted", "以下是替换预览；确认前不改变装备或技能。"));
    const unchanged = [];
    // Changed class skills are the primary equipment decision, ahead of normals.
    for (const to of [...after.filter(entry => !entry.normal), ...after.filter(entry => entry.normal)]) {
        const from = before.find(entry => entry.key === to.key);
        const skillChanged = from?.skill?.id !== to.skill?.id;
        const sourceChanged = sourceKey(from?.source) !== sourceKey(to.source);
        if (!skillChanged && !sourceChanged && !!from?.sealed === !!to.sealed) {
            unchanged.push(to.label); continue;
        }
        const row = node("section", "equipment-skill-change");
        row.dataset.skillSlot = to.key;
        row.dataset.change = skillChanged ? "replacement" : from?.sealed !== to.sealed ? "seal" : "source";
        const reason = skillChanged ? "技能替换" : from?.sealed !== to.sealed
            ? (to.sealed ? "技能封印" : "解除封印") : "来源变化，技能效果相同";
        row.appendChild(node("h4", "", to.label + " · " + reason));
        const columns = node("div", "skill-change-columns");
        columns.append(skillCard("当前", from?.skill, from?.source, from?.sealed, current.turnSeconds, to.normal),
            skillCard("替换后", to.skill, to.source, to.sealed, candidate.turnSeconds, to.normal));
        row.appendChild(columns); section.appendChild(row);
    }
    section.appendChild(node("p", "equipment-skill-unchanged", "保留不变：" + unchanged.join("、") + "。"));
    section.appendChild(equipmentSkillRules());
    return section;
}

export function equipmentSkillOverview(view) {
    if (!view) return null;
    const section = node("section", "equipment-skill-overview");
    section.appendChild(node("h3", "", "当前技能与生效来源"));
    const grid = node("div", "equipment-skill-grid");
    const all = entries(view);
    for (const entry of [...all.filter(row => !row.normal && !row.skill.ultimate),
        ...all.filter(row => row.normal || row.skill.ultimate)]) {
        const card = skillCard(entry.label, entry.skill, entry.source, entry.sealed, view.turnSeconds, entry.normal);
        card.dataset.skillSlot = entry.key;
        if (entry.base?.id !== entry.skill?.id) {
            const original = node("details", "equipment-original-skill");
            original.append(node("summary", "", "角色原招：" + (entry.base?.name || "无")),
                facts(entry.base, view.turnSeconds, entry.normal));
            card.appendChild(original);
        }
        grid.appendChild(card);
    }
    section.append(grid, equipmentSkillRules());
    return section;
}

export function equipmentSkillModifiers(item, options) {
    if (!item) return null;
    const view = options.skillLoadout;
    let changes;
    try {
        changes = view ? view.replacements.filter(change => change.source.slot === item.slot)
            : passiveRuntime([item]).skillReplacements.map(change => {
                const row = (options.skillsTable?.weaponChildren || options.weapons?.childSkills || {})[change.skillId];
                return { ...change, skill: row ? decodeSkill(row, change.skillId,
                    options.skillsTable?.recastSeconds || RECAST_SECONDS, options.skillsTable?.skillCards) : null };
            });
    } catch (_) { return node("p", "skill-unadapted", "改技数据不可用"); }
    if (!changes.length) return null;
    // A repeated declaration inside one original passive is not a second benefit.
    const unique = new Map();
    for (const change of changes) {
        const key = change.target + ":" + change.skillId + ":" + sourceKey(change.source);
        if (!unique.has(key) || change.active) unique.set(key, change);
    }
    const section = node("section", "equipment-modifiers");
    section.appendChild(node("h4", "", "固定槽位改技"));
    for (const change of unique.values()) {
        const row = node("details", "equipment-modifier");
        row.dataset.target = change.target; row.dataset.active = String(!!change.active && !!change.skill);
        const summary = node("summary");
        summary.append(node("strong", "", TARGETS[change.target] + " → " + (change.skill?.name || "技能资料缺失")),
            node("span", "equipment-skill-source", skillSourceLabel(change.source)));
        row.appendChild(summary);
        const winner = (view?.replacements || changes).find(other => other.target === change.target && other.active);
        const classStart = view?.slots[0]?.ultimate ? 1 : 0;
        const sealed = change.target > 0 && view?.sealedSlots.includes(classStart + change.target - 1);
        const status = !change.skill ? "资料缺失，未生效" : change.active
            ? (view ? (options.previewing ? "替换后生效" : "当前生效") : "单件配置；装配结果以技能对照为准")
                + (sealed ? " · 但该按键被缚技契约封印" : "")
            : winner ? "被「" + skillSourceLabel(winner.source) + "」覆盖；这条改技不生效"
                : "该槽位未装配此技能";
        // Always visible: users must not open the detail to discover a conflict.
        summary.appendChild(node("span", change.active ? "modifier-effective" : "modifier-suppressed", status));
        row.appendChild(facts(change.skill, options.skillsTable?.turnSeconds || view?.turnSeconds || TURN_SECONDS, change.target === 0));
        section.appendChild(row);
    }
    section.appendChild(node("p", "decision-muted", "展开可看效果与基础冷却。改技覆盖不代表这件装备的其他词条全部失效。"));
    return section;
}
