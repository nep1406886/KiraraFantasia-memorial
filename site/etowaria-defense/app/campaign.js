import { LEVELS, CHAPTERS, ENDLESS, UNIT_RULES, ENEMY_RULES, ENEMY_FIRST_SEEN, DECK_ORDER, GEAR_ORDER, DECK_SIZE, SAVE_KEY, TOWN_RULES, ENDLESS_MILESTONES, ACHIEVEMENTS, levelById } from "../data/campaign.js";
import { CampaignSave } from "./campaign-save.js";
import { evaluateChallenge } from "./challenge-evaluator.js";
import { portraitMarkup, siteUrl } from "./assets.js";
import { ICONS } from "./icons.js";
// 来客小像：懒拍池内模型本体。模块本身零重依赖（three/拍摄管线都在
// 拍摄函数内部按需动态导入），在选关图载入它没有额外成本。
import { captureEnemyIcon, loadEnemyIcons, storeEnemyIcons } from "../render/enemy-icons.js";
// 纸面骨架屏：进关载入卡的占位骨条，与观察模式载入卡共用 load-shell 的样式契约。
import { loadBones } from "./load-shell.js";

// 战斗模块在进入关卡时按需加载；模块系统自己会缓存，这里只收敛
// 三处重复的动态导入与解构。
let battleModule;
const loadBattle = () => battleModule ||= import("../sim/battle.js");

const DEFAULT_DECK = DECK_ORDER.slice(0, DECK_SIZE);
const WAVE_LABEL = level => level.endless ? "不限波次" : `${level.waves}波`;
const tacticalHint = rule => {
    if (rule.healer) { return "优先击倒：会治疗附近来客"; }
    if (rule.armor) { return "用破甲攻击：护甲会先吸收伤害"; }
    if (rule.hop) { return "需要高墙：会越过普通前排"; }
    if (rule.ranged) { return "优先处理：会在远处攻击前排"; }
    if (rule.revive) { return "不要松懈：倒下后还会复起"; }
    if (rule.summon) { return "注意首领：会召唤援军"; }
    if (rule.thorns) { return "避免近战：攻击会受到反伤"; }
    return "普通来客：保持该路有输出";
};
const counterTags = rule => {
    if (rule?.kind === "gear") { return rule.gear?.label || "改变宿主属性"; }
    const tags = [];
    if (rule?.pierceArmor) { tags.push("破甲"); }
    if (rule?.onHit?.slow || rule?.slow) { tags.push("减速"); }
    if (rule?.special?.type === "knockback" || rule?.onHit?.knockback) { tags.push("击退"); }
    if (["healer", "shielder", "beacon"].includes(rule?.kind)) { tags.push("支援"); }
    if (rule?.kind === "producer") { tags.push("经济"); }
    if (rule?.kind === "lobber") { tags.push("越障攻击"); }
    return tags.join("、") || rule?.role || "持续输出";
};
const TIME = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
// 逐帧间隔一张：优先 rAF（随绘制走）；页签被节流不绘制时（后台窗、
// 固定时钟验收）退回定时器，拍摄队列不因此停摆。
const nextFrame = () => new Promise(resolve => {
    const handle = requestAnimationFrame(() => { clearTimeout(fallback); resolve(); });
    const fallback = setTimeout(() => { cancelAnimationFrame(handle); resolve(); }, 250);
});
// 拍摄看门狗：单张小像的加载链路（view.loadEnemy → core/loader.js）实测
// 偶发停在发出 fetch 之前，既不 resolve 也不 reject（根因在共享 loader，
// 未定位）。不设上限时，懒拍泵会永远停在那一拍，busy 守卫把本会话所有
// 重试全部挡掉；看门狗把「卡死」降级成「这一张失败」，泵继续拍后面的。
// 落败的原 promise 之后才 settle（resolve 或 reject）也没有危害：race 的
// 回调仍在它身上挂着，不会冒 unhandledrejection；captureEnemyIcon 自己的
// finally 会把借出的模型归池，渲染段又是纯同步的，不会与下一张交错。
const CAPTURE_TIMEOUT = 20000;
const withTimeout = (promise, ms, label) => {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未完成`)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
};
// OS 级「减少动态效果」：守卫表达式与 battle-view.js:30 完全同款（裸环境
// 没有 matchMedia 时返回 false，presentation 契约的 harness 只垫 window，
// 没有 matchMedia，直接求值会在 import 时 ReferenceError）。这里故意做成
// 函数、在每次判定点现算而不做模块顶快照：结算面弹出的时机远晚于页面
// 载入，OS 设置可能中途开关；battle-view/stage 的 OS_REDUCED 用 matchMedia
// change 监听保持现值，两处口径一致才不会漂移。
const osReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
// 图鉴大图页的来客留影尺寸：网格缩略仍是 enemy-icons.js 的 96px，
// 只有大图页按 288 现拍，避免缩略缓存膨胀。
const CODEX_VIEW_CAPTURE = 288;
// ── 里程碑 ★4 语音 ──────────────────────────────────────────────────
// audio/voice/ 下 33 个 ★4 sheet（*4_A 目录，共 138 条 mp3，均为
// voice_kirarajump 系）在 units.json 的语音表里零引用——表只配了 ★5
// sheet。目录名第二、三、四段（作品_角色_职业）与 units.json voice.sheet
// 同构；sheet 已覆盖的作品按 sheet 推导，未覆盖的用 WORK 别名字面表
// 补齐（罗马字逐条对照 asset/rl/_raw/NamedList.json 的 m_ResouceBaseName
// 核实，未能确认归属的目录不收录——宁可不播，也不播错作品的语音）。
// 每目录的实际条数按 ls 实测写死，里程碑时随机取一条。
const VOICE4_FILE_COUNTS = {
    AChannel_Toru_Fighter: 3, Acchikocchi_Tumiki_Priest: 5, Anhapi_Hanako_Knight: 3,
    Anima_Kohane_Magician: 5, Blends_Maika_Magician: 3, Gakkou_Yuki_Priest: 3,
    GA_Tomokane_Fighter: 4, Gochiusa_Cocoa_Fighter: 4, Hanayamata_Naru_Priest: 7,
    Harukana_Haruka_Knight: 3, Harumination_Harumi_Priest: 3, Hidamari_Yuno_Priest: 3,
    Hitugi_Kuro_Alchemist: 3, Keion_Yui_Fighter: 7, Killme_Yasuna_Knight: 3,
    KinMosa_Alice_Alchemist: 3, KinMosa_Karen_Fighter: 3, Koharu_Koharu_Knight: 11,
    Koiasu_Mira_Alchemist: 6, Komiga_Kaoruko_Priest: 3, Matikado_Yuko_Priest: 7,
    NewGame_Aoba_Magician: 3, Pawasuma_Mayu_Alchemist: 6, Sakura_Haruka_Priest: 3,
    Sansha_Futaba_Fighter: 7, SlowStart_Hana_Priest: 3, Stella_Tamaki_Magician: 3,
    Tamayomi_Yomi_Magician: 6, Urara_Chiya_Knight: 3, Yumekui_Merry_Fighter: 3,
    Yurukyan_Nadesiko_Fighter: 3, Yurukyan_Rin_Magician: 3, YuyuShiki_Yui_Knight: 3
};
// sheet 推导不到的作品别名：作品名 = units.json 的 work 字段字面值。
const VOICE4_EXTRA_WORKS = {
    轻音少女: "Keion_Yui_Fighter",
    "NEW GAME!": "NewGame_Aoba_Magician",
    街角魔族: "Matikado_Yuko_Priest",
    一起一起这里那里: "Acchikocchi_Tumiki_Priest",
    "Anima Yell!": "Anima_Kohane_Magician",
    悠悠式: "YuyuShiki_Yui_Knight",
    "Slow Start": "SlowStart_Hana_Priest",
    晴海国度: "Harumination_Harumi_Priest"
};
// units.json voice.sheet 形如 Voice_Stella_Tamaki_Magician5_A，去掉
// Voice_ 前缀与 5_A 尾缀即与 ★4 目录的工作表名对齐。
const sheetToken = name => name.replace(/^Voice_/, "").replace(/\d_A$/, "");
const markup = `
  <div class="campaign-map" data-view="map">
    <header class="panel campaign-header"><button class="native-button compact" data-action="back">返回标题</button><h2>里口花径</h2><span>巡守手记</span><button class="native-button compact" data-action="save">巡守记录</button><button class="native-button compact" data-action="town">城镇</button></header>
    <div class="campaign-map-body">
      <section class="campaign-chapter panel" data-role="chapter-panel" data-theme="day"><div class="chapter-landscape" aria-hidden="true"></div><div class="chapter-description"><p class="chapter-kicker" data-role="chapter-kicker"></p><h3 data-role="chapter-title"></h3><p data-role="chapter-caption"></p><div class="campaign-faces" data-role="faces"></div><p class="muted">关卡按巡守记录逐步开放；每关重新分配クリエ，不把资源带入下一关。</p></div></section>
      <section class="panel campaign-selection" aria-label="选择巡守关卡"><div class="setup-banner-slot" data-role="setup-banner-slot"></div><div class="campaign-levels" data-role="levels"></div><div class="level-brief"><h3 data-role="level-title"></h3><p data-role="level-subtitle"></p><dl class="level-facts"><div><dt>布阵区域</dt><dd data-role="area"></dd></div><div><dt>初始应援</dt><dd data-role="budget"></dd></div><div><dt>来袭波次</dt><dd data-role="waves"></dd></div></dl><p data-role="enemy"></p><p data-role="objective"></p><p data-role="rewards"></p><p class="muted" data-role="best"></p></div><div class="campaign-map-actions"><p class="muted">关卡会按巡守记录逐步开放；完成当前关卡后解锁下一关，无尽巡守始终可挑战。</p><button class="native-button primary" data-action="prepare">选择阵容</button></div><p class="campaign-disclosure">本作同人改编。当前开放五章三十二关与无尽巡守。</p></section>
      <section class="panel deck-picker" data-role="deck-picker" aria-label="选择本次布阵的卡牌" hidden><header class="deck-picker-head"><div><h3>本次布阵</h3><p class="muted">从巡守图鉴里挑最多${DECK_SIZE}张卡同行；可随时返回换一关。</p></div><p class="deck-count" data-role="deck-count"></p></header>
<div class="deck-chosen" data-role="deck-chosen" aria-label="已选择的卡牌"></div><div class="deck-presets" data-role="deck-presets"><span class="deck-presets-label">推荐配置</span><div class="deck-preset-buttons" data-role="deck-preset-buttons"></div></div><div class="deck-grid" data-role="deck-grid"></div><p class="deck-detail" data-role="deck-detail"></p><div class="campaign-map-actions"><button class="native-button compact" data-action="deck-back">返回选关</button><button class="native-button primary" data-action="deck-start">开始巡守</button></div></section>
    </div><p class="save-problem" data-role="save-problem" role="status" hidden></p>
  </div>
  <div class="campaign-battle" data-view="battle" hidden>
    <header class="battle-head">
      <button class="hud-button" data-action="leave" aria-label="返回关卡">${ICONS.back}<span>返回</span></button>
      <div class="battle-heading"><h2 data-role="battle-title"></h2><p data-role="battle-phase">准备布阵</p></div>
      <div class="wave-meter" aria-hidden="true"><span data-role="wave-fill"></span></div>
      <span class="battle-context" data-role="battle-context"></span>
      <div class="battle-progress"><strong data-role="wave">第1波</strong><span data-role="time">0:00</span></div>
      <span class="next-wave" data-role="next-wave" hidden></span>
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
    <div class="battle-viewport" data-role="viewport" role="group" aria-label="巡守战场"><p class="sr-only" data-role="battle-live" aria-live="polite"></p><div class="battle-objectives" data-role="objectives" aria-label="本关目标"></div>
      <div class="battle-canvas" data-role="canvas"></div><div class="battle-labels" data-role="labels"></div><div class="battle-overlay" data-role="overlay"></div><div class="lane-indicators" data-role="lanes"></div>
      <div class="battle-tip" data-role="tip" hidden><strong data-role="selected-name"></strong><span data-role="selected-help"></span><span class="range-caption" data-role="range-caption" hidden></span></div>
      <p class="battle-message" data-role="message" role="status"></p>
      <div class="milestone-toast" data-role="milestone" role="status" hidden></div>
      <div class="battle-pause-overlay" data-role="pause-overlay" hidden><div class="panel"><h3>巡守已暂停</h3><p>波次、生产、冷却与攻击全部暂停。</p><div class="pause-actions"><button class="native-button primary compact" data-action="resume">继续巡守</button><button class="native-button compact" data-action="settings">声音设置</button><button class="native-button compact" data-action="leave">返回关卡</button></div></div></div>
      <div class="stage-loading" data-role="loading" hidden><div class="panel loading-card"><h3>把这次布阵准备好</h3><p data-role="load-text">读取原生场地…</p><div data-role="load-bones"></div><progress data-role="load-progress" max="1" value="0"></progress></div></div>
      <div class="portrait-notice" data-role="portrait" hidden><div class="panel"><h3>横屏看清整条防线</h3><p>战斗已经暂停。可以旋转屏幕，或返回关卡选择。</p><button class="native-button compact" data-action="leave">返回关卡</button></div></div>
    </div>
  </div>
  <dialog class="panel app-dialog campaign-dialog" data-role="brief-dialog" aria-labelledby="campaign-brief-title"><h2 id="campaign-brief-title">出发之前</h2><div data-role="story"></div><p data-role="opening-tip"></p><ol class="opening-steps" aria-label="新手流程"><li><strong>先部署</strong><span>选择卡牌，再点一格；卡牌说明会告诉你费用、射程和作用。</span></li><li><strong>再收集</strong><span>应援台和自然资源会生成クリエ，看到资源徽章就点击“收取”。</span></li><li><strong>开始巡守</strong><span>确认布阵后点击“开始巡守”；波次、冷却和敌人行动才会推进。</span></li><li><strong>遇险处理</strong><span>可以随时暂停查看详情；来客突破时，对应道路的结界会自动触发，争取重新布阵。</span></li></ol><p class="muted">场上身影为练习投影，可按费用和冷却重复召唤。对白与塔防数值是本作同人改编。</p><div class="dialog-actions"><button class="native-button primary compact" data-action="brief-close">开始布阵</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="result-dialog" aria-labelledby="campaign-result-title"><div class="result-scene" aria-hidden="true"></div><h2 id="campaign-result-title" data-role="result-title"></h2><p data-role="result-copy"></p><dl class="result-stats" data-role="result-stats"></dl><div class="reward-list" data-role="result-rewards"></div><p class="muted" data-role="result-save"></p><div class="dialog-actions"><button class="native-button compact" data-action="result-map">回到关卡</button><button class="native-button compact" data-action="retry">重新挑战</button><button class="native-button primary compact" data-action="next">下一关</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="leave-dialog" aria-labelledby="campaign-leave-title"><h2 id="campaign-leave-title">离开本次巡守？</h2><p>本次布阵不会保留，已经完成的关卡记录不变。</p><div class="dialog-actions"><button class="native-button compact" data-action="leave-cancel">留在战场</button><button class="native-button primary compact" data-action="leave-confirm">返回关卡</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="inspect-dialog" aria-labelledby="campaign-inspect-title"><header><h2 id="campaign-inspect-title">战场详情</h2><button class="native-button compact" data-action="inspect-close">关闭</button></header><p>同伴与来敌的实际生命。危急状态同时显示文字，不只依赖颜色。</p><div class="battle-table-wrap"><table class="battle-table"><caption>当前场上的对象</caption><thead><tr><th scope="col">对象</th><th scope="col">位置</th><th scope="col">生命</th><th scope="col">状态</th></tr></thead><tbody data-role="inspect-body"></tbody></table></div></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="save-dialog" aria-labelledby="campaign-save-title"><header><h2 id="campaign-save-title">巡守记录</h2><button class="native-button compact" data-action="save-close">关闭</button></header><p>只导入或导出本作的通关记录，不读取其他游戏的存档。</p><div class="dialog-actions"><button class="native-button compact" data-action="export">导出记录</button><label class="native-button compact import-label">选择记录文件<input data-role="save-file" type="file" accept="application/json,.json"></label></div><p data-role="import-preview" role="status"></p><button class="native-button primary compact" data-action="import-confirm" hidden>确认替换记录</button></dialog>
  <dialog class="panel app-dialog campaign-dialog" data-role="error-dialog" aria-labelledby="campaign-error-title"><h2 id="campaign-error-title">这次巡守已暂停</h2><p data-role="error-text"></p><p>未完成的部署不会扣费，也不会让看不见的模型继续攻击。</p><div class="dialog-actions"><button class="native-button compact" data-action="error-map">返回关卡</button><button class="native-button primary compact" data-action="error-retry">重新准备</button></div></dialog>
  <dialog class="panel app-dialog campaign-dialog codex-dialog" data-role="codex-dialog" aria-labelledby="codex-title"><header><h2 id="codex-title">巡守图鉴</h2><button class="native-button compact" data-action="codex-close">关闭</button></header><div class="codex-tabs" data-role="codex-tabs"></div><div class="codex-grid" data-role="codex-grid"></div><p class="codex-detail" data-role="codex-detail"></p></dialog>
  <dialog class="panel app-dialog campaign-dialog codex-view-dialog" data-role="codex-view-dialog" aria-labelledby="codex-view-title"><header><h2 id="codex-view-title" data-role="codex-view-title"></h2><button class="native-button compact" data-action="codex-view-close">关闭</button></header><p class="codex-view-caption" data-role="codex-view-caption"></p><div class="codex-view-stage"><img data-role="codex-view-image" alt="" draggable="false" hidden><span class="codex-view-fallback" data-role="codex-view-fallback" aria-hidden="true" hidden></span></div><p class="codex-view-help" data-role="codex-view-help"></p></dialog>
  <dialog class="panel app-dialog campaign-dialog town-dialog" data-role="town-dialog" aria-labelledby="town-title"><header><h2 id="town-title">城镇建设</h2><button class="native-button compact" data-action="town-close">关闭</button></header><p class="muted">无尽巡守每清 5 波掉落素材；素材与建筑取材原作。每级只给小幅加成，不参与强养成。</p><div class="town-materials" data-role="town-materials"></div><div class="town-buildings" data-role="town-buildings"></div></dialog>
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
        this.keyboardCell = { row: 1, col: 0 };
        this.warnings = new Map();
        this.cards = new Map();
        this.disposed = false;
        // 来客小像缓存：localStorage 里拍过的 dataURL，配额不足时只剩内存副本。
        this.enemyIcons = loadEnemyIcons();
        this._enemyIconPump = null;
        // HUD 壳是静态标记：data-role/data-action 元素只查一次，之后走缓存。
        // updateHud 每 0.08s 会取 ~30 个引用，querySelector 全子树扫描白费。
        this._roles = new Map();
        this._actions = new Map();
        // text() 的写入去重缓存：元素 → 上次写入的字符串。
        this._textCache = new WeakMap();
        this._attrCache = new WeakMap();
        this._styleCache = new WeakMap();
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

    get(role) {
        const cache = this._roles;
        if (!cache.has(role)) { cache.set(role, this.host.querySelector(`[data-role="${role}"]`)); }
        return cache.get(role);
    }
    button(action) {
        const cache = this._actions;
        if (!cache.has(action)) { cache.set(action, this.host.querySelector(`[data-action="${action}"]`)); }
        return cache.get(action);
    }
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
    // HUD 每 0.08 秒刷一次，绝大多数文案其实没变（时间在走，但名字、
    // 波次标签、按钮标签都是常量）。textContent 赋值即使内容相同也会
    // 触发样式重算，所以按元素记住上次写入的值，相同就跳过。
    text(role, value) {
        const element = this.get(role);
        if (!element) { return; }
        const next = String(value);
        if (this._textCache.get(element) === next) { return; }
        this._textCache.set(element, next);
        element.textContent = next;
    }
    // 属性/样式写入同样只在值变化时落地：setAttribute 与 style 赋值
    // 即使新旧值相同也会走一遍 DOM 的样式失效流程。
    // 直接元素的文本写入去重（text() 走 data-role 查找，这里是热循环
    // 里已持有的节点引用）。
    styleText(element, value) {
        if (!element) { return; }
        const next = String(value);
        if (this._textCache.get(element) === next) { return; }
        this._textCache.set(element, next);
        element.textContent = next;
    }
    attr(element, name, value) {
        if (!element) { return; }
        const key = `${name}:${value}`;
        let last = this._attrCache.get(element);
        if (!last) { last = new Map(); this._attrCache.set(element, last); }
        if (last.get(name) === value) { return; }
        last.set(name, value);
        element.setAttribute(name, value);
    }
    style(element, property, value) {
        if (!element) { return; }
        let last = this._styleCache.get(element);
        if (!last) { last = new Map(); this._styleCache.set(element, last); }
        if (last.get(property) === value) { return; }
        last.set(property, value);
        element.style[property] = value;
    }
    notice(message) {
        const element = this.get("message");
        element.textContent = message;
        element.classList.add("show");
        clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => element.classList.remove("show"), 3600);
    }
    // 里程碑独立 toast：素材入账等提示仍走 notice()（.battle-message），
    // 两块在 battle-viewport 顶部上下并存、互不覆盖；z-index 同为 4，
    // 都压不过选卡提示（.battle-tip z-5）与暂停遮罩（z-6）。
    milestoneToast(message) {
        this.text("milestone", message);
        const toast = this.get("milestone");
        toast.hidden = false;
        clearTimeout(this.milestoneTimer);
        this.milestoneTimer = setTimeout(() => { toast.hidden = true; }, 3600);
    }
    // ★4 语音池：作品 → sheet 目录 + 实际台词数。sheet 推导的作品映射
    // 第一次用到时建好并缓存（83 个 unit 只扫一遍）。
    milestoneVoiceSheets() {
        if (this._voice4Sheets) { return this._voice4Sheets; }
        const workOfToken = new Map();
        for (const unit of this.catalogue.units) {
            if (unit.voice?.sheet) { workOfToken.set(sheetToken(unit.voice.sheet), unit.work); }
        }
        for (const [work, token] of Object.entries(VOICE4_EXTRA_WORKS)) { workOfToken.set(token, work); }
        const sheets = [];
        for (const [token, count] of Object.entries(VOICE4_FILE_COUNTS)) {
            const work = workOfToken.get(token);
            if (!work) { continue; } // 作品归属未能确认的目录不用，宁缺毋错
            const lines = Array.from({ length: count }, (_, i) => `voice_kirarajump_${String(i).padStart(3, "0")}_0.mp3`);
            sheets.push({ work, dir: `Voice_${token}4_A`, lines });
        }
        return this._voice4Sheets = sheets;
    }
    // 里程碑配音：只在「在场同伴的作品」命中的 sheet 里随机取一条，
    // 配不上就不播——不播无关作品的语音。app/audio.js:139 的 voice
    // 开关关闭时 playVoice 自身静默。
    playMilestoneVoice() {
        if (!this.view) { return; }
        const works = new Set();
        for (const unit of this.view.battle.units.values()) {
            const profile = this.unit(unit.type);
            if (profile?.work) { works.add(profile.work); }
        }
        if (!works.size) { return; }
        const pool = this.milestoneVoiceSheets().filter(sheet => works.has(sheet.work));
        if (!pool.length) { return; }
        const sheet = pool[Math.floor(Math.random() * pool.length)];
        const line = sheet.lines[Math.floor(Math.random() * sheet.lines.length)];
        this.audio.playVoice({ cues: { milestone: `${sheet.dir}/${line}` } }, "milestone");
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
            "confirm-placement": () => this.view?.confirmPlacement(),
            "cancel-placement": () => this.view?.cancelPlacement(),
            inspect: () => this.inspect(), checkpoint: () => this.saveCheckpointNow(), "inspect-close": () => this.closeDialog("inspect-dialog", "inspect"),
            settings: () => this.options.onSettings(),
            "result-map": () => this.showMap(), retry: () => this.startLevel(this.levelId),
            next: () => { const index = LEVELS.findIndex(level => level.id === this.levelId); if (LEVELS[index + 1]) { this.startLevel(LEVELS[index + 1].id); } },
            save: () => this.get("save-dialog").showModal(), "save-close": () => this.get("save-dialog").close(),
            town: () => this.openTown(), "town-close": () => this.get("town-dialog").close(),
            codex: () => this.openCodex(), "codex-close": () => this.closeDialog("codex-dialog", "codex"),
            "codex-view-close": () => this.closeCodexView(),
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
        // 图鉴大图页叠在图鉴之上（嵌套 showModal）：Esc 只收大图层，
        // 图鉴对话框连同原页签留在下面。
        this.get("codex-view-dialog").addEventListener("cancel", event => {
            event.preventDefault(); this.closeCodexView();
        });
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
        const selected = levelById(this.levelId) || LEVELS[0];
        const chapter = CHAPTERS.find(item => item.id === selected.chapter);
        const chapterCopy = {
            day: ["把日常守在身后", "应援台、同伴与每一条道路，都是布阵图的一部分。"],
            camp: ["在星灯下整备", "营地的灯亮起之后，防线也要一条一条照看。"],
            night: ["把夜路守到天亮", "深夜的来客不会等你准备好，先让每一条路有回应。"],
            dawn: ["守到黎明升起", "天亮前的最后一段路，裂开的影子与压阵的头目都会来。"]
        };
        const theme = selected.theme || chapter?.theme || "day";
        const [chapterTitle, chapterCaption] = selected.endless
            ? [ENDLESS.title, ENDLESS.subtitle]
            : (chapterCopy[theme] || chapterCopy.day);
        const chapterPanel = this.get("chapter-panel");
        chapterPanel.dataset.theme = theme;
        this.text("chapter-kicker", selected.endless ? "特别巡守" : chapter?.title || "巡守记录");
        this.text("chapter-title", chapterTitle);
        this.text("chapter-caption", chapterCaption);
        const faceIds = [...(selected.recommended || [])].filter(id => id.startsWith("U"));
        for (const id of ["U01", "U11", "U15", ...faceIds].filter((id, index, ids) => ids.indexOf(id) === index).slice(0, 3)) {
            faces.append(this.unitArt(id));
        }

        const makeButton = level => {
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
            let lastClick = 0;
            button.addEventListener("click", () => {
                const again = Date.now() - lastClick < 400;
                lastClick = Date.now();
                this.levelId = level.id; this.renderMap();
                if (again) { this.startLevel(level.id); return; }
                if (this.save.canOpen(level.id)) { this.showDeckPicker(); }
            });
            return button;
        };

        for (const chapterInfo of CHAPTERS) {
            const levels = LEVELS.filter(level => level.chapter === chapterInfo.id);
            const group = document.createElement("section"); group.className = "campaign-chapter-group";
            group.dataset.chapter = String(chapterInfo.id);
            const head = document.createElement("header"); head.className = "chapter-group-head";
            const title = document.createElement("h3"); title.className = "chapter-group-title"; title.textContent = chapterInfo.title;
            const openCount = levels.filter(level => this.save.canOpen(level.id)).length;
            const meta = document.createElement("span"); meta.className = "chapter-group-meta"; meta.textContent = `${openCount}/${levels.length} 已开放`;
            head.append(title, meta);
            const cards = document.createElement("div"); cards.className = "chapter-levels";
            for (const level of levels) { cards.append(makeButton(level)); }
            group.append(head, cards); list.append(group);
        }

        const endlessGroup = document.createElement("section"); endlessGroup.className = "campaign-chapter-group endless-group";
        const endlessHead = document.createElement("header"); endlessHead.className = "chapter-group-head";
        const endlessTitle = document.createElement("h3"); endlessTitle.className = "chapter-group-title"; endlessTitle.textContent = "无尽巡守";
        const endlessMeta = document.createElement("span"); endlessMeta.className = "chapter-group-meta"; endlessMeta.textContent = "随时可挑战";
        endlessHead.append(endlessTitle, endlessMeta);
        const endlessCards = document.createElement("div"); endlessCards.className = "chapter-levels"; endlessCards.append(makeButton(ENDLESS));
        endlessGroup.append(endlessHead, endlessCards); list.append(endlessGroup);

        this.text("level-title", selected.title); this.text("level-subtitle", selected.subtitle);
        this.text("area", `${selected.rows}行 × ${selected.cols}列`); this.text("budget", `${selected.startResource} クリエ`); this.text("waves", WAVE_LABEL(selected));
        this.text("enemy", `来客：${ENEMY_RULES[selected.newEnemy].name}。${ENEMY_RULES[selected.newEnemy].description}`);
        this.text("objective", selected.objective);
        this.text("rewards", selected.endless ? "记录最佳波次、击退数和坚持时间。" : "完成记录会保存在巡守手记中。");
        const best = selected.endless ? this.save.progress.endless : this.save.progress.best[selected.id];
        this.text("best", selected.endless
            ? best ? `最佳记录：第${best.wave}波，击退${best.kills}，坚持${TIME(best.time)}。` : `额外目标：${selected.optional}。`
            : best ? `最佳记录 ${TIME(best.time)}，消耗${best.gatesUsed}次结界。` : `额外目标：${selected.optional}。`);
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
        const slot = this.get("setup-banner-slot");
        slot.replaceChildren();
        const cache = this.readSetupCache();
        if (!cache) { return; }
        const level = levelById(cache.level);
        if (!level) { this.clearSetupCache(); return; }
        const banner = document.createElement("div"); banner.className = "setup-banner";
        const copy = document.createElement("p");
        copy.append("上次的布阵还没开始：「", cache.level, " ", level.title, "」已部署 ", String(cache.units.length), " 张卡牌，要继续吗？");
        const actions = document.createElement("div"); actions.className = "setup-banner-actions";
        const resume = document.createElement("button"); resume.className = "native-button primary compact";
        resume.textContent = "继续布阵";
        resume.addEventListener("click", () => this.startLevel(cache.level));
        const drop = document.createElement("button"); drop.className = "native-button ghost compact";
        drop.textContent = "丢弃";
        drop.addEventListener("click", () => { this.clearSetupCache(); this.renderMap(); });
        actions.append(resume, drop);
        banner.append(copy, actions);
        slot.append(banner);
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
        this.host.classList.add("deck-open");
        this.renderDeckPicker();
        this.get("deck-picker").scrollIntoView({ block: "start" });
    }
    hideDeckPicker() { const picker = this.get("deck-picker"); picker.hidden = true; this.host.classList.remove("deck-open"); }
    renderDeckPicker() {
        const chosen = this.get("deck-chosen"); chosen.replaceChildren();
        this.deckChoice.forEach((id, index) => {
            const rule = UNIT_RULES[id];
            const chip = document.createElement("button"); chip.type = "button"; chip.className = "deck-chosen-chip";
            chip.setAttribute("aria-pressed", "true");
            chip.setAttribute("aria-label", `移出${rule.name}`);
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
        const level = levelById(this.levelId);
        this.renderPresets(level);
        const focus = this.deckFocus && UNIT_RULES[this.deckFocus];
        // 推荐职业搭配：按 family 归并成「职业×张数」，一眼看清本关推荐构成。
        const recommendation = (() => {
            const recommended = level?.recommended || [];
            if (!recommended.length) { return ""; }
            const tally = new Map();
            for (const id of recommended) {
                const family = UNIT_RULES[id]?.family || "?";
                tally.set(family, (tally.get(family) || 0) + 1);
            }
            return `推荐搭配：${[...tally].map(([family, count]) => `${family}×${count}`).join("、")}（${recommended.length}张）`;
        })();
        this.text("deck-detail", focus ? `${focus.name}【${counterTags(focus)}】：${focus.help}` : recommendation || (DECK_ORDER.length > this.deckChoice.length ? "点一张卡看它的作用，再点一次加入或移出阵容。" : ""));
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
    clearSetupCache() {
        try { this.save.storage?.removeItem(this.setupCacheKey()); } catch { /* ignore */ }
    }
    cacheSetupSnapshot(view) {
        // 只在布阵状态版本号变化时序列化（部署/召回/装备会推进版本号），
        // 过去每次 notify（准备阶段每 0.08s 一次）都全量 serialize+stringify。
        if (!view || view.battle.phase !== "setup") { return; }
        const revision = view.battle.setupRevision || 0;
        if (revision === this._lastSetupRevision) { return; }
        const data = view.battle.serializeSetup();
        if (!data) { return; }
        const serialized = JSON.stringify(data);
        this._lastSetupRevision = revision;
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
        // 选关界面用原作 bgm_questselect——标题页的城镇曲是「日常」，
        // 巡守图是「出发前的整备」，两屏听感要有别。cue 是不带 _0 的
        // 曲名（setTrack 会补 _0.mp3）。
        this.renderMap(); this.audio.setTrack("bgm_questselect");
        this.button("prepare").focus({ preventScroll: true });
    }

    async startLevel(id, options = {}) {
        if (!this.save.canOpen(id)) { return; }
        this.hideDeckPicker();
        const startTheme = levelById(id)?.theme;
        this.audio.preload(startTheme === "night" ? "bgm_battle_2"
            : startTheme === "dawn" ? "bgm_adv_9" : "bgm_battle_1");
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
        // 纸面骨架屏：首次进关铺一次骨条，之后随载入卡显隐（观察模式载入卡同款）。
        if (!this._levelBones) { this._levelBones = loadBones(this.get("load-bones"), { rows: 3 }); }
        this.get("setup").hidden = false;
        this.get("pause-overlay").hidden = true;
        this.text("battle-title", `${id}　${level.title}`);
        // 新一场战斗的布阵缓存基线归零：revision 计数从新 battle 对象重新开始。
        this._lastSetupRevision = -1;
        this._lastSetupCache = null;
        this._objectivesSig = null;
        this.renderObjectives({ stats: { healed: 0, gatesUsed: 0 } });
        this.text("message", "正在准备本关的原模型与特效。");
        this.warnings.clear(); this.buildBank(deck); this.buildLanes(level);
        this.seenEnemyHints = new Set();
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
                onRestock: event => {
                    if (epoch !== this.epoch) { return; }
                    const battle = this.view?.battle;
                    if (!battle || battle.runId !== event.runId) { return; }
                    const drops = event.drops || [];
                    const bonusDrops = event.bonusDrops || [];
                    const milestone = event.milestone || ENDLESS_MILESTONES[event.wave] || null;
                    const settlement = this.save.settleEndlessReward({
                        runId: event.runId,
                        wave: event.wave,
                        drops,
                        bonusDrops,
                        checkpoint: battle.serializeEndless()
                    });
                    if (!settlement.saved) {
                        this.notice(this.save.problem || "奖励和巡守进度未能写入存档。");
                        return;
                    }
                    if (!settlement.applied) { return; }
                    this._lastEndlessSave = battle.spawnIndex * 100000 + Math.floor(battle.time / 30);
                    this.text("checkpoint-label", "已存");
                    if (milestone) {
                        // 里程碑走独立 toast，与紧随其后的素材入账 notice 并存；
                        // 同时按在场同伴的作品随机播一条 ★4 语音（voice 设置
                        // 关闭时 playVoice 自身静默）。
                        this.milestoneToast(`里程碑：${milestone.label}。额外素材×${bonusDrops.length}`);
                        this.playMilestoneVoice();
                    }
                    const earned = [...drops, ...bonusDrops];
                    if (earned.length) {
                        this.notice(`素材入账：${earned.map(id => TOWN_RULES.materials[id]?.name || id).join("、")}。`);
                    }
                },
                onWarning: warning => {
                    if (epoch !== this.epoch) { return; }
                    this.warnings.set(warning.row, warning);
                    const rule = ENEMY_RULES[warning.enemyType];
                    if (rule && !this.seenEnemyHints.has(warning.enemyType)) {
                        this.seenEnemyHints.add(warning.enemyType);
                        this.notice(`${rule.name}：${tacticalHint(rule)}`);
                    }
                },
                onInspect: () => this.inspect(),
                onError: error => { if (epoch === this.epoch) { this.error(error); } },
                onFinished: event => { if (epoch === this.epoch) { this.finish(event); } }
            });
            if (epoch !== this.epoch || this.disposed) { view.dispose(); return; }
            this.view = view;
            this.keyboardCell = { row: Math.floor(level.rows / 2), col: 0 };
            const checkpointResumed = await (async () => {
                if (resuming || !level.endless || !this.save.progress.endlessRun) { return false; }
                return this.resumeEndless(view);
            })();
            const BattleMod = (await loadBattle()).Battle;
            BattleMod.applyTownBuffs(view.battle, this.save.progress.town, !checkpointResumed && !resuming);
            // 图书馆：只有「新开一局」才跳过波次——检查点恢复和布阵缓存
            // 续局都从各自的存档波次起算，不吃跳过。
            if (!resuming && !checkpointResumed && level.endless && BattleMod.skipEndlessWaves(view.battle)) {
                this.notice(`图书馆的记录帮你跳过了前${view.battle.wave - 1}波，从第${view.battle.wave}波开始。`);
            }
            if (resuming) {
                const { Battle } = await loadBattle();
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

    renderObjectives(state) {
        const host = this.get("objectives");
        if (!host) { return; }
        const level = levelById(this.levelId);
        const challenge = evaluateChallenge(level, state.stats, state.phase);
        // 目标行只在进度真正变化时重建：replaceChildren 会丢弃整行 DOM，
        // 过去每 0.08s 全量重画一次。
        const sig = `${this.levelId}|${state.phase}|${challenge
            ? `${challenge.label}|${challenge.type === "gates" ? challenge.value : `${challenge.value}/${challenge.target}`}|${challenge.complete}`
            : ""}`;
        if (this._objectivesSig === sig) { return; }
        this._objectivesSig = sig;
        const rows = level?.objective ? [{ label: level.objective, done: state.phase === "won" }] : [];
        if (challenge) {
            const value = challenge.value;
            rows.push({ label: `${challenge.label}（${challenge.type === "gates" ? value : `${value}/${challenge.target}`}）`, done: challenge.complete });
        }
        host.replaceChildren(...rows.map(row => {
            const item = document.createElement("span"); item.className = row.done ? "objective done" : "objective";
            item.textContent = `${row.done ? "✓" : "○"} ${row.label}`; return item;
        }));
    }

    updateHud(state, controls) {
        this.renderObjectives(state);
        this.text("crea", String(state.resource)); this.text("time", TIME(state.time));
        if (state.endless) {
            const tag = state.waveModifier?.label;
            this.text("wave", tag ? `第${state.wave}波 · ${tag}` : `第${state.wave}波`);
            this.get("wave").dataset.modifier = state.waveModifier?.kind || "";
        } else {
            this.text("wave", `第${state.wave} / ${state.totalWaves}波`);
            this.get("wave").dataset.modifier = "";
        }
        // 无尽模式：预告下一波的形态（BOSS/精英/急袭/群袭），让玩家提前布防。
        const nextWave = this.get("next-wave");
        const next = state.endless && state.phase === "running" ? state.nextWaveModifier : null;
        nextWave.hidden = !next?.label;
        if (next?.label) {
            nextWave.textContent = `下一波 · ${next.label}`;
            nextWave.dataset.modifier = next.kind || "";
        }
        const progress = state.endless ? (state.wave - 1 + Math.min(1, state.waveProgress || 0)) % 1 || 0
            : Math.min(1, (state.totalSpawns - state.scheduledRemaining) / Math.max(1, state.totalSpawns));
        this.style(this.get("wave-fill"), "transform", `scaleX(${progress})`);
        this.text("battle-phase", state.phase === "setup" ? "准备布阵" : state.phase === "running" ? `场上${state.enemies.length}位来客` : state.phase === "won" ? "防线守住了" : "本次失守");
        const live = this.get("battle-live");
        if (live && state.time - (this.lastLiveTime || -10) >= 2) {
            const warning = [...this.warnings.values()].find(item => item.at >= state.time && item.at <= state.time + 3);
            live.textContent = warning ? `${warning.row + 1}路将在${Math.max(1, Math.ceil(warning.at - state.time))}秒后出现${ENEMY_RULES[warning.enemyType].name}。` : `第${state.wave}波，${state.enemies.length}位来客在场，应援${state.resource}。`;
            this.lastLiveTime = state.time;
        }
        this.get("setup").hidden = state.phase !== "setup";
        const paused = state.pauses.includes("manual");
        this.get("pause-overlay").hidden = !paused;
        this.attr(this.button("pause"), "aria-pressed", String(paused));
        this.attr(this.button("pause"), "aria-label", paused ? "继续" : "暂停");
        this.text("pause-label", paused ? "继续" : "暂停");
        this.button("pause").disabled = state.phase !== "setup" && state.phase !== "running";
        this.button("collect").disabled = !state.pickups.length || !!state.pauses.length;
        this.text("collect-label", state.pickups.length ? `收取 ${state.pickups.length}` : "收取");
        this.button("collect").title = state.pickups.length ? `收取${state.pickups.length}份应援；资源会在8秒后自动收取` : "应援资源会在8秒后自动收取";
        const restockButton = this.button("restock");
        restockButton.hidden = !(state.endless && state.restocks > 0);
        this.text("restock-label", `换卡×${state.restocks || 0}`);
        this.button("checkpoint").hidden = !state.endless || !["setup", "running"].includes(state.phase);
        if (state.endless && state.phase === "running") { this.maybeAutosaveEndless(state); }
        this.attr(this.button("recall"), "aria-pressed", String(controls.recall));
        this.button("recall").disabled = !["setup", "running"].includes(state.phase);
        this.button("start").disabled = controls.loading || !!state.pauses.length;
        const busy = controls.loading || !["setup", "running"].includes(state.phase);
        for (const [id, entry] of this.cards) {
            const rule = UNIT_RULES[id];
            const remaining = state.cooldowns[id] || 0;
            const shortage = Math.max(0, rule.cost - state.resource);
            const status = remaining > .001 ? `${Math.ceil(remaining)}秒` : shortage ? `差${shortage}` : "可部署";
            this.styleText(entry.state, status);
            this.style(entry.shade, "transform", `scaleY(${remaining > .001 ? Math.min(1, remaining / rule.deployCooldown) : 0})`);
            entry.button.classList.toggle("cooling", remaining > .001);
            entry.button.classList.toggle("poor", !remaining && shortage > 0);
            entry.button.classList.toggle("unavailable", remaining > .001 || shortage > 0);
            this.attr(entry.button, "aria-pressed", String(!controls.recall && controls.selected === id));
            this.attr(entry.button, "aria-label", `${rule.name}，费用${rule.cost}，${remaining > .001 ? `冷却${status}` : shortage ? `还差${shortage}` : status}`);
            entry.button.disabled = busy;
        }
        const worn = new Map();
        for (const unit of state.units) { if (unit.gear) { worn.set(unit.gear, UNIT_RULES[unit.type].name); } }
        for (const [id, entry] of this.gearCards || []) {
            const rule = UNIT_RULES[id];
            const holder = worn.get(id);
            const remaining = state.cooldowns[id] || 0;
            const shortage = Math.max(0, rule.cost - state.resource);
            entry.holder.hidden = !holder;
            this.styleText(entry.holder, holder || "");
            this.styleText(entry.state, remaining > .001 ? `${Math.ceil(remaining)}s` : "");
            this.style(entry.shade, "transform", `scaleX(${remaining > .001 ? Math.min(1, remaining / rule.deployCooldown) : 0})`);
            entry.button.classList.toggle("worn", !!holder);
            entry.button.classList.toggle("cooling", remaining > .001);
            entry.button.classList.toggle("poor", !holder && !remaining && shortage > 0);
            this.attr(entry.button, "aria-pressed", String(!controls.recall && controls.selected === id));
            this.attr(entry.button, "aria-label", holder ? `${rule.name}，${holder}已佩戴`
                : remaining > .001 ? `${rule.name}，冷却还剩${Math.ceil(remaining)}秒`
                : `${rule.name}，费用${rule.cost}，${shortage ? `还差${shortage}` : "可佩戴"}`);
            entry.button.disabled = busy;
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
                marker.setAttribute("role", "img");
                marker.setAttribute("aria-label", `${row + 1}路 ${state.gates[row] ? "紧急结界自动可用" : "紧急结界已用"}`);
                marker.title = marker.getAttribute("aria-label");
                const point = this.view.world(row, -.9).project(this.view.stage.camera);
                marker.style.left = `${(point.x + 1) * this.view.stage.width / 2}px`;
                marker.style.top = `${(1 - point.y) * this.view.stage.height / 2}px`;
                const incoming = this.warnings.get(row);
                warning.hidden = !incoming || incoming.at < state.time;
                if (!warning.hidden) {
                    const rule = ENEMY_RULES[incoming.enemyType];
                    const ability = rule.healer ? "治疗" : rule.armor ? "护甲" : rule.hop ? "越障" : rule.ranged ? "远程" : rule.revive ? "复起" : rule.summon ? "召唤" : rule.thorns ? "反伤" : "";
                    warning.textContent = `${rule.name}${ability ? `·${ability}` : ""} ${Math.max(0, Math.ceil(incoming.at - state.time))}秒`;
                }
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
        const gateHint = this.get("brief-dialog").querySelector("[data-role=opening-tip]");
        if (gateHint && level.id === "1-1") { gateHint.textContent = `${level.openingTip} 结界会在来客突破时自动触发，不需要手动点击。`; }
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
        const { Battle } = await loadBattle();
        if (Battle.applyEndless(view.battle, checkpoint)) {
            this.buildBank([...view.battle.deck]);
            for (const unit of view.battle.units.values()) { await view.applyDeploymentVisual(unit); }
            this._lastEndlessSave = view.battle.spawnIndex * 100000 + Math.floor(0 / 30);
            this.notice(`已恢复无尽进度：第${checkpoint.wave}波，${checkpoint.units.length} 张卡牌在场。`);
            return true;
        }
        // 检查点校验失败（关卡/卡组对不上）时清掉它，避免每次进无尽都走
        // 一遍注定失败的恢复分支。
        this.save.clearEndlessRun();
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
        // 纯数字格做 800ms count-up（击退/治疗/结界/波次数）；「巡守时间
        // 1:23」这类带格式的值直接渲染终值。review=1（manualClock）、应用
        // 内减动效与 OS 减动效（现算，见 osReducedMotion）同样直出终值——
        // 同 syncBoard 先例：定格时钟下没有过程动画。
        const rows = endless
            ? [["坚持波次", `第${event.wave}波`, true], ["击退来客", String(event.stats.kills), true], ["巡守时间", TIME(battle.time), false], ["使用结界", `${event.stats.gatesUsed}次`, true]]
            : [["巡守时间", TIME(battle.time), false], ["击退来客", String(event.stats.kills), true], ["使用结界", `${event.stats.gatesUsed}次`, true], ["有效治疗", String(event.stats.healed), true]];
        const still = this.options.manualClock || this.options.audio.settings.reducedMotion || osReducedMotion();
        for (const [name, value, rolls] of rows) {
            const part = document.createElement("div"); const dt = document.createElement("dt"); dt.textContent = name;
            const dd = document.createElement("dd"); dd.textContent = value; part.append(dt, dd); stats.append(part);
            if (rolls && !still) { this.countUp(dd, value); }
        }
        // 揭示编排：结算块按模板里的 DOM 顺序错峰入场——result-stats 在
        // reward-list 之前，reward-list 内依次是横幅（金印）、摘要、成就，
        // 与「统计→横幅→摘要→成就」一致。这里只写序号 --i，单发 400ms
        // 动画和 110ms×--i 的延迟都由 CSS 算（.result-reveal）；挑战条、
        // 素材收获、通关结语跟在成就后面，并入成就档一起落。减动效下不
        // 挂动画类（toggle 保证上次非 still 留下的类被摘掉），直出终态；
        // shell.css 对 OS 与应用内减动效各有全局 animation:none 兜底。
        const reveal = (element, index) => {
            element.classList.toggle("result-reveal", !still);
            element.style.setProperty("--i", String(index));
        };
        reveal(stats, 0);
        const rewardList = this.get("result-rewards"); rewardList.replaceChildren();
        // 结算页的第一印象：金印/徽标 + 一行战报。金印并入横幅构图（替换
        // 原来的 ✓ 圆徽），不再另起一层金色装饰，避免与金边横幅双金叠加；
        // 失守与普通战报保留 × 徽。无尽新纪录也值得盖金印。
        const sealed = won || (endless && result.newRecord);
        // 盖印的结算叠书房底纹（原作闲置横幅 scene_study.webp，此前全站
        // 零引用）；失守保留 store 底纹，让胜负在底图上也能读出来。
        this.get("result-dialog").classList.toggle("result-dialog--sealed", sealed);
        const banner = document.createElement("div");
        banner.className = sealed ? "result-banner result-banner--won" : "result-banner result-banner--lost";
        const badge = document.createElement("span");
        badge.className = sealed ? "result-seal" : "result-badge";
        badge.textContent = won ? "达成" : sealed ? "新纪录" : "×";
        badge.setAttribute("aria-hidden", "true");
        const bannerCopy = document.createElement("span");
        bannerCopy.className = "result-banner-copy";
        bannerCopy.textContent = endless ? (result.newRecord ? "新的无尽记录" : "本次无尽战报")
            : won ? "巡守完成" : "本次失守";
        banner.append(badge, bannerCopy);
        reveal(banner, 1);
        rewardList.append(banner);
        const text = document.createElement("p");
        text.className = "result-summary";
        text.textContent = endless ? (result.newRecord ? "新的无尽记录已写入手记。" : "本次没有超过已有的无尽记录。")
            : won ? "本次巡守结果已写入手记。" : "未改变通关记录。";
        reveal(text, 2);
        rewardList.append(text);
        // 成就：一张一条卡片（金星 + 名称 + 说明），而不是一整段长句。
        if ((result.achievements || []).length) {
            const group = document.createElement("div");
            group.className = "result-achievements";
            reveal(group, 3);
            // 逐条浮现的节奏由 CSS 按 --i 算延迟（shell.css 的全局减动效
            // 会整体关掉 animation），JS 只写序号，不内联动画。
            let achievementIndex = 0;
            for (const achievement of result.achievements || []) {
                const item = document.createElement("div");
                item.className = "result-achievement";
                item.style.setProperty("--i", String(achievementIndex++));
                const star = document.createElement("span");
                star.className = "result-achievement-star";
                star.textContent = "★";
                star.setAttribute("aria-hidden", "true");
                const body = document.createElement("span");
                const name = document.createElement("strong");
                name.textContent = ACHIEVEMENTS[achievement].name;
                const desc = document.createElement("small");
                desc.textContent = ACHIEVEMENTS[achievement].description;
                body.append(name, desc);
                item.append(star, body);
                group.append(item);
            }
            rewardList.append(group);
        }
        if (!endless) {
            const challenge = evaluateChallenge(battle.level, event.stats, event.result);
            if (challenge) {
                // 挑战做成一条状态条：完成是金勾，未完成是淡墨圈。
                // 不用刺眼的红字——失守本身标题里已经说清楚了。
                const row = document.createElement("div");
                row.className = challenge.complete ? "result-challenge is-complete" : "result-challenge";
                const mark = document.createElement("span");
                mark.className = "result-challenge-mark";
                mark.textContent = challenge.complete ? "✓" : "○";
                mark.setAttribute("aria-hidden", "true");
                const label = document.createElement("span");
                label.textContent = `${challenge.complete ? "挑战完成" : "挑战未完成"}：${challenge.label}`;
                row.append(mark, label);
                reveal(row, 3);
                rewardList.append(row);
            }
        }
        // 无尽结算面补一行本局素材收获，让城镇掉落在结束时也看得见。
        if (endless && (battle.materials?.length || 0) > 0) {
            const counts = {};
            for (const id of battle.materials) { counts[id] = (counts[id] || 0) + 1; }
            const harvest = document.createElement("p");
            harvest.textContent = "本局素材收获：" + Object.entries(counts)
                .map(([id, n]) => `${TOWN_RULES.materials[id]?.name || id}×${n}`).join("　");
            reveal(harvest, 3);
            rewardList.append(harvest);
        }
        this.text("result-save", this.save.problem || (endless ? (result.newRecord ? "最佳波次已保存。" : "最佳波次保持不变。") : won ? "巡守记录已保存。" : "未改变通关记录。"));
        const index = LEVELS.findIndex(level => level.id === this.levelId);
        this.button("next").hidden = endless || !won || index === LEVELS.length - 1;
        if (won && index === LEVELS.length - 1) {
            const ending = document.createElement("p"); ending.textContent = "五章三十二关已全部守住。无尽巡守与城镇建设随时可以继续，后续章节仍在制作。";
            reveal(ending, 3);
            rewardList.append(ending);
        }
        this.audio.setTrack(won ? "bgm_battle_win" : "bgm_town_1");
        this.get("result-dialog").showModal();
        if (sealed && !still) { this.resultSparks(); }
    }

    // 结算金粒：盖印后的迸发。实色 --gold-deep 小圆点＋柔投影、正常混合
    // ——亮纸（--paper-raised 近白）上 screen 提亮混合不可见，spec §1 也
    // 反 neon；8~12 粒、单粒约 700ms。摘除主走 animationend，JS setTimeout
    // 兜底清容器，不留 DOM 残留；减动效（finish 的 still 口径）直接不生成。
    resultSparks() {
        const layer = document.createElement("div");
        layer.className = "result-fx";
        layer.setAttribute("aria-hidden", "true");
        const count = 8 + Math.floor(Math.random() * 5);
        let pending = count;
        for (let i = 0; i < count; i++) {
            const spark = document.createElement("i");
            spark.className = "result-spark";
            const size = 5 + Math.random() * 4;
            spark.style.left = `${8 + Math.random() * 84}%`;
            spark.style.width = spark.style.height = `${size.toFixed(1)}px`;
            spark.style.setProperty("--dx", `${(Math.random() * 120 - 60).toFixed(0)}px`);
            spark.style.setProperty("--dy", `${-(90 + Math.random() * 90).toFixed(0)}px`);
            spark.style.setProperty("--d", `${(Math.random() * 220).toFixed(0)}ms`);
            spark.addEventListener("animationend", () => { spark.remove(); if (--pending === 0) { layer.remove(); } });
            layer.append(spark);
        }
        // 兜底：动画被外部打断（如全局减动效把 animation 关掉）时
        // animationend 不来，定时器保证容器必然摘除。
        setTimeout(() => layer.remove(), 1400);
        this.get("result-dialog").append(layer);
    }

    // 结算数字滚动：保留前后缀（「第…波」「…次」）只滚数字，800ms
    // ease-out 收尾；progress=1 时必然落在终值，不会停在半路。
    // 0 与非数字不滚——滚一个「0」只会让结算看起来卡了一下。
    countUp(element, finalText) {
        const match = /^([^\d]*)(\d+)(.*)$/.exec(finalText);
        if (!match) { return; }
        const [, head, digits, tail] = match;
        const target = Number(digits);
        if (!Number.isFinite(target) || target === 0) { return; }
        const started = performance.now();
        const tick = now => {
            const progress = Math.min(1, (now - started) / 800);
            const eased = 1 - Math.pow(1 - progress, 3);
            element.textContent = `${head}${Math.round(target * eased)}${tail}`;
            if (progress < 1) { requestAnimationFrame(tick); }
        };
        requestAnimationFrame(tick);
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
            { key: "enemy", label: "来客", rows: Object.keys(ENEMY_RULES) },
            { key: "achievement", label: "成就", rows: Object.keys(ACHIEVEMENTS) }
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
        if (section === "achievement") {
            const unlocked = this.save.progress.achievements;
            this.text("codex-detail", `已解锁 ${unlocked.length} / ${rows.length} 项成就。`);
            for (const id of rows) {
                const unlockedNow = unlocked.includes(id);
                const label = document.createElement("span"); label.className = "codex-enemy-art";
                label.textContent = unlockedNow ? "★" : "?";
                const card = this.codexCard({ id, art: label,
                    name: unlockedNow ? ACHIEVEMENTS[id].name : "未解锁",
                    detail: () => unlockedNow
                        ? `${ACHIEVEMENTS[id].name}：${ACHIEVEMENTS[id].description}`
                        : `？？？：${ACHIEVEMENTS[id].description}` });
                if (unlockedNow) { card.classList.add("achievement-card", "unlocked"); }
                else { card.classList.add("achievement-card"); }
                grid.append(card);
            }
            this.get("codex-dialog").showModal();
            this.view?.setPaused("codex", true);
            return;
        }
        this.text("codex-detail", "");
        for (const id of rows) {
            const rule = section === "enemy" ? ENEMY_RULES[id] : UNIT_RULES[id];
            let art;
            if (section === "enemy") {
                art = document.createElement("span"); art.className = "codex-enemy-art";
                const cached = this.enemyIcons[id];
                if (cached) {
                    // 拍过的小像直接贴上；字母牌只在还没拍时兜底。
                    art.append(this.enemyThumbNode(cached));
                } else {
                    art.textContent = (rule.name || "?").slice(0, 1);
                }
                // 来客没有立绘资源，原来每张卡只有「名字首字」，读不出威胁类型。
                // 在卡背补一排特性徽章（护甲/治疗/召唤/越障/远程/复起/反伤/首领），
                // 让图鉴真正能当战术参考。
                const traits = this.enemyTraits(rule);
                if (traits.length) {
                    const strip = document.createElement("span");
                    strip.className = "codex-traits";
                    for (const trait of traits) {
                        const chip = document.createElement("i");
                        chip.className = `codex-trait trait-${trait.key}`;
                        chip.textContent = trait.label;
                        strip.append(chip);
                    }
                    art.append(strip);
                }
            } else { art = this.unitArt(id); }
            grid.append(this.codexCard({ id, art, name: rule.name,
                detail: () => section === "enemy" ? this.enemyDetail(rule)
                    : `${rule.name}（${rule.role}）：${rule.help}`,
                view: section === "enemy" ? () => this.openEnemyCodexView(id, rule)
                    : this.companionView(id, rule) }));
        }
        this.get("codex-dialog").showModal();
        this.view?.setPaused("codex", true);
        this.pumpEnemyIcons();
    }

    // 来客小像：把 dataURL 变成占位格里的等比缩略图。图永远装在 44px 的
    // .codex-enemy-art 里，卡格尺寸由 codex-card 的固定最小高度保证，不会
    // 因为换图而抖动。
    enemyThumbNode(url) {
        const image = document.createElement("img");
        image.className = "codex-enemy-thumb";
        image.src = url;
        image.alt = "";
        image.draggable = false;
        return image;
    }

    // 懒拍驱动：只拍缺失 id，逐帧间隔一张，拍完即存即换。所有状态判断
    // 都在每次拍摄前重读——页签切走、对话框关闭、view 被释放都会停下，
    // 下次打开来客页签再续拍。
    //
    // 载入窗口期不自愈的问题：战斗 HUD 在 BattleView.create 完成之前就可
    // 以点，此时打开来客页签会把泵卡在「view 未就绪」上，而泵只由
    // openCodex 触发——原实现在这里静默 return，加载完成后永远不自愈。
    // 现在改成挂起等待：对话框停在来客页签就逐帧等 view 就绪后自动续拍。
    pumpEnemyIcons() {
        if (this._enemyIconPump) { return; }
        const pending = Object.keys(ENEMY_RULES).filter(id => !this.enemyIcons[id]);
        if (!pending.length) { return; }
        if (this.codexSection !== "enemy" || !this.get("codex-dialog").open) { return; }
        if (!this.view?.stage) {
            console.info(`来客小像：战斗画面尚未就绪，就绪后自动拍摄 ${pending.length} 张。`);
        }
        this._enemyIconPump = (async () => {
            const queue = [...pending];
            let stale = 0; // 连续失败计数：拍到一张就清零；连满熔断，防死循环刷警告
            while (queue.length) {
                // view 未就绪（载入窗口期）或被释放时挂起，不放弃本批：
                // 等新 view 接上继续拍；切页签、关对话框、销毁才真正退出。
                while (!this.disposed && this.codexSection === "enemy"
                    && this.get("codex-dialog").open && !this.view?.stage) {
                    await nextFrame();
                }
                if (this.disposed || !this.view?.stage || this.codexSection !== "enemy"
                    || !this.get("codex-dialog").open) { break; }
                const id = queue[0];
                try {
                    const url = await withTimeout(captureEnemyIcon(this.view, id),
                        CAPTURE_TIMEOUT, `拍摄 ${id} 小像`);
                    stale = 0;
                    queue.shift();
                    if (url && !this.enemyIcons[id]) {
                        this.enemyIcons[id] = url;
                        storeEnemyIcons(this.enemyIcons);
                        const art = this.host.querySelector(`.codex-card[data-codex="${id}"] .codex-enemy-art`);
                        if (art) {
                            const strip = art.querySelector(".codex-traits");
                            art.replaceChildren(this.enemyThumbNode(url));
                            if (strip) { art.append(strip); } // 特性徽章继续压在卡背
                        }
                    }
                } catch (error) {
                    stale += 1;
                    console.warn(`来客小像拍摄失败（${id}）：`, error?.message || error);
                    if (stale >= 3) {
                        console.warn(`来客小像连续 ${stale} 次拍摄失败，本轮停止；重新打开来客页签会再试。`);
                        break;
                    }
                    // 单张卡死不拖垮整批：把它排到队尾，先拍后面的；
                    // 队列转回来时若加载链路已恢复，这张还能补上。
                    queue.push(queue.shift());
                }
                // 逐帧间隔一张：拍摄占用渲染器，一口气拍完会卡住一整帧。
                await nextFrame();
            }
        })().finally(() => { this._enemyIconPump = null; });
    }

    // 图鉴/换卡里重复出现的「卡面 = 图标块 + 名字」结构。art 由调用方
    // 决定（角色立绘、装备图标或一个字母牌），这里只管外壳和点击。
    // view 可选：同伴/来客页签传「打开大图页」的回调，装备/成就/设施
    // 维持纯文案的详情行。
    codexCard({ id, art, name, detail, view }) {
        const card = document.createElement("button");
        card.className = "codex-card";
        if (id) { card.dataset.codex = id; }
        const artSlot = document.createElement("span"); artSlot.className = "seed-art";
        artSlot.append(art);
        const nameSlot = document.createElement("span"); nameSlot.className = "seed-name"; nameSlot.textContent = name;
        card.append(artSlot, nameSlot);
        card.addEventListener("click", () => { if (view) { view(); } else { this.showCodexDetail(detail()); } });
        return card;
    }

    // 详情区统一入口：字符串走 text() 去重；来客详情是三段小结构，直接
    // 换子节点。DOM 写入后必须清掉 text() 的去重缓存，否则下次点到同一
    // 张卡的相同文案会被误判为「已写入」而不再刷新。
    showCodexDetail(content) {
        const host = this.get("codex-detail");
        if (!host) { return; }
        if (typeof content === "string") { this.text("codex-detail", content); return; }
        this._textCache.delete(host);
        host.replaceChildren(content);
    }

    // 来客的特性清单：图鉴徽章与详情文案共用同一份定义，避免两处漂移。
    enemyTraits(rule) {
        if (!rule) { return []; }
        const traits = [];
        if (rule.boss) { traits.push({ key: "boss", label: "首领" }); }
        if (rule.healer) { traits.push({ key: "healer", label: "治疗" }); }
        if (rule.summon) { traits.push({ key: "summon", label: "召唤" }); }
        if (rule.armor) { traits.push({ key: "armor", label: "护甲" }); }
        if (rule.hop) { traits.push({ key: "hop", label: "越障" }); }
        if (rule.ranged) { traits.push({ key: "ranged", label: "远程" }); }
        if (rule.revive) { traits.push({ key: "revive", label: "复起" }); }
        if (rule.thorns) { traits.push({ key: "thorns", label: "反伤" }); }
        if (rule.battleCry) { traits.push({ key: "cry", label: "加速" }); }
        if (rule.roar) { traits.push({ key: "roar", label: "压制" }); }
        return traits;
    }
    // 来客详情三段：数值／初见章节／反制＋免疫。原先是一整行
    // textContent，数值、初见与战术提示挤在一起读不清；拆成三行后，
    // 数字、出处与对策各自成段。初见取自 ENEMY_FIRST_SEEN（由关卡
    // spawn + newEnemy 扫描派生），特性徽章沿用 enemyTraits，不另抄数据。
    enemyDetail(rule) {
        const box = document.createElement("span");
        box.className = "codex-detail-rows";
        const stat = document.createElement("span");
        stat.className = "codex-detail-stats";
        stat.textContent = `${rule.name}：${this.enemyStatLine(rule)}。${rule.description || ""}`;
        const seen = document.createElement("span");
        seen.className = "codex-detail-seen";
        const seenAt = ENEMY_FIRST_SEEN[rule.id];
        seen.textContent = seenAt ? `初见 ${seenAt}` : "初见 无尽巡守（巡守关卡不出现）";
        const counters = document.createElement("span");
        counters.className = "codex-detail-counters";
        const label = document.createElement("b");
        label.textContent = "反制";
        counters.append(label);
        for (const cardId of rule.counters || []) {
            const cardRule = UNIT_RULES[cardId];
            if (!cardRule) { continue; }
            const chip = document.createElement("i");
            chip.className = "codex-counter-chip";
            chip.textContent = cardRule.name;
            counters.append(chip);
        }
        // 免疫/反伤等特性提示：与卡背徽章同一套 codex-traits 体系。
        const traits = this.enemyTraits(rule);
        if (traits.length) {
            const strip = document.createElement("span");
            strip.className = "codex-traits codex-traits--inline";
            for (const trait of traits) {
                const chip = document.createElement("i");
                chip.className = `codex-trait trait-${trait.key}`;
                chip.textContent = trait.label;
                strip.append(chip);
            }
            counters.append(strip);
        }
        box.append(stat, seen, counters);
        return box;
    }

    // 数值行：战斗表的关键数字。护甲自修（原作「ロックアーマー」）显示
    // 为「3秒自修」；战术解释交给描述与特性徽章，这里只报数。
    enemyStatLine(rule) {
        const bits = [`生命${Math.round(rule.hp)}`, `攻击${rule.damage}/${rule.period}秒`];
        if (rule.armor) {
            bits.push(`护甲${Math.round(rule.armor)}${rule.rockArmor ? `·${rule.rockArmor.delay}秒自修` : ""}`);
        }
        if (rule.ranged) { bits.push(`射程${rule.ranged.range}格`); }
        if (rule.healer) { bits.push(`每${rule.healer.period}秒治疗${rule.healer.amount}`); }
        if (rule.thorns) { bits.push(`反伤${rule.thorns}`); }
        if (rule.revive) { bits.push(`复起${Math.round(rule.revive.ratio * 100)}%生命`); }
        if (rule.speed) { bits.push(`速度${rule.speed}`); }
        return bits.join(" · ");
    }

    // ─── 图鉴卡面大图页 ────────────────────────────────────────────────
    // 同伴/来客两页签的卡点击后弹原尺寸大图；图鉴对话框以嵌套 showModal
    // 留在下面，关闭/Esc 回到原页签，closeDialogs() 也会一并收掉。
    // 同伴读 unit.card（assets/data 已带完整相对路径，如
    // asset/img/rl/card/16002001.webp；83 个 cardId 实测仅 32 张卡面文件
    // 落地，缺文件的 onerror 回退 128px 头像等比放大，不出白窗/破图）。
    // 设施卡（F13 这类没有 unit 档案的）不挂大图，维持纯文案详情。
    companionView(id, rule) {
        const profile = this.unit(id);
        if (!profile) { return null; }
        return () => this.openCodexView({
            title: rule.name,
            caption: profile.work ? `${profile.work} · ${rule.role}` : rule.role,
            help: `${rule.name}（${rule.role}）：${rule.help}`,
            src: profile.card ? siteUrl(profile.card) : siteUrl(profile.icon),
            fallbackSrc: siteUrl(profile.icon),
            alt: `${rule.name} 的原作卡面`
        });
    }
    // 来客大图：先贴 96px 网格缓存（若有），再对当前 id 现拍 288px 高清
    // 留影换上。拍摄期间连点别的卡、关大图页都会作废在途结果；战斗画面
    // 尚未就绪就只看网格缓存，等网格泵补拍后自然有图。
    async openEnemyCodexView(id, rule) {
        const stamp = this._codexViewStamp = (this._codexViewStamp || 0) + 1;
        const seenAt = ENEMY_FIRST_SEEN[rule.id];
        this.openCodexView({
            title: rule.name,
            caption: seenAt ? `初见 ${seenAt}` : "无尽巡守限定来客",
            help: `${rule.name}：${this.enemyStatLine(rule)}。${rule.description || ""}`,
            src: this.enemyIcons[id] || "",
            alt: `${rule.name} 的现场留影`
        });
        if (!this.view?.stage) { return; }
        try {
            const url = await withTimeout(captureEnemyIcon(this.view, id, CODEX_VIEW_CAPTURE),
                CAPTURE_TIMEOUT, `拍摄 ${id} 大图`);
            const image = this.get("codex-view-image");
            if (url && stamp === this._codexViewStamp && this.get("codex-view-dialog").open) {
                image.onerror = null;
                image.src = url;
            }
        } catch (error) {
            console.warn(`来客大图拍摄失败（${id}）：`, error?.message || error);
        }
    }
    openCodexView({ title, caption, help, src, fallbackSrc, alt }) {
        const dialog = this.get("codex-view-dialog");
        this.text("codex-view-title", title);
        this.text("codex-view-caption", caption || "");
        this.text("codex-view-help", help || "");
        const image = this.get("codex-view-image");
        const fallbackTile = this.get("codex-view-fallback");
        image.alt = alt || "";
        if (src) {
            image.hidden = false;
            fallbackTile.hidden = true;
            image.onerror = fallbackSrc && src !== fallbackSrc ? () => {
                image.onerror = null;
                image.src = fallbackSrc;
            } : null;
            image.src = src;
        } else {
            // 没有任何可用图源（缓存未拍、画面未就绪）：字母牌占位。
            image.hidden = true;
            image.onerror = null;
            image.removeAttribute("src");
            fallbackTile.textContent = (title || "?").slice(0, 1);
            fallbackTile.hidden = false;
        }
        if (!dialog.open) { dialog.showModal(); }
    }
    closeCodexView() {
        this._codexViewStamp = (this._codexViewStamp || 0) + 1; // 作废在途拍摄
        const dialog = this.get("codex-view-dialog");
        if (dialog.open) { dialog.close(); }
    }

    openRestock() {
        const view = this.view;
        if (!view || view.battle.restocks < 1) { return; }
        view.setPaused("restock", true);
        this.restockPick = null;
        this.restockDrop = null;
        const deck = [...view.battle.deck];
        const grid = this.get("restock-grid"); grid.replaceChildren();
        this.text("restock-detail", "");
        this.button("restock-confirm").disabled = true;
        const full = deck.length >= DECK_SIZE;
        // 满编时必须先选一张要换出的卡（已部署的不受影响，只动卡组槽位）。
        // 旧提示行先清掉——每次打开都会重建。
        this.host.querySelectorAll(".restock-drop-row").forEach(node => node.remove());
        // 换卡界面分三段：当前卡组（满编时选一张换出）→ 可换入的卡 → 确认。
        // 原来这三块只是平铺在一起，没有标题也没有容器，看不出哪边是「要换掉的」、
        // 哪边是「能换进来的」。
        const dropRow = document.createElement("section");
        dropRow.className = "restock-section restock-drop-row";
        const dropTitle = document.createElement("p");
        dropTitle.className = "restock-section-title";
        dropTitle.textContent = full
            ? `当前卡组 · 已满 ${deck.length}/${DECK_SIZE}，先点一张换出`
            : `当前卡组 · ${deck.length}/${DECK_SIZE}（有空位，直接选新卡即可）`;
        const dropGrid = document.createElement("div"); dropGrid.className = "restock-drop-grid";
        for (const id of deck) {
            const rule = UNIT_RULES[id];
            const chip = document.createElement("button");
            chip.className = "restock-drop-chip";
            chip.textContent = rule.name;
            if (!full) { chip.disabled = true; }
            else {
                chip.addEventListener("click", () => {
                    this.restockDrop = id;
                    dropGrid.querySelectorAll(".restock-drop-chip").forEach(node => node.classList.toggle("active", node === chip));
                });
            }
            dropGrid.append(chip);
        }
        dropRow.append(dropTitle, dropGrid);
        grid.before(dropRow);

        const poolTitle = document.createElement("p");
        poolTitle.className = "restock-section-title restock-pool-title";
        poolTitle.textContent = "可换入的卡";
        grid.before(poolTitle);
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
                this.button("restock-confirm").disabled = !(this.restockPick && (!full || this.restockDrop));
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
        const deck = [...battle.deck];
        if (deck.length >= DECK_SIZE && !this.restockDrop) { return; }
        battle.restocks--;
        if (deck.length >= DECK_SIZE) { battle.deck.delete(this.restockDrop); }
        battle.deck.add(this.restockPick);
        this.buildBank([...battle.deck]);
        // The gear tray follows the new deck: universal gear stays, dedicated
        // pieces re-filter to whoever is now carried. Worn gear on deployed
        // companions is untouched — only the tray chips re-render.
        this.buildGearTray([...battle.deck]);
        // Pause for the dialog came through the view; the sim mirrors it.
        this.get("restock-dialog").close();
        view.setPaused("restock", false);
        const swapped = deck.length >= DECK_SIZE ? `（${UNIT_RULES[this.restockDrop].name}换出）` : "";
        this.notice(`${UNIT_RULES[this.restockPick].name}已换入卡组${swapped}。换卡机会剩 ${battle.restocks} 次。`);
        this.restockPick = null;
        this.restockDrop = null;
    }

    // 城镇：素材库存 + 五栋建筑（原作 TownObjectList 折算）。升级走
    // save.upgradeTown，立即生效并重渲染。
    // 城镇：素材做成带数量的芯片（原来是一行「战士的象征×0 魔法使的象征×0…」
    // 挤成一段），建筑卡补上等级进度条、满级徽章与「缺多少素材」的明确提示。
    // spec/01 §4.1：不可用状态必须有原因，不能只是变灰。
    openTown() {
        const matHost = this.get("town-materials");
        matHost.replaceChildren();
        const matTitle = document.createElement("p");
        matTitle.className = "town-material-title";
        matTitle.textContent = "持有素材";
        const chipRow = document.createElement("div");
        chipRow.className = "town-material-chips";
        for (const m of Object.values(TOWN_RULES.materials)) {
            const chip = document.createElement("span");
            chip.className = "town-material-chip";
            const dot = document.createElement("i");
            dot.className = `town-material-dot mat-${m.id}`;
            dot.setAttribute("aria-hidden", "true");
            const name = document.createElement("span");
            name.textContent = m.name;
            const count = document.createElement("b");
            count.textContent = String(this.save.progress.materials[m.id] || 0);
            chip.append(dot, name, count);
            chipRow.append(chip);
        }
        matHost.append(matTitle, chipRow);

        const grid = this.get("town-buildings");
        grid.replaceChildren();
        for (const b of Object.values(TOWN_RULES.buildings)) {
            const level = this.save.progress.town[b.id] || 0;
            const maxed = level >= b.maxLevel;
            const card = document.createElement("div");
            card.className = maxed ? "town-card is-maxed" : "town-card";
            card.dataset.level = String(level);

            const head = document.createElement("header");
            head.className = "town-card-head";
            const name = document.createElement("strong");
            name.textContent = b.name;
            const lv = document.createElement("span");
            lv.className = "town-card-level";
            lv.textContent = maxed ? "满级" : `Lv.${level} / ${b.maxLevel}`;
            head.append(name, lv);

            // 等级进度：每级一格，已达等级填金，未达留空。
            const track = document.createElement("div");
            track.className = "town-card-track";
            track.setAttribute("aria-hidden", "true");
            for (let i = 0; i < b.maxLevel; i++) {
                const pip = document.createElement("i");
                if (i < level) { pip.className = "is-filled"; }
                track.append(pip);
            }

            const orig = document.createElement("small");
            orig.className = "town-card-origin";
            orig.textContent = `原作：${b.originalName}`;
            const desc = document.createElement("p");
            desc.className = "town-card-desc";
            desc.textContent = b.desc;

            const cost = b.costPlan[level] || null;
            const costLine = document.createElement("p");
            costLine.className = "town-card-cost";
            if (maxed) {
                costLine.textContent = "已满级，这栋建筑不会再需要素材。";
            } else if (cost) {
                const need = {};
                for (const id of cost) { need[id] = (need[id] || 0) + 1; }
                const parts = Object.entries(need).map(([id, n]) => {
                    const have = this.save.progress.materials[id] || 0;
                    const label = `${TOWN_RULES.materials[id].name} ${have}/${n}`;
                    return have >= n ? label : `${label}（缺${n - have}）`;
                });
                costLine.textContent = "升级需要：" + parts.join("、");
            }
            card.append(head, track, orig, desc, costLine);

            if (cost && !maxed) {
                const affordable = this.canAfford(cost);
                const up = document.createElement("button");
                up.className = "native-button primary compact town-card-upgrade";
                up.textContent = affordable ? "升级" : "素材不足";
                up.disabled = !affordable;
                up.addEventListener("click", () => {
                    if (this.save.upgradeTown(b.id, b.costPlan)) {
                        this.notice(`${b.name} 升到 Lv.${(this.save.progress.town[b.id] || 0)}。`);
                        this.openTown();
                    } else { this.notice("素材不够，先去无尽巡守里收集。"); }
                });
                card.append(up);
            } else if (maxed) {
                const badge = document.createElement("span");
                badge.className = "town-card-badge";
                badge.textContent = "★ 已完成";
                card.append(badge);
            }
            grid.append(card);
        }
        this.get("town-dialog").showModal();
    }
    canAfford(cost) {
        const need = {};
        for (const id of cost) { need[id] = (need[id] || 0) + 1; }
        return Object.entries(need).every(([id, n]) => (this.save.progress.materials[id] || 0) >= n);
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
                `${Math.ceil(unit.hp)} / ${unit.maxHp}`, friend ? (unit.gear ? `装备：${UNIT_RULES[unit.gear]?.name || unit.gear}` : "在位") : this.enemyStatusText(unit, rule)];
            for (const value of values) { const td = document.createElement("td"); td.textContent = value; row.append(td); }
            body.append(row);
        }
        if (!body.children.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 4; cell.textContent = "还没有部署对象。可以先选择应援采集台。"; row.append(cell); body.append(row); }
        this.get("inspect-dialog").showModal();
    }

    enemyStatusText(enemy, rule) {
        const ability = rule.healer ? "治疗者" : rule.armor ? `护甲${Math.ceil(enemy.armor)}` : rule.hop ? "越障" : rule.ranged ? "远程" : rule.revive && !enemy.revived ? "可复起" : rule.summon ? "召唤者" : rule.thorns ? "反伤" : enemy.state === "walking" ? "前进" : "攻击中";
        return enemy.hp / enemy.maxHp <= .25 ? `危急·${ability}` : ability;
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
        clearTimeout(this.noticeTimer);
        clearTimeout(this.milestoneTimer);
        window.removeEventListener("resize", this.onResize);
        document.removeEventListener("visibilitychange", this.onVisibility);
        document.removeEventListener("keydown", this.onKey);
    }
}
