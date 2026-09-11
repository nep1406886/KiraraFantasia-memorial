"""Exercise the public actor API with published GLBs in a real browser.

Run: python tools/check_actor_api.py --url http://localhost:8643
The harness serves only its empty HTML page; model requests use the site server.
"""
import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/actor-api'

PROBE = r"""async base => {
    const { create } = await import(base + '/site/core/actor.js');
    const loader = await import(base + '/site/core/loader.js');
    const { THREE } = await loader.loadModules();
    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
    const pose = actor => {
        const bones = new Set();
        actor.object.traverse(node => {
            if (node.isSkinnedMesh) node.skeleton.bones.forEach(b => bones.add(b));
        });
        return [...bones].filter(b => /^(Arm_[LR]|Fore_arm_[LR]|Hips|Spine)/.test(b.name))
            .flatMap(b => b.position.toArray().concat(b.quaternion.toArray()));
    };
    const moving = (actor, name) => {
        if (!actor.play(name, { fade: 0 })) return 0;
        actor.update(0.1);
        const before = pose(actor);
        actor.update(0.35);
        const after = pose(actor);
        return Math.max(0, ...before.map((v, i) => Math.abs(v - after[i])));
    };
    const actor = await create({ resourceId: 400002, classId: 3, headId: 3, weapon: 'none' });
    try {
        for (const name of ['idle', 'attack', 'class_skill_1', 'battle_run']) {
            const delta = moving(actor, name);
            check('body:' + name, delta > 1e-5, delta);
        }
        const meshes = new Set();
        const rigs = new Set();
        const rigOf = node => {
            for (let current = node; current; current = current.parent) {
                if ((current.userData.name || current.name) === 'root') return current;
            }
        };
        actor.object.traverse(n => {
            if (n.isMesh) meshes.add(n);
            if (n.isSkinnedMesh) n.skeleton.bones.forEach(b => { if (rigOf(b)) rigs.add(rigOf(b)); });
        });
        await actor.equip('default');
        const weapons = [];
        actor.object.traverse(n => { if (n.isMesh && !meshes.has(n)) weapons.push(n); });
        check('weapon uses the visible rig', weapons.length > 0 && weapons.every(n => rigs.has(rigOf(n))), weapons.length);
        await actor.equip('none');
        const manifest = await loader.loadManifest();
        const pack = manifest.classActions['3:3'];
        const names = await actor.loadActions(base + '/' + pack.file, {
            compression: pack.compression, meshopt: pack.meshopt,
            names: pack.animations.map((_, i) => 'custom_' + i)
        });
        check('custom bundle', names.length === pack.animations.length, names);
        check('custom body motion', moving(actor, names[0]) > 1e-5);

        const bone = (() => {
            let result;
            actor.object.traverse(n => {
                if (!result && n.isSkinnedMesh) result = n.skeleton.bones.find(b => /^Arm_L/.test(b.name));
            });
            return result;
        })();
        const clip = new THREE.AnimationClip('shared-input', 1, [
            new THREE.NumberKeyframeTrack(bone.uuid + '.position[x]', [0, 1], [0, 0.25])
        ]);
        check('register direct', actor.registerAction('direct', clip));
        check('caller owns input clip', clip.name === 'shared-input', clip.name);
        check('duplicate rejected', !actor.registerAction('direct', clip));
        actor.play('direct', { fade: 0 });
        actor.update(0.2);
        check('remove current', actor.removeAction('direct') && !actor.play('direct') && actor.action === '');
        const x = bone.position.x;
        actor.update(0.2);
        check('removed action stopped', bone.position.x === x, [x, bone.position.x]);
        actor.registerAction('replace', clip);
        actor.play('replace', { fade: 0 });
        actor.update(0.2);
        actor.registerAction('replace', clip, { replace: true });
        check('replacement stops old playback', actor.mixer.stats.actions.inUse === 0);

        check('face alias registered', actor.registerFace('talking', 'happy'));
        check('face alias applies', actor.face('talking'));
        const faceIndex = actor.faceIndex;
        actor.update(0.2);
        check('manual face stays pinned', actor.faceIndex === faceIndex);
        check('invalid face state rejected', !actor.registerFace('invalid', 99999));
        check('face alias removed', actor.removeFace('talking') && !actor.removeFace('talking'));
        check('automatic face restored', actor.faceAuto());

        const disposals = { geometry: 0, material: 0, texture: 0, skeleton: 0 };
        const resources = new Map(Object.keys(disposals).map(k => [k, new Set()]));
        const skeletons = new Set();
        actor.object.traverse(n => {
            if (n.geometry) resources.get('geometry').add(n.geometry);
            if (n.skeleton && !skeletons.has(n.skeleton)) {
                skeletons.add(n.skeleton);
                n.skeleton.computeBoneTexture();
                resources.get('skeleton').add(n.skeleton.boneTexture);
            }
            for (const material of n.material ? [].concat(n.material) : []) {
                resources.get('material').add(material);
                Object.values(material).filter(v => v?.isTexture).forEach(t => resources.get('texture').add(t));
            }
        });
        for (const [kind, values] of resources) {
            values.forEach(value => value.addEventListener('dispose', () => disposals[kind]++));
        }
        const pending = actor.loadActions(base + '/' + pack.file, {
            compression: pack.compression, meshopt: pack.meshopt,
            names: pack.animations.map((_, i) => 'late_' + i)
        });
        actor.dispose();
        const lateNames = await pending;
        check('no actions after disposal', lateNames.length === 0 && actor.actionNames.length === 0, lateNames);
        check('disposed actor rejects playback', !actor.play('idle'));
        for (const [kind, values] of resources) {
            check('release:' + kind, disposals[kind] === values.size, [disposals[kind], values.size]);
        }
        const once = JSON.stringify(disposals);
        actor.dispose();
        check('dispose is idempotent', JSON.stringify(disposals) === once);
        check('mixer released', actor.mixer.stats.actions.total === 0 && actor.mixer.stats.bindings.total === 0,
            [actor.mixer.stats.actions.total, actor.mixer.stats.bindings.total]);
        const second = await create({ resourceId: 400002, classId: 3, headId: 3, weapon: 'none' });
        try {
            const third = await create({ resourceId: 400002, classId: 3, headId: 3, weapon: 'none' });
            try {
                const fresh = await second.loadWeaponActions(0);
                third.play('class_skill_1', { fade: 0 });
                third.update(0.27);
                const posed = await third.loadWeaponActions(0);
                const tracks = (unit, name) => {
                    unit.play(name, { fade: 0 });
                    const action = unit.mixer._actions.find(a => a.getClip().name === name);
                    return action.getClip().tracks.map(t => [...t.values]);
                };
                const freshTracks = tracks(second, fresh.attack), posedTracks = tracks(third, posed.attack);
                const delta = Math.max(...freshTracks.flatMap((values, i) =>
                    values.map((v, j) => Math.abs(v - posedTracks[i][j]))));
                check('weapon actions do not depend on async load pose', delta < 1e-6, delta);
            } finally { third.dispose(); }
            second.play('damage', { fade: 0 });
            const direct = second.mixer._actions.find(a => a.getClip().name === 'damage').getClip().clone();
            let named = 0;
            for (const track of direct.tracks) {
                const dot = track.name.lastIndexOf('.');
                const node = THREE.PropertyBinding.findNode(second.object, track.name.slice(0, dot));
                if (node && THREE.PropertyBinding.findNode(second.object, node.name) === node) {
                    track.name = node.name + track.name.slice(dot); named++;
                }
            }
            check('direct name-based fixture has tracks', named > 0, named);
            second.registerAction('named_damage', direct);
            second.play('named_damage', { fade: 0 });
            second.update(0.05);
            const bindings = new Map();
            for (const action of second.mixer._actions) for (const track of action.getClip().tracks) {
                const dot = track.name.lastIndexOf('.');
                const node = THREE.PropertyBinding.findNode(second.object, track.name.slice(0, dot));
                const key = node.uuid + track.name.slice(dot);
                if (!bindings.has(key)) bindings.set(key, new Set());
                bindings.get(key).add(track.name);
            }
            check('direct and donor tracks share one binding identity',
                [...bindings.values()].every(names => names.size === 1));
            check('cached model remains independently usable', moving(second, 'attack') > 1e-5);
        } finally { second.dispose(); }
    } finally {
        actor.dispose();
        loader.clearModelCache();
    }
    return results;
}"""

CACHE_PROBE = r"""async () => {
    const loader = await import(window.__actorBase + '/site/core/loader.js');
    const originalFetch = window.fetch;
    const requests = [];
    const results = [];
    const check = (name, ok) => results.push({ name, ok: Boolean(ok) });
    const response = (size = 20) => {
        const bytes = new Uint8Array(size);
        bytes.set([103, 108, 84, 70]);
        new DataView(bytes.buffer).setUint32(8, size, true);
        return new Response(bytes);
    };
    window.fetch = url => new Promise((resolve, reject) => requests.push({ url: String(url), resolve, reject }));
    const read = (name, progress) => loader.readModelCached('/__actor_cache__/' + name, undefined, progress);
    try {
        loader.clearModelCache();
        const first = read('shared');
        const progress = [];
        const second = read('shared', value => progress.push(value));
        check('cache deduplicates concurrent requests', requests.length === 1);
        check('pending cache hit does not report completion', !progress.includes(1));
        requests.at(-1).resolve(response());
        const blobs = await Promise.all([first, second]);
        check('cache shares immutable bytes', blobs[0] === blobs[1] && progress.at(-1) === 1);

        loader.clearModelCache();
        const stale = read('retry').catch(() => null);
        const staleRequest = requests.at(-1);
        loader.clearModelCache();
        const replacement = read('retry');
        const replacementRequest = requests.at(-1);
        staleRequest.reject(new Error('expected failure'));
        await stale;
        const count = requests.length;
        const joined = read('retry');
        check('old failure cannot evict a newer request', requests.length === count);
        replacementRequest.resolve(response());
        await Promise.all([replacement, joined]);

        loader.clearModelCache();
        for (let i = 0; i < 13; i++) {
            const pending = read('lru-' + i);
            requests.at(-1).resolve(response());
            await pending;
        }
        const beforeEviction = requests.length;
        const again = read('lru-0');
        check('cache evicts beyond 12 entries', requests.length === beforeEviction + 1);
        requests.at(-1).resolve(response());
        await again;

        loader.clearModelCache();
        for (const name of ['large-a', 'large-b']) {
            const pending = read(name);
            requests.at(-1).resolve(response(17 * 1024 * 1024));
            await pending;
        }
        const beforeBytes = requests.length;
        const evicted = read('large-a');
        check('cache also enforces a 32 MiB byte budget', requests.length === beforeBytes + 1);
        requests.at(-1).resolve(response());
        await evicted;
    } finally {
        window.fetch = originalFetch;
        loader.clearModelCache();
    }
    return results;
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://localhost:8643')
    parser.add_argument('--deep', action='store_true', help='Exercise a page two directories below the site root')
    parser.add_argument('--project-prefix', action='store_true', help='Simulate the /kirafan-timer/ GitHub Pages prefix')
    args = parser.parse_args()
    base = args.url.rstrip('/')
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            page = browser.new_page()
            if args.project_prefix:
                prefix = base + '/kirafan-timer'
                page.route(prefix + '/**', lambda route: route.fulfill(response=route.fetch(
                    url=args.url.rstrip('/') + route.request.url[len(prefix):])))
                base = prefix
            errors = []
            requests = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: requests.append(request.url))
            page.route('**/actor-api.html', lambda route: route.fulfill(
                content_type='text/html', body='<!doctype html><meta charset="utf-8"><title>Actor API test</title>'))
            path = '/tools/deep/actor-api.html' if args.deep else '/tools/actor-api.html'
            page.goto(base + path)
            results = page.evaluate(PROBE, base)
            downloads = [url for url in requests if '/model_pl_400002/model.glb' in url]
            results.append({'name': 'model downloaded once for two actors', 'ok': len(downloads) == 1, 'detail': len(downloads)})
            page.evaluate('base => { window.__actorBase = base; }', base)
            results.extend(page.evaluate(CACHE_PROBE))
            for result in results:
                print(('PASS ' if result['ok'] else 'FAIL ') + result['name'] + ': ' + json.dumps(result.get('detail'), ensure_ascii=False), flush=True)
            (OUT / 'report.json').write_text(json.dumps(results, indent=2), encoding='utf8')
            assert not errors, errors
            assert all(r['ok'] for r in results), 'Actor API regression failed'
        finally:
            browser.close()


if __name__ == '__main__':
    main()
