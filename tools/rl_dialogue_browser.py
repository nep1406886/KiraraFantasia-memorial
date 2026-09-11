# Browser check for the dialogue system (T12) wiring in main.js:
#   1. fresh save -> prologue plays (typewriter, 4 named lines), then persists
#      as seen; a reload skips it
#   2. selecting a character plays v1_open; the world is frozen while the box
#      is up and unfrozen after; the bust image renders for a roster character
#   3. entering the boss room plays v1_boss_pre
#   4. resting at the campfire plays the guest's rest chatter (T22g: the
#      NPC by the fire speaks; pre-T22g this was the player's own line)
#   5. dying through the real bullet funnel plays the exit line
#   6. volume=5: finale_intro + v5_open on load, finale_pre at the boss,
#      and the full boss-death chain (boss_post -> v5_close -> finale_end)
# Owns its server. Usage: python tools/rl_dialogue_browser.py [port]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

BOX_STATE = """(() => {
  const box = document.getElementById('dialogue-box');
  if (!box || box.style.display === 'none') {
    return {vis: false, name: '', text: '', bust: false, bustSrc: ''};
  }
  const body = box.children[1];
  const img = box.children[0];
  return { vis: true,
           name: body ? body.children[0].textContent : '',
           text: body ? body.children[1].textContent : '',
           bust: img ? img.style.display !== 'none' : false,
           bustSrc: img ? (img.getAttribute('src') || '') : '' };
})()"""


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            return True
        page.wait_for_timeout(200)
    return False


def wait_for(page, expr, timeout=30):
    """Poll a boolean JS expression until true."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate("Boolean(%s)" % expr):
            return True
        page.wait_for_timeout(150)
    return False


def box(page):
    return page.evaluate(BOX_STATE)


def wait_box(page, want, timeout=15):
    """Wait until the dialogue box is (not) visible."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if box(page)["vis"] == want:
            return True
        page.wait_for_timeout(150)
    return False


def click_through(page, collect=None, limit=90):
    """Advance the box until it hides; record the name-plate sequence.
    The click is dispatched on the element itself so a victory overlay
    stacked above can't intercept the pointer event."""
    names = []
    last = None
    for _ in range(limit):
        st = box(page)
        if not st["vis"]:
            return names
        if st["name"] and st["name"] != last:
            names.append(st["name"])
            last = st["name"]
        page.evaluate(
            "document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    return names


def pick_yuno(page):
    page.wait_for_selector(".roster-card", timeout=20000)
    page.locator(".roster-card").filter(has_text="由乃").click()


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8963
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = 0

    def check(label, ok, detail=""):
        nonlocal fails
        print(("OK   " if ok else "FAIL ") + label + ("  " + str(detail) if detail else ""))
        if not ok:
            fails += 1

    try:
        time.sleep(1.5)
        url = "http://127.0.0.1:%d/site/game/roguelike.html" % port
        # floor=20: floors 1-19 hold a 層守衛 (an elite, no dialogue) in the
        # boss room — the boss phases need the real, final-floor boss.
        v1_url = url + "?volume=1&floor=20"
        v5_url = url + "?volume=5&floor=20"
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            # --- 1. prologue on a fresh save -----------------------------
            # This new browser page owns a fresh context. Do not clear storage
            # under a still-initializing page and race its prologue write.
            boot(page, v1_url)
            check("prologue box appears on fresh save",
                  wait_box(page, True), "")
            t0 = box(page)
            page.wait_for_timeout(350)
            t1 = box(page)
            check("typewriter is running (text grows)", len(t1["text"]) > len(t0["text"]),
                  "%d -> %d chars" % (len(t0["text"]), len(t1["text"])))
            names = click_through(page)
            check("prologue walks its four speakers before character selection",
                  names == ["梅蒂娅", "琪拉拉", "住良木 现", "琪拉拉"], names)
            seen = page.evaluate(
                "import('/site/game/rl/meta.js').then(m => m.createMeta().read().prologueSeen)")
            check("prologue marked seen in the save", bool(seen))
            # Do not programmatically select behind the prologue. Character
            # and map loading may finish after it, leaving a legitimate gap
            # before v1_open; that gap is not a missing dialogue node.
            pick_yuno(page)
            check("character selection starts v1_open after its scene is ready", wait_box(page, True))
            opening = click_through(page)
            check("v1_open walks both speakers after the prologue", opening == ["琪拉拉", "住良木 现"], opening)
            check("world unfrozen after the opening pair",
                  page.evaluate("window.kirafanRL.world.frozen === false"))
            check("no pageerrors after boot A", not errors, errors[:3])

            # --- reload: prologue skipped ---------------------------------
            boot(page, v1_url)
            pick_yuno(page)
            check("v1_open returns after reload (box waits)",
                  wait_box(page, True))
            seq1 = click_through(page)
            check("reload skips the prologue",
                  "梅蒂娅" not in seq1 and seq1 == ["琪拉拉", "住良木 现"], seq1)
            check("dungeon is built before room teleports",
                  wait_for(page,
                      "window.kirafanRL.world.dungeon"
                      " && window.kirafanRL.world.dungeon.rooms.length"))

            # --- 3. boss room entry -> v1_boss_pre -----------------------
            page.evaluate("""(() => {
                const k = window.kirafanRL;
                const boss = k.world.dungeon.rooms.find(r => r.type === 'boss');
                k.world.enterRoom(boss.id, 'N');
            })()""")
            check("v1_boss_pre box appears at boss entry", wait_box(page, True))
            st = box(page)
            check("boss pre first speaker is きらら (bust rendered)",
                  st["name"] == "琪拉拉" and st["bust"] is True,
                  "%s bust=%s" % (st["name"], st["bust"]))
            check("world frozen while boss dialogue is up",
                  page.evaluate("window.kirafanRL.world.frozen === true"))
            click_through(page)
            check("world unfrozen after boss dialogue",
                  page.evaluate("window.kirafanRL.world.frozen === false"))

            # --- 4. rest room -> campfire chatter (T22g: the guest speaks) --
            page.evaluate("""(() => {
                const k = window.kirafanRL;
                const rest = k.world.dungeon.rooms.find(r => r.type === 'rest');
                k.world.enterRoom(rest.id, 'N');
            })()""")
            # The guest is deterministic per room; whoever it is, the first
            # talk must open THEIR line (T12 played the player's own line —
            # T22g made the campfire a real conversation partner). The card
            # resolves inside the async interact-view attach, so wait for it.
            guest = None
            deadline = time.time() + 20
            while time.time() < deadline:
                guest = page.evaluate(
                    "(() => { const c = window.kirafanRL.npcCard;"
                    " return c ? (c.characterZh || c.name) : null; })()")
                pending = page.evaluate("window.kirafanRL.interactPending")
                if guest and pending == 0:
                    break
                page.wait_for_timeout(200)
            check("a campfire guest is resolved for the room",
                  bool(guest), guest)
            page.evaluate("""(() => {
                const k = window.kirafanRL;
                k.input.state.interact = true;
                k.step(1/60);   // opens the T26 supply decision first
                k.input.state.interact = false;
                k.step(1/60);   // consumeEvents runs before the interact key,
                                // so the npcTalk event needs a second step
                k.step(1/60);
            })()""")
            page.wait_for_selector("#rl-supply-choice[open]", timeout=10000)
            check("campfire offers a supply decision before chatter", page.locator("#rl-supply-choice").is_visible())
            page.locator("#rl-supply-choice button.primary:not(:disabled)").first.click()
            page.evaluate("window.kirafanRL.step(1/60)")
            check("campfire chatter box appears", wait_box(page, True))
            st = box(page)
            check("chatter speaker is the campfire guest",
                  st["name"] == guest, "%s vs %s" % (st["name"], guest))
            # complete the typewriter, then read the full line
            page.evaluate("document.getElementById('dialogue-box').click()")
            page.wait_for_timeout(200)
            check("chatter text is non-empty",
                  page.evaluate("""(() => {
                      const b = document.getElementById('dialogue-box');
                      return b.children[1].children[1].textContent.trim().length > 0;
                  })()"""))
            click_through(page)

            # --- 5. death -> exit line ------------------------------------
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const p = w.player;
                p.iframes = 0;
                w.danmaku.emit('aimed', {x: p.x - 3, y: p.y, angle: 0},
                    {side: 'enemy', power: 9999999, coef: 1, count: 1,
                     speed: 10, life: 4});
            })()""")
            deadline = time.time() + 15
            while time.time() < deadline:
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(30)
                if box(page)["vis"]:
                    break
            check("exit line box appears on death", box(page)["vis"])
            st = box(page)
            check("exit speaker is the player (由乃)", st["name"] == "由乃", st["name"])
            click_through(page)
            check("no pageerrors after death chain", not errors, errors[:3])

            # --- 6. volume 5 finale flow ----------------------------------
            page.wait_for_selector("#rl-result[open]", timeout=20000)
            page.locator("#result-restart").click()
            page.wait_for_selector(".roster-card", timeout=20000)
            boot(page, v5_url)
            pick_yuno(page)
            check("finale_intro plays on volume-5 load", wait_box(page, True))
            frozen_v5 = page.evaluate("window.kirafanRL.world.frozen === true")
            seq5 = click_through(page)
            check("world frozen during finale_intro", frozen_v5)
            check("finale flow: intro then v5_open speakers",
                  seq5[:4] == ["琪拉拉", "住良木 现", "琪拉拉", "住良木 现"], seq5)
            check("world unfrozen after the opening pair",
                  page.evaluate("window.kirafanRL.world.frozen === false"))
            check("dungeon built for the volume-5 run",
                  wait_for(page,
                      "window.kirafanRL.world.dungeon"
                      " && window.kirafanRL.world.dungeon.rooms.length"))

            page.evaluate("""(() => {
                const k = window.kirafanRL;
                const boss = k.world.dungeon.rooms.find(r => r.type === 'boss');
                k.world.enterRoom(boss.id, 'N');
            })()""")
            check("finale_pre plays at the volume-5 boss", wait_box(page, True))
            seqb = click_through(page)
            check("finale_pre includes ハイプリス and きらら and うつつ",
                  "ハイプリス" in "".join(seqb) and len(seqb) >= 4, seqb)

            # kill the boss through the real funnel: a player bullet rides
            # danmaku -> onHit -> tryHit -> the died event the chain hangs off
            page.evaluate("""(() => {
                const k = window.kirafanRL;
                const w = k.world;
                const boss = w.enemies.find(e => e.kind === 'boss');
                if (!boss) { return; }
                boss.iframes = 0;
                w.danmaku.emit('aimed', {x: boss.x - 3, y: boss.y, angle: 0},
                    {side: 'player', power: 999999999, coef: 1, count: 1,
                     speed: 10, life: 4});
            })()""")
            deadline = time.time() + 15
            boss_dead = False
            while time.time() < deadline:
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(30)
                boss_dead = page.evaluate(
                    "window.kirafanRL.world.enemies.every(e => e.kind !== 'boss' || e.dead)")
                if boss_dead and box(page)["vis"]:
                    break
            check("boss died through the funnel", boss_dead)
            check("boss-death dialogue chain starts (boss_post)", box(page)["vis"])
            seqd = click_through(page)
            check("chain runs long enough for post+close+finale_end (>=8 lines)",
                  len(seqd) >= 8, seqd)
            check("chain ends with メディア (finale_end)",
                  seqd and seqd[-1] == "梅蒂娅", seqd)
            # T23: story completion hands off to the terminal result.
            check("world remains frozen after the finale chain",
                  page.evaluate("window.kirafanRL.world.frozen === true"))
            check("finale ends at the victory result", page.evaluate(
                "document.getElementById('rl-result')?.dataset.outcome === 'victory'"))
            check("no pageerrors overall", not errors, errors[:3])
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    print("RESULT " + ("ALL OK" if fails == 0 else "%d FAILURES" % fails))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
