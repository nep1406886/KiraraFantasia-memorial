// Boot and shell. Owns the viewport scale, the fixed-step loop, and the
// action bridge between the DOM UI and the simulation.

import { VIEW_W, VIEW_H, BGM, BOONS } from "./config.js";
import { loadSave } from "./save.js";
import { Input } from "./input.js";
import { AudioSys } from "./audio.js";
import { WorldRenderer, Effects } from "./render2d.js";
import { Stage3D } from "./models.js";
import { StarfallGame } from "./game.js";
import { UI } from "./ui.js";

const stageEl = document.getElementById("stage");
const worldCanvas = document.getElementById("world-canvas");
const modelCanvas = document.getElementById("model-canvas");
const fxCanvas = document.getElementById("fx-canvas");
const touchRoot = document.getElementById("touch-controls");

const save = loadSave();
document.body.classList.toggle("reduced-motion", save.settings.reducedMotion);

const audio = new AudioSys(save.settings);
audio.setVolumes(save.settings);
const effects = new Effects();
const renderer = new WorldRenderer(worldCanvas, fxCanvas);
const input = new Input();
input.attachTouch(touchRoot);

let stage = null;
try {
  stage = new Stage3D(modelCanvas);
} catch (error) {
  console.error("starfall 3D layer unavailable:", error);
  document.getElementById("loading").classList.remove("hidden");
  document.getElementById("loading-text").textContent = "无法创建 3D 画布。请尝试更新浏览器，或打开硬件加速后再来。";
  document.getElementById("loading-bar").style.width = "100%";
  throw error;
}

let game = null;

const actions = {
  startPressed: () => game.startPressed(),
  continuePressed: () => game.continuePressed(),
  beginRun: index => game.beginRun(index),
  backToTitle: () => game.backToTitle(),
  pause: () => game.pause(),
  boons: () => {
    if (game.state === "playing") {
      game.pause();
      game.openBoonList();
    }
  },
  openStarMap: () => game.openStarMap(game.state === "result" ? "result" : game.state === "playing" || game.state === "paused" ? "pause" : "title"),
  openHelp: () => game.openHelp(game.state === "result" ? "result" : game.state === "playing" || game.state === "paused" ? "pause" : "title"),
  openSettings: () => game.openSettings(game.state === "result" ? "result" : game.state === "playing" || game.state === "paused" ? "pause" : "title"),
  overlayClose: () => {
    const ui = game?.ui;
    if (!ui) return;
    if (ui.overlayKind === "pause") game.resume();
    else ui.closeOverlay();
  }
};

const ui = new UI(actions, audio);
game = new StarfallGame({ ui, input, audio, save, renderer, stage, effects });

// ---------------------------------------------------------------- viewport
const touchDevice = (() => {
  try { return matchMedia("(pointer: coarse)").matches || "ontouchstart" in window; }
  catch (error) { return false; }
})();
let lastTouchVisible = null;
let lastPortraitHint = 0;

function resize() {
  const scale = Math.min(innerWidth / VIEW_W, innerHeight / VIEW_H);
  stageEl.style.transform = "scale(" + scale + ")";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderScale = Math.max(0.6, Math.min(scale * dpr, 2.4));
  renderer.resize(VIEW_W, VIEW_H, renderScale, scale);
  stage.resize(VIEW_W, VIEW_H, renderScale);
  if (game) game.render();
  if (touchDevice && innerHeight > innerWidth && innerWidth < 820 && performance.now() - lastPortraitHint > 20000) {
    lastPortraitHint = performance.now();
    ui.showRotateHint();
  }
}

addEventListener("resize", resize);
addEventListener("orientationchange", () => setTimeout(resize, 180));

// ---------------------------------------------------------------- audio unlock
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  audio.unlock();
  if (game) audio.playBgm(game.state === "title" || game.state === "select" ? BGM.title : BGM.battle[0]);
}
addEventListener("pointerdown", unlockAudio, { once: true });
addEventListener("keydown", unlockAudio, { once: true });

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    audio.suspendBgm();
    if (game && (game.state === "playing" || game.state === "dying") && !game.paused) game.pause();
  } else {
    audio.resumeBgm();
  }
});

// ---------------------------------------------------------------- loop
const STEP = 1 / 60;
let last = performance.now();
let accumulator = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  accumulator += dt;
  let steps = 0;
  while (accumulator >= STEP && steps < 4) {
    game.update(STEP);
    input.endFrame();
    accumulator -= STEP;
    steps++;
  }
  if (accumulator > 0.2) accumulator = 0;
  game.render();

  const showTouch = touchDevice && game.state === "playing";
  if (showTouch !== lastTouchVisible) {
    lastTouchVisible = showTouch;
    ui.setTouchVisible(showTouch);
  }
  requestAnimationFrame(frame);
}

game.showTitle();
resize();
requestAnimationFrame(frame);

// A small debug surface keeps the browser acceptance harness honest without
// teaching it private object shapes.
window.__starfall = {
  game,
  ui,
  audio,
  save,
  input,
  stage,
  startRun: async (index = 0) => {
    game.introSeen = true;
    await game.beginRun(index);
  },
  continueRun: () => game.continuePressed(),
  showSelect: () => game.showSelect(),
  showTitle: () => game.showTitle(),
  state: () => game.state,
  room: () => game.room && { type: game.room.type, w: game.room.w, act: game.run.actIndex, index: game.run.roomIndex },
  player: () => game.player && { x: game.player.x, y: game.player.y, hp: game.player.hp, maxHp: game.player.maxHp, dead: game.player.dead },
  run: () => game.run && {
    act: game.run.actIndex, room: game.run.roomIndex, hp: game.run.hp, maxHp: game.run.maxHp,
    dust: game.run.dust, kills: game.run.kills, boons: { ...game.run.boons }, ult: game.run.ult
  },
  enemies: () => game.enemies.map(e => ({ type: e.type, hp: e.hp, maxHp: e.maxHp, x: e.x, dead: e.dead, boss: e.isBoss })),
  teleport: (x, y = 438) => { if (game.player) { game.player.x = x; game.player.y = y; game.player.vy = 0; } },
  hurt: amount => game.hurtPlayer(amount, game.player.x + 40),
  heal: amount => game.healPlayer(amount),
  giveDust: amount => { game.run.dust += amount; game.ui.setDust(game.run.dust); },
  addBoon: id => {
    const boon = BOONS.find(b => b.id === id);
    if (boon) game.addBoon(boon);
  },
  clearRoom: () => game.clearRoom(),
  killAll: () => { for (const enemy of game.enemies) if (!enemy.dead) game.killEnemy(enemy); },
  openBoon: () => game.openBoonOffer(false),
  jumpRoom: async (act = 0, roomIndex = 0) => {
    if (!game.run) return false;
    game.run.actIndex = Math.max(0, Math.min(2, act));
    game.run.roomIndex = Math.max(0, roomIndex);
    await game.enterRoom({ first: false });
    return true;
  },
  spawnEnemy: async (type = "blot") => {
    const enemy = await game.createEnemy({ type }, { x: game.player.x + 180, y: 438 });
    game.enemies.push(enemy);
    return true;
  },
  stage,
  renderer
};
