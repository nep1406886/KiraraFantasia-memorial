#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = name => readFileSync(path.join(root, name), "utf8");
let checks = 0;
function check(name, run) {
    run();
    checks++;
    console.log(`PASS ${name}`);
}

class Events {
    listeners = new Map();
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, detail = {}) {
        for (const fn of this.listeners.get(type) || []) fn({ type, ...detail });
    }
    listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}

function pageEnvironment(base = "https://example.test/KiraraFantasia-memorial/") {
    const window = new Events();
    const document = new Events();
    let now = 1450;
    let id = 0;
    const timers = new Map();
    document.hidden = false;
    document.currentScript = { src: new URL("site/js/page-utils.js?v=test", base).href };
    window.setTimeout = (fn, delay) => {
        timers.set(++id, { fn, at: now + delay });
        return id;
    };
    window.clearTimeout = timer => timers.delete(timer);
    const context = vm.createContext({ window, document, URL, Date: { now: () => now }, console });
    vm.runInContext(source("site/js/page-utils.js"), context);
    return {
        window, document, context, timers,
        utils: window.kirafanPage,
        now: () => now,
        advance(ms) {
            const end = now + ms;
            for (let guard = 0; guard < 10000; guard++) {
                const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                now = next[1].at;
                timers.delete(next[0]);
                next[1].fn();
                if (guard === 9999) throw new Error("Timer did not settle");
            }
            now = end;
        }
    };
}

check("asset paths work at the domain root and under a Pages prefix", () => {
    for (const base of ["https://example.test/", "https://example.test/KiraraFantasia-memorial/"]) {
        const { assetUrl } = pageEnvironment(base).utils;
        assert.equal(assetUrl("imgs/kirara_b.png"), base + "site/imgs/kirara_b.png");
        assert.equal(assetUrl("site/imgs/kirara_b.png"), base + "site/imgs/kirara_b.png");
        assert.equal(assetUrl("./site/imgs/kirara_b.png"), base + "site/imgs/kirara_b.png");
        assert.equal(assetUrl("audio/bgm/bgm_Prologue_0.mp3"), base + "site/audio/bgm/bgm_Prologue_0.mp3");
        assert.equal(assetUrl("imgs/original-characters/Raine_StandPic_0.png"), base + "site/imgs/original-characters/Raine_StandPic_0.png");
        for (const value of ["https://asset.kirafan.cn/a.png", "//cdn.test/a.png", "/a.png", "data:image/png;base64,abc", "blob:https://example.test/id", "#anchor", ""]) {
            assert.equal(assetUrl(value), value);
        }
    }
});

check("rapid typing renders once; empty search and Enter flush immediately", () => {
    const env = pageEnvironment();
    const input = Object.assign(new Events(), { value: "" });
    const values = [];
    env.utils.bindSearch(input, value => values.push(value));
    input.value = "y";
    input.emit("input");
    env.advance(60);
    input.value = "yuno";
    input.emit("input");
    env.advance(139);
    assert.equal(values.length, 0);
    env.advance(1);
    assert.deepEqual(values, ["yuno"]);
    input.value = "";
    input.emit("input");
    assert.deepEqual(values, ["yuno", ""]);
    input.value = "爱丽丝";
    input.emit("input");
    input.emit("keydown", { key: "Enter" });
    assert.deepEqual(values, ["yuno", "", "爱丽丝"]);
    assert.equal(env.timers.size, 0);
});

check("IME composition never renders unfinished input or duplicate commits", () => {
    const env = pageEnvironment();
    const input = Object.assign(new Events(), { value: "" });
    const values = [];
    env.utils.bindSearch(input, value => values.push(value));
    input.value = "q";
    input.emit("input");
    input.emit("compositionstart");
    input.value = "qian";
    input.emit("input", { isComposing: true });
    input.emit("keydown", { key: "Enter", isComposing: true });
    env.advance(1000);
    assert.equal(values.length, 0);
    input.value = "千矢";
    input.emit("compositionend");
    input.emit("input");
    env.advance(1000);
    assert.deepEqual(values, ["千矢"]);
    assert.equal(env.timers.size, 0);
});

check("filter changes and cleanup cancel stale searches", () => {
    const env = pageEnvironment();
    const input = Object.assign(new Events(), { value: "" });
    const values = [];
    const search = env.utils.bindSearch(input, value => values.push(value));
    input.value = "唯";
    input.emit("input");
    search.sync();
    env.advance(500);
    assert.equal(values.length, 0);
    input.value = "澪";
    input.emit("input");
    search.destroy();
    env.advance(500);
    assert.equal(values.length, 0);
    assert.equal(input.listenerCount(), 0);
    assert.equal(env.timers.size, 0);
});

check("hidden pages do no clock work; visibility and BFCache resume from real time", () => {
    const env = pageEnvironment();
    const updates = [];
    const dispose = env.utils.visibleInterval(() => updates.push(env.now()), 1000);
    env.advance(550);
    assert.deepEqual(updates, [2000]);
    env.document.hidden = true;
    env.document.emit("visibilitychange");
    env.advance(62000);
    assert.deepEqual(updates, [2000]);
    assert.equal(env.timers.size, 0);
    env.document.hidden = false;
    env.document.emit("visibilitychange");
    assert.equal(updates.at(-1), 64000);
    assert.equal(env.timers.size, 1);
    env.window.emit("pagehide");
    env.document.emit("visibilitychange");
    const before = updates.length;
    env.advance(10000);
    assert.equal(updates.length, before);
    env.window.emit("pageshow");
    assert.equal(updates.at(-1), 74000);
    assert.equal(env.timers.size, 1);
    dispose();
    assert.equal(env.document.listenerCount(), 0);
    assert.equal(env.window.listenerCount(), 0);
    assert.equal(env.timers.size, 0);
});

function loadApp(momentPath) {
    const window = new Events();
    const document = new Events();
    document.currentScript = { src: "https://example.test/site/js/page-utils.js" };
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    function Vue(options) {
        Object.assign(this, options.data);
        Object.entries(options.methods).forEach(([name, fn]) => { this[name] = fn.bind(this); });
    }
    Vue.filter = () => {};
    Vue.directive = () => {};
    const context = vm.createContext({ window, document, URL, Date, Intl, Vue, console });
    for (const name of [momentPath, "site/js/moment-timezone-with-data-10-year-range.min.js", "site/js/page-utils.js", "site/data.js", "site/app.js"]) {
        vm.runInContext(source(name), context, { filename: name });
    }
    context.moment.now = () => Date.UTC(2026, 8, 24, 0, 0, 0);
    return context;
}

const full = loadApp("site/js/moment-with-locales.js");
const slim = loadApp("site/js/moment-zh-cn.js");
check("Moment derivative keeps the same version and only the required locales", () => {
    assert.equal(slim.moment.version, full.moment.version);
    assert.deepEqual(Array.from(slim.moment.locales()).sort(), ["en", "zh-cn"]);
    assert.ok(Buffer.byteLength(source("site/js/moment-zh-cn.js")) < 200000);
});

check("actual timer date parser agrees for historical English and Chinese data", () => {
    const fixtures = ["12月 11日 2017, 8:00", "2月 28日 2023, 15:59", "February 28 2023, 16:00", "Sep 24 2026", "not a date"];
    for (const event of full.timerData) {
        for (const timer of event.timers || []) {
            for (const field of ["start", "end", "date"]) if (timer[field]) fixtures.push(timer[field]);
        }
    }
    for (const value of fixtures) {
        const actual = slim.vm.parseMoment(value);
        const expected = full.vm.parseMoment(value);
        assert.equal(actual.isValid(), expected.isValid(), value);
        if (expected.isValid()) {
            assert.equal(actual.valueOf(), expected.valueOf(), value);
            for (const zone of ["Asia/Tokyo", "Asia/Shanghai", "America/New_York", "Europe/London"]) {
                assert.equal(actual.clone().locale("zh-cn").tz(zone).format("YYYY年M月D日 ddd HH:mm:ss"), expected.clone().locale("zh-cn").tz(zone).format("YYYY年M月D日 ddd HH:mm:ss"), `${value} / ${zone}`);
            }
        }
    }
    assert.equal(slim.vm.parseMoment("12月 11日 2017, 8:00").format("YYYY-MM-DD HH:mm Z"), "2017-12-11 08:00 +09:00");
});

check("timer updates keep historical data and do not sort stable columns again", () => {
    slim.vm.buildTimerData(slim.timerData);
    slim.vm.updateClocks();
    const memorial = slim.vm.timersData.flat().find(event => event.type === "Memorial");
    assert.equal(memorial.visible, true);
    assert.ok(memorial.timers[0].sinceStart.includes("天"));
    assert.ok(slim.vm.japanTime.includes("2026年9月24日"));
    let sorts = 0;
    for (const column of slim.vm.timersData) {
        const original = column.sort;
        column.sort = function (fn) { sorts++; return original.call(this, fn); };
    }
    slim.vm.updateClocks();
    slim.vm.updateClocks();
    assert.equal(sorts, 0);
    assert.ok(slim.vm.timersData.flat().length > 1, "Historical events must not be deleted for performance");
});

check("local preview does not silently force the fighter class", () => {
    const script = source("site/gacha.js");
    const start = script.indexOf("    function localDebugSummonOptions()");
    const end = script.indexOf("    function chooseRarity(", start);
    assert.ok(start >= 0 && end > start);
    const readOptions = (search, hostname = "localhost") => vm.runInNewContext(
        script.slice(start, end) + "\nlocalDebugSummonOptions();",
        { window: { location: { search, hostname } }, URLSearchParams }
    );
    assert.equal(readOptions("").classType, null);
    assert.equal(readOptions("?debugRarity=4").classType, null);
    assert.equal(readOptions("?debugClass=0").classType, 0);
    assert.equal(readOptions("?debugClass=4").classType, 4);
    assert.equal(readOptions("?debugClass=5").classType, null);
    assert.equal(readOptions("?debugClass=0", "example.test"), null);
});

check("home dependencies remain ordered and deferred", () => {
    const html = source("index.html");
    const scripts = [...html.matchAll(/<script\b([^>]*?)src="([^"]+)"[^>]*>/g)].filter(match => match[2].startsWith("site/"));
    assert.ok(scripts.every(match => /\bdefer\b/.test(match[1])));
    const names = scripts.map(match => match[2].split("?")[0]);
    for (const [first, second] of [["site/js/moment-zh-cn.js", "site/js/moment-timezone-with-data-10-year-range.min.js"], ["site/js/vue.min.js", "site/components.js"], ["site/components.js", "site/app.js"], ["site/js/bootstrap.min.js", "site/app.js"]]) {
        assert.ok(names.indexOf(first) >= 0 && names.indexOf(first) < names.indexOf(second), `${first} before ${second}`);
    }
    assert.ok(!html.includes("moment-with-locales.js"));
});

console.log(`\n${checks} frontend regression checks passed.`);
