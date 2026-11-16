// 星降旅记 · 引擎内核：共享状态、素材、输入、音频、存档、工具
import {
  W, H, STEP, A_BGM, SCENE, ICON, HEROES, BIOMES, BOONS, SHOP_ITEMS, META,
  ELEMENTS, FOES, bossStand, bossFace,
} from './data.js';

// ---------------------------------------------------------------------------
// 共享可变状态
// ---------------------------------------------------------------------------
export const G = {
  state: 'loading',           // loading / title / howto / hub / play / cards / shop / pause / result
  t: 0, stT: 0,               // 全局时间 / 状态停留时间
  lang: 'zh', muted: false, touch: false,
  save: null,
  hero: 0,
  run: null, room: null, P: null, boss: null, terrain: null,
  enemies: [], shots: [], eshots: [], pickups: [], parts: [], texts: [], zones: [], trails: [],
  cam: { x: 0, y: 0 }, shake: 0, flash: null, hitstop: 0, slow: 1, slowT: 0,
  banner: null, trans: null, result: null,
  cards: null, shop: null, menu: { i: 0 }, hub: { i: 0 }, pause: { i: 0 },
  combo: 0, comboT: 0, reactions: 0,
  element: 'sun', reactBanner: null,
  pointer: { x: -1, y: -1 },
  dbg: false,
};

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------
export const IMG = new Map();
export function getImg(src) {
  if (!src) return null;
  let im = IMG.get(src);
  if (!im) { im = new Image(); im.decoding = 'async'; im.src = src; IMG.set(src, im); }
  return im;
}
export const ready = (im) => !!(im && im.complete && im.naturalWidth > 0);

export function assetList() {
  const list = [
    SCENE.title, SCENE.select, SCENE.hub, SCENE.shop, SCENE.result, SCENE.dark,
    ...Object.values(ICON),
  ];
  for (const b of BIOMES) list.push(b.bg, bossStand(b.boss), bossFace(b.boss));
  for (const h of HEROES) list.push(h.stand, h.face, h.card);
  for (const e of ELEMENTS) list.push(e.icon);
  for (const f of Object.values(FOES)) list.push(f.art);
  for (const b of BOONS) list.push(b.card);
  for (const s of SHOP_ITEMS) list.push(s.icon);
  for (const m of META) list.push(m.icon);
  return [...new Set(list.filter(Boolean))];
}

export function preload(list, onProgress) {
  return new Promise((resolve) => {
    if (!list.length) { resolve(); return; }
    let n = 0;
    const done = () => { n++; onProgress && onProgress(n / list.length); if (n >= list.length) resolve(); };
    for (const src of list) {
      const im = getImg(src);
      if (im.complete) done();
      else {
        im.addEventListener('load', done, { once: true });
        im.addEventListener('error', done, { once: true });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------
const MAP = {
  left:   ['ArrowLeft', 'KeyA'],
  right:  ['ArrowRight', 'KeyD'],
  up:     ['ArrowUp', 'KeyW'],
  down:   ['ArrowDown', 'KeyS'],
  jump:   ['Space', 'ArrowUp', 'KeyW'],
  atk:    ['KeyJ', 'KeyZ'],
  nova:   ['KeyK', 'KeyX'],
  dash:   ['ShiftLeft', 'ShiftRight', 'KeyL'],
  ok:     ['Enter', 'KeyE'],
  pause:  ['Escape', 'KeyP'],
  c1: ['Digit1', 'Numpad1'], c2: ['Digit2', 'Numpad2'], c3: ['Digit3', 'Numpad3'],
  element: ['KeyQ', 'Tab'],
  el1: ['Digit1'], el2: ['Digit2'], el3: ['Digit3'],
  el4: ['Digit4'], el5: ['Digit5'], el6: ['Digit6'],
  mute:   ['KeyM'],
};
const BLOCK = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'ShiftLeft', 'ShiftRight', 'Tab']);

export const Input = {
  held: new Set(), just: new Set(), tapZones: [], touchHeld: new Set(),
  touchPress(code, hold) {
    this.just.add(code);
    if (hold) { this.held.add(code); this.touchHeld.add(code); }
  },
  act(name) { const a = MAP[name]; return a ? a.some(c => this.held.has(c)) : false; },
  hit(name) { const a = MAP[name]; return a ? a.some(c => this.just.has(c)) : false; },
  axis() { return (this.act('right') ? 1 : 0) - (this.act('left') ? 1 : 0); },
  clearJust() { this.just.clear(); },
  tapZone(x, y, w, h, fn) { this.tapZones.push({ x, y, w, h, fn }); },
  clearZones() { this.tapZones.length = 0; },
};

export function bindInput(cv) {
  addEventListener('keydown', (e) => {
    if (BLOCK.has(e.code)) e.preventDefault();
    if (!Input.held.has(e.code)) Input.just.add(e.code);
    Input.held.add(e.code);
    Sound.unlock();
  });
  addEventListener('keyup', (e) => { Input.held.delete(e.code); });
  addEventListener('blur', () => { Input.held.clear(); Input.just.clear(); });

  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
  };
  const fire = (e) => {
    Sound.unlock();
    const p = pos(e);
    G.pointer.x = p.x; G.pointer.y = p.y;
    if (e.pointerType === 'touch' || e.type === 'touchstart') G.touch = true;
    for (let i = Input.tapZones.length - 1; i >= 0; i--) {
      const z = Input.tapZones[i];
      if (p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h) { z.fn(); return; }
    }
    // 空白处点击 = 挥击（仅战斗态）
    if (G.state === 'play') Input.just.add('KeyJ');
  };
  cv.addEventListener('pointerdown', fire);
  cv.addEventListener('pointermove', (e) => { const p = pos(e); G.pointer.x = p.x; G.pointer.y = p.y; });
  const release = () => {
    for (const c of Input.touchHeld) Input.held.delete(c);
    Input.touchHeld.clear();
  };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------------------------------------------------------------------------
// 音频：离线 BGM + WebAudio 合成音效
// ---------------------------------------------------------------------------
export const Sound = {
  ctx: null, master: null, el: null, cur: '', muted: false, unlocked: false,
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { this.ctx = new AC(); this.master = this.ctx.createGain(); this.master.gain.value = 0.32; this.master.connect(this.ctx.destination); }
    } catch (e) { /* 无音频也可游玩 */ }
    if (this.el && this.cur) this.el.play().catch(() => {});
  },
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.32;
    if (this.el) this.el.volume = m ? 0 : 0.34;
  },
  bgm(file) {
    if (!file) { if (this.el) this.el.pause(); this.cur = ''; return; }
    if (this.cur === file) return;
    this.cur = file;
    if (!this.el) { this.el = new Audio(); this.el.loop = true; this.el.volume = this.muted ? 0 : 0.34; }
    this.el.src = A_BGM + file;
    if (this.unlocked) this.el.play().catch(() => {});
  },
  tone(f, dur, type = 'sine', vol = 0.3, slide = 0, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0 + dur + 0.02);
  },
  noise(dur, vol = 0.2, freq = 1200, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    s.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq; g.gain.value = vol;
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t0);
  },
  sfx(n, v = 1) {
    if (!this.ctx || this.muted) return;
    switch (n) {
      case 'ui':     this.tone(660, 0.07, 'triangle', 0.16 * v, 880); break;
      case 'jump':   this.tone(330, 0.16, 'triangle', 0.2 * v, 620); break;
      case 'slash':  this.noise(0.1, 0.16 * v, 2400); this.tone(720, 0.09, 'sawtooth', 0.1 * v, 300); break;
      case 'hit':    this.tone(180, 0.09, 'square', 0.13 * v, 90); this.noise(0.07, 0.12 * v, 900); break;
      case 'shoot':  this.tone(880, 0.12, 'sine', 0.13 * v, 1320); break;
      case 'hurt':   this.tone(220, 0.22, 'sawtooth', 0.2 * v, 90); this.noise(0.14, 0.14 * v, 500); break;
      case 'coin':   this.tone(1050, 0.09, 'sine', 0.16 * v, 1560); this.tone(1560, 0.1, 'sine', 0.1 * v, 2100, 0.05); break;
      case 'card':   this.tone(520, 0.14, 'triangle', 0.16 * v, 780); this.tone(780, 0.2, 'sine', 0.13 * v, 1170, 0.08); break;
      case 'door':   this.tone(300, 0.28, 'sine', 0.16 * v, 620); this.noise(0.22, 0.08 * v, 700); break;
      case 'boom':   this.noise(0.32, 0.28 * v, 380); this.tone(140, 0.3, 'sawtooth', 0.2 * v, 50); break;
      case 'heal':   this.tone(660, 0.18, 'sine', 0.14 * v, 990); this.tone(990, 0.22, 'sine', 0.11 * v, 1320, 0.09); break;
      case 'buy':    this.tone(700, 0.1, 'triangle', 0.16 * v, 1050); this.tone(1050, 0.14, 'sine', 0.12 * v, 1400, 0.07); break;
      case 'die':    this.tone(400, 0.7, 'sawtooth', 0.22 * v, 70); this.noise(0.5, 0.14 * v, 300); break;
      case 'win':    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.16 * v, f * 1.01, i * 0.13)); break;
      case 'boss':   this.tone(110, 0.7, 'sawtooth', 0.22 * v, 70); this.noise(0.5, 0.16 * v, 220); break;
      case 'dash':   this.noise(0.12, 0.14 * v, 1800); this.tone(500, 0.1, 'triangle', 0.1 * v, 900); break;
      case 'charge': this.tone(300, 0.5, 'sine', 0.1 * v, 900); break;
      case 'element': this.tone(520, 0.1, 'triangle', 0.14 * v, 780); this.tone(780, 0.14, 'sine', 0.1 * v, 1040, 0.05); break;
      case 'react': this.tone(440, 0.24, 'sawtooth', 0.18 * v, 880); this.tone(880, 0.3, 'sine', 0.14 * v, 1320, 0.04); this.noise(0.2, 0.12 * v, 1600); break;
      case 'chain': this.tone(660, 0.12, 'triangle', 0.15 * v, 1100); this.tone(990, 0.18, 'sine', 0.11 * v, 1480, 0.07); break;
      case 'shatter': this.noise(0.16, 0.2 * v, 3200); this.tone(900, 0.1, 'square', 0.09 * v, 300); break;
      case 'spring': this.tone(300, 0.22, 'sine', 0.18 * v, 900); break;
      case 'wall': this.tone(420, 0.1, 'triangle', 0.13 * v, 700); break;
      case 'dive': this.tone(600, 0.16, 'sawtooth', 0.14 * v, 120); break;
    }
  },
};

// ---------------------------------------------------------------------------
// 存档
// ---------------------------------------------------------------------------
const SAVE_KEY = 'kf_starfall_v1';
const defaultSave = () => ({ stardust: 0, up: {}, best: null, lang: 'zh', muted: false, hero: 0 });
export const Save = {
  load() {
    try {
      const j = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (j && typeof j === 'object') return Object.assign(defaultSave(), j, { up: j.up || {} });
    } catch (e) { /* 忽略损坏存档 */ }
    return defaultSave();
  },
  write(s) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) {} },
};

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------
export let cv = null, ctx = null;
export let RS = 1;
export function initCanvas(el) {
  cv = el; ctx = cv.getContext('2d', { alpha: false });
  const resize = () => {
    const fit = Math.min(innerWidth / W, innerHeight / H);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    RS = Math.max(1, Math.min(2.5, fit * dpr));
    cv.width = Math.round(W * RS); cv.height = Math.round(H * RS);
    cv.style.width = Math.round(W * fit) + 'px';
    cv.style.height = Math.round(H * fit) + 'px';
  };
  addEventListener('resize', resize);
  addEventListener('orientationchange', () => setTimeout(resize, 200));
  resize();
}
export function beginFrame() {
  ctx.setTransform(RS, 0, 0, RS, 0, 0);
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const rnd = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
export const rint = (a, b) => Math.floor(rnd(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const chance = (p) => Math.random() < p;
export function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }
export const aabb = (a, b) => Math.abs(a.x - b.x) * 2 < (a.w + b.w) && Math.abs(a.y - b.y) * 2 < (a.h + b.h);
export function fmtTime(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return m + ':' + String(ss).padStart(2, '0'); }
export function text(s, x, y, size, color, align = 'left', weight = 400, font = null) {
  ctx.save(); ctx.font = weight + ' ' + size + 'px ' + (font || '"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif');
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y); ctx.restore();
}
export function rrect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
export function panel(x, y, w, h, r = 16, fill = 'rgba(255,250,240,.94)', stroke = 'rgba(120,90,70,.35)', lw = 2) {
  ctx.save();
  ctx.shadowColor = 'rgba(60,40,30,.28)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
  rrect(x, y, w, h, r); ctx.fillStyle = fill; ctx.fill();
  ctx.restore();
  rrect(x, y, w, h, r); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
}
export function drawImg(im, x, y, w, h, alpha = 1) {
  if (!ready(im)) return false;
  ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(im, x, y, w, h); ctx.restore();
  return true;
}
// cover 方式铺一张不透明底图，带轻微视差与双份平铺防止露边
export function drawCover(im, ox, oy, w, h) {
  if (!ready(im)) return false;
  const s = Math.max(w / im.naturalWidth, h / im.naturalHeight);
  const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
  ctx.drawImage(im, ox + (w - dw) / 2, oy + (h - dh) / 2, dw, dh);
  return true;
}
export function particle(x, y, vx, vy, life, color, r, kind = 'dot') {
  G.parts.push({ x, y, vx, vy, life, max: life, color, r, kind });
}
export function floatText(x, y, s, color, size = 16) {
  G.texts.push({ x, y, s, color, size, life: 0.9, max: 0.9 });
}
export function burst(x, y, n, color, spd = 160) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(-0.2, 0.2), v = rnd(spd * 0.35, spd);
    particle(x, y, Math.cos(a) * v, Math.sin(a) * v, rnd(0.3, 0.7), color, rnd(2, 4), 'star');
  }
}
export function shake(v) { G.shake = Math.max(G.shake, v); }
export function flash(color = '#fff', a = 0.5) { G.flash = { color, a, t: 0.18, max: 0.18 }; }
export { STEP };
