// ============================================================
// 战斗系统：伤害、属性、反应、弹幕、区域、掉落
// ============================================================
import { G, activeMember, addStyle, loseStyle } from './state.js';
import { FX } from './fx.js';
import { Audio } from './core/audio.js';
import { EL, REACTIONS, reactionOf, FONT_SERIF, FONT_EN } from './config.js';
import { clamp, rnd, rint, pick, dist, dist2, angleTo, TAU, hexA, chance, easeOutCubic } from './utils.js';

const DAMAGE_SCALE = 2.2;

export function nearestEnemy(x, y, maxDist = 900, filter = null) {
  let best = null;
  let bd = maxDist * maxDist;
  for (const e of G.enemies) {
    if (e.dead || e.spawning > 0) continue;
    if (filter && !filter(e)) continue;
    const d = dist2(x, y, e.x, e.y - e.h * .5);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
export function enemiesInRadius(x, y, r, filter = null) {
  const out = [];
  for (const e of G.enemies) {
    if (e.dead) continue;
    if (filter && !filter(e)) continue;
    if (dist(x, y, e.x, e.y - e.h * .5) <= r + e.w * .5) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 敌人受伤
// ---------------------------------------------------------------------------
export function damageEnemy(enemy, base, opt = {}) {
  if (!enemy || enemy.dead || enemy.spawning > 0) return 0;
  const stats = G.run ? G.run.stats : null;
  const active = activeMember();
  let dmg = base * DAMAGE_SCALE * G.style.mult;
  let crit = false;
  if (opt.canCrit !== false) {
    const critChance = .05 + (stats?.crit || 0);
    crit = chance(critChance + (opt.critBonus || 0));
    if (crit) dmg *= (1.5 + (stats?.critDmg || 0));
  }
  if (enemy.status?.armorBreak > 0) dmg *= 1.18;
  if (stats?.firstHit && enemy.hp >= enemy.maxHp) dmg *= 2;
  if (stats?.lowHpRage && active && active.hp / active.maxHp < .35) dmg *= 1.35;
  if (enemy.status?.freeze > 0 || enemy.status?.stun > 0) dmg *= 1.08;
  if (enemy.defense) dmg *= (1 - enemy.defense);
  dmg = Math.max(1, dmg);

  enemy.hp -= dmg;
  enemy.flash = crit ? .18 : .1;
  enemy.hitFrom = opt.fromX ?? (G.player ? G.player.x : enemy.x - 40);
  if (enemy.onHurt) enemy.onHurt(dmg, opt);
  // 受击击退：小体型飞得更远，精英只算轻碰，幕终主角稳如泰山
  if (opt.knock || opt.launch) {
    const mass = clamp(140 / (enemy.w + enemy.h), .22, 1) * (enemy.elite ? .38 : 1);
    if (opt.knock) enemy.vx += (enemy.x < enemy.hitFrom ? -1 : 1) * opt.knock * mass;
    if (opt.launch) enemy.vy += opt.launch * mass;
    enemy.hurtT = Math.max(enemy.hurtT || 0, .16);
  }
  if (G.run) G.run.score += dmg * .3;

  const color = opt.color || (opt.element ? EL[opt.element]?.color : '#f8e7bd');
  if (G.showDamage !== false) {
    FX.damageText(enemy.x + rnd(-12, 12), enemy.y - enemy.h * rnd(.55, .8), dmg, {
      crit, color: crit ? '#ffd166' : color,
    });
  }
  FX.spark(enemy.x + rnd(-enemy.w * .3, enemy.w * .3), enemy.y - enemy.h * .55, color || '#f8e7bd', crit ? 10 : 5, null, crit ? 420 : 240);
  if (crit) {
    FX.text(enemy.x, enemy.y - enemy.h - 24, '暴击', '#ffd166', { size: 17, life: .55, vy: -80 });
    Audio.sfx('crit');
    if (stats?.critStar) {
      const target = nearestEnemy(enemy.x, enemy.y - 40, 700, (e) => e !== enemy);
      if (target) {
        spawnPlayerProjectile({
          x: enemy.x, y: enemy.y - enemy.h * .6, target,
          dmg: active ? active.char.atk * .5 : 6, element: active?.char.element || 'sun',
          speed: 640, homing: 1, size: 10, type: 'star', color: '#ffe9b0',
        });
      }
    }
  } else {
    Audio.sfx(opt.heavy ? 'heavy' : 'hit', { volume: opt.heavy ? .8 : .55 });
  }
  // 命中停顿与震屏按伤害分级：0.02-0.08 定帧，越重的刀越沉
  const ratio = dmg / Math.max(1, enemy.maxHp);
  let hs = opt.hitstop ?? clamp(.02 + ratio * .55, .02, .055);
  if (crit) hs = Math.max(hs, .05);
  if (opt.heavy) hs = Math.max(hs, .045);
  FX.hitstop(Math.min(.08, hs));
  let sh = opt.shake ?? clamp(.05 + ratio * .8, .05, .28);
  if (crit) sh = Math.min(.42, sh + .1);
  FX.shake(sh);
  registerHit(enemy, opt);

  // 属性印记 / 反应
  const el = opt.element;
  if (el && EL[el]) {
    const prev = enemy.mark && enemy.mark.t > 0 ? enemy.mark.el : null;
    if (prev && prev !== el) {
      triggerReaction(enemy, prev, el, opt);
      enemy.mark = { el, t: 3.2 + (stats?.markDur || 0) };
    } else {
      enemy.mark = { el, t: 2.8 + (stats?.markDur || 0) };
    }
  }
  if (enemy.hp <= 0) {
    killEnemy(enemy, opt);
  }
  return dmg;
}

let comboEl = null;
// 连击数放大脉冲：直接打在现有 #hud-combo 上，ui.js 不参与
function pulseCombo(milestone) {
  if (!comboEl || !comboEl.isConnected) comboEl = document.getElementById('hud-combo');
  if (!comboEl) return;
  comboEl.classList.remove('pulse', 'pulse2');
  void comboEl.offsetWidth;
  comboEl.classList.add(milestone ? 'pulse2' : 'pulse');
}

export function registerHit(enemy, opt = {}) {
  if (!G.run) return;
  const styleGain = (opt.style ?? 7) * (enemy.elite || enemy.boss ? 1.4 : 1);
  const prevCombo = G.style.combo;
  G.style.combo += 1;
  G.style.comboT = 2.6;
  // 连击数出现、以及每 10 连的里程碑：HUD 放大脉冲
  if (G.style.combo >= 2 && (prevCombo < 2 || G.style.combo % 10 === 0)) {
    pulseCombo(G.style.combo % 10 === 0);
  }
  addStyle(styleGain);
  const member = activeMember();
  if (member) member.ult = Math.min(100, member.ult + (opt.ult ?? .55) * (1 + (G.run.stats?.ultGain || 0)));
}

export function killEnemy(enemy, opt = {}) {
  if (enemy.dead) return;
  enemy.dead = true;
  enemy.deathT = 0;
  if (enemy.boss) {
    for (const e of G.enemies) {
      if (e !== enemy && !e.dead) {
        e.dead = true;
        e.deathT = .55;
        FX.ink(e.x, e.y - e.h * .4, 8, e.def?.color || '#1a1420');
      }
    }
    // 幕终倒下的瞬间：清掉残余敌弹，谢幕间隙不再挨打
    G.projectiles.length = 0;
  }
  if (G.run) {
    G.run.kills += 1;
    G.run.score += enemy.elite ? 160 : enemy.boss ? 1200 : 28;
  }
  const m = activeMember();
  if (m) m.ult = Math.min(100, m.ult + (enemy.boss ? 24 : enemy.elite ? 10 : 2.2));
  addStyle(enemy.boss ? 80 : enemy.elite ? 34 : 8);
  Audio.sfx(enemy.boss ? 'death' : 'death', { volume: enemy.boss ? 1 : .4 });

  const col = EL[enemy.element]?.color || '#e8c47e';
  FX.ink(enemy.x, enemy.y - enemy.h * .45, enemy.boss ? 46 : enemy.elite ? 22 : 12, enemy.color || '#1a1420');
  FX.burst(enemy.x, enemy.y - enemy.h * .5, {
    count: enemy.boss ? 60 : enemy.elite ? 26 : 12,
    colors: [col, '#ffe9b0', '#e8c47e'], speed: enemy.boss ? 420 : 220, size: 4, life: .8, glow: true, shape: 'star', gravity: 260,
  });
  // 金星升腾：谢幕式的小点缀
  for (let i = 0; i < (enemy.boss ? 14 : enemy.elite ? 8 : 4); i++) {
    FX.p({
      x: enemy.x + rnd(-16, 16), y: enemy.y - enemy.h * .5 + rnd(-10, 10),
      vx: rnd(-90, 90), vy: rnd(-280, -100), life: rnd(.5, .9),
      size: rnd(2.4, 4.6), color: pick(['#ffe9b0', '#e8c47e']),
      glow: true, shape: 'star', gravity: 220, spin: 6,
    });
  }
  FX.ring(enemy.x, enemy.y - enemy.h * .45, enemy.boss ? 340 : enemy.w * 1.2, col, { life: .65, width: 3 });
  if (enemy.boss) {
    FX.flash('#fff8e8', .8, .9);
    FX.shake(.9);
    FX.slowmo(1.1, .25);
    FX.hitstop(.08);
  } else {
    // 击杀定帧：越大的敌人在最后一刀上停得越久
    FX.hitstop(enemy.elite ? .06 : .03);
    FX.shake(.12);
  }

  const stats = G.run?.stats;
  if (stats?.healOnKill) healTeam(stats.healOnKill, true);
  if (chance(enemy.boss ? 1 : enemy.elite ? .8 : .22)) {
    spawnShard(enemy.x, enemy.y - 30, enemy.boss ? 16 : enemy.elite ? 6 : rint(1, 2));
  }
  if (!enemy.boss && chance(.055)) spawnHeart(enemy.x, enemy.y - 24);
  if (enemy.boss) {
    for (let i = 0; i < 8; i++) spawnShard(enemy.x + rnd(-80, 80), enemy.y - rnd(20, 100), 3);
  }
}

// ---------------------------------------------------------------------------
// 近战判定
// ---------------------------------------------------------------------------
export function hitEnemiesBox(o) {
  const box = o.box || { x: o.x, y: o.y, w: o.w, h: o.h };
  let hits = 0;
  for (const e of G.enemies) {
    if (e.dead || e.spawning > 0) continue;
    const er = { x: e.x - e.w * .5, y: e.y - e.h, w: e.w, h: e.h };
    const overlap = box.x < er.x + er.w && box.x + box.w > er.x && box.y < er.y + er.h && box.y + box.h > er.y;
    if (overlap) {
      if (o.hitList) {
        if (o.hitList.has(e)) continue;
        o.hitList.add(e);
      }
      damageEnemy(e, o.dmg, o);
      hits++;
    }
  }
  return hits;
}

export function hitEnemiesCircle(x, y, r, o) {
  let hits = 0;
  for (const e of G.enemies) {
    if (e.dead || e.spawning > 0) continue;
    if (dist(x, y, e.x, e.y - e.h * .5) <= r + e.w * .5) {
      if (o.hitList) {
        if (o.hitList.has(e)) continue;
        o.hitList.add(e);
      }
      damageEnemy(e, o.dmg, o);
      hits++;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 属性反应
// ---------------------------------------------------------------------------
export function triggerReaction(target, first, second, opt = {}) {
  const r = reactionOf(first, second);
  if (!r) return;
  const stats = G.run?.stats || {};
  const m = activeMember();
  const atk = m ? m.char.atk : 12;
  let base = (12 + atk * 1.1) * r.dmg * 2;
  base *= (1 + (stats.reaction || 0));
  if ((first === 'water' || second === 'water') && stats.waterReaction) base *= (1 + stats.waterReaction);
  if ((first === 'moon' || second === 'moon') && stats.moonReaction) base *= (1 + stats.moonReaction);
  if (m && m.char.id === 'kirara') base *= 1.18;
  const radius = r.radius * (1 + (stats.reactionRadius || 0));
  const victims = enemiesInRadius(target.x, target.y - target.h * .5, radius);
  for (const e of victims) {
    const dmg = damageEnemyRaw(e, base, {
      color: r.color, element: null, source: 'reaction', grade: 'reaction',
    });
    applyReactionStatus(e, r, opt);
    if (stats.flags?.has('markSpread')) {
      e.mark = { el: EL[second] ? second : first, t: 3.5 };
    }
  }
  // 视觉
  FX.ring(target.x, target.y - target.h * .55, radius, r.color, { life: .65, width: 5, fill: true });
  FX.ring(target.x, target.y - target.h * .55, radius * .65, '#fff8e8', { life: .4, width: 2 });
  FX.burst(target.x, target.y - target.h * .55, {
    count: 26, colors: [r.color, '#fff8e8', EL[first]?.color, EL[second]?.color],
    speed: 300, size: 5, life: .7, glow: true, shape: 'star', gravity: 100,
  });
  for (let i = 0; i < 10; i++) {
    FX.p({ x: target.x + rnd(-20, 20), y: target.y - target.h * .5 + rnd(-20, 20), vx: rnd(-120, 120), vy: rnd(-160, -40), life: rnd(.4, .8), size: rnd(2, 5), color: r.color, glow: true, shape: 'spark' });
  }
  FX.flash(r.color, .18, .16);
  FX.shake(.26);
  FX.hitstop(.05);
  Audio.sfx('reaction');
  G.reactionCallout = { name: r.name, en: r.en, color: r.color, t: 1.35, desc: r.text || '' };
  addStyle(22);
  if (G.run) G.run.reactions = (G.run.reactions || 0) + 1;

  // 反应附带效果
  if (r.heal) healTeam(r.heal, true);
  if (r.ult && m) m.ult = Math.min(100, m.ult + r.ult);
  if (r.shards) {
    for (let i = 0; i < r.shards; i++) spawnShard(target.x + rnd(-30, 30), target.y - 40, 1);
  }
  if (r.healOrb) spawnHeart(target.x, target.y - 40);
  if (r.pull) {
    for (const e of victims) {
      const a = angleTo(e.x, e.y - e.h * .5, target.x, target.y - target.h * .5);
      e.vx += Math.cos(a) * r.pull;
    }
  }
  if (stats.flags?.has('reactionHeal')) healTeam(2, true);
}

function applyReactionStatus(e, r, opt) {
  const s = e.status || (e.status = {});
  if (r.burn) { s.burn = Math.max(s.burn || 0, r.burn); s.burnDps = Math.max(s.burnDps || 0, 3.5 + (G.player?.char.atk || 10) * .12); }
  if (r.freeze) s.freeze = Math.max(s.freeze || 0, r.freeze);
  if (r.stun) s.stun = Math.max(s.stun || 0, r.stun);
  if (r.root) s.root = Math.max(s.root || 0, r.root);
  if (r.slow) s.slow = Math.max(s.slow || 0, r.slow);
  if (r.blind) s.blind = Math.max(s.blind || 0, r.blind);
  if (r.armorBreak) s.armorBreak = Math.max(s.armorBreak || 0, r.armorBreak);
}

// 无反应/无印记的纯粹伤害（用于反应、DOT）
export function damageEnemyRaw(enemy, dmg, opt = {}) {
  if (!enemy || enemy.dead) return 0;
  enemy.hp -= dmg;
  enemy.flash = Math.max(enemy.flash || 0, .1);
  const color = opt.color || '#f8e7bd';
  if (G.showDamage !== false) {
    FX.damageText(enemy.x + rnd(-10, 10), enemy.y - enemy.h * rnd(.55, .8), dmg, {
      color, size: opt.size || (opt.grade === 'reaction' ? 26 : 22),
      grade: opt.grade, dot: !!opt.dot,
    });
  }
  if (G.run) G.run.score += dmg * .25;
  if (enemy.hp <= 0) killEnemy(enemy, opt);
  return dmg;
}

// ---------------------------------------------------------------------------
// 玩家受伤
// ---------------------------------------------------------------------------
export function hurtPlayer(rawDmg, sourceX, opt = {}) {
  const p = G.player;
  const m = activeMember();
  if (!p || !m || m.downed || p.invuln > 0 || p.state === 'down' || G.run?.over) return false;
  if (p.teamInvulnT > 0) return false;
  if (p.dashT > 0) {
    // 完美闪避：刷新闪身，回一点喝彩
    p.dashCharges = p.maxDashes;
    addStyle(12);
    FX.text(p.x, p.y - 170, '闪', '#bff5e5', { size: 20, life: .5, vy: -70 });
    Audio.sfx('dash', { volume: .4, gap: 80 });
    return false;
  }
  if (p.parryT > 0) {
    p.parryCounter(sourceX);
    return false;
  }
  if (p.guardT > 0) {
    p.blocked = .2;
    let dmg = rawDmg * .35;
    applyPlayerDamage(dmg, m, sourceX, opt);
    FX.ring(p.x, p.y - 80, 70, '#cf9a5e', { life: .35, width: 4 });
    Audio.sfx('parry', { volume: .6 });
    return true;
  }
  const stats = G.run.stats;
  let dmg = rawDmg * (1 + (stats.dmgTaken || 0));
  if (m.char.id === 'highpris') dmg *= .92;
  if (G.player.shield > 0) {
    const absorbed = Math.min(G.player.shield, dmg);
    G.player.shield -= absorbed;
    dmg -= absorbed;
    FX.ring(p.x, p.y - 80, 60, '#7bd6bf', { life: .3, width: 3 });
    if (dmg <= 0) {
      p.invuln = .45;
      Audio.sfx('parry', { volume: .4 });
      return true;
    }
  }
  applyPlayerDamage(dmg, m, sourceX, opt);
  return true;
}

function applyPlayerDamage(dmg, m, sourceX, opt) {
  const p = G.player;
  dmg = Math.max(1, dmg);
  m.hp = Math.max(0, m.hp - dmg);
  p.invuln = .85;
  p.hurtT = .28;
  p.vx = (p.x < sourceX ? -1 : 1) * 240;
  p.vy = -260;
  loseStyle(.24);
  G.style.combo = 0;
  G.style.comboT = 0;
  FX.damageText(p.x, p.y - 150, dmg, { color: '#ff8fa3', size: 28, crit: true });
  FX.burst(p.x, p.y - 90, { count: 16, color: '#d96f8e', speed: 260, size: 4, life: .6, glow: true, shape: 'star' });
  FX.flash('#d96f8e', .22, .2);
  FX.shake(.45);
  FX.hitstop(.07);
  Audio.sfx('hit', { volume: 1 });
  Audio.sfx('death', { volume: .25 });
  if (G.run) G.run.damageTaken = (G.run.damageTaken || 0) + dmg;
  if (opt.sourceBoss) FX.slowmo(.18, .45);
  if (m.hp <= 0) {
    downMember(m);
  }
}

export function downMember(m) {
  const p = G.player;
  // 「无忧无虑」：每场演出第一次受到致命伤时，以 1 点生命留下，并获得 1.5 秒无敌
  const reviveStats = G.run ? (G.run.stats.revive || 0) : 0;
  if (reviveStats > 0 && !G.run.reviveUsed && !G.run.over) {
    G.run.reviveUsed = true;
    m.hp = 1;
    p.invuln = 1.5;
    p.hurtT = .28;
    FX.flash('#f8e7bd', .45, .4);
    FX.ring(p.x, p.y - 90, 150, '#f8e7bd', { life: .7, width: 4 });
    FX.text(p.x, p.y - 190, '没关系，明天还会来', '#f8e7bd', { size: 21, life: 1.5, vy: -46, font: '"Songti SC",serif' });
    Audio.sfx('victory', { volume: .5 });
    G.banner = { type: 'encore', name: '无忧无虑', sub: 'STILL HERE', t: 0, dur: 1.8 };
    return;
  }
  m.hp = 0;
  m.downed = true;
  m.ult = 0;
  FX.flash('#f2d9d0', .35, .3);
  FX.burst(p.x, p.y - 110, { count: 40, colors: ['#d96f8e', '#f8e7bd', '#b49bf0'], speed: 380, size: 5, life: 1, glow: true, shape: 'petal', gravity: 120 });
  FX.shake(.7);
  FX.slowmo(.7, .3);
  Audio.sfx('death', { volume: 1 });
  G.banner = { type: 'down', name: m.char.name, sub: '退场', t: 0, dur: 1.8 };
  // 寻找下一位
  const next = G.run.team.findIndex((x) => !x.downed && x.hp > 0);
  if (next >= 0) {
    G.run.active = next;
    p.switchTo(next, true);
    p.invuln = 1.3;
  } else {
    // 返场许可
    const rev = G.run.revives || 0;
    if (rev > 0) {
      G.run.revives -= 1;
      let target = G.run.team[0];
      for (const t of G.run.team) if (t.maxHp > target.maxHp) target = t;
      target.downed = false;
      target.hp = Math.max(1, target.maxHp * .5);
      G.run.active = G.run.team.indexOf(target);
      p.switchTo(G.run.active, true);
      p.invuln = 2;
      FX.flash('#f8e7bd', .5, .5);
      FX.heal(p.x, p.y - 100);
      G.banner = { type: 'encore', name: '返场', sub: 'ENCORE', t: 0, dur: 1.8 };
    } else {
      G.run.over = true;
      G.run.won = false;
      G.run.deathT = 0;
      G.player.state = 'down';
      G.player.stateT = 0;
      FX.slowmo(1.4, .2);
    }
  }
}

export function healTeam(amount, all = false) {
  if (!G.run) return;
  const stats = G.run.stats;
  const mult = 1 + (stats.heal || 0);
  const m = activeMember();
  if (all) {
    for (const t of G.run.team) {
      if (t.downed) continue;
      t.hp = Math.min(t.maxHp, t.hp + amount * mult);
    }
    if (m) FX.heal(G.player.x, G.player.y - 90);
  } else if (m) {
    m.hp = Math.min(m.maxHp, m.hp + amount * mult);
    FX.heal(G.player.x, G.player.y - 100);
  }
}

// ---------------------------------------------------------------------------
// 弹幕
// ---------------------------------------------------------------------------
export function spawnPlayerProjectile(o) {
  const p = G.player;
  const m = activeMember();
  const stats = G.run?.stats;
  const speedMul = 1 + (stats?.projectileSpeed || 0);
  const proj = {
    owner: 'player',
    x: o.x, y: o.y,
    vx: (o.vx ?? 0) * speedMul, vy: (o.vy ?? 0) * speedMul,
    r: o.r ?? o.size ?? 10,
    dmg: o.dmg ?? (m ? m.char.atk : 8),
    element: o.element || (m ? m.char.element : 'sun'),
    life: o.life ?? 1.8, maxLife: o.life ?? 1.8,
    homing: o.homing || 0, target: o.target || null,
    pierce: o.pierce || 0, hitList: new Set(),
    color: o.color || EL[o.element]?.color || '#f8e7bd',
    type: o.type || 'orb',
    gravity: o.gravity || 0,
    hitstop: o.hitstop ?? .02,
    shake: o.shake ?? .04,
    heavy: !!o.heavy,
    explode: o.explode || 0,
    markOnly: !!o.markOnly,
    angle: o.angle ?? 0,
    spin: o.spin ?? 0,
    size: o.size ?? 10,
    trail: o.trail !== false,
    releaseT: o.releaseT || 0,
    onHit: o.onHit || null,
    onExpire: o.onExpire || null,
  };
  if (o.speed && !o.vx && !o.vy) {
    const a = o.angle ?? (p ? (p.facing > 0 ? 0 : Math.PI) : 0);
    proj.vx = Math.cos(a) * o.speed;
    proj.vy = Math.sin(a) * o.speed;
    proj.angle = a;
  } else {
    proj.angle = Math.atan2(proj.vy, proj.vx);
  }
  G.projectiles.push(proj);
  return proj;
}

export function spawnEnemyProjectile(o) {
  const proj = {
    owner: 'enemy',
    x: o.x, y: o.y, vx: o.vx || 0, vy: o.vy || 0,
    r: o.r ?? o.size ?? 10,
    dmg: o.dmg ?? 10,
    life: o.life ?? 4, maxLife: o.life ?? 4,
    color: o.color || '#d96f8e',
    type: o.type || 'note',
    gravity: o.gravity || 0,
    homing: o.homing || 0,
    target: null,
    angle: o.angle ?? Math.atan2(o.vy || 0, o.vx || 0),
    spin: o.spin || 0,
    trail: o.trail !== false,
    size: o.size ?? 10,
    reflectable: o.reflectable !== false,
    pierceWalls: !!o.pierceWalls,
    spinT: 0,
  };
  if (o.speed) {
    const a = o.angle ?? 0;
    proj.vx = Math.cos(a) * o.speed;
    proj.vy = Math.sin(a) * o.speed;
  }
  G.projectiles.push(proj);
  return proj;
}

export function reflectProjectile(proj, fromX, fromY) {
  proj.owner = 'player';
  proj.dmg = proj.dmg * 2.2 + (G.player?.char.atk || 10);
  proj.color = '#ffe9b0';
  proj.type = 'star';
  proj.homing = 1.1;
  proj.target = null;
  proj.life = 2.4;
  proj.speed = 700;
  const a = angleTo(fromX, fromY, proj.x, proj.y);
  proj.vx = Math.cos(a) * 700;
  proj.vy = Math.sin(a) * 700;
  proj.hitList = new Set();
  proj.pierce = 1;
  FX.spark(proj.x, proj.y, '#ffe9b0', 10, null, 320);
  Audio.sfx('parry');
}

export function explode(x, y, radius, dmg, opt = {}) {
  FX.ring(x, y, radius, opt.color || '#ff9a5a', { life: .55, width: 5, fill: true });
  FX.ring(x, y, radius * .55, '#fff8e8', { life: .3, width: 2 });
  FX.burst(x, y, { count: opt.count ?? 26, colors: [opt.color || '#ff9a5a', '#fff8e8', '#e8c47e'], speed: 360, size: 5, life: .6, glow: true, shape: 'circle', gravity: 200 });
  FX.ink(x, y, 8, '#2a1620');
  FX.shake(opt.shake ?? .3);
  FX.hitstop(.035);
  Audio.sfx('explode', { volume: opt.volume ?? .6 });
  if (opt.hurtPlayer !== false) {
    const p = G.player;
    if (p && dist(p.x, p.y - 80, x, y) < radius + 30) hurtPlayer(dmg * .65, x, { sourceBoss: opt.boss });
  }
  if (dmg > 0 && opt.hitEnemies !== false) {
    for (const e of enemiesInRadius(x, y, radius)) {
      damageEnemy(e, dmg, {
        element: opt.element, color: opt.color, style: 5, hitstop: .01,
        fromX: x, canCrit: opt.canCrit !== false,
      });
    }
  }
}

export function updateProjectiles(dt) {
  const p = G.player;
  for (let i = G.projectiles.length - 1; i >= 0; i--) {
    const b = G.projectiles[i];
    b.life -= dt;
    if (b.life <= 0) {
      if (b.onExpire) b.onExpire(b);
      if (b.explode) explode(b.x, b.y, b.explode, b.dmg * .7, { color: b.color, element: b.element, hurtPlayer: false });
      G.projectiles.splice(i, 1);
      continue;
    }
    if (b.gravity) b.vy += b.gravity * dt;
    if (b.homing > 0) {
      if (!b.target || b.target.dead) b.target = nearestEnemy(b.x, b.y, 700, (e) => b.owner === 'player' || e === b.target);
      if (b.owner === 'player' && b.target && !b.target.dead) {
        const a = angleTo(b.x, b.y, b.target.x, b.target.y - b.target.h * .5);
        const cur = Math.atan2(b.vy, b.vx);
        let da = a - cur;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        const na = cur + clamp(da, -b.homing * 7 * dt, b.homing * 7 * dt);
        const sp = Math.hypot(b.vx, b.vy) || 300;
        b.vx = Math.cos(na) * sp;
        b.vy = Math.sin(na) * sp;
      }
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.angle = Math.atan2(b.vy, b.vx);
    b.spinT += dt;
    if (b.trail && !FX.lowfx && Math.random() < .65) {
      FX.p({
        x: b.x + rnd(-2, 2), y: b.y + rnd(-2, 2),
        vx: rnd(-20, 20), vy: rnd(-20, 20),
        life: .24, size: b.size * rnd(.25, .5), color: b.color,
        glow: true, shape: 'circle', alpha: .8, drag: .9,
      });
    }
    // 碰撞
    if (b.owner === 'player') {
      if (b.gravity && b.y >= FLOOR - 4) {
        if (b.explode) explode(b.x, FLOOR - 8, b.explode, b.dmg * .9, { color: b.color, element: b.element, hurtPlayer: false });
        G.projectiles.splice(i, 1);
        continue;
      }
      for (const e of G.enemies) {
        if (e.dead || e.spawning > 0) continue;
        if (b.hitList.has(e)) continue;
        if (circleHitsEnemy(b, e)) {
          b.hitList.add(e);
          if (b.onHit) b.onHit(e, b);
          damageEnemy(e, b.dmg, {
            element: b.element, color: b.color, style: b.heavy ? 10 : 6,
            hitstop: b.hitstop, shake: b.shake, fromX: b.x, heavy: b.heavy,
            critBonus: b.critBonus || 0,
          });
          if (b.explode) {
            explode(b.x, b.y, b.explode, b.dmg * .8, { color: b.color, element: b.element, hurtPlayer: false });
          }
          if (b.pierce > 0) { b.pierce -= 1; }
          else { G.projectiles.splice(i, 1); break; }
        }
      }
    } else {
      // 敌方弹幕与玩家
      if (p && p.invuln <= 0 && p.state !== 'down') {
        const px = p.x, py = p.y - 82;
        if (dist2(b.x, b.y, px, py) < (b.r + 34) * (b.r + 34)) {
          if (p.parryT > 0 || p.guardT > 0) {
            reflectProjectile(b, p.x, p.y - 82);
            FX.hitstop(.08);
            FX.flash('#f8e7bd', .2, .16);
            continue;
          }
          if (p.dashT > 0) continue;
          hurtPlayer(b.dmg, b.x, {});
          G.projectiles.splice(i, 1);
          continue;
        }
      }
      // 地面碰撞
      if (b.gravity && p && b.y > p.groundY(p.x) + 4) {
        if (b.explode) explode(b.x, b.y, b.explode, b.dmg, { color: b.color, hurtPlayer: true });
        G.projectiles.splice(i, 1);
        continue;
      }
    }
    // 出界
    if (b.life > 0 && (b.x < -200 || b.x > 3000 || b.y < -300 || b.y > 1000)) {
      G.projectiles.splice(i, 1);
    }
  }
}

function circleHitsEnemy(b, e) {
  const rect = { x: e.x - e.w * .5, y: e.y - e.h, w: e.w, h: e.h };
  const nx = clamp(b.x, rect.x, rect.x + rect.w);
  const ny = clamp(b.y, rect.y, rect.y + rect.h);
  const rr = b.r + 6;
  return dist2(b.x, b.y, nx, ny) <= rr * rr;
}

// ---------------------------------------------------------------------------
// 区域效果
// ---------------------------------------------------------------------------
export function spawnZone(o) {
  G.zones.push({
    x: o.x, y: o.y, r: o.r || 100, life: o.life || 2, max: o.life || 2,
    type: o.type || 'field', color: o.color || '#b49bf0',
    element: o.element || null, dmg: o.dmg || 0, tick: o.tick || .5, tickT: 0,
    pull: o.pull || 0, owner: o.owner || 'player', explode: o.explode || 0,
    onEnd: o.onEnd || null, heal: o.heal || 0, slow: o.slow || 0, hit: new Set(),
    data: o.data || {},
  });
}
export function updateZones(dt) {
  for (let i = G.zones.length - 1; i >= 0; i--) {
    const z = G.zones[i];
    z.life -= dt;
    z.tickT -= dt;
    if (z.pull > 0) {
      for (const e of G.enemies) {
        if (e.dead) continue;
        if (dist(e.x, e.y - e.h * .5, z.x, z.y) < z.r + 60) {
          const a = angleTo(e.x, e.y - e.h * .5, z.x, z.y);
          e.vx += Math.cos(a) * z.pull * dt;
          e.vy += Math.sin(a) * z.pull * .2 * dt;
        }
      }
    }
    if (z.tickT <= 0) {
      z.tickT = z.tick;
      if (z.dmg > 0) {
        for (const e of enemiesInRadius(z.x, z.y, z.r)) {
          damageEnemy(e, z.dmg, { element: z.element, color: z.color, style: 2, canCrit: false, hitstop: .005, shake: .02 });
        }
      }
      if (z.heal > 0 && G.player && dist(G.player.x, G.player.y - 80, z.x, z.y) < z.r) {
        healTeam(z.heal, true);
      }
      if (z.slow > 0) {
        for (const e of enemiesInRadius(z.x, z.y, z.r)) {
          e.status = e.status || {};
          e.status.slow = Math.max(e.status.slow || 0, z.slow);
        }
      }
    }
    if (!FX.lowfx && Math.random() < .35) {
      const a = rnd(0, TAU);
      const rr = rnd(0, z.r);
      FX.p({ x: z.x + Math.cos(a) * rr, y: z.y + Math.sin(a) * rr * .6, vx: 0, vy: rnd(-30, -8), life: .6, size: rnd(1.5, 3.5), color: z.color, glow: true, shape: z.type === 'flowerfield' ? 'petal' : 'spark' });
    }
    if (z.life <= 0) {
      if (z.explode) {
        explode(z.x, z.y, z.r * 1.2, z.explode, { color: z.color, element: z.element, hurtPlayer: false, count: 34 });
      }
      if (z.onEnd) z.onEnd(z);
      G.zones.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// 掉落
// ---------------------------------------------------------------------------
export function spawnShard(x, y, amount = 1) {
  G.pickups.push({
    type: 'shard', x, y, vx: rnd(-120, 120), vy: rnd(-240, -80),
    amount, t: 0, life: 20, magnet: 0, size: amount > 2 ? 9 : 6,
  });
}
export function spawnHeart(x, y) {
  G.pickups.push({ type: 'heart', x, y, vx: rnd(-80, 80), vy: rnd(-220, -110), t: 0, life: 18, magnet: 0, amount: 7, size: 9 });
}
export function spawnStar(x, y) {
  G.pickups.push({ type: 'star', x, y, vx: rnd(-90, 90), vy: rnd(-260, -100), t: 0, life: 22, magnet: 0, amount: 10, size: 11 });
}
export function updatePickups(dt) {
  const p = G.player;
  for (let i = G.pickups.length - 1; i >= 0; i--) {
    const k = G.pickups[i];
    k.life -= dt;
    k.t += dt;
    if (k.life <= 0) { G.pickups.splice(i, 1); continue; }
    k.vy += 900 * dt;
    k.x += k.vx * dt;
    k.y += k.vy * dt;
    if (p) {
      const gy = p.groundY(k.x);
      if (k.y > gy - 8) { k.y = gy - 8; k.vy *= -.35; k.vx *= .7; }
      const d = dist(k.x, k.y, p.x, p.y - 80);
      if (d < 150) {
        k.magnet += dt * 8;
        const a = Math.atan2((p.y - 80) - k.y, p.x - k.x);
        const sp = 120 + k.magnet * 420;
        k.vx = Math.cos(a) * sp;
        k.vy = Math.sin(a) * sp;
      }
      if (d < 38) {
        if (k.type === 'shard') {
          const gain = Math.max(1, Math.round(k.amount * (1 + (G.run?.stats.shards || 0))));
          G.run.shards += gain;
          Audio.sfx('coin', { volume: .5, gap: 24 });
          FX.text(p.x, p.y - 120, '+' + gain, '#e8c47e', { size: 16, life: .55, vy: -60 });
        } else {
          healTeam(k.amount, true);
          Audio.sfx('heal', { volume: .6 });
          FX.text(p.x, p.y - 120, '+' + Math.round(k.amount), '#7bd6bf', { size: 18, life: .6, vy: -60 });
        }
        G.pickups.splice(i, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 状态更新
// ---------------------------------------------------------------------------
export function updateStatuses(dt) {
  for (const e of G.enemies) {
    if (e.dead) continue;
    const s = e.status;
    if (!s) continue;
    if (s.burn > 0) {
      s.burn -= dt;
      e.burnT = (e.burnT || 0) + dt;
      if (e.burnT >= .55) {
        e.burnT = 0;
        damageEnemyRaw(e, (s.burnDps || 3) * .55, { color: '#ff9a5a', dot: true, size: 17 });
        FX.p({ x: e.x + rnd(-10, 10), y: e.y - e.h * .6, vx: rnd(-20, 20), vy: rnd(-90, -40), life: .35, size: 3, color: '#ff9a5a', glow: true, shape: 'spark' });
        if (s.burn <= 0) s.burnDps = 0;
      }
    }
    for (const k of ['freeze', 'stun', 'root', 'slow', 'blind', 'armorBreak']) {
      if (s[k] > 0) s[k] = Math.max(0, s[k] - dt);
    }
    // 印记计时只在这里递减（敌人自身不再扣），过期即刻清掉，不留残留
    if (e.mark) {
      if (e.mark.t > 0) e.mark.t -= dt;
      else e.mark = null;
    }
  }
}

export function updateUltCharge(dt) {
  const m = activeMember();
  if (!m) return;
  // 挨打和少量自然回复
  m.ult = Math.min(100, m.ult + dt * .55);
}

// ---------------------------------------------------------------------------
// 供 UI 读取
// ---------------------------------------------------------------------------
export function reactionHint() {
  return REACTIONS;
}
