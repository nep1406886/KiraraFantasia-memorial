// ============================================================
// 特效：粒子、残影、斩击、冲击波、飘字、屏幕震动
// ============================================================
import { G, updateStyle } from './state.js';
import { clamp, rnd, rint, TAU, starPath, hexA, easeOutCubic } from './utils.js';
import { FONT_SERIF, FONT_EN } from './config.js';
import { getImg, ready, silhouette } from './core/assets.js';

const MAX_P = 760;
const glowCache = new Map();
function glowSprite(color) {
  if (glowCache.has(color)) return glowCache.get(color);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, hexA(color, .95));
  grad.addColorStop(.28, hexA(color, .55));
  grad.addColorStop(.7, hexA(color, .1));
  grad.addColorStop(1, hexA(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowCache.set(color, c);
  return c;
}

export const FX = {
  particles: [],
  texts: [],
  slashes: [],
  rings: [],
  ghosts: [],
  beams: [],
  flashes: [],
  trails: [],
  lowfx: false,

  clear() {
    this.particles.length = 0;
    this.texts.length = 0;
    this.slashes.length = 0;
    this.rings.length = 0;
    this.ghosts.length = 0;
    this.beams.length = 0;
    this.flashes.length = 0;
    this.trails.length = 0;
  },

  p(o) {
    if (this.particles.length >= (this.lowfx ? 320 : MAX_P)) this.particles.shift();
    this.particles.push({
      x: o.x, y: o.y, vx: o.vx || 0, vy: o.vy || 0,
      life: o.life ?? .6, max: o.life ?? .6,
      size: o.size ?? 3, color: o.color || '#fff',
      gravity: o.gravity ?? 0, drag: o.drag ?? .9,
      shape: o.shape || 'circle', rot: o.rot ?? rnd(0, TAU), spin: o.spin ?? 0,
      glow: o.glow ?? false, alpha: o.alpha ?? 1, fade: o.fade ?? 1,
      blend: o.blend || (o.glow ? 'lighter' : 'source-over'),
      stretch: o.stretch || 0,
    });
    return this.particles[this.particles.length - 1];
  },

  burst(x, y, opt = {}) {
    // 低特效：爆发粒子减半，配合 FX.p 的总量上限
    const n = this.lowfx ? Math.ceil((opt.count ?? 10) * .5) : (opt.count ?? 10);
    const color = opt.color || '#e8c47e';
    const speed = opt.speed ?? 220;
    const dir = opt.dir ?? null;
    const spread = opt.spread ?? TAU;
    for (let i = 0; i < n; i++) {
      const a = dir == null ? rnd(0, TAU) : dir + rnd(-spread / 2, spread / 2);
      const sp = speed * rnd(.35, 1.1);
      this.p({
        x: x + rnd(-4, 4), y: y + rnd(-4, 4),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: (opt.life ?? .55) * rnd(.65, 1.25),
        size: (opt.size ?? 4) * rnd(.6, 1.35),
        color: opt.colors ? opt.colors[(Math.random() * opt.colors.length) | 0] : color,
        gravity: opt.gravity ?? 0, drag: opt.drag ?? .9,
        shape: opt.shape || 'circle', glow: opt.glow ?? false,
        alpha: opt.alpha ?? 1, spin: rnd(-8, 8), stretch: opt.stretch || 0,
      });
    }
  },

  spark(x, y, color = '#f8e7bd', count = 6, dir = null, speed = 300) {
    this.burst(x, y, { count, color, speed, dir, spread: dir == null ? TAU : 1.6, size: 3.2, life: .4, glow: true, shape: 'spark', drag: .86 });
  },
  ink(x, y, count = 8, color = '#17121f') {
    this.burst(x, y, { count, color, speed: 180, size: 6, life: .8, gravity: 600, shape: 'ink', drag: .93 });
  },
  dust(x, y, count = 6, color = 'rgba(220,200,170,.5)') {
    for (let i = 0; i < count; i++) {
      this.p({ x: x + rnd(-14, 14), y: y + rnd(-3, 3), vx: rnd(-70, 70), vy: rnd(-50, -10), life: rnd(.3, .7), size: rnd(2, 6), color, shape: 'smoke', gravity: -40, drag: .92, alpha: .6 });
    }
  },
  heal(x, y, color = '#7bd6bf') {
    for (let i = 0; i < 12; i++) {
      this.p({ x: x + rnd(-22, 22), y: y + rnd(-30, 20), vx: rnd(-20, 20), vy: rnd(-90, -45), life: rnd(.6, 1), size: rnd(2.5, 5), color, shape: 'plus', glow: true, drag: .94 });
    }
    this.ring(x, y - 30, 22, color, { life: .5, width: 2 });
  },
  shard(x, y, color = '#e8c47e', count = 3) {
    for (let i = 0; i < count; i++) {
      this.p({ x, y, vx: rnd(-80, 80), vy: rnd(-160, -60), life: .5, size: rnd(2, 4), color, shape: 'star', glow: true, gravity: 300, drag: .96 });
    }
  },

  slash(x, y, angle, reach, color, opt = {}) {
    this.slashes.push({
      x, y, angle, reach, color,
      life: opt.life ?? .22, max: opt.life ?? .22,
      width: opt.width ?? 26, span: opt.span ?? 1.45,
      flip: opt.flip ?? false, type: opt.type || 'arc',
      follow: opt.follow || null,
    });
  },
  ring(x, y, radius, color, opt = {}) {
    this.rings.push({
      x, y, r0: opt.r0 ?? 4, r1: radius, color,
      life: opt.life ?? .45, max: opt.life ?? .45,
      width: opt.width ?? 3, fill: opt.fill ?? false,
      squash: opt.squash ?? 1, follow: opt.follow || null,
    });
  },
  ghost(src, x, y, h, flip, color, life = .32) {
    this.ghosts.push({ src, x, y, h, flip, color, life, max: life });
  },
  beam(x1, y1, x2, y2, color, opt = {}) {
    this.beams.push({ x1, y1, x2, y2, color, life: opt.life ?? .22, max: opt.life ?? .22, width: opt.width ?? 12, core: opt.core ?? 3 });
  },
  flash(color, alpha = .4, dur = .18) {
    G.flash = { color, alpha, t: dur, max: dur };
  },
  damageText(x, y, amount, opt = {}) {
    if (!opt.dot) {
      const txt = opt.text || Math.max(1, Math.round(amount)).toString();
      const reaction = opt.grade === 'reaction';
      this.texts.push({
        x: x + rnd(-8, 8), y, vx: rnd(-20, 20), vy: opt.vy ?? (reaction ? -86 : -110),
        text: txt, color: opt.color || (opt.crit ? '#ffd166' : '#f8e7bd'),
        size: opt.size ?? (opt.crit ? 30 : reaction ? 26 : 22),
        life: opt.life ?? (reaction ? .95 : .75), max: opt.life ?? (reaction ? .95 : .75),
        crit: !!opt.crit, outline: opt.outline ?? 'rgba(8,5,12,.85)',
        font: opt.font || (reaction ? FONT_SERIF : FONT_EN),
        weight: opt.weight || 700, scale: opt.crit ? 1.35 : reaction ? 1.15 : 1,
        letter: reaction ? 1.4 : 1,
      });
    } else {
      this.texts.push({
        x: x + rnd(-14, 14), y, vx: rnd(-16, 16), vy: -52,
        text: Math.max(1, Math.round(amount)).toString(), color: opt.color || '#c9b9a0',
        size: 15, life: .55, max: .55, crit: false, outline: 'rgba(8,5,12,.8)', font: FONT_EN, weight: 500, scale: 1,
      });
    }
  },
  text(x, y, str, color = '#f8e7bd', opt = {}) {
    this.texts.push({
      x, y, vx: opt.vx ?? 0, vy: opt.vy ?? -48,
      text: str, color, size: opt.size ?? 20, life: opt.life ?? 1, max: opt.life ?? 1,
      crit: false, outline: opt.outline ?? 'rgba(8,5,12,.8)',
      font: opt.font || FONT_SERIF, weight: opt.weight || 600, scale: opt.scale || 1,
      letter: opt.letter || 1,
    });
  },
  shake(amount) {
    G.cam.trauma = Math.min(1, G.cam.trauma + amount);
  },
  hitstop(t) {
    G.hitstop = Math.max(G.hitstop, t);
  },
  slowmo(t, scale = .35) {
    G.slowmo = Math.max(G.slowmo, t);
    G.slowScale = scale;
  },

  update(dt) {
    const low = this.lowfx;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      const d = Math.pow(p.drag, dt * 60);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dt;
      if (t.life <= 0) { this.texts.splice(i, 1); continue; }
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.vy *= Math.pow(.9, dt * 60);
    }
    for (const arr of [this.slashes, this.rings, this.beams, this.ghosts]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const o = arr[i];
        o.life -= dt;
        if (o.follow) { o.x = o.follow.x; o.y = o.follow.y; }
        if (o.life <= 0) arr.splice(i, 1);
      }
    }
    if (G.flash) {
      G.flash.t -= dt;
      if (G.flash.t <= 0) G.flash = null;
    }
    if (G.cam.trauma > 0) {
      G.cam.trauma = Math.max(0, G.cam.trauma - dt * 1.9);
    }
    if (G.slowmo > 0) G.slowmo = Math.max(0, G.slowmo - dt);
  },

  draw(ctx) {
    // 残影
    for (const gh of this.ghosts) {
      const a = (gh.life / gh.max) * .34;
      if (a <= 0) continue;
      const im = gh.color ? silhouette(gh.src, gh.color, 1) : getImg(gh.src);
      if (!im) continue;
      const iw = im.width || im.naturalWidth;
      const ih = im.height || im.naturalHeight;
      const w = (iw / ih) * gh.h;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(gh.x, gh.y);
      if (gh.flip) ctx.scale(-1, 1);
      ctx.drawImage(im, -w / 2, -gh.h, w, gh.h);
      ctx.restore();
    }
    // 斩击
    for (const s of this.slashes) {
      const t = 1 - s.life / s.max;
      const a = (1 - t) * (1 - t);
      const rr = s.reach * (.55 + .55 * easeOutCubic(t));
      const ang = s.angle;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      const start = ang - s.span / 2;
      const end = ang + s.span / 2;
      ctx.globalAlpha = a * .5;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * (1 - t * .65);
      ctx.beginPath();
      ctx.arc(0, 0, rr, start, end);
      ctx.stroke();
      ctx.globalAlpha = a * .95;
      ctx.strokeStyle = '#fff8e8';
      ctx.lineWidth = Math.max(1.2, s.width * .22 * (1 - t * .5));
      ctx.beginPath();
      ctx.arc(0, 0, rr, start + .06, end - .06);
      ctx.stroke();
      // 拖尾碎光
      if (!this.lowfx && t < .4) {
        for (let i = 0; i < 2; i++) {
          const aa = rnd(start, end);
          this.p({ x: s.x + Math.cos(aa) * rr, y: s.y + Math.sin(aa) * rr, vx: Math.cos(aa) * 80, vy: Math.sin(aa) * 80, life: .2, size: rnd(1.5, 3), color: s.color, glow: true, shape: 'spark' });
        }
      }
      ctx.restore();
    }
    // 冲击环
    for (const r of this.rings) {
      const t = 1 - r.life / r.max;
      const rr = r.r0 + (r.r1 - r.r0) * easeOutCubic(t);
      const a = 1 - t;
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.scale(1, r.squash);
      ctx.globalAlpha = a * .85;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - t * .5);
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, TAU);
      ctx.stroke();
      if (r.fill) {
        ctx.globalAlpha = a * .12;
        ctx.fillStyle = r.color;
        ctx.fill();
      }
      ctx.restore();
    }
    // 光束
    for (const b of this.beams) {
      const t = 1 - b.life / b.max;
      const a = (1 - t) * (1 - t);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * .5;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.width * (1 - t * .4);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
      ctx.globalAlpha = a;
      ctx.strokeStyle = '#fff8e8';
      ctx.lineWidth = b.core;
      ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
      ctx.restore();
    }
    // 粒子
    for (const p of this.particles) {
      const t = p.life / p.max;
      const a = Math.min(1, t * 1.6) * p.alpha;
      if (a <= 0) continue;
      ctx.save();
      ctx.globalAlpha = a;
      if (p.blend !== 'source-over') ctx.globalCompositeOperation = p.blend;
      const sz = p.size * (p.fade === 1 ? (0.4 + .6 * t) : 1);
      if (p.glow) {
        ctx.drawImage(glowSprite(p.color), p.x - sz * 2.2, p.y - sz * 2.2, sz * 4.4, sz * 4.4);
      }
      ctx.fillStyle = p.color;
      ctx.strokeStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath(); ctx.arc(p.x, p.y, sz, 0, TAU); ctx.fill();
      } else if (p.shape === 'smoke') {
        ctx.globalAlpha = a * .4;
        ctx.beginPath(); ctx.arc(p.x, p.y, sz * 1.8, 0, TAU); ctx.fill();
      } else if (p.shape === 'spark') {
        ctx.lineWidth = Math.max(1, sz * .55);
        ctx.lineCap = 'round';
        const len = sz * 4;
        const vx = p.vx, vy = p.vy;
        const m = Math.hypot(vx, vy) || 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - (vx / m) * len, p.y - (vy / m) * len); ctx.stroke();
      } else if (p.shape === 'star') {
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        starPath(ctx, 0, 0, sz, 0, .45); ctx.fill();
      } else if (p.shape === 'plus') {
        ctx.fillRect(p.x - sz * .18, p.y - sz, sz * .36, sz * 2);
        ctx.fillRect(p.x - sz, p.y - sz * .18, sz * 2, sz * .36);
      } else if (p.shape === 'ink') {
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, sz, sz * .62, 0, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sz * .8, -sz * .2, sz * .28, 0, TAU); ctx.fill();
      } else if (p.shape === 'petal') {
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, sz, sz * .45, 0, 0, TAU); ctx.fill();
        ctx.globalAlpha = a * .5;
        ctx.beginPath();
        ctx.ellipse(sz * .3, 0, sz * .45, sz * .18, 0, 0, TAU); ctx.fill();
      } else if (p.shape === 'shard') {
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.beginPath(); ctx.moveTo(0, -sz); ctx.lineTo(sz * .5, 0); ctx.lineTo(0, sz); ctx.lineTo(-sz * .5, 0); ctx.closePath(); ctx.fill();
      } else {
        ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
      }
      ctx.restore();
    }
    // 飘字
    for (const t of this.texts) {
      const k = t.life / t.max;
      const pop = k > .82 ? 1 + (1 - (1 - k) / .18) * .18 : 1;
      ctx.save();
      ctx.globalAlpha = Math.min(1, k * 2.2);
      ctx.translate(t.x, t.y);
      ctx.scale(pop * t.scale, pop * t.scale);
      ctx.font = `${t.weight} ${t.size}px ${t.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, t.size * .16);
      ctx.strokeStyle = t.outline;
      ctx.strokeText(t.text, 0, 0);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, 0, 0);
      if (t.crit) {
        ctx.globalAlpha *= .6;
        ctx.fillStyle = '#fff8e8';
        ctx.fillText(t.text, 0, -1);
      }
      ctx.restore();
    }
  },
};

export function updateGlobalFx(dt) {
  FX.update(dt);
}
