"""T25 extension: all 41 playable identities, real inputs, one segment slice.

Per card: real roster selection, real keyboard casts of skill 2/3 and the
ultimate (gauge is staged like T25), a real normal attack hit on a prepared
high-HP target, then a real segment flow slice: two battle rooms of the
volume's first segment driven through the same inputState entry the page
reads, cleared with fixed-step updates. This is not a five-floor claim.

The five-volume identity regression (T25's pending range) runs this per
volume: `python -X utf8 tools/rl_identity_segments_browser.py --volume N`.
Optional name/id filters still narrow the roster; the report lands at
.codex-tmp/identity-segments/report-v{N}.json (volume 1 defaults to the
historic report.json name).
"""
import functools
import json
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import dismiss_dialogue

OUT = ROOT / ".codex-tmp" / "identity-segments"
STEPS_PER_ROOM = 3600


def drive_and_clear(page, max_steps=STEPS_PER_ROOM):
    """Nearest-enemy walk + attack through the page's own input entry."""
    return page.evaluate("""maxSteps => {
        const k = window.kirafanRL, w = k.world, p = w.player;
        w.frozen = false;
        let steps = 0, lastDist = Infinity, stall = 0;
        let detour = 0, detourSign = 1;
        while (steps < maxSteps && !p.dead && w.enemies.some(e => !e.dead)) {
            let target = null, dist = Infinity;
            for (const e of w.enemies) {
                if (e.dead) continue;
                const d = Math.hypot(e.x - p.x, e.y - p.y);
                if (d < dist) { dist = d; target = e; }
            }
            const input = { move: { x: 0, y: 0 }, attack: false, dodge: false,
                ultimate: false, skill: [false, false, false] };
            if (target) {
                w.aim = { x: target.x, y: target.y };
                const dx = (target.x - p.x) / dist, dy = (target.y - p.y) / dist;
                const desired = p.weaponProfile.kind === "projectile"
                    ? Math.min(6, p.weaponProfile.range * .7) : p.weaponProfile.range * .85;
                if (dist > desired + .1) {
                    // Straight-line approach stalls on room solids; when no
                    // progress is made for 20 frames, steer around for 60.
                    if (dist < lastDist - .02) { stall = 0; } else { stall++; }
                    lastDist = dist;
                    if (detour <= 0 && stall >= 20) { detour = 60; detourSign = -detourSign; stall = 0; }
                    let mx = dx, my = dy;
                    if (detour > 0) {
                        detour--;
                        mx = dx * .45 - dy * .9 * detourSign;
                        my = dy * .45 + dx * .9 * detourSign;
                    }
                    const len = Math.hypot(mx, my) || 1;
                    input.move = { x: mx / len, y: my / len };
                } else {
                    input.attack = true;
                }
            }
            w.inputState = input;
            w.update(1/60);
            steps++;
        }
        w.frozen = true;
        w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false,
            ultimate: false, skill: [false, false, false] };
        const foes = w.enemies.filter(e => !e.dead).map(e => ({
            hp: Math.round(e.hp), x: +e.x.toFixed(2), y: +e.y.toFixed(2),
            d: +Math.hypot(e.x - p.x, e.y - p.y).toFixed(2),
            ai: e.aiType, elite: !!e.elite, kind: e.kind }));
        return { steps, dead: p.dead, cleared: !w.enemies.some(e => !e.dead),
            hp: Math.round(p.hp), maxHp: p.maxHp, foes,
            px: +p.x.toFixed(2), py: +p.y.toFixed(2),
            swingRange: p.weaponProfile.range };
    }""", max_steps)


def battle_rooms(page):
    return page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world;
        return w.dungeon.rooms.filter(r => r.type === "battle").slice(0, 2)
            .map(r => r.id);
    }""")


def enter_room(page, room_id):
    page.evaluate("""id => {
        const w = window.kirafanRL.world;
        w.enterRoom(id, null);
        window.kirafanRL.step(1/60);
    }""", room_id)
    page.wait_for_function("window.kirafanRL.pending === 0 && !window.kirafanRL.roomLoading", timeout=30000)


def run_card(page, url, card, errors, index=0):
    checks = []
    def check(label, ok, detail=None):
        checks.append({"label": label, "ok": bool(ok), "detail": detail})
        return bool(ok)
    def stage(text):
        print("    [%02d] %s" % (index, text), flush=True)

    stage("goto")
    page.goto(url, wait_until="load", timeout=60000)
    page.wait_for_selector(".roster-card", timeout=40000)
    page.locator(".roster-card").filter(has_text=card["displayNameZh"]).first.click()
    stage("selected; waiting for player view")
    page.wait_for_function(
        "window.kirafanRL?.world?.player && window.kirafanRL.views?.player", timeout=40000)
    dismiss_dialogue(page)
    stage("dialogue dismissed")
    page.evaluate("window.kirafanRL.world.frozen = true")
    if not check(card["displayNameZh"] + " selected",
                 page.evaluate("window.kirafanRL.world.player.card.id") == card["id"]):
        return checks
    # Prepared target for the real-input probes; no AI pressure.
    page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world, p = w.player;
        const art = w.encounter.mobs[0];
        window.t25Foe = w.spawnEnemy({ x: p.x + 1.6, y: p.y, hp: 1000000,
            atk: 0, mgc: 0, def: 0, mdef: 0, luck: 0, model: art.model,
            nameZh: art.nameZh, shadowScale: art.shadowScale,
            aiType: "sentry", moveset: { attacks: [], support: [], gimmicks: [] } });
        w.enemies.forEach(e => { if (e !== window.t25Foe) e.actionTimer = 1e9; });
        k.step(1/60);
    }""")
    stage("probe target staged")
    page.wait_for_function("window.kirafanRL.pending === 0", timeout=30000)
    # Real keyboard: normal attack on the prepared target.
    before = page.evaluate("window.t25Foe.hp")
    page.evaluate("window.kirafanRL.world.frozen = false")
    page.keyboard.down("KeyJ")
    page.evaluate("""() => { const k = window.kirafanRL;
        for (let i = 0; i < 45; i++) k.step(1/60); k.world.frozen = true; }""")
    page.keyboard.up("KeyJ")
    after = page.evaluate("window.t25Foe.hp")
    check(card["displayNameZh"] + " real-key normal attack lands", after < before,
          {"before": before, "after": after})
    # Real keyboard: skill 2 and skill 3 (effects verified as state changes).
    stage("probes: skill slots")
    for slot, key in ((1, "Digit2"), (2, "Digit3")):
        stage("skill slot %d: read state" % slot)
        state = page.evaluate("""slot => {
            const p = window.kirafanRL.world.player, s = p.skills.slots[slot];
            return { remaining: s.remaining, buffs: p.skills.buffs.length,
                nextAtk: p.nextAtkBonus || 0, hp: p.hp,
                foeHp: window.t25Foe.hp };
        }""", slot)
        page.evaluate("window.kirafanRL.world.frozen = false")
        stage("skill slot %d: key down" % slot)
        page.keyboard.down(key)
        stage("skill slot %d: cast step" % slot)
        page.evaluate("window.kirafanRL.step(1/60)")
        page.keyboard.up(key)
        stage("skill slot %d: settle 60 steps" % slot)
        page.evaluate("""() => { const k = window.kirafanRL;
            for (let i = 0; i < 60; i++) k.step(1/60); k.world.frozen = true; }""")
        stage("skill slot %d: read result" % slot)
        result = page.evaluate("""slot => {
            const p = window.kirafanRL.world.player, s = p.skills.slots[slot];
            return { remaining: s.remaining, buffs: p.skills.buffs.length,
                nextAtk: p.nextAtkBonus || 0, hp: p.hp,
                foeHp: window.t25Foe.hp };
        }""", slot)
        changed = (result["remaining"] > state["remaining"]
                   or result["buffs"] > state["buffs"]
                   or result["nextAtk"] > state["nextAtk"]
                   or result["foeHp"] < state["foeHp"])
        check(card["displayNameZh"] + " real-key skill slot " + str(slot + 1), changed, {"before": state, "after": result})
        page.evaluate("window.t25Foe.hp = 1000000")
    # Real keyboard: ultimate, staged gauge like T25.
    stage("probes: ultimate")
    page.evaluate("""() => { const p = window.kirafanRL.world.player;
        p.skills.addGauge(p.skills.gaugeMax); }""")
    page.evaluate("window.kirafanRL.world.frozen = false")
    page.keyboard.down("Digit1")
    # useUltimate spends synchronously on the cast press; the row's own gauge
    # sub-effect refills later, so the spend evidence must be read here.
    spent = page.evaluate("""() => {
        window.kirafanRL.step(1/60);
        const p = window.kirafanRL.world.player;
        return { gauge: p.skills.gauge, gaugeMax: p.skills.gaugeMax };
    }""")
    page.keyboard.up("Digit1")
    page.wait_for_function("!window.kirafanRL.ultimate.loading", timeout=60000)
    page.evaluate("() => { const k = window.kirafanRL; k.skipUltimate(); }")
    page.evaluate("""() => { const k = window.kirafanRL; k.world.frozen = false;
        for (let i = 0; i < 40; i++) k.step(1/60); k.world.frozen = true; }""")
    # Some ultimate rows refill part of the gauge in the same cast frame, so
    # any gauge below the just-staged maximum is spend evidence; a failed cast
    # would leave it at gaugeMax.
    check(card["displayNameZh"] + " real-key ultimate consumed the gauge",
          spent["gauge"] < spent["gaugeMax"], spent)
    # Segment flow slice: two real battle rooms, cleared through inputState.
    rooms = battle_rooms(page)
    for room_index, room_id in enumerate(rooms):
        stage("battle room %d enter" % (room_index + 1))
        enter_room(page, room_id)
        result = drive_and_clear(page)
        stage("battle room %d done (steps=%d cleared=%s dead=%s)"
              % (room_index + 1, result["steps"], result["cleared"],
                 result["dead"]))
        check(card["displayNameZh"] + " segment room " + str(room_index + 1) + " cleared",
              result["cleared"] and not result["dead"],
              {"steps": result["steps"], "hp": result["hp"], "maxHp": result["maxHp"],
               "foes": result["foes"], "player": [result["px"], result["py"]],
               "swingRange": result["swingRange"]})
    return checks


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    roster_text = (ROOT / "site/game/rl/rosterids.js").read_text(encoding="utf-8")
    tail = roster_text.split("PLAYABLE_ROSTER = Object.freeze(", 1)[1]
    end = tail.find("]);")
    payload = tail[:end + 1]
    roster = json.loads(payload)
    flags = [a for a in sys.argv[1:] if a.startswith("-")]
    filters = [a for a in sys.argv[1:] if not a.startswith("-")]
    volume = 1
    for flag in flags:
        if flag.startswith("--volume="):
            volume = int(flag.split("=", 1)[1])
        elif flag == "--volume" and filters:
            volume = int(filters.pop(0))
    if volume not in range(1, 6):
        raise SystemExit("--volume must be 1..5")
    if filters:
        roster = [c for c in roster
                  if any(f in c["nameZh"] or str(c["id"]) == f for f in filters)]
        if not roster:
            raise SystemExit("no roster match: " + repr(filters))
    roster_cards = json.loads((ROOT / "site/asset/rl/cards-rl.json")
                              .read_text(encoding="utf-8"))["cards"]
    display = {c["id"]: c.get("characterZh") or c.get("nameZh") or c.get("name")
               for c in roster_cards}
    for card in roster:
        card["displayNameZh"] = display.get(card["id"], card["nameZh"])
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    server = Server(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = ("http://127.0.0.1:%d/site/game/roguelike.html?volume=%d&seed=17"
           % (server.server_address[1], volume))
    errors, results = [], []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            for card_index, card in enumerate(roster):
                context = browser.new_context(viewport={"width": 1280, "height": 800})
                page = context.new_page()
                name = card["displayNameZh"]
                page.on("pageerror", lambda e, n=name: errors.append(n + ": " + str(e)[:200]))
                page.on("console", lambda m, n=name: errors.append(n + " console: " + m.text[:150]) if m.type == "error" else None)
                try:
                    checks = run_card(page, url, card, errors, card_index)
                except Exception as exc:
                    checks = [{"label": card["displayNameZh"] + " crashed", "ok": False, "detail": str(exc)[:300]}]
                results.append({"cardId": card["id"], "name": card["displayNameZh"],
                                "passed": sum(1 for c in checks if c["ok"]),
                                "total": len(checks), "checks": checks})
                context.close()
                print("%s: %d/%d" % (card["displayNameZh"], results[-1]["passed"], results[-1]["total"]), flush=True)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    report = {"volume": volume, "errors": errors, "results": results,
              "passedCards": sum(1 for r in results if r["passed"] == r["total"]),
              "totalChecks": sum(r["total"] for r in results)}
    # Volume 1 keeps the historic report.json name; later volumes are suffixed.
    report_name = "report.json" if volume == 1 else "report-v%d.json" % volume
    (OUT / report_name).write_text(
        json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("cards fully passed: %d/41, checks: %d (volume %d)"
          % (report["passedCards"], report["totalChecks"], volume), flush=True)


if __name__ == "__main__":
    main()
