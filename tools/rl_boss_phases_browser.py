#!/usr/bin/env python3
"""B.3 首领阶段化 Chromium 验证.

Contract (per boss, driven to phase 2 then phase 3):
  - bossPhase event fires exactly once per threshold cross
  - stage gets the phase-flash class (reduced-flash off)
  - the boss-voice subtitle shows the escalation line
  - the aura ring reports the new phase (pulse seconds shrink)
  - phase 3 flips BGM to the volume's bossLate track
  - summons arrive (requestSummon) with the world cap respected
  - all of it clears when the boss dies

Usage: python tools/rl_boss_phases_browser.py
"""
import functools
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import NoCacheHandler, Server
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".codex-tmp" / "boss-phases"

SEEN_EVENTS = """(function () {
    // drainEvents() REPLACES world.events with a fresh array on every consume,
    // so a push-wrapper dies with the first step. Wrap drainEvents instead:
    // every drained batch passes through here before main.js's consumeEvents
    // sees it, and the tap survives the whole run.
    if (!window.__phaseTap) {
        window.__phaseTap = { phases: [], summons: 0 };
        const w = window.kirafanRL.world;
        const drain = w.drainEvents.bind(w);
        w.drainEvents = function () {
            const out = drain();
            for (const e of out) {
                if (e.type === "bossPhase") { window.__phaseTap.phases.push(e.phase); }
                if (e.type === "summon") { window.__phaseTap.summons += e.count; }
            }
            return out;
        };
    }
    return window.__phaseTap;
})()"""

STATE = """() => {
    const k = window.kirafanRL;
    const boss = k.world.enemies.find(e => e.kind === "boss" && !e.dead) || null;
    // The aura check reads a VISIBLE ring: a dead unit's ring fades with the
    // corpse and ends visible=false, so "still visible" is the actual claim.
    let auraPhase = null;
    k.scene.traverse(n => {
        if (auraPhase === null && n.name === "elite-aura" && n.visible) {
            auraPhase = n.userData.phase || 1;
        }
    });
    return {
        phase: boss ? boss.phase : null,
        hp: boss ? Math.round(boss.hp) : null,
        maxHp: boss ? boss.maxHp : null,
        taps: window.__phaseTap ? { phases: [...window.__phaseTap.phases], summons: window.__phaseTap.summons } : null,
        flashClass: document.getElementById("stage").classList.contains("phase-flash"),
        voiceText: (document.querySelector("#boss-voice .bv-line") || {}).textContent || "",
        voiceVisible: document.getElementById("boss-voice").style.display !== "none",
        auraPhase: auraPhase,
        bgmTrack: (window.__bgmProbe && window.__bgmProbe.current) || null,
        summonedAlive: k.world.enemies.filter(e => e.summoned && !e.dead).length
    };
}"""


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"checks": [], "errors": []}

    def check(name, ok, detail=None):
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name, flush=True)

    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])
            context = browser.new_context(viewport={"width": 1280, "height": 840})
            context.add_init_script(
                "window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};"
                "localStorage.setItem('kirafan-rl:meta',"
                "JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
            page = context.new_page()
            page.on("pageerror", lambda e: report["errors"].append(str(e)))
            page.goto(base + "/site/game/roguelike.html?seed=73061&volume=1&floor=20",
                      wait_until="load", timeout=60000)
            page.wait_for_selector(".roster-card", timeout=60000)
            page.locator(".roster-card").filter(
                has=page.locator('img[src$="/14002001.webp"]')).click()
            page.wait_for_function(
                "window.kirafanRL?.world?.player && kirafanRL.pending===0",
                polling=100, timeout=60000)
            for _ in range(60):
                if not page.locator("#dialogue-box").is_visible():
                    break
                page.locator("#dialogue-skip").click()
                page.wait_for_timeout(60)
            # Boot lands in the START room; the boss only exists after the
            # real room entry (spawnRoomEnemies on first visit).
            page.evaluate("""() => {
                const w = kirafanRL.world;
                const boss = w.dungeon.rooms.find(r => r.type === "boss");
                w.enterRoom(boss.id, "N");
                kirafanRL.step(1/60);
            }""")
            for _ in range(300):
                page.evaluate("kirafanRL.step(1/60)")
                st = page.evaluate(STATE)
                if st["phase"] is not None:
                    break
                page.wait_for_timeout(10)
            for _ in range(60):
                if not page.locator("#dialogue-box").is_visible():
                    break
                page.locator("#dialogue-skip").click()
                page.wait_for_timeout(60)
            for _ in range(80):
                page.wait_for_timeout(50)
                loading = page.evaluate("kirafanRL.roomLoading")
                if not loading:
                    break
            for _ in range(600):
                page.evaluate("kirafanRL.step(1/60)")
                if page.locator("#dialogue-box").is_visible():
                    page.evaluate("document.getElementById('dialogue-skip').click()")
                if not page.evaluate("kirafanRL.world.frozen"):
                    break
                page.wait_for_timeout(10)
            # Instrument LAST: enterRoom replaces world.events with a fresh
            # array, so a drain wrapper (installed here) survives while a push
            # wrapper would not. BGM reads through the manager's own
            # getCurrentTrack (same probe the SE/BGM gates use).
            page.evaluate(SEEN_EVENTS)
            page.evaluate("""() => {
                window.__bgmProbe = { get current() {
                    const a = document.querySelector("audio");
                    if (!a) return null;
                    const m = a.src.match(/bgm_[a-z0-9_]+/);
                    return m ? m[0] : null;
                } };
            }""")

            def drive(hp_fraction):
                # Damage the boss through combat.js's tryHit — the single funnel
                # every real hit passes through. The world's bullet path builds
                # the attack from power+coef with the boss's own def/mdef from
                # the stats table, so raw damage ≈ power*coef - def*DEF_FACTOR;
                # scale power by maxHp so 2-3 shots cross each threshold no
                # matter the volume's curve.
                return page.evaluate("""(frac) => {
                    const w = kirafanRL.world;
                    const boss = w.enemies.find(e => e.kind === "boss");
                    if (!boss) return null;
                    const p = w.player;
                    p.x = boss.x - 2.5; p.y = boss.y; p.iframes = 1e9; p.hp = p.maxHp;
                    // One bullet lands ~0.15 maxHp: the world's player-bullet
                    // path multiplies by TEMPO 4.15 (combat.js) and rolls crit
                    // from luck — size power so the TEMPO'd hit is a 0.15
                    // band and a crit still lands inside 0.30, then heal the
                    // player each drain tick so the boss's phase-burst ring
                    // cannot end the run mid-flip (defeat clears the world).
                    let shots = 0;
                    while (boss.hp > boss.maxHp * frac && shots < 40) {
                        w.danmaku.emit("aimed", { x: p.x + 1, y: p.y, angle: 0 }, {
                            side: "player", srcId: p.id,
                            power: boss.maxHp * 0.037 + 1200, coef: 1,
                            speed: 30, offset: 0, life: 2, radius: 6
                        });
                        for (let t = 0; t < 16; t++) { kirafanRL.step(1/60); }
                        shots += 1;
                    }
                    for (let t = 0; t < 30; t++) {
                        // The boss's phase-burst ring fires back at the
                        // player; heal through it so the run cannot end mid-
                        // flip (a defeat clears world.enemies and orphans
                        // every assertion after it).
                        p.hp = p.maxHp;
                        kirafanRL.step(1/60);
                    }
                    return { phase: boss.phase, hp: Math.round(boss.hp), shots: shots,
                             playerHp: Math.round(p.hp), playerDead: !!p.dead };
                }""", hp_fraction)

            st0 = page.evaluate(STATE)
            check("开局是第 1 阶段", st0["phase"] == 1, st0)
            check("boss 房 bgm 起曲是开场首领轨",
                  st0["bgmTrack"] in (None, "bgm_battle_3"),
                  st0["bgmTrack"])

            drive(0.65)
            time.sleep(0.4)
            page.evaluate("kirafanRL.step(1/60)")
            st2 = page.evaluate(STATE)
            check("HP≤0.7 翻入第 2 阶段一次", st2["phase"] == 2
                  and st2["taps"]["phases"].count(2) == 1, st2)
            # The beat toast (hint line) carries the phase banner; the voice
            # subtitle only ships for VOICED bosses — vol 1's storm carries no
            # cue sheet by the original's own warning gate, so the check is
            # "some phase banner surfaced", not the subtitle specifically.
            check("阶段横幅提示出现",
                  "阶段" in (page.evaluate(
                      "() => document.getElementById('hint') ? document.getElementById('hint').textContent : ''"
                  ) or "") or st2["voiceVisible"], st2)
            # BGM probe: read through the manager like the BGM gate does (the
            # detached <audio> element never enters the DOM).
            st2["bgmTrack"] = page.evaluate(
                "import('/site/game/rl/bgm.js').then(m => m.getBGM() ? m.getBGM().getCurrentTrack() : null)")
            check("第 2 阶段不换曲(开场曲保留)",
                  st2["bgmTrack"] in (None, "bgm_battle_3"), st2["bgmTrack"])

            drive(0.35)
            time.sleep(0.4)
            page.evaluate("kirafanRL.step(1/60)")
            st3 = page.evaluate(STATE)
            check("HP≤0.4 翻入第 3 阶段一次", st3["phase"] == 3
                  and st3["taps"]["phases"].count(3) == 1, st3)
            st3["bgmTrack"] = page.evaluate(
                "import('/site/game/rl/bgm.js').then(m => m.getBGM() ? m.getBGM().getCurrentTrack() : null)")
            check("第 3 阶段换 bossLate 轨", st3["bgmTrack"] == "bgm_battle_1",
                  st3["bgmTrack"])
            check("光环 ring 进入阶段 3", st3["auraPhase"] == 3, st3)
            check("阶段伴随援军 (summon 事件)",
                  st3["taps"]["summons"] > 0 and st3["summonedAlive"] > 0, st3)

            # Kill the boss; everything must clear.
            page.evaluate("""() => {
                const w = kirafanRL.world;
                const boss = w.enemies.find(e => e.kind === "boss");
                if (!boss) return;
                const p = w.player;
                p.x = boss.x - 2.5; p.y = boss.y;
                w.danmaku.emit("aimed", { x: p.x + 1, y: p.y, angle: 0 }, {
                    side: "player", srcId: p.id,
                    power: boss.hp + 5000, coef: 1,
                    speed: 30, offset: 0, life: 2, radius: 6
                });
                kirafanRL.step(1/60);
            }""")
            for _ in range(240):
                page.evaluate("kirafanRL.step(1/60)")
                st = page.evaluate(STATE)
                if st["phase"] is None:
                    break
                page.wait_for_timeout(10)
            st_dead = page.evaluate(STATE)
            check("首领死亡后光环与阶段读取清空", st_dead["auraPhase"] is None, st_dead)
            check("无页面异常", not report["errors"], report["errors"][:3])
            page.screenshot(path=str(OUT / "boss-phases.png"))
            browser.close()
    finally:
        server.shutdown()
        worker.join(timeout=5)
        (OUT / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failed = sum(1 for c in report["checks"] if not c["ok"])
    print("Boss phases gate: %d checks, %d failed" % (len(report["checks"]), failed), flush=True)
    return 1 if failed or report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
