// T12 dialogue system (spec/05 §5 script format, spec/06 T12 contract).
//
//   loadDialogueScripts(window)   → { ok, errors }   parse + validate once
//   setCharacterResolver(fn)      → who -> { id, name, nameZh, bust } | null
//   getNode(nodeId)               → line[] | undefined
//   play(nodeId, presenter)       → Promise          sequencing
//   validateScripts(src)          → { ok, errors }   pure, harness-facing
//
// Scripts are plain-JS assets that set window.kirafanDialogue (the cards.js
// pattern — no fetch, so file:// boots work). This module owns validation and
// sequencing only; the DOM box (typewriter, click-to-complete) is a presenter
// injected into play() (ui/dialogue.js in the browser, a fake in the node
// harness), which keeps world.js-style purity: no DOM here.

// Deliberate copy of core/actor.js GAME_EXPRESSIONS — core/ is not
// node-linkable and is peer territory (same discipline as elements.js).
// rl_dialogue_harness loads the real list via a data: URL and asserts this
// copy never drifts.
export const DIALOGUE_FACES = ["default", "angry", "happy", "joy", "shy",
    "sorrow", "surprise", "unique1", "unique2", "unique3"];

const NODE_LINE_LIMIT = 6;        // spec/05 §5: 每节点 ≤6 句
const OPEN_CLOSE_LINE_LIMIT = 4;  // spec/05 §5: 卷头/卷尾 ≤4 句

let scripts = {};
let resolver = null;

export function setCharacterResolver(fn) {
    resolver = typeof fn === "function" ? fn : null;
}

// window.kirafanDialogue — the aggregate every asset/rl/dialogue/*.js
// contributes to. Each file merges (`window.kirafanDialogue =
// Object.assign(window.kirafanDialogue || {}, {...})`) so several files can
// ship in any include order without clobbering each other.
export function loadDialogueScripts(global) {
    const src = global && global.kirafanDialogue;
    if (!src || typeof src !== "object") {
        return { ok: false, errors: ["window.kirafanDialogue is absent — no dialogue scripts loaded"] };
    }
    scripts = src;
    return validateScripts(scripts);
}

export function getNode(nodeId) {
    return scripts[nodeId];
}

// Node naming (spec/05 §5): v<volume>_open / _mid / _boss_pre / _boss_post /
// _close, prologue, rest_<char>_<n>, exit_<char>, plus pages/finale keys.
function lineLimitFor(nodeId) {
    return /_(open|close)$/.test(nodeId) ? OPEN_CLOSE_LINE_LIMIT : NODE_LINE_LIMIT;
}

export function validateScripts(src) {
    const errors = [];
    Object.keys(src).forEach(function (nodeId) {
        const node = src[nodeId];
        if (!Array.isArray(node) || node.length === 0) {
            errors.push(nodeId + ": node must be a non-empty array");
            return;
        }
        const limit = lineLimitFor(nodeId);
        if (node.length > limit) {
            errors.push(nodeId + ": " + node.length + " lines exceeds the "
                + limit + "-line limit for this node kind");
        }
        node.forEach(function (line, i) {
            const at = nodeId + "[" + i + "]";
            if (!line || typeof line !== "object") {
                errors.push(at + ": not an object");
                return;
            }
            if (typeof line.who !== "string" || !line.who) {
                errors.push(at + ": who must be a non-empty string");
            } else if (resolver && !resolver(line.who)) {
                errors.push(at + ': unknown character "' + line.who + '"');
            }
            if (line.face !== undefined && DIALOGUE_FACES.indexOf(line.face) < 0) {
                errors.push(at + ': face "' + line.face + '" is not a GAME_EXPRESSIONS key');
            }
            if (typeof line.text !== "string" || !line.text.trim()) {
                errors.push(at + ": text must be a non-empty string");
            }
            if (line.voice !== undefined && typeof line.voice !== "string") {
                errors.push(at + ": voice must be a cue-name string");
            }
        });
    });
    return { ok: errors.length === 0, errors: errors };
}

// play(nodeId, presenter) — walks the node's lines through the presenter.
//   presenter.showLine(line)   render one line (bust, name, typewriter text)
//   presenter.waitInput()      Promise — resolve when the player advances
//   presenter.finish()         the box closes
// Unknown nodes reject (typos must be loud, not silent no-ops).
export function play(nodeId, presenter) {
    const node = scripts[nodeId];
    if (!node) {
        return Promise.reject(new Error("unknown dialogue node: " + nodeId));
    }
    if (!presenter || typeof presenter.showLine !== "function"
            || typeof presenter.waitInput !== "function") {
        return Promise.reject(new Error("play() needs a presenter"));
    }
    let i = 0;
    function step() {
        if (i >= node.length || (typeof presenter.isSkipped === "function" && presenter.isSkipped())) {
            if (typeof presenter.finish === "function") {
                presenter.finish();
            }
            return Promise.resolve();
        }
        const line = node[i++];
        presenter.showLine(line);
        return presenter.waitInput().then(step);
    }
    // A presenter's synchronous failure must follow the same rejection path
    // as waitInput failures so the caller can release its story freeze.
    return Promise.resolve().then(function () {
        if (typeof presenter.begin === "function") { presenter.begin(); }
        return step();
    });
}
