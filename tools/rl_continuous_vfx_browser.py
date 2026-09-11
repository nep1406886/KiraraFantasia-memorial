"""Original melee art: continuous projected direction, pixels and live camera.

Uses the same emitSlash API as swingActive on an isolated GPU stage. This does
not replace the real-input collision checks in rl_continuous_aim_browser.py.
"""
import argparse
import functools
import json
import math
import threading

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_projectile_visual_browser import SETUP
from rl_hit_alignment_browser import ROOT, fingerprints

OUT = ROOT / '.codex-tmp' / 'continuous-aim'

MEASURE = """() => {
    const a=audit,T=a.T,roots=a.scene.children.filter(n=>n.userData.rlOverlay&&!n.isInstancedMesh&&!n.isPoints);
    const root=roots[0],angle=a.unit.facing;
    const centre=new T.Vector3(0,1,0).project(a.camera),from=new T.Vector3(0,0,0).project(a.camera);
    const size=a.renderer.getSize(new T.Vector2());
    const pixelsDirection=v=>v.set(v.x*size.x,v.y*size.y,0).normalize();
    const aim=pixelsDirection(new T.Vector3(Math.cos(angle),0,Math.sin(angle)).project(a.camera).sub(from));
    const drawn=root?new T.Vector3(-1,0,0).applyMatrix4(root.matrixWorld).project(a.camera)
        .sub(root.position.clone().project(a.camera)):null;
    if(drawn)pixelsDirection(drawn);
    const gl=a.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
    const read=()=>{a.renderer.render(a.scene,a.camera);const data=new Uint8Array(w*h*4);
        gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
    // Do not let a few decorative emitter dots stand in for the authored blade.
    const particles=[];roots.forEach(r=>r.traverse(n=>{if(n.name.startsWith('pe:')){
        particles.push([n,n.visible]);n.visible=false;}}));
    const visible=roots.map(r=>r.visible),before=read();roots.forEach(r=>r.visible=false);const after=read();
    roots.forEach((r,i)=>r.visible=visible[i]);particles.forEach(([n,v])=>n.visible=v);a.renderer.render(a.scene,a.camera);
    let pixels=0,sx=0,sy=0,minX=w,maxX=-1,minY=h,maxY=-1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;
        if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])<=20)continue;
        pixels++;sx+=x;sy+=y;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    const centroid=pixels?{x:sx/pixels,y:sy/pixels}:null,body={x:(centre.x+1)*w/2,y:(centre.y+1)*h/2};
    return {roots:roots.length,source:a.fx.stats.sources,alignment:drawn?.dot(aim),angle,
        pixels,centroid,body,bounds:{minX,maxX,minY,maxY},quaternion:root?.quaternion.toArray(),
        forwardPx:centroid?(centroid.x-body.x)*aim.x+(centroid.y-body.y)*aim.y:null,
        crossPx:centroid?-(centroid.x-body.x)*aim.y+(centroid.y-body.y)*aim.x:null};
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--observe', action='store_true')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'complete': False, 'checks': [], 'rows': [], 'errors': [], 'source_before': fingerprints()}

    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok and not args.observe:
            raise AssertionError(label + ': ' + str(detail))

    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            page = browser.new_page(viewport={'width': 800, 'height': 600})
            page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.route('**/continuous-vfx.html', lambda r: r.fulfill(content_type='text/html',
                       body='<html><body style="margin:0"><div id="stage"></div></body></html>'))
            page.goto('http://127.0.0.1:%d/continuous-vfx.html' % server.server_address[1])
            page.evaluate(SETUP, {'cap': 8, 'preload': True})
            # Full blade geometry must fit for a centroid comparison. This is
            # an isolated measurement frustum, not a change to the game camera.
            page.evaluate('audit.camera.top=4;audit.camera.bottom=-4;audit.camera.left=-16/3;audit.camera.right=16/3;audit.camera.updateProjectionMatrix()')
            def stage(angle, height, frame=None):
                page.evaluate("""({angle,height})=>{const a=audit;a.fx.clear();a.unit.facing=angle;
                    a.cameraAt(height);a.fx.emitSlash(a.unit);}""", {'angle': angle, 'height': height})
                page.wait_for_function('audit.fx.stats.loaded===1', timeout=30000)
                if frame is None:
                    page.evaluate('audit.render(1/60)')
                else:
                    # Compare the SAME authored source frame before/after a
                    # wind-up adapter, not an arbitrary blank frame or particle.
                    page.evaluate("""async frame=>{const a=audit,index=await a.native.loadNativeIndex(),
                        cfg=(await import('/site/game/rl/view/effectcatalog.js')).normalEffectConfig(a.unit),
                        entry=index.effects[a.fx.stats.sources[0]],elapsed=(frame-(cfg.startFrame||0))/30*cfg.duration/entry.duration;
                        if(elapsed<0)throw Error('sample frame precedes normal attack');a.render(elapsed);}""", frame)
                return page.evaluate(MEASURE)
            for cls in (0, 3):
                for element in range(6):
                    page.evaluate("""async({cls,element})=>{const a=audit;
                        a.unit.card.class=cls;a.unit.element=element;
                        a.unit.weaponProfile=(await import('/site/game/rl/weaponprofile.js')).weaponProfile({class:cls});
                        a.unit.skills.normal={id:cls+1,damage:true};await a.fx.prepare(a.unit);}""", {'cls': cls, 'element': element})
                    for height in ([5.5, 9, 13] if element == 0 else [9]):
                        sample_frame = 12 if cls == 0 else 15
                        baseline = stage(0, height, sample_frame)
                        check('原作横向基准确实有主攻击图形 %d %d %.1f' % (cls, element, height), baseline['pixels'] > 100, baseline)
                        for index in range(16 if element == 0 else 4):
                            angle = index * math.tau / (16 if element == 0 else 4) + .173
                            row = stage(angle, height, sample_frame)
                            row.update(cls=cls, element=element, height=height, index=index)
                            check('近战原作连续角度与屏幕投影一致 %d %d %.1f %d' % (cls, element, height, index),
                                  row['roots'] == 1 and row['alignment'] is not None and row['alignment'] > 1 - 1e-10, row)
                            check('原作近战效果产生主攻击图形而非装饰粒子 %d %d %.1f %d' % (cls, element, height, index), row['pixels'] > 100, row)
                            bounds = row['bounds']
                            check('测量主图形未被视口裁切 %d %d %.1f %d' % (cls, element, height, index),
                                  bounds['minX'] > 1 and bounds['maxX'] < 798 and bounds['minY'] > 1 and bounds['maxY'] < 598, bounds)
                            expected_cross = baseline['crossPx'] * (1 if math.cos(angle) > 0 else -1) if baseline['pixels'] else None
                            row['pivot_error_px'] = math.hypot(row['forwardPx'] - baseline['forwardPx'], row['crossPx'] - expected_cross) if row['pixels'] and baseline['pixels'] else None
                            check('原作攻击绕身体命中平面旋转而非脚下偏移 %d %d %.1f %d' % (cls, element, height, index),
                                  row['pivot_error_px'] is not None and row['pivot_error_px'] < 2.5, row)
                            report['rows'].append(row)
                            if element == 0 and height == 9 and index in (0, 4, 8, 12):
                                page.screenshot(path=str(OUT / ('vfx-%d-%d.png' % (cls, index))))
                    opening = stage(.173, 9)
                    check('世界已过前摇后，原作普攻首个显示步不再重复等待 %d %d' % (cls, element), opening['pixels'] > 100, opening)
                page.evaluate("""()=>{const a=audit;a.fx.clear();a.cameraAt(5.5);a.unit.facing=1.173;
                    a.fx.emitSlash(a.unit);}""")
                page.wait_for_function('audit.fx.stats.loaded===1', timeout=30000)
                page.evaluate('audit.render(.07);audit.cameraAt(13);audit.render(0)')
                row = page.evaluate(MEASURE)
                check('暂停期间改变镜头仍保持定向特效的正确投影 %d' % cls, row['alignment'] is not None
                      and row['alignment'] > 1 - 1e-10, row)
            page.evaluate('audit.fx.dispose();audit.view.dispose();audit.renderer.dispose()')
            check('特效释放后不残留原作实例引用', page.evaluate('audit.native.nativeCacheStats().refs===0'))
            check('原作近战连续方向验证无页面异常', not report['errors'], report['errors'])
            report['complete'] = True
            browser.close()
    except Exception as error:
        report['failure'] = str(error)
        raise
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()
        report['source_after'] = fingerprints()
        report['changed_during_run'] = [p for p in report['source_before'].keys() | report['source_after'].keys()
                                       if report['source_before'].get(p) != report['source_after'].get(p)]
        (OUT / ('vfx-observe.json' if args.observe else 'vfx.json')).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    return int(any(not row['ok'] for row in report['checks']))


if __name__ == '__main__':
    raise SystemExit(main())
