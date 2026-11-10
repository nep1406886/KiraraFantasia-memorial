import assert from 'node:assert/strict';
import { MusicBus } from '../site/core/music.js';

let now = 0, nextTimer = 1;
const timers = new Map(), instances = [];
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });
globalThis.setInterval = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
globalThis.clearInterval = id => timers.delete(id);
globalThis.Audio = class {
    constructor(src = '') { this.src = src; this.paused = true; this.volume = 1; this.currentTime = 0; instances.push(this); }
    play() { this.paused = false; return this.pending || Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() {}
};
const tick = ms => { now += ms; for (const fn of [...timers.values()]) fn(); };
const errors = [], bus = new MusicBus(track => '/local/' + track + '.mp3', error => errors.push(error));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }

await test('切曲时两轨平滑交叉，完成后只有新轨播放', async () => {
    await bus.play('town', { fade: 0 }); const old = bus.audio;
    await bus.play('battle', { fade: 600 });
    tick(300); assert.equal(old.paused, false); assert.equal(old.volume, .25); assert.equal(bus.audio.volume, .25);
    tick(300); assert.equal(old.paused, true); assert.equal(bus.audio.volume, .5); assert.equal(timers.size, 0);
});
await test('重复请求不重置播放位置，胜利曲不循环', async () => {
    bus.audio.currentTime = 17; await bus.play('battle'); assert.equal(bus.audio.currentTime, 17);
    await bus.play('victory', { loop: false, fade: 0 }); assert.equal(bus.audio.loop, false);
});
await test('快速连切始终至多两条活跃音轨，缓存上限三首', async () => {
    for (let i = 0; i < 15; i++) {
        await bus.play('track-' + i); tick(50);
        assert(instances.filter(row => !row.paused).length <= 2); assert(bus.cache.size <= 3);
    }
    tick(800); assert.equal(instances.filter(row => !row.paused).length, 1);
});
await test('语音压低音乐后可恢复，音量修改不会跳变', async () => {
    const initial = bus.audio.volume;
    bus.setVolume(.6, .45); assert.equal(bus.audio.volume, initial);
    tick(220); assert.equal(bus.audio.volume, .27);
    bus.setVolume(.6, 1); tick(220); assert.equal(bus.audio.volume, .6);
});
await test('暂停取消渐变、保持位置；后台选曲不会发声', async () => {
    bus.audio.currentTime = 23; bus.suspend(true); assert(instances.every(row => row.paused)); assert.equal(timers.size, 0);
    bus.suspend(false); await Promise.resolve(); tick(300); assert.equal(bus.audio.currentTime, 23);
    bus.suspend(true); await bus.play('hidden'); assert(bus.audio.paused);
    bus.suspend(false); await Promise.resolve(); tick(300); assert.equal(bus.track, 'hidden'); assert(!bus.audio.paused);
});
await test('迟到的播放承诺不能在暂停后恢复音乐', async () => {
    const track = bus.preload('pending'); let finish;
    track.pending = new Promise(resolve => { finish = resolve; });
    const job = bus.play('pending'); bus.suspend(true); finish(); await job;
    assert(track.paused); assert.equal(timers.size, 0); track.pending = null;
    bus.suspend(false); await Promise.resolve(); tick(300);
});
await test('淡出期间重播同曲取消停止，释放后无定时器或音轨', async () => {
    bus.stop(1000); tick(100); await bus.play('pending', { fade: 200 }); tick(300);
    assert.equal(bus.track, 'pending'); assert(!bus.audio.paused);
    bus.stop(100); tick(100); assert.equal(bus.track, null); assert(bus.audio.paused);
    bus.dispose(); bus.dispose(); assert.equal(timers.size, 0); assert(instances.every(row => row.paused)); assert.equal(bus.cache.size, 0);
    assert.deepEqual(errors, []);
});
await test('旧音乐接口保留手势门控、默认音量、重复播放和停止语义', async () => {
    const audio = await import('../site/core/audio.js'), count = instances.length;
    audio.setBgmVolume(.35); await audio.bgm('town');
    assert.equal(instances.length, count);
    audio.unlock(); await audio.bgm('town', { fade: 0 });
    const town = instances.at(-1);
    assert.equal(town.src, '../audio/bgm/town.mp3'); assert.equal(town.volume, .35);
    town.currentTime = 8; await audio.bgm('town'); assert.equal(town.currentTime, 8);
    await audio.bgm('victory', { fade: 400, loop: false }); tick(200);
    assert.equal(instances.filter(row => !row.paused).length, 2);
    assert.equal(instances.at(-1).loop, false);
    audio.stopBgm(100); tick(100);
    assert(instances.every(row => row.paused)); assert.equal(timers.size, 0);
});
console.log(`${passed}/${passed} music lifecycle checks passed`);
