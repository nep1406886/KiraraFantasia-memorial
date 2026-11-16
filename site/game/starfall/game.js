// 星降旅记 · 状态机、平台物理、连招与六属性连锁
import {
  W, H, FLOOR, ROOM_W, STEP, PAL, SCENE, ICON,
  HEROES, BIOMES, BOONS, SHOP_ITEMS, META, FOES, FOE_IDS, ELEMENTS, EL, elOf,
  PLAN, reactionOf, tr, loc, locObj, setLang, getLang,
} from './data.js';
import {
  G, IMG, Input, Sound, Save, clamp, lerp, rnd, rint, pick, chance, shuffle,
  particle, burst, floatText, shake, flash, initCanvas, bindInput,
  assetList, preload, fmtTime,
} from './core.js';
import { genSolvable, groundAt, groundSegmentAt, validateTerrain, PHYS } from './terrain.js';
import { render } from './render.js';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const setState = (s) => { G.state = s; G.stT = 0; };
const overlap = (ax, ay, aw, ah, bx, by, bw, bh) =>
  Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh;
const foeCy = (e) => e.y - e.h / 2;
const alive = (e) => e && !e.dead;

function banner(sub, name, col, dur = 2.6) { G.banner = { sub, name, col, t: 0, dur }; }
function transition(fn, dur = 0.85) { G.trans = { t: 0, dur, done: false, fn }; }
function persist() { G.save.lang = G.lang; G.save.muted = G.muted; G.save.hero = G.hero; Save.write(G.save); }
function toggleLang() { G.lang = getLang() === 'zh' ? 'en' : 'zh'; setLang(G.lang); persist(); Sound.sfx('ui'); }
function toggleSound() { G.muted = !G.muted; Sound.setMuted(G.muted); persist(); Sound.sfx('ui'); }
function heal(v) {
  const P = G.P, before = P.hp;
  P.hp = Math.min(P.maxhp, P.hp + v);
  const d = Math.round(P.hp - before);
  if (d > 0) floatText(P.x, P.y - 92, '+' + d, PAL.mint, 16);
}
function addNova(v) { const P = G.P; P.nova = Math.min(P.novaMax, P.nova + v * P.novaRate); }
function reactBanner(r, chain) {
  G.reactBanner = { name: loc(r.name, r.en), en: r.en, color: r.color, chain: chain || 1, t: 0.9, max: 0.9 };
}

// ---------------------------------------------------------------------------
// 玩家
// ---------------------------------------------------------------------------
function makePlayer() {
  const h = HEROES[G.hero], up = G.save.up;
  const hp = h.hp + 12 * (up.lamp || 0);
  const casts = h.id === 12 ? 2 : 1;
  const nm = 100 * (h.id === 12 ? 1.3 : 1);
  const P = {
    x: 110, y: FLOOR, vx: 0, vy: 0, face: 1, ground: true,
    hp, maxhp: hp, atk: h.atk + 2 * (up.edge || 0), spd: h.spd,
    nova: 0, novaMax: nm, novaRate: h.nova, novaCasts: casts, novaCost: nm / casts,
    burst: 1, atkRate: 1, range: h.id === 5 ? 1.3 : 1,
    greed: 1, discount: 1, drain: h.id === 10 ? 4 : 0,
    roomHeal: h.id === 2 ? 7 : 0, range2: 0,
    maxJumps: h.id === 9 ? 2 : 1, jumps: 0,
    shield: (up.ward || 0), shieldMax: (up.ward || 0),
    coin: 10 + 25 * (up.purse || 0), boons: [],
    // 属性构筑
    reactDmg: 1 + 0.12 * (up.prism || 0), blazeR: 175, reactNova: 0,
    soakBonus: 0, frostBonus: 0, keepSoak: 0,
    dualEl: false, diveReact: false, dashEl: false, orbit: false, orbitT: 0,
    // 动作
    slashStep: 0, slashT: 0, comboWindow: 0, atkCd: 0,
    dashCd: 0, dashT: 0, dashHit: null, dashDir: 1,
    dive: 0, wallDir: 0, dropThrough: 0, onPlat: null,
    squashX: 1, squashY: 1, tilt: 0, inv: 0.6, flash: 0,
    dead: false,
  };
  G.P = P;
  G.element = h.element;
  return P;
}
function hurtPlayer(dmg, fromX, opt = {}) {
  const P = G.P;
  if (P.inv > 0 || P.dead || G.state !== 'play') return;
  if (P.shield > 0) {
    P.shield--; P.inv = 0.85; Sound.sfx('hit');
    floatText(P.x, P.y - 90, 'BLOCK', PAL.sky, 15);
    burst(P.x, P.y - 45, 12, PAL.sky, 170); shake(4); return;
  }
  P.hp -= dmg; P.inv = 1.0; P.flash = 0.35;
  P.vx = (P.x < fromX ? -1 : 1) * 7.5; P.vy = -5.5; P.ground = false;
  Sound.sfx('hurt'); shake(9); flash('#ff9ab4', 0.3);
  floatText(P.x, P.y - 92, '-' + dmg, PAL.red, 20);
  burst(P.x, P.y - 45, 14, PAL.berry, 200);
  G.combo = 0;
  if (P.hp <= 0) { P.hp = 0; P.dead = true; Sound.sfx('die'); burst(P.x, P.y - 48, 30, PAL.gold, 260); }
}
function respawnFromPit() {
  const P = G.P, t = G.terrain;
  let best = null, bd = 1e9;
  for (const g of t.ground) { const d = Math.abs(P.x - (g.x + g.w / 2)); if (d < bd) { bd = d; best = g; } }
  hurtPlayer(12, P.x, { pit: true });
  P.inv = 1.2;
  P.x = clamp(best ? best.x + Math.min(100, best.w / 2) : 110, 40, ROOM_W - 40);
  P.y = (best ? best.y : FLOOR) - 60;
  P.vx = 0; P.vy = 0; P.ground = false; P.dive = 0;
  floatText(P.x, P.y - 40, tr('room.pit'), PAL.violet, 18);
  Sound.sfx('boom', 0.5); shake(8);
}

// ---------------------------------------------------------------------------
// 属性连锁核心
// ---------------------------------------------------------------------------
function nextElement(id) { const i = ELEMENTS.findIndex(e => e.id === id); return ELEMENTS[(i + 1) % ELEMENTS.length].id; }
function setElement(id) {
  if (G.element === id) return;
  G.element = id; Sound.sfx('element');
  const el = elOf(id);
  burst(G.P.x, G.P.y - 48, 8, el.color, 130);
  floatText(G.P.x, G.P.y - 108, loc(el.name, el.en), el.soft, 15);
}
function cycleElement() { setElement(nextElement(G.element)); }

// 对敌人造成伤害并施加属性浸染（反应入口）
function hitFoe(e, dmg, dir, opt = {}) {
  if (!alive(e)) return;
  const P = G.P;
  let total = dmg * (1 + (e.soakStacks || 0) * P.soakBonus);
  if (e.frozen > 0) total *= 1 + P.frostBonus;
  if (e.stun > 0) total *= 1.1;
  total = Math.max(1, total);
  e.hp -= total; e.flash = 0.13; e.vx += dir * 2.2;
  burst(e.x, foeCy(e), 6, elOf(opt.element || e.element).soft, 150);
  if (!opt.quiet) { Sound.sfx('hit', 0.55); shake(2); }
  floatText(e.x, e.y - e.h - 12, String(Math.round(total)), elOf(opt.element || G.element).soft, 14);
  G.combo++; G.comboT = 1.6; addNova(4);
  if (opt.launch) { e.vy = -9; e.stun = Math.max(e.stun, 0.45); }
  if (e.hp <= 0) { killFoe(e); return; }
  if (opt.element && !opt.noSoak) {
    soak(e, opt.element, opt.depth || 0);
    if (P.dualEl && opt.depth == null) soak(e, nextElement(opt.element), 1);
  }
}
function soak(e, elId, depth) {
  if (!alive(e)) return;
  const P = G.P;
  if (e.soak && e.soak !== elId) {
    const r = reactionOf(e.soak, elId);
    if (r) {
      doReaction(e, r, depth || 0);
      if (e.soak && chance(P.keepSoak)) { e.soak = elId; e.soakStacks = 1; }
      else { e.soak = null; e.soakStacks = 0; }
      return;
    }
  }
  if (e.soak === elId) e.soakStacks = Math.min(3, (e.soakStacks || 0) + 1);
  else { e.soak = elId; e.soakStacks = 1; }
}
function nearby(e, r) {
  return G.enemies.filter(o => alive(o) && o !== e && Math.abs(o.x - e.x) < r && Math.abs(o.y - e.y) < 175);
}
function aoe(x, y, r, dmg, opt = {}) {
  for (const e of G.enemies) {
    if (!alive(e) || Math.abs(e.x - x) > r || Math.abs(e.y - y) > 175) continue;
    hitFoe(e, dmg, Math.sign(e.x - x) || 1, { element: opt.element, quiet: true, depth: opt.depth, noSoak: opt.noSoak });
  }
  if (G.boss && !G.boss.dead && Math.abs(G.boss.x - x) < r + 60)
    hitBoss(dmg, Math.sign(G.boss.x - x) || 1, { quiet: true, element: opt.element, noSoak: opt.noSoak });
  G.parts.push({ x, y, vx: 0, vy: 0, life: 0.45, max: 0.45, color: opt.color || PAL.gold, r, kind: 'ring' });
}
function field(x, y, w, dmg, element, dur) {
  G.zones.push({ kind: 'field', x, y, w, t: dur, max: dur, dmg, element, tick: 0, color: elOf(element).color, done: false });
}
function doReaction(e, r, depth) {
  const P = G.P;
  G.reactions++;
  reactBanner(r, depth + 1);
  Sound.sfx(depth > 0 ? 'chain' : 'react');
  if (P.reactNova) addNova(P.reactNova);
  const dmg = (18 + P.atk * 1.25) * P.reactDmg * (1 + depth * 0.3);
  const el = elOf(G.element);
  burst(e.x, foeCy(e), 16, r.color, 220);
  switch (r.id) {
    case 'blaze': {
      aoe(e.x, foeCy(e), P.blazeR, dmg, { color: r.color, depth: depth + 1, noSoak: true });
      // 火种传播：邻近敌人若带着别的浸染，会再次引爆 —— 连锁涌现
      for (const o of nearby(e, P.blazeR)) {
        if (depth >= 3) break;
        if (o.soak && o.soak !== 'fire') soak(o, 'fire', depth + 1);
        else { o.soak = 'fire'; o.soakStacks = 1; }
        hitFoe(o, dmg * 0.45, Math.sign(o.x - e.x) || 1, { quiet: true, noSoak: true });
      }
      break;
    }
    case 'steam': {
      aoe(e.x, foeCy(e), 130, dmg * 0.8, { color: r.color, depth: depth + 1, noSoak: true });
      for (const o of nearby(e, 130)) o.vx += Math.sign(o.x - e.x) * 8;
      break;
    }
    case 'scorch': case 'ash': case 'magma': {
      e.burn = 3.2; e.burnT = 0;
      hitFoe(e, dmg * 0.6, 1, { quiet: true, noSoak: true });
      if (r.id === 'magma') field(e.x, e.y - 10, 130, dmg * 0.25, 'fire', 3.2);
      break;
    }
    case 'frost': {
      e.frozen = 1.7; hitFoe(e, dmg * 0.7, 1, { quiet: true, noSoak: true });
      for (const o of nearby(e, 80)) o.frozen = Math.max(o.frozen, 0.9);
      break;
    }
    case 'mist': case 'sand': case 'quake': {
      field(e.x, e.y - 10, 150, dmg * 0.3, r.id === 'sand' ? 'earth' : 'wind', 3.4);
      if (r.id === 'quake') for (const o of nearby(e, 150)) { o.stun = 1.1; hitFoe(o, dmg * 0.4, 1, { quiet: true, noSoak: true }); }
      break;
    }
    case 'eclipse': {
      const exec = e.hp < e.maxhp * 0.32;
      hitFoe(e, exec ? e.hp + 1 : dmg * 1.7, 1, { quiet: true, noSoak: true });
      if (exec) floatText(e.x, e.y - e.h - 34, 'EXECUTE', r.color, 16);
      aoe(e.x, foeCy(e), 110, dmg * 0.5, { color: r.color, depth: depth + 1, noSoak: true });
      break;
    }
    case 'bloom': case 'rainbow': {
      for (const o of nearby(e, 140)) o.stun = 1.2;
      heal(r.id === 'rainbow' ? 18 : 8);
      if (r.id === 'rainbow') addNova(25);
      hitFoe(e, dmg * 0.5, 1, { quiet: true, noSoak: true });
      break;
    }
    case 'crystal': case 'gale': case 'flare': default: {
      aoe(e.x, foeCy(e), 120, dmg * 0.9, { color: r.color, depth: depth + 1, noSoak: true });
      if (r.id === 'gale') for (const o of nearby(e, 150)) o.vx -= Math.sign(o.x - e.x) * 6;
      break;
    }
  }
  shake(3 + depth * 2);
}
function killFoe(e) {
  if (e.dead) return;
  e.dead = true; G.run.kills++;
  Sound.sfx('hit', 0.7); Sound.sfx('coin', 0.4);
  burst(e.x, foeCy(e), 16, elOf(e.element).color, 220);
  const n = rint(1, 3);
  for (let i = 0; i < n; i++) spawnPickup('coin', e.x + rnd(-18, 18), e.y - 20, 1);
  if (G.P.drain) heal(G.P.drain);
  addNova(6);
}
function hitBoss(dmg, dir, opt = {}) {
  const b = G.boss; if (!b || b.dead) return;
  const P = G.P;
  b.hp -= dmg * (1 + (b.soakStacks || 0) * P.soakBonus * 0.5);
  b.flash = 0.14;
  burst(b.x, FLOOR - 120, 8, '#fff4c8', 200);
  if (!opt.quiet) Sound.sfx('hit', 0.7);
  floatText(b.x + rnd(-30, 30), FLOOR - 250, String(Math.round(dmg)), PAL.goldSoft, 15);
  G.combo++; G.comboT = 1.6; addNova(4);
  if (opt.element && !opt.noSoak) bossSoak(b, opt.element, opt.depth || 0);
  if (b.hp <= 0) bossDown();
}
function bossSoak(b, elId, depth) {
  if (b.soak && b.soak !== elId) {
    const r = reactionOf(b.soak, elId);
    if (r) {
      G.reactions++; reactBanner(r, depth + 1); Sound.sfx(depth > 0 ? 'chain' : 'react');
      const dmg = (26 + G.P.atk * 1.4) * G.P.reactDmg;
      b.hp -= dmg; b.flash = 0.2; shake(6);
      burst(b.x, FLOOR - 130, 26, r.color, 280);
      floatText(b.x, FLOOR - 270, loc(r.name, r.en), r.color, 20);
      aoe(b.x, FLOOR - 110, G.P.blazeR, dmg * 0.5, { color: r.color, depth: depth + 1, noSoak: true });
      b.soak = null; b.soakStacks = 0;
      if (b.hp <= 0) { bossDown(); return; }
      return;
    }
  }
  if (b.soak === elId) b.soakStacks = Math.min(3, (b.soakStacks || 0) + 1);
  else { b.soak = elId; b.soakStacks = 1; }
}

// ---------------------------------------------------------------------------
// 连招 / 冲刺 / 下砸 / 星河
// ---------------------------------------------------------------------------
function propsNear(x, y, r) {
  const t = G.terrain; if (!t) return [];
  return t.props.filter(p => p.alive && Math.abs(p.x - x) < r && Math.abs(p.y - y) < 100);
}
function hitProps(x, y, r, element) {
  const t = G.terrain; if (!t) return;
  for (const pr of t.props) {
    if (!pr.alive || Math.abs(pr.x - x) > r || Math.abs(pr.y - y) > 110) continue;
    if (pr.kind === 'spring') continue;
    pr.alive = false;
    Sound.sfx('shatter');
    burst(pr.x, pr.y - 12, 14, PAL.goldSoft, 190);
    if (pr.kind === 'lamp') {
      spawnPickup('coin', pr.x, pr.y - 20, 4);
      addNova(18);
      floatText(pr.x, pr.y - 40, '+STAR', PAL.gold, 14);
    } else if (pr.kind === 'barrel') {
      explodeBarrel(pr, element);
    }
  }
}
function explodeBarrel(pr, element) {
  Sound.sfx('boom'); flash('#ffd9a0', 0.4); shake(10);
  const el = element || 'fire';
  aoe(pr.x, pr.y, 135, 26 + G.P.atk, { color: elOf(el).color, element: el });
  // 连锁引爆附近的桶
  for (const o of G.terrain.props) {
    if (o.alive && o.kind === 'barrel' && Math.abs(o.x - pr.x) < 150) {
      o.alive = false; burst(o.x, o.y, 16, PAL.gold, 220);
      aoe(o.x, o.y, 110, 18 + G.P.atk * 0.6, { color: PAL.gold, element: el, noSoak: true });
    }
  }
  G.parts.push({ x: pr.x, y: pr.y - 10, vx: 0, vy: 0, life: 0.5, max: 0.5, color: PAL.gold, r: 160, kind: 'ring' });
}
function doSlash() {
  const P = G.P;
  if (!P.ground && Input.act('down')) { doDive(); return; }
  const step = P.ground ? (P.comboWindow > 0 ? (P.comboStep + 1) % 3 : 0) : 0;
  P.comboStep = step; P.comboWindow = 0.55; P.slashStep = step;
  P.slashT = 0.2; P.atkCd = 0.29 * P.atkRate;
  Sound.sfx('slash');
  const reach = (step === 2 ? 84 : 70) * P.range;
  const bx = P.x + P.face * reach * 0.46, by = P.y - 50;
  const bh = step === 2 ? 128 : 100;
  const dmg = P.atk * (step === 2 ? 1.35 : step === 1 ? 1.12 : 1);
  let hits = 0;
  for (const e of G.enemies) {
    if (!alive(e) || e.spawnT > 0) continue;
    if (overlap(bx, by, reach, bh, e.x, foeCy(e), e.w, e.h)) {
      hitFoe(e, dmg, P.face, { element: G.element, launch: step === 2 }); hits++;
    }
  }
  if (G.boss && !G.boss.dead && overlap(bx, by, reach, bh, G.boss.x, FLOOR - 115, 100, 230))
    hitBoss(dmg, P.face, { element: G.element });
  hitProps(bx, by, reach * 0.6, G.element);
  // 星屑弹（附带属性，可触发远程反应）
  G.shots.push({
    x: P.x + P.face * 24, y: P.y - 46, vx: P.face * 11.5, vy: 0.3,
    dmg: P.atk * 0.55, pierce: P.pierce || 0, seed: rnd(6), life: 1.5,
    element: G.element, hit: new Set(),
  });
  Sound.sfx('shoot', 0.4);
  if (hits === 0 && step === 2) burst(bx, by, 6, elOf(G.element).soft, 120);
}
function doDive() {
  const P = G.P;
  if (P.ground || P.dive > 0) return;
  P.dive = 1; P.vy = 21; P.vx *= 0.25;
  P.squashX = 0.8; P.squashY = 1.25;
  Sound.sfx('dive');
}
function diveImpact() {
  const P = G.P;
  P.dive = 0; P.squashX = 1.3; P.squashY = 0.75;
  Sound.sfx('boom', 0.85); shake(12); flash(elOf(G.element).soft, 0.28);
  G.parts.push({ x: P.x, y: P.y - 8, vx: 0, vy: 0, life: 0.5, max: 0.5, color: elOf(G.element).color, r: 190, kind: 'ring' });
  const dmg = P.atk * 1.6;
  aoe(P.x, P.y - 30, 165, dmg, { element: G.element, color: elOf(G.element).color, noSoak: true });
  for (const e of G.enemies) if (alive(e) && Math.abs(e.x - P.x) < 165) e.stun = Math.max(e.stun, 0.85);
  hitProps(P.x, P.y - 20, 90, G.element);
  // 砸碎脚下的易碎纸片
  const t = G.terrain;
  if (t) for (const p of t.plats) {
    if (p.kind === 'fragile' && !p.broken && P.x > p.x - 20 && P.x < p.x + p.w + 20 && Math.abs(P.y - p.y) < 40) {
      p.broken = true; Sound.sfx('shatter');
      burst(p.x + p.w / 2, p.y, 14, PAL.cut, 200);
      floatText(p.x + p.w / 2, p.y - 20, tr('room.fragile'), '#fff', 13);
    }
  }
  if (P.diveReact) for (const e of G.enemies) if (alive(e) && Math.abs(e.x - P.x) < 340) soak(e, G.element, 1);
}
function doDash() {
  const P = G.P;
  if (P.dashCd > 0 || P.dashT > 0) return;
  P.dashT = 0.2; P.dashCd = 0.8; P.dashHit = new Set();
  P.dashDir = Input.axis() || P.face; P.face = P.dashDir;
  P.inv = Math.max(P.inv, 0.28);
  Sound.sfx('dash');
}
function doNova() {
  const P = G.P;
  if (P.nova < P.novaCost) return;
  P.nova -= P.novaCost;
  Sound.sfx('boom'); flash(elOf(G.element).soft, 0.6); shake(15);
  G.parts.push({ x: P.x, y: P.y - 48, vx: 0, vy: 0, life: 0.6, max: 0.6, color: elOf(G.element).color, r: 460, kind: 'ring' });
  const dmg = (38 + P.atk * 1.6) * P.burst;
  for (let i = 0; i < 34; i++) {
    const a = i * Math.PI / 17, v = rnd(170, 360);
    particle(P.x, P.y - 48, Math.cos(a) * v, Math.sin(a) * v, rnd(0.4, 0.9), i % 2 ? elOf(G.element).color : '#fff', rnd(3, 6), 'star');
  }
  // 星河：全场施加当前属性，配合已有浸染引爆连锁
  for (const e of G.enemies) if (alive(e)) { hitFoe(e, dmg, Math.sign(e.x - P.x) || 1, { quiet: true, element: G.element, noSoak: true }); soak(e, G.element, 0); }
  for (const e of G.enemies) if (alive(e)) hitFoe(e, dmg * 0.35, 1, { quiet: true, noSoak: true });
  if (G.boss && !G.boss.dead) { hitBoss(dmg, P.face, { quiet: true, noSoak: true }); bossSoak(G.boss, G.element, 0); }
  G.eshots.length = 0;
  heal(6);
  hitProps(P.x, P.y - 40, 280, G.element);
  floatText(P.x, P.y - 118, 'STAR RIVER', elOf(G.element).soft, 22);
}

// ---------------------------------------------------------------------------
// 玩家物理（平台 / 坑 / 蹬墙 / 下穿）
// ---------------------------------------------------------------------------
function wallAt(P) {
  const t = G.terrain; if (!t) return 0;
  for (const g of t.ground) {
    if (Math.abs(P.x - g.x) < 22 && P.y > g.y + 12 && P.y < g.y + 150) return -1;   // 左侧壁，向右蹬
    if (Math.abs(P.x - (g.x + g.w)) < 22 && P.y > g.y + 12 && P.y < g.y + 150) return 1;
  }
  for (const p of t.plats) {
    if (p.kind !== 'solid' || p.broken) continue;
    if (Math.abs(P.x - p.x) < 20 && P.y > p.y + 10 && P.y < p.y + 46) return -1;
    if (Math.abs(P.x - (p.x + p.w)) < 20 && P.y > p.y + 10 && P.y < p.y + 46) return 1;
  }
  return 0;
}
function landingSurfaces(x, prevFeet, P) {
  const t = G.terrain, out = [];
  if (!t) return [{ y: FLOOR, plat: null }];
  const gy = groundAt(t, x);
  if (gy != null) out.push({ y: gy, plat: null });
  for (const p of t.plats) {
    if (p.broken || p.breakT > 0.6) continue;
    if (x < p.x - 6 || x > p.x + p.w + 6) continue;
    if (P.dropThrough > 0 && p.kind !== 'solid') continue;
    if (prevFeet > p.y + 10) continue;         // 必须从上方落下
    out.push({ y: p.y, plat: p });
  }
  return out;
}
function updatePlayer(dt) {
  const P = G.P, t = G.terrain;
  P.inv = Math.max(0, P.inv - dt); P.flash = Math.max(0, P.flash - dt);
  P.slashT = Math.max(0, P.slashT - dt);
  P.comboWindow = Math.max(0, P.comboWindow - dt);
  P.atkCd = Math.max(0, P.atkCd - dt); P.dashCd = Math.max(0, P.dashCd - dt);
  P.dropThrough = Math.max(0, P.dropThrough - dt);
  P.squashX = lerp(P.squashX, 1, 0.16); P.squashY = lerp(P.squashY, 1, 0.16);
  P.tilt = lerp(P.tilt, clamp(-P.vx * 0.012, -0.12, 0.12), 0.15);
  if (P.dead) { P.vx *= 0.9; P.x += P.vx; return; }

  const ax = Input.axis();
  if (P.dashT > 0) {
    P.dashT -= dt; P.vx = P.dashDir * 16; P.inv = Math.max(P.inv, 0.08);
    if (chance(0.75)) G.trails.push({ x: P.x, y: P.y, life: 0.26, max: 0.26 });
    // 冲刺撞击
    for (const e of G.enemies) {
      if (!alive(e) || P.dashHit.has(e)) continue;
      if (overlap(P.x, P.y - 42, 34, 82, e.x, foeCy(e), e.w, e.h)) {
        P.dashHit.add(e);
        hitFoe(e, P.atk * 0.85, P.dashDir, { element: P.dashEl ? G.element : null, noSoak: !P.dashEl });
      }
    }
    hitProps(P.x, P.y - 40, 34, G.element);
  } else if (P.dive > 0) {
    P.vx *= 0.9;
  } else {
    P.vx = ax ? lerp(P.vx, ax * P.spd * 2.95, 0.28) : P.vx * 0.76;
  }
  if (ax && P.dashT <= 0) P.face = ax;
  P.x = clamp(P.x + P.vx, 24, ROOM_W - 24);

  // 属性切换
  if (Input.hit('element')) cycleElement();
  for (let i = 0; i < 6; i++) if (Input.hit('el' + (i + 1))) setElement(ELEMENTS[i].id);

  // 跳跃 / 蹬墙 / 下穿
  if (Input.hit('jump')) {
    if (Input.act('down') && P.ground && P.onPlat) {
      P.dropThrough = 0.3; P.ground = false; P.y += 6; P.onPlat = null;
    } else if (P.jumps < P.maxJumps) {
      P.vy = -12.6; P.jumps++; P.ground = false;
      P.squashX = 0.84; P.squashY = 1.18; Sound.sfx('jump');
      for (let i = 0; i < 8; i++) particle(P.x + rnd(-12, 12), P.y, rnd(-60, 60), rnd(-40, 10), 0.35, elOf(G.element).soft, 2.5, 'star');
    } else {
      const w = wallAt(P);
      if (w && !P.ground) {   // 蹬墙跳
        P.vy = -12.2; P.vx = -w * 9; P.jumps = 1; P.face = -w;
        Sound.sfx('wall'); burst(P.x, P.y - 40, 8, PAL.cut, 140);
      }
    }
  }
  if (Input.hit('dash')) doDash();
  if (Input.act('atk') && P.atkCd <= 0) doSlash();
  if (Input.hit('nova') && P.nova >= P.novaCost) doNova();

  // 竖直物理
  const prevFeet = P.y;
  P.vy = Math.min(21, P.vy + 0.62);
  P.y += P.vy;
  P.onPlat = null;
  let landed = false;
  if (P.vy >= 0) {
    const surfaces = landingSurfaces(P.x, prevFeet, P);
    let best = null;
    for (const s of surfaces) if (s.y >= prevFeet - 6 && s.y <= P.y + 2) { if (!best || s.y < best.y) best = s; }
    if (best) {
      P.y = best.y; P.vy = 0; P.ground = true; P.jumps = 0; P.onPlat = best.plat; landed = true;
      if (best.plat && best.plat.kind === 'fragile' && best.plat.breakT <= 0) best.plat.breakT = 0.6;
      // 弹簧
      if (t) for (const pr of t.props) {
        if (pr.alive && pr.kind === 'spring' && Math.abs(pr.x - P.x) < 24 && Math.abs(pr.y - P.y) < 26) {
          P.vy = -18.5; P.ground = false; P.jumps = 0; Sound.sfx('spring');
          for (let i = 0; i < 10; i++) particle(pr.x + rnd(-14, 14), pr.y, rnd(-90, 90), rnd(-120, -40), 0.5, '#fff', 3, 'star');
        }
      }
    }
  }
  if (!landed) P.ground = false;

  if (P.dive > 0 && P.ground) diveImpact();
  if (!P.ground && P.dive > 0 && P.vy < 0) P.dive = 0;

  // 坑 / 尖刺
  if (P.y > H + 90) respawnFromPit();
  if (t) for (const s of t.spikes) {
    if (P.x > s.x && P.x < s.x + s.w && Math.abs(P.y - s.y) < 12) { hurtPlayer(9, s.x); }
  }
  // 着陆反馈
  if (landed && prevFeet < P.y - 8 && P.dive === 0) {
    P.squashX = 1.18; P.squashY = 0.84;
    for (let i = 0; i < 6; i++) particle(P.x + rnd(-16, 16), P.y, rnd(-70, 70), rnd(-50, -10), 0.3, '#fff', 2.5);
  }
  // 环绕属性弹
  if (P.orbit) {
    P.orbitT -= dt;
    if (P.orbitT <= 0) {
      P.orbitT = 0.75;
      let best = null, bd = 1e9;
      for (const e of G.enemies) if (alive(e)) { const d = Math.hypot(e.x - P.x, e.y - P.y); if (d < bd) { bd = d; best = e; } }
      if (best && bd < 420) {
        const a = Math.atan2(foeCy(best) - (P.y - 46), best.x - P.x);
        G.shots.push({ x: P.x, y: P.y - 46, vx: Math.cos(a) * 8, vy: Math.sin(a) * 8, dmg: P.atk * 0.5, pierce: 1, seed: rnd(6), life: 1.4, element: G.element, hit: new Set() });
      }
    }
  }
  // 灼烧 DOT
  for (const e of G.enemies) {
    if (!alive(e) || e.burn <= 0) continue;
    e.burn -= dt; e.burnT = (e.burnT || 0) - dt;
    if (e.burnT <= 0) {
      e.burnT = 0.4;
      hitFoe(e, P.atk * 0.32, 1, { quiet: true, noSoak: true });
      if (chance(0.5)) particle(e.x + rnd(-10, 10), foeCy(e), rnd(-30, 30), rnd(-90, -30), 0.45, '#ff9a4a', 3, 'star');
    }
  }
}

// ---------------------------------------------------------------------------
// 敌人
// ---------------------------------------------------------------------------
function safeSpawnX(x) {
  const t = G.terrain; if (!t) return clamp(x, 60, ROOM_W - 60);
  let best = t.ground[0], bd = 1e9;
  for (const g of t.ground) {
    const cx = clamp(x, g.x + 24, g.x + g.w - 24), d = Math.abs(cx - x);
    if (d < bd) { bd = d; best = g; }
  }
  return clamp(x, best.x + 26, best.x + best.w - 26);
}
function spawnFoe(type, x, elite = false) {
  const d = FOES[type] || FOES.ember, t = G.terrain;
  const scale = 1 + G.run.biome * 0.22 + G.run.n * 0.018 + (elite ? 0.35 : 0);
  const hp = Math.round(d.hp * scale);
  const sx = safeSpawnX(x);
  const seg = t ? groundSegmentAt(t, sx) : null;
  const gy = seg ? seg.y : FLOOR;
  const e = {
    type, x: sx, y: d.kind === 'fly' ? gy - 105 : gy, vx: 0, vy: 0,
    face: -1, t: 0, seed: rnd(6.28), element: d.element,
    hp, maxhp: hp, atk: d.atk * (1 + G.run.biome * 0.14 + (elite ? 0.2 : 0)),
    spd: d.spd, w: d.w, h: d.h, kind: d.kind, scale: d.scale || 1,
    col: elOf(d.element).color, elite,
    // 状态
    soak: null, soakStacks: 0, frozen: 0, burn: 0, burnT: 0, stun: 0,
    flash: 0, dead: false, bob: 0, attackT: 0, spawnT: 0.45,
    cd: rnd(0.6, 1.6), shootCd: rnd(1.1, 2.2), charging: 0,
    baseY: d.kind === 'fly' ? gy - 105 : gy, homeY: gy,
  };
  G.enemies.push(e);
  burst(sx, e.y - e.h / 2, 10, elOf(d.element).color, 140);
  return e;
}
function updateFoe(e, dt) {
  const P = G.P, t = G.terrain;
  e.t += dt; e.flash = Math.max(0, e.flash - dt); e.spawnT = Math.max(0, e.spawnT - dt);
  e.frozen = Math.max(0, e.frozen - dt); e.stun = Math.max(0, e.stun - dt);
  e.attackT = Math.max(0, e.attackT - dt);
  const frozen = e.frozen > 0 || e.stun > 0;
  const dir = Math.sign(P.x - e.x) || -1;
  e.face = dir;
  e.bob = Math.sin(e.t * 4 + e.seed) * 2;
  const sf = G.slow * (frozen ? 0 : 1);

  if (e.kind === 'turret') {
    e.shootCd -= dt * sf;
    if (e.shootCd <= 0 && e.spawnT <= 0) { e.shootCd = 2.1; e.attackT = 0.3; fireEnemySpread(e.x, e.y - 34, dir, 3, 5.0, e.element); }
  } else if (e.kind === 'fly') {
    if (!frozen) {
      e.x += dir * e.spd * 1.5 * sf;
      e.y = e.baseY + Math.sin(e.t * 2.6 + e.seed) * 22;
    }
  } else if (e.kind === 'shoot') {
    if (!frozen) {
      const dist = Math.abs(P.x - e.x);
      if (dist > 240) e.x += dir * e.spd * 1.4 * sf;
      else if (dist < 130) e.x -= dir * e.spd * 1.1 * sf;
      e.shootCd -= dt * sf;
      if (e.shootCd <= 0 && e.spawnT <= 0) { e.shootCd = 1.8; e.attackT = 0.35; fireEnemyShot(e.x, e.y - 30, P, 5.4, e.element); }
    }
  } else if (e.kind === 'charge') {
    if (e.charging > 0 && !frozen) { e.charging -= dt * sf; e.x += e.face * 7.4 * sf; }
    else if (!frozen) {
      e.cd -= dt * sf; e.x += dir * e.spd * 0.7 * sf;
      if (e.cd <= 0) { e.charging = 0.55; e.cd = 2.3; e.face = dir; e.attackT = 0.4; }
    }
  } else {
    if (!frozen) { e.vx = lerp(e.vx, dir * e.spd * 2.6 * sf, 0.12); e.x += e.vx; }
  }
  // 不越出所在地面段（地面敌人不跨坑）
  if (t && e.kind !== 'fly') {
    const seg = groundSegmentAt(t, e.x);
    if (!seg) { e.x -= e.vx || dir * 2; e.vx = -(e.vx || 0) * 0.5; }
    else { e.x = clamp(e.x, seg.x + 14, seg.x + seg.w - 14); }
    const g = groundSegmentAt(t, e.x);
    if (g) { e.y = g.y; e.homeY = g.y; }
  }
  e.x = clamp(e.x, 24, ROOM_W - 24);
  if (e.spawnT <= 0 && overlap(P.x, P.y - 42, 30, 82, e.x, foeCy(e), e.w, e.h)) hurtPlayer(Math.round(e.atk), e.x);
}
function fireEnemyShot(x, y, P, spd, element) {
  const a = Math.atan2((P.y - 42) - y, P.x - x);
  G.eshots.push({ x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, r: 8, dmg: 10 + G.run.biome * 2, color: elOf(element).color, element, life: 3 });
  Sound.sfx('shoot', 0.3);
}
function fireEnemySpread(x, y, dir, n, spd, element) {
  const base = Math.atan2(-0.15, dir);
  for (let i = 0; i < n; i++) {
    const a = base + (i - (n - 1) / 2) * 0.32;
    G.eshots.push({ x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, r: 8, dmg: 9 + G.run.biome * 2, color: elOf(element).color, element, life: 3 });
  }
  Sound.sfx('shoot', 0.3);
}

// ---------------------------------------------------------------------------
// 首领
// ---------------------------------------------------------------------------
function spawnBoss() {
  const b = BIOMES[G.run.biome];
  const hp = Math.round(470 * (1 + G.run.biome * 0.5));
  const x = clamp(G.P.x + 430, 260, ROOM_W - 120);
  G.boss = {
    x, y: FLOOR, hp, maxhp: hp, biome: b, face: -1, element: b.bossEl,
    t: 0, cd: 1.6, act: null, actT: 0, flash: 0, dead: false,
    soak: null, soakStacks: 0, w: 110, h: 230,
  };
  Sound.sfx('boss'); flash(elOf(b.bossEl).soft, 0.35); shake(12);
  banner(tr('room.boss'), b.bossName, b.accent, 1.8);
}
function bossAttack() {
  const b = G.boss, P = G.P, r = rnd(1);
  if (r < 0.3) { fireEnemySpread(b.x - 40, FLOOR - 130, Math.sign(P.x - b.x) || -1, 7, 5.6, b.biome.bossEl); Sound.sfx('shoot'); }
  else if (r < 0.56) {
    const x = clamp(P.x + rnd(-40, 40), 60, ROOM_W - 60);
    const seg = G.terrain ? groundSegmentAt(G.terrain, x) : null;
    G.zones.push({ kind: 'warn', x, y: seg ? seg.y : FLOOR, w: 150, t: 0.85, max: 0.85, dmg: 18 + G.run.biome * 3, done: false, color: PAL.red });
    Sound.sfx('charge');
  } else if (r < 0.8) {
    for (let i = 0; i < 3; i++) spawnFoe(pick(FOE_IDS), b.x - 120 - i * 70);
  } else { b.act = 'dash'; b.actT = 0.7; b.face = Math.sign(P.x - b.x) || -1; Sound.sfx('dash'); }
}
function updateBoss(dt) {
  const b = G.boss; if (!b || b.dead) return;
  b.t += dt; b.flash = Math.max(0, b.flash - dt);
  const P = G.P;
  if (b.act === 'dash') { b.actT -= dt; b.x += b.face * 11; if (b.actT <= 0) b.act = null; }
  else {
    b.x += Math.sign(P.x - b.x) * 0.85 * G.slow;
    b.cd -= dt;
    if (b.cd <= 0) { b.cd = Math.max(1.1, 2.2 - G.run.biome * 0.2); bossAttack(); }
  }
  b.x = clamp(b.x, 120, ROOM_W - 90);
  if (overlap(P.x, P.y - 42, 30, 82, b.x, FLOOR - 115, 90, 210)) hurtPlayer(14 + G.run.biome * 3, b.x);
}
function bossDown() {
  const b = G.boss; b.dead = true; b.hp = 0;
  const bx = b.x; G.boss = null;
  Sound.sfx('boom'); flash('#fff0bc', 0.6); shake(18);
  burst(bx, FLOOR - 120, 40, PAL.gold, 320);
  G.run.kills++; heal(25);
  clearRoom();
}

// ---------------------------------------------------------------------------
// 拾取物 / 子弹 / 区域 / 粒子
// ---------------------------------------------------------------------------
function spawnPickup(type, x, y, value = 1) {
  const map = {
    coin: { im: ICON.coin, glow: 'rgba(255,215,110,.6)' },
    heal: { im: ICON.heal, glow: 'rgba(150,230,180,.6)' },
    boon: { im: ICON.skill, glow: 'rgba(200,160,255,.7)', label: '★' },
  };
  G.pickups.push({ type, x, y, vx: rnd(-2, 2), vy: -3, value, seed: rnd(6.28), life: 30, ...(map[type] || {}) });
}
function updatePickups(dt) {
  const P = G.P;
  for (const p of G.pickups) {
    p.life -= dt;
    const gy = G.terrain ? groundAt(G.terrain, p.x) : FLOOR;
    const floor = (gy == null ? FLOOR + 60 : gy) - 16;
    if (p.vy || p.y < floor) { p.vy += 0.5; p.y = Math.min(floor, p.y + p.vy); p.x += p.vx; p.vx *= 0.96; }
    const d = Math.hypot(P.x - p.x, (P.y - 42) - p.y);
    if (d < 100) { p.x = lerp(p.x, P.x, 0.16); p.y = lerp(p.y, P.y - 42, 0.16); }
    if (d < 36) { collect(p); p.life = -1; }
  }
  G.pickups = G.pickups.filter(p => p.life > 0);
}
function collect(p) {
  const P = G.P;
  if (p.type === 'coin') { const v = Math.max(1, Math.round(p.value * P.greed)); P.coin += v; Sound.sfx('coin'); floatText(p.x, p.y - 20, '+' + v, PAL.gold, 13); }
  else if (p.type === 'heal') { heal(24); Sound.sfx('heal'); }
  else if (p.type === 'boon') { Sound.sfx('card'); openCards(G.nextRisk ? 2 : 1, afterReward); }
}
function updateShots(dt) {
  const P = G.P;
  for (const s of G.shots) {
    s.life -= dt; s.x += s.vx; s.y += s.vy;
    for (const e of G.enemies) {
      if (!alive(e) || s.hit.has(e) || e.spawnT > 0) continue;
      if (overlap(s.x, s.y, 26, 58, e.x, foeCy(e), e.w, e.h)) {
        s.hit.add(e); hitFoe(e, s.dmg, Math.sign(s.vx), { element: s.element, quiet: true });
        if (s.hit.size > (s.pierce || 0)) s.life = -1;
      }
    }
    if (G.boss && !G.boss.dead && !s.hit.has(G.boss) && overlap(s.x, s.y, 26, 58, G.boss.x, FLOOR - 115, 100, 220)) {
      s.hit.add(G.boss); hitBoss(s.dmg, Math.sign(s.vx), { quiet: true, element: s.element });
      if (s.hit.size > (s.pierce || 0)) s.life = -1;
    }
    hitProps(s.x, s.y, 14, s.element);
  }
  G.shots = G.shots.filter(s => s.life > 0 && s.x > -40 && s.x < ROOM_W + 40);
  for (const s of G.eshots) {
    s.life -= dt; s.x += s.vx; s.y += s.vy;
    if (overlap(s.x, s.y, s.r * 2, s.r * 2, P.x, P.y - 42, 30, 80)) { hurtPlayer(s.dmg, s.x); s.life = -1; }
  }
  G.eshots = G.eshots.filter(s => s.life > 0 && s.x > -40 && s.x < ROOM_W + 40);
}
function updateTerrain(dt) {
  const t = G.terrain; if (!t) return;
  const P = G.P;
  // 移动平台：记录上一帧位置，带动站在上面的玩家
  for (const p of t.plats) {
    if (p.broken) continue;
    const prevX = p.x;
    p.t = (p.t || 0) + dt;                       // 先推进时间，避免首帧 Math.sin(NaN)
    if (p.kind === 'moving') p.x = p.ox + Math.sin(p.t * p.speed + p.phase) * p.amp;
    if (P.onPlat === p && p.kind === 'moving') P.x = clamp(P.x + (p.x - prevX), 24, ROOM_W - 24);
    if (p.breakT > 0) {
      p.breakT -= dt;
      if (p.breakT <= 0) {
        p.broken = true; Sound.sfx('shatter');
        burst(p.x + p.w / 2, p.y, 12, PAL.cut, 180);
        floatText(p.x + p.w / 2, p.y - 16, tr('room.fragile'), '#fff', 12);
        // 平台上的道具坠落
        for (const pr of t.props) if (pr.platId === p.id && pr.alive) { pr.alive = false; spawnPickup('coin', pr.x, pr.y, 2); }
      }
    }
  }
  // 移动平台上的道具跟随
  for (const pr of t.props) {
    if (!pr.alive || !pr.platId) continue;
    const p = t.plats.find(q => q.id === pr.platId);
    if (p) { pr.x = p.x + p.w / 2; pr.y = p.y - 20; }
  }
}
function updateZones(dt) {
  const P = G.P;
  for (const z of G.zones) {
    z.t -= dt;
    if (z.kind === 'field') {
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.4;
        for (const e of G.enemies) if (alive(e) && Math.abs(e.x - z.x) < z.w / 2 && Math.abs(e.y - z.y) < 90)
          hitFoe(e, z.dmg, 1, { quiet: true, element: z.element, noSoak: true });
        particle(z.x + rnd(-z.w / 2, z.w / 2), z.y, rnd(-20, 20), rnd(-80, -30), 0.5, z.color, 3, 'star');
      }
    } else if (z.kind === 'warn' && z.t <= 0 && !z.done) {
      z.done = true; Sound.sfx('boom', 0.6); shake(8);
      burst(z.x, z.y - 10, 18, PAL.violet, 240);
      if (Math.abs(P.x - z.x) < z.w / 2 && Math.abs(P.y - z.y) < 60) hurtPlayer(z.dmg, z.x);
    }
  }
  G.zones = G.zones.filter(z => z.t > -0.4);
}
function updateFX(dt) {
  for (const p of G.parts) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 260 * dt; }
  G.parts = G.parts.filter(p => p.life > 0);
  for (const t of G.texts) t.life -= dt;
  G.texts = G.texts.filter(t => t.life > 0);
  for (const t of G.trails) t.life -= dt;
  G.trails = G.trails.filter(t => t.life > 0);
  G.shake = Math.max(0, G.shake - dt * 26);
  if (G.flash) { G.flash.t -= dt; if (G.flash.t <= 0) G.flash = null; }
  if (G.banner) { G.banner.t += dt; if (G.banner.t >= G.banner.dur) G.banner = null; }
  if (G.reactBanner) { G.reactBanner.t -= dt; if (G.reactBanner.t <= 0) G.reactBanner = null; }
  if (G.comboT > 0) { G.comboT -= dt; if (G.comboT <= 0) G.combo = 0; }
  if (G.slowT > 0) { G.slowT -= dt; if (G.slowT <= 0) G.slow = 1; }
}

// ---------------------------------------------------------------------------
// 房间流程
// ---------------------------------------------------------------------------
function startRun() {
  G.run = { biome: 0, idx: 0, n: 0, kills: 0, time: 0, risk: false };
  G.nextRisk = false; G.winT = 0; G.combo = 0; G.comboT = 0; G.reactions = 0;
  G.reactBanner = null;
  makePlayer();
  if (G.save.up.seed) giveRandomBoon();
  clearEntities();
  setState('play');
  Sound.bgm(BIOMES[0].bgm);
  loadRoom(PLAN[0]);
}
function clearEntities() {
  G.enemies.length = 0; G.shots.length = 0; G.eshots.length = 0;
  G.pickups.length = 0; G.parts.length = 0; G.texts.length = 0;
  G.zones.length = 0; G.trails.length = 0; G.boss = null;
  G.banner = null; G.trans = null; G.flash = null; G.shake = 0;
}
function buildWaves(elite) {
  const bi = G.run.biome, idx = G.run.idx, t = G.terrain;
  const pool = bi === 0 ? ['ember', 'tide', 'gale', 'stone'] :
               bi === 1 ? ['tide', 'gale', 'frost', 'dawn'] :
               bi === 2 ? ['ember', 'frost', 'dawn', 'stone'] :
                          ['gale', 'frost', 'dawn', 'stone', 'ember'];
  const count = 2 + (idx > 0 ? 1 : 0) + (elite ? 1 : 0);
  const waves = [];
  for (let w = 0; w < count; w++) {
    const n = 2 + Math.min(2, Math.floor((bi + w) / 2)) + (elite ? 1 : 0);
    waves.push(Array.from({ length: n }, () => pick(pool)));
  }
  return waves;
}
function loadRoom(kind) {
  const run = G.run, P = G.P, b = BIOMES[run.biome];
  clearEntities();
  const gen = genSolvable((run.n * 131 + run.biome * 977 + 17) >>> 0, run.biome);
  G.terrain = gen.terrain;
  G.room = {
    kind, cleared: false, waveIdx: -1, waveT: 0, t: 0, doors: [],
    waves: [], bossT: 0, risk: !!G.nextRisk, solvable: gen.check,
  };
  const sy = groundAt(G.terrain, G.terrain.startX) ?? FLOOR;
  P.x = G.terrain.startX; P.y = sy; P.vx = 0; P.vy = 0;
  P.ground = true; P.jumps = 0; P.dive = 0; P.dashT = 0; P.onPlat = null;
  P.inv = 0.7; P.shield = P.shieldMax;
  G.cam.x = 0;
  if (P.roomHeal) heal(P.roomHeal);
  Sound.bgm(b.bgm);

  if (kind === 'shop') { enterShop(); return; }
  setState('play');
  if (run.idx === 0) banner(b.sub, b.name, b.accent, 1.9);
  if (kind === 'boss') G.room.bossT = 1.25;
  else {
    G.room.waves = buildWaves(G.room.risk);
    if (G.room.risk) floatText(P.x, P.y - 110, tr('door.risk'), PAL.berry, 18);
  }
}
function startWave(i) {
  const r = G.room, t = G.terrain;
  r.waveIdx = i; r.waveT = 0.65;
  const list = r.waves[i];
  // 前两只放在玩家所在段的右侧，保证开场立刻接战；其余散布到后续段
  const here = t ? groundSegmentAt(t, G.P.x) : null;
  const segs = t ? t.ground.filter(g => g.x > G.P.x + 120) : [];
  list.forEach((type, k) => {
    let x;
    if (k < 2 && here && here.w > 220) x = here.x + here.w - 44 - k * 48;
    else if (segs.length) { const g = segs[k % segs.length]; x = g.x + 40 + (k * 53) % Math.max(1, g.w - 80); }
    else x = G.P.x + 220 + k * 60;
    spawnFoe(type, x, r.risk);
  });
  Sound.sfx('boss', 0.3);
  floatText(G.P.x, G.P.y - 120, i === r.waves.length - 1 ? tr('room.finalWave') : tr('room.wave', { n: i + 1 }), PAL.gold, 17);
}
function clearRoom() {
  const r = G.room; if (r.cleared) return;
  r.cleared = true;
  Sound.sfx('card');
  floatText(G.P.x, G.P.y - 120, tr('room.clear'), PAL.mint, 20);
  heal(6);
  spawnPickup('boon', G.P.x + G.P.face * 46, G.P.y - 40);
}
function afterReward() {
  const r = G.room, run = G.run;
  if (r.kind === 'boss' && run.biome >= BIOMES.length - 1) { G.winT = 1.9; return; }
  spawnDoors();
}
function spawnDoors() {
  const r = G.room, run = G.run, t = G.terrain;
  const baseX = t ? t.doorX : ROOM_W - 130;
  const y = t ? t.doorY : FLOOR;
  if (r.kind === 'boss') {
    if (run.biome >= BIOMES.length - 1) return;
    r.doors.push({ x: baseX, y, risk: false, next: true, near: false });
  } else {
    r.doors.push({ x: clamp(baseX - 130, 200, ROOM_W - 160), y, risk: false, near: false });
    r.doors.push({ x: baseX, y, risk: true, near: false });
  }
  Sound.sfx('door');
}
function enterDoor(d) {
  if (G.trans) return;
  Sound.sfx('door');
  transition(() => {
    const run = G.run;
    run.n++;
    if (d.next) { run.biome++; run.idx = 0; }
    else run.idx++;
    G.nextRisk = !!d.risk;
    loadRoom(PLAN[run.idx]);
  });
}
function interact() {
  const P = G.P, r = G.room;
  if (!(Input.hit('ok') || Input.hit('up')) || G.trans || P.dead) return;
  if (!r || !r.doors.length) return;
  for (const d of r.doors) {
    if (Math.abs(P.x - d.x) < 44 && Math.abs(P.y - (d.y || FLOOR)) < 60) { enterDoor(d); return; }
  }
}

// ---------------------------------------------------------------------------
// 星辉 / 商店 / 结算
// ---------------------------------------------------------------------------
function openCards(count, onDone) {
  const pool = BOONS.filter(b => !G.P.boons.includes(b.id) || chance(0.15));
  const opts = shuffle(pool).slice(0, 3);
  while (opts.length < 3) opts.push(pick(BOONS));
  G.cards = { options: opts, pick: 0, count, onDone };
  setState('cards');
}
function cardPick(i) {
  const c = G.cards; if (!c) return;
  const bo = c.options[clamp(i, 0, c.options.length - 1)];
  bo.apply(G.P); G.P.boons.push(bo.id);
  Sound.sfx('card'); flash(PAL.goldSoft, 0.35);
  floatText(G.P.x, G.P.y - 120, locObj(bo), PAL.gold, 20);
  c.count--;
  if (c.count > 0) { openCards(c.count, c.onDone); return; }
  const done = c.onDone;
  G.cards = null; setState('play');
  if (done) done();
}
function giveRandomBoon() { const bo = pick(BOONS); bo.apply(G.P); G.P.boons.push(bo.id); }
function enterShop() {
  G.shop = { stock: shuffle(SHOP_ITEMS).slice(0, 3).map(def => ({ def, sold: false })), i: 0, msg: null };
  setState('shop');
}
function shopBuy(i) {
  const s = G.shop, P = G.P; if (!s || i == null) return;
  s.i = i;
  const it = s.stock[i]; if (!it || it.sold) return;
  const price = Math.max(1, Math.round(it.def.price * P.discount));
  if (P.coin < price) { s.msg = tr('shop.poor'); Sound.sfx('hit', 0.5); return; }
  P.coin -= price; it.sold = true; s.msg = null;
  if (it.def.boon) giveRandomBoon(); else it.def.apply(P);
  Sound.sfx('buy'); flash(PAL.goldSoft, 0.22);
  floatText(P.x, P.y - 110, locObj(it.def), PAL.gold, 17);
}
function shopLeave() {
  if (G.trans) return;
  Sound.sfx('door');
  transition(() => { G.run.n++; G.run.idx++; G.nextRisk = false; loadRoom(PLAN[G.run.idx]); });
}
function finishRun(win) {
  const run = G.run, P = G.P;
  const dust = Math.floor(run.kills * 0.7 + run.n * 9 + (win ? 90 : 0) + P.coin * 0.16 + G.reactions * 1.5);
  G.save.stardust += dust;
  const score = run.biome * 100 + run.idx * 10 + run.n;
  let newbest = false;
  if (!G.save.best || score > G.save.best.score || (win && !G.save.best.win)) {
    G.save.best = { win, chapter: run.biome, rooms: run.n, kills: run.kills, time: Math.floor(run.time), score };
    newbest = true;
  }
  persist();
  G.result = { win, chapter: run.biome, rooms: run.n, kills: run.kills, coin: Math.floor(P.coin), time: Math.floor(run.time), dust, reactions: G.reactions, newbest };
  setState('result');
  Sound.bgm(win ? 'bgm_battle_win_0.mp3' : 'bgm_Prologue_0.mp3');
  Sound.sfx(win ? 'win' : 'die');
}
function enterHub() {
  G.run = null; G.room = null; G.boss = null; G.cards = null; G.shop = null;
  G.result = null; G.terrain = null; G.reactBanner = null; G.hub.i = 0;
  clearEntities(); setState('hub');
  Sound.bgm('bgm_town_1_0.mp3');
}
function buyUpgrade(i) {
  const m = META[i]; if (!m) return;
  const lv = G.save.up[m.id] || 0;
  if (lv >= m.max) return;
  const cost = m.cost(lv);
  if (G.save.stardust < cost) { Sound.sfx('hit', 0.5); return; }
  G.save.stardust -= cost; G.save.up[m.id] = lv + 1;
  persist(); Sound.sfx('buy');
}

// ---------------------------------------------------------------------------
// 各状态更新
// ---------------------------------------------------------------------------
function stepTitle() {
  const n = 4;
  if (Input.hit('up')) G.menu.i = (G.menu.i + n - 1) % n;
  if (Input.hit('down')) G.menu.i = (G.menu.i + 1) % n;
  if (Input.hit('ok')) G.actions[['titleStart', 'titleHowto', 'titleLang', 'titleSound'][G.menu.i]]();
}
function stepHowto() { if (Input.hit('ok') || Input.hit('pause')) G.actions.howtoBack(); }
function stepHub() {
  const n = META.length + 1;
  if (Input.hit('left')) G.actions.hubPrev();
  if (Input.hit('right')) G.actions.hubNext();
  if (Input.hit('up')) G.hub.i = (G.hub.i + n - 1) % n;
  if (Input.hit('down')) G.hub.i = (G.hub.i + 1) % n;
  if (Input.hit('ok')) { if (G.hub.i < META.length) buyUpgrade(G.hub.i); else G.actions.hubGo(); }
  if (Input.hit('pause')) G.actions.hubBack();
}
function stepCards() {
  const c = G.cards; if (!c) return;
  if (Input.hit('left')) { c.pick = (c.pick + 2) % 3; Sound.sfx('ui'); }
  if (Input.hit('right')) { c.pick = (c.pick + 1) % 3; Sound.sfx('ui'); }
  if (Input.hit('c1')) cardPick(0);
  else if (Input.hit('c2')) cardPick(1);
  else if (Input.hit('c3')) cardPick(2);
  else if (Input.hit('ok')) cardPick(c.pick);
}
function stepShop() {
  const s = G.shop; if (!s) return;
  if (Input.hit('left')) { s.i = (s.i + 3) % 4; Sound.sfx('ui'); }
  if (Input.hit('right')) { s.i = (s.i + 1) % 4; Sound.sfx('ui'); }
  if (Input.hit('up') || Input.hit('ok')) { if (s.i < 3) shopBuy(s.i); else shopLeave(); }
  if (Input.hit('pause')) shopLeave();
}
function stepPause() {
  const acts = ['pauseResume', 'pauseQuit', 'pauseSound', 'pauseLang'];
  const n = acts.length;
  if (Input.hit('up')) G.pause.i = (G.pause.i + n - 1) % n;
  if (Input.hit('down')) G.pause.i = (G.pause.i + 1) % n;
  if (Input.hit('ok')) G.actions[acts[G.pause.i]]();
  if (Input.hit('pause')) G.actions.pauseResume();
}
function stepPlay(dt) {
  if (Input.hit('pause') && !G.P.dead) { setState('pause'); G.pause.i = 0; Sound.sfx('ui'); return; }
  const r = G.room; if (!r) return;
  G.run.time += dt; r.t += dt;
  const wdt = dt * G.slow;

  updatePlayer(dt);
  if (!G.P.dead) interact();
  updateTerrain(dt);
  for (const e of G.enemies) if (alive(e)) updateFoe(e, wdt);
  updateBoss(wdt);
  updateShots(wdt);
  updatePickups(dt);
  updateZones(dt);
  updateFX(dt);
  G.enemies = G.enemies.filter(e => !e.dead);

  // 相机（横向）
  const tx = clamp(G.P.x - W / 2 + G.P.face * 36, 0, ROOM_W - W);
  G.cam.x = lerp(G.cam.x, tx, 0.1);
  for (const d of r.doors) d.near = Math.abs(G.P.x - d.x) < 44 && Math.abs(G.P.y - (d.y || FLOOR)) < 60;

  if (r.kind === 'boss') {
    if (r.bossT > 0) { r.bossT -= dt; if (r.bossT <= 0) spawnBoss(); }
  } else if (!r.cleared) {
    if (r.waveIdx < 0) { if (r.t > 0.85) startWave(0); }
    else if (!G.enemies.some(alive)) {
      r.waveT -= wdt;
      if (r.waveT <= 0) {
        if (r.waveIdx < r.waves.length - 1) startWave(r.waveIdx + 1);
        else clearRoom();
      }
    }
  }
  if (G.winT > 0) { G.winT -= dt; if (G.winT <= 0) { finishRun(true); return; } }
  if (G.P.dead && G.stT > 1.6) { finishRun(false); return; }
}
function step(dt) {
  G.t += dt; G.stT += dt;
  if (Input.hit('mute')) toggleSound();
  if (G.trans) {
    const t = G.trans; t.t += dt;
    if (!t.done && t.t >= t.dur / 2) { t.done = true; t.fn(); G.trans = t; }
    if (t.t >= t.dur) G.trans = null;
    return;
  }
  switch (G.state) {
    case 'loading': break;
    case 'title': stepTitle(); break;
    case 'howto': stepHowto(); break;
    case 'hub': stepHub(); break;
    case 'play': stepPlay(dt); break;
    case 'cards': stepCards(); updateFX(dt * 0.35); break;
    case 'shop': stepShop(); updateFX(dt * 0.35); break;
    case 'pause': stepPause(); break;
    case 'result': if (Input.hit('ok') && G.stT > 0.5) G.actions.resultAgain(); break;
  }
}

// ---------------------------------------------------------------------------
// UI 动作表
// ---------------------------------------------------------------------------
function registerActions() {
  G.actions = {
    titleStart: () => { Sound.sfx('ui'); enterHub(); },
    titleHowto: () => { Sound.sfx('ui'); setState('howto'); },
    titleLang: () => toggleLang(),
    titleSound: () => toggleSound(),
    howtoBack: () => { Sound.sfx('ui'); setState('title'); },
    hubPrev: () => { Sound.sfx('ui'); G.hero = (G.hero + HEROES.length - 1) % HEROES.length; persist(); },
    hubNext: () => { Sound.sfx('ui'); G.hero = (G.hero + 1) % HEROES.length; persist(); },
    hubBack: () => { Sound.sfx('ui'); setState('title'); Sound.bgm('bgm_Prologue_0.mp3'); },
    hubGo: () => { Sound.sfx('ui'); startRun(); },
    hubSelect: (i) => { G.hub.i = i; buyUpgrade(i); },
    cardPick: (i) => cardPick(i),
    shopSelect: (i) => { G.shop.i = i; },
    shopBuy: (i) => shopBuy(i == null ? (G.shop ? G.shop.i : 0) : i),
    shopLeave: () => shopLeave(),
    pauseResume: () => { Sound.sfx('ui'); setState('play'); },
    pauseQuit: () => { Sound.sfx('ui'); finishRun(false); },
    pauseSound: () => toggleSound(),
    pauseLang: () => toggleLang(),
    resultAgain: () => { Sound.sfx('ui'); enterHub(); },
  };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
export async function boot() {
  const el = document.getElementById('game');
  initCanvas(el); bindInput(el);
  G.save = Save.load();
  G.lang = G.save.lang || 'zh'; setLang(G.lang);
  G.muted = !!G.save.muted; Sound.setMuted(G.muted);
  G.hero = clamp(G.save.hero | 0, 0, HEROES.length - 1);
  G.state = 'loading'; G.loadP = 0;
  registerActions();
  await preload(assetList(), (p) => { G.loadP = p; });
  G.loadP = 1; setState('title');
  Sound.bgm('bgm_Prologue_0.mp3');

  let last = performance.now(), acc = 0;
  function frame(now) {
    const rdt = Math.min(0.05, (now - last) / 1000); last = now; acc += rdt;
    let n = 0;
    while (acc >= STEP && n++ < 5) { step(STEP); acc -= STEP; Input.clearJust(); }
    if (acc > STEP * 5) acc = 0;
    render();
    document.body.classList.toggle('playing', G.state === 'play' || G.state === 'pause');
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__starfall = {
    G, IMG, Sound, Input, step, render, startRun, loadRoom, finishRun, enterHub,
    openCards, enterShop, hitFoe, hitBoss, soak, doReaction, reactionOf,
    clearRoom, spawnDoors, cardPick, spawnFoe, doNova, doSlash, doDive,
    setElement, genSolvable, validateTerrain, PHYS,
    HEROES, BIOMES, BOONS, SHOP_ITEMS, ELEMENTS, FOES, setState,
    tick(n = 1) { for (let i = 0; i < n; i++) { step(STEP); Input.clearJust(); } render(); },
  };
}
