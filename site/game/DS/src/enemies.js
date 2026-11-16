// ============================================================
// 敌人 AI / 幕终主角 —— 剧场纸偶·墨影造形
// 统一语言：剪影可辨 / 金边或暗 rim / 细缝竖瞳 / 流苏·符纸·裂缝·纸层
// 预警：地面环 / 扇形 / 光束走廊 / 身体充能，金→红，≥0.6s
// ============================================================
import { G } from './state.js';
import { FLOOR, W, H, EL } from './config.js';
import { ENEMIES, BOSSES } from './data/enemies.js';
import { FX } from './fx.js';
import { Audio } from './core/audio.js';
import {
  hurtPlayer, spawnEnemyProjectile, damageEnemy, killEnemy, nearestEnemy,
} from './combat.js';
import { clamp, rnd, pick, dist, angleTo, TAU, damp, hexA, chance, starPath } from './utils.js';

const ELEM_BY_ACT = [
  ['wind', 'moon', 'earth'],
  ['water', 'moon', 'wind'],
  ['earth', 'fire', 'moon'],
];

// ===========================================================================
// 缓存绘制原语（战斗热路径禁用每帧 createRadialGradient / shadowBlur）
// ===========================================================================
const FL = '#fff0d2'; // 受击白闪色

const glowCache = new Map();
function glowSprite(color) {
  let c = glowCache.get(color);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, hexA(color, .85));
    gr.addColorStop(.3, hexA(color, .38));
    gr.addColorStop(.65, hexA(color, .1));
    gr.addColorStop(1, hexA(color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    glowCache.set(color, c);
  }
  return c;
}
// 软辉光：drawImage 代替每帧径向渐变
function glow(ctx, x, y, r, color, alpha = 1) {
  if (alpha <= 0 || r <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

const gradCache = new Map();
// 线性渐变缓存：坐标烘焙进 key（CanvasGradient 在绘制时按当前 CTM 解释坐标）
function vg(ctx, key, x0, y0, x1, y1, stops) {
  const k = key + '|' + ((x0 * 7 + y0 * 13 + x1 * 29 + y1 * 31) | 0) + Math.round(y0) + '_' + Math.round(y1);
  let g = gradCache.get(k);
  if (!g) {
    g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]);
    gradCache.set(k, g);
  }
  return g;
}
// 纵向墨色渐变填充；受击时改平涂白闪
function bodyFill(ctx, key, y0, y1, c0, c1, flick) {
  if (flick) { ctx.fillStyle = FL; return; }
  ctx.fillStyle = vg(ctx, key, 0, y0, 0, y1, [0, c0, 1, c1]);
}

// ===========================================================================
// 纸偶细节部件：流苏 / 符纸 / 裂缝 / 纸层
// ===========================================================================
// 流苏：吊线 + 水滴坠
function tassel(ctx, x, y, len, sway, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + sway * .6, y + len * .55, x + sway, y + len);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + sway, y + len);
  ctx.quadraticCurveTo(x + sway + 2.6, y + len + 5, x + sway, y + len + 8);
  ctx.quadraticCurveTo(x + sway - 2.6, y + len + 5, x + sway, y + len);
  ctx.fill();
}
// 符纸：垂挂的咒条
function talisman(ctx, x, y, rot, txt, w = 9, h = 20, accent = '#8e2a3e') {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = 'rgba(240,226,196,.9)';
  ctx.fillRect(-w / 2, 0, w, h);
  ctx.strokeStyle = hexA('#e8c47e', .55);
  ctx.lineWidth = .8;
  ctx.strokeRect(-w / 2, 0, w, h);
  ctx.fillStyle = accent;
  ctx.font = '600 ' + Math.round(w * .78) + 'px "Songti SC",serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(txt, 0, h * .52);
  ctx.restore();
}
// 裂缝：折线暗纹
function crackLine(ctx, pts, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
}

// 细缝/竖瞳眼：剧场纸偶的注视（取代旧圆点眼）
function slitEye(ctx, x, y, s, color, opt = {}) {
  const w = s * (opt.wide ?? 1.45);
  const h = s * (opt.tall ?? .85);
  ctx.save();
  // 眼窝（暗色杏仁形）
  ctx.fillStyle = opt.socket || '#0a0710';
  ctx.beginPath();
  ctx.ellipse(x, y, w, h, opt.rot || 0, 0, TAU);
  ctx.fill();
  // 发光竖瞳
  ctx.globalCompositeOperation = 'lighter';
  glow(ctx, x, y, s * 2.4, color, (opt.glowA ?? .5));
  ctx.fillStyle = color;
  const pw = Math.max(1.1, s * .26), ph = h * 1.5;
  ctx.fillRect(x - pw / 2, y - ph / 2, pw, ph);
  ctx.fillStyle = hexA('#ffffff', .75);
  ctx.fillRect(x - pw * .3, y - ph * .42, pw * .5, ph * .3);
  ctx.restore();
}
// 横向细缝眼（用于折痕/面具式）
function seamEye(ctx, x, y, len, color) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  glow(ctx, x, y, len * .8, color, .4);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - len / 2, y);
  ctx.lineTo(x + len / 2, y);
  ctx.stroke();
  ctx.restore();
}

// 小纸面具（面具列部件）
function paperMask(ctx, scale, crack, eyeColor) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = '#e9dcc3';
  ctx.beginPath();
  ctx.moveTo(0, -13);
  ctx.quadraticCurveTo(7, -11, 6.5, 0);
  ctx.quadraticCurveTo(6, 10, 0, 13);
  ctx.quadraticCurveTo(-6, 10, -6.5, 0);
  ctx.quadraticCurveTo(-7, -11, 0, -13);
  ctx.fill();
  ctx.strokeStyle = 'rgba(70,45,38,.4)';
  ctx.lineWidth = .8;
  ctx.stroke();
  ctx.fillStyle = '#120a10';
  ctx.fillRect(-5, -4, 3.6, 1.5);
  ctx.fillRect(1.6, -4, 3.6, 1.5);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = eyeColor || '#c84a5a';
  ctx.fillRect(-4.6, -3.8, 2.2, 1);
  ctx.fillRect(2.2, -3.8, 2.2, 1);
  ctx.globalCompositeOperation = 'source-over';
  if (crack) crackLine(ctx, [-2, -12, -3.5, -5, -2, 2, -4, 10], 'rgba(80,50,40,.6)', .8);
  ctx.restore();
}

// ===========================================================================
// 统一攻击预警（金→红）
// type: circle 地面环 | sector 扇形 | line 走廊/光束 | charge 身体充能
// s.k 由调用方写入（0→1 出手进度）
// ===========================================================================
const WARN_GOLD = '#e8c47e';
const WARN_RED = '#ff5240';

function drawWarnShape(ctx, s, camX, t) {
  const k = clamp(s.k ?? 0, 0, 1);
  const pulse = .5 + .5 * Math.sin(t * (9 + 16 * k));
  const col = k > .66 ? WARN_RED : WARN_GOLD;
  const a = .3 + .28 * pulse + .22 * k;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (s.type === 'circle') {
    const x = s.x - camX, y = s.y;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, .32);
    ctx.globalAlpha = a * .42;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(0, 0, s.r, 0, TAU); ctx.fill();
    ctx.globalAlpha = a;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, s.r, 0, TAU); ctx.stroke();
    // 收缩内环：倒计时指示
    ctx.globalAlpha = a * .95;
    ctx.strokeStyle = FL;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(0, 0, Math.max(3, s.r * (1 - k * .84)), 0, TAU); ctx.stroke();
    ctx.restore();
    glow(ctx, x, y, s.r * .38, col, a * .3);
  } else if (s.type === 'sector') {
    const x = s.x - camX;
    const a0 = s.a - s.spread / 2, a1 = s.a + s.spread / 2;
    ctx.globalAlpha = a * .4;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x, s.y);
    ctx.arc(x, s.y, s.r, a0, a1);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = a;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, s.y);
    ctx.arc(x, s.y, s.r, a0, a1);
    ctx.closePath();
    ctx.stroke();
    // 临近出手：扇面向中线收拢
    if (k > .55) {
      const sp = s.spread * (1 - (k - .55) / .45);
      ctx.globalAlpha = a * .95;
      ctx.strokeStyle = FL;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, s.y);
      ctx.arc(x, s.y, s.r, s.a - sp / 2, s.a + sp / 2);
      ctx.closePath();
      ctx.stroke();
    }
  } else if (s.type === 'line') {
    const x1 = s.x1 - camX, y1 = s.y1, x2 = s.x2 - camX, y2 = s.y2;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const hw = s.w / 2;
    ctx.globalAlpha = a * .32;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x1 + nx * hw, y1 + ny * hw);
    ctx.lineTo(x2 + nx * hw, y2 + ny * hw);
    ctx.lineTo(x2 - nx * hw, y2 - ny * hw);
    ctx.lineTo(x1 - nx * hw, y1 - ny * hw);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = a;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // 核心线：临近出手变亮变粗
    ctx.globalAlpha = .45 + .55 * k;
    ctx.strokeStyle = k > .66 ? FL : col;
    ctx.lineWidth = 1.5 + s.w * .14 * k;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  } else if (s.type === 'charge') {
    // 身体充能：出手点金→红脉动
    const x = s.x - camX, y = s.y;
    glow(ctx, x, y, s.r * (1.5 + .6 * k), col, (.5 + .4 * pulse) * a);
    ctx.globalAlpha = a;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, s.r * .85, .4 + t * 4, 2.6 + t * 4);
    ctx.stroke();
    if (s.spread != null) {
      // 薄扇指向提示
      ctx.globalAlpha = a * .32;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, s.r * 2.8, s.a - s.spread / 2, s.a + s.spread / 2);
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ===========================================================================
// 敌人本体
// ===========================================================================
export class Enemy {
  constructor(defId, x, opts = {}) {
    const def = ENEMIES[defId] || ENEMIES.oni;
    this.def = def;
    this.id = defId;
    this.x = x;
    this.y = opts.y ?? FLOOR;
    this.homeY = this.y;
    this.vx = 0;
    this.vy = 0;
    this.w = def.w;
    this.h = def.h;
    this.elite = !!opts.elite || !!def.elite;
    this.boss = false;
    this.facing = opts.facing ?? -1;
    this.spawning = opts.spawning ?? .75;
    this.spawnT = this.spawning;
    this.dead = false;
    this.deathT = 0;
    this.flash = 0;
    this.anim = rnd(0, 10);
    this.status = {};
    this.mark = null;
    this.attackCd = opts.attackCd ?? rnd(.8, 2);
    this.action = null;
    this.actionT = 0;
    this.state = 'idle';
    this.flying = !!def.flying;
    this.baseY = opts.y ?? FLOOR - (def.flying ? (def.hover || 120) : 0);
    this.orbit = rnd(0, TAU);
    this.hurtT = 0;
    this.element = opts.element || pick(ELEM_BY_ACT[G.run?.act || 0]);
    const scaleHp = (1 + (G.run?.act || 0) * .6 + (G.run?.stage || 0) * .1);
    // 伤害曲线放缓：act1 1.0-1.12 → act2 1.24-1.36 → act3 1.48-1.60（原 1.0-1.9 跨幕过陡）
    const scaleDmg = 1 + (G.run?.act || 0) * .24 + (G.run?.stage || 0) * .04;
    this.hp = def.hp * scaleHp * (this.elite ? 2.4 : 1);
    this.maxHp = this.hp;
    this.dmgMul = scaleDmg;
    if (this.elite) { this.w *= 1.18; this.h *= 1.18; }
    this.spawnY = this.y;
    this.y = this.spawnY + 30;
    this.hoverPhase = rnd(0, TAU);
    this.telegraph = 0;
    this.beam = null;
    this.charge = 0;
    this.warn = null;   // 当前攻击预警（金→红）
    this.deathDone = false;
  }

  get alive() { return !this.dead; }

  update(dt) {
    this.anim += dt;
    this.flash = Math.max(0, this.flash - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    if (this.dead) {
      this.deathT += dt;
      if (!this.deathDone && this.deathT > .7) this.deathDone = true;
      return;
    }
    if (this.spawning > 0) {
      this.spawning -= dt;
      this.y = damp(this.y, this.baseY, 8, dt);
      if (this.spawning <= 0) this.y = this.baseY;
      return;
    }
    if (this.status?.stun > 0 || this.status?.freeze > 0) {
      this.vx = damp(this.vx, 0, 8, dt);
      this.applyPhysics(dt);
      return;
    }
    this.attackCd -= dt;
    if (this.action) {
      this.updateAction(dt);
      this.applyPhysics(dt);
      return;
    }
    this.think(dt);
    this.applyPhysics(dt);
    // 注意：mark/状态计时统一由 combat.js updateStatuses 递减，这里不再重复扣
  }

  applyPhysics(dt) {
    const room = G.room;
    const slow = this.status?.slow > 0 ? .55 : 1;
    this.x += this.vx * slow * dt;
    this.y += this.vy * dt;
    if (room) {
      this.x = clamp(this.x, room.bounds.left + 40, room.bounds.right - 40);
    }
    if (this.flying) {
      const targetY = this.baseY + Math.sin(this.anim * 1.6 + this.hoverPhase) * 12;
      this.y = damp(this.y, targetY, 4, dt);
      this.vy = 0;
    } else {
      this.vy = Math.min(1200, this.vy + 2300 * dt);
      if (this.y >= FLOOR) {
        this.y = FLOOR;
        this.vy = 0;
      }
    }
    this.vx = damp(this.vx, 0, this.state === 'charge' ? 1.2 : 5, dt);
  }

  think(dt) {
    const p = G.player;
    if (!p) return;
    const dx = p.x - this.x;
    const dy = (p.y - 80) - (this.y - this.h * .5);
    const d = Math.hypot(dx, dy);
    this.facing = dx < 0 ? -1 : 1;
    const spd = this.def.speed * (this.status?.slow > 0 ? .55 : 1);
    const atk = this.def.attack;

    if (this.def.ai === 'chaser') {
      if (Math.abs(dx) > atk.range * .72) {
        this.vx = damp(this.vx, this.facing * spd, 6, dt);
      } else if (this.attackCd <= 0) {
        this.beginAttack();
      } else {
        this.vx = damp(this.vx, 0, 8, dt);
      }
    } else if (this.def.ai === 'ranged') {
      if (d < 240) this.vx = damp(this.vx, -this.facing * spd, 5, dt);
      else if (d > 420) this.vx = damp(this.vx, this.facing * spd, 5, dt);
      else this.vx = damp(this.vx, Math.sin(this.anim * .8) * spd * .3, 3, dt);
      if (this.attackCd <= 0 && d < 700) this.beginAttack();
    } else if (this.def.ai === 'flyer') {
      const orbitX = p.x + Math.cos(this.anim * .7 + this.orbit) * 200;
      this.vx = damp(this.vx, clamp((orbitX - this.x) * .8, -spd, spd), 3, dt);
      if (this.attackCd <= 0 && d < 420) this.beginAttack();
    } else if (this.def.ai === 'dasher') {
      if (this.attackCd <= 0 && d < 620) {
        this.beginAttack();
      } else {
        this.vx = damp(this.vx, this.facing * spd * .5, 4, dt);
      }
    }
  }

  beginAttack() {
    const atk = this.def.attack;
    this.action = { id: atk.kind, t: 0, windup: atk.windup || .7, recover: atk.recover || .8, fired: false };
    this.attackCd = rnd(1.5, 2.6) + (atk.windup || .7);
    this.telegraph = atk.windup || .7;
    this.state = 'windup';
    this.warn = this.makeWarn(atk);
    if (atk.kind === 'charge') {
      this.chargeDir = this.facing;
      Audio.sfx('warning', { volume: .35 });
    }
  }

  // 出手预警：地面环 / 扇形 / 走廊 / 充能（锁定目标点，保证可读可躲）
  makeWarn(atk) {
    const p = G.player;
    const windup = atk.windup || .7;
    const kind = atk.kind;
    const cy = this.y - this.h * .55;
    if (kind === 'melee' || kind === 'sweep') {
      const reach = (atk.range || 96) * (kind === 'sweep' ? 1.25 : 1.05);
      const ang = p ? angleTo(this.x, cy, p.x, p.y - 80) : (this.facing > 0 ? 0 : Math.PI);
      return { type: 'sector', x: this.x, y: cy, r: reach, a: ang, spread: kind === 'sweep' ? 1.7 : 1.05, dur: windup, followBody: true };
    }
    if (kind === 'charge') {
      const len = (atk.speed || 650) * .8;
      return { type: 'line', x1: this.x, y1: this.y - this.h * .42, x2: this.x + this.facing * len, y2: this.y - this.h * .42, w: Math.max(72, this.w * .85), dur: windup, followBody: true, dir: this.facing, len };
    }
    if (kind === 'dive') {
      const tx = p ? p.x : this.x + this.facing * 220;
      const ty = FLOOR - 30;
      this.diveTargetX = tx;
      return { type: 'circle', x: tx, y: ty, r: 78, dur: windup };
    }
    if (kind === 'beam') {
      const p2 = p || { x: this.x + this.facing * 420, y: FLOOR };
      return { type: 'line', x1: this.x, y1: this.y - this.h * .62, x2: p2.x, y2: p2.y - 80, w: 26, dur: windup, aim: true, followBody: true };
    }
    // 远程弹幕：身体充能光 +（扇形类）薄扇指向
    const base = p ? angleTo(this.x, cy, p.x, p.y - 80) : 0;
    const w = { type: 'charge', x: this.x, y: cy, r: Math.max(13, this.w * .17), dur: windup, followBody: true };
    if (kind === 'fan' || kind === 'homing' || kind === 'burst') {
      w.a = base;
      w.spread = Math.max(.5, (atk.spread || .25) * (atk.count || 3) * 1.35);
    }
    return w;
  }

  updateAction(dt) {
    const a = this.action;
    a.t += dt;
    this.telegraph = Math.max(0, a.windup - a.t);
    const p = G.player;
    const w = this.warn;
    if (w && !a.fired) {
      // 预警跟随身体；追踪只在风抬前半程，后半程锁定（读得出、躲得开）
      const lock = p && a.t >= a.windup - .18;
      const cy = this.y - this.h * .55;
      if (w.type === 'sector') {
        w.x = this.x; w.y = cy;
        if (p && a.t < a.windup * .55) w.a = angleTo(this.x, cy, p.x, p.y - 80);
      } else if (w.type === 'line') {
        if (w.aim) {
          w.x1 = this.x; w.y1 = this.y - this.h * .62;
          if (p && !lock) { w.x2 = p.x; w.y2 = p.y - 80; }
        } else {
          w.x1 = this.x; w.y1 = this.y - this.h * .42;
          w.x2 = this.x + w.dir * w.len;
        }
      } else if (w.type === 'charge') {
        w.x = this.x; w.y = cy;
        if (p && w.spread != null && a.t < a.windup * .5) w.a = angleTo(this.x, cy, p.x, p.y - 80);
      }
    }
    if (!a.fired && a.t >= a.windup) {
      a.fired = true;
      this.fireAttack(a);
    }
    if (a.t >= a.windup + a.recover) {
      this.action = null;
      this.state = 'idle';
      this.telegraph = 0;
      this.warn = null;
    }
  }

  fireAttack(a) {
    const atk = this.def.attack;
    const p = G.player;
    if (!p) return;
    const color = this.def.accent || '#e8c47e';
    // 每个敌人的基础伤害取自数据表（def.dmg），攻击动作只提供倍率
    const dmg = (atk.dmg || 1) * (this.def.dmg || 12) * this.dmgMul;
    if (a.id === 'melee' || a.id === 'sweep') {
      const reach = atk.range || 96;
      const box = { x: this.x + (this.facing > 0 ? 10 : -reach - 10), y: this.y - this.h * .85, w: reach, h: this.h * .8 };
      FX.slash(this.x + this.facing * reach * .35, this.y - this.h * .55, this.facing > 0 ? 0 : Math.PI, reach * 1.1, color, { width: 18, span: 1.2, life: .25 });
      Audio.sfx('slash', { volume: .5 });
      const px = p.x, py = p.y - 80;
      if (px > box.x - 26 && px < box.x + box.w + 26 && py > box.y + 10 && py < box.y + box.h) {
        hurtPlayer(dmg, this.x, {});
      }
      if (a.id === 'sweep') FX.shake(.16);
    } else if (a.id === 'fan' || a.id === 'homing' || a.id === 'burst') {
      const n = atk.count || 3;
      const spread = atk.spread || .25;
      const baseA = angleTo(this.x, this.y - this.h * .6, p.x, p.y - 90);
      for (let i = 0; i < n; i++) {
        let ang = baseA;
        if (a.id === 'fan') ang += (i - (n - 1) / 2) * spread;
        else if (a.id === 'burst') ang = (i / n) * TAU + this.anim;
        else ang += (i - (n - 1) / 2) * spread;
        spawnEnemyProjectile({
          x: this.x, y: this.y - this.h * .6, angle: ang, speed: atk.speed || 230,
          dmg: dmg * .8, size: atk.size || 10, color,
          type: a.id === 'homing' ? 'note' : a.id === 'burst' ? 'orb' : 'paper',
          homing: a.id === 'homing' ? .35 : 0, life: 4,
        });
      }
      Audio.sfx('magic', { volume: .4 });
    } else if (a.id === 'dive') {
      // 朝预警锁定的落点俯冲（预警环即落点）
      this.charge = .55;
      const tx = this.diveTargetX ?? p.x;
      const ang = angleTo(this.x, this.y, tx, FLOOR - 40);
      this.vx = Math.cos(ang) * (atk.speed || 500);
      this.vy = Math.sin(ang) * (atk.speed || 500);
      this.state = 'charge';
      Audio.sfx('dash', { volume: .5 });
    } else if (a.id === 'charge') {
      this.charge = .6;
      this.vx = this.chargeDir * (atk.speed || 650);
      this.state = 'charge';
      Audio.sfx('dash', { volume: .6 });
    } else if (a.id === 'beam') {
      const ang = angleTo(this.x, this.y - this.h * .6, p.x, p.y - 80);
      this.beam = { x1: this.x, y1: this.y - this.h * .6, x2: this.x + Math.cos(ang) * (atk.length || 420), y2: this.y - this.h * .6 + Math.sin(ang) * (atk.length || 420), t: .25, max: .25 };
      FX.beam(this.beam.x1, this.beam.y1, this.beam.x2, this.beam.y2, color, { life: .25, width: 14 });
      Audio.sfx('beam', { volume: .5 });
      // 判定：线段到玩家距离
      const px = p.x, py = p.y - 80;
      const vx = this.beam.x2 - this.beam.x1, vy = this.beam.y2 - this.beam.y1;
      const wx = px - this.beam.x1, wy = py - this.beam.y1;
      const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy || 1), 0, 1);
      const cx = this.beam.x1 + vx * t, cy = this.beam.y1 + vy * t;
      if (dist(px, py, cx, cy) < 38) hurtPlayer(dmg, this.x, {});
    }
    if (a.id === 'dive' || a.id === 'charge') {
      this.chargeDir = this.facing;
    }
  }

  onHurt(dmg, opt) {
    this.hurtT = .16;
    // 冲刺中的敌人被打断
    if (this.state === 'charge' && dmg > this.maxHp * .08) {
      this.state = 'idle';
      this.charge = 0;
    }
  }

  draw(ctx, t) {
    const cam = G.cam.x;
    const x = this.x - cam;
    if (this.spawning > 0) {
      const k = 1 - this.spawning / this.spawnT;
      ctx.save();
      ctx.globalAlpha = k * .8;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgb(20,12,26)';
      ctx.beginPath();
      ctx.ellipse(x, FLOOR - 10, 40 * k, 14 * k, 0, 0, TAU);
      ctx.fill();
      for (let i = 0; i < 6; i++) {
        const a = i * TAU / 6 + t * 2;
        ctx.fillStyle = this.def.accent;
        ctx.globalAlpha = k * .5;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * 30, FLOOR - 20 + Math.sin(a) * 10, 2.5, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    // 攻击预警画在身体之下（地面层）
    if (this.warn && this.action && !this.action.fired && !this.dead) {
      this.warn.k = clamp(this.action.t / this.warn.dur, 0, 1);
      drawWarnShape(ctx, this.warn, cam, t);
    }
    if (this.dead) {
      const k = clamp(1 - this.deathT / .7, 0, 1);
      ctx.save();
      ctx.globalAlpha = k;
      ctx.translate(x, this.y);
      ctx.scale(1 + (1 - k) * .4, 1 - (1 - k) * .3);
      drawEnemyShape(ctx, this, t);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(x, this.y);
    drawEnemyAura(ctx, this, t);
    // 影子（缓存的软黑贴图）
    ctx.save();
    ctx.globalAlpha = .38;
    ctx.drawImage(glowSprite('#000000'), -this.w * .78, 2 - this.w * .3, this.w * 1.56, this.w * .6);
    ctx.restore();
    drawEnemyShape(ctx, this, t);
    ctx.restore();
    // 头顶预警标记（金→红）
    if (this.action && this.telegraph > 0 && !this.dead) {
      const k = 1 - this.telegraph / Math.max(.01, this.action.windup || .7);
      ctx.save();
      const y = this.y - this.h - 24 - (this.flying ? 16 : 0);
      ctx.globalAlpha = .5 + .5 * Math.sin(t * 22);
      ctx.fillStyle = k > .66 ? WARN_RED : '#ffcf7a';
      ctx.font = '700 20px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText('!', x, y);
      ctx.globalAlpha = .35 + .3 * k;
      ctx.strokeStyle = k > .66 ? WARN_RED : '#e8c47e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const rr = 12 + k * 28;
      ctx.arc(x, y - 8, rr, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
    // 状态图标
    drawStatusIcons(ctx, this, x, t);
    // 血条
    if (this.hp < this.maxHp || this.elite) {
      const w = this.elite ? 70 : 46;
      const bx = x - w / 2;
      const by = this.y - this.h - (this.flying ? 28 : 16);
      ctx.save();
      ctx.fillStyle = 'rgba(8,5,12,.7)';
      ctx.fillRect(bx - 1, by - 1, w + 2, 6);
      ctx.fillStyle = this.elite ? '#e8c47e' : '#d96f8e';
      ctx.fillRect(bx, by, w * clamp(this.hp / this.maxHp, 0, 1), 4);
      ctx.restore();
    }
    // 精英标记
    if (this.elite) {
      ctx.save();
      ctx.fillStyle = '#e8c47e';
      ctx.font = '600 11px "Songti SC",serif';
      ctx.textAlign = 'center';
      ctx.fillText('加演', x, this.y - this.h - 26);
      ctx.restore();
    }
    drawMark(ctx, this, x, t);
  }
}

function drawStatusIcons(ctx, e, x, t) {
  const s = e.status || {};
  const icons = [];
  if (s.burn > 0) icons.push(['燃', '#ff9a5a']);
  if (s.freeze > 0) icons.push(['冰', '#9fd8ff']);
  if (s.stun > 0) icons.push(['晕', '#ffe9b0']);
  if (s.root > 0) icons.push(['缚', '#8fd6a0']);
  if (s.armorBreak > 0) icons.push(['破', '#e0b878']);
  if (s.slow > 0) icons.push(['缓', '#b9d8ff']);
  if (!icons.length) return;
  ctx.save();
  ctx.font = '600 10px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let bx = x - (icons.length - 1) * 7;
  const y = e.y - e.h - 4;
  for (const [txt, col] of icons) {
    ctx.fillStyle = 'rgba(8,5,12,.78)';
    ctx.beginPath(); ctx.arc(bx, y, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = col;
    ctx.fillText(txt, bx, y + .5);
    bx += 14;
  }
  ctx.restore();
}

function drawMark(ctx, e, x, t) {
  if (!e.mark || e.mark.t <= 0) return;
  const el = EL[e.mark.el];
  if (!el) return;
  const y = e.y - e.h - 38;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * 1.4);
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = el.color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = .4 + .4 * Math.sin(t * 4);
  ctx.beginPath();
  ctx.moveTo(0, -9); ctx.lineTo(7, 0); ctx.lineTo(0, 9); ctx.lineTo(-7, 0); ctx.closePath(); ctx.stroke();
  ctx.globalAlpha = .75;
  ctx.fillStyle = el.color;
  ctx.font = '600 10px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(el.name, 0, 0);
  ctx.restore();
}

function inkFill(ctx, e, x, y, w, h) {
  ctx.fillStyle = vg(ctx, 'ink' + (e.def.color || '#1b1726'), 0, y - h, 0, y, [0, e.def.color || '#1b1726', 1, '#0a070f']);
  if (e.flash > 0) ctx.fillStyle = FL;
}

// 环境辉光：以缓存贴图代替每帧径向渐变
function drawEnemyAura(ctx, e, t, big = false) {
  const d = e.boss ? e.bossDef : e.def;
  const ac = d?.accent || '#e8c47e';
  const w = e.w, h = e.h;
  const cy = -h * .52;
  const rr = Math.max(w, h) * (big ? 1.15 : .95);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  glow(ctx, 0, cy, rr, ac, big ? .4 : .22);
  // 脚下法阵
  ctx.globalAlpha = .22 + .08 * Math.sin(t * 2 + e.anim);
  ctx.strokeStyle = ac;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(0, 2, w * .72, 10, 0, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = .1;
  ctx.beginPath();
  ctx.ellipse(0, 2, w * .95, 14, 0, 0, TAU);
  ctx.stroke();
  // 飘浮墨点/纸屑
  if (!FX.lowfx) {
    for (let i = 0; i < (big ? 10 : 5); i++) {
      const a = t * .6 + i * 2.1 + e.anim;
      const rad = w * (.45 + (i % 3) * .18);
      ctx.globalAlpha = .18 + .18 * Math.sin(t * 1.8 + i);
      ctx.fillStyle = i % 2 ? '#0b0812' : ac;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rad, cy + Math.sin(a) * h * .3, 1.6 + (i % 2), 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ===========================================================================
// 十一个剧场纸偶：剪影优先，金边/暗 rim，细缝竖瞳，流苏·符纸·裂缝·纸层
// ===========================================================================
function drawEnemyShape(ctx, e, t) {
  const d = e.def;
  const flick = e.flash > 0;
  const facing = e.facing;
  ctx.save();
  const bob = e.flying ? Math.sin(t * 2 + e.hoverPhase) * 3 : 0;
  ctx.translate(0, bob);
  if (facing < 0) ctx.scale(-1, 1);
  const ac = d.accent || '#e8c47e';
  const windK = e.action && !e.action.fired
    ? clamp(e.action.t / Math.max(.01, e.action.windup || .7), 0, 1)
    : 0; // 风抬进度：驱动蓄力姿态
  switch (d.draw) {

    // —— 墨鬼：瘦长墨影，破裂纸能面 + 断角 + 符纸 ——
    case 'oni': {
      const h = e.h, w = e.w;
      const sway = Math.sin(t * 2.2 + e.anim);
      const armSwing = Math.sin(t * 2.6 + e.anim) * 7;
      const wind = windK > 0;
      // 背后墨雾
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const a = t * .5 + i * 1.7 + e.anim;
        ctx.globalAlpha = .06 + .04 * Math.sin(t + i);
        ctx.fillStyle = i % 2 ? ac : '#3a1a2a';
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * w * .35, -h * (.3 + i * .12), w * .3, h * .16, a * .2, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
      // 背后符纸（半掩）
      ctx.save();
      ctx.translate(-w * .3, -h * .78);
      ctx.rotate(-.5 + sway * .04);
      ctx.fillStyle = 'rgba(240,226,196,.85)';
      ctx.fillRect(-5, -11, 10, 22);
      ctx.strokeStyle = hexA(ac, .5);
      ctx.lineWidth = .8;
      ctx.strokeRect(-5, -11, 10, 22);
      ctx.fillStyle = '#8e2a3e';
      ctx.font = '600 8px "Songti SC",serif';
      ctx.textAlign = 'center';
      ctx.fillText('封', 0, 2);
      ctx.restore();
      // 腿：细长、足爪
      ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        ctx.strokeStyle = flick ? FL : '#120d18';
        ctx.lineWidth = w * .13;
        const hipX = side * w * .14;
        const footX = side * w * .22 + sway * 2;
        ctx.beginPath();
        ctx.moveTo(hipX, -h * .4);
        ctx.quadraticCurveTo(side * w * .26, -h * .18, footX, -h * .03);
        ctx.stroke();
        ctx.strokeStyle = ac;
        ctx.lineWidth = 1.4;
        for (let k = -1; k <= 1; k++) {
          ctx.beginPath();
          ctx.moveTo(footX, -h * .03);
          ctx.lineTo(footX + k * 5 + side * 5, -h * .005);
          ctx.stroke();
        }
      }
      // 纸层裙：两层错位锯齿纸，下缘金线
      for (let layer = 0; layer < 2; layer++) {
        // lift 是「系数」而不是像素长度：之前写成 h*.08，第二层裙会算出 -h*8.74，
        // 画成一根贯穿全屏的锯齿墨柱
        const lift = layer * .08;
        ctx.fillStyle = flick ? FL : (layer ? '#241522' : '#170e1a');
        ctx.beginPath();
        ctx.moveTo(-w * (layer ? .3 : .36), -h * (.44 - lift));
        let jag = 0;
        for (let x = -w * (layer ? .3 : .36); x <= w * (layer ? .3 : .36); x += w * .09) {
          ctx.lineTo(x, -h * ((.1 + lift) + (jag % 2) * .07));
          jag++;
        }
        ctx.lineTo(w * (layer ? .3 : .36), -h * (.44 - lift));
        ctx.closePath();
        ctx.fill();
        if (!layer) {
          ctx.strokeStyle = hexA(ac, .55);
          ctx.lineWidth = 1.1;
          ctx.stroke();
        }
      }
      // 红腰带与流苏
      ctx.strokeStyle = '#8e2a3e';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-w * .3, -h * .45);
      ctx.quadraticCurveTo(0, -h * .42, w * .3, -h * .45);
      ctx.stroke();
      for (let i = -1; i <= 1; i++) {
        tassel(ctx, i * w * .12, -h * .43, h * .1, sway * 3 + i * 2, '#8e2a3e');
      }
      // 躯干（瘦长）
      bodyFill(ctx, 'oni-torso', -h * .9, -h * .45, flick ? FL : '#33202e', flick ? FL : '#100b16', flick);
      ctx.beginPath();
      ctx.moveTo(-w * .2, -h * .43);
      ctx.quadraticCurveTo(-w * .3, -h * .6, -w * .26, -h * .82);
      ctx.lineTo(-w * .12, -h * .9);
      ctx.quadraticCurveTo(0, -h * .92, w * .12, -h * .9);
      ctx.lineTo(w * .26, -h * .82);
      ctx.quadraticCurveTo(w * .3, -h * .6, w * .2, -h * .43);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .5);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      // 胸口金线肋纹 + 裂缝
      ctx.strokeStyle = hexA(ac, .5);
      ctx.lineWidth = 1.1;
      for (let i = 0; i < 3; i++) {
        const yy = -h * (.55 + i * .08);
        ctx.beginPath();
        ctx.moveTo(-w * .14 + i * 2, yy);
        ctx.quadraticCurveTo(0, yy - 4, w * .14 - i * 2, yy);
        ctx.stroke();
      }
      crackLine(ctx, [-w * .08, -h * .6, -w * .04, -h * .52, -w * .09, -h * .47], 'rgba(120,90,70,.5)');
      if (wind) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        glow(ctx, 0, -h * .6, w * .3, '#ff6a50', .3 * windK);
        ctx.restore();
      }
      // 肩甲尖刺（不对称）
      for (const side of [-1, 1]) {
        ctx.fillStyle = flick ? FL : '#241522';
        ctx.beginPath();
        ctx.ellipse(side * w * .26, -h * .8, w * .13, h * .06, side * .25, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = hexA(ac, .65);
        ctx.lineWidth = 1.1;
        ctx.stroke();
        ctx.fillStyle = ac;
        const spikes = side > 0 ? 3 : 1;
        for (let k = 0; k < spikes; k++) {
          ctx.beginPath();
          ctx.moveTo(side * w * (.22 + k * .06), -h * .83);
          ctx.lineTo(side * w * (.3 + k * .06), -h * (.94 + k * .03));
          ctx.lineTo(side * w * (.33 + k * .05), -h * .81);
          ctx.closePath();
          ctx.fill();
        }
      }
      // 手臂与爪
      for (const side of [-1, 1]) {
        const shX = side * w * .27, shY = -h * .76;
        const elX = side * w * .44, elY = -h * .56 + (side > 0 ? armSwing : -armSwing) * .2;
        const clX = side * w * .52, clY = -h * .38 + (side > 0 ? armSwing : -armSwing) * .5;
        ctx.strokeStyle = flick ? FL : '#171221';
        ctx.lineWidth = w * .11;
        ctx.beginPath();
        ctx.moveTo(shX, shY);
        ctx.quadraticCurveTo(elX, elY, clX, clY);
        ctx.stroke();
        ctx.strokeStyle = hexA(ac, .45);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(shX, shY - 1);
        ctx.quadraticCurveTo(elX, elY - 1, clX, clY - 1);
        ctx.stroke();
        ctx.strokeStyle = ac;
        ctx.lineWidth = 1.7;
        for (let k = -1; k <= 1; k++) {
          ctx.beginPath();
          ctx.moveTo(clX, clY);
          ctx.lineTo(clX + side * 9, clY + 4 + k * 5);
          ctx.stroke();
        }
        if (wind && side > 0) glow(ctx, clX, clY, 24, '#ff6a50', .4 * windK);
      }
      // 头：乱发（后掠锐刺）
      const headY = -h * .95;
      ctx.fillStyle = flick ? FL : '#0a0710';
      ctx.beginPath();
      ctx.moveTo(-w * .26, headY + h * .04);
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (.08 + i * .09);
        const rr = w * (.24 + (i % 2) * .1);
        ctx.lineTo(Math.cos(a) * rr, headY - Math.sin(a) * rr * .95);
      }
      ctx.quadraticCurveTo(w * .26, headY + h * .06, 0, headY + h * .07);
      ctx.quadraticCurveTo(-w * .26, headY + h * .07, -w * .26, headY + h * .04);
      ctx.closePath();
      ctx.fill();
      // 双角：一长一曲、一断
      ctx.strokeStyle = flick ? FL : '#d8c8a8';
      ctx.lineWidth = 3.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(w * .1, headY - h * .08);
      ctx.quadraticCurveTo(w * .3, headY - h * .3, w * .14, headY - h * .34);
      ctx.stroke();
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(-w * .1, headY - h * .08);
      ctx.lineTo(-w * .17, headY - h * .18);
      ctx.stroke();
      ctx.strokeStyle = hexA(ac, .7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w * .1, headY - h * .08);
      ctx.quadraticCurveTo(w * .3, headY - h * .3, w * .14, headY - h * .34);
      ctx.stroke();
      // 纸能面：细缝竖瞳
      ctx.fillStyle = flick ? FL : '#e9dcc3';
      ctx.beginPath();
      ctx.ellipse(0, headY, w * .18, h * .1, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .7);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      slitEye(ctx, -w * .07, headY - 2, 2.6, wind ? '#ff6a50' : (d.eye || '#ffcf7a'), { wide: .8, tall: 1.6 });
      slitEye(ctx, w * .07, headY - 2, 2.6, wind ? '#ff6a50' : (d.eye || '#ffcf7a'), { wide: .8, tall: 1.6 });
      // 长鼻梁 + 嘴缝 + 面具裂纹
      ctx.strokeStyle = 'rgba(120,95,80,.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, headY - h * .03);
      ctx.quadraticCurveTo(w * .012, headY + h * .02, 0, headY + h * .045);
      ctx.stroke();
      crackLine(ctx, [w * .12, headY - h * .04, w * .08, headY, w * .1, headY + h * .04], 'rgba(80,50,40,.5)', .8);
      ctx.strokeStyle = ac;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-w * .04, headY + h * .05);
      ctx.quadraticCurveTo(0, headY + h * .062, w * .04, headY + h * .05);
      ctx.stroke();
      // 额中印记
      ctx.fillStyle = '#8e2a3e';
      ctx.beginPath();
      ctx.arc(0, headY - h * .05, 1.6, 0, TAU);
      ctx.fill();
      break;
    }

    // —— 空席：墓碑式椅背上的竖瞳，留座符与票根 ——
    case 'seat': {
      const w = e.w, h = e.h;
      const float = Math.sin(t * 2 + e.anim) * 4;
      const wind = windK > 0;
      ctx.translate(0, float);
      if (wind) ctx.rotate(-.05 * windK);
      // 椅腿（弯曲花式）
      ctx.strokeStyle = flick ? FL : '#5a3a2a';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (const sx of [-w * .3, w * .3]) {
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.quadraticCurveTo(sx * 1.1, -h * .2, sx * .8, -h * .38);
        ctx.stroke();
      }
      // 靠背：墓碑式高背，顶部三连弧
      bodyFill(ctx, 'seat-back', -h * 1.1, -h * .5, flick ? FL : '#2a2038', flick ? FL : '#120e1c', flick);
      ctx.beginPath();
      ctx.moveTo(-w * .4, -h * .42);
      ctx.lineTo(-w * .44, -h * .92);
      ctx.quadraticCurveTo(-w * .4, -h * 1.1, -w * .2, -h * 1.1);
      ctx.quadraticCurveTo(0, -h * 1.16, w * .2, -h * 1.1);
      ctx.quadraticCurveTo(w * .4, -h * 1.1, w * .44, -h * .92);
      ctx.lineTo(w * .4, -h * .42);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .55);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 内衬金框 + 裂缝
      ctx.strokeStyle = hexA(ac, .45);
      ctx.lineWidth = 1;
      ctx.strokeRect(-w * .32, -h * 1.0, w * .64, h * .5);
      crackLine(ctx, [w * .3, -h * .98, w * .18, -h * .84, w * .26, -h * .72], 'rgba(0,0,0,.5)', 1);
      // 竖瞳独眼（空席在注视）
      slitEye(ctx, 0, -h * .76, 5, wind ? '#ff6a50' : (d.eye || '#ffe9b0'), { wide: .7, tall: 1.7 });
      // 座垫：红绒 + 金管边 + 四角流苏
      ctx.fillStyle = flick ? FL : '#7a2036';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(-w * .42, -h * .55, w * .84, h * .16, 4) : ctx.rect(-w * .42, -h * .55, w * .84, h * .16);
      ctx.fill();
      ctx.strokeStyle = hexA('#e8c47e', .6);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      for (const sx of [-1, 1]) {
        tassel(ctx, sx * w * .4, -h * .4, 8, Math.sin(t * 2 + sx) * 2, hexA('#e8c47e', .8));
      }
      // 「留座」符
      talisman(ctx, w * .48, -h * .6 + Math.sin(t * 2.4) * 2, .18 + Math.sin(t * 1.8) * .1, '留', 9, 18);
      // 环绕票根
      ctx.save();
      ctx.globalAlpha = .5;
      for (let i = 0; i < 3; i++) {
        const a = t * 1.2 + i * 2.1;
        ctx.save();
        ctx.translate(Math.cos(a) * w * .72, -h * .7 + Math.sin(a) * 16);
        ctx.rotate(a * 2);
        ctx.fillStyle = '#e9dcc3';
        ctx.fillRect(-5, -3.4, 10, 6.8);
        ctx.strokeStyle = 'rgba(142,42,62,.6)';
        ctx.lineWidth = .8;
        ctx.strokeRect(-5, -3.4, 10, 6.8);
        ctx.restore();
      }
      ctx.restore();
      break;
    }

    // —— 折纸鹤：硬折面纸层 + 红冠折角 + 折痕缝眼 ——
    case 'crane': {
      const w = e.w, h = e.h;
      const flap = Math.sin(t * 7 + e.anim) * .5;
      const wind = windK > 0;
      if (wind) ctx.rotate(-.1 * windK);
      // 尾羽（长而尖）
      ctx.fillStyle = flick ? FL : '#e2d2b8';
      ctx.beginPath();
      ctx.moveTo(-w * .12, -h * .42);
      ctx.lineTo(-w * .62, -h * .18);
      ctx.lineTo(-w * .3, -h * .3);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .4);
      ctx.lineWidth = .8;
      ctx.stroke();
      // 身体：三片折面（纸层）
      const tones = ['#f4ead7', '#e9dcc3', '#e2d2b8'];
      const facets = [
        [[0, -h * .5], [w * .34, -h * .3], [0, -h * .15]],
        [[0, -h * .5], [-w * .34, -h * .3], [0, -h * .15]],
        [[-w * .1, -h * .38], [w * .1, -h * .38], [0, -h * .12]],
      ];
      for (let i = 0; i < facets.length; i++) {
        ctx.fillStyle = flick ? FL : tones[i];
        ctx.beginPath();
        const f = facets[i];
        ctx.moveTo(f[0][0], f[0][1]);
        ctx.lineTo(f[1][0], f[1][1]);
        ctx.lineTo(f[2][0], f[2][1]);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(90,60,40,.35)';
        ctx.lineWidth = .7;
        ctx.stroke();
      }
      // 折痕线
      ctx.strokeStyle = 'rgba(90,60,40,.4)';
      ctx.lineWidth = .8;
      ctx.beginPath();
      ctx.moveTo(0, -h * .5); ctx.lineTo(0, -h * .15);
      ctx.moveTo(-w * .3, -h * .32); ctx.lineTo(w * .3, -h * .3);
      ctx.stroke();
      // 翅膀：折纸三角 + 金折缘 + 墨渍
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.scale(s, 1);
        ctx.rotate(flap * s * .25);
        ctx.fillStyle = flick ? FL : '#e2d2b8';
        ctx.beginPath();
        ctx.moveTo(w * .05, -h * .5);
        ctx.lineTo(w * .66, -h * .8);
        ctx.lineTo(w * .3, -h * .28);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = hexA(ac, .55);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(w * .05, -h * .5);
        ctx.lineTo(w * .66, -h * .8);
        ctx.stroke();
        ctx.fillStyle = 'rgba(20,12,24,.35)';
        ctx.beginPath();
        ctx.ellipse(w * .38, -h * .52, 4, 2.6, .4, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      // 头颈：前伸的折颈 + 红冠折 + 喙
      ctx.fillStyle = flick ? FL : '#f4ead7';
      ctx.beginPath();
      ctx.moveTo(w * .16, -h * .48);
      ctx.lineTo(w * .44, -h * .62);
      ctx.lineTo(w * .3, -h * .4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(w * .38, -h * .68);
      ctx.lineTo(w * .52, -h * .56);
      ctx.lineTo(w * .36, -h * .52);
      ctx.closePath();
      ctx.fill();
      // 红冠折角
      ctx.fillStyle = '#b8304a';
      ctx.beginPath();
      ctx.moveTo(w * .42, -h * .7);
      ctx.lineTo(w * .46, -h * .78);
      ctx.lineTo(w * .5, -h * .66);
      ctx.closePath();
      ctx.fill();
      // 喙（深色尖）
      ctx.fillStyle = '#4a2a24';
      ctx.beginPath();
      ctx.moveTo(w * .52, -h * .6);
      ctx.lineTo(w * .72, -h * .56);
      ctx.lineTo(w * .5, -h * .52);
      ctx.closePath();
      ctx.fill();
      // 折痕缝眼（红）
      seamEye(ctx, w * .44, -h * .6, 7, wind ? '#ff6a50' : (d.eye || '#b8304a'));
      if (wind) glow(ctx, w * .7, -h * .56, 10, '#ff6a50', .5 * windK);
      break;
    }

    // —— 提词精灵：裂面咒典 + 竖瞳 + 垂印丝绦 ——
    case 'book': {
      const w = e.w, h = e.h;
      const flap = Math.sin(t * 2.6 + e.anim);
      const open = Math.sin(t * 1.7) * .05;
      const wind = windK > 0;
      ctx.rotate(-.04 + open + (wind ? -.05 * windK : 0));
      // 书页层（纸层：错位双页）
      for (let pg = 0; pg < 2; pg++) {
        ctx.fillStyle = flick ? FL : (pg ? '#e9dcc3' : '#d9c8a8');
        ctx.beginPath();
        ctx.moveTo(-w * .36 + pg * 4, -h * .3 + pg * 3);
        ctx.lineTo(w * .38, -h * .28 + pg * 3);
        ctx.lineTo(w * .41, -h * .2 + flap * 2 + pg * 2);
        ctx.lineTo(-w * .39, -h * .22 + flap * 2 + pg * 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(90,60,40,.4)';
      ctx.lineWidth = .8;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-w * .34, -h * (.26 - i * .02));
        ctx.lineTo(w * .36, -h * (.24 - i * .02));
        ctx.stroke();
      }
      // 书壳：酒红皮面
      bodyFill(ctx, 'book-cover', -h * .82, -h * .26, flick ? FL : '#4a1628', flick ? FL : '#14060d', flick);
      ctx.beginPath();
      ctx.moveTo(-w * .4, -h * .82);
      ctx.quadraticCurveTo(-w * .44, -h * .55, -w * .4, -h * .26);
      ctx.lineTo(w * .4, -h * .26);
      ctx.quadraticCurveTo(w * .44, -h * .55, w * .4, -h * .82);
      ctx.closePath();
      ctx.fill();
      // 书脊
      ctx.fillStyle = flick ? FL : '#1a0910';
      ctx.fillRect(-w * .4, -h * .82, w * .1, h * .56);
      ctx.strokeStyle = hexA(ac, .5);
      ctx.lineWidth = 1;
      ctx.strokeRect(-w * .4, -h * .82, w * .1, h * .56);
      // 封面金边
      ctx.strokeStyle = hexA(ac, .7);
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-w * .28, -h * .78, w * .62, h * .46);
      // 四角金饰
      ctx.strokeStyle = hexA(ac, .8);
      ctx.lineWidth = 1.4;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sx * w * .28, sy * -h * .72);
        ctx.lineTo(sx * w * .28 + sx * 6, sy * -h * .72);
        ctx.moveTo(sx * w * .28, sy * -h * .72);
        ctx.lineTo(sx * w * .28, sy * -h * .72 + sy * 6);
        ctx.stroke();
      }
      // 贯穿裂缝
      crackLine(ctx, [w * .26, -h * .8, w * .12, -h * .62, w * .18, -h * .44, w * .06, -h * .3], 'rgba(0,0,0,.55)', 1.2);
      // 封面竖瞳
      const eyeY = -h * .55;
      ctx.fillStyle = flick ? FL : '#0a0710';
      ctx.beginPath();
      ctx.ellipse(0, eyeY, w * .2, h * .13, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .8);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      slitEye(ctx, 0, eyeY, 5, wind ? '#ff6a50' : (d.eye || '#fff3c4'), { wide: .55, tall: 1.9, glowA: .6 });
      // 垂印丝绦（书签 + 金印坠）
      tassel(ctx, w * .18, -h * .28 + flap * 3, h * .16, Math.sin(t * 2) * 2, '#8e2a3e');
      // 漂浮咒字
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hexA(ac, .55);
      ctx.font = '11px "Songti SC",serif';
      ctx.textAlign = 'center';
      for (let i = 0; i < 2; i++) {
        const a = t * .9 + i * 2.1;
        ctx.globalAlpha = .35 + .25 * Math.sin(t * 2 + i);
        ctx.fillText(['演', '终'][i], Math.cos(a) * w * .55, -h * .85 + Math.sin(a) * 14);
      }
      ctx.restore();
      break;
    }

    // —— 幕布水母：帷幔伞盖 + 帘条触手 + 垂穗 ——
    case 'jelly': {
      const w = e.w, h = e.h;
      const wind = windK > 0;
      const squish = wind ? 1 - .2 * windK : 1;
      // 帘条触手：锥形幕条 + 坠重
      for (let i = -3; i <= 3; i++) {
        const len = h * (.36 + (Math.abs(i) % 2) * .1);
        const sw = Math.sin(t * 2 + i * .9) * 12;
        const sw2 = Math.sin(t * 3 + i) * 14;
        ctx.fillStyle = flick ? FL : hexA(ac, .4);
        ctx.beginPath();
        ctx.moveTo(i * w * .11 - 3.4, -h * .4);
        ctx.quadraticCurveTo(i * w * .13 + sw * .5, -h * .18, i * w * .11 + sw2, -h * .4 + len);
        ctx.lineTo(i * w * .11 + sw2 + 3, -h * .4 + len);
        ctx.quadraticCurveTo(i * w * .13 + sw * .5 + 5, -h * .18, i * w * .11 + 3.4, -h * .4);
        ctx.closePath();
        ctx.fill();
        // 坠穗
        ctx.fillStyle = flick ? FL : hexA('#e8c47e', .75);
        ctx.beginPath();
        ctx.arc(i * w * .11 + sw2, -h * .4 + len + 3, 2.4, 0, TAU);
        ctx.fill();
      }
      // 内层透光伞
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      glow(ctx, 0, -h * .58, w * .5, ac, .3);
      ctx.restore();
      // 伞盖：帷幔穹顶
      bodyFill(ctx, 'jelly-dome', -h * .9, -h * .5, flick ? FL : '#8b3056', flick ? FL : '#2a0e20', flick);
      ctx.beginPath();
      ctx.ellipse(0, -h * .55, w * .5, h * .34 * squish, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA('#e8c47e', .5);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      // 帷幔垂弧（扇贝边）+ 金缘
      ctx.strokeStyle = hexA('#e8c47e', .65);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = -2; i <= 2; i++) {
        const x0 = i * w * .2;
        ctx.moveTo(x0, -h * .55);
        ctx.quadraticCurveTo(x0 + w * .1, -h * .46, x0 + w * .2, -h * .55);
      }
      ctx.stroke();
      // 垂穗
      for (let i = -2; i <= 2; i++) {
        tassel(ctx, i * w * .2 + w * .1, -h * .5, 7, Math.sin(t * 2.4 + i) * 2.4, hexA('#e8c47e', .7));
      }
      // 双竖缝眼
      slitEye(ctx, -w * .16, -h * .66 * squish, 4, wind ? '#ff6a50' : (d.eye || '#bff5e5'), { wide: .6, tall: 1.8 });
      slitEye(ctx, w * .16, -h * .66 * squish, 4, wind ? '#ff6a50' : (d.eye || '#bff5e5'), { wide: .6, tall: 1.8 });
      break;
    }

    // —— 断章猎犬：撕页层皮 + 露出红页的裂颚 + 断章书签 ——
    case 'hound': {
      const w = e.w, h = e.h;
      const run = Math.sin(t * 9 + e.anim) * 6;
      const wind = windK > 0;
      const crouch = wind ? 4 * windK : 0;
      ctx.translate(0, crouch);
      const seamCol = wind ? '#ff6a50' : hexA(ac, .55);
      // 撕页身体：两层锯齿纸（外层亮一档 + 金 rim，保证剪影可读）
      for (let layer = 0; layer < 2; layer++) {
        ctx.fillStyle = flick ? FL : (layer ? '#1c1428' : '#2e2240');
        ctx.beginPath();
        const yT = -h * (layer ? .68 : .78);
        const yB = -h * (layer ? .44 : .5);
        ctx.moveTo(-w * (layer ? .3 : .42), yT);
        for (let x = -w * .42; x <= w * .42; x += w * .12) {
          ctx.lineTo(x, yT + ((x / w * 10) % 2 + 2) % 2 * 3);
        }
        ctx.lineTo(w * (layer ? .3 : .42), yT);
        ctx.lineTo(w * .42, yB);
        for (let x = w * .42; x >= -w * .42; x -= w * .12) {
          ctx.lineTo(x, yB - (((x / w * 10) % 2 + 2) % 2) * 3);
        }
        ctx.closePath();
        ctx.fill();
        if (!layer) {
          ctx.strokeStyle = hexA(ac, .55);
          ctx.lineWidth = 1.3;
          ctx.stroke();
        }
      }
      // 层间发光裂缝
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = seamCol;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-w * .36, -h * .6);
      for (let x = -w * .36; x <= w * .3; x += w * .12) {
        ctx.lineTo(x + w * .06, -h * (.6 + ((x / w * 7) % 2 + 2) % 2 * .03));
      }
      ctx.stroke();
      ctx.restore();
      // 四条细长折节腿
      ctx.strokeStyle = flick ? FL : '#2e2240';
      ctx.lineWidth = 3.6;
      ctx.lineCap = 'round';
      for (const [sx, ph] of [[-w * .28, 0], [-w * .12, 1.5], [w * .16, 3], [w * .3, 4.5]]) {
        const kx = sx + Math.sin(t * 9 + ph) * 8 + run * .2;
        ctx.beginPath();
        ctx.moveTo(sx, -h * .52);
        ctx.lineTo(kx, -h * .26);
        ctx.lineTo(sx + Math.sin(t * 9 + ph) * 14, 0);
        ctx.stroke();
        // 爪
        ctx.strokeStyle = ac;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(sx + Math.sin(t * 9 + ph) * 14, 0);
        ctx.lineTo(sx + Math.sin(t * 9 + ph) * 14 + 5, -2);
        ctx.stroke();
        ctx.strokeStyle = flick ? FL : '#2e2240';
        ctx.lineWidth = 3.6;
      }
      // 颈与楔形颅（金 rim 勾边）
      bodyFill(ctx, 'hound-head', -h * .9, -h * .5, flick ? FL : '#342748', flick ? FL : '#16101f', flick);
      ctx.beginPath();
      ctx.moveTo(w * .14, -h * .7);
      ctx.quadraticCurveTo(w * .5, -h * .9, w * .62, -h * .72);
      ctx.lineTo(w * .3, -h * .48);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .5);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // 裂颚：撕开露出红页
      ctx.fillStyle = flick ? FL : '#221932';
      ctx.beginPath();
      ctx.ellipse(w * .58, -h * .76, w * .21, h * .15, .2, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .55);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#a63452';
      ctx.beginPath();
      ctx.moveTo(w * .5, -h * .66);
      ctx.lineTo(w * .76, -h * .6);
      ctx.lineTo(w * .52, -h * .55);
      ctx.closePath();
      ctx.fill();
      // 白页牙（撕出的纸齿）
      ctx.fillStyle = '#e9dcc3';
      ctx.beginPath();
      ctx.moveTo(w * .52, -h * .65);
      ctx.lineTo(w * .56, -h * .615);
      ctx.lineTo(w * .6, -h * .65);
      ctx.lineTo(w * .64, -h * .615);
      ctx.closePath();
      ctx.fill();
      // 撕裂耳
      ctx.fillStyle = ac;
      ctx.beginPath();
      ctx.moveTo(w * .46, -h * .88);
      ctx.lineTo(w * .4, -h * 1.05);
      ctx.lineTo(w * .52, -h * .96);
      ctx.lineTo(w * .56, -h * .88);
      ctx.closePath();
      ctx.fill();
      // 竖瞳
      slitEye(ctx, w * .62, -h * .78, 3.6, wind ? '#ff6a50' : (d.eye || '#ff9db6'), { wide: .65, tall: 1.8 });
      // 断章书签（叙事部件）
      ctx.save();
      ctx.translate(w * .1, -h * .5);
      ctx.rotate(Math.sin(t * 2.2) * .18 + .2);
      ctx.fillStyle = '#b8304a';
      ctx.fillRect(-3, 0, 6, 16);
      ctx.fillStyle = '#e9dcc3';
      ctx.fillRect(-3, 12, 6, 5);
      ctx.strokeStyle = 'rgba(0,0,0,.4)';
      ctx.lineWidth = .8;
      ctx.beginPath();
      ctx.moveTo(-1, 16); ctx.lineTo(2, 19);
      ctx.stroke();
      ctx.restore();
      // 破损尾
      ctx.strokeStyle = flick ? FL : '#171221';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-w * .4, -h * .66);
      ctx.quadraticCurveTo(-w * .62, -h * .6 + run * .4, -w * .7, -h * .42);
      ctx.stroke();
      break;
    }

    // —— 吊线人偶：操纵杆与五线 + 节段木身 + 碎冠面具 ——
    case 'puppet': {
      const w = e.w, h = e.h;
      const wind = windK > 0;
      const sw = Math.sin(t * 2.2 + e.anim) * .08;
      // 操纵十字杆
      ctx.strokeStyle = '#6b4a30';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(-w * .34, -h * 1.14);
      ctx.lineTo(w * .34, -h * 1.14);
      ctx.moveTo(0, -h * 1.2);
      ctx.lineTo(0, -h * 1.08);
      ctx.stroke();
      ctx.fillStyle = ac;
      ctx.beginPath(); ctx.arc(-w * .34, -h * 1.14, 3, 0, TAU); ctx.arc(w * .34, -h * 1.14, 3, 0, TAU); ctx.fill();
      // 五根提线
      ctx.strokeStyle = hexA(ac, .3);
      ctx.lineWidth = 1;
      for (const [dx, dy] of [[-w * .28, -h * .95], [w * .28, -h * .95], [-w * .22, -h * .45], [w * .22, -h * .45], [0, -h * 1.08]]) {
        ctx.beginPath();
        ctx.moveTo(dx, dy);
        ctx.quadraticCurveTo(dx + Math.sin(t + dx) * 4, (dy - h * 1.14) * .5 + h * 1.14, dx * .8, -h * 1.14);
        ctx.stroke();
      }
      // 躯干：三节木段（深木色 + 顶节奶白漆面板）
      for (let i = 0; i < 3; i++) {
        const y0 = -h * (.18 + i * .2);
        const y1 = -h * (.36 + i * .2);
        const ww = w * (.24 - i * .02);
        ctx.fillStyle = flick ? FL : (i === 2 ? '#4a2c3c' : '#32202c');
        ctx.beginPath();
        ctx.moveTo(-ww, y0);
        ctx.quadraticCurveTo(-ww * 1.1, (y0 + y1) / 2, -ww * .92, y1);
        ctx.lineTo(ww * .92, y1);
        ctx.quadraticCurveTo(ww * 1.1, (y0 + y1) / 2, ww, y0);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = hexA(ac, .5);
        ctx.lineWidth = 1.1;
        ctx.stroke();
        if (i === 2) {
          // 奶白漆面（剥落）
          ctx.fillStyle = flick ? FL : '#e9dcc3';
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(-ww * .55, y1 + 2, ww * 1.1, (y0 - y1) * .62, 3) : ctx.rect(-ww * .55, y1 + 2, ww * 1.1, (y0 - y1) * .62);
          ctx.fill();
          ctx.strokeStyle = 'rgba(90,60,40,.4)';
          ctx.lineWidth = .8;
          ctx.stroke();
        }
        if (i < 2) {
          ctx.fillStyle = '#0a0710';
          ctx.fillRect(-ww * .9, y1 - 1.6, ww * 1.8, 3.2);
        }
      }
      crackLine(ctx, [w * .08, -h * .5, w * .02, -h * .44, w * .1, -h * .38], 'rgba(0,0,0,.5)', 1);
      // 腰穗
      tassel(ctx, 0, -h * .38, h * .07, Math.sin(t * 2) * 3, hexA(ac, .8));
      // 腿（两节）
      ctx.strokeStyle = flick ? FL : '#2a1a26';
      ctx.lineWidth = w * .1;
      ctx.lineCap = 'round';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * w * .1, -h * .2);
        ctx.lineTo(s * w * .16, -h * .1);
        ctx.lineTo(s * w * .2, -h * .02);
        ctx.stroke();
        ctx.fillStyle = flick ? FL : '#e9dcc3';
        ctx.beginPath(); ctx.arc(s * w * .16, -h * .1, 3, 0, TAU); ctx.fill();
      }
      // 手臂（右臂扬起蓄力，左臂垂落）
      ctx.strokeStyle = flick ? FL : '#2a1a26';
      ctx.lineWidth = w * .09;
      for (const s of [-1, 1]) {
        const raise = wind && s > 0 ? windK : 0;
        const ex = s * w * (.5 - raise * .1);
        const ey = -h * (.5 - raise * .22) + sw * 80 * (s < 0 ? 1 : .3);
        const hx = s * w * (.56 - raise * .05);
        const hy = -h * (.28 + raise * .18) + sw * 120 * (s < 0 ? 1 : .3);
        ctx.beginPath();
        ctx.moveTo(s * w * .24, -h * .72);
        ctx.lineTo(ex, ey);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.fillStyle = flick ? FL : '#e9dcc3';
        ctx.beginPath(); ctx.arc(ex, ey, 3.4, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(s * w * .24, -h * .72, 3.4, 0, TAU); ctx.fill();
        if (wind && s > 0) glow(ctx, hx, hy, 16, '#ff6a50', .4 * windK);
      }
      // 腕上符纸
      talisman(ctx, w * .56, -h * .26, .3, '演', 8, 15);
      // 头：裂面纸偶
      const headY = -h * .87;
      ctx.fillStyle = flick ? FL : '#efe4cf';
      ctx.beginPath();
      ctx.ellipse(0, headY, w * .17, h * .11, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .7); ctx.lineWidth = 1.5;
      ctx.stroke();
      crackLine(ctx, [-w * .1, headY - h * .06, -w * .04, headY, -w * .08, headY + h * .05], 'rgba(80,50,40,.55)', 1);
      slitEye(ctx, -w * .06, headY - 1, 2.8, wind ? '#ff6a50' : (d.eye || '#ffd166'), { wide: .6, tall: 1.8 });
      slitEye(ctx, w * .06, headY - 1, 2.8, wind ? '#ff6a50' : (d.eye || '#ffd166'), { wide: .6, tall: 1.8 });
      ctx.strokeStyle = '#8e2a3e';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(-w * .04, headY + h * .045);
      ctx.quadraticCurveTo(0, headY + h * .058, w * .04, headY + h * .045);
      ctx.stroke();
      // 碎纸冠：三尖，右尖折断
      ctx.fillStyle = ac;
      ctx.beginPath();
      ctx.moveTo(-w * .15, headY - h * .07);
      ctx.lineTo(-w * .1, headY - h * .15);
      ctx.lineTo(-w * .04, headY - h * .08);
      ctx.lineTo(w * .02, headY - h * .16);
      ctx.lineTo(w * .07, headY - h * .1);
      ctx.lineTo(w * .1, headY - h * .07);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#8c6428';
      ctx.lineWidth = .9;
      ctx.stroke();
      break;
    }

    // —— 终幕判官：高幞头 + 白能面 + 判词卷轴 ——
    case 'judge': {
      const w = e.w, h = e.h;
      const wind = windK > 0;
      const sway = Math.sin(t * 1.4 + e.anim) * 3;
      // 长袍（高瘦斗篷，底缘垂穗）
      bodyFill(ctx, 'judge-robe', -h, 0, flick ? FL : '#2a1a3a', flick ? FL : '#0d0814', flick);
      ctx.beginPath();
      ctx.moveTo(0, -h * .9);
      ctx.quadraticCurveTo(-w * .52, -h * .6, -w * .5, 0);
      ctx.lineTo(-w * .34, -h * .04);
      ctx.lineTo(-w * .2, 0);
      ctx.lineTo(0, -h * .03);
      ctx.lineTo(w * .2, 0);
      ctx.lineTo(w * .34, -h * .04);
      ctx.lineTo(w * .5, 0);
      ctx.quadraticCurveTo(w * .52, -h * .6, 0, -h * .9);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .55);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-w * .5, 0);
      ctx.quadraticCurveTo(-w * .52, -h * .6, 0, -h * .9);
      ctx.quadraticCurveTo(w * .52, -h * .6, w * .5, 0);
      ctx.stroke();
      // 金线镶边 + 竖向饰带
      ctx.strokeStyle = hexA(ac, .35);
      ctx.lineWidth = 1;
      for (let i = -2; i <= 2; i++) {
        if (!i) continue;
        ctx.beginPath();
        ctx.moveTo(i * w * .1, -h * .5);
        ctx.quadraticCurveTo(i * w * .16 + sway, -h * .25, i * w * .18, -h * .02);
        ctx.stroke();
      }
      for (let i = -2; i <= 2; i++) {
        tassel(ctx, i * w * .18, -h * .02, 8, sway, hexA(ac, .6));
      }
      // 高领
      ctx.fillStyle = flick ? FL : '#1a1024';
      ctx.beginPath();
      ctx.moveTo(-w * .2, -h * .68);
      ctx.lineTo(-w * .3, -h * .96);
      ctx.lineTo(w * .3, -h * .96);
      ctx.lineTo(w * .2, -h * .68);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .5);
      ctx.lineWidth = 1;
      ctx.stroke();
      // 幞头高帽
      ctx.fillStyle = flick ? FL : '#140c1e';
      ctx.beginPath();
      ctx.moveTo(-w * .17, -h * .96);
      ctx.lineTo(-w * .15, -h * 1.16);
      ctx.quadraticCurveTo(0, -h * 1.2, w * .15, -h * 1.16);
      ctx.lineTo(w * .17, -h * .96);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = ac;
      ctx.fillRect(-w * .16, -h * 1.02, w * .32, 3);
      // 帽侧垂珠
      for (const s of [-1, 1]) {
        ctx.strokeStyle = hexA(ac, .6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s * w * .16, -h * 1.0);
        ctx.quadraticCurveTo(s * w * .2 + sway, -h * .9, s * w * .19, -h * .84);
        ctx.stroke();
        ctx.fillStyle = ac;
        ctx.beginPath(); ctx.arc(s * w * .19, -h * .83, 1.8, 0, TAU); ctx.fill();
      }
      // 白能面：细缝竖瞳 + 额朱判
      ctx.fillStyle = flick ? FL : '#efe4cf';
      ctx.beginPath();
      ctx.ellipse(0, -h * .84, w * .15, h * .095, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .6);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      slitEye(ctx, -w * .06, -h * .85, 3, wind ? '#ff6a50' : (d.eye || '#e3d6ff'), { wide: .6, tall: 1.9 });
      slitEye(ctx, w * .06, -h * .85, 3, wind ? '#ff6a50' : (d.eye || '#e3d6ff'), { wide: .6, tall: 1.9 });
      ctx.strokeStyle = '#8e2a3e';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -h * .92);
      ctx.lineTo(0, -h * .885);
      ctx.moveTo(-w * .02, -h * .905);
      ctx.lineTo(w * .02, -h * .905);
      ctx.stroke();
      crackLine(ctx, [w * .1, -h * .88, w * .06, -h * .84, w * .09, -h * .8], 'rgba(80,50,40,.5)', .8);
      // 判词卷轴（左袖垂出）
      ctx.save();
      ctx.translate(-w * .4, -h * .5 + sway);
      ctx.rotate(-.3);
      ctx.fillStyle = flick ? FL : '#e9dcc3';
      ctx.fillRect(-6, 0, 12, h * .3);
      ctx.strokeStyle = 'rgba(90,60,40,.4)';
      ctx.lineWidth = .8;
      ctx.strokeRect(-6, 0, 12, h * .3);
      ctx.fillStyle = '#8e2a3e';
      ctx.fillRect(-4, h * .1, 8, 8);
      ctx.fillStyle = '#e9dcc3';
      ctx.font = '600 7px "Songti SC",serif';
      ctx.textAlign = 'center';
      ctx.fillText('終', 0, h * .17);
      ctx.restore();
      // 天平（金线）
      ctx.strokeStyle = hexA(ac, .7);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(w * .3, -h * .55); ctx.lineTo(w * .62, -h * .55);
      ctx.moveTo(w * .46, -h * .55); ctx.lineTo(w * .46, -h * .3);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(w * .36, -h * .42, 7, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(w * .56, -h * .42, 7, 0, TAU); ctx.stroke();
      break;
    }

    // —— 灯下影：吊灯 + 灯锥下伸出的影爪 ——
    case 'wisp': {
      const w = e.w, h = e.h;
      const float = Math.sin(t * 3 + e.anim) * 5;
      const wind = windK > 0;
      ctx.translate(0, float);
      // 光锥（蓄力时收窄增亮）
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const spread = wind ? .8 - .3 * windK : .8;
      ctx.fillStyle = vg(ctx, 'wisp-cone' + (wind ? '1' : '0') + ac, 0, -h * .8, 0, 0, [0, hexA(ac, wind ? .3 : .22), 1, hexA(ac, 0)]);
      ctx.beginPath();
      ctx.moveTo(-w * .1, -h * .8);
      ctx.lineTo(-w * spread, 0);
      ctx.lineTo(w * .2, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // 影爪（灯下的真身）：蓄力时下探，金 rim 勾出指形
      const clawLen = h * (.55 + wind * .5 * windK);
      ctx.fillStyle = flick ? FL : '#141022';
      ctx.beginPath();
      ctx.moveTo(-w * .18, -h * .2);
      ctx.quadraticCurveTo(-w * .34, -h * .08, -w * .3, clawLen);
      ctx.lineTo(-w * .16, clawLen * .9);
      ctx.lineTo(-w * .04, clawLen);
      ctx.lineTo(w * .08, clawLen * .92);
      ctx.lineTo(w * .2, clawLen * .72);
      ctx.quadraticCurveTo(w * .26, -h * .1, w * .12, -h * .2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .65);
      ctx.lineWidth = 1.3;
      ctx.stroke();
      // 指缝
      ctx.strokeStyle = 'rgba(232,196,126,.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-w * .17, clawLen * .8);
      ctx.quadraticCurveTo(-w * .1, clawLen * .5, -w * .06, -h * .16);
      ctx.moveTo(w * .05, clawLen * .85);
      ctx.quadraticCurveTo(w * .06, clawLen * .45, w * .04, -h * .14);
      ctx.stroke();
      // 灯体
      bodyFill(ctx, 'wisp-lantern', -h * .9, -h * .35, flick ? FL : '#1a1424', flick ? FL : '#0d0a14', flick);
      ctx.beginPath();
      ctx.moveTo(-w * .3, -h * .88);
      ctx.lineTo(w * .3, -h * .88);
      ctx.lineTo(w * .36, -h * .6);
      ctx.lineTo(w * .3, -h * .35);
      ctx.lineTo(-w * .3, -h * .35);
      ctx.lineTo(-w * .36, -h * .6);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .7);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      // 金骨弧
      ctx.strokeStyle = hexA(ac, .4);
      ctx.lineWidth = 1;
      for (const yy of [-h * .72, -h * .58, -h * .46]) {
        ctx.beginPath();
        ctx.ellipse(0, yy, w * (.3 + (Math.abs(yy + h * .6) / h) * .05), h * .04, 0, 0, Math.PI);
        ctx.stroke();
      }
      // 缝隙焰眼
      slitEye(ctx, 0, -h * .6, 4.4, wind ? '#ff6a50' : (d.eye || '#fff3c4'), { wide: .5, tall: 2, glowA: .7 });
      // 灯底流苏
      tassel(ctx, 0, -h * .35, h * .16, Math.sin(t * 2.2 + e.anim) * 3, hexA(ac, .75));
      // 挂杆与提环
      ctx.strokeStyle = hexA(ac, .55);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(w * .3, -h * .88);
      ctx.quadraticCurveTo(w * .5, -h * 1.15, w * .72, -h * 1.1);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -h * .92, w * .14, Math.PI, 0);
      ctx.stroke();
      break;
    }

    // —— 星砂傀儡：沙漏身 + 星砂漏泻 + 裂陶面具 + 星形空洞 ——
    case 'sand': {
      const w = e.w, h = e.h;
      const sway = Math.sin(t * 3 + e.anim) * 3;
      const wind = windK > 0;
      // 沙尘裙摆
      bodyFill(ctx, 'sand-skirt', -h * .55, 0, flick ? FL : '#6b472a', flick ? FL : '#2e1c10', flick);
      ctx.beginPath();
      ctx.moveTo(-w * .38, 0);
      ctx.quadraticCurveTo(-w * .3, -h * .4, -w * .2, -h * .55);
      ctx.lineTo(w * .2, -h * .55);
      ctx.quadraticCurveTo(w * .3, -h * .4, w * .38, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .4);
      ctx.lineWidth = 1;
      ctx.stroke();
      // 裙底缘锯齿 + 沙堆
      ctx.fillStyle = flick ? FL : '#4a2f1c';
      ctx.beginPath();
      ctx.moveTo(-w * .34, -h * .06);
      for (let x = -w * .34; x <= w * .34; x += w * .1) ctx.lineTo(x + w * .05, 0);
      ctx.lineTo(w * .34, -h * .06);
      ctx.closePath();
      ctx.fill();
      // 上身（窄腰）
      bodyFill(ctx, 'sand-torso', -h * .84, -h * .5, flick ? FL : '#3a2418', flick ? FL : '#1c110a', flick);
      ctx.beginPath();
      ctx.moveTo(-w * .2, -h * .5);
      ctx.quadraticCurveTo(-w * .1, -h * .62, -w * .16, -h * .68);
      ctx.lineTo(-w * .24, -h * .84);
      ctx.lineTo(w * .24, -h * .84);
      ctx.lineTo(w * .16, -h * .68);
      ctx.quadraticCurveTo(w * .1, -h * .62, w * .2, -h * .5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .45);
      ctx.lineWidth = 1;
      ctx.stroke();
      // 星砂漏泻（腰间沙流）
      ctx.save();
      ctx.globalAlpha = .5;
      ctx.fillStyle = ac;
      for (let i = 0; i < 3; i++) {
        const yy = -h * .5 + ((t * 40 + i * 14) % (h * .3));
        ctx.fillRect(-w * .04 + i * w * .05, yy, 2.2, 7);
      }
      ctx.restore();
      // 星砂微光
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const a = t * 1.2 + i * 1.3;
        glow(ctx, Math.sin(a) * w * .22, -h * (.3 + (i % 3) * .12), 3.4, ac, .3 + .2 * Math.sin(t * 3 + i));
      }
      ctx.restore();
      // 星形空洞（胸口叙事）
      ctx.fillStyle = '#0c0810';
      starPath(ctx, 0, -h * .68, w * .13, t * .4);
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .8);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // 裂陶面具（胡狼，一耳折断）
      ctx.fillStyle = flick ? FL : '#8a5c32';
      ctx.beginPath();
      ctx.ellipse(0, -h * .9, w * .2, h * .1, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .6);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      crackLine(ctx, [-w * .1, -h * .95, -w * .05, -h * .9, -w * .09, -h * .85], 'rgba(0,0,0,.5)', 1);
      ctx.fillStyle = d.accent;
      ctx.beginPath();
      ctx.moveTo(-w * .14, -h * .96);
      ctx.lineTo(-w * .22, -h * 1.08);
      ctx.lineTo(-w * .04, -h * .99);
      ctx.closePath();
      ctx.fill();
      // 断耳残根
      ctx.beginPath();
      ctx.moveTo(w * .12, -h * .96);
      ctx.lineTo(w * .17, -h * 1.0);
      ctx.lineTo(w * .05, -h * .99);
      ctx.closePath();
      ctx.fill();
      slitEye(ctx, -w * .08, -h * .91, 2.8, wind ? '#ff6a50' : (d.eye || '#ffe6a8'), { wide: .6, tall: 1.8 });
      slitEye(ctx, w * .08, -h * .91, 2.8, wind ? '#ff6a50' : (d.eye || '#ffe6a8'), { wide: .6, tall: 1.8 });
      // 破旧头巾
      ctx.fillStyle = flick ? FL : '#4a2f1c';
      ctx.beginPath();
      ctx.moveTo(-w * .2, -h * .95);
      ctx.quadraticCurveTo(-w * .3 + sway, -h * .86, -w * .26, -h * .78);
      ctx.lineTo(-w * .14, -h * .84);
      ctx.closePath();
      ctx.fill();
      // 飘沙
      ctx.globalAlpha = .35;
      ctx.fillStyle = d.accent;
      for (let i = 0; i < 4; i++) {
        const a = t * 1.4 + i * 1.3;
        ctx.fillRect(Math.sin(a) * w * .5, -h * .3 + Math.cos(a) * 18, 3, 1);
      }
      ctx.globalAlpha = 1;
      break;
    }

    // —— 无面灯神：纸灯无面，内藏影形 ——
    case 'lamp': {
      const w = e.w, h = e.h;
      const float = Math.sin(t * 2.4 + e.anim) * 4;
      const wind = windK > 0;
      ctx.translate(0, float);
      ctx.rotate(Math.sin(t * 1.1 + e.anim) * .06 + (wind ? .1 * windK : 0));
      // 灯下光晕
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      glow(ctx, 0, -h * .1, w * .8, ac, wind ? .3 : .2);
      ctx.restore();
      // 纸灯身（米纸 + 金骨）
      bodyFill(ctx, 'lamp-body', -h * .95, -h * .05, flick ? FL : '#e5d5b2', flick ? FL : '#8a744e', flick);
      ctx.beginPath();
      ctx.moveTo(-w * .1, -h * .95);
      ctx.quadraticCurveTo(-w * .42, -h * .8, -w * .38, -h * .5);
      ctx.quadraticCurveTo(-w * .44, -h * .2, -w * .16, -h * .05);
      ctx.lineTo(w * .16, -h * .05);
      ctx.quadraticCurveTo(w * .44, -h * .2, w * .38, -h * .5);
      ctx.quadraticCurveTo(w * .42, -h * .8, w * .1, -h * .95);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .55);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // 金骨横弧（纸层骨架）
      ctx.strokeStyle = hexA(ac, .45);
      ctx.lineWidth = 1;
      for (const yy of [-h * .78, -h * .62, -h * .45, -h * .28]) {
        ctx.beginPath();
        ctx.ellipse(0, yy, w * .3, h * .045, 0, 0, Math.PI);
        ctx.stroke();
      }
      // 无面：只有内藏影形的两道缝瞳
      ctx.fillStyle = flick ? FL : 'rgba(10,7,14,.92)';
      ctx.beginPath();
      ctx.ellipse(0, -h * .58, w * .2, h * .17, 0, 0, TAU);
      ctx.fill();
      slitEye(ctx, -w * .07, -h * .58, 3, wind ? '#ff6a50' : (d.eye || '#fff3c4'), { wide: .55, tall: 2, glowA: .7 });
      slitEye(ctx, w * .07, -h * .58, 3, wind ? '#ff6a50' : (d.eye || '#fff3c4'), { wide: .55, tall: 2, glowA: .7 });
      // 顶盖 + 挂环 + 底穗
      ctx.fillStyle = ac;
      ctx.fillRect(-w * .14, -h * .98, w * .28, 4);
      ctx.strokeStyle = hexA(ac, .6);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, -h * 1.02, w * .1, Math.PI, 0);
      ctx.stroke();
      tassel(ctx, 0, -h * .05, h * .1, Math.sin(t * 2) * 3, hexA(ac, .85));
      break;
    }

    default: {
      inkFill(ctx, e, 0, 0, e.w, e.h);
      ctx.fillRect(-e.w / 2, -e.h, e.w, e.h);
      slitEye(ctx, 0, -e.h * .7, 5, d.eye || '#ffe9b0');
    }
  }
  ctx.restore();
}

// ===========================================================================
// Boss
// ===========================================================================
export class Boss extends Enemy {
  constructor(defId, opts = {}) {
    const def = BOSSES[defId];
    super('oni', opts.x ?? 900, opts);
    this.boss = true;
    this.bossDef = def;
    this.id = def.id;
    this.name = def.name;
    this.en = def.en;
    this.title = def.title;
    this.w = def.w;
    this.h = def.h;
    this.x = opts.x ?? (G.room ? G.room.w * .58 : 900);
    this.baseY = FLOOR - 20;
    this.y = FLOOR;
    this.homeY = FLOOR;
    this.flying = true;
    this.hp = def.hp * (1 + (G.run?.act || 0) * .12);
    this.maxHp = this.hp;
    this.def = {
      ...ENEMIES.oni,
      color: def.color, accent: def.accent, eye: def.eye,
      draw: def.draw, w: def.w, h: def.h,
      dmg: def.dmg || 16, // 幕终主角用自己的伤害表，不吃小怪默认值
    };
    this.element = 'moon';
    this.color = def.color;
    this.spawnY = FLOOR;
    this.spawning = 0;
    this.spawnT = 1;
    this.introT = 2.2;
    this.phase = 0;
    this.phaseTransition = 0;
    this.pattern = null;
    this.patternT = 0;
    this.patternData = null;
    this.nextPattern = 1.8;
    this.patternCds = {};
    this.warns = []; // 当前招式的统一预警（金→红）
    for (const p of def.patterns) this.patternCds[p.id] = 1;
    this.dmgMul = 1 + (G.run?.act || 0) * .35;
    this.animT = 0;
    this.dark = 0;
  }

  update(dt) {
    this.anim += dt;
    this.animT += dt;
    this.flash = Math.max(0, this.flash - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    if (this.dead) {
      this.deathT += dt;
      return;
    }
    if (this.status?.stun > 0 || this.status?.freeze > 0) {
      // 眩晕/冰冻计时由 combat.js updateStatuses 统一递减，这里只做停摆
      this.vx = damp(this.vx, 0, 8, dt);
      return;
    }
    if (this.introT > 0) {
      this.introT -= dt;
      this.y = damp(this.y, FLOOR - 12, 3, dt);
      return;
    }
    // 阶段：可见形态变化 + 强反馈
    const ratio = this.hp / this.maxHp;
    const phases = this.bossDef.phases;
    let newPhase = 0;
    for (let i = 0; i < phases.length; i++) if (ratio <= phases[i]) newPhase = i + 1;
    if (newPhase > this.phase) {
      this.phase = newPhase;
      this.phaseTransition = 1.5;
      FX.flash(this.bossDef.accent, .5, .55);
      FX.shake(.9);
      FX.slowmo(.55, .35);
      Audio.sfx('phase');
      G.banner = { type: 'phase', name: '第' + ['一', '二', '三', '四'][this.phase] + '阶段', sub: 'PHASE ' + (this.phase + 1), color: this.bossDef.accent, t: 0, dur: 1.6 };
      const ac2 = this.bossDef.accent;
      const cy = this.y - this.h * .5;
      // 双冲击环 + 墨溅 + 冠屑/纸屑飞散
      FX.ring(this.x, cy, 520, ac2, { life: .8, width: 7 });
      FX.ring(this.x, cy, 300, '#fff8e8', { life: .5, width: 3 });
      FX.ring(this.x, FLOOR - 6, 380, ac2, { life: .7, width: 5, squash: .2 });
      FX.ink(this.x, cy, 18, '#140a16');
      for (let i = 0; i < 30; i++) {
        FX.p({ x: this.x + rnd(-120, 120), y: this.y - rnd(60, this.h), vx: rnd(-260, 260), vy: rnd(-300, 100), life: .9, size: rnd(2, 6), color: ac2, glow: true, shape: 'star' });
      }
      for (let i = 0; i < 12; i++) {
        FX.p({ x: this.x + rnd(-40, 40), y: this.y - this.h * rnd(.5, .9), vx: rnd(-180, 180), vy: rnd(-320, -80), life: 1.1, size: rnd(4, 8), color: ac2, glow: true, shape: 'shard', gravity: 320, spin: rnd(-6, 6) });
      }
      this.warns.length = 0;
      this.pattern = null;
      this.patternData = null;
      this.nextPattern = 1.2;
    }
    if (this.phaseTransition > 0) {
      this.phaseTransition -= dt;
      this.y = damp(this.y, FLOOR - 20, 3, dt);
      return;
    }
    // 浮空追踪
    const p = G.player;
    if (p) {
      this.facing = p.x < this.x ? -1 : 1;
      const targetX = clamp(p.x + (p.x < this.x ? 260 : -260), 200, (G.room?.w || 1600) - 200);
      this.x = damp(this.x, targetX, .7, dt);
    }
    this.y = damp(this.y, FLOOR - 20 + Math.sin(this.anim * 1.4) * 8, 2, dt);
    // 被玩家贴上时轻微判定
    if (this.pattern) {
      this.updatePattern(dt);
      this.syncBossWarns();
    } else {
      this.nextPattern -= dt;
      for (const k in this.patternCds) this.patternCds[k] = Math.max(0, this.patternCds[k] - dt);
      if (this.nextPattern <= 0) this.choosePattern();
    }
    if (p && dist(p.x, p.y - 80, this.x, this.y - this.h * .45) < 60) {
      // 身体碰撞
      if (!this.bodyHitT || this.bodyHitT <= 0) {
        hurtPlayer((this.def.dmg || 16) * .5 * this.dmgMul, this.x, {});
        this.bodyHitT = 1;
      }
    }
    if (this.bodyHitT > 0) this.bodyHitT -= dt;
  }

  // 跟随型预警同步（身体锚点 / 激光瞄准）
  syncBossWarns() {
    const p = G.player;
    if (!p || !this.pattern) return;
    const T = this.pattern.t;
    for (let i = 0; i < this.warns.length; i++) {
      const s = this.warns[i];
      if (T < s.t0 || T > s.t1) continue;
      if (s.follow === 'body') { s.x = this.x; s.y = this.y - this.h * .5; }
      if (s.aim && T < s.t1 - .15) {
        s.x1 = this.x; s.y1 = this.y - this.h * .4;
        const a = angleTo(s.x1, s.y1, p.x, p.y - 80);
        s.x2 = s.x1 + Math.cos(a) * 1400;
        s.y2 = s.y1 + Math.sin(a) * 1400;
      }
    }
  }

  choosePattern() {
    const avail = this.bossDef.patterns.filter((p) => p.phase <= this.phase + 1 && (this.patternCds[p.id] || 0) <= 0);
    if (!avail.length) {
      this.nextPattern = .8;
      return;
    }
    const pat = pick(avail);
    this.pattern = { id: pat.id, t: 0, dur: 2.2, fired: {} };
    this.patternT = 0;
    this.patternCds[pat.id] = pat.cd;
    this.nextPattern = 1;
    this.startPattern(pat.id);
  }

  // 招式启动：锁预警参数，所有预警窗口 ≥0.6s
  startPattern(id) {
    this.patternData = { id };
    this.warns.length = 0;
    Audio.sfx('warning', { volume: .5 });
    const p = G.player;
    const w = G.room?.w || 1600;
    if (id === 'batonSweep') {
      this.pattern.dur = 2.4;
      this.patternData.sweepX = clamp(p ? p.x : w * .5, 150, w - 150);
      this.patternData.hits = 0;
      this.warns.push({ type: 'circle', x: this.patternData.sweepX, y: FLOOR - 6, r: 150, t0: .15, t1: 1.2 });
    } else if (id === 'spotlights') {
      this.pattern.dur = 3.2;
      this.patternData.xs = [];
      for (let i = 0; i < 5; i++) {
        const x = rnd(140, w - 140);
        this.patternData.xs.push(x);
        this.warns.push({ type: 'circle', x, y: FLOOR - 4, r: 64, t0: .2 + i * .45, t1: 1.2 + i * .45 });
      }
    } else if (id === 'paperFan') {
      this.pattern.dur = 3.2;
      this.patternData.waves = 0;
      this.warns.push({ type: 'sector', x: this.x, y: this.y - this.h * .5, r: 470, a: p ? angleTo(this.x, this.y - this.h * .5, p.x, p.y - 80) : 0, spread: 1.0, t0: .1, t1: .7, follow: 'body' });
    } else if (id === 'pullStrings') {
      this.pattern.dur = 2.6;
      const px = p ? p.x : w * .5, py = p ? p.y - 80 : FLOOR - 80;
      this.patternData.px = px; this.patternData.py = py;
      this.warns.push({ type: 'circle', x: px, y: py, r: 95, t0: .1, t1: .8 });
      this.warns.push({ type: 'line', x1: px, y1: py, x2: this.x, y2: this.y - this.h * .4, w: 26, t0: .6, t1: 1.2 });
    } else if (id === 'carousel') {
      this.pattern.dur = 4.0;
      this.warns.push({ type: 'circle', x: this.x, y: this.y - this.h * .5, r: 170, t0: .1, t1: .9, follow: 'body' });
    } else if (id === 'bowShock') {
      this.pattern.dur = 2.6;
      this.warns.push({ type: 'circle', x: this.x, y: FLOOR - 6, r: 420, t0: .2, t1: 1.2, follow: 'ground' });
    } else if (id === 'summon') {
      this.pattern.dur = 2.2;
      this.patternData.sx = [];
      for (let i = 0; i < 2; i++) {
        const x = clamp(this.x + rnd(-200, 200), 120, w - 120);
        this.patternData.sx.push(x);
        this.warns.push({ type: 'circle', x, y: FLOOR - 8, r: 84, t0: .1 + i * .1, t1: .7 + i * .1 });
      }
    } else if (id === 'noteRing') {
      this.pattern.dur = 3.0;
      this.warns.push({ type: 'circle', x: this.x, y: this.y - this.h * .45, r: 190, t0: .1, t1: .8, follow: 'body' });
      this.patternData.rings = 0;
    } else if (id === 'tide') {
      this.pattern.dur = 3.2;
      this.warns.push({ type: 'line', x1: 0, y1: FLOOR - 30, x2: w, y2: FLOOR - 30, w: 110, t0: .2, t1: .9 });
    } else if (id === 'sirenDive') {
      this.pattern.dur = 2.4;
      this.patternData.dived = false;
      this.patternData.tx = clamp(p ? p.x + (p.x < w / 2 ? 240 : -240) : w * .5, 120, w - 120);
      this.warns.push({ type: 'circle', x: this.patternData.tx, y: FLOOR - 5, r: 130, t0: .1, t1: 1.05 });
    } else if (id === 'noteRain') {
      this.pattern.dur = 3.4;
      this.warns.push({ type: 'line', x1: 0, y1: FLOOR - 30, x2: w, y2: FLOOR - 30, w: 120, t0: .1, t1: .7 });
    } else if (id === 'spiralAria') {
      this.pattern.dur = 3.8;
      this.warns.push({ type: 'circle', x: this.x, y: this.y - this.h * .5, r: 160, t0: .1, t1: .9, follow: 'body' });
    } else if (id === 'flood') {
      this.pattern.dur = 4.2;
      this.warns.push({ type: 'line', x1: 0, y1: FLOOR - 20, x2: w, y2: FLOOR - 20, w: 130, t0: .1, t1: .8 });
    } else if (id === 'handSlam') {
      this.pattern.dur = 2.5;
      this.patternData.slam = 0;
      const xs = [clamp(this.x - 260, 120, w - 120), clamp(this.x + 260, 120, w - 120)];
      this.patternData.x0 = xs[0]; this.patternData.x1s = xs[1];
      for (let k = 0; k < 2; k++) {
        this.warns.push({ type: 'circle', x: xs[k], y: FLOOR - 5, r: 130, t0: .5 + k * .9, t1: 1.2 + k * .9 });
      }
    } else if (id === 'starfall') {
      this.pattern.dur = 3.6;
      this.warns.push({ type: 'line', x1: 0, y1: FLOOR - 30, x2: w, y2: FLOOR - 30, w: 120, t0: .1, t1: .7 });
    } else if (id === 'eclipseBeam') {
      this.pattern.dur = 3.4;
      const s = { type: 'line', x1: this.x, y1: this.y - this.h * .4, x2: this.x + (this.facing > 0 ? 1400 : -1400), y2: this.y - this.h * .4, w: 34, t0: .3, t1: 1.5, aim: true };
      this.warns.push(s);
    } else if (id === 'blackHole') {
      this.pattern.dur = 3.6;
      const zx = p ? p.x : w * .5, zy = p ? p.y - 80 : FLOOR - 80;
      this.patternData.zx = zx; this.patternData.zy = zy;
      this.warns.push({ type: 'circle', x: zx, y: zy, r: 240, t0: .1, t1: .8 });
    } else if (id === 'finalCurtain') {
      this.pattern.dur = 4.6;
      this.warns.push({ type: 'line', x1: 0, y1: FLOOR - 30, x2: w, y2: FLOOR - 30, w: 130, t0: .5, t1: 1.1 });
      // 两侧冲击走廊
      this.warns.push({ type: 'line', x1: this.x - 120, y1: FLOOR - 26, x2: 40, y2: FLOOR - 26, w: 66, t0: 1.2, t1: 1.8 });
      this.warns.push({ type: 'line', x1: this.x + 120, y1: FLOOR - 26, x2: w - 40, y2: FLOOR - 26, w: 66, t0: 1.2, t1: 1.8 });
      this.warns.push({ type: 'line', x1: this.x - 120, y1: FLOOR - 26, x2: 40, y2: FLOOR - 26, w: 66, t0: 2.1, t1: 2.7 });
      this.warns.push({ type: 'line', x1: this.x + 120, y1: FLOOR - 26, x2: w - 40, y2: FLOOR - 26, w: 66, t0: 2.1, t1: 2.7 });
    }
  }

  updatePattern(dt) {
    const pat = this.pattern;
    if (!pat) return;
    pat.t += dt;
    const T = pat.t;
    const p = G.player;
    const w = G.room?.w || 1600;
    const accent = this.bossDef.accent;
    const id = pat.id;
    const at = (time, key, fn) => {
      if (T >= time && !pat.fired[key]) { pat.fired[key] = true; fn(); }
    };
    // 招式基准伤害跟随各幕主角的数据表（16/18/21），一幕口径与旧版一致
    const dmg = (this.def.dmg || 16) * .875 * this.dmgMul;

    switch (id) {
      case 'batonSweep': {
        at(.3, 'warn', () => {
          FX.ring(this.patternData.sweepX, FLOOR - 6, 150, '#ff9a5a', { life: .8, width: 3, squash: .3 });
          Audio.sfx('heavy', { volume: .6 });
        });
        at(1.0, 'swing', () => {
          FX.slash(this.x, this.y - this.h * .45, this.facing > 0 ? 0 : Math.PI, 520, accent, { width: 20, span: 1.6, life: .5 });
        });
        at(1.2, 'hit', () => {
          const cx = this.patternData.sweepX;
          if (p && Math.abs(p.x - cx) < 150 && p.y > FLOOR - 90) hurtPlayer(dmg * 1.3, cx, { sourceBoss: true });
          FX.ring(cx, FLOOR - 10, 160, accent, { life: .4, width: 6, squash: .25 });
          FX.burst(cx, FLOOR - 20, { count: 20, color: accent, speed: 300, size: 5, life: .5, glow: true });
          FX.shake(.4);
        });
        break;
      }
      case 'spotlights': {
        for (let i = 0; i < 5; i++) {
          const t0 = .2 + i * .45;
          at(t0, 'warn' + i, () => Audio.sfx('warning', { volume: .3 }));
          at(t0 + 1.0, 'hit' + i, () => {
            const x = this.patternData.xs[i];
            FX.beam(x, 80, x, FLOOR, '#ffe9b0', { life: .35, width: 40, core: 8 });
            FX.ring(x, FLOOR - 8, 70, '#ffe9b0', { life: .4, width: 4, squash: .25 });
            FX.shake(.25);
            if (p && Math.abs(p.x - x) < 44 && p.y > FLOOR - 120) hurtPlayer(dmg, x, { sourceBoss: true });
            Audio.sfx('beam', { volume: .5 });
          });
        }
        break;
      }
      case 'paperFan': {
        for (let k = 0; k < 3; k++) {
          at(.7 + k * .6, 'wave' + k, () => {
            if (!p) return;
            const base = angleTo(this.x, this.y - this.h * .5, p.x, p.y - 80);
            for (let i = -3; i <= 3; i++) {
              spawnEnemyProjectile({
                x: this.x, y: this.y - this.h * .55, angle: base + i * .12, speed: 320,
                dmg: dmg * .55, size: 12, color: '#efe2c8', type: 'paper', life: 4,
              });
            }
            Audio.sfx('magic', { volume: .35 });
          });
        }
        break;
      }
      case 'pullStrings': {
        at(.8, 'pull', () => {
          for (let i = 0; i < 7; i++) {
            const a = -Math.PI / 2 + (i - 3) * .2;
            spawnEnemyProjectile({
              x: this.patternData.px + Math.cos(a) * 300, y: this.patternData.py + Math.sin(a) * 280,
              angle: Math.atan2(this.y - 80 - this.patternData.py, this.x - this.patternData.px), speed: 330,
              dmg: dmg * .5, size: 10, color: accent, type: 'string', life: 3,
            });
          }
        });
        at(1.2, 'yank', () => {
          if (!p) return;
          const a = angleTo(p.x, p.y - 80, this.x, this.y - this.h * .4);
          p.vx += Math.cos(a) * 600;
          p.vy -= 250;
          hurtPlayer(dmg * .6, this.x, { sourceBoss: true });
          FX.beam(p.x, p.y - 80, this.x, this.y - this.h * .4, accent, { life: .3, width: 4 });
        });
        break;
      }
      case 'carousel': {
        at(.9, 'spin', () => {
          this.patternData.spin = true;
          Audio.sfx('magic', { volume: .5 });
        });
        if (this.patternData.spin) {
          this.patternData.acc = (this.patternData.acc || 0) + dt;
          if (this.patternData.acc > .16 && pat.t < 3.4) {
            this.patternData.acc = 0;
            const base = this.animT * 3;
            for (let i = 0; i < 4; i++) {
              spawnEnemyProjectile({
                x: this.x, y: this.y - this.h * .5, angle: base + i * TAU / 4, speed: 250,
                dmg: dmg * .45, size: 10, color: accent, type: 'orb', life: 4,
              });
            }
          }
        }
        break;
      }
      case 'bowShock': {
        at(.8, 'bow', () => {
          FX.slash(this.x, this.y - this.h * .4, Math.PI / 2, 260, accent, { width: 26, span: 2.6, life: .5 });
          Audio.sfx('heavy', { volume: .8 });
        });
        at(1.2, 'hit', () => {
          if (p && p.y > FLOOR - 55) hurtPlayer(dmg * 1.4, this.x, { sourceBoss: true });
          for (let s = -1; s <= 1; s += 2) {
            spawnEnemyProjectile({
              x: this.x + s * 100, y: FLOOR - 30, vx: s * 500, vy: 0, dmg: dmg * .7,
              size: 26, color: accent, type: 'shock', life: 2, angle: s > 0 ? 0 : Math.PI,
            });
          }
          FX.ring(this.x, FLOOR - 6, 420, accent, { life: .6, width: 5, squash: .18 });
          FX.shake(.5);
        });
        break;
      }
      case 'summon': {
        at(.7, 'summon', () => {
          for (let i = 0; i < 2; i++) {
            spawnBossAdd('oni', this.patternData.sx[i], this.phase >= 2 ? 'puppet' : 'oni');
          }
          FX.ring(this.x, FLOOR - 10, 200, accent, { life: .8, width: 4, squash: .25 });
          Audio.sfx('door', { volume: .5 });
        });
        break;
      }
      case 'noteRing': {
        for (let k = 0; k < 3; k++) {
          at(.8 + k * .7, 'ring' + k, () => {
            const n = 12;
            const off = k * .12;
            for (let i = 0; i < n; i++) {
              spawnEnemyProjectile({
                x: this.x, y: this.y - this.h * .45, angle: (i / n) * TAU + off, speed: 250,
                dmg: dmg * .45, size: 10, color: k === 2 ? '#c9a0ff' : '#9fd8ff', type: 'note', life: 4,
              });
            }
            Audio.sfx('magic', { volume: .4 });
          });
        }
        break;
      }
      case 'tide': {
        at(.2, 'warn', () => {
          Audio.sfx('warning', { volume: .5 });
          FX.shake(.2);
        });
        for (let i = 0; i < 3; i++) {
          at(.9 + i * .6, 'wave' + i, () => {
            const dir = i % 2 === 0 ? 1 : -1;
            const startX = dir > 0 ? 10 : w - 10;
            for (let row = 0; row < 3; row++) {
              spawnEnemyProjectile({
                x: startX, y: FLOOR - 20 - row * 46, vx: dir * (380 + row * 30), vy: 0,
                dmg: dmg * .7, size: 20, color: '#9fd8ff', type: 'wave', life: 4,
                angle: dir > 0 ? 0 : Math.PI,
              });
            }
            FX.shake(.2);
          });
        }
        break;
      }
      case 'sirenDive': {
        at(.5, 'dive', () => {
          this.x = this.patternData.tx;
          this.y = 120;
          FX.beam(this.x, 100, this.x, FLOOR, '#9fd8ff', { life: .4, width: 30 });
          Audio.sfx('dash', { volume: .6 });
        });
        at(1.05, 'hit', () => {
          this.y = FLOOR - 20;
          if (p && Math.abs(p.x - this.x) < 130) hurtPlayer(dmg * 1.2, this.x, { sourceBoss: true });
          FX.ring(this.x, FLOOR - 5, 170, '#9fd8ff', { life: .6, width: 6, squash: .25 });
          FX.burst(this.x, FLOOR - 20, { count: 26, color: '#9fd8ff', speed: 340, size: 5, life: .7, glow: true, gravity: 300 });
          FX.shake(.45);
        });
        break;
      }
      case 'noteRain': {
        for (let i = 0; i < 16; i++) {
          at(.7 + i * .13, 'rain' + i, () => {
            const x = rnd(80, w - 80);
            spawnEnemyProjectile({
              x, y: 40, vx: 0, vy: 420, dmg: dmg * .5, size: 11,
              color: '#9fd8ff', type: 'note', life: 3, angle: Math.PI / 2,
            });
          });
        }
        break;
      }
      case 'spiralAria': {
        if (!this.patternData.acc2) this.patternData.acc2 = 0;
        this.patternData.acc2 += dt;
        if (this.patternData.acc2 > .1 && pat.t > .9 && pat.t < 3.3) {
          this.patternData.acc2 = 0;
          const base = this.animT * 5;
          for (let i = 0; i < 2; i++) {
            spawnEnemyProjectile({
              x: this.x, y: this.y - this.h * .5, angle: base + i * Math.PI, speed: 290,
              dmg: dmg * .4, size: 9, color: '#c9a0ff', type: 'note', life: 4,
            });
          }
        }
        break;
      }
      case 'flood': {
        at(.8, 'flood', () => {
          for (let i = 0; i < 8; i++) {
            const x = (i / 8) * w + 80;
            spawnEnemyProjectile({
              x, y: FLOOR - 10, vx: 0, vy: -340, dmg: dmg * .7, size: 16,
              color: '#9fd8ff', type: 'wave', life: 1.5, gravity: 500,
              angle: -Math.PI / 2,
            });
          }
          FX.ring(this.x, FLOOR - 4, w, '#9fd8ff', { life: 1.2, width: 4, squash: .12 });
          Audio.sfx('explode', { volume: .5 });
        });
        break;
      }
      case 'handSlam': {
        for (let k = 0; k < 2; k++) {
          at(.5 + k * .9, 'warn' + k, () => Audio.sfx('warning', { volume: .4 }));
          at(1.2 + k * .9, 'hit' + k, () => {
            const x = k === 0 ? this.patternData.x0 : this.patternData.x1s;
            FX.ring(x, FLOOR - 8, 150, '#e8c47e', { life: .5, width: 6, squash: .2 });
            FX.burst(x, FLOOR - 20, { count: 24, color: '#e8c47e', speed: 300, size: 5, life: .6, glow: true });
            if (p && Math.abs(p.x - x) < 110 && p.y > FLOOR - 110) hurtPlayer(dmg * 1.3, x, { sourceBoss: true });
            FX.shake(.5);
          });
        }
        break;
      }
      case 'starfall': {
        for (let i = 0; i < 10; i++) {
          at(.7 + i * .17, 'star' + i, () => {
            const x = rnd(80, w - 80);
            spawnEnemyProjectile({
              x, y: -30, vx: 0, vy: 620, dmg: dmg * .9, size: 18,
              color: '#c9a0ff', type: 'star', life: 2, angle: Math.PI / 2,
            });
          });
        }
        break;
      }
      case 'eclipseBeam': {
        at(1.5, 'beam', () => {
          if (!p) return;
          const ang = angleTo(this.x, this.y - this.h * .4, p.x, p.y - 80);
          const len = 1400;
          FX.beam(this.x, this.y - this.h * .4, this.x + Math.cos(ang) * len, this.y - this.h * .4 + Math.sin(ang) * len, '#ffe9b0', { life: .45, width: 60, core: 14 });
          FX.shake(.6);
          FX.flash('#ffe9b0', .3, .3);
          // 判定
          const steps = 30;
          for (let i = 0; i < steps; i++) {
            const cx = this.x + Math.cos(ang) * (i / steps) * len;
            const cy = this.y - this.h * .4 + Math.sin(ang) * (i / steps) * len;
            if (dist(p.x, p.y - 80, cx, cy) < 40) { hurtPlayer(dmg * 1.8, this.x, { sourceBoss: true }); break; }
          }
          Audio.sfx('beam', { volume: .8 });
        });
        break;
      }
      case 'blackHole': {
        at(.8, 'hole', () => {
          const z = { x: this.patternData.zx, y: this.patternData.zy, r: 180, life: 2.0, max: 2.0, type: 'blackhole', color: '#a084dc', element: 'moon', dmg: 0, tick: .4, tickT: 0, pull: 700, owner: 'enemy' };
          G.zones.push(z);
          Audio.sfx('ult', { volume: .6 });
        });
        at(2.0, 'pull', () => {
          if (p) {
            const a = angleTo(p.x, p.y - 80, this.patternData.zx, this.patternData.zy);
            p.vx += Math.cos(a) * 300;
            p.vy += Math.sin(a) * 120;
          }
        });
        at(3.0, 'boom', () => {
          FX.ring(this.patternData.zx, this.patternData.zy, 240, '#a084dc', { life: .7, width: 8, fill: true });
          FX.flash('#c9a0ff', .5, .45);
          FX.shake(.7);
          if (p && dist(p.x, p.y - 80, this.patternData.zx, this.patternData.zy) < 240) hurtPlayer(dmg * 2, this.x, { sourceBoss: true });
          Audio.sfx('explode', { volume: .9 });
        });
        break;
      }
      case 'finalCurtain': {
        at(.5, 'dark', () => {
          FX.flash('#05040a', .8, 1.2);
          G.bossDark = 1;
          Audio.sfx('boss');
        });
        for (let i = 0; i < 6; i++) {
          at(1.1 + i * .22, 'rain' + i, () => {
            const x = (i % 2 ? 1 : 0) ? rnd(100, w - 100) : clamp(this.x + rnd(-300, 300), 80, w - 80);
            spawnEnemyProjectile({
              x, y: -20, vx: 0, vy: 640, dmg: dmg * .8, size: 20,
              color: '#c9a0ff', type: 'star', life: 2, angle: Math.PI / 2,
            });
          });
        }
        for (let k = 0; k < 2; k++) {
          at(1.8 + k * .9, 'shock' + k, () => {
            for (const s of [-1, 1]) {
              spawnEnemyProjectile({
                x: this.x + s * 120, y: FLOOR - 26, vx: s * 480, vy: 0, dmg: dmg * .9,
                size: 30, color: '#e8c47e', type: 'shock', life: 2, angle: s > 0 ? 0 : Math.PI,
              });
            }
            FX.shake(.4);
          });
        }
        at(4.2, 'end', () => { G.bossDark = 0; });
        break;
      }
    }
    if (pat.t >= pat.dur) {
      this.pattern = null;
      this.patternData = null;
      this.warns.length = 0;
      this.nextPattern = rnd(1, 1.8);
    }
  }

  onHurt(dmg, opt) {
    this.hurtT = .16;
    // 临近阶段阈值的受击：溅墨暗示形态将变
    const next = this.bossDef.phases[this.phase];
    if (next != null && this.hp / this.maxHp - next < .012 && this.hp / this.maxHp > next && chance(.5)) {
      FX.ink(this.x + rnd(-70, 70), this.y - rnd(80, this.h * .85), 4, '#1a0e1c');
    }
  }

  draw(ctx, t) {
    const cam = G.cam.x;
    const x = this.x - cam;
    if (this.dead) {
      const k = clamp(1 - this.deathT / 1.2, 0, 1);
      ctx.save();
      ctx.globalAlpha = k;
      ctx.translate(x, this.y);
      ctx.scale(1 + (1 - k) * .6, 1 - (1 - k) * .4);
      drawBossShape(ctx, this, t);
      ctx.restore();
      return;
    }
    // 统一招式预警（金→红，画在身体之下）
    if (this.pattern && this.warns.length) {
      const T = this.pattern.t;
      for (let i = 0; i < this.warns.length; i++) {
        const s = this.warns[i];
        if (T < s.t0 || T > s.t1) continue;
        s.k = (T - s.t0) / Math.max(.01, s.t1 - s.t0);
        drawWarnShape(ctx, s, cam, t);
      }
    }
    // 影子（缓存软黑贴图）
    ctx.save();
    ctx.globalAlpha = .5;
    ctx.drawImage(glowSprite('#000000'), x - this.w * .9, FLOOR - this.w * .32, this.w * 1.8, this.w * .64);
    ctx.restore();

    if (this.introT > 0) {
      const k = 1 - this.introT / 2.2;
      ctx.save();
      ctx.globalAlpha = k;
      ctx.translate(x, this.y);
      drawBossShape(ctx, this, t);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(x, this.y);
    drawEnemyAura(ctx, this, t, true);
    if (this.phaseTransition > 0) {
      ctx.globalAlpha = .6 + .4 * Math.sin(t * 30);
    }
    drawBossShape(ctx, this, t);
    ctx.restore();
    // 印记
    drawMark(ctx, this, x, t);
    // 头顶预警标记（金→红）
    if (this.telegraph > 0) {
      ctx.save();
      ctx.fillStyle = WARN_RED;
      ctx.font = '600 22px "Songti SC",serif';
      ctx.textAlign = 'center';
      ctx.fillText('!', x, this.y - this.h - 50);
      ctx.restore();
    }
  }
}

// ===========================================================================
// 三位幕终主角：修长诡异 + 叙事部件 + 阶段形态变化
// ===========================================================================
function drawBossShape(ctx, b, t) {
  const d = b.bossDef;
  const w = b.w, h = b.h;
  const flick = b.flash > 0;
  const ac = d.accent;
  const ph = b.phase || 0; // 0/1/2/3：驱动可见形态变化

  if (d.draw === 'papercrown') {
    const sway = Math.sin(t * 1.4) * 6;
    // —— 王座垂幕（叙事部件：金杆下两条残幕，阶段越高越破）——
    const rodY = -h * 1.1;
    ctx.strokeStyle = hexA(ac, .5);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-w * .52, rodY);
    ctx.quadraticCurveTo(0, rodY - 12, w * .52, rodY);
    ctx.stroke();
    ctx.fillStyle = ac;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.arc(s * w * .52, rodY, 3.4, 0, TAU); ctx.fill();
    }
    for (const s of [-1, 1]) {
      bodyFill(ctx, 'pc-drape' + s + ph, rodY, 0, flick ? FL : '#1e0d1a', flick ? FL : '#07040a', flick);
      ctx.beginPath();
      ctx.moveTo(s * w * .3, rodY);
      ctx.quadraticCurveTo(s * (w * .46 + Math.sin(t * .8 + s) * 6), -h * .58, s * (w * .42 + (ph >= 2 ? Math.sin(t * 1.7 + s) * 9 : 0)), -h * .04);
      ctx.lineTo(s * w * .3, -h * .1);
      ctx.lineTo(s * w * .22, -h * (.18 + ph * .05));
      ctx.lineTo(s * w * .36, -h * (.28 + ph * .04));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .3);
      ctx.lineWidth = 1;
      ctx.stroke();
      // 垂幕金缘穗
      tassel(ctx, s * w * .3, rodY, h * .1, Math.sin(t * 1.2 + s) * 4, hexA(ac, .6));
    }
    // —— 提线（阶段越高断得越多）——
    ctx.save();
    ctx.strokeStyle = hexA(ac, .22);
    ctx.lineWidth = 1;
    const strings = ph >= 2 ? 3 : ph >= 1 ? 5 : 7;
    for (let i = 0; i < strings; i++) {
      const sx = -w * .42 + i * (w * .84 / (strings - 1));
      ctx.beginPath();
      ctx.moveTo(sx, -h * 1.02);
      ctx.quadraticCurveTo(sx + Math.sin(t * .7 + i) * 12, -H * .55, sx * 1.35, -H * 1.3);
      ctx.stroke();
    }
    ctx.restore();
    // —— 面具列（叙事部件：身后弧形漂浮纸面具，阶段越高碎得越多）——
    for (let i = 0; i < 5; i++) {
      const a = t * .4 + i * 1.26;
      ctx.save();
      ctx.translate(Math.cos(a) * w * (.55 + (i % 2) * .18), -h * (.4 + (i % 3) * .16) + Math.sin(a) * 16);
      ctx.rotate(Math.sin(a * .8) * .3);
      ctx.globalAlpha = .62 + .18 * Math.sin(t + i);
      paperMask(ctx, 1.0 + (i % 3) * .3, ph >= 1 ? i % 2 === 0 : false, i % 2 ? '#c84a5a' : '#e8c47e');
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // —— 血色披风（修长化）——
    bodyFill(ctx, 'pc-cape' + ph, -h * .85, 0, flick ? FL : '#4a1327', flick ? FL : '#0b040a', flick);
    ctx.beginPath();
    ctx.moveTo(-w * .14, -h * .8);
    ctx.quadraticCurveTo(-w * .5, -h * .55, -w * .56, -h * .02);
    ctx.lineTo(-w * .4, -h * .06);
    ctx.lineTo(-w * .26, 0);
    ctx.lineTo(0, -h * .04);
    ctx.lineTo(w * .26, 0);
    ctx.lineTo(w * .4, -h * .06);
    ctx.lineTo(w * .56, -h * .02);
    ctx.quadraticCurveTo(w * .5, -h * .55, w * .14, -h * .8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = hexA(ac, .3);
    ctx.lineWidth = 1.2;
    for (let i = -3; i <= 3; i++) {
      if (!i) continue;
      ctx.beginPath();
      ctx.moveTo(i * w * .06, -h * .72);
      ctx.quadraticCurveTo(i * w * .15, -h * .35, i * w * .18, -h * .03);
      ctx.stroke();
    }
    // —— 大衣（窄肩长摆，下缘撕裂更碎）——
    bodyFill(ctx, 'pc-coat' + ph, -h * .7, 0, flick ? FL : '#3a1b36', flick ? FL : '#08050c', flick);
    ctx.beginPath();
    ctx.moveTo(-w * .18, -h * .58);
    ctx.quadraticCurveTo(-w * .4, -h * .34, -w * .48, -h * .02);
    ctx.lineTo(-w * .3, -h * .07);
    ctx.lineTo(-w * .2, -h * .015);
    ctx.lineTo(-w * .1, -h * .06);
    ctx.lineTo(0, -h * .01);
    ctx.lineTo(w * .1, -h * .06);
    ctx.lineTo(w * .2, -h * .015);
    ctx.lineTo(w * .3, -h * .07);
    ctx.lineTo(w * .48, -h * .02);
    ctx.quadraticCurveTo(w * .4, -h * .34, w * .18, -h * .58);
    ctx.closePath();
    ctx.fill();
    // 红内衬线与金纹
    ctx.strokeStyle = 'rgba(142,42,62,.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -h * .52);
    ctx.lineTo(0, -h * .03);
    ctx.stroke();
    ctx.strokeStyle = hexA(ac, .35);
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      if (i === 0) continue;
      ctx.beginPath();
      ctx.moveTo(i * w * .07, -h * .5);
      ctx.quadraticCurveTo(i * w * .15 + Math.sin(t + i) * 2, -h * .25, i * w * .18, -h * .02);
      ctx.stroke();
    }
    ctx.strokeStyle = hexA(ac, .55);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-w * .18, -h * .57);
    ctx.quadraticCurveTo(-w * .4, -h * .34, -w * .48, -h * .02);
    ctx.moveTo(w * .18, -h * .57);
    ctx.quadraticCurveTo(w * .4, -h * .34, w * .48, -h * .02);
    ctx.stroke();
    // —— 马甲/躯干 ——
    bodyFill(ctx, 'pc-vest', -h * .9, -h * .5, flick ? FL : '#efe4cf', flick ? FL : '#7d6752', flick);
    ctx.beginPath();
    ctx.moveTo(-w * .15, -h * .56);
    ctx.quadraticCurveTo(-w * .2, -h * .72, -w * .15, -h * .84);
    ctx.lineTo(w * .15, -h * .84);
    ctx.quadraticCurveTo(w * .2, -h * .72, w * .15, -h * .56);
    ctx.closePath();
    ctx.fill();
    // 双排金扣
    ctx.fillStyle = ac;
    for (let r = 0; r < 3; r++) {
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * w * .06, -h * (.63 + r * .055), 2.2, 0, TAU);
        ctx.fill();
      }
    }
    // 胸前星（阶段越高越暗）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = hexA(ac, (ph >= 2 ? .25 : .5) + .2 * Math.sin(t * 3));
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = i * Math.PI / 5 - Math.PI / 2 + t * .15;
      const rr = i % 2 ? 5 : 11;
      const px = Math.cos(a) * rr, py = -h * .68 + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // 领巾 + 拉夫领
    ctx.fillStyle = '#4a0f1e';
    ctx.beginPath();
    ctx.moveTo(-w * .05, -h * .8);
    ctx.lineTo(0, -h * .73);
    ctx.lineTo(w * .05, -h * .8);
    ctx.lineTo(w * .03, -h * .84);
    ctx.lineTo(0, -h * .815);
    ctx.lineTo(-w * .03, -h * .84);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = flick ? FL : '#efe4cf';
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.ellipse(i * w * .04, -h * .84 - Math.abs(i) * 2, w * .04, h * .02, i * .1, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = hexA(ac, .4);
    ctx.lineWidth = 1;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.ellipse(i * w * .04, -h * .84 - Math.abs(i) * 2, w * .04, h * .02, i * .1, 0, TAU);
      ctx.stroke();
    }
    // 肩章（窄）
    for (const side of [-1, 1]) {
      ctx.fillStyle = flick ? FL : '#2a0e1c';
      ctx.beginPath();
      ctx.ellipse(side * w * .17, -h * .8, w * .1, h * .028, side * .3, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .7);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = ac;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.arc(side * w * (.14 + k * .03), -h * .816, 1.5, 0, TAU);
        ctx.fill();
      }
    }
    // —— 手臂：细长球关节（阶段 ≥2 左臂断线垂落）——
    const armSwing = Math.sin(t * 1.2) * .06;
    const limp = ph >= 2;
    const arms = [
      { sx: -w * .16, sy: -h * .79, ex: -w * .38, ey: -h * .58 + sway, hx: -w * .46, hy: -h * .34 + sway },
      { sx: w * .16, sy: -h * .79, ex: w * .38, ey: limp ? -h * .5 : -h * .6 - sway, hx: w * .44, hy: limp ? -h * .22 : -h * .3 - sway },
    ];
    for (let ai = 0; ai < arms.length; ai++) {
      const a = arms[ai];
      ctx.strokeStyle = flick ? FL : '#c8b695';
      ctx.lineWidth = 4.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.quadraticCurveTo(a.ex, a.ey, a.hx, a.hy);
      ctx.stroke();
      ctx.strokeStyle = hexA(ac, .35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy); ctx.quadraticCurveTo(a.ex, a.ey, a.hx, a.hy); ctx.stroke();
      for (const [jx, jy] of [[a.sx, a.sy], [a.ex, a.ey], [a.hx, a.hy]]) {
        ctx.fillStyle = flick ? FL : '#e9dcc3';
        ctx.beginPath(); ctx.arc(jx, jy, 4.2, 0, TAU); ctx.fill();
        ctx.strokeStyle = hexA(ac, .5); ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.fillStyle = '#f4ead7';
      ctx.beginPath();
      ctx.ellipse(a.hx, a.hy + 4, 6.4, 9, a.hx < 0 ? -.3 : .3, 0, TAU);
      ctx.fill();
    }
    // 指挥棒（阶段 ≥2 上扬）
    const bx = w * .44, by = (ph >= 2 ? -h * .42 : -h * .3) - sway;
    ctx.strokeStyle = ac;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(bx, by + 4);
    ctx.lineTo(bx + w * .26, by - h * .36);
    ctx.stroke();
    ctx.fillStyle = ac;
    ctx.beginPath();
    ctx.arc(bx + w * .26, by - h * .36, 4.6, 0, TAU);
    ctx.fill();
    // —— 头：长面具（阶段 3 中缝裂开，红光渗出）——
    const headY = -h * .93;
    ctx.fillStyle = flick ? FL : '#efe4cf';
    ctx.beginPath();
    ctx.moveTo(0, headY - h * .1);
    ctx.quadraticCurveTo(w * .085, headY - h * .09, w * .09, headY - h * .015);
    ctx.quadraticCurveTo(w * .08, headY + h * .07, 0, headY + h * .115);
    ctx.quadraticCurveTo(-w * .08, headY + h * .07, -w * .09, headY - h * .015);
    ctx.quadraticCurveTo(-w * .085, headY - h * .09, 0, headY - h * .1);
    ctx.fill();
    ctx.strokeStyle = hexA(ac, .65);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    if (ph >= 2) crackLine(ctx, [0, headY - h * .1, w * .015, headY - h * .03, -w * .01, headY + h * .05, w * .012, headY + h * .11], 'rgba(60,30,26,.7)', 1.4);
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-w * .05, headY - h * .06);
    ctx.quadraticCurveTo(-w * .07, headY - h * .02, -w * .055, headY + h * .03);
    ctx.stroke();
    // 眼窝与红光
    ctx.fillStyle = '#120a10';
    ctx.beginPath();
    ctx.ellipse(-w * .048, headY - h * .012, w * .036, h * .015, -.38, 0, TAU);
    ctx.ellipse(w * .048, headY - h * .012, w * .036, h * .015, .38, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,95,80,.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, headY - h * .045);
    ctx.quadraticCurveTo(w * .012, headY + h * .01, 0, headY + h * .045);
    ctx.stroke();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, 0, headY, w * .18, '#ff5a4a', ph >= 1 ? .4 : .18);
    ctx.fillStyle = '#ff5a4a';
    ctx.fillRect(-w * .052, headY - h * .014, w * .018, h * .008);
    ctx.fillRect(w * .034, headY - h * .014, w * .018, h * .008);
    ctx.restore();
    // 第三只眼
    ctx.strokeStyle = hexA(ac, .8);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, headY - h * .05, w * .018, h * .008, 0, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#c84a5a';
    ctx.beginPath(); ctx.arc(0, headY - h * .05, 1.2, 0, TAU); ctx.fill();
    // 金裂嘴
    ctx.strokeStyle = ac;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-w * .045, headY + h * .048);
    ctx.quadraticCurveTo(0, headY + h * .056, w * .045, headY + h * .048);
    ctx.stroke();
    // —— 纸冠：阶段裂纹 → 缺损碎片环绕（星冠碎裂式）——
    const crownOff = ph >= 2 ? h * .01 : 0;
    ctx.fillStyle = flick ? FL : '#c9a05e';
    ctx.beginPath();
    ctx.moveTo(-w * .17, headY - h * .05 + crownOff);
    ctx.lineTo(-w * .2, headY - h * .17 + crownOff);
    ctx.lineTo(-w * .1, headY - h * .1 + crownOff);
    if (ph < 2) ctx.lineTo(-w * .03, headY - h * .19 + crownOff);
    else ctx.lineTo(-w * .03, headY - h * .11 + crownOff);
    ctx.lineTo(w * .04, headY - h * .1 + crownOff);
    if (ph < 1) ctx.lineTo(w * .13, headY - h * .18 + crownOff);
    ctx.lineTo(w * .18, headY - h * .06 + crownOff);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#8c6428';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (ph >= 1) crackLine(ctx, [-w * .06, headY - h * .06, -w * .04, headY - h * .12, -w * .07, headY - h * .16], 'rgba(60,30,20,.8)', 1.2);
    ctx.fillStyle = '#8e2a3e';
    ctx.beginPath();
    ctx.arc(0, headY - h * .115, 2.4, 0, TAU);
    ctx.fill();
    // 碎冠片环绕（阶段 ≥1）
    if (ph >= 1) {
      const nShard = ph >= 2 ? 4 : 2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < nShard; i++) {
        const a = t * 1.2 + i * TAU / nShard;
        const rx = w * .5, ry = h * .1;
        const sx2 = Math.cos(a) * rx, sy2 = -h * .62 + Math.sin(a) * ry;
        ctx.save();
        ctx.translate(sx2, sy2);
        ctx.rotate(a * 2);
        ctx.fillStyle = hexA('#c9a05e', .85);
        ctx.beginPath();
        ctx.moveTo(0, -7); ctx.lineTo(4, 0); ctx.lineTo(0, 8); ctx.lineTo(-3.4, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
    // 地面纸片
    for (let i = 0; i < 4; i++) {
      const a = t * .5 + i * 1.6;
      ctx.save();
      ctx.translate(Math.cos(a) * w * .55, -6 + Math.sin(a) * 3);
      ctx.rotate(a);
      ctx.globalAlpha = .4;
      ctx.fillStyle = '#efe4cf';
      ctx.fillRect(-5, -7, 10, 14);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

  } else if (d.draw === 'diva') {
    // —— 沉没的歌姬：长发上浮、白能面、水袖音符（阶段越高溺得越深）——
    const pale = ph >= 1;
    // —— 水袖：两条细长绸带 + 沿途音符（叙事部件）——
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const reach = w * (.52 + Math.sin(t * 1.2 + s) * .1 + ph * .06);
      const tipX = s * (reach + Math.sin(t + s) * 30);
      // 绸带：窄条填充（上缘/下缘两条曲线夹出）
      ctx.fillStyle = vg(ctx, 'diva-sleeve' + ph, 0, -h * .8, 0, 0, [0, hexA('#9fd8ff', .16), 1, hexA('#9fd8ff', 0)]);
      ctx.beginPath();
      ctx.moveTo(-s * w * .12, -h * .7);
      ctx.quadraticCurveTo(s * reach, -h * .52, tipX, -h * .14);
      ctx.quadraticCurveTo(s * reach * .82, -h * .46, s * w * .16, -h * .64);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA('#bfe8ff', .5);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-s * w * .12, -h * .7);
      ctx.quadraticCurveTo(s * reach, -h * .52, tipX, -h * .14);
      ctx.stroke();
      ctx.strokeStyle = hexA('#bfe8ff', .25);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-s * w * .12, -h * .7);
      ctx.quadraticCurveTo(s * reach * .82, -h * .46, s * w * .16, -h * .64);
      ctx.stroke();
      // 袖上音符
      ctx.fillStyle = hexA('#bfe8ff', .8);
      for (let i = 0; i < 2; i++) {
        const k2 = ((t * .35 + i * .5 + (s > 0 ? .25 : 0)) % 1);
        const nx2 = s * (w * .14 + k2 * reach * .8);
        const ny2 = -h * (.66 - k2 * .5) + Math.sin(t * 2 + i) * 6;
        ctx.beginPath();
        ctx.ellipse(nx2, ny2, 3.2, 2.2, -.4, 0, TAU);
        ctx.fill();
        ctx.fillRect(nx2 + 2.4, ny2 - 7, 1.1, 7);
      }
      ctx.restore();
    }
    // —— 身体：修长瓶形（长颈 → 窄肩 → 束腰 → 溶水的裙）——
    bodyFill(ctx, 'diva-body' + ph, -h * .9, 0, flick ? FL : (pale ? '#b8d4e6' : '#9fc4d8'), flick ? FL : '#122c42', flick);
    ctx.beginPath();
    ctx.moveTo(-w * .05, -h * .88);                       // 颈
    ctx.quadraticCurveTo(-w * .06, -h * .78, -w * .1, -h * .72);
    ctx.quadraticCurveTo(-w * .22, -h * .66, -w * .2, -h * .58); // 肩
    ctx.quadraticCurveTo(-w * .17, -h * .5, -w * .15, -h * .44); // 束腰
    ctx.quadraticCurveTo(-w * .3, -h * .26, -w * .26, -h * .1);  // 裙摆展开
    if (ph >= 2) {
      // 阶段 3：裙摆溶成水滴
      ctx.quadraticCurveTo(-w * .18, -h * .03, -w * .1, -h * .08);
      ctx.quadraticCurveTo(-w * .04, -h * .01, 0, -h * .05);
      ctx.quadraticCurveTo(w * .04, -h * .01, w * .1, -h * .08);
      ctx.quadraticCurveTo(w * .18, -h * .03, w * .26, -h * .1);
    } else {
      ctx.lineTo(-w * .08, 0);
      ctx.lineTo(w * .08, 0);
    }
    ctx.quadraticCurveTo(w * .3, -h * .26, w * .15, -h * .44);
    ctx.quadraticCurveTo(w * .17, -h * .5, w * .2, -h * .58);
    ctx.quadraticCurveTo(w * .22, -h * .66, w * .1, -h * .72);
    ctx.quadraticCurveTo(w * .06, -h * .78, w * .05, -h * .88);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = hexA('#9fd8ff', .45);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // 锁骨金线
    ctx.strokeStyle = hexA('#e8c47e', .4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-w * .07, -h * .68);
    ctx.quadraticCurveTo(0, -h * .66, w * .07, -h * .68);
    ctx.stroke();
    // 腰间水环（阶段越多环越多、越高）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hexA('#9fd8ff', .4);
    ctx.lineWidth = 1.5;
    const rings = 1 + ph;
    for (let i = 0; i < rings; i++) {
      const ry = -h * (.3 + i * .14);
      ctx.beginPath();
      ctx.ellipse(0, ry, w * (.42 + i * .06), 12, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
    // —— 长发：墨黑发丝上浮外散（溺者之发），阶段越高越散乱 ——
    ctx.strokeStyle = flick ? FL : '#0e1420';
    ctx.lineCap = 'round';
    const strands = ph >= 2 ? 8 : 6;
    for (let i = 0; i < strands; i++) {
      const s2 = (i - (strands - 1) / 2) / ((strands - 1) / 2); // -1..1
      ctx.globalAlpha = .8;
      ctx.lineWidth = 3.2 - Math.abs(s2) * .8;
      ctx.beginPath();
      ctx.moveTo(s2 * w * .05, -h * .96);
      ctx.quadraticCurveTo(
        s2 * w * (.12 + ph * .03) + Math.sin(t * .7 + i) * 10,
        -h * (1.04 + Math.abs(s2) * .05),
        s2 * w * (.2 + ph * .05) + Math.sin(t * .6 + i * 2) * (ph >= 2 ? 34 : 18),
        -h * (1.1 + Math.abs(s2) * .1 + (i % 2) * .04),
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // 发簪流苏
    ctx.strokeStyle = hexA(ac, .8);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(w * .08, -h * .98);
    ctx.lineTo(w * .16, -h * 1.04);
    ctx.stroke();
    tassel(ctx, w * .16, -h * 1.04, 10, Math.sin(t * 1.6) * 3, hexA('#e8c47e', .85));
    // —— 头：墨发底 + 白能面（阶段 3 面具中裂）——
    ctx.fillStyle = flick ? FL : '#101826';
    ctx.beginPath();
    ctx.ellipse(0, -h * .96, w * .13, h * .075, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = flick ? FL : '#f6f0e2';
    ctx.beginPath();
    ctx.moveTo(0, -h * 1.01);
    ctx.quadraticCurveTo(w * .08, -h * .99, w * .072, -h * .93);
    ctx.quadraticCurveTo(w * .06, -h * .885, 0, -h * .875);
    ctx.quadraticCurveTo(-w * .06, -h * .885, -w * .072, -h * .93);
    ctx.quadraticCurveTo(-w * .08, -h * .99, 0, -h * 1.01);
    ctx.fill();
    ctx.strokeStyle = hexA('#e8c47e', .75);
    ctx.lineWidth = 1.3;
    ctx.stroke();
    // 面具内的阴影眼窝
    ctx.fillStyle = 'rgba(20,14,26,.28)';
    ctx.beginPath();
    ctx.ellipse(-w * .036, -h * .945, w * .024, h * .014, -.25, 0, TAU);
    ctx.ellipse(w * .036, -h * .945, w * .024, h * .014, .25, 0, TAU);
    ctx.fill();
    if (ph >= 2) crackLine(ctx, [0, -h * 1.0, w * .01, -h * .95, -w * .012, -h * .89], 'rgba(70,40,36,.7)', 1.2);
    const eyeCol = ph >= 1 ? '#ff6a88' : '#66b8ea';
    slitEye(ctx, -w * .036, -h * .945, 3.2, eyeCol, { wide: .55, tall: 2, glowA: .6 });
    slitEye(ctx, w * .036, -h * .945, 3.2, eyeCol, { wide: .55, tall: 2, glowA: .6 });
    if (ph >= 2) {
      // 第三缝眼（溺亡后的和声眼）
      seamEye(ctx, 0, -h * .975, 8, eyeCol);
    }
    // 麦克风 → 沉默的话筒架（斜倚）
    ctx.strokeStyle = ac; ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(w * .2, -h * .7);
    ctx.lineTo(w * .3, -h * .92);
    ctx.stroke();
    ctx.fillStyle = ac;
    ctx.beginPath();
    ctx.arc(w * .31, -h * .94, 6, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = hexA('#9fd8ff', .5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(w * .31, -h * .94, 9, -.6 + t, 1.4 + t);
    ctx.stroke();
    // —— 阶段 3：气泡上升 ——
    if (ph >= 2) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hexA('#bfe8ff', .5);
      ctx.fillStyle = hexA('#bfe8ff', .16);
      for (let i = 0; i < 5; i++) {
        const yy = -h * (.1 + ((t * .18 + i * .23) % 1) * .95);
        const xx = Math.sin(t * 1.3 + i * 2) * w * .3;
        ctx.beginPath();
        ctx.arc(xx, yy, 2.6 + (i % 3), 0, TAU);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

  } else {
    // —— 无星之王：王座尖塔 + 胸前星渊 + 碎星冠（阶段坍缩）——
    // 身后辉光：阶段越高越亮，保证暗背景下轮廓可读
    if (ph >= 1) glow(ctx, 0, -h * .5, w * .9, ac, ph >= 2 ? .34 : .22);
    // 斗篷（底缘锯齿，阶段越高越破碎）
    bodyFill(ctx, 'st-cape' + ph, -h, 0, flick ? FL : (ph >= 2 ? '#2e2346' : '#241a38'), flick ? FL : '#0a0714', flick);
    ctx.beginPath();
    ctx.moveTo(0, -h * .92);
    ctx.quadraticCurveTo(-w * .58, -h * .55, -w * .5, -h * .1);
    ctx.lineTo(-w * .4, -h * .04);
    ctx.lineTo(-w * .3, 0);
    ctx.lineTo(-w * .16, -h * .05);
    ctx.lineTo(0, 0);
    ctx.lineTo(w * .16, -h * .05);
    ctx.lineTo(w * .3, 0);
    ctx.lineTo(w * .4, -h * .04);
    ctx.lineTo(w * .5, -h * .1);
    ctx.quadraticCurveTo(w * .58, -h * .55, 0, -h * .92);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = hexA(ac, ph >= 2 ? .75 : .4);
    ctx.lineWidth = ph >= 2 ? 1.8 : 1.3;
    ctx.stroke();
    // 王座扶手：细高尖塔
    for (const s of [-1, 1]) {
      ctx.fillStyle = flick ? FL : '#120d1c';
      ctx.beginPath();
      ctx.moveTo(s * w * .3, -h * .6);
      ctx.quadraticCurveTo(s * w * .6, -h * .5, s * w * .52, -h * .06);
      ctx.lineTo(s * w * .4, -h * .12);
      ctx.lineTo(s * w * .34, -h * .5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexA(ac, .35);
      ctx.lineWidth = 1;
      ctx.stroke();
      // 塔尖星屑
      ctx.fillStyle = ac;
      ctx.beginPath();
      ctx.arc(s * w * .48, -h * .08, 2.4, 0, TAU);
      ctx.fill();
    }
    // —— 胸前星渊（叙事部件：星座在坍缩）——
    const voidW = w * (.15 + ph * .035), voidH = h * (.19 + ph * .03);
    ctx.save();
    ctx.fillStyle = '#030208';
    ctx.beginPath();
    ctx.ellipse(0, -h * .55, voidW, voidH, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = hexA(ac, .5);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    // 星座：暗星与连线，阶段 2 起断线
    const stars = [[-.5, -.4], [.4, -.3], [-.3, .3], [.5, .35], [0, -.05]];
    const links = [[0, 4], [4, 1], [1, 3], [3, 2], [2, 0]];
    ctx.strokeStyle = hexA('#c9b8ef', .5);
    ctx.lineWidth = .9;
    for (let i = 0; i < links.length; i++) {
      if (ph >= 2 && i % 2 === 0) continue; // 星座断线
      const [a1, a2] = links[i];
      ctx.beginPath();
      ctx.moveTo(stars[a1][0] * voidW, -h * .55 + stars[a1][1] * voidH);
      ctx.lineTo(stars[a2][0] * voidW, -h * .55 + stars[a2][1] * voidH);
      ctx.stroke();
    }
    for (let i = 0; i < stars.length; i++) {
      const tw = .4 + .5 * Math.sin(t * 2 + i * 1.7);
      glow(ctx, stars[i][0] * voidW, -h * .55 + stars[i][1] * voidH, 5, '#c9b8ef', tw * .8);
    }
    // 阶段 3：渊中群缝眼
    if (ph >= 2) {
      for (let i = 0; i < 5; i++) {
        const ex = Math.sin(i * 2.4) * voidW * .6;
        const ey = -h * .55 + Math.cos(i * 1.7) * voidH * .5;
        seamEye(ctx, ex, ey, 10, '#e8c47e');
      }
    }
    ctx.restore();
    // —— 头：低垂的巨颅，双金缝瞳 ——
    ctx.fillStyle = flick ? FL : '#0b0812';
    ctx.beginPath();
    ctx.moveTo(-w * .18, -h * .98);
    ctx.quadraticCurveTo(-w * .22, -h * .86, 0, -h * .84);
    ctx.quadraticCurveTo(w * .22, -h * .86, w * .18, -h * .98);
    ctx.quadraticCurveTo(0, -h * 1.04, -w * .18, -h * .98);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = hexA(ac, .4);
    ctx.lineWidth = 1.1;
    ctx.stroke();
    slitEye(ctx, -w * .075, -h * .92, 5.4, d.eye || '#e8c47e', { wide: .55, tall: 2.2, glowA: .7 });
    slitEye(ctx, w * .075, -h * .92, 5.4, d.eye || '#e8c47e', { wide: .55, tall: 2.2, glowA: .7 });
    // —— 破碎星冠：阶段缺失 + 环绕碎片 ——
    const onCrown = [5, 4, 2][Math.min(ph, 2)];
    for (let i = 0; i < 5; i++) {
      if (i >= onCrown && ph < 3) continue;
      const a = -Math.PI * .8 + i * Math.PI * .4;
      const cx = Math.cos(a) * w * .26, cy = -h * 1.04 + Math.sin(a) * h * .05;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a + t * .2);
      ctx.fillStyle = ac;
      ctx.beginPath();
      ctx.moveTo(0, -14); ctx.lineTo(4.6, 0); ctx.lineTo(0, 11); ctx.lineTo(-4.6, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    if (ph >= 1) {
      // 脱落的冠片环绕
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const orbit = ph >= 2 ? 4 : 2;
      for (let i = 0; i < orbit; i++) {
        const a = t * 1.1 + i * TAU / orbit;
        const sx2 = Math.cos(a) * w * .46;
        const sy2 = -h * .7 + Math.sin(a) * h * .12;
        ctx.save();
        ctx.translate(sx2, sy2);
        ctx.rotate(a * 1.6);
        ctx.fillStyle = hexA(ac, .9);
        ctx.beginPath();
        ctx.moveTo(0, -9); ctx.lineTo(4.4, 0); ctx.lineTo(0, 10); ctx.lineTo(-4, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
    // 星河裂缝
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hexA(ac, .5);
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(-w * .28 + i * w * .17, -h * .8);
      ctx.quadraticCurveTo(-w * .18 + i * w * .17 + Math.sin(t + i) * 12, -h * .45, -w * .22 + i * w * .17, 0);
      ctx.stroke();
    }
    ctx.restore();
    // 悬浮星屑
    for (let i = 0; i < 8; i++) {
      const a = t * .6 + i * 1.1;
      const rr = w * (.4 + (i % 3) * .1);
      ctx.globalAlpha = .3 + .3 * Math.sin(t * 2 + i);
      ctx.fillStyle = ac;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rr, -h * .5 + Math.sin(a) * h * .3, 1.5, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function spawnBossAdd(kind, x, eliteKind) {
  const e = new Enemy(eliteKind || kind, clamp(x, 120, (G.room?.w || 1600) - 120), {});
  e.spawning = .5;
  e.spawnT = .5;
  G.enemies.push(e);
}
