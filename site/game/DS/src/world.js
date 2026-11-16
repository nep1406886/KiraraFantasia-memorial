// ============================================================
// 舞台世界：房间生成、平台、机关、背景与前景
// ============================================================
import { G } from './state.js';
import { W, H, FLOOR, ROOM_W, WALL, SCENES, EL } from './config.js';
import { ACTS } from './data/acts.js';
import { ACT_POOLS, ELITES, BOSSES } from './data/enemies.js';
import { getImg, ready, drawCover } from './core/assets.js';
import { clamp, rnd, rint, TAU, hexA, damp, lerp, hash2 } from './utils.js';
import { FX } from './fx.js';
import { Audio } from './core/audio.js';
import { hurtPlayer } from './combat.js';

export function createRoom(run, type, opts = {}) {
  const act = ACTS[run.act] || ACTS[0];
  const rng = run.rng;
  const boss = type === 'boss';
  const w = boss ? 1640 : ROOM_W;
  const platforms = [];
  const ground = { x: -WALL, y: FLOOR, w: w + WALL * 2, h: H - FLOOR + 40, ground: true };
  if (boss) {
    platforms.push(
      { x: 250, y: 480, w: 190, h: 16, oneWay: true, style: 1 },
      { x: w - 440, y: 480, w: 190, h: 16, oneWay: true, style: 1 },
      { x: w * .5 - 120, y: 340, w: 240, h: 16, oneWay: true, style: 2 },
    );
  } else {
    const base = [
      { x: 365, y: 498, w: 220, h: 16, oneWay: true },
      { x: 720, y: 414, w: 245, h: 16, oneWay: true },
      { x: 1090, y: 508, w: 230, h: 16, oneWay: true },
      { x: 1440, y: 400, w: 260, h: 16, oneWay: true },
      { x: 1810, y: 500, w: 225, h: 16, oneWay: true },
      { x: 2140, y: 402, w: 210, h: 16, oneWay: true },
    ];
    for (const p of base) if (p.x + p.w < w - 50) platforms.push(p);
    if (rng.chance(.4)) platforms.push({ x: rng.range(200, w - 400), y: rng.range(300, 350), w: 200, h: 16, oneWay: true });
  }

  let waves = [];
  if (boss) {
    waves = [{ list: [], boss: true, delay: 1.2 }];
  } else {
    const stage = run.stage;
    const waveCount = type === 'elite' ? 2 : (2 + (stage >= 2 ? 1 : 0));
    for (let wi = 0; wi < waveCount; wi++) {
      const list = [];
      if (type === 'elite' && wi === 0) {
        const e = rng.pick(ELITES[run.act] || ['puppet']);
        list.push(e);
        for (let i = 0; i < 2; i++) list.push(rng.pick(ACT_POOLS[run.act]));
      } else {
        const n = 3 + Math.min(2, Math.floor(stage / 2)) + (type === 'elite' ? 1 : 0);
        for (let i = 0; i < n; i++) list.push(rng.pick(ACT_POOLS[run.act]));
      }
      waves.push({ list, delay: wi === 0 ? 1 : .95 });
    }
  }

  const hazards = [];
  if (act.hazards.includes('spotlight') && !boss) {
    hazards.push({ type: 'spotlight', t: rng.range(3.5, 5), interval: rng.range(5.5, 7.5), warn: 0, x: 0, strike: 0, started: false });
  }
  if (act.hazards.includes('geyser') && !boss) {
    hazards.push({ type: 'geyser', t: rng.range(4, 6), interval: rng.range(5.5, 7), warn: 0, x: 0, strike: 0, started: false });
  }
  if (act.hazards.includes('sandstorm') && !boss) {
    hazards.push({ type: 'sandstorm', t: rng.range(6, 8), interval: 13, warn: 0, x: 0, dir: 1, strike: 0, started: false });
  }

  return {
    type, act: run.act, stage: run.stage, w, groundY: FLOOR,
    platforms, ground, waves, waveIndex: -1, waveT: 0,
    cleared: false, started: false, bossId: BOSSES[act.boss]?.id,
    hazards, seed: rng.int(1, 999999),
    clearT: 0, time: 0, doors: [],
    bounds: { left: WALL, right: w - WALL },
  };
}

export function updateWorld(dt) {
  const room = G.room;
  if (!room) return;
  room.time += dt;
  if (!room.started) return;
  // 机关
  if (!room.cleared) for (const hz of room.hazards) {
    hz.t -= dt;
    if (hz.type === 'spotlight') {
      if (hz.t <= 0 && hz.warn <= 0 && hz.strike <= 0) {
        hz.warn = 1.15;
        hz.x = hz.x || 0;
        hz.x = pickHazardX(room, 120);
        Audio.sfx('warning', { volume: .4 });
      }
      if (hz.warn > 0) {
        hz.warn -= dt;
        if (hz.warn <= 0) {
          hz.strike = .28;
          Audio.sfx('beam', { volume: .5 });
          FX.ring(hz.x, FLOOR - 8, 60, '#ffe9b0', { life: .4, width: 4, squash: .25 });
          FX.burst(hz.x, FLOOR - 16, { count: 12, color: '#ffe9b0', speed: 260, size: 4, life: .4, glow: true, shape: 'spark' });
          FX.shake(.18);
        }
      } else if (hz.strike > 0) {
        hz.strike -= dt;
        checkHazardHit(hz.x, FLOOR - 12, 34, 140, 16, hz);
        if (hz.strike <= 0) hz.t = hz.interval;
      }
    } else if (hz.type === 'geyser') {
      if (hz.t <= 0 && hz.warn <= 0 && hz.strike <= 0) {
        hz.warn = 1;
        hz.x = pickHazardX(room, 100);
        Audio.sfx('warning', { volume: .4 });
      }
      if (hz.warn > 0) {
        hz.warn -= dt;
        if (hz.warn <= 0) {
          hz.strike = .5;
          Audio.sfx('explode', { volume: .35 });
          FX.burst(hz.x, FLOOR - 30, { count: 20, colors: ['#9fd8ff', '#e8f6ff'], speed: 400, size: 5, life: .7, glow: true, gravity: 300 });
          FX.ring(hz.x, FLOOR - 10, 75, '#9fd8ff', { life: .45, width: 4, squash: .35 });
          FX.shake(.16);
        }
      } else if (hz.strike > 0) {
        hz.strike -= dt;
        checkHazardHit(hz.x, FLOOR - 110, 42, 220, 14, hz);
        if (hz.strike <= 0) hz.t = hz.interval;
      }
    } else if (hz.type === 'sandstorm') {
      if (hz.t <= 0 && hz.warn <= 0 && hz.strike <= 0) {
        hz.warn = 1.2;
        hz.dir = Math.random() < .5 ? 1 : -1;
        Audio.sfx('warning', { volume: .5 });
      }
      if (hz.warn > 0) {
        hz.warn -= dt;
        if (hz.warn <= 0) {
          hz.strike = 3.2;
          Audio.sfx('dash', { volume: .6 });
        }
      } else if (hz.strike > 0) {
        hz.strike -= dt;
        if (G.player) {
          G.player.vx += hz.dir * 110 * dt;
          if (G.player.grounded && Math.random() < .12) FX.dust(G.player.x - hz.dir * 20, G.player.y, 1, 'rgba(230,190,130,.4)');
          if (Math.random() < .06) hurtPlayer(3.5, G.player.x - hz.dir * 100, {});
        }
        if (Math.random() < .5) {
          FX.p({
            x: hz.dir > 0 ? G.cam.x - 20 : G.cam.x + W + 20,
            y: rnd(120, FLOOR - 20), vx: hz.dir * rnd(500, 900), vy: rnd(-40, 40),
            life: rnd(.5, 1), size: rnd(1.5, 3), color: '#e0b878', glow: false, shape: 'spark', alpha: .7,
          });
        }
        if (hz.strike <= 0) hz.t = hz.interval;
      }
    }
  }
}

// 为机关挑一个落点：远离玩家，也尽量不压在活着的敌人头上
function pickHazardX(room, margin) {
  for (let i = 0; i < 16; i++) {
    const x = rnd(room.bounds.left + margin, room.bounds.right - margin);
    if (G.player && Math.abs(x - G.player.x) < 190) continue;
    let onEnemy = false;
    for (const e of G.enemies) {
      if (e.dead || e.spawning > 0) continue;
      if (Math.abs(x - e.x) < 140) { onEnemy = true; break; }
    }
    if (!onEnemy) return x;
  }
  return rnd(room.bounds.left + margin, room.bounds.right - margin);
}

function checkHazardHit(x, y, w, h, dmg, hz) {
  const p = G.player;
  if (!p) return;
  const rect = { x: x - w / 2, y: y - h / 2, w, h };
  const box = { x: p.x - 24, y: p.y - 150, w: 48, h: 150 };
  if (box.x < rect.x + rect.w && box.x + box.w > rect.x && box.y < rect.y + rect.h && box.y + box.h > rect.y) {
    if (!hz.hitT || hz.hitT <= 0) {
      hurtPlayer(dmg, x, {});
      hz.hitT = .5;
    }
  }
  if (hz.hitT > 0) hz.hitT -= 1 / 60;
}

// ---------------------------------------------------------------------------
// 摄像机
// ---------------------------------------------------------------------------
export function updateCamera(dt) {
  const p = G.player;
  if (!p || !G.room) return;
  const room = G.room;
  const look = p.facing * 80 + clamp(p.vx * .06, -60, 60);
  G.cam.look = damp(G.cam.look, look, 4, dt);
  const target = clamp(p.x + G.cam.look - W * .46, 0, Math.max(0, room.w - W));
  G.cam.x = damp(G.cam.x, target, 7, dt);
  if (G.cam.x < 0) G.cam.x = 0;
  const maxX = Math.max(0, room.w - W);
  if (G.cam.x > maxX) G.cam.x = maxX;
}

export function cameraShakeOffset() {
  const t = G.cam.trauma;
  if (t <= 0) return { x: 0, y: 0 };
  const mag = t * t * 26;
  return { x: rnd(-mag, mag), y: rnd(-mag * .6, mag * .6) };
}

// ---------------------------------------------------------------------------
// 背景
// ---------------------------------------------------------------------------
const ambientCache = new Map();
function ambientFor(seed) {
  if (ambientCache.has(seed)) return ambientCache.get(seed);
  const arr = [];
  const rng = new (class {
    constructor(s) { this.s = s; }
    next() { this.s = (this.s * 1664525 + 1013904223) >>> 0; return this.s / 4294967296; }
    range(a, b) { return a + this.next() * (b - a); }
  })(seed);
  for (let i = 0; i < 46; i++) {
    arr.push({ x: rng.range(0, W), y: rng.range(60, FLOOR - 30), r: rng.range(.8, 2.6), sp: rng.range(.2, 1), ph: rng.range(0, TAU), drift: rng.range(-12, 12) });
  }
  ambientCache.set(seed, arr);
  return arr;
}

export function drawWorldBack(ctx, t) {
  const room = G.room;
  if (!room) return;
  const act = ACTS[room.act] || ACTS[0];
  const cam = G.cam.x;
  const bg = getImg(act.bg);
  ctx.save();
  if (ready(bg)) {
    drawCover(ctx, bg, -30, -30, W + 60, H + 60, -cam * .055, Math.sin(t * .06) * 6, 1.06);
  } else {
    ctx.fillStyle = '#0b0915';
    ctx.fillRect(0, 0, W, H);
  }
  // 色调
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = act.tint;
  ctx.globalAlpha = act.tintA;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // 顶部与底部渐变
  let grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(5,4,10,.82)');
  grad.addColorStop(.28, 'rgba(5,4,10,.18)');
  grad.addColorStop(.62, 'rgba(5,4,10,.08)');
  grad.addColorStop(1, 'rgba(5,4,10,.8)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // 舞台聚光
  grad = ctx.createRadialGradient(W * .5, H * .32, 40, W * .5, H * .45, W * .62);
  grad.addColorStop(0, 'rgba(255,226,170,.10)');
  grad.addColorStop(.5, 'rgba(255,200,130,.03)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // 背景雾层
  drawFog(ctx, t, act, cam);
  // 远景幕布竖纹
  drawBackgroundCurtains(ctx, cam, act);
  ctx.restore();
}

function drawFog(ctx, t, act, cam) {
  if (FX.lowfx) return; // 低特效：跳过每帧三条径向渐变雾层
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 3; i++) {
    const y = 210 + i * 130;
    const off = (t * (12 + i * 6) + i * 300) % (W + 300);
    const g = ctx.createRadialGradient(W * .5, y, 20, W * .5, y, W * .55);
    g.addColorStop(0, hexA(act.fog, .035));
    g.addColorStop(1, hexA(act.fog, 0));
    ctx.fillStyle = g;
    ctx.fillRect(-W * .1 + Math.sin(off * .01) * 40, y - 100, W * 1.2, 200);
  }
  ctx.restore();
}

function drawBackgroundCurtains(ctx, cam, act) {
  ctx.save();
  const w = 110;
  const off = cam * .18;
  for (const side of [0, 1]) {
    const x = side === 0 ? -off - 40 : W - w + 40 - off * .2;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(20,5,12,.55)');
    g.addColorStop(.5, 'rgba(50,12,26,.2)');
    g.addColorStop(1, 'rgba(20,5,12,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, w, H);
  }
  ctx.restore();
}

export function drawWorldMid(ctx, t) {
  const room = G.room;
  if (!room) return;
  drawPlatforms(ctx, room, t);
  drawAmbient(ctx, room, t);
  drawHazardWarnings(ctx, room, t);
  drawSideStages(ctx, room, t);
}

function drawSideStages(ctx, room, t) {
  const cam = G.cam.x;
  // 舞台侧幕（世界边缘）
  const edges = [
    { x: 40 - cam, side: -1 },
    { x: room.w - 40 - cam, side: 1 },
  ];
  for (const e of edges) {
    if (e.x < -150 || e.x > W + 150) continue;
    ctx.save();
    ctx.translate(e.x, 0);
    const g = ctx.createLinearGradient(0, 0, e.side * 110, 0);
    g.addColorStop(0, 'rgba(40,8,20,.86)');
    g.addColorStop(.6, 'rgba(26,6,15,.5)');
    g.addColorStop(1, 'rgba(20,5,12,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(e.side * 120, 0); ctx.lineTo(e.side * 80, H); ctx.lineTo(0, H);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(232,196,126,.14)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(e.side * (10 + i * 18), 0);
      ctx.quadraticCurveTo(e.side * (30 + i * 16), H * .5 + Math.sin(t + i) * 10, e.side * (16 + i * 12), H);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawPlatforms(ctx, room, t) {
  const cam = G.cam.x;
  // 地面舞台
  const fy = FLOOR;
  ctx.save();
  // 地面木纹
  const g = ctx.createLinearGradient(0, fy, 0, H);
  g.addColorStop(0, '#3a2020');
  g.addColorStop(.18, '#2a161a');
  g.addColorStop(1, '#0b070e');
  ctx.fillStyle = g;
  ctx.fillRect(-cam - 40, fy, room.w + 80, H - fy + 40);
  // 金色台缘
  ctx.fillStyle = 'rgba(232,196,126,.28)';
  ctx.fillRect(-cam, fy, room.w, 2);
  ctx.fillStyle = 'rgba(232,196,126,.1)';
  ctx.fillRect(-cam, fy + 3, room.w, 1);
  // 地板缝
  ctx.strokeStyle = 'rgba(0,0,0,.25)';
  ctx.lineWidth = 1;
  const start = Math.floor((cam - 40) / 120) * 120;
  for (let x = start; x < cam + W + 120; x += 120) {
    ctx.beginPath();
    ctx.moveTo(x - cam, fy + 8);
    ctx.lineTo(x - cam + 12, H);
    ctx.stroke();
  }
  // 地面前景暗角
  const fg = ctx.createLinearGradient(0, fy + 120, 0, H);
  fg.addColorStop(0, 'rgba(4,3,8,0)');
  fg.addColorStop(1, 'rgba(4,3,8,.55)');
  ctx.fillStyle = fg;
  ctx.fillRect(0, fy + 100, W, H - fy);
  // 脚灯（低特效时跳过每帧 8 个径向渐变，保留灯点）
  for (let i = 0; i < 8; i++) {
    const x = ((i * 220 - cam * .9) % (W + 300) + W + 300) % (W + 300) - 150;
    if (!FX.lowfx) {
      const glow = ctx.createRadialGradient(x, fy - 4, 0, x, fy - 4, 60);
      glow.addColorStop(0, 'rgba(255,220,160,.22)');
      glow.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - 60, fy - 64, 120, 64);
    }
    ctx.fillStyle = 'rgba(255,236,190,.55)';
    ctx.beginPath();
    ctx.ellipse(x, fy - 3, 4, 2, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  for (const p of room.platforms) {
    const px = p.x - cam;
    if (px + p.w < -50 || px > W + 50) continue;
    ctx.save();
    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.fillRect(px + 8, p.y + 10, p.w, 10);
    // 台板
    const pg = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
    pg.addColorStop(0, '#6a4634');
    pg.addColorStop(.5, '#3d2624');
    pg.addColorStop(1, '#1d1118');
    ctx.fillStyle = pg;
    ctx.fillRect(px, p.y, p.w, p.h);
    // 金色边缘
    ctx.fillStyle = 'rgba(232,196,126,.55)';
    ctx.fillRect(px, p.y, p.w, 1.5);
    ctx.fillStyle = 'rgba(232,196,126,.12)';
    ctx.fillRect(px, p.y + 2, p.w, 2);
    // 侧边金饰
    ctx.strokeStyle = 'rgba(232,196,126,.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 4.5, p.y + 4.5, p.w - 9, p.h - 9);
    // 吊绳
    ctx.strokeStyle = 'rgba(232,196,126,.16)';
    for (const sx of [px + p.w * .18, px + p.w * .82]) {
      ctx.beginPath();
      ctx.moveTo(sx, p.y);
      ctx.lineTo(sx + Math.sin(t * .4 + sx) * 3, -20);
      ctx.stroke();
    }
    // 微光
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createLinearGradient(0, p.y - 20, 0, p.y + 20);
    glow.addColorStop(0, 'rgba(255,220,160,0)');
    glow.addColorStop(.5, 'rgba(255,220,160,.06)');
    glow.addColorStop(1, 'rgba(255,220,160,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(px, p.y - 20, p.w, 40);
    ctx.restore();
  }
}

function drawAmbient(ctx, room, t) {
  const act = ACTS[room.act];
  const cam = G.cam.x;
  const list = ambientFor(room.seed);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const mode = act.particle;
  // 低特效：只画一半的环境粒子，也不画大粒子的辉光
  const stride = FX.lowfx ? 2 : 1;
  for (let ai = 0; ai < list.length; ai += stride) {
    const a = list[ai];
    if (mode === 'sand') {
      const x = ((a.x + t * 70 + a.drift * t * .2) % (W + 80)) - 40;
      const y = a.y + Math.sin(t * 1.2 + a.ph) * 8;
      ctx.globalAlpha = .25 + .25 * Math.sin(t * 2 + a.ph);
      ctx.fillStyle = '#e0b878';
      ctx.fillRect(x, y, a.r * 2.2, .8);
    } else if (mode === 'bubble') {
      const x = a.x + Math.sin(t * .7 + a.ph) * 20;
      const y = (a.y - t * (14 + a.sp * 18)) % (FLOOR - 60);
      const yy = y < 40 ? y + FLOOR - 100 : y;
      ctx.globalAlpha = .22 + .2 * Math.sin(t + a.ph);
      ctx.strokeStyle = '#bfe6ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, yy, a.r, 0, TAU);
      ctx.stroke();
    } else {
      const x = a.x + Math.sin(t * .5 + a.ph) * 24 + a.drift * t * .1;
      const y = a.y + Math.cos(t * .7 + a.ph) * 10;
      const al = .18 + .3 * (Math.sin(t * 1.6 + a.ph) * .5 + .5);
      ctx.globalAlpha = al;
      ctx.fillStyle = '#d8ffcf';
      ctx.beginPath();
      ctx.arc(x, y, a.r, 0, TAU);
      ctx.fill();
      if (a.r > 2 && !FX.lowfx) {
        ctx.globalAlpha = al * .25;
        ctx.beginPath();
        ctx.arc(x, y, a.r * 4, 0, TAU);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawHazardWarnings(ctx, room, t) {
  const cam = G.cam.x;
  for (const hz of room.hazards) {
    if (hz.type === 'spotlight') {
      if (hz.warn > 0) {
        const k = 1 - hz.warn / 1.15;
        const x = hz.x - cam;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = .22 + .4 * k;
        const g = ctx.createLinearGradient(0, 70, 0, FLOOR);
        g.addColorStop(0, 'rgba(255,235,180,.55)');
        g.addColorStop(1, 'rgba(255,235,180,.1)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - 8 - k * 12, 70);
        ctx.lineTo(x + 8 + k * 12, 70);
        ctx.lineTo(x + 34, FLOOR);
        ctx.lineTo(x - 34, FLOOR);
        ctx.closePath();
        ctx.fill();
        // 地面危险圈：填充 + 收缩描边，越接近落下越亮
        ctx.globalAlpha = .18 + .2 * Math.sin(t * 24) * .5 + .22 * k;
        ctx.fillStyle = '#ffd88a';
        ctx.beginPath();
        ctx.ellipse(x, FLOOR - 4, 36, 10, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = .6 + .4 * Math.sin(t * 30);
        ctx.strokeStyle = '#ffe9b0';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(x, FLOOR - 4, 36 - k * 14, 10 - k * 3, 0, 0, TAU);
        ctx.stroke();
        ctx.restore();
        // 头顶惊叹号，隔很远也能看见
        ctx.save();
        ctx.globalAlpha = .65 + .35 * Math.sin(t * 18);
        ctx.fillStyle = '#ffcf7a';
        ctx.font = '700 24px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', x, FLOOR - 210 - Math.sin(t * 10) * 4);
        ctx.restore();
      } else if (hz.strike > 0) {
        const x = hz.x - cam;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = .85;
        const g = ctx.createLinearGradient(0, 60, 0, FLOOR);
        g.addColorStop(0, 'rgba(255,240,190,.9)');
        g.addColorStop(.6, 'rgba(255,220,150,.35)');
        g.addColorStop(1, 'rgba(255,220,150,.05)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - 16, 60); ctx.lineTo(x + 16, 60);
        ctx.lineTo(x + 40, FLOOR); ctx.lineTo(x - 40, FLOOR);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    } else if (hz.type === 'geyser') {
      if (hz.warn > 0) {
        const k = 1 - hz.warn / 1;
        const x = hz.x - cam;
        ctx.save();
        // 半径随预警进度扩张的脉冲水圈
        const rr = 30 + k * 26;
        ctx.globalAlpha = .3 + .25 * Math.sin(t * 24);
        ctx.fillStyle = '#9fd8ff';
        ctx.beginPath();
        ctx.ellipse(x, FLOOR - 3, rr, rr * .3, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = .65 + .35 * Math.sin(t * 26);
        ctx.strokeStyle = '#bfe6ff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(x, FLOOR - 3, rr, rr * .3, 0, 0, TAU);
        ctx.stroke();
        ctx.restore();
        // 预警期就开始冒小水泡
        if (!FX.lowfx && Math.random() < .3) {
          FX.p({ x: x + G.cam.x + rnd(-24, 24), y: FLOOR - rnd(0, 26), vx: 0, vy: rnd(-90, -40), life: .4, size: rnd(1.5, 3), color: '#bfe6ff', glow: true, shape: 'circle' });
        }
        ctx.save();
        ctx.globalAlpha = .6 + .4 * Math.sin(t * 18);
        ctx.fillStyle = '#bfe6ff';
        ctx.font = '700 24px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', x, FLOOR - 210 - Math.sin(t * 10) * 4);
        ctx.restore();
      } else if (hz.strike > 0) {
        const x = hz.x - cam;
        const k = hz.strike / .5;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = .7 * k;
        const g = ctx.createLinearGradient(0, FLOOR - 220, 0, FLOOR);
        g.addColorStop(0, 'rgba(160,220,255,0)');
        g.addColorStop(.35, 'rgba(190,240,255,.5)');
        g.addColorStop(1, 'rgba(230,250,255,.85)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - 18, FLOOR);
        ctx.quadraticCurveTo(x - 60, FLOOR - 130, x - 10, FLOOR - 220);
        ctx.lineTo(x + 10, FLOOR - 220);
        ctx.quadraticCurveTo(x + 60, FLOOR - 130, x + 18, FLOOR);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    } else if (hz.type === 'sandstorm') {
      if (hz.warn > 0) {
        ctx.save();
        ctx.globalAlpha = .14 + .1 * Math.sin(t * 20);
        ctx.fillStyle = '#e0b878';
        ctx.fillRect(0, 0, W, H);
        // 来向箭头：砂从 hz.dir 一侧吹来
        const side = hz.dir > 0 ? 0 : 1; // dir>0 从左侧来
        const ax = side === 0 ? 60 : W - 60;
        const ay = H * .38 + Math.sin(t * 6) * 8;
        ctx.globalAlpha = .5 + .3 * Math.sin(t * 14);
        ctx.strokeStyle = '#e0b878';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        const d = hz.dir;
        ctx.beginPath();
        ctx.moveTo(ax - d * 34, ay);
        ctx.lineTo(ax + d * 34, ay);
        ctx.moveTo(ax + d * 34, ay);
        ctx.lineTo(ax + d * 14, ay - 14);
        ctx.moveTo(ax + d * 34, ay);
        ctx.lineTo(ax + d * 14, ay + 14);
        ctx.stroke();
        ctx.font = '700 13px "Songti SC",serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f2d9a0';
        ctx.fillText('风砂来袭', ax, ay - 34);
        ctx.restore();
      }
    }
  }
}

export function drawWorldFront(ctx, t) {
  const room = G.room;
  if (!room) return;
  const cam = G.cam.x;
  // 前景漂浮尘埃（屏幕空间；低特效减半）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const dustN = FX.lowfx ? 6 : 14;
  for (let i = 0; i < dustN; i++) {
    const x = ((i * 137 + t * (8 + i % 5) - cam * .18) % (W + 40) + W + 40) % (W + 40) - 20;
    const y = ((i * 97 + t * (3 + i % 4)) % (H - 100)) + 50;
    ctx.globalAlpha = .12 + .1 * Math.sin(t * 1.3 + i);
    ctx.fillStyle = '#f8e7bd';
    ctx.beginPath();
    ctx.arc(x, y, .8 + (i % 3) * .5, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  // 底部聚光带
  const g = ctx.createLinearGradient(0, H - 120, 0, H);
  g.addColorStop(0, 'rgba(5,4,10,0)');
  g.addColorStop(1, 'rgba(5,4,10,.55)');
  ctx.fillStyle = g;
  ctx.fillRect(0, H - 120, W, 120);
}

export function drawZones(ctx, t) {
  const cam = G.cam.x;
  for (const z of G.zones) {
    const a = Math.min(1, z.life / z.max * 4);
    const x = z.x - cam;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (z.type === 'moonGate') {
      ctx.globalAlpha = a * .8;
      ctx.translate(x, z.y);
      const r = z.r * (1 + Math.sin(t * 5) * .04);
      ctx.rotate(t * .8);
      ctx.strokeStyle = z.color;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
      ctx.rotate(-t * 1.6);
      ctx.beginPath(); ctx.arc(0, 0, r * .7, 0, TAU); ctx.stroke();
      ctx.globalAlpha = a * .15;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, z.color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    } else if (z.type === 'blackhole') {
      ctx.globalAlpha = a;
      ctx.translate(x, z.y);
      const r = z.r;
      const g = ctx.createRadialGradient(0, 0, r * .05, 0, 0, r);
      g.addColorStop(0, 'rgba(8,4,18,1)');
      g.addColorStop(.55, hexA(z.color, .5));
      g.addColorStop(.82, hexA(z.color, .15));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = hexA(z.color, .6);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, r * (.7 + Math.sin(t * 7) * .04), 0, TAU); ctx.stroke();
    } else if (z.type === 'field' || z.type === 'firefield' || z.type === 'flowerfield') {
      ctx.globalAlpha = a * .5;
      ctx.fillStyle = hexA(z.color, .12);
      ctx.beginPath();
      ctx.ellipse(x, z.y, z.r, z.r * .28, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = a * .5;
      ctx.strokeStyle = z.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(x, z.y, z.r * .92, z.r * .25, 0, 0, TAU);
      ctx.stroke();
    } else if (z.type === 'heal') {
      ctx.globalAlpha = a * .5;
      ctx.fillStyle = hexA('#7bd6bf', .12);
      ctx.beginPath();
      ctx.ellipse(x, z.y, z.r, z.r * .3, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function drawPickups(ctx, t) {
  const cam = G.cam.x;
  for (const k of G.pickups) {
    const x = k.x - cam;
    const y = k.y + Math.sin(t * 4 + k.t * 3) * 4;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalCompositeOperation = 'lighter';
    const r = k.size;
    if (k.type === 'shard') {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 3);
      g.addColorStop(0, 'rgba(255,230,170,.5)');
      g.addColorStop(1, 'rgba(255,230,170,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-r * 3, -r * 3, r * 6, r * 6);
      ctx.rotate(t * 2 + k.t);
      ctx.fillStyle = '#ffe9b0';
      ctx.beginPath();
      ctx.moveTo(0, -r); ctx.lineTo(r * .55, 0); ctx.lineTo(0, r); ctx.lineTo(-r * .55, 0);
      ctx.closePath(); ctx.fill();
    } else if (k.type === 'heart') {
      ctx.fillStyle = '#ff9db6';
      ctx.beginPath();
      ctx.arc(-r * .45, -r * .2, r * .55, 0, TAU);
      ctx.arc(r * .45, -r * .2, r * .55, 0, TAU);
      ctx.moveTo(-r, 0);
      ctx.lineTo(0, r * .95);
      ctx.lineTo(r, 0);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.rotate(t * 1.5);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 3);
      g.addColorStop(0, 'rgba(255,245,200,.8)');
      g.addColorStop(1, 'rgba(255,245,200,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-r * 3, -r * 3, r * 6, r * 6);
      ctx.fillStyle = '#fff3c4';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = i * Math.PI / 5 - Math.PI / 2;
        const rr = i % 2 ? r * .42 : r;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
}
