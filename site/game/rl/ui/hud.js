// The real HUD (spec/01 §4), replacing the text status line as the player's
// readout: skill icons with cooldown fan masks bottom-left, the gold
// とっておき gauge bottom-right. When the device can touch, the same module
// mounts the touch controls 游玩说明 §二 promises — the skill icons and the
// gauge ARE their buttons, plus a big attack button, a dodge button, a pause
// button, and a floating joystick over the left half of the stage.
//
// Sizing is clamp() everywhere, no breakpoints (the 375/1280-green,
// 390/412/430-broken lesson); every touch target is >= 44x44 (spec/01 §4.2).
//
// Edge semantics: skill/ultimate presses must survive a tap shorter than one
// frame, so press() latches the input flag and lift() only clears it after a
// world step has seen it (pump() runs after world.update in main.js). Attack
// is level-based like the key — held means auto-fire, which is what a held
// button should do.

import { NORMAL_CARD_SOURCE } from "../skillcards.js";
import { skillArt } from "./skillart.js";
import { createSkillTooltip } from "./skilltooltip.js";
import { createAttackAim } from "./attackaim.js";
import { skillSourceLabel } from "./equipmentskills.js";
import { equipmentDetails, equipmentIcon, equipmentName } from "./decisions.js";

const STICK_RADIUS = 56;      // px, the knob's travel; visuals are clamp()-scaled
const STICK_DEADZONE = 0.3;   // of radius

// HUD update shares the simulation cadence, but unchanged readouts should
// not replace text nodes, invalidate styles or restart screen-reader work.
function text(node, value) {
    if (node.textContent !== String(value)) { node.textContent = value; }
}
function attr(node, name, value) {
    if (node.getAttribute(name) !== String(value)) { node.setAttribute(name, value); }
}
function css(node, name, value) {
    if (node.style.getPropertyValue(name) !== value) { node.style.setProperty(name, value); }
}

export function createHud(options) {
    const input = options.input;
    const onMenu = options.onMenu;
    const parent = options.parent || document.body;
    let currentWorld = null, tooltip = null;
    let lastEquipSig = null;    // 装备签名，命中才重建芯片行
    let ultPulse = null;        // 必杀脉冲边沿 prev(ready, ultimate.id)
    // 脉冲一轮的摘除计时器。声明在状态区：挂载早期的 detectTouch() 会先走
    // 一次 clearInput()，clearPulses 必须在那时就已可用（不能等脉冲节）。
    const pulseTimers = new Map();

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    // --- edge latch ---------------------------------------------------------

    const latches = new Map();     // key -> { seen, releasing }

    function setFlag(kind, index, down) {
        if (kind === "skill") {
            input.state.skill[index] = down;
        } else {
            input.state[kind] = down;
        }
    }

    function press(kind, index) {
        setFlag(kind, index, true);
        latches.set(kind + ":" + index, { seen: 0, releasing: false });
    }

    function lift(kind, index) {
        const key = kind + ":" + index;
        const latch = latches.get(key);
        if (!latch || latch.seen >= 1) {
            setFlag(kind, index, false);
            latches.delete(key);
            return;
        }
        latch.releasing = true;    // too fast for a frame: pump() clears it
    }

    function pump() {
        latches.forEach(function (latch, key) {
            latch.seen += 1;
            if (latch.releasing && latch.seen >= 1) {
                const parts = key.split(":");
                setFlag(parts[0], Number(parts[1]), false);
                latches.delete(key);
            }
        });
        attackAim.pump();
    }

    function bindPress(node, kind, index) {
        node.addEventListener("pointerdown", function (event) {
            if (event.button > 0 || node.getAttribute("aria-disabled") === "true") { return; }
            event.preventDefault();
            press(kind, index);
        });
        node.addEventListener("pointerup", function () { lift(kind, index); });
        node.addEventListener("pointercancel", function () { lift(kind, index); });
        node.addEventListener("pointerleave", function () { lift(kind, index); });
        node.addEventListener("keydown", function (event) {
            if (event.key !== "Enter" && event.key !== " ") { return; }
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat && node.getAttribute("aria-disabled") !== "true") { press(kind, index); }
        });
        node.addEventListener("keyup", function (event) {
            if (event.key !== "Enter" && event.key !== " ") { return; }
            event.preventDefault(); event.stopPropagation(); lift(kind, index);
        });
        node.addEventListener("blur", function () { lift(kind, index); });
    }

    // --- skill icons (bottom-left) -------------------------------------------

    const skillbar = el("div", "hud-skillbar hud-hidden");
    const skillEls = [];
    for (let i = 0; i < 3; i++) {
        const btn = el("button", "hud-skill");
        btn.type = "button";
        btn.dataset.slot = String(i);
        const icon = el("span", "hud-skill-icon");
        icon.setAttribute("aria-hidden", "true");
        const key = el("span", "hud-skill-key", String(i + 1));
        key.setAttribute("aria-hidden", "true");
        const name = el("span", "hud-skill-name");
        const origin = el("span", "hud-skill-origin", "改");
        origin.hidden = true; origin.setAttribute("aria-hidden", "true");
        const cd = el("div", "hud-skill-cd");
        const secs = el("span", "hud-skill-secs");
        btn.appendChild(icon);
        btn.appendChild(key);
        btn.appendChild(name);
        btn.appendChild(origin);
        btn.appendChild(cd);
        btn.appendChild(secs);
        bindPress(btn, "skill", i);
        skillbar.appendChild(btn);
        skillEls.push({ btn: btn, icon: icon, name: name, origin: origin, cd: cd, secs: secs });
    }

    // --- とっておき gauge (bottom-right) --------------------------------------

    const gauge = el("button", "hud-gauge hud-hidden");
    gauge.type = "button";
    const gaugeFill = el("div", "hud-gauge-fill");
    const gaugeIcon = el("span", "hud-gauge-icon");
    gaugeIcon.setAttribute("aria-hidden", "true");
    const gaugeCopy = el("span", "hud-gauge-copy");
    const gaugeLabel = el("div", "hud-gauge-label", "R 必杀");
    const gaugeName = el("span", "hud-gauge-name");
    const gaugeReadout = el("span", "hud-gauge-readout");
    gauge.appendChild(gaugeFill);
    gauge.appendChild(gaugeIcon);
    gaugeCopy.appendChild(gaugeLabel);
    gaugeCopy.appendChild(gaugeName);
    gauge.appendChild(gaugeCopy);
    gauge.appendChild(gaugeReadout);
    // 满量四芒星（spec/01 §4.2 每面板至多一处）：inline SVG 描边星形。类名
    // 保持 hud-gauge-star——theme.css 的 reduced-motion 清单与 .ready 点亮
    // 规则都按该类匹配，改名即失配。SVG 用 setAttribute("class")（ESM 严格
    // 模式下给 SVGElement 赋 className 会抛错）；顶点沿用旧 clip-path 的
    // 四芒星轮廓（50/61/39% 折算到 24 视箱），形状不变、实心块换描边。
    const SVG_NS = "http://www.w3.org/2000/svg";
    const gaugeStar = document.createElementNS(SVG_NS, "svg");
    gaugeStar.setAttribute("class", "hud-gauge-star");
    gaugeStar.setAttribute("viewBox", "0 0 24 24");
    gaugeStar.setAttribute("aria-hidden", "true");
    const starFace = document.createElementNS(SVG_NS, "polygon");
    starFace.setAttribute("points",
        "12,0 14.64,9.36 24,12 14.64,14.64 12,24 9.36,14.64 0,12 9.36,9.36");
    gaugeStar.appendChild(starFace);
    gauge.appendChild(gaugeStar);
    bindPress(gauge, "ultimate", 0);

    const hudPanel = parent.querySelector("#hud");
    const identity = el("div", "hud-identity");
    const playerName = el("span", "hud-player-name");
    const playerLevel = el("span", "hud-player-level");
    const portrait = el("img", "hud-player-portrait");
    portrait.alt = "";
    portrait.hidden = true;
    portrait.addEventListener("error", () => { portrait.hidden = true; });
    let portraitId = null;
    identity.append(portrait, playerName, playerLevel);
    if (hudPanel) { hudPanel.prepend(identity); }

    // --- 装备四槽芯片（hud-identity 下，spec/01 §4 左上身份区新增行） ---------
    // 战斗中不进菜单即可查四槽与词条：图标复用 decisions.js 的 equipmentIcon
    // （weapon/<iconId>.webp 与 slot-*.svg 已全覆盖，空槽传合成 {slot} 取槽
    // 图标），详情弹层复用其 equipmentDetails。样式与 grid-area 落点由纸面
    // 壳层条目落在 theme.css（.hud-equip/.hud-equip-chip）。
    const EQUIP_SLOTS = [["weapon", "武器"], ["amulet", "护符"], ["armor", "护甲"], ["charm", "饰品"]];
    const equipRow = el("div", "hud-equip");
    equipRow.hidden = true;
    const equipChips = EQUIP_SLOTS.map(function (pair) {
        const chip = el("button", "hud-equip-chip");
        chip.type = "button";
        chip.dataset.slot = pair[0];
        const icon = el("img", "hud-equip-chip-icon");
        icon.alt = "";
        icon.setAttribute("aria-hidden", "true");
        icon.addEventListener("error", function () { icon.hidden = true; });
        const name = el("span", "hud-equip-chip-name");
        chip.append(icon, name);
        chip.addEventListener("click", function () {
            if (chip.getAttribute("aria-disabled") !== "true") { toggleBrief(pair[0]); }
        });
        equipRow.appendChild(chip);
        return { chip: chip, icon: icon, name: name, slot: pair[0], label: pair[1] };
    });
    if (hudPanel) { identity.after(equipRow); }
    function renderEquipChips(equipment) {
        // 只在装备签名变化时调用。weapons/cards 来自 main.js 注入的
        // equipmentContext（与菜单装备视图同一批表），缺失时 equipmentIcon
        // 退回槽位图标、equipmentName 退回槽名——弹层依然可读。
        const context = typeof options.equipmentContext === "function" ? options.equipmentContext() : {};
        equipChips.forEach(function (view) {
            const item = equipment.find(function (row) { return row.slot === view.slot; }) || null;
            const src = equipmentIcon(item || { slot: view.slot }, context.weapons);
            if (src) {
                if (view.icon.getAttribute("src") !== src) { view.icon.setAttribute("src", src); }
                view.icon.hidden = false;
            } else {
                view.icon.hidden = true;
            }
            const name = item ? equipmentName(item, context.weapons, context.cards) : "未装备";
            view.chip.classList.toggle('equipped', !!item);
            text(view.name, name);
            attr(view.chip, "aria-label", view.label + " · " + name + "（点击查看词条）");
        });
    }

    // 装备简报弹层：纸面壳层与 .hud-skill-tooltip 同一套（theme.css 用
    // 选择器并列共享），但不借用类名——交互门禁把 .hud-skill-tooltip 当作
    // 技能悬停卡的唯一定位器，多一个匹配会触发 Playwright 严格模式冲突。
    // 词条内容全部来自 equipmentDetails。Escape 走 skilltooltip.js 的捕获
    // 阶段 keydown + stopImmediatePropagation 先例——简报只收自己，不开暂停
    // 菜单，也无需在 main.js 加标志位。锁定（死亡/冻结/过场）时随 HUD 一起收起。
    const brief = el("section", "hud-equip-brief");
    brief.id = "hud-equip-brief";
    brief.setAttribute("role", "tooltip");
    brief.hidden = true;
    parent.appendChild(brief);
    let briefSlot = null;
    function briefItem(world, slot) {
        const equipment = world?.player?.equipment;
        return equipment ? equipment.find(function (item) { return item.slot === slot; }) || null : null;
    }
    function renderBrief(item) {
        const context = typeof options.equipmentContext === "function" ? options.equipmentContext() : {};
        const p = currentWorld?.player;
        brief.replaceChildren(equipmentDetails(item, {
            weapons: context.weapons, cards: context.cards,
            skillNames: p?.skills?.slots.map(function (slot) { return slot.name; }),
            skillLoadout: p?.skills?.describeLoadout?.()
        }));
    }
    function placeBrief() {
        if (brief.hidden || !briefSlot) { return; }
        const view = equipChips.find(function (chip) { return chip.slot === briefSlot; });
        if (!view) { return; }
        const bounds = parent.getBoundingClientRect();
        const briefW = brief.offsetWidth, briefH = brief.offsetHeight;
        // 横向仍按锚点芯片对齐，先 clamp 进视口。
        const left = Math.max(12, Math.min(bounds.width - briefW - 12,
            view.chip.getBoundingClientRect().left - bounds.left));
        // 纵向避让锚芯片行 union 矩形（全部芯片 rect 的并集，2×2 折行时
        // 天然覆盖两行）：上候选 = unionTop − briefH − 10、下候选 =
        // unionBottom + 10。候选先收进视口，再与全部芯片矩形求交，取零
        // 相交者（并集锚定下本应零相交，钳位可能压回芯片行）；两个候选
        // 皆相交才取重叠最小者。单芯片锚定的旧法在 2×2 下 below 必压
        // 第二行——求交兜底后简报绝不盖芯片（z-index 200 维持不动）。
        const rects = equipChips.map(function (chip) {
            return chip.chip.getBoundingClientRect();
        });
        const unionTop = Math.min.apply(null, rects.map(function (r) { return r.top; }));
        const unionBottom = Math.max.apply(null, rects.map(function (r) { return r.bottom; }));
        const lo = 12, hi = Math.max(12, bounds.height - briefH - 12);
        const candidates = [
            Math.max(lo, Math.min(hi, unionTop - bounds.top - briefH - 10)),
            Math.max(lo, Math.min(hi, unionBottom - bounds.top + 10))
        ];
        const overlapArea = function (top) {
            const bLeft = bounds.left + left, bRight = bLeft + briefW;
            const bTop = bounds.top + top, bBottom = bTop + briefH;
            return rects.reduce(function (sum, r) {
                const w = Math.min(bRight, r.right) - Math.max(bLeft, r.left);
                const h = Math.min(bBottom, r.bottom) - Math.max(bTop, r.top);
                return sum + (w > 0 && h > 0 ? w * h : 0);
            }, 0);
        };
        // 上候选优先（与旧「能放上面就放上面」的取舍一致）：零相交打平
        // 时保持上候选，只有严格更小才换。
        let top = candidates[0], worst = overlapArea(top);
        for (let i = 1; i < candidates.length; i++) {
            const cost = overlapArea(candidates[i]);
            if (cost < worst) { top = candidates[i]; worst = cost; }
        }
        brief.style.left = left + "px"; brief.style.top = top + "px";
    }
    function closeBrief() {
        if (brief.hidden && briefSlot === null) { return; }
        briefSlot = null;
        brief.hidden = true;
        equipChips.forEach(function (view) { view.chip.removeAttribute("aria-describedby"); });
    }
    function toggleBrief(slot) {
        if (briefSlot === slot) { closeBrief(); return; }
        briefSlot = slot;
        renderBrief(briefItem(currentWorld, slot));
        brief.hidden = false;
        equipChips.forEach(function (view) {
            if (view.slot === slot) { view.chip.setAttribute("aria-describedby", brief.id); }
            else { view.chip.removeAttribute("aria-describedby"); }
        });
        placeBrief();
    }
    function briefEscape(event) {
        if (brief.hidden || event.key !== "Escape") { return; }
        closeBrief();
        event.preventDefault(); event.stopImmediatePropagation();
    }
    document.addEventListener("keydown", briefEscape, true);
    // 战场任意按下即收简报（芯片自身的 toggle 在 pointerdown 之后照常工作）。
    // 简报本体按下也收：静态词条弹层，无划选/复制需求，点它即视为关闭，
    // 被盖住的芯片随之立即可开——有意取舍。
    function briefOutside(event) {
        if (brief.hidden || !(event.target instanceof Node)) { return; }
        if (equipRow.contains(event.target)) { return; }
        closeBrief();
    }
    parent.addEventListener("pointerdown", briefOutside, true);
    window.addEventListener("resize", placeBrief);
    const effects = el("div", "hud-effects");
    effects.setAttribute("aria-label", "战斗状态");
    (parent.querySelector("#hud") || parent).appendChild(effects);
    const assistBtn = el("button", "hud-assist hud-hidden");
    assistBtn.type = "button";
    assistBtn.setAttribute("aria-pressed", "false");
    assistBtn.title = "默认关闭；手动操作优先。仅当前房间内普攻，不代替技能、交互或过门。";
    const assistName = el("span");
    const assistState = el("span", "hud-assist-state");
    assistBtn.append(assistName, assistState);
    bindPress(assistBtn, "assist", 0);
    (parent.querySelector("#hud") || parent).appendChild(assistBtn);

    // --- touch controls --------------------------------------------------------

    const zone = el("div", "touch-zone hud-hidden");
    const stickBase = el("div", "touch-stick hud-hidden");
    const stickKnob = el("div", "touch-knob hud-hidden");
    const attackBtn = el("button", "touch-btn touch-attack hud-hidden", "攻击");
    const dodgeBtn = el("button", "touch-btn touch-dodge hud-hidden", "闪避");
    attackBtn.type = "button"; dodgeBtn.type = "button";
    const interactBtn = el("button", "touch-btn touch-interact hud-hidden", "交互");
    interactBtn.type = "button";
    const pauseBtn = el("button", "touch-btn hud-pause", "菜单");
    pauseBtn.type = "button";
    pauseBtn.appendChild(el("kbd", "hud-menu-key", "Esc"));
    pauseBtn.setAttribute("aria-label", "暂停与菜单（Esc）");
    pauseBtn.setAttribute("aria-controls", "menu-panel");
    // Status text wraps as effects arrive and viewports change. Keep the
    // touch menu below its actual border box, not over a hard-coded line.
    const hudSize = hudPanel && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(function () {
            parent.style.setProperty("--rl-hud-height", hudPanel.getBoundingClientRect().height + "px");
        }) : null;
    if (hudSize) { hudSize.observe(hudPanel); }

    let stickId = null;
    let origin = null;

    function stickAt(clientX, clientY) {
        const rect = parent.getBoundingClientRect();
        stickBase.style.left = (clientX - rect.left) + "px";
        stickBase.style.top = (clientY - rect.top) + "px";
        stickKnob.style.left = (clientX - rect.left) + "px";
        stickKnob.style.top = (clientY - rect.top) + "px";
    }
    function knobTo(dx, dy) {
        // The knob travels with the finger, clamped to the ring; the base
        // stays put. dx/dy come as pointer deltas from the origin.
        const rect = parent.getBoundingClientRect();
        const len = Math.hypot(dx, dy);
        const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
        stickKnob.style.left = (origin.x - rect.left + dx * k) + "px";
        stickKnob.style.top = (origin.y - rect.top + dy * k) + "px";
    }

    zone.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        if (stickId !== null || event.button > 0 || !currentWorld?.player || currentWorld.frozen || currentWorld.transition || currentWorld.player.dead) {
            return;
        }
        stickId = event.pointerId;
        origin = { x: event.clientX, y: event.clientY };
        stickAt(event.clientX, event.clientY);
        [stickBase, stickKnob].forEach(function (n) {
            n.classList.remove("hud-hidden");
        });
        try {
            zone.setPointerCapture(event.pointerId);
        } catch (e) {
            // Pointer capture is a convenience, not a contract; move/up on
            // the zone still fire for touches that stay within it.
        }
    });
    function stickMove(event) {
        if (event.pointerId !== stickId || !origin) {
            return;
        }
        const dx = event.clientX - origin.x;
        const dy = event.clientY - origin.y;
        knobTo(dx, dy);
        const len = Math.hypot(dx, dy);
        if (len < STICK_RADIUS * STICK_DEADZONE) {
            input.state.move.x = 0;
            input.state.move.y = 0;
            return;
        }
        // Analog magnitude, clamped to the ring: the world normalises by
        // length anyway, so this only ever expresses direction.
        const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
        input.state.move.x = (dx * k) / STICK_RADIUS;
        input.state.move.y = (dy * k) / STICK_RADIUS;
    }
    function clearStick() {
        const id = stickId; stickId = null;
        origin = null;
        if (id !== null && zone.hasPointerCapture(id)) { zone.releasePointerCapture(id); }
        input.state.move.x = 0;
        input.state.move.y = 0;
        [stickBase, stickKnob].forEach(function (n) {
            n.classList.add("hud-hidden");
        });
    }
    function stickEnd(event) { if (event.pointerId === stickId) { clearStick(); } }
    window.addEventListener("pointermove", stickMove);
    window.addEventListener("pointerup", stickEnd);
    window.addEventListener("pointercancel", stickEnd);
    zone.addEventListener("lostpointercapture", stickEnd);

    const attackAim = createAttackAim(attackBtn, input, {
        press() { press("attack", 0); },
        lift() { lift("attack", 0); },
        cancel() { latches.delete("attack:0"); input.state.attack = false; }
    });
    bindPress(dodgeBtn, "dodge", 0);

    // Native click is not dispatched for a second finger while the attack or
    // movement finger is held. Keep mouse/keyboard click semantics, and handle
    // only that missing secondary-touch tap on release (never twice).
    function bindTap(node, action) {
        let touch = null, suppressClick = false;
        node.addEventListener("pointerdown", event => {
            suppressClick = false;
            if (event.pointerType === "touch" && !event.isPrimary && !node.disabled && !touch) {
                touch = { id:event.pointerId, x:event.clientX, y:event.clientY };
            }
        });
        node.addEventListener("pointerup", event => {
            if (!touch || touch.id !== event.pointerId) { return; }
            const start = touch; touch = null;
            if (node.disabled || Math.hypot(event.clientX-start.x,event.clientY-start.y)>10
                || !node.contains(document.elementFromPoint(event.clientX,event.clientY))) { return; }
            event.preventDefault(); suppressClick = true; action?.();
        });
        const cancel = event => { if (touch?.id === event.pointerId) { touch = null; } };
        node.addEventListener("pointercancel", cancel);
        node.addEventListener("lostpointercapture", cancel);
        node.addEventListener("click", event => {
            const duplicate = suppressClick && event.detail !== 0; suppressClick = false;
            if (!duplicate && !node.disabled) { action?.(); }
        });
        for (const type of ["keydown", "keyup"]) node.addEventListener(type, event => {
            if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); }
        });
        return () => { touch = null; };
    }
    const clearMenuTap = bindTap(pauseBtn, onMenu), clearInteractTap = bindTap(interactBtn, options.onInteract);

    [skillbar, gauge, zone, stickBase, stickKnob,
     attackBtn, dodgeBtn, interactBtn].forEach(function (node) {
        parent.appendChild(node);
    });
    (options.menuParent || parent).appendChild(pauseBtn);

    // Touch chrome shows for coarse pointers, and on the first touch event
    // whatever the pointer media query said (some convertibles report fine).
    const touchEls = [zone, attackBtn, dodgeBtn, interactBtn];
    let touchOn = null;
    function clearInput() {
        attackAim.clear();
        clearMenuTap(); clearInteractTap(); clearStick();
        input.clear(); latches.clear();
        if (tooltip) { tooltip.hide(); }
        closeBrief(); clearPulses();
    }
    function setTouch(on) {
        if (touchOn === on) {
            return;
        }
        touchOn = on;
        clearInput();
        touchEls.forEach(function (node) {
            node.classList.toggle("hud-hidden", !on);
        });
        document.body.classList.toggle("touch-on", on);
    }
    const coarse = window.matchMedia("(pointer: coarse)");
    const fine = window.matchMedia("(any-pointer: fine)");
    function detectTouch() { setTouch(navigator.maxTouchPoints > 0 && coarse.matches && !fine.matches); }
    function pointerMode(event) {
        if (event.pointerType === "touch") { setTouch(true); }
        else if (event.pointerType === "mouse") { setTouch(false); }
    }
    function keyboardMode(event) { if (!event.metaKey && !event.ctrlKey && !event.altKey) { setTouch(false); } }
    detectTouch();
    coarse.addEventListener("change", detectTouch); fine.addEventListener("change", detectTouch);
    // Boundary events also fire when layout changes under a stationary mouse.
    // Only movement/press identifies a new device; revealing touch controls
    // must not immediately turn them off again.
    window.addEventListener("pointermove", pointerMode, true);
    window.addEventListener("pointerdown", pointerMode, true);
    window.addEventListener("keydown", keyboardMode, true);
    window.addEventListener("blur", clearInput);
    function visibilityInput() { if (document.hidden) { clearInput(); } }
    document.addEventListener("visibilitychange", visibilityInput);

    tooltip = createSkillTooltip({ parent, isTouch: () => touchOn,
        getState(index) {
            const world = currentWorld, p = world?.player, skills = p?.skills;
            const slot = index < 0 ? skills?.ultimate : skills?.slots[index];
            if (!slot) { return null; }
            const target = index < 0 ? world.previewUltimate() : null;
            const seconds = index < 0 ? 0 : skills.cooldownSeconds(index);
            const sealed = index >= 0 && skills.isSealed(index);
            const contract = p.gadgets.noCrit ? ' · 定心契约：不能暴击，必暴出手仍消耗'
                : p.gadgets.noAdvantage ? ' · 无相契约：失去有利属性加成，不利属性与耐性照常' : '';
            return { slot, turnSeconds: skills.turnSeconds,
                source: index >= 0 && skills.sourceFor?.(index)
                    ? "改技来源：" + skillSourceLabel(skills.sourceFor(index)) + "；完整对照见菜单 → 装备" : "",
                blocked: p.dead || world.frozen || !!world.transition,
                scope: index < 0 ? "R / 1 · " + (target?.description || "必杀")
                    : "技能 " + (index + 1) + " · " + ({ self: "作用于自身", ring: "周身环形", aimed: "朝瞄准方向" })[slot.delivery],
                state: (index < 0 ? (skills.ultimateReady ? "必杀就绪" : "量能 "
                    + Math.floor(skills.gauge / skills.gaugeMax * 100) + "% · 满量能可释放")
                    : (sealed ? '缚技契约封印，替换护甲后解除' : seconds > 0 ? '技能冷却中' : '技能就绪')
                        + (seconds > 0 ? " · 剩余 " + Math.ceil(seconds) + " 秒" : '')
                        + " · 基础冷却 " + Number(slot.cooldown.toFixed(1)) + " 秒") + contract };
        }
    });
    skillEls.forEach((view, index) => tooltip.bind(view.btn, index));
    tooltip.bind(gauge, -1);

    // --- 就绪单次脉冲 -----------------------------------------------------------
    // 量谱面板本体 transform 恒 identity：脉冲只挂星子元素与技能槽，300px
    // 面板的任何缩放都会顶出 right:12px 边距（1280×720 实测超视口）。
    // spec/01 §1：UI 层动效 150–250ms 柔和缓动——kf-ready-pulse 为 220ms
    // 单发、50% 帧仅放大 1.05，技能槽就绪边沿挂一轮，摘类即止；必杀转好时
    // 四芒星挂星形专用单发类 .hud-star-pulse（12px 星上 1.05 不可辨，单独
    // 一轮 1→1.35→1），摘除后由 .hud-gauge.ready 静置金色。
    const PULSE_MS = 220;       // 与 theme.css kf-ready-pulse/kf-star-pulse 时长一致（单发 220ms）
    function firePulse(node, key, pulseClass) {
        const cls = pulseClass || "hud-ready-pulse";
        node.classList.remove(cls);
        // 连续边沿也能重新起播（重排后重挂类）。星子元素是 SVG，没有
        // offsetWidth，getBoundingClientRect 对 HTML/SVG 都强制重排。
        void node.getBoundingClientRect();
        node.classList.add(cls);
        const held = pulseTimers.get(key);
        if (held) { clearTimeout(held); }
        pulseTimers.set(key, setTimeout(function () {
            pulseTimers.delete(key);
            node.classList.remove(cls);
        }, PULSE_MS));
    }
    function clearPulses() {
        pulseTimers.forEach(function (timer) { clearTimeout(timer); });
        pulseTimers.clear();
        skillEls.forEach(function (view) { view.btn.classList.remove("hud-ready-pulse"); });
        gaugeStar.classList.remove("hud-star-pulse");   // 星形专用单发类同步摘除
    }

    // --- per-frame update --------------------------------------------------------

    function update(world) {
        currentWorld = world;
        tooltip.refresh();
        const p = world && world.player;
        const assistance = world && world.assistance;
        const tier = p?.gadgets?.assist || 0;
        const locked = !p || p.dead || world.frozen || !!world.transition;
        if (locked) { attackAim.clear(); closeBrief(); }
        const shrineReady = !!world.canCommuneAtShrine && (!options.isShrineVisible || options.isShrineVisible());
        text(playerName, p?.card?.characterZh || p?.card?.name || "");
        text(playerLevel, p ? "Lv " + p.level : "");
        if (p?.card?.id && portraitId !== (p.displayCardId || p.card.id)) {
            portraitId = p.displayCardId || p.card.id;
            portrait.hidden = false;
            portrait.src = new URL(`../../../asset/img/rl/icon/${portraitId}.webp`, import.meta.url).href;
        }
        assistBtn.classList.toggle("hud-hidden", !p || tier < 2);
        attr(assistBtn, "aria-disabled", locked);
        attr(assistBtn, "aria-pressed", !!assistance?.enabled);
        text(assistName, (touchOn ? "" : "H · ") + (tier === 3 ? "巡猎" : "自动普攻"));
        text(assistState, assistance?.state || "关闭");
        attr(attackBtn, "aria-disabled", locked);
        attr(dodgeBtn, "aria-disabled", locked);
        const near = function (spot, radius) {
            return p && spot && Math.hypot(p.x - spot.x, p.y - spot.y) <= radius;
        };
        const noInteraction = locked || !(world.room
            && (world.room.type === "shop" || world.room.type === "rest"
                || near(world.chest, 2.2) || near(world.altar, 1.9) || shrineReady));
        if (interactBtn.disabled !== noInteraction) { interactBtn.disabled = noInteraction; }
        text(interactBtn, shrineReady ? '祈愿' : '交互');
        const active = [];
        if (p && !p.dead && p.skills) {
            if (p.gadgets.noCrit) active.push('定心契约 · 禁止暴击（含必暴）');
            if (p.gadgets.noAdvantage) active.push('无相契约 · 无有利属性加成');
            for (const index of p.gadgets.sealedSlots) {
                if (p.skills.isSealed(index)) active.push('缚技契约 · 技能' + (index + 1) + '封印');
            }
            if (p.nextCritical === true) {
                active.push(p.gadgets.noCrit ? '✧ 下次伤害必暴 · 契约压制，出手仍消耗' : "✧ 下次伤害必暴 · 出手消耗");
            }
            if (p.nextAtkBonus > 0) {
                active.push("✦ 次攻 +" + Math.round(p.nextAtkBonus * 100) + "%");
            }
            if (p.regen) {
                active.push("持续回复 " + Math.round(p.regen.pct * 100) + "% · 剩余" + p.regen.turnsLeft + "次");
            }
            const shield = p.skills.barrier;
            if (shield) {
                active.push("护盾 " + Math.round(shield.cut * 100) + "% · " + shield.hits + "次");
            }
            if (p.healingLock > 0) {
                active.push("治疗封锁（技能/吸血回复无效） · " + Math.ceil(p.healingLock) + "秒");
            }
            if (p.abnormalDisable > 0) {
                active.push("异常免疫（全部异常无效） · " + Math.ceil(p.abnormalDisable) + "秒");
            }
            if (p.poison > 0) {
                active.push("中毒（每回合损血） · " + Math.ceil(p.poison) + "秒");
            }
            if (p.healingLockImmunity > 0) {
                active.push("治疗封锁免疫 · " + Math.ceil(p.healingLockImmunity) + "秒");
            }
            if (p.passives && p.passives.healingLockImmune) {
                active.push("治疗封锁免疫 · 武器常驻");
            }
            for (const entry of p.skillCards || []) {
                const source = entry.sourceSlot === NORMAL_CARD_SOURCE ? "普攻"
                    : entry.sourceSlot === 0 ? "必杀" : "技能" + (entry.sourceSlot + 1);
                active.push(entry.card.name + "（" + source + "） · " + entry.remaining
                    + "次 · " + (Math.ceil(entry.next * 10) / 10).toFixed(1) + "秒");
            }
            const names = { atk: "物攻", mgc: "魔攻", def: "物防", mdef: "魔防", luck: "幸运" };
            const elements = ["火", "水", "土", "风", "月", "阳"];
            if (p.skills.buffs.some(buff => buff.spd && buff.remaining > 0)) {
                active.push("技能恢复 ×" + p.skills.cooldownRate.toFixed(2) + "（不影响移动/普攻）");
            }
            p.skills.buffs.forEach(function (buff) {
                const words = [];
                Object.keys(names).forEach(function (key) {
                    if (buff[key]) {
                        words.push(names[key] + (buff[key] > 0 ? "+" : "") + Math.round(buff[key] * 100) + "%");
                    }
                });
                if (buff.resistPct) {
                    words.push(elements[buff.resistElement] + "耐性"
                        + (buff.resistPct > 0 ? "+" : "") + Math.round(buff.resistPct * 100) + "%");
                }
                if (buff.spd) {
                    words.push("技能恢复" + (buff.spd > 0 ? "+" : "")
                        + Number((buff.spd * 100).toFixed(1)) + "%");
                }
                if (buff.weakElementBonus) {
                    words.push("克制倍率+" + Number(buff.weakElementBonus.toFixed(3))
                        + (p.gadgets.noAdvantage ? '（契约下无效）' : "（仅有利属性）"));
                }
                if (words.length) { active.push(words.join(" ") + " · " + Math.ceil(buff.remaining) + "秒"); }
            });
        }
        const label = active.join("；");
        if (effects.textContent !== label) { effects.textContent = label; }
        skillbar.classList.toggle("hud-hidden", !p);
        gauge.classList.toggle("hud-hidden", !p);
        if (equipRow.hidden !== !p) { equipRow.hidden = !p; }
        if (!p || !p.skills) {
            return;
        }
        const sk = p.skills;
        for (let i = 0; i < skillEls.length; i++) {
            const view = skillEls[i];
            const slot = sk.slots[i];
            view.btn.classList.toggle("hud-hidden", !slot || !!slot.ultimate);
            if (!slot || slot.ultimate) {
                continue;
            }
            const artKey = slot.id + ":" + slot.skillType + ":" + p.element;
            if (view.artKey !== artKey) {
                const art = skillArt(slot, p.element);
                view.icon.style.setProperty("--skill-art", 'url("' + art.url + '")');
                view.icon.style.setProperty("--skill-tint", art.tint);
                view.icon.classList.toggle("silhouette", !!art.silhouette);
                view.artKey = artKey;
            }
            const skillName = slot.name || "角色技能";
            const sealed = sk.isSealed(i);
            const ready = sk.ready(i);
            const source = sk.sourceFor?.(i);
            const originHidden = !source;
            if (view.origin.hidden !== originHidden) { view.origin.hidden = originHidden; }
            text(view.name, skillName);
            attr(view.btn, "aria-label", "技能 " + (i + 1) + " · " + skillName
                + (source ? " · 装备改写：" + skillSourceLabel(source) : "") + (sealed ? ' · 缚技契约封印' : ''));
            attr(view.btn, "data-overridden", !!source);
            attr(view.btn, "aria-disabled", !ready || locked);
            attr(view.btn, 'data-sealed', sealed);
            view.btn.classList.toggle('hud-skill-sealed', sealed);
            const frac = slot.remaining > 0 && slot.cooldown > 0
                ? Math.min(1, slot.remaining / slot.cooldown) : 0;
            // The fan covers the fraction of the circle that is still on
            // cooldown, sweeping down to nothing as it recovers. The veil
            // colour is a theme token (--kf-veil) — inline styles still
            // resolve CSS variables, so no raw colour lives here.
            css(view.cd, "--cooldown-angle", (frac * 360).toFixed(1) + "deg");
            attr(view.btn, "data-cd", frac.toFixed(3));
            const seconds = sk.cooldownSeconds(i);
            text(view.secs, sealed ? '封印' : seconds > 0 ? Math.ceil(seconds) + "秒" : "");
            view.btn.classList.toggle("hud-skill-ready", ready);
            // 就绪单次脉冲：按槽存 prev(ready, sealed, slot.id)+artKey 边沿。
            // 首帧（无 prev）、锁定（aria-disabled 含 locked 语义）、换装
            // （artKey/slot.id 变化）与封印起落都抑制，避免菜单关闭/换装
            // 假脉冲；只有同一技能真实跨过冷却收尾（false→true）才脉冲一次。
            const prev = view.pulse;
            if (prev && prev.id === slot.id && prev.artKey === artKey
                    && !prev.sealed && !sealed && !locked && ready && !prev.ready) {
                firePulse(view.btn, "skill:" + i);
            }
            view.pulse = { ready: ready, sealed: sealed, id: slot.id, artKey: artKey };
        }
        const g = sk.gaugeMax > 0
            ? Math.min(1, sk.gauge / sk.gaugeMax) : 0;
        css(gaugeFill, "--gauge", g.toFixed(3));
        attr(gauge, "data-frac", g.toFixed(3));
        gauge.classList.toggle("ready", !!sk.ultimateReady);
        // 必杀满量脉冲一次并点亮四芒星：点亮由 .hud-gauge.ready 在 theme.css
        // 接管；脉冲只挂星子元素（星形专用 220ms 单发），面板本体不再参与
        // 缩放、transform 恒 identity。这里只负责「恰一次」的边沿。
        const ultId = sk.ultimate ? sk.ultimate.id : null;
        if (ultPulse && ultPulse.id === ultId
                && !ultPulse.ready && sk.ultimateReady && !locked) {
            firePulse(gaugeStar, "ultimate-star", "hud-star-pulse");
        }
        ultPulse = { ready: !!sk.ultimateReady, id: ultId };
        // 装备芯片：只在装备签名变化时重建（空帧零 DOM 写入的既有约定）；
        // 简报开着时词条同步刷新，装备被换掉就收简报。
        const equipment = p.equipment || [];
        const equipSig = equipment.map(function (item) {
            return item.slot + ":" + (item.gadgetId || item.catalogId || item.weaponId || "")
                + ":" + (item.affixes || []).join(",");
        }).join("|");
        if (equipSig !== lastEquipSig) {
            lastEquipSig = equipSig;
            renderEquipChips(equipment);
            if (briefSlot !== null) {
                const item = briefItem(world, briefSlot);
                if (item) { renderBrief(item); placeBrief(); }
                else { closeBrief(); }
            }
        }
        equipChips.forEach(function (view) {
            attr(view.chip, "aria-disabled", locked);
        });
        let title = sk.ultimate ? sk.ultimate.name : "必杀资料缺失";
        const target = world.previewUltimate ? world.previewUltimate() : null;
        text(gaugeLabel, (touchOn ? "必杀" : "R 必杀") + (target ? " · " + target.scope : ""));
        text(gaugeName, sk.ultimate ? sk.ultimate.name : "无必杀资料");
        text(gaugeReadout, sk.ultimateReady ? "就绪" : Math.floor(g * 100) + "%");
        if (target) { title += " · " + target.description; }
        if (sk.ultimate) {
            title += sk.ultimate.sceneId ? " · 原作必杀演出" : " · 原作职业动作";
        }
        attr(gauge, "aria-label", gaugeLabel.textContent + " · " + title + " · " + gaugeReadout.textContent);
        attr(gauge, "aria-disabled", !sk.ultimateReady || locked);
    }

    return {
        update: update,
        pump: pump,
        setTouch: setTouch,
        clearInput: clearInput,
        dispose: function () {
            clearInput(); attackAim.dispose();
            tooltip.dispose();
            document.removeEventListener("keydown", briefEscape, true);
            parent.removeEventListener("pointerdown", briefOutside, true);
            window.removeEventListener("resize", placeBrief);
            brief.remove();
            if (hudSize) { hudSize.disconnect(); }
            parent.style.removeProperty("--rl-hud-height");
            coarse.removeEventListener("change", detectTouch); fine.removeEventListener("change", detectTouch);
            window.removeEventListener("pointermove", pointerMode, true);
            window.removeEventListener("pointerdown", pointerMode, true);
            window.removeEventListener("keydown", keyboardMode, true);
            window.removeEventListener("blur", clearInput);
            window.removeEventListener("pointermove", stickMove);
            window.removeEventListener("pointerup", stickEnd);
            window.removeEventListener("pointercancel", stickEnd);
            document.removeEventListener("visibilitychange", visibilityInput);
            [skillbar, gauge, identity, equipRow, effects, assistBtn, pauseBtn, ...touchEls, stickBase, stickKnob].forEach(node => node.remove());
        },
        get touchOn() { return touchOn; },
        els: {
            skillbar: skillbar, skills: skillEls, gauge: gauge, effects: effects,
            gaugeFill: gaugeFill, zone: zone, stickBase: stickBase,
            stickKnob: stickKnob, attack: attackBtn, dodge: dodgeBtn,
            pause: pauseBtn, interact: interactBtn, assist: assistBtn,
            equip: equipRow
        }
    };
}
