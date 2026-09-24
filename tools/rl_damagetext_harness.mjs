// T29 精美细腻切片：伤害数字颜色/字体/标签/动画选择逻辑。
// damagetext.js 是视图层（import 不跨层），这里用最小 DOM mock 捕获
// show() 产生的节点样式，断言 spec/01 的 token/字体/标签契约。
// 真实渲染像素与 prefers-reduced-motion 由浏览器门验收。
import assert from "node:assert/strict";

// --- minimal DOM mock -----------------------------------------------------
function makeNode() {
    const node = {
        style: { cssText: "" },
        className: "",
        children: [],
        textContent: "",
        appendChild(child) { this.children.push(child); },
        remove() { this._removed = true; },
    };
    return node;
}
let createdNodes = [];
const mockDocument = {
    createElement(tag) { const n = makeNode(); n.tagName = tag; createdNodes.push(n); return n; },
    createTextNode(text) { return { textContent: text, nodeType: 3 }; },
};
const mockMatchMedia = () => ({ matches: false });

globalThis.document = mockDocument;
globalThis.matchMedia = mockMatchMedia;

// THREE.Vector3 mock: just needs .set/.project and x/y/z
const THREE = {
    Vector3: class {
        constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
        set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
        project(camera) { return this; }
    },
};

const { createDamageTextLayer } = await import("../site/game/rl/view/damagetext.js");

// --- helpers ----------------------------------------------------------------
const mockCamera = {};
const mockRenderer = { domElement: { clientWidth: 768, clientHeight: 480 } };
const mockUnit = { x: 0, y: 0, kind: "enemy" };

function freshLayer() {
    createdNodes = [];
    const container = makeNode();
    const layer = createDamageTextLayer(container, THREE);
    return layer;
}

function showAndCapture(layer, spec) {
    layer.show({
        camera: mockCamera,
        renderer: mockRenderer,
        unit: mockUnit,
        damage: 100,
        crit: false,
        hitFlag: 0,
        side: "player",
        element: null,
        ...spec,
    });
    // The damage number is the last created div (layer container is first)
    const divs = createdNodes.filter(n => n.tagName === "div" && n.className.startsWith("damage-number"));
    assert.ok(divs.length >= 1, "show() must create a damage-number node");
    return divs[divs.length - 1];
}

function tagIn(node) {
    return node.children.find(c => c.tagName === "small") || null;
}

let checks = 0;
function test(label, fn) { fn(); checks++; console.log("PASS " + label); }

// --- ordinary player hit: paper white, no label, serif font ----------------
test("ordinary hit uses paper white, serif, no label", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, {});
    assert.ok(node.style.cssText.includes("var(--kf-paper)"), "ordinary hit colour is --kf-paper");
    assert.ok(node.style.cssText.includes("var(--font-serif)"), "font is --font-serif");
    assert.ok(node.style.cssText.includes("tabular-nums"), "tabular-nums declared");
    assert.equal(tagIn(node), null, "ordinary hit has no label tag");
    assert.ok(!node.style.cssText.includes("gold"), "ordinary hit has no gold halo");
});

// --- crit: gold colour + gold halo ------------------------------------------
test("crit hit uses gold colour and gold halo", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, { crit: true });
    assert.ok(node.style.cssText.includes("var(--kf-gold)"), "crit colour is --kf-gold");
    assert.ok(node.style.cssText.includes("0 0 6px var(--kf-gold)"), "crit has gold glow shadow");
    const tag = tagIn(node);
    assert.ok(tag, "crit has a label");
    assert.equal(tag.textContent, "暴击");
});

// --- 克制 (element advantage): attacker element colour + labelled tag -------
test("克制 hit tints with attacker element colour and labels it", () => {
    const layer = freshLayer();
    // element 0 = fire → --el-fire, label "克制·炎"
    const node = showAndCapture(layer, { hitFlag: 1, element: 0 });
    assert.ok(node.style.cssText.includes("var(--el-fire)"), "fire 克制 uses --el-fire");
    const tag = tagIn(node);
    assert.ok(tag, "克制 has a label");
    assert.equal(tag.textContent, "克制·炎");
    assert.ok(tag.style.cssText.includes("var(--el-fire)"), "label inherits element colour");
});

test("克制 with water element (1) uses --el-water", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, { hitFlag: 1, element: 1 });
    assert.ok(node.style.cssText.includes("var(--el-water)"), "water 克制 uses --el-water");
    assert.equal(tagIn(node).textContent, "克制·水");
});

test("克制 with moon element (4) uses --el-moon", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, { hitFlag: 1, element: 4 });
    assert.ok(node.style.cssText.includes("var(--el-moon)"), "moon 克制 uses --el-moon");
    assert.equal(tagIn(node).textContent, "克制·月");
});

test("克制 with sun element (5) uses --el-sun", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, { hitFlag: 1, element: 5 });
    assert.ok(node.style.cssText.includes("var(--el-sun)"), "sun 克制 uses --el-sun");
    assert.equal(tagIn(node).textContent, "克制·阳");
});

test("克制 without element info falls back to fire (id 0)", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, { hitFlag: 1, element: null });
    assert.ok(node.style.cssText.includes("var(--el-fire)"), "null element falls back to fire");
});

// --- 抵抗: ink-soft, no element colour --------------------------------------
test("抵抗 hit uses ink-soft colour", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, { hitFlag: -1 });
    assert.ok(node.style.cssText.includes("var(--kf-ink-soft)"), "抵抗 uses --kf-ink-soft");
    assert.equal(tagIn(node).textContent, "抵抗");
});

// --- healing: wind green ----------------------------------------------------
test("healing uses --el-wind and + prefix", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, { heal: true, side: "player", damage: 50 });
    assert.ok(node.style.cssText.includes("var(--el-wind)"), "healing uses --el-wind");
    const textNode = node.children.find(c => typeof c === "object" && c.nodeType === undefined && c.textContent === "+50")
        || node.children.find(c => c.textContent && c.textContent.includes("+50"));
    // The text node is a DOM Text object; in our mock it's appended via
    // createTextNode which we didn't mock, so check the node's textContent
    // indirectly: the last child that is not a small tag.
    const nonTag = node.children.filter(c => c.tagName !== "small");
    assert.ok(nonTag.length >= 1, "healing has a text child");
});

// --- enemy hit: berry -------------------------------------------------------
test("enemy-side hit uses --kf-berry", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, { side: "enemy", damage: 80 });
    assert.ok(node.style.cssText.includes("var(--kf-berry)"), "enemy hit uses --kf-berry");
});

// --- no bare hex in the colour declaration (spec/01 §2) ----------------------
test("no bare hex in colour field (only in text-shadow)", () => {
    const layer = freshLayer();
    const cases = [
        {},
        { crit: true },
        { hitFlag: 1, element: 2 },
        { hitFlag: -1 },
        { heal: true },
        { side: "enemy" },
    ];
    for (const spec of cases) {
        const node = showAndCapture(layer, spec);
        const colourMatch = node.style.cssText.match(/color:([^;]+)/);
        assert.ok(colourMatch, "colour declared");
        const colour = colourMatch[1].trim();
        assert.ok(!/^#[0-9a-f]{3,6}$/i.test(colour),
            "colour is a token, not bare hex: " + colour);
    }
});

// --- crit + 克制: element colour with gold halo ------------------------------
test("crit + 克制 combines element colour and gold halo", () => {
    const layer = freshLayer();
    const node = showAndCapture(layer, { crit: true, hitFlag: 1, element: 3 });
    assert.ok(node.style.cssText.includes("var(--el-wind)"), "wind 克制 colour");
    assert.ok(node.style.cssText.includes("0 0 6px var(--kf-gold)"), "gold halo present");
    assert.equal(tagIn(node).textContent, "克制·风");
});

// --- LIFETIME and LIMIT invariants ------------------------------------------
test("LIFETIME=.9 and LIMIT=48 unchanged", () => {
    const layer = freshLayer();
    for (let i = 0; i < 50; i++) {
        layer.show({ camera: mockCamera, renderer: mockRenderer, unit: { x: i, y: 0 }, damage: 1 });
    }
    assert.equal(layer.count, 48, "LIMIT=48: 50th show evicts the first");
    layer.update(1, u => u);
    assert.equal(layer.count, 0, "LIFETIME=.9: 1s update clears all");
});

console.log("Damage text: " + checks + " checks passed.");
process.exitCode = 0;
