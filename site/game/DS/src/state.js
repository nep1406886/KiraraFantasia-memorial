// ============================================================
// 全局运行时状态
// ============================================================
import { RANKS, RANK_MAX } from './config.js';

export const G = {
  mode: 'boot',              // boot/title/hub/select/playing/reward/next/shop/rest/event/pause/result/codex/upgrades/settings/help
  time: 0,
  runTime: 0,
  dt: 0,
  frame: 0,

  run: null,
  room: null,
  player: null,
  enemies: [],
  projectiles: [],
  pickups: [],
  zones: [],
  hazards: [],
  boss: null,

  cam: { x: 0, y: 0, trauma: 0, look: 0 },
  style: { value: 0, rank: 0, combo: 0, comboT: 0, hitT: 0, mult: 1, best: 0 },
  hitstop: 0,
  slowmo: 0,
  slowScale: 1,
  flash: null,
  banner: null,
  interrupt: null,

  paused: false,
  result: null,
  transition: null,
  tutorial: null,
  debug: false,
  lastRoomChoice: null,
};

export function rankFor(value) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (value >= RANKS[i].min) idx = i;
  return idx;
}
export function updateStyle(dt) {
  const s = G.style;
  if (s.comboT > 0) s.comboT -= dt;
  if (s.comboT <= 0 && s.combo > 0) { s.combo = 0; }
  if (s.hitT > 0) s.hitT -= dt;
  const idle = s.hitT <= 0;
  if (idle && s.value > 0) {
    const stats = G.run && G.run.stats;
    // 衰减随档位爬升：高档位是紧绷的走钢丝，低档位留喘息
    const decay = (26 + s.rank * 5) * (1 + (stats?.styleDecay || 0));
    s.value = Math.max(0, s.value - decay * dt);
  }
  s.rank = rankFor(s.value);
  s.mult = RANKS[s.rank].mul;
  if (s.value > s.best) s.best = s.value;
}
export function addStyle(amount) {
  const stats = G.run && G.run.stats;
  // 连击越久喝彩涨得越快：奖励持续演出，上限 +50%
  const comboBoost = 1 + Math.min(G.style.combo, 50) / 100;
  const gain = amount * comboBoost * (1 + (stats?.applause || 0));
  G.style.value = Math.min(RANK_MAX, G.style.value + gain);
  G.style.hitT = 2.6;
  G.style.rank = rankFor(G.style.value);
  G.style.mult = RANKS[G.style.rank].mul;
}
export function loseStyle(frac = .22) {
  G.style.value = Math.max(0, G.style.value * (1 - frac));
  G.style.combo = 0;
  G.style.comboT = 0;
  G.style.rank = rankFor(G.style.value);
  G.style.mult = RANKS[G.style.rank].mul;
}
export function activeMember() {
  if (!G.run) return null;
  return G.run.team[G.run.active] || null;
}
export function memberById(id) {
  if (!G.run) return null;
  return G.run.team.find((m) => m.id === id) || null;
}
export function resetStyle() {
  G.style.value = 0;
  G.style.rank = 0;
  G.style.combo = 0;
  G.style.comboT = 0;
  G.style.hitT = 0;
  G.style.mult = 1;
  G.style.best = 0;
}
export function clearCombat() {
  G.enemies.length = 0;
  G.projectiles.length = 0;
  G.pickups.length = 0;
  G.zones.length = 0;
  G.hazards.length = 0;
  G.boss = null;
  G.hitstop = 0;
  G.slowmo = 0;
  G.flash = null;
  G.banner = null;
  G.interrupt = null;
}
