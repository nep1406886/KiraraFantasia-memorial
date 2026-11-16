// Local original BGM (crossfaded) + small synthesized SFX palette.
// The site ships the original mp3 cues; combat SE were never included, so the
// short sounds here are generated instead of hotlinked.

const BGM_BASE = "../../audio/bgm/";
const FADE_MS = 900;

export class AudioSys {
  constructor(settings = {}) {
    this.bgmVolume = Number(settings.bgm ?? 0.55);
    this.sfxVolume = Number(settings.sfx ?? 0.68);
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.noiseBuffer = null;
    this.voices = 0;
    this.unlocked = false;
    this.muted = false;
    this.track = null;
    this.elements = [];
    this.fadeTimer = 0;
    this.current = null;
  }

  unlock() {
    if (this.unlocked) {
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return;
    }
    this.unlocked = true;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 18;
      comp.ratio.value = 5;
      comp.attack.value = 0.004;
      comp.release.value = 0.18;
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxVolume * 0.62;
      this.sfxBus.connect(comp);
      comp.connect(this.master);
      this.master.connect(this.ctx.destination);
      const length = Math.floor(this.ctx.sampleRate * 0.7);
      this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        last = last * 0.72 + white * 0.28;
        data[i] = last;
      }
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      if (this.current && this.current.el.paused) this.current.el.play().catch(() => {});
    } catch (error) {
      console.warn("starfall audio unavailable:", error);
    }
  }

  setVolumes({ bgm, sfx } = {}) {
    if (Number.isFinite(bgm)) this.bgmVolume = Math.min(1, Math.max(0, bgm));
    if (Number.isFinite(sfx)) this.sfxVolume = Math.min(1, Math.max(0, sfx));
    if (this.sfxBus) this.sfxBus.gain.value = this.sfxVolume * 0.62;
    if (this.current && this.current.el) this.current.el.volume = this.bgmVolume * 0.5;
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 1;
    for (const el of this.elements) el.muted = this.muted;
  }

  playBgm(name, { restart = false } = {}) {
    if (!name) return;
    if (this.current && this.current.name === name && !restart) {
      if (this.current.el.paused) this.current.el.play().catch(() => {});
      return;
    }
    this.ensureElement();
    const next = this.elements.find(el => el.dataset.free === "1" || el.dataset.track === name);
    if (!next) return;
    const old = this.current;
    next.dataset.track = name;
    next.dataset.free = "0";
    next.src = BGM_BASE + "bgm_" + name + "_0.mp3";
    next.loop = true;
    next.volume = 0;
    next.muted = this.muted;
    const playPromise = next.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
    const token = ++this.fadeTimer;
    const started = performance.now();
    if (this._fade) clearInterval(this._fade);
    this._fade = setInterval(() => {
      if (token !== this.fadeTimer) { clearInterval(this._fade); return; }
      const p = Math.min(1, (performance.now() - started) / FADE_MS);
      next.volume = Math.min(1, this.bgmVolume * 0.5 * p);
      if (old && old.el && old.el !== next) {
        old.el.volume = Math.min(1, this.bgmVolume * 0.5 * (1 - p));
        if (p >= 1) {
          old.el.pause();
          old.el.dataset.free = "1";
          old.el.removeAttribute("src");
        }
      }
      if (p >= 1) clearInterval(this._fade);
    }, 40);
    this.current = { name, el: next };
    this.track = name;
  }

  ensureElement() {
    if (this.elements.length) return;
    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.preload = "auto";
      el.dataset.free = "1";
      el.crossOrigin = "anonymous";
      this.elements.push(el);
    }
  }

  stopBgm(fade = true) {
    const old = this.current;
    this.current = null;
    if (!old) return;
    if (!fade) {
      old.el.pause();
      old.el.dataset.free = "1";
      old.el.removeAttribute("src");
      return;
    }
    const started = performance.now();
    const startVolume = old.el.volume;
    const timer = setInterval(() => {
      const p = Math.min(1, (performance.now() - started) / 500);
      old.el.volume = startVolume * (1 - p);
      if (p >= 1) {
        clearInterval(timer);
        old.el.pause();
        old.el.dataset.free = "1";
        old.el.removeAttribute("src");
      }
    }, 40);
  }

  suspendBgm() {
    if (this.current && !this.current.el.paused) this.current.el.pause();
  }

  resumeBgm() {
    if (this.current && this.current.el.paused) this.current.el.play().catch(() => {});
  }

  // ---------------------------------------------------------------- FX
  tone({ freq = 440, to = null, dur = 0.14, type = "sine", gain = 0.3, delay = 0, attack = 0.005 }) {
    if (!this.ctx || !this.sfxBus || this.voices > 26) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), t0);
    if (to != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env);
    env.connect(this.sfxBus);
    this.voices++;
    osc.onended = () => { this.voices = Math.max(0, this.voices - 1); };
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  noise({ dur = 0.14, gain = 0.22, freq = 1400, q = 0.8, delay = 0, type = "bandpass" }) {
    if (!this.ctx || !this.sfxBus || !this.noiseBuffer || this.voices > 26) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.36), t0 + dur);
    filter.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(env);
    env.connect(this.sfxBus);
    this.voices++;
    src.onended = () => { this.voices = Math.max(0, this.voices - 1); };
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  sfx(name) {
    if (!this.ctx || this.muted) return;
    switch (name) {
      case "jump":
        this.tone({ freq: 330, to: 620, dur: 0.13, type: "triangle", gain: 0.2 });
        break;
      case "doubleJump":
        this.tone({ freq: 480, to: 880, dur: 0.15, type: "triangle", gain: 0.18 });
        this.tone({ freq: 720, to: 1180, dur: 0.12, type: "sine", gain: 0.1, delay: 0.05 });
        break;
      case "dash":
        this.noise({ dur: 0.22, gain: 0.2, freq: 1900, q: 0.7 });
        this.tone({ freq: 520, to: 220, dur: 0.12, type: "sine", gain: 0.1 });
        break;
      case "slash":
        this.noise({ dur: 0.1, gain: 0.18, freq: 2600, q: 1.1 });
        this.tone({ freq: 820, to: 410, dur: 0.08, type: "triangle", gain: 0.1 });
        break;
      case "hit":
        this.tone({ freq: 190, to: 90, dur: 0.09, type: "square", gain: 0.13 });
        this.noise({ dur: 0.07, gain: 0.14, freq: 900, q: 0.8 });
        break;
      case "crit":
        this.tone({ freq: 920, to: 460, dur: 0.12, type: "square", gain: 0.12 });
        this.tone({ freq: 1380, to: 890, dur: 0.1, type: "sine", gain: 0.09, delay: 0.02 });
        break;
      case "hurt":
        this.tone({ freq: 230, to: 74, dur: 0.28, type: "sawtooth", gain: 0.15 });
        this.noise({ dur: 0.2, gain: 0.16, freq: 620 });
        break;
      case "coin":
        this.tone({ freq: 1046, dur: 0.07, type: "sine", gain: 0.12 });
        this.tone({ freq: 1568, dur: 0.1, type: "sine", gain: 0.1, delay: 0.06 });
        break;
      case "card":
        this.tone({ freq: 660, dur: 0.16, type: "sine", gain: 0.12 });
        this.tone({ freq: 990, dur: 0.2, type: "sine", gain: 0.1, delay: 0.07 });
        this.tone({ freq: 1320, dur: 0.3, type: "sine", gain: 0.08, delay: 0.14 });
        break;
      case "door":
        this.tone({ freq: 120, to: 60, dur: 0.4, type: "sine", gain: 0.18 });
        this.tone({ freq: 880, to: 1320, dur: 0.4, type: "sine", gain: 0.06, delay: 0.08 });
        break;
      case "skill":
        this.tone({ freq: 300, to: 760, dur: 0.24, type: "triangle", gain: 0.14 });
        this.noise({ dur: 0.3, gain: 0.12, freq: 1800 });
        break;
      case "ult":
        this.tone({ freq: 160, to: 640, dur: 0.55, type: "sawtooth", gain: 0.1 });
        this.tone({ freq: 320, to: 1280, dur: 0.5, type: "sine", gain: 0.12, delay: 0.06 });
        this.noise({ dur: 0.65, gain: 0.2, freq: 1200, delay: 0.1 });
        break;
      case "heal":
        this.tone({ freq: 660, dur: 0.22, type: "sine", gain: 0.1 });
        this.tone({ freq: 880, dur: 0.26, type: "sine", gain: 0.09, delay: 0.08 });
        this.tone({ freq: 1174, dur: 0.42, type: "sine", gain: 0.07, delay: 0.16 });
        break;
      case "death":
        this.tone({ freq: 300, to: 70, dur: 0.8, type: "triangle", gain: 0.15 });
        break;
      case "wave":
        this.tone({ freq: 196, dur: 0.3, type: "sine", gain: 0.1 });
        this.tone({ freq: 392, dur: 0.4, type: "sine", gain: 0.08, delay: 0.05 });
        break;
      case "boss":
        this.tone({ freq: 82, dur: 0.7, type: "sawtooth", gain: 0.13 });
        this.tone({ freq: 123, dur: 0.9, type: "sine", gain: 0.1, delay: 0.1 });
        this.noise({ dur: 0.5, gain: 0.12, freq: 400, delay: 0.1 });
        break;
      case "click":
        this.tone({ freq: 660, dur: 0.05, type: "sine", gain: 0.09 });
        break;
      case "buy":
        this.tone({ freq: 523, dur: 0.08, type: "sine", gain: 0.1 });
        this.tone({ freq: 784, dur: 0.12, type: "sine", gain: 0.1, delay: 0.06 });
        this.tone({ freq: 1046, dur: 0.18, type: "sine", gain: 0.08, delay: 0.12 });
        break;
      case "error":
        this.tone({ freq: 220, to: 180, dur: 0.16, type: "square", gain: 0.08 });
        break;
      case "page":
        this.noise({ dur: 0.28, gain: 0.14, freq: 2100, q: 0.5 });
        break;
      case "star":
        this.tone({ freq: 1320, dur: 0.08, type: "sine", gain: 0.06 });
        break;
      default:
        break;
    }
  }
}
