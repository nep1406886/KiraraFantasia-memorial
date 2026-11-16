// DOM shell: title, roster, HUD, and the modal overlays. The simulation never
// touches the DOM directly; this module owns every element id and text.

import {
  CHARACTERS, CLASSES, ELEMENTS, BOON_RARITY, EQUIPMENT_ICON_BASE,
  FACE_BASE, CARD_BASE, META_UPGRADES, STORY, TIPS
} from "./config.js";

const $ = id => document.getElementById(id);

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class UI {
  constructor(actions, audio) {
    this.actions = actions;
    this.audio = audio;
    this.selected = 0;
    this.overlayOpen = false;
    this.overlayKind = "";
    this.overlayCanClose = false;
    this.typeTimer = 0;
    this.typeDone = true;
    this.storyState = null;
    this.lastHp = -1;
    this.lastHpMax = -1;
    this.lastShield = -1;
    this.lastDust = -1;
    this.lastUlt = -1;
    this.lastSkill = -1;
    this.lastDash = -1;
    this.toastTimer = 0;
    this.waveTimer = 0;
    this.bossVisible = false;

    this.screens = {
      title: $("screen-title"),
      select: $("screen-select"),
      hud: $("hud")
    };
    this.overlay = $("overlay");
    this.touch = $("touch-controls");
    this.fade = $("fade");
    this.pageTurn = $("page-turn");
    this.loading = $("loading");
    this.loadingText = $("loading-text");
    this.loadingBar = $("loading-bar");
    this.rotateHint = $("rotate-hint");

    document.querySelectorAll("[data-action]").forEach(button => {
      button.addEventListener("click", () => {
        this.audio?.sfx("click");
        const action = button.dataset.action;
        if (action === "start") this.actions.startPressed();
        else if (action === "continue") this.actions.continuePressed();
        else if (action === "starmap") this.actions.openStarMap();
        else if (action === "help") this.actions.openHelp();
        else if (action === "settings") this.actions.openSettings();
        else if (action === "back-title") this.actions.backToTitle();
        else if (action === "begin-run") this.actions.beginRun(this.selected);
        else if (action === "pause") this.actions.pause();
        else if (action === "boons") this.actions.openBoonList();
      });
    });

    this.bindGlobalKeys();
    this.rosterBuilt = false;
  }

  bindGlobalKeys() {
    document.addEventListener("keydown", event => {
      if (!this.overlayOpen) return;
      if (event.code === "Escape" && this.overlayCanClose) {
        event.preventDefault();
        this.actions.overlayClose?.();
        return;
      }
      if (this.overlayKind === "story") {
        if (event.code === "Space" || event.code === "Enter") {
          event.preventDefault();
          this.storyAdvance();
        }
        return;
      }
      if (event.code === "Escape" && this.overlayKind === "boons-view") {
        event.preventDefault();
        this.actions.overlayClose?.();
        return;
      }
      if (/^Digit[1-4]$/.test(event.code)) {
        const button = this.overlay.querySelector('[data-hotkey="' + event.code.slice(-1) + '"]');
        if (button) { event.preventDefault(); button.click(); }
      }
    });
  }

  // ---------------------------------------------------------------- screens
  showTitle({ continueAvailable = false, starlight = 0 } = {}) {
    this.hideAllScreens();
    this.screens.title.classList.remove("hidden");
    const cont = this.screens.title.querySelector('[data-action="continue"]');
    if (cont) cont.classList.toggle("hidden", !continueAvailable);
    const pill = this.screens.title.querySelector(".title-starlight");
    if (pill) pill.textContent = starlight;
    this.overlayOpen = false;
    this.overlay.classList.add("hidden");
  }

  hideAllScreens() {
    Object.values(this.screens).forEach(screen => screen.classList.add("hidden"));
    this.overlay.classList.add("hidden");
    this.overlayOpen = false;
  }

  showSelect(save) {
    this.hideAllScreens();
    this.screens.select.classList.remove("hidden");
    $("select-starlight").textContent = save.meta.starlight;
    this.buildRoster(save);
    this.updateSelect(this.selected, save);
  }

  buildRoster(save) {
    const strip = $("roster-strip");
    if (this.rosterBuilt) {
      strip.querySelectorAll(".roster-chip").forEach((chip, index) => {
        chip.setAttribute("aria-selected", index === this.selected ? "true" : "false");
      });
      return;
    }
    strip.innerHTML = "";
    CHARACTERS.forEach((char, index) => {
      const button = document.createElement("button");
      button.className = "roster-chip";
      button.type = "button";
      button.role = "option";
      button.dataset.index = index;
      button.setAttribute("aria-selected", index === this.selected ? "true" : "false");
      button.innerHTML = '<img src="' + CARD_BASE + char.cardId + '.webp" alt="" loading="lazy"><b>' + escapeHtml(char.name) + "</b>";
      button.addEventListener("click", () => {
        this.audio?.sfx("click");
        this.selected = index;
        strip.querySelectorAll(".roster-chip").forEach((chip, i) => chip.setAttribute("aria-selected", i === index ? "true" : "false"));
        this.updateSelect(index, save);
      });
      strip.appendChild(button);
    });
    this.rosterBuilt = true;
  }

  updateSelect(index, save) {
    const char = CHARACTERS[index];
    if (!char) return;
    this.selected = index;
    const element = ELEMENTS[char.element];
    const cls = CLASSES[char.classId];
    $("select-art").src = CARD_BASE + char.cardId + ".webp";
    $("select-name").textContent = char.name;
    $("select-work").textContent = char.cardName && char.cardName !== char.name ? char.work + " · " + char.cardName.replace(char.name, "").replace(/[【】]/g, "") : char.work;
    $("select-class").textContent = cls.zh;
    $("select-class-icon").textContent = cls.glyph;
    $("select-class-badge").style.setProperty("--element", element.color);
    $("select-quote").textContent = char.quote;
    $("select-skill-name").textContent = char.skill.name;
    $("select-skill-desc").textContent = char.skill.desc;
    $("select-skill-seal").textContent = char.skill.glyph;
    $("select-ult-name").textContent = char.ult.name;
    $("select-ult-desc").textContent = char.ult.desc;
    $("select-ult-seal").textContent = char.ult.glyph;
    $("select-trait").textContent = char.trait;
    const meta = save ? save.meta : null;
    const bonuses = [];
    if (meta) {
      const lv = id => meta.upgrades[id] || 0;
      if (lv("vitality")) bonuses.push("生命 +" + lv("vitality") * 16);
      if (lv("edge")) bonuses.push("攻击 +" + lv("edge") * 7 + "%");
      if (lv("stride")) bonuses.push("疾行 +" + lv("stride"));
      if (lv("fortune")) bonuses.push("开局星屑 +" + lv("fortune") * 25);
      if (lv("ember")) bonuses.push("复起 ×" + lv("ember"));
    }
    $("select-meta").innerHTML = bonuses.length
      ? "星图加成 · <b>" + bonuses.join(" · ") + "</b>"
      : "星图尚未点亮 · 漫游结束后可以用星辉强化下一次旅途";

    const stats = [
      { label: "生命", value: char.hp, max: 160, suffix: "", bar: char.hp / 160 },
      { label: "攻击", value: Math.round(char.atk * 100), max: 140, suffix: "%", bar: char.atk / 1.4 },
      { label: "速度", value: char.speed, max: 300, suffix: "", bar: char.speed / 300 }
    ];
    $("select-stats").innerHTML = stats.map(stat =>
      '<div class="stat-cell"><header><span>' + stat.label + "</span><div><b>" + stat.value + "</b><small>" + stat.suffix + "</small></div></header>" +
      '<div class="stat-bar"><i style="width:' + Math.round(stat.bar * 100) + '%"></i></div></div>'
    ).join("");
    document.querySelectorAll(".roster-chip").forEach((chip, i) => chip.setAttribute("aria-selected", i === index ? "true" : "false"));
  }

  // ---------------------------------------------------------------- HUD
  showHud(char) {
    this.hideAllScreens();
    this.screens.hud.classList.remove("hidden");
    this.screens.hud.style.opacity = "1";
    $("hud-icon").src = FACE_BASE + char.cardId + ".webp";
    $("hud-name").textContent = char.name;
    const element = ELEMENTS[char.element];
    const pip = $("hud-element");
    pip.style.background = element.color;
    pip.textContent = element.mark;
    $("slot-skill-glyph").textContent = char.skill.glyph;
    $("slot-skill-label").textContent = char.skill.name.slice(0, 2);
    $("hud-boon-count").textContent = "星愿 0";
    $("hud-boon-badge").textContent = "0";
    this.lastHp = -1;
    this.lastHpMax = -1;
    this.lastShield = -1;
    this.lastDust = -1;
    this.lastUlt = -1;
    this.lastSkill = -1;
    this.lastDash = -1;
    $("boss-bar").classList.add("hidden");
    $("interact-prompt").classList.add("hidden");
    this.bossVisible = false;
    $("hud-hint").classList.remove("hidden");
  }

  hideHud() {
    this.screens.hud.classList.add("hidden");
  }

  setHp(hp, maxHp, shield = 0) {
    hp = Math.max(0, Math.round(hp));
    maxHp = Math.max(1, Math.round(maxHp));
    if (hp !== this.lastHp || maxHp !== this.lastHpMax) {
      const pct = Math.max(0, Math.min(1, hp / maxHp));
      $("hud-hp-fill").style.transform = "scaleX(" + pct + ")";
      $("hud-hp-ghost").style.transform = "scaleX(" + pct + ")";
      $("hud-hp-fill").classList.toggle("low", pct <= 0.3);
      $("hud-hp-text").textContent = hp + " / " + maxHp;
      this.lastHp = hp;
      this.lastHpMax = maxHp;
    }
    if (shield !== this.lastShield) {
      this.lastShield = shield;
      const chip = $("hud-shield");
      chip.classList.toggle("hidden", shield <= 0);
      chip.querySelector("b").textContent = Math.max(0, Math.round(shield));
    }
  }

  setDust(dust) {
    dust = Math.max(0, Math.round(dust));
    if (dust === this.lastDust) return;
    this.lastDust = dust;
    $("hud-dust").textContent = dust;
  }

  setBoons(count) {
    $("hud-boon-count").textContent = "星愿 " + count;
    $("hud-boon-badge").textContent = count;
  }

  setRevive(count) {
    const node = $("hud-revive");
    node.classList.toggle("hidden", count <= 0);
    node.textContent = "复起 ×" + count;
  }

  setAct(actLabel, roomLabel, rooms, currentIndex) {
    $("hud-act-label").textContent = actLabel;
    $("hud-room-label").textContent = roomLabel;
    const container = $("hud-room-pips");
    if (container.dataset.signature !== actLabel + rooms.join(",")) {
      container.dataset.signature = actLabel + rooms.join(",");
      container.innerHTML = rooms.map((type, i) =>
        '<i class="' + (type === "boss" ? "boss" : "") + (i < currentIndex ? " done" : i === currentIndex ? " current" : "") + '"></i>'
      ).join("");
    } else {
      [...container.children].forEach((pip, i) => {
        pip.classList.toggle("done", i < currentIndex);
        pip.classList.toggle("current", i === currentIndex);
      });
    }
  }

  setSkillCooldown(remaining, total) {
    const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    const rounded = Math.round(ratio * 100) / 100;
    if (rounded === this.lastSkill) return;
    this.lastSkill = rounded;
    $("slot-skill-cd").style.setProperty("--cd", rounded + "turn");
    $("slot-skill-cd-text").textContent = remaining > 0.1 ? Math.ceil(remaining) : "";
    $("slot-skill").classList.toggle("ready", remaining <= 0);
  }

  setDashCooldown(remaining, total) {
    const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    const rounded = Math.round(ratio * 100) / 100;
    if (rounded === this.lastDash) return;
    this.lastDash = rounded;
    $("slot-dash-cd").style.setProperty("--cd", rounded + "turn");
    $("slot-dash").classList.toggle("ready", remaining <= 0);
  }

  setUlt(value) {
    const pct = Math.max(0, Math.min(100, Math.round(value)));
    if (pct === this.lastUlt) return;
    this.lastUlt = pct;
    $("slot-ult-fill").style.setProperty("--ult", pct + "%");
    $("slot-ult-pct").textContent = pct + "%";
    $("slot-ult").classList.toggle("ready", pct >= 100);
  }

  setBoss(name, title, hp, maxHp, phase) {
    const bar = $("boss-bar");
    bar.classList.remove("hidden");
    $("boss-name").textContent = name;
    $("boss-phase").textContent = title + (phase > 1 ? " · 第二阶段" : "");
    const pct = Math.max(0, Math.min(1, hp / maxHp));
    $("boss-hp-fill").style.transform = "scaleX(" + pct + ")";
    $("boss-hp-ghost").style.transform = "scaleX(" + pct + ")";
    $("boss-hp-text").textContent = Math.max(0, Math.ceil(hp)) + " / " + Math.ceil(maxHp);
    this.bossVisible = true;
  }

  hideBoss() {
    $("boss-bar").classList.add("hidden");
    this.bossVisible = false;
  }

  waveBanner(big, small, duration = 1700) {
    const banner = $("wave-banner");
    banner.querySelector("b").textContent = big;
    banner.querySelector("span").textContent = small || "";
    banner.classList.remove("hidden");
    banner.style.animation = "none";
    void banner.offsetWidth;
    banner.style.animation = "";
    clearTimeout(this.waveTimer);
    this.waveTimer = setTimeout(() => banner.classList.add("hidden"), duration);
  }

  interact(text, sub = "") {
    const prompt = $("interact-prompt");
    prompt.classList.remove("hidden");
    prompt.querySelector("b").textContent = text;
    prompt.querySelector("small").textContent = sub;
  }

  hideInteract() {
    $("interact-prompt").classList.add("hidden");
  }

  toast(text, duration = 2000) {
    const node = $("hud-toast");
    node.textContent = text;
    node.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => node.classList.remove("show"), duration);
  }

  setHintVisible(visible) {
    $("hud-hint").classList.toggle("hidden", !visible);
  }

  setTouchVisible(visible) {
    this.touch.classList.toggle("hidden", !visible);
  }

  // ---------------------------------------------------------------- loading
  setLoading(visible, text = "正在翻开这一页…", progress = null) {
    this.loading.classList.toggle("hidden", !visible);
    if (text) this.loadingText.textContent = text;
    if (progress != null) this.loadingBar.style.width = Math.max(2, Math.min(100, progress * 100)) + "%";
  }

  setLoadingProgress(progress) {
    this.loadingBar.style.width = Math.max(2, Math.min(100, progress * 100)) + "%";
  }

  async turnPage() {
    this.pageTurn.classList.remove("turn");
    void this.pageTurn.offsetWidth;
    this.pageTurn.classList.add("turn");
    this.audio?.sfx("page");
    await new Promise(resolve => setTimeout(resolve, 700));
    this.pageTurn.classList.remove("turn");
  }

  showRotateHint() {
    this.rotateHint.classList.remove("hidden");
    setTimeout(() => this.rotateHint.classList.add("hidden"), 5200);
  }

  // ---------------------------------------------------------------- overlays
  openOverlay(html, kind, { canClose = false, focus = null } = {}) {
    this.overlay.innerHTML = html;
    this.overlay.classList.remove("hidden");
    this.overlayOpen = true;
    this.overlayKind = kind;
    this.overlayCanClose = canClose;
    const target = focus ? this.overlay.querySelector(focus) : this.overlay.querySelector("button, input");
    setTimeout(() => target?.focus?.(), 30);
  }

  closeOverlay() {
    this.overlay.innerHTML = "";
    this.overlay.classList.add("hidden");
    this.overlayOpen = false;
    this.overlayKind = "";
    this.overlayCanClose = false;
    this.storyState = null;
    clearInterval(this.typeTimer);
  }

  showBoonChoices(choices, owned, { onPick, onSkip }) {
    const cards = choices.map((choice, index) => {
      const boon = choice.def;
      const rarity = BOON_RARITY[boon.rarity] || BOON_RARITY[0];
      const level = owned[boon.id] || 0;
      return '<button class="boon-card" type="button" data-hotkey="' + (index + 1) + '" data-boon="' + index + '" style="--tint:' + boon.tint + ';--rarity:' + rarity.color + '">' +
        '<span class="boon-rarity"><i>✦</i>' + rarity.name + "</span>" +
        (level > 0 ? '<span class="boon-level">已有 ' + level + "</span>" : "") +
        '<span class="boon-medallion"><img src="' + EQUIPMENT_ICON_BASE + boon.icon + '.svg" alt=""></span>' +
        "<h3>" + escapeHtml(boon.name) + "</h3>" +
        "<p>" + escapeHtml(boon.desc) + "</p>" +
        '<span class="boon-flavor">' + escapeHtml(boon.flavor) + "</span>" +
        "</button>";
    }).join("");
    const html = '<section class="paper-panel boon-panel" aria-label="选择星愿">' +
      '<header class="panel-head"><div><p class="eyebrow">A WISH FROM THE STARLIGHT</p><h2>拾起一颗星愿</h2><p>选一枚带走。星愿可以叠加，也可以成为下一段故事的伏笔。</p></div></header>' +
      '<div class="boon-grid">' + cards + "</div>" +
      '<p class="boon-pick-hint">按 <span>1</span> <span>2</span> <span>3</span> 或点击卡牌选择</p>' +
      '<div class="panel-actions"><button class="menu-button small" type="button" data-skip="1">跳过 · 获得 15 星屑</button></div>' +
      "</section>";
    this.openOverlay(html, "boon", { focus: ".boon-card" });
    this.overlay.querySelectorAll("[data-boon]").forEach(button => {
      button.addEventListener("click", () => {
        this.audio?.sfx("card");
        onPick(Number(button.dataset.boon));
      });
    });
    this.overlay.querySelector("[data-skip]").addEventListener("click", () => {
      this.audio?.sfx("coin");
      onSkip?.();
    });
  }

  showBoonList(owned, defs, { onClose }) {
    const entries = Object.entries(owned).filter(([, level]) => level > 0);
    const rows = entries.length ? entries.map(([id, level]) => {
      const boon = defs.find(b => b.id === id) || { name: id, desc: "", icon: "gadget-prism", tint: "#eee" };
      return '<div class="boon-row"><span class="boon-medallion" style="background:' + boon.tint + '"><img src="' + EQUIPMENT_ICON_BASE + boon.icon + '.svg" alt=""></span>' +
        "<div><b>" + escapeHtml(boon.name) + "</b><p>" + escapeHtml(boon.desc) + "</p></div><span>×" + level + "</span></div>";
    }).join("") : '<p class="empty-note">还没有拾起星愿。打完第一页，星星就会落下来。</p>';
    const html = '<section class="paper-panel" aria-label="星愿一览"><header class="panel-head"><div><p class="eyebrow">COLLECTED WISHES</p><h2>星愿一览</h2><p>这一路捡到的祝福，会安静地待在书页里。</p></div><button class="panel-close" type="button" data-close aria-label="关闭">×</button></header>' +
      '<div class="boon-list">' + rows + "</div>" +
      '<div class="panel-actions"><button class="menu-button small" type="button" data-close>合上这一页</button></div></section>';
    this.openOverlay(html, "boons-view", { canClose: true, focus: "[data-close]" });
    this.actions.overlayClose = onClose;
    this.overlay.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => onClose()));
  }

  showPause({ actLabel, roomLabel, character, onResume, onBoons, onSettings, onHelp, onAbandon }) {
    const html = '<section class="paper-panel pause-panel" aria-label="暂停"><header class="panel-head"><div><p class="eyebrow">A PAUSE BETWEEN PAGES</p><h2>先歇一会儿</h2><p>' + escapeHtml(actLabel) + " · " + escapeHtml(roomLabel) + " · " + escapeHtml(character.name) + "</p></div></header>" +
      '<div class="pause-grid">' +
      '<button class="menu-button primary" type="button" data-pause="resume">继续漫游</button>' +
      '<button class="menu-button small" type="button" data-pause="boons">星愿一览</button>' +
      '<button class="menu-button small" type="button" data-pause="settings">声音与显示</button>' +
      '<button class="menu-button small" type="button" data-pause="help">玩法与按键</button>' +
      '<button class="menu-button small" type="button" data-pause="abandon">放弃本局</button>' +
      '<button class="menu-button small" type="button" data-pause="resume">回到书页</button>' +
      "</div></section>";
    this.openOverlay(html, "pause", { canClose: true, focus: '[data-pause="resume"]' });
    this.overlay.querySelectorAll("[data-pause]").forEach(button => {
      button.addEventListener("click", () => {
        this.audio?.sfx("click");
        const action = button.dataset.pause;
        if (action === "resume") onResume();
        else if (action === "boons") onBoons();
        else if (action === "settings") onSettings();
        else if (action === "help") onHelp();
        else if (action === "abandon") onAbandon();
      });
    });
    this.actions.overlayClose = onResume;
  }

  showSettings(settings, { onBgm, onSfx, onReduced, onClose, onReset }) {
    const html = '<section class="paper-panel pause-panel" aria-label="设置"><header class="panel-head"><div><p class="eyebrow">SOUND &amp; MOTION</p><h2>声音与显示</h2><p>改动会立刻生效，也会留在下一次翻开时。</p></div><button class="panel-close" type="button" data-close aria-label="关闭">×</button></header>' +
      '<div class="settings-row"><label for="set-bgm">背景音乐</label><input id="set-bgm" type="range" min="0" max="100" value="' + Math.round(settings.bgm * 100) + '"><output id="set-bgm-out">' + Math.round(settings.bgm * 100) + "%</output></div>" +
      '<div class="settings-row"><label for="set-sfx">音效</label><input id="set-sfx" type="range" min="0" max="100" value="' + Math.round(settings.sfx * 100) + '"><output id="set-sfx-out">' + Math.round(settings.sfx * 100) + "%</output></div>" +
      '<div class="settings-row"><label>减少动态</label><label class="toggle"><input id="set-reduced" type="checkbox" ' + (settings.reducedMotion ? "checked" : "") + '> 关闭大部分动画</label><span></span></div>' +
      '<div class="panel-actions"><button class="menu-button small" type="button" data-reset>清除漫游记录</button><button class="menu-button small" type="button" data-close>完成</button></div>' +
      '<p class="help-note">说明：本作会记住星图、设置与房间边界的漫游进度；清空记录不会影响站点其他功能。</p>' +
      "</section>";
    this.openOverlay(html, "settings", { canClose: true, focus: "#set-bgm" });
    this.actions.overlayClose = onClose;
    const bgm = $("set-bgm");
    const sfx = $("set-sfx");
    const bgmOut = $("set-bgm-out");
    const sfxOut = $("set-sfx-out");
    bgm.addEventListener("input", () => { bgmOut.textContent = bgm.value + "%"; onBgm(Number(bgm.value) / 100); });
    sfx.addEventListener("input", () => { sfxOut.textContent = sfx.value + "%"; onSfx(Number(sfx.value) / 100); this.audio?.sfx("click"); });
    $("set-reduced").addEventListener("change", event => onReduced(event.target.checked));
    this.overlay.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => onClose()));
    let confirming = false;
    this.overlay.querySelector("[data-reset]").addEventListener("click", event => {
      if (!confirming) {
        confirming = true;
        event.target.textContent = "再点一次确认清除";
        setTimeout(() => { confirming = false; event.target.textContent = "清除漫游记录"; }, 2600);
        return;
      }
      onReset();
    });
  }

  showHelp({ onClose }) {
    const controls = [
      ["A / D", "左右移动", "也可以使用 ← →。"],
      ["空格 / W", "跳跃", "长按跳得更高；部分同伴可二段跳。"],
      ["J / Z", "攻击", "连续按出三段连击，第三段最重。"],
      ["K / X", "特技", "每位同伴的专属招式，有冷却。"],
      ["L / C", "闪身", "短距离冲刺，有无敌帧。"],
      ["Q", "星坠", "充能满后释放的必杀技。"],
      ["E / ↓", "交互", "开门、休息、在星灯小铺购买。"],
      ["Esc / P", "暂停", "也可以打开星愿一览与设置。"]
    ];
    const html = '<section class="paper-panel" aria-label="玩法说明"><header class="panel-head"><div><p class="eyebrow">HOW TO WALK THIS STORY</p><h2>玩法与按键</h2><p>横版动作 · 星愿构筑 · 三卷漫游</p></div><button class="panel-close" type="button" data-close aria-label="关闭">×</button></header>' +
      '<div class="help-grid">' + controls.map(([key, title, desc]) => '<div class="help-item"><span class="keycap">' + key + "</span><div><b>" + title + "</b><p>" + desc + "</p></div></div>").join("") + "</div>" +
      '<p class="help-note"><b>星愿</b>：每清空一页可以从三枚星愿里选一枚，效果会叠加。<b>星坠</b>：攻击与击败敌人会积攒星愿槽，满后按 Q 释放。<b>属性</b>：水克炎、炎克风、风克土、土克水，月与日互相克制。受伤后有一小段无敌时间，善用闪身穿过弹幕。</p>' +
      '<div class="panel-actions"><button class="menu-button small" type="button" data-close>知道了</button></div></section>';
    this.openOverlay(html, "help", { canClose: true, focus: "[data-close]" });
    this.actions.overlayClose = onClose;
    this.overlay.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => onClose()));
  }

  showStarMap(save, { onBuy, onClose }) {
    this.starMapSave = save;
    this.starMapCallbacks = { onBuy, onClose };
    const positions = {
      vitality: [15, 56],
      edge: [32, 24],
      stride: [50, 62],
      fortune: [68, 22],
      ember: [85, 54]
    };
    const order = ["vitality", "edge", "stride", "fortune", "ember"];
    const points = order.map(id => positions[id].join(",")).join(" ");
    const nodes = META_UPGRADES.map(def => {
      const level = save.meta.upgrades[def.id] || 0;
      const max = level >= def.max;
      const cost = max ? null : def.costs[level];
      const p = positions[def.id];
      const pips = Array.from({ length: def.max }, (_, i) => '<i class="' + (i < level ? "on" : "") + '"></i>').join("");
      return '<button class="starmap-node' + (max ? " max" : "") + '" type="button" data-upgrade="' + def.id + '" style="left:' + p[0] + "%;top:" + p[1] + '%">' +
        '<span class="node-glyph">' + def.glyph + "</span><b>" + def.name + "</b><small>" + def.desc + "</small>" +
        '<span class="node-level">' + pips + "</span>" +
        '<span class="node-cost">' + (max ? "已点亮" : "✦ " + cost) + "</span></button>";
    }).join("");
    const best = save.meta.best;
    const bestText = best ? (best.win ? "已走完三卷 · " + (best.character || "") : "最远抵达 第" + (best.act + 1) + "卷 第" + (best.room + 1) + "页") : "还没有留下足迹";
    const html = '<section class="paper-panel starmap-panel" aria-label="星图"><header class="panel-head"><div><p class="eyebrow">CONSTELLATION OF MEMORIES</p><h2>星图</h2><p>星辉会留在这里，点亮下一段旅途。</p></div><div class="starmap-head-right"><span>✧</span><b id="starmap-total">' + save.meta.starlight + "</b><small>星辉</small></div></header>" +
      '<div class="starmap-canvas"><svg class="starmap-svg" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="' + points + '" fill="none" stroke="rgba(255,224,170,0.22)" stroke-width="0.4" stroke-dasharray="1.6 1.4"/></svg>' + nodes + "</div>" +
      '<p class="help-note" style="color:rgba(247,236,217,.54);background:rgba(255,244,222,.06)">最佳记录：' + escapeHtml(bestText) + " · 漫游 " + save.meta.runs + " 次 · 完成 " + save.meta.wins + " 次</p>" +
      '<div class="panel-actions"><span>每完成一页与击败守卷人都会获得星辉</span><button class="menu-button small" type="button" data-close>返回</button></div></section>';
    this.openOverlay(html, "starmap", { canClose: true, focus: "[data-upgrade]" });
    this.actions.overlayClose = onClose;
    this.overlay.querySelectorAll("[data-upgrade]").forEach(button => {
      button.addEventListener("click", () => onBuy(button.dataset.upgrade));
    });
    this.overlay.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => onClose()));
  }

  refreshStarMap(save) {
    if (!this.overlayOpen || this.overlayKind !== "starmap") return;
    const currentNode = document.activeElement?.dataset?.upgrade;
    this.showStarMap(save, this.starMapCallbacks || { onBuy: () => {}, onClose: () => {} });
    if (currentNode) this.overlay.querySelector('[data-upgrade="' + currentNode + '"]')?.focus();
  }

  showStory(pages, onDone, onSkip) {
    this.storyState = { pages, index: 0, onDone, onSkip };
    this.renderStory();
  }

  renderStory() {
    const state = this.storyState;
    if (!state) return;
    const page = state.pages[state.index];
    this.overlayOpen = true;
    this.overlayKind = "story";
    this.overlayCanClose = false;
    this.overlay.innerHTML = '<section class="paper-panel story-panel" aria-label="剧情">' +
      '<p class="story-kicker">' + escapeHtml(page.kicker || "") + "</p>" +
      "<h2>" + escapeHtml(page.title || "") + "</h2>" +
      '<p class="story-text" id="story-text"></p>' +
      '<div class="story-nav"><button class="menu-button small" type="button" data-story-next>继续 <span style="opacity:.5">›</span></button><span class="story-page">' + (state.index + 1) + " / " + state.pages.length + "</span></div>" +
      '<button class="ghost-button story-skip" type="button" data-story-skip>跳过剧情</button></section>';
    this.overlay.classList.remove("hidden");
    const textNode = $("story-text");
    textNode.textContent = "";
    textNode.classList.remove("done");
    this.typeDone = false;
    const full = page.text || "";
    let index = 0;
    clearInterval(this.typeTimer);
    this.typeTimer = setInterval(() => {
      index++;
      textNode.textContent = full.slice(0, index);
      if (index >= full.length) {
        clearInterval(this.typeTimer);
        textNode.classList.add("done");
        this.typeDone = true;
      }
    }, 24);
    this.overlay.querySelector("[data-story-next]").addEventListener("click", () => this.storyAdvance());
    this.overlay.querySelector("[data-story-skip]").addEventListener("click", () => {
      clearInterval(this.typeTimer);
      this.closeOverlay();
      state.onSkip?.();
    });
  }

  storyAdvance() {
    const state = this.storyState;
    if (!state) return;
    const textNode = $("story-text");
    if (!this.typeDone) {
      clearInterval(this.typeTimer);
      textNode.textContent = state.pages[state.index].text || "";
      textNode.classList.add("done");
      this.typeDone = true;
      return;
    }
    state.index++;
    if (state.index >= state.pages.length) {
      this.closeOverlay();
      state.onDone?.();
      return;
    }
    this.renderStory();
  }

  showResult(result) {
    const { win, character, act, room, kills, time, starlight, best, onAgain, onTitle, onStarmap } = result;
    const title = win ? STORY.win.title : STORY.lose.title;
    const text = win ? STORY.win.text : STORY.lose.text;
    const html = '<section class="paper-panel result-panel ' + (win ? "win" : "") + '" aria-label="结算">' +
      '<div class="result-seal">' + (win ? "✧" : "❋") + "</div>" +
      "<h2>" + escapeHtml(title) + "</h2>" +
      '<p class="result-sub">' + escapeHtml(character.name) + " · " + (win ? "三卷漫游完成" : "第 " + (act + 1) + " 卷 · 第 " + (room + 1) + " 页") + "</p>" +
      '<div class="result-stats">' +
      '<div class="result-stat"><b>' + kills + "</b><span>击败</span></div>" +
      '<div class="result-stat"><b>' + fmtTime(time) + "</b><span>漫游时间</span></div>" +
      '<div class="result-stat"><b>' + (win ? "3" : act + 1) + "</b><span>抵达卷数</span></div>" +
      '<div class="result-stat"><b>' + (win ? "完成" : "未完") + "</b><span>旅途</span></div>" +
      "</div>" +
      '<div class="result-reward"><span>✧</span> 获得星辉 <b>+' + starlight + "</b></div>" +
      (best ? '<p class="result-unlocks">★ 新的最远记录已写进星图。</p>' : "") +
      '<p class="result-quote">' + escapeHtml(text).replace(/\n/g, "<br>") + "</p>" +
      '<div class="panel-actions" style="justify-content:center">' +
      '<button class="menu-button primary" type="button" data-result="again">再次出发</button>' +
      '<button class="menu-button small" type="button" data-result="starmap">打开星图</button>' +
      '<button class="menu-button small" type="button" data-result="title">回到标题</button>' +
      "</div></section>";
    this.openOverlay(html, "result", { focus: '[data-result="again"]' });
    this.overlay.querySelector('[data-result="again"]').addEventListener("click", onAgain);
    this.overlay.querySelector('[data-result="starmap"]').addEventListener("click", onStarmap);
    this.overlay.querySelector('[data-result="title"]').addEventListener("click", onTitle);
  }

  fadeOut() {
    this.fade.classList.add("show");
  }

  fadeIn() {
    this.fade.classList.remove("show");
  }
}
