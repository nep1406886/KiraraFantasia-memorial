import { LEVELS, UNIT_RULES, ENEMY_RULES, DECK_ORDER, GEAR_ORDER, DECK_SIZE, SAVE_KEY, allLevels, levelById } from "../data/campaign.js";
import { CampaignSave } from "./campaign-save.js";
import { portraitMarkup, siteUrl } from "./assets.js";
import { ICONS } from "./icons.js";

const DEFAULT_DECK = DECK_ORDER.slice(0, DECK_SIZE);
const TIME = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const WAVE_LABEL = level => level.endless ? "不限波次" : `${level.waves}波`;
const markup = `
  <div class="campaign-map" data-view="map">
    <header class="panel campaign-header"><button class="native-button compact" data-action="back">返回标题</button><h2>里口花径</h2><span>巡守手记</span><button class="native-button compact" data-action="save">巡守记录</button></header>
    <div class="campaign-map-body">
      <section class="campaign-chapter panel"><div class="chapter-landscape" aria-hidden="true"></div><div class="chapter-description"><h3>把日常守在身后</h3><p>应援台、同伴与每一条道路，都是布阵图的一部分。</p><div class="campaign-faces" data-role="faces"></div><p class="muted">四章十九关和无尽巡守都可以直接选择。每关重新分配クリエ，不把资源带入下一关。</p></div></section>
      <section class="panel campaign-selection" aria-label="选择巡守关卡"><div class="campaign-levels" data-role="levels"></div><div class="level-brief"><h3 data-role="level-title"></h3><p data-role="level-subtitle"></p><dl class="level-facts"><div><dt>布阵区域</dt><dd data-role="area"></dd></div><div><dt>初始应援</dt><dd data-role="budget"></dd></div><div><dt>来袭波次</dt><dd data-role="waves"></dd></div></dl><p data-role="enemy"></p><p data-role="objective"></p><p data-role="rewards"></p><p class="muted" data-role="best"></p></div><div class="campaign-map-actions"><p class="muted">所有关卡都可以直接挑战，也可以重玩已完成的关卡。</p><button class="native-button primary" data-action="prepare">选择阵容</button></div><p class="campaign-disclosure">本作同人改编。当前开放四章十九关与无尽巡守。</p></section>
      <section class="panel deck-picker" data-role="deck-picker" aria-label="选择本次布阵的卡牌" hidden><header class="deck-picker-head"><div><h3>本次布阵</h3><p class="muted">从巡守图鉴里挑最多${DECK_SIZE}张卡同行；可随时返回换一关。</p></div><p class="deck-count" data-role="deck-count"></p></header>
<div class="deck-chosen" data-role="deck-chosen" aria-label="已选择的卡牌"></div><div class="deck-presets" data-role="deck-presets"><span class="deck-presets-label">推荐配置</span><div class="deck-preset-buttons" data-role="deck-preset-buttons"></div></div><div class="deck-grid" data-role="deck-grid"></div><p class="deck-detail" data-role="deck-detail"></p><div class="campaign-map-actions"><button class="native-button compact" data-action="deck-back">返回选关</button><button class="native-button primary" data-action="deck-start">开始巡守</button></div></section>
</div><div class="deck-chosen" data-role="deck-chosen" aria-label="已选择的卡牌"></div><div class="deck-presets" data-role="deck-presets"><span class="deck-presets-label">推荐配置</span><div class="deck-preset-buttons" data-role="deck-preset-buttons"></div></div><div class="deck-grid" data-role="deck-grid"></div><p class="deck-detail" data-role="deck-detail"></p><div class="campaign-map-actions"><button class="native-button compact" data-action="deck-back">返回选关</button><button class="native-button primary" data-action="deck-start">开始巡守</button></div></section>
    </div><p class="save-problem" data-role="save-problem" role="status" hidden></p>
  </div>
  <div class="campaign-battle" data-view="battle" hidden>
    <header class="battle-head">
      <button class="hud-button" data-action="leave" aria-label="返回关卡">${ICONS.back}<span>返回</span></button>
      <div class="battle-heading"><h2 data-role="battle-title"></h2><p data-role="battle-phase">准备布阵</p></div>
      <div class="wave-meter" aria-hidden="true"><span data-role="wave-fill"></span></div>
      <div class="battle-progress"><strong data-role="wave">第1波</strong><span data-role="time">0:00</span></div>
      <button class="hud-button" data-action="settings" aria-label="声音与显示">${ICONS.gear}<span>声音</span></button>
      <button class="hud-button" data-action="codex" aria-label="图鉴">${ICONS.list}<span>图鉴</span></button>
      <button class="hud-button" data-action="pause" aria-pressed="false" aria-label="暂停">${ICONS.pause}<span data-role="pause-label">暂停</span></button>
    </header>
    <div class="battle-seeds">
      <div class="crea-counter" title="クリエ"><span class="crea-icon" aria-hidden="true">${ICONS.crea}</span><strong data-role="crea">0</strong><span class="crea-word">クリエ</span></div>
      <div class="battle-bank" data-role="bank" aria-label="部署卡牌"></div>
    </div>
    <div class="gear-tray" data-role="gear-tray" aria-label="装备栏"><span class="gear-tray-label">装备</span><div class="gear-bank" data-role="gear-bank"></div></div>
    <div class="battle-tools">
      <button class="hud-button start" data-action="start" data-role="setup">${ICONS.play}<span>开始巡守</span></button>
      <div class="placement-actions" data-role="placement-actions" hidden><button class="hud-button confirm" data-action="confirm-placement">${ICONS.check}<span data-role="confirm-label">确认部署</span></button><button class="hud-button" data-action="cancel-placement" aria-label="取消部署">${ICONS.cross}<span>取消</span></button></div>
      <button class="hud-button" data-action="collect" aria-label="收取应援">${ICONS.collect}<span data-role="collect-label">收取</span></button>
      <button class="hud-button" data-action="restock" data-role="restock" hidden aria-label="换卡">${ICONS.gear}<span data-role="restock-label">换卡×0</span></button>
      <button class="hud-button" data-action="recall" aria-pressed="false" aria-label="召回">${ICONS.recall}<span>召回</span></button>
      <button class="hud-button" data-action="inspect" aria-label="战场详情">${ICONS.list}<span>详情</span></button>
      <button class="hud-button" data-action="checkpoint" data-role="checkpoint" hidden aria-label="保存进度">${ICONS.collect}<span data-role="checkpoint-label">保存</span></button>
    </div>
    <div class="battle-viewport" data-role="viewport" role="group" aria-label="巡守战场">
      <div class="battle-canvas" data-role="canvas"></div><div class="battle-labels" data-role="labels"></div><div class="battle-overlay" data-role="overlay"></div><div class="lane-indicators" data-role="lanes"></div>
      <div class="battle-tip" data-role="tip" hidden><strong data-role="selected-name"></strong><span data-role="selected-help"></span><span class="range-caption" data-role="range-caption" hidden></span></div>
      <p class="battle-message" data-role="message" role="status"></p>
      <div class="battle-pause-overlay" data-role="pause-overlay" hidden><div class="panel"><h3>巡守已暂停</h3><p>波次、生产、冷却与攻击全部暂停。</p><div class="pause-actions"><button class="native-button primary compact" data-action="resume">继续巡守</button><button class="native-button compact" data-action="settings">声音设置</button><button class="native-button compact" data-action="leave">返回关卡</button></div></div></div>
      <div class="stage-loading" data-role="loading" hidden><div class="panel loading-card"><h3>把这次布阵准备好</h3><p data-role="load-text">读取原生场地…</p><progress data-role="load-progress" max="1" value="0"></progress></div></div>
      <div class="portrait-notice" data-role="portrait" hidden><div class="panel"><h3>横屏看清整条防线</h3><p>战斗已经暂停。可以旋转屏幕，或返回关卡选择。</p><button class="native-button compact" data-action="leave">返回关卡</button></div></div>
    </div>
  </div>
  <dialog class="panel app-dialog campaign-dialog" data-role="brief-dialog" aria-labelledby="campaign-brief-title"><h2 id="campaign-brief-title">出发之前</h2><div data-role="story"></div><p data-role="opening-tip"></p><p class="muted">场上身影为练习投影，可按费用和冷却重复召唤。对白与塔防数值是本作同人改编。</p><div class="dialog-actions"><button class="native-button primary compact" data-action="brief-close">开始布阵</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="result-dialog" aria-labelledby="campaign-result-title"><h2 id="campaign-result-title" data-role="result-title"></h2><p data-role="result-copy"></p><dl class="result-stats" data-role="result-stats"></dl><div class="reward-list" data-role="result-rewards"></div><p class="muted" data-role="result-save"></p><div class="dialog-actions"><button class="native-button compact" data-action="result-map">回到关卡</button><button class="native-button compact" data-action="retry">重新挑战</button><button class="native-button primary compact" data-action="next">下一关</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="leave-dialog" aria-labelledby="campaign-leave-title"><h2 id="campaign-leave-title">离开本次巡守？</h2><p>本次布阵不会保留，已经完成的关卡记录不变。</p><div class="dialog-actions"><button class="native-button compact" data-action="leave-cancel">留在战场</button><button class="native-button primary compact" data-action="leave-confirm">返回关卡</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="inspect-dialog" aria-labelledby="campaign-inspect-title"><header><h2 id="campaign-inspect-title">战场详情</h2><button class="native-button compact" data-action="inspect-close">关闭</button></header><p>同伴与来敌的实际生命。危急状态同时显示文字，不只依赖颜色。</p><div class="battle-table-wrap"><table class="battle-table"><caption>当前场上的对象</caption><thead><tr><th scope="col">对象</th><th scope="col">位置</th><th scope="col">生命</th><th scope="col">状态</th></tr></thead><tbody data-role="inspect-body"></tbody></table></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="save-dialog" aria-labelledby="campaign-save-title"><header><h2 id="campaign-save-title">巡守记录</h2><button class="native-button compact" data-action="save-close">关闭</button></header><p>只导入或导出本作的通关记录，不读取其他游戏的存档。</p><div class="dialog-actions"><button class="native-button compact" data-action="export">导出记录</button><label class="native-button compact import-label">选择记录文件<input data-role="save-file" type="file" accept="application/json,.json"></label></div><p data-role="import-preview" role="status"></p><button class="native-button primary compact" data-action="import-confirm" hidden>确认替换记录</button></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="error-dialog" aria-labelledby="campaign-error-title"><h2 id="campaign-error-title">这次巡守已暂停</h2><p data-role="error-text"></p><p>未完成的部署不会扣费，也不会让看不见的模型继续攻击。</p><div class="dialog-actions"><button class="native-button compact" data-action="error-map">返回关卡</button><button class="native-button primary compact" data-action="error-retry">重新准备</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog codex-dialog" data-role="codex-dialog" aria-labelledby="codex-title"><header><h2 id="codex-title">巡守图鉴</h2><button class="native-button compact" data-action="codex-close">关闭</button></header><div class="codex-tabs" data-role="codex-tabs"></div><div class="codex-grid" data-role="codex-grid"></div><p class="codex-detail" data-role="codex-detail"></p></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="restock-dialog" aria-labelledby="restock-title"><header><h2 id="restock-title">换一次卡</h2><button class="native-button compact" data-action="restock-cancel">关闭</button></header><p class="muted">消耗一次换卡机会，从图鉴里换一张卡进卡组（不超过${DECK_SIZE}张）。已部署的同伴和已佩戴的装备不受影响。</p><div class="codex-grid" data-role="restock-grid"></div><p class="codex-detail" data-role="restock-detail"></p><div class="dialog-actions"><button class="native-button primary compact" data-action="restock-confirm" data-role="restock-confirm" disabled>确认换卡</button></div></dialog>
`;

export class Campaign {
    constructor(options) {
        this.options = options;
        this.host = options.host;
        this.catalogue = options.catalogue;
        this.audio = options.audio;
        this.host.innerHTML = markup;
        this.view = null;
        this.epoch = 0;
        this.mode = "map";
        this.levelId = "1-1";
        this.keyboardCell = { row: 1, col: 0 };
        this.warnings = new Map();
        this.cards = new Map();
        this.disposed = false;
        let storage;
        if (options.manualClock) {
            storage = { getItem: key => localStorage.getItem(`${key}.review`), setItem: (key, value) => localStorage.setItem(`${key}.review`, value) };
        }
        this.save = new CampaignSave(storage);
        this.levelId = this.save.progress.lastLevel;
        this.bind();
        this.renderMap();
        this.onResize = () => this.orientation();
        this.onVisibility = () => {
            if (!options.manualClock) { this.view?.setPaused("visibility", document.hidden); }
        };
        this.onKey = event => this.key(event);
        window.addEventListener("resize", this.onResize);
        document.addEventListener("visibilitychange", this.onVisibility);
        document.addEventListener("keydown", this.onKey);
    }

    get(role) { return this.host.querySelector(`[data-role="${role}"]`); }
    button(action) { return this.host.querySelector(`[data-action="${action}"]`); }
    unit(id) { return this.catalogue.units.find(unit => unit.id === id); }
    unitArt(id) {
        const unit = this.unit(id);
        if (unit) { return portraitMarkup(unit); }
        const rule = UNIT_RULES[id];
        if (rule?.kind === "gear") {
            const wrap = document.createElement("span");
            wrap.className = "gear-art";
            wrap.setAttribute("role", "img");
            wrap.setAttribute("aria-label", rule.name);
            const image = document.createElement("img");
            image.className = "gear-icon";
            image.src = siteUrl(`asset/img/rl/weapon/${rule.weapon.resourceIdR}.webp`);
            image.alt = rule.name;
            image.draggable = false;
            wrap.append(image);
            return wrap;
        }
        const image = document.createElement("img");
        image.className = "facility-image";
        image.src = new URL(`../assets/items/${id}.png`, import.meta.url).href;
        image.alt = id === "F10" ? "原药瓶道具，本作爆破用途" : "原桌台与旅程书册组合";
        image.draggable = false;
        return image;
    }
    text(role, value) { this.get(role).textContent = value; }
    notice(message) {
        const element = this.get("message");
        element.textContent = message;
        element.classList.add("show");
        clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => element.classList.remove("show"), 3600);
    }

    bind() {
        const actions = {
            back: () => this.options.onBack(), prepare: () => this.showDeckPicker(),
            "deck-back": () => this.hideDeckPicker(), "deck-start": () => this.startLevel(this.levelId),
            leave: () => this.requestLeave(), "leave-confirm": () => this.showMap(),
            "leave-cancel": () => this.closeDialog("leave-dialog", "leave"),
            "brief-close": () => this.closeDialog("brief-dialog", "brief"),
            start: () => this.view?.start(), pause: () => this.togglePause(), resume: () => this.togglePause(),
            collect: () => this.view?.collectAll(), recall: () => this.view?.setRecall(!this.view.recallMode),
            restock: () => this.openRestock(),
            "confirm-placement": () => this.view?.confirmPlacement(),
            "cancel-placement": () => this.view?.cancelPlacement(),
            inspect: () => this.inspect(), checkpoint: () => this.saveCheckpointNow(), "inspect-close": () => this.closeDialog("inspect-dialog", "inspect"),
            settings: () => this.options.onSettings(),
            "result-map": () => this.showMap(), retry: () => this.startLevel(this.levelId),
            next: () => { const index = LEVELS.findIndex(level => level.id === this.levelId); if (LEVELS[index + 1]) { this.startLevel(LEVELS[index + 1].id); } },
            save: () => this.get("save-dialog").showModal(), "save-close": () => this.get("save-dialog").close(),
            codex: () => this.openCodex(), "codex-close": () => this.closeDialog("codex-dialog", "codex"),
            restock: () => this.openRestock(), "restock-cancel": () => this.closeDialog("restock-dialog", "restock"),
            "restock-confirm": () => this.confirmRestock(),
            export: () => this.exportSave(), "import-confirm": () => this.importSave(),
            "error-map": () => this.showMap(), "error-retry": () => this.startLevel(this.levelId)
        };
        this.host.addEventListener("click", event => {
            const button = event.target.closest("[data-action]");
            if (button && actions[button.dataset.action]) { actions[button.dataset.action](); }
        });
        for (const role of ["brief-dialog", "leave-dialog", "inspect-dialog"]) {
            this.get(role).addEventListener("cancel", event => {
                event.preventDefault(); this.closeDialog(role, role.split("-")[0]);
            });
        }
        for (const role of ["result-dialog", "error-dialog"]) { this.get(role).addEventListener("cancel", event => event.preventDefault()); }
        this.get("save-file").addEventListener("change", async event => {
            const file = event.target.files[0];
            this.pendingImport = null;
            this.button("import-confirm").hidden = true;
            try {
                if (!file || file.size > 65536) { throw new Error("请选择小于64KB的记录文件。"); }
                const text = await file.text();
                const { validateProgress } = await import("./campaign-save.js");
                const parsed = validateProgress(JSON.parse(text));
                this.pendingImport = text;
                this.text("import-preview", `将替换为已完成${parsed.completed.length}关的记录。原记录会先备份。`);
                this.button("import-confirm").hidden = false;
            } catch (error) { this.text("import-preview", `未导入：${error.message}`); }
        });
    }

    renderMap() {
        const list = this.get("levels"); list.replaceChildren();
        const faces = this.get("faces"); faces.replaceChildren();
        for (const id of ["U01", "U11", "U15"]) { faces.append(this.unitArt(id)); }
        for (const level of allLevels()) {
            const completed = !level.endless && this.save.progress.completed.includes(level.id);
            const open = this.save.canOpen(level.id);
            const button = document.createElement("button"); button.className = "level-choice";
            button.dataset.level = level.id;
            button.disabled = !open;
            button.setAttribute("aria-pressed", String(level.id === this.levelId));
            const number = document.createElement("span"); number.className = "level-number"; number.textContent = level.endless ? "∞" : level.id;
            const names = document.createElement("span"); names.className = "level-choice-copy";
            const title = document.createElement("strong"); title.textContent = level.title;
            const detail = document.createElement("small"); detail.textContent = `${level.rows}条道路，${WAVE_LABEL(level)}来袭`;
            names.append(title, detail);
            const status = document.createElement("span"); status.className = "level-state"; status.textContent = completed ? "已守住" : open ? "可挑战" : "🔒 先守上一关";
            button.append(number, names, status);
            button.addEventListener("click", () => { this.levelId = level.id; this.renderMap(); });
            list.append(button);
        }
        const level = levelById(this.levelId) || LEVELS[0];
        this.text("level-title", level.title); this.text("level-subtitle", level.subtitle);
        this.text("area", `${level.rows}行 × ${level.cols}列`); this.text("budget", `${level.startResource} クリエ`); this.text("waves", WAVE_LABEL(level));
        this.text("enemy", `来客：${ENEMY_RULES[level.newEnemy].name}。${ENEMY_RULES[level.newEnemy].description}`);
        this.text("objective", level.objective);
        this.text("rewards", level.endless ? "记录最佳波次、击退数和坚持时间。" : "完成记录会保存在巡守手记中。");
        const best = level.endless ? this.save.progress.endless : this.save.progress.best[level.id];
        this.text("best", level.endless
            ? best ? `最佳记录：第${best.wave}波，击退${best.kills}，坚持${TIME(best.time)}。` : `额外目标：${level.optional}。`
            : best ? `最佳记录 ${TIME(best.time)}，消耗${best.gatesUsed}次结界。` : `额外目标：${level.optional}。`);
        this.get("save-problem").hidden = !this.save.problem;
        this.text("save-problem", this.save.problem || "");
        this.renderSetupBanner();
    }

    // A live cache of an in-progress placement lives in localStorage. On the
    // campaign map we surface it as a banner above the level list: "你有一
    // 盘上次的布阵" which the player can resume or dismiss. The banner is
    // deterministic — the cache always wins or always lost in one renderMap
    // pass, never in inconsistent UI state.
    renderSetupBanner() {
        const list = this.get("levels");
        list.querySelectorAll(".setup-banner").forEach(node => node.remove());
        const cache = this.readSetupCache();
        if (!cache) { return; }
        const level = levelById(cache.level);
        if (!level) { this.clearSetupCache(); return; }
        const banner = document.createElement("div"); banner.className = "setup-banner panel";
        const copy = document.createElement("p");
        copy.innerHTML = `上次的布阵还没开始：「${cache.level} ${level.title}」已部署 ${cache.units.length} 张卡牌，要继续吗？`;
        const actions = document.createElement("div"); actions.className = "setup-banner-actions";
        const resume = document.createElement("button"); resume.className = "native-button primary compact";
        resume.textContent = "继续布阵";
        resume.addEventListener("click", () => this.startLevel(cache.level));
        const drop = document.createElement("button"); drop.className = "native-button ghost compact";
        drop.textContent = "丢弃";
        drop.addEventListener("click", () => { this.clearSetupCache(); this.renderMap(); });
        actions.append(resume, drop);
        banner.append(copy, actions);
        list.prepend(banner);
    }

    // The deck step sits between choosing a level and entering it; a run
    // always carries at most DECK_SIZE cards, persisted like PvZ's seed slots.
    showDeckPicker() {
        const level = levelById(this.levelId);
        if (!level || !this.save.canOpen(level.id)) { return; }
        this.hideDeckPicker();
        this.deckChoice = [...(this.save.deck || DEFAULT_DECK)].filter(id => DECK_ORDER.includes(id));
        this.deckFocus = null;
        this.get("deck-picker").hidden = false;
        this.renderDeckPicker();
        this.get("deck-picker").scrollIntoView({ block: "nearest" });
    }
    hideDeckPicker() { this.get("deck-picker").hidden = true; }
    renderDeckPicker() {
        const chosen = this.get("deck-chosen"); chosen.replaceChildren();
        this.deckChoice.forEach((id, index) => {
            const rule = UNIT_RULES[id];
            const chip = document.createElement("span"); chip.className = "deck-chosen-chip";
            const order = document.createElement("b"); order.textContent = String(index + 1);
            const art = document.createElement("span"); art.className = "seed-art"; art.append(this.unitArt(id));
            const name = document.createElement("span"); name.className = "deck-chosen-name"; name.textContent = rule.name;
            chip.title = `${rule.name}：${rule.help}`;
            chip.addEventListener("click", () => this.toggleDeckCard(id));
            chip.append(order, art, name);
            chosen.append(chip);
        });
        const grid = this.get("deck-grid"); grid.replaceChildren();
        for (const id of DECK_ORDER) {
            const rule = UNIT_RULES[id];
            const orderIndex = this.deckChoice.indexOf(id);
            const picked = orderIndex >= 0;
            const button = document.createElement("button"); button.className = "deck-card";
            button.dataset.card = id;
            button.setAttribute("aria-pressed", String(picked));
            button.setAttribute("aria-label", picked ? `${rule.name}，费用${rule.cost}，阵容第${orderIndex + 1}张` : `${rule.name}，费用${rule.cost}，未在阵容`);
            const order = document.createElement("span"); order.className = "order"; order.textContent = picked ? String(orderIndex + 1) : "";
            if (picked) { button.append(order); }
            const art = document.createElement("span"); art.className = "seed-art"; art.append(this.unitArt(id));
            const name = document.createElement("span"); name.className = "seed-name"; name.textContent = rule.name;
            const cost = document.createElement("span"); cost.className = "seed-cost";
            cost.innerHTML = ICONS.crea; cost.append(String(rule.cost));
            button.append(art, name, cost);
            // Thumbnails are real assets; if one never decodes (offline, missing
            // file) the card would otherwise render as an empty hole with no
            // clue which card it is. Fall back to the name first character.
            const icon = art.querySelector("img");
            if (icon) {
                icon.addEventListener("error", () => {
                    art.replaceChildren(Object.assign(document.createElement("span"), { className: "seed-fallback", textContent: rule.name.slice(0, 1) }));
                });
            }
            button.addEventListener("click", () => this.toggleDeckCard(id));
            grid.append(button);
        }
        this.text("deck-count", `已选 ${this.deckChoice.length} / ${DECK_SIZE}`);
        // 推荐职业搭配：本关推荐卡的构成一眼可见。
        const level = levelById(this.levelId);
        if (level?.recommended) {
            const tally = new Map();
            for (const id of level.recommended) {
                const family = UNIT_RULES[id]?.family || "?";
                tally.set(family, (tally.get(family) || 0) + 1);
            }
            this.text("deck-detail", `推荐搭配：${[...tally.entries()].map(([family, count]) => `${family}×${count}`).join("、")}（${level.recommended.length}张）`);
        }
        this.renderPresets(level);
        const focus = this.deckFocus && UNIT_RULES[this.deckFocus];
        this.text("deck-detail", focus ? `${focus.name}：${focus.help}` : DECK_ORDER.length > this.deckChoice.length ? "点一张卡看它的作用，再点一次加入或移出阵容。" : "");
        this.button("deck-start").disabled = !this.deckChoice.length;
    }

    // 推荐配置：一套按职业配比预设的整队按钮。当前关卡有推荐卡组时优先
    // 展示它；否则按通用 archetype（经济+挡线+输出+治疗）给出四个预设。
    PRESETS = {
        standard: ["F01", "U01", "U11", "U07", "U15", "U03", "U06", "F10"],
        rush: ["F01", "F11", "U09", "U34", "U08", "U28", "U16", "F10"],
        fortress: ["F01", "F11", "U12", "U27", "U45", "U74", "U32", "F10"],
        elite: ["F01", "U01", "U13", "U31", "U47", "U49", "U70", "F10"],
    };
    renderPresets(level) {
        const host = this.get("deck-preset-buttons"); if (!host) { return; }
        host.replaceChildren();
        const entries = [];
        if (level?.recommended?.length) { entries.push(["本关推荐", level.recommended.slice(0, DECK_SIZE)]); }
        entries.push(["标准阵", this.PRESETS.standard], ["速攻阵", this.PRESETS.rush], ["铁壁阵", this.PRESETS.fortress], ["精英阵", this.PRESETS.elite]);
        for (const [label, cards] of entries) {
            const button = document.createElement("button"); button.className = "deck-preset";
            button.textContent = label;
            button.title = cards.map(id => UNIT_RULES[id]?.name).filter(Boolean).join("、");
            button.addEventListener("click", () => {
                const usable = cards.filter(id => UNIT_RULES[id] && this.save.unlocked.includes(id));
                this.deckChoice = usable.slice(0, DECK_SIZE);
                this.save.deck = this.deckChoice;
                this.renderDeckPicker();
            });
            host.append(button);
        }
    }
    toggleDeckCard(id) {
        this.deckFocus = id;
        const index = this.deckChoice.indexOf(id);
        if (index >= 0) { this.deckChoice.splice(index, 1); }
        else if (this.deckChoice.length >= DECK_SIZE) { this.text("deck-detail", `最多带${DECK_SIZE}张卡。先移出一张，再把${UNIT_RULES[id].name}加入阵容。`); return; }
        else { this.deckChoice.push(id); }
        this.deckChoice.sort((a, b) => DECK_ORDER.indexOf(a) - DECK_ORDER.indexOf(b));
        this.save.deck = this.deckChoice;
        this.renderDeckPicker();
    }
    closeDialogs() { for (const dialog of this.host.querySelectorAll("dialog[open]")) { dialog.close(); } }
    closeDialog(role, reason) { this.get(role).close(); this.view?.setPaused(reason, false); }

    // Setup-phase auto-cache. Each placement change the sim state is written;
    // the next visit to the campaign map offers "继续未完的布阵" which jumps
    // straight into a battle pre-populated with the same placement.
    setupCacheKey() { return `${SAVE_KEY}.setup`; }
    readSetupCache() {
        try {
            const raw = this.save.storage?.getItem(this.setupCacheKey());
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
    writeSetupCache(view) {
        if (!view) { return; }
        const data = view.battle.serializeSetup();
        try {
            if (data) { this.save.storage?.setItem(this.setupCacheKey(), JSON.stringify(data)); }
        } catch { /* storage may be unavailable; the cache is best-effort. */ }
    }
    clearSetupCache() {
        try { this.save.storage?.removeItem(this.setupCacheKey()); } catch { /* ignore */ }
    }
    cacheSetupSnapshot(view) {
        // Throttle to once per placement epoch: writes happen on every notify.
        if (!view || view.battle.phase !== "setup") { return; }
        const data = view.battle.serializeSetup();
        if (!data) { return; }
        const serialized = JSON.stringify(data);
        if (serialized === this._lastSetupCache) { return; }
        this._lastSetupCache = serialized;
        try { this.save.storage?.setItem(this.setupCacheKey(), serialized); } catch { /* ignore */ }
    }

    releaseBattle() {
        this.epoch++;
        this.view?.dispose(); this.view = null;
        this.closeDialogs();
        this.audio.suspend(false);
        this.get("overlay").replaceChildren(); this.get("lanes").replaceChildren();
    }
    showMap() {
        this.releaseBattle();
        this.mode = "map";
        this.host.querySelector('[data-view="map"]').hidden = false;
        this.host.querySelector('[data-view="battle"]').hidden = true;
        this.levelId = this.save.progress.lastLevel;
        this.renderMap(); this.audio.playTheme("day");
        this.button("prepare").focus({ preventScroll: true });
    }

    async startLevel(id, options = {}) {
        if (!this.save.canOpen(id)) { return; }
        this.hideDeckPicker();
        const cached = !options.skipCache && this.readSetupCache();
        const resuming = cached && cached.level === id ? cached : null;
        this.releaseBattle();
        this.levelId = id;
        this.save.rememberLevel(id);
        this.mode = "battle";
        const epoch = this.epoch;
        const level = levelById(id);
        let deck = [...(this.save.deck || DEFAULT_DECK)].filter(unit => DECK_ORDER.includes(unit) && this.save.unlocked.includes(unit));
        if (!deck.length) { deck = DEFAULT_DECK.slice(); }
        this.runId = `${id}:${Date.now()}:${epoch}`;
        const labels = document.createElement("div"); labels.className = "run-labels";
        const overlay = document.createElement("div"); overlay.className = "run-overlay";
        this.get("labels").replaceChildren(labels);
        this.get("overlay").replaceChildren(overlay);
        this.host.querySelector('[data-view="map"]').hidden = true;
        this.host.querySelector('[data-view="battle"]').hidden = false;
        this.get("loading").hidden = false;
        this.get("load-progress").value = 0;
        this.get("setup").hidden = false;
        this.get("pause-overlay").hidden = true;
        this.text("battle-title", `${id}　${level.title}`);
        this.text("message", "正在准备本关的原模型与特效。");
        this.warnings.clear(); this.buildBank(deck); this.buildLanes(level);
        this.audio.unlock();
        try {
            const { BattleView } = await import("../render/battle-view.js");
            if (epoch !== this.epoch || this.disposed) { return; }
            const view = await BattleView.create({ level, deck, catalogue: this.catalogue, audio: this.audio,
                host: this.get("canvas"), labels, overlay, manualClock: this.options.manualClock,
                isCurrent: () => epoch === this.epoch && !this.disposed,
                onProgress: (value, text) => { if (epoch === this.epoch) { this.get("load-progress").value = value; this.text("load-text", text); } },
                onState: (state, controls) => {
                    if (epoch === this.epoch) {
                        this.updateHud(state, controls);
                        if (this.view) { this.cacheSetupSnapshot(this.view); }
                    }
                },
                onNotice: text => { if (epoch === this.epoch) { this.notice(text); } },
                onWarning: warning => { if (epoch === this.epoch) { this.warnings.set(warning.row, warning); } },
                onInspect: () => this.inspect(),
                onError: error => { if (epoch === this.epoch) { this.error(error); } },
                onFinished: event => { if (epoch === this.epoch) { this.finish(event); } }
            });
            if (epoch !== this.epoch || this.disposed) { view.dispose(); return; }
            this.view = view;
            this.keyboardCell = { row: Math.floor(level.rows / 2), col: 0 };
            if (!resuming && level.endless && this.save.progress.endlessRun) { await this.resumeEndless(view); }
            if (resuming) {
                const { Battle } = await import("../sim/battle.js");
                if (epoch !== this.epoch || this.disposed) { view.dispose(); return; }
                if (Battle.applySetup(view.battle, resuming)) {
                    this.buildBank([...view.battle.deck]);
                    for (const unit of view.battle.units.values()) { await view.applyDeploymentVisual(unit); }
                    this.clearSetupCache();
                    this.notice(`已恢复上次的布阵（${resuming.units.length} 张卡牌）。`);
                }
            }
            this.get("loading").hidden = true;
            this.showBrief(level);
            this.orientation();
            if (document.hidden && !this.options.manualClock) { view.setPaused("visibility", true); }
            view.notify(); view.stage.resize();
        } catch (error) { if (epoch === this.epoch) { this.error(error); } }
    }

    buildBank(deck) {
        this.cards.clear(); const bank = this.get("bank"); bank.replaceChildren();
        deck.forEach((id, index) => {
            const rule = UNIT_RULES[id];
            const button = document.createElement("button"); button.className = "seed-card"; button.dataset.card = id;
            button.setAttribute("aria-pressed", "false");
            const art = document.createElement("span"); art.className = "seed-art"; art.append(this.unitArt(id));
            const name = document.createElement("span"); name.className = "seed-name"; name.textContent = rule.name;
            const cost = document.createElement("span"); cost.className = "seed-cost";
            cost.innerHTML = ICONS.crea; cost.append(String(rule.cost));
            const shade = document.createElement("span"); shade.className = "seed-cooldown"; shade.setAttribute("aria-hidden", "true");
            const state = document.createElement("span"); state.className = "seed-readiness"; state.textContent = "准备中";
            const key = document.createElement("kbd"); key.textContent = String(index + 1);
            button.append(art, name, cost, shade, state, key);
            button.addEventListener("click", () => { if (!this.dragging) { this.view?.select(id); } });
            button.addEventListener("pointerdown", event => this.beginCardDrag(event, id));
            bank.append(button); this.cards.set(id, { button, state, shade });
        });
        this.buildGearTray(this.cards.keys());
    }

    // Equipment is a separate tray, never a seed card. The tray only shows the
    // universal pieces plus the dedicated weapons belonging to characters the
    // current deck actually carries — a companion without a dedicated weapon
    // simply has none, and the tray stays short enough to read at a glance.
    gearForDeck(deck) {
        const carried = new Set(deck || this.deckChoice || []);
        const isUniversal = rule => !rule.gearFor?.length;
        return GEAR_ORDER.filter(id => {
            const rule = UNIT_RULES[id];
            if (isUniversal(rule)) { return true; }
            // Profession-series gear (G01-G14) is intentionally omitted from
            // the tray; only unrestricted equipment and exact card exclusives
            // are carried into a run.
            return rule.gearFor.length === 1 && carried.has(rule.gearFor[0]);
        });
    }
    buildGearTray(deck) {
        this.gearCards = new Map();
        const bank = this.get("gear-bank"); bank.replaceChildren();
        for (const id of this.gearForDeck(deck)) {
            const rule = UNIT_RULES[id];
            const button = document.createElement("button"); button.className = "gear-chip"; button.dataset.card = id;
            button.setAttribute("aria-pressed", "false");
            button.setAttribute("aria-label", `${rule.name}，费用${rule.cost}`);
            const art = document.createElement("span"); art.className = "gear-chip-art"; art.append(this.unitArt(id));
            const name = document.createElement("span"); name.className = "gear-chip-name"; name.textContent = rule.name;
            const cost = document.createElement("span"); cost.className = "gear-chip-cost"; cost.textContent = String(rule.cost);
            const holder = document.createElement("span"); holder.className = "gear-chip-holder"; holder.hidden = true;
            const shade = document.createElement("span"); shade.className = "gear-chip-cooldown"; shade.setAttribute("aria-hidden", "true");
            const state = document.createElement("span"); state.className = "gear-chip-state"; state.setAttribute("aria-hidden", "true");
            button.append(art, name, cost, shade, state, holder);
            button.addEventListener("click", () => { if (!this.dragging) { this.view?.select(id); } });
            bank.append(button); this.gearCards.set(id, { button, holder, shade, state });
        }
    }

    // Touch players drag a card onto the field; releasing over a cell plants
    // it, releasing anywhere else keeps the card in hand, as in the original PvZ.
    beginCardDrag(event, id) {
        if (event.pointerType === "mouse" || !this.view || event.button !== 0) { return; }
        const start = { x: event.clientX, y: event.clientY };
        let moved = false;
        const move = moveEvent => {
            if (!moved && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 12) { return; }
            if (!moved) { moved = true; this.dragging = true; if (this.view.selected !== id || this.view.recallMode) { this.view.select(id); } }
            this.view.dragTo(moveEvent.clientX, moveEvent.clientY);
        };
        const end = upEvent => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
            if (moved && upEvent.type === "pointerup") { this.view?.dropAt(upEvent.clientX, upEvent.clientY); }
            else if (moved) { this.view?.dragTo(null); }
            setTimeout(() => { this.dragging = false; }, 0);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }

    buildLanes(level) {
        this.laneNodes = [];
        const container = this.get("lanes"); container.replaceChildren();
        for (let row = 0; row < level.rows; row++) {
            const marker = document.createElement("span"); marker.className = "lane-gate";
            marker.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20 5.6v6.1c0 4.9-3.4 8.4-8 9.8-4.6-1.4-8-4.9-8-9.8V5.6Z" fill="currentColor"/></svg>';
            const number = document.createElement("b"); number.textContent = String(row + 1); marker.append(number);
            marker.setAttribute("role", "img");
            const warning = document.createElement("span"); warning.className = "lane-warning"; warning.hidden = true;
            container.append(marker, warning); this.laneNodes.push({ marker, warning });
        }
    }

    updateHud(state, controls) {
        this.lastState = state;
        this.text("crea", String(state.resource)); this.text("time", TIME(state.time));
        if (state.endless) {
            const tag = state.waveModifier?.label;
            this.text("wave", tag ? `第${state.wave}波 · ${tag}` : `第${state.wave}波`);
            this.get("wave").dataset.modifier = state.waveModifier?.kind || "";
        } else {
            this.text("wave", `第${state.wave} / ${state.totalWaves}波`);
            this.get("wave").dataset.modifier = "";
        }
        const progress = state.endless ? (state.wave - 1 + Math.min(1, state.waveProgress || 0)) % 1 || 0
            : Math.min(1, (state.totalSpawns - state.scheduledRemaining) / Math.max(1, state.totalSpawns));
        this.get("wave-fill").style.transform = `scaleX(${progress})`;
        this.text("battle-phase", state.phase === "setup" ? "准备布阵" : state.phase === "running" ? `场上${state.enemies.length}位来客` : state.phase === "won" ? "防线守住了" : "本次失守");
        this.get("setup").hidden = state.phase !== "setup";
        const paused = state.pauses.includes("manual");
        this.get("pause-overlay").hidden = !paused;
        this.button("pause").setAttribute("aria-pressed", String(paused));
        this.button("pause").setAttribute("aria-label", paused ? "继续" : "暂停");
        this.text("pause-label", paused ? "继续" : "暂停");
        this.button("pause").disabled = state.phase !== "setup" && state.phase !== "running";
        this.button("collect").disabled = !state.pickups.length || !!state.pauses.length;
        this.text("collect-label", state.pickups.length ? `收取 ${state.pickups.length}` : "收取");
        const restockButton = this.button("restock");
        restockButton.hidden = !(state.endless && state.restocks > 0);
        this.text("restock-label", `换卡×${state.restocks || 0}`);
        this.button("recall").setAttribute("aria-pressed", String(controls.recall));
        this.button("recall").disabled = !["setup", "running"].includes(state.phase);
        this.button("start").disabled = controls.loading || !!state.pauses.length;
        for (const [id, entry] of this.cards) {
            const remaining = state.cooldowns[id] || 0;
            const shortage = Math.max(0, UNIT_RULES[id].cost - state.resource);
            const status = remaining > .001 ? `${Math.ceil(remaining)}秒` : shortage ? `差${shortage}` : "可部署";
            entry.state.textContent = status;
            entry.shade.style.transform = `scaleY(${remaining > .001 ? Math.min(1, remaining / UNIT_RULES[id].deployCooldown) : 0})`;
            entry.button.classList.toggle("cooling", remaining > .001);
            entry.button.classList.toggle("poor", !remaining && shortage > 0);
            entry.button.classList.toggle("unavailable", remaining > .001 || shortage > 0);
            entry.button.setAttribute("aria-pressed", String(!controls.recall && controls.selected === id));
            entry.button.setAttribute("aria-label", `${UNIT_RULES[id].name}，费用${UNIT_RULES[id].cost}，${remaining > .001 ? `冷却${status}` : shortage ? `还差${shortage}` : status}`);
            entry.button.disabled = controls.loading || !["setup", "running"].includes(state.phase);
        }
        const worn = new Map();
        for (const unit of state.units) { if (unit.gear) { worn.set(unit.gear, UNIT_RULES[unit.type].name); } }
        for (const [id, entry] of this.gearCards || []) {
            const rule = UNIT_RULES[id];
            const holder = worn.get(id);
            const remaining = state.cooldowns[id] || 0;
            const shortage = Math.max(0, rule.cost - state.resource);
            entry.holder.hidden = !holder;
            entry.holder.textContent = holder || "";
            entry.state.textContent = remaining > .001 ? `${Math.ceil(remaining)}s` : "";
            entry.shade.style.transform = `scaleX(${remaining > .001 ? Math.min(1, remaining / rule.deployCooldown) : 0})`;
            entry.button.classList.toggle("worn", !!holder);
            entry.button.classList.toggle("cooling", remaining > .001);
            entry.button.classList.toggle("poor", !holder && !remaining && shortage > 0);
            entry.button.setAttribute("aria-pressed", String(!controls.recall && controls.selected === id));
            entry.button.setAttribute("aria-label", holder ? `${rule.name}，${holder}已佩戴`
                : remaining > .001 ? `${rule.name}，冷却还剩${Math.ceil(remaining)}秒`
                : `${rule.name}，费用${rule.cost}，${shortage ? `还差${shortage}` : "可佩戴"}`);
            entry.button.disabled = controls.loading || !["setup", "running"].includes(state.phase);
        }
        const rule = UNIT_RULES[controls.selected];
        const holding = controls.recall || !!rule;
        this.get("tip").hidden = !holding;
        this.get("tip").classList.toggle("invalid", !!controls.preview && !controls.preview.valid);
        this.text("selected-name", controls.recall ? "召回" : rule?.name || "");
        this.text("selected-help", controls.recall ? state.phase === "setup" ? "准备阶段全额退还。" : "开战后不退还费用。"
            : rule?.kind === "gear" ? `点已部署的同伴佩戴。${rule.help}` : rule?.help || "");
        this.get("range-caption").hidden = !controls.preview;
        this.text("range-caption", controls.preview ? `第${controls.preview.row + 1}路，第${controls.preview.col + 1}格：${controls.preview.text}${controls.preview.valid ? "" : `。${controls.preview.reason}`}` : "");
        this.get("placement-actions").hidden = !controls.touchConfirm;
        this.button("confirm-placement").disabled = controls.loading || !controls.preview?.valid;
        this.text("confirm-label", controls.recall ? "确认召回" : "确认部署");
        if (this.view) {
            this.laneNodes.forEach(({ marker, warning }, row) => {
                marker.classList.toggle("spent", !state.gates[row]);
                marker.setAttribute("aria-label", `${row + 1}路 ${state.gates[row] ? "紧急结界可用" : "紧急结界已用"}`);
                marker.title = marker.getAttribute("aria-label");
                const point = this.view.world(row, -.9).project(this.view.stage.camera);
                marker.style.left = `${(point.x + 1) * this.view.stage.width / 2}px`;
                marker.style.top = `${(1 - point.y) * this.view.stage.height / 2}px`;
                const incoming = this.warnings.get(row);
                warning.hidden = !incoming || incoming.at < state.time;
                if (!warning.hidden) { warning.textContent = `${ENEMY_RULES[incoming.enemyType].name} ${Math.max(0, Math.ceil(incoming.at - state.time))}秒`; }
                const entry = this.view.world(row, this.view.level.cols + .1).project(this.view.stage.camera);
                warning.style.left = `${Math.min(this.view.stage.width - 6, (entry.x + 1) * this.view.stage.width / 2)}px`;
                warning.style.top = marker.style.top;
            });
        }
    }

    showBrief(level) {
        const story = this.get("story"); story.replaceChildren();
        for (const line of level.story) {
            const block = document.createElement("p"); const name = document.createElement("strong"); name.textContent = `${line.name}：`;
            block.append(name, document.createTextNode(line.text)); story.append(block);
        }
        this.text("opening-tip", level.openingTip);
        this.view.setPaused("brief", true);
        this.get("brief-dialog").showModal();
    }

    // ── 无尽进度存档 ────────────────────────────────────────────────────
    // autosave piggybacks on updateHud (already 12×/s): only fires on wave
    // change (spawnIndex advance) or every 30s, whichever first. Zero added
    // timers, one ≤2KB stringify per checkpoint, and the wave-change guard
    // means the hot path is a two-number comparison.
    maybeAutosaveEndless(state) {
        if (!this.view || !this.view.battle.level.endless || state.phase !== "running") { return; }
        const battle = this.view.battle;
        const tick = battle.spawnIndex * 100000 + Math.floor(state.time / 30);
        if (this._lastEndlessSave === tick) { return; }
        this._lastEndlessSave = tick;
        const ok = this.save.saveEndlessRun(battle.serializeEndless());
        if (ok) { this.text("checkpoint-label", "已存"); }
    }
    saveCheckpointNow() {
        if (!this.view || !this.view.battle.level.endless) { return; }
        const battle = this.view.battle;
        if (battle.phase !== "running" && battle.phase !== "setup") { return; }
        battle.pause("checkpoint", true);
        const ok = this.save.saveEndlessRun(battle.serializeEndless());
        battle.pause("checkpoint", false);
        this._lastEndlessSave = battle.spawnIndex * 100000 + Math.floor(battle.time / 30);
        this.notice(ok ? `进度已保存：第${battle.wave}波。` : "本次进度未能写入存档。");
    }
    // Resume: on entering the endless level, a matching checkpoint restores
    // the bench and wave clock instead of a fresh wave 1 start.
    async resumeEndless(view) {
        const checkpoint = this.save.progress.endlessRun;
        if (!checkpoint || checkpoint.wave < 2) { return false; }
        const { Battle } = await import("../sim/battle.js");
        if (Battle.applyEndless(view.battle, checkpoint)) {
            this.buildBank([...view.battle.deck]);
            for (const unit of view.battle.units.values()) { await view.applyDeploymentVisual(unit); }
            this._lastEndlessSave = view.battle.spawnIndex * 100000 + Math.floor(0 / 30);
            this.notice(`已恢复无尽进度：第${checkpoint.wave}波，${checkpoint.units.length} 张卡牌在场。`);
            return true;
        }
        return false;
    }

    finish(event) {
        if (!this.view) { return; }
        const battle = this.view.battle;
        this.clearSetupCache();
        const result = this.save.finish(this.runId, battle);
        if (battle.level.endless) { this.save.clearEndlessRun(); this._lastEndlessSave = null; }
        const won = event.result === "won";
        const endless = !!battle.level.endless;
        this.text("result-title", won ? "这片日常，守住了" : endless ? "无尽巡守到此为止" : "先回去，重新画一张图");
        this.text("result-copy", won ? `${battle.level.title}完成。${event.stats.gatesUsed ? "结界替大家争取了时间。" : "每一条道路都守住了。"}`
            : endless ? `本次守到第${event.wave}波，击退${event.stats.kills}位来客。`
            : `第${event.row + 1}路被突破。可以试着减少前期支出，或更早补上这一条路的输出。`);
        const stats = this.get("result-stats"); stats.replaceChildren();
        const rows = endless
            ? [["坚持波次", `第${event.wave}波`], ["击退来客", String(event.stats.kills)], ["巡守时间", TIME(battle.time)], ["使用结界", `${event.stats.gatesUsed}次`]]
            : [["巡守时间", TIME(battle.time)], ["击退来客", String(event.stats.kills)], ["使用结界", `${event.stats.gatesUsed}次`], ["有效治疗", String(event.stats.healed)]];
        for (const [name, value] of rows) {
            const part = document.createElement("div"); const dt = document.createElement("dt"); dt.textContent = name;
            const dd = document.createElement("dd"); dd.textContent = value; part.append(dt, dd); stats.append(part);
        }
        const rewardList = this.get("result-rewards"); rewardList.replaceChildren();
        const text = document.createElement("p");
        text.textContent = endless ? (result.newRecord ? "新的无尽记录已写入手记。" : "本次没有超过已有的无尽记录。")
            : won ? "本次巡守结果已写入手记。" : "未改变通关记录。";
        rewardList.append(text);
        this.text("result-save", this.save.problem || (endless ? (result.newRecord ? "最佳波次已保存。" : "最佳波次保持不变。") : won ? "巡守记录已保存。" : "未改变通关记录。"));
        const index = LEVELS.findIndex(level => level.id === this.levelId);
        this.button("next").hidden = endless || !won || index === LEVELS.length - 1;
        if (won && index === LEVELS.length - 1) {
            const ending = document.createElement("p"); ending.textContent = "当前两章已完成。紧急爆破术式可在重玩时使用，后续章节仍在制作。"; rewardList.append(ending);
        }
        this.audio.setTrack(won ? "bgm_battle_win" : "bgm_town_1");
        this.get("result-dialog").showModal();
    }

    togglePause() {
        if (!this.view || !["running", "setup"].includes(this.view.battle.phase)) { return; }
        this.view.setPaused("manual", !this.view.battle.pauses.has("manual"));
    }
    requestLeave() {
        if (!this.view || !["running", "setup"].includes(this.view.battle.phase)) { this.showMap(); return; }
        this.view.setPaused("leave", true); this.get("leave-dialog").showModal();
    }
    setSettingsPaused(paused) { this.view?.setPaused("settings", paused); }
    orientation() {
        if (this.mode !== "battle") { return; }
        const narrow = innerWidth < 640 && innerHeight > innerWidth;
        this.get("portrait").hidden = !narrow;
        this.view?.setPaused("orientation", narrow);
        this.view?.stage.resize();
    }

    // ─── 图鉴 ───────────────────────────────────────────────────────────
    // One dialog browses every companion, facility and enemy with its real
    // card art, original identity and combat stats. Tabs switch sections.
    codexSections() {
        return [
            { key: "companion", label: "同伴", rows: DECK_ORDER.filter(id => UNIT_RULES[id].kind !== "producer" && UNIT_RULES[id].kind !== "burst") },
            { key: "facility", label: "设施", rows: DECK_ORDER.filter(id => UNIT_RULES[id].kind === "producer" || UNIT_RULES[id].kind === "burst") },
            { key: "gear", label: "装备", rows: GEAR_ORDER },
            { key: "enemy", label: "来客", rows: Object.keys(ENEMY_RULES) }
        ];
    }
    openCodex(section = "companion") {
        this.codexSection = section;
        const tabs = this.get("codex-tabs"); tabs.replaceChildren();
        for (const { key, label } of this.codexSections()) {
            const button = document.createElement("button");
            button.className = "native-button compact codex-tab";
            button.dataset.section = key;
            button.setAttribute("aria-pressed", String(key === section));
            button.textContent = label;
            button.addEventListener("click", () => this.openCodex(key));
            tabs.append(button);
        }
        const rows = this.codexSections().find(entry => entry.key === section)?.rows || [];
        const grid = this.get("codex-grid"); grid.replaceChildren();
        this.text("codex-detail", "");
        for (const id of rows) {
            const rule = section === "enemy" ? ENEMY_RULES[id] : UNIT_RULES[id];
            const card = document.createElement("button");
            card.className = "codex-card";
            card.dataset.codex = id;
            const art = document.createElement("span"); art.className = "seed-art";
            if (section === "enemy") {
                const label = document.createElement("span"); label.className = "codex-enemy-art";
                label.textContent = (rule.name || "?").slice(0, 1);
                art.append(label);
            } else { art.append(this.unitArt(id)); }
            const name = document.createElement("span"); name.className = "seed-name"; name.textContent = rule.name;
            card.append(art, name);
            card.addEventListener("click", () => {
                const help = section === "enemy"
                    ? `${rule.name}：${rule.description || ""}`
                    : `${rule.name}（${rule.role}）：${rule.help}`;
                this.text("codex-detail", help);
            });
            grid.append(card);
        }
        this.get("codex-dialog").showModal();
        this.view?.setPaused("codex", true);
    }

    // ─── 换卡（无尽每5波一次） ────────────────────────────────────────────
    openRestock() {
        const view = this.view;
        if (!view || view.battle.restocks < 1) { return; }
        view.setPaused("restock", true);
        this.restockPick = null;
        const deck = [...view.battle.deck];
        const grid = this.get("restock-grid"); grid.replaceChildren();
        this.text("restock-detail", "");
        this.button("restock-confirm").disabled = true;
        const pool = DECK_ORDER.filter(id => !deck.includes(id));
        for (const id of pool) {
            const rule = UNIT_RULES[id];
            const card = document.createElement("button");
            card.className = "codex-card";
            card.dataset.codex = id;
            const art = document.createElement("span"); art.className = "seed-art"; art.append(this.unitArt(id));
            const name = document.createElement("span"); name.className = "seed-name"; name.textContent = rule.name;
            card.append(art, name);
            card.addEventListener("click", () => {
                this.restockPick = id;
                this.button("restock-confirm").disabled = false;
                this.text("restock-detail", `${rule.name}（${rule.role}）：${rule.help}`);
            });
            grid.append(card);
        }
        this.get("restock-dialog").showModal();
    }
    confirmRestock() {
        const view = this.view;
        if (!view || !this.restockPick || view.battle.restocks < 1) { return; }
        const battle = view.battle;
        battle.restocks--;
        battle.deck.add(this.restockPick);
        this.buildBank([...battle.deck]);
        // The gear tray follows the new deck: universal gear stays, dedicated
        // pieces re-filter to whoever is now carried. Worn gear on deployed
        // companions is untouched — only the tray chips re-render.
        this.buildGearTray([...battle.deck]);
        // Pause for the dialog came through the view; the sim mirrors it.
        this.get("restock-dialog").close();
        view.setPaused("restock", false);
        this.notice(`${UNIT_RULES[this.restockPick].name}已换入卡组。换卡机会剩 ${battle.restocks} 次。`);
        this.restockPick = null;
    }

    inspect() {
        if (!this.view) { return; }
        this.view.setPaused("inspect", true);
        const body = this.get("inspect-body"); body.replaceChildren();
        const state = this.view.battle.snapshot();
        for (const unit of [...state.units, ...state.enemies]) {
            const friend = UNIT_RULES[unit.type]; const rule = friend || ENEMY_RULES[unit.type];
            const row = document.createElement("tr");
            const values = [`${friend ? "我方" : "来客"} ${rule.name}`, `${unit.row + 1}路，${friend ? `${unit.col + 1}格` : "行进中"}`,
                `${Math.ceil(unit.hp)} / ${unit.maxHp}`, unit.hp / unit.maxHp <= .25 ? "危急" : friend ? "在位" : unit.state === "walking" ? "前进" : "攻击中"];
            for (const value of values) { const td = document.createElement("td"); td.textContent = value; row.append(td); }
            body.append(row);
        }
        if (!body.children.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 4; cell.textContent = "还没有部署对象。可以先选择应援采集台。"; row.append(cell); body.append(row); }
        this.get("inspect-dialog").showModal();
    }

    key(event) {
        if (this.host.hidden || this.mode !== "battle" || !this.view || document.querySelector("dialog[open]") || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) { return; }
        const key = event.key.toLowerCase();
        if (/^[1-8]$/.test(key)) { const type = [...this.cards.keys()][Number(key) - 1]; if (type) { this.view.select(type); } }
        else if (key === "c") { this.view.collectAll(); }
        else if (key === "r") { this.view.setRecall(!this.view.recallMode); }
        else if (event.code === "Space") { event.preventDefault(); if (!event.repeat) { this.togglePause(); } }
        else if (key === "escape") { this.view.cancelPlacement(); }
        else if (key.startsWith("arrow")) {
            event.preventDefault();
            if (!this.view.selected && !this.view.recallMode) { this.notice("请先按数字键或点选一张卡牌，再用方向键选格。"); return; }
            this.keyboardCell.row = Math.max(0, Math.min(this.view.level.rows - 1, this.keyboardCell.row + (key === "arrowdown" ? 1 : key === "arrowup" ? -1 : 0)));
            this.keyboardCell.col = Math.max(0, Math.min(this.view.level.cols - 1, this.keyboardCell.col + (key === "arrowright" ? 1 : key === "arrowleft" ? -1 : 0)));
            this.view.pointCell(this.keyboardCell.row, this.keyboardCell.col);
        } else if (key === "enter" && event.target === this.view.stage.renderer.domElement) {
            event.preventDefault(); this.view.deployCell(this.keyboardCell.row, this.keyboardCell.col);
        }
    }

    error(error) {
        console.error("巡守：", error);
        this.get("loading").hidden = true;
        this.view?.setPaused("error", true);
        this.text("error-text", error.message || String(error));
        if (!this.get("error-dialog").open) { this.get("error-dialog").showModal(); }
    }
    exportSave() {
        const url = URL.createObjectURL(new Blob([this.save.export()], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "里之守望-巡守记录.json"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    importSave() {
        if (!this.pendingImport) { return; }
        try { this.save.import(this.pendingImport); this.levelId = this.save.progress.lastLevel; this.renderMap(); this.text("import-preview", this.save.problem || "巡守记录已导入。"); this.button("import-confirm").hidden = true; this.pendingImport = null; }
        catch (error) { this.text("import-preview", `未导入：${error.message}`); }
    }
    snapshot() {
        return { mode: this.mode, level: this.levelId, progress: JSON.parse(this.save.export()), unlocked: this.save.unlocked,
            battle: this.view?.snapshot() || null, error: this.get("error-dialog").open ? this.get("error-text").textContent : null,
            brief: this.get("brief-dialog").open, result: this.get("result-dialog").open };
    }
    cellPoint(row, col) {
        if (!this.view) { return null; }
        const stage = this.view.stage; const point = this.view.world(row, col).project(stage.camera);
        const rect = stage.renderer.domElement.getBoundingClientRect();
        return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
    }
    dispose() {
        if (this.disposed) { return; }
        this.disposed = true; this.releaseBattle();
        window.removeEventListener("resize", this.onResize);
        document.removeEventListener("visibilitychange", this.onVisibility);
        document.removeEventListener("keydown", this.onKey);
    }
}
