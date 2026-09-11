"""Browser regression for model rig binding, visible pixels, and responsive controls.

Serve with python -m http.server 8643, then run:
python tools/check_models_viewer.py --url http://localhost:8643
Only the external catalog/thumbnail service is stubbed; GLBs, clips, and facial tables
are the published local assets. Screenshots and results go to .codex-tmp/model-viewer.
"""
import argparse
import base64
import io
import json
import re
from pathlib import Path
from urllib.parse import quote

from PIL import Image
from playwright.sync_api import sync_playwright

from check_faces import PROBE as FACE_PROBE, check as check_face

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/model-viewer'
MODELS = ['model_pl_400002', 'model_pl_180107', 'model_pl_400101',
          'model_pl_100002', 'model_pl_100102', 'model_pl_130008', 'model_pl_140106',
          'model_en_1000', 'model_en_7000', 'model_en_13703', 'model_en_10001',
          'wpn_1300', 'wpn_21101', 'wpn_3103200', 'wpn_3800200']

BONES = """() => {
  const bones = new Set();
  window.__modelDebug.traverse(n => {
    if (n.isSkinnedMesh) n.skeleton.bones.forEach(b => bones.add(b));
  });
  return [...bones].filter(b => /^(Arm_[LR]|Fore_arm_[LR]|Hips|Spine)/.test(b.name))
    .flatMap(b => b.position.toArray().concat(b.quaternion.toArray()));
}"""


def boot(page, base, model):
    kind = 'weapon' if model.startswith('wpn_') else 'enemy' if model.startswith('model_en_') else 'player'
    path = f'model/{kind}/{model}.muast'
    page.goto(f'{base}/site/models.html?debug=1&case={model}#{quote(path)}', wait_until='domcontentloaded')
    page.wait_for_function("id => window.__modelDebugFile?.includes('/' + id + '/') && document.querySelector('#model3dCanvas.is-ready')", arg=model, timeout=60000)
    page.wait_for_timeout(300)


def freeze(page, clip, time):
    return page.evaluate("([clip, time]) => { const r = window.__visDebug(clip, time, []); window.__rendererDebug.render(); return r; }", [clip, time])


def pixels(page, filename):
    data = page.evaluate('window.__rendererDebug.grab()')
    image = Image.open(io.BytesIO(base64.b64decode(data['data'].split(',')[1]))).convert('RGBA')
    alpha = image.getchannel('A').point(lambda value: 255 if value > 20 else 0)
    bbox = alpha.getbbox()
    assert bbox, 'Canvas is blank'
    count = sum(alpha.histogram()[1:])
    assert count > 100, f'Only {count} visible pixels'
    image.save(OUT / filename)
    return {'size': image.size, 'bounds': bbox, 'pixels': count}


def layout(page):
    result = page.evaluate("""() => {
      const stage = document.querySelector('.model-viewer-stage').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.model-transport button, .model-transport input')];
      return {
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        clipped: buttons.filter(n => { const r = n.getBoundingClientRect();
          return r.width && (r.left < stage.left - 1 || r.right > stage.right + 1 || r.bottom > stage.bottom + 1);
        }).map(n => n.id || n.outerHTML),
        brokenIcons: [...document.querySelectorAll('img.model-icon')].filter(n => !n.complete || !n.naturalWidth).map(n => n.src)
      };
    }""")
    assert result['scrollWidth'] <= result['width'], result
    assert not result['clipped'], result
    assert not result['brokenIcons'], result
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://localhost:8643')
    parser.add_argument('models', nargs='*')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / 'site/asset/models/manifest.json').read_text(encoding='utf8'))
    catalog = [{'name': key, 'path': 'bucket-a', 'size': 1} for key in manifest['models']]
    reports = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            context = browser.new_context(viewport={'width': 1440, 'height': 960})
            context.route('https://database.kirafan.cn/assetBundle.json', lambda route: route.fulfill(json=catalog))
            context.route(re.compile(r'https://bucket-.*-asset\.kirafan\.cn/.*/index\.json'), lambda route: route.fulfill(status=503, body='offline fixture'))
            context.route(re.compile(r'https://asset\.kirafan\.cn/.*'), lambda route: route.fulfill(path=str(ROOT / 'favicon.png'), content_type='image/png'))
            page = context.new_page()
            page.add_init_script("""const raf = window.requestAnimationFrame;
                window.__rafTicks = 0;
                window.requestAnimationFrame = callback => raf.call(window, time => {
                    window.__rafTicks++; callback(time);
                });""")
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            for model in args.models or MODELS:
                boot(page, args.url, model)
                clips = page.evaluate('window.__rendererDebug.clipInfo()')
                actions = []
                for clip in clips:
                    freeze(page, clip['name'], clip['duration'] * 0.1)
                    before = page.evaluate(BONES)
                    freeze(page, clip['name'], clip['duration'] * 0.65)
                    after = page.evaluate(BONES)
                    delta = max((abs(a - b) for a, b in zip(before, after)), default=0)
                    if model.startswith('model_pl_'):
                        assert delta > 1e-5, (model, clip['name'], 'skinned body did not move')
                    actions.append({'name': clip['name'], 'bodyDelta': round(delta, 6)})
                if clips:
                    freeze(page, 'idle' if any(c['name'] == 'idle' for c in clips) else clips[0]['name'], 0.2)
                page.locator('#modelViewReset').click()
                if page.locator('#modelMotionToggle').count():
                    page.locator('#modelMotionToggle').click()
                face = page.evaluate(FACE_PROBE)
                assert not check_face(face), (model, check_face(face))
                visual = pixels(page, model + '.png')
                reports.append({'model': model, 'actions': actions, 'visual': visual, 'layout': layout(page)})
                assert not errors, errors
                print(f'PASS {model}: {len(actions)} clips, {visual["pixels"]} pixels', flush=True)

            boot(page, args.url, 'model_pl_400002')
            for width, height in [(1440, 960), (1216, 836), (1024, 768), (768, 1024), (390, 844), (320, 568)]:
                page.set_viewport_size({'width': width, 'height': height})
                page.evaluate("localStorage.removeItem('kirafan.models.listCollapsed')")
                page.reload(wait_until='domcontentloaded')
                page.wait_for_selector('#model3dCanvas.is-ready', timeout=60000)
                page.wait_for_timeout(150)
                layout(page)
                page.screenshot(path=str(OUT / f'layout-{width}.png'))
                pixels(page, f'canvas-{width}.png')
                page.locator('#modelsListCollapse').click()
                page.wait_for_timeout(100)
                layout(page)
                if width > 900:
                    page.locator('#modelsListRail').click()
                else:
                    page.locator('#modelsListCollapse').click()
                page.locator('[data-detail-tab=assets]').click()
                assert not page.locator('#modelViewPanelStage').is_visible()
                page.locator('[data-detail-tab=stage]').click()
                page.locator('[data-inspector-tab=setup]').click()
                assert not page.locator('#modelPanelAction').is_visible()
                page.locator('[data-inspector-tab=action]').click()
                assert not page.locator('#modelPanelSetup').is_visible()
                print(f'PASS layout {width}x{height}', flush=True)

            page.set_viewport_size({'width': 1440, 'height': 960})
            page.evaluate("localStorage.removeItem('kirafan.models.listCollapsed')")
            # A same-URL navigation with a fragment can keep the old document.
            # Start a fresh document so the download count has a cold baseline.
            page.goto('about:blank')
            requests = []
            page.on('request', lambda request: requests.append(request.url))
            boot(page, args.url, 'model_pl_400002')
            for model in ['model_pl_100002', 'model_pl_400002']:
                page.locator('#modelSearch').fill(model)
                page.locator('.model-list-item').filter(has_text=model).click()
                page.wait_for_function("id => window.__modelDebugFile?.includes('/' + id + '/') && document.querySelector('#model3dCanvas.is-ready')", arg=model)
            downloads = [url for url in requests if '/model_pl_400002/model.glb' in url]
            assert len(downloads) == 1, downloads
            print('PASS cache: reopening model uses one GLB download', flush=True)

            page.locator('[data-detail-tab=assets]').click()
            page.wait_for_timeout(200)
            ticks = page.evaluate('window.__rafTicks')
            page.wait_for_timeout(400)
            assert page.evaluate('window.__rafTicks') == ticks, 'Hidden canvas is still scheduling frames'
            page.locator('[data-detail-tab=stage]').click()
            page.wait_for_function('before => window.__rafTicks > before', arg=ticks)
            pixels(page, 'resumed.png')
            print('PASS performance: hidden canvas stops frames and resumes', flush=True)
            assert not errors, errors
        finally:
            browser.close()
    (OUT / 'report.json').write_text(json.dumps(reports, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()
