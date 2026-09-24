// DOM presenter for the dialogue system (T12). Owns the box, the bust
// portrait, the 24ms/char typewriter and the click/Enter advance rule
// (游玩说明 §二: 点击一次补全，再点下一句). No game logic lives here —
// game/rl/dialogue.js drives it through the presenter contract.

const TYPE_MS = 24;
const DIALOGUE_OUT_MS = 120;

export function createDialoguePresenter(options) {
    const opts = options || {};
    const resolver = opts.resolveCharacter || function () { return null; };
    const bustBase = opts.bustBase || "../../asset/img/rl/bust/";

    let box = null;
    let nameEl = null;
    let textEl = null;
    let imgEl = null;
    let typing = false;
    let typeTimer = null;
    let fullText = "";
    let inputResolve = null;
    let keyHandler = null;
    let skipped = false;
    let currentBust = "";
    let outTimer = null;

    function build() {
        box = document.createElement("div");
        box.id = "dialogue-box";
        box.className = "dlg-hidden";
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "冒险对白");
        // spec/01 §4.4: 底部纸面板 — paper token card, bust left, name tag a
        // small rounded label. Custom properties resolve inside cssText, so
        // no raw colour value lives here either.
        box.style.cssText = `
            position: fixed;
            left: 50%;
            bottom: 4vh;
            transform: translateX(-50%);
            width: min(720px, 92vw);
            box-sizing: border-box;
            max-height: 92vh;
            overflow-y: auto;
            background: var(--kf-paper);
            border: 1.5px solid var(--kf-ink-soft);
            border-radius: 14px;
            padding: 14px 18px 18px;
            display: flex;
            gap: 14px;
            align-items: flex-end;
            z-index: 300;
            cursor: pointer;
            box-shadow: 0 6px 18px var(--kf-shadow);
            font-family: var(--font-sans);
            color: var(--kf-ink);
        `;
        imgEl = document.createElement("img");
        imgEl.alt = "";
        // Only the 40 roster ids ship busts; a variant card resolving through
        // the 【prefix】 rule can point at a file that is not there — hide the
        // frame rather than show a broken-image glyph.
        imgEl.onerror = function () { imgEl.style.display = "none"; };
        imgEl.style.cssText = `
            width: 96px;
            height: 136px;
            object-fit: cover;
            object-position: top;
            border-radius: 8px;
            border: 1.5px solid var(--kf-ink-soft);
            background: var(--kf-mint);
            flex: none;
        `;
        const body = document.createElement("div");
        body.style.cssText = "flex: 1; min-width: 0;";
        nameEl = document.createElement("div");
        nameEl.style.cssText = `
            display: inline-block;
            background: var(--kf-mint);
            color: var(--kf-ink);
            font-weight: 600;
            font-size: 0.9rem;
            padding: 2px 12px;
            border-radius: 999px;
            margin-bottom: 8px;
        `;
        textEl = document.createElement("div");
        textEl.style.cssText = `
            color: var(--kf-ink);
            font-size: 1rem;
            line-height: 1.55;
            min-height: 3.1em;
            white-space: pre-wrap;
            word-break: break-word;
        `;
        body.appendChild(nameEl);
        body.appendChild(textEl);
        const skip = document.createElement("button");
        skip.type = "button";
        skip.id = "dialogue-skip";
        skip.textContent = "跳过此段";
        skip.style.cssText = "display:block;margin-top:8px;margin-left:auto;min-height:44px;padding:4px 12px;";
        skip.addEventListener("click", function (event) {
            event.stopPropagation();
            skipped = true;
            stopTyping();
            if (inputResolve) { const resolve = inputResolve; inputResolve = null; resolve(); }
        });
        body.appendChild(skip);
        box.appendChild(imgEl);
        box.appendChild(body);
        document.body.appendChild(box);

        box.addEventListener("click", advance);
        keyHandler = function (e) {
            if (e.target === skip) {
                // Keep native button activation, but do not also enqueue the
                // game's Space/dodge input when the dialogue releases freeze.
                if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); }
                return;
            }
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                advance();
            }
        };
    }

    function advance() {
        if (!box || box.classList.contains("dlg-hidden") || box.classList.contains("dlg-out")) {
            return;
        }
        if (typing) {
            // first input completes the line (游玩说明 §二)
            stopTyping();
            textEl.textContent = fullText;
            return;
        }
        if (inputResolve) {
            const r = inputResolve;
            inputResolve = null;
            r();
        }
    }

    function stopTyping() {
        typing = false;
        if (typeTimer !== null) {
            clearInterval(typeTimer);
            typeTimer = null;
        }
    }

    function stopAll() {
        stopTyping();
        if (outTimer !== null) { clearTimeout(outTimer); outTimer = null; }
    }

    return {
        begin: function () { skipped = false; },
        isSkipped: function () { return skipped; },
        showLine: function (line) {
            if (!box) { build(); }
            const who = resolver(line.who);
            const bustSrc = who && who.bust ? who.bust : "";
            if (bustSrc) {
                imgEl.src = bustSrc;
                imgEl.style.display = "";
                if (bustSrc !== currentBust) {
                    imgEl.classList.add("dlg-bust-fade");
                    imgEl.addEventListener("animationend", function onEnd() {
                        imgEl.classList.remove("dlg-bust-fade");
                        imgEl.removeEventListener("animationend", onEnd);
                    });
                    currentBust = bustSrc;
                }
            } else {
                imgEl.style.display = "none";
                currentBust = "";
            }
            nameEl.textContent = who ? (who.nameZh || who.name || line.who) : line.who;
            fullText = line.text;
            textEl.textContent = "";
            if (box.classList.contains("dlg-hidden") || box.classList.contains("dlg-out")) {
                if (outTimer) { clearTimeout(outTimer); outTimer = null; }
                box.classList.remove("dlg-hidden", "dlg-out");
            } else {
                box.classList.remove("dlg-hidden");
            }
            document.addEventListener("keydown", keyHandler, true);

            stopTyping(); // clear any prior line's interval before re-arming
            typing = true;
            let i = 0;
            typeTimer = setInterval(function () {
                i += 1;
                textEl.textContent = fullText.slice(0, i);
                if (i >= fullText.length) {
                    stopTyping();
                }
            }, TYPE_MS);
        },

        waitInput: function () {
            return new Promise(function (resolve) {
                inputResolve = resolve;
            });
        },

        finish: function () {
            stopAll();
            if (inputResolve) {
                const r = inputResolve;
                inputResolve = null;
                r();
            }
            if (box) {
                document.removeEventListener("keydown", keyHandler, true);
                box.classList.add("dlg-out");
                box.classList.remove("dlg-hidden");
                outTimer = setTimeout(function () {
                    box.classList.add("dlg-hidden");
                    box.classList.remove("dlg-out");
                    outTimer = null;
                }, DIALOGUE_OUT_MS);
            }
            currentBust = "";
        },

        // test/inspection hook
        isTyping: function () { return typing; },

        // stop all timers (typewriter + fade-out) without closing the box.
        // Lets a harness drop references without leaking intervals.
        _stopAll: stopAll,
    };
}
