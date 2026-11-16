// ============================================================
// DOM 界面：标题、后台、选角、HUD、奖励、商店、结算、图鉴
// ============================================================
import { G, rankFor } from './state.js';
import { Save } from './core/save.js';
import { Audio } from './core/audio.js';
import { FX } from './fx.js';
import { W, H, SCENES, EL, RANKS, RANK_MAX, COL, FONT_SERIF } from './config.js';
import { CHARACTERS, CHAR_MAP, STARTERS } from './data/characters.js';
import { BOONS, CATS, RARITY, computeStats } from './data/boons.js';
import { ACTS, ROOM_TYPES, UPGRADES } from './data/acts.js';
import { fmtTime, clamp, rint, pick, isCoarsePointer } from './utils.js';
import { getImg, ready } from './core/assets.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SCREENS = ['title', 'hub', 'select', 'reward', 'next', 'shop', 'rest', 'event', 'pause', 'result', 'codex', 'upgrades', 'settings', 'help'];
const OVERLAY = new Set(['reward', 'next', 'shop', 'rest', 'event', 'pause']);
const BG_FOR = {
  title: SCENES.title, hub: SCENES.hub, select: SCENES.select,
  codex: SCENES.hub, upgrades: SCENES.hub,
};
const ACT_BG = [SCENES.act1, SCENES.act2, SCENES.act3];

export const UI = {
  h: {},
  selectedTeam: [],
  rosterMode: false,
  selectedChar: null,
  filter: 'all',
  currentChoices: null,
  currentScreen: null,
  returnScreen: 'title',
  hudBuilt: false,
  boonCount: -1,
  lastCallout: null,
  lastUlt: null,
  lastBanner: null,
  bossKey: null,

  init(handlers) {
    this.h = handlers;
    document.body.classList.add('menu-mode');
    this._bindActions();
    this._bindSettings();
    this._bindHud();
    this._bindDialogue();
    this._bindCardKeys();
    this._bindFilters();
    this._makeAmbientDust();
    this._buildDynamicLayers();
    this.refreshMeta();
    const s = Save.settings;
    this.syncSettings();
    FX.lowfx = !!s.lowfx;
    G.showDamage = s.damage !== false;
    G.showShake = s.shake !== false;
    this.setTouchVisible(this.touchDesired());
  },

  // 触屏层是否应该显示：手动开启，或触屏设备上未明确关闭（与 run.js / main.js 共用同一口径）
  touchDesired() {
    const s = Save.settings;
    return s.touch === true || (isCoarsePointer() && !s.touchAutoOff);
  },

  // -------------------------------------------------------------------------
  _bindActions() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      Audio.sfx('ui', { volume: .35 });
      if (a === 'back') { this.h.back && this.h.back(); return; }
      const map = {
        'enter-hub': 'toHub', 'title': 'toTitle', 'hub': 'toHub',
        'open-select': 'openSelect', 'roster': 'openRoster',
        'upgrades': 'openUpgrades', 'codex': 'openCodex',
        'help': 'openHelp', 'settings': 'openSettings',
        'resume': 'resume', 'abandon': 'abandon', 'again': 'again',
      };
      const fn = map[a];
      if (fn && this.h[fn]) this.h[fn]();
    });
    const pause = $('#btn-pause');
    if (pause) pause.addEventListener('click', () => this.h.pause && this.h.pause());
  },

  _bindHud() {
    // 演员卡点击换演
    $('#hud-team').addEventListener('click', (e) => {
      const card = e.target.closest('.actor-card');
      if (!card) return;
      const idx = +card.dataset.slot;
      if (this.h.switchTo) this.h.switchTo(idx);
    });
  },

  _bindDialogue() {
    const lines = [
      '观众席已经空了。不过没关系，只要还有人愿意上台，幕就可以再拉开一次。',
      '今晚的节目单是空白的。空白不是遗憾，是留给你们写的位置。',
      '灯油还够。别担心，我会一直在侧幕看着。',
      '如果累了，就回后台。掌声不会跑掉的。',
      '有人说故事早就结束了。可你看，星星还在往这边落。',
    ];
    let idx = 0;
    const next = $('#hub-dialogue-next');
    if (next) next.addEventListener('click', () => {
      idx = (idx + 1) % lines.length;
      const t = $('#hub-dialogue-text');
      if (t) { t.style.opacity = 0; setTimeout(() => { t.textContent = lines[idx]; t.style.opacity = 1; }, 140); }
      Audio.sfx('hover');
    });
    const nextBtn = $('#btn-begin-run');
    if (nextBtn) nextBtn.addEventListener('click', () => {
      if (nextBtn.disabled) return;
      Audio.sfx('ui');
      if (this.h.beginRun) this.h.beginRun(this.selectedTeam.slice());
    });
  },

  _bindFilters() {
    const f = $('#cast-filter');
    if (!f) return;
    f.addEventListener('click', (e) => {
      const b = e.target.closest('.chip-btn');
      if (!b) return;
      this.filter = b.dataset.filter;
      Audio.sfx('ui', { volume: .3 });
      this.buildSelect();
    });
  },

  _bindCardKeys() {
    window.addEventListener('keydown', (e) => {
      if (G.mode === 'reward' && /^[1-6]$/.test(e.key)) {
        const cards = $$('#reward-cards .boon-card');
        const card = cards[+e.key - 1];
        if (card) { e.preventDefault(); card.click(); }
      } else if (G.mode === 'next' && /^[1-3]$/.test(e.key)) {
        const cards = $$('#next-rooms .poster');
        const card = cards[+e.key - 1];
        if (card) { e.preventDefault(); card.click(); }
      }
    });
  },

  _bindSettings() {
    const s = Save.settings;
    const bindRange = (id, key, valId) => {
      const inp = $('#' + id);
      if (!inp) return;
      inp.addEventListener('input', () => {
        const v = +inp.value;
        if (valId) $('#' + valId).textContent = v;
        inp.style.setProperty('--fill', v + '%');
        Save.setSetting(key, v / 100);
        if (key === 'music') Audio.setMusicVolume(v / 100);
        if (key === 'sfx') Audio.setSfxVolume(v / 100);
      });
    };
    bindRange('set-music', 'music', 'set-music-val');
    bindRange('set-sfx', 'sfx', 'set-sfx-val');
    const bindCheck = (id, key, fn) => {
      const inp = $('#' + id);
      if (!inp) return;
      inp.addEventListener('change', () => {
        Save.setSetting(key, inp.checked);
        if (fn) fn(inp.checked);
      });
    };
    bindCheck('set-shake', 'shake', (v) => { G.showShake = v; });
    bindCheck('set-damage', 'damage', (v) => { G.showDamage = v; });
    bindCheck('set-touch', 'touch', (v) => {
      // 触屏设备上手动关闭后不再自动弹出；重新勾选则恢复
      Save.setSetting('touchAutoOff', !v && isCoarsePointer());
      this.setTouchVisible(this.touchDesired());
    });
    bindCheck('set-lowfx', 'lowfx', (v) => { FX.lowfx = v; });
    const reset = $('#btn-reset-save');
    if (reset) reset.addEventListener('click', () => {
      if (window.confirm('确定要清空所有存档吗？掌声、解锁与图鉴都会消失。')) {
        Save.reset();
        this.refreshMeta();
        this.toast('存档已清空');
      }
    });
  },

  syncSettings() {
    const s = Save.settings;
    const setRange = (id, key, valId) => {
      const inp = $('#' + id);
      if (!inp) return;
      const v = Math.round((s[key] ?? 0) * 100);
      inp.value = v;
      inp.style.setProperty('--fill', v + '%');
      if (valId) $('#' + valId).textContent = v;
    };
    setRange('set-music', 'music', 'set-music-val');
    setRange('set-sfx', 'sfx', 'set-sfx-val');
    for (const [id, key] of [['set-shake', 'shake'], ['set-damage', 'damage'], ['set-touch', 'touch'], ['set-lowfx', 'lowfx']]) {
      const inp = $('#' + id);
      if (inp) inp.checked = !!s[key];
    }
  },

  refreshMeta() {
    const d = Save.data;
    const t = $('#title-best'); if (t) t.textContent = d.best;
    const tr = $('#title-runs'); if (tr) tr.textContent = d.runs;
    const a = $('#hub-applause'); if (a) a.textContent = d.applause;
    const b = $('#hub-best'); if (b) b.textContent = d.best;
    const sa = $('#select-applause'); if (sa) sa.textContent = d.applause;
    const ua = $('#upgrade-applause'); if (ua) ua.textContent = d.applause;
    const sh = $('#shop-shards'); if (sh) sh.textContent = G.run ? G.run.shards : 0;
  },

  _makeAmbientDust() {
    const box = $('#menu-dust');
    if (!box) return;
    for (let i = 0; i < 28; i++) {
      const s = el('i');
      s.style.left = Math.random() * 100 + '%';
      s.style.top = 30 + Math.random() * 70 + '%';
      s.style.animationDuration = 7 + Math.random() * 9 + 's';
      s.style.animationDelay = -Math.random() * 12 + 's';
      s.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
      s.style.opacity = .3 + Math.random() * .5;
      s.style.width = s.style.height = (1 + Math.random() * 2) + 'px';
      box.appendChild(s);
    }
  },

  _buildDynamicLayers() {
    const stage = $('#stage');
    // 大横幅
    this.bannerEl = el('div', 'stage-banner');
    this.bannerEl.innerHTML = '<span class="sb-kicker"></span><b class="sb-name"></b><em class="sb-sub"></em>';
    stage.appendChild(this.bannerEl);
    // 谢幕切入
    this.ultEl = el('div', 'ult-cutin');
    this.ultEl.innerHTML = `
      <div class="uc-bars"></div>
      <div class="uc-figure"><img alt=""></div>
      <div class="uc-copy"><span class="uc-en"></span><b class="uc-name"></b><em class="uc-ult"></em></div>
      <div class="uc-sweep"></div>`;
    stage.appendChild(this.ultEl);
    // Boss 登场
    this.bossIntroEl = el('div', 'boss-intro');
    this.bossIntroEl.innerHTML = '<span class="bi-kicker">FINAL BOSS</span><b class="bi-name"></b><em class="bi-title"></em><p class="bi-quote"></p>';
    stage.appendChild(this.bossIntroEl);
  },

  // -------------------------------------------------------------------------
  setMenuBg(src) {
    const wrap = $('#menu-bg');
    const img = $('#menu-bg-img');
    if (!wrap || !img) return;
    if (src) {
      img.style.backgroundImage = `url("${src}")`;
      wrap.style.opacity = '1';
      document.body.classList.add('menu-mode');
    } else {
      wrap.style.opacity = '0';
      document.body.classList.remove('menu-mode');
    }
  },

  setHudVisible(v) {
    const hud = $('#hud');
    if (hud) hud.classList.toggle('hidden', !v);
    document.body.classList.toggle('play-mode', !!v);
  },
  hideHud() { this.setHudVisible(false); },

  setTouchVisible(v) {
    const t = $('#touch');
    if (t) t.classList.toggle('hidden', !v);
    document.body.classList.toggle('touch-mode', !!v);
  },

  showScreen(name) {
    if (!SCREENS.includes(name)) return;
    const target = $('#screen-' + name);
    if (!target) return;
    for (const s of SCREENS) {
      const node = $('#screen-' + s);
      if (!node) continue;
      if (s === name) {
        node.classList.remove('hidden');
        requestAnimationFrame(() => node.classList.add('show'));
      } else {
        node.classList.remove('show');
        node.classList.add('hidden');
      }
    }
    this.currentScreen = name;
    this.setTouchVisible(false);
    const keepGame = OVERLAY.has(name) || (G.run && !G.run.finished && (name === 'settings' || name === 'help'));
    if (name === 'result') {
      this.setMenuBg(null);
    } else if (keepGame) {
      this.setMenuBg(null);
    } else if (BG_FOR[name]) {
      this.setMenuBg(BG_FOR[name]);
    }
    if (name !== 'pause') this.hidePauseHud(true);
  },

  hideAllScreens() {
    for (const s of SCREENS) {
      const node = $('#screen-' + s);
      if (!node) continue;
      node.classList.remove('show');
      node.classList.add('hidden');
    }
    this.currentScreen = null;
  },

  hidePauseHud() {},

  curtainTransition(fn) {
    const c = $('#curtain');
    if (!c) { fn && fn(); return; }
    if (this._transitioning) return;
    this._transitioning = true;
    c.classList.add('active');
    requestAnimationFrame(() => c.classList.add('closed'));
    Audio.sfx('door', { volume: .5 });
    setTimeout(() => {
      try { fn && fn(); } catch (e) { console.error(e); }
      setTimeout(() => {
        c.classList.remove('closed');
        Audio.sfx('door', { volume: .35 });
        setTimeout(() => { c.classList.remove('active'); this._transitioning = false; }, 800);
      }, 160);
    }, 800);
  },

  // =========================================================================
  // 标题 / 后台 / 选角
  // =========================================================================
  showTitle() {
    this.refreshMeta();
    this.setMenuBg(SCENES.title);
    this.showScreen('title');
    this.hideHud();
    this.setTouchVisible(false);
    this.setHudVisible(false);
    Audio.playMusic('bgm_Prologue_0.mp3', { fade: 1.6 });
  },

  showHub() {
    this.refreshMeta();
    this.setMenuBg(SCENES.hub);
    this.showScreen('hub');
    this.setHudVisible(false);
    this.setTouchVisible(false);
    Audio.playMusic('bgm_town_1_0.mp3', { fade: 1.4 });
  },

  showSelect(rosterMode = false) {
    this.rosterMode = !!rosterMode;
    this.refreshMeta();
    this.setMenuBg(SCENES.select);
    this.showScreen('select');
    this.setHudVisible(false);
    this.setTouchVisible(false);
    const title = $('#screen-select h2');
    if (title) title.textContent = rosterMode ? '演员休息室' : '今夜，谁来共演？';
    if (!this.selectedTeam.length) {
      this.selectedTeam = ['kirara', 'lamp', 'kanna'];
    }
    this.selectedTeam = this.selectedTeam.filter((id) => Save.isUnlocked(id));
    if (this.selectedTeam.length < 3) {
      const pool = CHARACTERS.filter((c) => Save.isUnlocked(c.id) && !this.selectedTeam.includes(c.id));
      while (this.selectedTeam.length < 3 && pool.length) this.selectedTeam.push(pool.shift().id);
    }
    if (!this.selectedChar || !Save.isUnlocked(this.selectedChar)) this.selectedChar = this.selectedTeam[0] || 'kirara';
    this.buildSelect();
    Audio.playMusic('bgm_questselect_0.mp3', { fade: 1.2 });
  },

  buildSelect() {
    const self = this;
    const roster = $('#roster-grid');
    const slots = $('#team-slots');
    const filter = $('#cast-filter');
    if (filter) {
      $$('.chip-btn', filter).forEach((b) => b.classList.toggle('active', b.dataset.filter === self.filter));
    }
    roster.innerHTML = '';
    const chars = CHARACTERS.filter((c) => self.filter === 'all' || c.cls === self.filter);
    for (const c of chars) {
      const unlocked = Save.isUnlocked(c.id);
      const selected = self.selectedTeam.includes(c.id);
      const card = el('button', 'roster-card' + (selected ? ' selected' : '') + (unlocked ? '' : ' locked'));
      card.type = 'button';
      card.innerHTML = `
        <img src="${c.stand}" alt="">
        <span class="rc-el" style="color:${EL[c.element].color}">${EL[c.element].name}</span>
        <span class="rc-name">${esc(c.name)}</span>
        <span class="rc-cls">${esc(c.title.split('的')[0] || '')}</span>
        ${unlocked ? '' : `<span class="rc-lock">解锁 · <b>${c.unlock}</b> 掌声</span>`}`;
      card.addEventListener('click', () => {
        Audio.sfx('ui');
        if (!unlocked) {
          if (Save.unlockChar(c.id)) {
            self.refreshMeta();
            self.toast(c.name + ' 已加入剧团');
            Audio.sfx('pickup');
            self.buildSelect();
          } else {
            self.toast('需要 ' + c.unlock + ' 掌声');
          }
          return;
        }
        self.selectedChar = c.id;
        const idx = self.selectedTeam.indexOf(c.id);
        if (idx >= 0) {
          if (self.selectedTeam.length > 1) self.selectedTeam.splice(idx, 1);
        } else {
          if (self.selectedTeam.length >= 3) { self.toast('最多三位演员，先移下一位吧'); self.buildSelect(); return; }
          self.selectedTeam.push(c.id);
        }
        self.buildSelect();
      });
      card.addEventListener('mouseenter', () => {
        if (unlocked) { self.selectedChar = c.id; self.fillShowcase(c); }
      });
      roster.appendChild(card);
    }
    // 队伍槽
    slots.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const id = self.selectedTeam[i];
      const slot = el('div', 'team-slot' + (id ? ' filled' : ' empty'));
      slot.innerHTML = `<span class="ts-num">0${i + 1}</span>`;
      if (id) {
        const c = CHAR_MAP[id];
        slot.innerHTML += `<img src="${c.stand}" alt=""><div class="ts-info"><b>${esc(c.name)}</b><span>${EL[c.element].name} · ${esc(c.title)}</span></div><button class="ts-remove" type="button" aria-label="移除">×</button>`;
        slot.querySelector('.ts-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          if (self.selectedTeam.length <= 1) return;
          self.selectedTeam.splice(i, 1);
          self.buildSelect();
          Audio.sfx('ui');
        });
        slot.addEventListener('click', () => { self.selectedChar = id; self.fillShowcase(c); self.buildSelect(); });
      } else {
        slot.innerHTML += `<span>待定</span>`;
      }
      slots.appendChild(slot);
    }
    const begin = $('#btn-begin-run');
    if (begin) begin.disabled = this.selectedTeam.length !== 3;
    if (self.selectedChar) self.fillShowcase(CHAR_MAP[self.selectedChar]);
    const hint = $('.select-hint');
    if (hint) hint.innerHTML = self.rosterMode
      ? '这里是演员休息室。查看台词与技能，也可以直接以当前阵容开演。'
      : '选择 <b>3</b> 位演员。战斗中可按 <kbd>Shift</kbd> 换演，切换时的登场技会附加属性。';
  },

  _short(text, n = 38) {
    if (!text) return '';
    return text.length > n ? text.slice(0, n) + '…' : text;
  },

  fillShowcase(c) {
    if (!c) return;
    const setSrc = (id, v) => { const n = $('#' + id); if (n) n.textContent = v; };
    const stand = $('#select-stand');
    if (stand) { stand.src = c.stand; stand.alt = c.name; }
    setSrc('select-en', c.en);
    setSrc('select-name', c.name);
    setSrc('select-title', c.title);
    setSrc('select-quote', '“' + c.quote + '”');
    const elBox = $('#select-elements');
    if (elBox) {
      elBox.innerHTML = `<span class="cur-glyph" style="color:${EL[c.element].color};border:1px solid currentColor;border-radius:50%;width:1.5cqw;height:1.5cqw;display:grid;place-items:center">${EL[c.element].name}</span>`;
    }
    const meta = $('#select-meta');
    if (meta) {
      meta.innerHTML = [
        `生命 ${c.hp}`, `攻击 ${c.atk}`, `速度 ${c.speed}`, `${EL[c.element].name}属性`,
      ].map((s) => `<span>${s}</span>`).join('');
    }
    const detail = $('#select-detail');
    if (detail) {
      const stat = [];
      for (const b of this.selectedTeam.map((id) => CHAR_MAP[id])) if (b && b.id !== c.id) stat.push(b);
      detail.innerHTML = `
        <div class="sd-kit">
          <article><small>普攻 · ${c.combo.length} 段</small><b>${c.combo.length > 3 ? '疾风连斩' : '三段连击'}</b><p>${c.combo[0].kind === 'shot' ? '远程攻击，可在移动中持续输出。' : '近战攻击，最后一段会击退敌人。'}</p></article>
          <article><small>特技 · K</small><b>${esc(c.skill.name)}</b><p>${esc(this._short(c.skill.desc, 40))}</p></article>
          <article><small>谢幕 · Q</small><b>${esc(c.ult.name)}</b><p>${esc(this._short(c.ult.desc, 40))}</p></article>
        </div>
        <div class="sd-trait"><small>旅途特质</small><b>${esc(c.trait.name)}</b><p>${esc(this._short(c.trait.desc, 40))}</p></div>`;
    }
    // 高亮当前卡
    $$('#roster-grid .roster-card').forEach((n, i) => {
      const ch = CHARACTERS.filter((x) => this.filter === 'all' || x.cls === this.filter)[i];
      if (ch) n.classList.toggle('selected', this.selectedTeam.includes(ch.id));
    });
  },

  // =========================================================================
  // HUD
  // =========================================================================
  buildHUD() {
    const run = G.run;
    if (!run) return;
    const team = $('#hud-team');
    team.innerHTML = '';
    run.team.forEach((m, i) => {
      const c = CHAR_MAP[m.id];
      const card = el('div', 'actor-card');
      card.dataset.slot = i;
      card.innerHTML = `
        <div class="ac-portrait"><img src="${c.stand}" alt=""><span class="ac-el" style="color:${EL[c.element].color}">${EL[c.element].name}</span><div class="ac-cd"><b>0</b></div></div>
        <div class="ac-body">
          <div class="ac-top"><span class="ac-name">${esc(c.name)}</span><span class="ac-key">${i + 1}</span></div>
          <div class="ac-hp"><div class="ac-hp-ghost"></div><div class="ac-hp-fill"></div></div>
          <div class="ac-sub"><span>HP</span><b>0 / 0</b></div>
          <div class="ac-ult"><i></i></div>
        </div>`;
      team.appendChild(card);
    });
    this.hudBuilt = true;
    this.boonCount = -1;
    this.bossKey = null;
  },

  setRoomPips(act, stage) {
    const key = act + '-' + stage;
    if (this._pipKey === key) return;
    this._pipKey = key;
    const box = $('#hud-room-pips');
    if (!box) return;
    box.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const p = el('i', i === 4 ? 'boss' : '');
      if (i <= stage) p.classList.add('on');
      box.appendChild(p);
    }
    const no = $('#hud-act-no'), name = $('#hud-act-name');
    const a = ACTS[act] || ACTS[0];
    if (no) no.textContent = a.no;
    if (name) name.textContent = a.name;
  },
  updateRoomInfo() {
    if (G.run) this.setRoomPips(G.run.act, G.run.stage);
  },

  showBossBar(boss) {
    const bar = $('#boss-bar');
    if (!bar) return;
    bar.classList.remove('hidden', 'phase-2', 'phase-3');
    $('#boss-title').textContent = boss.name;
    $('#boss-sub').textContent = boss.en;
    this.bossKey = boss.id;
    // 依据 bossDef.phases 动态生成阶段刻度（换 Boss 时重建）
    const track = bar.querySelector('.boss-track');
    if (track) {
      track.querySelectorAll('.boss-tick').forEach((n) => n.remove());
      const phases = (boss.bossDef && boss.bossDef.phases) || [];
      this._bossTicks = phases.map((ratio) => {
        const t = el('i', 'boss-tick');
        t.style.left = (clamp(ratio, 0, 1) * 100) + '%';
        track.appendChild(t);
        return t;
      });
    }
    this.updateBossBar(boss);
  },
  hideBossBar() {
    const bar = $('#boss-bar');
    if (bar) bar.classList.add('hidden');
    this.bossKey = null;
    this._bossTicks = null;
  },
  updateBossBar(boss) {
    if (!boss) boss = G.boss;
    if (!boss) return;
    const fill = $('#boss-fill'), ghost = $('#boss-ghost');
    const k = clamp(boss.hp / boss.maxHp, 0, 1);
    if (fill) fill.style.transform = `scaleX(${k})`;
    if (ghost) ghost.style.transform = `scaleX(${k})`;
    const bar = $('#boss-bar');
    if (bar) {
      bar.classList.toggle('phase-2', boss.phase === 1);
      bar.classList.toggle('phase-3', boss.phase >= 2);
      $('#boss-sub').textContent = boss.en + ' · PHASE ' + (boss.phase + 1);
      // 已越过的阶段刻度转为暗凹口
      const ticks = this._bossTicks || [];
      ticks.forEach((t, i) => t && t.classList.toggle('passed', boss.phase >= i + 1));
    }
  },

  showBossIntro(def) {
    if (!def) return;
    const b = this.bossIntroEl;
    if (!b) return;
    b.querySelector('.bi-name').textContent = def.name;
    b.querySelector('.bi-title').textContent = def.title;
    b.querySelector('.bi-quote').textContent = def.intro || '';
    b.querySelector('.bi-kicker').textContent = 'FINAL BOSS · ' + def.en;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    setTimeout(() => b.classList.remove('show'), 2800);
  },

  updateHUD(dt) {
    if (!G.run || !G.player) return;
    if (!this.hudBuilt) this.buildHUD();
    const run = G.run;
    if (run.team.some((m, i) => !$(`.actor-card[data-slot="${i}"]`))) this.buildHUD();
    const cards = $$('#hud-team .actor-card');
    run.team.forEach((m, i) => {
      const card = cards[i];
      if (!card) return;
      const c = CHAR_MAP[m.id];
      card.classList.toggle('active', i === run.active);
      card.classList.toggle('down', !!m.downed);
      const hpFill = card.querySelector('.ac-hp-fill');
      const hpGhost = card.querySelector('.ac-hp-ghost');
      const hpK = clamp(m.hp / m.maxHp, 0, 1);
      if (hpFill) hpFill.style.transform = `scaleX(${hpK})`;
      if (hpGhost) hpGhost.style.transform = `scaleX(${hpK})`;
      const sub = card.querySelector('.ac-sub b');
      if (sub) sub.textContent = `${Math.ceil(m.hp)} / ${m.maxHp}`;
      const cd = card.querySelector('.ac-cd');
      const cdV = c.skill.cd * (1 - (run.stats.cdr || 0)) * (c.id === 'claire' ? .85 : 1);
      const cdK = clamp((m.skillCd || 0) / Math.max(.01, cdV), 0, 1);
      if (cd) {
        cd.style.width = (cdK * 100) + '%';
        card.classList.toggle('cooling', cdK > 0.01);
        const b = cd.querySelector('b');
        if (b) b.textContent = (m.skillCd || 0).toFixed(1);
      }
      const ult = card.querySelector('.ac-ult i');
      if (ult) ult.style.width = clamp(m.ult || 0, 0, 100) + '%';
      card.classList.toggle('ult-ready', (m.ult || 0) >= 100 && !m.downed && i === run.active);
    });
    // 喝彩
    const rank = RANKS[G.style.rank] || RANKS[0];
    const rk = $('#hud-rank');
    if (rk) rk.textContent = rank.key.toUpperCase();
    // 变档瞬间给 rank 一个弹跳（配合 hud.css .rank.pop）
    if (this._lastRankKey !== rank.key) {
      this._lastRankKey = rank.key;
      if (rk) { rk.classList.remove('pop'); void rk.offsetWidth; rk.classList.add('pop'); }
    }
    const rn = $('#hud-rank-name');
    if (rn) rn.textContent = rank.name;
    const wrap = $('#style-wrap');
    if (wrap) {
      wrap.classList.remove('rank-d', 'rank-c', 'rank-b', 'rank-a', 'rank-s', 'rank-ss', 'rank-sss');
      wrap.classList.add('rank-' + rank.key);
    }
    const combo = $('#hud-combo');
    if (combo) {
      const c = G.style.combo;
      combo.classList.toggle('on', c > 1);
      const b = combo.querySelector('b');
      if (b) b.textContent = c;
    }
    const fill = $('#hud-style-fill');
    if (fill) fill.style.width = clamp(G.style.value / RANK_MAX, 0, 1) * 100 + '%';
    const shards = $('#hud-shards');
    if (shards) shards.textContent = run.shards;
    // room pips
    this.setRoomPips(run.act, run.stage);
    // boons
    if (this.boonCount !== run.boons.length) {
      this.boonCount = run.boons.length;
      this.buildBoonStrip();
    }
    // boss
    if (G.boss) this.updateBossBar(G.boss);
    // callout
    if (G.reactionCallout) {
      if (this.lastCallout !== G.reactionCallout) {
        this.lastCallout = G.reactionCallout;
        this.showReaction(G.reactionCallout);
      }
    }
    // ult cutin
    if (G.ultCutin) {
      if (this.lastUlt !== G.ultCutin) {
        this.lastUlt = G.ultCutin;
        this.showUltCutin(G.ultCutin);
      }
    }
    // banner
    if (G.banner) {
      if (this.lastBanner !== G.banner) {
        this.lastBanner = G.banner;
        this.showBanner(G.banner);
      }
    } else if (this.lastBanner) {
      this.lastBanner = null;
    }
  },

  buildBoonStrip() {
    const box = $('#hud-boons');
    if (!box || !G.run) return;
    box.innerHTML = '';
    const list = G.run.boons.slice(-14);
    for (const b of list) {
      const n = el('div', 'boon-pip');
      n.dataset.name = b.name;
      n.innerHTML = `<img src="${b.art}" alt="">`;
      box.appendChild(n);
    }
    if (G.run.boons.length > list.length) {
      const more = el('div', 'boon-pip more');
      more.textContent = '+' + (G.run.boons.length - list.length);
      box.appendChild(more);
    }
  },

  showReaction(c) {
    const n = $('#reaction-callout');
    if (!n) return;
    n.textContent = c.name;
    n.style.color = c.color;
    n.style.textShadow = `0 0 .5cqw ${c.color}, 0 .2cqw 1.4cqw rgba(0,0,0,.8)`;
    n.classList.remove('pop');
    void n.offsetWidth;
    n.classList.add('pop');
    Audio.sfx('reaction');
  },

  showBanner(b) {
    const n = this.bannerEl;
    if (!n) return;
    n.style.setProperty('--banner-color', b.color || COL.gold);
    n.querySelector('.sb-kicker').textContent = b.sub || '';
    n.querySelector('.sb-name').textContent = b.name || '';
    n.querySelector('.sb-sub').textContent = b.type === 'switch' ? 'CAST CHANGE' : b.type === 'ult' ? 'FINALE' : b.type === 'phase' ? 'PHASE SHIFT' : '';
    n.classList.remove('show');
    void n.offsetWidth;
    n.classList.add('show', 'type-' + (b.type || 'room'));
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => n.classList.remove('show'), (b.dur || 1.6) * 1000);
  },

  showUltCutin(c) {
    const n = this.ultEl;
    if (!n) return;
    const ch = CHARACTERS.find((x) => x.name === c.name);
    const img = n.querySelector('.uc-figure img');
    if (img && ch) { img.src = ch.stand; img.alt = ch.name; }
    n.querySelector('.uc-en').textContent = c.en;
    n.querySelector('.uc-name').textContent = c.name;
    n.querySelector('.uc-ult').textContent = c.title;
    n.style.setProperty('--cut-color', c.color);
    n.classList.remove('show');
    void n.offsetWidth;
    n.classList.add('show');
    clearTimeout(this._ultTimer);
    this._ultTimer = setTimeout(() => n.classList.remove('show'), 1800);
  },

  setShards(v) {
    const s = $('#shop-shards');
    if (s) s.textContent = v;
    const h = $('#hud-shards');
    if (h) h.textContent = v;
  },

  toast(msg) {
    const t = $('#global-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  },

  flashBoon(boon) {
    const box = $('#global-toast');
    if (!box) return;
    box.innerHTML = `<b>${esc(boon.owner)}</b> · ${esc(boon.name)} 加入节目单`;
    box.classList.add('show');
    clearTimeout(this._gtTimer);
    this._gtTimer = setTimeout(() => box.classList.remove('show'), 2600);
  },

  // =========================================================================
  // 奖励 / 下一场
  // =========================================================================
  showReward(cards, source, onPick) {
    const box = $('#reward-cards');
    const sub = $('#reward-sub');
    box.innerHTML = '';
    if (sub) {
      sub.textContent = source === 'elite'
        ? '加演的余韵里，多了一位愿意留下的共演者。'
        : '掌声惊醒了某段沉睡的记忆。选择一位共演者，加入今晚的节目单。';
    }
    for (const b of cards) {
      const card = el('button', 'boon-card');
      card.type = 'button';
      const cat = CATS[b.cat];
      card.innerHTML = `
        <div class="bc-art"><img src="${b.art}" alt=""><span class="bc-rarity">${'★'.repeat(b.rarity)}</span><span class="bc-el" style="color:${cat.color}">${cat.glyph}</span></div>
        <div class="bc-body">
          <span class="bc-owner">共演者 · ${esc(b.owner)}</span>
          <div class="bc-name">${esc(b.name)}</div>
          <div class="bc-title">${esc(b.title)}</div>
          <div class="bc-desc">${esc(b.desc)}</div>
          <div class="bc-tags"><span>${cat.name}</span><span>${RARITY[b.rarity].name}</span></div>
        </div>
        <span class="bc-pick">点击入席</span>`;
      card.addEventListener('click', () => {
        if (card.dataset.locked) return;
        card.dataset.locked = '1';
        Audio.sfx('pickup');
        onPick(b);
      });
      box.appendChild(card);
    }
    const skip = $('#reward-skip');
    if (skip) skip.onclick = () => { Audio.sfx('ui'); onPick(null); };
    this.showScreen('reward');
    Audio.sfx('door', { volume: .4 });
  },

  showNext(options, onChoose) {
    const box = $('#next-rooms');
    box.innerHTML = '';
    for (const opt of options) {
      const card = el('button', 'poster kind-' + opt.type);
      card.type = 'button';
      card.innerHTML = `
        <span class="pst-kicker">${opt.stage >= 4 ? 'FINALE' : 'STAGE ' + (opt.stage + 1)} · ${esc(ACTS[opt.act]?.en.split('·')[0] || '')}</span>
        <span class="pst-icon">${opt.icon}</span>
        <h3>${esc(opt.name)}</h3>
        <p>${esc(opt.desc)}</p>
        <div class="pst-reward">${opt.rewards.map((r) => `<span>${esc(r)}</span>`).join('')}</div>
        <span class="pst-go">→</span>`;
      card.addEventListener('click', () => { Audio.sfx('ui'); onChoose(opt); });
      box.appendChild(card);
    }
    this.showScreen('next');
  },

  // =========================================================================
  // 商店 / 休息 / 事件
  // =========================================================================
  showShop(items, run, handlers) {
    const box = $('#shop-items');
    if (!box) return;
    box.innerHTML = '';
    items.forEach((item, idx) => {
      const poor = run.shards < item.price;
      const node = el('button', 'shop-item' + (item.kind === 'boon' ? '' : ' service') + (item.sold ? ' sold' : '') + (poor ? ' poor' : ''));
      node.type = 'button';
      if (item.kind === 'boon') {
        const b = item.boon;
        const cat = CATS[b.cat];
        node.innerHTML = `
          <div class="si-art"><img src="${b.art}" alt=""></div>
          <span class="si-kind">共演者 · ${esc(b.owner)}</span>
          <h4>${esc(b.name)}</h4>
          <p>${esc(b.desc)}</p>
          <div class="si-foot"><span class="si-buy">点击购买</span><span class="si-price"><img src="../../asset/img/rl/drop/coin.webp" alt="">${item.price}</span></div>`;
      } else {
        node.innerHTML = `
          <div class="si-art">${item.icon || '✦'}</div>
          <span class="si-kind">补给 · SUPPLY</span>
          <h4>${esc(item.name)}</h4>
          <p>${esc(item.desc)}</p>
          <div class="si-foot"><span class="si-buy">点击购买</span><span class="si-price"><img src="../../asset/img/rl/drop/coin.webp" alt="">${item.price}</span></div>`;
      }
      node.addEventListener('click', () => {
        Audio.sfx('ui');
        handlers.buy(item, idx);
      });
      box.appendChild(node);
    });
    const sh = $('#shop-shards');
    if (sh) sh.textContent = run.shards;
    const reroll = $('#shop-reroll');
    if (reroll) {
      reroll.onclick = () => { Audio.sfx('ui'); handlers.reroll(); };
      reroll.innerHTML = `换一批 <b>${Math.max(6, Math.round(16 * (1 - (run.stats.rerollDiscount || 0))))}</b> 星屑`;
    }
    const leave = $('#shop-leave');
    if (leave) leave.onclick = () => { Audio.sfx('ui'); handlers.leave(); };
    this.showScreen('shop');
  },

  showRest(cards, onPick) {
    const box = $('#rest-choices');
    box.innerHTML = '';
    for (const c of cards) {
      const node = el('button', 'rest-card');
      node.type = 'button';
      node.innerHTML = `<span class="rc-icon">${c.icon}</span><h3>${esc(c.title)}</h3><p>${esc(c.desc)}</p><span class="rc-tag">${esc(c.tag)}</span>`;
      node.addEventListener('click', () => { Audio.sfx('ui'); onPick(c); });
      box.appendChild(node);
    }
    this.showScreen('rest');
  },

  showEvent(ev, run, onChoose) {
    const portrait = $('#event-portrait');
    if (portrait) portrait.innerHTML = `<span>${ev.portrait || '?'}</span>`;
    $('#event-title').textContent = ev.title;
    $('#event-text').textContent = ev.text;
    const box = $('#event-choices');
    box.innerHTML = '';
    for (const opt of ev.options) {
      const cost = opt.effect?.cost;
      const poor = cost && run.shards < cost;
      const node = el('button', 'event-choice' + (poor ? ' poor' : ''));
      node.type = 'button';
      node.innerHTML = `<b>${esc(opt.label)}</b><span>${esc(opt.hint)}</span>${cost ? `<em class="ec-cost">${poor ? '星屑不足' : '消耗 ' + cost + ' 星屑'}</em>` : ''}`;
      node.addEventListener('click', () => {
        if (poor) { this.toast('星屑不够'); return; }
        Audio.sfx('ui');
        onChoose(opt);
      });
      box.appendChild(node);
    }
    this.showScreen('event');
  },

  // =========================================================================
  // 暂停 / 结算
  // =========================================================================
  showPause(run) {
    const team = $('#pause-team');
    if (team) {
      team.innerHTML = run.team.map((m) => {
        const c = CHAR_MAP[m.id];
        return `<div class="pause-actor"><img src="${c.stand}" alt=""><span class="pa-name">${esc(c.name)}${m.downed ? ' · 退场' : ''}</span><span class="pa-hp"><i style="width:${clamp(m.hp / m.maxHp, 0, 1) * 100}%"></i></span><span class="pa-hp-num">${Math.ceil(m.hp)}/${m.maxHp}</span></div>`;
      }).join('');
    }
    const boons = $('#pause-boons');
    if (boons) {
      boons.innerHTML = run.boons.length ? run.boons.map((b) => `<div class="pause-boon"><img src="${b.art}" alt=""><span>${esc(b.name)}</span></div>`).join('') : '<p style="font-size:.6cqw;color:rgba(235,222,200,.35)">还没有共演者加入。</p>';
    }
    // 纯触屏玩家看不到键盘说明，换成触屏操作提示
    const pauseScreen = $('#screen-pause');
    if (pauseScreen) pauseScreen.classList.toggle('touch-ui', this.touchDesired());
    this.showScreen('pause');
  },

  showResult(result) {
    const set = (id, v) => { const n = $('#' + id); if (n) n.textContent = v; };
    set('result-kicker', result.kicker);
    set('result-title', result.title);
    const quote = $('#result-quote'); if (quote) quote.textContent = '“' + result.quote + '”';
    const stats = $('#result-stats');
    if (stats) {
      const rows = [
        ['演出场次', result.rooms],
        ['击破敌人', result.kills],
        ['幕终主角', result.bosses],
        ['最高喝彩', RANKS[rankFor(result.style)]?.name || '静场'],
        ['最长连击', result.maxCombo || 0],
        ['演出时长', fmtTime(result.time)],
      ];
      stats.innerHTML = rows.map(([k, v]) => `<div class="result-stat"><span>${k}</span><b>${v}</b></div>`).join('');
    }
    set('result-applause', '+' + result.gained);
    const un = $('#result-unlocks');
    if (un) un.innerHTML = result.newBest ? '<span>✦ 新的掌声纪录</span>' : '';
    const stand = $('#result-stand');
    if (stand) {
      const c = CHAR_MAP[result.lead];
      if (c) { stand.src = c.stand; stand.alt = c.name; }
    }
    this.showScreen('result');
    this.refreshMeta();
  },

  // =========================================================================
  // 图鉴 / 强化 / 设置 / 帮助
  // =========================================================================
  showCodex() {
    this.refreshMeta();
    this.setMenuBg(SCENES.hub);
    this.showScreen('codex');
    this.setHudVisible(false);
    const list = $('#codex-list');
    list.innerHTML = '';
    this.codexSelected = this.codexSelected || 'kirara';
    for (const c of CHARACTERS) {
      const unlocked = Save.isUnlocked(c.id);
      const node = el('button', 'codex-card' + (unlocked ? '' : ' locked') + (this.codexSelected === c.id ? ' active' : ''));
      node.type = 'button';
      node.innerHTML = `<img src="${c.stand}" alt=""><span>${unlocked ? esc(c.name) : '？？？'}</span>`;
      node.addEventListener('click', () => { this.codexSelected = c.id; this.showCodex(); Audio.sfx('ui'); });
      list.appendChild(node);
    }
    this.fillCodex();
  },

  fillCodex() {
    const c = CHAR_MAP[this.codexSelected] || CHARACTERS[0];
    const unlocked = Save.isUnlocked(c.id);
    const detail = $('#codex-detail');
    if (!detail) return;
    detail.innerHTML = `
      <div class="codex-art"><img src="${c.stand}" alt=""></div>
      <div class="codex-text">
        <span class="cx-en">${c.en} · ${EL[c.element].en}</span>
        <h3>${unlocked ? esc(c.name) : '未解锁的演员'}</h3>
        <div class="cx-role">${esc(c.title)} · ${esc(c.trait.name)}</div>
        <p class="cx-bio">${unlocked ? esc(c.bio) : '这位演员还在后台等待。积攒掌声，在演员休息室请她登台。'}</p>
        <p class="cx-quote">${unlocked ? '“' + esc(c.quote) + '”' : '“……”'}</p>
        ${unlocked ? '' : `<p class="cx-lock">解锁需要 ${c.unlock} 掌声</p>`}
      </div>`;
  },

  showUpgrades() {
    this.refreshMeta();
    this.setMenuBg(SCENES.hub);
    this.showScreen('upgrades');
    this.setHudVisible(false);
    const grid = $('#upgrade-grid');
    grid.innerHTML = '';
    const meta = Save.data;
    for (const u of UPGRADES) {
      const lv = Save.upgradeLevel(u.id);
      const cost = Save.upgradeCost(u.id);
      const maxed = lv >= u.max;
      const poor = !maxed && meta.applause < cost;
      const node = el('div', 'upgrade-card' + (maxed ? ' maxed' : '') + (poor ? ' poor' : ''));
      node.innerHTML = `
        <span class="uc-icon">${u.icon}</span>
        <div class="uc-head"><h3>${esc(u.name)}</h3><span class="uc-lv">LV ${lv} / ${u.max}</span></div>
        <p>${esc(u.desc(lv))}<br><span style="opacity:.5">${esc(u.per)}</span></p>
        <div class="uc-pips">${Array.from({ length: u.max }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('')}</div>
        <div class="uc-buy"><span>${maxed ? '已完成' : '升级'}</span><b>${maxed ? 'MAX' : cost + ' ✦'}</b></div>`;
      if (!maxed) {
        node.style.cursor = 'pointer';
        node.addEventListener('click', () => {
          if (Save.buyUpgrade(u.id)) {
            Audio.sfx('pickup');
            this.toast(u.name + ' 提升至 LV ' + (lv + 1));
            this.showUpgrades();
          } else {
            Audio.sfx('ui');
            this.toast('掌声不够');
          }
        });
      }
      grid.appendChild(node);
    }
    const ua = $('#upgrade-applause');
    if (ua) ua.textContent = Save.data.applause;
  },

  showSettings() {
    this.syncSettings();
    this.showScreen('settings');
  },
  showHelp() {
    this.showScreen('help');
  },
};

// 初始化后暴露
window.__ui = UI;
