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
    bindPress(gauge, "ultimate", 0);

    const hudPanel = parent.querySelector("#hud");
    const identity = el("div", "hud-identity");
    const playerName = el("span", "hud-player-name");
    const playerLevel = el("span", "hud-player-level");
    identity.append(playerName, playerLevel);
    if (hudPanel) { hudPanel.prepend(identity); }
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
    interactBtn.addEventListener("click", function () { if (options.onInteract) { options.onInteract(); } });
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
        if (stickId !== null) {
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
    zone.addEventListener("pointermove", function (event) {
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
    });
    function stickEnd(event) {
        if (event.pointerId !== stickId) {
            return;
        }
        stickId = null;
        origin = null;
        input.state.move.x = 0;
        input.state.move.y = 0;
        [stickBase, stickKnob].forEach(function (n) {
            n.classList.add("hud-hidden");
        });
    }
    zone.addEventListener("pointerup", stickEnd);
    zone.addEventListener("pointercancel", stickEnd);

    const attackAim = createAttackAim(attackBtn, input, {
        press() { press("attack", 0); },
        lift() { lift("attack", 0); },
        cancel() { latches.delete("attack:0"); input.state.attack = false; }
    });
    bindPress(dodgeBtn, "dodge", 0);

    // Native click is not dispatched for a second finger while the attack or
    // movement finger is held. Keep mouse/keyboard click semantics, and handle
    // only that missing secondary-touch tap on release (never twice).
    let pauseTouch = null, suppressPauseClick = false;
    pauseBtn.addEventListener("pointerdown", function (event) {
        suppressPauseClick = false;
        if (event.pointerType === "touch" && !event.isPrimary && !pauseBtn.disabled && !pauseTouch) {
            pauseTouch = { id: event.pointerId, x: event.clientX, y: event.clientY };
        }
    });
    pauseBtn.addEventListener("pointerup", function (event) {
        if (!pauseTouch || pauseTouch.id !== event.pointerId) { return; }
        const start = pauseTouch; pauseTouch = null;
        if (pauseBtn.disabled || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
                || !pauseBtn.contains(document.elementFromPoint(event.clientX, event.clientY))) { return; }
        event.preventDefault(); suppressPauseClick = true;
        if (onMenu) { onMenu(); }
    });
    function cancelPauseTouch(event) {
        if (pauseTouch?.id === event.pointerId) { pauseTouch = null; }
    }
    pauseBtn.addEventListener("pointercancel", cancelPauseTouch);
    pauseBtn.addEventListener("lostpointercapture", cancelPauseTouch);
    pauseBtn.addEventListener("click", function (event) {
        const duplicate = suppressPauseClick && event.detail !== 0;
        suppressPauseClick = false;
        if (duplicate) { return; }
        if (onMenu) {
            onMenu();
        }
    });
    for (const type of ["keydown", "keyup"]) {
        pauseBtn.addEventListener(type, function (event) {
            if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); }
        });
    }

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
        pauseTouch = null;
        input.clear(); latches.clear(); stickId = null; origin = null;
        stickBase.classList.add("hud-hidden"); stickKnob.classList.add("hud-hidden");
        if (tooltip) { tooltip.hide(); }
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

    // --- per-frame update --------------------------------------------------------

    function update(world) {
        currentWorld = world;
        tooltip.refresh();
        const p = world && world.player;
        const assistance = world && world.assistance;
        const tier = p?.gadgets?.assist || 0;
        const locked = !p || p.dead || world.frozen || !!world.transition;
        if (locked) { attackAim.clear(); }
        const shrineReady = !!world.canCommuneAtShrine && (!options.isShrineVisible || options.isShrineVisible());
        text(playerName, p?.card?.characterZh || p?.card?.name || "");
        text(playerLevel, p ? "Lv " + p.level : "");
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
            const source = sk.sourceFor?.(i);
            const originHidden = !source;
            if (view.origin.hidden !== originHidden) { view.origin.hidden = originHidden; }
            text(view.name, skillName);
            attr(view.btn, "aria-label", "技能 " + (i + 1) + " · " + skillName
                + (source ? " · 装备改写：" + skillSourceLabel(source) : "") + (sealed ? ' · 缚技契约封印' : ''));
            attr(view.btn, "data-overridden", !!source);
            attr(view.btn, "aria-disabled", !sk.ready(i) || locked);
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
            view.btn.classList.toggle("hud-skill-ready", sk.ready(i));
        }
        const g = sk.gaugeMax > 0
            ? Math.min(1, sk.gauge / sk.gaugeMax) : 0;
        css(gaugeFill, "--gauge", g.toFixed(3));
        attr(gauge, "data-frac", g.toFixed(3));
        gauge.classList.toggle("ready", !!sk.ultimateReady);
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
            if (hudSize) { hudSize.disconnect(); }
            parent.style.removeProperty("--rl-hud-height");
            coarse.removeEventListener("change", detectTouch); fine.removeEventListener("change", detectTouch);
            window.removeEventListener("pointermove", pointerMode, true);
            window.removeEventListener("pointerdown", pointerMode, true);
            window.removeEventListener("keydown", keyboardMode, true);
            window.removeEventListener("blur", clearInput);
            document.removeEventListener("visibilitychange", visibilityInput);
            [skillbar, gauge, identity, effects, assistBtn, pauseBtn, ...touchEls, stickBase, stickKnob].forEach(node => node.remove());
        },
        get touchOn() { return touchOn; },
        els: {
            skillbar: skillbar, skills: skillEls, gauge: gauge, effects: effects,
            gaugeFill: gaugeFill, zone: zone, stickBase: stickBase,
            stickKnob: stickKnob, attack: attackBtn, dodge: dodgeBtn,
            pause: pauseBtn, interact: interactBtn, assist: assistBtn
        }
    };
}
