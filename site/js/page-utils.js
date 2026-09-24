(function () {
    "use strict";

    // Resolve against this script, not the page: both / and /repo/ deployments
    // share the same assets, including legacy data paths that begin with imgs/.
    var siteRoot = new URL("../", document.currentScript.src);

    function assetUrl(path) {
        var value = String(path || "");
        if (!value || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value)) {
            return value;
        }
        return new URL(value.replace(/^(?:\.\/)?site\//, ""), siteRoot).href;
    }

    function bindSearch(input, update, delay) {
        var timer = null;
        var composing = false;
        var lastValue = input.value;

        function cancel() {
            window.clearTimeout(timer);
            timer = null;
        }

        function flush() {
            cancel();
            if (composing || input.value === lastValue) {
                return;
            }
            lastValue = input.value;
            update(lastValue);
        }

        function onInput(event) {
            cancel();
            if (composing || event.isComposing || input.value === lastValue) {
                return;
            }
            if (!input.value) {
                flush();
            } else {
                timer = window.setTimeout(flush, delay || 140);
            }
        }

        function onCompositionStart() {
            composing = true;
            cancel();
        }

        function onCompositionEnd() {
            composing = false;
            flush();
        }

        function onKeyDown(event) {
            if (event.key === "Enter" && !event.isComposing) {
                flush();
            }
        }

        input.addEventListener("input", onInput);
        input.addEventListener("compositionstart", onCompositionStart);
        input.addEventListener("compositionend", onCompositionEnd);
        input.addEventListener("keydown", onKeyDown);
        input.addEventListener("search", flush);
        return {
            flush: flush,
            // Filters already render the current value; do not render it again
            // when an older pending search eventually fires.
            sync: function () {
                cancel();
                lastValue = input.value;
            },
            destroy: function () {
                cancel();
                input.removeEventListener("input", onInput);
                input.removeEventListener("compositionstart", onCompositionStart);
                input.removeEventListener("compositionend", onCompositionEnd);
                input.removeEventListener("keydown", onKeyDown);
                input.removeEventListener("search", flush);
            }
        };
    }

    function visibleInterval(update, interval) {
        var timer = null;
        var disposed = false;
        var suspended = false;

        function pause() {
            window.clearTimeout(timer);
            timer = null;
        }

        function schedule() {
            if (!disposed && !suspended && !document.hidden) {
                timer = window.setTimeout(tick, interval - Date.now() % interval);
            }
        }

        function tick() {
            pause();
            if (!disposed && !suspended && !document.hidden) {
                update();
                schedule();
            }
        }

        function onVisibility() {
            pause();
            tick();
        }

        function onPageHide() {
            suspended = true;
            pause();
        }

        function onPageShow() {
            suspended = false;
            tick();
        }

        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener("pageshow", onPageShow);
        schedule();
        return function () {
            disposed = true;
            pause();
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("pagehide", onPageHide);
            window.removeEventListener("pageshow", onPageShow);
        };
    }

    window.kirafanPage = {
        assetUrl: assetUrl,
        bindSearch: bindSearch,
        visibleInterval: visibleInterval
    };
})();
