// 星降旅记 · 渲染层
// 美术参照：绘本立体书（pop-up book）—— 层叠剪纸平台、水彩底景、被星屑侵蚀的角色立绘。
import {
  W, H, FLOOR, ROOM_W, PAL, FONT, FONT_TITLE, SCENE, ICON,
  HEROES, BIOMES, BOONS, SHOP_ITEMS, META, PLAN, ELEMENTS, EL, elOf, FOES,
  tr, loc, locObj, getLang, bossStand,
} from './data.js';
import {
  G, Input, Sound, ctx, beginFrame, getImg, ready, drawImg, drawCover,
  panel, rrect, text, clamp, lerp, rnd, fmtTime,
} from './core.js';

// ---------------------------------------------------------------------------
// 通用图元
// ---------------------------------------------------------------------------
function starPath(cx, cy, r, rot = 0, inner = 0.46) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = rot + i * Math.PI / 5 - Math.PI / 2;
    const rr = i % 2 ? r * inner : r;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}
function star(cx, cy, r, color, rot = 0) { ctx.save(); starPath(cx, cy, r, rot); ctx.fillStyle = color; ctx.fill(); ctx.restore(); }
function ell(x, y, rx, ry, color) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(s, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function scrim(a = 0.42, color = '22,16,38') { ctx.fillStyle = `rgba(${color},${a})`; ctx.fillRect(0, 0, W, H); }
function hover(x, y, w, h) { const p = G.pointer; return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h; }

function uiBtn(x, y, w, h, label, action, opt = {}) {
  const { selected = false, disabled = false, sub = '', size = 17, value = undefined,
          accent = PAL.berry, align = 'center' } = opt;
  const on = (selected || hover(x, y, w, h)) && !disabled;
  ctx.save();
  if (on) { ctx.shadowColor = 'rgba(231,102,143,.55)'; ctx.shadowBlur = 16; }
  rrect(x, y, w, h, Math.min(12, h / 2));
  ctx.fillStyle = disabled ? 'rgba(210,200,190,.55)' : on ? accent : 'rgba(255,250,240,.95)';
  ctx.fill(); ctx.restore();
  rrect(x, y, w, h, Math.min(12, h / 2));
  ctx.strokeStyle = on ? accent : 'rgba(120,90,70,.4)'; ctx.lineWidth = on ? 2.5 : 1.6; ctx.stroke();
  const c = disabled ? '#a99a90' : on ? '#fffdf7' : PAL.ink;
  text(label, align === 'center' ? x + w / 2 : x + 14, y + h / 2 - (sub ? 7 : 0), size, c, align, 600);
  if (sub) text(sub, x + w / 2, y + h / 2 + 12, 11, on ? 'rgba(255,255,255,.85)' : PAL.inkSoft, 'center');
  if (on && !disabled) star(x + 12, y + h / 2, 5, 'rgba(255,255,255,.85)', G.t * 2);
  if (!disabled) Input.tapZone(x, y, w, h, () => { Sound.sfx('ui'); const f = G.actions[action]; if (f) f(value); });
}
function chip(x, y, label, color = PAL.berry, size = 12) {
  ctx.save(); ctx.font = `600 ${size}px ${FONT}`;
  const w = ctx.measureText(label).width + 18;
  rrect(x, y, w, size + 10, (size + 10) / 2); ctx.fillStyle = color; ctx.fill();
  text(label, x + w / 2, y + (size + 10) / 2, size, '#fff', 'center', 600);
  ctx.restore(); return w;
}
function bar(x, y, w, h, v, color, bg = 'rgba(80,60,50,.28)', label = '') {
  rrect(x, y, w, h, h / 2); ctx.fillStyle = bg; ctx.fill();
  const fw = Math.max(0, Math.min(1, v)) * (w - 4);
  if (fw > 0) {
    rrect(x + 2, y + 2, fw, h - 4, (h - 4) / 2);
    const g = ctx.createLinearGradient(x, y, x + w, y);
    g.addColorStop(0, color); g.addColorStop(1, 'rgba(255,255,255,.75)');
    ctx.fillStyle = g; ctx.fill();
  }
  if (label) text(label, x + w / 2, y + h / 2 + 0.5, Math.min(12, h - 4), PAL.ink, 'center', 700);
}
function iconBox(im, x, y, s, r = 10, fill = 'rgba(255,250,240,.9)') {
  rrect(x, y, s, s, r); ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = 'rgba(120,90,70,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
  if (!drawImg(im, x + 3, y + 3, s - 6, s - 6)) star(x + s / 2, y + s / 2, s / 3, PAL.gold);
}
// 属性图标（PNG，带底色圆）
function elIcon(id, x, y, r, opt = {}) {
  const e = elOf(id);
  ctx.save();
  if (opt.glow) { const g = ctx.createRadialGradient(x, y, 1, x, y, r * 2.1); g.addColorStop(0, e.color); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.globalAlpha = 0.5; ctx.fillStyle = g; ctx.fillRect(x - r * 2.2, y - r * 2.2, r * 4.4, r * 4.4); ctx.globalAlpha = 1; }
  ell(x, y, r, r, opt.dim ? 'rgba(40,32,55,.62)' : 'rgba(255,250,240,.94)');
  ctx.strokeStyle = opt.active ? PAL.gold : e.color; ctx.lineWidth = opt.active ? 3 : 2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  const im = getImg(e.icon);
  if (ready(im)) { ctx.globalAlpha = opt.dim ? 0.55 : 1; ctx.drawImage(im, x - r * 0.66, y - r * 0.66, r * 1.32, r * 1.32); }
  else text(e.name, x, y, r, e.color, 'center', 800);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 水彩底景
// ---------------------------------------------------------------------------
function bgLayer(im, camX, opt = {}) {
  ctx.fillStyle = opt.base || '#2a2440'; ctx.fillRect(0, 0, W, H);
  if (!ready(im)) return;
  const asp = im.naturalWidth / im.naturalHeight;
  const bh = H * 1.78, bw = bh * asp;
  const shift = (camX * (opt.par || 0.1)) % bw;
  let bx = -shift; if (bx > 0) bx -= bw;
  const by = (H - bh) * (opt.focus == null ? 0.5 : opt.focus);
  for (let x = bx; x < W + bw; x += bw) ctx.drawImage(im, x, by, bw, bh);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(20,15,35,.26)'); g.addColorStop(0.42, 'rgba(20,15,35,0)');
  g.addColorStop(1, 'rgba(25,16,35,.35)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (opt.tint) { ctx.fillStyle = opt.tint; ctx.fillRect(0, 0, W, H); }
}
function vignette(a = 0.35) {
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(20,12,30,${a})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

// ---------------------------------------------------------------------------
// 剪纸立体书地形
// ---------------------------------------------------------------------------
// 一段纸片：背板层 → 主体纸 → 顶面亮边 → 白裁切描边 → 纸纹
function paperSlab(x, y, w, bottom, b, opt = {}) {
  const thick = opt.thick || 15;
  ctx.save();
  // 后层（立体书叠纸）
  ctx.globalAlpha = 0.45;
  rrect(x + 8, y + 9, w, Math.max(6, bottom - y), 6);
  ctx.fillStyle = 'rgba(40,28,50,.55)'; ctx.fill();
  ctx.globalAlpha = 1;
  // 主体：纸片往下渐隐，让水彩底页透出来（绘本贴纸而非实心色块）
  const g = ctx.createLinearGradient(0, y, 0, bottom);
  g.addColorStop(0, opt.paper || b.paper);
  g.addColorStop(0.05, b.ground);
  g.addColorStop(0.28, withAlpha(b.ground2, 0.82));
  g.addColorStop(0.72, withAlpha(b.ground2, 0.5));
  g.addColorStop(1, withAlpha(b.ground2, 0.16));
  rrect(x, y + thick, w, Math.max(4, bottom - y - thick), 5);
  ctx.fillStyle = g; ctx.fill();
  // 厚度侧面
  ctx.fillStyle = 'rgba(60,42,34,.55)';
  ctx.fillRect(x + 3, y + 4, w - 6, thick);
  // 顶面亮纸带
  ctx.fillStyle = opt.paper || b.paper;
  ctx.fillRect(x, y, w, 8);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fillRect(x, y, w, 2.5);
  // 白裁切描边
  ctx.strokeStyle = 'rgba(255,252,242,.92)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(x, y + 0.5); ctx.lineTo(x + w, y + 0.5); ctx.stroke();
  // 纸纹只出现在纸片上半部，下半部渐隐区保持干净
  ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 1;
  for (let yy = y + 26; yy < Math.min(bottom, y + 130); yy += 22) {
    const off = ((yy * 7) % 31);
    ctx.beginPath(); ctx.moveTo(x + 8 + off, yy); ctx.lineTo(x + w - 12 - off * 0.4, yy); ctx.stroke();
  }
  // 左右裁切边
  ctx.strokeStyle = 'rgba(255,252,242,.75)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, bottom); ctx.moveTo(x + w - 1, y); ctx.lineTo(x + w - 1, bottom); ctx.stroke();
  ctx.restore();
}
function pitPaper(x0, x1, yTop, b) {
  if (x1 <= x0) return;
  const w = x1 - x0;
  // 夜空渐层：上方与纸片柔和衔接，越往下越深
  const g = ctx.createLinearGradient(0, yTop - 30, 0, H);
  g.addColorStop(0, 'rgba(32,22,62,.05)');
  g.addColorStop(0.18, 'rgba(38,26,76,.72)');
  g.addColorStop(0.55, '#241a52');
  g.addColorStop(1, '#0e0a26');
  ctx.fillStyle = g; ctx.fillRect(x0, yTop - 30, w, H - yTop + 30);
  // 两侧垂直撕纸边，掩盖生硬的直角
  ctx.save();
  for (const [edge, sgn] of [[x0, 1], [x1, -1]]) {
    ctx.beginPath(); ctx.moveTo(edge, yTop - 30);
    for (let y = yTop - 30; y < H; y += 11) ctx.lineTo(edge + sgn * (2 + Math.abs(Math.sin(y * 0.23 + edge)) * 5), y);
    ctx.lineTo(edge, H); ctx.closePath();
    ctx.fillStyle = 'rgba(255,250,240,.22)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,250,240,.5)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.restore();
  // 顶部雾
  const fog = ctx.createLinearGradient(0, yTop - 30, 0, yTop + 70);
  fog.addColorStop(0, 'rgba(180,150,220,0)'); fog.addColorStop(1, 'rgba(120,90,190,.16)');
  ctx.fillStyle = fog; ctx.fillRect(x0, yTop - 30, w, 100);
  // 星海
  ctx.save(); ctx.beginPath(); ctx.rect(x0, yTop - 20, w, H - yTop + 20); ctx.clip();
  for (let i = 0; i < 42; i++) {
    const sx = x0 + ((i * 53 + Math.sin(G.t * 0.3 + i) * 11) % w + w) % w;
    const sy = yTop + 8 + ((i * 47 + G.t * (6 + i % 3 * 3)) % (H - yTop + 30));
    const a = 0.3 + 0.45 * Math.sin(G.t * 2 + i);
    star(sx, sy, i % 5 === 0 ? 2.8 : 1.4, `rgba(255,238,190,${a})`, G.t + i);
  }
  ctx.restore();
}
function drawTerrain(b, camX) {
  const t = G.terrain;
  if (!t) { // 兜底平地
    paperSlab(0, FLOOR, ROOM_W, H + 40, b);
    return;
  }
  // 1) 坑（星海）先画，位于地面之后
  let prevEnd = 0;
  for (const g of t.ground) {
    if (g.x > prevEnd) pitPaper(prevEnd, g.x, Math.min(g.y, prevEnd ? FLOOR : g.y), b);
    prevEnd = Math.max(prevEnd, g.x + g.w);
  }
  if (prevEnd < ROOM_W) pitPaper(prevEnd, ROOM_W, FLOOR, b);
  // 2) 地面剪纸段
  for (const g of t.ground) paperSlab(g.x, g.y, g.w, H + 40, b);
  // 3) 地面上的草花（世界坐标）
  ctx.save(); ctx.translate(-camX, 0);
  const x0 = Math.floor(camX / 44) * 44;
  for (let wx = x0; wx < camX + W + 44; wx += 44) {
    const gy = (function () { for (const g of t.ground) if (wx >= g.x && wx <= g.x + g.w) return g.y; return null; })();
    if (gy == null) continue;
    const n = Math.abs(Math.sin(wx * 12.9898)) % 1, h = 5 + n * 9;
    ctx.strokeStyle = 'rgba(255,255,255,.42)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(wx + 8, gy + 2); ctx.lineTo(wx + 6, gy + 2 - h);
    ctx.moveTo(wx + 13, gy + 2); ctx.lineTo(wx + 16, gy + 2 - h * 0.8); ctx.stroke();
    if (n > 0.72) {
      const fx = wx + 22, fy = gy - 3 - n * 8;
      for (let k = 0; k < 5; k++) ell(fx + Math.cos(k * 1.26) * 4, fy + Math.sin(k * 1.26) * 4, 2.6, 2.6, 'rgba(255,250,240,.92)');
      ell(fx, fy, 2, 2, PAL.gold);
    }
  }
  ctx.restore();
  // 4) 剪纸平台
  for (const p of t.plats) {
    if (p.broken) continue;
    const px = p.x, py = p.y;
    ctx.save();
    if (p.kind === 'fragile' && p.breakT > 0) { ctx.translate(rnd(-2, 2), rnd(-2, 2)); ctx.globalAlpha = 0.55 + 0.45 * (p.breakT / 0.6); }
    // 背板
    ctx.globalAlpha *= 0.5; rrect(px + 6, py + 8, p.w, 18, 6); ctx.fillStyle = 'rgba(35,24,50,.6)'; ctx.fill();
    ctx.globalAlpha = p.kind === 'fragile' && p.breakT > 0 ? 0.7 : 1;
    // 纸片：米白纸色，与下方渐隐的地面明确分层
    const g = ctx.createLinearGradient(0, py, 0, py + 22);
    g.addColorStop(0, '#fffdf4'); g.addColorStop(0.5, '#f6ead6'); g.addColorStop(1, withAlpha(b.paper, 0.9));
    rrect(px, py + 6, p.w, 16, 5); ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = 'rgba(255,253,244,.98)'; ctx.fillRect(px, py + 3, p.w, 5);
    ctx.strokeStyle = 'rgba(255,252,242,.95)'; ctx.lineWidth = 2.2;
    rrect(px, py + 6, p.w, 16, 5); ctx.stroke();
    // 卷起的一角，强化「剪纸」质感
    ctx.save(); ctx.beginPath();
    ctx.moveTo(px + p.w - 14, py + 22); ctx.quadraticCurveTo(px + p.w, py + 18, px + p.w - 2, py + 30);
    ctx.closePath(); ctx.fillStyle = 'rgba(210,190,165,.85)'; ctx.fill(); ctx.restore();
    // 纸撑 / 星轨
    if (p.kind === 'moving') {
      ctx.setLineDash([5, 6]); ctx.strokeStyle = 'rgba(255,236,180,.55)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p.ox - p.amp, py + 27); ctx.lineTo(p.ox + p.w + p.amp, py + 27); ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = 'rgba(255,252,242,.4)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px + 14, py + 20); ctx.lineTo(px + 9, py + 40);
      ctx.moveTo(px + p.w - 14, py + 20); ctx.lineTo(px + p.w - 9, py + 40); ctx.stroke();
    }
    if (p.kind === 'fragile') {
      ctx.strokeStyle = 'rgba(90,60,50,.6)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(px + p.w * 0.35, py + 6); ctx.lineTo(px + p.w * 0.45, py + 13);
      ctx.lineTo(px + p.w * 0.38, py + 20); ctx.moveTo(px + p.w * 0.68, py + 6);
      ctx.lineTo(px + p.w * 0.6, py + 14); ctx.stroke();
    }
    if (p.kind === 'solid') { paperSlab(px, py, p.w, py + 26, b, { thick: 9 }); }
    ctx.restore();
  }
  // 5) 尖刺（剪纸锯齿）
  for (const s of t.spikes) {
    ctx.save();
    const n = Math.max(2, Math.floor(s.w / 14));
    ctx.beginPath(); ctx.moveTo(s.x, s.y);
    for (let i = 0; i < n; i++) { ctx.lineTo(s.x + (i + 0.5) * s.w / n, s.y - 16); ctx.lineTo(s.x + (i + 1) * s.w / n, s.y); }
    ctx.closePath(); ctx.fillStyle = '#e9dcc8'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,252,242,.95)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }
  // 6) 机关
  for (const pr of t.props) {
    if (!pr.alive) continue;
    ctx.save();
    const bob = Math.sin(G.t * 3 + pr.id) * 2;
    if (pr.kind === 'lamp') {
      const g = ctx.createRadialGradient(pr.x, pr.y + bob, 2, pr.x, pr.y + bob, 34);
      g.addColorStop(0, 'rgba(255,225,140,.7)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(pr.x - 36, pr.y + bob - 36, 72, 72);
      drawImg(getImg(ICON.lamp), pr.x - 16, pr.y - 16 + bob, 32, 32);
    } else if (pr.kind === 'barrel') {
      ell(pr.x, pr.y + 2, 17, 5, 'rgba(40,30,25,.22)');
      drawImg(getImg(ICON.barrel), pr.x - 18, pr.y - 34 + bob, 36, 36);
      star(pr.x + 10, pr.y - 34 + bob, 3.5, PAL.gold, G.t * 6);
    } else if (pr.kind === 'spring') {
      ell(pr.x, pr.y + 1, 20, 6, 'rgba(40,30,25,.2)');
      for (let i = 0; i < 5; i++) { const a = i * Math.PI / 2.5 + G.t; ell(pr.x + Math.cos(a) * 11, pr.y - 12 + Math.sin(a) * 5, 6, 5, 'rgba(255,250,240,.9)'); }
      drawImg(getImg(ICON.spring), pr.x - 12, pr.y - 25 + bob, 24, 24);
    }
    ctx.restore();
  }
  // 7) 前景飘落纸屑
  for (let i = 0; i < 18; i++) {
    const px = ((i * 137 + G.t * (16 + i % 4 * 8) - camX * 1.2) % (W + 60) + W + 60) % (W + 60) - 30;
    const py = 50 + ((i * 83 + G.t * (12 + i % 5 * 4)) % (H - 50));
    ctx.save(); ctx.translate(px, py); ctx.rotate(G.t * 0.8 + i);
    ctx.fillStyle = i % 3 ? 'rgba(255,248,225,.5)' : 'rgba(255,190,210,.5)';
    ctx.fillRect(-3, -1.5, 6, 3); ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// 立绘绘制（玩家 / 首领 / 敌人共用）
// ---------------------------------------------------------------------------
function artDraw(im, x, feet, h, faceDir, opt = {}) {
  const asp = ready(im) ? im.naturalWidth / im.naturalHeight : 0.36;
  const w = h * asp;
  ctx.save();
  ctx.translate(x, feet);
  ctx.rotate(opt.tilt || 0);
  ctx.scale(faceDir * (opt.sx || 1), opt.sy || 1);
  if (opt.alpha != null) ctx.globalAlpha = opt.alpha;
  if (opt.filter) ctx.filter = opt.filter;
  if (ready(im)) ctx.drawImage(im, -w / 2, -h, w, h);
  else { rrect(-w / 2, -h, w, h, 14); ctx.fillStyle = PAL.berry; ctx.fill(); star(0, -h * 0.62, 12, PAL.gold); }
  ctx.restore();
}
function drawPlayer() {
  const P = G.P; if (!P) return;
  const hero = HEROES[G.hero], im = getImg(hero.stand);
  // 冲刺残影
  for (const t of G.trails) {
    if (t.life <= 0) continue;
    const asp = ready(im) ? im.naturalWidth / im.naturalHeight : 0.36;
    const h = 104, w = h * asp;
    ctx.save(); ctx.globalAlpha = 0.2 * (t.life / t.max);
    if (ready(im)) ctx.drawImage(im, t.x - w / 2, t.y - h, w, h);
    ctx.restore();
  }
  const bob = Math.sin(G.t * 9) * (P.ground && Math.abs(P.vx) > 0.4 ? 2.2 : 0.9);
  const h = 104 + bob;
  const blink = P.inv > 0 && Math.floor(G.t * 22) % 2 === 0;
  const el = elOf(G.element);
  // 属性光环
  ctx.save(); ctx.globalAlpha = 0.5 + 0.2 * Math.sin(G.t * 4);
  const g = ctx.createRadialGradient(P.x, P.y - 48, 4, P.x, P.y - 48, 62);
  g.addColorStop(0, el.color + '88'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(P.x - 64, P.y - 112, 128, 128); ctx.restore();
  ell(P.x, P.y + 2, 26, 6, 'rgba(40,30,25,.24)');
  if (P.orbit) {
    ctx.save();
    for (let i = 0; i < 3; i++) { const a = G.t * 2.4 + i * 2.09; star(P.x + Math.cos(a) * 46, P.y - 48 + Math.sin(a) * 22, 7, el.color, a); }
    ctx.restore();
  }
  let filter = null;
  if (P.flash > 0) filter = 'brightness(2.2) saturate(.4)';
  else if (P.dive > 0) filter = 'brightness(1.15) contrast(1.2)';
  artDraw(im, P.x, P.y, h, P.face, {
    alpha: blink ? 0.42 : 1, sx: P.squashX, sy: P.squashY, tilt: P.tilt, filter,
  });
  // 护盾
  if (P.shield > 0) {
    ctx.save(); ctx.strokeStyle = 'rgba(140,215,255,.85)'; ctx.lineWidth = 3;
    ctx.globalAlpha = 0.6 + 0.3 * Math.sin(G.t * 6);
    ctx.beginPath(); ctx.ellipse(P.x, P.y - 52, 38, 60, 0, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < P.shield; i++) star(P.x - 20 + i * 14, P.y - 112, 5, PAL.sky, G.t);
    ctx.restore();
  }
  // 挥击弧（三段形态不同）
  if (P.slashT > 0) {
    const a = P.slashT / 0.2, step = P.slashStep || 0;
    ctx.save(); ctx.translate(P.x, P.y - 46); ctx.scale(P.face, 1);
    ctx.globalAlpha = a * 0.92;
    ctx.strokeStyle = el.soft; ctx.lineWidth = 9 * a + 2; ctx.lineCap = 'round';
    if (step === 2) { // 上挑
      ctx.beginPath(); ctx.arc(0, 8, 52, -2.3, 0.2); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * a + 1;
      ctx.beginPath(); ctx.arc(0, 8, 58, -2.2, 0.1); ctx.stroke();
    } else {
      const dir = step === 1 ? -1 : 1;
      ctx.beginPath(); ctx.arc(0, 0, 50, dir > 0 ? -1.0 : 2.1, dir > 0 ? 0.9 : 4.2); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * a + 1;
      ctx.beginPath(); ctx.arc(0, 0, 56, dir > 0 ? -0.85 : 2.25, dir > 0 ? 0.75 : 4.05); ctx.stroke();
    }
    for (let i = 0; i < 5; i++) star(26 + i * 10, -30 + i * 14, 5 * a + 2, el.color, G.t * 4);
    ctx.restore();
  }
  // 下砸冲击特效
  if (P.dive > 0) {
    ctx.save(); ctx.globalAlpha = 0.6;
    ctx.strokeStyle = el.color; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(P.x - P.vx * 2, P.y - 90); ctx.lineTo(P.x, P.y - 20); ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// 敌人：透明立绘 + 属性染色 + 状态动画（取代圆球）
// ---------------------------------------------------------------------------
function drawFoe(e) {
  const d = FOES[e.type], el = elOf(e.element);
  const bob = e.kind === 'fly' ? Math.sin(e.t * 3 + e.seed) * 6 : Math.sin(e.t * 4 + e.seed) * 2;
  const dh = d.drawH;                       // 不再二次缩放，保证立绘细节可见
  const cy = e.y - dh / 2 + bob;            // 视觉中心：立绘脚底正好落在 e.y
  // 影子
  if (e.kind !== 'fly') ell(e.x, e.y + 2, dh * 0.19, 5, 'rgba(35,25,40,.28)');
  // 剪纸衬底：浅色花瓣底 + 属性描边，让角色从水彩背景里跳出来
  ctx.save();
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + G.t * 0.18;
    ell(e.x + Math.cos(a) * dh * 0.24, cy - dh * 0.04 + Math.sin(a) * dh * 0.3,
        dh * 0.26, dh * 0.22, 'rgba(255,248,230,.42)');
  }
  ell(e.x, cy - dh * 0.04, dh * 0.34, dh * 0.46, 'rgba(255,248,230,.34)');
  ctx.strokeStyle = withAlpha(el.color, 0.75); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(e.x, cy - dh * 0.04, dh * 0.34, dh * 0.46, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // 属性光晕
  ctx.save();
  const g = ctx.createRadialGradient(e.x, cy, 2, e.x, cy, dh * 0.68);
  g.addColorStop(0, el.color + '55'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = e.flash > 0 ? 0.9 : 0.45;
  ctx.fillStyle = g; ctx.fillRect(e.x - dh, cy - dh, dh * 2, dh * 2);
  ctx.restore();
  // 冻结 / 灼烧 / 眩晕 状态
  if (e.frozen > 0) {
    ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = '#bfe6ff';
    rrect(e.x - dh * 0.24, cy - dh * 0.55, dh * 0.48, dh * 0.9, 10); ctx.fill();
    for (let i = 0; i < 4; i++) star(e.x + Math.cos(i * 1.6) * dh * 0.2, cy + Math.sin(i * 1.6) * dh * 0.3, 3, '#fff', G.t + i);
    ctx.restore();
  }
  if (e.burn > 0 && Math.floor(G.t * 14) % 2 === 0) star(e.x + rnd(-10, 10), cy - dh * 0.3, 4, '#ff9a4a', G.t * 3);
  // 立绘本体：只做轻微侵蚀，保留原画色彩与细节
  let filter = `brightness(.93) saturate(1.08) contrast(1.04) drop-shadow(0 0 6px ${el.color})`;
  if (e.flash > 0) filter = 'brightness(2.4) saturate(.3)';
  if (e.frozen > 0) filter = 'brightness(1.05) saturate(.55) hue-rotate(165deg)';
  const tilt = (e.stun > 0 ? Math.sin(G.t * 30) * 0.08 : 0) + clamp((e.vx || 0) * 0.02, -0.14, 0.14) + (e.attackT > 0 ? 0.18 * (e.face || 1) : 0);
  if (d.icon) {
    // 炮台 / 星灯花：剪纸花瓣 + 道具图标
    ctx.save(); ctx.translate(e.x, cy); ctx.rotate(Math.sin(G.t * 1.4 + e.seed) * 0.08);
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + G.t * 0.35; ell(Math.cos(a) * 18, Math.sin(a) * 13, 11, 8, 'rgba(255,250,240,.9)'); }
    elIcon(e.element, 0, 0, 15, { glow: true });
    // 一对眼睛，让机关怪看起来是活的
    ell(-5, 2, 2.2, 3, '#4a372c'); ell(5, 2, 2.2, 3, '#4a372c');
    ctx.strokeStyle = '#4a372c'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 6, 2.5, 0, Math.PI); ctx.stroke();
    ctx.restore();
  } else {
    artDraw(getImg(d.art), e.x, e.y + bob, dh, e.face || -1, { filter, tilt, sx: 1 + (e.attackT > 0 ? 0.08 : 0) });
  }
  // 飞行星尘尾
  if (e.kind === 'fly') {
    ctx.save(); ctx.globalAlpha = 0.6;
    for (let i = 0; i < 3; i++) star(e.x - (e.face || -1) * (16 + i * 12), cy + Math.sin(G.t * 5 + i) * 8, 3 - i * 0.6, el.soft, G.t * 3);
    ctx.restore();
  }
  // 常驻固有属性角标 —— 玩家据此规划用哪个属性去触发反应
  const tagY = cy - dh * 0.62 - 12;
  elIcon(e.element, e.x - 15, tagY, 8, { dim: true });
  if (e.soak) {
    text('→', e.x - 3, tagY, 11, 'rgba(255,255,255,.85)', 'center', 700);
    elIcon(e.soak, e.x + 13, tagY, 11, { glow: true });
    if (e.soakStacks > 1) text('×' + e.soakStacks, e.x + 27, tagY + 1, 10, '#fff', 'left', 800);
  }
  // 血条
  if (e.hp < e.maxhp && !e.dead) {
    const bw = Math.max(34, d.drawH * 0.5);
    bar(e.x - bw / 2, cy - dh * 0.66 - 26, bw, 5, e.hp / e.maxhp, el.color);
  }
  // 眩晕星
  if (e.stun > 0) { for (let i = 0; i < 2; i++) { const a = G.t * 6 + i * Math.PI; star(e.x + Math.cos(a) * 16, cy - dh * 0.6 + Math.sin(a) * 5, 3.5, PAL.gold, a); } }
}

function drawBossEntity() {
  const b = G.boss; if (!b || b.dead) return;
  const im = getImg(bossStand(b.biome.boss)), el = elOf(b.biome.bossEl);
  const h = 232 + Math.sin(G.t * 2) * 6;
  ctx.save(); ctx.translate(b.x, FLOOR - 4);
  ctx.globalAlpha = 0.5 + 0.14 * Math.sin(G.t * 3);
  ctx.strokeStyle = el.color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(0, -4, 100, 23, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(0, -4, 72, 15, 0, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 8; i++) { const a = G.t * 0.7 + i * Math.PI / 4; star(Math.cos(a) * 92, -4 + Math.sin(a) * 21, 6, el.color, a); }
  ctx.restore();
  ell(b.x, FLOOR - 2, 48, 8, 'rgba(35,25,40,.3)');
  let filter = 'brightness(.72) saturate(.9) drop-shadow(0 0 16px ' + el.color + ')';
  if (b.flash > 0) filter = 'brightness(2.2)';
  artDraw(im, b.x, FLOOR - 6, h, b.face, { filter, tilt: Math.sin(G.t * 1.5) * 0.02 });
  const cy = FLOOR - h - 8;
  for (let i = -2; i <= 2; i++) star(b.x + i * 15, cy + Math.abs(i) * 4, 7, PAL.gold, G.t * 1.5);
  if (b.soak) elIcon(b.soak, b.x + 56, FLOOR - h + 18, 13, { glow: true });
  // 预警圈
  for (const z of G.zones) {
    if (z.kind !== 'warn') continue;
    ctx.save(); ctx.globalAlpha = 0.4 + 0.35 * Math.sin(G.t * 18);
    ctx.strokeStyle = PAL.red; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(z.x, z.y || FLOOR - 2, z.w / 2, 13, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// 子弹 / 拾取 / 粒子 / 文字
// ---------------------------------------------------------------------------
function drawShots() {
  for (const s of G.shots) {
    const el = elOf(s.element);
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(G.t * 9 + s.seed);
    ctx.globalAlpha = 0.5; ell(-s.vx * 0.03, 0, 17, 6, el.color); ctx.globalAlpha = 1;
    if (!drawImg(getImg(ICON.star), -13, -13, 26, 26)) star(0, 0, 9, el.color, G.t * 5);
    ctx.globalAlpha = 0.75; star(0, 0, 5, el.soft, -G.t * 6);
    ctx.restore();
  }
  for (const s of G.eshots) {
    const el = elOf(s.element || 'moon');
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(G.t * 6);
    ell(0, 0, s.r + 4, s.r + 4, el.color + '44');
    star(0, 0, s.r, el.color, G.t * 3); ctx.restore();
  }
}
function drawPickups() {
  for (const p of G.pickups) {
    const yy = p.y + Math.sin(G.t * 4 + p.seed) * 3;
    ctx.save();
    const g = ctx.createRadialGradient(p.x, yy, 2, p.x, yy, 26);
    g.addColorStop(0, p.glow || 'rgba(255,225,140,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(p.x - 28, yy - 28, 56, 56); ctx.restore();
    if (p.im) drawImg(getImg(p.im), p.x - 17, yy - 17, 34, 34);
    else star(p.x, yy, 12, PAL.gold, G.t * 2);
    if (p.label) text(p.label, p.x, yy - 28, 11, '#fff', 'center', 700);
  }
}
function drawParticles() {
  for (const p of G.parts) {
    const a = clamp(p.life / p.max, 0, 1);
    ctx.save(); ctx.globalAlpha = a;
    if (p.kind === 'star') star(p.x, p.y, p.r * a + 1, p.color, G.t * 4);
    else if (p.kind === 'ring') { ctx.strokeStyle = p.color; ctx.lineWidth = 3 * a + 1; ctx.beginPath(); ctx.arc(p.x, p.y, (1 - a) * p.r + 4, 0, Math.PI * 2); ctx.stroke(); }
    else if (p.kind === 'petal') { ctx.translate(p.x, p.y); ctx.rotate(G.t * 3 + p.r); ctx.fillStyle = p.color; ctx.fillRect(-5, -2, 10, 4); }
    else ell(p.x, p.y, p.r * a + 0.5, p.r * a + 0.5, p.color);
    ctx.restore();
  }
}
function drawTexts() {
  for (const t of G.texts) {
    const a = clamp(t.life / t.max, 0, 1);
    ctx.save(); ctx.globalAlpha = a;
    text(t.s, t.x, t.y - (1 - a) * 26, t.size, '#fff', 'center', 800);
    text(t.s, t.x, t.y - (1 - a) * 26 + 1.5, t.size - 1, t.color, 'center', 800);
    ctx.restore();
  }
}
function drawDoors() {
  const r = G.room; if (!r) return;
  for (const d of r.doors) {
    const x = d.x, h = 116, y = (d.y || FLOOR) - h;
    ctx.save();
    rrect(x - 32, y, 64, h, 30);
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, d.risk ? 'rgba(190,80,110,.9)' : 'rgba(120,160,200,.9)');
    g.addColorStop(1, 'rgba(60,45,80,.95)');
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = d.risk ? PAL.berry : PAL.sky; ctx.lineWidth = 3; ctx.stroke();
    ctx.globalAlpha = 0.35 + 0.2 * Math.sin(G.t * 3);
    rrect(x - 24, y + 10, 48, h - 14, 22); ctx.fillStyle = d.risk ? '#ffd0dd' : '#dff2ff'; ctx.fill();
    ctx.restore();
    star(x, y + 34, 11, '#fff', G.t);
    text(d.risk ? tr('door.risk') : tr('door.safe'), x, y - 16, 13, '#fff', 'center', 700);
    text(d.risk ? tr('door.riskSub') : tr('door.safeSub'), x, y - 34, 10, 'rgba(255,255,255,.8)', 'center');
    if (d.near) text('↑ / E', x, (d.y || FLOOR) + 20, 12, PAL.gold, 'center', 700);
  }
}

// ---------------------------------------------------------------------------
// HUD：属性轮盘 / 反应计数
// ---------------------------------------------------------------------------
function drawElementWheel() {
  const y = H - 36, gap = 44, x0 = W / 2 - (ELEMENTS.length - 1) * gap / 2;
  const cur = elOf(G.element);
  // 不透明底板：像绘本页底部的机关槽，避免与地形混在一起
  ctx.save();
  rrect(x0 - 34, y - 30, (ELEMENTS.length - 1) * gap + 68, 60, 30);
  ctx.fillStyle = 'rgba(26,18,44,.92)'; ctx.fill(); ctx.restore();
  rrect(x0 - 34, y - 30, (ELEMENTS.length - 1) * gap + 68, 60, 30);
  ctx.strokeStyle = 'rgba(242,181,60,.6)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = 'rgba(242,181,60,.75)'; ctx.fillRect(x0 - 20, y - 30, (ELEMENTS.length - 1) * gap + 40, 2);
  ELEMENTS.forEach((e, i) => {
    const x = x0 + i * gap, active = e.id === G.element;
    const r = active ? 17 : 12;
    elIcon(e.id, x, y, r, { active, glow: active, dim: !active });
    if (active) {
      ctx.save(); ctx.globalAlpha = 0.6 + 0.3 * Math.sin(G.t * 5);
      ctx.strokeStyle = PAL.gold; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    text(String(i + 1), x, y + 24, 9, 'rgba(255,255,255,.7)', 'center', 700);
  });
  rrect(W / 2 - 58, y - 54, 116, 21, 10); ctx.fillStyle = 'rgba(26,18,44,.88)'; ctx.fill();
  text(loc(cur.name + ' · ' + cur.en, cur.en), W / 2, y - 43, 12, cur.soft, 'center', 700);
  text('Q / 1–6  ' + tr('hud.element'), W / 2 + 196, y - 6, 10, 'rgba(255,255,255,.65)', 'center', 600);
}
function drawHUD() {
  const P = G.P, r = G.room; if (!P) return;
  const hero = HEROES[G.hero];
  iconBox(getImg(hero.face), 14, 12, 56, 12);
  bar(80, 15, 224, 17, P.hp / P.maxhp, PAL.berry, 'rgba(70,45,55,.45)', `${Math.ceil(P.hp)} / ${P.maxhp}`);
  text(tr('hud.hp'), 84, 8, 9, 'rgba(255,255,255,.85)', 'left', 700);
  bar(80, 37, 224, 12, P.nova / P.novaMax, PAL.gold, 'rgba(70,45,55,.45)');
  text(tr('hud.nova'), 84, 55, 9, 'rgba(255,255,255,.85)', 'left', 700);
  for (let i = 0; i < Math.max(P.shield, P.shieldMax); i++) star(316 + i * 15, 44, 6, i < P.shield ? PAL.sky : 'rgba(255,255,255,.28)', G.t);
  drawImg(getImg(ICON.coin), 80, 62, 22, 22);
  text(String(Math.floor(P.coin)), 108, 73, 14, '#fff', 'left', 700);

  const b = BIOMES[G.run ? G.run.biome : 0];
  text(b.sub, 480, 14, 10, 'rgba(255,255,255,.75)', 'center', 600);
  text(b.name, 480, 32, 17, '#fff', 'center', 700, FONT_TITLE);
  if (r) {
    const n = PLAN.length;
    for (let i = 0; i < n; i++) {
      const x = 480 - (n - 1) * 11 + i * 22;
      const done = i < G.run.idx, cur = i === G.run.idx;
      ell(x, 52, cur ? 5.5 : 4, cur ? 5.5 : 4, done ? PAL.gold : cur ? '#fff' : 'rgba(255,255,255,.35)');
      if (PLAN[i] === 'boss') star(x, 52, 4, done ? '#fff' : 'rgba(255,255,255,.6)', 0);
    }
  }
  if (r && r.doors.length && r.cleared) text('→ ' + tr('door.go'), 480, 74, 12, PAL.goldSoft, 'center', 700);

  text(`${tr('hud.kills')} ${G.run ? G.run.kills : 0}`, 946, 18, 12, '#fff', 'right', 700);
  text(fmtTime(G.run ? G.run.time : 0), 946, 38, 12, 'rgba(255,255,255,.8)', 'right', 600);
  text(`${tr('hud.reaction')} ${G.reactions}`, 946, 58, 11, PAL.goldSoft, 'right', 700);

  if (G.combo > 1 && G.comboT > 0) {
    ctx.save(); ctx.globalAlpha = clamp(G.comboT, 0, 1);
    text(`${G.combo}`, 900, 150, 44, PAL.gold, 'center', 800, FONT_TITLE);
    text(tr('hud.combo'), 900, 182, 12, '#fff', 'center', 700); ctx.restore();
  }
  if (P.boons && P.boons.length) {
    const list = P.boons.slice(-6);
    text(`${tr('hud.boons')} ×${P.boons.length}`, 946, H - 30 - list.length * 17, 10, 'rgba(255,255,255,.8)', 'right', 700);
    list.forEach((bn, i) => { const bo = BOONS.find(x => x.id === bn); text('✦ ' + (bo ? locObj(bo) : bn), 946, H - 14 - (list.length - 1 - i) * 17, 11, '#fff', 'right', 600); });
  }
  if (G.boss && !G.boss.dead) {
    const bb = G.boss;
    text(bb.biome.bossName || tr('boss.name'), 480, H - 116, 14, '#fff', 'center', 700, FONT_TITLE);
    bar(250, H - 106, 460, 16, bb.hp / bb.maxhp, PAL.berry, 'rgba(40,25,45,.7)');
    text(`${Math.ceil(bb.hp)} / ${bb.maxhp}`, 480, H - 98, 11, '#fff', 'center', 700);
  }
  drawElementWheel();
  if (!G.touch) text(tr('hint.controls'), 14, H - 14, 10, 'rgba(255,255,255,.65)', 'left', 500);
}
function drawReactBanner() {
  const r = G.reactBanner; if (!r) return;
  const a = clamp(r.t / r.max, 0, 1), pop = r.t > r.max - 0.16 ? (r.t - (r.max - 0.16)) / 0.16 : 1;
  ctx.save(); ctx.globalAlpha = Math.min(1, a * 2) * (0.85 + 0.15 * Math.sin(G.t * 18));
  ctx.translate(480, 162 + (1 - pop) * -14);
  ctx.scale(1 + (1 - pop) * 0.18, 1 + (1 - pop) * 0.18);
  text(r.name, 0, 0, 34, r.color, 'center', 800, FONT_TITLE);
  text(r.en, 0, 28, 12, 'rgba(255,255,255,.85)', 'center', 700);
  if (r.chain > 1) { chip(52, -14, 'CHAIN ×' + r.chain, PAL.berry, 13); }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 触摸按钮
// ---------------------------------------------------------------------------
function touchBtn(x, y, r, label, code, hold) {
  ctx.save();
  const down = Input.touchHeld.has(code) || (G.pointer.x > x - r && G.pointer.x < x + r && G.pointer.y > y - r && G.pointer.y < y + r);
  ell(x, y, r, r, down ? 'rgba(231,102,143,.9)' : 'rgba(30,22,48,.62)');
  ctx.strokeStyle = 'rgba(255,250,240,.9)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  text(label, x, y, 13, '#fff', 'center', 700); ctx.restore();
  Input.tapZone(x - r - 4, y - r - 4, r * 2 + 8, r * 2 + 8, () => Input.touchPress(code, hold));
}
function drawTouch() {
  if (!G.touch) return;
  touchBtn(58, H - 58, 28, '◀', 'ArrowLeft', true);
  touchBtn(124, H - 58, 28, '▶', 'ArrowRight', true);
  touchBtn(58, H - 122, 24, '▼', 'ArrowDown', false);
  touchBtn(W - 62, H - 118, 26, tr('touch.jump'), 'Space', false);
  touchBtn(W - 134, H - 58, 29, tr('touch.atk'), 'KeyJ', false);
  touchBtn(W - 62, H - 48, 29, tr('touch.nova'), 'KeyK', false);
  touchBtn(W - 210, H - 100, 24, tr('touch.dash'), 'ShiftLeft', false);
  touchBtn(W - 210, H - 46, 24, tr('touch.el'), 'KeyQ', false);
}

// ---------------------------------------------------------------------------
// 横幅 / 转场 / 闪白
// ---------------------------------------------------------------------------
function drawBanner() {
  const b = G.banner; if (!b) return;
  const p = b.t / b.dur;
  const slide = p < 0.18 ? (1 - p / 0.18) * -260 : p > 0.82 ? (p - 0.82) / 0.18 * 260 : 0;
  ctx.save(); ctx.translate(slide, 0);
  // 顶部细条：不遮挡站在地面的角色立绘
  const y = 76, h = 52;
  const g = ctx.createLinearGradient(0, y, W, y + h);
  g.addColorStop(0, 'rgba(40,28,58,0)'); g.addColorStop(0.18, 'rgba(40,28,58,.9)');
  g.addColorStop(0.82, 'rgba(40,28,58,.9)'); g.addColorStop(1, 'rgba(40,28,58,0)');
  ctx.fillStyle = g; ctx.fillRect(0, y, W, h);
  ctx.fillStyle = b.col || PAL.gold; ctx.fillRect(0, y + h - 3, W, 3);
  text(b.sub, 480, y + 13, 10, 'rgba(255,255,255,.8)', 'center', 600);
  text(b.name, 480, y + 33, 24, '#fff', 'center', 800, FONT_TITLE);
  ctx.restore();
}
function drawTrans() {
  const t = G.trans; if (!t) return;
  const a = t.t < t.dur / 2 ? (t.t / (t.dur / 2)) : (1 - (t.t - t.dur / 2) / (t.dur / 2));
  ctx.fillStyle = `rgba(18,12,32,${clamp(a, 0, 1)})`; ctx.fillRect(0, 0, W, H);
}
function drawFlash() {
  const f = G.flash; if (!f) return;
  ctx.save(); ctx.globalAlpha = f.a * (f.t / f.max); ctx.fillStyle = f.color; ctx.fillRect(0, 0, W, H); ctx.restore();
}

// ---------------------------------------------------------------------------
// 各界面
// ---------------------------------------------------------------------------
function drawLoading() {
  ctx.fillStyle = '#1a1430'; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) { const x = (i * 97 + G.t * 20) % W, y = (i * 53) % H; star(x, y, 1.5 + (i % 3), `rgba(255,225,150,${0.2 + 0.3 * Math.sin(G.t * 2 + i)})`, G.t + i); }
  text('KIRARA · STARFALL', 480, 218, 22, PAL.goldSoft, 'center', 700, FONT_TITLE);
  text(tr('game.title'), 480, 260, 48, '#fff', 'center', 800, FONT_TITLE);
  bar(340, 320, 280, 10, G.loadP || 0, PAL.gold, 'rgba(255,255,255,.15)');
  text(`${Math.floor((G.loadP || 0) * 100)}%`, 480, 350, 12, 'rgba(255,255,255,.7)', 'center', 600);
}
function drawTitle() {
  bgLayer(getImg(SCENE.title), 0, { focus: 0.46 }); vignette(0.4);
  ctx.save(); ctx.globalAlpha = 0.55; panel(268, 62, 424, 424, 26, 'rgba(28,20,46,.55)', 'rgba(255,235,190,.35)', 1.5); ctx.restore();
  text(tr('game.sub'), 480, 104, 13, PAL.goldSoft, 'center', 700);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 16;
  text(tr('game.title'), 480, 156, 52, '#fffaf0', 'center', 800, FONT_TITLE); ctx.restore();
  star(346, 156, 9, PAL.gold, G.t); star(614, 156, 9, PAL.gold, -G.t);
  text(tr('game.tag'), 480, 196, 12, 'rgba(255,255,255,.85)', 'center', 600);
  ctx.fillStyle = 'rgba(255,225,150,.6)'; ctx.fillRect(390, 214, 180, 1.5);
  const labels = [tr('menu.start'), tr('menu.howto'), tr('menu.lang'), G.muted ? tr('menu.soundOff') : tr('menu.sound')];
  const acts = ['titleStart', 'titleHowto', 'titleLang', 'titleSound'];
  labels.forEach((l, i) => uiBtn(348, 232 + i * 52, 264, 42, l, acts[i], { selected: G.menu.i === i, size: 16 }));
  const best = G.save && G.save.best;
  const bt = best
    ? (getLang() === 'en'
        ? `${tr('menu.best')} · Ch.${best.chapter + 1} / ${best.rooms} rooms`
        : `${tr('menu.best')} · 第 ${best.chapter + 1} 卷 / ${best.rooms} 个房间`)
    : tr('menu.none');
  text(bt, 480, 452, 12, 'rgba(255,255,255,.8)', 'center', 600);
  text(tr('menu.footer'), 480, 514, 10, 'rgba(255,255,255,.7)', 'center', 500);
}
function drawHowto() {
  bgLayer(getImg(SCENE.title), 0, { focus: 0.5 }); scrim(0.62);
  panel(96, 48, 768, 444, 22);
  text(tr('howto.title'), 480, 88, 27, PAL.ink, 'center', 800, FONT_TITLE);
  ctx.fillStyle = 'rgba(180,140,100,.4)'; ctx.fillRect(320, 110, 320, 2);
  const lines = ['howto.1', 'howto.2', 'howto.3', 'howto.4', 'howto.5'];
  lines.forEach((k, i) => {
    const y = 146 + i * 58;
    star(126, y, 8, i % 2 ? PAL.sky : PAL.berry, G.t + i);
    text(tr(k), 148, y, 13.5, PAL.ink, 'left', 500);
  });
  // 属性小抄
  ELEMENTS.forEach((e, i) => elIcon(e.id, 214 + i * 106, 420, 13, {}));
  uiBtn(390, 444, 180, 34, tr('howto.back'), 'howtoBack', { size: 15 });
}
function drawHub() {
  bgLayer(getImg(SCENE.hub), 0, { focus: 0.48 }); scrim(0.28); vignette(0.32);
  const hero = HEROES[G.hero], el = elOf(hero.element);
  ctx.save(); ctx.globalAlpha = 0.82; panel(316, 12, 328, 54, 16, 'rgba(30,22,48,.8)', 'rgba(255,230,180,.4)', 1.5); ctx.restore();
  text(tr('hub.title'), 480, 32, 22, '#fffaf0', 'center', 800, FONT_TITLE);
  text(tr('hub.sub'), 480, 54, 11, 'rgba(255,255,255,.8)', 'center', 500);

  ctx.save(); ctx.globalAlpha = 0.95; panel(30, 78, 338, 396, 20); ctx.restore();
  ctx.save(); ctx.translate(199, 348);
  const hg = ctx.createRadialGradient(0, -120, 4, 0, -120, 150);
  hg.addColorStop(0, hero.color + '55'); hg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = hg; ctx.fillRect(-150, -270, 300, 300); ctx.restore();
  artDraw(getImg(hero.stand), 199, 348, 244, 1, {});
  uiBtn(40, 220, 30, 44, '‹', 'hubPrev', { size: 24 });
  uiBtn(328, 220, 30, 44, '›', 'hubNext', { size: 24 });
  text(loc(hero.name, hero.en), 199, 368, 25, PAL.ink, 'center', 800, FONT_TITLE);
  text(loc(hero.title, hero.titleEn), 199, 391, 12, PAL.berryDark, 'center', 600);
  text(`${tr('hub.stats')}  ${hero.hp} / ${hero.atk} / ${hero.spd.toFixed(1)}`, 199, 410, 12, PAL.inkSoft, 'center', 600);
  elIcon(hero.element, 108, 430, 13, { glow: true });
  text(`${tr('hub.element')} · ${loc(el.name, el.en)}`, 130, 430, 12, el.color, 'left', 700);
  ctx.save(); rrect(48, 446, 302, 24, 8); ctx.fillStyle = 'rgba(240,225,200,.6)'; ctx.fill(); ctx.restore();
  const hd = loc(hero.desc, hero.descEn);
  text(hd.length > 34 ? hd.slice(0, 33) + '…' : hd, 199, 458, 10.5, PAL.ink, 'center', 500);
  text(tr('hub.switch'), 199, 96, 10, PAL.inkSoft, 'center', 500);

  ctx.save(); ctx.globalAlpha = 0.95; panel(388, 78, 542, 396, 20); ctx.restore();
  text(tr('hub.upgrade'), 412, 100, 18, PAL.ink, 'left', 800, FONT_TITLE);
  drawImg(getImg(ICON.star), 838, 88, 22, 22);
  text(`${tr('hub.dust')} ${G.save.stardust}`, 906, 100, 14, PAL.berryDark, 'right', 800);
  META.forEach((m, i) => {
    const y = 116 + i * 55, sel = G.hub.i === i, lv = G.save.up[m.id] || 0, full = lv >= m.max;
    ctx.save(); rrect(402, y, 514, 50, 11);
    ctx.fillStyle = sel ? 'rgba(242,181,60,.22)' : 'rgba(246,234,214,.55)'; ctx.fill();
    ctx.strokeStyle = sel ? PAL.gold : 'rgba(150,120,95,.3)'; ctx.lineWidth = sel ? 2.5 : 1.2; ctx.stroke(); ctx.restore();
    iconBox(getImg(m.icon), 410, y + 6, 38, 9);
    text(loc(m.name, m.en), 458, y + 16, 14, PAL.ink, 'left', 700);
    text(loc(m.desc, m.descEn), 458, y + 34, 10.5, PAL.inkSoft, 'left', 500);
    for (let k = 0; k < m.max; k++) star(690 + k * 14, y + 16, 5, k < lv ? PAL.gold : 'rgba(150,130,110,.3)');
    chip(806, y + 12, full ? tr('hub.max') : `${tr('hub.cost')} ${m.cost(lv)}`, full ? '#b9a99a' : sel ? PAL.berry : PAL.inkSoft, 11);
    Input.tapZone(402, y, 514, 50, () => { Sound.sfx('ui'); G.actions.hubSelect(i); });
  });
  const best = G.save.best;
  if (best) text(getLang() === 'en'
    ? `${tr('hub.best')}: Ch.${best.chapter + 1} / ${best.rooms} rooms`
    : `${tr('hub.best')}: 第 ${best.chapter + 1} 卷 / ${best.rooms} 个房间`,
    660, 452, 11, PAL.berryDark, 'center', 600);
  else text(tr('hub.hint'), 660, 452, 11, PAL.inkSoft, 'center', 500);

  uiBtn(30, 486, 210, 44, tr('hub.back'), 'hubBack', { size: 14 });
  uiBtn(640, 486, 290, 44, tr('hub.go'), 'hubGo', { selected: G.hub.i === META.length, size: 16 });
}
function drawCards() {
  const b = BIOMES[G.run ? G.run.biome : 0];
  bgLayer(getImg(b.bg), G.cam.x, { focus: 0.45 }); scrim(0.66);
  text(tr('card.title'), 480, 42, 30, '#fffaf0', 'center', 800, FONT_TITLE);
  text(tr('card.sub'), 480, 74, 13, 'rgba(255,255,255,.8)', 'center', 500);
  const c = G.cards; if (!c) return;
  const cw = 216, ch = 306, gap = 26, x0 = (W - (cw * 3 + gap * 2)) / 2, y0 = 112;
  c.options.forEach((bo, i) => {
    const x = x0 + i * (cw + gap), sel = c.pick === i, lift = sel ? 12 : 0, y = y0 - lift;
    ctx.save(); if (sel) { ctx.shadowColor = PAL.gold; ctx.shadowBlur = 26; }
    rrect(x, y, cw, ch, 16); ctx.fillStyle = 'rgba(255,250,240,.98)'; ctx.fill(); ctx.restore();
    rrect(x, y, cw, ch, 16); ctx.strokeStyle = sel ? PAL.gold : 'rgba(120,90,70,.45)'; ctx.lineWidth = sel ? 4 : 2; ctx.stroke();
    ctx.save(); rrect(x + 8, y + 8, cw - 16, 214, 10); ctx.clip();
    const im = getImg(bo.card);
    if (ready(im)) drawCover(im, x + 8, y + 8, cw - 16, 214);
    else { ctx.fillStyle = PAL.violet; ctx.fillRect(x + 8, y + 8, cw - 16, 214); star(x + cw / 2, y + 110, 40, PAL.gold); }
    const g = ctx.createLinearGradient(0, y + 160, 0, y + 222);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = g; ctx.fillRect(x + 8, y + 160, cw - 16, 62); ctx.restore();
    ell(x + 24, y + 26, 15, 15, sel ? PAL.gold : 'rgba(40,30,50,.7)');
    text(String(i + 1), x + 24, y + 26, 15, '#fff', 'center', 800);
    chip(x + cw - 66, y + 14, bo.rare === 2 ? tr('card.rare2') : tr('card.rare1'), bo.rare === 2 ? PAL.violet : PAL.mint, 10);
    text(locObj(bo), x + cw / 2, y + 244, 19, PAL.ink, 'center', 800, FONT_TITLE);
    ctx.fillStyle = 'rgba(180,140,100,.4)'; ctx.fillRect(x + 40, y + 260, cw - 80, 1.5);
    text(loc(bo.desc, bo.descEn), x + cw / 2, y + 278, 12, PAL.berryDark, 'center', 600);
    Input.tapZone(x, y, cw, ch, () => { Sound.sfx('card'); G.actions.cardPick(i); });
  });
  text(tr('card.nav'), 480, 476, 12, 'rgba(255,255,255,.75)', 'center', 500);
}
function drawShop() {
  bgLayer(getImg(SCENE.shop), 0, { focus: 0.5 }); scrim(0.38); vignette(0.3);
  text(tr('shop.title'), 480, 46, 30, '#fffaf0', 'center', 800, FONT_TITLE);
  text(tr('shop.sub'), 480, 78, 13, 'rgba(255,255,255,.85)', 'center', 500);
  drawImg(getImg(ICON.coin), 852, 22, 26, 26);
  text(String(Math.floor(G.P ? G.P.coin : 0)), 920, 36, 18, '#fff', 'right', 800);
  const s = G.shop; if (!s) return;
  const cw = 224, gap = 24, x0 = (W - (cw * 3 + gap * 2)) / 2, y0 = 126;
  s.stock.forEach((it, i) => {
    const x = x0 + i * (cw + gap), sel = s.i === i, sold = it.sold;
    const price = Math.max(1, Math.round(it.def.price * (G.P.discount || 1)));
    ctx.save(); ctx.globalAlpha = 0.96; panel(x, y0, cw, 244, 18, sold ? 'rgba(225,218,208,.9)' : undefined); ctx.restore();
    rrect(x, y0, cw, 244, 18); ctx.strokeStyle = sel && !sold ? PAL.gold : 'rgba(120,90,70,.35)'; ctx.lineWidth = sel && !sold ? 3.5 : 1.6; ctx.stroke();
    ctx.save(); ctx.globalAlpha = sold ? 0.35 : 1;
    const g = ctx.createRadialGradient(x + cw / 2, y0 + 82, 4, x + cw / 2, y0 + 82, 62);
    g.addColorStop(0, 'rgba(255,225,150,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(x + 20, y0 + 20, cw - 40, 130);
    if (!drawImg(getImg(it.def.icon), x + cw / 2 - 44, y0 + 34, 88, 88)) star(x + cw / 2, y0 + 78, 30, PAL.gold);
    ctx.restore();
    text(locObj(it.def), x + cw / 2, y0 + 142, 18, PAL.ink, 'center', 800, FONT_TITLE);
    text(loc(it.def.desc, it.def.descEn), x + cw / 2, y0 + 166, 12, PAL.inkSoft, 'center', 500);
    drawImg(getImg(ICON.coin), x + cw / 2 - 38, y0 + 184, 22, 22);
    text(String(price), x + cw / 2 + 12, y0 + 195, 17, PAL.berryDark, 'center', 800);
    Input.tapZone(x, y0, cw, 244, () => { Sound.sfx('ui'); G.actions.shopSelect(i); });
    if (sold) chip(x + cw / 2 - 32, y0 + 212, tr('shop.sold'), '#b9a99a', 12);
    else uiBtn(x + 18, y0 + 210, cw - 36, 28, tr('shop.buy'), 'shopBuy', { selected: sel, size: 12, value: i });
  });
  uiBtn(360, 410, 240, 46, tr('shop.leave'), 'shopLeave', { selected: s.i === 3, size: 16 });
  if (s.msg) text(s.msg, 480, 480, 13, PAL.goldSoft, 'center', 700);
}
function drawPause() {
  scrim(0.62); panel(310, 122, 340, 296, 22);
  text(tr('pause.title'), 480, 162, 28, PAL.ink, 'center', 800, FONT_TITLE);
  const acts = ['pauseResume', 'pauseQuit', 'pauseSound', 'pauseLang'];
  const labels = [tr('pause.resume'), tr('pause.quit'), G.muted ? tr('pause.soundOff') : tr('pause.sound'), tr('pause.lang')];
  labels.forEach((l, i) => uiBtn(340, 192 + i * 52, 280, 42, l, acts[i], { selected: G.pause.i === i, size: 15 }));
}
function drawResult() {
  bgLayer(getImg(SCENE.result), 0, { focus: 0.46 }); scrim(0.4); vignette(0.35);
  const R = G.result || {};
  panel(226, 44, 508, 452, 24);
  text(R.win ? tr('result.win') : tr('result.lose'), 480, 94, 35, R.win ? PAL.berryDark : PAL.ink, 'center', 800, FONT_TITLE);
  text(R.win ? tr('result.winSub') : tr('result.loseSub'), 480, 130, 12.5, PAL.inkSoft, 'center', 500);
  for (let i = 0; i < 26; i++) star(252 + i * 18, 150 + Math.sin(i * 1.7) * 5, 3, i % 2 ? PAL.gold : PAL.berry, G.t + i);
  const rows = [
    [tr('result.chapter'), `${loc('第', 'Ch.')}${R.chapter + 1} / ${BIOMES.length}`],
    [tr('result.rooms'), String(R.rooms)],
    [tr('result.kills'), String(R.kills)],
    [tr('result.react'), String(R.reactions || 0)],
    [tr('result.coin'), String(R.coin)],
    [tr('result.time'), fmtTime(R.time || 0)],
  ];
  rows.forEach((r, i) => {
    const col = i % 2, row = Math.floor(i / 2), x = 258 + col * 244, y = 180 + row * 60;
    rrect(x, y, 224, 50, 12); ctx.fillStyle = 'rgba(246,234,214,.65)'; ctx.fill();
    text(r[0], x + 14, y + 16, 11, PAL.inkSoft, 'left', 600);
    text(r[1], x + 14, y + 35, 18, PAL.ink, 'left', 800);
    if (i === 3) star(x + 200, y + 25, 8, PAL.violet, G.t);
  });
  // 星屑收益
  ctx.save(); rrect(258, 366, 460, 54, 12); ctx.fillStyle = 'rgba(242,181,60,.18)'; ctx.fill(); ctx.restore();
  drawImg(getImg(ICON.star), 274, 380, 26, 26);
  text(`${tr('result.dust')}  +${R.dust}`, 310, 393, 17, PAL.berryDark, 'left', 800);
  text(`${tr('hub.dust')} ${G.save.stardust}`, 706, 393, 13, PAL.inkSoft, 'right', 700);
  if (R.newbest) chip(408, 428, tr('result.newbest'), PAL.berry, 13);
  uiBtn(340, 440, 280, 42, tr('result.again'), 'resultAgain', { selected: true, size: 16 });
}

// ---------------------------------------------------------------------------
// 主渲染分发
// ---------------------------------------------------------------------------
export function render() {
  beginFrame();
  Input.clearZones();
  ctx.fillStyle = '#1a1430'; ctx.fillRect(0, 0, W, H);

  const sx = G.shake > 0 ? rnd(-G.shake, G.shake) : 0;
  const sy = G.shake > 0 ? rnd(-G.shake, G.shake) * 0.6 : 0;
  ctx.save(); ctx.translate(Math.round(sx), Math.round(sy));

  if (G.state === 'loading') drawLoading();
  else if (G.state === 'title') drawTitle();
  else if (G.state === 'howto') drawHowto();
  else if (G.state === 'hub') drawHub();
  else if (G.state === 'cards') { drawWorld(); drawCards(); }
  else if (G.state === 'shop') { drawWorld(); drawShop(); }
  else if (G.state === 'play') { drawWorld(); drawHUD(); drawReactBanner(); drawTouch(); drawBanner(); }
  else if (G.state === 'pause') { drawWorld(); drawHUD(); drawPause(); }
  else if (G.state === 'result') drawResult();

  if (G.state !== 'loading') { drawTrans(); drawFlash(); }
  ctx.restore();
}

function drawWorld() {
  const camX = G.cam.x;
  const b = BIOMES[G.run ? G.run.biome : 0];
  bgLayer(getImg(b.bg), camX, { focus: 0.44, tint: G.boss ? 'rgba(40,20,60,.18)' : null });
  drawTerrain(b, camX);
  ctx.save(); ctx.translate(-camX, 0);
  drawDoors();
  drawPickups();
  for (const e of G.enemies) if (!e.dead) drawFoe(e);
  drawBossEntity();
  drawShots();
  drawPlayer();
  drawParticles();
  drawTexts();
  ctx.restore();
  vignette(0.22);
}
