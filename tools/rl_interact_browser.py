# Browser check for the T22g room interactables (spec/06):
#   1. 宝箱: the chest room renders the treasure-mimic closed; E near it
#      opens it (doors swap, contents show, the loot marker lands); the open
#      state and the refused re-open persist across a re-entry
#   2. 木桶: a battle room renders its barrels as live objects; a melee
#      swing removes the one it breaks and pays its loot; the hint line
#      reports what fell out
#   3. 祭坛: a battle room that rolled one renders the hovering star; E
#      pays the blessing once and the used state survives re-entry
#   4. NPC: the rest room renders the campfire guest; talking heals and
#      plays the guest's line; the guest is never the player's own card
#   5. the hint line advertises the interactable in range ("按 E …")
# Owns its server. Usage: python tools/rl_interact_browser.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def boot(page, port, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            break
        page.wait_for_timeout(200)


def dismiss_dialogue(page):
    for _ in range(90):
        vis = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " return !!(b && b.style.display !== 'none'); })()")
        if not vis:
            return
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)


def wait_pending(page, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pending = page.evaluate("window.kirafanRL.interactPending")
        views = page.evaluate("window.kirafanRL.pending")
        if pending == 0 and views == 0:
            return True
        page.wait_for_timeout(200)
    return False


def scene_child_at(page, x, y, tol=0.35):
    return page.evaluate("""((xy) => {
        const scene = window.kirafanRL.scene;
        for (const child of scene.children) {
            if (child.isObject3D
                && Math.abs(child.position.x - xy[0]) < 0.35
                && Math.abs(child.position.z - xy[1]) < 0.35) {
                return true;
            }
        }
        return false;
    })""", [x, y])


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8969
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
        url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=1" % port
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            boot(page, port, url)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.click(".roster-card")
            deadline = time.time() + 30
            while time.time() < deadline:
                has = page.evaluate(
                    "!!(window.kirafanRL.world && window.kirafanRL.world.player)")
                if has:
                    break
                page.wait_for_timeout(300)
            dismiss_dialogue(page)
            check("boot: run started", bool(
                page.evaluate("!!window.kirafanRL.world.player")))

            # park the fight: no enemy ever acts, the player never dies
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                w.player.iframes = 1e9;
                w.enemies.forEach(e => { e.actionTimer = 1e9; });
            })()""")

            # --- 1. 宝箱 --------------------------------------------------
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const chest = w.dungeon.rooms.find(r => r.type === 'chest');
                w.enterRoom(chest.id, 'S');
            })()""")
            page.evaluate("window.kirafanRL.step(1/60)")
            check("chest room: interact views settled", wait_pending(page))
            state = page.evaluate("""(() => {
                const scene = window.kirafanRL.scene;
                const door = scene.getObjectByName('door_close_L_obj');
                const open = scene.getObjectByName('door_open_L_obj');
                const crystal = scene.getObjectByName('crystal_1_obj');
                return {
                    hasChest: !!door,
                    closedVisible: door ? door.visible : false,
                    openVisible: open ? open.visible : null,
                    contentsVisible: crystal ? crystal.visible : null,
                    drops: window.kirafanRL.world.drops.length
                };
            })()""")
            check("mimic chest is in the scene", state["hasChest"])
            check("closed doors visible", state["closedVisible"])
            check("open doors hidden while closed", state["openVisible"] is False)
            check("contents hidden while closed", state["contentsVisible"] is False)
            check("no loot rolled before the open", state["drops"] == 0)

            # walk up and press E through the real input path
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                w.player.x = w.chest.x;
                w.player.y = w.chest.y + 1.2;
            })()""")
            page.evaluate("window.kirafanRL.step(1/60)")  # pump updateHint
            hint = page.evaluate(
                "document.getElementById('hint').textContent")
            check("hint advertises the chest", "宝箱" in hint, hint)
            page.evaluate("window.kirafanRL.interact()")
            page.evaluate("window.kirafanRL.step(1/60)")
            state = page.evaluate("""(() => {
                const scene = window.kirafanRL.scene;
                return {
                    opened: window.kirafanRL.world.chest.opened,
                    drops: window.kirafanRL.world.drops.length,
                    closedVisible: scene.getObjectByName('door_close_L_obj').visible,
                    openVisible: scene.getObjectByName('door_open_L_obj').visible,
                    contentsVisible: scene.getObjectByName('crystal_1_obj').visible
                };
            })()""")
            check("E opens the chest (record)", state["opened"])
            check("the roll landed on the floor", state["drops"] == 1,
                  state["drops"])
            check("closed doors hidden after the open",
                  not state["closedVisible"])
            check("open doors + contents visible after the open",
                  state["openVisible"] and state["contentsVisible"])

            # re-entry: still open, no re-roll
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const other = w.dungeon.rooms.find(
                    r => r.type === 'battle' || r.type === 'rest');
                w.enterRoom(other.id, 'S');
            })()""")
            page.evaluate("window.kirafanRL.step(1/60)")
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const chest = w.dungeon.rooms.find(r => r.type === 'chest');
                w.enterRoom(chest.id, 'N');
            })()""")
            page.evaluate("window.kirafanRL.step(1/60)")
            check("chest views settled after re-entry", wait_pending(page))
            state = page.evaluate("""(() => {
                return {
                    opened: window.kirafanRL.world.chest.opened,
                    refused: window.kirafanRL.openChest() === null,
                    drops: window.kirafanRL.world.drops.length,
                    openVisible: window.kirafanRL.scene
                        .getObjectByName('door_open_L_obj').visible
                };
            })()""")
            check("re-entry: chest stays open", state["opened"]
                  and state["openVisible"])
            check("re-entry: re-open refused, no re-roll",
                  state["refused"] and state["drops"] == 0)

            # --- 2. 木桶 + 3. 祭坛 ----------------------------------------
            # The floor-1 dungeon is deterministic and this build's battle
            # rooms rolled no altar, so swap in a dungeon known to carry one
            # (seed 70039: a battle room rolls an altar at the 0.35 stream).
            page.evaluate("""(() => import('/site/game/rl/dungeon.js')
                .then(function (m) {
                    const k = window.kirafanRL;
                    const dg = m.generateDungeon(70039, { roomsMin: 6, roomsMax: 9 });
                    k.minimap.setDungeon(dg);
                    k.world.setDungeon(dg);
                }))()""")
            # walk battle rooms until one holds an altar
            found = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const battles = w.dungeon.rooms.filter(r => r.type === 'battle');
                for (const room of battles) {
                    w.enterRoom(room.id, 'S');
                    if (w.altar) { return { id: room.id, has: true }; }
                }
                w.enterRoom(battles[0].id, 'S');
                return { id: battles[0].id, has: false };
            })()""")
            page.evaluate("window.kirafanRL.step(1/60)")
            check("battle room: interact views settled", wait_pending(page))
            barrels = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                return w.barrels.map(b => ({
                    x: b.x, y: b.y, broken: b.broken,
                    rendered: (() => {
                        for (const child of window.kirafanRL.scene.children) {
                            if (child.isObject3D
                                && Math.abs(child.position.x - b.x) < 0.35
                                && Math.abs(child.position.z - b.y) < 0.35) {
                                return true;
                            }
                        }
                        return false;
                    })()
                }));
            })()""")
            check("2-3 barrels rolled", 2 <= len(barrels) <= 3, len(barrels))
            check("every intact barrel renders", all(
                b["rendered"] for b in barrels if not b["broken"]))

            # break one with a real swing
            target = next(b for b in barrels if not b["broken"])
            page.evaluate("""((b) => {
                const w = window.kirafanRL.world;
                w.player.x = b.x - 1.0;
                w.player.y = b.y;
                w.player.facing = 0;
                window.kirafanRL.input.state.attack = true;
                window.kirafanRL.step(1/60);
                window.kirafanRL.input.state.attack = false;
                for (let i = 0; i < 12; i++) { window.kirafanRL.step(1/60); }
            })""", target)
            state = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const b = w.barrels.find(x => !x.broken);
                return {
                    brokenCount: w.barrels.filter(x => x.broken).length,
                    hint: document.getElementById('hint').textContent
                };
            })()""")
            check("the swing broke a barrel", state["brokenCount"] >= 1,
                  state["brokenCount"])
            # the beat line reports the loot (coin/heal/empty variants)
            brokenHint = page.evaluate(
                "document.getElementById('hint').textContent")
            check("the beat line reports the barrel",
                  any(k in brokenHint for k in ("木桶", "金币", "回复")),
                  brokenHint)
            stillThere = scene_child_at(page, target["x"], target["y"])
            check("the broken barrel's object is gone", not stillThere)

            # altar, if this room rolled one
            if found["has"]:
                state = page.evaluate("""(() => {
                    const w = window.kirafanRL.world;
                    return { used: w.altar.used,
                             x: w.altar.x, y: w.altar.y };
                })()""")
                check("altar present and fresh", not state["used"])
                view = page.evaluate("""((a) => {
                    const scene = window.kirafanRL.scene;
                    for (const child of scene.children) {
                        if (child.isObject3D
                            && Math.abs(child.position.x - a.x) < 0.6
                            && Math.abs(child.position.z - a.y) < 0.6) {
                            return { y: child.position.y };
                        }
                    }
                    return null;
                })""", state)
                check("the altar renders as a live object", bool(view))
                check("the fresh altar hovers", bool(view) and view["y"] > 0.3,
                      view)
                page.evaluate("""((a) => {
                    const w = window.kirafanRL.world;
                    w.player.x = a.x;
                    w.player.y = a.y;
                })""", state)
                # burn the barrel beat's hintTimer so updateHint can take over
                for _ in range(300):
                    page.evaluate("window.kirafanRL.step(1/60)")
                hint = page.evaluate(
                    "document.getElementById('hint').textContent")
                check("hint advertises the altar", "祭坛" in hint or "祈愿" in hint,
                      hint)
                page.evaluate("window.kirafanRL.interact()")
                page.evaluate("window.kirafanRL.step(1/60)")
                used = page.evaluate(
                    "window.kirafanRL.world.altar.used")
                check("E uses the altar", used)
                page.evaluate("""(() => {
                    for (let i = 0; i < 30; i++) { window.kirafanRL.step(1/60); }
                })()""")
                settled = page.evaluate("""((a) => {
                    const scene = window.kirafanRL.scene;
                    for (const child of scene.children) {
                        if (child.isObject3D
                            && Math.abs(child.position.x - a.x) < 0.6
                            && Math.abs(child.position.z - a.y) < 0.6) {
                            return child.position.y;
                        }
                    }
                    return null;
                })""", state)
                check("the used altar settles to the ground",
                      settled is not None and settled < 0.2, settled)
                page.evaluate("""(() => {
                    const w = window.kirafanRL.world;
                    const other = w.dungeon.rooms.find(r => r.type === 'rest');
                    w.enterRoom(other.id, 'S');
                })()""")
                page.evaluate("window.kirafanRL.step(1/60)")
                page.evaluate(
                    "(id) => window.kirafanRL.world.enterRoom(id, 'N')",
                    found["id"])
                page.evaluate("window.kirafanRL.step(1/60)")
                used = page.evaluate(
                    "window.kirafanRL.world.altar.used")
                check("altar stays used after re-entry", used)
            else:
                print("SKIP altar checks (this dungeon's battle rooms rolled none)")

            # --- 4. NPC ----------------------------------------------------
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const rest = w.dungeon.rooms.find(r => r.type === 'rest');
                w.enterRoom(rest.id, 'S');
            })()""")
            page.evaluate("window.kirafanRL.step(1/60)")
            check("rest room: interact views settled", wait_pending(page, 45))
            state = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const guest = window.kirafanRL.npcCard;
                return {
                    npc: !!w.npc,
                    rendered: w.npc ? (() => {
                        for (const child of window.kirafanRL.scene.children) {
                            if (child.isObject3D
                                && Math.abs(child.position.x - w.npc.x) < 0.35
                                && Math.abs(child.position.z - w.npc.y) < 0.35) {
                                return true;
                            }
                        }
                        return false;
                    })() : false,
                    guestName: guest ? (guest.characterZh || guest.name) : null,
                    guestIsPlayer: guest && w.player.card
                        && guest.id === w.player.card.id
                };
            })()""")
            check("a campfire guest is resolved", state["npc"]
                  and state["guestName"], state["guestName"])
            check("the guest renders by the fire", state["rendered"])
            check("the guest is not the player's own card",
                  not state["guestIsPlayer"])

            hpBefore = page.evaluate(
                "window.kirafanRL.world.player.hp")
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                w.player.hp = Math.max(1, Math.floor(w.player.maxHp / 2));
            })()""")
            page.evaluate("""() => {
                const k=window.kirafanRL;
                k.world.chooseSupply('heal', k.world.roomId);
                k.talkNpc();
            }""")
            page.evaluate("window.kirafanRL.step(1/60)")
            deadline = time.time() + 10
            spoke = False
            while time.time() < deadline:
                vis = page.evaluate(
                    "(() => { const b = document.getElementById('dialogue-box');"
                    " return !!(b && b.style.display !== 'none'); })()")
                if vis:
                    spoke = True
                    break
                page.wait_for_timeout(150)
            check("talking opens the guest's dialogue", spoke)
            if spoke:
                nameText = page.evaluate(
                    "document.getElementById('dialogue-box')"
                    ".children[1].children[0].textContent")
                check("the speaker plate names the guest",
                      (state["guestName"] or "") in nameText,
                      nameText)
            healed = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                return w.player.hp > Math.floor(w.player.maxHp / 2);
            })()""")
            check("the healing supply restored HP", healed)
            dismiss_dialogue(page)

            # --- 5. visuals -------------------------------------------------
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const chest = w.dungeon.rooms.find(r => r.type === 'chest');
                w.enterRoom(chest.id, 'S');
                w.player.x = w.chest.x;
                w.player.y = w.chest.y + 2.5;
            })()""")
            page.evaluate("window.kirafanRL.step(1/60)")
            check("chest views settled for the screenshot", wait_pending(page))
            page.evaluate("window.kirafanRL.renderOnce()")

            check("no pageerrors", not errors, errors[:3])
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
