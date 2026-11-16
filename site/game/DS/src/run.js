// ============================================================
// 演出流程：开演、房间、波次、奖励、商店、事件、结算
// ============================================================
import { G, resetStyle, clearCombat, activeMember } from './state.js';
import { Audio } from './core/audio.js';
import { Save } from './core/save.js';
import { FX } from './fx.js';
import { Player } from './player.js';
import { Enemy, Boss } from './enemies.js';
import { createRoom, updateWorld, updateCamera } from './world.js';
import { updateStyle } from './state.js';
import { updateProjectiles, updateZones, updatePickups, updateStatuses, updateUltCharge, healTeam } from './combat.js';
import { CHARACTERS, CHAR_MAP } from './data/characters.js';
import { BOONS, BOON_MAP, computeStats, rollBoonOptions, CATS, RARITY } from './data/boons.js';
import { ACTS, ROOM_TYPES, ROOM_PLAN, EVENTS } from './data/acts.js';
import { BOSSES } from './data/enemies.js';
import { clamp, rnd, rint, pick, shuffle, chance, fmtTime } from './utils.js';
import { UI } from './ui.js';
import { RNG } from './utils.js';
import { FLOOR, RANKS } from './config.js';

const BATTLE_MUSIC = ['bgm_battle_5_0.mp3', 'bgm_battle_8_0.mp3', 'bgm_battle_12_0.mp3'];

export function createRun(teamIds) {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const rng = new RNG(seed);
  const meta = Save.metaMods();
  const stats = computeStats([]);
  const team = teamIds.map((id) => {
    const c = CHAR_MAP[id];
    const maxHp = Math.round(c.hp + stats.hp + meta.hp);
    return {
      id, char: c, hp: maxHp, maxHp, ult: 0, skillCd: 0, shield: 0, downed: false,
      skillLevel: 1,
    };
  });
  const run = {
    seed, rng, team, active: 0, boons: [], shards: 0, score: 0, kills: 0,
    rooms: 0, bosses: 0, reactions: 0, damage: 0, damageTaken: 0,
    act: 0, stage: 0, stats, revives: meta.revives || 0, reviveUsed: false, over: false, won: false,
    deathT: 0, startTime: performance.now(), time: 0, meta,
    shopStock: null, eventUsed: [], pending: null,
    extraChoice: meta.extraChoice || 0, freeBoon: meta.freeBoon,
    maxCombo: 0,
  };
  run.shards = (stats.startShards || 0) + (meta.startShards || 0);
  G.run = run;
  G.player = new Player(run);
  G.player.resetPos(220);
  resetStyle();
  clearCombat();
  FX.clear();
  G.runTime = 0;
  G.cam.x = 0;
  G.cam.look = 0;
  G.cam.trauma = 0;
  G.mode = 'playing';
  UI.hideAllScreens();
  UI.setMenuBg(null);
  UI.setHudVisible(true);
  UI.setTouchVisible(UI.touchDesired());
  UI.setRoomPips(run.act, run.stage);
  // 化妆间：开演随机共演卡
  if (meta.freeBoon) {
    const b = pick(BOONS.filter((x) => !run.boons.find((o) => o.id === x.id)));
    if (b) addBoon(b, true);
  }
  return run;
}

export function beginRun(teamIds) {
  createRun(teamIds);
  UI.curtainTransition(() => {
    startCombatRoom('battle', true);
  });
}

function hubMusic() { return 'bgm_town_1_0.mp3'; }

export function startCombatRoom(type, first = false) {
  const run = G.run;
  clearCombat();
  FX.clear();
  G.room = createRoom(run, type);
  G.player.resetPos(220);
  G.mode = 'playing';
  G.paused = false;
  UI.hideAllScreens();
  UI.setMenuBg(null);
  UI.setHudVisible(true);
  UI.setRoomPips(run.act, run.stage);
  UI.hideBossBar();
  Audio.duck(false);
  const act = ACTS[run.act];
  if (type === 'boss') {
    Audio.playMusic(BOSSES[act.boss].music, { fade: 1.2 });
    G.banner = { type: 'act', name: '幕终', sub: BOSSES[act.boss].title, color: BOSSES[act.boss].accent, t: 0, dur: 2.4 };
    UI.showBossIntro(BOSSES[act.boss]);
  } else {
    Audio.playMusic(BATTLE_MUSIC[run.act] || BATTLE_MUSIC[0], { fade: 1.2 });
    if (first || run.stage === 0) {
      G.banner = { type: 'act', name: act.no + ' · ' + act.name, sub: act.en, color: act.accent, t: 0, dur: 2.8 };
    } else {
      G.banner = { type: 'room', name: ROOM_TYPES[type].name, sub: ROOM_TYPES[type].en, color: ROOM_TYPES[type].color, t: 0, dur: 1.6 };
    }
  }
  G.room.started = true;
  G.room.waveT = type === 'boss' ? 1.8 : 1.1;
  G.room.waveIndex = -1;
  G.room.emptyT = 0;
  UI.updateRoomInfo();
  // 每场开演：共演卡的固定收益（回复 / 护盾）
  const stats = run.stats;
  if (stats.roomHeal > 0) healTeam(stats.roomHeal, true);
  if (stats.roomShield > 0 && G.player) {
    G.player.shield = (G.player.shield || 0) + stats.roomShield;
    FX.text(G.player.x, G.player.y - 190, '护盾 +' + stats.roomShield, '#7bd6bf', { size: 18, life: .9, vy: -46 });
  }
}

// ---------------------------------------------------------------------------
// 主更新
// ---------------------------------------------------------------------------
export function updateRun(dt) {
  const run = G.run;
  if (!run || !G.room) return;
  run.time += dt;
  G.runTime += dt;
  G.player.update(dt);
  updateWorld(dt);
  for (const e of G.enemies) e.update(dt);
  updateStatuses(dt);
  updateProjectiles(dt);
  updateZones(dt);
  updatePickups(dt);
  updateUltCharge(dt);
  updateStyle(dt);
  FX.update(dt);
  updateCamera(dt);
  if (G.bossDark > 0 && (!G.boss || G.boss.dead)) G.bossDark = Math.max(0, G.bossDark - dt * 2);
  // 清理敌人
  for (let i = G.enemies.length - 1; i >= 0; i--) {
    const e = G.enemies[i];
    if (e.dead && e.deathT > 1.1) G.enemies.splice(i, 1);
  }
  if (G.boss && G.boss.dead) {
    G.bossDeadT = (G.bossDeadT || 0) + dt;
  }
  if (G.style.combo > run.maxCombo) run.maxCombo = G.style.combo;
  // 喝彩升档仪式：横幅 + 金环 + 一拍定帧，让每一步升档都有掌声
  if (run.rankSeen == null) run.rankSeen = G.style.rank;
  if (G.style.rank < run.rankSeen) run.rankSeen = G.style.rank;
  if (G.style.rank > run.rankSeen && !run.over) {
    run.rankSeen = G.style.rank;
    const rk = RANKS[G.style.rank];
    const p = G.player;
    G.banner = { type: 'rank', name: rk.name, sub: 'ENCORE ' + rk.key.toUpperCase(), color: '#e8c47e', t: 0, dur: 1.15 };
    if (p) {
      FX.ring(p.x, p.y - 90, 132, '#e8c47e', { life: .5, width: 4 });
      FX.ring(p.x, p.y - 90, 190, '#ffe9b0', { life: .65, width: 2 });
      FX.burst(p.x, p.y - 90, { count: 14, colors: ['#ffe9b0', '#e8c47e'], speed: 250, size: 3.5, life: .6, glow: true, shape: 'star', gravity: 90 });
    }
    FX.flash('#e8c47e', .12, .2);
    FX.hitstop(.045);
    Audio.sfx('phase', { volume: .45 });
    Audio.sfx('coin', { volume: .35, gap: 60 });
  }
  // 波次
  const room = G.room;
  if (!room.cleared) {
    const alive = G.enemies.filter((e) => !e.dead).length;
    if (room.waveIndex < 0) {
      room.waveT -= dt;
      if (room.waveT <= 0) spawnNextWave();
    } else if (alive === 0) {
      if (room.waveIndex < room.waves.length - 1) {
        room.waveT -= dt;
        if (room.waveT <= 0) spawnNextWave();
      } else {
        room.emptyT = (room.emptyT || 0) + dt;
        if (room.emptyT > .9) onRoomClear();
      }
    }
  }
  // 死亡流程
  if (run.over) {
    run.deathT += dt;
    if (run.deathT > 1.9 && G.mode === 'playing') finishRun(false);
  }
  // Boss 击破后的换幕
  if (run.pendingAct != null) {
    run.pendingAct -= dt;
    if (run.pendingAct <= 0) {
      run.pendingAct = null;
      if (run.act < 2) {
        run.act += 1;
        run.stage = 0;
        UI.curtainTransition(() => startCombatRoom('battle', true));
      } else {
        finishRun(true);
      }
    }
  }
  // HUD
  UI.updateHUD(dt);
  if (G.reactionCallout) {
    G.reactionCallout.t -= dt;
    if (G.reactionCallout.t <= 0) G.reactionCallout = null;
  }
  if (G.ultCutin) {
    G.ultCutin.t += dt;
    if (G.ultCutin.t >= G.ultCutin.dur) G.ultCutin = null;
  }
  if (G.banner) {
    G.banner.t += dt;
    if (G.banner.t >= G.banner.dur) G.banner = null;
  }
  if (G.flash) {
    // FX update handles its own flash timer; keep here for direct use
  }
}

function spawnNextWave() {
  const room = G.room;
  room.waveIndex++;
  const wave = room.waves[room.waveIndex];
  if (!wave) return;
  if (wave.boss) {
    const bossId = BOSSES[ACTS[G.run.act].boss].id;
    const boss = new Boss(bossId, { x: Math.min(room.w * .62, room.w - 250) });
    G.enemies.push(boss);
    G.boss = boss;
    UI.showBossBar(boss);
    Audio.sfx('boss', { volume: .9 });
    return;
  }
  const p = G.player;
  // 正在预警/落下的机关位置，出生点要避开
  const hazardXs = (room.hazards || []).filter((h) => h.x && (h.warn > 0 || h.strike > 0)).map((h) => h.x);
  const nearHazard = (x) => hazardXs.some((hx) => Math.abs(hx - x) < 150);
  for (const id of wave.list) {
    let x = 0, ok = false;
    for (let i = 0; i < 24; i++) {
      x = rnd(room.bounds.left + 160, room.bounds.right - 160);
      if (Math.abs(x - p.x) > 260 && !nearHazard(x)) { ok = true; break; }
    }
    // 兜底：强制放到离玩家最远的一侧
    if (!ok) {
      x = p.x < room.w * .5 ? room.bounds.right - 200 : room.bounds.left + 200;
      x = clamp(x + rnd(-90, 90), room.bounds.left + 160, room.bounds.right - 160);
    }
    const e = new Enemy(id, x, {});
    G.enemies.push(e);
  }
  room.emptyT = 0;
  room.waveT = wave.delay ?? .95;
  if (room.waveIndex > 0) {
    FX.text(clamp(p.x, 200, room.w - 200), 260, '第 ' + (room.waveIndex + 1) + ' 波', '#e8c47e', { size: 26, life: 1.2, vy: -30 });
  }
}

function onRoomClear() {
  const room = G.room;
  const run = G.run;
  if (room.cleared) return;
  room.cleared = true;
  run.rooms += 1;
  room.clearT = 0;
  // 清场后机关确定关闭：掐掉进行中的预警与打击，也不再重启
  for (const hz of room.hazards) {
    hz.warn = 0;
    hz.strike = 0;
    hz.hitT = 0;
    hz.t = 1e9;
  }
  Audio.sfx('pickup', { volume: .7 });
  healTeam(4, true);
  for (let i = 0; i < 6; i++) {
    G.pickups.push({ type: 'shard', x: G.player.x + rnd(-80, 80), y: G.player.y - 80, vx: rnd(-100, 100), vy: rnd(-260, -100), amount: 2, t: 0, life: 20, magnet: 0, size: 6 });
  }
  G.projectiles.length = 0;
  FX.text(G.player.x, G.player.y - 170, '落幕', '#f8e7bd', { size: 34, life: 1.4, vy: -40, font: '"Songti SC",serif' });
  if (room.type === 'boss') {
    for (const e of [...G.enemies]) {
      if (!e.dead && !e.boss) {
        e.hp = 0;
        e.dead = true;
        e.deathT = .6;
        FX.ink(e.x, e.y - e.h * .4, 12, e.def?.color || '#1a1420');
      }
    }
    run.bosses += 1;
    run.score += 500;
    G.boss = null;
    UI.hideBossBar();
    FX.flash('#fff8e8', .55, .6);
    FX.slowmo(1, .3);
    Audio.sfx('victory');
    Audio.playMusic('bgm_battle_win_0.mp3', { fade: .4 });
    healTeam(G.player.member.maxHp * .28, true);
    run.shards += 45;
    const bossBoon = rollBoonOptions(1, run.boons, run.rng)[0];
    if (bossBoon) addBoon(bossBoon);
    run.pendingAct = 3.4;
    G.banner = { type: 'act', name: '幕落', sub: 'CURTAIN FALLS', color: '#f8e7bd', t: 0, dur: 3 };
  } else {
    onRoomClearedUI(room.type);
  }
}

// ---------------------------------------------------------------------------
// 奖励
// ---------------------------------------------------------------------------
export function openBoonReward(count, source, onDone) {
  const run = G.run;
  const n = Math.max(1, count + (run.extraChoice || 0) + (run.stats.extraChoice || 0));
  const cards = rollBoonOptions(n, run.boons, run.rng);
  if (!cards.length) {
    run.shards += 60;
    UI.toast('节目单已满，获得 60 星屑');
    onDone();
    return;
  }
  G.mode = 'reward';
  Audio.duck(true);
  UI.showReward(cards, source, (boon) => {
    if (boon) addBoon(boon);
    Audio.duck(false);
    onDone();
  });
}

export function addBoon(boon, silent = false) {
  const run = G.run;
  if (!boon) return;
  const oldStats = run.stats;
  run.boons.push(boon);
  Save.markBoon(boon.id);
  run.stats = computeStats(run.boons);
  const hpDelta = (run.stats.hp || 0) - (oldStats.hp || 0);
  if (hpDelta > 0) {
    for (const m of run.team) {
      m.maxHp += hpDelta;
      if (!m.downed) m.hp = Math.min(m.maxHp, m.hp + hpDelta);
    }
  }
  // 返场许可只来自永久强化；共演卡的「无忧无虑」走 reviveUsed 单独结算
  run.revives = run.meta.revives || 0;
  if (!silent) {
    UI.toast('共演者加入：' + boon.owner + ' · ' + boon.name);
    UI.flashBoon(boon);
    Audio.sfx('pickup');
    FX.flash('#e8c47e', .15, .2);
  }
}

// ---------------------------------------------------------------------------
// 节点推进
// ---------------------------------------------------------------------------
export function afterReward() {
  const run = G.run;
  if (run.over) return;
  run.stage += 1;
  if (run.stage >= 4) {
    UI.curtainTransition(() => startCombatRoom('boss'));
  } else {
    showNextChoices();
  }
}

export function showNextChoices() {
  const run = G.run;
  if (run.stage >= 4) {
    UI.curtainTransition(() => startCombatRoom('boss'));
    return;
  }
  const plan = ROOM_PLAN[Math.min(run.stage, ROOM_PLAN.length - 1)];
  let options = plan.options.slice();
  // 保证至少一个战斗类
  if (!options.some((o) => o === 'battle' || o === 'elite' || o === 'boss')) options.push('battle');
  options = shuffle(options).slice(0, 3);
  const built = options.map((type) => buildRoomOption(type));
  G.mode = 'next';
  Audio.duck(true);
  UI.showNext(built, (opt) => {
    Audio.duck(false);
    chooseNode(opt.type);
  });
}

function buildRoomOption(type) {
  const info = ROOM_TYPES[type];
  const run = G.run;
  const rewards = [];
  if (type === 'battle') rewards.push('共演卡', rint(18, 30) + ' 星屑');
  else if (type === 'elite') rewards.push('共演卡 · 稀', '大量星屑');
  else if (type === 'shop') rewards.push('共演卡', '补给', '刷新');
  else if (type === 'rest') rewards.push('回复', '强化');
  else if (type === 'event') rewards.push('未知', '故事');
  else if (type === 'treasure') rewards.push('星屑', '共演卡');
  else if (type === 'boss') rewards.push('幕终', '大量掌声');
  return { type, ...info, rewards, act: run.act, stage: run.stage };
}

export function chooseNode(type) {
  const run = G.run;
  if (type === 'battle' || type === 'elite') {
    UI.curtainTransition(() => startCombatRoom(type));
  } else if (type === 'boss') {
    UI.curtainTransition(() => startCombatRoom('boss'));
  } else if (type === 'shop') {
    openShop();
  } else if (type === 'rest') {
    openRest();
  } else if (type === 'event') {
    openEvent();
  } else if (type === 'treasure') {
    openTreasure();
  }
}

// ---------------------------------------------------------------------------
// 商店
// ---------------------------------------------------------------------------
function priceOf(base) {
  const run = G.run;
  return Math.max(8, Math.round(base * (1 + (run.stats.shop || 0))));
}

export function openShop() {
  const run = G.run;
  if (!run.shopStock) {
    const boons = rollBoonOptions(3, run.boons, run.rng);
    run.shopStock = {
      boons: boons.map((b) => ({ kind: 'boon', boon: b, price: priceOf(38 + b.rarity * 16), sold: false })),
      // 补货商品的售罄状态留在库存里，否则 UI 刷新一次就能无限回购
      services: {
        heal: { kind: 'heal', name: '灯油与热汤', desc: '全队回复 38% 生命。', base: 34, sold: false, icon: '✦' },
        maxhp: { kind: 'maxhp', name: '加厚的戏服', desc: '全队生命上限 +7，并回复 7 点生命。', base: 62, sold: false, icon: '❖' },
      },
      rerolls: 0,
    };
  }
  G.mode = 'shop';
  Audio.duck(true);
  const render = () => {
    // 「微笑服务」：治疗类商品在商店折扣之上再减 30%
    const healPrice = (base) => Math.max(8, Math.round(priceOf(base) * (run.stats.flags.has('healDiscount') ? .7 : 1)));
    const sv = run.shopStock.services;
    const items = [
      ...run.shopStock.boons,
      { ...sv.heal, price: healPrice(sv.heal.base) },
      { ...sv.maxhp, price: priceOf(sv.maxhp.base) },
    ];
    UI.showShop(items, run, {
      buy: (item, index) => {
        if (item.sold) return;
        if (run.shards < item.price) { UI.toast('星屑不够'); Audio.sfx('ui'); return; }
        run.shards -= item.price;
        item.sold = true;
        // 售罄状态写回库存对象（item 是渲染用的浅拷贝）
        const stock = item.kind === 'boon' ? run.shopStock.boons[index] : run.shopStock.services[item.kind];
        if (stock) stock.sold = true;
        if (item.kind === 'boon') addBoon(item.boon);
        else if (item.kind === 'heal') { healTeam(G.player.member.maxHp * .38, true); Audio.sfx('heal'); FX.heal(G.player.x, G.player.y - 100); }
        else if (item.kind === 'maxhp') {
          for (const m of run.team) { m.maxHp += 7; if (!m.downed) m.hp = Math.min(m.maxHp, m.hp + 7); }
          UI.toast('全队生命上限 +7');
        }
        Audio.sfx('coin');
        render();
      },
      reroll: () => {
        const cost = Math.max(6, Math.round(16 * (1 - (run.stats.rerollDiscount || 0))));
        if (run.shards < cost) { UI.toast('星屑不够'); return; }
        run.shards -= cost;
        const boons = rollBoonOptions(3, run.boons, run.rng);
        run.shopStock.boons = boons.map((b) => ({ kind: 'boon', boon: b, price: priceOf(38 + b.rarity * 16), sold: false }));
        Audio.sfx('ui');
        render();
      },
      leave: () => {
        Audio.duck(false);
        run.shopStock = null;
        afterReward();
      },
      refresh: () => { UI.setShards(run.shards); },
    });
    UI.setShards(run.shards);
  };
  render();
}

// ---------------------------------------------------------------------------
// 休息
// ---------------------------------------------------------------------------
export function openRest() {
  const run = G.run;
  G.mode = 'rest';
  Audio.duck(true);
  // 「照顾人的手」：进休息室时，倒下的演员以 35% 生命自动归队
  if (run.stats.flags.has('downedHeal')) {
    let returned = false;
    for (const m of run.team) {
      if (m.downed) {
        m.downed = false;
        m.hp = Math.max(1, Math.round(m.maxHp * .35));
        returned = true;
      }
    }
    if (returned) {
      UI.toast('倒下的演员悄悄归队了');
      Audio.sfx('heal');
      FX.heal(G.player.x, G.player.y - 100);
    }
  }
  const downed = run.team.filter((m) => m.downed);
  const cards = [
    { id: 'heal', icon: '☾', title: '闭目养神', desc: '全队回复 35% 生命。', tag: 'RESTORE' },
    { id: 'maxhp', icon: '✦', title: '加固戏服', desc: '全队生命上限 +6，并回复 6 点生命。', tag: 'REINFORCE' },
  ];
  if (downed.length) {
    cards.push({ id: 'revive', icon: '❖', title: '请回舞台', desc: '让一位退场的演员以 40% 生命归队。', tag: 'ENCORE' });
  } else {
    cards.push({ id: 'style', icon: '◈', title: '对镜排练', desc: '获得 25 星屑；本次演出喝彩值 +18。', tag: 'REHEARSE' });
  }
  UI.showRest(cards, (card) => {
    Audio.duck(false);
    if (card.id === 'heal') { healTeam(G.player.member.maxHp * .35, true); Audio.sfx('heal'); }
    else if (card.id === 'maxhp') { for (const m of run.team) { m.maxHp += 6; if (!m.downed) m.hp = Math.min(m.maxHp, m.hp + 6); } Audio.sfx('heal'); }
    else if (card.id === 'revive') {
      const m = downed[0];
      m.downed = false;
      m.hp = Math.max(1, Math.round(m.maxHp * .4));
      if (run.active === run.team.indexOf(m)) G.player.switchTo(run.active, true);
      Audio.sfx('pickup');
    } else if (card.id === 'style') { run.shards += 25; G.style.value = Math.min(1000, G.style.value + 18); Audio.sfx('coin'); }
    afterReward();
  });
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------
export function openEvent() {
  const run = G.run;
  const pool = EVENTS.filter((e) => !run.eventUsed.includes(e.id));
  const ev = pool.length ? pick(pool) : pick(EVENTS);
  run.eventUsed.push(ev.id);
  G.mode = 'event';
  Audio.duck(true);
  UI.showEvent(ev, run, (opt) => {
    if (opt.effect.cost && run.shards < opt.effect.cost) {
      UI.toast('星屑不够');
      return;
    }
    if (opt.effect.cost) run.shards -= opt.effect.cost;
    Audio.duck(false);
    applyEventEffect(opt.effect, () => {
      run.stage += 1;
      if (run.stage >= 4) UI.curtainTransition(() => startCombatRoom('boss'));
      else showNextChoices();
    });
  });
}

function applyEventEffect(effect, done) {
  const run = G.run;
  const p = G.player;
  if (effect.heal) { healTeam(effect.heal, true); Audio.sfx('heal'); FX.heal(p.x, p.y - 100); }
  if (effect.damage) {
    const m = G.player.member;
    m.hp = Math.max(1, m.hp - effect.damage);
    UI.toast('失去 ' + effect.damage + ' 点生命');
    FX.damageText(p.x, p.y - 140, effect.damage, { color: '#ff8fa3', size: 24 });
  }
  if (effect.shards) { run.shards += effect.shards; Audio.sfx('coin'); }
  if (effect.maxhp) {
    for (const m of run.team) { m.maxHp += effect.maxhp; if (!m.downed) m.hp = Math.min(m.maxHp, m.hp + effect.maxhp); }
  }
  if (effect.style) { G.style.value = Math.min(1000, G.style.value + effect.style); }
  if (effect.boon) {
    openBoonReward(3, 'event', done);
  } else {
    done();
  }
}

// ---------------------------------------------------------------------------
// 宝箱
// ---------------------------------------------------------------------------
export function openTreasure() {
  const run = G.run;
  G.mode = 'event';
  Audio.duck(true);
  const ev = {
    id: 'treasure', portrait: '✦', title: '落满灰的道具箱',
    text: '你打开箱子。里面有一叠旧票根、一束已经干枯的花，还有几枚仍然发亮的星屑。箱底压着一张没有署名的共演邀请函。',
    options: [
      { label: '收下邀请函', hint: '获得一张共演卡，以及 35 星屑', effect: { boon: true, shards: 35 } },
      { label: '只拿星屑', hint: '获得 85 星屑', effect: { shards: 85 } },
    ],
  };
  UI.showEvent(ev, run, (opt) => {
    Audio.duck(false);
    applyEventEffect(opt.effect, () => {
      run.stage += 1;
      if (run.stage >= 4) UI.curtainTransition(() => startCombatRoom('boss'));
      else showNextChoices();
    });
  });
}

// ---------------------------------------------------------------------------
// 结算
// ---------------------------------------------------------------------------
export function finishRun(won) {
  const run = G.run;
  if (!run) return;
  if (run.finished) return;
  run.finished = true;
  run.won = won;
  run.over = true;
  G.mode = 'result';
  const lead = run.team.find((m) => !m.downed) || run.team[0];
  const leadChar = CHAR_MAP[lead.id];
  const result = {
    won, act: run.act, rooms: run.rooms, bosses: run.bosses, kills: run.kills,
    score: Math.round(run.score),
    // 演出时长只累计真正的战斗与流程时间，暂停与逛菜单不计时
    time: run.time,
    team: run.team.map((m) => m.id), lead: lead.id,
    quote: won
      ? (leadChar ? leadChar.quote : '灯灭了，但你看，星星还在。')
      : '幕布落下的时候，别急着离场。',
    title: won ? '谢幕' : '中途落幕',
    kicker: won ? 'CURTAIN CALL' : 'THE CURTAIN FALLS',
    reactions: run.reactions, maxCombo: run.maxCombo, style: G.style.best,
  };
  const gained = Save.recordRun(result);
  result.gained = gained;
  result.newBest = gained >= Save.data.best;
  G.result = result;
  UI.hideHud();
  UI.hideAllScreens();
  Audio.stopMusic(1.2);
  setTimeout(() => {
    UI.showResult(result);
    if (won) Audio.playMusic('bgm_Prologue_0.mp3', { fade: 1.6 });
    else Audio.playMusic('bgm_adv_1_0.mp3', { fade: 2 });
  }, 350);
}

export function abandonRun() {
  const run = G.run;
  if (!run) return;
  finishRun(false);
}

// ---------------------------------------------------------------------------
// UI 回调
// ---------------------------------------------------------------------------
export function onRoomClearedUI(type) {
  const run = G.run;
  const count = type === 'elite' ? 4 : 3;
  openBoonReward(count, type, () => afterReward());
}

// 帮助方法
export function runTimeText() {
  return fmtTime(G.run ? G.run.time : 0);
}
