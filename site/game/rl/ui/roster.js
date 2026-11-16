import { showCharacterCard } from "./infocard.js";
import { withCardForm } from "../../../core/card-forms.js";

const SITE = new URL("../../../", import.meta.url);
const CARD_ART_BASE = new URL("asset/img/rl/card/", SITE).href;
const ELEMENT_NAMES = ["炎", "水", "土", "风", "月", "阳"];
const CLASS_NAMES = ["战士", "魔法使", "僧侣", "骑士", "炼金术士"];
const CLASS_HELP = ["近身连击，灵活闪避。适合喜欢主动进攻的你。", "以魔法攻击远处的敌人，把握距离与施法时机。", "用恢复与增益延长旅程，稳稳走过每个房间。", "用更坚实的防御面对来敌，寻找反击的机会。", "以削弱与状态效果创造优势，让战斗按你的节奏进行。"];
function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

/** The caller owns unlocks and persistence. This surface only chooses an ID. */
export function createRosterUI(options) {
    const { cards, onSelect, onCodex, onAchievements, onContinue, onTrain, onStorage, skillsTable } = options;
    const unique = new Map();
    for (const card of cards) {
        if (!unique.has(card.characterZh) && card.element >= 0 && card.element <= 5) unique.set(card.characterZh, card);
    }
    const roster = [...unique.values()];
    let selected = roster[0] || null;
    const appearance = card => options.cardForms?.get(card.id);
    const shownCard = card => appearance(card) ? withCardForm(appearance(card), 'base').displayCardId : card.id;
    let previewForm=null;
    let activeElement = null;
    let search = "";
    let departing = false;
    const overlay = node("main", "rl-roster");
    overlay.id = "roster-overlay";
    overlay.setAttribute("aria-label", "花笺旅记 · 冒险营地");
    const nav = node("nav", "ad-nav");
    nav.setAttribute("aria-label", "纪念站导航");
    nav.innerHTML = `<a class="ad-brand" href="${new URL("../index.html", SITE).href}"><span class="ad-brand-mark" aria-hidden="true">✧</span>闪耀幻想曲 · 纪念之庭</a><div class="ad-nav-links"><span class="ad-current">花笺旅记</span><a href="${new URL("etowaria-defense/", SITE).href}">星灯守望 ↗</a></div>`;
    overlay.appendChild(nav);
    const content = node("div", "rl-camp-content");
    overlay.appendChild(content);
    const hero = node("section", "rl-camp-hero");
    hero.innerHTML = `<div class="rl-camp-copy"><p class="ad-eyebrow">闪耀幻想曲外传 · 动作探索</p><h1>花笺<span>旅记</span><i aria-hidden="true">✧</i></h1><p class="rl-camp-motto">故事还没有结束。<br>和熟悉的你，再出发一次。</p><p class="rl-camp-description">走进褪色的世界，找回散落的书页。<br>在每一次相遇中，把回忆重新染上颜色。</p><div class="rl-camp-pills"><span>五卷故事</span><span>随机探索</span><span>原作角色与招式</span></div></div><div class="rl-camp-art" aria-hidden="true"><div class="rl-camp-map"></div><img src="${new URL("imgs/original-characters/Kirara_StandPic_0.png", SITE).href}" alt="" class="rl-camp-guide"><span class="rl-camp-art-caption">旅途的下一页，等你来写。</span></div>`;
    content.appendChild(hero);
    const actions = node("nav", "rl-roster-actions");
    actions.setAttribute("aria-label", "营地功能");
    for (const [id, text, callback] of [
        ["continue", "继续上次冒险 →", onContinue], ["train", "营地培养", onTrain],
        ["codex", "残页图鉴", onCodex], ["achv", "旅途成就", onAchievements], ["storage", "存档与备份", onStorage]
    ]) {
        if (!callback) continue;
        const button = node("button", "ad-button" + (id === "continue" ? " ad-button-primary" : ""), text);
        button.type = "button";
        button.id = "roster-" + id;
        button.addEventListener("click", () => {
            if (id === "continue") {
                if (departing) return;
                departing = true;
                overlay.remove();
            }
            callback();
        });
        actions.appendChild(button);
    }
    const guide = node("button", "ad-button", "初次冒险指南");
    guide.type = "button";
    guide.id = "roster-guide";
    guide.setAttribute("aria-expanded", "false");
    guide.setAttribute("aria-controls", "roster-guide-content");
    actions.appendChild(guide);
    content.appendChild(actions);
    const help = node("section", "rl-camp-help");
    help.id = "roster-guide-content";
    help.hidden = true;
    help.innerHTML = `<div><b>01 · 选择同行者</b><p>选中角色后点击出发。净化3处战斗房或抵达下一层后，在安全房间使用60金币完成本次旅途的进化，新的卡面与模型当场生效。</p></div><div><b>02 · 探索与战斗</b><p><kbd class="ad-key">W A S D</kbd> 移动 · 鼠标攻击 · <kbd class="ad-key">空格</kbd> 闪避<br><kbd class="ad-key">2 / 3</kbd> 技能 · <kbd class="ad-key">R</kbd> 必杀 · <kbd class="ad-key">E</kbd> 互动</p></div><div><b>03 · 带回新的回忆</b><p>清理房间、收集装备、寻找出口。进度自动保存在当前浏览器；手机横竖屏均可使用摇杆与触控按钮。</p></div>`;
    guide.addEventListener("click", () => {
        help.hidden = !help.hidden;
        guide.setAttribute("aria-expanded", String(!help.hidden));
    });
    content.appendChild(help);
    const atelier = node("section", "rl-companions");
    atelier.setAttribute("aria-labelledby", "roster-heading");
    const heading = node("header", "rl-companion-heading");
    heading.innerHTML = `<div><p class="ad-eyebrow">准备下一次相遇</p><h2 id="roster-heading">这一次，和谁一起？</h2></div>`;
    const count = node("span", "rl-roster-count");
    count.setAttribute("role", "status");
    heading.appendChild(count);
    atelier.appendChild(heading);
    const layout = node("div", "rl-roster-layout");
    const preview = node("aside", "rl-companion-preview");
    preview.id = "roster-preview";
    const artwork = node("img", "rl-selected-art");
    artwork.alt = "";
    const copy = node("div", "rl-selected-copy");
    const work = node("p", "ad-eyebrow");
    const name = node("h3");
    name.tabIndex = -1;
    const identity = node("p", "rl-selected-identity");
    const role = node("p", "rl-selected-help");
    const details = node("button", "ad-button", "查看人物与技能");
    details.id = "roster-details";
    details.type = "button";
    details.hidden = !skillsTable;
    const start = node("button", "ad-button ad-button-primary", "选择伙伴后出发");
    start.id = "roster-start";
    start.type = "button";
    const forms = node("div", "rl-form-controls"); forms.setAttribute("aria-label", "角色外观形态");
    for (const [value, label] of [["base", "进化前"], ["evolved", "进化后"]]) {
        const button = node("button", "ad-button", label); button.type = "button"; button.dataset.form = value;
        button.addEventListener("click", () => {
            const card = appearance(selected); if (!card) return;
            previewForm=value;
            select(selected);
        }); forms.append(button);
    }
    const growthHint = node('p', 'rl-form-note', '每段旅程，从最初的你开始。净化3处战斗房，或抵达下一层后，点击头像旁的成长按钮，在安全处用60金币迎接新的身影。');
    copy.append(work, name, identity, role, forms, details, growthHint);
    preview.append(artwork, copy);
    layout.appendChild(preview);
    const catalogue = node("div", "rl-roster-catalogue");
    const searchLabel = node("label", "rl-roster-search");
    searchLabel.appendChild(node("span", "", "寻找同行者"));
    const searchBox = node("input");
    searchBox.type = "search";
    searchBox.placeholder = "搜索角色、作品或职业…";
    searchBox.setAttribute("aria-label", "搜索角色、作品或职业");
    searchBox.autocomplete = "off";
    searchLabel.appendChild(searchBox);
    catalogue.appendChild(searchLabel);
    const filters = node("div", "rl-roster-filters");
    filters.setAttribute("aria-label", "按属性筛选");
    const grid = node("div", "rl-roster-grid");
    grid.setAttribute("aria-label", "同行者列表");
    const empty = node("p", "rl-roster-empty", "还没有找到这位伙伴。试试其他名字，或切回全部属性。");
    empty.hidden = true;
    const cardNodes = [];
    const chips = [];
    const departure=node('div','rl-departure'),current=node('button','rl-current-companion');current.type='button';
    const currentArt=node('img','');currentArt.alt='';const currentCopy=node('span',''),currentName=node('strong','');
    currentCopy.append(currentName,node('small','','卡面与资料 ↗'));current.append(currentArt,currentCopy);
    current.addEventListener('click',()=>{preview.scrollIntoView({block:'start'});name.focus({preventScroll:true});});
    departure.append(current,start);
    function filter() {
        let visible = 0;
        for (const { card, button } of cardNodes) {
            const matches = (activeElement === null || card.element === activeElement)
                && [card.characterZh, card.titleZh, card.classZh].join(" ").toLocaleLowerCase().replace(/\s/g, "").includes(search);
            button.hidden = !matches;
            button.dataset.filteredOut = String(!matches);
            if (matches) visible++;
        }
        count.textContent = `${visible} / ${roster.length} 位同行者`;
        empty.hidden = visible > 0;
    }
    for (const [index, label] of ["全部", ...ELEMENT_NAMES].entries()) {
        const chip = node("button", "rl-roster-filter", label);
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(index === 0));
        chip.addEventListener("click", () => {
            activeElement = index === 0 ? null : index - 1;
            chips.forEach((item, i) => item.setAttribute("aria-pressed", String(i === index)));
            filter();
        });
        chips.push(chip);
        filters.appendChild(chip);
    }
    function select(card) {
        if(selected?.id!==card.id)previewForm=null;
        selected = card;
        const selectedForm=previewForm || 'base';
        const displayId=appearance(card)?withCardForm(appearance(card),selectedForm).displayCardId:card.id;
        artwork.src = CARD_ART_BASE + displayId + ".webp";
        const original = appearance(card); forms.hidden = !original?.evolvedId;
        for (const button of forms.children){
            button.setAttribute('aria-pressed',String(original&&button.dataset.form===selectedForm));
            button.textContent=button.dataset.form==='base'?'进化前':'进化后 · 预览';
        }
        artwork.hidden = false;
        artwork.alt = card.characterZh + "的角色卡";
        work.textContent = card.titleZh || "闪耀幻想曲";
        name.textContent = card.characterZh || card.name;
        identity.textContent = `${card.classZh || CLASS_NAMES[card.class] || "同行者"} · ${ELEMENT_NAMES[card.element]}属性`;
        role.textContent = CLASS_HELP[card.class] || "和这位伙伴一起，找回散落的故事。";
        start.textContent = `与${card.characterZh || card.name}出发 →`;
        currentArt.src = CARD_ART_BASE + shownCard(card) + '.webp';
        currentName.textContent = card.characterZh || card.name;
        current.setAttribute('aria-label',`查看${currentName.textContent}的卡面与资料`);
        start.disabled = false;
        for (const item of cardNodes) item.button.setAttribute("aria-pressed", String(item.card.id === card.id));
    }
    function depart(id) {
        if (departing) return;
        departing = true;
        overlay.remove();
        onSelect?.(id);
    }
    artwork.addEventListener("error", () => { artwork.hidden = true; });
    start.addEventListener("click", () => { if (selected) depart(selected.id); });
    details.addEventListener("click", () => {
        if (selected && skillsTable) showCharacterCard(selected, skillsTable, { artBase: CARD_ART_BASE, artId:shownCard(selected), onSelect: depart });
    });
    for (const card of roster) {
        const button = node("button", "roster-card rl-roster-card");
        button.type = "button";
        button.dataset.cardId = String(card.id);
        button.setAttribute("aria-label", `选择${card.characterZh}，${card.classZh || "同行者"}，${ELEMENT_NAMES[card.element]}属性`);
        button.setAttribute("aria-pressed", "false");
        const art = node("img", "art");
        art.src = CARD_ART_BASE + shownCard(card) + ".webp";
        art.alt = "";
        art.loading = "lazy";
        art.decoding = "async";
        art.addEventListener("error", () => {
            art.replaceWith(node("span", "art missing", (card.characterZh || "伙伴").slice(0, 1)));
        }, { once: true });
        button.append(art, node("span", "who", card.characterZh || card.name), node("span", "rl-card-role", `${ELEMENT_NAMES[card.element]} · ${card.classZh || CLASS_NAMES[card.class] || "同行者"}`));
        button.addEventListener("click", () => select(card));
        cardNodes.push({ card, button });
        grid.appendChild(button);
    }
    searchBox.addEventListener("input", () => { search = searchBox.value.toLocaleLowerCase().replace(/\s/g, ""); filter(); });
    catalogue.append(filters, grid, empty, departure);
    layout.appendChild(catalogue);
    atelier.appendChild(layout);
    content.appendChild(atelier);
    const footer = node("footer", "ad-footer");
    footer.innerHTML = "<span>献给在艾特瓦利亚相遇的每一个你。</span><span>非官方同人作品 · 进度保存在当前浏览器</span>";
    content.appendChild(footer);
    start.disabled = !selected;
    current.disabled = !selected;
    if (selected) select(selected);
    filter();
    return overlay;
}

export function showRoster(cards, options = {}) {
    return new Promise((resolve, reject) => {
        const overlay = createRosterUI({ ...options, cards, onSelect: resolve,
            onCancel: () => reject(new Error("Roster selection cancelled")) });
        document.body.appendChild(overlay);
    });
}
