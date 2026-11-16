// ============================================================
// 画布渲染：世界、实体、弹幕、特效、光影
// ============================================================
import { G } from './state.js';
import { W, H, FLOOR, EL, RANKS, FONT_SERIF } from './config.js';
import { drawWorldBack, drawWorldMid, drawWorldFront, drawZones, drawPickups } from './world.js';
import { cameraShakeOffset } from './world.js';
import { FX } from './fx.js';
import { CHAR_MAP } from './data/characters.js';
import { clamp, TAU, hexA, dist } from './utils.js';

const glowCache = new Map();
function glow(color) {
  if (glowCache.has(color)) return glowCache.get(color);
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(48, 48, 0, 48, 48, 48);
  gr.addColorStop(0, hexA(color, 1));
  gr.addColorStop(.22, hexA(color, .65));
  gr.addColorStop(.55, hexA(color, .18));
  gr.addColorStop(1, hexA(color, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, 96, 96);
  glowCache.set(color, c);
  return c;
}

export function renderGame(ctx, t) {
  ctx.clearRect(0, 0, W, H);
  if (!G.room) {
    drawEmpty(ctx, t);
    return;
  }
  const shake = G.showShake === false ? { x: 0, y: 0 } : cameraShakeOffset();
  ctx.save();
  ctx.translate(shake.x, shake.y);
  drawWorldBack(ctx, t);
  drawWorldMid(ctx, t);

  // 区域 / 掉落
  drawZones(ctx, t);
  drawPickups(ctx, t);

  // 弹幕（世界坐标）
  ctx.save();
  ctx.translate(-G.cam.x, 0);
  drawProjectiles(ctx, t);
  ctx.restore();

  // 敌人
  for (const e of G.enemies) {
    if (e.boss) e.draw(ctx, t);
    else e.draw(ctx, t);
  }
  // 玩家
  if (G.player) G.player.draw(ctx, t);

  // 特效
  ctx.save();
  ctx.translate(-G.cam.x, 0);
  FX.draw(ctx);
  ctx.restore();

  drawWorldFront(ctx, t);
  ctx.restore();

  // 黑暗领域
  if (G.bossDark > 0 && G.player) {
    const px = G.player.x - G.cam.x;
    const py = G.player.y - 100;
    const g = ctx.createRadialGradient(px, py, 70, px, py, 520);
    g.addColorStop(0, 'rgba(3,2,8,0)');
    g.addColorStop(.6, `rgba(3,2,8,${.45 * G.bossDark})`);
    g.addColorStop(1, `rgba(3,2,8,${.94 * G.bossDark})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // 低血量警示
  const m = G.run?.team[G.run.active];
  if (m && !m.downed && m.hp / m.maxHp < .35) {
    const pulse = .18 + .12 * Math.sin(t * 5);
    const g = ctx.createRadialGradient(W / 2, H / 2, H * .3, W / 2, H / 2, H * .78);
    g.addColorStop(0, 'rgba(120,10,30,0)');
    g.addColorStop(1, `rgba(120,10,30,${pulse})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // 全屏闪光
  if (G.flash) {
    const a = (G.flash.t / G.flash.max) * G.flash.alpha;
    ctx.fillStyle = hexA(G.flash.color, Math.max(0, a));
    ctx.fillRect(0, 0, W, H);
  }

  // 慢动作晕影：换演/处决的那一拍，观众席暗下去
  if (G.slowmo > 0) {
    const k = Math.min(1, G.slowmo * 2.4);
    const g = ctx.createRadialGradient(W / 2, H / 2, H * .32, W / 2, H / 2, H * .86);
    g.addColorStop(0, 'rgba(8,5,14,0)');
    g.addColorStop(1, `rgba(8,5,14,${(.32 * k).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // 高喝彩金粉
  if (G.style.rank >= 5) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 18; i++) {
      const x = ((i * 173 + t * (12 + i % 4) * 8) % (W + 40)) - 20;
      const y = ((i * 97 + t * (22 + i % 3) * 6) % (H + 40)) - 20;
      ctx.globalAlpha = .1 + .16 * Math.sin(t * 2 + i);
      ctx.fillStyle = '#ffe9b0';
      ctx.beginPath();
      ctx.arc(x, y, 1.3 + (i % 3) * .7, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // 暂停压暗
  if (G.mode === 'pause') {
    ctx.fillStyle = 'rgba(4,3,8,.35)';
    ctx.fillRect(0, 0, W, H);
  }
}

function drawEmpty(ctx, t) {
  const g = ctx.createRadialGradient(W / 2, H * .4, 20, W / 2, H * .4, W * .7);
  g.addColorStop(0, '#191126');
  g.addColorStop(1, '#050409');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawProjectiles(ctx, t) {
  for (const b of G.projectiles) {
    const a = b.angle || 0;
    const col = b.color || '#e8c47e';
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = b.life < .2 ? b.life / .2 : 1;
    const r = b.r || b.size || 10;
    // 光晕
    const gs = glow(col);
    const gsz = r * (b.type === 'wave' ? 7 : 5);
    ctx.drawImage(gs, -gsz / 2, -gsz / 2, gsz, gsz);

    if (b.type === 'arrow') {
      ctx.rotate(a);
      ctx.fillStyle = col;
      ctx.fillRect(-r * 2.4, -r * .16, r * 3.2, r * .32);
      ctx.beginPath();
      ctx.moveTo(r * .8, 0); ctx.lineTo(r * .25, -r * .5); ctx.lineTo(r * .25, r * .5);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff8e8';
      ctx.fillRect(-r * 2.2, -r * .05, r * 2.4, r * .1);
    } else if (b.type === 'bullet') {
      ctx.rotate(a);
      ctx.fillStyle = '#fff8e8';
      ctx.fillRect(-r * 1.6, -r * .18, r * 3.2, r * .36);
      ctx.fillStyle = col;
      ctx.fillRect(-r * .4, -r * .5, r * 1.2, r);
    } else if (b.type === 'star') {
      ctx.rotate(a + t * 6);
      ctx.fillStyle = col;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const aa = i * Math.PI / 4;
        const rr = i % 2 ? r * .35 : r;
        const px = Math.cos(aa) * rr, py = Math.sin(aa) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff8e8';
      ctx.beginPath(); ctx.arc(0, 0, r * .25, 0, TAU); ctx.fill();
    } else if (b.type === 'note') {
      ctx.rotate(a);
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.4, r * .16);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -r * 1.3); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(-r * .25, 0, r * .55, r * .4, -.3, 0, TAU); ctx.fillStyle = col; ctx.fill();
      ctx.beginPath(); ctx.ellipse(r * .4, -r * .2, r * .4, r * .3, -.3, 0, TAU); ctx.fill();
    } else if (b.type === 'paper') {
      ctx.rotate(a + Math.sin(t * 8 + b.x) * .3);
      ctx.fillStyle = '#efe4cf';
      ctx.fillRect(-r * .9, -r * .55, r * 1.8, r * 1.1);
      ctx.strokeStyle = 'rgba(184,48,74,.6)'; ctx.lineWidth = 1;
      ctx.strokeRect(-r * .9, -r * .55, r * 1.8, r * 1.1);
    } else if (b.type === 'bomb' || b.type === 'rocket') {
      ctx.rotate(a);
      ctx.fillStyle = '#2a1a20';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      ctx.fillStyle = '#e8c47e';
      ctx.beginPath(); ctx.arc(-r * .2, -r * .2, r * .3, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#ff9a5a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(r * .4, -r * .6); ctx.quadraticCurveTo(r * .9, -r * .9, r * .7, -r * 1.2); ctx.stroke();
      if (b.type === 'rocket') {
        ctx.fillStyle = '#ff9a5a';
        ctx.beginPath(); ctx.moveTo(-r * 1.2, 0); ctx.lineTo(-r * 2.2, -r * .5); ctx.lineTo(-r * 2.2, r * .5); ctx.closePath(); ctx.fill();
      }
    } else if (b.type === 'wave') {
      ctx.rotate(a);
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(3, r * .35);
      ctx.beginPath();
      ctx.arc(-r * .8, 0, r, -1.1, 1.1);
      ctx.stroke();
      ctx.strokeStyle = '#fff8e8';
      ctx.lineWidth = Math.max(1, r * .08);
      ctx.beginPath();
      ctx.arc(-r * .8, 0, r, -.9, .9);
      ctx.stroke();
    } else if (b.type === 'petal') {
      ctx.rotate(a + t * 3);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(0, 0, r, r * .45, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff8e8';
      ctx.beginPath(); ctx.ellipse(r * .2, 0, r * .35, r * .14, 0, 0, TAU); ctx.fill();
    } else if (b.type === 'shock') {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(3, r * .25);
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
      ctx.strokeStyle = '#fff8e8'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, r * .7, 0, TAU); ctx.stroke();
    } else if (b.type === 'string') {
      ctx.strokeStyle = col; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(-r * 2, 0); ctx.lineTo(r * 2, 0); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, 0, r * .25, 0, TAU); ctx.fill();
    } else {
      // orb
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#fff8e8'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, r * .6, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#fff8e8';
      ctx.beginPath(); ctx.arc(-r * .2, -r * .2, r * .22, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
}
