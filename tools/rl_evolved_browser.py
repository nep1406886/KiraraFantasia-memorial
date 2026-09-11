# Browser gate for T21a (spec/01 §5 rule 5, spec/06 T21a): the player
# renders the card's EVOLVED model, matching the 模型观察室 (models.js),
# while stats stay keyed to the roster row.
#   1. boot -> pick リン (roster row 23001000, base rid 230001, evolved 230002)
#      -> actor.resourceId is "230002" (not the base 230001)
#   2. the evolved actor is fully functional: weapon parts mounted on
#      Loc/Weapon sockets, attack + skill clips present, face table loaded
#   3. a fresh boot renders one frame with zero console warnings
#   4. no-evolution regression: ゆの (rid 100000, evolvedResourceId null)
#      still loads the base model — the switch must not invent forms
# Owns its server. Usage: python tools/rl_evolved_browser.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

ROSTER_URL = "/site/game/roguelike.html"


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


def pick(page, model_text):
    page.wait_for_selector(".roster-card", timeout=20000)
    return page.evaluate(
        """(text) => {
            const els = Array.from(document.querySelectorAll('.roster-card'));
            const hit = els.find(e => (e.textContent || '').includes(text));
            if (hit) { hit.click(); return true; }
            return false;
        }""",
        model_text,
    )


# Resolves once the actor exists; reports the fields the gate asserts on.
ACTOR_PROBE = """(() => {
  const rl = window.kirafanRL;
  const view = rl && rl.views && rl.views.player;
  const a = view && view.actor;
  if (!a) { return {ready: false}; }
  let weapons = 0;
  ["Loc_L", "Loc_R", "Weapon_L", "Weapon_R"].forEach(function (name) {
    const socket = a.object.getObjectByName(name);
    if (socket) { weapons += socket.children.length; }
  });
  rl.renderOnce();
  return { ready: true,
           rid: a.resourceId,
           weapons: weapons,
           clips: a.actionNames,
           faces: a.faceNames ? a.faceNames.length : 0 };
})()"""


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8975
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = 0

    def check(label, ok, detail=""):
        nonlocal fails
        mark = "OK " if ok else "FAIL"
        print("%s  %s%s" % (mark, label, ("  -- " + str(detail)) if detail else ""))
        if not ok:
            fails += 1

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page()
            warnings = []
            # ".WebGL-…GL Driver Message" is ANGLE/Chromium noise from the
            # ReadPixels in renderOnce(), not an application warning.
            page.on("console", lambda m: warnings.append(m.text)
                    if m.type in ("warning", "error")
                    and "GL Driver Message" not in m.text else None)

            # -- 1-3: an evolvable character loads her evolved form ----------
            if not boot(page, "http://127.0.0.1:%d%s" % (port, ROSTER_URL)):
                print("FAIL  boot (kirafanRL never appeared)")
                return 1
            check("boot roguelike.html", True)

            # -- roster restyle (spec/01): token paper style + real card art --
            # The art loads eagerly, but a fast boot can still race the decode,
            # so walk the grid into view and settle before judging.
            page.wait_for_selector(".roster-card", timeout=20000)
            page.evaluate(
                "document.querySelectorAll('.roster-card').forEach(c => c.scrollIntoView())")
            page.wait_for_timeout(600)
            roster_probe = page.evaluate("""(() => {
                const cards = Array.from(document.querySelectorAll('.roster-card'));
                const arts = cards.map(c => c.querySelector('.art'));
                const loaded = arts.filter(a => a && a.tagName === 'IMG'
                    && a.complete && a.naturalWidth > 0).length;
                const missing = cards.filter(c => c.querySelector('.art.missing')).length;
                const overlay = document.getElementById('roster-overlay');
                return { count: cards.length, loaded: loaded, missing: missing,
                         sky: overlay ? getComputedStyle(overlay).backgroundColor : '',
                         paper: cards[0] ? getComputedStyle(cards[0]).backgroundColor : '',
                         star5: document.querySelectorAll('.roster-card .star5').length };
            })()""")
            check("roster shows >= 1 card", roster_probe["count"] >= 1,
                  "%d cards" % roster_probe["count"])
            check("every card's 卡面 art loaded",
                  roster_probe["missing"] == 0
                  and roster_probe["loaded"] == roster_probe["count"],
                  "loaded %d/%d, missing %d" % (roster_probe["loaded"],
                                                roster_probe["count"],
                                                roster_probe["missing"]))
            check("overlay uses the --kf-sky token", roster_probe["sky"] == "rgb(201, 230, 228)",
                  "bg=%s" % roster_probe["sky"])
            check("cards are --kf-paper panels", roster_probe["paper"] == "rgb(247, 243, 234)",
                  "bg=%s" % roster_probe["paper"])

            picked = pick(page, "志摩")  # リン's roster card (nameZh 志摩 凛)
            check("roster card for リン clicked", picked)
            if not wait_for(page, "window.kirafanRL.views.player && window.kirafanRL.views.player.actor"):
                print("FAIL  リン's actor never loaded")
                return 1

            actor = page.evaluate(ACTOR_PROBE)
            check("evolved rid 230002 rendered", actor["rid"] == "230002",
                  "actor.resourceId=%s" % actor["rid"])
            check("weapon parts mounted", actor["weapons"] > 0,
                  "sockets hold %d parts" % actor["weapons"])
            check("attack + skill clips present",
                  "attack" in actor["clips"] and "skill" in actor["clips"],
                  "clips=%s" % actor["clips"])
            check("face table loaded", actor["faces"] > 0,
                  "%d expressions" % actor["faces"])
            check("no console warnings on the evolved load",
                  not warnings, "; ".join(warnings[:3]))

            # -- 4: a no-evolution character keeps the base model ------------
            page2 = browser.new_page()
            warnings2 = []
            page2.on("console", lambda m: warnings2.append(m.text)
                     if m.type in ("warning", "error")
                     and "GL Driver Message" not in m.text else None)
            if not boot(page2, "http://127.0.0.1:%d%s" % (port, ROSTER_URL)):
                print("FAIL  second boot")
                return 1
            picked2 = pick(page2, "由乃")  # ゆの, no evolution
            check("roster card for ゆの clicked", picked2)
            if not wait_for(page2, "window.kirafanRL.views.player && window.kirafanRL.views.player.actor"):
                print("FAIL  ゆの's actor never loaded")
                return 1
            actor2 = page2.evaluate(ACTOR_PROBE)
            check("base rid 100000 kept (no invented evolution)",
                  actor2["rid"] == "100000", "actor.resourceId=%s" % actor2["rid"])
            check("no console warnings on the base load",
                  not warnings2, "; ".join(warnings2[:3]))

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    print("=" * 60)
    if fails == 0:
        print("ALL OK — evolved-form rendering verified (T21a)")
        return 0
    print(fails, "check(s) failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
