// ============================================================
// 素材加载
// ============================================================
import { SCENES, ICONS, ELEMENTS, ROOT } from '../config.js';
import { CHARACTERS } from '../data/characters.js';
import { BOONS } from '../data/boons.js';

export const IMG = new Map();

export function getImg(src) {
  if (!src) return null;
  let im = IMG.get(src);
  if (!im) {
    im = new Image();
    im.decoding = 'async';
    im.src = src;
    IMG.set(src, im);
  }
  return im;
}
export const ready = (im) => !!(im && im.complete && im.naturalWidth > 0);

export function loadImg(src) {
  return new Promise((resolve) => {
    const im = getImg(src);
    if (im.complete) { resolve(im); return; }
    im.addEventListener('load', () => resolve(im), { once: true });
    im.addEventListener('error', () => resolve(im), { once: true });
  });
}

export function preloadList(list, onProgress) {
  const unique = [...new Set(list.filter(Boolean))];
  let done = 0;
  return new Promise((resolve) => {
    if (!unique.length) { resolve(); return; }
    const tick = () => {
      done++;
      if (onProgress) onProgress(done / unique.length);
      if (done >= unique.length) resolve();
    };
    for (const src of unique) {
      const im = getImg(src);
      if (im.complete) tick();
      else {
        im.addEventListener('load', tick, { once: true });
        im.addEventListener('error', tick, { once: true });
      }
    }
  });
}

export function preloadAssets(onProgress) {
  const list = [
    ...Object.values(SCENES),
    ...Object.values(ICONS),
    ...ELEMENTS.map((e) => e.icon),
    ...CHARACTERS.map((c) => c.stand),
    ...BOONS.map((b) => b.art),
    ROOT + 'asset/img/rl/drop/star.webp',
    ROOT + 'asset/img/rl/ui/scene_field.webp',
  ];
  return preloadList(list, onProgress);
}

// 画布 cover 绘制
export function drawCover(ctx, img, x, y, w, h, ox = 0, oy = 0, scale = 1) {
  if (!ready(img)) return;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const s = Math.max(w / iw, h / ih) * scale;
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2 + ox, y + (h - dh) / 2 + oy, dw, dh);
}

export function drawContain(ctx, img, cx, bottom, h) {
  if (!ready(img)) return;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const w = (iw / ih) * h;
  ctx.drawImage(img, cx - w / 2, bottom - h, w, h);
}

// 预生成暗色剪影（用于登场、预告轮廓）
const silhouetteCache = new Map();
export function silhouette(src, color = '#000', alpha = 1) {
  const key = src + color + alpha;
  if (silhouetteCache.has(key)) return silhouetteCache.get(key);
  const im = getImg(src);
  if (!ready(im)) return null;
  const c = document.createElement('canvas');
  c.width = im.naturalWidth;
  c.height = im.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.globalAlpha = alpha;
  g.fillRect(0, 0, c.width, c.height);
  silhouetteCache.set(key, c);
  return c;
}
