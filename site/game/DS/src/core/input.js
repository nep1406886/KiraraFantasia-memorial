// ============================================================
// 输入：键盘 / 触屏 / 手柄
// ============================================================
import { KEYS } from '../config.js';

const ALL_ACTIONS = ['left', 'right', 'up', 'down', 'jump', 'attack', 'skill', 'dash', 'swap', 'ult', 'pause', 'interact', 'confirm'];

class InputSys {
  constructor() {
    this.down = new Set();
    this.pressedSet = new Set();
    this.releasedSet = new Set();
    this.keyState = new Map();
    this.touchX = 0;
    this.touchY = 0;
    this.stickActive = false;
    this.stickPointer = null;
    this.touchHeld = new Map();
    this.holdover = new Map(); // 命中停顿期间暂存的按键（action -> 按下时刻）
    this.enabled = true;
    this.lastDevice = 'keyboard';
    this._bindKeyboard();
    this._bindTouch();
    this._bindGamepad();
  }

  _codeToActions(code) {
    const out = [];
    for (const a of ALL_ACTIONS) {
      const list = KEYS[a];
      if (list && list.includes(code)) out.push(a);
    }
    return out;
  }

  _bindKeyboard() {
    const onKey = (e, isDown) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const acts = this._codeToActions(e.code);
      if (!acts.length) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (isDown) {
        if (e.repeat) return;
        this.lastDevice = 'keyboard';
        for (const a of acts) {
          if (!this.down.has(a)) this.pressedSet.add(a);
          this.down.add(a);
        }
      } else {
        for (const a of acts) {
          this.down.delete(a);
          this.releasedSet.add(a);
        }
      }
    };
    window.addEventListener('keydown', (e) => onKey(e, true), { passive: false });
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.touchHeld.clear();
      this.touchX = 0;
      this.touchY = 0;
    });
  }

  _bindTouch() {
    const stick = document.getElementById('stick-zone');
    const knob = document.getElementById('stick-knob');
    if (!stick) return;
    const setStick = (e) => {
      const r = stick.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / (r.width * .42);
      let dy = (e.clientY - cy) / (r.height * .42);
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      this.touchX = dx;
      this.touchY = dy;
      if (knob) knob.style.transform = `translate(${dx * 1.6}cqw, ${dy * 1.6}cqw)`;
    };
    stick.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stickActive = true;
      this.stickPointer = e.pointerId;
      this.lastDevice = 'touch';
      stick.setPointerCapture(e.pointerId);
      setStick(e);
    });
    stick.addEventListener('pointermove', (e) => {
      if (!this.stickActive || e.pointerId !== this.stickPointer) return;
      e.preventDefault();
      setStick(e);
    });
    const upStick = (e) => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickActive = false;
      this.stickPointer = null;
      this.touchX = 0;
      this.touchY = 0;
      if (knob) knob.style.transform = '';
    };
    stick.addEventListener('pointerup', upStick);
    stick.addEventListener('pointercancel', upStick);
    stick.addEventListener('pointerleave', (e) => { if (this.stickActive && e.buttons === 0) upStick(e); });

    document.querySelectorAll('.tbtn').forEach((btn) => {
      const act = btn.dataset.act;
      if (!act) return;
      const press = (e) => {
        e.preventDefault();
        // 显式捕获：手指滑出按钮也能保证 pointerup 回到同一个元素
        try { btn.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
        this.lastDevice = 'touch';
        this.touchHeld.set(act, true);
        if (!this.down.has(act)) this.pressedSet.add(act);
        this.down.add(act);
        btn.classList.add('on');
      };
      const release = (e) => {
        e.preventDefault();
        try {
          if (btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
        } catch (_) { /* 忽略 */ }
        this.touchHeld.delete(act);
        this.down.delete(act);
        this.releasedSet.add(act);
        btn.classList.remove('on');
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('lostpointercapture', (e) => {
        // 捕获意外丢失（如元素被隐藏）时也要松键，避免卡死在按下状态
        this.touchHeld.delete(act);
        this.down.delete(act);
        btn.classList.remove('on');
      });
      btn.addEventListener('pointerleave', (e) => { if (e.buttons === 0) release(e); });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }

  _bindGamepad() {
    this.gp = null;
    this.gpPrev = [];
    this.gpAxisPrev = 0;
    window.addEventListener('gamepadconnected', (e) => {
      this.gp = e.gamepad;
      this.lastDevice = 'gamepad';
    });
    window.addEventListener('gamepaddisconnected', () => { this.gp = null; });
  }

  _pollGamepad() {
    if (!this.gp) {
      const gps = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const g of gps) { if (g) { this.gp = g; break; } }
    }
    if (!this.gp) return;
    const gp = this.gp;
    const map = [
      [0, 'jump'], [2, 'attack'], [3, 'skill'], [1, 'dash'],
      [4, 'swap'], [5, 'swap'], [7, 'ult'], [9, 'pause'],
    ];
    for (const [btn, act] of map) {
      const now = !!(gp.buttons[btn] && gp.buttons[btn].pressed);
      const was = !!this.gpPrev[btn];
      if (now && !was) {
        this.lastDevice = 'gamepad';
        if (!this.down.has(act)) this.pressedSet.add(act);
        this.down.add(act);
      } else if (!now && was) {
        this.down.delete(act);
        this.releasedSet.add(act);
      }
      this.gpPrev[btn] = now;
    }
    const ax = gp.axes[0] || 0;
    if (Math.abs(ax) > .3) {
      const dir = ax > 0 ? 'right' : 'left';
      const other = ax > 0 ? 'left' : 'right';
      if (!this.down.has(dir)) this.pressedSet.add(dir);
      this.down.add(dir);
      this.down.delete(other);
      this.gpAxis = ax;
    } else if (this.gpAxis && Math.abs(this.gpAxis) > .3) {
      this.down.delete('left');
      this.down.delete('right');
      this.gpAxis = 0;
    }
    // 十字键
    const dpad = [[12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
    for (const [btn, act] of dpad) {
      const now = !!(gp.buttons[btn] && gp.buttons[btn].pressed);
      const was = !!this.gpPrev['d' + btn];
      if (now && !was) { this.pressedSet.add(act); this.down.add(act); }
      if (!now && was) { this.down.delete(act); this.releasedSet.add(act); }
      this.gpPrev['d' + btn] = now;
    }
  }

  axisX() {
    let v = 0;
    if (this.down.has('left')) v -= 1;
    if (this.down.has('right')) v += 1;
    if (Math.abs(this.touchX) > .16) v = this.touchX;
    if (this.gp && Math.abs(this.gp.axes[0] || 0) > .25) v = this.gp.axes[0];
    return Math.max(-1, Math.min(1, v));
  }
  axisY() {
    let v = 0;
    if (this.down.has('up')) v -= 1;
    if (this.down.has('down')) v += 1;
    if (Math.abs(this.touchY) > .3) v = this.touchY;
    return Math.max(-1, Math.min(1, v));
  }

  downState(a) { return this.down.has(a); }
  pressed(a) { return this.pressedSet.has(a); }
  released(a) { return this.releasedSet.has(a); }
  consume(a) { if (!this.pressedSet.has(a)) return false; this.pressedSet.delete(a); return true; }

  update() {
    this._pollGamepad();
  }
  endFrame() {
    this.pressedSet.clear();
    this.releasedSet.clear();
  }
  // 命中停顿帧专用：把本帧按键暂存起来，下一逻辑帧再兑现（超过 .26s 的陈旧输入丢弃）
  stash() {
    if (!this.pressedSet.size) return;
    const now = performance.now();
    for (const a of this.pressedSet) this.holdover.set(a, now);
    this.pressedSet.clear();
    this.releasedSet.clear();
  }
  replay() {
    if (!this.holdover.size) return;
    const now = performance.now();
    for (const [a, t] of this.holdover) {
      if (now - t >= 260) this.holdover.delete(a);
      else this.pressedSet.add(a);
    }
  }
  // 主循环真正跑过逻辑帧后调用：暂存的输入已被兑现，防止重复触发
  consumeHoldover() {
    this.holdover.clear();
  }
  clear() {
    this.down.clear();
    this.pressedSet.clear();
    this.releasedSet.clear();
    this.touchHeld.clear();
    this.holdover.clear();
  }
}

export const Input = new InputSys();
window.__input = Input;
