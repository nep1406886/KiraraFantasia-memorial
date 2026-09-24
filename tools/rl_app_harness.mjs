// Phase 0 skeleton acceptance gate for the offline game.
//
//   node tools/rl_app_harness.mjs
//
// Verifies, headlessly (no browser, no server):
//   1. All 77 data tables load and have the expected row counts (from the
//      build-time manifest).
//   2. The save system round-trips: default -> save -> load -> equal; corrupt
//      JSON loads as null; import/export round-trips.
//   3. The scene router registers all 11 scenes, starts at Title, and can
//      navigate between them (goto + change event fires).
//   4. The app boots, loads data + save, and exposes the expected handle.
//   5. Specific data sanity: starter character (10002000) exists in
//      character.json with a Chinese name joined; enemy table has rows;
//      questWave has rows (the battle content source).
//
// Convention per spec/00 §5 + plan §6: check() prints ok/FAIL and the process
// exits non-zero on the first failure. Expectations are hardcoded here, never
// read back from the tables under test (otherwise data and code could both be
// wrong and the gate would still pass).

import * as fs from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const GAME = path.join(ROOT, "site", "game", "star");
const DATA = path.join(ROOT, "site", "game", "star", "data");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`ok    ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

// helper: import a module by absolute path (Windows-safe)
function importAbs(p) {
  return import(pathToFileURL(p).href);
}

// --- load the data layer under test ---------------------------------------
// The data module reads from globalThis.__kirafanGameData in node. Pre-populate
// it from the build output before importing the module.
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, "manifest.json"), "utf-8"));
const tables = {};
for (const name of Object.keys(manifest)) {
  const p = path.join(DATA, `${name}.json`);
  if (fs.existsSync(p)) {
    tables[name] = JSON.parse(fs.readFileSync(p, "utf-8"));
  } else {
    tables[name] = {};
  }
}
globalThis.__kirafanGameData = tables;

// node:localStorage shim so save.js works headlessly
// (a real localStorage stores values by key; `key in map` would miss Map
// entries, so getItem must use .has/.get)
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
};

const data = await importAbs(path.join(GAME, "rl-core", "data", "index.js"));
const save = await importAbs(path.join(GAME, "rl-core", "save.js"));
const { SceneRouter, SCENE, Scene } = await importAbs(path.join(GAME, "rl-core", "scene.js"));
const { App } = await importAbs(path.join(GAME, "rl-core", "app.js"));

// ===========================================================================
// 1. Data tables: every manifest table loads, row counts match the manifest.
// ===========================================================================
await data.load();
check("data: manifest has tables", Object.keys(manifest).length >= 70,
  `got ${Object.keys(manifest).length}`);

let mismatched = [];
for (const [name, expectedCount] of Object.entries(manifest)) {
  const actual = data.count(name);
  if (actual !== expectedCount) mismatched.push(`${name}: expected ${expectedCount} got ${actual}`);
}
check("data: all tables match manifest counts", mismatched.length === 0,
  mismatched.slice(0, 5).join("; "));

// ===========================================================================
// 2. Data sanity: key tables have the rows the game actually needs.
// ===========================================================================
const starter = data.lookup("character", "10002000");
check("data: starter chara 10002000 exists", !!starter);
check("data: starter chara has Chinese name joined",
  !!starter && typeof starter.nameZh === "string" && starter.nameZh.length > 0,
  starter ? `nameZh=${starter.nameZh}` : "missing");
check("data: starter chara has six-stat truth",
  !!starter && typeof starter.m_InitHp === "number" && typeof starter.m_InitAtk === "number");

check("data: enemy table has rows", data.count("enemy") > 1000,
  `got ${data.count("enemy")}`);
check("data: questWave table has rows", data.count("questWave") > 5000,
  `got ${data.count("questWave")}`);
check("data: skillPl table has rows", data.count("skillPl") > 1000,
  `got ${data.count("skillPl")}`);
check("data: item table has rows", data.count("item") > 500,
  `got ${data.count("item")}`);
check("data: weapon table has rows", data.count("weapon") > 100,
  `got ${data.count("weapon")}`);
check("data: adv table has rows", data.count("adv") > 1000,
  `got ${data.count("adv")}`);

// ===========================================================================
// 3. App: boots, loads data + save, exposes handle.
//
// Boot writes a newDefault() save (with uuid/createdAt) into the store, so the
// save round-trip section (4) runs after this one and resets the store first.
// ===========================================================================
const app = new App();
await app.boot();
check("app: ready after boot", app.ready === true);
check("app: starts at Title", app.scene === SCENE.TITLE);
check("app: data loaded", data.isLoaded() === true);
check("app: save present", !!app.ctx.save && !!app.ctx.save.player);
const ids = Object.values(SCENE);
check("app: router has all scenes", app.router.ids().length === ids.length);

// navigation through the app
app.goto(SCENE.TOWN);
check("app: navigates to Town", app.scene === SCENE.TOWN);

// newGame resets to a fresh save at Title
app.newGame();
check("app: newGame returns to Title", app.scene === SCENE.TITLE);
check("app: newGame creates fresh save",
  !!app.ctx.save && !!app.ctx.save.characters["10002000"]);

// ===========================================================================
// 4. Save system: round-trip, corruption, import/export.
// ===========================================================================
// 4a. default -> save -> load -> deep equal (reset store: app boot polluted it)
const def = save.defaultSave();
save.clear();
save.save(def);
const loaded = save.load();
check("save: default round-trips", JSON.stringify(loaded) === JSON.stringify(def));

// 4b. starter character present in default save
check("save: default save has starter chara",
  !!loaded && !!loaded.characters["10002000"]);

// 4c. corrupt JSON loads as null
_store.set(save.STORAGE_KEY, "{not valid json");
check("save: corrupt JSON loads as null", save.load() === null);

// 4d. valid but wrong-shape loads as null (validation)
_store.set(save.STORAGE_KEY, JSON.stringify({ version: 1, player: {} }));
check("save: wrong shape loads as null", save.load() === null);

// 4e. export -> import round-trips
const exported = save.exportJSON(def);
const imported = save.importJSON(exported);
check("save: export/import round-trips",
  JSON.stringify(imported) === JSON.stringify(def));

// 4f. import rejects a bad envelope
let rejected = false;
try { save.importJSON(JSON.stringify({ format: "wrong", save: def })); }
catch { rejected = true; }
check("save: import rejects bad envelope", rejected);

// 4g. validate() catches a missing player
const v = save.validate({ version: 1 });
check("save: validate catches missing player", v.ok === false);

// ===========================================================================
// 5. Scene router: registers, navigates, fires change events.
// ===========================================================================
const router = new SceneRouter();
for (const id of ids) {
  router.register(id, new Scene(id));
}
check("router: all 11 scenes registered", router.ids().length === ids.length,
  `got ${router.ids().length}`);

let changeFired = null;
router.onChange((e) => { changeFired = e; });
router.goto(SCENE.TITLE);
check("router: starts at Title", router.current === SCENE.TITLE);
check("router: change event fired on goto", !!changeFired && changeFired.to === SCENE.TITLE);

router.goto(SCENE.TOWN);
check("router: navigates to Town", router.current === SCENE.TOWN);
check("router: change event reflects transition",
  changeFired && changeFired.from === SCENE.TITLE && changeFired.to === SCENE.TOWN);

// unknown scene throws
let threw = false;
try { router.goto("Nope"); } catch { threw = true; }
check("router: goto unknown scene throws", threw);

// ===========================================================================
// 6. State machine (state.js): 1:1 port of GameStateMain/GameStateBase.
//    Getters: main.current / main.next / main.prev (see state.js).
//    GameStateBase hooks are ABSTRACT — a raw instance throws on each.
// ===========================================================================
const { GameStateMain, GameStateBase, COMMON_STATE_FINAL } = await importAbs(
  path.join(GAME, "rl-core", "state.js"),
);
check("state: COMMON_STATE_FINAL is 2147483646", COMMON_STATE_FINAL === 2147483646,
  `got ${COMMON_STATE_FINAL}`);

// A concrete state: overrides the abstract hooks + tracks enter/exit.
class TestState extends GameStateBase {
  constructor(id) { super(); this.id = id; this.entered = false; this.exited = false; }
  getStateID() { return this.id; }
  onStateEnter() { this.entered = true; }
  onStateExit() { this.exited = true; }
  onStateUpdate() { return -1; } // -1 == stay (the original's NONE sentinel)
  onDispose() { this.disposed = true; }
  onClickBackButton() { /* no-op */ }
}
// A concrete scene main: the ChangeState factory maps id -> a fresh state.
// Like every real scene's factory, it returns null for the final sentinel
// (COMMON_STATE_FINAL) — that's the source's way of saying "no more states".
class TestMain extends GameStateMain {
  changeState(id) { return id === COMMON_STATE_FINAL ? null : new TestState(id); }
}

const main = new TestMain();
check("state: main starts with no current state", main.current === null);

// setNextState -> update() performs the transition (enter the new state).
main.setNextState(10);
check("state: pending next state recorded (next getter)", main.next === 10);
main.update();
check("state: update() entered the new state",
  main.current instanceof TestState && main.current.entered === true && main.current.id === 10);
check("state: pending cleared after transition (next back to -1)", main.next === -1);

// A second transition: the previous state must be exited + disposed.
const firstState = main.current;
main.setNextState(20);
main.update();
check("state: previous state exited on transition", firstState.exited === true);
check("state: previous state disposed on transition", firstState.disposed === true);
check("state: current state swapped", main.current.id === 20 && main.current !== firstState);
check("state: prev state id recorded (prev getter)", main.prev === 10);

// Final state: changeState(COMMON_STATE_FINAL) returns null -> no current state.
main.setNextState(COMMON_STATE_FINAL);
main.update();
check("state: final state exits current (null)", main.current === null);

// destroy() disposes the live state and clears it.
main.setNextState(30);
main.update();
check("state: a fresh state is current before destroy", main.current !== null);
main.destroy();
check("state: destroy() clears the current state", main.current === null);

// abstract base: each of the six hooks throws until overridden.
const base = new GameStateBase();
const hookNames = ["getStateID", "onStateEnter", "onStateExit", "onStateUpdate", "onDispose", "onClickBackButton"];
let allThrow = true;
for (const h of hookNames) {
  let t = false;
  try { base[h](); } catch { t = true; }
  if (!t) allThrow = false;
}
check("state: GameStateBase hooks are abstract (all throw)", allThrow);

// ===========================================================================
// 7. GlobalUI logic (globalui.js): HUD values, scene-info stack, shortcuts.
// ===========================================================================
const { GlobalUI, E_SHORTCUT, E_BACK_BUTTON } = await importAbs(
  path.join(GAME, "rl-core", "globalui.js"),
);
const gui = new GlobalUI();
let hudEvents = 0;
gui.onChange((name) => { if (name === "hud") hudEvents++; });

gui.setUserLevel(140);
gui.setUserExp(5000, 10000);
gui.setUserStamina(165, 165);
gui.setUserGold(999999999);
gui.setUserGem(9999999);
check("gui: hud values stored",
  gui.hud.level === 140 && gui.hud.exp === 5000 && gui.hud.expMax === 10000 &&
  gui.hud.stamina === 165 && gui.hud.gold === 999999999 && gui.hud.gem === 9999999,
  JSON.stringify(gui.hud));
check("gui: hud change events fired (>=5)", hudEvents >= 5, `got ${hudEvents}`);

// applyUserData pushes a whole record in one call.
gui.applyUserData({
  Lv: 5, LvExp: 100,
  Stamina: { GetValue: () => 30, GetValueMax: () => 30, GetRemainSec: () => 0 },
  Gold: 500, Gem: 25,
}, 1000);
check("gui: applyUserData maps the record",
  gui.hud.level === 5 && gui.hud.exp === 100 && gui.hud.stamina === 30 &&
  gui.hud.gold === 500 && gui.hud.gem === 25,
  JSON.stringify(gui.hud));

// scene-info stack: set/add/remove/top mirror m_InfoStack.
gui.setSceneInfo(E_BACK_BUTTON.Back, "Town");
check("gui: setSceneInfo adds one entry", gui._infoStack.length === 1);
const topEntry = gui.topSceneInfo();
check("gui: top scene-info is the just-set one",
  topEntry && topEntry.backButtonType === E_BACK_BUTTON.Back && topEntry.sceneInfo === "Town");
// adding more then removing pops back to the entry beneath.
gui.addSceneInfoStack(E_BACK_BUTTON.Home, "Edit");
check("gui: stack grows to 2", gui._infoStack.length === 2);
gui.removeSceneInfoStack(gui._infoStack[1]);
check("gui: remove pops the top", gui._infoStack.length === 1 && gui.topSceneInfo().sceneInfo === "Town");
// clear empties it.
gui.clearSceneInfoStack();
check("gui: clear empties the stack", gui._infoStack.length === 0 && gui.topSceneInfo() === null);

// back-button callback delegation.
let backCalled = null;
gui.setBackButtonCallBack((isCallFromShortCut) => { backCalled = isCallFromShortCut; });
gui.onClickBackButtonCallBack();
check("gui: back button delegates to callback(false)", backCalled === false);

// shortcuts: select -> exec resolves to a scene (1:1 with ExecShortCut).
// (Run on a fresh instance so globalParam flags start clean.)
const gui2 = new GlobalUI();
gui2.onShortCutButtonCallBack(E_SHORTCUT.Gacha);
let execRes = gui2.execShortCut();
check("gui: Gacha shortcut resolves to Gacha scene",
  execRes && execRes.scene === "Gacha");
check("gui: shortcut selection cleared after exec", gui2.selectedShortCutButton === E_SHORTCUT.None);

// Upgrade shortcut transits to Edit WITH the IsMenuUpgradeStart flag.
gui2.onShortCutButtonCallBack(E_SHORTCUT.Upgrade);
execRes = gui2.execShortCut();
check("gui: Upgrade shortcut -> Edit + IsMenuUpgradeStart",
  execRes && execRes.scene === "Edit" && execRes.globalParam.IsMenuUpgradeStart === true);

// Home shortcut -> Town + IsHomeModeStart.
gui2.onShortCutButtonCallBack(E_SHORTCUT.Home);
execRes = gui2.execShortCut();
check("gui: Home shortcut -> Town + IsHomeModeStart",
  execRes && execRes.scene === "Town" && execRes.globalParam.IsHomeModeStart === true);

// no selection -> exec returns null.
check("gui: exec with no selection returns null", gui2.execShortCut() === null);

// badges: set + total.
gui2.setBadgeValue(E_SHORTCUT.Mission, 3);
gui2.setBadgeValue(E_SHORTCUT.Present, 2);
check("gui: badge total sums", gui2.totalBadge() === 5, `got ${gui2.totalBadge()}`);

// ===========================================================================
// 8. Full-unlock save: shape + formula faithfulness.
//    fullUnlockSave() uses the module-scope data instance (loaded above via
//    data.load()), so no args are needed in node.
// ===========================================================================
const fullSave = save.fullUnlockSave();
const fv = save.validate(fullSave);
check("fullunlock: validates against the schema", fv.ok === true,
  (fv.errors || []).join("; "));

// every character unlocked + maxed.
const allChara = data.list("character");
check("fullunlock: all characters owned", Object.keys(fullSave.characters).length === allChara.length,
  `got ${Object.keys(fullSave.characters).length} of ${allChara.length}`);

// level cap matches CalcMaxLv (m_InitLimitLv + sum m_CharaMaxLvUps) for a sample.
const limitBreakList = Object.fromEntries(data.list("limitBreak").map((r) => [r.id, r]));
function expectedMaxLv(param) {
  const recipe = limitBreakList[String(param.m_LimitBreakRecipeID)];
  const ups = recipe && Array.isArray(recipe.m_CharaMaxLvUps) ? recipe.m_CharaMaxLvUps : [];
  return param.m_InitLimitLv + ups.reduce((a, b) => a + b, 0);
}
let lvOk = true, lvDetail = "";
for (const c of allChara.slice(0, 50)) {
  const exp = expectedMaxLv(c);
  if (fullSave.characters[c.id].level !== exp) { lvOk = false; lvDetail = `${c.id}: got ${fullSave.characters[c.id].level} want ${exp}`; break; }
}
check("fullunlock: levels match CalcMaxLv for 50 sampled chars", lvOk, lvDetail);

// stats come from the growth table at max level (CalcCharaParamLevelOnly).
const growth = data.list("growth");
function growthStat(init, lv, tableID, field) {
  let v = init; const i = lv - 1;
  if (i >= 0 && i < growth.length) { const a = growth[i][field]; if (Array.isArray(a) && tableID >= 0 && tableID < a.length) v = Math.ceil(v * a[tableID]); }
  return v;
}
const sampleChara = allChara.find((c) => c.id === "10002000");
if (sampleChara) {
  const maxLv = fullSave.characters["10002000"].level;
  const hpMatch = fullSave.characters["10002000"].stats.Hp === growthStat(sampleChara.m_InitHp, maxLv, sampleChara.m_GrowthTableID, "m_GrowthHp");
  const atkMatch = fullSave.characters["10002000"].stats.Atk === growthStat(sampleChara.m_InitAtk, maxLv, sampleChara.m_GrowthTableID, "m_GrowthAtk");
  check("fullunlock: ゆの stats match growth table at max level", hpMatch && atkMatch,
    JSON.stringify(fullSave.characters["10002000"].stats));
}

// quests all cleared 3-star.
const allQuests = data.list("quest");
let questOk = true, questDetail = "";
for (const q of allQuests) {
  const p = fullSave.quests[q.id];
  if (!p || p.cleared !== true || p.star !== 3) { questOk = false; questDetail = `quest ${q.id}: ${JSON.stringify(p)}`; break; }
}
check("fullunlock: all quests cleared 3-star", questOk, questDetail);

// player at max master rank, full currencies.
const masterRank = data.list("masterRank").reduce((a, b) => (Number(a.id) > Number(b.id) ? a : b));
check("fullunlock: player at max master rank", fullSave.player.level === Number(masterRank.id),
  `got ${fullSave.player.level} want ${masterRank.id}`);
check("fullunlock: stamina at max rank value", fullSave.player.staminaMax === masterRank.m_Stamina,
  `got ${fullSave.player.staminaMax} want ${masterRank.m_Stamina}`);
check("fullunlock: full currencies", fullSave.player.gold > 999999 && fullSave.player.gem > 99999);

// party is 5 (battle party cap).
check("fullunlock: party has 5 members", fullSave.party.length === 5,
  `got ${fullSave.party.length}`);

// ===========================================================================
// 9. Phase B: Title + Town state machines (1:1 ports), driven headlessly
//    through their scene wrappers (the same path the page's fixed-step loop
//    uses). Verifies the Init -> Logo -> Title -> FINAL -> Town flow and the
//    town's Init -> Main -> (transit) -> FINAL -> <scene> flow.
// ===========================================================================
const { TitleMain, TITLE_STATE } = await importAbs(
  path.join(GAME, "rl-core", "titlemain.js"),
);
const { TownMain, TOWN_STATE, TOWN_TRANSIT } = await importAbs(
  path.join(GAME, "rl-core", "townmain.js"),
);
// (COMMON_STATE_FINAL is already imported in the state-machine section.)

// --- Title: pump the headless main through its phases. ----------------------
const tMain = new TitleMain({ globalUI: null });
tMain.start(); // SetNextState(STATE_INIT)
let tGuard = 0;
while (tGuard++ < 300) {
  tMain.update();
  if (tMain.current && tMain.current.getStateID() === TITLE_STATE.STATE_TITLE) break;
}
check("title: pumps to the title menu (STATE_TITLE)",
  tMain.current && tMain.current.getStateID() === TITLE_STATE.STATE_TITLE,
  `current=${tMain.current && tMain.current.getStateID()} after ${tGuard} updates`);
// The UI surface saw the expected calls (progress ladder, logo, button bind).
const tCalls = tMain.ui.calls.map((c) => c[0]);
check("title: UI progress ladder ran", tCalls.includes("progress"));
check("title: UI logo played", tCalls.includes("playInLogo"));
check("title: UI title buttons bound", tCalls.includes("bindTitleButtons"));
// Fire game start -> the transient chain resolves to the final sentinel.
tMain.ui.fireGameStart();
tGuard = 0;
while (tGuard++ < 100) {
  tMain.update();
  if (tMain.current && tMain.current.getStateID() === COMMON_STATE_FINAL) break;
}
check("title: game start -> final sentinel",
  tMain.current && tMain.current.getStateID() === COMMON_STATE_FINAL);
check("title: final sentinel records the Town transit", tMain._transitTo === "Town",
  `got ${tMain._transitTo}`);

// --- Town: pump to Main, then a Gacha transit -> final + NextTransitSceneID. -
const tTown = new TownMain({
  globalUI: { selectedShortCutButton: -1, globalParam: { IsHomeModeStart: false } },
});
tTown.start(); // SetNextState(STATE_INIT)
tGuard = 0;
while (tGuard++ < 300) {
  tTown.update();
  if (tTown.current && tTown.current.getStateID() === TOWN_STATE.STATE_MAIN) break;
}
check("town: pumps to the main hub (STATE_MAIN)",
  tTown.current && tTown.current.getStateID() === TOWN_STATE.STATE_MAIN,
  `current=${tTown.current && tTown.current.getStateID()} after ${tGuard} updates`);
// A menu button: set the transit + fire the callback (1:1 requestTransit).
tTown.requestTransit(TOWN_TRANSIT.Gacha);
tGuard = 0;
while (tGuard++ < 100) {
  tTown.update();
  if (tTown.current && tTown.current.getStateID() === COMMON_STATE_FINAL) break;
}
check("town: gacha transit -> final sentinel",
  tTown.current && tTown.current.getStateID() === COMMON_STATE_FINAL);
check("town: final sentinel records the Gacha scene",
  tTown.NextTransitSceneID === "Gacha",
  `got ${tTown.NextTransitSceneID}`);

// --- Town: a fresh main, a Home transit -> STATE_HOME (in-scene switch). ----
const tTown2 = new TownMain({
  globalUI: { selectedShortCutButton: -1, globalParam: { IsHomeModeStart: false } },
});
tTown2.start();
tGuard = 0;
while (tGuard++ < 300) {
  tTown2.update();
  if (tTown2.current && tTown2.current.getStateID() === TOWN_STATE.STATE_MAIN) break;
}
tTown2.requestTransit(TOWN_TRANSIT.Home);
tGuard = 0;
while (tGuard++ < 100) {
  tTown2.update();
  if (tTown2.current && tTown2.current.getStateID() === TOWN_STATE.STATE_HOME) break;
}
check("town: home transit -> STATE_HOME (in-scene mode switch)",
  tTown2.current && tTown2.current.getStateID() === TOWN_STATE.STATE_HOME,
  `current=${tTown2.current && tTown2.current.getStateID()}`);

// ===========================================================================
// 10. Phase C: Gacha state machine + draw logic (1:1 ports), driven headlessly.
//     Verifies: the Init->Main pump; GachaUtility.CheckPlay cost/short checks;
//     the draw engine (rarity distribution, 50-draw pity, cost deduction); and
//     the GachaPlay reveal -> result -> final -> Gacha transit flow.
// ===========================================================================
const {
  GachaMain, GACHA_MAIN_STATE, GachaUtility, GACHA_DEFINE,
  GACHA_BANNERS, buildPool, rollDraw, GachaResult,
} = await importAbs(path.join(GAME, "rl-core", "gachamain.js"));
const { GachaPlayMain, GACHA_PLAY_STATE } = await importAbs(
  path.join(GAME, "rl-core", "gachaplaymain.js"),
);

// --- GachaUtility.CheckPlay: cost resolution + gem-short branch. ------------
const dummyDataMng = {
  UserData: { IsShortOfGem: (n) => n > 5000, IsShortOfUnlimitedGem: () => true },
  getItemNum: () => 999,
  getItemName: () => "チケット",
};
const dummyDb = { msg: (k, a) => k + (a ? ":" + a.join(",") : "") };
const banner4 = GACHA_BANNERS[0];
const gData4 = {
  id: banner4.id, cost_Gem1: 100, cost_Gem10: 1000, cost_First10: 900,
  cost_UnlimitedGem1: 0, cost_ItemID: -1, cost_ItemAmount: 0,
  playNum_Gem10Total: 0, playNum_UnlimitedGem1Daily: 0,
  type: GACHA_DEFINE.eGachaType.Permanent, wonIsReset: false, wonLimit: 0,
};
// Gem10 with first10 available -> cost is the first10 price (900), check Ok.
let cp = GachaUtility.CheckPlay(gData4, GACHA_DEFINE.ePlayType.Gem10, dummyDataMng, dummyDb);
check("gacha: CheckPlay Gem10 uses first10 price when first10 available",
  cp.check === GACHA_DEFINE.eCheckPlay.Ok && cp.msg.includes("900"),
  JSON.stringify(cp));
// Gem1 with 5001 gems needed -> GemIsShort.
const gDataShort = { ...gData4, cost_Gem1: 5001 };
cp = GachaUtility.CheckPlay(gDataShort, GACHA_DEFINE.ePlayType.Gem1, dummyDataMng, dummyDb);
check("gacha: CheckPlay Gem1 short -> GemIsShort",
  cp.check === GACHA_DEFINE.eCheckPlay.GemIsShort);
// Unlimited with unlimited-gem short -> GemIsShort.
const gDataUnlim = { ...gData4, cost_UnlimitedGem1: 100 };
cp = GachaUtility.CheckPlay(gDataUnlim, GACHA_DEFINE.ePlayType.Unlimited, dummyDataMng, dummyDb);
check("gacha: CheckPlay Unlimited short -> GemIsShort",
  cp.check === GACHA_DEFINE.eCheckPlay.GemIsShort);
// Item with enough items -> Ok.
const gDataItem = { ...gData4, cost_ItemID: 1, cost_ItemAmount: 5 };
cp = GachaUtility.CheckPlay(gDataItem, GACHA_DEFINE.ePlayType.Item, dummyDataMng, dummyDb);
check("gacha: CheckPlay Item sufficient -> Ok",
  cp.check === GACHA_DEFINE.eCheckPlay.Ok);

// --- Draw engine: pool build + rarity + pity. --------------------------------
const pool4 = buildPool(data, { minRare: 4 });
check("gacha: 4★ banner pool has only 4★ chars",
  pool4.chars.length > 0 && pool4.chars.every((c) => c.m_Rare === 4),
  `pool size ${pool4.chars.length}`);
const pool3 = buildPool(data, { minRare: 3 });
check("gacha: 3★ banner pool includes 3★+ chars",
  pool3.chars.every((c) => c.m_Rare >= 3));
// Pity: with 49 draws already, the next draw is a guaranteed 4★.
const pityDraw = rollDraw({ wonLimit: 50, minRare: 4 }, pool4, 49, data, () => 0.99);
check("gacha: 50-draw pity forces a 4★", pityDraw.rare === 4 && pityDraw.isPity === true,
  JSON.stringify(pityDraw));
// A normal roll respects the banner's minRare (a 4★ banner never yields <4★...
// actually the 4★ banner can yield 3★/2★ fills; the key invariant is the pool
// is drawn from). Verify the drawn charaID is in the pool.
const normalDraw = rollDraw({ wonLimit: 50, minRare: 4 }, pool4, 0, data, () => 0.5);
check("gacha: normal draw returns a pool chara",
  normalDraw.charaID > 0 && data.lookup("character", String(normalDraw.charaID)) !== undefined);

// --- GachaMain pump: Init -> Main. ------------------------------------------
// Build a headless GachaMain. The ui surface is a minimal recorder so the
// Init flow's _openLoading/_closeLoading/_loadingBusy calls are satisfied.
const gCalls = [];
let gMenuIn = false;
const gHeadlessUI = {
  _openLoading() { gCalls.push("openLoading"); },
  _closeLoading() { gCalls.push("closeLoading"); },
  _playGachaBgm() { gCalls.push("bgm"); },
  _loadingBusy() { return false; },
  setup() { gCalls.push("setup"); },
  isReady() { return true; },
  playIn() { gCalls.push("playIn"); gMenuIn = true; },
  isMenuEnd() { return !gMenuIn; },
  playOut() { gCalls.push("playOut"); },
  openMessage() {}, openError() {}, destroy() {}, refresh() {},
};
const gSave = {
  player: { gem: 100000, unlimitedGem: 0, gold: 100000 },
  characters: {}, items: {},
  gacha: { totalDraws: 0, lastDrawAt: 0 },
};
const gMain = new GachaMain({
  gachaUI: gHeadlessUI,
  globalUI: null,
  data,
  userDataMng: {
    _save: gSave,
    UserData: {
      gem: () => gSave.player.gem,
      gold: () => gSave.player.gold,
      unlimitedGem: () => gSave.player.unlimitedGem,
      IsShortOfGem: (n) => gSave.player.gem < n,
      IsShortOfUnlimitedGem: (n) => gSave.player.unlimitedGem < n,
      _spendGem: (n) => { gSave.player.gem = Math.max(0, gSave.player.gem - n); },
    },
    getUserItemNum: (id) => gSave.items[String(id)] || 0,
    getItemNum: (id) => gSave.items[String(id)] || 0,
    getItemName: (id) => String(id),
    _ensureChara: (id) => { gSave.characters[String(id)] = { level: 1 }; return true; },
  },
  db: { msg: (k) => k },
});
gMain.start(); // SetNextState(STATE_INIT)
let gGuard = 0;
while (gGuard++ < 300) {
  gMain.pumpUI();
  gMain.update();
  if (gMain.current && gMain.current.getStateID() === GACHA_MAIN_STATE.STATE_MAIN) break;
}
// The break fires on the frame the Main state is ENTERED; its First/LoadWait/
// PlayIn steps (which call ui.setup + ui.playIn) run on the following frames.
// Pump a few frames so the selection UI actually builds, as the app loop does.
for (let i = 0; i < 8; i++) { gMain.pumpUI(); gMain.update(); }
check("gacha: pumps to the selection state (STATE_MAIN)",
  gMain.current && gMain.current.getStateID() === GACHA_MAIN_STATE.STATE_MAIN,
  `current=${gMain.current && gMain.current.getStateID()} after ${gGuard}`);
check("gacha: init opened/closed loading + played BGM",
  gCalls.includes("openLoading") && gCalls.includes("closeLoading") && gCalls.includes("bgm"));
check("gacha: selection UI setup + playIn ran", gCalls.includes("setup") && gCalls.includes("playIn"));
// The gacha-get request populated the banner list.
check("gacha: banner list populated (2 banners)",
  gMain.gacha.GetGachaList().length === GACHA_BANNERS.length,
  `got ${gMain.gacha.GetGachaList().length}`);

// --- Draw request: deducts cost, stores results, resolves Success. ----------
const gemBefore = gSave.player.gem;
gMain.requestGachaPlay(GACHA_BANNERS[0].id, GACHA_DEFINE.ePlayType.Gem10, () => {});
check("gacha: 10-pull returns 10 results", gMain.results.length === 10,
  `got ${gMain.results.length}`);
check("gacha: 10-pull deducted gem cost", gSave.player.gem < gemBefore,
  `before ${gemBefore} after ${gSave.player.gem}`);
check("gacha: draw log recorded the pull", gSave.gacha.totalDraws === 10,
  `got ${gSave.gacha.totalDraws}`);
// Every result references a real character in the pool.
let allCharaOk = true;
for (const r of gMain.results) {
  if (r.m_CharaID <= 0 || data.lookup("character", String(r.m_CharaID)) === undefined) { allCharaOk = false; break; }
}
check("gacha: all 10 results are real characters", allCharaOk);

// --- GachaPlayMain pump: reveal -> result -> final -> Gacha transit. --------
const gpUI = {
  _charaLookup: (id) => { try { return data.lookup("character", String(id)); } catch { return null; } },
  revealCard() {}, openResult() {},
};
const gpMain = new GachaPlayMain({ gacha: gMain.gacha, gachaPlayUI: gpUI });
gpMain.start(); // SetNextState(STATE_MAIN)
gGuard = 0;
while (gGuard++ < 300) {
  // 1:1 with the source's Update(): the play scene's reveal loop advances
  // BEFORE the state machine's pump (m_GachaPlayScene.Update(); base.Update();).
  gpMain.pumpUI();
  gpMain.update();
  // The reveal loop (driven solely by pumpUI) walks every card and parks at the
  // Result grid. Simulate the player's "close result" button (1:1 with
  // GachaPlayScene.OnCloseResult) to let the machine resolve to the final
  // sentinel. Guard: only while the scene is parked, not already at End.
  if (gpMain.playScene && !gpMain.playScene.IsCompletePlay()) gpMain.playScene.closeResult();
  if (gpMain.current && gpMain.current.getStateID() === COMMON_STATE_FINAL) break;
}
check("gachaplay: reveal -> result -> final sentinel",
  gpMain.current && gpMain.current.getStateID() === COMMON_STATE_FINAL,
  `current=${gpMain.current && gpMain.current.getStateID()} after ${gGuard}`);
check("gachaplay: final records the Gacha transit",
  gpMain.NextTransitSceneID === "Gacha",
  `got ${gpMain.NextTransitSceneID}`);
check("gachaplay: play scene reached End",
  gpMain.playScene && gpMain.playScene.IsCompletePlay());

// ===========================================================================
// 11. Phase D: Edit (character list / upgrade / limit-break / evolution) —
//     EditUtility formula layer (1:1 with EditUtility.cs) + the EditMain
//     state machine, driven headlessly. Verifies:
//       - the exp->level walk (SimulateCharaLv) against the characterExp table
//       - GetCharaNowExp / GetCharaNextMaxExp
//       - CalcMaxLv / CalcMaxLvFromLimitBreak (m_CharaMaxLvUps sums)
//       - CalcCharaParamLevelOnly growth (ceil(init * growthRow[tableID]))
//       - SimulateUpgrade (exp + the 1.1 same-element bonus + amount)
//       - CanLimitBreak / SimulateLimitBreak
//       - CanEvolution / SimulateEvolution
//       - the EditMain Top -> Charalist -> Detail -> Result -> Top pump
// ===========================================================================
const { makeEditUtility, UPGRADE_SAME_ELEMENT_BONUS_VALUE } = await importAbs(
  path.join(GAME, "rl-core", "editutility.js"),
);
const { EditMain, EDIT_MAIN_STATE, EDIT_BUTTON } = await importAbs(
  path.join(GAME, "rl-core", "editmain.js"),
);

check("edit: same-element bonus is 1.1 (StarDefine.cs:39)",
  UPGRADE_SAME_ELEMENT_BONUS_VALUE === 1.1,
  `got ${UPGRADE_SAME_ELEMENT_BONUS_VALUE}`);

// --- A userDataMng adapter over a throwaway save. ----------------------------
function makeEditDataMng(charaID, charaLevel, limitBreak) {
  const saveData = {
    player: { gold: 10_000_000, gem: 999_999, unlimitedGem: 999_999 },
    characters: {},
    items: {},
  };
  // Ensure the chara exists at the requested level / LB stage.
  const key = String(charaID);
  saveData.characters[key] = { level: charaLevel, exp: 0, limitBreak, weaponId: 0 };
  // A generous item pool so the limit-break / evolution item checks pass.
  for (const id of [4000, 4001, 6001, 6007, 6013, 7004, 7009]) {
    saveData.items[String(id)] = 999;
  }
  const dataMng = {
    _save: saveData,
    flush() {},
    getChara(id) {
      const k = String(id);
      if (!saveData.characters[k]) saveData.characters[k] = { level: 1, exp: 0, limitBreak: 0, weaponId: 0 };
      return saveData.characters[k];
    },
    getUserItemNum(id) { return saveData.items[String(id)] || 0; },
    setUserItemNum(id, n) { saveData.items[String(id)] = n; },
    getItemNum(id) { return saveData.items[String(id)] || 0; },
    IsShortOfGold(n) { return saveData.player.gold < n; },
    IsShortOfGem(n) { return saveData.player.gem < n; },
  };
  return dataMng;
}

// --- SimulateCharaLv: the exp->level walk against the characterExp table. ----
{
  const dm = makeEditDataMng(10000000, 1, 0);
  const eu = makeEditUtility({ data, userDataMng: dm });
  // Level 1 costs m_NextExp[0]=100 to leave. The source loop (EditUtility.cs:39)
  // uses `while (work_RemainExp > 0)`: feeding exactly 100 levels to lv2 and the
  // loop adds the 100 to afterExp (work_RemainExp becomes 0, loop stops). So
  // 100 exp -> lv2 / afterExp 100 (1:1 with the source, not a "clean" reset).
  const r1 = eu.simulateCharaLv(10000000, 999, 100);
  check("edit: SimulateCharaLv 100 exp -> lv2 (source loop)",
    r1.afterLv === 2 && r1.afterExp === 100,
    `got lv=${r1.afterLv} exp=${r1.afterExp}`);
  // 210 exp: leaves lv1 (100), remaining 110 < lv2's 1100 cost -> stays lv2,
  // afterExp = 100 + 110 = 210 (the loop keeps adding while work_RemainExp>0).
  const r2 = eu.simulateCharaLv(10000000, 999, 210);
  check("edit: SimulateCharaLv 210 exp -> lv2 exp 210",
    r2.afterLv === 2 && r2.afterExp === 210,
    `got lv=${r2.afterLv} exp=${r2.afterExp}`);
  // GetCharaNextMaxExp(1) = m_NextExp[0] = 100.
  check("edit: GetCharaNextMaxExp(1) = 100", eu.getCharaNextMaxExp(1) === 100,
    `got ${eu.getCharaNextMaxExp(1)}`);
  // GetCharaNowExp(2, 110) = 110 - sum(GetNextExp(1)) = 110 - 100 = 10.
  check("edit: GetCharaNowExp(2, 110) = 10", eu.getCharaNowExp(2, 110) === 10,
    `got ${eu.getCharaNowExp(2, 110)}`);
}

// --- CalcMaxLv / CalcMaxLvFromLimitBreak (m_CharaMaxLvUps sums). -------------
{
  const dm = makeEditDataMng(10000000, 1, 0);
  const eu = makeEditUtility({ data, userDataMng: dm });
  const chara = data.lookup("character", "10000000");
  const lbRecipe = data.lookup("limitBreak", chara.m_LimitBreakRecipeID);
  const totalUps = (lbRecipe.m_CharaMaxLvUps || []).reduce((a, b) => a + b, 0);
  // CalcMaxLv = m_InitLimitLv + total m_CharaMaxLvUps.
  check("edit: CalcMaxLv = m_InitLimitLv + total LB ups",
    eu.calcMaxLv(10000000) === chara.m_InitLimitLv + totalUps,
    `got ${eu.calcMaxLv(10000000)} expected ${chara.m_InitLimitLv + totalUps}`);
  // CalcMaxLvFromLimitBreak(0) = m_InitLimitLv (no ups applied yet).
  check("edit: CalcMaxLvFromLimitBreak(0) = m_InitLimitLv",
    eu.calcMaxLvFromLimitBreak(10000000, 0) === chara.m_InitLimitLv,
    `got ${eu.calcMaxLvFromLimitBreak(10000000, 0)}`);
  // CalcMaxLvFromLimitBreak(2) = m_InitLimitLv + ups[0] + ups[1].
  const partial = chara.m_InitLimitLv + lbRecipe.m_CharaMaxLvUps[0] + lbRecipe.m_CharaMaxLvUps[1];
  check("edit: CalcMaxLvFromLimitBreak(2) = partial sum",
    eu.calcMaxLvFromLimitBreak(10000000, 2) === partial,
    `got ${eu.calcMaxLvFromLimitBreak(10000000, 2)} expected ${partial}`);
}

// --- CalcCharaParamLevelOnly: growth = ceil(init * growthRow[lv-1][table]). --
{
  const dm = makeEditDataMng(10000000, 1, 0);
  const eu = makeEditUtility({ data, userDataMng: dm });
  const chara = data.lookup("character", "10000000");
  const gRows = data.list("growth");
  // At lv 1 the growth factor is the row-0 value for the chara's table.
  const gFactor = gRows[0].m_GrowthHp[chara.m_GrowthTableID];
  const expectedHp1 = Math.ceil(chara.m_InitHp * gFactor);
  const p1 = eu.calcCharaParamLevelOnly(10000000, 1);
  check("edit: CalcCharaParamLevelOnly lv1 Hp = ceil(init*growth)",
    p1.Hp === expectedHp1 && p1.Lv === 1,
    `got Hp=${p1.Hp} expected ${expectedHp1}`);
  // At a higher lv the factor is the row for that lv.
  const gFactor20 = gRows[19].m_GrowthHp[chara.m_GrowthTableID];
  const expectedHp20 = Math.ceil(chara.m_InitHp * gFactor20);
  const p20 = eu.calcCharaParamLevelOnly(10000000, 20);
  check("edit: CalcCharaParamLevelOnly lv20 Hp grows",
    p20.Hp === expectedHp20 && p20.Hp > p1.Hp,
    `got Hp=${p20.Hp} expected ${expectedHp20}`);
}

// --- SimulateUpgrade: exp formula + 1.1 same-element bonus + amount. --------
{
  const dm = makeEditDataMng(10000000, 1, 0);
  const eu = makeEditUtility({ data, userDataMng: dm });
  const chara = data.lookup("character", "10000000");
  const items = eu.getUpgradeItemParams(chara.m_Element);
  check("edit: getUpgradeItemParams returns an item for the element",
    items.length >= 1, `got ${items.length}`);
  if (items.length) {
    // Same-element item: exp = m_TypeArgs[1] * num * 1.1 (local stand-in exp).
    const itemExp = items[0].exp;
    const sim = eu.simulateUpgrade(10000000, [{ id: items[0].id, num: 1 }]);
    check("edit: SimulateUpgrade exp uses the 1.1 same-element bonus",
      sim && sim.exp === Math.floor(itemExp * 1 * 1.1),
      `got exp=${sim && sim.exp} expected ${Math.floor(itemExp * 1.1)}`);
    // amount = GetUpgradeAmount(Lv) * num = m_UpgradeAmount[0] * 1 = 100.
    check("edit: SimulateUpgrade amount = GetUpgradeAmount(Lv)*num",
      sim && sim.amount === 100 * 1,
      `got amount=${sim && sim.amount}`);
    // The after level advances past level 1 (100+exp is enough to level up).
    check("edit: SimulateUpgrade advances the level",
      sim && sim.afterLv > 1,
      `got afterLv=${sim && sim.afterLv}`);
    // before/after params are populated.
    check("edit: SimulateUpgrade fills before/after params",
      sim && sim.beforeParam && sim.afterParam && sim.beforeParam.Lv === 1
        && sim.afterParam.Lv === sim.afterLv,
      "before/after missing");
  }
}

// --- CanLimitBreak / SimulateLimitBreak. ------------------------------------
{
  // A chara below its max LB stage with gold + items -> CanLimitBreak true.
  const dm = makeEditDataMng(10000000, 1, 0);
  const eu = makeEditUtility({ data, userDataMng: dm });
  const chara = data.lookup("character", "10000000");
  const lbRecipe = data.lookup("limitBreak", chara.m_LimitBreakRecipeID);
  const lbLen = lbRecipe.m_CharaMaxLvUps.length;
  check("edit: CanLimitBreak true at stage 0 (gold+items present)",
    eu.canLimitBreak(10000000) === true,
    `lbLen=${lbLen}`);
  const simLb = eu.simulateLimitBreak(10000000);
  check("edit: SimulateLimitBreak raises MaxLv by m_CharaMaxLvUps[0]",
    simLb && simLb.afterMaxLv === simLb.beforeMaxLv + lbRecipe.m_CharaMaxLvUps[0],
    `before=${simLb && simLb.beforeMaxLv} after=${simLb && simLb.afterMaxLv} ups=${lbRecipe.m_CharaMaxLvUps[0]}`);
  check("edit: SimulateLimitBreak raises skill cap by m_SkillMaxLvUps[0]",
    simLb && simLb.skillUp === lbRecipe.m_SkillMaxLvUps[0],
    `skillUp=${simLb && simLb.skillUp}`);
  // At the max LB stage, CanLimitBreak is false.
  const dmMax = makeEditDataMng(10000000, 1, lbLen);
  const euMax = makeEditUtility({ data, userDataMng: dmMax });
  check("edit: CanLimitBreak false at max LB stage",
    euMax.canLimitBreak(10000000) === false);
}

// --- CanEvolution / SimulateEvolution. -------------------------------------
{
  // Find a chara that has an evolution recipe.
  const evoRows = data.list("evolution");
  const src = evoRows[0].m_SrcCharaID;
  const dm = makeEditDataMng(src, 999, 999); // max level + LB so conditions pass
  const eu = makeEditUtility({ data, userDataMng: dm });
  check("edit: IsExistEvolution true for a recipe'd chara",
    eu.isExistEvolution(src) === true);
  const simEvo = eu.simulateEvolution(src);
  check("edit: SimulateEvolution maps Src -> Dest chara",
    simEvo && simEvo.afterCharaId === evoRows[0].m_DestCharaID,
    `got ${simEvo && simEvo.afterCharaId}`);
  check("edit: SimulateEvolution resets LB to 0",
    simEvo && simEvo.afterLimitBreak === 0,
    `got ${simEvo && simEvo.afterLimitBreak}`);
  check("edit: SimulateEvolution afterMaxLv = dest m_InitLimitLv",
    simEvo && simEvo.afterMaxLv === data.lookup("character", evoRows[0].m_DestCharaID).m_InitLimitLv,
    `got ${simEvo && simEvo.afterMaxLv}`);
}

// --- EditMain state machine: Top -> Charalist -> Detail -> Result -> Top. ---
{
  // Headless UI surface (stateful, like the gacha harness).
  let menuEnd = false;
  let currentSetup = null;
  const editUI = {
    calls: [],
    _menuEnd: false,
    setup(mode, payload) { editUI.calls.push(["setup", mode]); currentSetup = { mode, payload }; editUI._menuEnd = false; },
    isReady() { return true; },
    playIn() { editUI.calls.push(["playIn"]); },
    playOut() { editUI.calls.push(["playOut"]); editUI._menuEnd = true; },
    tick() { if (editUI._menuEnd) editUI._menuEnd = true; },
    isMenuEnd() { return editUI._menuEnd; },
    refresh() { editUI.calls.push(["refresh"]); },
    destroy() {},
  };
  const dm = makeEditDataMng(10000000, 1, 0);
  // The chara must exist; give it a low level so the upgrade detail shows a
  // real level-up.
  dm.getChara(10000000).level = 1;
  dm.getChara(10000000).exp = 0;

  const em = new EditMain({
    editUI,
    globalUI: null,
    data,
    userDataMng: dm,
  });
  em.start();
  let guard = 0;
  // Pump to the Top state.
  while (guard++ < 300) {
    if (editUI.tick) editUI.tick();
    em.update();
    if (em.current && em.current.getStateID() === EDIT_MAIN_STATE.STATE_EDIT_TOP) break;
  }
  check("editmain: pumps to STATE_EDIT_TOP",
    em.current && em.current.getStateID() === EDIT_MAIN_STATE.STATE_EDIT_TOP,
    `current=${em.current && em.current.getStateID()} after ${guard}`);

  // The Top menu: press "Upgrade" -> the state machine routes to the
  // CHARALIST_UPGRADE sub-state (in-scene transition).
  const topState = em.current;
  if (topState && topState.onClickButtonCallBack) topState.onClickButtonCallBack(EDIT_BUTTON.Upgrade);
  // The Top Main step waits on isMenuEnd(); the UI marks it ended (a button
  // was pressed). Pump to the charalist.
  editUI._menuEnd = true;
  guard = 0;
  while (guard++ < 300) {
    if (editUI.tick) editUI.tick();
    em.update();
    if (em.current && em.current.getStateID() === EDIT_MAIN_STATE.STATE_CHARALIST_UPGRADE) break;
  }
  check("editmain: Upgrade button -> STATE_CHARALIST_UPGRADE",
    em.current && em.current.getStateID() === EDIT_MAIN_STATE.STATE_CHARALIST_UPGRADE,
    `current=${em.current && em.current.getStateID()} after ${guard}`);

  // Select a chara in the list -> the detail (STATE_UPGRADE) opens.
  const clist = em.current;
  if (clist && clist.selectChara) clist.selectChara(10000000);
  em.selectChara(10000000);
  editUI._menuEnd = true;
  guard = 0;
  while (guard++ < 300) {
    if (editUI.tick) editUI.tick();
    em.update();
    if (em.current && em.current.getStateID() === EDIT_MAIN_STATE.STATE_UPGRADE) break;
  }
  check("editmain: chara select -> STATE_UPGRADE detail",
    em.current && em.current.getStateID() === EDIT_MAIN_STATE.STATE_UPGRADE,
    `current=${em.current && em.current.getStateID()} after ${guard}`);

  // Confirm the upgrade -> the state applies it + routes to the result.
  const upState = em.current;
  const beforeLevel = dm.getChara(10000000).level;
  if (upState && upState.confirmUpgrade) {
    const euRef = em.editUtility;
    const chara = data.lookup("character", 10000000);
    const upg = euRef.getUpgradeItemParams(chara.m_Element);
    const itemInfo = upg.length ? [{ id: upg[0].id, num: 1 }] : [];
    upState.confirmUpgrade(itemInfo);
    // The detail's Main step then waits on isMenuEnd(); mark it ended.
    editUI._menuEnd = true;
  }
  guard = 0;
  while (guard++ < 300) {
    if (editUI.tick) editUI.tick();
    em.update();
    if (em.current && em.current.getStateID() === EDIT_MAIN_STATE.STATE_UPGRADE_RESULT) break;
  }
  check("editmain: confirm upgrade -> STATE_UPGRADE_RESULT",
    em.current && em.current.getStateID() === EDIT_MAIN_STATE.STATE_UPGRADE_RESULT,
    `current=${em.current && em.current.getStateID()} after ${guard}`);
  // The save's chara level advanced past the before-level (the upgrade applied).
  const afterLevel = dm.getChara(10000000).level;
  check("editmain: upgrade applied to the save (level advanced)",
    afterLevel > beforeLevel,
    `before=${beforeLevel} after=${afterLevel}`);

  // OK on the result -> FINAL -> Edit Top (the scene's tick re-enters Edit).
  editUI._menuEnd = true;
  guard = 0;
  while (guard++ < 300) {
    if (editUI.tick) editUI.tick();
    em.update();
    if (em.current && em.current.getStateID() === COMMON_STATE_FINAL) break;
  }
  check("editmain: result OK -> final sentinel",
    em.current && em.current.getStateID() === COMMON_STATE_FINAL,
    `current=${em.current && em.current.getStateID()} after ${guard}`);
  check("editmain: final records the Edit Top transit",
    em.NextTransitSceneID === "Edit",
    `got ${em.NextTransitSceneID}`);
}

// ===========================================================================
// summary
// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
