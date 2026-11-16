// Painted world + effects. Everything is procedural so a room can be rebuilt
// from a seed; the only bitmaps are the item icons that come from the site's
// existing asset library.

import { VIEW_W, VIEW_H, FLOOR_Y, BIOMES, ELEMENTS, ICON_BASE } from "./config.js";
import { clamp, lerp } from "./world.js";

const TAU = Math.PI * 2;
const LAYER_SCALE = 2;

const imageCache = new Map();
export function loadImage(src) {
  if (!src) return null;
  let hit = imageCache.get(src);
  if (hit) return hit;
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  imageCache.set(src, img);
  return img;
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map(c => c + c).join("") : value;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function shade(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const f = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  const mix = (v) => Math.round(v + (f - v) * p);
  return "rgb(" + mix(r) + "," + mix(g) + "," + mix(b) + ")";
}
function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}
function withAlpha(hex, alpha) {
  return rgba(hex, alpha);
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function star(ctx, x, y, r, points = 4, color = "#fff") {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle = (i / (points * 2)) * TAU - Math.PI / 2;
    const radius = i % 2 === 0 ? r : r * 0.32;
    const px = Math.cos(angle) * radius;
    const py = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function flower(ctx, x, y, r, color, center = "#fff1c4") {
  ctx.fillStyle = color;
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * TAU;
    ctx.beginPath();
    ctx.arc(x + Math.cos(angle) * r * 0.7, y + Math.sin(angle) * r * 0.7, r * 0.55, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = center;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.38, 0, TAU);
  ctx.fill();
}

function grassTuft(ctx, x, y, h, color, lean = 0) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(x + i * 3 - 3, y);
    ctx.quadraticCurveTo(x + i * 3 - 2 + lean, y - h * 0.6, x + i * 3 - 4 + lean * 2.2, y - h);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- renderer
export class WorldRenderer {
  constructor(worldCanvas, fxCanvas) {
    this.worldCanvas = worldCanvas;
    this.fxCanvas = fxCanvas;
    this.worldCtx = worldCanvas.getContext("2d");
    this.fxCtx = fxCanvas.getContext("2d");
    this.room = null;
    this.roomLayer = null;
    this.titleSeed = 17;
    this.scale = 1;
    this.pixelRatio = 1;
    this.flash = 0;
    this.flashColor = "#fff";
    this.tint = null;
  }

  resize(width, height, pixelRatio, designScale) {
    this.width = width;
    this.height = height;
    this.scale = designScale;
    this.pixelRatio = pixelRatio;
    for (const [canvas, ctx] of [[this.worldCanvas, this.worldCtx], [this.fxCanvas, this.fxCtx]]) {
      const w = Math.max(1, Math.round(width * pixelRatio));
      const h = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.imageSmoothingEnabled = true;
    }
  }

  setRoom(room) {
    this.room = room;
    this.roomLayer = room ? this.buildRoomLayer(room) : null;
  }

  clearRoom() {
    this.room = null;
    this.roomLayer = null;
  }

  // ---------------------------------------------------------------- title
  drawTitle(t) {
    const ctx = this.worldCtx;
    const fx = this.fxCtx;
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    fx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    fx.clearRect(0, 0, VIEW_W, VIEW_H);
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, "#0d0a1d");
    g.addColorStop(0.34, "#1a1437");
    g.addColorStop(0.66, "#2c2052");
    g.addColorStop(0.88, "#44305f");
    g.addColorStop(1, "#1b1432");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // nebula washes
    const neb = (x, y, r, color, alpha) => {
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, withAlpha(color, alpha));
      rg.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    neb(700, 170, 330, "#8b5bd2", 0.2);
    neb(250, 300, 290, "#c34a76", 0.12);
    neb(470, 90, 220, "#5b9bd5", 0.1);

    // stars
    const rng = mulberryRandom(77);
    for (let i = 0; i < 120; i++) {
      const x = rng() * VIEW_W;
      const y = rng() * 430;
      const r = rng() < 0.82 ? 0.7 : 1.4;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * (0.7 + rng()) + i));
      ctx.fillStyle = "rgba(255,243,220," + (0.18 + tw * 0.62) + ")";
      ctx.fillRect(x, y, r, r);
    }
    // a couple of shooting stars on a slow loop
    for (let i = 0; i < 2; i++) {
      const cycle = (t * 0.075 + i * 0.53) % 1;
      if (cycle > 0.18) continue;
      const p = cycle / 0.18;
      const x = 660 - p * 260 + i * 90;
      const y = 100 + p * 90 + i * 130;
      const grad = ctx.createLinearGradient(x, y, x + 90, y - 36);
      grad.addColorStop(0, "rgba(255,238,196,0)");
      grad.addColorStop(0.7, "rgba(255,238,196," + (0.7 * (1 - p)) + ")");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 90, y - 36);
      ctx.stroke();
    }

    // moon halo (the moon disc itself is DOM, this is the atmosphere around it)
    neb(760, 160, 220, "#ffd9a2", 0.2);

    // far hills
    ctx.fillStyle = "#221a42";
    ctx.beginPath();
    ctx.moveTo(0, 470);
    for (let x = 0; x <= VIEW_W; x += 80) {
      ctx.quadraticCurveTo(x + 40, 400 + Math.sin(x * 0.01) * 30, x + 80, 462 + Math.cos(x * 0.007) * 18);
    }
    ctx.lineTo(VIEW_W, VIEW_H);
    ctx.lineTo(0, VIEW_H);
    ctx.closePath();
    ctx.fill();

    // cloud sea
    for (let i = 0; i < 7; i++) {
      const x = ((i * 190 + t * 8) % (VIEW_W + 260)) - 130;
      const y = 412 + Math.sin(i * 2.1) * 16;
      const rg = ctx.createRadialGradient(x, y, 8, x, y, 120);
      rg.addColorStop(0, "rgba(207,180,236,0.16)");
      rg.addColorStop(1, "rgba(207,180,236,0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.ellipse(x, y, 120, 28, 0, 0, TAU);
      ctx.fill();
    }

    // drifting motes
    for (let i = 0; i < 24; i++) {
      const x = (i * 97 + t * (6 + (i % 4) * 3)) % VIEW_W;
      const y = (i * 53 + Math.sin(t * 0.3 + i) * 18) % 470;
      ctx.fillStyle = i % 3 === 0 ? "rgba(255,214,160,0.5)" : "rgba(214,196,255,0.35)";
      ctx.beginPath();
      ctx.arc(x, y, i % 5 === 0 ? 1.6 : 0.9, 0, TAU);
      ctx.fill();
    }

    // page silhouette at the bottom-right
    ctx.save();
    ctx.translate(780, 470);
    ctx.rotate(-0.1);
    ctx.fillStyle = "rgba(23,16,44,0.85)";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(110, -26, 220, 4);
    ctx.lineTo(214, 74);
    ctx.quadraticCurveTo(110, 40, 6, 62);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,228,190,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- room
  buildRoomLayer(room) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(room.w * LAYER_SCALE);
    canvas.height = Math.ceil(VIEW_H * LAYER_SCALE);
    const ctx = canvas.getContext("2d");
    ctx.scale(LAYER_SCALE, LAYER_SCALE);
    const biome = BIOMES[room.biome];
    const rng = mulberryRandom(room.seed + room.actIndex * 31 + room.roomIndex * 17);

    // background decorations sink behind the ground band and ledges
    for (const d of room.decor) {
      if (["tree", "arch", "house", "water-lamp", "bookshelf", "window", "tent", "camp-banner", "shop-sign", "awning", "boss-arch", "boss-arch-small"].includes(d.kind)) {
        this.drawDecor(ctx, d, biome, room, rng, true);
      }
    }

    // ground band
    this.drawGround(ctx, room, biome, rng);

    // ledges and blocks
    for (const p of room.oneways) this.drawLedge(ctx, p, biome, rng);
    for (const p of room.solids) if (p.kind !== "ground") this.drawBlock(ctx, p, biome, rng);

    // small ground decorations
    for (const d of room.decor) {
      if (["tuft", "flower", "reed", "lantern", "book-stack", "candle", "signpost"].includes(d.kind)) {
        this.drawDecor(ctx, d, biome, room, rng, false);
      }
    }

    // spikes
    for (const hazard of room.hazards) this.drawSpikes(ctx, hazard, biome);

    // pedestals / campfire / seals / star pillars
    for (const pedestal of room.pedestals) this.drawPedestal(ctx, pedestal, biome);
    for (const d of room.decor) {
      if (d.kind === "elite-seal" || d.kind === "star-pillar") this.drawDecor(ctx, d, biome, room, rng, false);
    }
    if (room.fire) this.drawCampfireBase(ctx, room.fire, biome);

    return canvas;
  }

  drawGround(ctx, room, biome, rng) {
    const y = FLOOR_Y;
    const g = ctx.createLinearGradient(0, y, 0, VIEW_H);
    g.addColorStop(0, shade(biome.platformBody, 0.14));
    g.addColorStop(0.18, biome.platformBody);
    g.addColorStop(0.62, shade(biome.platformBody, -0.18));
    g.addColorStop(1, shade(biome.platformEdge, -0.3));
    ctx.fillStyle = g;
    ctx.fillRect(0, y, room.w, VIEW_H - y + 8);

    // top lip
    ctx.fillStyle = biome.platformTop;
    ctx.fillRect(0, y, room.w, 7);
    ctx.fillStyle = shade(biome.platformMoss, 0.15);
    for (let x = 0; x < room.w; x += 18) {
      const h = 3 + rng() * 4;
      ctx.beginPath();
      ctx.ellipse(x + 9, y + 6, 14, h, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(0, y, room.w, 1.5);

    // soil details
    for (let x = 0; x < room.w; x += 34) {
      if (rng() < 0.55) {
        ctx.fillStyle = withAlpha(biome.platformEdge, 0.45);
        ctx.beginPath();
        ctx.ellipse(x + rng() * 12, y + 22 + rng() * 46, 4 + rng() * 7, 2 + rng() * 3, rng(), 0, TAU);
        ctx.fill();
      }
      if (rng() < 0.24) {
        ctx.fillStyle = withAlpha(biome.platformTop, 0.22);
        ctx.fillRect(x + rng() * 20, y + 16 + rng() * 38, 1.5, 4 + rng() * 7);
      }
    }
    // a few roots / vines
    for (let i = 0; i < Math.floor(room.w / 380); i++) {
      const x = 80 + rng() * (room.w - 160);
      ctx.strokeStyle = withAlpha(biome.platformEdge, 0.35);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y + 8);
      ctx.bezierCurveTo(x + 8, y + 24, x - 6, y + 40, x + 4, y + 56);
      ctx.stroke();
    }
  }

  drawLedge(ctx, p, biome, rng) {
    const x = p.x;
    const y = p.y;
    const w = p.w;
    const h = p.h;
    ctx.save();
    // drop shadow
    ctx.fillStyle = "rgba(26,14,30,0.22)";
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h + 6, w * 0.46, 5, 0, 0, TAU);
    ctx.fill();

    if (p.kind === "book") {
      const rows = 3;
      for (let i = 0; i < rows; i++) {
        const bx = x + (i % 2) * 6;
        const by = y + i * 5;
        const bw = w - (i % 2) * 12;
        const colors = [shade(biome.platformBody, 0.18), shade(biome.platformBody, -0.04), shade(biome.platformEdge, -0.12)];
        ctx.fillStyle = colors[i % 3];
        roundedRect(ctx, bx, by, bw, 5.5, 1.5);
        ctx.fill();
        ctx.fillStyle = "rgba(255,242,210,0.22)";
        ctx.fillRect(bx + 4, by + 1.5, bw - 8, 0.8);
      }
      ctx.fillStyle = biome.platformTop;
      ctx.fillRect(x, y - 2, w, 2);
    } else if (p.kind === "wood") {
      ctx.fillStyle = shade(biome.platformBody, 0.03);
      roundedRect(ctx, x, y, w, h + 5, 3);
      ctx.fill();
      ctx.fillStyle = shade(biome.platformBody, -0.16);
      for (let i = 0; i < w; i += 26) ctx.fillRect(x + i, y + 1, 1, h + 4);
      ctx.fillStyle = biome.platformTop;
      ctx.fillRect(x, y, w, 3);
      ctx.fillStyle = biome.platformMoss;
      for (let i = 6; i < w; i += 22) ctx.fillRect(x + i, y + 3, 8, 2);
      // little rope knots
      for (let i = 10; i < w; i += 38) {
        ctx.strokeStyle = "rgba(255,236,200,0.32)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x + i, y + h + 1, 2.4, 0, TAU);
        ctx.stroke();
      }
    } else if (p.kind === "stone") {
      ctx.fillStyle = shade(biome.platformBody, 0.06);
      roundedRect(ctx, x, y, w, h + 3, 4);
      ctx.fill();
      ctx.fillStyle = shade(biome.platformBody, -0.16);
      for (let i = 0; i < w; i += 30) ctx.fillRect(x + i, y + h - 2, 22, 2);
      ctx.fillStyle = biome.platformTop;
      ctx.fillRect(x, y, w, 3);
    } else {
      // mossy flower ledge
      ctx.fillStyle = shade(biome.platformBody, 0.08);
      roundedRect(ctx, x, y, w, h + 3, 5);
      ctx.fill();
      ctx.fillStyle = biome.platformMoss;
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + 1, w / 2, 4, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = biome.platformTop;
      ctx.fillRect(x + 2, y, w - 4, 2.5);
      for (let i = 8; i < w - 6; i += 16) {
        const col = biome.platformFlower[Math.floor(i / 16) % biome.platformFlower.length];
        if (i % 32 === 8) flower(ctx, x + i, y - 2, 2.2, col);
      }
    }
    // hanging moss
    ctx.strokeStyle = withAlpha(biome.platformMoss, 0.65);
    ctx.lineWidth = 1.2;
    for (let i = 8; i < w; i += 22) {
      if (i > w - 8) break;
      ctx.beginPath();
      ctx.moveTo(x + i, y + h + 2);
      ctx.quadraticCurveTo(x + i + 2, y + h + 6, x + i + 1, y + h + 8 + (i % 7));
      ctx.stroke();
    }
    ctx.restore();
  }

  drawBlock(ctx, p, biome, rng) {
    const { x, y, w, h, kind } = p;
    ctx.save();
    ctx.fillStyle = "rgba(26,14,30,0.26)";
    ctx.beginPath();
    ctx.ellipse(x + w / 2, FLOOR_Y + 3, w * 0.52, 5, 0, 0, TAU);
    ctx.fill();
    if (kind === "stump") {
      ctx.fillStyle = shade(biome.platformBody, -0.1);
      roundedRect(ctx, x, y, w, h, 6);
      ctx.fill();
      ctx.fillStyle = shade(biome.platformBody, 0.18);
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + 4, w / 2 - 1, 6, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = withAlpha(biome.platformEdge, 0.65);
      ctx.lineWidth = 1;
      for (let r = 5; r < w / 2; r += 5) {
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + 4, r, r * 0.22, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.fillStyle = biome.platformMoss;
      ctx.beginPath();
      ctx.ellipse(x + w * 0.35, y + 3, w * 0.28, 3, 0, 0, TAU);
      ctx.fill();
    } else if (kind === "crate") {
      ctx.fillStyle = shade(biome.platformBody, 0.02);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = shade(biome.platformBody, -0.24);
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 4);
      ctx.lineTo(x + w - 4, y + h - 4);
      ctx.moveTo(x + w - 4, y + 4);
      ctx.lineTo(x + 4, y + h - 4);
      ctx.stroke();
      ctx.fillStyle = biome.platformTop;
      ctx.fillRect(x, y, w, 2);
    } else if (kind === "shelf") {
      ctx.fillStyle = shade(biome.platformBody, -0.12);
      roundedRect(ctx, x, y, w, h, 4);
      ctx.fill();
      let by = y + 8;
      const colors = ["#d99a8c", "#8fb8d8", "#c9a86a", "#9b8fc4", "#8ec7a8"];
      while (by < y + h - 8) {
        let bx = x + 6;
        while (bx < x + w - 10) {
          const bw = 4 + rng() * 4;
          ctx.fillStyle = colors[Math.floor(rng() * colors.length)];
          ctx.fillRect(bx, by, bw, 12);
          bx += bw + 2;
        }
        by += 18;
      }
      ctx.fillStyle = biome.platformTop;
      ctx.fillRect(x, y, w, 3);
    } else if (kind === "archive") {
      for (let i = 0; i < 4; i++) {
        const bw = w + (i % 2 ? -12 : 0);
        const bx = x + (w - bw) / 2 + (i % 2 ? 6 : 0);
        ctx.fillStyle = [shade(biome.platformBody, 0.12), shade(biome.platformBody, -0.08), shade(biome.platformBody, 0.02), shade(biome.platformBody, -0.18)][i];
        roundedRect(ctx, bx, y + h - (i + 1) * 16, bw, 15, 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,235,200,0.25)";
        ctx.fillRect(bx + 4, y + h - (i + 1) * 16 + 3, bw - 8, 1);
      }
    } else if (kind === "bush") {
      ctx.fillStyle = shade(biome.platformMoss, -0.1);
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h * 0.55, w * 0.55, h * 0.55, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = biome.platformMoss;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(x + 10 + (i % 3) * (w / 3), y + h * 0.4 + (i % 2) * 10, w * 0.2, 0, TAU);
        ctx.fill();
      }
      for (let i = 0; i < 3; i++) flower(ctx, x + 10 + i * (w / 3), y + h * 0.35, 2.2, biome.platformFlower[i % 3]);
    } else {
      // lantern / stone pillar
      ctx.fillStyle = shade(biome.platformBody, 0.02);
      roundedRect(ctx, x + 6, y, w - 12, h, 4);
      ctx.fill();
      ctx.fillStyle = shade(biome.platformBody, -0.24);
      ctx.fillRect(x + 3, y + h - 10, w - 6, 10);
      ctx.fillStyle = "#ffe4a8";
      roundedRect(ctx, x + 10, y + 8, w - 20, 14, 3);
      ctx.fill();
      ctx.fillStyle = "rgba(255,244,205,0.35)";
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + 15, w * 0.4, 12, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = shade(biome.platformBody, -0.3);
      ctx.fillRect(x + 6, y, w - 12, 3);
    }
    ctx.restore();
  }

  drawSpikes(ctx, h, biome) {
    const count = Math.max(2, Math.round(h.w / 16));
    for (let i = 0; i < count; i++) {
      const x = h.x + (i + 0.5) * (h.w / count);
      ctx.fillStyle = i % 2 ? "#d9d3e8" : "#bdb3d2";
      ctx.beginPath();
      ctx.moveTo(x - 7, FLOOR_Y);
      ctx.lineTo(x, h.y);
      ctx.lineTo(x + 7, FLOOR_Y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.beginPath();
      ctx.moveTo(x - 2, FLOOR_Y - 2);
      ctx.lineTo(x, h.y + 2);
      ctx.lineTo(x + 1, FLOOR_Y - 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "rgba(44,24,44,0.36)";
    ctx.fillRect(h.x, FLOOR_Y - 2, h.w, 3);
  }

  drawJar(ctx, jar, biome) {
    const x = jar.x;
    const y = jar.y;
    ctx.save();
    ctx.translate(x, y - 14);
    ctx.fillStyle = "rgba(255,246,224,0.18)";
    ctx.beginPath();
    ctx.ellipse(0, 17, 16, 4, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(159,215,226,0.58)";
    ctx.beginPath();
    ctx.moveTo(-7, -15);
    ctx.lineTo(-10, 12);
    ctx.quadraticCurveTo(0, 18, 10, 12);
    ctx.lineTo(7, -15);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,250,235,0.75)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = "#ffe29b";
    star(ctx, 0, -1, 5.5, 4, "#ffe29b");
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(-4, -10, 2, 12);
    ctx.restore();
  }

  drawPedestal(ctx, p, biome) {
    const x = p.x;
    const y = p.y;
    ctx.fillStyle = "rgba(30,16,32,0.28)";
    ctx.beginPath();
    ctx.ellipse(x, y + 3, 34, 7, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = shade(biome.platformBody, 0.12);
    ctx.beginPath();
    ctx.moveTo(x - 24, y);
    ctx.lineTo(x - 16, y - 36);
    ctx.lineTo(x + 16, y - 36);
    ctx.lineTo(x + 24, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = biome.platformTop;
    ctx.fillRect(x - 28, y - 4, 56, 4);
    ctx.fillStyle = shade(biome.platformTop, 0.12);
    roundedRect(ctx, x - 22, y - 42, 44, 8, 3);
    ctx.fill();
    ctx.strokeStyle = withAlpha(biome.accent, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, y - 42, 25, 6, 0, 0, TAU);
    ctx.stroke();
  }

  drawCampfireBase(ctx, fire, biome) {
    const x = fire.x;
    const y = fire.y;
    ctx.fillStyle = "rgba(30,16,32,0.28)";
    ctx.beginPath();
    ctx.ellipse(x, y + 2, 46, 9, 0, 0, TAU);
    ctx.fill();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      ctx.fillStyle = i % 2 ? "#8e859e" : "#a99cba";
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(a) * 32, y - 2 + Math.sin(a) * 8, 6, 4, a, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = "#6d4a43";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - 18, y - 2);
    ctx.lineTo(x + 16, y - 10);
    ctx.moveTo(x - 16, y - 10);
    ctx.lineTo(x + 18, y - 2);
    ctx.stroke();
  }

  drawDecor(ctx, d, biome, room, rng, behind) {
    const x = d.x;
    const y = d.y;
    const s = d.scale || 1;
    ctx.save();
    if (d.kind === "tree") {
      ctx.fillStyle = "rgba(30,16,30,0.22)";
      ctx.beginPath();
      ctx.ellipse(x, y + 2, 42 * s, 8 * s, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = shade(biome.platformEdge, -0.2);
      roundedRect(ctx, x - 8 * s, y - 96 * s, 16 * s, 96 * s, 4);
      ctx.fill();
      ctx.fillStyle = shade(biome.platformMoss, -0.2);
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(x + Math.cos(i * 1.7) * 30 * s, y - (92 + i * 12) * s, 30 * s, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = withAlpha(biome.platformMoss, 0.75);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(x + Math.cos(i * 2.1) * 22 * s, y - (104 + i * 9) * s, 20 * s, 0, TAU);
        ctx.fill();
      }
      for (let i = 0; i < 6; i++) {
        flower(ctx, x + (i % 3 - 1) * 25 * s, y - (70 + (i % 4) * 16) * s, 2 * s, biome.platformFlower[i % 3]);
      }
    } else if (d.kind === "arch") {
      ctx.strokeStyle = withAlpha(biome.far, 0.55);
      ctx.lineWidth = 12 * s;
      ctx.beginPath();
      ctx.arc(x, y - 60 * s, 58 * s, Math.PI, TAU);
      ctx.stroke();
      ctx.fillStyle = withAlpha(biome.far, 0.48);
      ctx.fillRect(x - 64 * s, y - 60 * s, 10 * s, 60 * s);
      ctx.fillRect(x + 54 * s, y - 60 * s, 10 * s, 60 * s);
      ctx.strokeStyle = withAlpha(biome.accent, 0.25);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y - 60 * s, 46 * s, Math.PI, TAU);
      ctx.stroke();
    } else if (d.kind === "house") {
      ctx.fillStyle = withAlpha(biome.far, 0.72);
      const hw = 72 * s;
      const hh = 74 * s;
      ctx.fillRect(x - hw / 2, y - hh, hw, hh);
      ctx.beginPath();
      ctx.moveTo(x - hw / 2 - 10 * s, y - hh);
      ctx.lineTo(x, y - hh - 38 * s);
      ctx.lineTo(x + hw / 2 + 10 * s, y - hh);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,220,150,0.42)";
      ctx.fillRect(x - 20 * s, y - hh + 18 * s, 12 * s, 16 * s);
      ctx.fillRect(x + 8 * s, y - hh + 18 * s, 12 * s, 16 * s);
    } else if (d.kind === "water-lamp") {
      ctx.fillStyle = "rgba(20,14,40,0.62)";
      ctx.fillRect(x - 2 * s, y - 92 * s, 4 * s, 92 * s);
      const glow = ctx.createRadialGradient(x, y - 98 * s, 2, x, y - 98 * s, 38 * s);
      glow.addColorStop(0, "rgba(255,226,160,0.5)");
      glow.addColorStop(1, "rgba(255,226,160,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y - 98 * s, 38 * s, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#ffe1a1";
      roundedRect(ctx, x - 7 * s, y - 106 * s, 14 * s, 16 * s, 4);
      ctx.fill();
      ctx.strokeStyle = "rgba(40,26,50,0.55)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (d.kind === "bookshelf") {
      ctx.fillStyle = withAlpha(biome.far, 0.82);
      const bw = 94 * s;
      const bh = 150 * s;
      ctx.fillRect(x - bw / 2, y - bh, bw, bh);
      const colors = ["#7a5a7b", "#5e6e8f", "#8b6a55", "#6c5a8c", "#5f806e"];
      for (let row = 0; row < 4; row++) {
        let bx = x - bw / 2 + 6;
        while (bx < x + bw / 2 - 8) {
          const bookW = 5 + rng() * 5;
          ctx.fillStyle = withAlpha(colors[Math.floor(rng() * colors.length)], 0.7);
          ctx.fillRect(bx, y - bh + 10 + row * 34, bookW, 24);
          bx += bookW + 2;
        }
      }
      ctx.fillStyle = withAlpha(biome.accent, 0.15);
      ctx.fillRect(x - bw / 2, y - bh, bw, 3);
    } else if (d.kind === "window") {
      ctx.strokeStyle = withAlpha(biome.accent, 0.35);
      ctx.lineWidth = 3;
      const ww = 70 * s;
      const wh = 130 * s;
      ctx.beginPath();
      ctx.moveTo(x - ww / 2, y - 70 * s);
      ctx.lineTo(x - ww / 2, y - wh);
      ctx.arc(x, y - wh, ww / 2, Math.PI, TAU);
      ctx.lineTo(x + ww / 2, y - 70 * s);
      ctx.stroke();
      ctx.fillStyle = "rgba(80,60,130,0.24)";
      ctx.fill();
      ctx.strokeStyle = withAlpha(biome.accent, 0.18);
      ctx.beginPath();
      ctx.moveTo(x, y - wh - ww / 2);
      ctx.lineTo(x, y - 70 * s);
      ctx.moveTo(x - ww / 2, y - wh + ww / 4);
      ctx.lineTo(x + ww / 2, y - wh + ww / 4);
      ctx.stroke();
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = "rgba(255,240,200," + (0.3 + rng() * 0.4) + ")";
        ctx.fillRect(x - 24 + rng() * 48, y - wh + 20 + rng() * 40, 1.2, 1.2);
      }
    } else if (d.kind === "tent") {
      ctx.fillStyle = shade(biome.platformBody, 0.1);
      ctx.beginPath();
      ctx.moveTo(x - 48 * s, y);
      ctx.lineTo(x, y - 78 * s);
      ctx.lineTo(x + 48 * s, y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(255,244,220,0.4)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "rgba(28,16,34,0.55)";
      ctx.beginPath();
      ctx.moveTo(x - 15 * s, y);
      ctx.lineTo(x, y - 40 * s);
      ctx.lineTo(x + 15 * s, y);
      ctx.closePath();
      ctx.fill();
    } else if (d.kind === "camp-banner") {
      ctx.fillStyle = "rgba(30,18,40,0.5)";
      ctx.fillRect(x - 2 * s, y - 110 * s, 3 * s, 110 * s);
      ctx.fillStyle = withAlpha(biome.accent, 0.6);
      ctx.beginPath();
      ctx.moveTo(x + 1, y - 108 * s);
      ctx.lineTo(x + 58 * s, y - 98 * s);
      ctx.lineTo(x + 46 * s, y - 84 * s);
      ctx.lineTo(x + 56 * s, y - 70 * s);
      ctx.lineTo(x + 1, y - 74 * s);
      ctx.closePath();
      ctx.fill();
    } else if (d.kind === "shop-sign") {
      ctx.strokeStyle = "rgba(42,26,44,0.55)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - 42 * s, y + 150 * s);
      ctx.lineTo(x - 42 * s, y - 20 * s);
      ctx.moveTo(x + 42 * s, y + 150 * s);
      ctx.lineTo(x + 42 * s, y - 20 * s);
      ctx.stroke();
      ctx.fillStyle = withAlpha(biome.platformBody, 0.95);
      roundedRect(ctx, x - 68 * s, y - 22 * s, 136 * s, 44 * s, 6);
      ctx.fill();
      ctx.strokeStyle = withAlpha(biome.accent, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#fff1cf";
      ctx.font = "600 " + (18 * s) + "px 'Noto Serif SC','STSong',serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("星灯小铺", x, y + 2 * s);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    } else if (d.kind === "awning") {
      for (let i = 0; i < 7; i++) {
        ctx.fillStyle = i % 2 ? "#e7b9c7" : "#fff1dd";
        ctx.beginPath();
        ctx.moveTo(x - 100 + i * 29, y - 160);
        ctx.lineTo(x - 100 + (i + 1) * 29, y - 160);
        ctx.lineTo(x - 100 + (i + 1) * 29 + 6, y - 138);
        ctx.lineTo(x - 100 + i * 29 + 6, y - 138);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(84,46,58,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 104, y - 160);
      ctx.lineTo(x + 104, y - 160);
      ctx.stroke();
    } else if (d.kind === "boss-arch") {
      ctx.strokeStyle = withAlpha(biome.accent, 0.28);
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.arc(x, y - 20, 180, Math.PI * 1.06, Math.PI * 1.94);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,238,205,0.18)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y - 20, 150, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * 1.12 + (i / 5) * Math.PI * 0.76;
        const sx = x + Math.cos(a) * 170;
        const sy = y - 20 + Math.sin(a) * 170;
        ctx.strokeStyle = "rgba(255,236,200,0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx, sy + 20);
        ctx.stroke();
        star(ctx, sx, sy + 25, 4, 4, "rgba(255,226,160,0.7)");
      }
    } else if (d.kind === "boss-arch-small") {
      ctx.strokeStyle = withAlpha(biome.accent, 0.16);
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(x, y - 10, 90, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    } else if (d.kind === "star-pillar") {
      ctx.fillStyle = "rgba(255,236,200,0.16)";
      ctx.fillRect(x - 2, y, 4, 60 + Math.sin(d.phase || 0) * 8);
      const glow = ctx.createRadialGradient(x, y - 10, 0, x, y - 10, 34);
      glow.addColorStop(0, "rgba(255,230,180,0.2)");
      glow.addColorStop(1, "rgba(255,230,180,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y - 10, 34, 0, TAU);
      ctx.fill();
    } else if (d.kind === "elite-seal") {
      ctx.strokeStyle = "rgba(255,150,160,0.2)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y - 2, 220, 16, 0, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,190,160,0.12)";
      ctx.beginPath();
      ctx.ellipse(x, y - 2, 170, 11, 0, 0, TAU);
      ctx.stroke();
    } else if (d.kind === "tuft") {
      grassTuft(ctx, x, y, 12 * s, shade(biome.platformMoss, -0.1), 0.2);
    } else if (d.kind === "flower") {
      ctx.strokeStyle = shade(biome.platformMoss, -0.2);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 10 * s);
      ctx.stroke();
      flower(ctx, x, y - 12 * s, 3 * s, biome.platformFlower[Math.floor(x) % biome.platformFlower.length]);
    } else if (d.kind === "reed") {
      ctx.strokeStyle = shade(biome.platformMoss, -0.15);
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(x + i * 3, y);
        ctx.quadraticCurveTo(x + i * 3 + 4, y - 14 * s, x + i * 3 + 8, y - 24 * s);
        ctx.stroke();
      }
    } else if (d.kind === "lantern") {
      ctx.strokeStyle = "rgba(42,26,44,0.4)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 30 * s);
      ctx.stroke();
      const glow = ctx.createRadialGradient(x, y - 34 * s, 0, x, y - 34 * s, 26);
      glow.addColorStop(0, "rgba(255,226,160,0.35)");
      glow.addColorStop(1, "rgba(255,226,160,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y - 34 * s, 26, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(255,226,160,0.8)";
      ctx.beginPath();
      ctx.arc(x, y - 34 * s, 3.5, 0, TAU);
      ctx.fill();
    } else if (d.kind === "book-stack") {
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = ["#8d6c86", "#b58f75", "#7589a8"][i];
        roundedRect(ctx, x - 12 + i * 2, y - 5 - i * 5, 24 - i * 3, 5, 1.5);
        ctx.fill();
      }
    } else if (d.kind === "candle") {
      ctx.fillStyle = "rgba(255,228,170,0.85)";
      ctx.fillRect(x - 1.5, y - 18, 3, 18);
      const glow = ctx.createRadialGradient(x, y - 22, 0, x, y - 22, 22);
      glow.addColorStop(0, "rgba(255,220,150,0.4)");
      glow.addColorStop(1, "rgba(255,220,150,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y - 22, 22, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#ffe8ae";
      ctx.beginPath();
      ctx.ellipse(x, y - 24, 2.2, 4, 0, 0, TAU);
      ctx.fill();
    } else if (d.kind === "signpost") {
      ctx.fillStyle = "rgba(43,28,45,0.48)";
      ctx.fillRect(x - 2.5, y - 64, 5, 64);
      ctx.fillStyle = shade(biome.platformBody, 0.18);
      roundedRect(ctx, x - 42, y - 76, 84, 25, 4);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,244,218,0.46)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#fff2d8";
      ctx.font = "600 10px 'Noto Serif SC','STSong',serif";
      ctx.textAlign = "center";
      ctx.fillText("花径深处  ›", x, y - 59);
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(255,235,200,0.28)";
      ctx.beginPath();
      ctx.moveTo(x + 30, y - 52);
      ctx.lineTo(x + 38, y - 45);
      ctx.lineTo(x + 30, y - 38);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- world frame
  drawWorld(game, t) {
    const ctx = this.worldCtx;
    const cam = game.camera;
    const room = game.room;
    if (!room) { this.drawTitle(t); return; }
    const biome = BIOMES[room.biome];
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    ctx.save();
    ctx.translate(cam.shakeX || 0, cam.shakeY || 0);
    this.drawSky(ctx, biome, cam, t, room);
    this.drawParallax(ctx, biome, cam, t, room);
    ctx.save();
    ctx.translate(-Math.round(cam.x), 0);

    if (this.roomLayer) ctx.drawImage(this.roomLayer, 0, 0, room.w, VIEW_H);
    this.drawDynamicProps(ctx, game, t);
    this.drawDoor(ctx, room, t);
    this.drawShadows(ctx, game);
    ctx.restore();
    ctx.restore();
  }

  drawSky(ctx, biome, cam, t, room) {
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, biome.skyTop);
    g.addColorStop(0.42, biome.skyMid);
    g.addColorStop(0.74, biome.skyLow);
    g.addColorStop(1, biome.skyDeep);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // sun / moon
    const sx = 760 - cam.x * 0.018;
    const sy = 88;
    const halo = ctx.createRadialGradient(sx, sy, 10, sx, sy, 170);
    halo.addColorStop(0, rgba(biome.sunGlow, 0.38));
    halo.addColorStop(0.55, rgba(biome.sunGlow, 0.13));
    halo.addColorStop(1, rgba(biome.sunGlow, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(sx - 170, sy - 170, 340, 340);
    if (room.biome === 0) {
      // a proper dawn sun with soft rays
      ctx.save();
      ctx.translate(sx, sy);
      ctx.strokeStyle = "rgba(255,244,204,0.18)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU + t * 0.012;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 62, Math.sin(a) * 62);
        ctx.lineTo(Math.cos(a) * 96, Math.sin(a) * 96);
        ctx.stroke();
      }
      ctx.fillStyle = biome.sun;
      ctx.beginPath();
      ctx.arc(0, 0, 45, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath();
      ctx.arc(-12, -13, 24, 0, TAU);
      ctx.fill();
      ctx.restore();
      // a few distant birds
      ctx.strokeStyle = "rgba(90,66,92,0.32)";
      ctx.lineWidth = 1.1;
      for (let i = 0; i < 3; i++) {
        const bx = 590 + i * 38 + Math.sin(t * 0.5 + i) * 9;
        const by = 146 + i * 14 + Math.cos(t * 0.8 + i) * 4;
        ctx.beginPath();
        ctx.moveTo(bx - 7, by);
        ctx.quadraticCurveTo(bx - 3, by - 4, bx, by);
        ctx.quadraticCurveTo(bx + 3, by - 4, bx + 7, by);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = biome.sun;
      ctx.beginPath();
      ctx.arc(sx, sy, 40, 0, TAU);
      ctx.fill();
      ctx.fillStyle = rgba(biome.skyMid, 0.94);
      ctx.beginPath();
      ctx.arc(sx - 15, sy - 7, 36, 0, TAU);
      ctx.fill();
    }

    // stars for the two night biomes
    if (room.biome > 0) {
      const rng = mulberryRandom(room.seed + 5);
      for (let i = 0; i < (room.biome === 2 ? 90 : 46); i++) {
        const x = (rng() * VIEW_W + cam.x * 0.05 * (i % 3 + 1)) % VIEW_W;
        const y = rng() * 330;
        const a = 0.2 + Math.abs(Math.sin(t * 0.8 + i)) * 0.6;
        ctx.fillStyle = "rgba(255,244,220," + a + ")";
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // clouds
    const cloudAlpha = room.biome === 0 ? 0.55 : 0.35;
    for (let i = 0; i < 6; i++) {
      const x = ((i * 210 - cam.x * 0.08 + t * (3 + i)) % (VIEW_W + 320)) - 160;
      const y = 118 + (i % 3) * 42;
      const rx = 96 + (i % 3) * 34;
      ctx.fillStyle = rgba(biome.cloud[i % 2], cloudAlpha * (0.5 + (i % 2) * 0.3));
      ctx.beginPath();
      ctx.ellipse(x, y, rx, 16 + (i % 3) * 4, 0, 0, TAU);
      ctx.ellipse(x - rx * 0.42, y - 6, rx * 0.46, 12, 0, 0, TAU);
      ctx.ellipse(x + rx * 0.36, y - 4, rx * 0.4, 11, 0, 0, TAU);
      ctx.fill();
    }
  }

  drawParallax(ctx, biome, cam, t, room) {
    // far hills
    ctx.fillStyle = rgba(biome.far, 0.6);
    ctx.beginPath();
    ctx.moveTo(0, 430);
    const offset = -cam.x * 0.1;
    for (let x = -120; x <= VIEW_W + 120; x += 120) {
      const wx = x + (offset % 240);
      ctx.quadraticCurveTo(wx + 60, 340 + Math.sin((wx + room.seed) * 0.01) * 34, wx + 120, 424);
    }
    ctx.lineTo(VIEW_W, VIEW_H);
    ctx.lineTo(0, VIEW_H);
    ctx.closePath();
    ctx.fill();

    // mid silhouettes
    const midX = -cam.x * 0.24;
    if (room.biome === 0) {
      ctx.fillStyle = rgba(biome.mid, 0.66);
      for (let i = 0; i < 12; i++) {
        const x = ((i * 160 + midX) % (VIEW_W + 220)) - 110;
        const h = 54 + (i % 4) * 24;
        ctx.beginPath();
        ctx.ellipse(x, 412, 42, h * 0.55, 0, 0, TAU);
        ctx.fill();
        ctx.fillRect(x - 5, 412, 10, 30);
      }
    } else if (room.biome === 1) {
      ctx.fillStyle = rgba(biome.mid, 0.82);
      for (let i = 0; i < 8; i++) {
        const x = ((i * 190 + midX) % (VIEW_W + 260)) - 130;
        const h = 68 + (i % 3) * 26;
        ctx.fillRect(x - 36, 420 - h, 72, h);
        ctx.beginPath();
        ctx.moveTo(x - 48, 420 - h);
        ctx.lineTo(x, 420 - h - 34);
        ctx.lineTo(x + 48, 420 - h);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "rgba(255,222,160,0.3)";
        ctx.fillRect(x - 20, 420 - h + 16, 9, 12);
        ctx.fillRect(x + 8, 420 - h + 16, 9, 12);
        ctx.fillStyle = rgba(biome.mid, 0.82);
      }
    } else {
      ctx.fillStyle = rgba(biome.mid, 0.8);
      for (let i = 0; i < 7; i++) {
        const x = ((i * 210 + midX) % (VIEW_W + 260)) - 130;
        const h = 140 + (i % 4) * 38;
        ctx.fillRect(x - 34, 430 - h, 68, h);
        ctx.fillStyle = "rgba(180,140,220,0.16)";
        for (let row = 0; row < 5; row++) ctx.fillRect(x - 26, 430 - h + 16 + row * 26, 52, 3);
        ctx.fillStyle = rgba(biome.mid, 0.8);
      }
    }

    // floating pages / motes
    if (room.biome === 2) {
      for (let i = 0; i < 14; i++) {
        const x = ((i * 97 - cam.x * 0.3 + Math.sin(t * 0.4 + i) * 24) % (VIEW_W + 80)) - 40;
        const y = 80 + ((i * 53 + t * (8 + (i % 5) * 2)) % 320);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.sin(t * 0.5 + i) * 0.5);
        ctx.fillStyle = "rgba(255,240,214," + (0.16 + (i % 3) * 0.06) + ")";
        ctx.fillRect(-5, -3, 10, 6);
        ctx.restore();
      }
    }

    // canopy / hanging set dressing: gives the upper third of the frame a
    // ceiling so the stage reads as a place instead of a backdrop.
    if (room.biome === 0) {
      const off = -cam.x * 0.36;
      ctx.fillStyle = "rgba(64,88,74,0.34)";
      for (let i = 0; i < 9; i++) {
        const x = ((i * 150 + off) % (VIEW_W + 260)) - 130;
        ctx.beginPath();
        ctx.ellipse(x, -18 + (i % 3) * 8, 96, 42 + (i % 3) * 10, 0, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(70,96,78,0.28)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 7; i++) {
        const x = ((i * 173 + off * 1.2) % (VIEW_W + 240)) - 120;
        ctx.beginPath();
        ctx.moveTo(x, 16);
        ctx.bezierCurveTo(x + 12, 52, x - 8, 74, x + 10, 104 + (i % 3) * 16);
        ctx.stroke();
      }
    } else if (room.biome === 1) {
      const off = -cam.x * 0.42;
      ctx.strokeStyle = "rgba(20,14,36,0.55)";
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 7; i++) {
        const x = ((i * 172 + off) % (VIEW_W + 240)) - 120;
        const y = 30 + (i % 3) * 16;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, y);
        ctx.stroke();
        const glow = ctx.createRadialGradient(x, y + 8, 1, x, y + 8, 30);
        glow.addColorStop(0, "rgba(255,218,150,0.22)");
        glow.addColorStop(1, "rgba(255,218,150,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y + 8, 30, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "rgba(255,224,160,0.55)";
        roundedRect(ctx, x - 5, y + 1, 10, 12, 3);
        ctx.fill();
      }
    } else {
      const off = -cam.x * 0.4;
      ctx.strokeStyle = "rgba(215,180,255,0.16)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const x = ((i * 195 + off) % (VIEW_W + 260)) - 130;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 70 + (i % 3) * 22);
        ctx.stroke();
        ctx.save();
        ctx.translate(x, 82 + (i % 3) * 22);
        ctx.rotate((i % 2 ? -0.12 : 0.12) + Math.sin(t * 0.4 + i) * 0.04);
        ctx.fillStyle = "rgba(110,80,150,0.5)";
        ctx.fillRect(-16, -9, 32, 18);
        ctx.fillStyle = "rgba(230,205,255,0.22)";
        ctx.fillRect(-13, -6, 26, 2);
        ctx.restore();
      }
    }

    // horizon haze
    const haze = ctx.createLinearGradient(0, 300, 0, 438);
    haze.addColorStop(0, "rgba(255,236,214,0)");
    haze.addColorStop(0.72, rgba(biome.tint, 0.16));
    haze.addColorStop(1, rgba(biome.tint, 0.3));
    ctx.fillStyle = haze;
    ctx.fillRect(0, 300, VIEW_W, 138);
  }

  drawDynamicProps(ctx, game, t) {
    const room = game.room;
    const biome = BIOMES[room.biome];

    // unbroken star jars
    for (const jar of room.breakables) {
      if (!jar.broken) this.drawJar(ctx, jar, biome);
    }

    // pedestal offerings
    for (const p of room.pedestals) {
      if (p.sold || !p.item) continue;
      const iconSrc = p.item.icon.startsWith("../../") ? p.item.icon : ICON_BASE + p.item.icon + ".webp";
      const icon = loadImage(iconSrc);
      const bob = Math.sin(t * 2 + p.bob) * 4;
      ctx.save();
      ctx.translate(p.x, p.y - 72 + bob);
      const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 32);
      glow.addColorStop(0, "rgba(255,233,180,0.5)");
      glow.addColorStop(1, "rgba(255,233,180,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 32, 0, TAU);
      ctx.fill();
      if (icon && icon.complete && icon.naturalWidth) {
        ctx.drawImage(icon, -19, -19, 38, 38);
      } else {
        ctx.fillStyle = "#ffe9b0";
        star(ctx, 0, 0, 15, 4, "#ffe9b0");
      }
      ctx.fillStyle = "rgba(255,246,226,0.92)";
      ctx.fillStyle = "rgba(23,14,33,0.66)";
      roundedRect(ctx, -46, 26, 92, 34, 8);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,236,200,0.18)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,246,226,0.94)";
      ctx.font = "600 11px 'Noto Serif SC','STSong',serif";
      ctx.textAlign = "center";
      ctx.fillText(p.item.name, 0, 39);
      ctx.fillStyle = "rgba(255,214,144,0.9)";
      ctx.font = "700 9px 'Cascadia Mono',monospace";
      ctx.fillText("✦ " + p.item.price, 0, 53);
      ctx.textAlign = "left";
      ctx.restore();
    }

    // campfire flame
    if (room.fire) {
      const f = room.fire;
      const flicker = 0.8 + Math.sin(t * 13) * 0.12 + Math.sin(t * 7.3) * 0.08;
      ctx.save();
      ctx.translate(f.x, f.y - 6);
      const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 86);
      glow.addColorStop(0, "rgba(255,196,120,0.4)");
      glow.addColorStop(1, "rgba(255,196,120,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 86, 0, TAU);
      ctx.fill();
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i === 0 ? "rgba(255,206,120,0.9)" : i === 1 ? "rgba(255,154,96,0.8)" : "rgba(255,244,196,0.8)";
        ctx.beginPath();
        ctx.moveTo(-11 + i * 3, 0);
        ctx.quadraticCurveTo(-5 + i * 4, -22 * flicker, 2 + i * 2, -42 * flicker);
        ctx.quadraticCurveTo(12 - i * 3, -18 * flicker, 10 - i * 2, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // elite seal pulse
    if (room.type === "elite") {
      ctx.save();
      ctx.strokeStyle = "rgba(255,160,170," + (0.16 + Math.sin(t * 2) * 0.08) + ")";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(room.w * 0.5, FLOOR_Y - 2, 220 + Math.sin(t * 2) * 8, 17, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // boss phase aura
    if (room.boss && !room.boss.dead) {
      const boss = room.boss;
      if (boss.phase >= 2) {
        ctx.save();
        const glow = ctx.createRadialGradient(boss.x, boss.y - 70, 10, boss.x, boss.y - 70, 120);
        glow.addColorStop(0, rgba(boss.color || "#ff9aa8", 0.18));
        glow.addColorStop(1, rgba(boss.color || "#ff9aa8", 0));
        ctx.fillStyle = glow;
        ctx.fillRect(boss.x - 120, boss.y - 190, 240, 240);
        ctx.restore();
      }
    }

    // door
    if (room.door.open) {
      const d = room.door;
      const pulse = 0.55 + Math.sin(t * 3) * 0.15;
      ctx.save();
      ctx.translate(d.x + d.w / 2, d.y + d.h / 2);
      const glow = ctx.createRadialGradient(0, 0, 3, 0, 0, 84);
      glow.addColorStop(0, "rgba(255,236,188," + pulse + ")");
      glow.addColorStop(1, "rgba(255,210,150,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 84, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  drawDoor(ctx, room, t) {
    const d = room.door;
    ctx.save();
    ctx.translate(d.x, d.y);
    // arch frame
    ctx.fillStyle = "rgba(36,22,46,0.42)";
    ctx.beginPath();
    ctx.moveTo(-8, d.h + 4);
    ctx.lineTo(-8, 30);
    ctx.arc(d.w / 2, 30, d.w / 2 + 8, Math.PI, TAU);
    ctx.lineTo(d.w + 8, d.h + 4);
    ctx.closePath();
    ctx.fill();
    // door body
    const g = ctx.createLinearGradient(0, 0, 0, d.h);
    g.addColorStop(0, room.door.open ? "#ffe3a8" : "#6f5574");
    g.addColorStop(1, room.door.open ? "#f6b972" : "#3f2e4a");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, d.h);
    ctx.lineTo(0, 30);
    ctx.arc(d.w / 2, 30, d.w / 2, Math.PI, TAU);
    ctx.lineTo(d.w, d.h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = room.door.open ? "rgba(255,248,220,0.8)" : "rgba(231,196,140,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(d.w / 2, 0);
    ctx.lineTo(d.w / 2, d.h);
    ctx.stroke();
    // star lock
    ctx.fillStyle = room.door.open ? "#fff6d8" : "rgba(255,220,150,0.85)";
    star(ctx, d.w / 2, d.h * 0.55, doorOpenPulse(room, t), 4, room.door.open ? "#fff6d8" : "rgba(255,220,150,0.9)");
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(4, 50, 2, d.h - 60);
    ctx.restore();
  }

  drawShadows(ctx, game) {
    for (const enemy of game.enemies) {
      if (enemy.dead) continue;
      const ground = enemy.shadowY ?? FLOOR_Y;
      const lift = Math.max(0, ground - enemy.y);
      const alpha = clamp(0.24 - lift / 900, 0.06, 0.24);
      const scale = clamp(1 - lift / 900, 0.4, 1);
      ctx.fillStyle = "rgba(24,12,30," + alpha + ")";
      ctx.beginPath();
      ctx.ellipse(enemy.x, ground + 2, (enemy.def ? enemy.def.hitbox[0] : 30) * 0.55 * scale, 5.2 * scale, 0, 0, TAU);
      ctx.fill();
    }
    const p = game.player;
    if (p && !p.dead) {
      const ground = p.shadowY ?? FLOOR_Y;
      const lift = Math.max(0, ground - p.y);
      const alpha = clamp(0.3 - lift / 820, 0.08, 0.3);
      const scale = clamp(1 - lift / 900, 0.45, 1);
      ctx.fillStyle = "rgba(24,12,30," + alpha + ")";
      ctx.beginPath();
      ctx.ellipse(p.x, ground + 2, 20 * scale, 5.5 * scale, 0, 0, TAU);
      ctx.fill();
      // soft player spotlight
      const glow = ctx.createRadialGradient(p.x, ground, 2, p.x, ground, 68);
      glow.addColorStop(0, "rgba(255,232,184,0.12)");
      glow.addColorStop(1, "rgba(255,232,184,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(p.x, ground, 68, 18, 0, 0, TAU);
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------- FX frame
  drawFX(game, t) {
    const ctx = this.fxCtx;
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    ctx.save();
    ctx.translate(game.camera.shakeX || 0, game.camera.shakeY || 0);
    ctx.translate(-Math.round(game.camera.x), 0);

    this.drawProjectiles(ctx, game, t);
    this.drawZones(ctx, game, t);
    this.drawPickups(ctx, game, t);
    this.drawFallbackEnemies(ctx, game, t);
    game.effects.drawWorld(ctx, t);
    this.drawHealthBars(ctx, game);
    game.effects.drawTexts(ctx, t);
    ctx.restore();

    this.drawForeground(ctx, game, t);
    game.effects.drawScreen(ctx, this);
    if (this.flash > 0) {
      ctx.fillStyle = withAlpha(this.flashColor, this.flash);
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    // vignette
    const vign = ctx.createRadialGradient(VIEW_W / 2, VIEW_H * 0.48, VIEW_H * 0.3, VIEW_W / 2, VIEW_H * 0.5, VIEW_H * 0.78);
    vign.addColorStop(0, "rgba(20,10,28,0)");
    vign.addColorStop(1, "rgba(20,10,28,0.32)");
    ctx.fillStyle = vign;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  drawForeground(ctx, game, t) {
    const room = game.room;
    if (!room) return;
    const biome = BIOMES[room.biome];
    // grass fringe in front of the cast's feet
    ctx.save();
    ctx.translate(-Math.round(game.camera.x), 0);
    for (let x = Math.floor(game.camera.x / 14) * 14; x < game.camera.x + VIEW_W + 36; x += 14) {
      const seed = (x * 9301 + 49297) % 233280 / 233280;
      if (seed < 0.26) continue;
      const h = 6 + seed * 16;
      ctx.strokeStyle = withAlpha(biome.platformMoss, 0.46 + seed * 0.2);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, FLOOR_Y + 2);
      ctx.quadraticCurveTo(x + 3, FLOOR_Y - h * 0.6, x + 5 + seed * 6, FLOOR_Y - h);
      ctx.stroke();
      if (seed > 0.82) {
        ctx.strokeStyle = withAlpha(biome.platformMoss, 0.3);
        ctx.beginPath();
        ctx.moveTo(x + 4, FLOOR_Y + 2);
        ctx.quadraticCurveTo(x + 9, FLOOR_Y - h * 0.5, x + 12 + seed * 3, FLOOR_Y - h * 0.8);
        ctx.stroke();
      }
    }
    // a few foreground flowers peeking over the ground line
    for (let x = Math.floor(game.camera.x / 210) * 210; x < game.camera.x + VIEW_W + 100; x += 210) {
      const seed = ((x * 17) % 97) / 97;
      if (seed < 0.4) continue;
      const fx = x + seed * 60;
      ctx.strokeStyle = withAlpha(biome.platformMoss, 0.42);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(fx, FLOOR_Y + 1);
      ctx.lineTo(fx + 1, FLOOR_Y - 15 - seed * 8);
      ctx.stroke();
      flower(ctx, fx + 1, FLOOR_Y - 16 - seed * 8, 2.5 + seed, biome.platformFlower[Math.floor(seed * 3) % 3]);
    }
    ctx.restore();

    // ambient weather
    const count = room.biome === 2 ? 26 : 20;
    for (let i = 0; i < count; i++) {
      const speed = room.biome === 0 ? 10 + (i % 5) * 3 : room.biome === 1 ? 6 + (i % 4) * 2 : 8 + (i % 6) * 2;
      const x = ((i * 131 + t * speed - game.camera.x * 0.24) % (VIEW_W + 80)) - 40;
      const y = 70 + ((i * 61 + t * (12 + (i % 4) * 4)) % (VIEW_H - 60));
      ctx.save();
      if (room.biome === 0) {
        ctx.translate(x, y);
        ctx.rotate(t * 0.3 + i);
        ctx.fillStyle = "rgba(255,200,214," + (0.32 + (i % 3) * 0.1) + ")";
        ctx.beginPath();
        ctx.ellipse(0, 0, 3.2, 1.8, 0, 0, TAU);
        ctx.fill();
      } else if (room.biome === 1) {
        const a = 0.22 + Math.abs(Math.sin(t + i)) * 0.35;
        ctx.fillStyle = "rgba(180,224,255," + a + ")";
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, TAU);
        ctx.fill();
      } else {
        ctx.translate(x, y);
        ctx.rotate(Math.sin(t * 0.4 + i) * 0.7);
        ctx.fillStyle = "rgba(236,215,255," + (0.25 + (i % 4) * 0.06) + ")";
        ctx.fillRect(-3, -2, 6, 4);
      }
      ctx.restore();
    }
  }

  drawProjectiles(ctx, game, t) {
    for (const p of game.projectiles) {
      const x = p.x;
      const y = p.y;
      ctx.save();
      if (p.owner === "player") {
        const color = p.color || "#ffe9a8";
        const glow = ctx.createRadialGradient(x, y, 1, x, y, p.radius * 4.2);
        glow.addColorStop(0, rgba(color, 0.72));
        glow.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, p.radius * 4.2, 0, TAU);
        ctx.fill();
        if (p.kind === "flask") {
          ctx.fillStyle = "#e9c7ff";
          ctx.beginPath();
          ctx.arc(x, y, p.radius, 0, TAU);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.beginPath();
          ctx.arc(x - 2, y - 2, p.radius * 0.4, 0, TAU);
          ctx.fill();
        } else if (p.kind === "wind") {
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(x, y, p.radius + 4, -0.7, 0.7);
          ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,0.7)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, p.radius, -0.8, 0.8);
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          star(ctx, x, y, p.radius + 2, 4, color);
        }
      } else {
        const color = p.color || "#ff9aad";
        const glow = ctx.createRadialGradient(x, y, 1, x, y, p.radius * 4.6);
        glow.addColorStop(0, rgba(color, 0.55));
        glow.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, p.radius * 4.6, 0, TAU);
        ctx.fill();
        ctx.fillStyle = color;
        if (p.kind === "seed") {
          ctx.beginPath();
          ctx.ellipse(x, y, p.radius, p.radius * 0.65, p.angle || 0, 0, TAU);
          ctx.fill();
          ctx.fillStyle = "rgba(255,244,218,0.8)";
          ctx.fillRect(x - 1, y - p.radius - 3, 1.5, 4);
        } else if (p.kind === "wave") {
          ctx.strokeStyle = color;
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.moveTo(x - p.radius, y + 4);
          ctx.quadraticCurveTo(x, y - 16, x + p.radius, y + 4);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, p.radius, 0, TAU);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.beginPath();
          ctx.arc(x - p.radius * 0.3, y - p.radius * 0.3, p.radius * 0.35, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  drawZones(ctx, game, t) {
    for (const zone of game.zones) {
      if (zone.life <= 0) continue;
      const p = clamp(zone.life / zone.maxLife, 0, 1);
      ctx.save();
      const glow = ctx.createRadialGradient(zone.x, zone.y - 6, 4, zone.x, zone.y - 6, zone.r);
      glow.addColorStop(0, rgba(zone.color, 0.2 * p));
      glow.addColorStop(0.7, rgba(zone.color, 0.09 * p));
      glow.addColorStop(1, rgba(zone.color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(zone.x, zone.y - 4, zone.r, zone.r * 0.34, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = rgba(zone.color, 0.35 * p);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(zone.x, zone.y - 4, zone.r * (0.9 + Math.sin(t * 3) * 0.03), zone.r * 0.31, 0, 0, TAU);
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const a = t * 0.8 + i * 1.7;
        const bx = zone.x + Math.cos(a) * zone.r * 0.55;
        const by = zone.y - 10 + Math.sin(a * 1.3) * 14;
        ctx.fillStyle = rgba(zone.color, 0.5 * p);
        ctx.beginPath();
        ctx.arc(bx, by, 2.2, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawFallbackEnemies(ctx, game, t) {
    for (const enemy of game.enemies) {
      if (enemy.dead || enemy.handle || !enemy.fallback) continue;
      const color = enemy.def.color || ELEMENTS[enemy.def.element].color;
      const h = enemy.def.height || 44;
      ctx.save();
      ctx.globalAlpha = enemy.spawnT > 0 ? 0.35 : 1;
      ctx.fillStyle = "rgba(25,14,32,0.22)";
      ctx.beginPath();
      ctx.ellipse(enemy.x, enemy.y + 2, enemy.w * 0.7, 5, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(enemy.x, enemy.y - h * 0.5, enemy.w * 0.6, h * 0.5, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#fff8e8";
      ctx.beginPath();
      ctx.arc(enemy.x - enemy.w * 0.18, enemy.y - h * 0.62, 2.6, 0, TAU);
      ctx.arc(enemy.x + enemy.w * 0.18, enemy.y - h * 0.62, 2.6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#3b263f";
      ctx.beginPath();
      ctx.arc(enemy.x - enemy.w * 0.18, enemy.y - h * 0.62, 1.2, 0, TAU);
      ctx.arc(enemy.x + enemy.w * 0.18, enemy.y - h * 0.62, 1.2, 0, TAU);
      ctx.fill();
      ctx.restore();
      void t;
    }
  }

  drawPickups(ctx, game, t) {    for (const pickup of game.pickups) {
      const bob = Math.sin(t * 4 + pickup.phase) * 2.5;
      ctx.save();
      ctx.translate(pickup.x, pickup.y + bob);
      if (pickup.type === "heart") {
        const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 18);
        glow.addColorStop(0, "rgba(255,150,180,0.45)");
        glow.addColorStop(1, "rgba(255,150,180,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(0, 0, 18, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "#ff8fae";
        ctx.beginPath();
        ctx.moveTo(0, 6);
        ctx.bezierCurveTo(-12, -3, -6, -12, 0, -5);
        ctx.bezierCurveTo(6, -12, 12, -3, 0, 6);
        ctx.fill();
      } else {
        const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 16);
        glow.addColorStop(0, "rgba(255,220,140,0.5)");
        glow.addColorStop(1, "rgba(255,220,140,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(0, 0, 16, 0, TAU);
        ctx.fill();
        star(ctx, 0, 0, pickup.value > 3 ? 6 : 4.6, 4, "#ffe6a5");
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.beginPath();
        ctx.arc(-1, -1, 1.2, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawHealthBars(ctx, game) {
    for (const enemy of game.enemies) {
      if (enemy.dead) continue;
      if (enemy.isBoss) continue;
      if (enemy.elite) {
        ctx.save();
        const radius = 52 + Math.sin(performance.now() * 0.004 + enemy.seed) * 4;
        const glow = ctx.createRadialGradient(enemy.x, enemy.y - 20, 4, enemy.x, enemy.y - 20, radius);
        glow.addColorStop(0, "rgba(255,176,120,0.16)");
        glow.addColorStop(1, "rgba(255,176,120,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.ellipse(enemy.x, enemy.y - 18, radius * 0.8, radius, 0, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,196,140,0.34)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(enemy.x, enemy.y - 2, 34, 6, 0, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
      if (enemy.hp >= enemy.maxHp && !enemy.elite) continue;
      const width = enemy.elite ? 48 : 34;
      const x = enemy.x - width / 2;
      const y = enemy.y - (enemy.def ? enemy.def.height : 50) - 14;
      ctx.fillStyle = "rgba(18,10,24,0.58)";
      roundedRect(ctx, x - 1, y - 1, width + 2, 5, 2.5);
      ctx.fill();
      const pct = clamp(enemy.hp / enemy.maxHp, 0, 1);
      ctx.fillStyle = enemy.elite ? "#ffb86b" : "#ff8aa2";
      roundedRect(ctx, x, y, width * pct, 3, 1.5);
      ctx.fill();
    }
  }
}

function doorOpenPulse(room, t) {
  return room.door.open ? 7 + Math.sin(t * 4) * 1.4 : 5;
}

function mulberryRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- effects
export class Effects {
  constructor() {
    this.particles = [];
    this.texts = [];
    this.arcs = [];
    this.rings = [];
    this.beams = [];
    this.warnings = [];
    this.screen = [];
    this.pool = 460;
  }

  clear() {
    this.particles.length = 0;
    this.texts.length = 0;
    this.arcs.length = 0;
    this.rings.length = 0;
    this.beams.length = 0;
    this.warnings.length = 0;
    this.screen.length = 0;
  }

  burst(x, y, { count = 10, colors = ["#ffe9a8"], speed = 140, life = 0.55, size = 2.4, gravity = 260, spread = TAU, angle = 0, kind = "dot", drag = 0.9 } = {}) {
    if (this.particles.length > this.pool) return;
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = speed * (0.35 + Math.random() * 0.85);
      this.particles.push({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: life * (0.6 + Math.random() * 0.6),
        maxLife: life,
        size: size * (0.5 + Math.random()),
        color: colors[Math.floor(Math.random() * colors.length)],
        gravity,
        kind,
        rot: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 12,
        drag
      });
    }
  }

  slash(x, y, facing, color, size = 1, flip = 0) {
    this.arcs.push({ x, y, facing, color, size, life: 0.18, maxLife: 0.18, flip });
  }

  ring(x, y, color, radius = 30, life = 0.36, width = 3) {
    this.rings.push({ x, y, color, radius, life, maxLife: life, width });
  }

  beam(x1, y1, x2, y2, color, life = 0.22, width = 5) {
    this.beams.push({ x1, y1, x2, y2, color, life, maxLife: life, width });
  }

  text(x, y, text, { color = "#fff6e4", size = 12, life = 0.8, vy = -46, crit = false } = {}) {
    this.texts.push({ x, y, text: String(text), color, size, life, maxLife: life, vy, crit });
  }

  warning(x, y, w, h, life = 0.7, kind = "rect") {
    this.warnings.push({ x, y, w, h, life, maxLife: life, kind });
  }

  flashScreen(alpha = 0.24, color = "#fff") {
    this.screen.push({ alpha, color, life: 0.22, maxLife: 0.22 });
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      p.vx *= Math.pow(p.drag, dt * 60);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dt;
      t.y += t.vy * dt;
      t.vy *= Math.pow(0.88, dt * 60);
      if (t.life <= 0) this.texts.splice(i, 1);
    }
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.life -= dt;
      if (a.life <= 0) this.arcs.splice(i, 1);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      if (r.life <= 0) this.rings.splice(i, 1);
    }
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt;
      if (b.life <= 0) this.beams.splice(i, 1);
    }
    for (let i = this.warnings.length - 1; i >= 0; i--) {
      const w = this.warnings[i];
      w.life -= dt;
      if (w.life <= 0) this.warnings.splice(i, 1);
    }
    for (let i = this.screen.length - 1; i >= 0; i--) {
      const s = this.screen[i];
      s.life -= dt;
      if (s.life <= 0) this.screen.splice(i, 1);
    }
  }

  drawWorld(ctx, t) {
    // warnings under actors
    for (const w of this.warnings) {
      const p = clamp(w.life / w.maxLife, 0, 1);
      ctx.save();
      if (w.kind === "circle") {
        ctx.strokeStyle = "rgba(255,122,130," + (0.4 + (1 - p) * 0.4) + ")";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.w * (1.08 - p * 0.18), 0, TAU);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,120,130,0.1)";
        ctx.fill();
      } else {
        ctx.fillStyle = "rgba(255,122,130," + (0.1 + (1 - p) * 0.14) + ")";
        ctx.fillRect(w.x - w.w / 2, w.y - w.h, w.w, w.h);
        ctx.strokeStyle = "rgba(255,150,150," + (0.4 + (1 - p) * 0.4) + ")";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(w.x - w.w / 2, w.y - w.h, w.w, w.h);
      }
      ctx.restore();
    }

    for (const p of this.particles) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.kind === "star") {
        star(ctx, 0, 0, p.size * 1.5, 4, p.color);
      } else if (p.kind === "petal") {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size * 1.7, p.size * 0.8, 0, 0, TAU);
        ctx.fill();
      } else if (p.kind === "ring") {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, p.size * (1.4 - a * 0.4), 0, TAU);
        ctx.stroke();
      } else if (p.kind === "page") {
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size * 1.5, -p.size, p.size * 3, p.size * 2);
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.size, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    for (const ring of this.rings) {
      const p = clamp(ring.life / ring.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = p * 0.8;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = ring.width * p;
      ctx.beginPath();
      ctx.ellipse(ring.x, ring.y, ring.radius * (1.3 - p * 0.6), ring.radius * 0.42 * (1.3 - p * 0.6), 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    for (const beam of this.beams) {
      const p = clamp(beam.life / beam.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = p;
      ctx.strokeStyle = beam.color;
      ctx.lineWidth = beam.width * p;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(beam.x1, beam.y1);
      ctx.lineTo(beam.x2, beam.y2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = Math.max(1, beam.width * p * 0.3);
      ctx.stroke();
      ctx.restore();
    }

    for (const arc of this.arcs) {
      const p = clamp(arc.life / arc.maxLife, 0, 1);
      const grow = 1.25 - p * 0.45;
      ctx.save();
      ctx.translate(arc.x, arc.y);
      ctx.scale(arc.facing, 1);
      ctx.globalAlpha = p;
      ctx.lineCap = "round";
      const radius = 48 * arc.size * grow;
      const grad = ctx.createLinearGradient(0, -radius, radius, radius);
      grad.addColorStop(0, "rgba(255,255,255,0.9)");
      grad.addColorStop(0.45, arc.color);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 8 * arc.size * p;
      ctx.beginPath();
      ctx.arc(0, 0, radius, -1.02, 0.92);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 2 * arc.size * p;
      ctx.beginPath();
      ctx.arc(0, 0, radius - 4, -0.9, 0.8);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawTexts(ctx, t) {
    for (const text of this.texts) {
      const p = clamp(text.life / text.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = Math.min(1, p * 1.8);
      ctx.font = "700 " + text.size + "px 'Noto Serif SC','STSong',serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(42,20,40,0.7)";
      ctx.strokeText(text.text, text.x, text.y);
      ctx.fillStyle = text.color;
      ctx.fillText(text.text, text.x, text.y);
      ctx.restore();
    }
  }

  drawScreen(ctx, renderer) {
    for (const s of this.screen) {
      const p = clamp(s.life / s.maxLife, 0, 1);
      ctx.fillStyle = withAlpha(s.color, s.alpha * p);
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
  }
}
