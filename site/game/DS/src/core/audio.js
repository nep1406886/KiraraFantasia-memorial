// ============================================================
// 音频：原作 BGM 交叉淡入 + WebAudio 合成音效
// ============================================================
import { AUDIO } from '../config.js';

class AudioSys {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.comp = null;
    this.noiseBuf = null;
    this.musicVol = .62;
    this.sfxVol = .78;
    this.muted = false;
    this.tracks = [null, null];
    this.cur = 0;
    this.curName = '';
    this.fadeTimers = [];
    this.lastAt = new Map();
    this.ducked = false;
    this.unlocked = false;
    this._pendingMusic = null;
  }

  init(settings) {
    if (settings) {
      this.musicVol = settings.music ?? .62;
      this.sfxVol = settings.sfx ?? .78;
    }
    // 首次手势时解锁
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });
    window.addEventListener('touchstart', unlock, { once: true, capture: true });
  }

  ensureCtx() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      this.ctx = new AC();
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16;
      this.comp.knee.value = 18;
      this.comp.ratio.value = 6;
      this.comp.attack.value = .003;
      this.comp.release.value = .22;
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.sfxVol;
      this.sfxGain.connect(this.comp);
      this.comp.connect(this.master);
      this.master.connect(this.ctx.destination);
      // noise buffer
      const len = this.ctx.sampleRate * 1.2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    } catch (e) {
      this.ctx = null;
    }
    return this.ctx;
  }

  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.ensureCtx();
    if (this._pendingMusic) {
      const p = this._pendingMusic;
      this._pendingMusic = null;
      this.playMusic(p);
    }
    for (const t of this.tracks) {
      if (t && t.dataset.want === '1' && t.paused) t.play().catch(() => {});
    }
  }

  setMusicVolume(v) {
    this.musicVol = v;
    for (const t of this.tracks) {
      if (t) t.volume = this._trackVolume(t);
    }
  }
  setSfxVolume(v) {
    this.sfxVol = v;
    if (this.sfxGain) this.sfxGain.gain.value = this.muted ? 0 : v;
  }
  setMuted(m) {
    this.muted = m;
    for (const t of this.tracks) if (t) t.volume = this._trackVolume(t);
    if (this.sfxGain) this.sfxGain.gain.value = m ? 0 : this.sfxVol;
  }
  _trackVolume(t) {
    const base = t._targetVol ?? this.musicVol;
    return this.muted ? 0 : base * (this.ducked ? .35 : 1);
  }

  _makeTrack(i) {
    const a = document.createElement('audio');
    a.loop = true;
    a.preload = 'auto';
    a.volume = 0;
    a.dataset.want = '0';
    this.tracks[i] = a;
    return a;
  }

  playMusic(name, opts = {}) {
    if (!name) return;
    if (this.curName === name && this.tracks[this.cur] && !this.tracks[this.cur].paused) return;
    if (!this.unlocked) {
      this._pendingMusic = name;
      this.curName = name;
      return;
    }
    this.curName = name;
    const targetVol = (opts.volume ?? 1) * this.musicVol;
    const idx = 1 - this.cur;
    let next = this.tracks[idx];
    if (!next) next = this._makeTrack(idx);
    const old = this.tracks[this.cur];
    const src = AUDIO + name;
    if (next.src !== new URL(src, location.href).href) {
      next.src = src;
    }
    next.dataset.want = '1';
    next._targetVol = targetVol;
    next.volume = 0;
    next.currentTime = 0;
    const p = next.play();
    if (p && p.catch) p.catch(() => {});
    this.cur = idx;
    this._fadeTo(next, targetVol, opts.fade ?? 1.4);
    if (old && old !== next) {
      old.dataset.want = '0';
      this._fadeTo(old, 0, opts.fade ?? 1.4, true);
    }
  }

  _fadeTo(el, target, seconds, stop = false) {
    if (!el) return;
    const start = el.volume;
    const t0 = performance.now();
    const dur = Math.max(80, seconds * 1000);
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const v = start + (target - start) * t;
      el.volume = Math.max(0, Math.min(1, this.muted ? 0 : v));
      if (t < 1) requestAnimationFrame(tick);
      else if (stop) el.pause();
    };
    requestAnimationFrame(tick);
  }

  stopMusic(fade = 1) {
    for (const t of this.tracks) {
      if (!t) continue;
      t.dataset.want = '0';
      this._fadeTo(t, 0, fade, true);
    }
    this.curName = '';
  }

  duck(on) {
    this.ducked = on;
    for (const t of this.tracks) if (t) t.volume = this._trackVolume(t);
  }

  // ---------------- 合成音效 ----------------
  _tone(type, f0, f1, dur, gain, when = 0, dest = null) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(.0002, gain), t + .008);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(g);
    g.connect(dest || this.sfxGain);
    o.start(t);
    o.stop(t + dur + .02);
  }

  _noise(dur, gain, filterType, f0, f1, when = 0, q = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf) return;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(40, f0), t);
    if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(.0002, gain), t + .006);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxGain);
    src.start(t, Math.random() * .3);
    src.stop(t + dur + .02);
  }

  sfx(name, opts = {}) {
    if (!this.unlocked || this.muted || this.sfxVol <= 0.001) return;
    if (!this.ensureCtx()) return;
    const now = performance.now();
    const gap = opts.gap ?? 32;
    const last = this.lastAt.get(name) || 0;
    if (now - last < gap) return;
    this.lastAt.set(name, now);
    const vol = (opts.volume ?? 1) * (opts.pitch ?? 1);
    switch (name) {
      case 'ui':
        this._tone('sine', 720, 760, .05, .035 * vol);
        this._tone('sine', 1080, 1120, .06, .025 * vol, .03);
        break;
      case 'hover':
        this._tone('sine', 420, 460, .035, .018 * vol);
        break;
      case 'slash':
        this._noise(.09, .10 * vol, 'highpass', 1400, 3200, 0, .8);
        this._tone('sawtooth', 420, 130, .08, .022 * vol);
        break;
      case 'slash2':
        this._noise(.11, .12 * vol, 'highpass', 1000, 2600, 0, .7);
        this._tone('triangle', 340, 120, .1, .028 * vol);
        break;
      case 'heavy':
        this._noise(.16, .14 * vol, 'lowpass', 900, 260, 0, .7);
        this._tone('sine', 110, 42, .18, .10 * vol);
        break;
      case 'hit':
        this._tone('square', 210, 70, .055, .028 * vol);
        this._noise(.05, .05 * vol, 'bandpass', 900, 500, 0, 1.6);
        break;
      case 'crit':
        this._tone('triangle', 1500, 380, .12, .05 * vol);
        this._tone('sine', 2400, 1800, .08, .025 * vol, .01);
        this._noise(.06, .045 * vol, 'highpass', 2600, 4200, 0, .8);
        break;
      case 'shoot':
        this._tone('square', 900, 240, .06, .022 * vol);
        this._noise(.04, .022 * vol, 'highpass', 1800, 2600, 0, .7);
        break;
      case 'magic':
        this._tone('sine', 320, 1180, .16, .035 * vol);
        this._tone('triangle', 640, 1600, .14, .018 * vol, .02);
        break;
      case 'orb':
        this._tone('sine', 500, 900, .1, .03 * vol);
        break;
      case 'dash':
        this._noise(.18, .09 * vol, 'bandpass', 420, 1900, 0, .9);
        this._tone('sine', 180, 420, .12, .02 * vol);
        break;
      case 'jump':
        this._tone('sine', 300, 640, .12, .03 * vol);
        break;
      case 'land':
        this._noise(.1, .05 * vol, 'lowpass', 380, 120, 0, .8);
        this._tone('sine', 92, 48, .1, .045 * vol);
        break;
      case 'coin':
        this._tone('sine', 880, 880, .07, .03 * vol);
        this._tone('sine', 1320, 1320, .1, .026 * vol, .06);
        break;
      case 'heal':
        this._tone('sine', 523, 523, .2, .028 * vol);
        this._tone('sine', 659, 659, .22, .022 * vol, .07);
        this._tone('sine', 784, 784, .26, .018 * vol, .14);
        break;
      case 'switch':
        this._noise(.16, .07 * vol, 'bandpass', 700, 2400, 0, 1.2);
        this._tone('sine', 660, 990, .12, .03 * vol, .05);
        break;
      case 'ult':
        this._tone('sine', 98, 196, .7, .09 * vol);
        this._tone('triangle', 196, 784, .55, .035 * vol, .05);
        this._noise(.5, .05 * vol, 'highpass', 500, 3200, 0, .6);
        break;
      case 'explode':
        this._noise(.42, .15 * vol, 'lowpass', 900, 90, 0, .8);
        this._tone('sine', 82, 36, .4, .12 * vol);
        break;
      case 'parry':
        this._tone('triangle', 1760, 1760, .18, .05 * vol);
        this._tone('sine', 2640, 2640, .24, .03 * vol, .01);
        this._noise(.08, .04 * vol, 'highpass', 3000, 6000, 0, .8);
        break;
      case 'reaction':
        this._tone('sine', 660, 990, .12, .03 * vol);
        this._tone('sine', 990, 1320, .14, .022 * vol, .06);
        break;
      case 'death':
        this._tone('sawtooth', 240, 44, .5, .05 * vol);
        this._noise(.3, .04 * vol, 'lowpass', 600, 100, 0, .8);
        break;
      case 'door':
        this._noise(.35, .05 * vol, 'bandpass', 900, 240, 0, 1.6);
        this._tone('sine', 160, 110, .3, .025 * vol);
        break;
      case 'pickup':
        this._tone('sine', 784, 1046, .12, .026 * vol);
        this._tone('sine', 1046, 1318, .16, .02 * vol, .06);
        break;
      case 'beam':
        this._tone('sawtooth', 220, 880, .25, .05 * vol);
        this._noise(.18, .05 * vol, 'highpass', 1200, 3600, 0, .8);
        break;
      case 'warning':
        this._tone('square', 220, 220, .1, .02 * vol);
        break;
      case 'boss':
        this._tone('sawtooth', 55, 48, 1.2, .09 * vol);
        this._tone('sine', 110, 82, 1.4, .05 * vol);
        this._noise(.8, .03 * vol, 'lowpass', 300, 80, 0, .7);
        break;
      case 'phase':
        this._tone('triangle', 130, 260, .6, .06 * vol);
        this._noise(.5, .05 * vol, 'highpass', 600, 2400, 0, .8);
        break;
      case 'victory':
        this._tone('sine', 523, 523, .3, .04 * vol);
        this._tone('sine', 659, 659, .3, .035 * vol, .12);
        this._tone('sine', 784, 784, .32, .03 * vol, .24);
        this._tone('sine', 1046, 1046, .6, .03 * vol, .36);
        break;
      default:
        this._tone('sine', 440, 440, .05, .02 * vol);
    }
  }
}

export const Audio = new AudioSys();
