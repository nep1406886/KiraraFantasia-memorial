// ============================================================
// 玩家：移动、连击、特技、换演、谢幕
// ============================================================
import { G, activeMember, addStyle, loseStyle } from './state.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { FX } from './fx.js';
import { W, H, FLOOR, GRAVITY, EL } from './config.js';
import { CHAR_MAP } from './data/characters.js';
import {
  hitEnemiesBox, hitEnemiesCircle, spawnPlayerProjectile, spawnZone,
  healTeam, nearestEnemy, explode, damageEnemy, enemiesInRadius,
} from './combat.js';
import { getImg, ready, silhouette } from './core/assets.js';
import { clamp, damp, rnd, rint, TAU, angleTo, dist, pick, chance, hexA } from './utils.js';

const DRAW_H = 246;

export class Player {
  constructor(run) {
    this.run = run;
    this.x = 220;
    this.y = FLOOR;
    this.prevY = FLOOR;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;
    this.grounded = true;
    this.jumpsUsed = 0;
    this.maxJumps = 2;
    this.coyote = .1;
    this.jumpBuffer = 0;
    this.jumpHeld = false;
    this.landT = 0; // 落地缓冲的挤压拉伸计时

    this.state = 'idle';
    this.stateT = 0;
    this.animT = 0;
    this.attackIndex = 0;
    this.attackDef = null;
    this.attackQueued = false;
    this.attackHit = false;
    this.comboResetT = 0;
    this.hitList = new Set();

    this.dashT = 0;
    this.dashCd = 0;
    this.dashCharges = 1;
    this.dashHit = new Set();
    this.dropT = 0;

    this.switchCd = 0;
    this.invuln = .7;
    this.hurtT = 0;
    this.parryT = 0;
    this.guardT = 0;
    this.blocked = 0;
    this.teamInvulnT = 0;
    this.skillData = null;

    this.ultActions = [];
    this.ultT = 0;
    this.ghostT = 0;
    this.auraT = 0;
    this.deathT = 0;
    this.stats = run.stats;
  }

  get member() { return G.run.team[G.run.active]; }
  get char() { return CHAR_MAP[this.member.id]; }
  get maxDashes() { return 1 + (this.stats.dashCharge || 0); }
  get shield() { return this.member.shield || 0; }
  set shield(v) { this.member.shield = v; }

  resetPos(x = 220) {
    this.x = x;
    this.y = FLOOR;
    this.prevY = FLOOR;
    this.vx = 0; this.vy = 0;
    this.facing = 1;
    this.grounded = true;
    this.state = 'idle';
    this.stateT = 0;
    this.invuln = .8;
    this.dashT = 0;
    this.attackIndex = 0;
    this.skillData = null;
    this.parryT = 0;
    this.guardT = 0;
    this.ultActions.length = 0;
  }

  update(dt) {
    this.animT += dt;
    this.stats = G.run.stats;
    const m = this.member;
    for (const t of G.run.team) {
      t.skillCd = Math.max(0, (t.skillCd || 0) - dt);
    }
    this.switchCd = Math.max(0, this.switchCd - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.teamInvulnT = Math.max(0, this.teamInvulnT - dt);
    this.blocked = Math.max(0, this.blocked - dt);
    this.comboResetT = Math.max(0, this.comboResetT - dt);
    this.landT = Math.max(0, this.landT - dt * 3.4);
    if (this.comboResetT <= 0 && this.state !== 'attack') this.attackIndex = 0;
    if (this.grounded) {
      this.jumpsUsed = 0;
      this.dashCharges = this.maxDashes;
    }
    if (G.run.over) {
      this.deathT += dt;
      this.updatePhysics(dt, true);
      return;
    }
    if (m.downed) return;

    // 换演优先
    if (Input.pressed('swap') && this.state !== 'ult') {
      this.trySwitch();
    }
    // 谢幕
    if (Input.pressed('ult') && m.ult >= 100 && this.state !== 'ult') {
      this.castUlt();
    }

    if (this.state === 'ult') {
      this.updateUlt(dt);
      return;
    }
    if (this.state === 'parry') {
      this.parryT -= dt;
      this.stateT += dt;
      this.updatePhysics(dt, true);
      if (this.parryT <= 0) { this.state = 'idle'; this.stateT = 0; }
      this.emitGhost(dt, '#bff5e5');
      return;
    }
    if (this.state === 'guard') {
      this.guardT -= dt;
      this.stateT += dt;
      this.vx = damp(this.vx, 0, 10, dt);
      this.updatePhysics(dt, true);
      if (this.guardT <= 0) {
        this.shieldBash();
      }
      return;
    }
    if (this.state === 'skill') {
      this.updateSkill(dt);
      this.emitGhost(dt, this.char.hitColor);
      return;
    }
    if (this.state === 'attack') {
      this.updateAttack(dt);
      return;
    }

    // 普通移动
    const ax = Input.axisX();
    const maxSpd = this.char.speed;
    if (Math.abs(ax) > .08) {
      const accel = this.grounded ? 3400 : 2300;
      this.vx += ax * accel * dt;
      this.facing = ax < 0 ? -1 : 1;
    } else {
      this.vx = damp(this.vx, 0, this.grounded ? 14 : 3.4, dt);
    }
    this.vx = clamp(this.vx, -maxSpd, maxSpd);

    // 跳跃
    if (Input.pressed('jump')) {
      this.jumpBuffer = .13;
      this.jumpHeld = true;
    }
    if (Input.released('jump')) this.jumpHeld = false;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? .1 : Math.max(0, this.coyote - dt);

    if (this.jumpBuffer > 0) {
      if (Input.downState('down') && this.grounded && this.isOnOneWay()) {
        this.dropT = .24;
        this.grounded = false;
        this.y += 8;
        this.jumpBuffer = 0;
        Audio.sfx('dash', { volume: .3, gap: 80 });
      } else if (this.grounded || this.coyote > 0) {
        this.doJump(false);
        this.coyote = 0;
        this.jumpBuffer = 0;
      } else if (this.jumpsUsed < this.maxJumps) {
        this.doJump(true);
        this.jumpBuffer = 0;
      }
    }
    if (!this.jumpHeld && this.vy < -240) this.vy = Math.max(this.vy, -240);

    // 闪身
    if (Input.pressed('dash') && this.dashT <= 0 && (this.dashCharges > 0)) {
      this.startDash();
    }

    // 攻击
    if (Input.pressed('attack')) {
      if (this.state !== 'attack') {
        this.startAttack(this.comboResetT > 0 ? (this.attackIndex + 1) % this.char.combo.length : 0);
      }
    }
    // 特技
    if (Input.pressed('skill')) this.trySkill();

    // 闪身状态
    if (this.dashT > 0) {
      this.dashT -= dt;
      this.vx = this.facing * 900;
      this.vy = 0;
      this.dashCharges = Math.max(0, this.dashCharges);
      this.emitGhost(dt, this.char.hitColor);
      if (this.stats.flags.has('dashStrike')) {
        const r = 82;
        // 「猫步」：穿透伤害吃 dashDmg 加成（默认 60% 攻击），并随攻击力提升
        const mul = Math.max(.3, this.stats.dashDmg || .6);
        const dashBase = this.char.atk * mul * (1 + (this.stats.atk || 0) + (this.stats.melee || 0));
        for (const e of G.enemies) {
          if (e.dead || this.dashHit.has(e)) continue;
          if (dist(this.x, this.y - 80, e.x, e.y - e.h * .5) < r + e.w * .4) {
            this.dashHit.add(e);
            damageEnemy(e, dashBase, { element: this.char.element, color: this.char.hitColor, style: 4, fromX: this.x });
          }
        }
      }
      this.updatePhysics(dt, true);
      if (this.dashT <= 0) {
        this.vx *= .35;
        // 「猫步」的闪身冷却缩短
        this.dashCd = .18 * (1 - (this.stats.dashCd || 0));
      }
      return;
    }

    this.updatePhysics(dt);
    if (this.grounded) {
      if (Math.abs(this.vx) > 30) {
        if (this.state !== 'run') this.state = 'run';
      } else if (this.state !== 'idle') this.state = 'idle';
    } else if (this.state !== 'jump' && this.state !== 'fall') {
      this.state = this.vy < 0 ? 'jump' : 'fall';
    }
    if (!this.grounded && this.state === 'run') this.state = 'fall';

    // 掉落地面残影
    if (!this.grounded && this.vy > 500 && Math.random() < .2) {
      FX.p({ x: this.x + rnd(-10, 10), y: this.y - 60, vx: 0, vy: rnd(-20, 20), life: .25, size: 3, color: this.char.hitColor, glow: true, alpha: .4 });
    }
  }

  updatePhysics(dt, noInput = false) {
    this.prevY = this.y;
    this.vy = Math.min(1500, this.vy + GRAVITY * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const room = G.room;
    if (room) {
      const left = room.bounds.left + 26;
      const right = room.bounds.right - 26;
      if (this.x < left) { this.x = left; this.vx = Math.max(0, this.vx); }
      if (this.x > right) { this.x = right; this.vx = Math.min(0, this.vx); }
    }
    this.dropT = Math.max(0, this.dropT - dt);
    // 与平台碰撞
    let landY = FLOOR;
    if (room && this.dropT <= 0 && this.vy >= 0) {
      for (const p of room.platforms) {
        if (this.x + 20 < p.x || this.x - 20 > p.x + p.w) continue;
        if (this.prevY <= p.y + 1 && this.y >= p.y) {
          landY = Math.min(landY, p.y);
        }
      }
    }
    if (this.y >= landY) {
      const falling = this.vy;
      this.y = landY;
      this.vy = 0;
      if (!this.grounded) {
        this.onLand(falling);
      }
      this.grounded = true;
      this.coyote = .1;
      if (this.state === 'jump' || this.state === 'fall') this.state = 'idle';
    } else {
      if (this.grounded && this.y < landY - 1) this.grounded = false;
      if (this.grounded) {
        // 站在平台边缘时保持支撑
        this.grounded = false;
        for (const p of room ? room.platforms : []) {
          if (this.x >= p.x - 4 && this.x <= p.x + p.w + 4 && Math.abs(this.y - p.y) < 2) this.grounded = true;
        }
        if (Math.abs(this.y - FLOOR) < 2) this.grounded = true;
        if (!this.grounded) this.coyote = .09;
      }
    }
  }

  isOnOneWay() {
    const room = G.room;
    if (!room) return false;
    if (Math.abs(this.y - FLOOR) < 2) return false;
    return room.platforms.some((p) => this.x >= p.x && this.x <= p.x + p.w && Math.abs(this.y - p.y) < 2);
  }

  onLand(falling) {
    this.jumpsUsed = 0;
    this.dashCharges = this.maxDashes;
    // 落地缓冲：按下落速度给一记挤压回弹
    this.landT = clamp(falling / 1100, .3, 1);
    Audio.sfx('land', { volume: clamp(falling / 900, .2, .9), gap: 90 });
    FX.dust(this.x, this.y, falling > 700 ? 12 : 6);
    FX.shake(falling > 900 ? .12 : .04);
    if (falling > 1150) {
      FX.ring(this.x, this.y - 4, 70, this.char.hitColor, { life: .3, width: 2, squash: .3 });
      enemiesInRadius(this.x, this.y - 20, 95).forEach((e) => {
        damageEnemy(e, this.char.atk * .3, { element: this.char.element, color: this.char.hitColor, style: 3, canCrit: false });
      });
    }
  }

  doJump(double) {
    this.vy = -this.char.jump * (double ? .9 : 1);
    this.grounded = false;
    this.jumpsUsed += 1;
    this.state = 'jump';
    Audio.sfx('jump', { volume: double ? .7 : .5, gap: 60 });
    if (double) {
      // 二段跳手感：空中转向借力 + 脚下气浪
      const ax = Input.axisX();
      if (Math.abs(ax) > .25) this.vx = clamp(this.vx + ax * 170, -this.char.speed, this.char.speed);
      FX.ring(this.x, this.y - 8, 46, this.char.hitColor, { life: .34, width: 2, squash: .5 });
      FX.slash(this.x, this.y - 4, Math.PI / 2, 40, '#fff8e8', { width: 9, span: 1.05, life: .22 });
      for (let i = 0; i < 6; i++) {
        FX.p({ x: this.x + rnd(-14, 14), y: this.y - 6, vx: rnd(-90, 90), vy: rnd(-40, 40), life: .4, size: 3, color: this.char.hitColor, glow: true, shape: 'star' });
      }
      FX.p({ x: this.x, y: this.y, vx: 0, vy: 120, life: .3, size: 14, color: '#fff8e8', glow: true, shape: 'circle', alpha: .5 });
    } else {
      FX.dust(this.x, this.y, 4);
    }
  }

  startDash() {
    this.dashCharges -= 1;
    this.dashT = .16;
    this.dashHit.clear();
    // 无敌帧确认：覆盖整段冲刺再留 .1s 余量，贴脸也敢闪
    this.invuln = Math.max(this.invuln, .26);
    const ax = Input.axisX();
    if (Math.abs(ax) > .1) this.facing = ax < 0 ? -1 : 1;
    this.state = 'dash';
    this.stateT = 0;
    Audio.sfx('dash', { volume: .7, gap: 60 });
    FX.ring(this.x - this.facing * 20, this.y - 70, 40, this.char.hitColor, { life: .25, width: 2 });
    for (let i = 0; i < 8; i++) {
      FX.p({ x: this.x - this.facing * rnd(0, 26), y: this.y - rnd(30, 140), vx: -this.facing * rnd(80, 220), vy: rnd(-30, 30), life: .4, size: rnd(2, 4), color: this.char.hitColor, glow: true, shape: 'spark' });
    }
  }

  startAttack(index) {
    this.attackIndex = index;
    this.attackDef = this.char.combo[index];
    this.state = 'attack';
    this.stateT = 0;
    this.attackHit = false;
    this.attackQueued = false;
    this.hitList = new Set();
    this.hurtT = 0;
    const ax = Input.axisX();
    if (Math.abs(ax) > .1) this.facing = ax < 0 ? -1 : 1;
    if (this.attackDef.lunge) {
      this.vx += this.facing * this.attackDef.lunge * .55;
    }
    if (this.grounded && this.attackDef.kind === 'melee') {
      this.vx *= .8;
    }
  }

  updateAttack(dt) {
    const def = this.attackDef;
    // 攻击速度：整段动作与出招帧等比缩短（「放学后的和弦」「猫爪」）
    const as = 1 + (this.stats.as || 0);
    const dur = def.dur / as;
    this.stateT += dt;
    // 连段手感：后摇的后 60% 可直接取消接下一段/闪身/特技；
    // 更早的输入先进缓冲，等这招收完自动接上
    const cancelAt = dur * (def.hit + (1 - def.hit) * .4);
    const canCancel = this.stateT >= cancelAt;
    if (Input.pressed('attack')) {
      if (canCancel) {
        this.startAttack((this.attackIndex + 1) % this.char.combo.length);
        return;
      }
      this.attackQueued = true;
    }
    if (canCancel) {
      if (Input.pressed('dash') && this.dashT <= 0 && this.dashCharges > 0) {
        this.startDash();
        return;
      }
      if (Input.pressed('skill') && (this.member.skillCd || 0) <= 0) {
        this.trySkill();
        return;
      }
    }
    if (!this.attackHit && this.stateT >= dur * def.hit) {
      this.attackHit = true;
      this.performAttack(def);
    }
    // 移动衰减
    this.vx = damp(this.vx, 0, this.grounded ? 9 : 2, dt);
    this.updatePhysics(dt, true);
    if (this.stateT >= dur) {
      if (this.attackQueued) {
        const next = (this.attackIndex + 1) % this.char.combo.length;
        this.startAttack(next);
        this.attackQueued = false;
      } else {
        this.state = this.grounded ? 'idle' : 'fall';
        this.stateT = 0;
        this.comboResetT = .62;
      }
    }
  }

  performAttack(def) {
    const char = this.char;
    const element = char.element;
    const color = char.hitColor;
    const atk = char.atk;
    const stats = this.stats;
    const kind = def.kind;
    const base = atk * def.dmg * (1 + (stats.atk || 0) + (kind === 'shot' ? (stats.ranged || 0) : (stats.melee || 0)));
    const yoff = def.y ?? -78;

    if (kind === 'shot') {
      const shots = def.shots || { count: 1, speed: 800, size: 10 };
      // 收尾段多一发：让连段的最后一击更有分量
      const n = (shots.count || 1) + (this.attackIndex === this.char.combo.length - 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const spread = shots.spread || 0;
        let a = this.facing > 0 ? 0 : Math.PI;
        if (n > 1) a += (i - (n - 1) / 2) * spread * (this.facing > 0 ? 1 : -1);
        a += rnd(-.012, .012);
        const target = nearestEnemy(this.x, this.y - 80, 780);
        spawnPlayerProjectile({
          x: this.x + this.facing * 28, y: this.y + yoff,
          speed: shots.speed || 800, angle: a,
          dmg: base, element, color,
          size: shots.size || 10, r: shots.size || 10,
          homing: shots.homing || 0, pierce: shots.pierce || 0,
          type: char.weapon === 'bow' ? 'arrow' : char.weapon === 'guns' ? 'bullet' : char.weapon === 'tome' ? 'orb' : 'star',
          life: 1.6, target,
        });
      }
      Audio.sfx(char.weapon === 'guns' ? 'shoot' : 'magic', { volume: .55, gap: 40 });
      FX.burst(this.x + this.facing * 36, this.y + yoff, {
        count: 5, color, speed: 140, dir: this.facing > 0 ? 0 : Math.PI,
        spread: .7, size: 3, life: .25, glow: true, shape: 'spark',
      });
      if (this.stats.flags.has('thirdWave') && this.attackIndex === 2) {
        this.waveProjectile(def);
      }
      return;
    }

    if (kind === 'spin') {
      const radius = def.reach || 150;
      hitEnemiesCircle(this.x, this.y + yoff, radius, {
        dmg: base, element, color, style: 8, fromX: this.x,
        knock: def.knock, launch: def.launch, hitList: this.hitList,
      });
      FX.ring(this.x, this.y + yoff, radius, color, { life: .32, width: 5 });
      FX.ring(this.x, this.y + yoff, radius * .7, '#fff8e8', { life: .22, width: 2 });
      Audio.sfx('heavy', { volume: .7 });
      FX.shake(.2);
      FX.hitstop(.04);
      this.emitSlash(TAU, def.reach, color, def, true);
      return;
    }

    if (kind === 'slam') {
      const cx = this.x + this.facing * (def.reach * .35);
      hitEnemiesCircle(cx, this.y - 30, def.reach * .75, {
        dmg: base, element, color, style: 9, fromX: this.x,
        knock: def.knock, launch: def.launch, hitList: this.hitList,
      });
      FX.ring(cx, this.y - 8, def.reach * 1.1, color, { life: .45, width: 5, squash: .32 });
      FX.ring(cx, this.y - 8, def.reach * .7, '#fff8e8', { life: .3, width: 2, squash: .3 });
      FX.dust(cx, this.y, 16);
      FX.shake(.35);
      FX.hitstop(.055);
      Audio.sfx('heavy', { volume: 1 });
      if (def.shockwave) {
        spawnPlayerProjectile({
          x: cx, y: this.y - 20, vx: this.facing * 620, vy: 0,
          dmg: base * .5, element, color, size: 30, type: 'wave',
          pierce: 4, life: .9, heavy: true,
        });
      }
      if (def.heal) healTeam(def.heal, true);
      this.emitSlash(Math.PI / 2 * this.facing, def.reach, color, def, true);
      return;
    }

    // melee / thrust
    const reach = def.reach || 100;
    const h = def.h || 90;
    const cx = this.x + this.facing * (reach * .5 + 18);
    const cy = this.y + yoff;
    hitEnemiesBox({
      box: { x: cx - reach / 2, y: cy - h / 2, w: reach, h },
      dmg: base, element, color, style: 7, fromX: this.x,
      knock: def.knock, launch: def.launch, hitList: this.hitList,
      heavy: kind === 'thrust' && def.dmg > .9,
    });
    this.emitSlash(this.facing > 0 ? 0 : Math.PI, reach, color, def, false);
    Audio.sfx(def.dmg > .9 ? 'slash2' : 'slash', { volume: .75, gap: 45 });
    FX.shake(def.dmg > .9 ? .16 : .07);
    FX.hitstop(def.dmg > .9 ? .04 : .02);

    if (this.stats.flags.has('thirdWave') && this.attackIndex === 2) this.waveProjectile(def);
  }

  waveProjectile(def) {
    const color = this.char.hitColor;
    spawnPlayerProjectile({
      x: this.x + this.facing * 40, y: this.y - 80, vx: this.facing * 620, vy: 0,
      dmg: this.char.atk * .45, element: this.char.element, color,
      size: 34, type: 'wave', pierce: 3, life: .9,
    });
    FX.ring(this.x + this.facing * 42, this.y - 80, 50, color, { life: .3, width: 2, squash: .7 });
  }

  emitSlash(angle, reach, color, def, heavy) {
    const baseAngle = angle;
    const span = def.kind === 'thrust' ? .5 : 1.5;
    FX.slash(this.x + Math.cos(baseAngle) * 20, this.y + (def.y ?? -78), baseAngle, reach * .95, color, {
      width: heavy ? 34 : 22, span, life: heavy ? .28 : .2,
    });
    if (heavy) {
      FX.slash(this.x, this.y + (def.y ?? -78), baseAngle + .15, reach * .7, '#fff8e8', { width: 8, span: .9, life: .18 });
    }
  }

  trySkill() {
    const s = this.char.skill;
    if ((this.member.skillCd || 0) > 0) return;
    let cdMul = (1 - (this.stats.cdr || 0));
    if (this.char.id === 'claire') cdMul *= .85;
    this.member.skillCd = s.cd * cdMul;
    this.stateT = 0;
    Audio.sfx('magic');
    const atk = this.char.atk;
    const color = this.char.hitColor;
    const element = this.char.element;
    switch (this.char.id) {
      case 'kirara': {
        healTeam(this.member.maxHp * .1, true);
        for (let i = 0; i < 6; i++) {
          const a = -Math.PI / 2 + (i - 2.5) * .5;
          spawnPlayerProjectile({
            x: this.x, y: this.y - 100, speed: 560, angle: a,
            dmg: atk * .8, element, color, size: 13, type: 'star', homing: 1.1, life: 1.7,
          });
        }
        FX.ring(this.x, this.y - 90, 90, color, { life: .55, width: 3 });
        FX.burst(this.x, this.y - 90, { count: 18, color, speed: 260, size: 4, life: .6, glow: true, shape: 'star' });
        this.skillData = { id: 'cast', t: 0, dur: .28 };
        this.state = 'skill';
        break;
      }
      case 'lamp': {
        this.shield = (this.shield || 0) + 44;
        healTeam(this.member.maxHp * .09, true);
        this.teamInvulnT = Math.max(this.teamInvulnT, .25);
        FX.ring(this.x, this.y - 100, 96, '#66b8ea', { life: .7, width: 4 });
        FX.burst(this.x, this.y - 100, { count: 22, color: '#bfe6ff', speed: 200, size: 4, life: .8, glow: true, shape: 'plus' });
        Audio.sfx('heal');
        this.skillData = { id: 'cast', t: 0, dur: .32 };
        this.state = 'skill';
        break;
      }
      case 'kanna': {
        this.parryT = .55;
        this.state = 'parry';
        this.stateT = 0;
        this.vx = 0;
        FX.ring(this.x, this.y - 90, 60, '#bff5e5', { life: .5, width: 2 });
        FX.slash(this.x + this.facing * 20, this.y - 85, this.facing > 0 ? 0 : Math.PI, 110, '#bff5e5', { width: 16, span: 1.1, life: .5 });
        Audio.sfx('parry', { volume: .4 });
        break;
      }
      case 'raine': {
        this.state = 'skill';
        this.skillData = { id: 'fireWheel', t: 0, dur: .86, tick: 0, hits: new Set() };
        this.vx = this.facing * 560;
        Audio.sfx('explode', { volume: .4 });
        break;
      }
      case 'cork': {
        this.state = 'skill';
        this.skillData = { id: 'cast', t: 0, dur: .3 };
        this.vy = -380;
        this.vx = -this.facing * 300;
        for (let i = 0; i < 5; i++) {
          const a = (this.facing > 0 ? 0 : Math.PI) + rnd(-.35, .35);
          spawnPlayerProjectile({
            x: this.x, y: this.y - 90, speed: rnd(300, 480), angle: a - .35,
            dmg: atk * .95, element, color, size: 11, type: 'bomb',
            gravity: 1150, life: 1.1, explode: 74, heavy: true,
          });
        }
        Audio.sfx('shoot', { volume: .8 });
        break;
      }
      case 'claire': {
        const x = this.x + this.facing * 150;
        spawnZone({
          x, y: this.y - 94, r: 118, life: 1.1, type: 'moonGate',
          color: '#b49bf0', element, dmg: 0, pull: 620,
          explode: atk * 2.9, tick: .5,
        });
        FX.ring(x, this.y - 94, 120, '#b49bf0', { life: .8, width: 3 });
        this.skillData = { id: 'cast', t: 0, dur: .38 };
        this.state = 'skill';
        break;
      }
      case 'hakka': {
        this.state = 'skill';
        this.skillData = { id: 'sweep', t: 0, dur: .36, tick: 0, hits: new Set() };
        this.vx = this.facing * 820;
        this.invuln = Math.max(this.invuln, .32);
        Audio.sfx('dash', { volume: .7 });
        break;
      }
      case 'highpris': {
        this.guardT = 1;
        this.state = 'guard';
        this.stateT = 0;
        FX.ring(this.x, this.y - 90, 80, '#cf9a5e', { life: .5, width: 3 });
        Audio.sfx('parry', { volume: .5 });
        break;
      }
      case 'suzuran': {
        for (let i = 0; i < 14; i++) {
          const x = clamp(this.x + rnd(-380, 380), 80, G.room.w - 80);
          spawnPlayerProjectile({
            x, y: -rnd(20, 160), speed: 940, angle: Math.PI / 2 + rnd(-.06, .06),
            dmg: atk * .7, element, color, size: 10, type: 'arrow', pierce: 1, life: 2.2,
          });
        }
        FX.ring(this.x, this.y - 60, 120, '#bff5e5', { life: .5, width: 2 });
        this.skillData = { id: 'cast', t: 0, dur: .35 };
        this.state = 'skill';
        break;
      }
      default: break;
    }
  }

  updateSkill(dt) {
    const sd = this.skillData;
    this.stateT += dt;
    if (!sd) { this.state = 'idle'; return; }
    if (sd.id === 'cast') {
      this.grounded = false;
      this.updatePhysics(dt, true);
      if (this.stateT >= sd.dur) {
        this.state = this.grounded ? 'idle' : 'fall';
        this.skillData = null;
      }
      return;
    }
    if (sd.id === 'fireWheel') {
      this.vx = this.facing * 560;
      this.grounded = false;
      this.updatePhysics(dt, true);
      sd.t += dt;
      sd.tick -= dt;
      if (sd.tick <= 0) {
        sd.tick = .12;
        const dmg = this.char.atk * .42 * (1 + (this.stats.atk || 0) + (this.stats.melee || 0));
        hitEnemiesCircle(this.x, this.y - 70, 105, {
          dmg, element: 'fire', color: '#ff9a5a', style: 6, fromX: this.x, hitstop: .01,
        });
        FX.burst(this.x, this.y - 60, { count: 8, colors: ['#ff9a5a', '#ffd166'], speed: 220, size: 5, life: .35, glow: true, shape: 'circle' });
        FX.ring(this.x, this.y - 60, 100, '#ff9a5a', { life: .25, width: 3, squash: .8 });
        Audio.sfx('slash', { volume: .5, gap: 80 });
      }
      if (sd.t >= sd.dur) {
        this.state = this.grounded ? 'idle' : 'fall';
        this.skillData = null;
      }
      return;
    }
    if (sd.id === 'sweep') {
      this.vx = this.facing * 820;
      this.grounded = false;
      this.updatePhysics(dt, true);
      sd.t += dt;
      sd.tick -= dt;
      this.emitGhost(dt, '#c9a0ff');
      if (sd.tick <= 0) {
        sd.tick = .06;
        const dmg = this.char.atk * .46 * (1 + (this.stats.atk || 0) + (this.stats.melee || 0));
        const hits = hitEnemiesCircle(this.x, this.y - 70, 105, {
          dmg, element: this.char.element, color: '#c9a0ff', style: 5, fromX: this.x, hitstop: .01,
        });
        if (hits > 0) {
          this.member.hp = Math.min(this.member.maxHp, this.member.hp + 1.2);
        }
        FX.slash(this.x, this.y - 70, this.facing > 0 ? 0 : Math.PI, 115, '#c9a0ff', { width: 18, span: 1.5, life: .18 });
        Audio.sfx('slash', { volume: .4, gap: 55 });
      }
      if (sd.t >= sd.dur) {
        this.state = this.grounded ? 'idle' : 'fall';
        this.skillData = null;
      }
      return;
    }
    this.state = 'idle';
  }

  shieldBash() {
    const atk = this.char.atk;
    hitEnemiesCircle(this.x + this.facing * 50, this.y - 80, 120, {
      dmg: atk * 1.4 * (1 + (this.stats.atk || 0)), element: this.char.element,
      color: '#cf9a5e', style: 8, fromX: this.x, knock: 260, launch: -140,
    });
    FX.ring(this.x + this.facing * 50, this.y - 80, 130, '#cf9a5e', { life: .4, width: 5 });
    FX.shake(.25);
    Audio.sfx('heavy', { volume: .8 });
    this.guardT = 0;
    this.state = 'idle';
    this.stateT = 0;
  }

  parryCounter(sourceX) {
    this.parryT = 0;
    this.state = 'skill';
    this.skillData = { id: 'cast', t: 0, dur: .3 };
    this.invuln = .7;
    const atk = this.char.atk;
    hitEnemiesCircle(this.x, this.y - 80, 170, {
      dmg: atk * 2.8 * (1 + (this.stats.atk || 0)), element: 'wind',
      color: '#bff5e5', style: 18, fromX: this.x, knock: 340, launch: -220, hitstop: .08,
    });
    FX.ring(this.x, this.y - 80, 170, '#bff5e5', { life: .6, width: 6 });
    FX.ring(this.x, this.y - 80, 120, '#fff8e8', { life: .4, width: 3 });
    FX.flash('#bff5e5', .35, .25);
    FX.slowmo(.45, .25);
    FX.shake(.4);
    Audio.sfx('parry', { volume: 1 });
    Audio.sfx('crit', { volume: 1 });
    addStyle(30);
    this.member.ult = Math.min(100, this.member.ult + 12);
    // 回复一次闪身
    this.dashCharges = this.maxDashes;
    this.vx = this.x < sourceX ? -260 : 260;
  }

  trySwitch() {
    if (this.switchCd > 0) return;
    const team = G.run.team;
    const living = team.map((m, i) => (!m.downed && m.hp > 0 ? i : -1)).filter((i) => i >= 0);
    if (living.length <= 1) return;
    let idx = living.find((i) => i > G.run.active);
    if (idx == null) idx = living[0];
    if (idx === G.run.active) return;
    this.switchTo(idx, false);
  }

  switchTo(index, forced = false) {
    const old = G.run.active;
    if (index === old && !forced) return;
    const team = G.run.team;
    const newM = team[index];
    if (!newM || newM.downed) return;
    // 保存旧护盾
    G.run.active = index;
    this.switchCd = forced ? .6 : 1.05 * (1 - (this.stats.switchCdr || 0));
    this.state = 'idle';
    this.stateT = 0;
    this.attackIndex = 0;
    this.attackDef = null;
    this.skillData = null;
    this.parryT = 0;
    this.guardT = 0;
    this.ultActions.length = 0;
    this.invuln = Math.max(this.invuln, forced ? 1.1 : .35);
    this.dashCharges = this.maxDashes;
    this.vx = 0;
    this.vy = Math.min(this.vy, 0);
    if (!forced) {
      Audio.sfx('switch');
      // 换演瞬间 0.2s 微慢动作：给登场一拍呼吸
      FX.slowmo(.22, .42);
      FX.flash(this.char.hitColor, .16, .16);
      FX.ring(this.x, this.y - 80, 90, this.char.hitColor, { life: .5, width: 4 });
      FX.ring(this.x, this.y - 80, 150, this.char.hitColor, { life: .65, width: 2 });
      FX.burst(this.x, this.y - 80, { count: 20, color: this.char.hitColor, speed: 260, size: 4, life: .6, glow: true, shape: 'star' });
      this.emitGhost(.016, this.char.hitColor);
      G.banner = { type: 'switch', name: this.char.name, sub: this.char.title, color: this.char.hitColor, t: 0, dur: 1.25 };
      this.switchInAttack(forced);
      if (this.stats.flags.has('switchHeal')) healTeam(3, true);
      if (this.stats.flags.has('switchHeal4')) healTeam(4, true);
      if (this.stats.switchShield) this.shield = (this.shield || 0) + this.stats.switchShield;
    }
  }

  switchInAttack(forced) {
    const sw = this.char.switchIn;
    const atk = this.char.atk * (sw.dmg || 1) * (1 + (this.stats.atk || 0) + (this.stats.switchDmg || 0));
    const color = this.char.hitColor;
    const element = this.char.element;
    const type = sw.type;
    const hits = () => hitEnemiesCircle(this.x, this.y - 80, 130, {
      dmg: atk, element, color, style: 10, fromX: this.x, knock: 220, launch: -100,
    });
    if (type === 'ring' || type === 'slam' || type === 'spin') {
      hits();
      FX.ring(this.x, this.y - 60, 150, color, { life: .45, width: 5, squash: type === 'slam' ? .4 : 1 });
      FX.ring(this.x, this.y - 60, 100, '#fff8e8', { life: .3, width: 2 });
      FX.shake(.2);
      if (type === 'slam') FX.dust(this.x, this.y, 14);
    } else if (type === 'wave') {
      spawnPlayerProjectile({
        x: this.x + this.facing * 30, y: this.y - 80, vx: this.facing * 700, vy: 0,
        dmg: atk, element, color, size: 46, type: 'wave', pierce: 6, life: .8, heavy: true,
      });
      if (sw.heal) healTeam(sw.heal, true);
    } else if (type === 'dashSlash' || type === 'charge') {
      this.vx = this.facing * 760;
      this.x += this.facing * 20;
      const list = new Set();
      hitEnemiesBox({
        box: { x: this.x - 90, y: this.y - 150, w: 180, h: 150 },
        dmg: atk, element, color, style: 8, fromX: this.x, hitList: list,
        knock: 260, launch: -80,
      });
      if (type === 'charge') {
        for (const e of enemiesInRadius(this.x, this.y - 80, 160)) {
          e.status = e.status || {};
          e.status.stun = Math.max(e.status.stun || 0, sw.stun || .8);
        }
      }
      FX.slash(this.x, this.y - 80, this.facing > 0 ? 0 : Math.PI, 150, color, { width: 26, span: 1.2, life: .2 });
    } else if (type === 'backflipShots') {
      this.vy = -380;
      this.vx = -this.facing * 300;
      for (let i = 0; i < 3; i++) {
        spawnPlayerProjectile({
          x: this.x, y: this.y - 90, speed: 880, angle: (this.facing > 0 ? 0 : Math.PI) + (i - 1) * .1,
          dmg: atk * .8, element, color, size: 9, type: 'bullet', life: 1.1,
        });
      }
    } else if (type === 'orbFan') {
      for (let i = 0; i < 5; i++) {
        spawnPlayerProjectile({
          x: this.x, y: this.y - 90, speed: 620, angle: (this.facing > 0 ? 0 : Math.PI) + (i - 2) * .16,
          dmg: atk * .55, element, color, size: 14, type: 'orb', homing: .8, life: 1.4,
        });
      }
    } else if (type === 'tripleShot') {
      for (let i = 0; i < 3; i++) {
        spawnPlayerProjectile({
          x: this.x, y: this.y - 90, speed: 1150, angle: (this.facing > 0 ? 0 : Math.PI) + (i - 1) * .06,
          dmg: atk * .7, element, color, size: 9, type: 'arrow', life: 1.4,
        });
      }
    }
    FX.burst(this.x, this.y - 80, { count: 16, color, speed: 200, size: 3.5, life: .5, glow: true, shape: 'spark' });
  }

  castUlt() {
    const m = this.member;
    m.ult = 0;
    this.state = 'ult';
    this.ultT = 0;
    this.ultActions.length = 0;
    this.invuln = 3.2;
    this.teamInvulnT = 1.6;
    this.vx = 0;
    this.vy = 0;
    G.ultCutin = { name: this.char.name, en: this.char.en, title: this.char.ult.name, color: this.char.hitColor, t: 0, dur: 1.7 };
    FX.flash(this.char.hitColor, .5, .5);
    FX.slowmo(.7, .3);
    FX.shake(.5);
    Audio.sfx('ult');
    G.banner = { type: 'ult', name: this.char.ult.name, sub: this.char.name, color: this.char.hitColor, t: 0, dur: 1.6 };
    const atk = this.char.atk * (1 + (this.stats.atk || 0)) * (1 + (this.stats.ultDmg || 0));
    const A = (at, fn) => this.ultActions.push({ at, fn });
    const room = G.room;
    const ultId = this.char.ult.id;
    const color = this.char.hitColor;
    const element = this.char.element;
    const center = () => (G.player ? G.player.x : (room ? room.w / 2 : 640));
    if (ultId === 'galaxyTea') {
      const xs = [];
      for (let i = 0; i < 18; i++) xs.push(room ? rnd(80, room.w - 80) : 640 + rnd(-500, 500));
      xs.forEach((x, i) => A(.18 + i * .045, () => {
        spawnPlayerProjectile({
          x, y: -40, speed: 900, angle: Math.PI / 2 + rnd(-.05, .05),
          dmg: atk * 1.2, element: 'sun', color: '#ffe9b0', size: 16, type: 'star',
          life: 1.6, heavy: true, explode: 46,
        });
        FX.ring(x, FLOOR - 4, 46, '#ffe9b0', { life: .4, width: 2, squash: .3 });
      }));
      A(1.15, () => { healTeam(this.member.maxHp * .26, true); FX.flash('#ffe9b0', .3, .3); });
    } else if (ultId === 'eternalLamp') {
      A(.22, () => {
        this.teamInvulnT = 3.1;
        healTeam(this.member.maxHp * .32, true);
        FX.ring(this.x, this.y - 90, 320, '#bfe6ff', { life: 1.1, width: 6 });
        Audio.sfx('heal');
      });
      A(.5, () => {
        const dmg = atk * 3.0;
        for (const e of [...G.enemies]) {
          if (e.dead) continue;
          damageEnemy(e, dmg, { element: 'water', color: '#bfe6ff', style: 18, fromX: this.x, hitstop: .03 });
        }
        FX.ring(this.x, this.y - 80, 420, '#bfe6ff', { life: .8, width: 8, fill: true });
        FX.flash('#dff4ff', .4, .35);
        FX.shake(.6);
      });
    } else if (ultId === 'thousandBirds') {
      for (let i = 0; i < 14; i++) {
        A(.15 + i * .055, () => {
          const target = pick(G.enemies.filter((e) => !e.dead)) || null;
          const tx = target ? target.x : center() + rnd(-300, 300);
          const ty = target ? target.y - target.h * .6 : FLOOR - 120;
          this.x = clamp(tx - this.facing * 60, 60, room.w - 60);
          this.y = Math.max(200, ty + 80);
          FX.slash(tx, ty, rnd(-.6, .6), 150, '#bff5e5', { width: 22, span: 1.6, life: .2 });
          FX.ghost(this.char.stand, this.x, this.y, DRAW_H, this.facing, '#bff5e5', .25);
          if (target) damageEnemy(target, atk * .75, { element: 'wind', color: '#bff5e5', style: 6, fromX: this.x });
          Audio.sfx('slash', { volume: .5, gap: 30 });
        });
      }
      A(1.05, () => {
        for (const e of [...G.enemies]) {
          if (!e.dead) damageEnemy(e, atk * 4, { element: 'wind', color: '#bff5e5', style: 20, fromX: this.x, hitstop: .06, knock: 420, launch: -260 });
        }
        FX.flash('#dffef2', .55, .4);
        FX.ring(this.x, this.y - 80, 300, '#bff5e5', { life: .7, width: 6 });
        FX.shake(.7);
      });
      A(1.2, () => { this.y = FLOOR; this.vy = 0; });
    } else if (ultId === 'grandFinale') {
      const xs = room ? [.1, .3, .5, .7, .9].map((k) => room.w * k) : [200, 440, 680, 920, 1160];
      xs.forEach((x, i) => A(.15 + i * .13, () => {
        spawnZone({ x, y: FLOOR - 30, r: 90, life: .65, type: 'firefield', color: '#ff8a4a', element: 'fire', dmg: atk * .8, tick: .25 });
        FX.ring(x, FLOOR - 10, 100, '#ff9a5a', { life: .6, width: 5, squash: .3 });
        FX.burst(x, FLOOR - 30, { count: 24, colors: ['#ff9a5a', '#ffd166'], speed: 320, size: 5, life: .8, glow: true, gravity: 200 });
        Audio.sfx('explode', { volume: .5 });
      }));
      A(1.0, () => {
        for (const e of [...G.enemies]) {
          if (!e.dead) damageEnemy(e, atk * 3.8, { element: 'fire', color: '#ff9a5a', style: 22, fromX: this.x, hitstop: .05 });
        }
        FX.flash('#ffb46a', .5, .5);
        FX.shake(.8);
        Audio.sfx('explode', { volume: 1 });
        for (let i = 0; i < 40; i++) FX.p({ x: rnd(0, W), y: rnd(100, FLOOR), vx: rnd(-200, 200), vy: rnd(-300, 50), life: .8, size: rnd(3, 7), color: pick(['#ff9a5a', '#ffd166', '#fff3c4']), glow: true, shape: 'circle', gravity: 100 });
      });
    } else if (ultId === 'fireworks') {
      for (let i = 0; i < 26; i++) A(.15 + i * .034, () => {
        const target = pick(G.enemies.filter((e) => !e.dead)) || null;
        spawnPlayerProjectile({
          x: this.x + rnd(-40, 40), y: this.y - 100, target,
          dmg: atk * .9, element: 'earth', color: pick(['#ffd166', '#ff9a5a', '#fff3c4']),
          size: 10, type: 'rocket', homing: 1.3, life: 1.6, explode: 46,
        });
        FX.burst(this.x, this.y - 100, { count: 3, color: '#ffd166', speed: 160, size: 3, life: .3, glow: true });
        Audio.sfx('shoot', { volume: .3, gap: 20 });
      });
      A(1.15, () => {
        FX.flash('#ffe9b0', .55, .5);
        FX.shake(.8);
        for (const e of [...G.enemies]) {
          if (!e.dead) damageEnemy(e, atk * 5, { element: 'earth', color: '#ffd166', style: 25, fromX: this.x });
        }
        Audio.sfx('explode', { volume: 1 });
      });
    } else if (ultId === 'finalPage') {
      const tx = center();
      A(.2, () => {
        spawnZone({ x: tx, y: FLOOR - 120, r: 150, life: 1.4, type: 'blackhole', color: '#b49bf0', element: 'moon', dmg: atk * .5, tick: .3, pull: 900 });
      });
      for (let i = 0; i < 8; i++) A(.3 + i * .1, () => {
        spawnPlayerProjectile({
          x: tx + rnd(-420, 420), y: -30, speed: 920, angle: Math.PI / 2 + rnd(-.06, .06),
          dmg: atk * 2, element: 'moon', color: '#c9a0ff', size: 22, type: 'orb',
          life: 1.8, heavy: true, explode: 70,
        });
        FX.ring(tx + rnd(-100, 100), FLOOR - 4, 60, '#b49bf0', { life: .4, width: 2, squash: .3 });
      });
      A(1.25, () => { FX.flash('#e0d0ff', .4, .4); FX.shake(.6); });
    } else if (ultId === 'moonCleaning') {
      for (let i = 0; i < 18; i++) A(.15 + i * .045, () => {
        const target = pick(G.enemies.filter((e) => !e.dead)) || null;
        if (!target) return;
        FX.slash(target.x + rnd(-20, 20), target.y - target.h * .6, rnd(-1, 1), 150, '#c9a0ff', { width: 26, span: 1.8, life: .25 });
        damageEnemy(target, atk * .65, { element: 'moon', color: '#c9a0ff', style: 7, fromX: target.x - 80 });
        if (target.hp > 0 && target.hp / target.maxHp < .15 && !target.boss && !target.elite) {
          damageEnemy(target, 99999, { element: 'moon', color: '#fff8e8', style: 10 });
        }
        Audio.sfx('slash', { volume: .5, gap: 25 });
      });
      A(1.05, () => { FX.flash('#e0d0ff', .35, .35); FX.shake(.4); });
    } else if (ultId === 'fortress') {
      A(.2, () => {
        this.teamInvulnT = 2.6;
        FX.ring(this.x, this.y - 80, 280, '#cf9a5e', { life: 2.6, width: 5 });
        Audio.sfx('parry');
      });
      A(1.3, () => {
        for (const e of [...G.enemies]) {
          if (e.dead) continue;
          e.status = e.status || {};
          e.status.stun = Math.max(e.status.stun || 0, 1.6);
          damageEnemy(e, atk * 3.6, { element: 'earth', color: '#cf9a5e', style: 24, fromX: this.x });
        }
        FX.ring(this.x, this.y - 70, 420, '#e0b878', { life: .9, width: 8 });
        FX.flash('#f2d9b0', .45, .4);
        FX.shake(.8);
        Audio.sfx('explode', { volume: 1 });
      });
    } else if (ultId === 'thousandPetals') {
      for (let i = 0; i < 30; i++) A(.12 + i * .03, () => {
        const target = pick(G.enemies.filter((e) => !e.dead)) || null;
        spawnPlayerProjectile({
          x: this.x + rnd(-80, 80), y: this.y - 100, target,
          dmg: atk * .8, element: 'wind', color: pick(['#ffd9ec', '#cdf4dd', '#ffe9b0']),
          size: 11, type: 'petal', homing: 1.4, life: 1.6, speed: 600,
        });
      });
      A(1.05, () => {
        const tx = center();
        spawnZone({ x: tx, y: FLOOR - 8, r: 260, life: 4, type: 'flowerfield', color: '#ffd9ec', element: 'wind', dmg: atk * .18, tick: .5, slow: 1 });
        FX.burst(tx, FLOOR - 100, { count: 50, colors: ['#ffd9ec', '#fff3c4', '#cdf4dd'], speed: 340, size: 5, life: 1.2, glow: true, shape: 'petal', gravity: 80 });
        FX.flash('#fff0f6', .35, .4);
        FX.shake(.5);
        Audio.sfx('heal');
      });
    }
    A(1.6, () => {
      this.state = 'idle';
      this.stateT = 0;
      this.y = Math.min(this.y, FLOOR);
      if (this.y >= FLOOR - 1) this.y = FLOOR;
    });
  }

  updateUlt(dt) {
    this.ultT += dt;
    // 悬浮
    this.vx = damp(this.vx, 0, 6, dt);
    this.vy = 0;
    if (this.ultT < 1.5) {
      this.y = damp(this.y, FLOOR - 18, 6, dt);
    }
    while (this.ultActions.length && this.ultActions[0].at <= this.ultT) {
      const a = this.ultActions.shift();
      a.fn();
    }
    this.invuln = Math.max(this.invuln, .2);
    this.emitGhost(dt, this.char.hitColor);
    if (this.ultT > 1.9 && this.state === 'ult') {
      this.state = 'idle';
      this.stateT = 0;
    }
  }

  emitGhost(dt, color) {
    this.ghostT -= dt;
    if (this.ghostT <= 0) {
      this.ghostT = .055;
      FX.ghost(this.char.stand, this.x, this.y + 4, DRAW_H, this.facing < 0, color, .28);
    }
  }

  groundY(x) {
    let y = FLOOR;
    if (G.room) {
      for (const p of G.room.platforms) {
        if (x >= p.x && x <= p.x + p.w && p.y < y) y = p.y;
      }
    }
    return y;
  }

  // -------------------------------------------------------------------------
  // 绘制
  // -------------------------------------------------------------------------
  draw(ctx, t) {
    const char = this.char;
    const img = getImg(char.stand);
    const cam = G.cam.x;
    const x = this.x - cam;
    let y = this.y + 4;
    const flip = this.facing < 0;

    // 影子
    ctx.save();
    const sh = ctx.createRadialGradient(x, this.y + 1, 0, x, this.y + 1, 46);
    sh.addColorStop(0, 'rgba(0,0,0,.45)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.ellipse(x, this.y + 1, 46, 10, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 元素光环
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const auraR = 105 + Math.sin(t * 2.2) * 6;
    const g = ctx.createRadialGradient(x, y - 120, 10, x, y - 120, auraR);
    g.addColorStop(0, hexA(char.hitColor, .13));
    g.addColorStop(.55, hexA(char.hitColor, .05));
    g.addColorStop(1, hexA(char.hitColor, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - auraR, y - 230, auraR * 2, 250);
    ctx.restore();

    // 谢幕时的巨大剪影
    if (this.state === 'ult') {
      const sil = silhouette(char.stand, char.hitColor, 1);
      if (sil) {
        ctx.save();
        ctx.globalAlpha = .28;
        ctx.globalCompositeOperation = 'lighter';
        const hh = DRAW_H * 1.35;
        const ww = (sil.width / sil.height) * hh;
        ctx.translate(x, y);
        if (flip) ctx.scale(-1, 1);
        ctx.drawImage(sil, -ww / 2, -hh, ww, hh);
        ctx.restore();
      }
    }

    // 角色
    if (ready(img)) {
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      let sc = 1;
      let rot = 0;
      let bob = 0;
      let sx = 1, sy = 1;
      if (this.state === 'run') {
        bob = Math.abs(Math.sin(t * 13)) * -4;
        rot = Math.sin(t * 13) * .035;
      } else if (this.grounded) {
        bob = Math.sin(t * 2.6) * 2;
      }
      if (!this.grounded) {
        rot = clamp(this.vy / 1800, -.18, .15) * (flip ? -1 : 1);
        sy = this.vy < 0 ? 1.035 : .975;
        sx = this.vy < 0 ? .97 : 1.02;
      }
      // 落地缓冲：压扁再弹回来
      if (this.landT > 0) {
        const k = Math.sin(Math.min(1, this.landT) * Math.PI);
        sy *= 1 - .09 * k;
        sx *= 1 + .07 * k;
        bob += 3 * k;
      }
      if (this.state === 'attack') {
        const k = this.stateT / (this.attackDef?.dur || .3);
        rot += (flip ? 1 : -1) * Math.sin(k * Math.PI) * .12;
        bob += Math.sin(k * Math.PI) * 4;
        sc = 1 + Math.sin(k * Math.PI) * .015;
      }
      if (this.state === 'dash') {
        rot = (flip ? 1 : -1) * .22;
        sy = .98; sx = 1.04;
      }
      if (this.state === 'skill' && this.skillData?.id === 'fireWheel') {
        rot = Math.sin(t * 28) * .16;
      }
      if (this.state === 'parry') {
        rot = 0;
        bob = 0;
      }
      if (this.state === 'hurt') {
        rot = (flip ? 1 : -1) * .08;
      }
      const h = DRAW_H * sc * (this.state === 'ult' ? 1.03 : 1);
      const w = (iw / ih) * h;
      ctx.save();
      ctx.translate(x, y + bob);
      if (flip) ctx.scale(-1, 1);
      ctx.rotate(rot);
      ctx.scale(sx, sy);
      ctx.drawImage(img, -w / 2, -h, w, h);
      ctx.restore();
      // 受击白闪
      if (this.hurtT > 0 || this.invuln > 0 && Math.floor(t * 20) % 2 === 0) {
        const sil = silhouette(char.stand, this.hurtT > 0 ? '#ff8fa3' : '#ffffff', 1);
        if (sil) {
          ctx.save();
          ctx.globalAlpha = this.hurtT > 0 ? .55 : .18;
          ctx.globalCompositeOperation = 'lighter';
          ctx.translate(x, y + bob);
          if (flip) ctx.scale(-1, 1);
          ctx.rotate(rot);
          ctx.scale(sx, sy);
          ctx.drawImage(sil, -w / 2, -h, w, h);
          ctx.restore();
        }
      }
    }

    // 护盾
    if (this.shield > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(123,214,191,.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(x, y - 110, 62, 118, 0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = .12;
      ctx.fillStyle = '#7bd6bf';
      ctx.fill();
      ctx.restore();
    }

    // 举盾
    if (this.state === 'guard') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(207,154,94,.85)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(x + this.facing * 20, y - 105, 76, -1.25, 1.25);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,240,200,.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x + this.facing * 20, y - 105, 76, -1.1, 1.1);
      ctx.stroke();
      ctx.restore();
    }
    // 居合
    if (this.state === 'parry') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = .5 + .4 * Math.sin(t * 28);
      ctx.strokeStyle = '#bff5e5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y - 90, 70, -1.3, 1.3);
      ctx.stroke();
      ctx.restore();
    }
    // 满星辉光环
    if (this.member.ult >= 100 && this.state !== 'ult') {
      ctx.save();
      ctx.translate(x, y - 110);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = .55 + .25 * Math.sin(t * 4);
      ctx.strokeStyle = '#ffe9b0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(0, 0, 82, 112, 0, 0, TAU);
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const a = i * TAU / 4 + t * .8;
        const sx = Math.cos(a) * 82, sy = Math.sin(a) * 112;
        ctx.fillStyle = '#fff3c4';
        ctx.beginPath();
        ctx.arc(sx, sy, 2.2, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}
