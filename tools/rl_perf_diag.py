# One-off diagnostic for the perf-gate draw-call failure (332 vs budget 300).
# Rebuilds the gate's worst case (battle room + donor cloned to 10) and
# attributes every draw call to a scene subtree by toggling visibility:
#   calls(subtree) = calls(all) - calls(subtree hidden)
# Usage: python tools/rl_perf_diag.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8984
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto("http://127.0.0.1:%d/site/game/roguelike.html" % port,
                      wait_until="load", timeout=60000)
            deadline = time.time() + 40
            while time.time() < deadline:
                if page.evaluate("!!window.kirafanRL"):
                    break
                page.wait_for_timeout(200)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.evaluate("document.querySelector('.roster-card').click()")
            deadline = time.time() + 30
            while time.time() < deadline \
                    and not page.evaluate("!!window.kirafanRL.world.player"):
                page.wait_for_timeout(200)
            for _ in range(90):
                vis = page.evaluate(
                    "(() => { const b = document.getElementById('dialogue-box');"
                    " return !!(b && b.style.display !== 'none'); })()")
                if not vis:
                    break
                page.evaluate("document.getElementById('dialogue-box').click()")
                page.wait_for_timeout(90)

            # --- the gate's worst-case construction, verbatim ------------
            entered = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const w = k.world;
                const battle = w.dungeon.rooms.find(r => r.type === 'battle');
                if (!battle) { return false; }
                w.enterRoom(battle.id, 'N');
                return true;
            })()""")
            print("entered battle room:", entered)
            for _ in range(60):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(8)
            deadline = time.time() + 40
            while page.evaluate("window.kirafanRL.pending"):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(50)
                if time.time() > deadline:
                    break

            built = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const w = k.world;
                const p = w.player;
                p.iframes = 1e9;
                p.hp = p.maxHp;
                const alive = w.enemies.filter(e => !e.dead);
                if (!alive.length) { return null; }
                const donor = alive[0];
                window.__donor = donor.model;
                while (w.enemies.filter(e => !e.dead).length < 10) {
                    const ang = Math.random() * Math.PI * 2;
                    const dist = 3 + Math.random() * 4;
                    w.spawnEnemy({
                        enemyId: donor.enemyId, name: donor.name,
                        nameZh: donor.nameZh, model: donor.model,
                        shadowScale: donor.shadowScale,
                        voiceCueSheet: donor.voiceCueSheet,
                        x: Math.min(w.width - 1, Math.max(1, p.x + Math.cos(ang) * dist)),
                        y: Math.min(w.height - 1, Math.max(1, p.y + Math.sin(ang) * dist)),
                        radius: donor.radius, hp: 1e9, atk: donor.atk,
                        mgc: donor.mgc, def: donor.def, mdef: donor.mdef,
                        spd: donor.spd, luck: donor.luck, element: donor.element,
                        aiType: donor.aiType, elite: donor.elite,
                        moveset: donor.moveset,
                        turnSeconds: donor.turnSeconds, room: w.roomId
                    });
                }
                w.enemies.forEach(e => { e.hp = 1e9; e.maxHp = 1e9; });
                w.events.push({ type: 'summon', unit: donor, count: 0 });
                for (let i = 0; i < 40; i++) {
                    w.danmaku.emit('ring', { x: p.x, y: p.y },
                        { side: 'enemy', count: 24, speed: 0.4 + Math.random() * 0.4,
                          life: 600, power: 1, coef: 0.1, radius: 0.2, element: 1 });
                }
                return w.enemies.filter(e => !e.dead).length;
            })()""")
            print("enemies built:", built, "donor:", page.evaluate("window.__donor"))
            for _ in range(60):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(8)

            # --- attribute draw calls by hiding subtrees -----------------
            out = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const calls = () => {
                    k.renderOnce();
                    return k.renderer.info.render.calls;
                };
                const base = calls();

                // name every direct child of the scene so we can bucket
                const root = k.scene;
                const kids = root.children.map(c => ({
                    handle: c.uuid,
                    label: (c.name || c.type) +
                        (c.isInstancedMesh ? ' [instanced x' + c.count + ']' : ''),
                    meshes: (() => { let n = 0;
                        c.traverse(o => { if (o.isMesh && o.visible) n++; });
                        return n; })(),
                }));

                const per = [];
                for (const kid of kids) {
                    const obj = root.children.find(c => c.uuid === kid.handle);
                    if (!obj) { continue; }
                    const was = obj.visible;
                    obj.visible = false;
                    const without = calls();
                    obj.visible = was;
                    per.push({ label: kid.label, meshes: kid.meshes,
                               calls: base - without });
                }
                per.sort((a, b) => b.calls - a.calls);
                return { base: base, per: per };
            })()""")
            print("total draw calls:", out["base"])
            print("scene children by draw calls:")
            for row in out["per"]:
                print("  %-46s meshes=%-4d calls=%d"
                      % (row["label"][:46], row["meshes"], row["calls"]))

            # name every mesh under one enemy stack and under the two
            # 6-mesh groups, so runtime-added meshes (facial decals,
            # outlines, clones) can be told apart from authored ones
            names = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const dump = (obj) => {
                    const rows = [];
                    obj.traverse(o => {
                        if (o.isMesh) {
                            rows.push({ name: o.name, visible: o.visible,
                                        parent: o.parent && o.parent.name });
                        }
                    });
                    return rows;
                };
                const stacks = k.scene.children
                    .filter(c => c.type === 'Group')
                    .map(c => ({ label: c.name || c.type,
                                 meshes: dump(c) }))
                    .filter(g => g.meshes.length > 0);
                return stacks;
            })()""")
            for g in names:
                print("group %-30s meshes=%d" % (g["label"][:30], len(g["meshes"])))
                for m in g["meshes"]:
                    print("    %-40s vis=%s parent=%s"
                          % (m["name"][:40], m["visible"], (m["parent"] or "")[:24]))
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
