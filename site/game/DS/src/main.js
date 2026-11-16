// ============================================================
// 入口：启动、加载、状态机与主循环
// ============================================================
import { G, resetStyle, clearCombat } from './state.js';
import { W, H, STEP, SCENES } from './config.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { Save } from './core/save.js';
import { preloadAssets } from './core/assets.js';
import { UI } from './ui.js';
import { beginRun, updateRun, finishRun, abandonRun, createRun, openShop, openRest, openEvent, openTreasure, openBoonReward, afterReward, showNextChoices, startCombatRoom } from './run.js';
import { renderGame } from './renderer.js';
import { FX } from './fx.js';
import { CHAR_MAP } from './data/characters.js';
import { Enemy, Boss } from './enemies.js';

let canvas;
let ctx;
let dpr = 1;
let last = 0;
let acc = 0;
const navStack = [];

function setCanvas() {
  canvas = document.getElementById('game');
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx = canvas.getContext('2d', { alpha: false });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

// 页面尺寸由 CSS 缩放（#stage 恒定 16:9），仅当跨屏导致 DPR 变化时才重建画布
window.addEventListener('resize', () => {
  const nd = Math.min(2, window.devicePixelRatio || 1);
  if (nd !== dpr) setCanvas();
}, { passive: true });

function navPush() {
  const cur = G.mode;
  if (cur && cur !== 'settings' && cur !== 'help') navStack.push(cur);
}

function goBack() {
  const target = navStack.pop() || (G.run && !G.run.finished ? 'pause' : 'hub');
  if (target === 'pause' && G.run && !G.run.finished) {
    G.mode = 'pause';
    UI.showPause(G.run);
    Audio.duck(true);
  } else if (target === 'hub') {
    toHub();
  } else if (target === 'title') {
    toTitle();
  } else if (target === 'select') {
    openSelect();
  } else if (target === 'upgrades') {
    G.mode = 'upgrades';
    UI.showUpgrades();
  } else if (target === 'codex') {
    G.mode = 'codex';
    UI.showCodex();
  } else if (target === 'pause') {
    G.mode = 'pause';
    UI.showPause(G.run);
  } else {
    toHub();
  }
}

function toTitle() {
  G.run = null; G.room = null; G.player = null;
  clearCombat();
  FX.clear();
  resetStyle();
  G.mode = 'title';
  UI.hideHud();
  UI.hideAllScreens();
  UI.showTitle();
  navStack.length = 0;
}

function toHub() {
  G.run = null; G.room = null; G.player = null;
  clearCombat();
  FX.clear();
  resetStyle();
  G.mode = 'hub';
  UI.hideHud();
  UI.hideAllScreens();
  UI.showHub();
  navStack.length = 0;
}

function openSelect() {
  G.mode = 'select';
  UI.hideHud();
  UI.hideAllScreens();
  UI.showSelect(false);
  navStack.length = 0;
}
function openRoster() {
  G.mode = 'select';
  UI.hideHud();
  UI.hideAllScreens();
  UI.showSelect(true);
  navStack.length = 0;
}
function openUpgrades() { navPush(); G.mode = 'upgrades'; UI.showUpgrades(); }
function openCodex() { navPush(); G.mode = 'codex'; UI.showCodex(); }
function openHelp() { navPush(); G.mode = 'help'; UI.showHelp(); }
function openSettings() { navPush(); G.mode = 'settings'; UI.showSettings(); }

function pauseGame() {
  if (G.mode !== 'playing' || !G.run) return;
  G.mode = 'pause';
  G.paused = true;
  UI.showPause(G.run);
  Audio.duck(true);
  Input.clear();
}
function resumeGame() {
  if (!G.run) return;
  G.mode = 'playing';
  G.paused = false;
  UI.hideAllScreens();
  UI.setHudVisible(true);
  // 与开演时同一口径：手动开启，或触屏设备未明确关闭（否则真机暂停后触屏层会消失）
  UI.setTouchVisible(UI.touchDesired());
  Audio.duck(false);
  Input.clear();
}

function again() {
  G.mode = 'select';
  UI.hideHud();
  UI.hideAllScreens();
  UI.showSelect(false);
  navStack.length = 0;
}

function switchTo(index) {
  if (G.mode !== 'playing' || !G.player) return;
  if (G.player.switchCd > 0) { UI.toast('换演还在冷却'); return; }
  const m = G.run.team[index];
  if (!m || m.downed) { UI.toast('这位演员已经退场'); return; }
  if (index === G.run.active) return;
  G.player.switchTo(index, false);
}

function setupHandlers() {
  // 切到后台时自动暂停，避免回来时场上局势已经变了
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && G.mode === 'playing' && !G.paused) pauseGame();
  });
  UI.init({
    toTitle, toHub, openSelect, openRoster, openUpgrades, openCodex,
    openHelp, openSettings, back: goBack, pause: pauseGame, resume: resumeGame,
    abandon: () => {
      if (!G.run) return;
      if (!window.confirm('要中止今晚的演出吗？当前进度不会保留，但掌声仍会结算。')) return;
      UI.hideAllScreens();
      UI.hideHud();
      Audio.duck(false);
      abandonRun();
    },
    again,
    switchTo,
    beginRun: (team) => {
      if (!Array.isArray(team) || team.length !== 3) return;
      navStack.length = 0;
      UI.setHudVisible(true);
      UIColorReset();
      beginRun(team);
    },
  });
}

function UIColorReset() {
  // 让每次开演都重新构建 HUD
  UI.hudBuilt = false;
  UI.boonCount = -1;
  UI.lastBanner = null;
  UI.lastUlt = null;
  UI.lastCallout = null;
}

function handleKeys() {
  if (Input.pressed('pause')) {
    if (G.mode === 'playing') pauseGame();
    else if (G.mode === 'pause') resumeGame();
    else if (G.mode === 'settings' || G.mode === 'help') goBack();
  }
  if (G.mode === 'title' && Input.pressed('confirm')) {
    toHub();
  }
  if (G.mode === 'result' && Input.pressed('confirm')) {
    again();
  }
  if (G.mode === 'pause' && Input.pressed('swap')) {
    // 暂停时 Shift 不做事，避免误触
  }
}

function renderMenuBackdrop(t) {
  if (!ctx) return;
  const g = ctx.createRadialGradient(W * .5, H * .42, 20, W * .5, H * .42, W * .72);
  g.addColorStop(0, '#171024');
  g.addColorStop(.55, '#0c0814');
  g.addColorStop(1, '#050409');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 缓慢漂浮的金尘
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 26; i++) {
    const x = ((i * 137 + t * (6 + i % 5)) % (W + 40)) - 20;
    const y = ((i * 83 + t * (3 + i % 3)) % (H + 40)) - 20;
    const a = .06 + .09 * Math.sin(t * 1.1 + i);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#e8c47e';
    ctx.beginPath();
    ctx.arc(x, y, 1 + (i % 3) * .6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function shouldRenderGame() {
  if (!G.room || !G.run || !G.player) return false;
  if (G.mode === 'result') return false;
  if (G.mode === 'title' || G.mode === 'hub' || G.mode === 'select' || G.mode === 'codex' || G.mode === 'upgrades') return false;
  return true;
}

function frame(now) {
  requestAnimationFrame(frame);
  const raw = last ? Math.min(.06, (now - last) / 1000) : 0;
  last = now;
  G.time += raw;
  G.dt = raw;
  G.frame += 1;
  Input.update();
  handleKeys();

  if (G.hitstop > 0) {
    G.hitstop = Math.max(0, G.hitstop - raw);
    acc = 0;
  } else if (G.mode === 'playing' && !G.paused) {
    Input.replay(); // 兑现命中停顿期间按下的输入，连打不吞帧
    const slow = G.slowmo > 0 ? Math.max(.12, G.slowScale) : 1;
    acc += raw * slow;
    let steps = 0;
    while (acc >= STEP && steps < 4) {
      updateRun(STEP);
      acc -= STEP;
      steps += 1;
      Input.endFrame();
    }
    if (steps > 0) Input.consumeHoldover();
    if (steps >= 4) acc = 0;
  } else {
    acc = 0;
  }

  if (shouldRenderGame()) {
    renderGame(ctx, G.time);
  } else {
    renderMenuBackdrop(G.time);
  }
  // 帧尾：停顿帧里按下的键先暂存，其余情况照常清空
  if (G.hitstop > 0 && G.mode === 'playing' && !G.paused) Input.stash();
  else Input.endFrame();
}

async function boot() {
  try {
    Save.load();
    Audio.init(Save.settings);
    setupHandlers();
    setCanvas();
    const fill = document.getElementById('loading-fill');
    const note = document.getElementById('loading-note');
    await preloadAssets((p) => {
      if (fill) fill.style.width = (p * 100).toFixed(1) + '%';
      if (note) note.textContent = p < .5 ? '正在点亮舞台…' : p < .9 ? '正在唤醒演员…' : '正在拉起幕布…';
    });
    const loading = document.getElementById('loading');
    if (loading) {
      loading.classList.add('done');
      setTimeout(() => loading.classList.add('hidden'), 900);
    }
    UI.showTitle();
    G.mode = 'title';
    last = 0;
    requestAnimationFrame(frame);
    window.__lastencore = { G, UI, Save, Audio, FX, CHAR_MAP, Enemy, Boss, finishRun, abandonRun, openShop, openRest, openEvent, openTreasure, openBoonReward, afterReward, showNextChoices, startCombatRoom };
  } catch (err) {
    console.error(err);
    const note = document.getElementById('loading-note');
    if (note) {
      note.textContent = '舞台搭建失败：' + (err && err.message ? err.message : err);
      note.style.color = '#ff9db6';
    }
    const toast = document.getElementById('global-toast');
    if (toast) {
      toast.textContent = '加载失败：' + err;
      toast.classList.add('show');
    }
  }
}

window.addEventListener('error', (e) => {
  console.error('[lastencore]', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[lastencore:promise]', e.reason);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
