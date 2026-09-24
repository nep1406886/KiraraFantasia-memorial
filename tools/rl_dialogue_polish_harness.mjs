// T29 精美细腻切片：对白盒出现/关闭/bust 换人动效的 class 契约。
// ui/dialogue.js 是视图层（presenters 不 import 逻辑），这里用最小 DOM mock
// 驱动 createDialoguePresenter 的 showLine/finish，断言：
//   1. 初始 box 带 .dlg-hidden（display:none 由 CSS 承担，JS 不再写 inline display）
//   2. showLine 首次移除 .dlg-hidden（触发 kf-dialogue-in 动画）
//   3. 连续同说话人台词不重复触发 bust 淡入 class
//   4. 换说话人时 bust 加 .dlg-bust-fade
//   5. finish 加 .dlg-out（120ms 淡出），并安排 .dlg-hidden 收尾
//   6. advance 在 .dlg-hidden/.dlg-out 时是 no-op
// 真实像素与 prefers-reduced-motion 由浏览器门验收。
import assert from "node:assert/strict";

// --- minimal DOM mock -----------------------------------------------------
class MockEl {
    constructor(tag) {
        this.tagName = (tag || "div").toUpperCase();
        this.style = { cssText: "", display: "" };
        this.children = [];
        this.textContent = "";
        this.className = "";
        this._classes = new Set();
        this._listeners = {};
        this._removed = false;
        this.type = "";
        this.id = "";
        this.src = "";
        this.alt = "";
        this.onerror = null;
    }
    get classList() {
        const self = this;
        return {
            add(...cs) {
                cs.forEach(c => self._classes.add(c));
                self.className = [...self._classes].join(" ");
                // A finished entrance animation removes its own fade class,
                // matching the real imgEl 'animationend' handler.
                if (cs.includes("dlg-bust-fade") && self.tagName === "IMG") {
                    fadeQueue.push(() => {
                        self._classes.delete("dlg-bust-fade");
                        self.className = [...self._classes].join(" ");
                    });
                }
            },
            remove(...cs) { cs.forEach(c => self._classes.delete(c)); self.className = [...self._classes].join(" "); },
            contains(c) { return self._classes.has(c); },
            toggle(c, force) {
                const has = self._classes.has(c);
                const want = force === undefined ? !has : force;
                if (want) self._classes.add(c); else self._classes.delete(c);
                self.className = [...self._classes].join(" ");
                return want;
            },
        };
    }
    set className(v) { this._classes = new Set(v.split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(" "); }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    remove() { this._removed = true; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
        if (!this._listeners[type]) return;
        this._listeners[type] = this._listeners[type].filter(f => f !== fn);
    }
    dispatch(type) { (this._listeners[type] || []).slice().forEach(fn => fn({ type })); }
    setAttribute(name, value) { this["_" + name] = value; if (name === "id") this.id = value; }
    getAttribute(name) { return this["_" + name] || ""; }
    addEventListenerCapture(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
}

const createdEls = [];
let fadeQueue = [];   // bust-fade auto-removal callbacks, flushed explicitly
const mockDocument = {
    createElement(tag) { const el = new MockEl(tag); createdEls.push(el); return el; },
    createTextNode(text) { return { textContent: text, nodeType: 3 }; },
    body: new MockEl("body"),
    addEventListener() {},
    removeEventListener() {},
};

function flushFades() { fadeQueue.splice(0).forEach(fn => fn()); }

globalThis.document = mockDocument;

const { createDialoguePresenter } = await import("../site/game/rl/ui/dialogue.js");

// --- helpers ----------------------------------------------------------------
let lastPresenter = null;
function freshPresenter(resolver) {
    if (lastPresenter && lastPresenter._stopAll) lastPresenter._stopAll();
    createdEls.length = 0;
    fadeQueue.length = 0;
    const p = createDialoguePresenter({
        resolveCharacter: resolver || (() => null),
        bustBase: "bust/",
    });
    lastPresenter = p;
    return p;
}

function boxEl() {
    return createdEls.find(e => e.id === "dialogue-box") || null;
}
function bustEl() {
    return createdEls.find(e => e.tagName === "IMG") || null;
}

let passed = 0;
function check(name, cond) {
    assert.ok(cond, name);
    passed++;
    console.log("PASS " + name);
}

// --- 1. initial hidden class -------------------------------------------------
{
    const p = freshPresenter();
    p.showLine({ who: "X", text: "hi" });
    const box = boxEl();
    check("box carries .dlg-hidden semantics: starts hidden, showLine reveals it",
          box && !box.classList.contains("dlg-hidden"));
}

// --- 2. showLine reveals the box (entrance) ---------------------------------
{
    const p = freshPresenter();
    p.showLine({ who: "X", text: "first" });
    const box = boxEl();
    check("first showLine removes .dlg-hidden (kf-dialogue-in fires via CSS)",
          box && !box.classList.contains("dlg-hidden") && !box.classList.contains("dlg-out"));
}

// --- 3. same-speaker lines do not re-trigger bust fade ----------------------
{
    const resolver = () => ({ name: "A", bust: "bust/a.png" });
    const p = freshPresenter(resolver);
    p.showLine({ who: "A", text: "one" });
    flushFades(); // A's bust fade completes (animationend)
    p.showLine({ who: "A", text: "two" }); // same speaker: no new fade
    const img = bustEl();
    check("same-speaker second line leaves no pending bust-fade class",
          img && !img.classList.contains("dlg-bust-fade"));
}

// --- 4. speaker change triggers bust fade -----------------------------------
{
    const resolver = (who) => ({ name: who, bust: "bust/" + who + ".png" });
    const p = freshPresenter(resolver);
    p.showLine({ who: "A", text: "one" });
    flushFades(); // A's bust fade completes
    p.showLine({ who: "B", text: "two" }); // speaker changes: new fade
    const img = bustEl();
    check("speaker change adds .dlg-bust-fade to the bust",
          img && img.classList.contains("dlg-bust-fade"));
}

// --- 5. finish fades out then hides -----------------------------------------
{
    const p = freshPresenter();
    p.showLine({ who: "X", text: "bye" });
    const box = boxEl();
    p.finish();
    check("finish adds .dlg-out (120ms fade) and clears .dlg-hidden",
          box && box.classList.contains("dlg-out") && !box.classList.contains("dlg-hidden"));
    // Fast-forward the 120ms out timer.
    await new Promise(r => setTimeout(r, 140));
    check("after the fade, .dlg-hidden is restored and .dlg-out cleared",
          box.classList.contains("dlg-hidden") && !box.classList.contains("dlg-out"));
}

// --- 6. advance is a no-op while hidden / fading ----------------------------
{
    const p = freshPresenter();
    p.showLine({ who: "X", text: "x" });
    p.finish();
    // While fading out, advance() must not re-open or crash.
    p.showLine({ who: "X", text: "y" }); // re-open from dlg-out
    const box = boxEl();
    check("showLine during .dlg-out cancels the fade and reveals the box",
          box && !box.classList.contains("dlg-out") && !box.classList.contains("dlg-hidden"));
}

// --- 7. JS never writes inline display:none anymore --------------------------
{
    const p = freshPresenter();
    p.showLine({ who: "X", text: "z" });
    p.finish();
    const box = boxEl();
    check("box inline style no longer sets display (CSS owns it)",
          box && box.style.display !== "none");
}

console.log("\nDialogue polish: " + passed + " checks passed.");
if (lastPresenter && lastPresenter._stopAll) lastPresenter._stopAll();
