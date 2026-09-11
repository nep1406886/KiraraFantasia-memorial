// T26: native modal views. Callbacks own validation, mutation and persistence.
import { passiveRuntime, equipmentMultipliers } from "../equipment.js";
import { weaponDefinition, canEquipWeapon, weaponProficiency } from "../weaponcatalog.js";
import { gadgetDefinition, gadgetAcquisition, gadgetTerms } from "../gadgets.js";
import { equipmentSkillComparison, equipmentSkillOverview, equipmentSkillModifiers } from "./equipmentskills.js";
import { equipmentBrief } from "./equipmentbrief.js";

const SLOTS = { weapon: "武器", amulet: "护符", armor: "护甲", charm: "饰品" };
const RARITIES = { common: "普通", rare: "稀有", epic: "史诗", legendary: "传说" };
const CLASSES = ["战士", "魔法使", "僧侣", "骑士", "炼金术士"];
const STATS = [["atk", "物攻"], ["mgc", "魔攻"], ["def", "物防"], ["mdef", "魔防"]];
const ASSETS = new URL("../../../asset/img/rl/", import.meta.url);
// Native weapons retain their catalog art. New equipment has authored symbols,
// never ItemList consumables, enhancement materials or event currency.
const percent = value => Math.round(value * 100) + "%";
const number = value => Math.round(value * 10) / 10;

function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) { el.className = className; }
    if (text !== undefined) { el.textContent = text; }
    return el;
}

function button(label, callback, className) {
    const el = node("button", className, label);
    el.type = "button";
    el.addEventListener("click", callback);
    return el;
}

function portrait(id, name) {
    const image = node("img", "decision-portrait");
    image.src = new URL("card/" + id + ".webp", ASSETS).href;
    image.alt = name;
    image.addEventListener("error", function () { image.hidden = true; });
    return image;
}

function modal(id, title, onClose) {
    const dialog = node("dialog", "rl-decision");
    dialog.id = id;
    const heading = node("h2", "", title);
    heading.id = id + "-title";
    heading.tabIndex = -1;
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.appendChild(heading);
    const previous = document.activeElement;
    let closed = false;
    function close() {
        if (closed) { return; }
        closed = true;
        dialog.close();
        dialog.remove();
        if (previous && previous.isConnected) { previous.focus(); }
        if (onClose) { onClose(); }
    }
    dialog.addEventListener("cancel", function (event) { event.preventDefault(); close(); });
    // Let keyup reach the input layer so keys held before opening get released.
    dialog.addEventListener("keydown", function (event) { event.stopPropagation(); });
    return { dialog: dialog, close: close, show: function () {
        document.body.appendChild(dialog);
        dialog.showModal();
        dialog.scrollTop = 0;
        heading.focus({ preventScroll: true });
    } };
}

export function equipmentName(item, weapons, cards) {
    if (!item) { return "未装备"; }
    try {
        const gadget = gadgetDefinition(item);
        if (gadget) { return RARITIES[gadget.rarity] + " · " + gadget.name
            + (gadget.sealSkill ? ' · 技能' + (item.sealedSlot + 1) + '封印' : ''); }
    } catch (_) { return "无效机制装备"; }
    if (item.catalogId !== undefined) {
        let row;
        try { row = weaponDefinition(item); } catch (_) { return "未知武器"; }
        return (RARITIES[item.rarity] || "") + " · " + row.nameZh;
    }
    const mapping = weapons && (weapons.weapons || []).find(w => String(w.id) === String(item.weaponId));
    const owner = mapping && (cards || []).find(c => c.dedicatedWeapon
        && c.dedicatedWeapon.id === mapping.weaponId);
    const name = owner ? (owner.characterZh || owner.nameZh) + "的专武" : SLOTS[item.slot] || "未知装备";
    return (RARITIES[item.rarity] || "") + " · " + name;
}

export function equipmentRarity(item) {
    try { return gadgetDefinition(item)?.rarity || item?.rarity; } catch (_) { return null; }
}

export function equipmentIcon(item, weapons) {
    let row;
    try {
        const gadget = gadgetDefinition(item);
        if (gadget) { return new URL("equipment/gadget-" + gadget.id + ".svg", ASSETS).href; }
        row = weaponDefinition(item);
    } catch (_) { return null; }
    const legacy = !row && weapons && (weapons.weapons || []).find(w => String(w.id) === String(item && item.weaponId));
    const id = row ? row.iconId : legacy && legacy.weaponId;
    if (id) { return new URL("weapon/" + id + ".webp", ASSETS).href; }
    const slot = item && Object.hasOwn(SLOTS, item.slot) && item.slot;
    return slot ? new URL("equipment/slot-" + slot + ".svg", ASSETS).href : null;
}

function equipmentImage(item, weapons, className = "equipment-icon") {
    const src = equipmentIcon(item, weapons);
    if (!src) { return null; }
    const image = node("img", className);
    image.src = src; image.alt = ""; image.width = 96; image.height = 96;
    image.addEventListener("error", () => { image.hidden = true; });
    return image;
}

function passiveWords(item) {
    if (!item) { return []; }
    let rt;
    let modifiers;
    try {
        rt = passiveRuntime([item]); modifiers = equipmentMultipliers([item]);
    } catch (_) { return ["词条数据不可用"]; }
    const words = [];
    for (const [key, label] of [["hp", "生命"], ...STATS, ["spd", "速度"], ["luck", "幸运"]]) {
        const change = modifiers.mults[key] - 1;
        if (change) { words.push(label + " " + (change > 0 ? "+" : "") + percent(change)); }
    }
    if (modifiers.crit) { words.push("暴击率 +" + percent(modifiers.crit)); }
    if (rt.critDamage) { words.push("暴击倍率 +" + percent(rt.critDamage)); }
    if (rt.gaugeMult !== 1) { words.push("量能获取 +" + percent(rt.gaugeMult - 1)); }
    if (rt.gaugeOnHit) { words.push("受击回复必杀槽 " + percent(rt.gaugeOnHit)); }
    if (rt.stunFill !== 1) { words.push("眩晕累积 +" + percent(rt.stunFill - 1)); }
    if (rt.overheal) { words.push("治疗上限 +" + percent(rt.overheal)); }
    if (rt.lifesteal) { words.push("伤害回血 " + percent(rt.lifesteal)); }
    if (rt.survival) { words.push("每层致死保护 " + rt.survival + " 次"); }
    if (rt.healingLockImmune) { words.push("治疗封锁免疫（其余异常未适配）"); }
    if (rt.extraCardTriggers) { words.push("技能卡触发次数 +" + rt.extraCardTriggers + "（放置/刷新时）"); }
    if (rt.skillReplacements.length) { words.push("技能改写（见下方固定槽位对照）"); }
    for (const [key, label] of [["hitStack", "每次受击"], ["killStack", "每次击杀"]]) {
        const stack = rt[key];
        for (const [stat, name] of [["atk", "物攻"], ["mgc", "魔攻"], ["def", "物防"], ["mdef", "魔防"]]) {
            if (stack && stack[stat]) { words.push(label + name + " +" + percent(stack[stat])); }
        }
    }
    if (rt.debuffOnHit) {
        words.push("受击后敌方物攻 " + percent(rt.debuffOnHit.atk)
            + "，魔攻 " + percent(rt.debuffOnHit.mgc) + "，" + rt.debuffOnHit.turns + " 回合");
    }
    if (rt.taunt) { words.push("仇恨：单人模式无作用"); }
    const missing = { 2: "异常免疫", 3: "眩晕免疫", 12: "技能卡", 13: "生命曲线" };
    rt.noops.forEach(kind => words.push("未适配：" + missing[kind]));
    return words;
}

function equipmentDetails(item, options = {}) {
    const { weapons, cards } = options;
    const skillNames = options.skillLoadout?.slots.map(slot => slot.name) || options.skillNames;
    const content = node("div", "equipment-detail");
    const image = equipmentImage(item, weapons);
    if (image) { content.appendChild(image); }
    content.appendChild(node("p", "equipment-name", equipmentName(item, weapons, cards)));
    if (!item) { return content; }
    let gadget;
    try { gadget = gadgetDefinition(item); } catch (_) { return content; }
    if (gadget) {
        const terms = gadgetTerms(item, skillNames);
        content.dataset.gadgetId = gadget.id;
        content.append(node("p", "equipment-meta", "外传机制装备 · " + SLOTS[gadget.slot] + "槽"),
            node("h4", "", "操作变化"), node("p", "gadget-benefit", terms.benefit),
            node("h4", "", "取舍与边界"), node("p", "gadget-cost", terms.cost),
            node("p", "decision-muted", "固定机制，品质不增强效果；同槽装备互相替换，不叠加。"),
            node("h4", "", "获取途径"), node("p", "decision-muted", gadgetAcquisition(gadget)));
        if (gadget.assist >= 2) {
            content.appendChild(node("p", "decision-muted", "装配后默认关闭。按 H 或点击状态栏开关；手动输入立即接管。不自动拾取、过门或使用技能。"));
        }
        return content;
    }
    let row;
    try { row = weaponDefinition(item); } catch (_) { return content; }
    if (!row && item.slot !== "weapon") {
        content.appendChild(node("p", "equipment-meta", "外传装备 · " + SLOTS[item.slot] + "槽 · 非原作消耗品"));
    }
    if (row) {
        content.dataset.catalogId = row.id;
        content.appendChild(node("p", "equipment-meta", "原作 " + row.rare + " 星 · " + CLASSES[row.class]
            + " · Lv." + row.maxLv + " · " + (row.evolution ? "进化 " + row.evolution + " 阶" : "初始形态")));
        const stats = node("dl", "weapon-stats");
        for (const [key, name] of STATS) {
            stats.append(node("dt", "", name), node("dd", "", "+" + row.max[key]));
        }
        content.append(node("h4", "", "原作属性"), stats);
        if (row.passiveId > 0) {
            const native = passiveWords({ slot: "weapon", catalogId: row.id, affixes: [] });
            content.append(node("h4", "", "原生被动"), node("p", "decision-muted", native.join("；")));
        }
        if (row.skillId > 0) {
            content.appendChild(node("p", "decision-muted", "武器主动技：未适配"));
        }
    }
    const extra = (item.affixes || []).filter(id => !row || id !== String(row.passiveId));
    content.appendChild(node("h4", "", row ? "附加词条" : "装备词条"));
    if (extra.length) {
        const list = node("ol", "equipment-affixes");
        for (const id of extra) {
            const words = passiveWords({ slot: item.slot, affixes: [id] });
            const entry = node("li", "decision-muted", words.length ? words.join("；") : "无已适配的数值效果");
            entry.dataset.affixId = id; list.appendChild(entry);
        }
        content.appendChild(list);
    } else content.appendChild(node("p", "decision-muted", "无"));
    const modifications = equipmentSkillModifiers(item, options);
    if (modifications) content.appendChild(modifications);
    return content;
}

export function showEquipmentComparison(options) {
    const ui = modal("rl-equipment-choice", options.price !== undefined ? "购买装备" : "发现装备", options.onClose);
    const view = options.preview;
    // Keep identity outside the long skill/stat scroller. This is the same
    // candidate read model; no extra equipment calculation or commit path.
    const summary = node("section", "comparison-summary");
    const image = equipmentImage(options.item, options.weapons, "comparison-summary-icon");
    if (image) summary.appendChild(image);
    const copy = node("div", "comparison-summary-copy");
    const name = node("h3", "comparison-summary-name", equipmentName(options.item, options.weapons, options.cards));
    name.id = "equipment-candidate-name";
    summary.setAttribute("aria-labelledby", name.id);
    copy.append(name, node("p", "comparison-summary-meta", (SLOTS[options.item?.slot] || "装备")
        + "槽 · " + (view?.equipped ? "替换：" + equipmentName(view.equipped, options.weapons, options.cards) : "当前未装备")));
    summary.appendChild(copy);
    ui.dialog.appendChild(summary);
    const scroll = node("div", "comparison-scroll");
    const brief = equipmentBrief(view);
    if (view) {
        const changes = node("section", "equipment-brief");
        changes.setAttribute("aria-label", "装备简述");
        changes.appendChild(node("p", "equipment-brief-benefit", brief.benefits.join(" · ")
            || (brief.costs.length ? "没有新增收益" : "主要属性没有变化")));
        if (brief.costs.length) changes.appendChild(node("p", "equipment-brief-cost", "代价：" + brief.costs.join(" · ")));
        if (brief.notes.length) changes.appendChild(node("p", "equipment-brief-note", brief.notes.join(" · ")));
        scroll.appendChild(changes);
    }
    const details = node("details", "equipment-more");
    const toggle = node("summary", "", "查看详情" + (brief.more ? " · 另有 " + brief.more + " 项变化" : ""));
    const collapsedLabel = toggle.textContent;
    details.addEventListener("toggle", () => {
        toggle.textContent = details.open ? "收起详情" : collapsedLabel;
        if (!details.open) scroll.scrollTop = 0;
    });
    const detailBody = node("div", "equipment-more-body");
    details.append(toggle, detailBody); scroll.appendChild(details);
    const skillChanges = equipmentSkillComparison(view);
    if (skillChanges) detailBody.appendChild(skillChanges);
    const columns = node("div", "comparison-columns");
    for (const [label, item, names, loadout, previewing] of [["当前装备", view && view.equipped, view?.skillNames?.current, view?.skills?.current, false],
        ["候选装备", options.item, view?.skillNames?.candidate, view?.skills?.candidate, true]]) {
        const column = node("section");
        column.append(node("h3", "", label), equipmentDetails(item, { ...options, skillNames: names, skillLoadout: loadout, previewing }));
        columns.appendChild(column);
    }
    detailBody.appendChild(columns);
    ui.dialog.appendChild(scroll);
    if (view) {
        if (view.style && options.item?.slot === "weapon") {
            const from = view.style.current, to = view.style.candidate;
            const note = to.proficiency < 1
                ? "跨职业持有：原作属性与正向属性词条按 " + percent(to.proficiency) + " 生效。"
                : "本职武器：原作属性与正向数值词条按 100% 计算。";
            detailBody.appendChild(node("p", "equipment-style", "普攻：" + from.name + " → " + to.name + "。" + note
                + "角色职业与 R 必杀不变；职业技能以改技对照为准。"));
        }
        const table = node("table", "comparison-stats");
        const head = node("tr");
        ["角色面板", "当前", "替换后", "差值"].forEach(label => head.appendChild(node("th", "", label)));
        const thead = node("thead"); thead.appendChild(head); table.appendChild(thead);
        const body = node("tbody");
        for (const [key, name] of [["hp", "生命上限"], ["atk", "物攻"], ["mgc", "魔攻"],
            ["def", "物防"], ["mdef", "魔防"], ["luck", "幸运"], ["critChance", "暴击率"]]) {
            const from = view.current[key] || 0, to = view.candidate[key] || 0;
            const delta = number((to - from) * (key === "critChance" ? 100 : 1));
            const format = key === "critChance" ? percent : number;
            const row = node("tr"); row.dataset.stat = key;
            row.append(node("th", "", name), node("td", "", format(from)), node("td", "", format(to)),
                node("td", delta > 0 ? "stat-up" : delta < 0 ? "stat-down" : "", (delta > 0 ? "+" : "") + delta
                    + (key === "critChance" ? "%" : "")));
            body.appendChild(row);
        }
        table.appendChild(body); detailBody.appendChild(table);
    }
    const status = node("p", "decision-status", options.price !== undefined
        ? "价格 " + options.price + " 金币 · 余额 " + options.coin : "");
    status.setAttribute("role", "status");
    const actions = node("div", "decision-actions");
    const keep = button("不换", ui.close);
    const take = button(options.price !== undefined ? "购买并换上" : "换上", function () {
        take.disabled = true;
        let confirmed = false;
        try { confirmed = options.onConfirm(); } catch (_) { /* keep the uncommitted choice open */ }
        if (confirmed) { ui.close(); }
        else {
            status.textContent = '替换未提交，物品未消耗。请检查保存状态、物品或余额后重试。';
            take.disabled = !view || !!options.disabled;
        }
    }, "primary");
    take.id = "equipment-confirm";
    take.disabled = !view || !!options.disabled;
    if (!view) { status.textContent = "装备数据不可用，无法装配。"; }
    keep.id = "equipment-keep";
    actions.append(keep, take); ui.dialog.append(status, actions); ui.show();
    return ui;
}

export function showFloorDeparture(options) {
    const ui = modal('rl-floor-departure', '大圣堂雕像 · 星光祈愿', options.onClose);
    ui.dialog.appendChild(node('p', '', options.final
        ? '雕像已苏醒。与它共鸣，记录这一卷的旅程并返回休憩处。'
        : '雕像已苏醒。与它共鸣，让星光引导你前往第 ' + (options.floor + 1) + ' 层。'));
    const items = options.unclaimed || [];
    ui.dialog.appendChild(node('p', '', items.length
        ? '本层还有 ' + items.length + ' 件未拾取战利品。可以暂不祈愿、继续探索，也可以直接前行。'
        : '没有未拾取的战利品。你也可以暂不祈愿，继续探索本层。'));
    if (items.length) {
        const list = node('ul', 'departure-loot');
        for (const entry of items) {
            const row = node('li');
            const image = equipmentImage(entry.item, options.weapons);
            if (image) { row.appendChild(image); }
            row.appendChild(node('span', '', '房间 ' + (entry.roomId + 1) + ' · ' + equipmentName(entry.item, options.weapons)));
            list.appendChild(row);
        }
        ui.dialog.appendChild(list);
    }
    ui.dialog.appendChild(node('p', 'decision-muted', options.final
        ? '确认后结算本卷。未拾取物品将留在本层，不会自动装备或带走。'
        : '确认后才开始读取下一层。未拾取物品不会自动装备；成功离层后无法再返回。'));
    const status = node('p', 'decision-status'); status.setAttribute('role', 'status');
    const actions = node('div', 'decision-actions');
    const stay = button('暂不祈愿', ui.close); stay.id = 'floor-departure-stay';
    const go = button(options.final ? '祈愿 · 完成本卷' : '祈愿 · 前往第 ' + (options.floor + 1) + ' 层', () => {
        go.disabled = true;
        if (options.onConfirm()) { ui.close(); }
        else { go.disabled = false; status.textContent = '当前状态已变化，未离开本层。'; }
    }, 'primary');
    go.id = 'floor-departure-confirm'; actions.append(stay, go);
    ui.dialog.append(status, actions); ui.show();
    return ui;
}

export function showEquipmentCollection(options) {
    const ui = modal("rl-equipment-collection", "装备与武器图鉴", options.onClose);
    const tabs = node("div", "equipment-tabs"); tabs.setAttribute("role", "tablist");
    const body = node("div"); body.id = "equipment-tab-content"; body.setAttribute("role", "tabpanel");
    const current = button("当前装备", () => select("current"));
    const catalog = button("武器图鉴", () => select("catalog"));
    for (const [tab, id] of [[current, "current"], [catalog, "catalog"]]) {
        tab.id = "equipment-tab-" + id; tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", body.id);
        tab.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight"].includes(event.key)) { return; }
            event.preventDefault(); select(id === "current" ? "catalog" : "current");
            (id === "current" ? catalog : current).focus();
        });
    }
    tabs.append(current, catalog);
    function select(mode) {
        for (const [tab, id] of [[current, "current"], [catalog, "catalog"]]) {
            tab.setAttribute("aria-selected", String(mode === id)); tab.tabIndex = mode === id ? 0 : -1;
        }
        body.setAttribute("aria-labelledby", "equipment-tab-" + mode);
        body.replaceChildren();
        if (mode === "current") {
            body.className = "equipment-loadout";
            const overview = equipmentSkillOverview(options.skillLoadout);
            if (overview) body.appendChild(overview);
            for (const [slot, name] of Object.entries(SLOTS)) {
                const section = node("section");
                section.append(node("h3", "", name), equipmentDetails(
                    options.items.find(item => item.slot === slot), options));
                body.appendChild(section);
            }
        } else {
            body.className = "";
            renderCatalog();
        }
    }
    function renderCatalog() {
        const filters = node("div", "weapon-filters");
        const job = node("select"); job.setAttribute("aria-label", "武器职业");
        const all = node("option", "", "全部职业"); all.value = ""; job.appendChild(all);
        CLASSES.forEach((name, id) => { const option = node("option", "", name); option.value = id; job.appendChild(option); });
        job.value = String(options.card.class);
        const search = node("input"); search.type = "search"; search.placeholder = "武器名称";
        search.setAttribute("aria-label", "武器名称");
        const count = node("p", "decision-muted"); count.setAttribute("role", "status");
        const list = node("div", "weapon-catalog-list");
        const rows = options.weapons && options.weapons.catalog || [];
        const families = rows.filter(row => row.evolution === 0);
        filters.append(job, search); body.append(filters, count, list);
        function filter() {
            list.replaceChildren();
            const found = families.filter(row => (job.value === "" || row.class === Number(job.value))
                && row.nameZh.toLowerCase().includes(search.value.trim().toLowerCase()));
            count.textContent = found.length + " 种武器 · " + families.length + " 种收录";
            for (const family of found) {
                const item = { slot: "weapon", rarity: family.rare === 5 ? "legendary" : "rare", affixes: [], catalogId: family.id };
                const entry = node("details", "weapon-entry");
                const summary = node("summary");
                const image = equipmentImage(item, options.weapons, "weapon-list-icon");
                if (image) { image.loading = "lazy"; summary.appendChild(image); }
                summary.appendChild(node("span", "", family.nameZh));
                entry.appendChild(summary);
                entry.addEventListener("toggle", () => {
                    if (!entry.open || entry.dataset.loaded) { return; }
                    entry.dataset.loaded = "true";
                    const stage = node("select"); stage.setAttribute("aria-label", family.nameZh + "进化阶段");
                    rows.filter(row => row.iconId === family.iconId).forEach(row => {
                        const option = node("option", "", (row.evolution ? "进化 " + row.evolution + " 阶" : "初始形态") + " · Lv." + row.maxLv);
                        option.value = row.id; stage.appendChild(option);
                    });
                    const detail = node("div");
                    function update() {
                        item.catalogId = Number(stage.value);
                        const preview = options.previewEquipment?.(item);
                        detail.replaceChildren(equipmentDetails(item, { ...options,
                            skillLoadout: preview?.skills?.candidate, skillNames: preview?.skillNames?.candidate, previewing: true }));
                        const comparison = equipmentSkillComparison(preview);
                        if (comparison) detail.appendChild(comparison);
                        detail.appendChild(node("p", "decision-muted", canEquipWeapon(item, options.card)
                            ? (weaponProficiency(item, options.card) < 1 ? "可跨职业装备 · 属性加成 65% · 改变普攻方式" : "本职武器 · 属性加成 100%")
                            : "专用角色限定"));
                    }
                    stage.addEventListener("change", update); entry.append(stage, detail); update();
                });
                list.appendChild(entry);
            }
        }
        job.addEventListener("change", filter); search.addEventListener("input", filter); filter();
    }
    ui.dialog.append(tabs, body, button("返回", ui.close)); select("current"); ui.show();
    return ui;
}

export function showSupplyChoice(options) {
    return showRoomEventChoice(options, 'rl-supply-choice', 'supply');
}

export function showAltarChoice(options) {
    return showRoomEventChoice(options, 'rl-altar-choice', 'altar');
}

function showRoomEventChoice(options, id, prefix) {
    const offer = options.offer;
    const ui = modal(id, offer.title, options.onClose);
    ui.dialog.classList.add('room-event');
    const scroll = node('div', 'room-event-scroll');
    const heading = node('div', options.cardId ? 'decision-character' : '');
    if (options.cardId) heading.appendChild(portrait(options.cardId, options.name));
    heading.appendChild(node('p', '', (options.name ? options.name + '：' : '') + offer.text));
    const choices = node('div', 'room-event-choices');
    const preview = node('section', 'room-event-preview');
    preview.hidden = true;
    const status = node("p", "decision-status"); status.setAttribute("role", "status");
    const actions = node("div", "decision-actions");
    let selected = null;
    const confirm = button('先选择一条道路', function () {
        if (!selected) return;
        confirm.disabled = true;
        if (options.onChoose(selected.id)) { ui.close(); }
        else {
            status.textContent = '本次选择未提交，资源与房间机会未消费。请检查存档提示或资源条件后重试。';
            confirm.disabled = false;
        }
    }, 'primary');
    confirm.id = 'room-event-confirm'; confirm.disabled = true;
    const buttons = [];
    for (const choice of offer.options) {
        const action = button('', function () {
            selected = choice;
            buttons.forEach(b => b.setAttribute('aria-pressed', String(b === action)));
            preview.replaceChildren(node('h3', '', choice.label), node('p', '', choice.text));
            if (choice.item) {
                const columns = node('div', 'comparison-columns');
                const comparison = equipmentSkillComparison(choice.preview);
                if (comparison) preview.appendChild(comparison);
                for (const [label, item, names, loadout, previewing] of [['将被替换', choice.preview?.equipped, choice.preview?.skillNames?.current, choice.preview?.skills?.current, false],
                    ['获得装备', choice.item, choice.preview?.skillNames?.candidate, choice.preview?.skills?.candidate, true]]) {
                    const column = node('section');
                    column.append(node('h4', '', label), equipmentDetails(item, { ...options, skillNames: names, skillLoadout: loadout, previewing }));
                    columns.appendChild(column);
                }
                preview.appendChild(columns);
            }
            preview.appendChild(node('p', 'equipment-style', '确认后：生命 ' + number(choice.result.hp)
                + ' · 必杀槽 ' + number(choice.result.gauge) + ' · 金币 ' + number(choice.result.coin)
                + '。其他选项将关闭。'));
            preview.hidden = false;
            status.textContent = '尚未扣除资源。确认前可以换选项，或暂不参与。';
            confirm.textContent = '确认 · ' + choice.label; confirm.disabled = false;
        }, 'room-event-option');
        action.id = prefix + '-' + choice.id;
        action.setAttribute('aria-pressed', 'false');
        const image = choice.item && equipmentImage(choice.item, options.weapons, 'room-event-icon');
        if (image) action.appendChild(image);
        action.append(node('strong', '', choice.label), node('span', '', choice.benefit));
        const fee = [choice.hpCost ? '生命 −' + choice.hpCost : '', choice.coinCost ? '金币 −' + choice.coinCost : ''].filter(Boolean).join(' · ');
        action.appendChild(node('span', 'gadget-cost', [fee, choice.cost].filter(Boolean).join('；')));
        if (choice.reason) action.appendChild(node('span', 'decision-muted', choice.reason));
        action.disabled = offer.used || !choice.enabled;
        buttons.push(action); choices.appendChild(action);
    }
    actions.append(button('暂不参与', ui.close), confirm);
    scroll.append(heading, choices, preview);
    ui.dialog.append(scroll, status, actions); ui.show();
    return ui;
}

export function showCampTraining(options) {
    const ui = modal("rl-camp-training", "营地培养", options.onClose);
    const select = node("select"); select.id = "camp-character";
    select.setAttribute("aria-label", "培养角色");
    options.cards.forEach(function (card) {
        const option = node("option", "", card.characterZh || card.nameZh || card.name);
        option.value = card.id; select.appendChild(option);
    });
    const profile = node("div", "decision-character");
    const details = node("div");
    const balance = node("p"); balance.id = "camp-balance";
    const levels = node("p"); levels.id = "camp-levels";
    details.append(balance, levels); profile.appendChild(details);
    const label = node("label", "camp-target", "目标等级");
    const target = node("input"); target.id = "camp-target"; target.type = "number"; target.step = "1";
    label.appendChild(target);
    const price = node("p"); price.id = "camp-price";
    const status = node("p", "decision-status"); status.setAttribute("role", "status");
    const actions = node("div", "decision-actions");
    const reasons = { poor: "星彩石不足", max: "已达突破上限", cap: "已达等级上限", noop: "无需练级", invalid: "请输入有效等级",
        storage: "存档写入失败，星彩石和培养进度未改变。" };
    const train = button("练级", function () {
        const result = options.onTrain(Number(select.value), Number(target.value));
        status.textContent = result.reason ? reasons[result.reason] : "练级完成，消耗 " + result.spent + " 星彩石。";
        render(true);
    }, "primary"); train.id = "camp-train";
    const limit = button("限界突破", function () {
        const result = options.onBreak(Number(select.value));
        status.textContent = result.reason ? reasons[result.reason] : "突破完成，上限提升 5 级。";
        render(true);
    }); limit.id = "camp-break";
    actions.append(train, limit, button("关闭", ui.close));
    function render(reset) {
        const id = Number(select.value);
        let data = options.describe(id, Number(target.value));
        if (reset) { target.value = Math.min(data.cap, data.level + 1); data = options.describe(id, Number(target.value)); }
        target.min = Math.min(data.cap, data.level + 1); target.max = data.cap;
        balance.textContent = "星彩石 " + data.gems;
        levels.textContent = "培养等级 " + data.level + " / " + data.cap
            + " · 突破 " + data.limit.lb + " / 4 · 本卷出发 Lv " + Math.max(data.level, options.baseline);
        price.textContent = "练级花费 " + data.training.cost + " · 突破花费 " + data.limit.cost + " 星彩石";
        train.disabled = !!data.training.reason;
        limit.disabled = !!data.limit.reason;
        train.title = reasons[data.training.reason] || ""; limit.title = reasons[data.limit.reason] || "";
        const currentImage = profile.querySelector("img");
        if (!currentImage || currentImage.dataset.card !== String(id)) {
            if (currentImage) { currentImage.remove(); }
            const art = portrait(id, select.selectedOptions[0].textContent); art.dataset.card = id;
            profile.prepend(art);
        }
    }
    select.addEventListener("change", function () { status.textContent = ""; render(true); });
    target.addEventListener("input", function () {
        render(false);
        const data = options.describe(Number(select.value), Number(target.value));
        status.textContent = reasons[data.training.reason] || "";
    });
    ui.dialog.append(select, profile, label, price, status, actions); render(true); ui.show();
    return ui;
}
