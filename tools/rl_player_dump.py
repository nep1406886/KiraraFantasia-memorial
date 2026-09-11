# Per-mesh dump for every roster player: which mesh owns the sub-zero
# geometry (legs vs hair vs weapon), which face variants are visible, and
# which properties the mixer's clips actually drive (tracks), so the
# face-variant hide and the foot lift can be built on data, not guesses.
# Owns its server. Usage: python tools/rl_player_dump.py [port]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "playerdump.json"

# Same sampling as the posture probe, but dump meshes for EVERY model and
# add the mixer's unique track names (first 60) — clips that carry
# .visible tracks manage face variants themselves and a static hide must
# not fight them blindly.
DUMP_PROBE = """(label) => {
    return new Promise((resolve) => {
        const rl = window.kirafanRL;
        rl.world.frozen = true;
        rl.views.enemies.forEach(v => { if (v.object) v.object.visible = false; });
        const pv = rl.views.player;
        if (!pv || !pv.actor || !pv.actor.object) { resolve({error:'no-view'}); return; }
        const root = pv.actor.object;
        function dump() {
            const meshes = [];
            root.traverse(function (child) {
                if (!child.isMesh || !child.geometry) return;
                child.updateWorldMatrix(true, false);
                const p = child.geometry.attributes.position;
                let y0 = null, y1 = null;
                if (p) {
                    const e = child.matrixWorld.elements;
                    y0 = 1e9; y1 = -1e9;
                    for (let i = 0; i < p.count; i++) {
                        const vy = e[1]*p.getX(i) + e[5]*p.getY(i) + e[9]*p.getZ(i) + e[13];
                        if (vy < y0) y0 = vy;
                        if (vy > y1) y1 = vy;
                    }
                }
                meshes.push({
                    name: child.name,
                    vis: child.visible,
                    y: y0 === null ? null : [+y0.toFixed(3), +y1.toFixed(3)]
                });
            });
            return meshes;
        }
        const t0 = performance.now();
        const timer = setInterval(() => {
            for (let i = 0; i < 4; i++) rl.step(1 / 60);
            if (performance.now() - t0 < 1200) return;
            clearInterval(timer);
            let tracks = [];
            const mixer = pv.actor.mixer;
            if (mixer) {
                const seen = {};
                mixer._actions.forEach(function (a) {
                    a.getClip().tracks.forEach(function (t) {
                        if (seen[t.name]) return;
                        seen[t.name] = 1;
                        if (tracks.length < 60) tracks.push(t.name);
                    });
                });
            }
            resolve({ meshes: dump(), tracks: tracks });
        }, 20);
    });
}"""


def save(records):
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=1)


def main() -> int:
    port = 8987
    for a in sys.argv[1:]:
        if a.isdigit():
            port = int(a)
    players = json.load(open(ROOT / ".cache/sweep_players.json"))
    rid2ids = {}
    for row in json.load(open(ROOT / "site/asset/rl/cards-rl.json",
                              encoding="utf-8"))["cards"]:
        rid2ids.setdefault(str(row.get("resourceId")), []).append(
            str(row.get("id")))
    records = {}

    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            for rid in players["rids"]:
                label = "pl_%d" % rid
                page.goto("about:blank")
                try:
                    page.goto(
                        "http://127.0.0.1:%d/site/game/roguelike.html" % port,
                        wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_selector(".roster-card", timeout=30000)
                    cards = page.evaluate(
                        "(() => Array.from(document.querySelectorAll"
                        "('.roster-card')).map((el, i) => {"
                        " const img = el.querySelector('img.art');"
                        " const m = img && img.src ?"
                        " img.src.match(/(\\d+)\\.webp/) : null;"
                        " return { i: i, id: m ? m[1] : null }; }))()")
                except Exception as exc:
                    records[label] = {"error": str(exc)[:150]}
                    save(records)
                    continue
                want = rid2ids.get(str(rid)) or [str(rid * 100)]
                pick = next((c for c in cards if c["id"] in want), None)
                if pick is None:
                    records[label] = {"error": "NO-CARD"}
                    save(records)
                    continue
                page.evaluate("document.querySelectorAll"
                              "('.roster-card')[%d].click()" % pick["i"])
                deadline = time.time() + 60
                while time.time() < deadline:
                    ok = page.evaluate(
                        "(() => { const rl = window.kirafanRL; return !!(rl"
                        " && rl.world && rl.world.player && rl.views.player"
                        " && rl.views.player.actor"
                        " && rl.views.player.actor.object); })()")
                    if ok:
                        break
                    page.wait_for_timeout(250)
                else:
                    records[label] = {"error": "NO-VIEW"}
                    save(records)
                    continue
                for _ in range(90):
                    if not page.evaluate(
                            "(() => { const b = document.getElementById"
                            "('dialogue-box'); return !!(b &&"
                            " b.style.display !== 'none'); })()"):
                        break
                    page.evaluate(
                        "document.getElementById('dialogue-box').click()")
                    page.wait_for_timeout(90)
                rec = page.evaluate(DUMP_PROBE, label)
                records[label] = rec
                save(records)
                low = [m for m in rec["meshes"]
                       if m["y"] and m["y"][0] < -0.02 and m["vis"]]
                print("%-12s %d meshes, below-zero: %s" % (
                    label, len(rec["meshes"]),
                    ", ".join("%s %.3f" % (m["name"], m["y"][0])
                              for m in low[:6]) or "none"))
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

    save(records)
    print("done: %d records -> %s" % (len(records), OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
