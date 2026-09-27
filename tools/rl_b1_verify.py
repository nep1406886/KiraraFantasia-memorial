#!/usr/bin/env python3
"""B.1 扩表 Chromium 验证: vol-4 全房间敌人模型可见 + vol-5 boss 动画在位.

Usage: python tools/rl_b1_verify.py
"""
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8650"


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    page.locator(".rl-roster-card").filter(
        has=page.locator('img[src$="/32002001.webp"]')).click(timeout=60000)


def dismiss(page):
    for _ in range(40):
        vis = page.evaluate(
            "!!document.getElementById('dialogue-box')"
            " && !document.getElementById('dialogue-box').classList.contains('dlg-hidden')"
            " && !document.getElementById('dialogue-box').classList.contains('dlg-out')")
        if not vis:
            return
        page.evaluate("document.getElementById('dialogue-skip')?.click()")
        page.evaluate("kirafanRL.step(1/60)")
        page.wait_for_timeout(20)


def settle(page, room_id=None):
    for _ in range(400):
        page.evaluate("kirafanRL.step(1/60)")
        dismiss(page)
        page.wait_for_timeout(8)
        st = page.evaluate(
            "()=>({id:kirafanRL.world.roomId,g:kirafanRL.mapview.group?.name,"
            "p:kirafanRL.pending,l:kirafanRL.roomLoading,f:kirafanRL.world.frozen})")
        want = ("room:" + str(room_id)) if room_id is not None else st["g"]
        if st["g"] == want and not st["p"] and not st["l"] and not st["f"]:
            return st
    return None


def main() -> int:
    result = {"errors": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 840})
        ctx.add_init_script(
            "window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};"
            "localStorage.setItem('kirafan-rl:meta',"
            "JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
        page = ctx.new_page()
        page.on("pageerror", lambda e: result["errors"].append(str(e)))

        # --- vol 4: every room, every enemy model actually renders a view ---
        boot(page, BASE + "/game/roguelike.html?volume=4&seed=260903")
        settle(page)
        seen = {}
        rooms = page.evaluate("kirafanRL.world.dungeon.rooms.map(r=>({id:r.id,type:r.type}))")
        for r in rooms:
            page.evaluate(
                '(id)=>{kirafanRL.world.enterRoom(id,"N");kirafanRL.step(1/60)}', r["id"])
            settle(page, r["id"])
            models = page.evaluate("kirafanRL.world.enemies.map(e=>e.model)")
            for m in models:
                seen[m] = seen.get(m, 0) + 1
            views = page.evaluate(
                "()=>({w:kirafanRL.world.enemies.length,v:kirafanRL.views.enemies.length})")
            if views["w"] != views["v"]:
                result["errors"].append(
                    f"room {r['id']} ({r['type']}): {views['w']} world enemies but {views['v']} views")
        result["vol4_models"] = {k.split("/")[-1]: v for k, v in sorted(seen.items())}

        # --- vol 5 final boss: animated model actually playing clips ---
        boot(page, BASE + "/game/roguelike.html?volume=5&floor=20&seed=260903")
        settle(page)
        boss_room = page.evaluate("kirafanRL.world.dungeon.boss")
        page.evaluate(
            "(id)=>{kirafanRL.world.enterRoom(id,'N');kirafanRL.step(1/60)}", boss_room)
        for _ in range(400):
            page.evaluate("kirafanRL.step(1/60)")
            dismiss(page)
            page.wait_for_timeout(10)
            st = page.evaluate(
                "()=>({p:kirafanRL.pending,l:kirafanRL.roomLoading,"
                "v:kirafanRL.views.enemies.length})")
            if not st["p"] and not st["l"] and st["v"]:
                break
        result["vol5_boss"] = page.evaluate("""(() => {
            const v = kirafanRL.views.enemies[0];
            return { model: v.unit.model, kind: v.unit.kind, current: v.current,
                     mixer: !!v.mixer, bossHp: v.unit.hp };
        })()""")
        page.screenshot(path=str(ROOT / ".cache/plan-B1-vol5-boss.png"))
        browser.close()
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
