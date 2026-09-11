"""Real player/enemy mixers: continuous presentation, pause and death isolation."""
import argparse
import functools
import hashlib
import json
import threading
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_navigation_browser import SETUP

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/motion'
FILES = ['site/game/rl/view/actorview.js', 'site/game/rl/view/enemyview.js', 'site/core/actor.js']

PLAYER = """()=>{
    const a=nav, rows=[],check=(name,ok,detail)=>rows.push({name,ok:!!ok,detail});
    a.unit.sm.state='idle';a.unit.facing=0;a.view.sync(1);
    a.unit.sm.state='move';a.view.sync(1/120);
    const first=a.actor.object.rotation.z;
    check('跑步起步倾斜缓动，不一步跳到8度',first<0&&Math.abs(first)<.08,first);
    const held=first;a.view.sync(0);
    check('暂停帧不推进倾斜',a.actor.object.rotation.z===held);
    const samples=[];
    for(const fps of [30,60,120]){
        a.unit.sm.state='idle';a.view.sync(2);a.unit.sm.state='move';a.unit.facing=0;
        for(let i=0;i<fps/5;i++)a.view.sync(1/fps);
        samples.push(a.actor.object.rotation.z);
    }
    check('30/60/120帧的相同跑步时间倾斜一致',Math.max(...samples)-Math.min(...samples)<1e-6,samples);
    const before=a.actor.object.rotation.z;a.unit.facing=Math.PI;a.view.sync(1/120);
    check('左右转向不会直接跳变正负倾斜',Math.abs(a.actor.object.rotation.z-before)<.06);
    const state=JSON.stringify(a.unit);for(let i=0;i<20;i++)a.view.sync(1/120);
    check('表现层不改世界位置、朝向、状态或时钟',JSON.stringify(a.unit)===state);
    a.unit.dead=true;a.unit.sm.state='dead';a.view.sync(0);
    check('死亡不继承跑步额外倾斜',a.actor.object.rotation.z===0);
    return rows;
}"""

ENEMY = """async()=>{
    const a=nav,{attachEnemyView}=await import('/site/game/rl/view/enemyview.js'),rows=[];
    const check=(name,ok,detail)=>rows.push({name,ok:!!ok,detail});
    const unit={model:'model/enemy/model_en_1000.muast',x:16,y:12,radius:.5,facing:0,dead:false,
        sm:{state:'idle',stateTime:0},pending:null};
    const view=await attachEnemyView(unit,a.stage.scene);
    const active=()=>view.mixer._actions.filter(action=>action.isScheduled()).map(action=>
        ({name:action.getClip().name,weight:action.getEffectiveWeight(),time:action.time}));
    unit.sm.state='telegraph';unit.sm.stateTime=.2;unit.pending={pattern:'aimed'};view.sync(1/120,200);
    let actions=active();check('敌人待机与蓄力短交叉淡化而非硬切',actions.length===2
        &&actions.every(action=>action.weight>0&&action.weight<1),actions);
    view.sync(.12,320);actions=active();
    check('淡化结束只剩一个动作，不长期累计权重',actions.length===1&&Math.abs(actions[0].weight-1)<1e-8,actions);
    unit.sm.state='skill';unit.sm.stateTime=.01;unit.pending=null;view.sync(1/120,330);
    actions=active();check('蓄力转出招同样平滑衔接',actions.length===2&&actions.every(action=>action.weight>0),actions);
    const paused=JSON.stringify(active());view.sync(0,330);
    check('暂停不推进敌人动作与淡化',paused===JSON.stringify(active()));
    let bounded=true;
    for(let i=0;i<12;i++){
        unit.sm.state=i%2?'skill':'telegraph';unit.sm.stateTime=.01;view.sync(1/120,330+i*1000/120);
        const playing=active();bounded&&=playing.length<=2&&playing.every(row=>row.weight>=0&&row.weight<=1);
    }
    check('快速反复切换不累计旧动画或超出有效权重',bounded,active());
    unit.sm.state='dead';unit.dead=true;unit.sm.stateTime=0;view.sync(1/120,340);actions=active();
    check('淡化途中死亡立即移除旧待机和技能，只播放死亡',actions.length===1&&actions[0].name==='dead'
        &&actions[0].weight===1,actions);
    for(let i=0;i<120;i++)view.sync(1/120,350+i*1000/120);
    check('死亡退场保持终态，不重新播放待机',!view.object.visible&&active().length===0);
    view.dispose();
    const staticUnit={...unit,model:'model/enemy/model_en_12001.muast',dead:false,sm:{state:'idle',stateTime:0}};
    const staticView=await attachEnemyView(staticUnit,a.stage.scene),base=staticView.object.scale.y;
    staticUnit.sm.state='telegraph';
    for(let i=1;i<=84;i++){staticUnit.sm.stateTime=i/120;staticView.sync(1/120,i*1000/120);}
    const charged=staticView.object.scale.y/base;
    staticUnit.sm.state='skill';staticUnit.sm.stateTime=0;staticView.sync(1/120,700);
    const released=staticView.object.scale.y/base;
    check('静态敌人蓄力结束没有1.16到0.90的突变',charged>1.1&&charged-released<.075&&charged>released,{charged,released});
    const size=staticView.object.scale.y;staticView.sync(0,700);
    check('静态敌人暂停保持蓄力缩放',staticView.object.scale.y===size);
    staticView.dispose();return rows;
}"""


def fingerprint():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--label', default='current'); args = parser.parse_args()
    target = OUT / args.label; target.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'before': fingerprint()}
    with Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT))) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
                page = browser.new_page(viewport={'width': 960, 'height': 640})
                page.on('pageerror', lambda e: report['errors'].append(str(e)))
                page.route('**/motion-check', lambda r: r.fulfill(content_type='text/html', body='<body style="margin:0"></body>'))
                base = 'http://127.0.0.1:%d' % server.server_address[1]
                page.goto(base + '/motion-check'); page.add_script_tag(url=base + '/site/asset/gacha/cards.js'); page.evaluate(SETUP)
                report['checks'].extend(page.evaluate(PLAYER)); report['checks'].extend(page.evaluate(ENEMY))
                for row in report['checks']:
                    print(('PASS ' if row['ok'] else 'FAIL ') + row['name'], flush=True)
                page.evaluate("""async()=>{const a=nav;
                    a.map=a.maps.createMapView(a.stage.scene,1);
                    await a.map.buildRoom({id:1,type:'battle',seed:28101},undefined,['N','E'],{strict:true});
                    a.unit.dead=false;a.unit.sm.state='idle';a.unit.x=15;a.unit.y=12;a.view.sync(1);
                    a.follow.snap(16,12);a.stage.applyVolume(a.maps.volumeConfig(1));
                    a.filmUnit={model:'model/enemy/model_en_1000.muast',x:17,y:12,radius:.5,facing:Math.PI,
                        dead:false,sm:{state:'idle',stateTime:0},pending:{pattern:'aimed'}};
                    a.filmView=await (await import('/site/game/rl/view/enemyview.js')).attachEnemyView(a.filmUnit,a.stage.scene);
                    const label=document.createElement('div');label.id='motion-label';
                    label.style.cssText='position:fixed;left:20px;top:16px;padding:6px 10px;background:#fff8e9;color:#594c40;font:16px sans-serif';
                    document.body.appendChild(label);}""")
                sheet = Image.new('RGB', (1920, 640))
                for index, phase in enumerate(['待机', '开始跑步 / 蓄力', '继续蓄力', '开始出招', '出招衔接', '转向', '恢复', '死亡']):
                    page.evaluate("""({index,phase})=>{const a=nav,u=a.filmUnit;
                        if(index===1){a.unit.sm.state='move';a.unit.facing=0;u.sm.state='telegraph';u.sm.stateTime=.05;}
                        if(index===2)u.sm.stateTime=.65;
                        if(index===3){u.sm.state='skill';u.sm.stateTime=.01;u.pending=null;}
                        if(index===5)a.unit.facing=Math.PI;
                        if(index===6){u.sm.state='recover';a.unit.sm.state='idle';}
                        if(index===7){u.sm.state='dead';u.dead=true;}
                        const dt=index===2?.5:.025;
                        a.view.sync(dt);a.filmView.sync(dt,index*100);a.map.update(dt);
                        document.getElementById('motion-label').textContent=phase;
                        a.stage.render(a.camera,a.actor.object);}""", {'index': index, 'phase': phase})
                    shot = target / ('frame-%d.png' % index); page.screenshot(path=str(shot))
                    with Image.open(shot) as image:
                        sheet.paste(image.resize((480, 320)), ((index % 4) * 480, (index // 4) * 320))
                sheet.save(target / 'contact.png')
                browser.close()
        except Exception as error:
            report['failure'] = repr(error); raise
        finally:
            report['after'] = fingerprint()
            report['changed_during_run'] = [n for n in report['before'] if report['before'][n] != report['after'][n]]
            (target / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            server.shutdown()
    if report['errors'] or any(not row['ok'] for row in report['checks']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
