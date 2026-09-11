// Exercise the real roster module with the same shipped-data selection as main.
// The DOM shim checks callbacks and removal, not browser layout or accessibility.
// node tools/rl_roster_entry_harness.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createStats } from "../site/asset/rl/stats.js";
import { PLAYABLE_IDS } from "../site/game/rl/rosterids.js";
import { mergeState } from "../site/game/rl/meta.js";
import { createRosterUI, showRoster } from "../site/game/rl/ui/roster.js";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");
// The UI resolves card art module-relative so deployment can live under a subpath.
const CARD_ART_BASE = new URL("../site/asset/img/rl/card/", import.meta.url).href;
const context = { window: {} };
vm.runInNewContext(read("site/asset/gacha/cards.js"), context, { timeout: 1000 });
const rendered = new Map();
for (const card of context.window.kirafanGachaData.cards) {
    rendered.set(card.id, card);
    if (card.evolvedId) rendered.set(card.evolvedId, card);
}
const stats = createStats({ cards: JSON.parse(read("site/asset/rl/cards-rl.json")).cards });
const unlocked = mergeState(null).chars;
const cards = stats.all().filter(row => rendered.has(row.id) && row.rare === 5
    && PLAYABLE_IDS.includes(row.id) && unlocked.includes(row.id));
assert.equal(PLAYABLE_IDS.length, 41, "current authored roster fixture");
assert.deepEqual(new Set(cards.map(row => row.id)), new Set(PLAYABLE_IDS), "boot source contains every playable identity");

class Element {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.attributes = {};
        this.listeners = new Map();
    }
    appendChild(child) {
        assert.equal(child.parentNode, null);
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        assert.notEqual(index, -1, "cannot remove a detached child");
        this.children.splice(index, 1);
        child.parentNode = null;
        return child;
    }
    replaceChild(next, previous) {
        const index = this.children.indexOf(previous);
        assert.notEqual(index, -1);
        assert.equal(next.parentNode, null);
        this.children[index] = next;
        previous.parentNode = null;
        next.parentNode = this;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    insertAdjacentHTML(position, html) {
        assert.equal(position, "beforeend");
        this.markup = (this.markup || "") + html;
    }
    addEventListener(type, handler) {
        const handlers = this.listeners.get(type) || [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
    }
    fire(type) {
        for (const handler of this.listeners.get(type) || []) handler({ target: this, stopPropagation() {} });
    }
}
const walk = (element, predicate) => predicate(element) ? element
    : element.children.map(child => walk(child, predicate)).find(Boolean);
const document = {
    head: new Element("head"), body: new Element("body"),
    createElement: tag => new Element(tag),
    getElementById: id => walk(document.head, node => node.id === id)
        || walk(document.body, node => node.id === id)
};
const oldDocument = globalThis.document;
globalThis.document = document;
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log("PASS " + name); };
const gridCards = overlay => walk(overlay, node => node.className === "rl-roster-grid").children;
const mount = options => document.body.appendChild(createRosterUI({ cards, ...options }));

try {
    const before = JSON.stringify(cards);
    check("all 41 authored cards reach the actual UI in caller order", () => {
        const overlay = mount();
        const nodes = gridCards(overlay);
        assert.equal(nodes.length, 41);
        assert.deepEqual(nodes.map(node => node.children.find(child => child.tagName === "IMG").src),
            cards.map(card => CARD_ART_BASE + card.id + ".webp"));
        assert.ok(nodes.some(node => node.children.some(child => child.src?.endsWith("/47002001.webp"))), "Hiyori is not truncated");
        document.body.removeChild(overlay);
    });
    for (const [index, card] of cards.entries()) {
        check("selection returns authored ID " + card.id, () => {
            const selected = [];
            const overlay = mount({ onSelect: id => selected.push(id) });
            gridCards(overlay)[index].fire("click");
            assert.deepEqual(selected, [card.id]);
            assert.equal(overlay.parentNode, null);
        });
    }
    check("caller filtering, same-name deduplication and element bounds remain intact", () => {
        const fixtures = [
            { id: 1, characterZh: "甲", element: 0 },
            { id: 2, characterZh: "甲", element: 1 },
            { id: 3, characterZh: "乙", element: 5 },
            { id: 4, characterZh: "丙", element: -1 },
            { id: 5, characterZh: "丁", element: 6 }
        ];
        const overlay = mount({ cards: fixtures });
        assert.deepEqual(gridCards(overlay).map(node => node.children.find(child => child.tagName === "IMG").src),
            [CARD_ART_BASE + "1.webp", CARD_ART_BASE + "3.webp"]);
        document.body.removeChild(overlay);
    });
    check("there is no replacement UI-local roster cap", () => {
        const fixtures = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, characterZh: "角色" + i, element: i % 6 }));
        const overlay = mount({ cards: fixtures });
        assert.equal(gridCards(overlay).length, 60);
        document.body.removeChild(overlay);
    });
    check("empty caller roster stays empty", () => {
        const overlay = mount({ cards: [] });
        assert.equal(gridCards(overlay).length, 0);
        document.body.removeChild(overlay);
    });
    check("missing card art retains name fallback and selection", () => {
        let selected = null;
        const overlay = mount({ onSelect: id => { selected = id; } });
        const node = gridCards(overlay).at(-1);
        node.children.find(child => child.tagName === "IMG").fire("error");
        assert.equal(node.children.find(child => child.className === "art missing").textContent, "海凪 日和");
        node.fire("click");
        assert.equal(selected, 47002001);
    });
    check("camp actions leave selection mounted", () => {
        const events = [];
        const overlay = mount({ onTrain: () => events.push("train"), onStorage: () => events.push("storage"), onCodex: () => events.push("codex") });
        for (const action of ["train", "storage", "codex"]) walk(overlay, node => node.id === "roster-" + action).fire("click");
        assert.deepEqual(events, ["train", "storage", "codex"]);
        assert.equal(overlay.parentNode, document.body);
        document.body.removeChild(overlay);
    });
    check("continue removes the roster before handing off", () => {
        let calls = 0;
        const overlay = mount({ onContinue: () => { calls++; assert.equal(overlay.parentNode, null); } });
        walk(overlay, node => node.id === "roster-continue").fire("click");
        assert.equal(calls, 1);
    });
    const selected = showRoster(cards);
    gridCards(document.getElementById("roster-overlay")).at(-1).fire("click");
    assert.equal(await selected, 47002001);
    checks++; console.log("PASS showRoster promise resolves the previously hidden card");
    const cancelled = showRoster(cards);
    walk(document.getElementById("roster-overlay"), node => node.textContent === "取消").fire("click");
    await assert.rejects(cancelled, { message: "Roster selection cancelled" });
    checks++; console.log("PASS cancellation still rejects and removes the overlay");
    assert.equal(JSON.stringify(cards), before, "rendering does not mutate source cards");
    assert.equal(document.body.children.length, 0, "no mounted overlays left");
    assert.equal(document.head.children.length, 1, "style is injected once");
    checks++; console.log("PASS source ownership and overlay cleanup");
} finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
}
console.log("Roster entry: " + checks + " checks passed (DOM shim; not visually verified).");
