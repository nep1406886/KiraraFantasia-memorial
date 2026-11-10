"""Render real WebAudio cues and exercise HTMLAudio transitions in Edge.

The offline context runs the production recipes, not a copy of their node counts.
Outputs measure audibility, peak headroom, bounded concurrency and graph release.
"""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import ready

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/adventure-audio'

RENDER = r"""async ({cues,index,mode}) => {
    const ctx = new OfflineAudioContext(1, 44100 * 3, 44100);
    const counts = {sources:0,buffers:0,released:0};
    for (const name of ['createOscillator','createBufferSource']) {
        const original=ctx[name].bind(ctx);
        ctx[name]=()=>{const node=original(),disconnect=node.disconnect.bind(node);counts.sources++;
            let released=false;node.disconnect=()=>{if(!released){counts.released++;released=true;}disconnect();};return node;};
    }
    const buffer=ctx.createBuffer.bind(ctx);
    ctx.createBuffer=(...args)=>{counts.buffers++;return buffer(...args);};
    ctx.resume=()=>Promise.resolve();
    window.AudioContext=function(){return ctx;};
    const audio=await import('/site/core/audio.js?offline='+index);
    audio.unlock();audio.setSeVolume(1);
    if(mode==='paused')audio.suspendSe(true);
    if(mode==='muted')audio.setSeVolume(0);
    for(const cue of cues)audio.se(cue);
    if(mode==='stop')audio.suspendSe(true);
    const result=await ctx.startRendering(),samples=result.getChannelData(0);
    let peak=0,energy=0,nonzero=0,crossings=0;
    for(let i=0;i<samples.length;i++){const value=samples[i];peak=Math.max(peak,Math.abs(value));
        energy+=value*value;if(Math.abs(value)>.0001)nonzero++;
        if(i&&value*samples[i-1]<0)crossings++;}
    await new Promise(resolve=>setTimeout(resolve,0));
    return {...counts,peak,rms:Math.sqrt(energy/samples.length),nonzero,crossings};
}"""

MUSIC = r"""async () => {
    const {MusicBus}=await import('/site/core/music.js');
    const errors=[],bus=new MusicBus(track=>'/site/audio/bgm/'+track+'.mp3',e=>errors.push(e.message));
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    bus.setVolume(.4);await bus.play('bgm_town_1_0',{fade:0});await wait(120);
    const first=bus.audio,started=!first.paused&&first.currentTime>0&&first.readyState>=2;
    await bus.play('bgm_battle_1_0',{fade:300});await wait(120);
    const crossfade=!first.paused&&!bus.audio.paused&&first.volume>0&&bus.audio.volume>0;
    await wait(250);const retired=first.paused&&bus.outgoing===null;
    bus.suspend(true);const time=bus.audio.currentTime;await wait(100);
    const paused=bus.audio.paused&&Math.abs(bus.audio.currentTime-time)<.01;
    await bus.play('bgm_battle_2_0');const silentSelection=bus.audio.paused;
    bus.suspend(false);await wait(500);const resumed=!bus.audio.paused&&bus.audio.currentTime>0;
    bus.setVolume(.4,.4);await wait(260);const ducked=Math.abs(bus.audio.volume-.16)<.01;
    bus.setVolume(0);await wait(260);const muted=bus.audio.volume===0;
    for(const track of ['bgm_town_2_0','bgm_town_3_0','bgm_town_4_0'])bus.preload(track);
    const bounded=bus.cache.size<=3,all=[...bus.cache.values()];
    bus.dispose();bus.dispose();const released=all.every(a=>a.paused&&!a.getAttribute('src'))&&bus.timer===null;
    return {started,crossfade,retired,paused,silentSelection,resumed,ducked,muted,bounded,released,errors};
}"""

EVENT = r"""async kind => {
    const a=await import('/site/core/audio.js'),k=kirafanRL,p=k.world.player;
    a.unlock();a.setSeVolume(1);
    const events={
        dodge:{type:'dodge',unit:p},pickup:{type:'pickup',items:[{}],drop:null,x:0,y:0},
        levelup:{type:'levelup',unit:p,level:2,healed:3},roomClear:{type:'roomClear'},
        crit:{type:'hit',damage:7,crit:true,target:{kind:'enemy',x:0,y:0},attacker:{kind:'player',element:0}},
        guard:{type:'hit',damage:4,hitFlag:-1,target:{kind:'enemy',x:0,y:0},attacker:{kind:'player',element:0}},
        defeat:{type:'hit',damage:999,died:true,target:p,attacker:{kind:'enemy'}}};
    const before=window.audioSources;k.world.events.push(events[kind]);k.step(1/60);
    return window.audioSources-before;
}"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'cues': {}}

    def check(name, ok):
        report['checks'].append({'name': name, 'ok': bool(ok)})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)

    with Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT))) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(channel='msedge', args=['--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader'])
                page = browser.new_page()
                page.on('pageerror', lambda error: report['errors'].append(str(error)))
                page.route('**/audio-audit.html', lambda route: route.fulfill(content_type='text/html', body='<title>声音验收</title>'))
                page.goto(f'http://127.0.0.1:{server.server_address[1]}/audio-audit.html')
                cues = page.evaluate("async()=> (await import('/site/core/audio.js')).SE_CUES")
                for index, cue in enumerate(cues):
                    row = page.evaluate(RENDER, {'cues': [cue], 'index': index, 'mode': 'normal'})
                    report['cues'][cue] = row
                    check(cue + ' 可闻、有峰值余量、播放后释放', row['rms'] > .0001 and .001 < row['peak'] < .98
                          and row['sources'] == row['released'])
                for mode in ['paused', 'muted', 'stop']:
                    row = page.evaluate(RENDER, {'cues': cues, 'index': mode, 'mode': mode})
                    report[mode] = row
                    check(mode + ' 不产生残留声音', row['peak'] == 0 and row['sources'] == row['released'])
                stress = page.evaluate(RENDER, {'cues': cues * 5, 'index': 'stress', 'mode': 'normal'})
                report['stress'] = stress
                check('密集声音限制48个声源并复用一个噪声缓冲', 0 < stress['sources'] <= 48 and stress['buffers'] == 1)
                check('密集声音无削波且所有声源断开', stress['peak'] < .98 and stress['released'] == stress['sources'])
                signatures = {(round(row['rms'], 5), row['crossings']) for row in report['cues'].values()}
                check('各提示音具有不同波形', len(signatures) == len(cues))
                report['music'] = page.evaluate(MUSIC)
                for key, value in report['music'].items():
                    if key != 'errors': check('实际原曲播放：' + key, value)
                check('原曲无播放失败', not report['music']['errors'])
                game=browser.new_page(viewport={'width':1280,'height':840})
                game.on('pageerror',lambda error:report['errors'].append(str(error)))
                game.add_init_script('''window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
                    localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));
                    window.audioSources=0;
                    class LoggedAudio extends AudioContext {
                        createOscillator(){window.audioSources++;return super.createOscillator();}
                        createBufferSource(){window.audioSources++;return super.createBufferSource();}
                    }window.AudioContext=LoggedAudio;''')
                game.goto(f'http://127.0.0.1:{server.server_address[1]}/site/game/roguelike.html?seed=14')
                game.locator('#roster-start').click(timeout=60000);ready(game)
                game.wait_for_function('()=>!kirafanRL.world.frozen',polling=100,timeout=20000)
                game.locator('.hud-pause').click()
                muted=game.evaluate('''async()=>{const a=await import('/site/core/audio.js');
                    a.unlock();a.setSeVolume(1);const before=audioSources;a.se('hit');return before===audioSources;}''')
                check('实际暂停菜单阻止战斗音效',muted)
                game.locator('#menu-resume').click()
                for cue in ['dodge','pickup','levelup','roomClear','crit','guard','defeat']:
                    game.wait_for_timeout(80)
                    check('真实事件管线触发声音：'+cue,game.evaluate(EVENT,cue)>0)
                browser.close()
        except Exception as error:
            report['errors'].append(repr(error))
            print('ERROR ' + repr(error), flush=True)
        finally:
            server.shutdown(); worker.join(timeout=5)
    check('声音浏览器无脚本异常', not report['errors'])
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return int(any(not row['ok'] for row in report['checks']))


if __name__ == '__main__':
    raise SystemExit(main())
