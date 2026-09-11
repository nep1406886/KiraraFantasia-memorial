// 人物卡 / 技能卡 overlays (T22i, feedback item 10): every character and
// skill must be inspectable — the roster's 人物卡 before committing to a
// run, and the in-run 技能卡 from the pause menu at any time (「游戏内可
// 随时查看」).
//
// Styling follows the same tokens as roster.js: paper panels, rounded, the
// element is one small accent, never a dye. All overlays freeze the world
// through their callers (roster is pre-run; the in-run card is opened from
// the pause menu, which already froze it).

// decodeSkill is the game's own decoder; the roster card must show skills
// exactly as a run would decode them, so it is imported, never re-derived.
import { decodeSkill, PLAYER_RECOVERY_RATE, TURN_SECONDS } from "../skills.js";
import { SKILL_ICON_BY_TYPE, ELEMENT_TINT } from "./skillart.js";

const INFOCARD_CSS = `
    .rl-infocard * { box-sizing: border-box; }
    .rl-infocard {
        position: fixed;
        inset: 0;
        z-index: 1200;
        overflow-y: auto;
        background: var(--kf-veil);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: clamp(12px, 3vmin, 32px);
        font-family: var(--font-sans);
        color: var(--kf-ink);
    }
    .rl-infocard .sheet {
        background: var(--kf-paper);
        border: 1.5px solid var(--kf-ink-soft);
        border-radius: 16px;
        box-shadow: 0 8px 24px var(--kf-shadow);
        width: min(560px, 100%);
        max-height: 100%;
        overflow-y: auto;
        padding: clamp(16px, 3vmin, 28px);
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    .rl-infocard .head {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: none;
    }
    .rl-infocard .head .art {
        flex: none;
        width: clamp(72px, 14vmin, 104px);
        aspect-ratio: 3 / 4;
        border-radius: 9px;
        object-fit: cover;
        background: var(--kf-mint);
        display: block;
    }
    .rl-infocard .head .who {
        min-width: 0;
        flex: 1;
    }
    .rl-infocard .head .who .nm {
        font-family: var(--font-serif);
        font-size: clamp(1.2rem, 3.4vw, 1.7rem);
        font-weight: 700;
        letter-spacing: 0.03em;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .rl-infocard .head .who .nm .el {
        flex: none;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        border: 1px solid var(--kf-ink-soft);
    }
    .rl-infocard .head .who .ttl {
        color: var(--kf-ink-soft);
        font-size: 0.85rem;
        margin-top: 2px;
    }
    .rl-infocard .head .who .cv {
        color: var(--kf-ink-soft);
        font-size: 0.78rem;
        margin-top: 2px;
    }
    .rl-infocard .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        flex: none;
    }
    .rl-infocard .tag {
        font-size: 0.75rem;
        padding: 2px 10px;
        border: 1px solid var(--kf-ink-soft);
        border-radius: 999px;
        color: var(--kf-ink);
        background: var(--kf-paper);
    }
    .rl-infocard .profile {
        font-size: 0.9rem;
        line-height: 1.7;
        white-space: pre-line;
        border-top: 1px dashed var(--kf-ink-soft);
        padding-top: 10px;
    }
    .rl-infocard .statblock {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        font-size: 0.8rem;
        font-variant-numeric: tabular-nums;
        color: var(--kf-ink);
        border-top: 1px dashed var(--kf-ink-soft);
        padding-top: 10px;
    }
    .rl-infocard .statblock .k {
        color: var(--kf-ink-soft);
        margin-right: 4px;
    }
    .rl-infocard .skill {
        border: 1px solid var(--kf-ink-soft);
        border-radius: 10px;
        padding: 10px 12px;
    }
    .rl-infocard .skill .skname .skicon {
        width: 30px;
        height: 30px;
        flex: none;
        align-self: center;
    }
    /* Attack/magic glyphs are white silhouettes — the original multiplies
       them by UIUtility.GetIconColor(elementType), whose authored switch has
       a +1 offset (Fire→grey, Water→red-orange, …). The mask keeps the
       glyph shape; the background carries the tint. Recovery/buff/debuff
       keep their authored art colours (plain img). */
    .rl-infocard .skill .skicon.silhouette {
        -webkit-mask: var(--skicon-url) center / contain no-repeat;
        mask: var(--skicon-url) center / contain no-repeat;
        background: var(--skicon-tint, var(--kf-ink-soft));
    }
    .rl-infocard .skill .skicon.plain {
        object-fit: contain;
    }
    .rl-infocard .skill .skname {
        font-weight: 600;
        display: flex;
        gap: 8px;
        align-items: baseline;
        flex-wrap: wrap;
    }
    .rl-infocard .skill .skname .cd {
        font-size: 0.72rem;
        color: var(--kf-ink-soft);
        font-variant-numeric: tabular-nums;
    }
    .rl-infocard .skill .skdetail {
        font-size: 0.82rem;
        line-height: 1.6;
        white-space: pre-line;
        color: var(--kf-ink);
        margin-top: 4px;
    }
    .rl-infocard .skill .skwords {
        margin-top: 6px;
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
    }
    .rl-infocard .skill .word {
        font-size: 0.7rem;
        padding: 1px 8px;
        border-radius: 999px;
        background: var(--kf-mint);
        color: var(--kf-ink);
        border: 1px solid transparent;
    }
    .rl-infocard .section {
        font-size: 0.8rem;
        color: var(--kf-ink-soft);
        letter-spacing: 0.12em;
    }
    .rl-infocard .close-row {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        flex: none;
    }
    .rl-infocard .close-row button {
        font: inherit;
        font-weight: 600;
        padding: 0.6rem 1.6rem;
        background: var(--kf-paper);
        color: var(--kf-ink);
        border: 1.5px solid var(--kf-ink-soft);
        border-radius: 999px;
        cursor: pointer;
        box-shadow: 0 2px 0 var(--kf-shadow);
    }
    .rl-infocard .close-row button:hover,
    .rl-infocard .close-row button:focus-visible {
        border-color: var(--kf-gold);
        outline: none;
    }
    .rl-infocard .close-row button:focus-visible {
        outline: 2px solid var(--kf-gold);
        outline-offset: 2px;
    }
    .rl-infocard .close-row button.primary {
        background: var(--kf-gold);
        border-color: var(--kf-gold);
        color: var(--kf-paper);
    }
    @media (prefers-reduced-motion: reduce) {
        .rl-infocard .close-row button { transition: none; }
    }
`;

let stylesInjected = false;

function injectStyles() {
    if (stylesInjected || document.getElementById("rl-infocard-style")) {
        stylesInjected = true;
        return;
    }
    const style = document.createElement("style");
    style.id = "rl-infocard-style";
    style.textContent = INFOCARD_CSS;
    document.head.appendChild(style);
    stylesInjected = true;
}

// 词条: the runtime slot already resolved the original effect kinds into a
// combat-translation vocabulary (skills.js decodeSkill) — surface those as
// the word chips the plan calls 词条.
export function skillWords(slot, turnSeconds = TURN_SECONDS) {
    const words = [];
    if (slot.damage) {
        words.push(slot.magic ? "魔法" : "物理");
    }
    if (slot.heal > 0) {
        words.push("回复 " + Math.round(slot.heal * 100) + "%");
    }
    const buffs = slot.buffs && slot.buffs.length ? slot.buffs : (slot.buff ? [slot.buff] : []);
    buffs.forEach(function (b) {
        const names = { atk: "物攻", mgc: "魔攻", def: "物防", mdef: "魔防",
                        spd: "行动速度", luck: "幸运" };
        const enemy = b.target === 1 || b.target === 2;
        Object.keys(names).forEach(function (k) {
            if (b[k]) {
                if (k === "spd" && !enemy) {
                    words.push("自身技能恢复速度" + (b.spd > 0 ? "+" : "")
                        + Number((b.spd * 100).toFixed(1)) + "%"
                        + (b.turns ? "×" + b.turns + "回合" : "")
                        + "（合计" + PLAYER_RECOVERY_RATE.min + "–" + PLAYER_RECOVERY_RATE.max
                        + "倍，不改变移动/普攻）");
                    return;
                }
                words.push((enemy ? "敌方" : "自身") + names[k] + (b[k] > 0 ? "+" : "")
                    + Math.round(b[k] * 100) + "%"
                    + (b.turns ? "×" + b.turns + "回合" : ""));
            }
        });
    });
    (slot.statResets || []).forEach(function (reset) {
        const enemy = reset.target === 1 || reset.target === 2;
        const names = { atk: "物攻", mgc: "魔攻", def: "物防", mdef: "魔防",
            spd: enemy ? "行动速度" : "技能恢复速度", luck: "幸运" };
        const target = reset.target === 1 ? "敌方单体" : reset.target === 2 ? "敌方全体" : "自身";
        const direction = { down: "降低效果（保留提高）", up: "提高效果（保留降低）", all: "正负变化" };
        words.push("解除" + target + reset.stats.map(key => names[key]).join("、") + direction[reset.mode]);
    });
    if (slot.barrier) {
        words.push("护盾 " + Math.round(slot.barrier.cut * 100) + "%×"
            + slot.barrier.hits + "次");
    }
    for (const change of slot.recastChanges || []) {
        words.push("立即" + (change.ratio < 0 ? "缩短" : "增加") + "自身普通技能剩余冷却：各自基础冷却的"
            + Number((Math.abs(change.ratio) * 100).toFixed(2)) + "%（原作格数向零取整）");
        words.push("本次施放的技能自身除外；不储存给后续施放，不影响 R 量能");
    }
    if (slot.gauge) {
        words.push("必杀槽 +" + Math.round(slot.gauge * 100) + "%");
    }
    if (slot.nextAtk > 0) {
        words.push("下次普攻 +" + Math.round(slot.nextAtk * 100) + "%（命中后消耗）");
    }
    if ((slot.nextCriticals || []).length) {
        words.push("下次伤害行动必定暴击（普攻／普通技能／必杀；出手消耗，挥空不返还）");
        words.push("同次多目标／多段共享；技能卡不使用；不利属性仍可暴击");
    }
    if (slot.regen) {
        words.push("每回合回复 " + Math.round(slot.regen.pct * 100) + "%×" + slot.regen.turns + "回合");
    }
    if (slot.slow && slot.slow.pct > 0) {
        words.push("行动减速，基础 " + Math.round(slot.slow.pct * 100)
            + "%×" + slot.slow.turns + "回合（上限80%，精英与首领减免）");
    }
    if (slot.resists && slot.resists.by) {
        const zh = ["火", "水", "土", "风", "月", "阳"];
        Object.keys(slot.resists.by).forEach(function (e) {
            const v = slot.resists.by[e];
            const enemy = slot.resists.target === 1 || slot.resists.target === 2;
            words.push((enemy ? "敌方" : "自身") + zh[+e] + "耐性"
                + (v > 0 ? "+" : "") + Math.round(v * 100) + "%×" + slot.resists.turns + "回合");
        });
    }
    (slot.weakBonuses || []).forEach(function (bonus) {
        words.push("自身克制倍率+" + Number(bonus.pct.toFixed(3))
            + "（2→" + Number((2 + bonus.pct).toFixed(3)) + "，仅有利属性）×" + bonus.turns + "回合");
    });
    (slot.statusEffects || []).forEach(function (effect) {
        if (effect.kind === 4) {
            words.push("自身治疗封锁（不幸）" + Math.round(effect.chance * 100) + "%概率×" + effect.turns
                + "回合：技能/持续/吸血回复无效，补给、升级与保命不受影响");
        } else if (effect.kind === 5) {
            words.push("解除治疗封锁");
        } else if (effect.kind === 6) {
            words.push("治疗封锁免疫×" + effect.turns + "回合（不解除已有封锁）");
        }
    });
    for (const placement of slot.cardPlacements || []) {
        const card = placement.card;
        const seconds = Number((turnSeconds * card.loadFactor).toFixed(3));
        words.push("放置" + card.name + "×" + placement.count + "次，每" + seconds + "秒触发");
        for (const effect of card.effects) {
            if (effect.heal) words.push("卡每次回复最大生命" + Math.round(effect.heal * 100) + "%（受治疗封锁）");
            if (effect.damage) words.push("卡每次" + (effect.magic ? "魔法" : "物理") + "系数" + effect.coef
                + (effect.target === 2 ? "，当前敌方全体" : "，当前最近敌人"));
            if (effect.barrier) words.push("卡每次护盾" + Math.round(effect.barrier.cut * 100) + "%×" + effect.barrier.hits + "次");
        }
        words.push("同槽刷新次数不重置倒计时；暂停不触发、换房清除；装备额外次数另计");
    }
    const unsupported = { 3: "能力重置", 4: "自身异常", 5: "异常解除", 6: "异常免疫",
        7: "异常概率", 9: "属性变更", 10: "克制强化", 12: "必定暴击", 14: "冷却变化", 16: "量能倍率",
        17: "行动顺序", 18: "仇恨", 19: "蓄力", 20: "连携", 21: "技能卡放置",
        22: "眩晕恢复", 24: "原作后续效果" };
    (slot.unhandled || []).forEach(function (kind) {
        const partial = (slot.statusEffects || []).some(effect => effect.kind === kind);
        const name = partial && [4, 5, 6].includes(kind)
            ? ({ 4: "其余自身异常", 5: "其余异常解除", 6: "其余异常免疫" })[kind] : unsupported[kind];
        words.push("未适配：" + (name || "原作特殊效果"));
    });
    const delivery = { self: "自身", ring: "环形", aimed: "指向" };
    if (slot.ultimate) {
        words.push(slot.target === 2 ? "敌方全体" : slot.target === 1 ? "最近敌人" : "自身");
    } else if (slot.delivery && delivery[slot.delivery]) {
        words.push(delivery[slot.delivery]);
    }
    return words;
}

// Authored SkillIcon.cs icon family keyed by the row's own m_SkillType.
// 3 (attack) / 4 (magic) are white silhouettes → tinted with
// UIUtility.GetIconColor's authored +1 offset; 5-7 keep their art colours.
// GetIconColor(elementType): the switch adds 1 before comparing, so Fire
// gets NONE_ELEMENT grey, Water gets FIRE red, ... Sun gets MOON pink.

function skillSheet(slot, table, element) {
    const sheet = document.createElement("div");
    sheet.className = "skill";
    const name = document.createElement("div");
    name.className = "skname";
    const info = SKILL_ICON_BY_TYPE[slot.skillType];
    if (info) {
        const icon = document.createElement("span");
        icon.className = "skicon " + (info.silhouette ? "silhouette" : "plain");
        // Inline-style url() would resolve against the page and escape a
        // /kirafan-timer/ deployment subpath; resolve from this module.
        const dropIcon = new URL("../../../asset/img/rl/drop/" + info.name + ".webp",
            import.meta.url).href;
        icon.style.setProperty("--skicon-url",
            'url("' + dropIcon + '")');
        if (info.silhouette) {
            icon.style.setProperty("--skicon-tint",
                ELEMENT_TINT[element] || "#808080");
        } else {
            icon.style.background = "center / contain no-repeat";
            icon.style.backgroundImage =
                'url("' + dropIcon + '")';
        }
        name.appendChild(icon);
    }
    const nm = document.createElement("span");
    nm.className = "skname-text";
    nm.textContent = slot.name || "";
    name.appendChild(nm);
    if (slot.ultimate || slot.cooldown > 0) {
        const cd = document.createElement("span");
        cd.className = "cd";
        cd.textContent = slot.ultimate ? "必杀" : "冷却 " + slot.cooldown + "s";
        name.appendChild(cd);
    }
    sheet.appendChild(name);
    if (slot.ultimate) {
        const presentation = document.createElement("div");
        presentation.className = "skdetail sk-presentation";
        presentation.textContent = slot.sceneId
            ? "原作演出形式：独立必杀场景"
            : "原作演出形式：职业动作（此卡没有独立场景）";
        sheet.appendChild(presentation);
    }
    if (slot.detail) {
        const source = document.createElement("details");
        const label = document.createElement("summary");
        label.textContent = "原作说明（实际效果见词条）";
        source.appendChild(label);
        const det = document.createElement("div");
        det.className = "skdetail";
        det.textContent = slot.detail;
        source.appendChild(det);
        sheet.appendChild(source);
    }
    const words = skillWords(slot, table && table.turnSeconds || TURN_SECONDS);
    if (words.length) {
        const wrap = document.createElement("div");
        wrap.className = "skwords";
        words.forEach(function (w) {
            const chip = document.createElement("span");
            chip.className = "word";
            chip.textContent = w;
            wrap.appendChild(chip);
        });
        sheet.appendChild(wrap);
    }
    return sheet;
}

// The in-run 技能卡: the player's three live slots (with current cooldown
// state) plus the normal attack, read straight off world.player.skills.
export function showSkillCard(player, onClose) {
    injectStyles();
    const overlay = document.createElement("div");
    overlay.className = "rl-infocard";
    overlay.id = "rl-skillcard";
    const sheet = document.createElement("div");
    sheet.className = "sheet";

    const title = document.createElement("div");
    title.className = "section";
    title.textContent = "技　能";
    sheet.appendChild(title);

    const sk = player && player.skills;
    if (sk) {
        const card = player.card || {};
        const head = document.createElement("div");
        head.className = "head";
        head.style.gap = "8px";
        const who = document.createElement("div");
        who.className = "who";
        const nm = document.createElement("div");
        nm.className = "nm";
        nm.style.fontSize = "1rem";
        nm.textContent = card.characterZh || card.nameZh || card.name || "";
        who.appendChild(nm);
        head.appendChild(who);
        sheet.appendChild(head);

        if (sk.normal) {
            sheet.appendChild(skillSheet(sk.normal, null, card.element));
        }
        (sk.slots || []).forEach(function (slot) {
            sheet.appendChild(skillSheet(slot, null, card.element));
        });
    }

    const closeRow = document.createElement("div");
    closeRow.className = "close-row";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    closeBtn.addEventListener("click", function () {
        overlay.remove();
        if (onClose) { onClose(); }
    });
    closeRow.appendChild(closeBtn);
    sheet.appendChild(closeRow);

    overlay.appendChild(sheet);
    overlay.addEventListener("pointerdown", function (event) {
        if (event.target === overlay) {
            overlay.remove();
            if (onClose) { onClose(); }
        }
    });
    document.body.appendChild(overlay);
    closeBtn.focus();
    return overlay;
}

// The roster's 人物卡: title, CV, profile, class/element tags, init stats,
// and the three skills decoded exactly as the run would decode them.
export function showCharacterCard(card, skillsTable, options) {
    injectStyles();
    const opts = options || {};
    const overlay = document.createElement("div");
    overlay.className = "rl-infocard";
    overlay.id = "rl-charcard";
    const sheet = document.createElement("div");
    sheet.className = "sheet";

    const head = document.createElement("div");
    head.className = "head";
    const art = document.createElement("img");
    art.className = "art";
    art.src = opts.artBase + card.id + ".webp";
    art.alt = "";
    art.addEventListener("error", function () {
        art.style.visibility = "hidden";
    });
    head.appendChild(art);

    const who = document.createElement("div");
    who.className = "who";
    const nm = document.createElement("div");
    nm.className = "nm";
    const dot = document.createElement("span");
    dot.className = "el";
    // Data ring 0=炎 1=水 2=土 3=風 4=月 5=陽 (same fix as roster.js — the
    // old map was shifted one and miscoloured every element but 風).
    const ELEMENT_VAR = { 0: "var(--el-fire)", 1: "var(--el-water)",
                          2: "var(--el-earth)", 3: "var(--el-wind)",
                          4: "var(--el-moon)", 5: "var(--el-sun)" };
    dot.style.background = ELEMENT_VAR[card.element] || "var(--kf-mint)";
    nm.appendChild(dot);
    const nmText = document.createElement("span");
    nmText.textContent = card.characterZh || card.nameZh || card.name || "";
    nm.appendChild(nmText);
    who.appendChild(nm);
    if (card.titleZh) {
        const ttl = document.createElement("div");
        ttl.className = "ttl";
        ttl.textContent = "《" + card.titleZh + "》";
        who.appendChild(ttl);
    }
    if (card.cv) {
        const cv = document.createElement("div");
        cv.className = "cv";
        cv.textContent = "CV：" + card.cv;
        who.appendChild(cv);
    }
    head.appendChild(who);
    sheet.appendChild(head);

    const tags = document.createElement("div");
    tags.className = "tags";
    const tagList = [];
    if (card.elementZh) { tagList.push(card.elementZh + "属性"); }
    if (card.classZh) { tagList.push(card.classZh); }
    tagList.push("★".repeat(Math.max(1, Math.min(5, card.rare || 3))));
    tagList.forEach(function (t) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = t;
        tags.appendChild(tag);
    });
    sheet.appendChild(tags);

    if (card.profileZh) {
        const profile = document.createElement("div");
        profile.className = "profile";
        profile.textContent = card.profileZh;
        sheet.appendChild(profile);
    }

    if (card.init && card.init.hp !== undefined) {
        const stats = document.createElement("div");
        stats.className = "statblock";
        const rows = [
            ["HP", card.init.hp], ["物攻", card.init.atk], ["魔攻", card.init.mgc],
            ["物防", card.init.def], ["魔防", card.init.mdef],
            ["速度", card.init.spd], ["幸运", card.init.luck]
        ];
        rows.forEach(function (pair) {
            const item = document.createElement("span");
            const k = document.createElement("span");
            k.className = "k";
            k.textContent = pair[0];
            item.appendChild(k);
            item.appendChild(document.createTextNode(String(pair[1])));
            stats.appendChild(item);
        });
        sheet.appendChild(stats);
    }

    // Skills decoded with the game's own createSkills so the card shows
    // exactly what a run would give the character.
    if (skillsTable) {
        const section = document.createElement("div");
        section.className = "section";
        section.textContent = "技　能";
        sheet.appendChild(section);
        const ids = [];
        if (card.skillIds) {
            if (card.skillIds.chara) { ids.push(card.skillIds.chara); }
            (card.skillIds.class || []).forEach(function (id) {
                ids.push(id);
            });
        }
        const rows = skillsTable.player || {};
        ids.slice(0, 3).forEach(function (id) {
            const row = rows[id] || rows[String(id)];
            if (!row) { return; }
            const slot = decodeSkill(row, id, skillsTable.recastSeconds || 0.35, skillsTable.skillCards);
            sheet.appendChild(skillSheet(slot, skillsTable, card.element));
        });
    }

    const closeRow = document.createElement("div");
    closeRow.className = "close-row";
    if (opts.onSelect) {
        const go = document.createElement("button");
        go.className = "primary";
        go.textContent = "出发";
        go.addEventListener("click", function () {
            overlay.remove();
            opts.onSelect(card.id);
        });
        closeRow.appendChild(go);
    }
    const close = document.createElement("button");
    close.textContent = "返回";
    close.addEventListener("click", function () {
        overlay.remove();
    });
    closeRow.appendChild(close);
    sheet.appendChild(closeRow);

    overlay.appendChild(sheet);
    overlay.addEventListener("pointerdown", function (event) {
        if (event.target === overlay && !opts.onSelect) {
            overlay.remove();
        }
    });
    document.body.appendChild(overlay);
    close.focus();
    return overlay;
}
