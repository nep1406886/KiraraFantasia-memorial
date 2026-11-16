// 星降旅记 · 地形生成与可解性校验（纯逻辑，不依赖 DOM / three）
// 美术参照：绘本立体书（pop-up book）的层叠剪纸纸片。
import { FLOOR, ROOM_W } from './data.js';

// 与 game.js 的玩家物理保持一致；校验用保守值，宁可低估不可高估
export const PHYS = {
  jumpVy: -12.6,
  gravity: 0.62,
  runSpeed: 7.0,        // 保守水平速度（实际约 8.5，留出操作余量）
  bodyW: 30,
  bodyH: 82,
};
const MAX_RISE = (PHYS.jumpVy * PHYS.jumpVy) / (2 * PHYS.gravity); // ≈128

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// 跳跃能力：从高度差 h（正数=需要上升）算出可用水平窗口
export function jumpRange(h) {
  if (h > MAX_RISE) return 0;
  const disc = PHYS.jumpVy * PHYS.jumpVy - 2 * PHYS.gravity * h;
  if (disc <= 0) return 0;
  const window = 2 * Math.sqrt(disc) / PHYS.gravity;   // 处于目标高度以上的帧数
  return window * PHYS.runSpeed - PHYS.bodyW;
}

const GAP_MAX = 165;      // 坑宽上限
const GAP_MIN = 70;
const STEP_MAX = 92;      // 相邻地面段高度差上限
const PLAT_RISE_MIN = 78;
const PLAT_RISE_MAX = 132;

let uid = 1;
const nid = () => uid++;

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
export function genTerrain(seed, biome, opt = {}) {
  const rng = mulberry32(seed >>> 0);
  const pick = (a, b) => a + rng() * (b - a);
  const rint = (a, b) => Math.floor(pick(a, b + 1));
  const chance = (p) => rng() < p;

  const t = {
    seed, biome,
    ground: [], plats: [], spikes: [], props: [],
    startX: 110, doorX: 0,
    w: ROOM_W,
  };

  // 第一段永远平坦，给玩家落脚与教学空间
  const firstW = 340 + rint(0, 60);
  t.ground.push({ x: 0, w: firstW, y: FLOOR });
  let x = firstW;
  let y = FLOOR;

  const segTarget = 4 + rint(0, 2) + Math.min(biome, 1);
  for (let i = 0; i < segTarget && x < ROOM_W - 320; i++) {
    // 坑
    const gap = rint(GAP_MIN, GAP_MAX);
    x += gap;
    // 高度差（受上一段约束）
    const dy = clamp(Math.round(pick(-STEP_MAX, STEP_MAX)), -STEP_MAX, STEP_MAX);
    let ny = clamp(y + dy, FLOOR - 150, FLOOR);
    if (Math.abs(ny - y) > STEP_MAX) ny = y + (ny > y ? STEP_MAX : -STEP_MAX);
    y = ny;
    const w = 250 + rint(0, 190);
    t.ground.push({ x, w, y });

    // 段上平台：1~2 片剪纸
    const pn = chance(0.85) ? 2 : 1;
    for (let k = 0; k < pn; k++) {
      const pw = 130 + rint(0, 90);
      const px = x + 18 + rint(0, Math.max(1, w - pw - 36));
      const rise = pick(PLAT_RISE_MIN, PLAT_RISE_MAX);
      const py = Math.round(y - rise);
      let kind = 'oneway';
      const r = rng();
      if (r < 0.18 + biome * 0.03) kind = 'fragile';
      else if (r < 0.34 + biome * 0.03) kind = 'moving';
      else if (r < 0.52) kind = 'solid';
      const p = {
        id: nid(), x: px, y: py, w: pw, kind,
        hp: kind === 'fragile' ? 1 : 99, broken: false, breakT: 0,
        ox: px, oy: py, amp: kind === 'moving' ? pick(50, 95) : 0,
        speed: pick(0.5, 0.9), phase: rng() * 6.28, t: 0,
      };
      // 初始位置与 t=0 的正弦值一致，避免首帧把站在平台上的玩家瞬移
      if (kind === 'moving') p.x = px + Math.sin(p.phase) * p.amp;
      t.plats.push(p);
      // 平台上挂星灯 / 爆桶
      if (chance(0.5)) t.props.push({ id: nid(), x: px + pw * 0.5, y: py - 20, kind: chance(0.35) ? 'barrel' : 'lamp', hp: 1, alive: true, lit: false, baseX: px + pw * 0.5, platId: p.id });
    }

    // 地面机关
    if (chance(0.72)) {
      const sx = x + 60 + rint(0, Math.max(1, w - 150));
      t.spikes.push({ x: sx, y: y, w: 42 + rint(0, 30) });
    }
    if (chance(0.6)) t.props.push({ id: nid(), x: x + 90 + rint(0, Math.max(1, w - 180)), y, kind: 'spring', hp: 99, alive: true, lit: false, baseX: 0, platId: 0 });
    if (chance(0.55)) t.props.push({ id: nid(), x: x + 140 + rint(0, Math.max(1, w - 220)), y, kind: 'barrel', hp: 1, alive: true, lit: false, baseX: 0, platId: 0 });

    x += w;
  }
  // 收尾段：铺到房间右端并放门
  if (x < ROOM_W - 40) {
    const last = t.ground[t.ground.length - 1];
    const extra = ROOM_W - x;
    if (last && Math.abs(last.y - y) < 1) last.w += extra;
    else t.ground.push({ x, w: extra, y });
  }
  const finalSeg = t.ground[t.ground.length - 1];
  t.doorX = Math.min(ROOM_W - 90, finalSeg.x + finalSeg.w - 130);
  t.doorY = finalSeg.y;

  // 移动平台上的道具位置基准
  for (const pr of t.props) if (pr.platId) {
    const p = t.plats.find(q => q.id === pr.platId);
    if (p) { pr.baseX = p.x + p.w / 2; pr.y = p.y - 20; }
  }
  return t;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------
export function groundAt(t, x) {
  for (const g of t.ground) if (x >= g.x && x <= g.x + g.w) return g.y;
  return null;                       // 坑
}
export function groundSegmentAt(t, x) {
  for (const g of t.ground) if (x >= g.x && x <= g.x + g.w) return g;
  return null;
}
export function platTop(t, x) {
  let best = null;
  for (const p of t.plats) {
    if (p.broken) continue;
    if (x >= p.x - 4 && x <= p.x + p.w + 4) {
      if (!best || p.y < best.y) best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 可解性校验：落脚点图上做 BFS，边由真实跳跃抛物线推出
// ---------------------------------------------------------------------------
export function validateTerrain(t) {
  // 节点 = 每个地面段 + 每个平台（用左/右端与顶面代表）
  const nodes = [];
  t.ground.forEach((g, i) => nodes.push({ id: 'g' + i, x0: g.x, x1: g.x + g.w, y: g.y, kind: 'ground' }));
  t.plats.forEach(p => {
    if (p.kind === 'fragile') return;                 // 易碎平台不作为必经路径
    nodes.push({ id: 'p' + p.id, x0: p.x - (p.amp || 0), x1: p.x + p.w + (p.amp || 0), y: p.y, kind: 'plat' });
  });

  // 能否从 A 跳到 B（只允许向右推进，或短距离回跳）
  const canJump = (A, B) => {
    const gap = Math.max(0, B.x0 - A.x1);             // 需要跨越的水平空隙
    const h = A.y - B.y;                             // >0 表示 B 更高
    if (h > MAX_RISE - 4) return false;
    if (gap <= 0) return true;                       // 水平重叠，直接可走/可落
    const range = jumpRange(Math.max(0, h));
    return gap <= range - 12;                        // 12px 安全余量
  };

  const start = nodes.find(n => n.kind === 'ground' && t.startX >= n.x0 && t.startX <= n.x1);
  if (!start) return { ok: false, reason: 'no start segment' };

  const seen = new Set([start.id]);
  const queue = [start];
  while (queue.length) {
    const a = queue.shift();
    for (const b of nodes) {
      if (seen.has(b.id)) continue;
      if (b.x1 < a.x0 - 120) continue;               // 不往回绕太远
      if (canJump(a, b)) { seen.add(b.id); queue.push(b); }
    }
  }
  const doorNode = nodes.find(n => n.kind === 'ground' && t.doorX >= n.x0 && t.doorX <= n.x1);
  const doorOk = !!doorNode && seen.has(doorNode.id);
  // 坑宽硬约束
  let prevEnd = t.ground[0].x + t.ground[0].w;
  let gapOk = true;
  for (let i = 1; i < t.ground.length; i++) {
    const g = t.ground[i];
    if (g.x - prevEnd > GAP_MAX) { gapOk = false; break; }
    prevEnd = g.x + g.w;
  }
  return {
    ok: doorOk && gapOk,
    doorOk, gapOk,
    reachable: seen.size, total: nodes.length,
    segments: t.ground.length, plats: t.plats.length,
  };
}

// 反复生成直到可解；返回 { terrain, tries }
export function genSolvable(seed, biome, maxTries = 24) {
  for (let i = 0; i < maxTries; i++) {
    const t = genTerrain(seed + i * 7919, biome);
    const v = validateTerrain(t);
    if (v.ok) return { terrain: t, tries: i + 1, check: v };
  }
  // 兜底：全平地（一定可解）
  const flat = {
    seed, biome, w: ROOM_W, startX: 110,
    ground: [{ x: 0, w: ROOM_W, y: FLOOR }],
    plats: [], spikes: [], props: [],
    doorX: ROOM_W - 130, doorY: FLOOR,
  };
  return { terrain: flat, tries: maxTries, check: validateTerrain(flat), fallback: true };
}
