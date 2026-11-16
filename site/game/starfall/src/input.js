// Keyboard + pointer input. Gameplay reads edge-triggered actions from
// pressed()/down(); overlays disable the whole router so arrow keys don't
// scroll the page or leak into the paused simulation.

import { KEY_BINDINGS } from "./config.js";

const GAME_CODES = new Set(Object.values(KEY_BINDINGS).flat());

export class Input {
  constructor() {
    this.enabled = true;
    this.held = new Set();
    this.pressedSet = new Set();
    this.releasedSet = new Set();
    this.codeToAction = new Map();
    for (const [action, codes] of Object.entries(KEY_BINDINGS)) {
      for (const code of codes) this.codeToAction.set(code, action);
    }
    this.virtual = new Map();
    this.pointers = new Map();
    this._onKeyDown = this.onKeyDown.bind(this);
    this._onKeyUp = this.onKeyUp.bind(this);
    this._onBlur = this.clear.bind(this);
    addEventListener("keydown", this._onKeyDown, { passive: false });
    addEventListener("keyup", this._onKeyUp);
    addEventListener("blur", this._onBlur);
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.clear(); });
  }

  onKeyDown(event) {
    const action = this.codeToAction.get(event.code);
    if (!action) return;
    if (GAME_CODES.has(event.code) && (this.enabled || action === "pause")) {
      event.preventDefault();
    }
    if (!this.enabled) return;
    if (event.repeat) return;
    if (!this.held.has(action)) this.pressedSet.add(action);
    this.held.add(action);
    if (action === "pause" || action === "confirm") this.pressedSet.add(action);
  }

  onKeyUp(event) {
    const action = this.codeToAction.get(event.code);
    if (!action) return;
    if (GAME_CODES.has(event.code) && this.enabled) event.preventDefault();
    if (!this.enabled) return;
    this.held.delete(action);
    this.releasedSet.add(action);
  }

  attachTouch(root) {
    const buttons = root.querySelectorAll("[data-touch]");
    const release = event => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer) return;
      this.pointers.delete(event.pointerId);
      this.recomputeVirtual();
      try { event.target.releasePointerCapture?.(event.pointerId); } catch (ignored) { /* already released */ }
    };
    buttons.forEach(button => {
      const action = button.dataset.touch;
      button.addEventListener("pointerdown", event => {
        event.preventDefault();
        if (!this.enabled) return;
        button.setPointerCapture?.(event.pointerId);
        this.pointers.set(event.pointerId, action);
        this.virtual.set(action, true);
        if (!this.held.has(action)) this.pressedSet.add(action);
        button.classList.add("pressed");
      });
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("lostpointercapture", event => {
        const pointer = this.pointers.get(event.pointerId);
        if (pointer) { this.pointers.delete(event.pointerId); this.recomputeVirtual(); }
      });
    });
    this._touchRoot = root;
  }

  recomputeVirtual() {
    this.virtual.clear();
    for (const action of this.pointers.values()) this.virtual.set(action, true);
    (this._touchRoot?.querySelectorAll("[data-touch]") || []).forEach(button => {
      button.classList.toggle("pressed", this.virtual.get(button.dataset.touch) || false);
    });
  }

  down(action) {
    return this.held.has(action) || this.virtual.has(action);
  }

  pressed(action) {
    return this.pressedSet.has(action);
  }

  released(action) {
    return this.releasedSet.has(action);
  }

  axisX() {
    const left = this.down("left") ? 1 : 0;
    const right = this.down("right") ? 1 : 0;
    return right - left;
  }

  clear() {
    this.held.clear();
    this.pressedSet.clear();
    this.releasedSet.clear();
    this.pointers.clear();
    this.virtual.clear();
    if (this._touchRoot) {
      this._touchRoot.querySelectorAll("[data-touch]").forEach(button => button.classList.remove("pressed"));
    }
  }

  endFrame() {
    this.pressedSet.clear();
    this.releasedSet.clear();
  }
}
