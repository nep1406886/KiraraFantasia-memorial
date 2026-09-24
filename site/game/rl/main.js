// Driver for game/roguelike.html — stages 2–3 of the roguelike plan.
//
// A seed-driven dungeon of rooms (battle/chest/shop/rest/boss) with door
// transitions, locked battle rooms and a minimap, rendered with the original
// game's map kits (view/mapview.js) under the fixed art direction
// (view/scene.js: warm key light, sky ambient, per-volume fog) — plus stage 3's
// fight: the shipped tables (asset/rl/*.json) decide who spawns and what
// everything hits for, enemies telegraph and fire danmaku, and the status line
// carries HP, the とっておき gauge and the three cooldowns.
//
// The world is pure logic (game/rl/world.js, no three.js); this file wires it
// to input, the fixed-step clock, the camera, the view layer and the minimap,
// and keeps a headless handle on window.kirafanRL.
//
// ?volume=N (1–5) picks the 卷: biome, boss arena and fog tint come from
// asset/rl/floors.json, the roster and both sides' levels from the matching
// asset/rl/encounters.json row. Same volume + same seed = same dungeon, same
// rooms, same prop placement, same fight.
//
// Legacy table-less fixtures retain literal defaults. Actual room assembly
// failures keep combat paused and expose retry/backup instead of hiding missing
// scenery or letting an invisible enemy fight behind a warning-only log.

import * as loader from "../../core/loader.js";
import * as actorModule from "../../core/actor.js";
import * as cards from "../../core/cards.js";
import * as audio from "../../core/audio.js";
import { loadStats } from "../../asset/rl/stats.js";
import { createClock } from "./clock.js";
import { createMotionSampler } from "./view/motion.js";
import { createInput } from "./input.js";
import { PLAYABLE_IDS, PLAYABLE_ROSTER } from "./rosterids.js";
import { createRandom, hash32, seedFrom } from "./random.js";
import { setAffixPool } from "./loot.js";
import { setAffixTable, affixTableFromPassives } from "./equipment.js";
import { setWeaponCatalog, weaponDefinition, canEquipWeapon } from "./weaponcatalog.js";
import { gadgetDefinition, gadgetTerms } from "./gadgets.js";
import { createWorld, EXP_PER_KILL, COIN_PER_KILL } from "./world.js";
import { hitStopFor } from "./impact.js";
import { generateDungeon, doorsOf } from "./dungeon.js";
import { attachPlayerView } from "./view/actorview.js";
import { attachEnemyView } from "./view/enemyview.js";
import {
    attachChestView, attachBarrelViews, attachAltarView, attachNpcView
} from "./view/interactview.js";
import { createDanmakuView } from "./view/danmakuview.js";
import { createEnemyTelegraphs } from "./view/enemytelegraphs.js";
import { createFollowCamera } from "./view/camera.js";
import { createMinimap } from "./view/minimap.js";
import { createStageScene } from "./view/scene.js?v=20260908-1";
import { createMapView, volumeConfig, biomeFor } from "./view/mapview.js";
import { createDamageTextLayer } from "./view/damagetext.js";
import { createHealthBars } from "./view/healthbars.js";
import { createBattleIndicators } from "./view/battleindicators.js";
import { createSkillVFX } from "./view/skillvfx.js";
import { loadEnemyAttacks } from "./view/nativeassets.js";
import { COMBAT_HEIGHT } from "./view/layers.js";
import { setCharacterPitch } from "./view/tilt.js";
import { showRoster } from "./ui/roster.js";
import { showEquipmentComparison, showSupplyChoice, showAltarChoice, showFloorDeparture, showCampTraining, showEquipmentCollection,
    equipmentName, equipmentIcon, equipmentRarity } from "./ui/decisions.js";
import { showSkillCard } from "./ui/infocard.js";
import { showCodex } from "./ui/codex.js";
import { createHud } from "./ui/hud.js";
import { createLandscapeGuard } from "./ui/orientation.js";
import { accessibility, applyAccessibility } from "./accessibility.js";
import { quality, applyQuality } from "./quality.js";
import { showRunResult } from "./ui/result.js";
import { showStorageManager, createStorageStatus } from "./ui/storage.js";
import { showFloorLoading } from "./ui/floorload.js";
import { createRoomLoading, waitForRoomFade } from './ui/roomload.js';
import { retryNativeRequests } from './view/nativeassets.js';
import { createMeta, mergeState, pagesForVolume, FINALE_PAGES } from "./meta.js";
import { createTutorial } from "./tutorial.js";
import { ACHIEVEMENTS, evaluateAchievements } from "./achievements.js";
import { showAchievements, showAchievementToast } from "./ui/achievements.js";
import { showHowto } from "./ui/howto.js";
import { load as loadSlot, write as writeSlot, clear as clearSlot, exportSave, previewImport,
    importSave, storageState, setImportValidator, initializeStorage, retryStorage,
    exportPendingSave, subscribeStorage, checkStorageChanges, beginRun, resultState, acknowledgeResult } from "./save.js";
import { createProfileValidator } from "./profileschema.js";
import {
    RUN_SCHEMA_VERSION, parseRunSnapshot, buildRunPayload,
    layoutSeedFor as layoutSeedForSeed
} from "./runschema.js";
import { initBGM, playBGM, stopBGM, setBGMChapter } from "./bgm.js";
import { loadScene, loadTimeline, loadSceneIndex, createStage, disposeScene } from "../../core/skillstage.js";
import * as dialogue from "./dialogue.js";
import { selectStory, storySections, validateStoryCatalog, previousStoryResult } from "./story.js";
import { dialogueNameForCard, dialoguePresentationForName } from "./storycharacters.js";
import { createDialoguePresenter } from "./ui/dialogue.js";

const stage = document.getElementById("stage");
const status = document.getElementById("status");
const minimapBox = document.getElementById("minimap");
const hintBox = document.getElementById("hint");
const shopPanel = document.getElementById("shop-panel");
const shopItemsBox = document.getElementById("shop-items");
const shopCoinLabel = document.getElementById("shop-coin");
const menuPanel = document.getElementById("menu-panel");
const equipmentModelBox = document.getElementById("menu-equipment-model");
const equipmentModelStatus = document.getElementById("menu-equipment-status");
const equipmentRetry = document.getElementById("menu-equipment-retry");
const bossBar = document.getElementById("boss-bar");
const floorBox = document.getElementById("floor-display");
const roomFade = document.getElementById("room-fade");

const debugHud = new URLSearchParams(location.search).get("debug") === "1";
function setText(node, text) {
    if (node && node.textContent !== String(text)) { node.textContent = text; }
}
function say(text) {
    setText(status, text);
    if (status.hidden !== !text) { status.hidden = !text; }
}

// Only contextual prompts and short beats occupy the scene. The complete
// control legend remains in the always-reachable menu, not over combat.
const HINT_DEFAULT = "";
const HINT_HOLD = 1.8;
let hintTimer = 0;

function beat(text, seconds) {
    if (!hintBox) {
        return;
    }
    setHint(text);
    hintTimer = seconds || HINT_HOLD;
}

// T22g: between beats the line doubles as the interact prompt — whatever is
// in E range says so, so the interactables advertise themselves without a
// tutorial. setHint caches so the idle path never churns the DOM per frame.
// While the walkthrough is active it owns the line and writes it directly
// (its onHint bypasses this guard); every other writer yields to it — e.g. a
// chest opened during the interact step must not overwrite the step hint.
let lastHintText = null;
function setHint(text) {
    if (!hintBox || text === lastHintText) {
        return;
    }
    if (tutorial && tutorial.active) {
        return;
    }
    lastHintText = text;
    hintBox.textContent = text;
    hintBox.hidden = !text;
}

function interactHint() {
    if (!world || !world.player || !world.room
            || shopOpen || menuOpen || codexOpen || decisionOpen || usLoading || usPlayer || dialogueBusy || landscapeBlocked) {
        return null;
    }
    const p = world.player;
    const interactKey = hud && hud.touchOn ? "点击「交互」" : "按 E ";
    const near = function (spot, r) {
        return !!spot && Math.hypot(p.x - spot.x, p.y - spot.y) <= r;
    };
    if (near(world.chest, 2.2)) {
        return world.chest.opened ? "宝箱已经空了" : interactKey + "打开宝箱";
    }
    if (near(world.altar, 1.9)) {
        return world.altar.used ? "祭坛安静了下来" : interactKey + "祈愿";
    }
    if (world.room.type === "rest") {
        return interactKey + "交谈";
    }
    if (world.room.type === "shop") {
        return interactKey + "进店";
    }
    if (world.canCommuneAtShrine && currentFloorShrine()) {
        return interactKey + '向大圣堂雕像祈愿';
    }
    if (world.floorExitReady) {
        return '大圣堂雕像已苏醒 · 靠近雕像，与星光共鸣';
    }
    return null;
}

function updateHint(dt) {
    // The walkthrough owns the hint line for its whole step (plan 阶段 8);
    // the interact prompt comes back once it dismisses.
    if (tutorial && tutorial.active) {
        return;
    }
    if (hintTimer <= 0) {
        setHint(interactHint() || HINT_DEFAULT);
        return;
    }
    hintTimer -= dt;
    if (hintTimer <= 0) {
        setHint(HINT_DEFAULT);
    }
}

// The first-run walkthrough (plan 阶段 8「菜单、教学、成就」). tutorialEntryOpen
// is set when a fresh run boots on an un-tutored save (and when the howto
// overlay's 重新教学 asks again); tickTutorial begins it on the first step the
// player actually controls the world, then feeds it input edge detections.
// A frozen world (dialogue, menu, shop, overlays, loading) simply stalls the
// walkthrough; it resumes when control returns.
// While active the player is untouchable: tryHit treats iframes>0 as a full
// miss, so a fixed i-frame floor lets the tutorial teach without punishing —
// the first room can be a battle room and the walkthrough must not end in a
// death screen. onDone/dispose drop the floor again.
const TUTORIAL_IFRAMES = 1e6;
function clearTutorialSafety() {
    if (world && world.player && world.player.iframes === TUTORIAL_IFRAMES) {
        world.player.iframes = 0;
    }
}
function tickTutorial(dt) {
    if (tutorialEntryOpen && world && world.player
            && runPhase === "active" && !world.frozen) {
        tutorialEntryOpen = false;
        if (tutorial) {
            tutorial.begin();
        }
    }
    if (tutorial && tutorial.active && world && !world.frozen) {
        if (world.player && world.player.iframes !== undefined) {
            world.player.iframes = Math.max(world.player.iframes, TUTORIAL_IFRAMES);
        }
        tutorial.update(input.state, dt);
    }
}

// Achievements (plan 阶段 8): evaluate checks every table row as a pure read
// and persists passing ones through meta.unlockAchievements — one batch write
// per sweep — so repeated sweeps return [] after the first and each unlock
// toasts once.
function sweepAchievements() {
    if (!meta) {
        return;
    }
    const fresh = evaluateAchievements(meta);
    if (fresh.length) {
        // One chime per sweep that actually unlocked something (the browser
        // still blocks audio before the first gesture, so a boot sweep is
        // silent until the player has armed a sound).
        audio.se("chime", { volume: 0.6 });
    }
    fresh.forEach(function (entry) {
        showAchievementToast(entry);
    });
}

// 游玩说明 §三: 每卷 20 层，第 20 层是 Boss. The volume-clear unlock only
// fires on that floor's boss (T11), so single-floor demo runs stay dormant.
const VOLUME_FLOORS = 20;
const params = new URLSearchParams(window.location.search);
// 局内续档: a run snapshot picks the boot volume when the URL doesn't. An
// explicit ?volume= always wins (gates jump with it), so a snapshot can never
// hijack a targeted boot — it only fills in the default for a player who
// reloads the plain page mid-run.
const bootRun = readRunSnapshot();
const volume = params.has("volume")
    ? Math.min(5, Math.max(1, parseInt(params.get("volume"), 10) || 1))
    : (bootRun && bootRun.volume >= 1 && bootRun.volume <= 5
        ? bootRun.volume : 1);
// Jump-to-floor (gates boot straight at ?volume=1&floor=20 for the boss
// checks); clamped to the authored ladder so a stray ?floor=99 cannot
// desync world.floor from the segment table.
const startFloor = Math.min(VOLUME_FLOORS,
    Math.max(1, parseInt(params.get("floor") || "1", 10) || 1));
function randomSeed() {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        var buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return buf[0];
    }
    return Math.floor(Math.random() * 0x100000000) >>> 0;
}

function parseSeedParam(text) {
    var s = String(text || "").trim();
    if (!/^\d{1,10}$/.test(s)) { return null; }
    var n = parseInt(s, 10);
    return n >= 0 && n <= 0xFFFFFFFF ? n >>> 0 : null;
}

// T24 run seed (spec/07 §6): one uint32 per run drives both the fight stream
// and every floor's layout seed. A matching snapshot means the run MAY
// resume; its saved seed drives everything. Without one, ?seed= or a fresh
// random uint32 starts a new run.
const resumeSnapshot = bootRun && bootRun.volume === volume ? bootRun : null;
const urlSeed = params.has("seed") ? parseSeedParam(params.get("seed")) : null;
const RUN_SEED = resumeSnapshot
    ? resumeSnapshot.seed
    : (urlSeed !== null ? urlSeed : randomSeed());

// Layout seed for floor f: derived from the uint32 run seed, so the same
// seed + volume + floor always rebuilds the same dungeon. The pure helper
// lives in runschema.js so the acceptance harness pins the same derivation.
function layoutSeedFor(f) {
    return layoutSeedForSeed(RUN_SEED, f);
}
// 卷名 for the HUD (roguelike-plan §0.2 分卷表); the 段名 rides in
// floors.json next to each segment.
const VOLUME_NAMES = {
    1: "褪色之海", 2: "沉眠之沙", 3: "贪食之森", 4: "机械之心", 5: "真实之影"
};

// Preserve the existing saved-height range. The camera now enlarges its
// orthographic frustum with height; fog and billboard pitch follow the rig.
const CAM_HEIGHT_MIN = 5.5;
const CAM_HEIGHT_MAX = 13;
const CAM_HEIGHT_DEFAULT = 9;
const CAM_RIG_BACK = 6.5;
const CAM_RIG_DIST_DEFAULT = Math.hypot(CAM_HEIGHT_DEFAULT, CAM_RIG_BACK);
function savedCamHeight() {
    const v = parseFloat(loadSlot("cam-height"));
    return isFinite(v)
        ? Math.min(CAM_HEIGHT_MAX, Math.max(CAM_HEIGHT_MIN, v))
        : CAM_HEIGHT_DEFAULT;
}

// T29 辅助设置: the three switches ride the same persisted-settings path as
// the saved camera height. Module-scope loadSlot is the boot read (the run
// snapshot already does this); the menu handler re-reads after each toggle so
// the view layer always mirrors the durable bytes.
const ACCESSIBILITY_KEYS = ["reduced-shake", "reduced-flash", "simplified-ultimates"];
function savedAccessibility() {
    const snapshot = {};
    for (const key of ACCESSIBILITY_KEYS) { snapshot[key] = loadSlot(key) === true; }
    return snapshot;
}
applyAccessibility(savedAccessibility());
function applyCamHeight(h) {
    const c = Math.min(CAM_HEIGHT_MAX, Math.max(CAM_HEIGHT_MIN, h));
    if (followCam) {
        followCam.setHeight(c);
        stageScene.setFogShift(followCam.distance() - CAM_RIG_DIST_DEFAULT);
    }
    return c;
}

let THREE = null;
let renderer = null;
let stageScene = null;
let scene = null;
let camera = null;
let followCam = null;
let clock = null;
const input = createInput();
const minimap = createMinimap(minimapBox);
let world = null;               // created once the tables have been fetched
let tables = null;              // { stats, skills, encounters } or null
let mapView = null;
let playerView = null;
let lastEquipmentState = null;
let enemyViews = [];
let danmakuView = null;
let enemyTelegraphs = null;
let damageTextLayer = null;
let healthBars = null;
let battleIndicators = null;
let skillVFX = null;        // Skill visual effects (Task 4.4)
let enemyAttacks = null;    // original enemy attack effect map (slash/blow/bite/claw)
let hud = null;             // the real HUD + touch controls (ui/hud.js)
// A room change while an enemy model is still loading must not push a ghost
// view into the new room: every load remembers the generation it started in.
let roomGeneration = 0;
const pendingViews = new Map();
const pendingInteractViews = new Map();
let pendingRoomLoad = null, roomLoadUI = null;
const ROOM_LOAD_TIMEOUT_MS = 20000;

// とっておき演出 (阶段 6)
let voicesData = null;      // asset/rl/voices.json
let usPlayer = null;        // core/uniqueskill.js player
let usLoading = false;      // load in flight (usPlayer is set only on resolve)
let usActor = null;
let usRequest = 0;
let usDeferredEvents = [];
let usSkipButton = null;

// Boss opening voice (spec/05 §6 rule 5): asset/rl/bossvoices.json maps
// every voiced enemy sheet to its local mp3 variants, and
// bossvoice-lines.json carries the invented subtitle lines.
let bossVoiceData = null;   // asset/rl/bossvoices.json
let bossVoiceLines = null;  // asset/rl/bossvoice-lines.json
let bossVoiceAudio = null;  // HTMLAudioElement for voice_400 playback
let bossVoiceTimer = 0;     // subtitle hide timeout (0 = none pending)
// Subtitle hold. Audio is real-time — the line must hide on the wall clock
// (setTimeout), not on rAF, which the preview pane can stall.
const BOSS_VOICE_HOLD_MS = 4500;

// BGM system (Task 4.1)
let bgm = null;             // BGM manager instance

// Progression UI state (spec/04 §10): shop/menu overlays freeze the world,
// drop markers pair with the world's drop ledger, and the E/Esc keys are
// edge-triggered here so a held key cannot re-buy or re-toggle.
let dropViews = new Map();  // drop ledger entry -> sprite (T22j)
// T22j coin receipts: kill/barrel/altar coins are credited silently in
// world.js, so the sprite is the only feedback. Ephemeral — no ledger.
let coinFlys = [];
// Loaded once in setup(); spawnDropMarker/coin reads these lazily so a
// texture that has not arrived yet still yields a white sprite, not a crash.
let dropTextures = null;
const weaponTextures = new Map();
// T22g interactable views: one chest, a few barrels, maybe an altar and the
// campfire guest, rebuilt per room like the enemy views. `interactPending`
// counts in-flight loads so a gate can wait for a fully built room.
let chestView = null;
let barrelViews = [];
let altarView = null;
let npcView = null;
let npcCard = null;         // the guest's gacha card (dialogue name + bust)
let shrineMarker = null;
let menuOpen = false;
let shopOpen = false;
let decisionOpen = false;
let activeDecision = null;
let lastShopKeys = [false, false, false];
let codexOpen = false;
let achvOpen = false;
let howtoOpen = false;
let tutorial = null;          // first-run walkthrough (tutorial.js, plan 阶段 8)
let tutorialEntryOpen = false; // start the walkthrough on the next unfrozen step
let lastMenu = false;
let lastInteract = false;
let weaponsData = null;     // weapons-rl.json, for shop affix detail text
let meta = null;            // cross-run progression (meta.js, T11)
let runPhase = "selecting";
let activeRunId = null;
let storageConflict = false;
let landscapeBlocked = false;
let runResult = null;
let pendingDescent = null;
const FLOOR_LOAD_TIMEOUT_MS = 20000;

// Dialogue (T12): the presenter owns the DOM box; the queue serializes nodes
// so a boss death landing mid-prologue cannot interleave two typewriters.
let dialoguePresenter = null;
const dialogueQueue = [];
let dialogueBusy = false;

// Bumped once per renderFrame call. The model render-order pass reads it to
// reuse one CPU-skinned AABB across all passes of the same frame (staged
// compositing renders the scene up to three times per frame).
let renderStamp = 0;


function setup(modules) {
    THREE = modules.THREE;
    // T29 画质档位 (spec/08 §5): boot applies the persisted tier before the
    // renderer is created. "high" keeps the >=2x restoration scheme; a tier
    // changes only the presentation buffer and view-layer particle rates.
    applyQuality(loadSlot("quality"), window.devicePixelRatio || 1);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    // T22m-4 渲染对齐 models.html: the restored default is min(max(2, dpr), 3) —
    // floor 2 so a dpr-1 desktop still gets supersampling, cap 3 for fill
    // cost. The old min(2, dpr) rendered 1x on every desktop, and
    // undersampling is exactly the "边缘粗/发糊" the observation room never
    // shows (its measurements: undersampling MAE 3.43 → 2.61 once fixed).
    // The quality tier scales the same ladder down from this default.
    renderer.setPixelRatio(quality.pixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.appendChild(renderer.domElement);

    stageScene = createStageScene(THREE, renderer, { frameStamp: function () { return renderStamp; } });
    scene = stageScene.scene;
    camera = new THREE.PerspectiveCamera(34, 1, 0.05, 100);
    followCam = createFollowCamera(camera,
        { height: savedCamHeight(), back: CAM_RIG_BACK });
    // A persisted height must colour the boot-time applyVolume too — the
    // stored shift lands there even though no fog exists yet.
    stageScene.setFogShift(followCam.distance() - CAM_RIG_DIST_DEFAULT);
    mapView = createMapView(scene, volume);
    mapView.setFloor(startFloor);   // segment-aware rooms from the first build
    danmakuView = createDanmakuView(scene, THREE, {
        capacity: world.danmaku.capacity,
        camera: camera,  // the streak layer billboards against the live camera
        projectileVisualReady: bullet => !!skillVFX && skillVFX.projectileVisualReady(bullet)
    });
    enemyTelegraphs = createEnemyTelegraphs(scene, THREE);
    damageTextLayer = createDamageTextLayer(stage, THREE);
    healthBars = createHealthBars(stage, THREE);
    battleIndicators = createBattleIndicators(stage, THREE);
    skillVFX = createSkillVFX(scene, THREE, { maxEffects: 28, camera: camera });
    // The original's enemy attack effects (slash/blow/bite/claw by grade),
    // keyed by the enemy skill's action name. Loaded once; a missing map only
    // means enemy swings play without their burst.
    loadEnemyAttacks().then(map => { enemyAttacks = map; })
        .catch(error => console.warn("Enemy attack effects:", error));
    dropTextures = loadDropTextures();

    // Initialize BGM system
    bgm = initBGM();
    setBGMChapter(volume);   // per-volume track table (游玩说明 §七)
    initOverlays();
    roomLoadUI = createRoomLoading(stage, {
        onRetry() { if (pendingRoomLoad) attemptRoomLoad(pendingRoomLoad, true); },
        onStorage: openStorage
    });

    // The real HUD + touch controls (spec/01 §4). toggleMenu is hoisted, so
    // the pause button can be wired before its definition reads.
    hud = createHud({ input: input, onMenu: toggleMenu, onInteract: handleInteract, parent: stage,
        isShrineVisible: function () { return !!currentFloorShrine(); },
        menuParent: document.querySelector(".save-status-actions"), floorsPerVolume: VOLUME_FLOORS });
    createLandscapeGuard({ onChange(blocked) {
        landscapeBlocked = blocked;
        hud.clearInput();
        hud.els.pause.disabled = blocked;
        if (blocked && usPlayer) { usPlayer.pause(); }
        syncWorldFrozen();
    } });

    resize();
    window.addEventListener("resize", resize);
    // Last-chance autosave: a reload or tab close fires pagehide after the
    // last frame, capturing HP the 5-second cadence might still be holding.
    window.addEventListener("pagehide", function () {
        saveRun();
        pauseRoomLoad('页面已离开，房间装配已暂停。返回后请重试。');
        pauseDescent("页面已离开，加载已暂停。返回后请重试下潜。");
    });
    document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
            input.clear();
            pauseRoomLoad('页面已切到后台，房间装配已暂停。回到本页后请重试。');
            pauseDescent("页面已切到后台，加载已暂停。回到本页后请重试。");
        }
    });
    // SE unlock (core/audio.js): the browser gates audio behind a gesture,
    // and the first gesture the game sees is the roster card click. Both
    // pointerdown and click arm it — element.click() (drivers, harnesses)
    // fires only a click event with no pointerdown before it — and keydown
    // arms it too: a keyboard-only player never touches the mouse, and a key
    // press is as much a user activation as a click. One gesture arms every
    // later cue; the context resumes itself in audio.se()'s context() and a
    // missed resume is swallowed, never thrown.
    function armAudio() {
        audio.unlock();
        window.removeEventListener("pointerdown", armAudio, true);
        window.removeEventListener("click", armAudio, true);
        window.removeEventListener("keydown", armAudio, true);
    }
    window.addEventListener("pointerdown", armAudio, { capture: true });
    window.addEventListener("click", armAudio, { capture: true });
    window.addEventListener("keydown", armAudio, { capture: true });

    const motion = createMotionSampler();
    clock = createClock({
        step: 1 / 60,
        update: function (dt) {
            motion.beginStep(world);
            updateFollowCamera(dt, 1, motion);
            projectAim();
            world.update(dt);
            consumeEvents();
            tickTutorial(dt);
            if (hud) {
                hud.pump();     // release touch-latched presses the step saw
            }
            updateMenuKey();
            updateInteractKey();
            updateShopKeys();
            updateUltimate(dt);
            tickRunSave(dt);
        },
        render: function (alpha, _steps, dt) {
            syncViews(dt, motion, alpha);
            renderFrame();
        }
    });
    clock.start();

    // T22k 键鼠联动: the aim channel. The pointer arrives as NDC over the
    // stage canvas (input.js); three.js is needed for the inverse projection,
    // so this is the only place NDC becomes world ground coordinates. The rig
    // lens is ORTHOGRAPHIC (view/camera.js converts the instance in place), so
    // the pixel ray is NOT camera-position→unproject — that is the pinhole
    // model, and under ortho it pointed the swing ~67° off the cursor.
    // Instead unproject the NDC at both depth ends: the near/far pair spans
    // the pixel ray for EITHER lens (perspective: the segment passes through
    // the camera center; ortho: it is parallel to the forward vector), and
    // intersecting the projectile plane maps visible aim to world x/y. Hoisted as a
    // function declaration so both the clock's update and
    // window.kirafanRL.step() (headless drivers) run it — a stale world.aim
    // would aim every swing at an old cursor.
    const aimVec = new THREE.Vector3();
    const aimFar = new THREE.Vector3();
    const aimOrigin = new THREE.Vector3();
    function projectAim() {
        const pointer = input.state.pointer;
        const stick = input.state.aimStick;
        if ((!pointer.active && !stick.active) || !camera || !world) {
            world.aim = null;
            return;
        }
        camera.updateMatrixWorld();
        let x = pointer.x, y = pointer.y;
        if (stick.active) {
            const p = world.player, rect = renderer.domElement.getBoundingClientRect();
            if (!p || !rect.width || !rect.height) { world.aim = null; return; }
            aimOrigin.set(p.x, COMBAT_HEIGHT, p.y).project(camera);
            // Same CSS-pixel direction at every aspect ratio and camera height.
            x = aimOrigin.x + stick.x * 160 / rect.width;
            y = aimOrigin.y - stick.y * 160 / rect.height;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) { world.aim = null; return; }
        aimVec.set(x, y, -1).unproject(camera);
        aimFar.set(x, y, 1).unproject(camera);
        const dx = aimFar.x - aimVec.x;
        const dy = aimFar.y - aimVec.y;
        const dz = aimFar.z - aimVec.z;
        if (Math.abs(dy) < 1e-6) {
            world.aim = null;
            return;
        }
        const t = (COMBAT_HEIGHT - aimVec.y) / dy;
        if (t < 0 || t > 1) {
            world.aim = null;
            return;
        }
        world.aim = {
            x: aimVec.x + dx * t,
            y: aimVec.z + dz * t
        };
    }

    // Headless handle: a backgrounded tab never runs rAF, so checks drive
    // the world synchronously through step() instead (same as models.js).
    window.kirafanRL = {
        get renderer() { return renderer; },
        get scene() { return scene; },
        get camera() { return camera; },
        // The follow rig (not the THREE camera): exposes shake/height state
        // for headless regressions without widening view internals.
        get cameraRig() { return followCam; },
        get world() { return world; },
        get input() { return input; },
        get minimap() { return minimap; },
        get mapview() { return mapView; },
        get volume() { return volume; },
        get volumeBiome() { return volumeConfig(volume).biome; },
        get quality() { return quality; },
        // plan 阶段 8: read-only first-run-tutorial handle for headless
        // drivers (the walkthrough marks it via meta.markTutorialSeen).
        get tutorialSeen() { return !!(meta && meta.seenTutorial()); },
        get floorBiome() { return volumeConfig(volume, world ? world.floor : 1).biome; },
        get floorLabel() { return floorBox ? floorBox.textContent : ""; },
        get views() { return { player: playerView, enemies: enemyViews, danmaku: danmakuView,
            telegraphs: enemyTelegraphs }; },
        // Same attach path the "summon" event takes, exposed so headless
        // fixtures can give a mid-test spawned unit its real view.
        syncEnemyViews: ensureEnemyViews,
        get dropTexturesReady() { return !!dropTextures; },
        // Enemy models still in flight. A driver that samples renderer.info
        // has to wait for this to reach 0, or it is measuring a half-built room.
        get pending() { return pendingViews.size; },
        get roomLoading() { return pendingRoomLoad ? { roomId: pendingRoomLoad.room.id, phase: pendingRoomLoad.phase } : null; },
        get tables() { return tables ? Object.keys(tables) : null; },
        // T22m free animation/face surface — the observation room's chips,
        // without the UI. Drives the same actor.play/face calls models.js
        // makes, so what a driver stages is exactly what a player would see.
        actor: function () {
            if (!playerView || !playerView.actor) {
                return null;
            }
            // Keep metadata live: custom actions/faces can be registered after
            // a caller obtains this handle, so snapshots would silently go
            // stale while play() still succeeds.
            const target = playerView.actor;
            return {
                get actionNames() { return target.actionNames; },
                get faceNames() { return target.faceNames; },
                get current() { return target.action; },
                play: function (name, opts) {
                    return target.play(name, opts);
                },
                face: function (index) { return target.face(index); },
                faceAuto: function () { return target.faceAuto(); },
                registerFace: function (name, state) {
                    return target.registerFace(name, state);
                },
                removeFace: function (name) {
                    return target.removeFace(name);
                },
                registerAction: function (name, clip, options) {
                    return target.registerAction(name, clip, options);
                },
                removeAction: function (name) {
                    return target.removeAction(name);
                },
                loadActions: function (url, options) {
                    return target.loadActions(url, options);
                },
                object: target.object
            };
        },
        get ultimate() { return { loading: usLoading, stage: usPlayer, actor: usActor }; },
        get effects() { return skillVFX; },
        skipUltimate: skipUltimate,
        renderOnce: renderFrame,
        step: function (dt) {
            updateFollowCamera(dt);
            projectAim();
            world.update(dt);
            consumeEvents();
            if (hud) {
                hud.pump();
            }
            updateMenuKey();
            updateInteractKey();
            updateShopKeys();
            updateUltimate(dt);
            tickRunSave(dt);
            syncViews(dt);
            renderFrame();
        },
        // Progression surface for drivers (spec/04 §10): same code paths the
        // keyboard takes, so a check exercises what a player exercises.
        interact: function () { handleInteract(); },
        toggleMenu: function () { toggleMenu(); },
        openShop: function () { openShop(); },
        closeShop: function () { closeShop(); },
        buyShopItem: function (index) { return world.buyShopItem(index, undefined, persistRoomEvent); },
        restHeal: function () { return world.restHeal(); },
        // T22g: the interactable surface, same code paths the E key takes.
        openChest: function () { return world.openChest(); },
        useAltar: function () { return openAltar(); },
        talkNpc: function () { return world.talkNpc(); },
        get npcCard() { return npcCard; },
        get interactPending() { return pendingInteractViews.size; }
    };
    usSkipButton = document.createElement("button");
    usSkipButton.type = "button";
    usSkipButton.className = "rl-ultimate-skip";
    usSkipButton.textContent = "跳过";
    usSkipButton.hidden = true;
    usSkipButton.addEventListener("click", skipUltimate);
    stage.appendChild(usSkipButton);
}

function renderFrame() {
    renderStamp++;
    stage.classList.toggle("ultimate-playing", !!usPlayer);
    if (usPlayer) { usPlayer.render(renderer); }
    else { stageScene.render(camera, playerView && playerView.actor.object); }
}

// One place both the rAF render and the headless step go through, so what a
// check sees is what a player sees.
// The follow rig advances BEFORE the aim projection, not in syncViews:
// projectAim unprojects the cursor through the camera and the shot fires off
// world.aim inside the same world.update — with the advance left in syncViews
// (which runs after world.update), every aim read last frame's camera. While
// the player walks, the rig trails the frame behind, and the bullet visibly
// missed the cursor's screen spot by that frame delta along the view ray
// (2026-09-16 实机反馈：弹丸特效方向与鼠标指向有偏差). Exactly one advance
// per frame: the clock update/k.step call this before projectAim, syncViews
// no longer does.
function updateFollowCamera(dt, alpha, motionSampler) {
    const p = world && world.player;
    if (!p) { return; }
    const position = unit => motionSampler
        ? motionSampler.position(unit, world.frozen || world.hitStop > 0 ? 1 : alpha) : unit;
    const at = position(p);
    followCam.update(at.x, at.y, world.frozen ? 0 : dt);
}

function syncViews(dt, motion, alpha) {
    if (!world) {
        return;
    }
    const poseDt = world.frozen || world.hitStop > 0 ? 0 : dt;
    const effectDt = world.frozen ? 0 : dt;
    const now = world.time * 1000;
    const position = unit => motion
        ? motion.position(unit, world.frozen || world.hitStop > 0 ? 1 : alpha) : unit;
    const p = world.player;
    // The camera rig already advanced this frame (updateFollowCamera before
    // projectAim); views sync against the camera the aim just used.
    setCharacterPitch(followCam.pitch());
    if (playerView) {
        playerView.sync(poseDt, position(p));
    }
    updateEquipmentAppearance();
    enemyViews.forEach(function (view) {
        view.sync(view.unit.dead ? dt : poseDt, now, position(view.unit));
    });
    enemyTelegraphs.sync(world);
    if (skillVFX) {
        skillVFX.syncProjectiles(world.danmaku, position);
        skillVFX.update(effectDt);
    }
    danmakuView.sync(world.danmaku, position);

    // Emit trail particles for player bullets (Task 4.4). The pool's stable
    // walk is forEach (all() does not exist); the world is 2D so the bullet's
    // y is the VFX layer's z.
    if (skillVFX && world.danmaku) {
        world.danmaku.forEach(function (b) {
            if (b.side === "player" && b.life > 0 && b.delay <= 0
                    && !skillVFX.projectileVisualReady(b)
                    && Math.random() < 1 - Math.exp(-quality.trailRate * poseDt)) {
                const at = position(b);
                skillVFX.emitTrail(at.x, at.y, b.element);
            }
        });
    }

    const floorShrine = currentFloorShrine();
    if (floorShrine) { floorShrine.setState(world.floorExitReady, world.canCommuneAtShrine); }
    mapView.update(effectDt);
    syncFloorShrineMarker(floorShrine);
    if (altarView) {
        altarView.update(effectDt);
    }
    if (npcView) {
        npcView.update(effectDt);
    }
    if (damageTextLayer) { damageTextLayer.update(effectDt, position); }
    if (healthBars) { healthBars.update(world, camera, renderer, effectDt, position); }
    if (battleIndicators) { battleIndicators.update(world, camera, renderer, position); }
    minimap.update(world, position);
    // Drop markers (T22j): the authored icons, billboarded — paper-stack
    // discipline says props face the camera, never spin on Y.
    dropViews.forEach(function (sprite) {
        sprite.position.y = 0.55 + Math.sin(world.time * 3) * 0.08;
        for (const icon of sprite.children) {
            const image = icon.material && icon.material.map && icon.material.map.image;
            icon.visible = !!(image && image.width && image.complete !== false);
        }
    });
    for (let i = coinFlys.length - 1; i >= 0; i--) {
        const fly = coinFlys[i];
        fly.age += dt;
        if (fly.age >= fly.life) {
            scene.remove(fly.sprite);
            fly.sprite.material.dispose();
            coinFlys.splice(i, 1);
            continue;
        }
        const t = fly.age / fly.life;
        fly.sprite.position.y = 0.6 + t * 1.4;
        fly.sprite.material.opacity = 1 - t * t;
        const dxCam = camera.position.x - fly.sprite.position.x;
        const dzCam = camera.position.z - fly.sprite.position.z;
        fly.sprite.position.x += dxCam * dt * 0.5;
        fly.sprite.position.z += dzCam * dt * 0.5;
    }
    updateHint(dt);
    updateStatus();
    if (hud) {
        hud.update(world);
    }
}


function resize() {
    const rect = stage.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}

// --- events (the world narrates; this file dresses it) -------------------------

function unitName(unit) {
    if (!unit) {
        return "?";
    }
    return unit.nameZh || unit.name || (unit.kind === "player" ? "我方" : "敌人");
}

let lastSeenSwing = 0;
function consumeEvents() {
    // A quick click's latch stays armed until the world has actually swung
    // with it (swingId changed this update) — a click landing mid-swing then
    // queues the next one instead of being swallowed (input.js).
    const player = world && world.player;
    const seen = !!player && player.swingId !== lastSeenSwing;
    if (seen) { lastSeenSwing = player.swingId; }
    input.endStep(seen);
    const events = world.drainEvents();
    // A reload during a cinematic must retain the completed fight and its loot.
    if (events.some(event => event.type === 'roomClear')) { saveRun(); }
    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (event.type === "hit") { settleTerminalHit(event); }
        if ((usLoading || usPlayer) && (event.type === "hit"
                || event.type === "roomClear" || event.type === "floorClear")) {
            usDeferredEvents.push(event);
            continue;
        }
        switch (event.type) {
        case "door":
            // T21d: the world stages the room swap DOOR_FADE_OUT seconds
            // ahead; cover the stage in the current segment's fog colour so
            // the cut hides under a continuous tone, and cue the page fade.
            // The cover transition (theme.css, 0.15s ease-in) is strictly
            // shorter than the world's wait, so the screen is fully opaque
            // before the new room first renders.
            coverRoom(false);
            audio.se("page_fade", { volume: 0.5 });
            break;
        case "room":
            cancelRoomLoad();
            if (usLoading || usPlayer) { stopUltimate(true); }
            if (damageTextLayer) { damageTextLayer.clear(); }
            if (healthBars) { healthBars.clear(); }
            if (skillVFX) { skillVFX.clear(); }
            roomGeneration += 1;
            clearEnemyViews();
            clearDropViews();
            clearInteractViews();
            if (activeDecision) { activeDecision.close(); }
            rebuildRoom(event.room);
            recordEncounters();
            sweepAchievements();
            minimap.setCurrent(event.to);
            // battle stance on first entry of a fight room (anchor table,
            // master plan §2.3; battle_in plays once, non-looping)
            if (event.firstVisit && playerView
                && !world.roomState.get(event.room.id)?.cleared
                && (event.room.type === "battle" || event.room.type === "boss")) {
                playerView.play("battle_in", { loop: false, fade: 0.12 });
            }
            // BGM switching based on room type. The boss room only gets the
            // boss track on the FINAL floor; floors 1-19 house a 層守衛
            // (an elite, not the boss — world.js spawnRoomEnemies), which is
            // a battle like any other.
            if (bgm && event.firstVisit) {
                if (event.room.type === "boss") {
                    if (world.floor >= VOLUME_FLOORS) {
                        playBGM("boss", { fadeIn: 1000 });
                    } else {
                        playBGM("battle", { fadeIn: 800 });
                    }
                } else if (event.room.type === "battle") {
                    playBGM("battle", { fadeIn: 800 });
                } else {
                    playBGM("explore", { fadeIn: 1000 });
                }
            }
            // Boss pre-battle (T12): the finale volume plays its longer
            // ハイプリス dialogue instead of the shared v5_boss_pre. A guard
            // floor gets no scene — just the flag, matching the "bossRoom"
            // beat the world already narrated.
            if (event.firstVisit && event.room.type === "boss") {
                if (world.floor >= VOLUME_FLOORS) {
                    queueDialogue(volume === 5 ? "finale_pre" : "v" + volume + "_boss_pre");
                }
            }
            // Boss opening voice (spec/05 §6 rule 5): a room that fields a
            // voiced unit announces it on first entry. Story bosses carry no
            // sheet and stay silent, matching the original's warning gate.
            if (event.firstVisit) {
                const voiced = world.enemies.find(function (e) {
                    return !e.dead && e.voiceCueSheet;
                });
                if (voiced) {
                    playBossVoice(voiced);
                }
            }
            // The room-load owner reveals only after map and actors are ready.
            break;
        case "bossRoom":
            // 層守衛 vs the real boss: same room type, different headline.
            if (world.floor >= VOLUME_FLOORS) {
                beat("⚑ 首领战", 2.4);
            } else {
                beat("⚑ 层守卫挡住了去路", 2.4);
            }
            break;
        // Reinforcements arrive mid-room, so the view list has to grow without
        // being rebuilt -- ensureEnemyViews only attaches what is missing.
        case "summon":
            ensureEnemyViews();
            beat("↯ " + unitName(event.unit) + " 召来援军 ×" + event.count);
            break;
        case "bossPhase":
            beat("◆ " + unitName(event.unit) + " 第 " + event.phase + " 阶段");
            break;
        case "telegraph":
            if (event.unit.kind === "boss" || event.unit.elite) {
                beat("! " + (event.label || event.skill.name || event.pattern)
                    + (event.counter ? " · " + event.counter : ""),
                    event.duration);
            }
            break;
        case "enemyRecovery":
            if (event.unit.kind === "boss" || event.unit.elite) {
                beat("破绽 · " + event.duration.toFixed(1) + " 秒，趁机进攻", event.duration);
            }
            break;
        case "skill":
            // A self reset has already reported what changed (or why nothing
            // changed). Do not overwrite that result with the generic cast toast.
            if (!(event.skill.statResets || []).some(reset => [0, 3, 4].includes(reset.target))
                    && !(event.skill.nextCriticals || []).length) {
                beat((event.healBlocked ? "治疗被封锁 · " : "✦ ")
                    + (event.skill.name || "技能") + " · 技能 " + (event.slot + 1));
            }
            // Emit skill cast particles (world is 2D: y is the ground plane's z)
            if (skillVFX && world.player) {
                skillVFX.emitSkillCast(event.unit, event.skill);
            }
            audio.se("magic", { volume: 0.6 });
            break;
        case "swing":
            audio.se("whoosh", { volume: 0.5 });
            break;
        case "swingActive":
            // Same fixed-step boundary as the actual blade, including whiffs.
            if (skillVFX && event.unit) {
                skillVFX.emitSlash(event.unit);
            }
            break;
        case "heal":
            if (event.amount > 0) {
                beat("＋" + event.amount + " HP");
                if (damageTextLayer) { damageTextLayer.show({ damage: event.amount,
                    unit: event.unit, heal: true, camera: camera, renderer: renderer }); }
                if (skillVFX && event.unit && !event.skill) { skillVFX.emitHeal(event.unit.x, event.unit.y); }
            }
            break;
        case "skillCard": {
            const action = { placed: "已放置", refreshed: "次数已刷新", triggered: "触发" }[event.action];
            if (action) beat(event.name + action + " · 剩余" + event.remaining + "次", 1.6);
            break;
        }
        case "playerStatus": {
            const words = { applied: "治疗封锁", protected: "获得治疗封锁免疫",
                immune: "治疗封锁已免疫", cleared: "治疗封锁已解除", healBlocked: "治疗被封锁" };
            if (words[event.action]) {
                beat(words[event.action] + (event.remaining ? " · " + Math.ceil(event.remaining) + "秒" : ""), 1.6);
            }
            break;
        }
        case "nextAtkUp":
            // T22n: a kind-11 次回攻撃威力UP cast landed on the player.
            beat("✧ 次回攻击威力 +" + Math.round(event.pct * 100) + "%", 1.6);
            break;
        case "nextCritical":
            if (event.action !== "used") {
                beat("✧ " + (event.action === "refreshed" ? "必暴已刷新（不叠次数）" : "下次伤害行动必定暴击")
                    + " · 出手消耗，技能卡除外", 2);
            }
            break;
        case "statReset": {
            const names = { atk: "物攻", mgc: "魔攻", def: "物防", mdef: "魔防",
                spd: event.unit.kind === "player" ? "技能恢复速度" : "行动速度", luck: "幸运" };
            const direction = { down: "降低", up: "提高", all: "正负变化" }[event.mode];
            const scope = (event.changed.length ? event.changed : event.stats).map(key => names[key]).join("、");
            beat("◆ " + unitName(event.unit) + (event.changed.length ? " 已解除" : " 无可解除的")
                + scope + direction + "效果", 1.6);
            break;
        }
        case "statChange":
            beat("◆ " + unitName(event.unit) + " 能力变化", 1.6);
            break;
        case "slow":
            // T25 kind-4: the cast's bullet landed and slowed the target.
            beat("❄ " + unitName(event.unit) + " 行动变缓 -" + Math.round(event.pct * 100) + "%", 1.6);
            break;
        case "resist": {
            // T25 kind-8: element-resist entry refreshed on a target.
            const ELEMENT_ZH = ["火", "水", "土", "风", "月", "阳"];
            beat("◆ " + (ELEMENT_ZH[event.element] || "?") + "耐性 "
                + (event.pct > 0 ? "+" : "") + Math.round(event.pct * 100) + "%", 1.6);
            break;
        }
        case "survival":
            // 踏みとどまり (spec/04 §4.2 type 11): the fatal hit was survived
            // with a full heal; the row's own wording is 「1回だけHPが1残り」.
            beat("◈ 濒死反击！", 1.6);
            break;
        case "ultimate":
            // 阶段 6: trigger とっておき performance if ready
            if (event.ready && !usPlayer && !usLoading && world.player) {
                playUltimate();
            } else if (!event.ready) {
                beat("必杀能量不足");
            }
            break;
        case "hit":
            enemyViews.forEach(function (view) {
                if (view.unit === event.target) { view.hit(); }
            });
            // Show damage number
            if (damageTextLayer && event.damage > 0) {
                const target = event.target;
                damageTextLayer.show({
                    damage: event.damage,
                    unit: target,
                    x: target.x,
                    y: target.y,
                    crit: event.crit || false,
                    hitFlag: event.hitFlag || 0,
                    element: event.attacker ? event.attacker.element : null,
                    side: event.attacker && event.attacker.kind === "player" ? "player" : "enemy",
                    camera: camera,
                    renderer: renderer
                });
            }
            // Snapshot the actual contact, not a target moved since the hit.
            if (skillVFX && event.target) {
                const impact = event.impact || event.target;
                skillVFX.emitHitImpact(
                    impact.x,
                    impact.y,
                    event.attacker ? event.attacker.element || 0 : 0,
                    event.crit || false
                );
                // The original's common death burst (ef_btl_common_dead):
                // every kill gets it at the kill point, scaled up for bosses
                // and elites — the readable "it died" beat that a vanishing
                // model alone never gave. 2026-09-18 原素材美术优化.
                if (event.died && event.target.kind !== "player") {
                    const big = event.target.kind === "boss" || event.target.elite;
                    skillVFX.emitNative("ef_btl_common_dead", impact.x, impact.y, {
                        kind: "impact", height: COMBAT_HEIGHT,
                        scale: big ? 1.6 : 1.0, duration: .5 });
                }
            }
            // Impact shake: taking a hit moves the camera harder than dealing
            // one, and a crit the player lands still lands a little.
            if (followCam) {
                if (event.target.kind === "player") {
                    followCam.shake(0.22, 0.3);
                } else if (event.crit) {
                    followCam.shake(0.1, 0.18);
                }
            }
            // 受击顿帧 + 受击音 (T21b): the freeze and the impact cue land on
            // the moments that have to read — taking a hit, the blade
            // connecting, a crit, a boss dying. Plain bullet ticks skip both:
            // a 10-shot ring would turn the freeze into a stutter and the cue
            // into a drum roll.
            const playerLanded = !!(event.attacker && event.attacker.kind === "player");
            const targetIsPlayer = event.target.kind === "player";
            world.applyHitStop(hitStopFor(event));
            if (targetIsPlayer) {
                audio.se("hit", { volume: 1.0 });
            } else if (playerLanded && event.crit) {
                audio.se("hit", { volume: 0.8 });
                // T22d 命中音分层: the crit gets its own accent on top of the
                // thud -- the dedicated crit cue (plan §2.3, replacing the
                // borrowed chime), quiet enough to read as "special" without
                // stepping on the next hit.
                audio.se("crit", { volume: 0.3 });
            } else if (playerLanded && !event.bullet) {
                // T22d 命中音分层: ばつぐん lands brighter, いまいち duller --
                // the element ring is audible before it is read. A resisted
                // hit (いまいち) also gets the guard cue: the original's
                // guard is a turn command (BattleCommandParser.cs isGuard →
                // GuardCoef) with no action equivalent, so its sound lands
                // on the closest moment -- affinity turning the blow aside
                // (plan §2.3).
                const hitVolume = event.hitFlag > 0 ? 0.95
                    : event.hitFlag < 0 ? 0.55 : 0.8;
                audio.se("hit", { volume: hitVolume });
                if (event.hitFlag < 0) {
                    audio.se("guard", { volume: 0.4 });
                }
            }
            break;
        case "roomClear":
            // The open-door moment is this beat, not the crossing: crossing
            // keeps its page_fade (T21d).
            audio.se("door", { volume: 0.6 });
            beat("✓ 房间清空——门开了", 2.0);
            // The strips stop reading as shut (T21d).
            mapView.setDoorsLocked(false);
            // Switch back to exploration BGM after clearing battle room
            if (bgm && world.currentRoom && world.currentRoom.type === "battle") {
                playBGM("explore", { fadeIn: 1000 });
            }
            break;
        case "drop":
            spawnDropMarker(event);
            break;
        case "lootOffer": {
            const item = event.drop.items[0];
            if (runPhase === "active" && !world.player.dead && !decisionOpen) {
                openEquipmentChoice(item, function () {
                    return world.takeDrop(event.drop, item, persistRoomEvent);
                });
            } else {
                event.drop.offered = false;
            }
            break;
        }
        case "pickup":
            audio.se("pickup", { volume: 0.5 });
            if (event.exhausted !== false) { removeDropMarker(event.drop); }
            if (skillVFX && world.player) {
                skillVFX.emitPickup(event.x, event.y);
            }
            beat("✦ 拾取装备 ×" + event.items.length, 2.0);
            saveRun();   // the equipped set is the death-settle payload — keep it fresh
            break;
        case "levelup":
            audio.se("levelup", { volume: 0.5 });
            if (skillVFX && event.unit) {
                skillVFX.emitHeal(event.unit.x, event.unit.y);
            }
            beat("▲ 升到 "
                + event.level + " 级" + (event.healed > 0 ? "（+" + event.healed + " HP）" : ""), 2.4);
            saveRun();   // level re-derives every stat on resume — pin it immediately
            break;
        case "shopOpen":
            saveRun();
            beat("♣ 商店开业了——按 E 进店", 3.0);
            if (bgm) {
                playBGM("shop", { fadeIn: 800 });
            }
            break;
        case "restOpen":
            beat("♨ 篝火燃着——" + (npcCard
                ? npcCard.characterZh || npcCard.name || "" + "在火旁——按 E 交谈"
                : "按 E 休息"), 3.0);
            if (bgm) {
                playBGM("rest", { fadeIn: 1200 });
            }
            break;
        case "rest":
            beat("♨ 回复了 " + event.healed + " HP", 2.4);
            if (skillVFX && event.unit) {
                skillVFX.emitHeal(event.unit.x, event.unit.y);
            }
            saveRun();   // a rest is a deliberate HP checkpoint
            break;
        case "npcTalk":
            saveRun();
            // T22g: the guest speaks (falls back to the player's own chatter
            // when their card has no rest node — queueDialogue skips unknowns).
            if (skillVFX && event.healed > 0) {
                skillVFX.emitHeal(event.x, event.y);
            }
            if (event.first) {
                beat(npcCard
                    ? "♨ 和 " + (npcCard.characterZh || npcCard.name) + " 聊了聊"
                    : "♨ 在篝火旁休息了", 2.4);
            }
            queueDialogue(npcDialogueNode());
            break;
        case "chestOpen":
            // T22g 宝箱: the view swaps the mimic's doors, the loot marker
            // lands through the normal "drop" event rollDrops just pushed.
            if (chestView) {
                chestView.open();
            }
            if (skillVFX) {
                skillVFX.emitPickup(event.x, event.y);
            }
            audio.se("chime", { volume: 0.7 });
            spawnCoinFly(event.x, event.y, 30);
            beat("✦ 宝箱打开了", 2.2);
            saveRun();
            break;
        case "barrelBreak":
            saveRun();
            // T22g 木桶: the view goes away; the line reports what fell out.
            for (let i = 0; i < barrelViews.length; i++) {
                if (barrelViews[i].barrel.x === event.x
                        && barrelViews[i].barrel.y === event.y) {
                    barrelViews[i].break();
                    barrelViews.splice(i, 1);
                    break;
                }
            }
            if (skillVFX) {
                skillVFX.emitBreak(event.x, event.y);
            }
            audio.se("hit", { volume: 0.6 });
            if (event.loot.kind === "coin") {
                spawnCoinFly(event.x, event.y, event.loot.amount);
                beat("✧ 木桶碎了——金币 +" + event.loot.amount, 2.0);
            } else if (event.loot.kind === "heal") {
                beat("✧ 木桶碎了——回复 +" + event.loot.amount + " HP", 2.0);
                if (skillVFX) {
                    skillVFX.emitHeal(event.x, event.y);
                }
            } else {
                beat("✧ 木桶碎了——里面什么都没有", 2.0);
            }
            break;
        case "altarUse":
            saveRun();
            // T22g 祭坛: the event point's blessing.
            if (skillVFX) {
                skillVFX.emitBuff(event.x, event.y);
            }
            audio.se("magic", { volume: 0.6 });
            if (event.outcome.kind === "coin") {
                spawnCoinFly(event.x, event.y, event.outcome.amount);
                beat("☆ 星之祭坛——金币 +" + event.outcome.amount, 2.6);
            } else if (event.outcome.kind === "heal") {
                beat("☆ 星之祭坛——回复 +" + event.outcome.amount + " HP", 2.6);
                if (skillVFX) {
                    skillVFX.emitHeal(event.x, event.y);
                }
            } else {
                beat('☆ ' + event.label + ' · ' + equipmentName(event.item, weaponsData), 3.0);
            }
            break;
        case "purchase":
            beat("♣ 购入成功（" + event.price + " 金币）", 2.0);
            renderShopItems();
            saveRun();   // coins spent must not come back with a reload
            break;
        case "supply":
            beat(event.item ? event.label + ' · ' + equipmentName(event.item, weaponsData)
                : event.choice === "heal" ? "生命 +" + event.amount : "必杀槽 +" + event.amount, 2.4);
            saveRun();
            break;
        case "coinGain":
            // T22j: kill coins pop out of the dead enemy as sprite receipts.
            spawnCoinFly(event.x, event.y, event.amount);
            break;
        case "stun":
            // スタンゲージ filled (spec/04 §11): the enemy is out of the fight.
            if (skillVFX) {
                skillVFX.emitStun(event.x, event.y);
            }
            beat("☆ 眩晕 " + event.duration + " 秒", 1.6);
            break;
        case "floorClear":
            if (runPhase !== "active" || world.player.dead) { break; }
            world.danmaku.clear(); // after this tick's damage, not during collision iteration
            if (world.floor >= VOLUME_FLOORS) {
                beat('✓ 首领已击破——大圣堂雕像苏醒了，靠近祈愿可完成本卷', 6.0);
                if (playerView) {
                    playerView.play("win_lp_0", { loop: false, fade: 0.15 });
                }
            } else {
                beat('✓ 守卫已击破——大圣堂雕像苏醒了，靠近祈愿可继续旅程', 6.0);
            }
            break;
        case "dodge":
            // The player's own sidestep (world pushes it from idle/move on
            // the dodge input); enemies never dodge, so no unit filter.
            audio.se("dodge", { volume: 0.6 });
            break;
        case "enemySkill":
            // The original's enemy attack burst (ef_btl_dmg_enemy_attack_*),
            // chosen by the skill's action plan: kind (slash/blow/bite/claw)
            // and grade. Played at the attacker, aimed along the swing.
            if (skillVFX && enemyAttacks && event.skill) {
                const row = enemyAttacks.skills[event.skill.action];
                if (row) {
                    skillVFX.emitNative(row.effect, event.unit.x, event.unit.y, {
                        kind: "impact", enemyAttack: true, height: COMBAT_HEIGHT,
                        angle: event.unit.facing, scale: 1.1, duration: .5 });
                }
            }
            break;
        default:
            break;      // swing/enemySkill/dash/playerShot: view-side already
        }
    }
    maybeShowRunResult();
}

function charNameById(charaId) {
    const row = tables && tables.stats ? tables.stats.card(charaId) : null;
    return row ? (row.characterZh || row.name || String(charaId)) : String(charaId);
}

// --- 局内续档 (run persistence across reload; 阶段 5's deferred item) -----------
//
// The snapshot holds what a reload cannot rebuild from seeds: the descent
// position and the character's progress (level/exp/HP/gauge), the equipped
// set, coins, stacking counters, completed rooms and unclaimed loot. Layouts
// regenerate from the seed; unfinished enemy/projectile state is not saved.
//
// readRunSnapshot() runs at module scope (it decides the boot volume when the
// URL stays silent), so it must only touch literals and VOLUME_FLOORS — both
// of which are initialized before it is called.
function readRunSnapshot() {
    let snap = null;
    try {
        snap = loadSlot("run");
    } catch (err) {
        return null;
    }
    // T24 (spec/07 §6): the whole envelope is validated in runschema.js —
    // finite numbers, ranges, equipment slots, duplicate equipment, seed and
    // generator version. Legacy v1 saves migrate to a deterministic uint32
    // seed; unknown future versions are refused rather than guessed at.
    return parseRunSnapshot(snap, VOLUME_FLOORS);
}

function runPayload() {
    return buildRunPayload({
        schemaVersion: RUN_SCHEMA_VERSION,
        seed: RUN_SEED,
        volume: volume,
        floor: world.floor,
        cardId: world.player.card ? world.player.card.id : 0,
        level: world.player.level,
        exp: world.player.exp || 0,
        hp: Math.max(1, Math.round(world.player.hp)),
        gauge: world.player.skills ? world.player.skills.gauge : 0,
        coin: world.coin || 0,
        stackHits: world.player.stackHits || 0,
        stackKills: world.player.stackKills || 0,
        equipment: (world.player.equipment || []).slice(),
        roomClaims: world.getRoomClaims()
    });
}

function saveRun() {
    if (runPhase !== "active" || !world || !world.player || world.player.dead) { return; }
    const payload = runPayload();
    if (payload) {
        writeSlot("run", payload, { defer: true, runId: activeRunId });
    }
}

function clearRun() {
    clearSlot("run", { defer: true, ...(activeRunId ? { runId: activeRunId } : {}) });
}

// Autosave cadence: every 5 seconds of GAME time, not wall time, so a
// backgrounded tab (rAF never ticks) and a headless gate driving step()
// both hit the save exactly the way real play does.
let runSaveClock = 0;
function tickRunSave(dt) {
    runSaveClock += dt;
    if (runSaveClock >= 5) {
        runSaveClock = 0;
        saveRun();
    }
}

function syncWorldFrozen() {
    if (!world) { return; }
    world.frozen = runPhase !== "active" || menuOpen || shopOpen || codexOpen || decisionOpen
        || achvOpen || howtoOpen
        || dialogueBusy || dialogueQueue.length > 0 || usLoading || !!usPlayer || storageConflict || landscapeBlocked
        || !!pendingRoomLoad;
}

// Defeat is terminal immediately. Boss defeat is a loot checkpoint; victory
// is accepted only when the player explicitly leaves the cleared final room.
const narratedBossDefeats = new WeakSet();
function settleTerminalHit(event) {
    if (!event.died) { return; }
    if (event.target.kind === "boss" && world.floor >= VOLUME_FLOORS
            && runPhase === 'active' && !world.player.dead && !narratedBossDefeats.has(event.target)) {
        narratedBossDefeats.add(event.target);
        saveRun();
        world.applyHitStop(0.14);
        if (followCam) { followCam.shake(0.4, 0.6); }
        beat("★ " + unitName(event.target) + " 击破", 2.4);
        if (bgm) { playBGM("victory", { fadeIn: 500 }); }
        queueDialogue("v" + volume + "_boss_post");
    } else if (event.target.kind === "player" && finishRun("defeat")) {
        stopUltimate(true);
        audio.se("death", { volume: 0.9 });
        queueDialogue("exit_" + playerDialogueName());
        if (bgm) { stopBGM({ fadeOut: 2000 }); }
    }
}

// Lock out every save path before committing the checkpoint, reward and receipt.
// A repeated hit event and an async dialogue/ultimate completion see the same state.
function finishRun(outcome) {
    if (runPhase !== "active") { return false; }
    runPhase = outcome;
    cancelRoomLoad();
    if (activeDecision) { activeDecision.close(); }
    input.detach();
    menuOpen = false;
    shopOpen = false;
    if (menuPanel) { menuPanel.classList.add("hidden"); }
    if (shopPanel) { shopPanel.close(); shopPanel.classList.add("hidden"); }
    syncWorldFrozen();
    const p = world.player;
    const items = p && p.equipment ? p.equipment.slice() : [];
    const facts = { outcome, volume, floor: world.floor, cardId: p.card ? p.card.id : 0,
        level: p.level, coin: world.coin || 0, items };
    const settled = meta ? meta.settleRun(activeRunId, facts) : { receipt: null, saved: false };
    // Volume/page/gem achievements land with the terminal commit. They are NOT
    // swept here: the terminal gate (rl_terminal_browser.py) counts storage
    // commits in the victory window and an extra write would break its
    // single-transaction contract. The sweep runs at the next run start.
    const receipt = settled.receipt || { ...facts, runId: activeRunId, equipmentCount: items.length,
        gems: 0, newPages: [], pages: meta ? meta.progression.pages.length : 0 };
    if (outcome === "defeat") {
        beat("✖ 力竭——这一页先折起来", 4.0);
        beat("◇ 装备 " + items.length + " 件结算带回 → 星彩石 +" + receipt.gems
            + (settled.saved ? "（已保存）" : "（尚未保存）"), 8.0);
    } else if (receipt.newPages.length) {
        beat("◇ 残页图鉴 +" + receipt.newPages.length + " 页", 5.0);
    }
    if (outcome === "victory" && playerView) {
        playerView.play("win_lp_0", { loop: false, fade: 0.15 });
    }
    runResult = resultSummary(receipt);
    return true;
}

function resultSummary(receipt) {
    return { ...receipt, volumeName: VOLUME_NAMES[receipt.volume], characterName: charNameById(receipt.cardId),
        cardArt: new URL("../../asset/img/rl/card/" + receipt.cardId + ".webp", import.meta.url).href,
        gemsEarned: receipt.gems };
}

function maybeShowRunResult() {
    if (!runResult || dialogueBusy || dialogueQueue.length || usLoading || usPlayer) { return; }
    const summary = runResult;
    runResult = null;
    showRunResult(summary, {
        state: function () { return resultState(summary.runId); },
        subscribe: subscribeStorage, onRetry: retryStorage, onStorage: openStorage,
        onRestart: function () { return restartRun(summary.volume, summary.runId); },
        onNextVolume: summary.outcome === "victory" && summary.volume < 5
            ? function () { return restartRun(summary.volume + 1, summary.runId); } : null
    });
}

function restartRun(nextVolume, resultId) {
    if (runPhase === "abandoned") { return false; }
    if (resultId) {
        const confirmed = acknowledgeResult(resultId);
        if (!confirmed.ok) { return confirmed; }
    }
    cancelDescent();
    cancelRoomLoad();
    runPhase = "abandoned";
    stopUltimate(true);
    if (!resultId) { clearRun(); }
    input.detach();
    syncWorldFrozen();
    const url = new URL(window.location.href);
    url.searchParams.set("volume", String(nextVolume));
    url.searchParams.delete("floor");
    window.location.assign(url.href);
    return true;
}

// --- the 20-layer descent (阶段 5; spec/02 §3, spec/04 §5) -------------------------

// Reward order stays in meta.js; presentation only names already-committed pages.
function workZhFor(pageId, fallback) {
    const card = cards.byId(pageId);
    return card && card.titleZh ? card.titleZh : fallback;
}

function ownsDescent(tx) {
    return pendingDescent === tx && runPhase === "loading" && activeRunId === tx.runId
        && world.player === tx.player && !tx.player.dead;
}

function releaseDescentCandidate(tx) {
    if (tx.candidate && mapView.group !== tx.candidate.group) {
        tx.candidate.dispose(); tx.candidate = null;
    }
}

function pauseDescent(message) {
    const tx = pendingDescent;
    if (!tx) { return; }
    tx.attempt += 1; tx.busy = false;
    clearTimeout(tx.timer);
    releaseDescentCandidate(tx);
    tx.ui.update({ busy: false, phase: "failed", committed: !!tx.committed, message });
    input.clear(); syncWorldFrozen();
}

function cancelDescent() {
    const tx = pendingDescent;
    if (!tx) { return; }
    pendingDescent = null; tx.attempt += 1;
    clearTimeout(tx.timer);
    releaseDescentCandidate(tx);
    tx.ui.close();
    mapView.cancelBuild();
}

function leaveDescent(tx) {
    if (!ownsDescent(tx)) { return; }
    if (!checkStorageChanges() || storageState().status !== "saved") {
        pauseDescent("请先在备份窗口导出本页进度或恢复保存，再返回选角。续档没有被清除。");
        return;
    }
    cancelDescent();
    runPhase = "abandoned"; input.detach(); syncWorldFrozen();
    const url = new URL(window.location.href);
    for (const key of ["volume", "floor", "seed"]) { url.searchParams.delete(key); }
    window.location.assign(url.href);     // unlike restartRun, never clears the checkpoint
}

function descentSourceMatches(tx) {
    return world.dungeon === tx.sourceDungeon && world.room === tx.sourceRoom
        && world.floor === tx.from && roomGeneration === tx.generation;
}

async function attemptDescent(tx) {
    if (!ownsDescent(tx) || tx.busy || decisionOpen) { return; }
    if (document.hidden) { pauseDescent("页面仍在后台，请回到本页后重试。"); return; }
    const token = ++tx.attempt;
    const current = function () { return ownsDescent(tx) && tx.attempt === token; };
    tx.busy = true;
    const timer = setTimeout(function () {
        if (current()) { pauseDescent("地图加载超过 20 秒，已暂停。请检查网络后重试，或先导出备份。"); }
    }, FLOOR_LOAD_TIMEOUT_MS);
    tx.timer = timer;
    try {
        if (!tx.committed && !descentSourceMatches(tx)) { throw new Error("原房间已变化，请检查存档并重新载入。"); }
        if (!checkStorageChanges()) { throw new Error(storageState().error || "暂时无法检查存档。"); }
        const expected = tx.committed ? tx.committed.run : tx.checkpoint;
        if (!expected || JSON.stringify(loadSlot("run")) !== JSON.stringify(expected)) {
            throw new Error("检查点已变化，未继续下潜。请核对备份后重新载入。");
        }
        if (!tx.nextDungeon) {
            tx.nextDungeon = generateDungeon(layoutSeedFor(tx.to), { roomsMin: 6, roomsMax: 9 });
            tx.entry = tx.nextDungeon.rooms.find(function (room) { return room.id === tx.nextDungeon.start; });
            if (!tx.entry || tx.entry.enemies.length) { throw new Error("下一层入口无效，原层已保留。"); }
        }
        if (!tx.candidate) {
            tx.ui.update({ busy: true, phase: "preload", committed: !!tx.committed,
                message: "正在读取下一层的原作模型与图集，当前场景保持不变。" });
            await mapView.preloadVolume(volume, tx.to, { strict: true, retry: true });
            if (!current()) { return; }
            tx.ui.update({ phase: "prepare", message: "资源已就绪，正在准备下一层入口。" });
            const candidate = await mapView.prepareRoom(tx.entry, undefined,
                doorsOf(tx.nextDungeon, tx.entry.id).map(function (door) { return door.side; }),
                { floor: tx.to, strict: true });
            if (!current()) { candidate.dispose(); return; }
            tx.candidate = candidate;
        }
        if (!tx.committed) {
            if (!descentSourceMatches(tx)) { throw new Error("原房间已变化，未提交下一层。"); }
            tx.ui.update({ phase: "commit", message: "正在一次保存下一层检查点与本层残页。" });
            const result = meta.descendRun(tx.runId, tx.checkpoint);
            if (!result.ok) { throw new Error(result.error || "下一层检查点未保存。"); }
            tx.committed = result;
        }
        if (!current()) { return; }
        tx.ui.update({ phase: "activate", committed: true, message: "检查点已提交，正在切换场景。" });
        // No asynchronous gap after the commit. If this synchronous assembly
        // throws, retry only rebuilds the empty entrance, never the transaction.
        mapView.activateRoom(tx.candidate);
        stageScene.applyVolume(volumeConfig(volume, tx.to));
        world.floor = tx.to;
        if (world.dungeon === tx.nextDungeon) { world.drainEvents(); }
        minimap.setDungeon(tx.nextDungeon);
        world.setDungeon(tx.nextDungeon);
        consumeEvents();              // rebuildRoom uses the already-prepared entrance
        world.setRoomColliders(tx.candidate.result.colliders);
        mapView.setDoorsLocked(world.roomLocked);
        followCam.snap(world.player.x, world.player.y);
        updateFloorHud();
        // Floor-entry warmup: fetch/parse the floor's enemy pool now, while
        // the descent transition still owns the screen, so the first battle
        // room's strict enemy load parses cached blobs instead of paying
        // network + inflate mid-exploration. Fire-and-forget: warm failures
        // never block the new floor.
        loader.warmModels(world.floorEnemyModels()).catch(function () {});
        pendingDescent = null; tx.busy = false;
        tx.ui.close(); runPhase = "active";
        input.clear(); syncWorldFrozen();
        tx.committed.newPages.forEach(function (pageId) {
            const entry = window.kirafanPages && window.kirafanPages[String(pageId)];
            beat("◇ 救回残页：〈" + workZhFor(pageId, entry ? entry.work : String(pageId)) + "〉", 5.0);
        });
        sweepAchievements();
        beat("▼ 下潜到第 " + tx.to + " 层", 4.0);
        queueDialogue(conditionalStory("segment"));
    } catch (error) {
        if (current()) { pauseDescent(error.message || "下潜未完成，请重试或打开备份窗口。"); }
    } finally { clearTimeout(timer); }
}

function descend(room) {
    if (runPhase !== "active" || pendingDescent || world.player.dead || room !== world.room
            || !room || room.type !== "boss" || world.roomLocked
            || !world.roomState.get(room.id)?.cleared || world.floor >= VOLUME_FLOORS) { return; }
    saveRun();                       // retain earned old-floor facts, not a queued floor change
    const tx = { runId: activeRunId, player: world.player, sourceDungeon: world.dungeon,
        sourceRoom: room, generation: roomGeneration, from: world.floor, to: world.floor + 1,
        checkpoint: runPayload(), attempt: 0, timer: null, busy: false,
        nextDungeon: null, candidate: null, committed: null, ui: null };
    pendingDescent = tx; runPhase = "loading";
    input.clear(); mapView.cancelBuild(); syncWorldFrozen();
    tx.ui = showFloorLoading({ volume, volumeName: VOLUME_NAMES[volume], from: tx.from, to: tx.to,
        characterName: charNameById(tx.checkpoint.cardId),
        cardArt: new URL("../../asset/img/rl/card/" + tx.checkpoint.cardId + ".webp", import.meta.url).href }, {
        state: storageState, subscribe: subscribeStorage,
        onRetry: function () { attemptDescent(tx); }, onStorage: openStorage,
        onBack: function () { leaveDescent(tx); }
    });
    attemptDescent(tx);
}

function openFloorDeparture() {
    if (!world.canCommuneAtShrine || !currentFloorShrine() || runPhase !== 'active'
            || decisionOpen || pendingDescent) { return; }
    const room = world.room, generation = roomGeneration, final = world.floor >= VOLUME_FLOORS;
    const unclaimed = world.getRoomClaims().flatMap(claim => (claim.drops || [])
        .flatMap(drop => drop.items.map(item => ({ roomId: claim.id, item }))));
    decisionOpen = true; input.clear(); syncWorldFrozen();
    activeDecision = showFloorDeparture({ final, floor: world.floor, unclaimed, weapons: weaponsData,
        onClose: closeDecision,
        onConfirm() {
            if (runPhase !== 'active' || world.room !== room || generation !== roomGeneration
                    || !world.canCommuneAtShrine || !currentFloorShrine()) { return false; }
            activeDecision.close();
            if (!final) { descend(room); return !!pendingDescent; }
            if (!finishRun('victory')) { return false; }
            if (volume === 5) { queueDialogue('v5_close'); queueDialogue('finale_end'); }
            else { queueDialogue('v' + volume + '_close'); }
            maybeShowRunResult();
            return true;
        }
    });
}



// --- dialogue (T12, spec/05 §5/§7) ------------------------------------------------

// who -> character. Exact cards.js name first, then a 【variant】 prefix
// match that is one of the 40 roster cards (those ship busts), then the
// original-characters roster (メディア/ハイプリス — their 【第2部】 gacha
// cards exist but ship no bust, so they must not win over the originals),
// then any 【variant】 prefix as a last resort. Returns null for a name that
// is in no roster — validateScripts flags those, the presenter shows a bare
// plate.
function resolveDialogueCharacter(who) {
    if (!who || typeof who !== "string") {
        return null;
    }
    const explicit = dialoguePresentationForName(who);
    if (explicit) { return explicit; }
    const all = cards.all();
    for (let i = 0; i < all.length; i++) {
        if (all[i].name === who) {
            return dialogueCharacterFromCard(all[i]);
        }
    }
    const roster = meta && meta.progression ? meta.progression.chars : null;
    const prefix = who + "【";
    if (roster) {
        for (let i = 0; i < all.length; i++) {
            if (all[i].name.indexOf(prefix) === 0
                    && roster.indexOf(all[i].id) >= 0) {
                return dialogueCharacterFromCard(all[i]);
            }
        }
    }
    const originals = window.kirafanOriginalCharacters || [];
    for (let i = 0; i < originals.length; i++) {
        if (originals[i].japanese === who) {
            // The gacha table localizes メディア as 梅蒂娅 on its 【第2部】
            // card and leaves ハイプリス in katakana — follow both, but keep
            // bust null: those variant cards ship no bust file.
            let zh = originals[i].chinese || null;
            if (!zh) {
                for (let j = 0; j < all.length; j++) {
                    if (all[j].name.indexOf(prefix) === 0
                            && all[j].characterZh) {
                        zh = all[j].characterZh;
                        break;
                    }
                }
            }
            return { id: 0, name: who, nameZh: zh || who, bust: null };
        }
    }
    for (let i = 0; i < all.length; i++) {
        if (all[i].name.indexOf(prefix) === 0) {
            return dialogueCharacterFromCard(all[i]);
        }
    }
    return null;
}

function dialogueCharacterFromCard(card) {
    return {
        id: card.id,
        name: card.name,
        // characterZh is the base name (きらら【漫画版】 → 琪拉拉); nameZh
        // carries the 【variant】 suffix and reads badly on a name plate.
        nameZh: card.characterZh || card.nameZh || card.name,
        bust: new URL("../../asset/img/rl/bust/" + card.id + ".webp", import.meta.url).href
    };
}

function initDialogue() {
    dialogue.setCharacterResolver(resolveDialogueCharacter);
    dialoguePresenter = createDialoguePresenter({
        resolveCharacter: resolveDialogueCharacter
    });
    const loaded = dialogue.loadDialogueScripts(window);
    if (!loaded.ok) {
        console.warn("dialogue script errors: " + loaded.errors.join(" | "));
    }
    const indexed = validateStoryCatalog(dialogue.getNode);
    if (!indexed.ok) { console.warn(indexed.errors.join(" | ")); }
}

function conditionalStory(trigger) {
    const cardId = world?.player?.card?.id;
    const identity = PLAYABLE_ROSTER.find(row => row.id === cardId);
    const lastResult = trigger === "rest" && runPhase === "active"
        ? previousStoryResult(loadSlot("lastResult"), activeRunId) : null;
    return selectStory(trigger, { volume, floor: world?.floor, cardId,
        character: identity ? identity.legacyId : cardId, pages: meta?.state.pages || [], lastResult },
        meta?.state.storySeen || []);
}

// The player's dialogue-side name: spawnPlayer stores the resolved cards-rl
// row on the unit as `card` (the spawn spec's cardId is not kept).
function playerDialogueName() {
    const p = world && world.player;
    const row = p && p.card;
    return dialogueNameForCard(row);
}

// Rest chatter (spec/05 §7): the campfire picks one of the character's three
// lines per visit, off a run-stable stream so a retry gives a fresh pick.
const restRng = seedFrom(RUN_SEED + " chatter");
function restChatterNode() {
    const who = playerDialogueName();
    if (!who) {
        return null;
    }
    return "rest_" + who + "_" + (1 + Math.floor(restRng() * 3));
}

// Unknown nodes are skipped, not rejected: a missing node must never
// red-screen the fight that tried to cite it.
function queueDialogue(nodeId) {
    if (!nodeId || !dialogue.getNode(nodeId)) {
        return;
    }
    dialogueQueue.push(nodeId);
    pumpDialogue();
}

function pumpDialogue() {
    if (dialogueBusy || !dialogueQueue.length || !dialoguePresenter || !world
            || usLoading || usPlayer || pendingRoomLoad) {
        return;
    }
    dialogueBusy = true;
    const nodeId = dialogueQueue.shift();
    world.frozen = true;      // story time stops the fight (spec/05 §5)
    dialogue.play(nodeId, dialoguePresenter).then(function () {
        if (meta) { meta.markStorySeen(nodeId); }
    }).catch(function (error) {
        dialoguePresenter.finish();
        console.warn("dialogue node " + nodeId + ": " + error.message);
    }).then(function () {
        dialogueBusy = false;
        syncWorldFrozen();
        pumpDialogue();
        maybeShowRunResult();
    });
}

function rebuildRoom(room) {
    const tx = pendingDescent;
    if (tx && tx.committed && room === tx.entry && world.dungeon === tx.nextDungeon
            && mapView.group === tx.candidate?.group) {
        world.setRoomColliders(tx.candidate.result.colliders);
        mapView.setDoorsLocked(world.roomLocked);
        followCam.snap(world.player.x, world.player.y);
        return;
    }
    const load = { room, dungeon: world.dungeon, floor: world.floor, player: world.player,
        generation: roomGeneration, attempt: 0, phase: 'loading', busy: false, committed: false,
        candidate: null, timer: null, notice: null };
    pendingRoomLoad = load;
    coverRoom(true); stage.classList.add('room-loading'); input.clear(); syncWorldFrozen();
    attemptRoomLoad(load);
}

// Adjust a hex colour's HSL lightness by `delta` (percentage points).
// Returns a hex string. Used for the room-fade radial gradient (spec/01 §1:
// the reveal centre is slightly brighter than the fog edge).
function shadeFog(hex, delta) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || "")) { return hex || ""; }
    let r = parseInt(hex.slice(1, 3), 16) / 255,
        g = parseInt(hex.slice(3, 5), 16) / 255,
        b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > .5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) { h = (g - b) / d + (g < b ? 6 : 0); }
        else if (max === g) { h = (b - r) / d + 2; }
        else { h = (r - g) / d + 4; }
        h /= 6;
    }
    l = Math.min(1, Math.max(0, l + delta / 100));
    // HSL → RGB
    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    let rr, gg, bb;
    if (s === 0) { rr = gg = bb = l; }
    else {
        const q = l < .5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        rr = hue2rgb(p, q, h + 1 / 3);
        gg = hue2rgb(p, q, h);
        bb = hue2rgb(p, q, h - 1 / 3);
    }
    const toHex = v => Math.round(v * 255).toString(16).padStart(2, "0");
    return "#" + toHex(rr) + toHex(gg) + toHex(bb);
}

function coverRoom(immediate) {
    if (!roomFade) return;
    const fog = volumeConfig(volume, world.floor)?.fog || '#c9e6e4';
    const night = !!volumeConfig(volume, world.floor)?.night;
    const light = shadeFog(fog, night ? -12 : 12);
    roomFade.style.background = "radial-gradient(ellipse at center, " + light + " 0%, " + fog + " 70%)";
    roomFade.classList.toggle('instant', immediate);
    roomFade.classList.add('on');
}

function ownsRoomLoad(load) {
    return pendingRoomLoad === load && runPhase === 'active' && world.room === load.room
        && world.dungeon === load.dungeon && world.floor === load.floor && world.player === load.player
        && !load.player.dead && roomGeneration === load.generation;
}

function releaseRoomLoad(load) {
    clearTimeout(load.timer); clearTimeout(load.notice);
    if (load.candidate && mapView.group !== load.candidate.group) load.candidate.dispose();
    load.candidate = null;
}

function pauseRoomLoad(message) {
    const load = pendingRoomLoad;
    if (!load) return;
    load.attempt++; load.busy = false; load.phase = 'failed';
    releaseRoomLoad(load);
    if (!load.committed) {
        load.generation = ++roomGeneration;
        retryNativeRequests();
        clearEnemyViews(); clearInteractViews();
    }
    coverRoom(true); input.clear(); syncWorldFrozen();
    roomLoadUI.show('failed', message);
}

function cancelRoomLoad() {
    const load = pendingRoomLoad;
    if (!load) return;
    pendingRoomLoad = null; load.attempt++;
    if (!load.committed) { roomGeneration++; clearEnemyViews(); clearInteractViews(); }
    releaseRoomLoad(load); roomLoadUI.hide();
    stage.classList.remove('room-loading');
    if (roomFade) roomFade.classList.remove('on', 'instant');
}

async function attemptRoomLoad(load, retry = false) {
    if (!ownsRoomLoad(load) || load.busy || decisionOpen) return;
    if (document.hidden) { pauseRoomLoad('页面仍在后台，请回到本页后重试。'); return; }
    const token = ++load.attempt, current = () => ownsRoomLoad(load) && load.attempt === token;
    load.busy = true; load.phase = 'loading'; coverRoom(true); roomLoadUI.hide();
    input.clear(); syncWorldFrozen();
    load.notice = setTimeout(() => {
        if (current() && load.phase === 'loading') roomLoadUI.show('loading', '正在读取地图、敌人与交互物。战斗保持暂停。');
    }, 650);
    const timer = setTimeout(() => {
        if (current()) pauseRoomLoad('房间加载超过20秒，已暂停。可重试装配，或先检查备份。');
    }, ROOM_LOAD_TIMEOUT_MS);
    load.timer = timer;
    try {
        if (!load.committed) {
            if (retry) {
                loader.clearModelCache(); retryNativeRequests();
                await mapView.preloadVolume(volume, load.floor, { strict: true, retry: true });
                if (!current()) return;
            }
            const map = mapView.prepareRoom(load.room, biomeFor(load.room, volume, load.floor),
                world.roomDoors.map(door => door.side), { floor: load.floor, strict: true }).then(candidate => {
                if (!current()) { candidate.dispose(); return null; }
                load.candidate = candidate; return candidate;
            });
            await Promise.all([map, ensureEnemyViews({ strict: true }), ensureInteractViews({ strict: true }),
                waitForRoomFade(roomFade, 1)]);
            if (!current()) return;
            const result = mapView.activateRoom(load.candidate);
            world.setRoomColliders(result.colliders); mapView.setDoorsLocked(world.roomLocked);
            followCam.snap(load.player.x, load.player.y);
            syncViews(0); renderFrame();
            load.committed = true;
        }
        if (!current()) return;
        load.phase = 'revealing'; clearTimeout(load.notice); roomLoadUI.hide();
        if (roomFade) {
            roomFade.classList.remove('instant');
            getComputedStyle(roomFade).opacity; // Commit the opaque starting state before revealing.
            roomFade.classList.remove('on');
            stage.classList.remove('room-settle');
            void stage.offsetWidth; // reflow so the animation restarts
            stage.classList.add('room-settle');
        }
        await waitForRoomFade(roomFade, 0);
        if (!current()) return;
        pendingRoomLoad = null; load.busy = false; load.candidate = null;
        stage.classList.remove('room-loading'); input.clear(); hud?.clearInput();
        syncWorldFrozen(); pumpDialogue();
    } catch (error) {
        if (current()) pauseRoomLoad('房间装配未完成：' + error.message + '。当前战斗未恢复，可安全重试。');
    } finally { clearTimeout(timer); }
}

function clearEnemyViews() {
    if (enemyTelegraphs) { enemyTelegraphs.clear(); }
    enemyViews.forEach(function (view) { view.dispose(); });
    enemyViews = [];
    pendingViews.clear();
}

// Map candidates own the native statue. Failed/late builds cannot publish an
// invisible interaction or leave its materials behind in a different room.
function currentFloorShrine() {
    const view = mapView && mapView.floorShrine;
    return view && view.room === world?.room ? view : null;
}

function syncFloorShrineMarker(view) {
    if (!shrineMarker) {
        shrineMarker = document.createElement('div'); shrineMarker.className = 'floor-shrine-marker';
        shrineMarker.setAttribute('aria-hidden', 'true');
        const title = document.createElement('strong'); title.textContent = '大圣堂雕像';
        shrineMarker.append(title, document.createElement('span')); stage.appendChild(shrineMarker);
    }
    shrineMarker.hidden = !view || !world.player || world.player.dead || menuOpen || shopOpen
        || decisionOpen || dialogueBusy || codexOpen || !!usLoading || !!usPlayer || !!pendingDescent;
    if (shrineMarker.hidden) { return; }
    const at = view.anchor.clone().project(camera);
    const rect = renderer.domElement.getBoundingClientRect(), host = stage.getBoundingClientRect();
    if (at.z < -1 || at.z > 1 || Math.abs(at.x) > .94 || Math.abs(at.y) > .94) {
        shrineMarker.hidden = true; return;
    }
    shrineMarker.style.left = (rect.left - host.left + (at.x + 1) * rect.width / 2) + 'px';
    shrineMarker.style.top = (rect.top - host.top + (1 - at.y) * rect.height / 2) + 'px';
    const state = world.floorExitReady ? (world.canCommuneAtShrine ? 'nearby' : 'awake') : 'dormant';
    shrineMarker.dataset.state = state;
    const label = state === 'dormant' ? '战斗结束后苏醒' : state === 'nearby'
        ? (hud?.touchOn ? '点击「祈愿」与雕像共鸣' : 'E · 星光祈愿') : '靠近雕像 · 星光祈愿';
    if (shrineMarker.lastChild.textContent !== label) { shrineMarker.lastChild.textContent = label; }
}

// --- T22g interactable views (chest / barrels / altar / NPC) ---------------------

function clearInteractViews() {
    pendingInteractViews.clear();
    if (chestView) { chestView.dispose(); chestView = null; }
    barrelViews.forEach(function (view) { view.break(); });
    barrelViews = [];
    if (altarView) { altarView.dispose(); altarView = null; }
    if (npcView) { npcView.dispose(); npcView = null; }
    npcCard = null;
}

// The campfire guest: deterministic per room off its seed, drawn from the
// unlocked roster minus whoever the player brought. The first twelve all
// have campfire lines (spec/05 §7); a cameo without a rest node falls back
// to the player's own chatter at talk time.
function restNpcCard(room) {
    if (!meta || !tables || !tables.stats) {
        return null;
    }
    const p = world && world.player;
    const pool = meta.progression.chars
        // Durable history also contains legacy rows without current card art.
        // Guests use the same supported identities as the roster, not that union.
        .filter(function (id) { return PLAYABLE_IDS.includes(id); })
        .filter(function (id) { return !p || !p.card || p.card.id !== id; })
        .map(function (id) { return tables.stats.card(id); })
        .filter(function (row) { return row && row.resourceId; });
    if (!pool.length) {
        return null;
    }
    const rng = createRandom((room.seed ^ hash32("npc")) >>> 0);
    const row = pool[Math.floor(rng() * pool.length)];
    // row → gacha card: the same crossing loadPlayer does (the model library
    // and the stat table are keyed differently).
    return cards.all().find(function (c) {
        return c.id === row.id || c.evolvedId === row.id;
    }) || null;
}

// The guest's line, or the player's own chatter when the guest has no rest
// node authored (queueDialogue skips unknown nodes, so a missing node is a
// silent no-op, not a red screen).
function npcDialogueNode() {
    const conditional = conditionalStory("rest");
    if (conditional) { return conditional; }
    if (npcCard) {
        const node = "rest_" + dialogueNameForCard(npcCard) + "_" + (1 + Math.floor(restRng() * 3));
        if (dialogue.getNode(node)) { return node; }
    }
    return restChatterNode();
}

function ensureInteractViews(options = {}) {
    if (!world || !world.room) {
        return Promise.resolve();
    }
    const room = world.room;
    const tasks = [];

    if (world.chest && !chestView) {
        const chest = world.chest;
        tasks.push(requestRoomView(pendingInteractViews, 'chest', () => attachChestView(chest, scene),
            view => { chestView = view; }, view => view.dispose()));
    }

    const intact = world.barrels.filter(function (b) { return !b.broken; });
    if (intact.length && !barrelViews.length) {
        tasks.push(requestRoomView(pendingInteractViews, 'barrels', () => attachBarrelViews(intact, scene),
            views => { barrelViews = views; }, views => views.forEach(view => view.break())));
    }

    if (world.altar && !altarView) {
        const altar = world.altar;
        tasks.push(requestRoomView(pendingInteractViews, 'altar', () => attachAltarView(altar, scene),
            view => { altarView = view; }, view => view.dispose()));
    }

    if (world.npc && !npcView) {
        npcCard = restNpcCard(room);
        if (npcCard) {
            // Capture the record now: the actor load is async, and if the
            // player leaves the rest room mid-load, world.npc is already
            // null when the .then runs (enterRoom resets the handle).
            const npcRecord = world.npc;
            const evolved = Boolean(npcCard.evolvedResourceId);
            const settings = {
                resourceId: evolved ? npcCard.evolvedResourceId : npcCard.resourceId,
                classId: npcCard["class"],
                headId: cards.headId(npcCard, evolved),
                dedicatedWeapon: npcCard.dedicatedWeapon,
                weapon: "default",
                skillId: evolved ? npcCard.evolvedResourceId : npcCard.resourceId
            };
            // The campfire guest is a cosmetic cameo, not an interactable:
            // loading its full actor model (fresh GLB parse + fringe repair) on
            // the strict room-load path held every rest-room reveal hostage to
            // it, and one failed cameo paused the whole room load. Fire it and
            // let it attach when ready -- requestRoomView already warns on
            // failure and drops stale loads via the room generation.
            requestRoomView(pendingInteractViews, 'npc', () => actorModule.create(settings).then(actor =>
                attachNpcView(npcRecord, actor, scene).catch(error => { actor.dispose(); throw error; })),
                view => { npcView = view; }, view => view.dispose());
        }
    }
    return completeRoomViews(tasks, options.strict);
}

// --- floor loot markers (spec/04 §10) ------------------------------------------

const DROP_RARITY_COLORS = {
    common: 0x9aa4b5, rare: 0x4d9fff, epic: 0xb44dff, legendary: 0xffb340
};

// Rarity frame and untinted original weapon image share one billboard marker.

function loadDropTextures() {
    const loader3 = new THREE.TextureLoader();
    const names = ["coin", "star", "equipment-frame", "skill-attack", "skill-magic",
        "skill-recovery", "skill-buff", "skill-debuff", "skill-frame"];
    const tex = {};
    names.forEach(function (name) {
        // Resolve from this module: a page-relative "../.." escapes a
        // /kirafan-timer/ deployment subpath (two levels deep from the page).
        tex[name] = loader3.load(new URL("../../asset/img/rl/drop/" + name + ".webp", import.meta.url).href);
        tex[name].colorSpace = THREE.SRGBColorSpace;
    });
    return tex;
}

function makeDropSprite(texture, tint) {
    const material = new THREE.SpriteMaterial({
        map: texture,
        color: tint || 0xffffff,
        transparent: true,
        depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.42, 0.42, 1);
    return sprite;
}

function spawnDropMarker(event) {
    if (!THREE || !event.drop || dropViews.has(event.drop)) {
        return;
    }
    const item = event.items[0];
    const color = DROP_RARITY_COLORS[equipmentRarity(item)] || DROP_RARITY_COLORS.common;
    const tex = dropTextures && dropTextures["equipment-frame"];
    const sprite = makeDropSprite(tex, color);
    const icon = equipmentIcon(item, weaponsData);
    if (icon) {
        if (!weaponTextures.has(icon)) {
            const texture = new THREE.TextureLoader().load(icon);
            texture.colorSpace = THREE.SRGBColorSpace;
            weaponTextures.set(icon, texture);
        }
        sprite.scale.set(0.72, 0.72, 1);
        const image = makeDropSprite(weaponTextures.get(icon));
        image.scale.set(0.9, 0.9, 1);
        image.renderOrder = 1;
        image.visible = false; // The frame remains visible while art loads or fails.
        sprite.add(image);
        sprite.userData.weaponIcon = icon;
        sprite.userData.catalogId = item.catalogId;
    }
    sprite.position.set(event.x, 0.55, event.y);
    scene.add(sprite);
    dropViews.set(event.drop, sprite);
}

// T22j coin receipt: credited amounts are silent in world.js, so spawn a
// coin sprite that floats toward the camera and fades — the same "pickup"
// read the original gives.
function spawnCoinFly(x, y, amount) {
    if (!THREE || !dropTextures) {
        return;
    }
    const n = Math.max(1, Math.min(3, Math.round((amount || 8) / 12)));
    for (let i = 0; i < n; i++) {
        const sprite = makeDropSprite(dropTextures.coin);
        sprite.position.set(x + (i - (n - 1) / 2) * 0.25, 0.6, y);
        scene.add(sprite);
        coinFlys.push({ sprite: sprite, age: -i * 0.12, life: 1.6 });
    }
}

function removeDropMarker(drop) {
    const sprite = dropViews.get(drop);
    if (!sprite) {
        return;
    }
    scene.remove(sprite);
    sprite.traverse(child => { if (child.material) { child.material.dispose(); } });
    dropViews.delete(drop);
}

function clearDropViews() {
    dropViews.forEach(function (sprite) {
        scene.remove(sprite);
        sprite.traverse(child => { if (child.material) { child.material.dispose(); } });
    });
    dropViews.clear();
    coinFlys.forEach(function (fly) {
        scene.remove(fly.sprite);
        fly.sprite.material.dispose();
    });
    coinFlys = [];
}

// --- shop / rest / menu (spec/04 §10) -------------------------------------------

const SLOT_NAMES = { weapon: "武器", amulet: "护符", armor: "护甲", charm: "饰品" };
const RARITY_NAMES = { common: "普通", rare: "稀有", epic: "史诗", legendary: "传说" };

function closeDecision() {
    decisionOpen = false;
    activeDecision = null;
    input.clear();
    syncWorldFrozen();
}

function openStorage() {
    if (decisionOpen || runPhase === "loading" && !pendingDescent || usLoading || usPlayer || dialogueBusy) { return; }
    if (pendingDescent) { pauseDescent("下潜已暂停以检查备份。关闭备份窗口后，可重试下潜或装配。"); }
    if (pendingRoomLoad) pauseRoomLoad('房间装配已暂停以检查备份。关闭窗口后可重试。');
    saveRun();
    decisionOpen = true; input.clear(); syncWorldFrozen();
    activeDecision = showStorageManager({
        state: storageState, export: exportSave, preview: previewImport, restore: importSave,
        pending: exportPendingSave, retry: retryStorage, subscribe: subscribeStorage,
        characterName: charNameById,
        onClose: closeDecision,
        onRestored: function () {
            // Prevent pagehide from overwriting the imported run with the old world.
            cancelDescent();
            cancelRoomLoad();
            runPhase = "abandoned"; input.detach(); syncWorldFrozen();
            const url = new URL(window.location.href);
            for (const key of ["volume", "floor", "seed"]) { url.searchParams.delete(key); }
            window.location.replace(url.href);
        }
    });
}

function openEquipmentChoice(item, confirm, price) {
    if (!item || decisionOpen || runPhase !== "active" || world.player.dead) { return; }
    decisionOpen = true;
    input.clear();
    syncWorldFrozen();
    activeDecision = showEquipmentComparison({
        item: item, preview: world.previewEquipment(item), price: price, coin: world.coin,
        skillsTable: tables?.skills,
        disabled: price !== undefined && world.coin < price,
        weapons: weaponsData, cards: tables && tables.stats ? tables.stats.all() : [],
        onConfirm: function () {
            if (runPhase !== "active" || !confirm()) { return false; }
            saveRun();
            return true;
        },
        onClose: closeDecision
    });
}

function inspectShopItem(index) {
    const quote = world.getShopQuote(index);
    if (!shopOpen || !quote?.enabled) { return; }
    const item = quote.item;
    openEquipmentChoice(item, function () { return !!world.buyShopItem(index, item, persistRoomEvent); }, quote.price);
}

function openSupply() {
    const offer = world.getSupplyOffer();
    if (!offer || offer.used) { world.talkNpc(); return; }
    decisionOpen = true;
    input.clear();
    syncWorldFrozen();
    const guest = npcCard && tables && tables.stats ? tables.stats.card(npcCard.evolvedId || npcCard.id) : null;
    activeDecision = showSupplyChoice({
        offer: offer, cardId: guest ? guest.id : world.player.card.id,
        weapons: weaponsData, cards: tables.stats.all(),
        name: npcCard ? npcCard.characterZh || npcCard.nameZh : world.player.card.characterZh,
        onChoose: function (choice) {
            if (runPhase !== "active" || !world.chooseSupply(choice, offer.roomId, persistRoomEvent)) { return false; }
            world.talkNpc();
            saveRun();
            return true;
        },
        onClose: closeDecision
    });
}

function persistRoomEvent(patch) {
    const current = runPayload();
    if (!current || runPhase !== 'active') return false;
    const payload = buildRunPayload({ ...current, ...patch });
    return !!payload && writeSlot('run', payload, { runId: activeRunId });
}

function openAltar() {
    const offer = world.getAltarOffer();
    if (!offer) { if (world.roomLocked) beat('先结束战斗，再与星光立约。', 2.2); return; }
    if (offer.used) { beat('本祭坛的选择已完成。', 2.2); return; }
    decisionOpen = true; input.clear(); syncWorldFrozen();
    activeDecision = showAltarChoice({ offer, weapons: weaponsData, cards: tables.stats.all(),
        onChoose(choice) { return runPhase === 'active' && !!world.useAltar(choice, offer.roomId, persistRoomEvent); },
        onClose: closeDecision });
}

function renderShopItems() {
    if (!shopItemsBox || !world) {
        return;
    }
    const offer = world.getShopOffer();
    shopItemsBox.textContent = "";
    if (!offer) {
        return;
    }
    offer.forEach(function (entry, index) {
        const row = document.createElement("button");
        row.type = "button";
        row.dataset.index = index;
        if (!entry.item) {
            row.className = "shop-item sold";
            row.textContent = "无货";
            row.disabled = true;
            shopItemsBox.appendChild(row);
            return;
        }
        const item = entry.item;
        row.className = "shop-item rarity-" + equipmentRarity(item) + (entry.bought ? " sold" : "");
        const name = document.createElement("span");
        name.className = "item-name";
        name.textContent = equipmentName(item, weaponsData, tables && tables.stats ? tables.stats.all() : []);
        const quote = world.getShopQuote(index);
        row.disabled = !quote?.enabled;
        const price = document.createElement("span");
        price.className = "item-price";
        price.textContent = quote?.reason || entry.price + " 金币";
        const icon = equipmentIcon(item, weaponsData);
        if (icon) {
            const image = document.createElement("img");
            image.src = icon; image.alt = ""; image.className = "shop-weapon-icon";
            image.width = 48; image.height = 48;
            image.addEventListener("error", () => { image.hidden = true; });
            row.appendChild(image);
        }
        const copy = document.createElement("span"); copy.className = "item-copy";
        copy.appendChild(name);
        let definition;
        try { definition = weaponDefinition(item); } catch (_) { /* Invalid stock stays disabled. */ }
        if (definition) {
            const detail = document.createElement("span"); detail.className = "item-stats";
            detail.textContent = "Lv." + definition.maxLv + " · " + [["atk", "物攻"], ["mgc", "魔攻"],
                ["def", "物防"], ["mdef", "魔防"]].filter(([key]) => definition.max[key])
                .map(([key, label]) => label + " +" + definition.max[key]).join(" · ");
            copy.appendChild(detail);
        }
        let gadget;
        try { gadget = gadgetDefinition(item); } catch (_) { /* Invalid stock stays disabled. */ }
        if (gadget) {
            const terms = gadgetTerms(item, quote?.preview?.skillNames?.candidate);
            const benefit = document.createElement("span"); benefit.className = "item-stats";
            benefit.textContent = "外传机制 · " + terms.benefit;
            const cost = document.createElement("span"); cost.className = "item-stats gadget-cost";
            cost.textContent = terms.cost;
            copy.append(benefit, cost);
        }
        if (!definition && !gadget && item.slot !== "weapon") {
            const origin = document.createElement("span"); origin.className = "item-stats";
            origin.textContent = "外传装备 · " + (SLOT_NAMES[item.slot] || "未知槽位");
            copy.appendChild(origin);
        }
        row.appendChild(copy);
        row.appendChild(price);
        if (!entry.bought) {
            row.addEventListener("click", function () {
                inspectShopItem(index);
            });
        }
        shopItemsBox.appendChild(row);
    });
    if (shopCoinLabel) {
        shopCoinLabel.textContent = "金币 " + world.coin;
    }
}

function openShop() {
    if (!world || runPhase !== "active" || shopOpen || menuOpen || decisionOpen) {
        return;
    }
    if (!world.getShopOffer()) {
        return;
    }
    shopOpen = true;
    input.clear();
    syncWorldFrozen();
    renderShopItems();
    if (shopPanel) {
        shopPanel.classList.remove("hidden");
        shopPanel.showModal();
    }
}

function closeShop() {
    if (!shopOpen) {
        return;
    }
    shopOpen = false;
    // Native dialog cancellation can finish before the next simulation tick,
    // especially after a purchase rebuild removed the formerly focused button.
    // Do not let that same Escape edge open the pause menu underneath it.
    input.clear();
    syncWorldFrozen();
    if (shopPanel) {
        shopPanel.close();
        shopPanel.classList.add("hidden");
    }
    beat("♣ 离开商店", 1.5);
}

// Presentation recovery never re-applies an item or writes the profile. State
// objects change only at request boundaries, so the idle path writes no DOM.
function updateEquipmentAppearance() {
    const state = playerView && playerView.equipment;
    if (state === lastEquipmentState) { return; }
    lastEquipmentState = state;
    if (!equipmentModelBox || !equipmentRetry) { return; }
    const visible = !!state && state.status !== "ready";
    equipmentModelBox.hidden = !visible;
    if (!visible) { return; }
    const loading = state.status === "loading";
    const equipped = playerView.unit.equipment.some(item => item.slot === "weapon");
    setText(equipmentModelStatus, loading
        ? "正在加载武器外观…角色数值不受影响。"
        : equipped ? "武器外观加载失败，数值已生效。重试不会重复装备或扣费。"
            : "默认武器外观加载失败。可以重试，不影响角色数值。");
    equipmentRetry.disabled = loading;
    setText(equipmentRetry, loading ? "正在加载…" : "重试武器外观");
    if (!loading && !menuOpen) { beat("武器外观暂不可用，可在菜单中重试。", 3); }
}

function toggleMenu() {
    if (runPhase !== "active" || decisionOpen || landscapeBlocked) { return; }
    menuOpen = !menuOpen;
    syncWorldFrozen();
    if (menuPanel) {
        menuPanel.classList.toggle("hidden", !menuOpen);
    }
    if (menuOpen) { updateEquipmentAppearance(); }
}

// 残页図鑑 (T13, spec/06): the page-collection viewer, reachable from the
// pause menu mid-run and from the roster before a run. Volume titles mirror
// the authored rescue order in meta.js; 14010000 (きんいろモザイク) is listed
// by both 卷二 and 卷五, so first-wins dedupe keeps the codex at the 37
// unique pages that pages.js actually keys (游玩说明 §六.3). T22a: the work
// and hero names shown are the gacha card's titleZh/characterZh, so the
// codex, the rescue beat and the roster all agree on one Chinese name.
const CODEX_VOLUME_TITLES = [
    "卷一 褪色之海——被潮水卷走的夏天",
    "卷二 沉眠之沙——旅人与食桌的约定",
    "卷三 贪食之森——森深处没有回声",
    "卷四 机械之心——无人认领的造物",
    "卷五 真实之影——第一百个故事"
];

function codexEntries(ids, seen, collected) {
    const pages = window.kirafanPages || {};
    return ids.filter(function (id) {
        const key = String(id);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    }).map(function (id) {
        const row = pages[String(id)] || {};
        const card = cards.byId(id);
        return {
            id: id,
            work: (card && card.titleZh) || row.work || String(id),
            hero: (card && card.characterZh) || row.hero || "",
            text: row.text || "",
            collected: collected.has(String(id))
        };
    });
}

function codexSections() {
    const collected = new Set(
        (meta ? meta.progression.pages : []).map(String)
    );
    const seen = new Set();
    const sections = [];
    for (let vol = 1; vol <= 5; vol++) {
        sections.push({
            title: CODEX_VOLUME_TITLES[vol - 1],
            entries: codexEntries(pagesForVolume(vol), seen, collected)
        });
    }
    sections.push({
        title: "终章 散页",
        entries: codexEntries(FINALE_PAGES, seen, collected)
    });
    return sections;
}

// 敌人図鑑 (T22f): one section per volume, every mob + elite + boss face the
// authored encounter table ships. Stats are the volume's own dial level (the
// row the player actually meets at the volume's base floor); elite/boss HP
// carries the authored hpScale. 掉落: per-enemy drop tables do not exist in
// the data — drops roll a shared loot table — so the entry shows the kill
// rewards that ARE per-kind (world.js COIN_PER_KILL/EXP_PER_KILL).
function enemyCodexSections() {
    const encountered = new Set(
        (meta ? meta.progression.enemies : []).map(String)
    );
    return (tables && tables.encounters ? tables.encounters : []).map(
        function (vol) {
            const rows = []
                .concat(vol.mobs, vol.elites, [vol.boss])
                .filter(Boolean);
            return {
                title: CODEX_VOLUME_TITLES[(vol.vol || 1) - 1],
                entries: rows.map(function (row) {
                    const stats = tables.stats
                        ? tables.stats.enemyStats(row.id, vol.level) : null;
                    const role = row.id === vol.boss.id ? "boss"
                        : (row.elite ? "elite" : "mob");
                    return {
                        id: row.id,
                        nameZh: row.nameZh || row.name,
                        name: row.name,
                        element: row.element,
                        role: role,
                        level: vol.level,
                        hp: stats ? Math.round(stats.hp * (row.hpScale || 1)) : 0,
                        atk: stats ? stats.atk : 0,
                        def: stats ? stats.def : 0,
                        coin: COIN_PER_KILL[role],
                        exp: EXP_PER_KILL[role],
                        model: row.model,
                        encountered: encountered.has(String(row.id))
                    };
                })
            };
        });
}

// 遭遇记录 (T22f): a face joins the 图鉴 when it is seen in the room, not
// when it dies — the plan's word is 遭遇. Summoned adds are hp fodder with a
// parent's id, and batched recording keeps one save write per room.
function recordEncounters() {
    if (!meta || !world) {
        return;
    }
    const ids = [];
    world.enemies.forEach(function (e) {
        if (!e.summoned && ids.indexOf(e.enemyId) === -1) {
            ids.push(e.enemyId);
        }
    });
    if (ids.length) {
        meta.encounterEnemies(ids);
    }
}

function openCodex() {
    if (codexOpen || (runPhase !== "active" && runPhase !== "selecting")) {
        return;
    }
    codexOpen = true;
    if (menuOpen) {
        // the pause menu hands focus to the codex; the run stays frozen.
        menuOpen = false;
        if (menuPanel) {
            menuPanel.classList.add("hidden");
        }
    }
    if (world) {
        world.frozen = true;
    }
    showCodex({
        sections: codexSections(),
        enemySections: enemyCodexSections(),
        storySections: storySections(meta?.state.storySeen || [], dialogue.getNode,
            who => resolveDialogueCharacter(who)?.nameZh || "同行者"),
        onClose: function () {
            codexOpen = false;
            if (world) {
                syncWorldFrozen();
            }
        }
    });
}

// 成就 overlay (plan 阶段 8): same codex pattern — the pause menu hands focus
// to the overlay, the run stays frozen, and closing restores the menu so a
// keyboard player's flow is Esc→成就→Esc, not a dropped menu.
function openAchievements() {
    if (achvOpen || (runPhase !== "active" && runPhase !== "selecting")) {
        return;
    }
    achvOpen = true;
    const fromMenu = menuOpen;
    if (menuOpen) {
        menuOpen = false;
        if (menuPanel) {
            menuPanel.classList.add("hidden");
        }
    }
    if (world) {
        world.frozen = true;
    }
    showAchievements({
        entries: ACHIEVEMENTS.map(function (row) {
            const done = meta
                ? meta.state.achievements.some(function (a) {
                    return String(a) === String(row.id);
                }) : false;
            return { id: row.id, name: row.name, desc: row.desc, done: done };
        }),
        onClose: function () {
            achvOpen = false;
            if (world) {
                syncWorldFrozen();
            }
            if (fromMenu) {
                menuOpen = true;
                if (menuPanel) {
                    menuPanel.classList.remove("hidden");
                }
                const back = document.getElementById("menu-achv");
                if (back) {
                    back.focus();
                }
            }
        }
    });
}

// 操作说明 overlay (plan 阶段 8): a static controls reference. 重新教学 starts
// the walkthrough again (spec/09: 教学可在菜单重开, 无重复奖励); it only shows
// with an active run and dismisses the overlay so the world can unfreeze.
function openHowto() {
    if (howtoOpen || (runPhase !== "active" && runPhase !== "selecting")) {
        return;
    }
    howtoOpen = true;
    const fromMenu = menuOpen;
    if (menuOpen) {
        menuOpen = false;
        if (menuPanel) {
            menuPanel.classList.add("hidden");
        }
    }
    if (world) {
        world.frozen = true;
    }
    showHowto({
        canRetryTutorial: runPhase === "active" && !!world && !!world.player,
        onRetryTutorial: function () {
            if (tutorial) {
                tutorial.dispose();
            }
            clearTutorialSafety();
            tutorialEntryOpen = true;
        },
        onClose: function () {
            howtoOpen = false;
            if (world) {
                syncWorldFrozen();
            }
            if (fromMenu) {
                menuOpen = true;
                if (menuPanel) {
                    menuPanel.classList.remove("hidden");
                }
                const back = document.getElementById("menu-howto");
                if (back) {
                    back.focus();
                }
            }
        }
    });
}

// Esc: closes the shop first if it is up, otherwise toggles the pause menu.
// While the codex is open its own Escape handler owns the key — swallowing
// the edge here stops the menu from also opening underneath the overlay.
function updateMenuKey() {
    const down = !!input.state.menu;
    if (down && !lastMenu) {
        if (decisionOpen || codexOpen || achvOpen || howtoOpen) {
            // owned by the overlay's own Escape handler
        } else if (document.getElementById("rl-skillcard")) {
            // T22i 技能卡: Escape dismisses the card, not the menu under it.
            const el = document.getElementById("rl-skillcard");
            const btn = el.querySelector(".close-row button");
            if (btn) { btn.click(); } else { el.remove(); }
        } else if (shopOpen) {
            closeShop();
        } else {
            toggleMenu();
        }
    }
    lastMenu = down;
}

// E: the one key for every room interaction — the shop counter and the
// campfire guest own their rooms; T22g's chest and 祭坛 are proximity-gated
// inside theirs (a battle room can hold both a 祭坛 and the exit door, so
// "anywhere in the room" would fire the wrong one).
function handleInteract() {
    if (!world || world.frozen || world.transition || !world.player || world.player.dead
            || runPhase !== "active" || menuOpen || shopOpen || decisionOpen || usLoading || usPlayer || codexOpen || dialogueBusy || landscapeBlocked) {
        return;
    }
    const room = world.room;
    if (!room) {
        return;
    }
    const p = world.player;
    const near = function (spot, r) {
        return !!spot && !!p && Math.hypot(p.x - spot.x, p.y - spot.y) <= r;
    };
    if (room.type === "shop") {
        openShop();
    } else if (room.type === "rest") {
        openSupply();
    } else if (near(world.chest, 2.2)) {
        world.openChest();
    } else if (near(world.altar, 1.9)) {
        openAltar();
    } else if (world.canCommuneAtShrine && currentFloorShrine()) {
        openFloorDeparture();
    }
}

function updateInteractKey() {
    const down = !!input.state.interact;
    if (down && !lastInteract) {
        handleInteract();
    }
    lastInteract = down;
}

// While the shop overlay is up, the skill keys double as buy keys — the world
// is frozen, so no cast can compete with them.
function updateShopKeys() {
    for (let i = 0; i < 3; i++) {
        const down = !!input.state.skill[i];
        if (shopOpen && !decisionOpen && down && !lastShopKeys[i]) {
            inspectShopItem(i);
        }
        lastShopKeys[i] = down;
    }
}

function initOverlays() {
    const storageButton = document.getElementById("menu-storage");
    if (storageButton) { storageButton.addEventListener("click", openStorage); }
    const equipmentButton = document.getElementById("menu-equipment");
    if (equipmentButton) {
        equipmentButton.addEventListener("click", function () {
            if (!world || !world.player || decisionOpen || runPhase !== "active") { return; }
            decisionOpen = true; input.clear(); syncWorldFrozen();
            activeDecision = showEquipmentCollection({
                items: world.player.equipment, card: world.player.card,
                skillNames: world.player.skills?.slots.map(slot => slot.name),
                skillLoadout: world.player.skills?.describeLoadout(), skillsTable: tables?.skills,
                previewEquipment: item => world.previewEquipment(item),
                weapons: weaponsData, cards: tables && tables.stats ? tables.stats.all() : [],
                onClose: closeDecision
            });
        });
    }
    const resume = document.getElementById("menu-resume");
    if (equipmentRetry) {
        equipmentRetry.addEventListener("click", function () {
            if (!menuOpen || decisionOpen || landscapeBlocked || runPhase !== "active" || !playerView) { return; }
            const view = playerView;
            const pending = view.retryEquipment();
            updateEquipmentAppearance();
            pending.then(function () {
                if (playerView !== view) { return; }
                updateEquipmentAppearance();
                const focus = document.activeElement;
                const target = view.equipment.status === "ready" ? resume : equipmentRetry;
                // Do not pull focus out of another overlay/control while a
                // slow request finishes, or focus a portrait-hidden menu.
                if (menuOpen && !decisionOpen && !landscapeBlocked
                        && (focus === equipmentRetry || focus === document.body)
                        && target && target.getClientRects().length) { target.focus(); }
            });
        });
    }
    if (resume) {
        resume.addEventListener("click", function () {
            if (menuOpen) {
                toggleMenu();
            }
        });
    }
    const restart = document.getElementById("menu-restart");
    if (restart) {
        restart.addEventListener("click", function () {
            restartRun(volume);
        });
    }
    const codexBtn = document.getElementById("menu-codex");
    if (codexBtn) {
        codexBtn.addEventListener("click", openCodex);
    }
    // plan 阶段 8 菜单: 成就 and 操作说明 were rendered for a long time with no
    // handler — the overlay builders (ui/achievements.js, ui/howto.js) were
    // orphans. Wire both here like the codex button above.
    const achvBtn = document.getElementById("menu-achv");
    if (achvBtn) {
        achvBtn.addEventListener("click", openAchievements);
    }
    const howtoBtn = document.getElementById("menu-howto");
    if (howtoBtn) {
        howtoBtn.addEventListener("click", openHowto);
    }
    // T22i 技能卡: readable at any moment mid-run — the pause menu is up and
    // the world frozen, so the card just stacks on top and closing it hands
    // focus back to the menu (world.frozen is still menuOpen-driven).
    const skillsBtn = document.getElementById("menu-skills");
    if (skillsBtn) {
        skillsBtn.addEventListener("click", function () {
            if (!world || !world.player) {
                return;
            }
            showSkillCard(world.player, function () {
                const back = document.getElementById("menu-skills");
                if (back) {
                    back.focus();
                }
            });
        });
    }
    const volumeControl = document.getElementById("menu-volume");
    if (volumeControl) {
        volumeControl.addEventListener("input", function () {
            if (bgm) {
                bgm.setVolume(Number(volumeControl.value) / 100);
            }
        });
    }
    const seVolumeControl = document.getElementById("menu-sevol");
    if (seVolumeControl) {
        seVolumeControl.value = String(Math.round(audio.getSeVolume() * 100));
        seVolumeControl.addEventListener("input", function () {
            audio.setSeVolume(Number(seVolumeControl.value) / 100);
        });
    }
    // T22b 镜头高度 slider: tenths of a world unit in the input, a plain
    // unit in the rig. The value persists, so a reload boots the saved rig.
    const camSlider = document.getElementById("menu-cam");
    if (camSlider) {
        camSlider.value = String(Math.round(savedCamHeight() * 10));
        camSlider.addEventListener("input", function () {
            const h = applyCamHeight(Number(camSlider.value) / 10);
            writeSlot("cam-height", h, { defer: true });
        });
    }
    // T29 辅助设置: persist first, then mirror the durable bytes into the view
    // flags. A refused write (blocked storage) reverts the checkbox so the
    // control never claims a state the archive does not hold.
    // T29 画质档位: same persist-then-apply contract as the accessibility
    // switches. The pixel ratio re-rasterises the existing canvas at the
    // stage's unchanged CSS size; the health-bar size cache rides the same
    // ResizeObserver, so nothing reads layout here.
    const qualitySelect = document.getElementById("menu-quality");
    if (qualitySelect) {
        qualitySelect.value = loadSlot("quality");
        if (!qualitySelect.value) { qualitySelect.value = "high"; }
        qualitySelect.addEventListener("change", function () {
            if (writeSlot("quality", qualitySelect.value, { defer: true })) {
                applyQuality(loadSlot("quality"), window.devicePixelRatio || 1);
                renderer.setPixelRatio(quality.pixelRatio);
                const rect = renderer.domElement;
                renderer.setSize(rect.clientWidth, rect.clientHeight, false);
            } else {
                qualitySelect.value = quality.level;
            }
        });
    }
    for (const [boxId, key] of [["menu-reduced-shake", "reduced-shake"],
                                ["menu-reduced-flash", "reduced-flash"],
                                ["menu-simplified-ultimates", "simplified-ultimates"]]) {
        const box = document.getElementById(boxId);
        if (!box) { continue; }
        box.checked = loadSlot(key) === true;
        box.addEventListener("change", function () {
            if (writeSlot(key, box.checked, { defer: true })) {
                applyAccessibility(savedAccessibility());
            } else {
                box.checked = loadSlot(key) === true;
            }
        });
    }
    const closeShopBtn = document.getElementById("shop-close");
    if (closeShopBtn) {
        closeShopBtn.addEventListener("click", closeShop);
    }
    if (shopPanel) {
        shopPanel.addEventListener("cancel", function (event) { event.preventDefault(); closeShop(); });
        shopPanel.addEventListener("keydown", function (event) {
            event.stopPropagation();
            if (!event.repeat && /^[123]$/.test(event.key)) { inspectShopItem(Number(event.key) - 1); }
        });
    }
}

// Boss opening voice (spec/05 §6 rule 5). The original plays "voice_400" on
// the enemy party at eMainStep.WarningStart (BattleSystem.cs:3777), resolved
// through the enemy row's own m_VoiceCueSheetName; IsWarningWave() gates it on
// the quest's warning flag (BattleSystem.cs:543), so the story bosses of
// volumes 1-4 — which carry no sheet in EnemyResourceList.json — stay silent.
// Our warning fights are the rooms that field a voiced unit: the 層守衛 (an
// elite row), a battle room that rolled an elite, and the volume-5 boss.
function showBossVoiceLine(name, line) {
    const box = document.getElementById("boss-voice");
    if (!box || !line) { return; }
    box.querySelector(".bv-name").textContent = name;
    box.querySelector(".bv-line").textContent = line;
    box.style.display = "";
    if (bossVoiceTimer) { clearTimeout(bossVoiceTimer); }
    bossVoiceTimer = setTimeout(function () {
        box.style.display = "none";
        bossVoiceTimer = 0;
    }, BOSS_VOICE_HOLD_MS);
}

function playBossVoice(unit) {
    if (!bossVoiceData || !unit || !unit.voiceCueSheet) { return; }
    const rec = bossVoiceData.sheets[unit.voiceCueSheet];
    if (!rec || !rec.files || !rec.files.length) { return; }
    if (bossVoiceAudio) {
        bossVoiceAudio.pause();
        bossVoiceAudio = null;
    }
    // CRI sheets carry the cue as variants voice_400_0/_1 (the middleware
    // picks one at random); mirror that with a fair coin.
    const file = rec.files[Math.floor(Math.random() * rec.files.length)];
    // Module-relative: Audio src alone would resolve against the page URL and
    // escape a deployment subpath.
    bossVoiceAudio = new Audio(new URL("../../audio/voice/" + file, import.meta.url).href);
    bossVoiceAudio.play().catch(function (err) {
        console.warn("boss voice playback failed:", err.message);
    });
    const lines = bossVoiceLines && bossVoiceLines[unit.voiceCueSheet];
    showBossVoiceLine(unitName(unit), lines && lines.line);
}

// 阶段 6: load and play one とっておき performance
async function playUltimate() {
    if (runPhase !== "active" || usLoading || usPlayer) { return; }
    const skill = world.useUltimate();
    if (!skill) { beat("当前无法使用必杀"); return; }
    audio.se("special", { volume: 0.8 });
    beat(skill.name || "必杀", 2.5);
    // 用户反馈 2026-09-16：必杀前不再垫 ef_btl_buff_ring 蓄力圆环——原作
    // とっておき演出（有 sceneId 的身份）自带上场特效，无演出的身份也不该
    // 出现一个代码加的圆。emitPickup 的拾取圆环与此无关，保留。
    const rid = skill.sceneId;
    usLoading = !!rid;
    world.events.filter(function (event) { return event.type === "hit"; }).forEach(settleTerminalHit);
    saveRun();
    if (!rid) { return; }
    // 辅助设置“简化必杀演出”: useUltimate already queued this ultimate's
    // world damage events — the same deferred events the skip/failure path
    // settles — so skipping the presentation load resolves the damage exactly
    // once and combat resumes without a freeze. The cinematic is purely
    // presentational; hit ranges, bullets and the logic step never change.
    if (accessibility.simplifiedUltimates) {
        usLoading = false;
        return;
    }
    const token = ++usRequest;
    const owner = world.player;
    const generation = roomGeneration;
    const current = function () {
        return token === usRequest && world.player === owner && generation === roomGeneration
            && !owner.dead && (runPhase === "active" || runPhase === "victory");
    };
    usLoading = true;
    syncWorldFrozen();
    usSkipButton.hidden = false;
    let loaded = null;
    let actor = null;
    try {
        const index = await loadSceneIndex();
        if (!current() || !(index.scenes || index)[rid]) { return; }
        const timeline = await loadTimeline(rid);
        if (!current()) { return; }
        loaded = await loadScene(rid);
        if (!current()) { return; }
        const card = cards.all().find(c => c.id === owner.card.id || c.evolvedId === owner.card.id);
        if (!card) { throw new Error("必杀角色身份未能匹配卡牌资料"); }
        // The scene selects motion, not the actor's costume. Preserve the
        // rendered form already on the battlefield (often the evolved model).
        const resourceId = playerView && playerView.actor
            ? playerView.actor.resourceId : String(card.evolvedResourceId || card.resourceId);
        const evolved = resourceId === String(card.evolvedResourceId);
        actor = await actorModule.create({ resourceId, skillId: rid, stageMotion: true,
            classId: card.class, headId: cards.headId(card, evolved),
            dedicatedWeapon: card.dedicatedWeapon,
            weapon: card.dedicatedWeapon ? "dedicated" : "default" });
        if (!current()) { return; }
        if (!actor.play("skill", { loop: false, fade: 0 })) { throw new Error("missing original skill motion " + rid); }
        usPlayer = createStage({ THREE, timeline, root: loaded.scene, object: actor.object,
            resourceId: rid, voices: voicesData,
            sampleActor: function (seconds) { actor.seek(seconds); },
            onReset: function () { actor.setWeaponVisible(true); actor.faceAuto(); },
            onEvent: function (event) {
                if (event.event === "weaponVisible") { actor.setWeaponVisible(!!event.args[0]); }
                if (event.event === "setFacial") { actor.facialId(event.args[0]); }
            }
        });
        usActor = actor;
        usPlayer.seek(0);
        if (!menuOpen && !document.hidden && !landscapeBlocked) { usPlayer.play(); }
        loaded = null;
    } catch (error) {
        console.warn("uniqueskill presentation unavailable:", error.message);
    } finally {
        if (loaded) { disposeScene(loaded.scene, THREE); }
        if (actor && actor !== usActor) { actor.dispose(); }
        if (token === usRequest) {
            usLoading = false;
            if (!usPlayer) { skipUltimate(); }
            syncWorldFrozen();
        }
    }
}

// Each request owns its map entry. A stale completion cannot delete a newer
// attempt with the same enemy ID, nor publish a view in the replacement room.
function requestRoomView(requests, key, create, accept, dispose) {
    const existing = requests.get(key);
    if (existing) return existing.promise;
    const request = { generation: roomGeneration, promise: null };
    requests.set(key, request);
    request.promise = Promise.resolve().then(create).then(view => {
        if (request.generation !== roomGeneration || requests.get(key) !== request) { dispose(view); return null; }
        accept(view); return null;
    }).catch(error => {
        console.warn('房间模型未就绪 (' + key + '): ' + error.message);
        return error;
    }).finally(() => { if (requests.get(key) === request) requests.delete(key); });
    return request.promise;
}

function completeRoomViews(tasks, strict) {
    return Promise.all(tasks).then(results => {
        const error = results.find(Boolean);
        if (strict && error) throw error;
    });
}

function skipUltimate() {
    stopUltimate(false);
    pumpDialogue();
    maybeShowRunResult();
}

function stopUltimate(discardEvents) {
    usRequest += 1;
    if (usPlayer) { usPlayer.dispose(); }
    if (usActor) { usActor.dispose(); }
    usPlayer = null;
    usActor = null;
    usLoading = false;
    stage.classList.remove("ultimate-playing");
    if (usSkipButton) { usSkipButton.hidden = true; }
    if (world && !discardEvents) { world.events.unshift(...usDeferredEvents); }
    usDeferredEvents = [];
    syncWorldFrozen();
}

function updateUltimate(dt) {
    if (usSkipButton) { usSkipButton.hidden = !(usLoading || usPlayer) || menuOpen; }
    if (!usPlayer) { return; }
    if (menuOpen || document.hidden || landscapeBlocked) { usPlayer.pause(); return; }
    if (!usPlayer.player.playing && !usPlayer.finished) { usPlayer.play(); }
    usPlayer.update(dt);
    if (usPlayer.finished) { skipUltimate(); }
}

// Attaches a view to every enemy that has not got one yet: room entry brings a
// whole roster, a boss phase brings one or two more. core/loader.js load() is
// uncached, so each unit owns its own geometries and dispose() actually frees
// them -- which is what keeps renderer.info flat across a floor's worth of
// rooms.
function ensureEnemyViews(options = {}) {
    const tasks = [];
    world.enemies.forEach(function (unit) {
        if (hasView(unit)) {
            return;
        }
        if (typeof unit.model !== "string" || !unit.model) {
            if (options.strict) tasks.push(Promise.resolve(new Error('敌人缺少模型：' + unitName(unit))));
            return;
        }
        tasks.push(requestRoomView(pendingViews, unit.id, () => attachEnemyView(unit, scene),
            view => { enemyViews.push(view); }, view => view.dispose()));
    });
    return completeRoomViews(tasks, options.strict);
}

function hasView(unit) {
    for (let i = 0; i < enemyViews.length; i++) {
        if (enemyViews[i].unit === unit) {
            return true;
        }
    }
    return false;
}


// --- HUD -------------------------------------------------------------------
//
// The player-facing readout is ui/hud.js (spec/01 §4): skill icons with CD
// fan masks, the gold とっておき gauge, the touch controls. This section is
// the top status line — the numbers a developer wants at a glance that the
// HUD does not carry (room state, live enemy and bullet counts, i-frames).

// Floor HUD (阶段 5): 卷名 · 段名 · f/20 — the descent's only progress
// readout. Cached on lastFloorShown so the per-frame updateStatus call
// rewrites the DOM solely when a floor is actually crossed.
let lastFloorShown = 0;
function updateFloorHud() {
    if (!floorBox || !world || world.floor === lastFloorShown) {
        return;
    }
    lastFloorShown = world.floor;
    const cfg = volumeConfig(volume, world.floor);
    floorBox.textContent = (VOLUME_NAMES[volume] || "卷 " + volume)
        + " · " + (cfg.name || "") + " · " + world.floor + "/" + VOLUME_FLOORS;
}

function updateStatus() {
    if (!world) {
        return;
    }
    const p = world.player;
    const room = world.room;
    if (!p) {
        return;
    }
    updateFloorHud();
    // Coin HUD readout (mirrors the HP field above)
    const coinValue = document.getElementById("coin-value");
    setText(coinValue, world.coin);

    // Boss HP bar: up while the boss of this room is alive, down otherwise.
    if (bossBar) {
        const boss = world.enemies.find(function (e) {
            return !e.dead && (e.kind === "boss" || (room?.type === "boss" && e.elite));
        });
        stage.classList.toggle("boss-fight", !!boss);
        if (boss) {
            bossBar.style.display = "";
            setText(bossBar.querySelector(".boss-name"), unitName(boss));
            bossBar.querySelector(".boss-fill").style.width
                = Math.max(0, Math.round(100 * boss.hp / boss.maxHp)) + "%";
            const readout = bossBar.querySelector(".boss-readout");
            if (readout) {
                const action = boss.action;
                let phase = boss.kind === "boss" ? "第 " + boss.phase + " 阶段" : "层守卫", counter = "";
                if (boss.stunTimer > 0) { phase = "眩晕 · " + boss.stunTimer.toFixed(1) + " 秒"; counter = "趁机进攻"; }
                else if (action?.stage === "windup") {
                    phase = action.move.label + " · " + Math.max(0, action.move.warning - action.age).toFixed(1) + " 秒";
                    counter = action.move.counter;
                } else if (action?.stage === "active") { phase = action.move.label + " · 执行"; counter = "避开红色区域"; }
                else if (action?.stage === "recover" || boss.recoveryWindow > 0) {
                    const remaining = boss.recoveryWindow || Math.max(0, action.recovery - action.age);
                    phase = "破绽 · " + remaining.toFixed(1) + " 秒"; counter = "趁恢复反击，留意其他敌人";
                } else if (boss.sm.state === "telegraph") { phase = "蓄力 · 注意预警"; }
                else if (boss.sm.state === "recover") { phase = "破绽 · 趁机进攻"; }
                setText(readout, phase + "  /  " + Math.ceil(boss.hp) + " · " + boss.maxHp);
                const advice = bossBar.querySelector(".boss-counter");
                if (advice) { setText(advice, counter); advice.hidden = !counter; }
            }
        } else {
            bossBar.style.display = "none";
        }
    }

    // Update HP HUD display
    const hpValue = document.getElementById("hp-value");
    const hpMax = document.getElementById("hp-max");
    setText(hpValue, p.hp);
    setText(hpMax, p.maxHp);
    const hpDisplay = document.getElementById("hp-display");
    if (hpDisplay) {
        const health = String(Math.min(1, Math.max(0, p.hp / p.maxHp)));
        if (hpDisplay.style.getPropertyValue("--health") !== health) {
            hpDisplay.style.setProperty("--health", health);
        }
        hpDisplay.classList.toggle("low-health", p.hp / p.maxHp < .3);
    }

    if (!debugHud) { return; }
    const alive = world.enemies.filter(function (e) { return !e.dead; }).length;
    const parts = ["卷 " + volume];
    if (p.card) { parts.push((p.card.characterZh || p.card.name) + " Lv" + p.level); }
    parts.push("HP " + p.hp + "/" + p.maxHp, "金币 " + world.coin);
    if (p.skills) {
        if (p.skills.barrier) {
            parts.push("护盾 " + p.skills.barrier.hits);
        }
        if (p.skills.buffs.length) {
            parts.push("强化 " + p.skills.buffs.length);
        }
    } else {
        parts.push("未加载表格");
    }
    parts.push("房间 " + (room ? room.type : "-") + (world.roomLocked ? " 🔒" : ""));
    parts.push("敌 " + alive);
    if (world.danmaku.active > 0) {
        parts.push("弹 " + world.danmaku.active);
    }
    if (p.iframes > 0) {
        parts.push("无敌 " + p.iframes.toFixed(2) + "s");
    }
    if (p.dead) {
        parts.push("力竭");
    }
    say(parts.join("  ·  "));
}

// --- boot -----------------------------------------------------------------------

// The shipped tables. Every one is optional: a fetch that fails drops the world
// back to stage 2's literals rather than to a blank page, and the status line
// says which case the player is looking at.
function loadTables() {
    const base = new URL("../../asset/rl/", import.meta.url);
    function json(name) {
        return fetch(new URL(name, base)).then(function (response) {
            if (!response.ok) {
                throw new Error(name + ": " + response.status);
            }
            return response.json();
        });
    }
    return Promise.all([
        loadStats(function (url) { return fetch(url); }),
        json("skills-rl.json"),
        json("encounters.json"),
        json("weapons-rl.json"),
        json("voices.json"),
        json("bossvoices.json"),
        json("bossvoice-lines.json")
    ]).then(function (loaded) {
        // T10 wiring: weapons-rl.json's 162 passives are both the affix pool
        // loot.js rolls from and the multiplier table equipment.js applies
        // (passives keys == weapons[].id, so one file feeds both).
        const weapons = loaded[3];
        const passiveIds = Object.keys(weapons.passives);
        setAffixPool(passiveIds, weapons.weapons.map(function (w) { return w.id; }));
        setAffixTable(affixTableFromPassives(weapons.passives));
        setWeaponCatalog(weapons.catalog);
        setImportValidator(createProfileValidator({ stats: loaded[0], weapons: weapons, mergeMeta: mergeState,
            pageIds: [1, 2, 3, 4, 5].flatMap(pagesForVolume).concat(FINALE_PAGES),
            achievementIds: ACHIEVEMENTS.map(row => row.id) }));
        weaponsData = weapons;   // shop UI reads passive detail text from it
        voicesData = loaded[4];  // stash voices.json for ultimate playback
        bossVoiceData = loaded[5];   // boss opening voice manifest
        bossVoiceLines = loaded[6];  // boss opening voice subtitle lines
        // Type-8 rows swap the evolved weapon's own attack/skill rows in
        // (skills.js applyWeapon); they ride the skills table so createSkills
        // sees them through the same `table` argument as everything else.
        loaded[1].weaponChildren = weapons.childSkills || {};
        return {
            stats: loaded[0],
            skills: loaded[1],
            encounters: loaded[2].volumes || []
        };
    }).catch(function (error) {
        console.warn("rl tables unavailable, falling back to stage-2 numbers:", error.message);
        return null;
    });
}

function encounterFor(volumeNumber) {
    if (!tables) {
        return null;
    }
    const rows = tables.encounters || [];
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].vol === volumeNumber) {
            return rows[i];
        }
    }
    return rows[volumeNumber - 1] || null;
}

// Card IDs own identity. Resource IDs are not unique: two classes can share
// one casual-outfit model. Preserve the selected (or saved) truth row all the
// way through stats, skills, card art and the exact base/evolved model form.
function loadPlayer() {
    // The one body both the selection and the cancel/fallback path run.
    // `resume` is a validated run snapshot (局内续档) or null for a fresh run.
    function loadCardIntoWorld(row, resume) {
        const card = row && gachaById.get(row.id);
        if (!card || !row) {
            say("卡片数据为空");
            return Promise.resolve();
        }
        runPhase = "loading";
        syncWorldFrozen();
        // Keep the previous checkpoint until the chosen character and room
        // are ready; beginRun then replaces it under a fresh identity.
        // T24: a fresh run rolls its own seed; a resumed one reuses the
        // snapshot's. Two fresh runs with the same ?seed= and volume must
        // produce the same dungeon (spec/07 §6 acceptance), so RUN_SEED is
        // not re-randomised here — it was decided once at module boot.
        const bootFloor = resume ? resume.floor : startFloor;
        say("读取中 " + (card.characterZh || card.character || card.name) + "…");
        const evolved = row.id === card.evolvedId;
        return actorModule.create({
            resourceId: row.resourceId,
            classId: row.class,
            headId: cards.headId(card, evolved),
            dedicatedWeapon: card.dedicatedWeapon,
            // The battle loadout, not the card's available dedicated weapon,
            // owns equipment. A resumed catalog item is applied by the view.
            weapon: "default",
            skillId: row.resourceId
        }).then(function (actor) {
            // the volume's kits load once here; room switches only instantiate
            return mapView.preloadVolume(volume, bootFloor).then(function () {
                mapView.setFloor(bootFloor);
                stageScene.applyVolume(volumeConfig(volume, bootFloor));

                // Run start level (T11): the camp-trained level lifts the run
                // above the volume's authored baseline but never below it —
                // fresh saves play at the balance anchors (spec/04 §5), and
                // training is what pushes past them (游玩说明 §六.1).
                // A resume ignores both: the snapshot's level IS the run's.
                const baseline = world.encounter && world.encounter.playerLevel
                    ? world.encounter.playerLevel : 1;
                const trained = row && meta ? meta.levelOf(row.id) : 1;
                const player = world.spawnPlayer({
                    cardId: row ? row.id : undefined,
                    level: resume ? resume.level : Math.max(baseline, trained),
                    equipment: resume ? resume.equipment : undefined,
                    x: world.width / 2,
                    y: world.height / 2
                });
                if (resume) {
                    // Everything below is what the seeds cannot rebuild. hp is
                    // clamped (never trust a stale number past a re-derived
                    // maxHp); the stack counters ride the unit and apply on the
                    // next reapplyEquipment, same as a continuous run's.
                    player.hp = Math.min(Math.round(resume.hp), player.maxHp);
                    player.exp = resume.exp;
                    player.stackHits = resume.stackHits;
                    player.stackKills = resume.stackKills;
                    world.coin = resume.coin;
                    if (player.skills) {
                        player.skills.addGauge(resume.gauge);
                    }
                }
                playerView = attachPlayerView(player, actor, scene);
                skillVFX.prepare(player).catch(function (error) { console.warn("Player effect preload:", error); });

                world.floor = bootFloor;
                const dungeon = generateDungeon(layoutSeedFor(bootFloor), {
                    roomsMin: 6, roomsMax: 9
                });
                minimap.setDungeon(dungeon);
                world.setDungeon(dungeon, resume ? resume.roomClaims : []); // fires the first "room" event,
                                                // which builds the room + views
                followCam.snap(player.x, player.y);
                updateFloorHud();
                const started = beginRun(resume || runPayload(), { resume: !!resume });
                activeRunId = started.runId;
                if (!activeRunId) {
                    runPhase = "selecting"; syncWorldFrozen();
                    say(started.error || "冒险未开始，请从存档入口检查记录。");
                    return;
                }
                runPhase = "active";
                syncWorldFrozen();
                say("");
                // Achievements earned by the previous run's terminal commit
                // land here — never inside finishRun's victory window (the
                // terminal gate counts storage commits there, and the sweep
                // must not add a second transaction to the terminal one).
                sweepAchievements();
                // Same floor-entry warmup as the descent path (see below):
                // the run's first battle room must not pay network + inflate
                // for unseen enemy models on its strict load path.
                loader.warmModels(world.floorEnemyModels()).catch(function () {});
                if (resume) {
                    // The volume opening belongs to the run's first boot; a
                    // resume picks up mid-descent, so the camp stays quiet.
                    saveRun();
                    queueDialogue(conditionalStory("segment"));
                } else if (volume === 5) {
                    // Volume opening (T12): the finale volume gets its own longer
                    // intro before the standard 卷头.
                    queueDialogue("finale_intro");
                    queueDialogue("v" + volume + "_open");
                } else {
                    queueDialogue("v" + volume + "_open");
                }
                // First-run tutorial (plan 阶段 8): once per save, right after
                // the volume opening — きらら previews the controls, then the
                // on-screen walkthrough takes over when control returns.
                if (!resume && meta && !meta.seenTutorial()) {
                    queueDialogue("tutorial");
                    tutorialEntryOpen = true;
                }

                // Switch to exploration BGM after the character loads
                if (bgm) {
                    playBGM("explore", { fadeIn: 1500 });
                }
            });
        });
    }

    function defaultCard() {
        return rlRows.find(row => row.id === PLAYABLE_IDS[0]) || null;
    }

    // Roster source: truth-table rows that actually have a renderable gacha
    // card. Without the tables (offline fallback) there is nothing to choose
    // between, so skip straight to the default.
    const rlRows = tables && tables.stats ? tables.stats.all() : [];
    const gachaById = new Map();
    cards.all().forEach(function (c) {
        gachaById.set(c.id, c);
        if (c.evolvedId) { gachaById.set(c.evolvedId, c); }
    });
    const rosterSource = rlRows.filter(function (row) {
        if (!gachaById.has(row.id) || row.rare !== 5 || !PLAYABLE_IDS.includes(row.id)) {
            return false;
        }
        // T11: only camp-unlocked characters are playable (游玩说明 §六.2).
        // A missing/failed meta never locks the roster — fall back to open.
        if (meta && meta.progression.chars.indexOf(row.id) < 0) {
            return false;
        }
        return true;
    });

    // 局内续档: the snapshot resumes only into the volume it was saved in —
    // booting another volume explicitly (?volume=) starts fresh by design.
    // Content tables are now available: the boot-time structural check alone
    // cannot authorize continuing a corrupt active profile.
    const checkedRun = readRunSnapshot();
    const snapshot = checkedRun && checkedRun.volume === volume ? checkedRun : null;
    function resumeRun() {
        if (!snapshot || !tables || !tables.stats) {
            return;
        }
        const row = tables.stats.card(snapshot.cardId);
        const card = row ? gachaById.get(row.id) : null;
        if (!card) {
            // the saved character no longer resolves to a renderable card —
            // drop the run instead of softlocking the roster
            clearRun();
            say("续档已失效");
            return;
        }
        const savedItems = snapshot.equipment.concat(snapshot.roomClaims.flatMap(claim =>
            (claim.offer || []).map(entry => entry.item).filter(Boolean)
                .concat((claim.drops || []).flatMap(drop => drop.items))));
        if (savedItems.some(item => !canEquipWeapon(item, row))) {
            say("续档中的武器与目录或角色不符，无法继续。");
            return;
        }
        say("从第 " + snapshot.floor + " 层继续……");
        loadCardIntoWorld(row, snapshot);
    }
    const rosterOptions = {
        onCodex: openCodex,
        onAchievements: openAchievements,
        onStorage: openStorage,
        onTrain: function () {
            if (!meta || runPhase !== "selecting" || decisionOpen) { return; }
            decisionOpen = true;
            input.clear();
            activeDecision = showCampTraining({
                cards: rosterSource,
                baseline: world.encounter ? world.encounter.playerLevel : 1,
                describe: function (id, target) {
                    return { gems: meta.gems(), level: meta.levelOf(id), cap: meta.levelCap(id),
                        training: meta.trainingQuote(id, target), limit: meta.limitBreakQuote(id) };
                },
                onTrain: function (id, target) { return meta.train(id, target); },
                onBreak: function (id) { return meta.limitBreak(id); },
                onClose: closeDecision
            });
        },
        onContinue: snapshot ? resumeRun : null,
        skillsTable: tables && tables.skills ? tables.skills : null
    };

    if (!rosterSource.length) {
        // Every first-twelve row missing a gacha card (or an empty unlock
        // intersection) must not softlock the boot: fall back to the open
        // roster so the game is still playable.
        const openRoster = rlRows.filter(function (row) {
            return row.rare === 5 && PLAYABLE_IDS.includes(row.id) && gachaById.has(row.id);
        });
        if (openRoster.length) {
            say("无存档——全员开放");
            return showRoster(openRoster, rosterOptions).then(function (selectedRowId) {
                const row = openRoster.find(function (r) { return r.id === selectedRowId; });
                return loadCardIntoWorld(row);
            }).catch(function (error) {
                if (error && error.message === "Roster selection cancelled") {
                    return loadCardIntoWorld(defaultCard());
                }
                say("加载失败：" + error.message);
                console.error(error);
            });
        }
        return loadCardIntoWorld(defaultCard());
    }

    say("请选择角色……");
    // Play menu BGM during roster selection
    if (bgm) {
        playBGM("menu", { fadeIn: 2000 });
    }

    // Show roster selection UI
    return showRoster(rosterSource, rosterOptions)
        .then(function (selectedRowId) {
            const row = rosterSource.find(function (r) { return r.id === selectedRowId; });
            return loadCardIntoWorld(row);
        })
        .catch(function (error) {
            if (error && error.message === "Roster selection cancelled") {
                say("已取消");
                // Default to Yuno if cancelled
                return loadCardIntoWorld(defaultCard());
            }
            say("加载失败：" + error.message);
            console.error(error);
        });
}

// Tables and three.js load in parallel: neither needs the other, and the world
// has to exist before setup() hands the clock a reference to it.
createStorageStatus({ state: storageState, subscribe: subscribeStorage, retry: retryStorage,
    brand: document.getElementById("bar"),
    onOpen: openStorage,
    onResize: function () { if (renderer) { resize(); } },
    onState: function (state) {
        storageConflict = state.status === "conflict";
        if (storageConflict) {
            input.clear();
            pauseDescent(state.error || "存档已被其他页面修改，请先核对备份。");
        }
        syncWorldFrozen();
    }
});
window.addEventListener("storage", function (event) {
    if (!event.key || event.key.startsWith("kirafan-rl:")) { checkStorageChanges(); }
});
window.addEventListener("focus", checkStorageChanges);
Promise.all([loader.loadModules(), loadTables()]).then(function (booted) {
    tables = booted[1];
    initializeStorage();
    const encounter = encounterFor(volume);
    // Create world BEFORE setup() so world.danmaku.capacity is available.
    // The run seed is floor 1's seed even when booting at a deeper floor
    // (gates jump with ?floor=20): the fight stream is the RUN's, not the
    // floor's, so a jump and an honest descent land in the same rng state.
    world = createWorld({
        volume: volume,
        floor: startFloor,
        floorsPerVolume: VOLUME_FLOORS,
        seed: RUN_SEED,
        tables: tables
            ? { stats: tables.stats, skills: tables.skills, encounter: encounter }
            : null
    });
    setup(booted[0]);
    syncWorldFrozen();
    input.attach(renderer.domElement);
    world.inputState = input.state;
    // Cross-run state (T11): roster gating, run start level, death settle.
    meta = createMeta();
    meta.read();
    // First-run walkthrough: DOM-free, main.js owns the hint line + the
    // one-shot flag. 重新教学 from the howto overlay reuses the same object.
    tutorial = createTutorial({
        onHint: function (step, text) {
            // Write the walkthrough hint directly — setHint yields to the
            // active walkthrough, so this is the only writer that must bypass
            // that guard (a chest/shop beat during the interact step must not
            // replace the step text). The tutorial-active class re-shows the
            // box on touch (body.touch-on hides it) so mobile guidance lives.
            if (!hintBox) {
                return;
            }
            hintBox.classList.add("tutorial-active");
            lastHintText = text;
            hintBox.textContent = text;
            hintBox.hidden = !text;
        },
        onDone: function () {
            if (hintBox) {
                hintBox.classList.remove("tutorial-active");
            }
            setHint(HINT_DEFAULT);
            clearTutorialSafety();
            if (meta) {
                meta.markTutorialSeen();
            }
        }
    });
    // Dialogue (T12): resolver + presenter + one-time validation of every
    // script tag above; the prologue plays once per save, not per boot.
    initDialogue();
    const receipt = loadSlot("lastResult");
    if (receipt && !receipt.acknowledged) {
        // The receipt is presentation data, never an instruction to replay
        // rewards, terminal dialogue, actor loading or the previous battle.
        runPhase = receipt.outcome; input.detach(); syncWorldFrozen();
        runResult = resultSummary(receipt); maybeShowRunResult();
        return;
    }
    // Achievements earned in a previous session unlock retroactively at boot.
    // This runs only AFTER the receipt early-return: the terminal gate boots
    // with an unacknowledged receipt and expects zero storage writes until it
    // is confirmed, so the sweep must never fire on that path.
    sweepAchievements();
    if (meta && !meta.seenPrologue()) {
        queueDialogue("prologue");
        meta.markPrologueSeen();
    }
    if (tables && !encounter) {
        console.warn("no encounters.json row for volume " + volume);
    }
    return loadPlayer();
}).catch(function (error) {
    say("初始化失败：" + error.message
        + (loader.IS_LOCAL_FILE ? "  " + loader.LOCAL_FILE_HINT : ""));
    console.error(error);
});

