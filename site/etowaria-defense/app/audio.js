import { siteUrl } from "./assets.js";
import { MusicBus } from "../../core/music.js";
import { suspendSe } from "../../core/audio.js";

const KEY = "etowaria-defense.p0.settings.v1";
const DEFAULTS = { music: true, musicVolume: 0.35, voice: true, seVolume: 0.7, reducedMotion: false };
// dawn（第五章）起用原作 adv 曲：城镇屏听 bgm_adv_10，战斗听 bgm_adv_9——
// 两首都是曲目库里的闲置原作曲，之前从未进过塔防。
const THEMES = { day: "bgm_town_1", camp: "bgm_town_3", water: "bgm_town_2", night: "bgm_town_3", dawn: "bgm_adv_10" };

export class AudioDirector {
    constructor(onNotice = () => {}) {
        this.onNotice = onNotice;
        this.settings = { ...DEFAULTS };
        try {
            const saved = JSON.parse(localStorage.getItem(KEY) || "null");
            if (saved && typeof saved === "object") {
                for (const key of ["music", "voice", "reducedMotion"]) {
                    if (typeof saved[key] === "boolean") { this.settings[key] = saved[key]; }
                }
                if (Number.isFinite(saved.musicVolume)) {
                    this.settings.musicVolume = Math.max(0, Math.min(1, saved.musicVolume));
                }
                if (Number.isFinite(saved.seVolume)) {
                    this.settings.seVolume = Math.max(0, Math.min(1, saved.seVolume));
                }
            }
        } catch { /* A malformed preference never removes progress from another game. */ }
        this.music = new MusicBus(cue => siteUrl(`audio/bgm/${cue}_0.mp3`),
            () => this.onNotice("音乐暂未开始播放，可在声音设置中重新开启。"));
        this.music.suspend(true);
        this.voice = new Audio();
        this.voice.preload = "none";
        this.unlocked = false;
        this.silent = false;
        this.voiceRequest = 0;
        this.suspended = false;
        this.track = "";
        this.theme = "day";
        this.cinematic = false;
        this.voice.addEventListener("ended", () => this.applyVolumes());
        this.voice.addEventListener("playing", () => this.applyVolumes());
        this.voice.addEventListener("error", () => this.applyVolumes());
    }

    get bgm() { return this.music.audio; }

    unlock() {
        this.unlocked = true;
        return this.track ? this.syncPlayback() : this.playTheme(this.theme);
    }

    updateSettings(patch) {
        Object.assign(this.settings, patch);
        try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch { /* Storage can be unavailable. */ }
        if (!this.settings.voice) { this.stopVoice(); }
        this.applyVolumes();
        this.syncPlayback();
    }

    applyVolumes() {
        // While a voice line plays, BGM ducks to half so the line reads.
        const duck = this.voice.paused ? 1 : 0.5;
        this.music.setVolume(this.settings.musicVolume, duck);
        this.voice.volume = 0.8;
    }

    async playTheme(theme) {
        this.theme = theme;
        return this.setTrack(THEMES[theme] || THEMES.day);
    }

    preload(cue) {
        return this.music.preload(cue);
    }

    async setTrack(cue) {
        this.track = cue;
        this.applyVolumes();
        return this.syncPlayback();
    }

    async syncPlayback() {
        const paused = this.silent || !this.unlocked || !this.settings.music || this.suspended || this.cinematic;
        this.music.suspend(paused);
        if (this.track) return this.music.play(this.track, { loop: this.track !== "bgm_battle_win" });
    }

    suspend(value) {
        this.suspended = value;
        suspendSe(value);
        if (value) { this.stopVoice(); }
        this.syncPlayback();
    }

    beginCinematic() {
        this.cinematic = true;
        this.syncPlayback();
        this.stopVoice();
    }

    endCinematic() {
        this.cinematic = false;
        this.stopVoice();
        this.syncPlayback();
    }

    // Bridge to the shared synth for PVZ-style defense cues (plant/shovel/gate).
    // The synth keeps its own volume knob in core/audio.js; mirror the user's
    // SE slider into it so one slider rules both.
    se(name, options) {
        if (this.silent || this.suspended || !this.unlocked) return;
        if (globalThis.__defenseSEVolume) { globalThis.__defenseSEVolume(this.settings.seVolume); }
        if (globalThis.__defenseSE) { globalThis.__defenseSE(name, options); }
    }

    async playVoice(row, cue) {
        if (this.silent || !this.settings.voice || !this.unlocked || this.suspended) { return; }
        const file = row?.cues?.[cue];
        if (!file) { return; }
        const request = ++this.voiceRequest;
        this.voice.pause();
        this.voice.src = siteUrl(`audio/voice/${file}`);
        this.applyVolumes();
        try { await this.voice.play(); }
        catch (error) {
            if (error.name !== "AbortError" && request === this.voiceRequest) { this.onNotice("这一段原作语音未能播放。"); }
        }
    }

    stopVoice() {
        this.voiceRequest++;
        this.voice.pause();
        this.voice.removeAttribute("src");
        this.voice.load();
        this.applyVolumes();
    }

    dispose() {
        this.stopVoice();
        this.music.dispose();
    }
}
