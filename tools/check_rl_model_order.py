"""Compare real Roguelike frames with and without the shared model sorter.

Start tools/serve.mjs, then run:
  python tools/check_rl_model_order.py --url http://127.0.0.1:8765
Tests the original report's affected models plus historic enemy regressions.
GLBs, animations, materials, mirrors, role offsets and scene are the real game.
Only the scene's sorting hooks are toggled between two otherwise identical draws.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MODELS = ["model_pl_120000", "model_en_13703", "model_pl_100001", "model_pl_100003",
          "model_pl_130001", "model_pl_140000", "model_pl_140101", "model_pl_140102",
          "model_pl_150204", "model_pl_220100", "model_pl_230402", "model_pl_250201",
          "model_pl_250202", "model_pl_320801", "model_en_1000", "model_en_7000",
          "model_en_10001", "model_pl_100000", "model_pl_320111"]

INIT = r"""async () => {
    const rl = window.kirafanRL;
    window.requestAnimationFrame = () => 0;
    rl.world.frozen = true;
    rl.world.player.iframes = 1e9;
    const {THREE} = await import(new URL('../site/core/loader.js',location.href).href).then(m => m.loadModules());
    window.__orderAudit = {THREE, player:rl.views.player, activePlayer:rl.views.player, view:null, unit:null};
}"""

PLAYER_FIXTURE = r"""async model => {
    const a=window.__orderAudit,rl=window.kirafanRL,id=model.replace('model_pl_','');
    const [actors,cards,views]=await Promise.all([
        import(new URL('../site/core/actor.js',location.href).href),
        import(new URL('../site/core/cards.js',location.href).href),
        import(new URL('./rl/view/actorview.js',location.href).href)]);
    const card=cards.all().find(c=>String(c.resourceId)===id||String(c.evolvedResourceId)===id);
    if(!card)throw new Error('no card metadata for '+model);
    const evolved=String(card.evolvedResourceId)===id;
    const rendered=(evolved?cards.byId(card.evolvedResourceId):null)||card;
    const weapon=rendered.dedicatedWeapon;
    const actor=await actors.create({resourceId:id,classId:card.class,headId:cards.headId(card,evolved),
        dedicatedWeapon:weapon,weapon:weapon&&(weapon.resourceIdR||weapon.resourceIdL)?'dedicated':'default'});
    const unit={x:12,y:9,facing:0,radius:0.35,swingId:0,dead:false,sm:{state:'idle',stateTime:0}};
    a.player.actor.object.visible=false;
    a.activePlayer=views.attachPlayerView(unit,actor,rl.scene);
}"""

DISPOSE_PLAYER = """() => {
    const a=window.__orderAudit;
    if(a.activePlayer!==a.player){
        a.activePlayer.dispose();window.kirafanRL.scene.remove(a.activePlayer.actor.object);
        a.activePlayer.actor.dispose();a.activePlayer=a.player;
    }
}"""

SPAWN = r"""async ({model, x=12, y=9}) => {
    const rl=window.kirafanRL, a=window.__orderAudit, w=rl.world;
    const kind=model.startsWith('model_en_')?'enemy':'player';
    const unit=w.spawnEnemy({model:'model/'+kind+'/'+model+'.muast', name:'order-audit',
        nameZh:'排序回归', x, y, hp:999999, aiType:'sentry'});
    w.events.push({type:'summon'});
    const deadline=performance.now()+30000;
    let view;
    while (!(view=rl.views.enemies.find(v=>v.unit===unit))) {
        if(performance.now()>deadline) throw new Error('enemy view timeout: '+model);
        rl.step(0);
        await new Promise(r=>setTimeout(r,30));
    }
    a.unit=unit; a.view=view;
    a.player.actor.object.visible=false;
    return [...new Set((view.mixer?view.mixer._actions:[]).map(x=>x.getClip().name))];
}"""

POSE = r"""({player, clip, fraction, facing}) => {
    const rl=window.kirafanRL, a=window.__orderAudit;
    const view=player?a.activePlayer:a.view, unit=player?view.unit:a.unit;
    unit.facing=facing;
    view.sync(0,0);
    const root=player?view.actor.object:view.object;
    root.visible=true;
    let duration=0;
    if(clip) {
        const actor=player?view.actor:view;
        if(!actor.play(clip,{loop:true,fade:0})) throw new Error('missing clip '+clip);
        const action=actor.mixer._actions.find(x=>x.getClip().name===clip);
        duration=action.getClip().duration;
        // Use the shipped AnimationMixer API so this also runs on the release baseline.
        actor.mixer.setTime(duration*fraction);
        if(player)actor.update(0);
    }
    root.position.x=unit.x; root.position.z=unit.y;
    rl.camera.zoom=player?3:2;
    rl.camera.updateProjectionMatrix();
    return {clip, time:duration*fraction, mirrored:root.scale.x<0};
}"""

PROBE = r"""({player=false, crowd=false}) => {
    const rl=window.kirafanRL, T=window.__orderAudit.THREE;
    const {scene,renderer,camera}=rl;
    if(renderer.getContext().isContextLost())throw new Error('WebGL context lost; rerun without concurrent browsers');
    const root=player?window.__orderAudit.activePlayer.actor.object:window.__orderAudit.view.object;
    scene.updateMatrixWorld(true); camera.updateMatrixWorld();
    const beforeHook=scene.onBeforeRender, afterHook=scene.onAfterRender;
    const invariant=()=>{
        const data=[];
        scene.traverse(n=>{
            if(!n.isMesh)return;
            const ms=Array.isArray(n.material)?n.material:[n.material];
            data.push([n.id,n.visible,n.renderOrder,n.matrixWorld.toArray(),ms.map(m=>
                [m.id,m.transparent,m.depthTest,m.depthWrite,m.side,m.alphaTest,m.opacity,
                 m.blending,m.blendSrc,m.blendDst])]);
        });
        return JSON.stringify(data);
    };
    const prior=invariant(), hooks=[], trace=[], vector=new T.Vector3();
    const width=renderer.domElement.width, height=renderer.domElement.height;
    const rect=[width,height,0,0];
    root.traverseVisible(n=>{
        if(!n.isMesh||!n.geometry)return;
        if(n.isSkinnedMesh)n.computeBoundingBox();
        else if(!n.geometry.boundingBox)n.geometry.computeBoundingBox();
        const b=n.isSkinnedMesh?n.boundingBox:n.geometry.boundingBox;
        for(const x of [b.min.x,b.max.x])for(const y of [b.min.y,b.max.y])for(const z of [b.min.z,b.max.z]){
            vector.set(x,y,z).applyMatrix4(n.matrixWorld).project(camera);
            const px=(vector.x+1)*width/2, py=(1-vector.y)*height/2;
            rect[0]=Math.min(rect[0],px);rect[1]=Math.min(rect[1],py);
            rect[2]=Math.max(rect[2],px);rect[3]=Math.max(rect[3],py);
        }
    });
    const crop=crowd?[0,0,width,height]:[Math.max(0,Math.floor(rect[0])-12),
        Math.max(0,Math.floor(rect[1])-12),Math.min(width,Math.ceil(rect[2])+12),
        Math.min(height,Math.ceil(rect[3])+12)];
    if(crop[2]<=crop[0]||crop[3]<=crop[1])throw new Error('model outside camera');
    const canvas=document.createElement('canvas');
    canvas.width=crop[2]-crop[0];canvas.height=crop[3]-crop[1];
    const ctx=canvas.getContext('2d');
    const queue=order=>{
        if(!Number.isSafeInteger(order))return null;
        const stage=Math.floor(order/1000000),layer=Math.floor(order%1000000/1000);
        if(stage<20||stage>24||layer>=125)return null;
        const q=stage*125+layer+(stage>=22?1:0);return q>2500?q:null;
    };
    scene.traverseVisible(n=>{
        if(!n.isMesh)return;
        const old=n.onBeforeRender;hooks.push([n,old]);
        n.onBeforeRender=function(r,s,c,g,material,part){
            old.apply(this,arguments);
            let z=0;
            const q=queue(n.userData.rlAuthoredOrder);
            if(q!==null){
                if(n.isSkinnedMesh)n.computeBoundingBox();
                else if(!n.geometry.boundingBox)n.geometry.computeBoundingBox();
                const b=n.isSkinnedMesh?n.boundingBox:n.geometry.boundingBox;
                b.getCenter(vector).applyMatrix4(n.matrixWorld).project(camera);z=vector.z;
            }
            let group=0;
            for(let p=n.parent;p;p=p.parent)if(p.isGroup){group=p.renderOrder;break;}
            trace.push({id:n.id+':'+material.id+':'+(part?.start||0), name:n.name,
                order:n.renderOrder, bucket:Math.floor(n.renderOrder/1000), q,
                band:n.renderOrder-n.userData.rlAuthoredOrder,z,group,transparent:material.transparent});
        };
    });
    function capture(enabled){
        scene.onBeforeRender=enabled?beforeHook:()=>{};
        scene.onAfterRender=enabled?afterHook:()=>{};
        renderer.setOpaqueSort(null);trace.length=0;
        renderer.render(scene,camera);
        if(!trace.length||renderer.getContext().isContextLost())throw new Error('no rendered meshes / lost WebGL context');
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(renderer.domElement,crop[0],crop[1],canvas.width,canvas.height,
            0,0,canvas.width,canvas.height);
        return {image:canvas.toDataURL('image/png'),trace:trace.slice()};
    }
    let before,after;
    try{before=capture(false);after=capture(true);}
    finally{
        scene.onBeforeRender=beforeHook;scene.onAfterRender=afterHook;
        renderer.setOpaqueSort(null);hooks.forEach(([n,old])=>n.onBeforeRender=old);
    }
    if(invariant()!==prior)throw new Error('sorting changed transforms, materials or visibility');
    const ids=new Map(before.trace.map((n,i)=>[n.id,i]));
    if(before.trace.length!==after.trace.length||after.trace.some(n=>!ids.has(n.id)))
        throw new Error('sorting changed the rendered meshes');
    const inversions=[];
    for(let i=0;i<after.trace.length;i++)for(let j=i+1;j<after.trace.length;j++){
        const a=after.trace[i],b=after.trace[j];
        if(ids.get(a.id)<=ids.get(b.id))continue;
        if(a.transparent||b.transparent||a.q===null||a.q!==b.q||a.band!==b.band||a.group!==b.group)
            throw new Error('cross-queue/role/transparent order changed: '+a.name+' / '+b.name);
        inversions.push([a.name,b.name,a.q,a.band]);
    }
    const groups=new Map();
    for(const n of after.trace){
        if(n.transparent)continue;
        const key=n.group+':'+n.bucket;
        if(!groups.has(key))groups.set(key,[]);groups.get(key).push(n);
    }
    let verifiedQueues=0;
    for(const peers of groups.values()){
        if(peers.length<2||peers.some(n=>n.q===null||n.q!==peers[0].q||n.band!==peers[0].band))continue;
        verifiedQueues++;
        for(let i=1;i<peers.length;i++)if(peers[i].z>peers[i-1].z+1e-10)
            throw new Error('alpha queue not back-to-front: '+peers[i-1].name+' / '+peers[i].name);
    }
    return {before:before.image,after:after.image,inversions,verifiedQueues,
        drawCalls:after.trace.length,crop,neckOrder:after.trace.filter(n=>/face$|chest_line/.test(n.name))};
}"""

DISPOSE = """() => {
    const a=window.__orderAudit, w=window.kirafanRL.world;
    if(a.view)a.view.dispose();
    const i=w.enemies.indexOf(a.unit);if(i>=0)w.enemies.splice(i,1);
    a.view=null;a.unit=null;
}"""


def save_images(result, out, stem):
    frames = []
    for key in ("before", "after"):
        image = Image.open(io.BytesIO(base64.b64decode(result.pop(key).split(",", 1)[1]))).convert("RGBA")
        path = f"{stem}-{key}.png"
        image.save(out / path)
        result[key] = path
        frames.append(np.array(image).astype(np.int16))
    result["changedPixels"] = int((np.max(np.abs(frames[0] - frames[1]), axis=2) > 8).sum())


def boot(page, url):
    page.goto(url.rstrip("/") + "/site/game/roguelike.html?volume=1&seed=model-order", wait_until="load", timeout=60000)
    page.wait_for_function("!!window.kirafanRL", timeout=60000)
    page.locator('.roster-card').filter(has=page.locator('img[src*="12000000"]')).click()
    page.wait_for_function("!!window.kirafanRL.views.player", timeout=60000)
    for _ in range(90):
        opened = page.evaluate("""() => {
            const b=document.getElementById('dialogue-box');
            if(b&&b.style.display!=='none'){b.click();return true;}return false;
        }""")
        if not opened:
            break
        page.wait_for_timeout(90)
    page.evaluate(INIT)
    page.wait_for_timeout(100)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", nargs="*", help="enemy-path model IDs; defaults to the 19-model regression set")
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--out", type=Path, default=ROOT / ".codex-tmp/neck-audit/roguelike/frames")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    report = {"player": [], "actors": [], "models": [], "crowd": None, "failures": [], "pageErrors": [], "modelRequests": []}

    def flush():
        (args.out / "browser-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")

    def sample(page, player, model, clip, fraction, facing, number):
        pose = page.evaluate(POSE, {"player": player, "clip": clip, "fraction": fraction, "facing": facing})
        result = page.evaluate(PROBE, {"player": player})
        save_images(result, args.out, f"{model}-{'player' if player else 'enemy'}-{number:02}")
        result.update(pose)
        return result

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1216, "height": 836})
        page.on("pageerror", lambda e: report["pageErrors"].append(str(e)))
        page.on("request", lambda r: report["modelRequests"].append(r.url)
                if "/site/asset/models/" in r.url and ".glb.gz" in r.url else None)
        try:
            boot(page, args.url)
            number = 0
            for clip in ("idle", "battle_run", "attack", "damage"):
                for fraction in (0.15, 0.65):
                    for facing in (0, 3.141592653589793):
                        report["player"].append(sample(page, True, "model_pl_120000", clip, fraction, facing, number))
                        number += 1
            assert any(any(inv[:2] == ["chest_line", "L30_face"] for inv in r["inversions"])
                       for r in report["player"]), "player did not exercise the reported neck fix"
            print(f"PASS player model_pl_120000: {number} poses, both mirrors", flush=True)
            flush()
            # Full actor path: class motions, separate head, expressions and
            # default/dedicated weapons, not just player GLBs as pseudo-enemies.
            for model in [m for m in (args.models or MODELS) if m.startswith('model_pl_')]:
                row = {"model": model, "cases": []}
                try:
                    page.evaluate(PLAYER_FIXTURE, model)
                    for clip in ("idle", "attack"):
                        for fraction in (0.15, 0.65):
                            for facing in (0, 3.141592653589793):
                                row["cases"].append(sample(page, True, model + "-actor", clip, fraction, facing, len(row["cases"])))
                    report["actors"].append(row)
                    print(f"PASS player path {model}: {len(row['cases'])} poses", flush=True)
                except Exception as error:
                    report["failures"].append({"actor": model, "error": str(error)})
                    print(f"FAIL player path {model}: {error}", flush=True)
                finally:
                    page.evaluate(DISPOSE_PLAYER)
                    flush()
            for model in args.models or MODELS:
                row = {"model": model, "cases": []}
                try:
                    available = page.evaluate(SPAWN, {"model": model})
                    wanted = [n for n in ("idle", "room_idle_L", "skill_0", "attack", "battle_run", "room_idle_R") if n in available]
                    # Rest plus one different motion, or both phases of a static model.
                    clips = (wanted[:1] + [n for n in wanted[1:] if n not in ("idle", "room_idle_L")][:1]) or available[:2] or [None]
                    for clip in clips:
                        for fraction in (0.15, 0.65):
                            for facing in (0, 3.141592653589793):
                                row["cases"].append(sample(page, False, model, clip, fraction, facing, len(row["cases"])))
                    report["models"].append(row)
                    print(f"PASS enemy path {model}: {len(row['cases'])} poses", flush=True)
                except Exception as error:
                    report["failures"].append({"model": model, "error": str(error)})
                    print(f"FAIL {model}: {error}", flush=True)
                finally:
                    page.evaluate(DISPOSE)
                    flush()
            # Keep three independently posed enemies alive with the real player,
            # map props, shadows and transparent effects in the same render list.
            for i, model in enumerate(("model_pl_120000", "model_pl_120000", "model_en_13703")):
                page.evaluate(SPAWN, {"model": model, "x": 11.6 + i * 0.6, "y": 9.1 + i * 0.3})
            page.evaluate("""() => {
                const rl=window.kirafanRL;
                window.__orderAudit.player.actor.object.visible=true;
                rl.camera.zoom=1.6;rl.camera.updateProjectionMatrix();
            }""")
            result = page.evaluate(PROBE, {"crowd": True})
            save_images(result, args.out, "crowd")
            report["crowd"] = result
            assert not report["pageErrors"], report["pageErrors"]
            print(f"PASS crowd: {result['drawCalls']} draw calls, {result['verifiedQueues']} alpha queues", flush=True)
        except Exception as error:
            report["failures"].append({"phase": "player/crowd/boot", "error": str(error)})
            print(f"FAIL integration: {error}", flush=True)
        finally:
            flush()
            browser.close()
    poses = len(report["player"]) + sum(len(r["cases"]) for r in report["actors"] + report["models"]) + int(report["crowd"] is not None)
    print(f"Roguelike: {len(report['actors'])} player-path / {len(report['models'])} enemy-path models, {poses} frames, {len(report['failures'])} failures")
    return int(bool(report["failures"]))


if __name__ == "__main__":
    raise SystemExit(main())
