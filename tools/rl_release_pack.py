"""T28 release-preparation: build the roguelike deploy closure into a
subpath-named pack, scan it for absolute-root resource references, and smoke
boot + continue from the PACK copy at /kirafan-timer/.

The whitelist below is the documented closure source (spec/08 §7.2): every
directory is one the shipped pages load from. Runtime 404/pageerror gates
still prove the exercised flows. Pack contains uncommitted work-tree bytes, so
this is a preparation result, never a release claim (spec/08 §7.6).
"""
import functools
import gzip
import json
import re
import shutil
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_storage_browser import fixture, select_backup

ROOT = Path(__file__).resolve().parents[1]
PACK_ROOT = ROOT / ".codex-tmp" / "release-pack"
PACK = PACK_ROOT / "kirafan-timer"
REPORT = PACK_ROOT / "release-report.json"
OUT = PACK_ROOT
checks = []

# (source, destination, ignore patterns) — one entry per deployed directory or
# file so the whitelist is reviewable line by line.
CLOSURE = [
    ("site/game/roguelike.html", "site/game/roguelike.html", None),
    ("site/game/rl", "site/game/rl", None),
    ("site/asset/rl", "site/asset/rl", ("_raw",)),
    ("site/asset/img", "site/asset/img", None),
    ("site/asset/models", "site/asset/models", ("_raw",)),
    ("site/asset/uniqueskill", "site/asset/uniqueskill", None),
    ("site/asset/gacha/cards.js", "site/asset/gacha/cards.js", None),
    ("site/asset/original-characters.js", "site/asset/original-characters.js", None),
    ("site/asset/battle", "site/asset/battle", None),
    ("site/audio/voice", "site/audio/voice", None),
    ("site/audio/bgm", "site/audio/bgm", None),
    ("site/audio/gacha", "site/audio/gacha", None),
    ("site/core", "site/core", None),
    ("site/vendor", "site/vendor", None),
    ("site/css/kirara-cursor.css", "site/css/kirara-cursor.css", None),
]
TEXT_SUFFIXES = {".html", ".css", ".js", ".json"}


def _read_text(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


@functools.lru_cache(maxsize=1)
def _rl_scene_ids():
    """301 unique sceneId values referenced by the shipped roguelike skills."""
    return set(re.findall(r'sceneId[":\s]+(\d+)', _read_text("site/asset/rl/skills-rl.json")))


@functools.lru_cache(maxsize=1)
def _rl_enemy_ids():
    """94 unique enemy model resource ids from the encounter tables."""
    text = _read_text("site/asset/rl/encounters.json")
    return set(re.findall(r'model_en_(\d+)\.muast', text))


@functools.lru_cache(maxsize=1)
def _rl_playable_ids():
    """41 playable roster resourceIds + legacy-save fixture card resourceId.

    The release checklist restores a save with card 10000000 (resourceId 100000)
    to prove old saves still boot. That card is not in the 41-card playable
    roster, but the deploy closure must carry its model or the checklist hang
    at "读取中" is a product defect, not a test artifact.
    """
    text = _read_text("site/game/rl/rosterids.js")
    ids = set(re.findall(r'"resourceId":\s*(\d+)', text))
    ids.add("100000")  # rl_storage_browser.fixture() legacy card 10000000
    return ids


@functools.lru_cache(maxsize=1)
def _rl_texture_digests():
    """Texture digests embedded in the scene GLBs the roguelike loads."""
    digests = set()
    for scene_id in sorted(_rl_scene_ids()):
        path = ROOT / "site" / "asset" / "uniqueskill" / "scene" / (scene_id + ".glb.gz")
        if not path.exists():
            continue
        raw = gzip.decompress(path.read_bytes())
        # GLB layout: magic(4) version(4) length(4) | jsonChunk: len(4) type(4) data
        json_len = int.from_bytes(raw[12:16], "little")
        chunk = raw[20:20 + min(json_len, len(raw) - 20)].decode("utf-8", errors="replace")
        digests.update(re.findall(r'us_tex/([a-f0-9]+)\.png', chunk))
    return digests
ABSOLUTE_PATTERNS = [
    "(src|href)\\s*=\\s*[\"']/(?!/)",
    "fetch\\(\\s*[\"']/(?!/)",
    "new URL\\(\\s*[\"']/(?!/)",
    "import\\(\\s*[\"']/(?!/)",
    "url\\(\\s*/(?!/)",
]


def check(label, ok, detail=None):
    if not ok:
        raise AssertionError(label + ": " + repr(detail))
    checks.append(label)
    print("PASS " + label, flush=True)


def _closure_include(rel_parts):
    """True when rel_parts (path components under the pack root) belongs to the
    roguelike's measured dependency closure. Only asset/uniqueskill and
    asset/models are filtered; every other whitelist entry copies whole."""
    parts = list(rel_parts)
    # The site/ relocation prefixes every deployed dir; normalize so the
    # closure rules below keep their root-level shape.
    if parts[0] == "site" and parts[1] == "asset":
        parts = parts[1:]
    if parts[0] == "asset" and parts[1] == "uniqueskill":
        rest = parts[2:]
        if not rest or not rest[0].endswith(".json"):
            return False  # root index files and any unexpected entry
        stem = rest[0].rsplit(".", 1)[0]
        if rest[0] in ("scene-index.json", "timeline-index.json"):
            return True
        if rest[0].endswith(".json") and stem.isdigit():
            return stem in _rl_scene_ids()  # timeline/<id>.json
        if rest[0] == "scene" and len(rest) == 2:
            return rest[1].rsplit(".", 1)[0] in _rl_scene_ids()
        if rest[0] == "texture" and len(rest) == 2:
            return rest[1].rsplit(".", 1)[0] in _rl_texture_digests()
        return False
    if parts[0] == "asset" and parts[1] == "models":
        rest = parts[2:]
        if not rest or (len(rest) == 1 and "." in rest[0]):
            return True  # root manifest/visibility/rarity json
        head = rest[0]
        if head in ("class-actions", "facial", "shadow_battle",
                    "shadow_room", "skill-actions"):
            # skill-actions: only the 41 playable roster ids
            if head == "skill-actions" and len(rest) > 1:
                sub = rest[1]
                if sub.startswith("model_pl_"):
                    return sub[len("model_pl_"):] in _rl_playable_ids()
            return True
        if head.startswith("model_pl_"):
            return head[len("model_pl_"):] in _rl_playable_ids()
        if head.startswith("model_en_"):
            return head[len("model_en_"):] in _rl_enemy_ids()
        if head.startswith("wpn_"):
            return True  # 267 dirs / 15 MB total — cheap to keep whole
        return False
    return True  # not a filtered directory


def build_pack():
    PACK_ROOT.mkdir(parents=True, exist_ok=True)
    if PACK.exists():
        resolved = PACK.resolve()
        guard = PACK_ROOT.resolve()
        if not str(resolved).startswith(str(guard)):
            raise AssertionError("pack target escaped the scratch root")
        shutil.rmtree(resolved)
    files = 0
    sizes = {}
    for source, dest, ignore in CLOSURE:
        src = ROOT / source
        dst = PACK / dest
        if not src.exists():
            raise AssertionError("closure source missing: " + source)
        if src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            count, size = 1, src.stat().st_size
        else:
            count, size = 0, 0
            for item in src.rglob("*"):
                if not item.is_file():
                    continue
                rel = item.relative_to(src)
                if ignore and any(part in ignore for part in rel.parts):
                    continue
                if not _closure_include(Path(dest).parts + rel.parts):
                    continue
                target = dst / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, target)
                count += 1
                size += item.stat().st_size
        files += count
        sizes[dest] = {"files": count, "bytes": size}
    return files, sizes


def scan_absolute_refs():
    import re
    patterns = [re.compile(p) for p in ABSOLUTE_PATTERNS]
    hits = []
    scanned = 0
    for path in PACK.rglob("*"):
        if not path.is_file() or path.suffix not in TEXT_SUFFIXES:
            continue
        scanned += 1
        text = path.read_text(encoding="utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), 1):
            if any(p.search(line) for p in patterns):
                hits.append({"file": str(path.relative_to(PACK)), "line": number,
                             "source": str((ROOT / path.relative_to(PACK)))})
    return scanned, hits


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"complete": False}
    try:
        files, sizes = build_pack()
        total = sum(row["bytes"] for row in sizes.values())
        report["pack"] = {"files": files, "bytes": total, "dirs": sizes}
        # Closure-trimmed pack: uniqueskill/models include only roguelike-referenced
        # files (measured 2026-09-11: ~375-415 MB vs 2.27 GB untrimmed). The pack
        # must stay under the GitHub Pages 1 GB published-site limit.
        check("closure copied from the whitelist", files > 4000 and total > 100 * 1024 * 1024,
              {"files": files, "MB": round(total / 1048576, 1)})
        check("trimmed pack fits GitHub Pages 1 GB limit",
              total < 1024 * 1024 * 1024, {"MB": round(total / 1048576, 1)})

        scanned, hits = scan_absolute_refs()
        report["absoluteScan"] = {"scannedFiles": scanned, "hits": hits}
        check("no absolute-root resource references in packed text files",
              not hits and scanned > 100, {"scanned": scanned, "hits": hits[:8]})

        # Text assets are what deploy-time gzip actually shrinks; webp/mp3/glb
        # bodies are served as-is, so only raw bytes matter for them.
        gzip_total = 0
        for path in PACK.rglob("*"):
            if path.is_file() and path.suffix in TEXT_SUFFIXES:
                gzip_total += len(gzip.compress(path.read_bytes(), compresslevel=6, mtime=0))
        report["gzipBytes"] = gzip_total
        print("PACK files=%d raw=%.1fMB text-gzip=%.1fMB" % (
            files, total / 1048576, gzip_total / 1048576), flush=True)

        # The subpath name /kirafan-timer/ is part of the pack, so the server
        # root is the scratch parent, not the deploy folder itself.
        server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(PACK_ROOT)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        entry = "http://127.0.0.1:%d/kirafan-timer/site/game/roguelike.html?volume=1" % server.server_address[1]
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                                   "--autoplay-policy=no-user-gesture-required"])
                try:
                    # --- new run boot from the pack ---
                    context = browser.new_context(viewport={"width": 1280, "height": 900})
                    context.add_init_script(
                        "localStorage.setItem('kirafan-rl:meta',JSON.stringify("
                        "{prologueSeen:true,tutorialSeen:true}));")
                    page = context.new_page()
                    errors, failures = [], []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    page.on("response", lambda r: failures.append({"url": r.url, "status": r.status})
                            if r.status >= 400 else None)
                    page.goto(entry, wait_until="load", timeout=90000)
                    page.locator(".roster-card").first.click(timeout=90000)
                    page.wait_for_function(
                        "window.kirafanRL?.world?.player && kirafanRL.world.dungeon",
                        timeout=90000)
                    check("subpath pack boots a new run",
                          "/kirafan-timer/site/game/roguelike.html" in page.url
                          and not failures and not errors,
                          {"failures": failures[:8], "errors": errors[:4]})
                    context.close()

                    # --- restored save continues from the pack ---
                    # Use the pack's own backup UI (the proven T28 path): fresh
                    # boot, import the legacy fixture, confirm, then continue.
                    context = browser.new_context(viewport={"width": 1280, "height": 900})
                    context.add_init_script(
                        "localStorage.setItem('kirafan-rl:meta',JSON.stringify("
                        "{prologueSeen:true,tutorialSeen:true}));")
                    page = context.new_page()
                    errors, failures = [], []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    page.on("response", lambda r: failures.append({"url": r.url, "status": r.status})
                            if r.status >= 400 else None)
                    page.goto(entry, wait_until="load", timeout=90000)
                    page.locator("#roster-storage").click(timeout=90000)
                    data = fixture(page)
                    select_backup(page, data)
                    page.locator("#storage-preview").wait_for(state="visible", timeout=90000)
                    with page.expect_navigation(wait_until="load"):
                        page.locator("#storage-confirm").click()
                    page.locator("#roster-continue").wait_for(state="visible", timeout=90000)
                    page.locator("#roster-continue").click()
                    page.wait_for_function(
                        "window.kirafanRL?.world?.player && kirafanRL.world.dungeon",
                        timeout=90000)
                    state = page.evaluate("""() => { const w = kirafanRL.world;
                        return {coin: w.coin, card: w.player.card.id};}""")
                    check("restored save continues inside the subpath pack",
                          state["coin"] == 90 and state["card"] == 10000000
                          and not failures and not errors,
                          {"state": state, "failures": failures[:8], "errors": errors[:4]})
                    page.screenshot(path=str(OUT / "release-boot.png"))
                    context.close()
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()
        report["complete"] = True
    except Exception as error:
        report["failure"] = repr(error)
        raise
    finally:
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("RELEASE PACK PREP OK (%d checks)" % len(checks), flush=True)


if __name__ == "__main__":
    main()
