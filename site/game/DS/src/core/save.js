// ============================================================
// 存档：掌声、解锁、永久强化、设置
// ============================================================
import { SAVE_KEY, DEFAULT_SETTINGS } from '../config.js';
import { CHARACTERS, STARTERS } from '../data/characters.js';
import { UPGRADES } from '../data/acts.js';

const DEFAULT = {
  version: 1,
  applause: 0,
  best: 0,
  runs: 0,
  wins: 0,
  unlocked: [...STARTERS],
  upgrades: {},
  seenBoon: [],
  lastResult: null,
  settings: { ...DEFAULT_SETTINGS },
};

let state = null;

function merge(base, data) {
  // 存档可能是损坏 JSON / 数组 / 数字等，全部按空档处理，不让一次脏数据炸掉启动
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const out = { ...base, ...d };
  out.unlocked = [...new Set([...STARTERS, ...(Array.isArray(d.unlocked) ? d.unlocked.filter((x) => typeof x === 'string') : [])])];
  out.upgrades = d.upgrades && typeof d.upgrades === 'object' && !Array.isArray(d.upgrades) ? { ...d.upgrades } : {};
  out.seenBoon = Array.isArray(d.seenBoon) ? [...new Set(d.seenBoon.filter((x) => typeof x === 'string'))] : [];
  const st = { ...DEFAULT_SETTINGS, ...(d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings) ? d.settings : {}) };
  for (const k of ['music', 'sfx']) {
    const v = Number(st[k]);
    st[k] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_SETTINGS[k];
  }
  for (const k of ['shake', 'damage', 'lowfx', 'touch', 'touchAutoOff']) st[k] = !!st[k];
  out.settings = st;
  for (const k of ['applause', 'best', 'runs', 'wins']) {
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) && v >= 0 ? Math.floor(v) : base[k];
  }
  if (!out.lastResult || typeof out.lastResult !== 'object' || Array.isArray(out.lastResult)) out.lastResult = null;
  return out;
}

export const Save = {
  load() {
    if (state) return state;
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { raw = null; }
    state = merge(DEFAULT, raw);
    return state;
  },
  get data() { return this.load(); },
  save() {
    if (!state) return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  },
  reset() {
    state = merge(DEFAULT, null);
    this.save();
    return state;
  },
  addApplause(n) {
    state = this.load();
    state.applause = Math.max(0, Math.round(state.applause + n));
    this.save();
  },
  spend(n) {
    state = this.load();
    if (state.applause < n) return false;
    state.applause -= n;
    this.save();
    return true;
  },
  get unlocked() { return this.load().unlocked; },
  isUnlocked(id) { return this.load().unlocked.includes(id); },
  unlockCost(id) {
    const c = CHARACTERS.find((x) => x.id === id);
    return c ? c.unlock : 0;
  },
  unlockChar(id) {
    state = this.load();
    const c = CHARACTERS.find((x) => x.id === id);
    if (!c || state.unlocked.includes(id)) return false;
    if (state.applause < c.unlock) return false;
    state.applause -= c.unlock;
    state.unlocked.push(id);
    this.save();
    return true;
  },
  upgradeLevel(id) { return this.load().upgrades[id] || 0; },
  upgradeCost(id) {
    const u = UPGRADES.find((x) => x.id === id);
    if (!u) return 0;
    const lv = this.upgradeLevel(id);
    if (lv >= u.max) return Infinity;
    return u.costs[lv];
  },
  buyUpgrade(id) {
    state = this.load();
    const u = UPGRADES.find((x) => x.id === id);
    if (!u) return false;
    const lv = state.upgrades[id] || 0;
    if (lv >= u.max) return false;
    const cost = u.costs[lv];
    if (state.applause < cost) return false;
    state.applause -= cost;
    state.upgrades[id] = lv + 1;
    this.save();
    return true;
  },
  metaMods() {
    const u = this.load().upgrades;
    return {
      hp: (u.oil || 0) * 7,
      dmg: (u.script || 0) * .05,
      applause: (u.applause || 0) * .12,
      startShards: (u.dust || 0) * 35,
      revives: (u.revive || 0) > 0 ? 1 : 0,
      extraChoice: (u.program || 0) > 0 ? 1 : 0,
      freeBoon: (u.makeup || 0) > 0,
    };
  },
  recordRun(result) {
    state = this.load();
    const mods = this.metaMods();
    let gained = Math.round((result.score / 14 + result.rooms * 6 + result.bosses * 65 + (result.won ? 220 : 0)) * (1 + mods.applause));
    gained = Math.max(6, gained);
    state.applause += gained;
    state.runs += 1;
    if (result.won) state.wins += 1;
    if (gained > state.best) state.best = gained;
    const chars = result.team || [];
    for (const id of chars) {
      if (!state.unlocked.includes(id)) continue;
    }
    state.lastResult = {
      gained, won: !!result.won, act: result.act, score: result.score,
      kills: result.kills, time: result.time, team: chars,
      ts: Date.now(),
    };
    this.save();
    return gained;
  },
  markBoon(id) {
    state = this.load();
    if (!state.seenBoon.includes(id)) {
      state.seenBoon.push(id);
      this.save();
    }
  },
  setSetting(key, value) {
    state = this.load();
    state.settings[key] = value;
    this.save();
  },
  get settings() { return this.load().settings; },
};
