"""Original skill playback regression, with an owned port-0 server."""
import functools
import hashlib
import io
import json
import re
import sys
import threading
from pathlib import Path

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from check_models_viewer import boot
from rl_result_browser import dismiss_dialogue
from rl_floor_loot_browser import ready, approach_shrine, pray, profile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".codex-tmp/skill-playback"
CHECKS = []
FILES = ['site/game/rl/main.js', 'site/game/rl/world.js', 'site/game/rl/combat.js', 'site/game/rl/skills.js',
         'site/game/rl/view/nativeassets.js', 'site/game/rl/view/skillvfx.js', 'site/game/rl/view/actorview.js',
         'site/game/rl/view/mapview.js', 'site/core/skillstage.js', 'site/core/uniqueskill.js',
         'site/asset/rl/playable-roster.json', 'site/asset/rl/skills-rl.json']


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def check(label, value, detail=None):
    print(("PASS " if value else "FAIL ") + label + (" " + str(detail) if detail else ""), flush=True)
    if not value:
        raise AssertionError(label)
    CHECKS.append(label)


def pixels(page, selector, filename):
    data = page.locator(selector).screenshot(path=str(OUT / filename))
    image = Image.open(io.BytesIO(data)).convert("RGB").resize((180, 120))
    variance = sum(ImageStat.Stat(image).var)
    check(filename + " has rendered detail", variance > 150, round(variance))
    return image


POSE = """root => {
    const bones=[];
    root.traverse(n=>{if(n.isBone && /Head|Hips|Spine|Arm|root/.test(n.userData.name||n.name))
        bones.push(...n.position.toArray(), ...n.quaternion.toArray());});
    return bones;
}"""


def viewer(page, base, manifest):
    boot(page, base, "model_pl_100003")
    page.locator('[data-model-action="skill"]').click()
    page.wait_for_function("!!window.__rendererDebug?.cinematic()", timeout=60000)
    page.locator('#modelMotionToggle').click()
    page.locator('#modelTimeline').fill('650')
    page.wait_for_timeout(150)
    state = page.evaluate("""() => {
        const c=window.__rendererDebug.cinematic();
        return {frame:c.player.frame, frames:c.player.frames};
    }""")
    check("viewer scrub moves original cinematic timeline", abs(state['frame'] / (state['frames']-1) - .65) < .01, state)
    samples = []
    for frame in [0,40,90,200,331]:
        page.locator('#modelTimeline').fill(str(round(frame/510*1000)))
        page.wait_for_timeout(70)
        samples.append(pixels(page, '#model3dCanvas', 'viewer-frame-%d.png' % frame))
    check("viewer cinematic visibly changes across frames",
          sum(ImageStat.Stat(ImageChops.difference(samples[1], samples[-1])).mean) > 5)
    pose = page.evaluate("() => (" + POSE + ")(window.__modelDebug)")
    page.wait_for_timeout(180)
    check("paused actor pose is stable", pose == page.evaluate("() => (" + POSE + ")(window.__modelDebug)"))
    page.locator('#modelTimeline').fill('78')
    check("scrubbing also moves actor bones", pose != page.evaluate("() => (" + POSE + ")(window.__modelDebug)"))
    page.screenshot(path=str(OUT / 'viewer-desktop.png'))
    page.set_viewport_size({"width":390,"height":844})
    page.wait_for_timeout(150)
    pixels(page, '#model3dCanvas', 'viewer-mobile-canvas.png')
    page.screenshot(path=str(OUT / 'viewer-mobile.png'))
    check("viewer mobile has no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    page.set_viewport_size({"width":1440,"height":960})
    page.locator('[data-model-action="attack"]').first.click()
    check("ordinary action exits cinematic", page.evaluate("!window.__rendererDebug.cinematic()"))
    page.locator('[data-model-action="skill"]').click()
    page.wait_for_function("!!window.__rendererDebug.cinematic()", timeout=60000)
    check("viewer cinematic can be replayed", page.evaluate("window.__rendererDebug.cinematic().player.frame < 15"))

    # A missing cross-model owner bundle must leave an explicit retry, not
    # silently remove the skill button or borrow this costume's other motion.
    source = manifest['skillActions']['380001']['file']
    pattern = '**/' + source
    page.route(pattern, lambda r: r.fulfill(status=503, body='owner fixture unavailable'))
    boot(page, base, 'model_pl_380003')
    page.wait_for_selector('[data-cinematic-toggle]', timeout=40000)
    button = page.locator('[data-model-action="skill"]')
    button.click()
    page.wait_for_function("document.querySelector('.model-cinematic-status')?.textContent.includes('可重试')", timeout=40000)
    check('missing exact owner action remains retryable', button.is_enabled() and
          page.evaluate('!window.__rendererDebug.cinematic()'))
    page.unroute(pattern)
    button.click()
    page.wait_for_function('!!window.__rendererDebug.cinematic()', timeout=40000)
    check('owner action retry uses the exact mapped source', page.evaluate(
        "source=>window.__rendererDebug.clipInfo().find(c=>c.name==='skill')?.sourceFile===source", source))


def texture_failures(page):
    index = json.loads((ROOT/'site/asset/uniqueskill/scene-index.json').read_text(encoding='utf-8'))
    plain = next(rid for rid, row in index['scenes'].items() if not row.get('layeredMaterials'))
    pattern = '**/site/asset/uniqueskill/texture/*'
    for rid in [plain, '100003']:
        page.route(pattern, lambda r: r.fulfill(status=503, body='texture fixture unavailable'))
        result = page.evaluate("""async rid => {
          const us=await import('/site/core/skillstage.js');
          try { const r=await us.loadScene(rid);us.disposeScene(r.scene,r.modules.THREE);return {resolved:true}; }
          catch(error) { return {resolved:false,message:error.message}; }
        }""", rid)
        check('missing texture rejects the whole scene '+rid, not result['resolved'], result)
        page.unroute(pattern)
        check('failed textures can be retried '+rid, page.evaluate("""async rid=>{
          const us=await import('/site/core/skillstage.js');const r=await us.loadScene(rid);
          us.disposeScene(r.scene,r.modules.THREE);return true;
        }""", rid))


def start_game(page, base, card_id=23002001, floor=1):
    page.goto(base + '/site/game/roguelike.html?volume=1&floor=%d&seed=300908' % floor,
              wait_until='load', timeout=60000)
    page.wait_for_selector('.roster-card', timeout=40000)
    page.locator('.roster-card').filter(has=page.locator('img[src$="/%d.webp"]' % card_id)).click()
    # Stop only the test clock; production step() still owns every update/render.
    page.evaluate('window.__manualRAF = true')
    ready(page)
    page.wait_for_function('!kirafanRL.roomLoading && !kirafanRL.world.frozen', polling=50, timeout=60000)
    check('exact playable card selected ' + str(card_id), page.evaluate('kirafanRL.world.player.card.id') == card_id)
    page.evaluate("""() => {
      const k=window.kirafanRL,w=k.world,p=w.player;
      p.iframes=1e9;p.base.luck=0;p.luck=0;
      k.step(1/60);
    }""")


def prepare_enemy(page):
    return page.evaluate("""() => {
      const k=window.kirafanRL,w=k.world,p=w.player;
      w.enemies.forEach(e=>{e.dead=true;});
      const art=w.encounter.mobs[0];
      const e=w.spawnEnemy({x:p.x+3,y:p.y,hp:10000000,def:0,mdef:0,luck:0,
        atk:0,mgc:0,element:p.element,model:art.model,nameZh:art.nameZh});
      e.actionTimer=1e9;window.skillFoe=e;p.skills.clearEffects();
      p.sm.set('idle');k.step(1/60);
      return e.hp;
    }""")


def press(page, key):
    page.keyboard.down(key)
    page.evaluate('window.kirafanRL.step(1/60)')
    page.keyboard.up(key)
    page.evaluate('window.kirafanRL.step(1/60)')


def charge(page):
    page.evaluate("""() => {
      const k=window.kirafanRL,p=k.world.player;
      for(let i=0;i<90 && !['idle','move'].includes(p.sm.state);i++)k.step(1/60);
      p.skills.addGauge(p.skills.gaugeMax);k.step(1/60);
    }""")


def wait_stage(page):
    try:
        page.wait_for_function('!!window.kirafanRL.ultimate.stage', polling=100, timeout=30000)
    except Exception:
        print(page.evaluate("""() => {const k=window.kirafanRL,w=k.world,p=w.player;
          return {loading:k.ultimate.loading,frozen:w.frozen,state:p.sm.state,
            gauge:p.skills.gauge,ready:p.skills.ultimateReady,held:p.heldUltimate,
            events:w.events.map(e=>e.type),skill:p.skills.ultimate};}"""),flush=True)
        page.screenshot(path=str(OUT/'failed-ultimate.png'))
        raise
    page.evaluate('window.kirafanRL.step(1/60)')


def skip(page):
    page.locator('.rl-ultimate-skip').click()
    page.evaluate('window.kirafanRL.step(1/60)')


def settle_combat_visuals(page):
    # A restored combat frame may still own hit/buff particles; those are not
    # cinematic leaks. Wait for real loads, then let their real lifetimes end.
    page.evaluate('async()=>{await kirafanRL.effects.ready;await kirafanRL.effects.prepare(kirafanRL.world.player);}')
    page.wait_for_function('kirafanRL.effects.stats.active===kirafanRL.effects.stats.loaded', polling=50, timeout=30000)
    page.evaluate('()=>{for(let i=0;i<120;i++)kirafanRL.step(1/60);}')
    check('combat effect lifetimes have settled before the GPU sample', page.evaluate(
        'kirafanRL.effects.stats.active===0 && kirafanRL.effects.stats.trails===0 && kirafanRL.effects.stats.errors.length===0'))


def game(page, base):
    start_game(page, base)
    hp = prepare_enemy(page)
    page.wait_for_function('window.kirafanRL.pending === 0', polling=100, timeout=40000)
    check("HUD has two ordinary skills", page.locator('.hud-skill:visible').count() == 2)
    press(page, 'Digit2')
    check("ordinary skill uses authored class motion", page.evaluate("window.kirafanRL.world.player.skills.slots[1].action === 'class_skill_2' && window.kirafanRL.views.player.current === 'class_skill_2'"))
    check("ordinary skill spends cooldown only", page.evaluate("window.kirafanRL.world.player.skills.slots[1].remaining > 0 && !window.kirafanRL.ultimate.stage"))
    page.evaluate('window.kirafanRL.world.danmaku.clear()')
    charge(page)
    hp = page.evaluate('window.skillFoe.hp')
    # SkillList 230020010 (the playable evolved 5-star Rin), not the old
    # four-star legacy card 23001000: one 2410/1000 magic hit, neutral element.
    expected = page.evaluate('Math.round(window.kirafanRL.world.player.mgc*2.41*2.6)')
    press(page, 'KeyR')
    wait_stage(page)
    check("R resolves original all-target damage once", page.evaluate('window.skillFoe.hp') == hp-expected)
    check("ultimate owns original scene and a separate actor", page.evaluate("""() => {
      const k=window.kirafanRL,u=k.ultimate;
      return k.world.player.skills.ultimate.sceneId==='230004' && u.actor!==k.views.player.actor
        && u.actor.resourceId===k.views.player.actor.resourceId
        && u.actor.object.parent===u.stage.root && k.world.frozen
        && u.actor.action==='skill' && k.world.player.skills.gauge===0;
    }"""))
    page.evaluate('window.kirafanRL.ultimate.stage.seek(40)')
    page.evaluate('window.kirafanRL.renderOnce()')
    first = pixels(page, '#stage canvas', 'roguelike-frame-40.png')
    pose = page.evaluate("() => (" + POSE + ")(window.kirafanRL.ultimate.actor.object)")
    camera = page.evaluate('window.kirafanRL.ultimate.stage.camera.matrixWorld.toArray()')
    page.evaluate('window.kirafanRL.ultimate.stage.seek(200)')
    page.evaluate('window.kirafanRL.renderOnce()')
    second = pixels(page, '#stage canvas', 'roguelike-frame-200.png')
    check("original actor bones and camera animate", pose != page.evaluate("() => (" + POSE + ")(window.kirafanRL.ultimate.actor.object)")
          and camera != page.evaluate('window.kirafanRL.ultimate.stage.camera.matrixWorld.toArray()'))
    check("roguelike original frames visibly differ", sum(ImageStat.Stat(ImageChops.difference(first,second)).mean)>5)
    page.screenshot(path=str(OUT/'roguelike-desktop.png'))
    before = page.evaluate('window.kirafanRL.ultimate.stage.frame')
    press(page,'Escape')
    page.evaluate('window.kirafanRL.step(.25)')
    check("pause stops cinematic and world", page.evaluate('window.kirafanRL.ultimate.stage.frame')==before and page.evaluate('window.kirafanRL.world.frozen'))
    press(page,'Escape')
    page.evaluate('window.kirafanRL.step(.25)')
    check("resume advances same cinematic", page.evaluate('window.kirafanRL.ultimate.stage.frame')>before)
    skip(page)
    check("skip returns to combat without duplicate damage", page.evaluate('!window.kirafanRL.world.frozen && !window.kirafanRL.ultimate.stage') and page.evaluate('window.skillFoe.hp')==hp-expected)
    # Warm all assets before using the renderer's owned GPU resource counters.
    page.wait_for_function('window.kirafanRL.pending===0 && window.kirafanRL.interactPending===0',polling=100,timeout=40000)
    settle_combat_visuals(page)
    # Ten real hits naturally cause a stun. Its cached nine-mesh effect is
    # uploaded only when rendered, not by preloadNative; prime it once rather
    # than misclassifying that first upload as an ultimate geometry leak.
    before_warm = page.evaluate('({...kirafanRL.renderer.info.memory})')
    check('warm the real stun path without assigning a stun state', page.evaluate("""()=>{
        const k=kirafanRL,w=k.world,e=skillFoe,hp=e.hp;
        for(let i=0;i<10&&e.stunTimer<=0;i++){
            w.danmaku.emit('aimed',{x:e.x-.8,y:e.y,angle:0},
                {side:'player',srcId:w.player.id,element:w.player.element,power:1,coef:1,count:1,speed:10,life:1});
            for(let j=0;j<20;j++)k.step(1/60);
        }
        return e.stunTimer>0&&e.hp<hp;
    }"""))
    settle_combat_visuals(page)
    page.evaluate('()=>{for(let i=0;i<120;i++)kirafanRL.step(1/60);}')
    check('stun warmup finishes and leaves no active particles', page.evaluate(
        'skillFoe.stunTimer===0&&kirafanRL.effects.stats.active===0'),
        {'before': before_warm, 'after': page.evaluate('({...kirafanRL.renderer.info.memory})')})
    memories = []
    for i in range(20):
        charge(page)
        press(page,'Digit1' if i % 2 else 'KeyR')
        wait_stage(page)
        page.evaluate("""() => {
          const k=window.kirafanRL;for(let i=0;i<200 && k.ultimate.stage;i++)k.step(.25);
          k.step(1/60);
        }""")
        settle_combat_visuals(page)
        memories.append(page.evaluate('({...window.kirafanRL.renderer.info.memory})'))
        check('repeated ultimate %d cleans up' % (i+1), page.evaluate('!window.kirafanRL.ultimate.stage && !window.kirafanRL.world.frozen'))
    check("twenty original performances release GPU textures", len({m['textures'] for m in memories})==1, memories)
    check("geometry count stays bounded through twenty performances",
          max(m['geometries'] for m in memories)-min(m['geometries'] for m in memories)<=1
          and len({m['geometries'] for m in memories[-5:]})==1,memories)
    page.route('**/site/asset/uniqueskill/scene/230004.glb.gz', lambda r:r.fulfill(status=503,body='fixture unavailable'))
    hp = prepare_enemy(page)
    charge(page)
    press(page,'KeyR')
    page.wait_for_function('!window.kirafanRL.ultimate.loading',polling=100,timeout=60000)
    page.evaluate('window.kirafanRL.step(1/60)')
    check("missing scene keeps exactly one payload and releases freeze", page.evaluate('window.skillFoe.hp')==hp-expected and page.evaluate('!window.kirafanRL.world.frozen && !window.kirafanRL.ultimate.stage && window.kirafanRL.world.player.skills.gauge===0'))


def touch_game(page, base):
    start_game(page,base,46002001)
    prepare_enemy(page)
    page.locator('.hud-skill[data-slot="2"]').tap()
    page.evaluate('window.kirafanRL.step(1/60)')
    check("touch character skill uses authored action and shield",page.evaluate("window.kirafanRL.views.player.current === 'class_skill_3' && window.kirafanRL.world.player.skills.barrier.hits===1"))
    charge(page)
    page.locator('.hud-gauge').tap()
    page.evaluate('window.kirafanRL.step(1/60)')
    wait_stage(page)
    check("Hitori original scene retains three-hit shield and the rendered costume",page.evaluate('window.kirafanRL.world.player.skills.barrier.hits===3 && window.kirafanRL.world.player.skills.gauge===0 && window.kirafanRL.world.frozen && window.kirafanRL.ultimate.actor.resourceId===window.kirafanRL.views.player.actor.resourceId'))
    page.evaluate('window.kirafanRL.ultimate.stage.seek(100);window.kirafanRL.renderOnce()')
    pixels(page,'#stage canvas','roguelike-touch-hitori.png')
    page.screenshot(path=str(OUT/'roguelike-touch.png'))
    page.locator('.rl-ultimate-skip').tap()
    page.evaluate('window.kirafanRL.step(1/60)')
    check("touch Hitori skip restores combat",page.evaluate('!window.kirafanRL.world.frozen'))
    start_game(page,base)
    prepare_enemy(page)
    charge(page)
    page.locator('.hud-gauge').tap()
    page.evaluate('window.kirafanRL.step(1/60)')
    wait_stage(page)
    page.evaluate('window.kirafanRL.ultimate.stage.seek(200)')
    page.evaluate('window.kirafanRL.renderOnce()')
    pixels(page,'#stage canvas','roguelike-mobile-canvas.png')
    page.screenshot(path=str(OUT/'roguelike-mobile.png'))
    check("mobile cinematic controls fit viewport",page.evaluate("""() => {
      const b=document.querySelector('.rl-ultimate-skip').getBoundingClientRect();
      return document.documentElement.scrollWidth<=innerWidth && b.right<=innerWidth
        && b.bottom<=innerHeight && b.left>=0 && b.top>=0;
    }"""))
    page.locator('.rl-ultimate-skip').tap()
    page.evaluate('window.kirafanRL.step(1/60)')
    check("touch skip restores combat",page.evaluate('!window.kirafanRL.world.frozen'))


def boundaries(page, base):
    page.unroute('**/site/asset/uniqueskill/scene/230004.glb.gz')
    start_game(page,base)
    prepare_enemy(page)
    pending=[]
    page.route('**/site/asset/uniqueskill/scene/230004.glb.gz',lambda route:pending.append(route))
    charge(page)
    press(page,'KeyR')
    for _ in range(100):
        if pending: break
        page.wait_for_timeout(50)
    check("delayed scene fixture reached the actual request",len(pending)==1)
    hp=page.evaluate('window.skillFoe.hp')
    skip(page)
    pending[0].continue_()
    page.wait_for_timeout(600)
    page.evaluate('window.kirafanRL.step(1/60)')
    check("late resource completion cannot revive a skipped stage",page.evaluate('!window.kirafanRL.ultimate.stage && !window.kirafanRL.ultimate.loading && !window.kirafanRL.world.frozen') and page.evaluate('window.skillFoe.hp')==hp)
    page.unroute('**/site/asset/uniqueskill/scene/230004.glb.gz')
    charge(page)
    press(page,'KeyR')
    wait_stage(page)
    press(page,'Escape')
    page.evaluate('window.kirafanRL.skipUltimate()')
    check("cleanup preserves pause ownership",page.evaluate('window.kirafanRL.world.frozen && !window.kirafanRL.ultimate.stage'))
    press(page,'Escape')
    check("closing the remaining pause resumes combat",page.evaluate('!window.kirafanRL.world.frozen'))
    charge(page)
    press(page,'KeyR')
    wait_stage(page)
    page.evaluate("""() => {const k=window.kirafanRL;
      const id=k.world.dungeon.rooms.find(r=>r.id!==k.world.roomId && r.type!=='boss').id;
      k.world.enterRoom(id,'N');k.step(1/60);
    }""")
    check("room change cancels the old cinematic",page.evaluate('!window.kirafanRL.ultimate.stage && !window.kirafanRL.ultimate.loading'))
    # Killing the final boss leaves an active loot checkpoint. Only an explicit
    # statue prayer may turn it into a terminal result, even during an ultimate.
    page.evaluate('localStorage.clear()')
    start_game(page,base,floor=20)
    page.evaluate("""() => {const k=window.kirafanRL;
      k.world.enterRoom(k.world.dungeon.rooms.find(r=>r.type==='boss').id,'N');k.step(1/60);
    }""")
    ready(page)
    page.evaluate('kirafanRL.world.enemies.forEach(e=>{e.hp=1;e.iframes=0;e.actionTimer=1e9;})')
    charge(page)
    press(page,'KeyR')
    check("fatal ultimate keeps the cleared boss checkpoint for looting",page.evaluate('kirafanRL.world.enemies.every(e=>e.dead) && kirafanRL.world.floorExitReady')
          and profile(page)['run'] is not None and profile(page)['lastResult'] is None)
    wait_stage(page)
    check("boss kill does not open a result or interrupt the cinematic",not page.locator('#dialogue-box').is_visible()
          and not page.locator('#rl-result[open]').count())
    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
    check("background save preserves the active loot checkpoint during playback",profile(page)['run'] is not None
          and profile(page)['lastResult'] is None)
    skip(page)
    dismiss_dialogue(page)
    ready(page)
    check("ending the cinematic alone cannot leave the boss room",page.evaluate('kirafanRL.world.floor===20 && kirafanRL.world.floorExitReady && !kirafanRL.world.frozen')
          and profile(page)['run'] is not None and profile(page)['lastResult'] is None)
    approach_shrine(page); pray(page)
    page.locator('#floor-departure-confirm').click()
    dismiss_dialogue(page)
    page.wait_for_selector('#rl-result[open]',timeout=15000)
    check("only confirmed statue prayer settles the victory once",page.locator('#rl-result').get_attribute('data-outcome')=='victory'
          and profile(page)['run'] is None and profile(page)['lastResult']['outcome']=='victory')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    before = fingerprints()
    (OUT/'report.json').write_text(json.dumps({"status":"RUNNING","args":sys.argv[1:]}),encoding='utf-8')
    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                               "--autoplay-policy=no-user-gesture-required"])
            try:
                context = browser.new_context(viewport={"width":1440,"height":960})
                manifest = json.loads((ROOT / 'site/asset/models/manifest.json').read_text(encoding='utf-8'))
                catalog = [{"name":key,"path":"bucket-a","size":1} for key in manifest['models']]
                context.route('https://database.kirafan.cn/assetBundle.json', lambda r: r.fulfill(json=catalog))
                context.route(re.compile(r'https://bucket-.*-asset\.kirafan\.cn/.*/index\.json'), lambda r: r.fulfill(status=503,body='offline fixture'))
                context.route(re.compile(r'https://asset\.kirafan\.cn/.*'), lambda r: r.fulfill(path=str(ROOT/'favicon.png'),content_type='image/png'))
                page = context.new_page()
                errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                if '--game-only' not in sys.argv:
                    viewer(page,base,manifest)
                    texture_failures(page)
                context.close()
                for mobile in ([False] if '--desktop-only' in sys.argv else [False,True]):
                    context = browser.new_context(viewport={"width":844 if mobile else 1280,"height":390 if mobile else 800},
                                                  is_mobile=mobile,has_touch=mobile,device_scale_factor=1)
                    context.add_init_script("""const raf=window.requestAnimationFrame.bind(window);
                        window.requestAnimationFrame=cb=>raf(t=>{if(!window.__manualRAF) cb(t);});""")
                    page=context.new_page()
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    page.on('console',lambda m: print(m.text,flush=True) if m.type=='warning' and 'uniqueskill' in m.text else None)
                    if '--boundary-only' in sys.argv:
                        if not mobile: boundaries(page,base)
                    elif mobile:
                        touch_game(page,base)
                    else:
                        game(page,base)
                        boundaries(page,base)
                    context.close()
                check("no browser exceptions",not errors,errors)
                after = fingerprints(); check('product sources stayed unchanged during playback checks', before == after)
                (OUT/'report.json').write_text(json.dumps({"status":"PASS","args":sys.argv[1:],"checks":CHECKS,"errors":errors,
                    'before':before,'after':after},ensure_ascii=False,indent=2),encoding='utf-8')
            finally:
                browser.close()
    except Exception as error:
        (OUT/'report.json').write_text(json.dumps({"status":"FAIL","args":sys.argv[1:],
            "checks":CHECKS,"failure":str(error),'before':before,'after':fingerprints()},ensure_ascii=False,indent=2),encoding='utf-8')
        raise
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == '__main__':
    main()
