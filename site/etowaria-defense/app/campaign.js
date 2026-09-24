import { LEVELS, UNIT_RULES, ENEMY_RULES, levelById } from "../data/campaign.js";
import { CampaignSave } from "./campaign-save.js";
import { portraitMarkup } from "./assets.js";

const ORDER = ["F01", "U01", "U11", "U07", "U15", "F10"];
const TIME = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const markup = `
  <div class="campaign-map" data-view="map">
    <header class="panel campaign-header"><button class="native-button compact" data-action="back">返回标题</button><h2>里口花径</h2><span>巡守手记</span><button class="native-button compact" data-action="save">巡守记录</button></header>
    <div class="campaign-map-body">
      <section class="campaign-chapter panel"><div class="chapter-landscape" aria-hidden="true"></div><div class="chapter-description"><h3>把日常守在身后</h3><p>应援台、同伴与每一条道路，都是布阵图的一部分。</p><div class="campaign-faces" data-role="faces"></div><p class="muted">前三关逐步开放经济、挡线和治疗。每关重新分配クリエ，不把资源带入下一关。</p></div></section>
      <section class="panel campaign-selection" aria-label="选择巡守关卡"><div class="campaign-levels" data-role="levels"></div><div class="level-brief"><h3 data-role="level-title"></h3><p data-role="level-subtitle"></p><dl class="level-facts"><div><dt>布阵区域</dt><dd data-role="area"></dd></div><div><dt>初始应援</dt><dd data-role="budget"></dd></div><div><dt>来袭波次</dt><dd data-role="waves"></dd></div></dl><p data-role="enemy"></p><p data-role="objective"></p><p data-role="rewards"></p><p class="muted" data-role="best"></p></div><div class="campaign-map-actions"><p class="muted">可以重玩已完成的关卡，试试不同的布阵。</p><button class="native-button primary" data-action="prepare">准备出发</button></div><p class="campaign-disclosure">本作同人改编。当前开放前三关，后续章节尚未制作。</p></section>
    </div><p class="save-problem" data-role="save-problem" role="status" hidden></p>
  </div>
  <div class="campaign-battle" data-view="battle" hidden>
    <header class="panel battle-header"><button class="native-button compact" data-action="leave">返回关卡</button><div><h2 data-role="battle-title"></h2><p data-role="battle-phase">准备布阵</p></div><div class="crea-counter"><span>クリエ</span><strong data-role="crea">0</strong></div><div class="battle-progress"><strong data-role="wave">第1波</strong><span data-role="time">0:00</span></div><button class="native-button compact" data-action="settings">声音</button><button class="native-button compact" data-action="pause" aria-pressed="false">暂停</button></header>
    <div class="battle-bank" data-role="bank" aria-label="部署卡牌"></div>
    <div class="battle-viewport" data-role="viewport" role="group" aria-label="巡守战场">
      <div class="battle-canvas" data-role="canvas"></div><div class="battle-labels" data-role="labels"></div><div class="battle-overlay" data-role="overlay"></div><div class="lane-indicators" data-role="lanes"></div>
      <div class="battle-help-overlay" data-role="setup"><p>准备阶段可先部署，冷却将在开局后推进。</p><button class="native-button primary compact" data-action="start">开始巡守</button></div>
      <div class="battle-pause-overlay" data-role="pause-overlay" hidden><div class="panel"><h3>巡守已暂停</h3><p>波次、生产、冷却与攻击全部暂停。</p><button class="native-button primary compact" data-action="resume">继续巡守</button></div></div>
      <div class="stage-loading" data-role="loading" hidden><div class="panel loading-card"><h3>把这次布阵准备好</h3><p data-role="load-text">读取原生场地…</p><progress data-role="load-progress" max="1" value="0"></progress></div></div>
      <div class="portrait-notice" data-role="portrait" hidden><div class="panel"><h3>横屏看清整条防线</h3><p>战斗已经暂停。可以旋转屏幕，或返回关卡选择。</p><button class="native-button compact" data-action="leave">返回关卡</button></div></div>
    </div>
    <footer class="panel battle-footer"><div class="battle-selection"><strong data-role="selected-name">应援采集台</strong><p data-role="selected-help"></p><p class="range-caption" data-role="range-caption" hidden></p></div><div class="placement-actions" data-role="placement-actions" hidden><button class="native-button primary compact" data-action="confirm-placement">确认部署</button><button class="native-button compact" data-action="cancel-placement">取消</button></div><button class="native-button compact" data-action="collect">收取应援</button><button class="native-button compact" data-action="recall" aria-pressed="false">召回</button><button class="native-button compact" data-action="inspect">战场详情</button></footer>
    <p class="battle-message" data-role="message" role="status">选卡后点空格部署。资源8秒后自动收取。</p>
  </div>
  <dialog class="panel app-dialog campaign-dialog" data-role="brief-dialog" aria-labelledby="campaign-brief-title"><h2 id="campaign-brief-title">出发之前</h2><div data-role="story"></div><p data-role="opening-tip"></p><p class="muted">场上身影为练习投影，可按费用和冷却重复召唤。对白与塔防数值是本作同人改编。</p><div class="dialog-actions"><button class="native-button primary compact" data-action="brief-close">开始布阵</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="result-dialog" aria-labelledby="campaign-result-title"><h2 id="campaign-result-title" data-role="result-title"></h2><p data-role="result-copy"></p><dl class="result-stats" data-role="result-stats"></dl><div class="reward-list" data-role="result-rewards"></div><p class="muted" data-role="result-save"></p><div class="dialog-actions"><button class="native-button compact" data-action="result-map">回到关卡</button><button class="native-button compact" data-action="retry">重新挑战</button><button class="native-button primary compact" data-action="next">下一关</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="leave-dialog" aria-labelledby="campaign-leave-title"><h2 id="campaign-leave-title">离开本次巡守？</h2><p>本次布阵不会保留，已经完成的关卡记录不变。</p><div class="dialog-actions"><button class="native-button compact" data-action="leave-cancel">留在战场</button><button class="native-button primary compact" data-action="leave-confirm">返回关卡</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="inspect-dialog" aria-labelledby="campaign-inspect-title"><header><h2 id="campaign-inspect-title">战场详情</h2><button class="native-button compact" data-action="inspect-close">关闭</button></header><p>同伴与来敌的实际生命。危急状态同时显示文字，不只依赖颜色。</p><div class="battle-table-wrap"><table class="battle-table"><caption>当前场上的对象</caption><thead><tr><th scope="col">对象</th><th scope="col">位置</th><th scope="col">生命</th><th scope="col">状态</th></tr></thead><tbody data-role="inspect-body"></tbody></table></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="save-dialog" aria-labelledby="campaign-save-title"><header><h2 id="campaign-save-title">巡守记录</h2><button class="native-button compact" data-action="save-close">关闭</button></header><p>只导入或导出本作的通关记录，不读取其他游戏的存档。</p><div class="dialog-actions"><button class="native-button compact" data-action="export">导出记录</button><label class="native-button compact import-label">选择记录文件<input data-role="save-file" type="file" accept="application/json,.json"></label></div><p data-role="import-preview" role="status"></p><button class="native-button primary compact" data-action="import-confirm" hidden>确认替换记录</button></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="error-dialog" aria-labelledby="campaign-error-title"><h2 id="campaign-error-title">这次巡守已暂停</h2><p data-role="error-text"></p><p>未完成的部署不会扣费，也不会让看不见的模型继续攻击。</p><div class="dialog-actions"><button class="native-button compact" data-action="error-map">返回关卡</button><button class="native-button primary compact" data-action="error-retry">重新准备</button></div></dialog>
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
        const image = document.createElement("img");
        image.className = "facility-image";
        image.src = new URL(`../assets/items/${id}.png`, import.meta.url).href;
        image.alt = id === "F10" ? "原药瓶道具，本作爆破用途" : "原桌台与旅程书册组合";
        image.draggable = false;
        return image;
    }
    text(role, value) { this.get(role).textContent = value; }
    notice(message) { this.text("message", message); }

    bind() {
        const actions = {
            back: () => this.options.onBack(), prepare: () => this.startLevel(this.levelId),
            leave: () => this.requestLeave(), "leave-confirm": () => this.showMap(),
            "leave-cancel": () => this.closeDialog("leave-dialog", "leave"),
            "brief-close": () => this.closeDialog("brief-dialog", "brief"),
            start: () => this.view?.start(), pause: () => this.togglePause(), resume: () => this.togglePause(),
            collect: () => this.view?.collectAll(), recall: () => this.view?.setRecall(!this.view.recallMode),
            "confirm-placement": () => this.view?.confirmPlacement(),
            "cancel-placement": () => this.view?.cancelPlacement(),
            inspect: () => this.inspect(), "inspect-close": () => this.closeDialog("inspect-dialog", "inspect"),
            settings: () => this.options.onSettings(),
            "result-map": () => this.showMap(), retry: () => this.startLevel(this.levelId),
            next: () => { const index = LEVELS.findIndex(level => level.id === this.levelId); if (LEVELS[index + 1]) { this.startLevel(LEVELS[index + 1].id); } },
            save: () => this.get("save-dialog").showModal(), "save-close": () => this.get("save-dialog").close(),
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
        for (const level of LEVELS) {
            const open = this.save.canOpen(level.id);
            const completed = this.save.progress.completed.includes(level.id);
            const button = document.createElement("button"); button.className = "level-choice";
            button.dataset.level = level.id; button.disabled = !open;
            button.setAttribute("aria-pressed", String(level.id === this.levelId));
            const number = document.createElement("span"); number.className = "level-number"; number.textContent = level.id;
            const names = document.createElement("span"); names.className = "level-choice-copy";
            const title = document.createElement("strong"); title.textContent = level.title;
            const detail = document.createElement("small"); detail.textContent = open ? `${level.rows}条道路，${level.waves}波来袭` : `完成${LEVELS[LEVELS.indexOf(level) - 1].id}后开放`;
            names.append(title, detail);
            const status = document.createElement("span"); status.className = "level-state"; status.textContent = completed ? "已守住" : open ? "可挑战" : "未开放";
            button.append(number, names, status);
            button.addEventListener("click", () => { this.levelId = level.id; this.renderMap(); });
            list.append(button);
        }
        const level = levelById(this.levelId) || LEVELS[0];
        this.text("level-title", level.title); this.text("level-subtitle", level.subtitle);
        this.text("area", `${level.rows}行 × ${level.cols}列`); this.text("budget", `${level.startResource} クリエ`); this.text("waves", `${level.waves}波`);
        this.text("enemy", `来客：${ENEMY_RULES[level.newEnemy].name}。${ENEMY_RULES[level.newEnemy].description}`);
        this.text("objective", level.objective);
        this.text("rewards", `首次守住后：${level.rewards.map(id => UNIT_RULES[id].name).join("、")}`);
        const best = this.save.progress.best[level.id];
        this.text("best", best ? `最佳记录 ${TIME(best.time)}，消耗${best.gatesUsed}次结界。` : `额外目标：${level.optional}。`);
        this.get("save-problem").hidden = !this.save.problem;
        this.text("save-problem", this.save.problem || "");
    }

    closeDialogs() { for (const dialog of this.host.querySelectorAll("dialog[open]")) { dialog.close(); } }
    closeDialog(role, reason) { this.get(role).close(); this.view?.setPaused(reason, false); }
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

    async startLevel(id) {
        if (!this.save.canOpen(id)) { return; }
        this.releaseBattle();
        this.levelId = id;
        this.save.rememberLevel(id);
        this.mode = "battle";
        const epoch = this.epoch;
        const level = levelById(id);
        const deck = ORDER.filter(unit => this.save.unlocked.includes(unit));
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
                onState: (state, controls) => { if (epoch === this.epoch) { this.updateHud(state, controls); } },
                onNotice: text => { if (epoch === this.epoch) { this.notice(text); } },
                onWarning: warning => { if (epoch === this.epoch) { this.warnings.set(warning.row, warning); } },
                onInspect: () => this.inspect(),
                onError: error => { if (epoch === this.epoch) { this.error(error); } },
                onFinished: event => { if (epoch === this.epoch) { this.finish(event); } }
            });
            if (epoch !== this.epoch || this.disposed) { view.dispose(); return; }
            this.view = view;
            this.keyboardCell = { row: Math.floor(level.rows / 2), col: 0 };
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
            button.append(this.unitArt(id));
            const copy = document.createElement("span"); copy.className = "seed-copy";
            const name = document.createElement("strong"); name.textContent = rule.name;
            const cost = document.createElement("span"); cost.className = "seed-cost"; cost.textContent = `${rule.cost} クリエ`;
            const state = document.createElement("span"); state.className = "seed-readiness"; state.textContent = "准备中";
            const key = document.createElement("kbd"); key.textContent = String(index + 1);
            copy.append(name, cost, state); button.append(copy, key);
            button.addEventListener("click", () => this.view?.select(id));
            bank.append(button); this.cards.set(id, { button, state });
        });
    }

    buildLanes(level) {
        this.laneNodes = [];
        const container = this.get("lanes"); container.replaceChildren();
        for (let row = 0; row < level.rows; row++) {
            const marker = document.createElement("span"); marker.className = "lane-gate";
            marker.textContent = `${row + 1}路 · 结界1`;
            const warning = document.createElement("span"); warning.className = "lane-warning"; warning.hidden = true;
            container.append(marker, warning); this.laneNodes.push({ marker, warning });
        }
    }

    updateHud(state, controls) {
        this.lastState = state;
        this.text("crea", String(state.resource)); this.text("time", TIME(state.time));
        this.text("wave", `第${state.wave} / ${state.totalWaves}波`);
        this.text("battle-phase", state.phase === "setup" ? "准备布阵" : state.phase === "running" ? `场上${state.enemies.length}位来客` : state.phase === "won" ? "防线守住了" : "本次失守");
        this.get("setup").hidden = state.phase !== "setup";
        const paused = state.pauses.includes("manual");
        this.get("pause-overlay").hidden = !paused;
        this.button("pause").setAttribute("aria-pressed", String(paused)); this.button("pause").textContent = paused ? "继续" : "暂停";
        this.button("pause").disabled = state.phase !== "setup" && state.phase !== "running";
        this.button("collect").disabled = !state.pickups.length || !!state.pauses.length;
        this.button("collect").textContent = state.pickups.length ? `收取应援 ${state.pickups.length}` : "收取应援";
        this.button("recall").setAttribute("aria-pressed", String(controls.recall));
        this.button("recall").disabled = !["setup", "running"].includes(state.phase);
        this.button("start").disabled = controls.loading || !!state.pauses.length;
        for (const [id, entry] of this.cards) {
            const remaining = state.cooldowns[id] || 0;
            const shortage = Math.max(0, UNIT_RULES[id].cost - state.resource);
            const status = remaining > .001 ? `冷却 ${Math.ceil(remaining)}秒` : shortage ? `还差${shortage}` : "可部署";
            entry.state.textContent = status;
            entry.button.classList.toggle("unavailable", remaining > .001 || shortage > 0);
            entry.button.setAttribute("aria-pressed", String(!controls.recall && controls.selected === id));
            entry.button.setAttribute("aria-label", `${UNIT_RULES[id].name}，费用${UNIT_RULES[id].cost}，${status}`);
            entry.button.disabled = controls.loading || !["setup", "running"].includes(state.phase);
        }
        const rule = UNIT_RULES[controls.selected];
        this.text("selected-name", controls.recall ? "召回" : rule?.name || "选择卡牌");
        this.text("selected-help", controls.recall ? state.phase === "setup" ? "准备阶段全额退还。" : "开战后不退还费用。" : rule?.help || "选卡后点空格部署。");
        this.get("range-caption").hidden = !controls.preview;
        this.get("range-caption").classList.toggle("invalid", !!controls.preview && !controls.preview.valid);
        this.text("range-caption", controls.preview ? `第${controls.preview.row + 1}路，第${controls.preview.col + 1}格：${controls.preview.text}${controls.preview.valid ? "" : `。${controls.preview.reason}`}` : "");
        this.get("placement-actions").hidden = !controls.touchConfirm;
        this.button("confirm-placement").disabled = controls.loading || !controls.preview?.valid;
        this.button("confirm-placement").textContent = controls.recall ? "确认召回" : "确认部署";
        this.get("viewport").classList.toggle("has-placement-confirm", !!controls.touchConfirm);
        if (this.view) {
            this.laneNodes.forEach(({ marker, warning }, row) => {
                marker.textContent = `${row + 1}路 · ${state.gates[row] ? "结界1" : "结界已用"}`;
                marker.classList.toggle("spent", !state.gates[row]);
                const point = this.view.world(row, -.9).project(this.view.stage.camera);
                marker.style.left = `${(point.x + 1) * this.view.stage.width / 2}px`;
                marker.style.top = `${(1 - point.y) * this.view.stage.height / 2}px`;
                const incoming = this.warnings.get(row);
                warning.hidden = !incoming || incoming.at < state.time;
                if (!warning.hidden) { warning.textContent = `${ENEMY_RULES[incoming.enemyType].name} · ${Math.max(0, Math.ceil(incoming.at - state.time))}秒`; }
                const entry = this.view.world(row, this.view.level.cols + .1).project(this.view.stage.camera);
                warning.style.left = `${Math.min(this.view.stage.width - 8, (entry.x + 1) * this.view.stage.width / 2)}px`;
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

    finish(event) {
        if (!this.view) { return; }
        const battle = this.view.battle;
        const rewards = this.save.finish(this.runId, battle);
        const won = event.result === "won";
        this.text("result-title", won ? "这片日常，守住了" : "先回去，重新画一张图");
        this.text("result-copy", won ? `${battle.level.title}完成。${event.stats.gatesUsed ? "结界替大家争取了时间。" : "每一条道路都守住了。"}`
            : `第${event.row + 1}路被突破。可以试着减少前期支出，或更早补上这一条路的输出。`);
        const stats = this.get("result-stats"); stats.replaceChildren();
        for (const [name, value] of [["巡守时间", TIME(battle.time)], ["击退来客", String(event.stats.kills)], ["使用结界", `${event.stats.gatesUsed}次`], ["有效治疗", String(event.stats.healed)]]) {
            const part = document.createElement("div"); const dt = document.createElement("dt"); dt.textContent = name;
            const dd = document.createElement("dd"); dd.textContent = value; part.append(dt, dd); stats.append(part);
        }
        const rewardList = this.get("result-rewards"); rewardList.replaceChildren();
        for (const id of rewards) {
            const item = document.createElement("div"); item.append(this.unitArt(id));
            const label = document.createElement("p"); label.textContent = `解锁：${UNIT_RULES[id].name}`; item.append(label); rewardList.append(item);
        }
        this.text("result-save", this.save.problem || (won ? "巡守记录已保存。" : "未改变通关记录。"));
        const index = LEVELS.findIndex(level => level.id === this.levelId);
        this.button("next").hidden = !won || index === LEVELS.length - 1;
        if (won && index === LEVELS.length - 1) {
            const text = document.createElement("p"); text.textContent = "前三关已完成。紧急爆破术式可在重玩时使用，后续章节仍在制作。"; rewardList.append(text);
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
        if (/^[1-6]$/.test(key)) { const type = [...this.cards.keys()][Number(key) - 1]; if (type) { this.view.select(type); } }
        else if (key === "c") { this.view.collectAll(); }
        else if (key === "r") { this.view.setRecall(!this.view.recallMode); }
        else if (event.code === "Space") { event.preventDefault(); if (!event.repeat) { this.togglePause(); } }
        else if (key === "escape") { this.view.cancelPlacement(); }
        else if (key.startsWith("arrow")) {
            event.preventDefault();
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
