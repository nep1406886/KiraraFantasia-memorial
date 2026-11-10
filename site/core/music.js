// Two live music channels, one cancellable transition, and at most three cached tracks.
export class MusicBus {
    constructor(urlFor, onError = () => {}) {
        this.urlFor = urlFor;
        this.onError = onError;
        this.audio = new Audio();
        this.track = null;
        this.outgoing = null;
        this.cache = new Map();
        this.volume = .5;
        this.duck = 1;
        this.suspended = false;
        this.disposed = false;
        this.request = 0;
        this.timer = null;
        this.stopping = false;
    }

    preload(track) {
        if (this.disposed) return null;
        let audio = this.cache.get(track);
        if (!audio) {
            audio = new Audio(this.urlFor(track));
            audio.preload = "auto";
            this.cache.set(track, audio);
        }
        for (const [key, old] of this.cache) {
            if (this.cache.size <= 3) break;
            if (old === this.audio || old === this.outgoing || old === audio) continue;
            old.pause(); old.removeAttribute("src"); old.load();
            this.cache.delete(key);
        }
        return audio;
    }

    cancelFade() {
        clearInterval(this.timer);
        this.timer = null;
    }

    fade(duration = 600, stopping = false) {
        this.cancelFade();
        this.stopping = stopping;
        const audio = this.audio, old = this.outgoing;
        const start = audio.volume, previous = old?.volume || 0;
        const target = stopping ? 0 : this.volume * this.duck;
        const began = performance.now();
        const tick = () => {
            const t = duration > 0 ? Math.min(1, (performance.now() - began) / duration) : 1;
            const eased = t * t * (3 - 2 * t);
            audio.volume = Math.max(0, Math.min(1, start + (target - start) * eased));
            if (old) old.volume = previous * (1 - eased);
            if (t < 1) return;
            this.cancelFade();
            if (old) old.pause();
            this.outgoing = null;
            if (stopping) { audio.pause(); this.track = null; }
            this.stopping = false;
        };
        if (duration > 0) this.timer = setInterval(tick, 25);
        tick();
    }

    async play(track, { loop = true, fade = 700 } = {}) {
        if (this.disposed || !track) return;
        if (track !== this.track) {
            this.cancelFade();
            this.outgoing?.pause();
            this.outgoing = this.audio.src && !this.audio.paused ? this.audio : null;
            this.audio = this.preload(track);
            this.audio.currentTime = 0;
            this.audio.volume = 0;
            this.track = track;
        } else if (!this.audio.paused && !this.stopping) return;
        this.audio.loop = loop;
        if (this.suspended) return;
        const audio = this.audio, request = ++this.request;
        try {
            await audio.play();
            if (request !== this.request || this.suspended || this.disposed) {
                if (this.suspended || this.disposed || audio !== this.audio && audio !== this.outgoing) audio.pause();
                return;
            }
            this.fade(fade);
        } catch (error) {
            if (request === this.request && error.name !== "AbortError") {
                this.outgoing?.pause(); this.outgoing = null;
                this.onError(error);
            }
        }
    }

    setVolume(value, duck = this.duck) {
        this.volume = Math.max(0, Math.min(1, value));
        this.duck = Math.max(0, Math.min(1, duck));
        if (!this.audio.paused && !this.suspended && !this.stopping) this.fade(220);
    }

    suspend(value) {
        if (this.suspended === value || this.disposed) return;
        this.suspended = value;
        if (value) {
            this.request++; this.cancelFade();
            this.outgoing?.pause(); this.outgoing = null;
            this.audio.pause();
        } else if (this.track) {
            this.audio.volume = 0;
            this.play(this.track, { loop: this.audio.loop, fade: 250 });
        }
    }

    stop(duration = 700) {
        this.request++;
        this.fade(this.suspended ? 0 : duration, true);
    }

    dispose() {
        this.disposed = true;
        this.request++; this.cancelFade();
        for (const audio of new Set([this.audio, this.outgoing, ...this.cache.values()])) {
            if (!audio) continue;
            audio.pause(); audio.removeAttribute("src"); audio.load();
        }
        this.cache.clear(); this.outgoing = null; this.track = null;
    }
}
