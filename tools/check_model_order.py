"""Audit all published queue keys, then compare actual site/models.html draw order/pixels.

Run after starting tools/serve.mjs:
  python tools/check_model_order.py --url http://127.0.0.1:8643
  python tools/check_model_order.py --scan-only
The external catalog/thumbnails are stubbed; model/animation/face assets are real.
Queue collisions are candidates, NOT proof of a visible defect. Before/after PNGs,
per-frame changed-pixel counts and full inventory are retained for visual review.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter, defaultdict
import io
import json
from pathlib import Path
import re
from urllib.parse import quote

from audit_models import read_gltf_json

ROOT = Path(__file__).resolve().parents[1]
FACE = re.compile(r"^[LR]\d+_face$", re.I)
DIRECTION = re.compile(r"^(?:[LRT]\d+_|SIDE_)", re.I)
REGRESSION = ["model_pl_120000", "model_pl_100001", "model_pl_100003",
              "model_pl_130008", "model_pl_140000", "model_pl_140007",
              "model_pl_140106", "model_pl_180208", "model_pl_270102",
              "model_pl_320111", "model_pl_320801", "model_pl_400002",
              "model_en_1000", "model_en_7000", "model_en_10001", "model_en_13703",
              "wpn_1300", "wpn_21101", "wpn_3103200", "wpn_3800200"]


def alpha_queue(order):
    if not isinstance(order, int) or isinstance(order, bool):
        return None
    stage, layer = order // 1_000_000, (order % 1_000_000) // 1000
    if not 20 <= stage <= 24 or layer >= 125:
        return None
    queue = stage * 125 + layer + int(stage >= 22)
    return queue if queue > 2500 else None


def scan(manifest):
    stats = Counter()
    records, errors = [], []
    for key, entry in manifest["models"].items():
        stats["total"] += 1
        stats[key.split("/")[1]] += 1
        try:
            doc = read_gltf_json(ROOT / entry["file"].split("?", 1)[0])
            groups = defaultdict(list)
            for node in doc.get("nodes", []):
                if "mesh" not in node:
                    continue
                order = node.get("extras", {}).get("renderOrder")
                queue = alpha_queue(order)
                if queue is not None:
                    groups[queue].append({"name": node.get("name", ""), "renderOrder": order})
            tied = [{"queue": q, "nodes": ns} for q, ns in sorted(groups.items()) if len(ns) > 1]
            face_body = [g for g in tied if any(FACE.match(n["name"]) for n in g["nodes"])
                         and any(not DIRECTION.match(n["name"]) for n in g["nodes"])]
            stats["modelsWithAlphaTies"] += bool(tied)
            stats["faceBodyCandidates"] += bool(face_body)
            if tied:
                records.append({"model": Path(key).stem, "key": key,
                                "alphaTies": tied, "faceBodyTies": face_body})
        except Exception as error:
            errors.append({"model": key, "error": str(error)})
    return {"stats": dict(stats), "models": records, "errors": errors}


PROBE = r"""({clip, time, yaw}) => {
    const d = window.__rendererDebug, root = window.__modelDebug, T = d.THREE;
    d.freeze();
    if (clip) {
        const result = window.__visDebug(clip, time, []);
        if (result.error) throw new Error(result.error);
    }
    const camera = d.camera, target = d.controls.target;
    const distance = camera.position.distanceTo(target);
    camera.position.set(target.x + Math.sin(yaw) * distance, target.y,
        target.z + Math.cos(yaw) * distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    root.updateMatrixWorld(true);
    const invariant = () => {
        const values = [];
        root.traverse(n => {
            if (!n.isMesh) return;
            const materials = Array.isArray(n.material) ? n.material : [n.material];
            values.push([n.uuid, n.visible, n.renderOrder, n.matrixWorld.toArray(), materials.map(m =>
                [m.uuid, m.transparent, m.depthWrite, m.depthTest, m.alphaTest, m.side,
                 m.blending, m.blendSrc, m.blendDst])]);
        });
        return JSON.stringify(values);
    };
    const prior = invariant();
    const queue = order => {
        if (!Number.isSafeInteger(order)) return null;
        const stage = Math.floor(order / 1000000), layer = Math.floor(order % 1000000 / 1000);
        if (stage < 20 || stage > 24 || layer >= 125) return null;
        const q = stage * 125 + layer + (stage >= 22 ? 1 : 0);
        return q > 2500 ? q : null;
    };
    const vector = new T.Vector3();
    const faceBounds = [];
    const width = d.renderer.domElement.width, height = d.renderer.domElement.height;
    root.traverseVisible(n => {
        if (!n.isMesh || !/^[LR]\d+_face$/i.test(n.name)) return;
        if (n.isSkinnedMesh) n.computeBoundingBox();
        else if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
        const box = n.isSkinnedMesh ? n.boundingBox : n.geometry.boundingBox;
        const pixels = [];
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y])
            for (const z of [box.min.z, box.max.z]) {
                vector.set(x,y,z).applyMatrix4(n.matrixWorld).project(camera);
                pixels.push([(vector.x + 1) * width / 2, (1 - vector.y) * height / 2]);
            }
        faceBounds.push([Math.min(...pixels.map(p=>p[0])), Math.min(...pixels.map(p=>p[1])),
                         Math.max(...pixels.map(p=>p[0])), Math.max(...pixels.map(p=>p[1]))]);
    });
    const capture = enabled => {
        d.setQueueDepthSort(enabled);
        const trace = [], hooks = [];
        root.traverseVisible(n => {
            if (!n.isMesh) return;
            const old = n.onBeforeRender;
            hooks.push([n, old]);
            n.onBeforeRender = function() {
                old.apply(this, arguments);
                if (n.isSkinnedMesh) n.computeBoundingBox();
                else if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
                const box = n.isSkinnedMesh ? n.boundingBox : n.geometry.boundingBox;
                box.getCenter(vector).applyMatrix4(n.matrixWorld).project(camera);
                trace.push({name:n.name, id:n.id, order:n.renderOrder, queue:queue(n.renderOrder), z:vector.z});
            };
        });
        try { return {image:d.grab().data, trace}; }
        finally { hooks.forEach(([n, old]) => {n.onBeforeRender = old;}); }
    };
    let before, after;
    try { before = capture(false); after = capture(true); }
    finally { d.setQueueDepthSort(true); }
    if (invariant() !== prior) throw new Error('Sorting mutated transforms, visibility or materials');
    const failures = [], groups = new Map();
    after.trace.forEach(n => {
        if (n.queue === null) return;
        const peers = groups.get(n.queue) || [];
        peers.push(n); groups.set(n.queue, peers);
    });
    groups.forEach(peers => {
        for (let i=1; i<peers.length; i++) {
            if (peers[i].z > peers[i-1].z + 1e-10) failures.push([peers[i-1], peers[i]]);
        }
    });
    // No cross-queue or depth-writing order may change.
    const unchanged = nodes => nodes.filter(n => n.queue === null).map(n => n.id).join(',');
    if (unchanged(before.trace) !== unchanged(after.trace)) throw new Error('Opaque order changed');
    const indices = new Map(before.trace.map((n,i) => [n.id,i]));
    const inversions = [];
    for (let i=0; i<after.trace.length; i++) for (let j=i+1; j<after.trace.length; j++) {
        const a=after.trace[i], b=after.trace[j];
        if (indices.get(a.id) > indices.get(b.id)) {
            if (a.queue === null || a.queue !== b.queue) throw new Error('Cross-queue order changed');
            inversions.push({first:a.name, second:b.name, queue:a.queue});
        }
    }
    return {before:before.image, after:after.image, failures, inversions, faceBounds,
            drawCalls:after.trace.length, title:document.querySelector('#modelDetailTitle')?.textContent};
}"""


def images(result, out, stem, allow_empty=False):
    import numpy as np
    from PIL import Image
    frames = {}
    for key in ("before", "after"):
        frames[key] = Image.open(io.BytesIO(base64.b64decode(result.pop(key).split(",", 1)[1]))).convert("RGBA")
        frames[key].save(out / f"{stem}-{key}.png")
    a, b = (np.array(frames[k]).astype(np.int16) for k in ("before", "after"))
    diff = np.max(np.abs(a - b), axis=2)
    visible = (a[:, :, 3] > 20) | (b[:, :, 3] > 20)
    changed = (diff > 8) & visible
    face = np.zeros(changed.shape, dtype=bool)
    for x0, y0, x1, y1 in result["faceBounds"]:
        face[max(0, int(y0)):min(face.shape[0], int(y1)+1),
             max(0, int(x0)):min(face.shape[1], int(x1)+1)] = True
    count = int(np.count_nonzero(visible))
    before_count = int(np.count_nonzero(a[:, :, 3] > 20))
    after_count = int(np.count_nonzero(b[:, :, 3] > 20))
    # Some enemy death poses are already empty in the baseline. Keep
    # testing that frame, but require the baseline and fixed render to agree.
    empty_death = allow_empty and before_count == after_count == 0 and not diff.any()
    if not empty_death and (before_count < 100 or after_count < 100):
        raise AssertionError(f"Blank model: before={before_count}, after={after_count}")
    return {"visiblePixels":count, "emptyDeathFrame":bool(empty_death),
            "changedPixels":int(changed.sum()),
            "faceChangedPixels":int((changed & face).sum()),
            "before":f"{stem}-before.png", "after":f"{stem}-after.png"}


def run_browser(args, manifest, inventory):
    from playwright.sync_api import sync_playwright
    candidates = [row["model"] for row in inventory["models"] if row["faceBodyTies"]]
    models = args.models or sorted(set(candidates + REGRESSION))
    if args.limit:
        models = models[:args.limit]
    catalog = [{"name":key, "path":"bucket-a", "size":1} for key in manifest["models"]]
    reports, failures = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(viewport={"width":1216, "height":836})
        context.route("https://database.kirafan.cn/assetBundle.json", lambda route: route.fulfill(json=catalog))
        context.route(re.compile(r"https://bucket-.*-asset\.kirafan\.cn/.*/index\.json"),
                      lambda route: route.fulfill(status=503, body="offline fixture"))
        context.route(re.compile(r"https://asset\.kirafan\.cn/.*"),
                      lambda route: route.fulfill(path=str(ROOT / "favicon.png"), content_type="image/png"))
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            for index, model in enumerate(models):
                try:
                    errors.clear()
                    kind = "weapon" if model.startswith("wpn_") else "enemy" if model.startswith("model_en_") else "player"
                    key = f"model/{kind}/{model}.muast"
                    page.goto(f"{args.url}/site/models.html?debug=1&order-audit={model}#{quote(key)}", wait_until="domcontentloaded")
                    page.wait_for_function("id => window.__modelDebugFile?.includes('/'+id+'/') && document.querySelector('#model3dCanvas.is-ready')", arg=model, timeout=60000)
                    if kind == "player":
                        page.wait_for_function("window.__rendererDebug.clipInfo().some(c => c.name === 'idle')", timeout=15000)
                    page.evaluate("window.__rendererDebug.freeze()")
                    clips = page.evaluate("window.__rendererDebug.clipInfo()")
                    selected = clips if model in REGRESSION else [c for c in clips if c["name"] in ("idle", "room_idle_L", "battle_run", "attack")]
                    if not selected:
                        selected = [{"name":None, "duration":0}]
                    cases = [(c["name"], c["duration"] * t, 0) for c in selected for t in (0.15, 0.65)]
                    if model in REGRESSION:
                        resting = next((c for c in selected if c["name"] == "idle"), selected[0])
                        cases += [(resting["name"], resting["duration"] * 0.2, yaw) for yaw in (-0.6, 0.6)]
                    row = {"model":model, "key":key, "cases":[]}
                    for number, (clip, time, yaw) in enumerate(cases):
                        result = page.evaluate(PROBE, {"clip":clip, "time":time, "yaw":yaw})
                        assert not result["failures"], result["failures"]
                        result.update(images(result, args.out, f"{model}-{number:02}", allow_empty=clip == "dead"))
                        result.update({"clip":clip, "time":time, "yaw":yaw})
                        row["cases"].append(result)
                    assert not errors, errors
                    reports.append(row)
                    print(f"PASS {index+1}/{len(models)} {model}: {len(cases)} poses", flush=True)
                except Exception as error:
                    failures.append({"model":model, "error":str(error)})
                    print(f"FAIL {model}: {error}", flush=True)
                # Keep completed evidence if a later asset/browser fails.
                (args.out / "browser-report.json").write_text(json.dumps({"models":reports, "failures":failures}, ensure_ascii=False, indent=2), encoding="utf8")
        finally:
            browser.close()
    return reports, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", nargs="*")
    parser.add_argument("--url", default="http://127.0.0.1:8643")
    parser.add_argument("--out", type=Path, default=ROOT / ".codex-tmp/model-order")
    parser.add_argument("--scan-only", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / "site/asset/models/manifest.json").read_text(encoding="utf8"))
    inventory = scan(manifest)
    (args.out / "inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(inventory["stats"], ensure_ascii=False), flush=True)
    if inventory["errors"]:
        print(json.dumps(inventory["errors"], ensure_ascii=False))
        return 1
    if args.scan_only:
        return 0
    reports, failures = run_browser(args, manifest, inventory)
    print(f"Browser: {len(reports)} models, {sum(len(r['cases']) for r in reports)} poses, {len(failures)} failures")
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
