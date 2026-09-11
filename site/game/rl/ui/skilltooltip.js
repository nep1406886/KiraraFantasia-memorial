// A read-only, hoverable summary of the same decoded effects as the skill sheet.
import { skillWords } from "./infocard.js";

let serial = 0;

export function skillBrief(slot, turnSeconds) {
    if (!slot) { return { effects: [], note: "暂无技能资料" }; }
    const words = skillWords(slot, turnSeconds);
    // Target delivery is shown in its own line, not counted as an effect.
    const targetWords = new Set(["自身", "环形", "指向", "敌方全体", "最近敌人"]);
    const effects = words.filter(word => !targetWords.has(word) && !word.startsWith("未适配："));
    if (slot.damage && effects.length) {
        effects[0] = (slot.magic ? "魔法" : "物理") + "伤害 · 系数 " + slot.coef;
    }
    const pending = words.filter(word => word.startsWith("未适配："));
    const notes = [];
    if (effects.length > 3) { notes.push("另有 " + (effects.length - 3) + " 项效果，菜单可查看完整说明"); }
    if (pending.length) { notes.push(pending.join("；")); }
    return { effects: effects.slice(0, 3), note: notes.join("。") };
}

export function createSkillTooltip({ parent, getState, isTouch }) {
    const box = document.createElement("section");
    box.className = "hud-skill-tooltip"; box.id = "hud-skill-tooltip-" + (++serial);
    box.setAttribute("role", "tooltip"); box.hidden = true;
    const heading = document.createElement("h3");
    const scope = document.createElement("p"); scope.className = "skill-tooltip-scope";
    const source = document.createElement("p"); source.className = "skill-tooltip-source";
    const effects = document.createElement("ul");
    const state = document.createElement("p"); state.className = "skill-tooltip-state";
    const note = document.createElement("p"); note.className = "skill-tooltip-note";
    box.append(heading, scope, source, effects, state, note); parent.appendChild(box);
    let active = null, cachedSlot = null, closing = null, dismissed = null;
    const unbind = [];

    function text(node, value) {
        if (node.textContent === value) { return false; }
        node.textContent = value; return true;
    }
    function cancelClose() { clearTimeout(closing); closing = null; }
    function hide() {
        cancelClose();
        if (active) { active.button.removeAttribute("aria-describedby"); }
        active = null; box.hidden = true;
    }
    function place() {
        if (!active) { return; }
        const bounds = parent.getBoundingClientRect(), anchor = active.button.getBoundingClientRect();
        const left = Math.max(12, Math.min(bounds.width - box.offsetWidth - 12, anchor.left - bounds.left));
        const top = Math.max(12, anchor.top - bounds.top - box.offsetHeight - 10);
        box.style.left = left + "px"; box.style.top = top + "px";
    }
    function refresh() {
        if (!active) { return; }
        const info = getState(active.index);
        if (!info || info.blocked || isTouch()) { hide(); return; }
        const slot = info.slot;
        let changed = false;
        if (slot !== cachedSlot) {
            cachedSlot = slot;
            const brief = skillBrief(slot, info.turnSeconds);
            text(heading, slot.name || "角色技能");
            effects.replaceChildren(...brief.effects.map(value => {
                const item = document.createElement("li"); item.textContent = value; return item;
            }));
            text(note, brief.note); note.hidden = !brief.note; changed = true;
        }
        changed = text(scope, info.scope) || changed;
        changed = text(source, info.source || "") || changed;
        source.hidden = !info.source;
        changed = text(state, info.state) || changed;
        if (changed) { place(); }
    }
    function show(button, index) {
        if (isTouch() || dismissed === button) { return; }
        cancelClose();
        if (active?.button !== button) { hide(); cachedSlot = null; }
        active = { button, index };
        box.hidden = false; button.setAttribute("aria-describedby", box.id);
        refresh(); place();
    }
    function scheduleClose() { cancelClose(); closing = setTimeout(hide, 140); }
    function listen(node, type, fn) {
        node.addEventListener(type, fn); unbind.push(() => node.removeEventListener(type, fn));
    }
    listen(box, "pointerenter", cancelClose);
    listen(box, "pointerleave", scheduleClose);
    function escape(event) {
        if (!active || event.key !== "Escape") { return; }
        dismissed = active.button;
        hide(); event.preventDefault(); event.stopImmediatePropagation();
    }
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", place);
    window.addEventListener("blur", hide);
    return {
        bind(button, index) {
            listen(button, "pointerenter", () => {
                // A new entry ends the previous hover/focus dismissal, but
                // only actual pointer movement below may open the card.
                if (dismissed === button) { dismissed = null; }
                if (active?.button === button) { cancelClose(); }
            });
            // A disappearing dialog can expose a button without any mouse
            // movement. Do not open a tooltip that would steal the next Esc.
            listen(button, "pointermove", event => {
                if (event.pointerType === "touch" || isTouch()) { return; }
                if (active?.button === button) { cancelClose(); }
                else { show(button, index); }
            });
            listen(button, "pointerleave", () => {
                if (dismissed === button) { dismissed = null; }
                scheduleClose();
            });
            listen(button, "focus", () => {
                if (button.matches(":focus-visible")) { dismissed = null; show(button, index); }
            });
            listen(button, "blur", hide);
            listen(button, "pointerdown", () => { dismissed = button; hide(); });
        },
        refresh, hide,
        dispose() {
            hide(); unbind.forEach(fn => fn());
            document.removeEventListener("keydown", escape, true);
            window.removeEventListener("resize", place); window.removeEventListener("blur", hide);
            box.remove();
        }
    };
}
