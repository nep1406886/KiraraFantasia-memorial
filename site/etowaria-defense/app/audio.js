import { siteUrl } from "./assets.js";

const KEY = "etowaria-defense.p0.settings.v1";
const DEFAULTS = { music: true, musicVolume: 0.35, voice: true, reducedMotion: false };
const THEMES = { day: "bgm_town_1", camp: "bgm_town_3", water: "bgm_town_2" };

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
            }
        } catch { /* A malformed preference never removes progress from another game. */ }
        this.bgm = new Audio();
        this.bgm.loop = true;
        this.bgm.preload = "none";
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
    }

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
        const duck = this.voice.paused ? 1 : 0.5;
        this.bgm.volume = this.settings.musicVolume * duck;
        this.voice.volume = 0.8;
    }

    async playTheme(theme) {
        this.theme = theme;
        return this.setTrack(THEMES[theme] || THEMES.day);
    }

    async setTrack(cue) {
        this.bgm.loop = cue !== "bgm_battle_win";
        if (this.track !== cue) {
            this.track = cue;
            this.bgm.src = siteUrl(`audio/bgm/${cue}_0.mp3`);
        }
        this.applyVolumes();
        return this.syncPlayback();
    }

    async syncPlayback() {
        if (this.silent || !this.unlocked || !this.settings.music || this.suspended || this.cinematic) {
            this.bgm.pause();
            return;
        }
        if (this.bgm.src && this.bgm.paused) {
            const track = this.track;
            try { await this.bgm.play(); }
            catch (error) {
                if (error.name !== "AbortError" && track === this.track && !this.suspended && !this.cinematic && this.settings.music) {
                    this.onNotice("音乐暂未开始播放，可在声音设置中重新开启。");
                }
            }
        }
    }

    suspend(value) {
        this.suspended = value;
        if (value) { this.stopVoice(); }
        this.syncPlayback();
    }

    beginCinematic() {
        this.cinematic = true;
        this.bgm.pause();
        this.stopVoice();
    }

    endCinematic() {
        this.cinematic = false;
        this.stopVoice();
        this.syncPlayback();
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
        this.bgm.pause();
        this.bgm.removeAttribute("src");
        this.bgm.load();
        this.stopVoice();
    }
}
