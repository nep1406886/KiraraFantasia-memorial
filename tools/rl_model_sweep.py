# T22o mirror-paint sweep: screenshot every shipped model (40 roster players
# as pseudo-enemies + 93 enemies) in idle, BOTH mirror states, cropped to the
# unit via a live camera projection, then tile contact sheets for review.
#
# Why: the v4 SOLID regex fixed mant* but the same exposure class — mirrored
# + DoubleSide + authored depthWrite=false — still covers skirt/bottom/cape/
# muffler/scarf/tail/ribbon/collar on dozens of models. Before touching
# modelrules.js, look at every model: which classes actually paint over the
# body decides which prefixes join SOLID (the 第五批 lesson: the theory must
# be A/B-verified live, not argued from first principles).
#
# State M = spawn facing (Math.PI -> mirrored, scale.x < 0, the state the
# SOLID branch guards); state F = unit.facing = 0 (un-mirrored).
# Owns its server. Usage: python tools/rl_model_sweep.py [port] [--only sub,sub]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "sweep"

# Spawn the unit on the known-good floor spot (12, 9) — the player is parked
# at (10, 8) and its view hidden, so the crop is all unit.
SPAWN_ONE = """(arg) => {
    return new Promise((resolve) => {
        const rl = window.kirafanRL;
        const w = rl.world;
        w.frozen = true;
        let unit;
        try {
            unit = w.spawnEnemy({
                model: arg.model, name: 'sweep', nameZh: 'sweep',
                x: 12, y: 9, hp: 999999, aiType: 'sentry'
            });
        } catch (e) { resolve({ error: String(e) }); return; }
        w.events.push({ type: 'summon' });
        const t0 = performance.now();
        const timer = setInterval(() => {
            rl.step(1 / 60);
            const view = rl.views.enemies.find(v => v.unit === unit);
            if (!view && performance.now() - t0 < 20000) { return; }
            clearInterval(timer);
            if (!view) { resolve({ attached: false }); return; }
            window.__sweepUnit = unit;
            const root = view.object;
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
            if (minX > maxX) { resolve({ attached: true, rect: null }); return; }
            // Project the bbox corners through the live (ortho) camera into
            // CSS pixels — no guessed crop boxes, bosses included.
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
            const corners = [];
            [minX, maxX].forEach(function (X) {
                [minY, maxY].forEach(function (Y) {
                    [minZ, maxZ].forEach(function (Z) { corners.push([X, Y, Z]); });
                });
            });
            corners.forEach(function (c) {
                const p = prj(c[0], c[1], c[2]);
                if (p[0] < px0) { px0 = p[0]; } if (p[0] > px1) { px1 = p[0]; }
                if (p[1] < py0) { py0 = p[1]; } if (p[1] > py1) { py1 = p[1]; }
            });
            resolve({
                attached: true,
                facing: unit.facing,
                rect: [Math.round(px0), Math.round(py0),
                       Math.round(px1), Math.round(py1)],
                height: +(maxY - minY).toFixed(2)
            });
        }, 20);
    });
}"""

FLIP_ONE = """() => {
    const rl = window.kirafanRL;
    const unit = window.__sweepUnit;
    if (!unit) { return false; }
    unit.facing = unit.facing > 1 ? 0 : Math.PI;
    for (let i = 0; i < 4; i++) { rl.step(1 / 60); }
    return true;
}"""

DISPOSE_ONE = """() => {
    const rl = window.kirafanRL;
    const w = rl.world;
    const unit = window.__sweepUnit;
    if (!unit) { return false; }
    const view = rl.views.enemies.find(v => v.unit === unit);
    if (view) { view.dispose(); }
    const i = w.enemies.indexOf(unit);
    if (i >= 0) { w.enemies.splice(i, 1); }
    window.__sweepUnit = null;
    return true;
}"""

HIDE_PLAYER = """(hide) => {
    const pv = window.kirafanRL.views.player;
    if (pv && pv.object) { pv.object.visible = !hide; }
    return true;
}"""


def boot(page, port):
    page.goto("http://127.0.0.1:%d/site/game/roguelike.html" % port,
              wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline and not page.evaluate("!!window.kirafanRL"):
        page.wait_for_timeout(200)
    page.wait_for_selector(".roster-card", timeout=20000)
    page.evaluate("document.querySelector('.roster-card').click()")
    deadline = time.time() + 30
    while time.time() < deadline and not page.evaluate(
            "!!window.kirafanRL.world.player"):
        page.wait_for_timeout(200)
    for _ in range(90):
        if not page.evaluate(
                "(() => { const b = document.getElementById('dialogue-box');"
                " return !!(b && b.style.display !== 'none'); })()"):
            break
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    page.evaluate("(() => { const p = window.kirafanRL.world.player;"
                  " p.x = 10; p.y = 8; })()")
    page.evaluate(HIDE_PLAYER, True)


def fleet():
    """[(key_path, label)] — players first (fidelity priority), then enemies."""
    players = json.load(open(ROOT / ".cache/sweep_players.json"))
    enemies = json.load(open(ROOT / ".cache/sweep_fleet.json"))
    rows = [("model/player/model_pl_%d.muast" % r, "pl_%d" % r)
            for r in players["rids"]]
    rows += [("model/enemy/%s.muast" % d, d) for d in enemies["enemies"]]
    return rows


def main() -> int:
    port = 8981
    only = None
    for a in sys.argv[1:]:
        if a.isdigit():
            port = int(a)
        elif a.startswith("--only="):
            only = [s for s in a.split("=", 1)[1].split(",") if s]
    OUT.mkdir(parents=True, exist_ok=True)
    rows = fleet()
    if only:
        rows = [r for r in rows if any(s in r[1] for s in only)]
    print("sweeping %d models" % len(rows))

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
            boot(page, port)
            for i, (key, label) in enumerate(rows):
                info = page.evaluate(SPAWN_ONE, {"model": key})
                rec = {"model": key, "label": label}
                if not info.get("attached") or not info.get("rect"):
                    rec["flags"] = ["NO-VIEW" if not info.get("attached")
                                    else "EMPTY-BBOX"]
                    if info.get("error"):
                        rec["error"] = info["error"]
                    results.append(rec)
                    page.evaluate(DISPOSE_ONE)
                    print("[%3d/%d] %-24s %s" % (i + 1, len(rows), label,
                                                 rec["flags"]))
                    continue
                x0, y0, x1, y1 = info["rect"]
                m = 30
                clip = {"x": max(0, x0 - m), "y": max(0, y0 - m),
                        "width": min(1280, x1 + m) - max(0, x0 - m),
                        "height": min(800, y1 + m) - max(0, y0 - m)}
                clip["width"] = min(clip["width"], 1280 - clip["x"])
                clip["height"] = min(clip["height"], 800 - clip["y"])
                rec["rect"] = info["rect"]
                rec["height"] = info.get("height")
                page.screenshot(path=str(OUT / ("%s__M.png" % label)),
                                clip=clip)
                page.evaluate(FLIP_ONE)
                page.screenshot(path=str(OUT / ("%s__F.png" % label)),
                                clip=clip)
                page.evaluate(DISPOSE_ONE)
                results.append(rec)
                print("[%3d/%d] %-24s rect=%s h=%s" % (
                    i + 1, len(rows), label, info["rect"], info.get("height")))
            page.evaluate(HIDE_PLAYER, False)
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

    with open(OUT / "sweep_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    bad = [r for r in results if r.get("flags")]
    print("done: %d ok, %d flagged" % (len(results) - len(bad), len(bad)))

    # Contact sheets: 4 cols x 4 rows, each model's M|F pair adjacent.
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
    sheets = [cells[i:i + COLS * ROWS // 2]
              for i in range(0, len(cells), COLS * ROWS // 2)]
    index = []
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
                index.append({"sheet": si, "cell": "%d,%d" % (gi, ci),
                              "caption": cap})
        sheet.save(OUT / ("sheet_%02d.png" % si))
    with open(OUT / "sheet_index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print("%d contact sheets: .cache/sweep/sheet_*.png" % len(sheets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
