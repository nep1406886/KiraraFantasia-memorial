# Facial-state probe for the live-reported defect "人物头部有模型缺和衔接不对"
# (stacked / missing face pieces). Two paths to verify:
#   - fallback rids (no facial table in the manifest): core/actor.js
#     applyRestingFallback must leave only the letter-A eye/brow/mouth
#     variants visible, cry/cheek hidden, unlettered/other untouched.
#   - table rids: applyFace(default) at build must show exactly the default
#     state's catalog layers (minus the table's hide list); blink may swap in
#     the blink state for <=115 ms, so 5 samples 150 ms apart are unioned and
#     every sample must stay inside rest ∪ blink.
# Owns its server. Usage: python tools/face_probe.py [port]
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "face_probe.json"

# rid -> expected class
FALLBACK_RIDS = [460001, 220601]
TABLE_RIDS = [280001, 100000, 300001, 110405]

FACE_PROBE = """(nSamples) => {
    return new Promise((resolve) => {
        const rl = window.kirafanRL;
        const root = rl.views.player.actor.object;
        const GENERATED = /^mesh_\\d+$/;
        function resolveName(node) {
            if (node.name && !GENERATED.test(node.name)) return node.name;
            let parent = node.parent;
            while (parent) {
                if (parent.name && !GENERATED.test(parent.name)) {
                    return parent.name;
                }
                parent = parent.parent;
            }
            return node.name || "";
        }
        function snap() {
            const out = [];
            root.traverse(function (child) {
                const name = String(resolveName(child) || "");
                if (name.slice(0, 4).toUpperCase() !== "L30_") return;
                out.push([name, !!child.visible]);
            });
            return out;
        }
        const recs = [];
        let n = 0;
        const timer = setInterval(() => {
            recs.push(snap());
            n++;
            if (n >= nSamples) { clearInterval(timer); resolve(recs); }
        }, 150);
    });
}"""


def load_table(rid):
    """-> (table dict | None, facial path or None)"""
    manifest = json.load(open(
        ROOT / "asset" / "models" / "manifest.json", encoding="utf-8"))
    entry = manifest["models"].get("model/player/model_pl_%d.muast" % rid)
    if not entry:
        return None, None
    facial = entry.get("facial")
    if not facial:
        return None, None
    path = facial.split("?")[0]
    table = json.load(open(ROOT / Path(*path.split("/")), encoding="utf-8"))
    return table, facial


def group_of(layer):
    l = layer.lower()
    if l.startswith("cry"):
        return "cry"
    if l.startswith("cheek") or l.startswith("cheeck"):
        return "cheek"
    if l.startswith("eyebr"):
        return "brow"
    if l.startswith("eye"):
        return "eye"
    if l.startswith("mouth"):
        return "mouth"
    return "other"


def letter_of(layer):
    m = re.search(r"_([A-Za-z])(?:_\d+)?$", layer)
    return m.group(1).upper() if m else ""


def check_fallback(samples):
    """applyRestingFallback semantics, asserted on the recorded node names."""
    layers = []                      # unique layer keys in draw order
    for sample in samples:
        for name, _vis in sample:
            layer = name[4:]
            if layer not in layers:
                layers.append(layer)
    hasA = {"eye": False, "brow": False, "mouth": False}
    for layer in layers:
        g = group_of(layer)
        if g in hasA and letter_of(layer) == "A":
            hasA[g] = True
    problems = []
    untouched = 0
    # every sample must agree (nothing rewrites the face after build)
    for layer in layers:
        vis = [dict(sample).get("L30_" + layer) for sample in samples
               if "L30_" + layer in dict(sample)]
        if len(set(vis)) > 1:
            problems.append("unstable:%s" % layer)
        visible = vis[0] if vis else None
        g = group_of(layer)
        letter = letter_of(layer)
        if g in ("cry", "cheek"):
            if visible:
                problems.append("visible:%s" % layer)
        elif g in hasA and hasA[g] and letter != "":
            if letter == "A" and not visible:
                problems.append("hidden-A:%s" % layer)
            if letter != "A" and visible:
                problems.append("visible-nonA:%s" % layer)
        else:
            untouched += 1
    return {
        "ok": not problems,
        "problems": problems,
        "layers": len(layers),
        "asserted": len(layers) - untouched,
        "untouched": untouched,
        "hasA": hasA,
    }


def check_table(samples, table):
    catalog = table["layers"]
    catalog_set = set(catalog)
    hide = set(table.get("hide") or [])
    states = table["states"]
    default = table["default"]
    rest = {catalog[i] for i in states[default]} - hide
    blink_idx = table.get("blink")
    blinkset = set()
    if isinstance(blink_idx, int) and blink_idx >= 0 and blink_idx != default:
        blinkset = {catalog[i] for i in states[blink_idx]} - hide
    allowed = rest | blinkset
    problems = []
    union = set()
    per_sample = []
    for si, sample in enumerate(samples):
        vis_keys = {name[4:] for name, vis in sample if vis}
        cat_vis = vis_keys & catalog_set
        union |= cat_vis
        per_sample.append(sorted(cat_vis))
        for key in sorted(cat_vis - allowed):
            problems.append("s%d-outside:%s" % (si, key))
        for key in sorted(vis_keys & hide):
            problems.append("s%d-hide-visible:%s" % (si, key))
    for key in sorted(rest - union):
        problems.append("never-visible:%s" % key)
    blink_seen = len({tuple(s) for s in per_sample}) > 1
    return {
        "ok": not problems,
        "problems": problems,
        "rest": sorted(rest),
        "blinkset": sorted(blinkset),
        "blink_seen": blink_seen,
        "per_sample": per_sample,
        "default": default,
        "blink": blink_idx,
    }


def save(records):
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=1)


def main() -> int:
    port = 8989
    for a in sys.argv[1:]:
        if a.isdigit():
            port = int(a)
    rid2ids = {}
    for row in json.load(open(
            ROOT / "site/asset/rl/cards-rl.json", encoding="utf-8"))["cards"]:
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
            for rid in FALLBACK_RIDS + TABLE_RIDS:
                label = "pl_%d" % rid
                try:
                    page.goto("about:blank")
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
                            "(() => { const rl = window.kirafanRL;"
                            " return !!(rl && rl.world && rl.world.player"
                            " && rl.views.player && rl.views.player.actor"
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
                                "(() => { const b ="
                                " document.getElementById('dialogue-box');"
                                " return !!(b && !b.classList.contains('dlg-hidden') && !b.classList.contains('dlg-out'));"
                                " })()"):
                            break
                        page.evaluate(
                            "document.getElementById('dialogue-box').click()")
                        page.wait_for_timeout(90)
                    samples = page.evaluate(FACE_PROBE, 5)
                    table, facial = load_table(rid)
                    if table is None:
                        verdict = check_fallback(samples)
                        verdict["class"] = "fallback"
                    else:
                        verdict = check_table(samples, table)
                        verdict["class"] = "table"
                        verdict["table"] = facial
                    records[label] = {"verdict": verdict, "samples": samples}
                    save(records)
                    print("%-12s %s %s" % (
                        label, verdict["class"],
                        "OK" if verdict["ok"] else "FAIL "
                        + str(verdict["problems"])[:200]))
                except Exception as exc:
                    records[label] = {"error": str(exc)[:200]}
                    save(records)
                    print("%-12s ERROR %s" % (label, str(exc)[:120]))
            browser.close()
            if errors:
                print("PAGEERRORS (%d):" % len(errors))
                for e in errors[:10]:
                    print("  ", e[:300])
                for label in records:
                    records[label].setdefault("pageerrors", len(errors))
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    save(records)
    bad = [k for k, v in records.items()
           if v.get("error") or not v.get("verdict", {}).get("ok")]
    print("done: %d records, %d bad -> %s" % (len(records), len(bad), OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
