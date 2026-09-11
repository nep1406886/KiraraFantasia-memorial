// Mobile gameplay requires landscape. Never rotate the canvas with CSS: input
// and camera coordinates continue to use the actual viewport. Browser locks
// are best-effort; the portrait gate is the enforceable fallback.
export function createLandscapeGuard({ onChange }) {
    const coarse = matchMedia("(pointer: coarse)"), fine = matchMedia("(any-pointer: fine)");
    const panel = document.createElement("section");
    panel.id = "landscape-guard"; panel.className = "landscape-guard"; panel.hidden = true;
    panel.setAttribute("aria-labelledby", "landscape-title");
    const sheet = document.createElement("div"); sheet.className = "landscape-sheet";
    const symbol = document.createElement("span"); symbol.className = "landscape-symbol";
    symbol.setAttribute("aria-hidden", "true");
    const title = document.createElement("h2"); title.id = "landscape-title"; title.textContent = "请横屏游玩";
    const description = document.createElement("p");
    description.textContent = "横向握持设备，能看清战场和操作按钮。竖屏期间战斗已暂停。";
    const action = document.createElement("button"); action.type = "button";
    action.id = "landscape-fullscreen"; action.textContent = "横屏并进入全屏";
    const status = document.createElement("p"); status.className = "landscape-status";
    status.setAttribute("role", "status");
    status.textContent = "若未自动旋转，请开启设备的自动旋转后横向握持。";
    sheet.append(symbol, title, description, action, status); panel.appendChild(sheet);
    document.body.appendChild(panel);
    let blocked = null, disposed = false, previous = null, ownsLock = false;

    function update() {
        if (disposed) { return; }
        const mobile = navigator.maxTouchPoints > 0
            && (!!navigator.userAgentData?.mobile || coarse.matches && !fine.matches);
        const next = mobile && innerHeight > innerWidth;
        if (next === blocked) { return; }
        blocked = next;
        panel.hidden = !blocked;
        document.body.classList.toggle("landscape-required", blocked);
        onChange(blocked);
        if (blocked) {
            previous = document.activeElement;
            if (!previous?.closest("dialog[open]")) { action.focus({ preventScroll: true }); }
        } else if (previous?.isConnected && previous.getClientRects().length && panel.contains(document.activeElement)) {
            previous.focus({ preventScroll: true }); previous = null;
        }
    }
    async function requestLandscape() {
        if (action.disabled) { return; }
        action.disabled = true;
        status.textContent = "正在尝试切换为全屏横屏…";
        try {
            if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
                await document.documentElement.requestFullscreen();
            }
            if (!disposed && screen.orientation?.lock) {
                await screen.orientation.lock("landscape");
                if (disposed) { screen.orientation.unlock?.(); }
                else { ownsLock = true; }
            }
        } catch (_) {
            // Safari and embedded browsers may reject fullscreen or orientation.
            // A rejection never resumes a portrait world or consumes an input.
        } finally {
            if (!disposed) {
                action.disabled = false; update();
                status.textContent = "如果浏览器未自动旋转，请开启设备的自动旋转后横向握持。";
            }
        }
    }
    function keydown(event) {
        if (!blocked || event.target.closest?.("dialog[open]")) { return; }
        if (event.key === "Tab") {
            const buttons = [...document.querySelectorAll("#save-status button, #landscape-guard button")]
                .filter(button => !button.disabled && button.getClientRects().length);
            const current = buttons.indexOf(document.activeElement);
            const next = (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
            event.preventDefault(); event.stopImmediatePropagation(); return;
        }
        if ((event.key === "Enter" || event.key === " ")
                && event.target.closest?.("#save-status button, #landscape-guard button")) {
            event.stopImmediatePropagation(); return;
        }
        if (event.key !== "Escape") { event.preventDefault(); }
        event.stopImmediatePropagation();
    }
    action.addEventListener("click", requestLandscape);
    window.addEventListener("resize", update);
    document.addEventListener("fullscreenchange", update);
    screen.orientation?.addEventListener?.("change", update);
    coarse.addEventListener("change", update); fine.addEventListener("change", update);
    window.addEventListener("keydown", keydown, true);
    update();
    return {
        get blocked() { return blocked; },
        dispose() {
            if (disposed) { return; }
            disposed = true;
            window.removeEventListener("resize", update);
            document.removeEventListener("fullscreenchange", update);
            screen.orientation?.removeEventListener?.("change", update);
            coarse.removeEventListener("change", update); fine.removeEventListener("change", update);
            window.removeEventListener("keydown", keydown, true);
            action.removeEventListener("click", requestLandscape);
            if (ownsLock) { screen.orientation?.unlock?.(); }
            document.body.classList.remove("landscape-required"); panel.remove();
            if (blocked) { blocked = false; onChange(false); }
        }
    };
}
