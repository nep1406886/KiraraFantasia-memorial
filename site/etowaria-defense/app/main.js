import { loadCatalogue, portraitMarkup, siteUrl, uiUrl, classIcons, elementIcons } from "./assets.js";
import { AudioDirector } from "./audio.js";

const $ = id => document.getElementById(id);
const PARTY_KEY = "etowaria-defense.p0.party.v1";
const REVIEW_CLOCK = new URLSearchParams(location.search).get("review") === "1";
const HELP = {
    U01: "在同一路持续施放土魔法，周期职业技覆盖小范围。",
    U02: "以水魔法处理群体敌人，招式后的自加速形成输出节奏。",
    U03: "以变化球与攻击技能卡为依据，规划越障抛投与追加落点。",
    U04: "原卡具备下一击必定会心的能力，适合蓄力后的高质量一击。",
    U05: "原卡可缩短自身再使用时间，规划为有明显空窗的周期连发。",
    U06: "用范围炎魔法和有利属性增伤，处理适合自己的威胁。",
    U07: "风属性战士。靠近来敌后打开物理防线，不是一次性爆破角色。",
    U08: "蓄力后的水属性重击有很高单体威力，也需要同伴照顾空档。",
    U09: "月属性战士。原技能的会心支援让物理队伍抓住出手机会。",
    U10: "对睡眠目标有原作特攻，需要其他同伴先创造控制机会。",
    U11: "炎属性骑士。以物理防御与仇恨提升守住最前面的道路。",
    U12: "攻击后提高防御，适合持续接敌；需要后排同伴补足火力。",
    U13: "三次完全格挡是这张卡的核心。拦截能力有次数，而非永久无敌。",
    U14: "原必杀具备净化、自愈和限次数屏障，照顾异常环境中的防线。",
    U15: "阳属性僧侣。用原作治疗能力及时照顾承受压力的同伴。",
    U16: "水属性僧侣。治疗技能卡是支援重点，水属性不等于冰冻攻击。",
    U17: "原卡能净化并暂时阻止异常状态，为队伍留一张可靠保险。",
    U18: "以治疗与行动速度支援维持同路伙伴的节奏，自己的输出并不高。",
    U19: "原卡确有行动速度下降和减少充能，适合为防线争取准备时间。",
    U20: "降低敌方魔防、物攻与充能，为魔法队伍打开缺口。",
    U21: "两条职业技分别削弱物防和魔防；睡眠必杀可与玛莉·梦魔配合。",
    U22: "关注敌人的蓄力时机，以减少充能和魔防削弱提供反制。",
    U23: "保留原技的双刃剑：饥饿与双攻削弱，也会加快敌人的行动。",
    U24: "束缚、物防削弱与阳耐性下降有原卡依据，不凭属性创造冰冻。"
};
const state = { screen: "title", catalogue: null, party: [], selected: "U01", filter: "all", stage: null, epoch: 0 };
let toastTimer;
let campaign;
const audio = new AudioDirector(notice);
audio.silent = REVIEW_CLOCK;

function notice(message) {
    $("stage-status").textContent = message;
    $("toast").textContent = message;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
}

function showScreen(name) {
    state.screen = name;
    for (const key of ["title", "roster", "stage", "campaign"]) { $(`${key}-screen`).hidden = key !== name; }
    window.scrollTo({ top: 0, behavior: "instant" });
}

function saveParty() {
    try { localStorage.setItem(PARTY_KEY, JSON.stringify(state.party)); } catch { /* Preferences are optional. */ }
}

function selectedUnit() { return state.catalogue?.units.find(unit => unit.id === state.selected); }

function showDetails(unit) {
    state.selected = unit.id;
    const image = $("detail-card");
    image.src = siteUrl(unit.card || unit.icon);
    image.alt = `${unit.name}，${unit.className}，${unit.elementName}属性，卡号${unit.cardId}`;
    image.classList.toggle("icon-only", !unit.card);
    $("card-gap").hidden = !!unit.card;
    $("detail-name").textContent = unit.name;
    $("detail-work").textContent = `${unit.work}　五星进化卡`;
    const identity = $("detail-identity");
    identity.replaceChildren();
    for (const [name, alt] of [[`ClassIcon${classIcons[unit.classId]}`, unit.className], [`ElementIcon${elementIcons[unit.elementId]}`, unit.elementName]]) {
        const icon = document.createElement("img"); icon.src = uiUrl(name); icon.alt = alt; identity.append(icon);
    }
    const label = document.createElement("span"); label.textContent = `${unit.className} · ${unit.elementName}`; identity.append(label);
    $("detail-role").textContent = HELP[unit.id];
    $("detail-cost").textContent = `规划费用 ${unit.plannedCost}　当前为动作与场景试演`;
    const skills = $("detail-skills");
    skills.replaceChildren();
    const evidence = document.createElement("p"); evidence.textContent = `原卡 ${unit.cardId} / 模型 ${unit.resourceId}。这里保留原技能日文；当前巡守开放的卡牌和塔防效果以关卡说明为准。`; skills.append(evidence);
    for (const skill of unit.skills) {
        const heading = document.createElement("h4"); heading.textContent = skill.name;
        const description = document.createElement("p"); description.textContent = skill.detail;
        skills.append(heading, description);
    }
    const included = state.party.includes(unit.id);
    $("toggle-party").textContent = included ? "移出本次场景" : "加入本次场景";
    $("toggle-party").disabled = included && state.party.length === 1;
    for (const button of $("roster-grid").querySelectorAll("button")) {
        button.classList.toggle("is-current", button.dataset.unit === unit.id);
    }
}

function renderRoster() {
    if (!state.catalogue) { return; }
    const grid = $("roster-grid");
    grid.replaceChildren();
    for (const unit of state.catalogue.units) {
        if (state.filter !== "all" && unit.classId !== Number(state.filter)) { continue; }
        const button = document.createElement("button");
        button.className = "roster-card";
        button.dataset.unit = unit.id;
        button.classList.toggle("is-in-party", state.party.includes(unit.id));
        button.classList.toggle("is-current", state.selected === unit.id);
        button.setAttribute("aria-label", `${unit.name}，${unit.className}，${unit.elementName}属性，${unit.role}，规划费用${unit.plannedCost}`);
        button.append(portraitMarkup(unit));
        for (const [tag, cls, text] of [["strong", "", unit.name], ["span", "unit-role", unit.role], ["span", "unit-cost", `费用 ${unit.plannedCost}`]]) {
            const node = document.createElement(tag); node.className = cls; node.textContent = text; button.append(node);
        }
        button.addEventListener("click", () => showDetails(unit));
        grid.append(button);
    }
    renderParty();
    showDetails(selectedUnit() || state.catalogue.units[0]);
}

function renderParty() {
    $("party-count").textContent = `${state.party.length} / 6 位伙伴`;
    const slots = $("party-slots");
    slots.replaceChildren();
    for (let i = 0; i < 6; i++) {
        const unit = state.catalogue.units.find(candidate => candidate.id === state.party[i]);
        const button = document.createElement("button");
        button.className = `party-slot${unit ? "" : " empty"}`;
        if (unit) {
            const image = document.createElement("img"); image.src = siteUrl(unit.icon); image.alt = "";
            const name = document.createElement("span"); name.textContent = unit.name;
            button.append(image, name);
            button.setAttribute("aria-label", `查看本次伙伴：${unit.name}`);
            button.addEventListener("click", () => showDetails(unit));
        } else {
            button.textContent = "添加伙伴";
            button.addEventListener("click", () => $("roster-grid").querySelector("button")?.focus());
        }
        slots.append(button);
    }
    $("roster-enter").disabled = !state.party.length;
}

function buildTabs() {
    const tabs = $("roster-tabs");
    for (const [id, label] of [["all", "全部"], [0, "战士"], [1, "魔法使"], [3, "骑士"], [2, "僧侣"], [4, "炼金术士"]]) {
        const button = document.createElement("button");
        button.className = "tab-button"; button.textContent = label; button.dataset.filter = id;
        button.setAttribute("role", "tab"); button.setAttribute("aria-controls", "roster-grid");
        button.setAttribute("aria-selected", String(id === "all"));
        button.addEventListener("click", () => {
            state.filter = String(id);
            for (const tab of tabs.children) { tab.setAttribute("aria-selected", String(tab === button)); }
            renderRoster();
        });
        button.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight"].includes(event.key)) { return; }
            event.preventDefault();
            const buttons = [...tabs.children];
            const next = buttons[(buttons.indexOf(button) + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
            next.focus(); next.click();
        });
        tabs.append(button);
    }
    $("roster-grid").setAttribute("role", "tabpanel");
}

function leaveStage() {
    state.epoch++;
    state.stage?.dispose();
    state.stage = null;
    document.body.classList.remove("cinematic-active");
    $("cinematic-controls").hidden = true;
    audio.endCinematic();
    audio.suspend(false);
    audio.playTheme("day");
}

async function openCampaign() {
    if (!state.catalogue) { return; }
    leaveStage();
    const epoch = state.epoch;
    try {
        if (!campaign) {
            const { Campaign } = await import("./campaign.js");
            if (epoch !== state.epoch) { return; }
            campaign = new Campaign({ host: $("campaign-screen"), catalogue: state.catalogue, audio,
                manualClock: REVIEW_CLOCK, onSettings: openSettings,
                onBack: () => { showScreen("title"); audio.playTheme("day"); } });
        }
        showScreen("campaign");
        campaign.showMap();
        audio.unlock();
    } catch (error) { showError(error); }
}

function openSettings() {
    audio.unlock(); syncSettings(); $("settings-dialog").showModal();
    state.stage?.setPaused("dialog", true);
    if (state.screen === "campaign") { campaign?.setSettingsPaused(true); }
}

function openRoster() {
    if (!state.catalogue) { return; }
    leaveStage();
    showScreen("roster");
    renderRoster();
    audio.unlock();
}

function updateStageSelection(unit) {
    state.selected = unit.id;
    $("selected-unit-name").textContent = unit.name;
    $("selected-unit-role").textContent = `${unit.className} · ${unit.elementName}`;
    for (const button of $("stage-loadout").children) { button.setAttribute("aria-pressed", String(button.dataset.unit === unit.id)); }
    $("play-skill").title = (unit.classId === 3 ? unit.skills[2] : unit.skills[1]).name;
    $("play-ultimate").title = unit.skills[0].name;
}

function buildLoadout(units) {
    const bar = $("stage-loadout");
    bar.replaceChildren();
    for (const [index, unit] of units.entries()) {
        const button = document.createElement("button"); button.className = "loadout-unit"; button.dataset.unit = unit.id;
        button.setAttribute("aria-pressed", "false"); button.title = `${index + 1}：${unit.name}，${unit.role}`;
        button.append(portraitMarkup(unit, { identity: false }));
        const text = document.createElement("span");
        const name = document.createElement("strong"); name.textContent = unit.name;
        const role = document.createElement("small"); role.textContent = unit.role;
        text.append(name, role); button.append(text);
        button.addEventListener("click", () => state.stage?.select(unit.id));
        bar.append(button);
    }
}

function stageControls(enabled) {
    for (const button of $("stage-screen").querySelectorAll(".action-buttons button, .demo-buttons button, #toggle-grid")) { button.disabled = !enabled; }
    $("scene-theme").disabled = !enabled;
}

async function enterStage() {
    if (!state.catalogue || !state.party.length) { return; }
    leaveStage();
    const epoch = ++state.epoch;
    showScreen("stage");
    stageControls(false);
    const units = state.party.map(id => state.catalogue.units.find(unit => unit.id === id));
    buildLoadout(units);
    $("stage-loading").hidden = false;
    $("loading-progress").textContent = "读取原生模型、武器、表情和场地…";
    $("loading-progress-bar").value = 0;
    $("scene-theme").value = "day";
    $("stage-pause").textContent = "暂停";
    $("stage-pause").setAttribute("aria-pressed", "false");
    $("toggle-grid").setAttribute("aria-pressed", "false");
    audio.unlock();
    try {
        const { DefenseStage } = await import("../render/stage.js");
        if (epoch !== state.epoch) { return; }
        const stage = await DefenseStage.create({ host: $("stage-canvas"), labels: $("stage-labels"), units, audio,
            manualClock: REVIEW_CLOCK,
            onProgress: (fraction, message) => {
                if (epoch !== state.epoch) { return; }
                $("loading-progress-bar").value = fraction; $("loading-progress").textContent = message;
            },
            onSelect: unit => { if (epoch === state.epoch) { updateStageSelection(unit); } },
            onNotice: message => { if (epoch === state.epoch) { notice(message); } },
            onDemo: playing => { if (epoch === state.epoch) { $("play-demo").textContent = playing ? "停止试演" : "试演攻防"; } },
            onTheme: theme => {
                if (epoch !== state.epoch) { return; }
                $("stage-heading").textContent = theme.title; $("scene-caption").textContent = theme.caption;
            },
            onCinematic: (active, title) => {
                if (epoch !== state.epoch) { return; }
                document.body.classList.toggle("cinematic-active", active);
                $("cinematic-controls").hidden = !active;
                if (title) { $("cinematic-title").textContent = title; }
            }
        });
        if (epoch !== state.epoch) { stage.dispose(); return; }
        state.stage = stage;
        $("stage-loading").hidden = true;
        stageControls(true);
        updateOrientation();
        if (document.hidden && !REVIEW_CLOCK) { stage.setPaused("visibility", true); }
        stage.render();
        $("stage-status").textContent = "P0 场景样机：点选伙伴查看原动作，也可在空格试摆。本阶段不进行经济与胜负结算。";
    } catch (error) {
        if (epoch !== state.epoch) { return; }
        showError(error);
    }
}

function showError(error) {
    console.error("里之守望：", error);
    $("stage-loading").hidden = true;
    $("error-message").textContent = error.message || String(error);
    if (!$("error-dialog").open) { $("error-dialog").showModal(); }
    state.stage?.setPaused("error", true);
}

async function command(fn) {
    if (!state.stage) { return; }
    try { await fn(state.stage); }
    catch (error) { showError(error); }
}

function togglePause() {
    if (!state.stage) { return; }
    const pause = !state.stage.pauseReasons.has("manual");
    state.stage.setPaused("manual", pause);
    $("stage-pause").setAttribute("aria-pressed", String(pause));
    $("stage-pause").textContent = pause ? "继续" : "暂停";
    $("stage-status").textContent = pause ? "场景已暂停，动作和演出计时均已停止。" : "场景已继续。";
}

function updateOrientation() {
    const compactPortrait = innerWidth < 700 && innerHeight > innerWidth;
    $("portrait-notice").hidden = !compactPortrait;
    state.stage?.setPaused("orientation", compactPortrait);
}

function syncSettings() {
    $("music-enabled").checked = audio.settings.music;
    $("voice-enabled").checked = audio.settings.voice;
    $("music-volume").value = Math.round(audio.settings.musicVolume * 100);
    $("music-value").value = `${Math.round(audio.settings.musicVolume * 100)}%`;
    $("reduce-motion").checked = audio.settings.reducedMotion;
    document.body.classList.toggle("reduced-motion", audio.settings.reducedMotion);
}

$("start-campaign").addEventListener("click", openCampaign);
$("enter-scene").addEventListener("click", enterStage);
$("open-roster").addEventListener("click", openRoster);
$("roster-enter").addEventListener("click", enterStage);
$("roster-back").addEventListener("click", () => { showScreen("title"); audio.playTheme("day"); });
$("stage-back").addEventListener("click", openRoster);
$("portrait-back").addEventListener("click", openRoster);
$("toggle-party").addEventListener("click", () => {
    const index = state.party.indexOf(state.selected);
    if (index >= 0) { if (state.party.length > 1) { state.party.splice(index, 1); } }
    else if (state.party.length < 6) { state.party.push(state.selected); }
    else { notice("场景最多带入六位伙伴。先移出一位，再加入新的伙伴。"); return; }
    saveParty(); renderRoster();
});
$("restore-party").addEventListener("click", () => { state.party = state.catalogue.defaultParty.slice(); saveParty(); renderRoster(); });
$("scene-theme").addEventListener("change", event => command(stage => stage.setTheme(event.target.value)));
$("toggle-grid").addEventListener("click", event => {
    const pressed = event.currentTarget.getAttribute("aria-pressed") !== "true";
    event.currentTarget.setAttribute("aria-pressed", String(pressed));
    event.currentTarget.textContent = pressed ? "隐藏格位" : "显示格位";
    state.stage?.toggleGrid(pressed);
});
for (const [id, kind] of [["play-attack", "attack"], ["play-skill", "skill"], ["play-damage", "damage"], ["play-win", "win"]]) {
    $(id).addEventListener("click", () => command(stage => stage.playSelected(kind)));
}
$("play-ultimate").addEventListener("click", () => command(stage => stage.playUltimate()));
$("play-demo").addEventListener("click", () => command(stage => stage.startDemo()));
$("stage-pause").addEventListener("click", togglePause);
$("reset-stage").addEventListener("click", () => state.stage?.resetPositions());
$("close-cinematic").addEventListener("click", () => state.stage?.closeCinematic());

for (const button of document.querySelectorAll("[data-open-settings]")) {
    button.addEventListener("click", openSettings);
}
const releaseSettingsPause = () => {
    state.stage?.setPaused("dialog", false);
    campaign?.setSettingsPaused(false);
};
// A background webview may defer the native close event until a paint.
// Release our pause owner when the close action is submitted, not only then.
$("settings-dialog").querySelector("form").addEventListener("submit", releaseSettingsPause);
$("settings-dialog").addEventListener("cancel", releaseSettingsPause);
$("settings-dialog").addEventListener("close", releaseSettingsPause);
$("open-about").addEventListener("click", () => $("about-dialog").showModal());
$("music-enabled").addEventListener("change", event => audio.updateSettings({ music: event.target.checked }));
$("voice-enabled").addEventListener("change", event => audio.updateSettings({ voice: event.target.checked }));
$("music-volume").addEventListener("input", event => {
    audio.updateSettings({ musicVolume: Number(event.target.value) / 100 }); $("music-value").value = `${event.target.value}%`;
});
$("reduce-motion").addEventListener("change", event => {
    audio.updateSettings({ reducedMotion: event.target.checked }); syncSettings();
});
$("retry-stage").addEventListener("click", () => { $("error-dialog").close(); enterStage(); });
$("error-back").addEventListener("click", () => { $("error-dialog").close(); leaveStage(); showScreen("title"); });
$("error-dialog").addEventListener("cancel", event => { event.preventDefault(); $("error-back").click(); });

window.addEventListener("resize", updateOrientation);
document.addEventListener("visibilitychange", () => {
    if (REVIEW_CLOCK) { return; }
    state.stage?.setPaused("visibility", document.hidden);
    if (!state.stage && state.screen !== "campaign") { audio.suspend(document.hidden); }
});
document.addEventListener("keydown", event => {
    if (document.querySelector("dialog[open]") || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || state.screen !== "stage") { return; }
    if (event.repeat) { return; }
    if (event.code === "Space") { event.preventDefault(); togglePause(); }
    if (event.key === "Escape" && state.stage?.cinematic) { state.stage.closeCinematic(); }
    if (/^[1-6]$/.test(event.key)) {
        const id = state.party[Number(event.key) - 1]; if (id) { state.stage?.select(id); }
    }
    const keys = { a: "play-attack", s: "play-skill", u: "play-ultimate", g: "toggle-grid" };
    if (keys[event.key.toLowerCase()]) { $(keys[event.key.toLowerCase()]).click(); }
});
window.addEventListener("pagehide", () => { leaveStage(); campaign?.dispose(); audio.dispose(); });

window.__defense = Object.freeze({
    snapshot: () => ({ screen: state.screen, party: state.party.slice(), selected: state.selected,
        ready: !!state.catalogue, scene: state.stage?.snapshot() || null, campaign: campaign?.snapshot() || null,
        audio: { track: audio.track, paused: audio.bgm.paused, volume: audio.bgm.volume,
            music: audio.settings.music, verificationMuted: audio.silent } })
});

if (REVIEW_CLOCK) {
    document.querySelector(".title-phase").textContent = "固定时钟验收 · 不用于帧率测试";
    window.__defenseReview = Object.freeze({
        step(seconds = 1 / 30) {
            if (!state.stage || !Number.isFinite(seconds) || seconds < 0 || seconds > 30) {
                throw new Error("固定时钟仅接受 0–30 秒，且需要先进入场景");
            }
            let remaining = seconds;
            while (remaining > 1e-8) {
                const dt = Math.min(1 / 60, remaining);
                state.stage.update(dt);
                remaining -= dt;
            }
            state.stage.render();
            return state.stage.snapshot();
        },
        capture(width = 1600, height = 900) {
            if (state.screen === "campaign" && campaign?.view) { return campaign.view.stage.capture(width, height); }
            if (!state.stage) { throw new Error("需要先进入场景"); }
            return state.stage.capture(width, height);
        },
        campaignStep(seconds = 1 / 30) {
            if (!campaign?.view) { throw new Error("需要先进入巡守"); }
            return campaign.view.reviewStep(seconds);
        },
        async itemIcons() {
            const stage = state.stage || campaign?.view?.stage;
            if (!stage) { throw new Error("需要先进入场景"); }
            const { captureDeploymentIcons } = await import("../render/item-icons.js");
            return captureDeploymentIcons(stage);
        },
        cellPoint(row, col) { return campaign?.cellPoint(row, col) || null; }
    });
}

async function boot() {
    syncSettings();
    try {
        state.catalogue = await loadCatalogue();
        const ids = new Set(state.catalogue.units.map(unit => unit.id));
        let party;
        try { party = JSON.parse(localStorage.getItem(PARTY_KEY) || "null"); } catch { party = null; }
        state.party = Array.isArray(party) && party.length > 0 && party.length <= 6
            && new Set(party).size === party.length && party.every(id => ids.has(id))
            ? party : state.catalogue.defaultParty.slice();
        state.selected = state.party[0];
        buildTabs();
        $("enter-scene").disabled = false;
        $("enter-scene").textContent = "演出观察";
        $("start-campaign").disabled = false;
        $("start-campaign").textContent = "开始巡守";
    } catch (error) { showError(error); }
}
boot();
