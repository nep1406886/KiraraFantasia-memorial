# Browser check for the 20-layer descent (阶段 5; spec/02 §3, spec/04 §5):
#   1. boot vol1 -> HUD reads 卷名 · 段名 · 1/20, floorsPerVolume is 20
#   2. floor 1's boss room holds a 層守衛 (an elite, kind "enemy"): no boss
#      bar, no v1_boss_pre
#   3. killing the guard rescues this floor's 残页 (page 29001000) and
#      descends: floor 2, new dungeon, HUD 2/20, segment still 港町
#   4. ?floor=6/11/16 boot the 海底/深层/巨浪 segments: biome + fog + HUD
#      段名 all switch; vol2 floor 11 is a night segment (key light)
#   5. ?floor=20 boots the real boss: boss bar + v1_boss_pre; killing it
#      clears the volume (roster grew, volumes=1, all 7 pages swept, no
#      descent — floor stays 20)
# Owns its server. Usage: python tools/rl_floor_browser.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

BOX_STATE = """(() => {
  const box = document.getElementById('dialogue-box');
  if (!box || box.style.display === 'none') {
    return {vis: false, name: '', text: ''};
  }
  const body = box.children[1];
  return { vis: true,
           name: body ? body.children[0].textContent : '',
           text: body ? body.children[1].textContent : '' };
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
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate("Boolean(%s)" % expr):
            return True
        page.wait_for_timeout(150)
    return False


def box(page):
    return page.evaluate(BOX_STATE)


def click_through(page, limit=90):
    for _ in range(limit):
        if not box(page)["vis"]:
            return True
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    return not box(page)["vis"]


def pick_yuno(page):
    page.wait_for_selector(".roster-card", timeout=20000)
    page.evaluate("""(() => {
        const els = Array.from(document.querySelectorAll('.roster-card'));
        const yuno = els.find(e => (e.textContent || '').includes('由乃'));
        (yuno || els[0]).click();
    })()""")


# Kill everything alive in the room through the real funnel: one aimed player
# bullet per enemy, then step until the world says the room is done. Returns
# once floorClear has been consumed (descend() flips world.floor synchronously,
# the dungeon rebuild lands one preload later).
KILL_ROOM = """(() => {
  const w = window.kirafanRL.world;
  w.enemies.forEach(e => {
    if (e.dead) return;
    e.iframes = 0;
    w.danmaku.emit('aimed', {x: e.x - 3, y: e.y, angle: 0},
        {side: 'player', power: 999999999, coef: 1, count: 1,
         speed: 10, life: 4});
  });
})()"""


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8965
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
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            # --- 1. boot: HUD + ladder --------------------------------
            page.goto(url + "?volume=1", wait_until="load", timeout=60000)
            page.evaluate("localStorage.clear()")
            boot(page, url + "?volume=1")
            pick_yuno(page)
            wait_for(page, "window.kirafanRL.world.dungeon")
            for _ in range(30):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(10)
            check("HUD reads 卷名 · 段名 · 1/20",
                  page.evaluate("document.getElementById('floor-display').textContent")
                  == "褪色之海 · 港町 · 1/20",
                  page.evaluate("document.getElementById('floor-display').textContent"))
            check("world is on the 20-floor ladder",
                  page.evaluate("window.kirafanRL.world.floor === 1"
                                " && window.kirafanRL.world.floorsPerVolume === 20"))
            check("floor 1 biome is the volume base",
                  page.evaluate("window.kirafanRL.floorBiome === '1018_0'"))
            click_through(page)

            # --- 2. floor 1 boss room = 層守衛 -------------------------
            page.evaluate("""(() => {
                const k = window.kirafanRL;
                const boss = k.world.dungeon.rooms.find(r => r.type === 'boss');
                k.world.enterRoom(boss.id, 'N');
            })()""")
            for _ in range(30):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(10)
            guard = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const foes = w.enemies.filter(e => !e.dead);
                return { total: foes.length,
                         bosses: foes.filter(e => e.kind === 'boss').length,
                         elites: foes.filter(e => e.elite).length };
            })()""")
            check("guard room holds elites, not a boss",
                  guard["total"] > 0 and guard["bosses"] == 0 and guard["elites"] >= 1,
                  guard)
            check("boss bar stays down for a guard",
                  page.evaluate(
                      "document.getElementById('boss-bar').style.display === 'none'"))
            page.wait_for_timeout(1200)
            check("no v1_boss_pre at a guard room", not box(page)["vis"])

            # --- 3. guard kill -> page rescue + descent ----------------
            page.evaluate(KILL_ROOM)
            check("guard kill crosses to floor 2",
                  wait_for(page, "window.kirafanRL.world.floor === 2"))
            check("descent rebuilds the dungeon (start room entered)",
                  wait_for(page,
                      "window.kirafanRL.world.roomId"
                      " === window.kirafanRL.world.dungeon.start"))
            check("new dungeon has a full room set",
                  page.evaluate(
                      "window.kirafanRL.world.dungeon.rooms.length >= 6"),
                  page.evaluate("window.kirafanRL.world.dungeon.rooms.length"))
            check("HUD reads 2/20 (still 港町 — 5 floors per segment)",
                  page.evaluate("document.getElementById('floor-display').textContent")
                  == "褪色之海 · 港町 · 2/20",
                  page.evaluate("document.getElementById('floor-display').textContent"))
            page1 = page.evaluate("""(() => import('/site/game/rl/meta.js')
                .then(m => m.createMeta().read().pages))()""")
            check("floor 1's 残页 (29001000) was rescued",
                  page1 == ["29001000"], page1)
            for _ in range(30):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(10)
            check("no pageerrors after the descent", not errors, errors[:3])

            # --- 4. segment jumps --------------------------------------
            # Same browser context: the save (prologue seen, page 29001000)
            # carries over, which is exactly what a returning player has.
            for floor, seg, biome, fog in (
                    (6, "海底", "1018_1", "a8d8dc"),
                    (11, "深层", "1018_2", "6a92a8"),
                    (16, "巨浪", "1018_5", "bcd4d8")):
                boot(page, "%s?volume=1&floor=%d" % (url, floor))
                pick_yuno(page)
                wait_for(page, "window.kirafanRL.world.dungeon")
                for _ in range(20):
                    page.evaluate("window.kirafanRL.step(1/60)")
                    page.wait_for_timeout(10)
                click_through(page)
                got_fog = page.evaluate(
                    "window.kirafanRL.scene.fog.color.getHexString()")
                got_hud = page.evaluate(
                    "document.getElementById('floor-display').textContent")
                check("floor %d boots the %s segment" % (floor, seg),
                      page.evaluate("window.kirafanRL.floorBiome === '%s'" % biome)
                      and seg in got_hud and got_fog == fog,
                      (page.evaluate("window.kirafanRL.floorBiome"), got_hud, got_fog))

            # vol2 floor 11 = 夜沙丘, the first authored night segment
            boot(page, url + "?volume=2&floor=11")
            pick_yuno(page)
            wait_for(page, "window.kirafanRL.world.dungeon")
            for _ in range(20):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(10)
            click_through(page)
            night = page.evaluate("""(() => {
                const dir = window.kirafanRL.scene.children
                    .filter(c => c.isDirectionalLight)[0];
                return dir ? dir.color.getHexString() : null;
            })()""")
            check("夜沙丘 is lit by the night key (#c9d4f0)", night == "c9d4f0", night)

            # --- 5. floor 20: the real boss ----------------------------
            page.evaluate("localStorage.clear()")
            boot(page, url + "?volume=1&floor=20")
            pick_yuno(page)
            wait_for(page, "window.kirafanRL.world.dungeon")
            for _ in range(30):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(10)
            click_through(page)     # v1_open
            page.evaluate("""(() => {
                const k = window.kirafanRL;
                const boss = k.world.dungeon.rooms.find(r => r.type === 'boss');
                k.world.enterRoom(boss.id, 'N');
            })()""")
            for _ in range(30):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(10)
            check("floor 20 boss room holds the real boss",
                  page.evaluate(
                      "window.kirafanRL.world.enemies.some(e => e.kind === 'boss')"))
            check("boss bar is up for the real boss",
                  page.evaluate(
                      "document.getElementById('boss-bar').style.display !== 'none'"))
            check("v1_boss_pre plays at the floor-20 boss",
                  wait_for(page, "Boolean(document.getElementById('dialogue-box')"
                                 " && !document.getElementById('dialogue-box').classList.contains('dlg-hidden')"
                                 " && !document.getElementById('dialogue-box').classList.contains('dlg-out'))"))
            click_through(page)

            roster0 = page.evaluate("""(() => import('/site/game/rl/meta.js')
                .then(m => m.createMeta().read().chars.length))()""")
            page.evaluate(KILL_ROOM)
            check("boss died and the volume-end chain started",
                  wait_for(page, "Boolean(document.getElementById('dialogue-box')"
                                 " && !document.getElementById('dialogue-box').classList.contains('dlg-hidden')"
                                 " && !document.getElementById('dialogue-box').classList.contains('dlg-out'))"))
            click_through(page)
            check("no descent past the final floor",
                  page.evaluate("window.kirafanRL.world.floor === 20"))
            state = page.evaluate("""import('/site/game/rl/meta.js')
                .then(m => { const s = m.createMeta().read();
                             return { volumes: s.volumes, pages: s.pages,
                                      chars: s.chars.length }; })""")
            # T22l already opens all 40; a clear must preserve that roster.
            check("volume cleared (volumes=1, authored 40 preserved)",
                  state["volumes"] == 1 and roster0 == 40 and state["chars"] == 40,
                  (roster0, state))
            check("all 7 vol1 pages swept on the volume clear",
                  state["pages"] and set(state["pages"]) >= set(
                      ["29001000", "47002000", "28001000", "31001000",
                       "21000000", "11010000", "19000000"]), state["pages"])
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
