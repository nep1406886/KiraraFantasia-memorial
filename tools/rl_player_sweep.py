# T22o player-model sweep, REAL pipeline this time. The first sweep spawned
# roster players through spawnEnemy -> enemyview, which has no clips (player
# animations live in the class action bundles only core/actor.js loads), so
# every player rendered its raw bind pose -- authored upside down. This tool
# instead boots the game once PER CHARACTER through the roster screen: the
# actor loads model + action bundles, actorview attaches, idle plays -- what
# a player actually sees. Both mirror states are shot (actorview: mirrored =
# cos(facing) > band, so facing 0 is MIRRORED for players, pi is not).
#
# Owns its server. Usage: python tools/rl_player_sweep.py [port] [--only rid,rid]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "sweep"

# Enumerate the roster cards with their card id (from the art src) and name,
# so Python can pick the right one without trusting DOM order.
LIST_CARDS = """() => {
    return Array.from(document.querySelectorAll('.roster-card')).map((el, i) => {
        const img = el.querySelector('img.art');
        const m = img && img.src ? img.src.match(/(\\d+)\\.webp/) : null;
        const who = el.querySelector('.who');
        const nameSpan = who ? who.querySelector('span:nth-child(2)') : null;
        return { i: i, id: m ? m[1] : null, name: nameSpan ? nameSpan.textContent : '' };
    });
}"""

CLICK_CARD = """(i) => {
    const cards = document.querySelectorAll('.roster-card');
    if (!cards[i]) { return false; }
    cards[i].click();
    return true;
}"""

# Called once the player view exists: freeze the world, hide every enemy
# view (fresh dungeon per boot, spawn-adjacent patrols would photobomb the
# crop), and settle the follow camera. The player stays on its own spawn
# tile — the only position guaranteed floor in every generated dungeon.
PARK = """() => {
    const rl = window.kirafanRL;
    rl.world.frozen = true;
    rl.views.enemies.forEach(function (v) {
        if (v.object) { v.object.visible = false; }
    });
    const p = rl.world.player;
    for (let i = 0; i < 90; i++) { rl.step(1 / 60); }
    return { x: p.x, y: p.y, facing: p.facing,
             state: p.sm ? p.sm.state : null };
}"""

SET_FACING = """(f) => {
    const rl = window.kirafanRL;
    rl.world.player.facing = f;
    for (let i = 0; i < 4; i++) { rl.step(1 / 60); }
    return true;
}"""

# Same bbox->camera projection crop as rl_model_sweep.py, on the player's
# actor object (weapon sockets included).
CROP = """() => {
    const rl = window.kirafanRL;
    const pv = rl.views.player;
    if (!pv || !pv.actor || !pv.actor.object) { return { ready: false }; }
    const root = pv.actor.object;
    root.updateWorldMatrix(true, true);
    let minX = 1e9, minY = 1e9, minZ = 1e9;
    let maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    root.traverse(function (child) {
        if (!child.isMesh || !child.geometry || !child.visible) { return; }
        const p = child.geometry.attributes.position;
        if (!p) { return; }
        const e = child.matrixWorld.elements;
        for (let i = 0; i < p.count; i++) {
            const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
            const wx = e[0]*vx + e[4]*vy + e[8]*vz + e[12];
            const wy = e[1]*vx + e[5]*vy + e[9]*vz + e[13];
            const wz = e[2]*vx + e[6]*vy + e[10]*vz + e[14];
            if (wx < minX) { minX = wx; } if (wx > maxX) { maxX = wx; }
            if (wy < minY) { minY = wy; } if (wy > maxY) { maxY = wy; }
            if (wz < minZ) { minZ = wz; } if (wz > maxZ) { maxZ = wz; }
        }
    });
    if (minX > maxX) { return { ready: true, rect: null }; }
    const cam = rl.camera;
    cam.updateMatrixWorld();
    const vw = cam.matrixWorldInverse.elements;
    const pj = cam.projectionMatrix.elements;
    const el = rl.renderer.domElement;
    const W = el.clientWidth || window.innerWidth;
    const H = el.clientHeight || window.innerHeight;
    function prj(wx, wy, wz) {
        const vx = vw[0]*wx + vw[4]*wy + vw[8]*wz + vw[12];
        const vy = vw[1]*wx + vw[5]*wy + vw[9]*wz + vw[13];
        const vz = vw[2]*wx + vw[6]*wy + vw[10]*wz + vw[14];
        const cx = pj[0]*vx + pj[4]*vy + pj[8]*vz + pj[12];
        const cy = pj[1]*vx + pj[5]*vy + pj[9]*vz + pj[13];
        const cw = pj[3]*vx + pj[7]*vy + pj[11]*vz + pj[15];
        return [(cx/cw + 1) / 2 * W, (1 - cy/cw) / 2 * H];
    }
    let px0 = 1e9, py0 = 1e9, px1 = -1e9, py1 = -1e9;
    [minX, maxX].forEach(function (X) {
        [minY, maxY].forEach(function (Y) {
            [minZ, maxZ].forEach(function (Z) {
                const p = prj(X, Y, Z);
                if (p[0] < px0) { px0 = p[0]; } if (p[0] > px1) { px1 = p[0]; }
                if (p[1] < py0) { py0 = p[1]; } if (p[1] > py1) { py1 = p[1]; }
            });
        });
    });
    return {
        ready: true,
        rect: [Math.round(px0), Math.round(py0),
               Math.round(px1), Math.round(py1)],
        height: +(maxY - minY).toFixed(2),
        clip: pv.current
    };
}"""


def dismiss_dialogue(page):
    for _ in range(120):
        if not page.evaluate(
                "(() => { const b = document.getElementById('dialogue-box');"
                " return !!(b && b.style.display !== 'none'); })()"):
            return True
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    return False


def boot_character(page, port, card_index, port_wait=60.0):
    """On the roster page, select card_index and wait for the player view."""
    # If the roster is already up (main navigated for enumeration), don't
    # reload — the first goto's boot is already initializing.
    on_roster = page.evaluate(
        "(() => !!document.querySelector('.roster-card'))()")
    if not on_roster:
        page.goto("http://127.0.0.1:%d/site/game/roguelike.html" % port,
                  wait_until="load", timeout=60000)
        deadline = time.time() + port_wait
        while time.time() < deadline and not page.evaluate(
                "!!window.kirafanRL"):
            page.wait_for_timeout(200)
        page.wait_for_selector(".roster-card", timeout=30000)
    page.evaluate(CLICK_CARD, card_index)
    deadline = time.time() + 60
    while time.time() < deadline:
        ok = page.evaluate(
            "(() => { const rl = window.kirafanRL;"
            " return !!(rl && rl.world && rl.world.player"
            " && rl.views.player && rl.views.player.actor"
            " && rl.views.player.actor.object); })()")
        if ok:
            break
        page.wait_for_timeout(250)
    else:
        return False
    return dismiss_dialogue(page)


def main() -> int:
    port = 8983
    only = None
    for a in sys.argv[1:]:
        if a.isdigit():
            port = int(a)
        elif a.startswith("--only="):
            only = [s for s in a.split("=", 1)[1].split(",") if s]
    OUT.mkdir(parents=True, exist_ok=True)
    players = json.load(open(ROOT / ".cache/sweep_players.json"))
    rids = players["rids"]
    names = players["names"]
    if only:
        rids = [r for r in rids if str(r) in only]
    # rid -> real card ids, from the same table the roster walks. Card ids
    # are NOT uniformly rid*100 (e.g. 300001 -> 30001000), so resolve via
    # resourceId and only fall back to the old guess.
    rid2ids = {}
    for row in json.load(
            open(ROOT / "site/asset/rl/cards-rl.json", encoding="utf-8"))["cards"]:
        rid2ids.setdefault(str(row.get("resourceId")), []).append(
            str(row.get("id")))
    # With --only, keep the previous results/PNGs for everyone else.
    prior = {}
    if only:
        old = OUT / "players_results.json"
        if old.exists():
            for r in json.load(open(old, encoding="utf-8")):
                prior[r["label"]] = r
    else:
        # Full sweep: the first sweep's pl_* shots are the invalid bind-pose
        # renders; clear them so a stale file can never be reviewed as a
        # result.
        for old in OUT.glob("pl_*__*.png"):
            old.unlink()
    print("sweeping %d players through the real pipeline" % len(rids))

    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results = []
    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            for i, rid in enumerate(rids):
                label = "pl_%d" % rid
                # Fresh page per character: no state leaks between boots.
                page.goto("about:blank")
                cards = None
                try:
                    page.goto(
                        "http://127.0.0.1:%d/site/game/roguelike.html" % port,
                        wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_selector(".roster-card", timeout=30000)
                    cards = page.evaluate(LIST_CARDS)
                except Exception as exc:
                    results.append({"label": label, "flags": ["BOOT-FAIL"],
                                    "error": str(exc)[:200]})
                    print("[%2d/40] %-12s BOOT-FAIL %s" % (i + 1, label, exc))
                    continue
                want_ids = rid2ids.get(str(rid)) or [str(rid * 100)]
                pick = next((c for c in cards if c["id"] in want_ids), None)
                if pick is None:
                    want_name = names.get(str(rid), "")
                    pick = next((c for c in cards
                                 if c["name"] == want_name), None)
                if pick is None:
                    results.append({"label": label, "flags": ["NO-CARD"],
                                    "cards": cards[:3]})
                    print("[%2d/40] %-12s NO-CARD (want id %s)"
                          % (i + 1, label, want_ids))
                    continue
                if not boot_character(page, port, pick["i"]):
                    results.append({"label": label, "flags": ["NO-VIEW"],
                                    "card": pick})
                    print("[%2d/40] %-12s NO-VIEW" % (i + 1, label))
                    continue
                park = page.evaluate(PARK)
                info = page.evaluate(CROP)
                if not info.get("ready") or not info.get("rect"):
                    results.append({"label": label, "flags": ["EMPTY-BBOX"],
                                    "park": park})
                    print("[%2d/40] %-12s EMPTY-BBOX" % (i + 1, label))
                    continue
                x0, y0, x1, y1 = info["rect"]
                m = 30
                clip = {"x": max(0, x0 - m), "y": max(0, y0 - m),
                        "width": min(1280, x1 + m) - max(0, x0 - m),
                        "height": min(800, y1 + m) - max(0, y0 - m)}
                clip["width"] = min(clip["width"], 1280 - clip["x"])
                clip["height"] = min(clip["height"], 800 - clip["y"])
                # actorview: facing 0 -> mirrored; pi -> authored side.
                page.evaluate(SET_FACING, 0.0)
                page.screenshot(path=str(OUT / ("%s__M.png" % label)),
                                clip=clip)
                page.evaluate(SET_FACING, 3.14159265)
                page.screenshot(path=str(OUT / ("%s__F.png" % label)),
                                clip=clip)
                results.append({"label": label, "rect": info["rect"],
                                "height": info.get("height"),
                                "clip": info.get("clip"), "park": park})
                print("[%2d/40] %-12s rect=%s h=%s clip=%s" % (
                    i + 1, label, info["rect"], info.get("height"),
                    info.get("clip")))
            browser.close()
            if errors:
                print("PAGEERRORS (%d):" % len(errors))
                for e in errors[:10]:
                    print("  ", e[:300])
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    # --only re-runs replace their labels; everyone else keeps the prior rec.
    swept = {r["label"] for r in results}
    results = results + [r for label, r in prior.items()
                         if label not in swept]
    with open(OUT / "players_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    bad = [r for r in results if r.get("flags")]
    print("done: %d ok, %d flagged" % (len(results) - len(bad), len(bad)))

    # Contact sheets, same layout as rl_model_sweep.py but labelled pl.
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("PIL missing — screenshots only, no sheets")
        return 0
    CELL_H = 340
    LABEL_H = 22
    COLS, ROWS = 4, 4
    cells = []
    for r in results:
        if r.get("flags"):
            continue
        pair = []
        for st in ("M", "F"):
            p = OUT / ("%s__%s.png" % (r["label"], st))
            if p.exists():
                pair.append((p, "%s %s" % (r["label"], st)))
        if len(pair) == 2:
            cells.append(pair)
    per = COLS * ROWS // 2
    sheets = [cells[i:i + per] for i in range(0, len(cells), per)]
    for si, group in enumerate(sheets):
        imgs = []
        for pair in group:
            row = []
            for p, cap in pair:
                im = Image.open(p)
                w = int(im.width * CELL_H / im.height)
                row.append((im.resize((w, CELL_H)), cap))
            imgs.append(row)
        cw = max(max(im.width for im, _ in row) for row in imgs) + 8
        sheet = Image.new("RGB", (cw * COLS, (CELL_H + LABEL_H + 6) * ROWS),
                          "white")
        dr = ImageDraw.Draw(sheet)
        for idx, row in enumerate(imgs):
            for off, (im, cap) in enumerate(row):
                # Grid position: M|F cells run left-to-right, top-to-bottom,
                # so all 8 pairs land inside the 4x4 canvas (the old
                # one-pair-per-row paste silently clipped pairs 5-8).
                gi, ci = divmod(idx * 2 + off, COLS)
                x = ci * cw
                y = gi * (CELL_H + LABEL_H + 6)
                dr.text((x + 4, y + 4), cap, fill="black")
                sheet.paste(im, (x + 4, y + LABEL_H))
        sheet.save(OUT / ("sheet_pl_%02d.png" % si))
    print("%d player contact sheets: .cache/sweep/sheet_pl_*.png" % len(sheets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
