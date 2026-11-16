// Persistent player profile: meta currency, star-map upgrades, settings, best
// run and one room-boundary checkpoint. Everything is versioned; an unknown
// shape is discarded rather than half-migrated.

import { SAVE_KEY, META_UPGRADES } from "./config.js";

const DEFAULT_SETTINGS = { bgm: 0.55, sfx: 0.68, reducedMotion: false };

function blankMeta() {
  const upgrades = {};
  META_UPGRADES.forEach(u => { upgrades[u.id] = 0; });
  return { starlight: 0, upgrades, runs: 0, wins: 0, best: null };
}

function blank() {
  return {
    version: 1,
    meta: blankMeta(),
    settings: { ...DEFAULT_SETTINGS },
    run: null
  };
}

function clamp01(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function sanitize(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1) return blank();
  const save = blank();
  const meta = raw.meta && typeof raw.meta === "object" ? raw.meta : {};
  save.meta.starlight = Math.max(0, Math.floor(Number(meta.starlight) || 0));
  save.meta.runs = Math.max(0, Math.floor(Number(meta.runs) || 0));
  save.meta.wins = Math.max(0, Math.floor(Number(meta.wins) || 0));
  META_UPGRADES.forEach(u => {
    const level = Math.floor(Number(meta.upgrades && meta.upgrades[u.id]) || 0);
    save.meta.upgrades[u.id] = Math.max(0, Math.min(u.max, level));
  });
  if (meta.best && typeof meta.best === "object") {
    save.meta.best = {
      act: Math.max(0, Math.floor(Number(meta.best.act) || 0)),
      room: Math.max(0, Math.floor(Number(meta.best.room) || 0)),
      kills: Math.max(0, Math.floor(Number(meta.best.kills) || 0)),
      time: Math.max(0, Number(meta.best.time) || 0),
      win: !!meta.best.win,
      character: typeof meta.best.character === "string" ? meta.best.character : null
    };
  }
  const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  save.settings.bgm = clamp01(settings.bgm, DEFAULT_SETTINGS.bgm);
  save.settings.sfx = clamp01(settings.sfx, DEFAULT_SETTINGS.sfx);
  save.settings.reducedMotion = !!settings.reducedMotion;
  if (raw.run && raw.run.checkpoint) save.run = raw.run;
  return save;
}

export function loadSave() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
    return sanitize(raw);
  } catch (error) {
    console.warn("starfall save ignored:", error);
    return blank();
  }
}

export function writeSave(save) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch (error) {
    console.warn("starfall save failed:", error);
    return false;
  }
}

export function resetSave(save) {
  const settings = save && save.settings ? { ...save.settings } : { ...DEFAULT_SETTINGS };
  const fresh = blank();
  fresh.settings = settings;
  return fresh;
}

export function upgradeLevel(save, id) {
  return Math.max(0, Math.floor(Number(save.meta.upgrades[id]) || 0));
}

export function upgradeCost(save, id) {
  const def = META_UPGRADES.find(u => u.id === id);
  if (!def) return Infinity;
  const level = upgradeLevel(save, id);
  if (level >= def.max) return null;
  return def.costs[level];
}

export function buyUpgrade(save, id) {
  const def = META_UPGRADES.find(u => u.id === id);
  if (!def) return { ok: false, reason: "missing" };
  const level = upgradeLevel(save, id);
  if (level >= def.max) return { ok: false, reason: "max" };
  const cost = def.costs[level];
  if (save.meta.starlight < cost) return { ok: false, reason: "poor", cost };
  save.meta.starlight -= cost;
  save.meta.upgrades[id] = level + 1;
  writeSave(save);
  return { ok: true, level: level + 1, cost, def };
}

export function metaBonuses(save) {
  const level = id => upgradeLevel(save, id);
  return {
    maxHp: level("vitality") * 16,
    atk: 1 + level("edge") * 0.07,
    speed: 1 + level("stride") * 0.02,
    dashCd: 1 - level("stride") * 0.05,
    startDust: level("fortune") * 25,
    revives: level("ember")
  };
}

export function recordRun(save, { act = 0, room = 0, kills = 0, time = 0, win = false, character = null }, starlight = 0) {
  save.meta.runs += 1;
  if (win) save.meta.wins += 1;
  save.meta.starlight += Math.max(0, Math.floor(starlight));
  const best = save.meta.best;
  const score = act * 100 + room + (win ? 10000 : 0);
  const oldScore = best ? best.act * 100 + best.room + (best.win ? 10000 : 0) : -1;
  if (score > oldScore) {
    save.meta.best = { act, room, kills, time, win, character };
  }
  writeSave(save);
}

export function stashRun(save, run) {
  save.run = run ? { checkpoint: true, ...run } : null;
  writeSave(save);
}

export function clearRun(save) {
  save.run = null;
  writeSave(save);
}
