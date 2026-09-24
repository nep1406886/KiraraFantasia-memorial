# Browser gate for the boss opening voice (spec/05 §6 rule 5, plan line 852).
# The original plays "voice_400" on the enemy party when a warning-flagged
# quest reaches its final wave (BattleSystem.cs:543 IsWarningWave → :3777
# WarningStart), resolved through the enemy row's m_VoiceCueSheetName. Our
# wiring: a room that fields a voiced unit announces it on first entry —
# the 層守衛 (an elite row), a battle room that rolled an elite, and the
# volume-5 boss; the vols-1-4 story bosses carry no sheet and stay silent.
#   offline: bossvoices.json covers 21 resources / 18 sheets, every file on
#            disk is a real MPEG frame >1KB, bossvoice-lines.json covers all
#            18 sheets with non-empty invented lines
#   browser: vol 5 floor 20 (ハイプリス, sheet Voice_Original_018) plays a
#            voice_400 variant and shows the subtitle, which hides itself
#            ~4.5s later; a vol 1 guard-floor 層守衛 plays the rolled
#            elite's own sheet (all three vol-1 elites are voiced: シュガー
#            009 / ソルト 012 / スイセン 022); vol 1 floor 20 (テンペスト,
#            no sheet) stays silent; no pageerrors / console warnings
# `new Audio()` is detached (never in the DOM), so the gate wraps
# window.Audio into window.__audioLog via an init script.
# Owns its server. Usage: python tools/rl_bossvoice.py [port]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "asset" / "rl" / "bossvoices.json"
LINES = ROOT / "asset" / "rl" / "bossvoice-lines.json"
AUDIO_DIR = ROOT / "audio" / "voice"

# Runs before every page script on every navigation, so each case's log is
# its own. class extends keeps real Audio semantics (play/pause/src).
INIT_SCRIPT = """
window.__audioLog = [];
class LoggedAudio extends window.Audio {
    constructor(src) {
        super(src);
        window.__audioLog.push({ src: String(src || '') });
    }
}
window.Audio = LoggedAudio;
"""


def check_offline(check) -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    lines = json.loads(LINES.read_text(encoding="utf-8"))
    resources = manifest["resources"]
    sheets = manifest["sheets"]
    check("manifest cue is voice_400", manifest.get("cue") == "voice_400",
          manifest.get("cue"))
    check("21 voiced resources", len(resources) == 21, len(resources))
    check("18 distinct sheets", len(sheets) == 18, len(sheets))
    check("resource sheets == manifest sheets",
          set(resources.values()) == set(sheets),
          sorted(set(resources.values()) ^ set(sheets)))
    bad = []
    total = 0
    for sheet, rec in sheets.items():
        names = {f.split("/")[-1] for f in rec["files"]}
        if not {"voice_400_0.mp3", "voice_400_1.mp3"} <= names:
            bad.append((sheet, "missing variant", sorted(names)))
        for f in rec["files"]:
            p = AUDIO_DIR / f
            if not p.exists():
                bad.append((f, "missing", ""))
                continue
            data = p.read_bytes()
            total += len(data)
            if len(data) <= 1024:
                bad.append((f, "too small", len(data)))
            elif not data.startswith(b"\xff\xfb"):
                bad.append((f, "bad MPEG header", data[:2].hex()))
    check("36 mp3 variants on disk, MPEG-framed >1KB", not bad, bad[:4])
    check("voice payload in a sane band (0.3-3 MiB)",
          0.3 * 1048576 <= total <= 3 * 1048576,
          "%.2f MiB" % (total / 1048576))
    check("lines cover all 18 sheets", set(lines) == set(sheets),
          sorted(set(lines) ^ set(sheets)))
    empty = [k for k, v in lines.items() if not str(v.get("line", "")).strip()]
    check("every subtitle line non-empty", not empty, empty)


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            return True
        page.wait_for_timeout(200)
    return False


def start_run(page):
    page.wait_for_selector(".roster-card", timeout=20000)
    page.evaluate("document.querySelector('.roster-card').click()")
    deadline = time.time() + 30
    while time.time() < deadline \
            and not page.evaluate("!!window.kirafanRL.world.player"):
        page.wait_for_timeout(200)
    return bool(page.evaluate("!!window.kirafanRL.world.player"))


def dismiss_dialogues(page, rounds=90):
    for _ in range(rounds):
        vis = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " return !!(b && !b.classList.contains('dlg-hidden') && !b.classList.contains('dlg-out')); })()")
        if not vis:
            return True
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    return False


def enter_boss_room(page):
    ok = page.evaluate("""(() => {
        const w = window.kirafanRL.world;
        const boss = w.dungeon.rooms.find(r => r.type === 'boss');
        if (!boss) { return false; }
        w.enterRoom(boss.id, 'N');
        return true;
    })()""")
    if not ok:
        return False
    # The room event is consumed inside step (world.update → consumeEvents);
    # a few frames are enough for the voice + subtitle to fire.
    for _ in range(30):
        page.evaluate("window.kirafanRL.step(1/60)")
        page.wait_for_timeout(8)
    return True


def voice_entries(page):
    return page.evaluate(
        "window.__audioLog.map(e => e.src).filter(s => s.includes('voice_400'))")


def subtitle_state(page):
    return page.evaluate("""(() => {
        const b = document.getElementById('boss-voice');
        if (!b) { return null; }
        return { visible: b.style.display !== 'none',
                 name: b.querySelector('.bv-name').textContent,
                 line: b.querySelector('.bv-line').textContent };
    })()""")


def voiced_unit(page):
    return page.evaluate("""(() => {
        const w = window.kirafanRL.world;
        const v = w.enemies.find(e => !e.dead && e.voiceCueSheet);
        return v ? { sheet: v.voiceCueSheet,
                     name: v.nameZh || v.name } : null;
    })()""")


def wait_subtitle_hidden(page, seconds=8):
    deadline = time.time() + seconds
    while time.time() < deadline:
        st = subtitle_state(page)
        if st and not st["visible"]:
            return True
        page.wait_for_timeout(150)
    return False


def run_case(page, base_url, query, check):
    """Boot one scenario, enter its boss room, return the page's answers."""
    if not boot(page, base_url + query):
        check("boot %s" % query, False)
        return None
    if not start_run(page):
        check("player loaded %s" % query, False)
        return None
    dismiss_dialogues(page)
    if not enter_boss_room(page):
        check("boss room found %s" % query, False)
        return None
    return True


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8985
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
        time.sleep(1.0)
        check_offline(check)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.add_init_script(INIT_SCRIPT)
            base_url = "http://127.0.0.1:%d/site/game/roguelike.html" % port

            # -- case A: vol 5 finale, ハイプリス → Voice_Original_018 ----
            warnings, errors = [], []
            page.on("console", lambda m: warnings.append(m.text)
                    if m.type in ("warning", "error")
                    and "GL Driver Message" not in m.text else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            if run_case(page, base_url, "?volume=5&floor=20", check) is not None:
                unit = voiced_unit(page)
                check("vol5 boss is voiced (Voice_Original_018)",
                      unit is not None and unit["sheet"] == "Voice_Original_018",
                      unit)
                srcs = voice_entries(page)
                check("exactly one voice_400 playback", len(srcs) == 1, srcs)
                check("audio src is the boss's own sheet",
                      len(srcs) == 1
                      and "Voice_Original_018/voice_400_" in srcs[0]
                      and srcs[0].endswith(("voice_400_0.mp3", "voice_400_1.mp3")),
                      srcs)
                st = subtitle_state(page)
                check("subtitle visible with the boss's name and line",
                      st is not None and st["visible"]
                      and st["name"] == "ハイプリス" and st["line"].strip(),
                      st)
                dismiss_dialogues(page)
                check("subtitle hides itself (~4.5s)", wait_subtitle_hidden(page))
            check("vol5: no pageerrors", not errors, errors[:3])
            check("vol5: no console warnings", not warnings, warnings[:3])

            # -- case B: vol 1 guard floor, the 層守衛 elite --------------
            warnings, errors = [], []
            if run_case(page, base_url, "?volume=1&floor=10", check) is not None:
                unit = voiced_unit(page)
                check("guard floor fields a voiced 層守衛", unit is not None,
                      unit)
                srcs = voice_entries(page)
                check("audio src is the rolled elite's own sheet",
                      unit is not None and len(srcs) == 1
                      and ("%s/voice_400_" % unit["sheet"]) in srcs[0],
                      {"unit": unit, "srcs": srcs})
                st = subtitle_state(page)
                check("subtitle names the elite with a line",
                      st is not None and st["visible"]
                      and unit is not None and st["name"] == unit["name"]
                      and st["line"].strip(),
                      st)
                check("subtitle hides itself (~4.5s)", wait_subtitle_hidden(page))
            check("guard: no pageerrors", not errors, errors[:3])
            check("guard: no console warnings", not warnings, warnings[:3])

            # -- case C: vol 1 final boss, テンペスト has no sheet ---------
            warnings, errors = [], []
            if run_case(page, base_url, "?volume=1&floor=20", check) is not None:
                unit = voiced_unit(page)
                check("story boss carries no sheet", unit is None, unit)
                check("no voice_400 playback", not voice_entries(page),
                      voice_entries(page))
                st = subtitle_state(page)
                check("no subtitle", st is not None and not st["visible"], st)
            check("story: no pageerrors", not errors, errors[:3])
            check("story: no console warnings", not warnings, warnings[:3])

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    print("=" * 60)
    if fails == 0:
        print("ALL OK — boss opening voice (spec/05 §6 rule 5)")
        return 0
    print(fails, "check(s) failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
