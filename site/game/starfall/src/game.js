// The run itself: platforming, combat, rooms, wishes, bosses and the
// transitions between them. Rendering lives in render2d/models; this file owns
// only the rules and the data the views read.

import {
  VIEW_W, VIEW_H, FLOOR_Y, CHARACTERS, CLASSES, ELEMENTS, ATTACKS, ACTS, BIOMES,
  BOSSES, ENEMIES, BOONS, SHOP_STOCK, STORY, BGM, elementMultiplier
} from "./config.js";
import {
  generateRoom, moveBody, Camera, clamp, lerp, rectsOverlap, enemyDef,
  findSpawn, mulberry32
} from "./world.js";
import { metaBonuses, stashRun, clearRun, recordRun, buyUpgrade, resetSave, writeSave } from "./save.js";

const GRAVITY = 1750;
const BASE_DASH_CD = 0.86;
const ROOM_TYPE_LABEL = { combat: "战斗", elite: "强敌", shop: "星灯小铺", rest: "星灯营地", boss: "守卷人" };

function surfaceBelow(room, x, y) {
  let best = FLOOR_Y;
  for (const p of room.solids) {
    if (x >= p.x && x <= p.x + p.w && p.y >= y - 4 && p.y < best) best = p.y;
  }
  for (const p of room.oneways) {
    if (x >= p.x && x <= p.x + p.w && p.y >= y - 4 && p.y < best) best = p.y;
  }
  return best;
}

function pointRect(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

export class StarfallGame {
  constructor({ ui, input, audio, save, renderer, stage, effects }) {
    this.ui = ui;
    this.input = input;
    this.audio = audio;
    this.save = save;
    this.renderer = renderer;
    this.stage = stage;
    this.effects = effects;
    this.camera = new Camera();
    this.time = 0;
    this.titleTime = 0;
    this.state = "title";
    this.paused = false;
    this.room = null;
    this.player = null;
    this.enemies = [];
    this.projectiles = [];
    this.hitboxes = [];
    this.zones = [];
    this.pickups = [];
    this.timers = [];
    this.run = null;
    this.playerHandle = null;
    this.waveIndex = -1;
    this.waveActive = false;
    this.waveLoading = false;
    this.waveGap = 0;
    this.clearTimer = 0;
    this.hitStop = 0;
    this.timeScale = 1;
    this.slowTimer = 0;
    this.deathT = 0;
    this.finished = false;
    this.introSeen = false;
    this.titleContext = "title";
    this.resultData = null;
    this.pendingCharacter = null;
    this.overlayReturn = "title";
    this.lastRunBest = null;
    this.hintTimer = 0;
    this.bossSpawnT = 0;
    this.bossIntroShown = false;
    this.debug = false;
  }

  // ---------------------------------------------------------------- screens
  showTitle() {
    this.state = "title";
    this.paused = false;
    this.run = null;
    this.room = null;
    this.enemies = [];
    this.projectiles = [];
    this.hitboxes = [];
    this.zones = [];
    this.pickups = [];
    this.timers = [];
    this.effects.clear();
    this.renderer.clearRoom();
    this.stage.clearAll();
    this.player = null;
    this.playerHandle = null;
    this.camera.shake = 0;
    this.finished = false;
    this.bossSpawnT = 0;
    this.ui.showTitle({
      continueAvailable: !!this.save.run,
      starlight: this.save.meta.starlight
    });
    this.ui.hideHud();
    this.audio.playBgm(BGM.title);
    this.input.enabled = false;
    this.input.clear();
  }

  showSelect() {
    this.state = "select";
    this.paused = false;
    this.renderer.clearRoom();
    this.stage.clearAll();
    this.effects.clear();
    this.ui.showSelect(this.save);
    this.ui.hideHud();
    this.audio.playBgm(BGM.select);
    this.input.enabled = false;
    this.input.clear();
  }

  startPressed() {
    this.audio.unlock();
    this.audio.sfx("click");
    this.showSelect();
  }

  backToTitle() {
    this.showTitle();
  }

  async beginRun(index) {
    const character = CHARACTERS[index];
    if (!character) return;
    this.audio.unlock();
    this.pendingCharacter = character;
    if (!this.introSeen) {
      this.introSeen = true;
      this.paused = true;
      this.ui.showStory(STORY.intro, () => this.startRun(character), () => this.startRun(character));
      return;
    }
    await this.startRun(character);
  }

  continuePressed() {
    const checkpoint = this.save.run;
    if (!checkpoint) { this.showTitle(); return; }
    const character = CHARACTERS.find(c => c.id === checkpoint.characterId);
    if (!character) { this.showTitle(); return; }
    this.audio.unlock();
    this.resumeRun(character, checkpoint);
  }

  async startRun(character) {
    const meta = metaBonuses(this.save);
    const run = {
      character,
      characterId: character.id,
      seed: (Math.floor(Math.random() * 900000000) + 1) | 0,
      actIndex: 0,
      roomIndex: 0,
      maxHp: character.hp + meta.maxHp,
      hp: character.hp + meta.maxHp,
      shield: 0,
      dust: meta.startDust,
      boons: {},
      kills: 0,
      time: 0,
      ult: 0,
      roomsCleared: 0,
      bosses: 0,
      revives: meta.revives,
      shopDiscount: false
    };
    this.run = run;
    this.recomputeStats();
    this.run.hp = this.run.maxHp;
    await this.loadRun(character, false);
  }

  async resumeRun(character, checkpoint) {
    const run = {
      character,
      characterId: character.id,
      seed: checkpoint.seed || 1234567,
      actIndex: clamp(checkpoint.actIndex | 0, 0, ACTS.length - 1),
      roomIndex: 0,
      maxHp: Math.max(1, Math.round(checkpoint.maxHp || character.hp)),
      hp: Math.max(1, Math.round(checkpoint.hp || character.hp)),
      shield: Math.max(0, Math.round(checkpoint.shield || 0)),
      dust: Math.max(0, Math.round(checkpoint.dust || 0)),
      boons: checkpoint.boons && typeof checkpoint.boons === "object" ? { ...checkpoint.boons } : {},
      kills: Math.max(0, checkpoint.kills | 0),
      time: Math.max(0, Number(checkpoint.time) || 0),
      ult: Math.max(0, Math.min(100, Number(checkpoint.ult) || 0)),
      roomsCleared: Math.max(0, checkpoint.roomsCleared | 0),
      bosses: Math.max(0, checkpoint.bosses | 0),
      revives: Math.max(0, checkpoint.revives | 0),
      shopDiscount: !!checkpoint.shopDiscount
    };
    const act = ACTS[run.actIndex];
    const maxRoom = act.rooms.length - 1;
    run.roomIndex = clamp(checkpoint.roomIndex | 0, 0, maxRoom);
    run.hp = Math.min(run.maxHp, run.hp);
    this.run = run;
    this.recomputeStats();
    this.introSeen = true;
    await this.loadRun(character, true);
  }

  async loadRun(character, resumed) {
    this.state = "loading";
    this.paused = true;
    this.finished = false;
    this.effects.clear();
    this.stage.clearAll();
    this.renderer.clearRoom();
    this.ui.setLoading(true, resumed ? "正在回到这一页…" : "正在唤醒 " + character.name + "…", 0.03);
    this.ui.fadeIn();
    let handle = null;
    try {
      handle = await this.stage.addPlayer(character, {
        onProgress: p => this.ui.setLoadingProgress(0.04 + p * 0.7)
      });
    } catch (error) {
      console.warn("starfall player model fallback:", error);
      handle = null;
    }
    if (!handle) handle = this.stage.addFallback(120, FLOOR_Y, 1);
    this.playerHandle = handle;
    this.ui.showHud(character);
    this.createPlayerEntity();
    await this.enterRoom({ first: true, resumed });
  }

  createPlayerEntity() {
    const char = this.run.character;
    const savedHp = this.run.hp;
    const savedMaxHp = this.run.maxHp;
    this.player = {
      x: 120,
      y: FLOOR_Y,
      vx: 0,
      vy: 0,
      w: 26,
      h: 72,
      face: 1,
      onGround: true,
      ground: null,
      coyote: 0.1,
      jumpsUsed: 0,
      jumpBuffer: 0,
      dropThrough: 0,
      dashT: 0,
      dashCd: 0,
      afterDashT: 0,
      attackT: 0,
      attackTotal: 0,
      attackBuffer: 0,
      comboIndex: -1,
      comboWindow: 0,
      skillCd: 0,
      inv: 0.8,
      hurtT: 0,
      animLock: 0,
      animState: "",
      dead: false,
      hp: savedHp,
      maxHp: savedMaxHp,
      shadowY: FLOOR_Y,
      lastHurtAt: -10,
      critBonusT: 0,
      character: char
    };
    this.run.hp = savedHp;
    this.run.maxHp = savedMaxHp;
  }

  // ---------------------------------------------------------------- stats
  recomputeStats() {
    const run = this.run;
    if (!run) return;
    const char = run.character;
    const meta = metaBonuses(this.save);
    const level = id => run.boons[id] || 0;
    const stats = {
      atkMul: (1 + 0.15 * level("edge") + 0.08 * level("knock")) * meta.atk,
      speedMul: (1 + 0.10 * level("haste")) * (1 + meta.speed - 1),
      dashCdMul: Math.max(0.45, (1 - 0.12 * level("swift")) * meta.dashCd * (char.id === "karen" ? 0.88 : 1)),
      crit: 0.05 + 0.08 * level("crit") + 0.05 * level("luck") + (char.id === "aoba" ? 0.08 : 0),
      critMul: 1.6 + 0.25 * level("critdmg") + (char.id === "aoba" ? 0.1 : 0),
      lifesteal: 1.2 * level("lifesteal"),
      jumps: level("doublejump") > 0 ? 1 : 0,
      multishot: level("multishot"),
      pierce: level("pierce"),
      dashDamage: 20 * level("dashblast"),
      thorn: 22 * level("thorn"),
      roomShield: 22 * level("shieldstart"),
      killHeal: 2 * level("healkill") + (char.id === "cocoa" ? 2 : 0),
      dustMul: (1 + 0.25 * level("dust")) * (1 + 0.10 * level("magnet")) * (1 + 0.10 * level("luck")),
      ultRate: 1 + 0.25 * level("ultcharge"),
      skillCdMul: Math.max(0.5, 1 - 0.15 * level("cdr")),
      burn: 4 * level("burn"),
      slow: Math.min(0.5, 0.25 * level("slow")),
      knockMul: 1 + 0.35 * level("knock"),
      comboBonus: 0.35 * level("combo"),
      exec: 0.40 * level("exec"),
      armor: Math.max(0.5, 1 - 0.12 * level("armor")),
      magnetRange: 140 + (level("magnet") ? 160 : 0),
      firstHit: 0.50 * level("firsthit"),
      skillPower: 1 + 0.30 * level("skillpower"),
      airborne: 1 + 0.25 * level("airborne"),
      healPower: 1 + 0.30 * level("healpower")
    };
    run.stats = stats;
  }

  stash() {
    const run = this.run;
    if (!run) return;
    stashRun(this.save, {
      characterId: run.characterId,
      seed: run.seed,
      actIndex: run.actIndex,
      roomIndex: run.roomIndex,
      hp: Math.max(0, Math.round(run.hp)),
      maxHp: Math.round(run.maxHp),
      shield: Math.max(0, Math.round(run.shield)),
      dust: Math.max(0, Math.round(run.dust)),
      boons: { ...run.boons },
      kills: run.kills,
      time: Math.round(run.time),
      ult: Math.round(run.ult),
      roomsCleared: run.roomsCleared,
      bosses: run.bosses,
      revives: run.revives,
      shopDiscount: run.shopDiscount
    });
  }

  addBoon(def) {
    const run = this.run;
    const level = run.boons[def.id] || 0;
    run.boons[def.id] = level + 1;    this.recomputeStats();
    if (def.id === "vital") {
      run.maxHp += 18;
      run.hp = Math.min(run.maxHp, run.hp + 18);
      if (this.player) { this.player.maxHp = run.maxHp; this.player.hp = run.hp; }
    }
    if (def.id === "revive") {
      run.revives += 1;
      this.ui.setRevive(run.revives);
    }
    if (run.character.id === "kirara") this.healPlayer(4, { silent: true });
    this.ui.setBoons(Object.values(run.boons).reduce((a, b) => a + b, 0));
    this.ui.toast("拾起星愿 · " + def.name);
    this.effects.ring(this.player.x, this.player.y - 20, "#ffe6a8", 46, 0.6, 3);
    this.effects.burst(this.player.x, this.player.y - 56, { count: 18, colors: ["#ffe6a8", "#ffb7ca", "#fff"], speed: 170, life: 0.8, size: 2.6, gravity: -30, kind: "star" });
    this.audio.sfx("card");
    this.stash();
  }

  // ---------------------------------------------------------------- room flow
  async enterRoom({ first = false, resumed = false } = {}) {
    const run = this.run;
    const act = ACTS[run.actIndex];
    const type = act.rooms[run.roomIndex] || "combat";
    const biomeIndex = act.biome;
    this.state = "loading";
    this.paused = true;
    this.ui.setLoading(true, first ? "正在布置第" + (run.actIndex + 1) + "卷…" : "正在翻到下一页…", 0.55);
    this.hitStop = 0;
    this.timeScale = 1;
    this.slowTimer = 0;
    this.waveIndex = -1;
    this.waveActive = false;
    this.waveLoading = false;
    this.waveGap = 0;
    this.clearTimer = 0;
    this.bossSpawnT = 0;
    this.bossIntroShown = false;
    this.timers = [];
    this.enemies = [];
    this.projectiles = [];
    this.hitboxes = [];
    this.zones = [];
    this.pickups = [];
    this.effects.clear();
    this.stage.clearEnemies();

    const room = generateRoom({
      type,
      actIndex: run.actIndex,
      roomIndex: run.roomIndex,
      seed: run.seed + run.actIndex * 7717 + run.roomIndex * 397,
      biome: biomeIndex
    });
    this.room = room;
    this.renderer.setRoom(room);
    this.setupRoomProps(room, type);
    this.addRoomDecorEffects(room);

    const p = this.player;
    p.x = 120;
    p.y = FLOOR_Y;
    p.vx = 0;
    p.vy = 0;
    p.face = 1;
    p.onGround = true;
    p.dead = false;
    p.attackT = 0;
    p.attackBuffer = 0;
    p.comboIndex = -1;
    p.comboWindow = 0;
    p.dashT = 0;
    p.dashCd = 0;
    p.skillCd = 0;
    p.inv = 0.9;
    p.hurtT = 0;
    p.animLock = 0;
    p.animState = "";
    p.hp = run.hp;
    p.maxHp = run.maxHp;
    p.shadowY = FLOOR_Y;
    if (this.playerHandle) {
      this.playerHandle.setVisible(true);
      this.playerHandle.setTilt(0);
      this.playerHandle.move(p.x, p.y);
      this.playerHandle.play("idle", { fade: 0 });
    }
    this.camera.snap(p, room);
    this.camera.shake = 0;

    if (run.stats.roomShield > 0) {
      run.shield = Math.min(999, run.shield + run.stats.roomShield);
    }

    this.buildWavePlan(room, type);
    this.ui.setAct(
      BIOMES[biomeIndex].act + " · " + BIOMES[biomeIndex].name,
      "第 " + (run.roomIndex + 1) + " 页 · " + ROOM_TYPE_LABEL[type],
      act.rooms,
      run.roomIndex
    );
    this.ui.setHp(run.hp, run.maxHp, run.shield);
    this.ui.setDust(run.dust);
    this.ui.setUlt(run.ult);
    this.ui.setBoons(Object.values(run.boons).reduce((a, b) => a + b, 0));
    this.ui.setRevive(run.revives);
    this.ui.hideInteract();
    this.ui.hideBoss();
    this.ui.setHintVisible(run.actIndex === 0 && run.roomIndex === 0);

    if (type === "combat" || type === "elite") {
      this.ui.setLoadingProgress(0.82);
      await this.spawnWave(0, true);
    } else if (type === "boss") {
      const boss = room.boss;
      this.ui.setLoadingProgress(0.88);
      this.bossSpawnT = 1.15;
      this.ui.waveBanner(boss.name, boss.title, 2200);
      this.ui.toast(boss.intro, 3800);
      this.audio.playBgm(BGM.boss[run.actIndex] || BGM.boss[0]);
    } else if (type === "shop") {
      this.audio.playBgm(BGM.shop);
      this.ui.waveBanner("星灯小铺", "买一点星屑换来的好心情", 1800);
    } else {
      this.audio.playBgm(BGM.rest);
      this.ui.waveBanner("星灯营地", "在下一页打开之前，先歇一会儿", 1800);
    }

    if (type === "combat" || type === "elite") {
      this.audio.playBgm(type === "elite" ? BGM.elite : BGM.battle[run.actIndex] || BGM.battle[0]);
      if (!resumed) this.ui.waveBanner(BIOMES[biomeIndex].act + " · " + BIOMES[biomeIndex].name, BIOMES[biomeIndex].sub, 2100);
    }
    this.ui.setLoading(false);
    this.ui.fadeIn();
    this.state = "playing";
    this.paused = false;
    this.input.enabled = true;
    this.input.clear();
    if (resumed) this.ui.toast("从这一页继续漫游");
    else if (run.actIndex === 0 && run.roomIndex === 0) this.ui.toast("A / D 移动 · 空格跳跃 · J 攻击 · K 特技 · L 闪身 · Q 星坠", 5200);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.ui.setHintVisible(false), 9000);
    this.stash();
  }

  setupRoomProps(room, type) {
    if (type === "shop") {
      const pool = SHOP_STOCK.slice();
      const chosen = [];
      const preferred = ["heal", "boon", "shield", "maxhp", "rareboon", "discount"];
      while (chosen.length < 3 && pool.length) {
        const id = preferred[Math.floor(Math.random() * preferred.length)];
        const item = pool.find(entry => entry.id === id);
        if (!item) continue;
        chosen.push(item);
        pool.splice(pool.indexOf(item), 1);
      }
      room.pedestals.forEach((pedestal, i) => {
        const item = chosen[i];
        if (!item) return;
        pedestal.item = {
          ...item,
          price: Math.max(8, Math.round(item.price * (this.run.shopDiscount ? 0.8 : 1)))
        };
      });
    }
  }

  addRoomDecorEffects(room) {
    // A couple of drifting lights at the room entrance so the first frame of a
    // new page already has some motion in it.
    for (let i = 0; i < 10; i++) {
      this.effects.burst(80 + i * 40, 320 + Math.random() * 90, {
        count: 1, colors: [BIOMES[room.biome].particle], speed: 10, life: 2.2 + Math.random() * 2,
        size: 1.4, gravity: -4, kind: "dot"
      });
    }
  }

  buildWavePlan(room, type) {
    if (type !== "combat" && type !== "elite") { room.wavePlan = []; return; }
    const act = ACTS[this.run.actIndex];
    const rng = mulberry32(room.seed + 91);
    const waveCount = type === "elite" ? 2 : (this.run.roomIndex === 0 ? 2 : 3);
    const plan = [];
    for (let i = 0; i < waveCount; i++) {
      const wave = [];
      const count = (type === "elite" ? 2 : 2) + i + (this.run.actIndex >= 1 ? 1 : 0) + (this.run.roomIndex >= 2 ? 1 : 0);
      const pool = act.pool.slice();
      for (let j = 0; j < count; j++) {
        let poolIndex = Math.floor(rng() * pool.length);
        if (this.run.roomIndex === 0 && j < 2 && pool[poolIndex] === "fish") poolIndex = 0;
        wave.push({ type: pool[poolIndex] });
      }
      if (type === "elite" && i === waveCount - 1) {
        wave.push({ type: act.elitePool[Math.floor(rng() * act.elitePool.length)], elite: true });
      }
      plan.push(wave);
    }
    room.wavePlan = plan;
  }

  async spawnWave(index, wait = false) {
    if (!this.room || !this.room.wavePlan) return;
    if (this.waveLoading) return;
    this.waveIndex = index;
    const plan = this.room.wavePlan[index] || [];
    if (!plan.length) return;
    this.waveLoading = true;
    this.waveActive = true;
    const rng = mulberry32(this.room.seed + index * 71 + 3);
    const spawns = plan.map(spec => {
      const def = ENEMIES[spec.type];
      const flying = def && def.kind === "flyer";
      const pos = findSpawn(this.room, rng, { flying, minFrom: this.player.x });
      return { spec, pos };
    });
    const enemies = await Promise.all(spawns.map(({ spec, pos }) => this.createEnemy(spec, pos)));
    if (!this.room || this.room.type === "shop" || this.room.type === "rest") {
      enemies.forEach(enemy => this.removeEnemy(enemy));
      this.waveLoading = false;
      return;
    }
    this.enemies.push(...enemies);
    this.waveLoading = false;
    this.ui.waveBanner(
      index >= this.room.wavePlan.length - 1 ? "最后一波" : "第 " + (index + 1) + " 波",
      index >= this.room.wavePlan.length - 1 ? "把这一页读到句号" : "星屑在靠近",
      1300
    );
    this.audio.sfx("wave");
  }

  async createEnemy(spec, pos) {
    const def = enemyDef(spec.type, this.run.actIndex);
    const elite = !!spec.elite;
    const actScale = [1, 1.55, 2.2][this.run.actIndex] || 1;
    const roomScale = 1 + this.run.roomIndex * 0.045;
    const maxHp = Math.max(1, Math.round(def.hp * actScale * roomScale * (elite ? 2.3 : 1)));
    const damageScale = [1, 1.25, 1.5][this.run.actIndex] || 1;
    const entity = {
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      w: def.hitbox[0] * (elite ? 1.24 : 1),
      h: def.hitbox[1] * (elite ? 1.24 : 1),
      face: -1,
      def,
      kind: def.kind,
      type: def.id,
      hp: maxHp,
      maxHp,
      damage: def.damage * damageScale * (elite ? 1.3 : 1),
      elite,
      dead: false,
      gone: false,
      deathT: 0,
      spawnT: 0.55,
      flash: 0,
      onGround: true,
      ground: null,
      hitWall: 0,
      homeX: pos.x,
      patrolDir: Math.random() < 0.5 ? -1 : 1,
      timer: 0.6 + Math.random() * 1.2,
      attackCd: 0.8 + Math.random() * 1.4,
      state: "spawn",
      baseY: pos.y,
      phase: Math.random() * Math.PI * 2,
      shadowY: pos.y,
      seed: Math.random() * 1000,
      burnT: 0,
      burnTick: 0,
      slowT: 0,
      anim: "",
      handle: null,
      isBoss: false
    };
    try {
      entity.handle = await this.stage.addEnemy(def.model, {
        height: def.height * (elite ? 1.27 : 1),
        x: pos.x,
        groundY: pos.y,
        facing: -1
      });
      entity.handle.play("idle", { loop: true, fade: 0 });
    } catch (error) {
      console.warn("starfall enemy model missing:", spec.type, error);
      entity.fallback = true;
    }
    entity.anim = "idle";
    this.effects.ring(pos.x, pos.y, elite ? "#ffb06b" : ELEMENTS[def.element].color, elite ? 54 : 33, 0.55, 2.5);
    return entity;
  }

  removeEnemy(enemy) {
    if (!enemy) return;
    if (enemy.handle) {
      try { this.stage.remove(enemy.handle); } catch (error) { console.warn(error); }
      enemy.handle = null;
    }
    enemy.gone = true;
  }

  async spawnBoss() {
    const room = this.room;
    if (!room || room.type !== "boss" || !room.boss || room.boss.spawned) return;
    const def = room.boss;
    def.spawned = true;
    const entity = {
      x: room.boss.x || room.w * 0.55,
      y: FLOOR_Y,
      vx: 0,
      vy: 0,
      w: def.hitbox[0],
      h: def.hitbox[1],
      face: -1,
      def,
      kind: "boss",
      type: "boss",
      hp: def.hp,
      maxHp: def.hp,
      damage: [16, 18, 21][this.run.actIndex] || 18,
      elite: false,
      dead: false,
      gone: false,
      deathT: 0,
      spawnT: 0,
      flash: 0,
      onGround: true,
      ground: null,
      hitWall: 0,
      timer: 0,
      attackCd: 1.6,
      state: "intro",
      introT: 1.1,
      baseY: FLOOR_Y,
      phase: 1,
      shadowY: FLOOR_Y,
      seed: 1,
      burnT: 0,
      burnTick: 0,
      slowT: 0,
      anim: "",
      handle: null,
      isBoss: true,
      chargeT: 0,
      lastShownHp: -1
    };
    this.enemies.push(entity);
    try {
      entity.handle = await this.stage.addEnemy(def.model, {
        height: def.height,
        x: entity.x,
        groundY: FLOOR_Y,
        facing: -1
      });
      entity.handle.play("idle", { loop: true, fade: 0 });
    } catch (error) {
      console.warn("starfall boss model missing:", error);
      entity.fallback = true;
    }
    this.ui.setBoss(def.name, def.title, entity.hp, entity.maxHp, 1);
    this.audio.sfx("boss");
    this.effects.ring(entity.x, FLOOR_Y, def.color, 120, 0.9, 4);
    this.effects.burst(entity.x, FLOOR_Y - 80, { count: 26, colors: [def.color, "#ffe6a8", "#fff"], speed: 230, life: 1.1, size: 3, gravity: -20, kind: "star" });
    this.camera.kick(7);
  }

  // ---------------------------------------------------------------- update
  update(dt) {
    this.time += dt;
    if (this.state === "title" || this.state === "select") {
      this.titleTime += dt;
      this.effects.update(dt * 0.4);
      return;
    }
    if (this.state === "loading" || this.state === "result") return;
    if (this.state === "dying") {
      this.deathT -= dt;
      this.effects.update(dt);
      this.updatePlayerVisuals(dt);
      this.camera.follow(this.player, this.room, dt);
      if (this.deathT <= 0) this.finishRun(false);
      return;
    }
    if (this.paused) return;
    if (!this.room || !this.player) return;

    if (this.input.pressed("pause")) { this.pause(); return; }
    if (this.input.pressed("mute")) {
      this.audio.setMuted(!this.audio.muted);
      this.ui.toast(this.audio.muted ? "声音已关闭" : "声音已开启");
    }

    if (this.hitStop > 0) {
      this.hitStop -= dt;
      this.effects.update(dt * 0.35);
      this.updateHUD();
      return;
    }

    if (this.slowTimer > 0) {
      this.slowTimer -= dt;
      this.timeScale = lerp(1, 0.32, clamp(this.slowTimer / 0.9, 0, 1));
    } else {
      this.timeScale = 1;
    }
    const sdt = dt * this.timeScale;
    this.run.time += sdt;
    this.run.ult = Math.max(0, this.run.ult);
    this.updatePlayer(sdt);
    this.updateEnemies(sdt);
    this.updateProjectiles(sdt);
    this.updateHitboxes(sdt);
    this.updateZones(sdt);
    this.updatePickups(sdt);
    this.updateTimers(sdt);
    this.updateRoomState(sdt);
    this.effects.update(sdt);
    this.camera.follow(this.player, this.room, dt);
    this.updateInteraction();
    this.updateHUD();
  }

  updatePlayer(dt) {
    const p = this.player;
    const s = this.run.stats;
    const char = this.run.character;
    if (!p || p.dead) return;

    p.inv = Math.max(0, p.inv - dt);
    p.hurtT = Math.max(0, p.hurtT - dt);
    p.animLock = Math.max(0, p.animLock - dt);
    p.attackT = Math.max(0, p.attackT - dt);
    p.attackBuffer = Math.max(0, p.attackBuffer - dt);
    p.comboWindow = Math.max(0, p.comboWindow - dt);
    p.dashCd = Math.max(0, p.dashCd - dt);
    p.dashT = Math.max(0, p.dashT - dt);
    p.afterDashT = Math.max(0, p.afterDashT - dt);
    p.skillCd = Math.max(0, p.skillCd - dt);
    p.critBonusT = Math.max(0, p.critBonusT - dt);
    p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);

    if (p.animLock <= 0 && p.attackT <= 0) {
      // state transitions are resolved after physics
    }

    // dash owns the horizontal velocity while it runs
    if (p.dashT > 0) {
      p.vx = p.face * 760;
      p.vy = 0;
      p.inv = Math.max(p.inv, 0.08);
      if (Math.random() < 0.65) {
        this.effects.burst(p.x - p.face * 8, p.y - 30 - Math.random() * 26, {
          count: 1, colors: ["#d6efff", char.color, "#ffffff"], speed: 40, life: 0.3, size: 2.2, gravity: -20, kind: "dot"
        });
      }
      if (p.dashT <= dt) p.vx *= 0.42;
    } else {
      const axis = this.input.axisX();
      const maxSpeed = char.speed * s.speedMul * (p.attackT > 0 ? 0.72 : 1);
      if (axis !== 0 && p.hurtT <= 0) {
        p.vx += axis * (p.onGround ? 1900 : 1250) * dt;
        p.vx = clamp(p.vx, -maxSpeed, maxSpeed);
        if (p.attackT <= 0) p.face = axis;
      } else {
        const friction = p.onGround ? 0.0008 : 0.02;
        p.vx *= Math.pow(friction, dt);
        if (Math.abs(p.vx) < 4) p.vx = 0;
      }
    }

    // jump buffering, coyote time and the optional air jump
    if (this.input.pressed("jump")) p.jumpBuffer = 0.13;
    const maxJumps = char.jumps + s.jumps;
    if (p.jumpBuffer > 0) {
      if (p.onGround || p.coyote > 0) {
        if (this.input.down("down") && p.ground && p.ground.oneway) {
          p.dropThrough = 0.22;
          p.y += 3;
          p.vy = 50;
          p.onGround = false;
          p.jumpBuffer = 0;
        } else {
          p.vy = -575;
          p.onGround = false;
          p.ground = null;
          p.coyote = 0;
          p.jumpsUsed = 1;
          p.jumpBuffer = 0;
          p.animState = "";
          this.effects.burst(p.x, p.y, { count: 6, colors: ["#fff2d5", BIOMES[this.room.biome].particle], speed: 55, life: 0.35, size: 2, gravity: 80, angle: -Math.PI / 2, spread: 2.2 });
          this.audio.sfx("jump");
        }
      } else if (p.jumpsUsed < maxJumps && p.jumpsUsed > 0) {
        p.vy = -535;
        p.jumpsUsed++;
        p.jumpBuffer = 0;
        p.animState = "";
        this.effects.ring(p.x, p.y - 6, "#cfeeff", 22, 0.34, 2);
        this.effects.burst(p.x, p.y - 12, { count: 8, colors: ["#d9f2ff", "#fff"], speed: 70, life: 0.4, size: 1.8, gravity: 40 });
        this.audio.sfx("doubleJump");
      }
    }
    if (this.input.released("jump") && p.vy < -180) p.vy *= 0.55;

    // attack
    if (this.input.pressed("attack")) this.tryAttack();

    // skill
    if (this.input.pressed("skill")) this.trySkill();

    // starfall
    if (this.input.pressed("ult")) this.tryUlt();

    // dash
    if (this.input.pressed("dash") && p.dashCd <= 0 && p.dashT <= 0 && p.hurtT <= 0) {
      p.dashT = 0.155;
      p.dashCd = BASE_DASH_CD * s.dashCdMul;
      p.inv = Math.max(p.inv, 0.22);
      p.afterDashT = 0.42;
      p.vy = 0;
      p.face = this.input.axisX() || p.face;
      p.animState = "";
      this.audio.sfx("dash");
      this.effects.burst(p.x, p.y - 30, { count: 12, colors: ["#e2f4ff", "#ffffff", char.color], speed: 150, life: 0.38, size: 2.2, gravity: -10 });
      if (s.dashDamage > 0) {
        this.hitboxes.push({
          x: p.x - 46, y: p.y - 72, w: 92, h: 72, damage: s.dashDamage,
          life: 0.18, hit: new Set(), knockback: 140, element: char.element,
          color: char.color, isSkill: true, source: "dash", combo: false, air: false
        });
      }
    }

    // gravity and collision
    if (p.dashT <= 0) {
      p.vy = Math.min(920, p.vy + GRAVITY * dt);
    }
    const wasGround = p.onGround;
    moveBody(p, dt, this.room);
    if (p.onGround && !wasGround) {
      p.jumpsUsed = 0;
      p.animState = "";
      this.effects.burst(p.x, p.y, { count: 5, colors: ["#fff3dc", BIOMES[this.room.biome].particle], speed: 40, life: 0.3, size: 1.8, gravity: 100, angle: -Math.PI / 2, spread: 2.6 });
    }
    if (p.onGround) p.jumpsUsed = 0;
    p.shadowY = p.onGround ? p.y : surfaceBelow(this.room, p.x, p.y);

    // spikes
    for (const hazard of this.room.hazards) {
      if (rectsOverlap(this.bodyRect(p), hazard) && p.inv <= 0) {
        this.hurtPlayer(9 + this.run.actIndex * 2, hazard.x + hazard.w / 2, { source: "spike" });
        p.vy = -350;
        p.vx = p.face * -170;
      }
    }

    // attack buffer release
    if (p.attackT <= 0 && p.attackBuffer > 0 && p.animLock <= 0) {
      p.attackBuffer = 0;
      this.startAttack();
    }

    // keep the model in sync
    this.updatePlayerVisuals(dt);
  }

  updatePlayerVisuals(dt) {
    const p = this.player;
    const h = this.playerHandle;
    if (!p || !h) return;
    h.move(p.x, p.y);
    h.mirror(p.face);
    h.update(dt);
    if (p.inv > 0 && p.inv < 0.8) {
      h.setVisible(Math.floor(p.inv * 24) % 2 === 0);
    } else if (!p.dead) {
      h.setVisible(true);
    }
    if (p.dead) return;
    const s = this.run.stats;
    if (p.animLock > 0) return;
    if (p.attackT > 0) {
      if (p.animState !== "attack") {
        this.setPlayerAnim("attack", { loop: false, duration: p.attackTotal, fade: 0.04 });
      }
      return;
    }
    if (!p.onGround) {
      if (p.animState !== "jump") this.setPlayerAnim("kirarajump_0", { loop: false, duration: 0.72, fade: 0.06 });
      return;
    }
    if (Math.abs(p.vx) > 18) {
      if (p.animState !== "run") this.setPlayerAnim("battle_run", { loop: true, duration: 0, fade: 0.1 });
    } else if (p.animState !== "idle") {
      this.setPlayerAnim("idle", { loop: true, fade: 0.1 });
    }
  }

  setPlayerAnim(name, options) {
    if (!this.playerHandle) return;
    const ok = this.playerHandle.play(name, options);
    if (ok) this.player.animState = name === "battle_run" ? "run" : name === "kirarajump_0" ? "jump" : name;
  }

  bodyRect(entity) {
    return { x: entity.x - entity.w / 2, y: entity.y - entity.h, w: entity.w, h: entity.h };
  }

  tryAttack() {
    const p = this.player;
    if (!p || p.dead) return;
    if (p.animLock > 0 && p.attackT <= 0) return;
    if (p.attackT > 0) {
      p.attackBuffer = 0.24;
      return;
    }
    this.startAttack();
  }

  startAttack() {
    const p = this.player;
    const char = this.run.character;
    const data = ATTACKS[char.classId];
    const third = p.comboWindow > 0 ? (p.comboIndex + 1) % 3 : 0;
    p.comboIndex = third;
    const duration = data.duration[third] || data.duration[0];
    p.attackT = duration;
    p.attackTotal = duration;
    p.comboWindow = duration + 0.28;
    p.animLock = duration;
    p.animState = "";
    this.faceTowardsThreat();
    if (p.onGround) p.vx += p.face * (third === 2 ? 110 : 45);
    this.setPlayerAnim("attack", { loop: false, duration, fade: 0.03 });
    this.audio.sfx("slash");
    const active = Math.max(0.045, duration * 0.3);
    if (data.kind === "melee") {
      this.after(active, () => this.resolveMelee(third, data));
    } else if (data.kind === "projectile") {
      this.after(active, () => this.fireBasicProjectile(data));
    } else {
      this.after(active, () => this.fireFlask(data));
    }
  }

  faceTowardsThreat() {
    const p = this.player;
    let best = null;
    let bestDist = 170;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const d = Math.abs(enemy.x - p.x);
      if (d < bestDist && Math.abs(enemy.y - p.y) < 110) { best = enemy; bestDist = d; }
    }
    if (best) p.face = best.x >= p.x ? 1 : -1;
    else if (this.input.axisX() !== 0) p.face = this.input.axisX();
  }

  resolveMelee(combo, data) {
    const p = this.player;
    if (!p || p.dead) return;
    const s = this.run.stats;
    const char = this.run.character;
    const range = data.range * (combo === 2 ? 1.18 : 1);
    const box = {
      x: p.x + p.face * 10 - (p.face > 0 ? 0 : range),
      y: p.y - 76,
      w: range,
      h: 74,
      damage: data.combo[combo],
      life: 0.09,
      hit: new Set(),
      knockback: data.knockback[combo],
      element: char.element,
      color: char.color,
      isSkill: false,
      source: "melee",
      combo: combo === 2,
      air: !p.onGround
    };
    this.hitboxes.push(box);
    this.effects.slash(p.x + p.face * 26, p.y - 38, p.face, char.color, combo === 2 ? 1.35 : 0.92);
    if (combo === 2) {
      this.effects.ring(p.x + p.face * 36, p.y - 36, char.color, 34, 0.3, 2.5);
      this.camera.kick(3.2);
    }
    if (s.multishot > 0) {
      for (let i = 0; i < s.multishot; i++) {
        this.spawnPlayerProjectile({
          x: p.x + p.face * 22,
          y: p.y - 54,
          vx: p.face * 520,
          vy: -60 - i * 30,
          damage: data.combo[combo] * 0.45,
          radius: 7,
          life: 1.1,
          pierce: 0,
          kind: "star",
          color: ELEMENTS[char.element].glow,
          isSkill: false,
          combo: false,
          air: !p.onGround
        });
      }
    }
  }

  fireBasicProjectile(data) {
    const p = this.player;
    if (!p || p.dead) return;
    const s = this.run.stats;
    const char = this.run.character;
    const baseAngle = 0;
    const shots = 1 + s.multishot;
    for (let i = 0; i < shots; i++) {
      const spread = shots === 1 ? 0 : (i - (shots - 1) / 2) * 0.13;
      this.spawnPlayerProjectile({
        x: p.x + p.face * 24,
        y: p.y - 52,
        vx: Math.cos(baseAngle + spread) * 680 * p.face,
        vy: Math.sin(spread) * 680,
        damage: data.damage,
        radius: 7,
        life: 1.4,
        pierce: s.pierce,
        kind: "bolt",
        color: ELEMENTS[char.element].glow,
        isSkill: false,
        combo: false,
        air: !p.onGround
      });
    }
    this.effects.ring(p.x + p.face * 26, p.y - 52, ELEMENTS[char.element].glow, 18, 0.24, 2);
  }

  fireFlask(data) {
    const p = this.player;
    if (!p || p.dead) return;
    const char = this.run.character;
    this.spawnPlayerProjectile({
      x: p.x + p.face * 20,
      y: p.y - 54,
      vx: p.face * 460,
      vy: -250,
      damage: data.damage,
      radius: 9,
      life: 2.2,
      pierce: 0,
      kind: "flask",
      color: ELEMENTS[char.element].glow,
      gravity: 860,
      blast: data.blast,
      isSkill: false,
      combo: false,
      air: !p.onGround
    });
  }

  spawnPlayerProjectile(opts) {
    this.projectiles.push({
      owner: "player",
      x: opts.x,
      y: opts.y,
      vx: opts.vx,
      vy: opts.vy,
      radius: opts.radius || 7,
      damage: opts.damage || 10,
      life: opts.life || 1.2,
      maxLife: opts.life || 1.2,
      pierce: opts.pierce || 0,
      hit: new Set(),
      kind: opts.kind || "bolt",
      color: opts.color || "#ffe9a8",
      gravity: opts.gravity || 0,
      blast: opts.blast || 0,
      homing: !!opts.homing,
      isSkill: !!opts.isSkill,
      combo: !!opts.combo,
      air: !!opts.air,
      element: this.run.character.element,
      trail: opts.trail !== false
    });
  }

  trySkill() {
    const p = this.player;
    const char = this.run.character;
    if (!p || p.dead || p.skillCd > 0) return;
    const s = this.run.stats;
    p.skillCd = char.skill.cd * s.skillCdMul;
    p.animLock = 0.78;
    p.animState = "";
    p.inv = Math.max(p.inv, 0.3);
    this.faceTowardsThreat();
    this.setPlayerAnim("class_skill_1", { loop: false, duration: 0.95, fade: 0.05 });
    this.audio.sfx("skill");
    this.effects.ring(p.x, p.y - 32, char.color, 44, 0.5, 3);
    this.camera.kick(2);
    switch (char.skill.type) {
      case "healStars": return this.skillHealStars(p);
      case "shieldCharge": return this.skillShieldCharge(p);
      case "rapidFlurry": return this.skillRapidFlurry(p);
      case "windPierce": return this.skillWindPierce(p);
      case "poisonFlask": return this.skillPoisonFlask(p);
      case "spinBlades": return this.skillSpinBlades(p);
      default: return undefined;
    }
  }

  skillHealStars(p) {
    const s = this.run.stats;
    const char = this.run.character;
    this.healPlayer(p.maxHp * 0.14, { silent: false });
    for (let i = 0; i < 5; i++) {
      const angle = -Math.PI / 2 + (i - 2) * 0.42;
      this.spawnPlayerProjectile({
        x: p.x, y: p.y - 52,
        vx: Math.cos(angle) * 470,
        vy: Math.sin(angle) * 470,
        damage: 11 * s.skillPower,
        radius: 6, life: 1.9, pierce: 0, kind: "star", color: "#ffe6a0",
        homing: true, isSkill: true, element: char.element
      });
    }
    this.effects.burst(p.x, p.y - 50, { count: 16, colors: ["#ffe7a8", "#fff", "#ffb8d0"], speed: 150, life: 0.8, size: 2.4, gravity: -20, kind: "star" });
  }

  skillShieldCharge(p) {
    const s = this.run.stats;
    const char = this.run.character;
    p.dashT = 0.26;
    p.inv = Math.max(p.inv, 1.2);
    p.vx = p.face * 820;
    this.run.shield = Math.min(999, this.run.shield + 24);
    this.hitboxes.push({
      x: p.x + p.face * 14 - (p.face > 0 ? 0 : 110),
      y: p.y - 82, w: 110, h: 82,
      damage: 46, life: 0.3, hit: new Set(),
      knockback: 300, element: char.element, color: "#cde9ff",
      isSkill: true, source: "skill", combo: false, air: false
    });
    this.effects.beam(p.x, p.y - 40, p.x + p.face * 130, p.y - 40, "#d7f1ff", 0.3, 7);
    this.effects.burst(p.x, p.y - 40, { count: 14, colors: ["#d7f1ff", "#fff"], speed: 180, life: 0.6, size: 2.3, gravity: 0 });
    this.camera.kick(4);
    this.ui.setHp(this.run.hp, this.run.maxHp, this.run.shield);
  }

  skillRapidFlurry(p) {
    const char = this.run.character;
    p.animLock = 0.95;
    p.inv = Math.max(p.inv, 0.95);
    for (let i = 0; i < 8; i++) {
      this.after(i * 0.085, () => {
        if (!this.player || this.player.dead) return;
        const s = this.run.stats;
        this.faceTowardsThreat();
        const face = this.player.face;
        this.hitboxes.push({
          x: this.player.x + face * 8 - (face > 0 ? 0 : 68),
          y: this.player.y - 78, w: 68, h: 76,
          damage: 9, life: 0.08, hit: new Set(),
          knockback: 90, element: char.element, color: char.color,
          isSkill: true, source: "skill", combo: false, air: false
        });
        this.effects.slash(this.player.x + face * 24, this.player.y - 38, i % 2 ? -face : face, char.color, 1.05);
        this.audio.sfx("slash");
        void s;
      });
    }
    this.effects.ring(p.x, p.y - 36, "#ffe0a0", 46, 0.7, 2);
  }

  skillWindPierce(p) {
    const char = this.run.character;
    const s = this.run.stats;
    this.spawnPlayerProjectile({
      x: p.x + p.face * 18, y: p.y - 50,
      vx: p.face * 860, vy: 0,
      damage: 58, radius: 15, life: 1.5,
      pierce: 3, kind: "wind", color: "#b9f0d8",
      isSkill: true, element: char.element
    });
    this.effects.beam(p.x, p.y - 50, p.x + p.face * 180, p.y - 50, "#b9f0d8", 0.24, 6);
    this.effects.burst(p.x + p.face * 40, p.y - 50, { count: 12, colors: ["#b9f0d8", "#fff"], speed: 160, life: 0.5, size: 2.1, gravity: 0 });
    this.camera.kick(3);
    void s;
  }

  skillPoisonFlask(p) {
    const char = this.run.character;
    this.spawnPlayerProjectile({
      x: p.x + p.face * 18, y: p.y - 56,
      vx: p.face * 520, vy: -180,
      damage: 8, radius: 10, life: 2.2,
      pierce: 0, kind: "flask", color: "#c9a8ff",
      gravity: 900, blast: 62,
      isSkill: true, element: char.element,
      poison: true
    });
    this.effects.ring(p.x, p.y - 46, "#c9a8ff", 30, 0.4, 2);
  }

  skillSpinBlades(p) {
    const char = this.run.character;
    p.animLock = 0.72;
    p.inv = Math.max(p.inv, 0.55);
    p.critBonusT = 1.6;
    for (let i = 0; i < 3; i++) {
      this.after(i * 0.18, () => {
        if (!this.player || this.player.dead) return;
        const face = this.player.face;
        this.hitboxes.push({
          x: this.player.x - 86, y: this.player.y - 88, w: 172, h: 88,
          damage: 19, life: 0.14, hit: new Set(),
          knockback: 180, element: char.element, color: "#ffe0a0",
          isSkill: true, source: "skill", combo: false, air: false
        });
        this.effects.slash(this.player.x + face * 30, this.player.y - 38, face, "#ffd88a", 1.2);
        this.effects.slash(this.player.x - face * 30, this.player.y - 38, -face, "#ffd88a", 1.2);
        this.audio.sfx("slash");
      });
    }
    this.effects.ring(p.x, p.y - 36, "#ffd88a", 72, 0.6, 3);
    this.camera.kick(4);
  }

  tryUlt() {
    const p = this.player;
    const char = this.run.character;
    if (!p || p.dead || this.run.ult < 100) return;
    this.run.ult = 0;
    p.animLock = 1.25;
    p.inv = Math.max(p.inv, 2);
    p.animState = "";
    this.faceTowardsThreat();
    this.setPlayerAnim("class_skill_2", { loop: false, duration: 1.5, fade: 0.05 });
    this.audio.sfx("ult");
    this.effects.flashScreen(0.28, "#fff2cf");
    this.camera.kick(9);
    this.ui.setUlt(0);
    switch (char.ult.type) {
      case "starShower": return this.ultStarShower(p);
      case "moonGuard": return this.ultMoonGuard(p);
      case "sunburst": return this.ultSunburst(p);
      case "galePage": return this.ultGalePage(p);
      case "moonFall": return this.ultMoonFall(p);
      case "hundredViews": return this.ultHundredViews(p);
      default: return undefined;
    }
  }

  ultStarShower(p) {
    const char = this.run.character;
    this.healPlayer(p.maxHp * 0.18);
    const rng = mulberry32(Math.floor(this.time * 1000));
    for (let i = 0; i < 24; i++) {
      this.after(i * 0.055, () => {
        if (!this.room) return;
        const x = clamp(p.x + (rng() - 0.5) * 700, 40, this.room.w - 40);
        this.spawnPlayerProjectile({
          x, y: -20,
          vx: (rng() - 0.5) * 40, vy: 520 + rng() * 240,
          damage: 12, radius: 7, life: 2, pierce: 0,
          kind: "star", color: "#ffe6a0", gravity: 80, isSkill: true, element: char.element
        });
      });
    }
    this.effects.flashScreen(0.18, "#ffe9c0");
  }

  ultMoonGuard(p) {
    const char = this.run.character;
    this.run.shield = Math.min(999, this.run.shield + 60);
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (Math.abs(enemy.x - p.x) < 300 && Math.abs(enemy.y - p.y) < 200) {
        this.hitEnemy(enemy, 90, { element: char.element, isSkill: true, source: "ult", knockback: 380 });
      }
    }
    this.effects.ring(p.x, p.y - 30, "#cfe6ff", 150, 0.9, 6);
    this.effects.ring(p.x, p.y - 30, "#ffffff", 90, 0.6, 3);
    this.effects.burst(p.x, p.y - 50, { count: 30, colors: ["#cfe6ff", "#fff", "#a7c8ff"], speed: 260, life: 1, size: 2.5, gravity: 0, kind: "star" });
    this.camera.kick(7);
    this.ui.setHp(this.run.hp, this.run.maxHp, this.run.shield);
  }

  ultSunburst(p) {
    const char = this.run.character;
    const face = p.face;
    this.hitboxes.push({
      x: p.x + face * 10 - (face > 0 ? 0 : 380), y: p.y - 160, w: 390, h: 160,
      damage: 150, life: 0.45, hit: new Set(), knockback: 520,
      element: char.element, color: "#ffce7a", isSkill: true, source: "ult", combo: false, air: false
    });
    this.effects.beam(p.x, p.y - 70, p.x + face * 400, p.y - 70, "#ffce7a", 0.5, 26);
    this.effects.burst(p.x + face * 100, p.y - 70, { count: 36, colors: ["#ffce7a", "#fff3c0", "#ff9d70"], speed: 330, life: 1, size: 3.2, gravity: 0, kind: "star" });
    this.camera.kick(11);
    this.effects.flashScreen(0.3, "#ffe2a6");
  }

  ultGalePage(p) {
    const char = this.run.character;
    for (let i = 0; i < 5; i++) {
      this.after(i * 0.12, () => {
        if (!this.player || this.player.dead) return;
        this.spawnPlayerProjectile({
          x: p.face > 0 ? p.x : p.x - 30,
          y: p.y - 40 - i * 34,
          vx: p.face * 900, vy: 0,
          damage: 38, radius: 16, life: 1.7, pierce: 9,
          kind: "wind", color: "#b9f0d8", isSkill: true, element: char.element
        });
      });
    }
    this.effects.flashScreen(0.14, "#d6fff0");
  }

  ultMoonFall(p) {
    const char = this.run.character;
    for (const enemy of this.enemies) {
      if (enemy.dead || enemy.isBoss) continue;
      this.hitEnemy(enemy, 135, { element: char.element, isSkill: true, source: "ult", knockback: 240 });
      enemy.slowT = Math.max(enemy.slowT || 0, 2.2);
    }
    if (this.room.boss) {
      const boss = this.enemies.find(e => e.isBoss && !e.dead);
      if (boss) this.hitEnemy(boss, 110, { element: char.element, isSkill: true, source: "ult", knockback: 0 });
    }
    this.effects.ring(p.x, p.y - 20, "#d9c2ff", 420, 1.1, 8);
    this.effects.ring(p.x, p.y - 20, "#ffe6ff", 260, 0.8, 4);
    this.effects.flashScreen(0.3, "#d9c2ff");
    this.camera.kick(10);
  }

  ultHundredViews(p) {
    const char = this.run.character;
    for (let i = 0; i < 12; i++) {
      this.after(i * 0.065, () => {
        if (!this.player || this.player.dead) return;
        const alive = this.enemies.filter(e => !e.dead);
        const target = alive[Math.floor(Math.random() * alive.length)];
        const tx = target ? target.x : this.player.x + (Math.random() < 0.5 ? -1 : 1) * 80;
        const ty = target ? target.y - (target.def.height || 40) * 0.55 : this.player.y - 50;
        this.hitboxes.push({
          x: tx - 46, y: ty - 46, w: 92, h: 92,
          damage: 18, life: 0.1, hit: new Set(),
          knockback: 130, element: char.element, color: "#ffd88a",
          isSkill: true, source: "ult", combo: false, air: false
        });
        this.effects.slash(tx, ty, Math.random() < 0.5 ? -1 : 1, "#ffd88a", 1.15);
        this.effects.burst(tx, ty, { count: 6, colors: ["#ffd88a", "#fff"], speed: 120, life: 0.4, size: 2, gravity: 0 });
        this.audio.sfx("slash");
      });
    }
    this.effects.ring(p.x, p.y - 38, "#ffd88a", 100, 0.8, 3);
    this.effects.flashScreen(0.18, "#ffe9c0");
  }

  // ---------------------------------------------------------------- hit/death
  hitEnemy(enemy, base, opts = {}) {
    if (!enemy || enemy.dead || enemy.spawnT > 0) return 0;
    const run = this.run;
    const s = run.stats;
    const char = run.character;
    let damage = base * char.atk * s.atkMul;
    if (opts.isSkill) damage *= s.skillPower;
    if (opts.air) damage *= s.airborne;
    if (opts.combo) damage *= 1 + s.comboBonus;
    if (char.id === "uzuzu" && this.player.hp / this.player.maxHp < 0.35) damage *= 1.2;
    let critChance = s.crit + (this.player.critBonusT > 0 ? 0.12 : 0);
    const crit = Math.random() < critChance;
    if (crit) damage *= s.critMul;
    if (enemy.hp >= enemy.maxHp) damage *= 1 + s.firstHit;
    if (enemy.hp / enemy.maxHp < 0.3) damage *= 1 + s.exec;
    const element = opts.element != null ? opts.element : char.element;
    const mult = elementMultiplier(element, enemy.def.element);
    damage *= mult;
    damage = Math.max(1, Math.round(damage));

    enemy.hp -= damage;
    enemy.flash = 0.14;
    if (!enemy.isBoss && enemy.handle) enemy.handle.play("damage", { loop: false, fade: 0.04 });
    const dir = enemy.x >= this.player.x ? 1 : -1;
    const kb = (opts.knockback || 90) * s.knockMul * (enemy.elite ? 0.55 : 1) * (enemy.isBoss ? 0.13 : 1);
    enemy.vx += dir * kb;
    if (!enemy.isBoss && enemy.def.kind !== "flyer") enemy.vy = Math.min(enemy.vy, -20);

    const color = crit ? "#ffd27a" : mult > 1 ? "#ffe6a0" : "#fff4e2";
    this.effects.text(enemy.x + (Math.random() - 0.5) * 14, enemy.y - (enemy.def.height || 44) - 8, damage, {
      color, size: crit ? 17 : mult > 1 ? 13 : 12, life: crit ? 0.9 : 0.7, crit
    });
    this.effects.burst(enemy.x, enemy.y - (enemy.def.height || 44) * 0.55, {
      count: crit ? 14 : 7,
      colors: crit ? ["#ffd27a", "#fff3c8", "#fff"] : ["#fff3d8", enemy.def.color || "#ffb7ca"],
      speed: crit ? 190 : 120,
      life: crit ? 0.55 : 0.38,
      size: crit ? 2.5 : 1.8,
      gravity: 220,
      kind: "star"
    });
    if (crit) this.effects.ring(enemy.x, enemy.y - (enemy.def.height || 44) * 0.55, "#ffd27a", 26, 0.28, 2.5);
    this.audio.sfx(crit ? "crit" : "hit");
    this.camera.kick(crit ? 4.2 : 2.2);
    this.hitStop = Math.max(this.hitStop, crit ? 0.055 : 0.028);

    if (s.lifesteal > 0) this.healPlayer(s.lifesteal, { silent: true });
    this.run.ult = Math.min(100, this.run.ult + 2 * s.ultRate);
    if (s.burn > 0) { enemy.burnT = Math.max(enemy.burnT, 2); enemy.burnDamage = s.burn; }
    if (s.slow > 0) enemy.slowT = Math.max(enemy.slowT, 1.5);

    if (enemy.isBoss) this.showBossHp(enemy);
    if (enemy.hp <= 0) this.killEnemy(enemy);
    return damage;
  }

  healPlayer(amount, { silent = false } = {}) {
    const p = this.player;
    if (!p || p.dead) return 0;
    const s = this.run.stats;
    const before = p.hp;
    const heal = Math.max(0, amount * s.healPower);
    p.hp = Math.min(p.maxHp, p.hp + heal);
    this.run.hp = p.hp;
    const gained = p.hp - before;
    if (gained > 0.5) {
      this.effects.text(p.x, p.y - 88, "+" + Math.round(gained), { color: "#b9ffd4", size: 12, life: 0.7, vy: -36 });
      this.effects.burst(p.x, p.y - 50, { count: 5, colors: ["#c6ffd9", "#fff"], speed: 55, life: 0.5, size: 1.8, gravity: -30, angle: -Math.PI / 2, spread: 1.8 });
      if (!silent) this.audio.sfx("heal");
    }
    return gained;
  }

  killEnemy(enemy) {
    if (enemy.dead) return;
    enemy.dead = true;
    enemy.deathT = enemy.isBoss ? 2.0 : 0.75;
    enemy.vx = 0;
    if (enemy.handle) {
      enemy.handle.play("dead", { loop: false, fade: 0.05 });
    }
    const s = this.run.stats;
    this.run.kills += 1;
    this.run.ult = Math.min(100, this.run.ult + 8 * s.ultRate);
    if (s.killHeal > 0) this.healPlayer(s.killHeal, { silent: true });
    this.effects.burst(enemy.x, enemy.y - (enemy.def.height || 44) * 0.5, {
      count: enemy.isBoss ? 46 : 16,
      colors: enemy.isBoss ? [enemy.def.color, "#ffe6a8", "#fff", "#ffb7ca"] : ["#ffe6a8", "#ffb7ca", "#fff"],
      speed: enemy.isBoss ? 300 : 170,
      life: enemy.isBoss ? 1.4 : 0.7,
      size: enemy.isBoss ? 3.4 : 2.3,
      gravity: 180,
      kind: "star"
    });
    if (enemy.isBoss) {
      this.slowTimer = 1.05;
      this.camera.kick(12);
      this.effects.flashScreen(0.34, "#fff0cd");
      this.ui.hideBoss();
      if (this.room) this.room.cleared = true;
      this.audio.sfx("boss");
      this.player.inv = Math.max(this.player.inv, 3);
      this.projectiles = this.projectiles.filter(projectile => projectile.owner === "player");
      this.after(1.9, () => this.bossDefeated(enemy));
    } else {
      this.dropLoot(enemy);
    }
    this.audio.sfx("hit");
    if (this.run.stats.dustMul > 1) { /* the drop calculation applies the multiplier */ }
  }

  dropLoot(enemy) {
    const act = this.run.actIndex;
    const s = this.run.stats;
    const elite = enemy.elite;
    const count = elite ? 6 : 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      this.spawnPickup(enemy.x, enemy.y - 24, {
        type: "dust",
        value: Math.max(1, Math.round((1 + Math.floor(Math.random() * 2) + act) * s.dustMul * (elite ? 2 : 1)))
      });
    }
    if (Math.random() < 0.12 || elite) {
      this.spawnPickup(enemy.x, enemy.y - 24, { type: "heart", value: elite ? 14 : 7 });
    }
  }

  spawnPickup(x, y, { type = "dust", value = 1 } = {}) {
    this.pickups.push({
      x, y,
      vx: (Math.random() - 0.5) * 150,
      vy: -170 - Math.random() * 90,
      w: 14,
      h: 14,
      type,
      value,
      life: 10,
      phase: Math.random() * 6.28,
      groundY: surfaceBelow(this.room, x, y)
    });
  }

  hurtPlayer(raw, sourceX, { source = "hit" } = {}) {
    const p = this.player;
    if (!p || p.dead || p.inv > 0) return;
    const s = this.run.stats;
    let damage = Math.max(1, raw * s.armor);
    if (this.run.shield > 0) {
      const absorbed = Math.min(this.run.shield, damage);
      this.run.shield -= absorbed;
      damage -= absorbed;
      this.effects.text(p.x, p.y - 90, "-" + Math.round(absorbed), { color: "#bfe6ff", size: 12, life: 0.7 });
    }
    if (damage > 0) {
      p.hp -= damage;
      this.run.hp = p.hp;
      this.effects.text(p.x, p.y - 92, "-" + Math.round(damage), { color: "#ff9aa8", size: 15, life: 0.8 });
    }
    p.inv = 1.05;
    p.hurtT = 0.32;
    p.animLock = 0.32;
    p.animState = "";
    p.vx = (p.x < sourceX ? -1 : 1) * 210;
    p.vy = Math.min(p.vy, -190);
    this.setPlayerAnim("damage", { loop: false, duration: 0.42, fade: 0.03 });
    this.effects.flashScreen(0.14, "#ff8798");
    this.effects.burst(p.x, p.y - 46, { count: 12, colors: ["#ffc1cb", "#ff8fa2", "#fff"], speed: 150, life: 0.5, size: 2.2, gravity: 260 });
    this.camera.kick(6);
    this.audio.sfx("hurt");
    if (source === "spike") this.ui.toast("尖刺扎到了。闪身可以无伤穿过。", 1500);
    if (this.run.character.id === "chiya" && Math.random() < 0.2) {
      this.healPlayer(6, { silent: true });
      this.effects.text(p.x + 18, p.y - 104, "山野的直觉", { color: "#b9ffd4", size: 9, life: 0.8 });
    }
    if (s.thorn > 0) {
      for (const enemy of this.enemies) {
        if (!enemy.dead && Math.abs(enemy.x - p.x) < 100 && Math.abs(enemy.y - p.y) < 100) {
          this.hitEnemy(enemy, s.thorn, { element: this.run.character.element, source: "thorn", knockback: 160 });
        }
      }
      this.effects.ring(p.x, p.y - 36, "#ffb8c6", 70, 0.4, 2);
    }
    this.ui.setHp(this.run.hp, this.run.maxHp, this.run.shield);
    if (p.hp <= 0) {
      if (this.run.revives > 0) this.revivePlayer();
      else this.die();
    }
  }

  revivePlayer() {
    const p = this.player;
    this.run.revives -= 1;
    p.hp = Math.max(1, Math.round(p.maxHp * 0.5));
    this.run.hp = p.hp;
    p.dead = false;
    p.inv = 2.5;
    p.animState = "";
    this.setPlayerAnim("idle", { loop: true, fade: 0.1 });
    this.ui.setRevive(this.run.revives);
    this.ui.setHp(p.hp, p.maxHp, this.run.shield);
    this.effects.ring(p.x, p.y - 30, "#ffe6a8", 110, 0.9, 5);
    this.effects.burst(p.x, p.y - 50, { count: 32, colors: ["#ffe6a8", "#fff", "#ffc3da"], speed: 220, life: 1.1, size: 2.8, gravity: -20, kind: "star" });
    this.effects.flashScreen(0.25, "#ffeccb");
    this.audio.sfx("heal");
    this.ui.toast("星之回响 · 再次睁开眼睛", 2200);
    this.stash();
  }

  die() {
    const p = this.player;
    p.dead = true;
    p.animState = "";
    p.animLock = 99;
    this.setPlayerAnim("damage", { loop: false, duration: 0.7, fade: 0.05 });
    if (this.playerHandle) {
      this.playerHandle.setVisible(true);
      this.playerHandle.setTilt(-1.15);
    }
    this.effects.flashScreen(0.24, "#ff97a8");
    this.effects.burst(p.x, p.y - 40, { count: 26, colors: ["#ffb8c6", "#fff", "#ffe6a8"], speed: 180, life: 1, size: 2.6, gravity: 160, kind: "star" });
    this.camera.kick(9);
    this.audio.sfx("death");
    this.state = "dying";
    this.deathT = 1.7;
    this.ui.hideInteract();
  }

  // ---------------------------------------------------------------- enemies
  updateEnemies(dt) {
    const p = this.player;
    for (const enemy of this.enemies) {
      if (enemy.isBoss) {
        if (!enemy.dead) this.updateBoss(enemy, dt);
      } else if (!enemy.dead) {
        this.updateEnemy(enemy, dt);
      }
      if (enemy.dead) {
        enemy.deathT -= dt;
        if (enemy.deathT <= 0) this.removeEnemy(enemy);
        if (enemy.handle) enemy.handle.update(dt);
        continue;
      }
      if (enemy.handle) {
        enemy.handle.move(enemy.x, enemy.y);
        enemy.handle.mirror(enemy.face);
        enemy.handle.update(dt);
      }
      if (enemy.burnT > 0) {
        enemy.burnT -= dt;
        enemy.burnTick = (enemy.burnTick || 0) - dt;
        if (enemy.burnTick <= 0) {
          enemy.burnTick = 0.5;
          const dmg = Math.max(1, Math.round((enemy.burnDamage || 4) * 0.5));
          enemy.hp -= dmg;
          this.effects.text(enemy.x, enemy.y - (enemy.def.height || 44) - 4, dmg, { color: "#ffb07a", size: 9, life: 0.5 });
          this.effects.burst(enemy.x, enemy.y - (enemy.def.height || 44) * 0.4, { count: 2, colors: ["#ffb07a", "#ffdf9f"], speed: 30, life: 0.35, size: 1.6, gravity: -40 });
          if (enemy.hp <= 0) this.killEnemy(enemy);
        }
      }
      if (enemy.slowT > 0) enemy.slowT = Math.max(0, enemy.slowT - dt);
      // contact damage
      if (!enemy.dead && enemy.spawnT <= 0 && p && !p.dead && p.inv <= 0) {
        const a = this.bodyRect(p);
        const b = { x: enemy.x - enemy.w / 2, y: enemy.y - enemy.h, w: enemy.w, h: enemy.h };
        if (rectsOverlap(a, b)) this.hurtPlayer(enemy.damage, enemy.x, { source: "enemy" });
      }
    }
    this.enemies = this.enemies.filter(enemy => !enemy.gone);
  }

  updateEnemy(enemy, dt) {
    const p = this.player;
    enemy.spawnT = Math.max(0, enemy.spawnT - dt);
    enemy.flash = Math.max(0, enemy.flash - dt);
    const slowFactor = enemy.slowT > 0 ? 0.75 : 1;
    const facing = p.x >= enemy.x ? 1 : -1;
    enemy.face = facing;
    if (enemy.spawnT > 0) {
      if (enemy.handle) enemy.handle.setVisible(Math.floor(enemy.spawnT * 20) % 2 === 0);
      return;
    }
    if (enemy.handle) enemy.handle.setVisible(true);

    if (enemy.def.kind === "flyer") {
      const targetX = p.x + Math.sin(this.time * 0.8 + enemy.phase) * 70;
      enemy.x += clamp(targetX - enemy.x, -enemy.def.speed * slowFactor * dt, enemy.def.speed * slowFactor * dt);
      enemy.y = enemy.baseY + Math.sin(this.time * 2.2 + enemy.phase) * 15;
      enemy.shadowY = surfaceBelow(this.room, enemy.x, enemy.y);
      enemy.attackCd -= dt;
      if (enemy.attackCd <= 0 && Math.abs(enemy.x - p.x) < 560) {
        enemy.attackCd = 2.3;
        this.enemyShootAtPlayer(enemy, 240, 7 * [1, 1.25, 1.5][this.run.actIndex], "seed", ELEMENTS[enemy.def.element].color);
        enemy.handle?.play("skill_1", { loop: false, fade: 0.08 });
        enemy.anim = "skill";
      }
      return;
    }

    enemy.vy = Math.min(900, enemy.vy + GRAVITY * dt);
    if (enemy.def.kind === "walker") {
      const dist = Math.abs(p.x - enemy.x);
      if (dist < 320 && Math.abs(p.y - enemy.y) < 100) {
        enemy.vx = lerp(enemy.vx, facing * enemy.def.speed * slowFactor, Math.min(1, dt * 5));
      } else {
        if (Math.abs(enemy.x - enemy.homeX) > 130) enemy.patrolDir *= -1;
        enemy.vx = lerp(enemy.vx, enemy.patrolDir * enemy.def.speed * 0.55 * slowFactor, Math.min(1, dt * 3));
      }
    } else if (enemy.def.kind === "hopper") {
      enemy.timer -= dt;
      if (enemy.onGround && enemy.timer <= 0 && Math.abs(p.x - enemy.x) < 380) {
        enemy.timer = 1.15 + Math.random() * 0.5;
        enemy.vy = -430;
        enemy.vx = clamp((p.x - enemy.x) * 1.4, -240, 240);
        enemy.handle?.play("skill_0", { loop: false, fade: 0.05 });
        this.effects.burst(enemy.x, enemy.y, { count: 5, colors: ["#fff2dc", enemy.def.color || "#ffe0c9"], speed: 45, life: 0.3, size: 1.6, gravity: 80, angle: -Math.PI / 2, spread: 2.2 });
      }
      if (enemy.onGround) enemy.vx *= Math.pow(0.0006, dt);
    } else if (enemy.def.kind === "charger") {
      enemy.timer -= dt;
      if (enemy.state === "charge") {
        enemy.vx = enemy.face * 430;
        enemy.timer -= dt;
        if (enemy.timer <= 0 || enemy.hitWall) {
          enemy.state = "idle";
          enemy.timer = 0.7;
          enemy.vx *= 0.2;
          enemy.handle?.play("idle", { loop: true, fade: 0.15 });
        }
      } else if (enemy.state === "telegraph") {
        enemy.vx = 0;
        if (enemy.timer <= 0) {
          enemy.state = "charge";
          enemy.timer = 0.45;
          enemy.face = p.x >= enemy.x ? 1 : -1;
          enemy.vx = enemy.face * 430;
          enemy.handle?.play("skill_1", { loop: false, fade: 0.04 });
        }
      } else {
        if (enemy.timer <= 0 && Math.abs(p.x - enemy.x) < 380 && Math.abs(p.y - enemy.y) < 90) {
          enemy.state = "telegraph";
          enemy.timer = 0.55;
          enemy.face = p.x >= enemy.x ? 1 : -1;
          this.effects.warning(enemy.x + enemy.face * 100, FLOOR_Y, 200, 18, 0.55, "rect");
          enemy.handle?.play("skill_0", { loop: false, fade: 0.05 });
        }
      }
    } else if (enemy.def.kind === "turret") {
      enemy.vx = 0;
      enemy.attackCd -= dt;
      if (enemy.attackCd <= 0 && Math.abs(p.x - enemy.x) < 620) {
        enemy.attackCd = 2.7;
        const base = Math.atan2((p.y - 45) - (enemy.y - 28), p.x - enemy.x);
        for (let i = -1; i <= 1; i++) {
          this.spawnEnemyProjectile(enemy, base + i * 0.22, 300, 7 * [1, 1.25, 1.5][this.run.actIndex], "orb", ELEMENTS[enemy.def.element].color);
        }
        enemy.handle?.play("skill_0", { loop: false, fade: 0.08 });
        enemy.anim = "skill";
      }
    }

    // gravity / collision
    const before = enemy.onGround;
    moveBody(enemy, dt, this.room);
    if (enemy.onGround && !before) {
      this.effects.burst(enemy.x, enemy.y, { count: 3, colors: ["#fff3dc"], speed: 30, life: 0.25, size: 1.4, gravity: 80, angle: -Math.PI / 2, spread: 2.2 });
    }
    enemy.shadowY = enemy.onGround ? enemy.y : surfaceBelow(this.room, enemy.x, enemy.y);
  }

  enemyShootAtPlayer(enemy, speed, damage, kind, color) {
    const p = this.player;
    const angle = Math.atan2((p.y - 40) - (enemy.y - 28), p.x - enemy.x);
    this.spawnEnemyProjectile(enemy, angle, speed, damage, kind, color);
  }

  spawnEnemyProjectile(enemy, angle, speed, damage, kind, color) {
    this.projectiles.push({
      owner: "enemy",
      x: enemy.x + Math.cos(angle) * 18,
      y: enemy.y - 28 + Math.sin(angle) * 18,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: kind === "wave" ? 15 : 7,
      damage,
      life: 3.2,
      maxLife: 3.2,
      kind: kind || "orb",
      color: color || "#ff9aad",
      angle,
      gravity: 0,
      hit: false
    });
  }

  showBossHp(boss) {
    if (boss.lastShownHp === boss.hp) return;
    boss.lastShownHp = boss.hp;
    this.ui.setBoss(boss.def.name, boss.def.title, boss.hp, boss.maxHp, boss.phase);
  }

  updateBoss(boss, dt) {
    const p = this.player;
    boss.flash = Math.max(0, boss.flash - dt);
    boss.spawnT = Math.max(0, boss.spawnT - dt);
    const ratio = boss.hp / boss.maxHp;
    if (boss.phase === 1 && ratio <= 0.58) {
      boss.phase = 2;
      boss.attackCd = Math.min(boss.attackCd, 0.8);
      this.ui.toast("守卷人认真起来了 · 第二阶段", 2400);
      this.effects.ring(boss.x, boss.y - 40, boss.def.color, 130, 0.9, 5);
      this.effects.burst(boss.x, boss.y - 80, { count: 26, colors: [boss.def.color, "#ffe6a8", "#fff"], speed: 220, life: 1, size: 2.8, gravity: -20, kind: "star" });
      this.audio.sfx("boss");
      this.camera.kick(8);
    }
    this.showBossHp(boss);
    if (boss.introT > 0) {
      boss.introT -= dt;
      boss.face = p.x >= boss.x ? 1 : -1;
      return;
    }
    boss.attackCd -= dt;
    boss.face = p.x >= boss.x ? 1 : -1;
    if (boss.chargeT > 0) {
      boss.chargeT -= dt;
      boss.vx = boss.face * 520;
      if (boss.hitWall) boss.chargeT = 0;
      boss.vy = Math.min(900, boss.vy + GRAVITY * dt);
      moveBody(boss, dt, this.room);
      if (boss.chargeT <= 0) boss.vx = 0;
      boss.shadowY = boss.onGround ? boss.y : surfaceBelow(this.room, boss.x, boss.y);
      return;
    }
    const dist = Math.abs(p.x - boss.x);
    if (dist > 230) {
      boss.vx = boss.face * 58;
    } else if (dist < 110) {
      boss.vx = -boss.face * 38;
    } else {
      boss.vx *= Math.pow(0.001, dt);
    }
    boss.vy = Math.min(900, boss.vy + GRAVITY * dt);
    moveBody(boss, dt, this.room);
    boss.shadowY = boss.onGround ? boss.y : surfaceBelow(this.room, boss.x, boss.y);
    if (boss.attackCd <= 0) this.bossChoosePattern(boss);
  }

  bossChoosePattern(boss) {
    const patterns = boss.def.patterns;
    const name = patterns[Math.floor(Math.random() * patterns.length)];
    const phaseMul = boss.phase >= 2 ? 0.72 : 1;
    if (name === "slam") {
      boss.attackCd = 2.8 * phaseMul;
      boss.handle?.play("skill_1", { loop: false, fade: 0.08 });
      const x = clamp(this.player.x, 120, this.room.w - 120);
      this.effects.warning(x, FLOOR_Y, 190, 30, 0.82, "circle");
      this.effects.warning(x, FLOOR_Y, 96, 18, 0.82, "rect");
      this.after(0.82, () => {
        if (boss.dead) return;
        this.effects.ring(x, FLOOR_Y - 4, boss.def.color, 110, 0.5, 5);
        this.effects.burst(x, FLOOR_Y - 10, { count: 24, colors: [boss.def.color, "#ffe6a8", "#fff"], speed: 220, life: 0.8, size: 2.6, gravity: 160 });
        this.camera.kick(9);
        this.audio.sfx("boss");
        if (Math.abs(this.player.x - x) < 96 && Math.abs(this.player.y - FLOOR_Y) < 70) {
          this.hurtPlayer(boss.damage, x, { source: "boss" });
        }
        this.spawnEnemyProjectile({ x, y: FLOOR_Y + 10 }, Math.PI, 300, boss.damage * 0.55, "wave", boss.def.color);
        this.spawnEnemyProjectile({ x, y: FLOOR_Y + 10 }, 0, 300, boss.damage * 0.55, "wave", boss.def.color);
      });
    } else if (name === "fan") {
      boss.attackCd = 2.3 * phaseMul;
      boss.handle?.play("skill_0", { loop: false, fade: 0.08 });
      this.after(0.48, () => {
        if (boss.dead) return;
        const angle = Math.atan2((this.player.y - 40) - (boss.y - 54), this.player.x - boss.x);
        const count = boss.phase >= 2 ? 7 : 5;
        for (let i = 0; i < count; i++) {
          const spread = (i - (count - 1) / 2) * 0.17;
          this.spawnEnemyProjectile(boss, angle + spread, 320, 9 * (boss.phase >= 2 ? 1.2 : 1), "orb", boss.def.color);
        }
        this.audio.sfx("skill");
      });
    } else if (name === "charge") {
      boss.attackCd = 3.2 * phaseMul;
      boss.handle?.play("charge_skill", { loop: false, fade: 0.06 });
      const dir = this.player.x >= boss.x ? 1 : -1;
      this.effects.warning(boss.x + dir * 200, FLOOR_Y, 400, 28, 0.58, "rect");
      this.after(0.58, () => {
        if (boss.dead) return;
        boss.face = this.player.x >= boss.x ? 1 : -1;
        boss.chargeT = 0.46;
        boss.vx = boss.face * 520;
        this.camera.kick(5);
        this.audio.sfx("dash");
      });
    } else if (name === "summon") {
      boss.attackCd = 4.2 * phaseMul;
      boss.handle?.play("skill_0", { loop: false, fade: 0.08 });
      this.after(0.55, async () => {
        if (boss.dead || !this.room) return;
        const act = ACTS[this.run.actIndex];
        for (let i = 0; i < 2; i++) {
          const type = act.pool[Math.floor(Math.random() * act.pool.length)];
          const pos = { x: clamp(boss.x + (i ? 150 : -150), 100, this.room.w - 100), y: FLOOR_Y };
          const enemy = await this.createEnemy({ type }, pos);
          if (!this.room || this.room.type !== "boss") { this.removeEnemy(enemy); continue; }
          this.enemies.push(enemy);
        }
        this.ui.toast("守卷人唤来了帮手", 1500);
      });
    } else if (name === "starfall") {
      boss.attackCd = 3.0 * phaseMul;
      boss.handle?.play("charge_skill", { loop: false, fade: 0.08 });
      const xs = [this.player.x - 130, this.player.x, this.player.x + 130].map(x => clamp(x, 100, this.room.w - 100));
      for (const x of xs) this.effects.warning(x, FLOOR_Y, 120, 30, 0.95, "circle");
      this.after(0.95, () => {
        if (boss.dead) return;
        for (const x of xs) {
          this.effects.beam(x, 0, x, FLOOR_Y, boss.def.color, 0.35, 12);
          this.effects.burst(x, FLOOR_Y - 12, { count: 12, colors: [boss.def.color, "#fff"], speed: 160, life: 0.6, size: 2.4, gravity: 180 });
          if (Math.abs(this.player.x - x) < 62 && Math.abs(this.player.y - FLOOR_Y) < 80) {
            this.hurtPlayer(boss.damage * 0.9, x, { source: "boss" });
          }
        }
        this.camera.kick(7);
        this.audio.sfx("ult");
      });
    }
  }

  async bossDefeated(boss) {
    if (this.finished) return;
    const run = this.run;
    run.bosses += 1;
    run.roomsCleared += 1;
    this.healPlayer(run.maxHp * 0.3);
    run.dust += 30;
    this.ui.setDust(run.dust);
    this.ui.toast("守卷人让开了路", 2000);
    this.stash();
    if (run.actIndex >= ACTS.length - 1) {
      this.finishRun(true);
      return;
    }
    const nextAct = ACTS[run.actIndex + 1];
    const page = {
      kicker: "INTERLUDE · 第" + (run.actIndex + 1) + "卷的句号",
      title: "书页翻过去了",
      text: boss.def.outro + "\n\n" + nextAct.intro
    };
    this.paused = true;
    this.state = "story";
    this.input.enabled = false;
    this.input.clear();
    this.ui.showStory([page], () => {
      this.state = "playing";
      this.paused = false;
      run.actIndex += 1;
      run.roomIndex = 0;
      this.enterRoom({ first: true });
    }, () => {
      this.state = "playing";
      this.paused = false;
      run.actIndex += 1;
      run.roomIndex = 0;
      this.enterRoom({ first: true });
    });
  }

  // ---------------------------------------------------------------- projectiles
  updateProjectiles(dt) {
    const p = this.player;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i];
      projectile.life -= dt;
      if (projectile.gravity) projectile.vy += projectile.gravity * dt;
      if (projectile.homing && projectile.owner === "player") {
        let best = null;
        let bestDist = Infinity;
        for (const enemy of this.enemies) {
          if (enemy.dead) continue;
          const d = (enemy.x - projectile.x) ** 2 + (enemy.y - 40 - projectile.y) ** 2;
          if (d < bestDist) { best = enemy; bestDist = d; }
        }
        if (best) {
          const angle = Math.atan2(best.y - 40 - projectile.y, best.x - projectile.x);
          const speed = Math.hypot(projectile.vx, projectile.vy) || 470;
          projectile.vx = lerp(projectile.vx, Math.cos(angle) * speed, Math.min(1, dt * 6));
          projectile.vy = lerp(projectile.vy, Math.sin(angle) * speed, Math.min(1, dt * 6));
        }
      }
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;
      if (projectile.trail && Math.random() < 0.7) {
        this.effects.burst(projectile.x, projectile.y, { count: 1, colors: [projectile.color], speed: 12, life: 0.25, size: projectile.radius * 0.35, gravity: -10, kind: "dot" });
      }

      if (projectile.owner === "player") {
        let hitSomething = false;
        for (const enemy of this.enemies) {
          if (enemy.dead || enemy.spawnT > 0 || projectile.hit.has(enemy)) continue;
          const rect = { x: enemy.x - enemy.w / 2, y: enemy.y - enemy.h, w: enemy.w, h: enemy.h };
          if (pointRect(projectile.x, projectile.y, { x: rect.x - projectile.radius, y: rect.y - projectile.radius, w: rect.w + projectile.radius * 2, h: rect.h + projectile.radius * 2 })) {
            projectile.hit.add(enemy);
            this.hitEnemy(enemy, projectile.damage, {
              element: projectile.element,
              isSkill: projectile.isSkill,
              combo: projectile.combo,
              air: projectile.air,
              knockback: 100,
              source: "projectile"
            });
            this.effects.burst(projectile.x, projectile.y, { count: 7, colors: [projectile.color, "#fff"], speed: 110, life: 0.35, size: 2, gravity: 100 });
            hitSomething = true;
            if (projectile.pierce > 0) projectile.pierce -= 1;
            else { projectile.life = 0; break; }
          }
        }
        if (projectile.life > 0 && !hitSomething) {
          for (const jar of this.room.breakables) {
            if (jar.broken) continue;
            if (projectile.x > jar.x - 16 && projectile.x < jar.x + 16 && projectile.y > jar.y - 32 && projectile.y < jar.y + 4) {
              this.breakJar(jar);
              if (projectile.pierce > 0) projectile.pierce -= 1;
              else projectile.life = 0;
              break;
            }
          }
        }
        if (projectile.kind === "flask" && (projectile.life <= 0 || projectile.y >= FLOOR_Y - 4)) {
          this.explodeFlask(projectile);
          projectile.life = 0;
        }
        if (projectile.kind === "flask" && hitSomething) {
          this.explodeFlask(projectile);
          projectile.life = 0;
        }
      } else {
        if (p && !p.dead && p.inv <= 0) {
          const pr = this.bodyRect(p);
          if (pointRect(projectile.x, projectile.y, { x: pr.x - projectile.radius, y: pr.y - projectile.radius, w: pr.w + projectile.radius * 2, h: pr.h + projectile.radius * 2 })) {
            this.hurtPlayer(projectile.damage, projectile.x, { source: "projectile" });
            projectile.life = 0;
            this.effects.burst(projectile.x, projectile.y, { count: 8, colors: [projectile.color, "#fff"], speed: 120, life: 0.4, size: 2, gravity: 80 });
          }
        }
      }
      if (projectile.life <= 0 || projectile.y > VIEW_H + 80 || projectile.x < this.camera.x - 200 || projectile.x > this.camera.x + VIEW_W + 320) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  explodeFlask(projectile) {
    const radius = projectile.blast || 56;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (Math.abs(enemy.x - projectile.x) < radius && Math.abs((enemy.y - enemy.h / 2) - projectile.y) < radius) {
        this.hitEnemy(enemy, projectile.damage, {
          element: projectile.element,
          isSkill: projectile.isSkill,
          source: "flask",
          knockback: 120
        });
      }
    }
    if (projectile.poison) {
      this.zones.push({
        x: projectile.x, y: FLOOR_Y, r: radius + 18,
        life: 4, maxLife: 4, dps: 13 * this.run.stats.skillPower, tick: 0.2,
        color: "#c9a8ff", owner: "player"
      });
    }
    this.effects.ring(projectile.x, projectile.y, projectile.color, radius, 0.5, 3);
    this.effects.burst(projectile.x, projectile.y, { count: 16, colors: [projectile.color, "#fff", "#e6cfff"], speed: 170, life: 0.7, size: 2.6, gravity: 150, kind: "dot" });
    this.audio.sfx("skill");
    this.camera.kick(3);
  }

  updateHitboxes(dt) {
    for (let i = this.hitboxes.length - 1; i >= 0; i--) {
      const box = this.hitboxes[i];
      box.life -= dt;
      for (const enemy of this.enemies) {
        if (enemy.dead || enemy.spawnT > 0 || box.hit.has(enemy)) continue;
        const rect = { x: enemy.x - enemy.w / 2, y: enemy.y - enemy.h, w: enemy.w, h: enemy.h };
        if (rectsOverlap({ x: box.x, y: box.y, w: box.w, h: box.h }, rect)) {
          box.hit.add(enemy);
          this.hitEnemy(enemy, box.damage, {
            element: box.element,
            isSkill: box.isSkill,
            combo: box.combo,
            air: box.air,
            knockback: box.knockback,
            source: box.source
          });
        }
      }
      for (const jar of this.room.breakables) {
        if (jar.broken) continue;
        if (rectsOverlap({ x: box.x, y: box.y, w: box.w, h: box.h }, { x: jar.x - 16, y: jar.y - 32, w: 32, h: 32 })) {
          this.breakJar(jar);
        }
      }
      if (box.life <= 0) this.hitboxes.splice(i, 1);
    }
  }

  updateZones(dt) {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const zone = this.zones[i];
      zone.life -= dt;
      zone.tick -= dt;
      if (zone.tick <= 0) {
        zone.tick = 0.5;
        for (const enemy of this.enemies) {
          if (enemy.dead) continue;
          if (Math.abs(enemy.x - zone.x) < zone.r && Math.abs(enemy.y - zone.y) < 40) {
            this.hitEnemy(enemy, zone.dps * 0.5, {
              element: 4,
              isSkill: true,
              source: "zone",
              knockback: 10
            });
          }
        }
      }
      if (Math.random() < 0.35) {
        this.effects.burst(zone.x + (Math.random() - 0.5) * zone.r * 1.6, zone.y - Math.random() * 30, {
          count: 1, colors: [zone.color], speed: 15, life: 0.7, size: 2, gravity: -20, kind: "dot"
        });
      }
      if (zone.life <= 0) this.zones.splice(i, 1);
    }
  }

  updatePickups(dt) {
    const p = this.player;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pickup = this.pickups[i];
      pickup.life -= dt;
      pickup.vy = Math.min(700, pickup.vy + 1100 * dt);
      pickup.x += pickup.vx * dt;
      pickup.y += pickup.vy * dt;
      if (pickup.y >= pickup.groundY) {
        pickup.y = pickup.groundY;
        pickup.vy *= -0.28;
        pickup.vx *= 0.7;
        if (Math.abs(pickup.vy) < 35) pickup.vy = 0;
      }
      const dist = Math.hypot(pickup.x - p.x, pickup.y - (p.y - 30));
      if (dist < this.run.stats.magnetRange) {
        const pull = Math.min(1, dt * 6);
        pickup.vx = lerp(pickup.vx, (p.x - pickup.x) * 5.5, pull);
        pickup.vy = lerp(pickup.vy, ((p.y - 30) - pickup.y) * 5.5, pull);
      }
      if (dist < 32) {
        if (pickup.type === "heart") this.healPlayer(pickup.value);
        else {
          this.run.dust += pickup.value;
          this.ui.setDust(this.run.dust);
          this.audio.sfx("coin");
          this.effects.burst(pickup.x, pickup.y, { count: 3, colors: ["#ffe6a8", "#fff"], speed: 40, life: 0.3, size: 1.5, gravity: -20, kind: "star" });
        }
        this.pickups.splice(i, 1);
        continue;
      }
      if (pickup.life <= 0) this.pickups.splice(i, 1);
    }
  }

  breakJar(jar) {
    jar.broken = true;
    const amount = 8 + Math.floor(Math.random() * 9);
    for (let i = 0; i < 4; i++) {
      this.spawnPickup(jar.x, jar.y - 18, { type: "dust", value: Math.max(1, Math.round(amount / 4)) });
    }
    this.effects.burst(jar.x, jar.y - 16, { count: 12, colors: ["#bfe9f3", "#ffe6a8", "#fff"], speed: 140, life: 0.5, size: 2, gravity: 200, kind: "star" });
    this.audio.sfx("coin");
  }

  // ---------------------------------------------------------------- room state
  updateRoomState(dt) {
    const room = this.room;
    if (!room || room.cleared) return;
    if (room.type === "boss") {
      if (this.bossSpawnT > 0) {
        this.bossSpawnT -= dt;
        if (this.bossSpawnT <= 0) this.spawnBoss();
      }
      return;
    }
    if (room.type !== "combat" && room.type !== "elite") return;
    const alive = this.enemies.some(enemy => !enemy.dead && !enemy.gone);
    if (this.waveActive && !this.waveLoading && !alive) {
      this.waveActive = false;
      if (this.waveIndex < room.wavePlan.length - 1) this.waveGap = 1.05;
      else this.clearTimer = 0.8;
    }
    if (this.waveGap > 0) {
      this.waveGap -= dt;
      if (this.waveGap <= 0) this.spawnWave(this.waveIndex + 1);
    }
    if (this.clearTimer > 0) {
      this.clearTimer -= dt;
      if (this.clearTimer <= 0) this.clearRoom();
    }
  }

  clearRoom() {
    const room = this.room;
    if (!room || room.cleared) return;
    room.cleared = true;
    this.run.roomsCleared += 1;
    this.healPlayer(6, { silent: true });
    this.audio.sfx("door");
    this.effects.ring(room.door.x + 26, FLOOR_Y - 40, "#ffe6a8", 70, 0.8, 4);
    this.effects.burst(room.door.x + 26, FLOOR_Y - 40, { count: 16, colors: ["#ffe6a8", "#fff", "#ffc3da"], speed: 120, life: 0.8, size: 2.2, gravity: -20, kind: "star" });
    this.ui.toast("这一页读完了 · 星愿正在落下来", 2200);
    this.stash();
    this.after(0.85, () => this.openBoonOffer(room.type === "elite"));
  }

  openDoor() {
    if (!this.room) return;
    this.room.door.open = true;
    this.audio.sfx("door");
    this.effects.ring(this.room.door.x + 26, FLOOR_Y - 40, "#ffe6a8", 54, 0.6, 3);
  }

  openBoonOffer(elite = false) {
    if (!this.run || this.player.dead || this.state !== "playing") return;
    const choices = this.pickBoonChoices(3, elite);
    if (!choices.length) {
      this.openDoor();
      return;
    }
    this.paused = true;
    this.state = "overlay";
    this.input.enabled = false;
    this.input.clear();
    this.ui.showBoonChoices(choices.map(def => ({ def })), this.run.boons, {
      onPick: index => {
        const chosen = choices[index];
        if (!chosen) return;
        this.ui.closeOverlay();
        this.addBoon(chosen);
        this.openDoor();
        this.paused = false;
        this.state = "playing";
        this.input.enabled = true;
        this.input.clear();
      },
      onSkip: () => {
        this.ui.closeOverlay();
        this.run.dust += 15;
        this.ui.setDust(this.run.dust);
        this.ui.toast("留下一小袋星屑", 1400);
        this.openDoor();
        this.paused = false;
        this.state = "playing";
        this.input.enabled = true;
        this.input.clear();
        this.stash();
      }
    });
    this.audio.sfx("card");
  }

  pickBoonChoices(count, elite) {
    const run = this.run;
    const available = BOONS.filter(def => (run.boons[def.id] || 0) < def.max);
    if (!available.length) return [];
    const weighted = [];
    for (const def of available) {
      let weight = def.rarity === 0 ? 55 : def.rarity === 1 ? 30 : 10;
      if (run.actIndex >= 1 && def.rarity >= 1) weight += 10;
      if (elite && def.rarity >= 1) weight += 22;
      if (elite && def.rarity === 2) weight += 10;
      if ((run.boons[def.id] || 0) > 0) weight += 12;
      weighted.push({ def, weight });
    }
    const chosen = [];
    for (let i = 0; i < count && weighted.length; i++) {
      let total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
      let roll = Math.random() * total;
      let index = 0;
      for (; index < weighted.length; index++) {
        roll -= weighted[index].weight;
        if (roll <= 0) break;
      }
      const pick = weighted[Math.min(index, weighted.length - 1)];
      chosen.push(pick.def);
      weighted.splice(weighted.indexOf(pick), 1);
    }
    return chosen;
  }

  // ---------------------------------------------------------------- interaction
  updateInteraction() {
    const room = this.room;
    const p = this.player;
    if (!room || !p || p.dead) { this.ui.hideInteract(); return; }
    let best = null;
    let bestDist = 76;
    if (room.door.open) {
      const dx = Math.abs(p.x - (room.door.x + room.door.w / 2));
      if (dx < 74 && Math.abs(p.y - FLOOR_Y) < 90) {
        best = { kind: "door", label: "推开门 · 前往下一页", sub: "E", dist: dx };
        bestDist = dx;
      }
    }
    for (const pedestal of room.pedestals) {
      if (pedestal.sold || !pedestal.item) continue;
      const dx = Math.abs(p.x - pedestal.x);
      if (dx < 72 && Math.abs(p.y - FLOOR_Y) < 90 && dx < bestDist) {
        const affordable = this.run.dust >= pedestal.item.price;
        best = {
          kind: "shop",
          pedestal,
          label: (affordable ? "购买 " : "星屑不足 · ") + pedestal.item.name,
          sub: "✦ " + pedestal.item.price,
          dist: dx
        };
        bestDist = dx;
      }
    }
    if (room.fire && !room.fire.used) {
      const dx = Math.abs(p.x - room.fire.x);
      if (dx < 76 && Math.abs(p.y - FLOOR_Y) < 90 && dx < bestDist) {
        best = { kind: "rest", label: "在营火旁休息", sub: "回复 35% 生命 · +35 星屑", dist: dx };
        bestDist = dx;
      }
    }
    this.currentInteract = best;
    if (!best) { this.ui.hideInteract(); return; }
    this.ui.interact(best.label, best.sub);
    if (this.input.pressed("interact")) this.doInteract(best);
  }

  doInteract(target) {
    if (!target) return;
    if (target.kind === "door") {
      this.nextRoom();
    } else if (target.kind === "shop") {
      this.buyPedestal(target.pedestal);
    } else if (target.kind === "rest") {
      this.restAtFire();
    }
  }

  nextRoom() {
    const run = this.run;
    const act = ACTS[run.actIndex];
    if (!this.room || !this.room.door.open) return;
    if (run.roomIndex >= act.rooms.length - 1) {
      // Boss rooms end through the boss flow, not a door.
      return;
    }
    this.paused = true;
    this.state = "loading";
    this.input.enabled = false;
    this.input.clear();
    this.ui.hideInteract();
    this.ui.fadeOut();
    this.audio.sfx("door");
    this.pendingRoomTimer = setTimeout(async () => {
      run.roomIndex += 1;
      await this.enterRoom({ first: false });
      this.ui.fadeIn();
    }, 320);
  }

  buyPedestal(pedestal) {
    if (!pedestal || pedestal.sold || !pedestal.item) return;
    const item = pedestal.item;
    if (this.run.dust < item.price) {
      this.audio.sfx("error");
      this.ui.toast("星屑不够。再去打碎几个星星罐吧。", 1600);
      return;
    }
    this.run.dust -= item.price;
    pedestal.sold = true;
    this.ui.setDust(this.run.dust);
    this.audio.sfx("buy");
    this.effects.burst(pedestal.x, pedestal.y - 72, { count: 16, colors: ["#ffe6a8", "#fff", "#ffc3da"], speed: 130, life: 0.8, size: 2.2, gravity: -20, kind: "star" });
    this.applyShopItem(item);
    this.ui.toast(item.name + " · " + item.desc, 1800);
    this.stash();
  }

  applyShopItem(item) {
    const run = this.run;
    const p = this.player;
    if (item.id === "heal") {
      this.healPlayer(p.maxHp * 0.5);
    } else if (item.id === "maxhp") {
      run.maxHp += 20;
      p.maxHp = run.maxHp;
      p.hp = Math.min(run.maxHp, p.hp + 20);
      run.hp = p.hp;
      this.ui.setHp(run.hp, run.maxHp, run.shield);
      this.audio.sfx("heal");
    } else if (item.id === "boon" || item.id === "rareboon") {
      const minRarity = item.id === "rareboon" ? 1 : 0;
      const pool = BOONS.filter(def => (run.boons[def.id] || 0) < def.max && def.rarity >= minRarity);
      if (pool.length) this.addBoon(pool[Math.floor(Math.random() * pool.length)]);
    } else if (item.id === "shield") {
      run.shield = Math.min(999, run.shield + 35);
      this.ui.setHp(run.hp, run.maxHp, run.shield);
      this.audio.sfx("heal");
    } else if (item.id === "discount") {
      run.shopDiscount = true;
      this.room.pedestals.forEach(other => {
        if (!other.sold && other.item) other.item.price = Math.max(8, Math.round(other.item.price * 0.8));
      });
    }
  }

  restAtFire() {
    const room = this.room;
    if (!room.fire || room.fire.used) return;
    room.fire.used = true;
    this.healPlayer(this.player.maxHp * 0.35);
    this.run.dust += 35;
    this.ui.setDust(this.run.dust);
    this.ui.toast("休息了一会儿 · 生命与星屑都回来了", 1900);
    this.effects.burst(room.fire.x, room.fire.y - 30, { count: 18, colors: ["#ffe0a0", "#fff", "#ffb7ca"], speed: 100, life: 0.9, size: 2.2, gravity: -20, kind: "star" });
    this.audio.sfx("heal");
    this.stash();
  }

  // ---------------------------------------------------------------- timers
  after(delay, fn) {
    this.timers.push({ t: delay, fn });
  }

  updateTimers(dt) {
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const timer = this.timers[i];
      timer.t -= dt;
      if (timer.t <= 0) {
        this.timers.splice(i, 1);
        try { timer.fn(); } catch (error) { console.warn("starfall scheduled action:", error); }
      }
    }
  }

  // ---------------------------------------------------------------- HUD
  updateHUD() {
    if (!this.run || !this.player) return;
    this.ui.setHp(this.run.hp, this.run.maxHp, this.run.shield);
    this.ui.setDust(this.run.dust);
    this.ui.setUlt(this.run.ult);
    this.ui.setSkillCooldown(this.player.skillCd, this.run.character.skill.cd * this.run.stats.skillCdMul);
    this.ui.setDashCooldown(this.player.dashCd, BASE_DASH_CD * this.run.stats.dashCdMul);
    this.ui.setBoons(Object.values(this.run.boons).reduce((a, b) => a + b, 0));
    this.ui.setRevive(this.run.revives);
  }

  // ---------------------------------------------------------------- menus
  pause() {
    if (!this.run || this.player?.dead || this.state !== "playing" || this.paused) return;
    this.paused = true;
    this.state = "paused";
    this.input.enabled = false;
    this.input.clear();
    this.ui.hideInteract();
    this.openPauseMenu();
    this.audio.sfx("click");
  }

  openPauseMenu() {
    const run = this.run;
    const act = ACTS[run.actIndex];
    this.ui.showPause({
      actLabel: BIOMES[act.biome].act + " · " + BIOMES[act.biome].name,
      roomLabel: "第 " + (run.roomIndex + 1) + " 页 · " + ROOM_TYPE_LABEL[act.rooms[run.roomIndex]],
      character: run.character,
      onResume: () => this.resume(),
      onBoons: () => this.openBoonList(),
      onSettings: () => this.openSettings("pause"),
      onHelp: () => this.openHelp("pause"),
      onAbandon: () => this.abandonRun()
    });
  }

  resume() {
    this.ui.closeOverlay();
    this.paused = false;
    this.state = "playing";
    this.input.enabled = true;
    this.input.clear();
  }

  openBoonList() {
    this.ui.showBoonList(this.run.boons, BOONS, {
      onClose: () => this.openPauseMenu()
    });
  }

  openSettings(from = "title") {
    this.overlayReturn = from;
    const wasPlaying = this.state === "playing" || this.state === "paused";
    if (wasPlaying) {
      this.paused = true;
      this.state = "paused";
      this.input.enabled = false;
      this.input.clear();
    }
    this.ui.showSettings(this.save.settings, {
      onBgm: value => {
        this.save.settings.bgm = value;
        this.audio.setVolumes({ bgm: value });
        writeSave(this.save);
      },
      onSfx: value => {
        this.save.settings.sfx = value;
        this.audio.setVolumes({ sfx: value });
        writeSave(this.save);
      },
      onReduced: value => {
        this.save.settings.reducedMotion = value;
        document.body.classList.toggle("reduced-motion", value);
        writeSave(this.save);
      },
      onClose: () => {
        this.ui.closeOverlay();
        this.returnFromOverlay("settings");
      },
      onReset: () => {
        this.save = resetSave(this.save);
        writeSave(this.save);
        this.audio.setVolumes(this.save.settings);
        this.ui.closeOverlay();
        this.showTitle();
        this.ui.toast("漫游记录已清空", 1800);
      }
    });
  }

  openHelp(from = "title") {
    this.overlayReturn = from;
    const wasPlaying = this.state === "playing" || this.state === "paused";
    if (wasPlaying) {
      this.paused = true;
      this.state = "paused";
      this.input.enabled = false;
      this.input.clear();
    }
    this.ui.showHelp({
      onClose: () => {
        this.ui.closeOverlay();
        this.returnFromOverlay("help");
      }
    });
  }

  openStarMap(from = "title") {
    this.overlayReturn = from;
    const wasPlaying = this.state === "playing" || this.state === "paused";
    if (wasPlaying) {
      this.paused = true;
      this.state = "paused";
      this.input.enabled = false;
      this.input.clear();
    }
    this.ui.showStarMap(this.save, {
      onBuy: id => this.buyUpgradeNow(id),
      onClose: () => {
        this.ui.closeOverlay();
        this.returnFromOverlay("starmap");
      }
    });
  }

  returnFromOverlay(kind) {
    const from = this.overlayReturn;
    if (from === "pause") { this.openPauseMenu(); return; }
    if (from === "result") { this.presentResult(); return; }
    if (from === "select") { this.showSelect(); return; }
    if (from === "title") { this.showTitle(); return; }
    if (from === "boons") { this.openPauseMenu(); return; }
    this.showTitle();
    void kind;
  }

  buyUpgradeNow(id) {
    const result = buyUpgrade(this.save, id);
    if (result.ok) {
      this.audio.sfx("buy");
      this.ui.refreshStarMap(this.save);
      this.ui.toast("星图点亮 · " + result.def.name, 1400);
    } else {
      this.audio.sfx("error");
      const note = this.ui.overlay.querySelector(".starmap-panel .help-note");
      if (note) {
        note.textContent = result.reason === "poor"
          ? "星辉不足 · 再走完一段故事就能点亮它"
          : "这颗星已经亮到最亮了";
      }
    }
  }

  abandonRun() {
    this.ui.closeOverlay();
    this.save.run = null;
    writeSave(this.save);
    this.stage.clearAll();
    this.renderer.clearRoom();
    this.state = "title";
    this.showTitle();
  }

  // ---------------------------------------------------------------- finish
  finishRun(win) {
    if (this.finished) return;
    this.finished = true;
    const run = this.run;
    const gain = Math.max(5, Math.floor(run.roomsCleared * 6 + run.bosses * 25 + (win ? 50 : 0) + run.dust / 30));
    const oldBest = this.save.meta.best;
    const oldScore = oldBest ? oldBest.act * 100 + oldBest.room + (oldBest.win ? 10000 : 0) : -1;
    const newScore = run.actIndex * 100 + run.roomIndex + (win ? 10000 : 0);
    recordRun(this.save, {
      act: run.actIndex,
      room: run.roomIndex,
      kills: run.kills,
      time: run.time,
      win,
      character: run.character.name
    }, gain);
    clearRun(this.save);
    this.state = "result";
    this.paused = true;
    this.input.enabled = false;
    this.input.clear();
    this.ui.hideBoss();
    this.ui.hideInteract();
    this.ui.hideHud();
    if (this.playerHandle) {
      this.playerHandle.setVisible(true);
      if (win) {
        this.playerHandle.setTilt(0);
        this.playerHandle.play("win_st_0", { loop: true, fade: 0.2 });
      }
    }
    this.audio.playBgm(win ? BGM.win : BGM.rest);
    this.resultData = {
      win,
      character: run.character,
      act: run.actIndex,
      room: run.roomIndex,
      kills: run.kills,
      time: run.time,
      starlight: gain,
      best: newScore > oldScore
    };
    this.presentResult();
  }

  presentResult() {
    if (!this.resultData) return;
    const data = this.resultData;
    this.ui.showResult({
      ...data,
      onAgain: () => { this.ui.closeOverlay(); this.stage.clearAll(); this.showSelect(); },
      onTitle: () => { this.ui.closeOverlay(); this.showTitle(); },
      onStarmap: () => {
        this.ui.closeOverlay();
        this.openStarMap("result");
      }
    });
  }

  // ---------------------------------------------------------------- render
  render() {
    if (this.state === "title" || this.state === "select") {
      this.renderer.drawTitle(this.titleTime);
      this.stage.render(0, 0, 0, 0);
      return;
    }
    if (this.room) {
      this.renderer.drawWorld(this, this.time);
      this.stage.render(this.camera.x, 0, this.camera.shakeX, this.camera.shakeY);
      this.renderer.drawFX(this, this.time);
    } else {
      this.renderer.drawTitle(this.titleTime);
      this.stage.render(0, 0, 0, 0);
    }
  }
}

// Exported for tests and for the small constellation map on the title screen.
export function roomTypeLabel(type) {
  return ROOM_TYPE_LABEL[type] || type;
}
