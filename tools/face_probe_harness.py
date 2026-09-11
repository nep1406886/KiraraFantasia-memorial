# Harness-path face probe for the two rids the RL roster can never show
# (220601 Sawako, 110405 yuyushiki Chiho costume variant): meta.js refuses
# ids outside ROSTER_ALL, so tools/face_probe.py hit NO-CARD. Instead we
# drive tools/face_harness.html, which calls core/actor.js create()
# directly -- the recorded L30_ visibility is exactly build()'s output
# (actions:false -> no clips -> no blink/ticking), so one sample suffices
# and it must equal the expected set exactly.
# Reuses check_fallback / check_table / load_table from face_probe.py.
# Owns its server. Usage: python tools/face_probe_harness.py [port]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from face_probe import (OUT, ROOT, check_fallback, check_table, load_table,
                        save)
from playwright.sync_api import sync_playwright

HARNESS_RIDS = [220601, 110405]


def main() -> int:
    port = 8990
    for a in sys.argv[1:]:
        if a.isdigit():
            port = int(a)
    try:
        records = json.load(open(OUT, encoding="utf-8"))
    except Exception:
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
            for rid in HARNESS_RIDS:
                label = "pl_%d" % rid
                try:
                    page.goto(
                        "http://127.0.0.1:%d/tools/face_harness.html" % port,
                        wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_function("window.__ready === true",
                                           timeout=30000)
                    res = page.evaluate("(rid) => window.__faceTask(rid)", rid)
                    if res.get("error"):
                        records[label] = {"error": "HARNESS: " + res["error"]}
                        save(records)
                        print("%-12s ERROR %s" % (label, res["error"][:120]))
                        continue
                    samples = [res["layers"]]     # single build-state sample
                    table, facial = load_table(rid)
                    if table is None:
                        verdict = check_fallback(samples)
                        verdict["class"] = "fallback"
                    else:
                        verdict = check_table(samples, table)
                        verdict["class"] = "table"
                        verdict["table"] = facial
                    records[label] = {"verdict": verdict, "samples": samples,
                                      "path": "harness"}
                    save(records)
                    print("%-12s %s %s (layers=%d)" % (
                        label, verdict["class"],
                        "OK" if verdict["ok"] else "FAIL "
                        + str(verdict["problems"])[:200],
                        len(res["layers"])))
                except Exception as exc:
                    records[label] = {"error": str(exc)[:200]}
                    save(records)
                    print("%-12s ERROR %s" % (label, str(exc)[:120]))
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

    bad = [k for k, v in records.items()
           if v.get("error") or not v.get("verdict", {}).get("ok")]
    print("done: %d records total, %d bad" % (len(records), len(bad)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
