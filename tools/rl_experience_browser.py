"""Real render-loop regressions: refresh rate, death ownership and feedback.

The fake rAF schedule drives the production clock (not kirafanRL.step).
Run against a preview: python tools/rl_experience_browser.py --url http://127.0.0.1:62857
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "experience-rework"
FRAME_DRIVER = """
window.__frames = new Map(); window.__frameId = 0; window.__now = 0;
window.requestAnimationFrame = cb => { const id=++window.__frameId; window.__frames.set(id,cb); return id; };
window.cancelAnimationFrame = id => window.__frames.delete(id);
window.__frame = dt => {
    window.__now += dt * 1000;
    const queue = Array.from(window.__frames.values()); window.__frames.clear();
    queue.forEach(cb => cb(window.__now));
};
"""


def boot(browser, url, volume=1):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(FRAME_DRIVER)
    page.goto(url + "/site/game/roguelike.html?seed=73061&volume=" + str(volume), wait_until="load", timeout=60000)
    page.wait_for_function("!!window.kirafanRL", polling=50, timeout=45000)
    page.wait_for_selector(".roster-card", timeout=30000)
    page.evaluate("document.querySelector('.roster-card').click()")
    page.wait_for_function("!!window.kirafanRL.views.player", polling=50, timeout=45000)
    for _ in range(160):
        page.evaluate("""() => {
            const d=document.getElementById('dialogue-box');
            if (d && d.style.display !== 'none') d.click();
            window.kirafanRL.step(1/60);
        }""")
        page.wait_for_timeout(35)
        if page.evaluate("!window.kirafanRL.world.frozen && window.kirafanRL.pending === 0"):
            break
    page.wait_for_function("window.kirafanRL.pending === 0 && !!window.kirafanRL.mapview.group", polling=50, timeout=45000)
    return page, errors


def rates(browser, url, report, check):
    report["rates"] = []
    for hz in (60, 120, 144, 240):
        page, errors = boot(browser, url)
        if hz == 60:
            page.screenshot(path=str(OUT / (report["label"] + "-harbour.png")))
        row = page.evaluate("""hz => {
            const k=window.kirafanRL,w=k.world,p=w.player;
            w.frozen=false;w.hitStop=0;w.enemies=[];w.roomColliders=[];
            p.x=10;p.y=9;p.sm.force('move');k.input.clear();k.input.state.move.x=1;
            k.step(0);window.__frame(0);
            const start=w.time,mixer=k.views.player.actor.mixer.time;
            const samples=[];
            for(let i=0;i<2*hz;i++) {
                window.__frame(1/hz);
                samples.push(k.views.player.actor.object.position.x);
            }
            const deltas=samples.slice(9).map((x,i)=>x-samples[i+8]);
            const simulation=w.time-start,animation=k.views.player.actor.mixer.time-mixer;
            const beforePause=k.views.player.actor.mixer.time;
            w.frozen=true;for(let i=0;i<hz;i++)window.__frame(1/hz);
            return {hz,simulation,animation,distance:p.x-10,
                repeated:deltas.filter(d=>Math.abs(d)<1e-8).length,
                minDelta:Math.min(...deltas),maxDelta:Math.max(...deltas),
                pauseDrift:k.views.player.actor.mixer.time-beforePause};
        }""", hz)
        row["errors"] = errors
        report["rates"].append(row)
        check(str(hz) + "Hz simulation remains real-time", abs(row["simulation"]-2) < .02)
        check(str(hz) + "Hz animation remains real-time", abs(row["animation"]-2) < .035)
        check(str(hz) + "Hz continuous render positions", row["repeated"] == 0)
        check(str(hz) + "Hz pause holds the pose", abs(row["pauseDrift"]) < .02)
        check(str(hz) + "Hz no page errors", not errors)
        page.close()


def death(browser, url, report, check):
    page, errors = boot(browser, url)
    page.evaluate("""() => {
        const k=window.kirafanRL,w=k.world;k.input.clear();
        w.enterRoom(w.dungeon.boss,'S');k.step(1/60);
    }""")
    page.wait_for_function("window.kirafanRL.pending === 0 && window.kirafanRL.views.enemies.some(v=>v.mixer)", polling=50, timeout=45000)
    report["death"] = page.evaluate("""() => {
        const k=window.kirafanRL,v=k.views.enemies.find(v=>v.mixer),u=v.unit;
        u.sm.force('telegraph');v.sync(.2,1000);
        u.sm.force('skill');v.sync(.2,1200);
        u.dead=true;u.hp=0;u.sm.force('dead');
        for(let i=0;i<180;i++)v.sync(1/60,1200+i*1000/60);
        return {model:u.model,current:v.current,visible:v.object.visible,
            running:v.mixer._actions.filter(a=>a.isRunning()).map(a=>a.getClip().name)};
    }""")
    check("death stops every live action", not report["death"]["running"])
    check("death retires the visible model", not report["death"]["visible"])
    check("death no page errors", not errors)
    page.close()


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--url", default="http://127.0.0.1:62857")
    args.add_argument("--baseline", action="store_true")
    cfg = args.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"label": "before" if cfg.baseline else "after", "checks": []}
    def check(label, ok):
        report["checks"].append({"label": label, "ok": bool(ok)})
        print(("PASS " if ok else "FAIL ") + label, flush=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        try:
            rates(browser, cfg.url.rstrip("/"), report, check)
            death(browser, cfg.url.rstrip("/"), report, check)
        finally:
            browser.close()
            (OUT / (report["label"] + "-report.json")).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    failures = sum(not row["ok"] for row in report["checks"])
    print(str(failures) + " failed")
    return 0 if cfg.baseline else int(failures > 0)


if __name__ == "__main__":
    raise SystemExit(main())
