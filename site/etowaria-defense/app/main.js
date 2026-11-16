import { createCompanionGallery } from './companions.js';
import { loadCatalogue, portraitMarkup, siteUrl, uiUrl } from "./assets.js";
import { loadBones } from "./load-shell.js";
import { AudioDirector } from "./audio.js";
import { UNIT_RULES } from "../data/campaign.js";
import { se as defenseSE, setSeVolume as setSynthVolume, unlock as unlockSynth } from "../../core/audio.js";
globalThis.__defenseSE = defenseSE;
globalThis.__defenseSEVolume = setSynthVolume;

// The synth's se() is silent until core unlock() runs from a gesture — the
// AudioDirector.unlock() above is a different flag. Arm both from the same
// first input, same as the rl main does.
function armSynth() {
    unlockSynth();
    window.removeEventListener("pointerdown", armSynth, true);
    window.removeEventListener("click", armSynth, true);
    window.removeEventListener("keydown", armSynth, true);
}
window.addEventListener("pointerdown", armSynth, { capture: true });
window.addEventListener("click", armSynth, { capture: true });
window.addEventListener("keydown", armSynth, { capture: true });

const $ = id => document.getElementById(id);
const PARTY_KEY = "etowaria-defense.p0.party.v1";
const REVIEW_CLOCK = new URLSearchParams(location.search).get("review") === "1";
const state = { screen: "title", catalogue: null, party: [], selected: "U01", stage: null, epoch: 0 };
let toastTimer;
let campaign;
let companions;
let stageLoadingBones;
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
    companions.render();
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
        button.setAttribute("aria-pressed", "false"); button.title = `${index + 1}：${unit.name}，${UNIT_RULES[unit.id].role}`;
        button.append(portraitMarkup(unit, { identity: false }));
        const text = document.createElement("span");
        const name = document.createElement("strong"); name.textContent = unit.name;
        const role = document.createElement("small"); role.textContent = UNIT_RULES[unit.id].role;
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
    const units = state.party.map(id => companions.unit(id));
    buildLoadout(units);
    // 观察模式载入卡：progress 上方铺一次纸面骨条，随整卡显示与隐藏。
    if (!stageLoadingBones) { stageLoadingBones = loadBones($("stage-loading-bones"), { rows: 3 }); }
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
        $("stage-status").textContent = "动作观察：点选伙伴查看原动作，也可调整站位；本模式不消耗资源、不计入巡守记录。";
    } catch (error) {
        if (epoch !== state.epoch) { return; }
        showError(error);
    }
}

function showError(error) {
    console.error("星灯守望：", error);
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
    state.stage?.resize();
}

function syncSettings() {
    $("music-enabled").checked = audio.settings.music;
    $("voice-enabled").checked = audio.settings.voice;
    $("music-volume").value = Math.round(audio.settings.musicVolume * 100);
    $("music-value").value = `${Math.round(audio.settings.musicVolume * 100)}%`;
    $("se-volume").value = Math.round(audio.settings.seVolume * 100);
    $("se-value").value = `${Math.round(audio.settings.seVolume * 100)}%`;
    $("reduce-motion").checked = audio.settings.reducedMotion;
    document.body.classList.toggle("reduced-motion", audio.settings.reducedMotion);
}

$("start-campaign").addEventListener("click", openCampaign);
$("enter-scene").addEventListener("click", enterStage);
$("open-roster").addEventListener("click", openRoster);
$("roster-enter").addEventListener("click", enterStage);
$("roster-back").addEventListener("click", () => { showScreen("title"); audio.playTheme("day"); });
$("stage-back").addEventListener("click", openRoster);
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
$("se-volume").addEventListener("input", event => {
    audio.updateSettings({ seVolume: Number(event.target.value) / 100 }); $("se-value").value = `${event.target.value}%`;
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
            music: audio.settings.music, verificationMuted: audio.silent } }),
    get campaign() { return campaign; }
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
        state.party = Array.isArray(party) && party.length <= 6
            && new Set(party).size === party.length && party.every(id => ids.has(id))
            ? party : state.catalogue.defaultParty.slice();
        state.selected = state.party[0] || state.catalogue.units[0].id;
        companions = createCompanionGallery({ catalogue: state.catalogue, party: state.party,
            onChange: party => { state.party = party; saveParty(); },
            onSelect: unit => { state.selected = unit.id; } });
        $("enter-scene").disabled = false;
        $("enter-scene").textContent = "动作观察（不计分）";
        $("start-campaign").disabled = false;
        $("start-campaign").textContent = "开始巡守";
    } catch (error) { showError(error); }
}
boot();
