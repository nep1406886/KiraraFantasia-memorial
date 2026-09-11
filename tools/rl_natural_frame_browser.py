"""Foreground native-rAF measurements, separate from CPU profiling.

The staged encounter retains its generated enemies and real AI, input, rendering,
and autosave. High HP and player invulnerability keep this a sustained-load
fixture, not a natural-run or balance claim. SwiftShader is not a hardware gate.
"""
import argparse
from collections import defaultdict
import functools
import hashlib
import json
import math
import platform
import re
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import dismiss_dialogue

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/natural-frame'
READY = """() => { const k = window.kirafanRL;
    return k?.world.player && k.world.dungeon && !k.pending && !k.interactPending
        && !k.roomLoading && !k.world.frozen && !k.world.transition
        && k.mapview.group?.name === 'room:' + k.world.roomId; }"""
SAMPLE = """duration => new Promise(resolve => {
    const k = kirafanRL, w = k.world, intervals = [], snapshots = [], longTasks = [];
    const startWorld = w.time, startSwing = w.player.swingId;
    let first = null, last = null, nextSnapshot = 0, handle = 0, finished = false;
    let hidden = 0, unfocused = 0, frozen = 0, noEnemies = 0, maxBullets = 0;
    let observer = null, taskOverflow = false;
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        observer = new PerformanceObserver(list => {
            for (const item of list.getEntries()) {
                if (longTasks.length < 512) longTasks.push({start: item.startTime, duration: item.duration});
                else taskOverflow = true;
            }
        });
        observer.observe({type: 'longtask', buffered: false});
    }
    function done(complete) {
        if (finished) return;
        finished = true; clearTimeout(deadline); cancelAnimationFrame(handle);
        observer?.disconnect();
        resolve({complete, duration, first, last, elapsed: first === null ? 0 : last-first,
            intervals, snapshots, longTasks, taskOverflow, hidden, unfocused, frozen,
            noEnemies, maxBullets, capacity: w.danmaku.capacity, startWorld, endWorld: w.time,
            startSwing, endSwing: w.player.swingId, nativeRAF: /\\[native code\\]/.test(String(requestAnimationFrame))});
    }
    const deadline = setTimeout(() => done(false), duration + 10000);
    function frame(now) {
        if (first === null) { first = now; nextSnapshot = now; }
        if (last !== null) intervals.push(now-last);
        last = now;
        hidden += Number(document.visibilityState !== 'visible');
        unfocused += Number(!document.hasFocus());
        frozen += Number(w.frozen || !!w.transition || !!k.roomLoading);
        noEnemies += Number(!w.enemies.some(e => !e.dead));
        maxBullets = Math.max(maxBullets, w.danmaku.active);
        if (now >= nextSnapshot) {
            const info = k.renderer.info;
            snapshots.push({elapsed: now-first, time: w.time, room: w.roomId,
                enemies: w.enemies.filter(e => !e.dead).length, bullets: w.danmaku.active,
                dropped: w.danmaku.dropped, swing: w.player.swingId,
                calls: info.render.calls, triangles: info.render.triangles,
                geometries: info.memory.geometries, textures: info.memory.textures});
            nextSnapshot += 1000;
        }
        if (now-first >= duration) done(true);
        else if (intervals.length >= 20000) done(false);
        else handle = requestAnimationFrame(frame);
    }
    handle = requestAnimationFrame(frame);
})"""


def fingerprints():
    paths = {ROOT / 'site/game/roguelike.html'}
    for folder in ['game/rl', 'core']:
        paths.update(path for path in (ROOT / folder).rglob('*') if path.suffix in ['.js', '.css'])
    for name in ['cards-rl.json', 'skills-rl.json', 'weapons-rl.json', 'floors.json', 'encounters.json']:
        paths.add(ROOT / 'site/asset/rl' / name)
    return {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def metrics(session):
    return {entry['name']: entry['value'] for entry in session.send('Performance.getMetrics')['metrics']}


def summarize(values):
    ordered = sorted(values)
    if not ordered:
        return {'count': 0}
    percentile = lambda p: ordered[max(0, math.ceil(len(ordered) * p) - 1)]
    return {'count': len(values), 'mean': sum(values) / len(values), 'p50': percentile(.5),
            'p95': percentile(.95), 'p99': percentile(.99), 'max': ordered[-1],
            'over20': sum(v > 20 for v in values), 'over36': sum(v > 36 for v in values),
            'over50': sum(v > 50 for v in values)}


def cpu_summary(profile):
    nodes = {node['id']: node for node in profile['nodes']}
    parent = {child: node['id'] for node in profile['nodes'] for child in node.get('children', [])}
    own, inclusive = defaultdict(float), defaultdict(float)
    for node_id, delta in zip(profile.get('samples', []), profile.get('timeDeltas', [])):
        own[node_id] += delta / 1000
        cursor = node_id
        while cursor is not None:
            inclusive[cursor] += delta / 1000
            cursor = parent.get(cursor)
    def rows(timing):
        result = []
        for node_id, ms in sorted(timing.items(), key=lambda pair: pair[1], reverse=True)[:35]:
            frame = nodes[node_id]['callFrame']
            result.append({'function': frame['functionName'], 'url': frame['url'],
                           'line': frame['lineNumber'] + 1, 'ms': ms})
        return result
    return {'self': rows(own), 'inclusive': rows(inclusive),
            'elapsedMs': (profile['endTime'] - profile['startTime']) / 1000}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--label', default='current')
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--profile-seconds', type=float, default=10)
    parser.add_argument('--gl-seconds', type=float, default=0)
    parser.add_argument('--baseline-rendering', action='store_true',
                        help='Serve the three saved pre-optimization view snapshots, without changing workspace files')
    parser.add_argument('--quality', choices=['high', 'balanced', 'performance'], default=None,
                        help='Pre-write an active profile carrying this quality setting before boot')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', args.label) or not 5 <= args.seconds <= 180 or not 0 <= args.profile_seconds <= 30 or not 0 <= args.gl_seconds <= 30:
        parser.error('bounded label, 5..180 sampling seconds and 0..30 profiling seconds required')
    target = OUT / args.label
    target.mkdir(parents=True, exist_ok=True)
    if (target / 'report.json').exists():
        parser.error('use a new label to preserve the previous measurement')
    report = {'complete': False, 'checks': [], 'errors': [], 'source_before': fingerprints(),
              'fixture': ['Normal card selection and seed 28101 / volume 1 / floor 1 battle room.',
                          'Generated enemy identities/count/AI retained; no direct bullet injection.',
                          'High enemy HP, invulnerable player, safe central position, real mouse and held J.',
                          'Native foreground rAF; no manual step, altered pixel ratio or CPU throttling.',
                          'CPU profiler is a separate phase, excluded from frame intervals.']}
    overrides = {}
    if args.baseline_rendering:
        snapshots = {
            'site/game/rl/view/stagerender.js': '.codex-tmp/natural-frame/stagerender-before.js',
            'site/game/rl/view/skillvfx.js': '.codex-tmp/effect-reuse/skillvfx-before.js',
            'site/game/rl/view/enemytelegraphs.js': '.codex-tmp/telegraph-reuse/enemytelegraphs-before.js',
        }
        for name, snapshot in snapshots.items():
            if not (ROOT / snapshot).is_file():
                parser.error('missing baseline snapshot: ' + snapshot)
            overrides[name] = {'snapshot': snapshot, 'body': (ROOT / snapshot).read_bytes()}
    report['variant'] = 'pre-render-optimization-snapshots' if overrides else 'current-worktree'
    report['source_overrides'] = {name: {'snapshot': data['snapshot'],
        'sha256': hashlib.sha256(data['body']).hexdigest()} for name, data in overrides.items()}
    report['effective_source'] = report['source_before'] | {
        name: data['sha256'] for name, data in report['source_overrides'].items()}
    report['overrides_served'] = []
    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok:
            raise AssertionError(label + ': ' + str(detail))
    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1280, 'height': 840})
            context.add_init_script("localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
            if args.quality:
                # With an active profile the save module reads meta/settings only
                # from the envelope, so the tier must travel inside it.
                envelope = {'profileVersion': 2, 'revision': 0, 'dataVersion': 1,
                            'meta': {'prologueSeen': True, 'tutorialSeen': True},
                            'run': None, 'runId': None,
                            'settings': {'quality': args.quality}, 'lastResult': None}
                context.add_init_script("localStorage.setItem('kirafan-rl:profile',"
                                        "JSON.stringify(" + json.dumps(envelope) + "));")
                report['quality'] = args.quality
            page = context.new_page()
            def snapshot_handler(name, body):
                # Playwright supplies Request as a second positional argument
                # when a callback declares one, even with a default value.
                def serve_snapshot(route):
                    report['overrides_served'].append(name)
                    route.fulfill(content_type='application/javascript; charset=utf-8', body=body)
                return serve_snapshot
            for name, data in overrides.items():
                page.route('**/' + name + '*', snapshot_handler(name, data['body']))
            page.on('pageerror', lambda e: report['errors'].append(str(e)))
            url = 'http://127.0.0.1:%d/site/game/roguelike.html?volume=1&floor=1&seed=28101' % server.server_address[1]
            page.goto(url, wait_until='load', timeout=60000)
            page.locator('.roster-card').filter(has=page.locator('img[src$="/14002001.webp"]')).click(timeout=60000)
            page.wait_for_function('window.kirafanRL?.world.player && kirafanRL.world.dungeon', timeout=60000)
            dismiss_dialogue(page)
            page.wait_for_function(READY, timeout=60000)
            page.evaluate("""() => { const w=kirafanRL.world;
                w.player.iframes=1e9; w.enterRoom(w.dungeon.rooms.find(r=>r.type==='battle').id, 'N'); }""")
            page.wait_for_function(READY, timeout=60000)
            report['staged'] = page.evaluate("""() => {
                const w=kirafanRL.world, p=w.player, cells=[];
                for(let y=2; y<w.height-2; y++) for(let x=2; x<w.width-2; x++) {
                    const clear=w.roomColliders.every(b => Math.hypot(Math.max(Math.abs(x-b.x)-b.hw,0),
                        Math.max(Math.abs(y-b.y)-b.hh,0)) > p.radius+.15);
                    if(clear) cells.push({x,y,d:Math.hypot(x-w.width/2,y-w.height/2)});
                }
                cells.sort((a,b)=>a.d-b.d); if(!cells.length) throw Error('No safe fixture position');
                p.x=cells[0].x; p.y=cells[0].y; p.iframes=1e9; p.hp=p.maxHp;
                const enemies=w.enemies.filter(e=>!e.dead);
                enemies.forEach(e=>{e.hp=1e8;e.maxHp=1e8;});
                return {card:p.card.id,room:w.roomId,width:w.width,height:w.height,
                    player:{x:p.x,y:p.y}, enemies:enemies.map(e=>({id:e.id,enemyId:e.enemyId,model:e.model,ai:e.aiType}))};
            }""")
            check('测量场景保留真实生成敌人', bool(report['staged']['enemies']), report['staged'])
            page.bring_to_front()
            point = page.evaluate("""() => {const k=kirafanRL,w=k.world,r=k.renderer.domElement.getBoundingClientRect();
                const p=k.camera.position.clone().set(w.player.x+4,1,w.player.y).project(k.camera);
                return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};}""")
            page.mouse.move(point['x'], point['y'])
            page.keyboard.down('j')
            page.wait_for_timeout(5000)
            page.wait_for_function(READY, timeout=30000)
            if overrides:
                check('三份旧渲染快照均真实进入浏览器模块加载路径',
                      set(report['overrides_served']) == set(overrides), report['overrides_served'])
            report['environment'] = page.evaluate("""() => {
                const k=kirafanRL, gl=k.renderer.getContext(), info=gl.getExtension('WEBGL_debug_renderer_info');
                return {userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,
                    renderPixelRatio:k.renderer.getPixelRatio(),canvas:[gl.drawingBufferWidth,gl.drawingBufferHeight],
                    renderer:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
                    vendor:info?gl.getParameter(info.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),
                    rafSource:String(requestAnimationFrame),nativeRAF:String(requestAnimationFrame).includes('[native code]'),
                    visibility:document.visibilityState,focus:document.hasFocus()};}""")
            report['environment'].update({'browser': browser.version, 'os': platform.platform()})
            if args.quality:
                # Viewport dpr is 1, so the tier formulas reduce to fixed ratios.
                expected = {'high': '2', 'balanced': '1.5', 'performance': '1'}[args.quality]
                applied = page.evaluate("() => ({level:kirafanRL.quality.level,"
                    "ratio:String(kirafanRL.renderer.getPixelRatio())})")
                check('画质档位在测量会话内真实生效',
                      applied == {'level': args.quality, 'ratio': expected}, applied)
            check('保留原生rAF且页面可见有焦点', report['environment']['nativeRAF']
                  and report['environment']['visibility'] == 'visible' and report['environment']['focus'])
            page.screenshot(path=str(target / 'before.png'))
            session = context.new_cdp_session(page)
            session.send('Performance.enable')
            before = metrics(session)
            print('MEASURE native rAF %gs' % args.seconds, flush=True)
            sample = page.evaluate(SAMPLE, args.seconds * 1000)
            after = metrics(session)
            report['sample'] = sample
            report['intervalMs'] = summarize(sample['intervals'])
            report['performanceDelta'] = {name: after[name]-before[name] for name in
                ['LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration','TaskDuration','ScriptDuration']
                if name in before and name in after}
            report['heap'] = {name: [before.get(name),after.get(name)] for name in ['JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents']}
            check('完整有界自然采样，无后台或冻结帧', sample['complete'] and not sample['hidden']
                  and not sample['unfocused'] and not sample['frozen'],
                  {key:sample[key] for key in ['complete','hidden','unfocused','frozen','elapsed']})
            check('采样期间真实战斗持续推进且弹池不越界', not sample['noEnemies']
                  and sample['endWorld']-sample['startWorld'] >= args.seconds*.75
                  and sample['endSwing']-sample['startSwing'] >= max(2,args.seconds/5)
                  and sample['maxBullets'] <= sample['capacity'])
            report['referenceBudget'] = {'secondsRequired':60, 'p95MsTarget':20,
                'durationQualified': args.seconds >= 60, 'p95WithinTarget': report['intervalMs']['p95'] <= 20,
                'hardwareCertification':False,
                'limit':'This is the recorded Windows browser renderer, not a mid-tier iGPU or real phone.'}
            print('INTERVAL ' + json.dumps(report['intervalMs']), flush=True)
            print('LAYOUT ' + json.dumps(report['performanceDelta']), flush=True)
            page.screenshot(path=str(target / 'after.png'))
            if args.profile_seconds:
                session.send('Profiler.enable')
                session.send('Profiler.setSamplingInterval', {'interval':1000})
                session.send('Profiler.start')
                page.wait_for_timeout(args.profile_seconds * 1000)
                profile = session.send('Profiler.stop')['profile']
                (target / 'cpu.cpuprofile').write_text(json.dumps(profile), encoding='utf8')
                report['cpu'] = cpu_summary(profile)
                session.send('Profiler.disable')
            if args.gl_seconds:
                print('DIAGNOSE WebGL lifecycle %gs (outside frame sample)' % args.gl_seconds, flush=True)
                report['webglDiagnostic'] = page.evaluate("""duration => new Promise(resolve => {
    const k=kirafanRL,gl=k.renderer.getContext(),methods=['createProgram','deleteProgram','linkProgram',
        'compileShader','getProgramInfoLog','getShaderInfoLog','texImage2D','texSubImage2D'];
    const originals=new Map(), totals={}, events=[],programs=new Map(),ids=new WeakMap();
    const started=performance.now(),previousStackLimit=Error.stackTraceLimit;
    Error.stackTraceLimit=30;let serial=0,overflow=false;
    function programId(program){if(!program)return null;if(!ids.has(program))ids.set(program,++serial);return ids.get(program);}
    function remember(){for(const p of k.renderer.info.programs||[]){const id=programId(p.program);
        if(!programs.has(id))programs.set(id,{id,cacheKey:p.cacheKey,name:p.name});}}
    remember();
    for(const name of methods){const original=gl[name]; originals.set(name,original);
        totals[name]={count:0,totalMs:0,maxMs:0};
        gl[name]=function(...args){const start=performance.now();let result;
            try{return result=original.apply(this,args);}
            finally {const ms=performance.now()-start,row=totals[name];row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms);
                if(name==='createProgram'||name==='deleteProgram'){remember();
                    if(events.length<512)events.push({kind:name,program:programId(name==='createProgram'?result:args[0]),
                        elapsed:performance.now()-started,ms,swing:k.world.player.swingId,sources:k.effects.stats.sources,
                        releaseStack:name==='deleteProgram'?new Error().stack:null});
                    else overflow=true;
                }
            }
        };
    }
    setTimeout(()=>{for(const [name,original] of originals)gl[name]=original;remember();Error.stackTraceLimit=previousStackLimit;
        resolve({elapsed:performance.now()-started,totals,events,programs:[...programs.values()],overflow});},duration);
})""", args.gl_seconds * 1000)
            page.keyboard.up('j')
            check('自然采样无未处理页面异常', not report['errors'], report['errors'])
            report['complete'] = True
            session.detach()
            context.close()
            browser.close()
    except Exception as error:
        report['failure'] = repr(error)
        raise
    finally:
        server.shutdown(); worker.join(timeout=5); server.server_close()
        report['source_after'] = fingerprints()
        names = set(report['source_before']) | set(report['source_after'])
        report['changed_during_run'] = sorted(name for name in names
            if report['source_before'].get(name) != report['source_after'].get(name))
        (target / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    if report['changed_during_run']:
        raise AssertionError('Product sources changed during measurement; not stable evidence')


if __name__ == '__main__':
    main()
