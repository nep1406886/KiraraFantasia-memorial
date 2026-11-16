// Room authoring, platform collision and the follow camera.
// A room is a horizontal strip of solid ground, one-way ledges and a few
// blocks. Collision is plain AABB so tuning a jump is a number, not a mesh.

import { VIEW_W, VIEW_H, FLOOR_Y, BOSSES, ENEMIES } from "./config.js";

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function makePlatform(x, y, w, kind, solid = false) {
  return { x, y, w, h: solid ? 64 : 12, kind, solid, oneway: !solid };
}

export function generateRoom({ type, actIndex, roomIndex, seed, biome }) {
  const rng = mulberry32((seed + actIndex * 977 + roomIndex * 131) >>> 0);
  const isBoss = type === "boss";
  const isShop = type === "shop";
  const isRest = type === "rest";
  const w = isBoss ? 1660 : isShop ? 1720 : isRest ? 1760 : 2480 + Math.floor(rng() * 560);
  const room = {
    type,
    actIndex,
    roomIndex,
    biome,
    seed,
    w,
    h: VIEW_H,
    floorY: FLOOR_Y,
    solids: [{ x: -40, y: FLOOR_Y, w: w + 80, h: 150, kind: "ground", solid: true }],
    oneways: [],
    walls: [{ x: 26, y: 0, w: 8, h: FLOOR_Y }, { x: w - 34, y: 0, w: 8, h: FLOOR_Y }],
    hazards: [],
    breakables: [],
    decor: [],
    pedestals: [],
    door: { x: w - 86, y: FLOOR_Y - 104, w: 54, h: 104, open: false, t: 0 },
    fire: null,
    boss: null,
    spawns: [],
    cleared: false,
    clearedT: 0,
    chestOpened: false,
    time: 0
  };

  if (isBoss) {
    const boss = BOSSES[actIndex === 0 ? "ginger" : actIndex === 1 ? "mint" : "arshif"];
    room.boss = { ...boss, x: 780, y: FLOOR_Y, hp: boss.hp, maxHp: boss.hp, phase: 1, dead: false };
    room.oneways.push(makePlatform(190, FLOOR_Y - 116, 190, "stone", false));
    room.oneways.push(makePlatform(w - 380, FLOOR_Y - 116, 190, "stone", false));
    room.decor.push({ kind: "boss-arch", x: 780, y: FLOOR_Y, scale: 1 });
    room.decor.push({ kind: "boss-arch-small", x: 210, y: FLOOR_Y, scale: 1 });
    room.decor.push({ kind: "boss-arch-small", x: w - 160, y: FLOOR_Y, scale: 1 });
    for (let i = 0; i < 10; i++) {
      room.decor.push({ kind: "star-pillar", x: 100 + rng() * (w - 200), y: 40 + rng() * 240, scale: 0.5 + rng() * 0.8, phase: rng() * 6.28 });
    }
    return room;
  }

  if (isShop) {
    room.oneways.push(makePlatform(330, FLOOR_Y - 118, 200, "wood", false));
    room.oneways.push(makePlatform(760, FLOOR_Y - 196, 170, "wood", false));
    room.oneways.push(makePlatform(w - 520, FLOOR_Y - 118, 200, "wood", false));
    [520, 690, 860].forEach((x, i) => {
      room.pedestals.push({ x, y: FLOOR_Y, index: i, sold: false, bob: rng() * 6.28 });
    });
    room.decor.push({ kind: "shop-sign", x: 690, y: 120, scale: 1 });
    room.decor.push({ kind: "awning", x: 690, y: FLOOR_Y, scale: 1 });
    addGroundDecor(room, rng, 12);
    return room;
  }

  if (isRest) {
    room.fire = { x: 522, y: FLOOR_Y, used: false, t: 0 };
    room.oneways.push(makePlatform(260, FLOOR_Y - 118, 190, "wood", false));
    room.oneways.push(makePlatform(w - 520, FLOOR_Y - 118, 190, "wood", false));
    room.decor.push({ kind: "tent", x: 700, y: FLOOR_Y, scale: 1 });
    room.decor.push({ kind: "camp-banner", x: 880, y: FLOOR_Y, scale: 1 });
    room.decor.push({ kind: "signpost", x: 320, y: FLOOR_Y, scale: 1 });
    addGroundDecor(room, rng, 14);
    return room;
  }

  // Combat / elite rooms: walk the strip and alternate platform clusters.
  const isElite = type === "elite";
  const startX = 382;
  const endX = w - 280;
  const patterns = biome === 0
    ? ["flower-ledge", "stump", "double-ledge", "bush-block", "high-ledge"]
    : biome === 1
      ? ["dock", "lantern-block", "double-dock", "crate-stack", "high-dock"]
      : ["book-ledge", "shelf-block", "double-book", "archive-stack", "high-book"];
  let x = startX;
  let guard = 0;
  while (x < endX && guard++ < 20) {
    let pattern = patterns[Math.floor(rng() * patterns.length)];
    // The first thing the player meets is always a low ledge: a solid stump at
    // the entrance reads as an invisible wall before the jump is learned.
    if (guard === 1) pattern = biome === 0 ? "flower-ledge" : biome === 1 ? "dock" : "book-ledge";
    if (pattern === "flower-ledge" || pattern === "dock" || pattern === "book-ledge") {
      const len = 170 + rng() * 100;
      room.oneways.push(makePlatform(x, FLOOR_Y - (96 + rng() * 34), len, biome === 0 ? "flower" : biome === 1 ? "wood" : "book", false));
      if (rng() < 0.55) room.oneways.push(makePlatform(x + len * 0.4, FLOOR_Y - (196 + rng() * 40), len * 0.56, biome === 1 ? "wood" : biome === 2 ? "book" : "flower", false));
    } else if (pattern === "double-ledge" || pattern === "double-dock" || pattern === "double-book") {
      const len = 140 + rng() * 70;
      room.oneways.push(makePlatform(x, FLOOR_Y - 112, len, biome === 1 ? "wood" : biome === 2 ? "book" : "flower", false));
      room.oneways.push(makePlatform(x + len + 70, FLOOR_Y - 204, len, biome === 1 ? "wood" : biome === 2 ? "book" : "flower", false));
    } else if (pattern === "high-ledge" || pattern === "high-dock" || pattern === "high-book") {
      const len = 130 + rng() * 80;
      room.oneways.push(makePlatform(x, FLOOR_Y - 282, len, biome === 2 ? "book" : "stone", false));
    } else if (pattern === "stump" || pattern === "crate-stack" || pattern === "shelf-block" || pattern === "archive-stack" || pattern === "bush-block" || pattern === "lantern-block") {
      const height = 56 + Math.floor(rng() * 24);
      const width = 68 + rng() * 46;
      const kind = biome === 0 ? (pattern === "bush-block" ? "bush" : "stump") : biome === 1 ? (pattern === "lantern-block" ? "lantern" : "crate") : (pattern === "shelf-block" ? "shelf" : "archive");
      const block = { x, y: FLOOR_Y - height, w: width, h: height, kind, solid: true };
      room.solids.push(block);
      if (rng() < 0.6) {
        room.oneways.push(makePlatform(x - 40, FLOOR_Y - height - 92, width + 80, biome === 0 ? "flower" : biome === 1 ? "wood" : "book", false));
      }
    }
    x += 220 + rng() * 120;
  }

  if (isElite) {
    room.decor.push({ kind: "elite-seal", x: w * 0.5, y: FLOOR_Y, scale: 1 });
  }

  // Ground spikes: never near the entrance or the door.
  const spikeCount = 1 + Math.floor(rng() * 3) + (isElite ? 1 : 0);
  for (let i = 0; i < spikeCount; i++) {
    const sx = 520 + rng() * (w - 1050);
    if (Math.abs(sx - room.door.x) < 220) continue;
    const sw = 48 + Math.floor(rng() * 2) * 24;
    room.hazards.push({ x: sx, y: FLOOR_Y - 18, w: sw, h: 18, kind: "spike", phase: rng() * 6.28 });
  }

  // Star jars to break for currency.
  const jarCount = 2 + Math.floor(rng() * 2) + (isElite ? 1 : 0);
  for (let i = 0; i < jarCount; i++) {
    const jx = 300 + rng() * (w - 650);
    const onLedge = room.oneways.find(p => jx > p.x + 20 && jx < p.x + p.w - 20 && p.y > FLOOR_Y - 240);
    const y = onLedge ? onLedge.y : FLOOR_Y;
    if (Math.abs(jx - room.door.x) < 130) continue;
    room.breakables.push({ x: jx, y, w: 22, h: 28, hp: 1, broken: false, bob: rng() * 6.28 });
  }

  room.decor.push({ kind: "signpost", x: 214, y: FLOOR_Y, scale: 1 });
  addGroundDecor(room, rng, 18);
  addBackgroundDecor(room, rng, 13);
  return room;
}

function addGroundDecor(room, rng, count) {
  for (let i = 0; i < count; i++) {
    room.decor.push({
      kind: room.biome === 0 ? (rng() < 0.5 ? "tuft" : "flower") : room.biome === 1 ? (rng() < 0.5 ? "reed" : "lantern") : (rng() < 0.5 ? "book-stack" : "candle"),
      x: 100 + rng() * (room.w - 200),
      y: FLOOR_Y,
      scale: 0.7 + rng() * 0.6,
      phase: rng() * 6.28
    });
  }
}

function addBackgroundDecor(room, rng, count) {
  for (let i = 0; i < count; i++) {
    room.decor.push({
      kind: room.biome === 0 ? (rng() < 0.5 ? "tree" : "arch") : room.biome === 1 ? (rng() < 0.5 ? "house" : "water-lamp") : (rng() < 0.5 ? "bookshelf" : "window"),
      x: 80 + rng() * (room.w - 160),
      y: FLOOR_Y,
      scale: 0.8 + rng() * 0.7,
      phase: rng() * 6.28
    });
  }
}

// ---------------------------------------------------------------- physics
export function bodyRect(entity) {
  return { x: entity.x - entity.w / 2, y: entity.y - entity.h, w: entity.w, h: entity.h };
}

export function pointHitsPlatform(platform, x, y) {
  return x >= platform.x && x <= platform.x + platform.w && Math.abs(y - platform.y) < 20;
}

export function moveBody(entity, dt, room) {
  entity.hitWall = 0;
  entity.hitHead = false;
  const hw = entity.w / 2;
  const wasGround = entity.onGround;

  // horizontal against solids
  if (entity.vx !== 0) {
    entity.x += entity.vx * dt;
    for (const p of room.solids) {
      if (entity.y <= p.y + 1 || entity.y - entity.h >= p.y + p.h) continue;
      if (entity.x + hw <= p.x || entity.x - hw >= p.x + p.w) continue;
      if (entity.vx > 0) entity.x = p.x - hw - 0.01;
      else if (entity.vx < 0) entity.x = p.x + p.w + hw + 0.01;
      entity.hitWall = entity.vx > 0 ? 1 : -1;
      entity.vx = 0;
    }
    for (const wall of room.walls || []) {
      if (entity.x - hw < wall.x + wall.w && entity.x + hw > wall.x) {
        entity.x = entity.x < wall.x + wall.w / 2 ? wall.x + wall.w + hw : wall.x - hw;
        entity.vx = 0;
      }
    }
  }

  // vertical
  const prevY = entity.y;
  entity.onGround = false;
  entity.ground = null;
  entity.y += entity.vy * dt;
  const left = entity.x - hw + 1;
  const right = entity.x + hw - 1;

  if (entity.vy >= 0) {
    let landed = null;
    const candidates = [...room.solids, ...room.oneways];
    for (const p of candidates) {
      if (p.oneway && entity.dropThrough > 0) continue;
      if (right < p.x || left > p.x + p.w) continue;
      const top = p.y;
      if (prevY <= top + 4 && entity.y >= top) {
        if (!landed || top < landed.y) landed = p;
      }
    }
    if (landed) {
      entity.y = landed.y;
      entity.vy = 0;
      entity.onGround = true;
      entity.ground = landed;
      if (!wasGround) entity.landed = true;
    }
  } else {
    for (const p of room.solids) {
      if (right < p.x || left > p.x + p.w) continue;
      const bottom = p.y + p.h;
      if (prevY - entity.h >= bottom - 2 && entity.y - entity.h <= bottom) {
        entity.y = bottom + entity.h;
        entity.vy = 0;
        entity.hitHead = true;
      }
    }
  }
  if (entity.dropThrough > 0) entity.dropThrough = Math.max(0, entity.dropThrough - dt);
  if (entity.onGround) entity.coyote = 0.1;
  else entity.coyote = Math.max(0, (entity.coyote || 0) - dt);
}

export function groundBelow(room, x, y) {
  let best = FLOOR_Y;
  for (const p of [...room.solids, ...room.oneways]) {
    if (x >= p.x && x <= p.x + p.w && p.y >= y - 30 && p.y <= y + 30) return p.y;
    if (x >= p.x && x <= p.x + p.w && p.y >= y - 30 && p.y < best) best = p.y;
  }
  return best;
}

export function findSpawn(room, rng, { flying = false, minFrom = 0 } = {}) {
  for (let tries = 0; tries < 30; tries++) {
    const candidates = room.oneways.filter(p => p.w > 90);
    let x;
    let y;
    if (!flying && candidates.length && rng() < 0.5) {
      const p = candidates[Math.floor(rng() * candidates.length)];
      x = p.x + 30 + rng() * (p.w - 60);
      y = p.y;
    } else {
      x = 120 + rng() * (room.w - 240);
      y = FLOOR_Y;
    }
    if (Math.abs(x - minFrom) < 210) continue;
    if (Math.abs(x - room.door.x) < 120) continue;
    if (room.hazards.some(h => x > h.x - 30 && x < h.x + h.w + 30)) continue;
    return { x, y: flying ? FLOOR_Y - 130 - rng() * 90 : y };
  }
  return { x: room.w * 0.65, y: flying ? FLOOR_Y - 170 : FLOOR_Y };
}

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.look = 1;
  }

  follow(player, room, dt) {
    const lead = player.face * 62;
    const target = clamp(player.x - VIEW_W * 0.44 + lead, 0, Math.max(0, room.w - VIEW_W));
    this.x = lerp(this.x, target, Math.min(1, dt * 5.5));
    this.y = 0;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 26);
      const m = this.shake;
      this.shakeX = (Math.random() * 2 - 1) * m;
      this.shakeY = (Math.random() * 2 - 1) * m * 0.7;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  kick(magnitude) {
    this.shake = Math.max(this.shake, magnitude);
  }

  snap(player, room) {
    this.x = clamp(player.x - VIEW_W * 0.44 + player.face * 62, 0, Math.max(0, room.w - VIEW_W));
    this.y = 0;
  }
}

export function actEnemyPool(act, roomIndex, type) {
  const base = act.pool.slice();
  if (type === "elite" && act.elitePool) return act.elitePool.slice();
  if (roomIndex === 0) return base.filter(id => id !== "fish");
  return base;
}

export function enemyDef(id, actIndex) {
  const def = ENEMIES[id];
  return {
    ...def,
    model: def.models[Math.min(actIndex, def.models.length - 1)],
    element: def.element[Math.min(actIndex, def.element.length - 1)]
  };
}
