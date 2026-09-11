"""Compare the exporter's face classifier against the one in models.js.

The extras written at export time and the fallback models.js applies when they are
missing have to agree, or a layer behaves differently depending on which path ran.
This drives the real vocabulary -- every distinct L30_ part name in the built
catalog -- through both and reports any disagreement.
"""
import importlib.util, inspect, json, re, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = Path(tempfile.mkdtemp(prefix="kirafan-classifier-"))
sys.path.insert(0, str(ROOT / "tools"))
from audit_models import read_gltf_json

spec = importlib.util.spec_from_file_location("ckm", ROOT / "tools" / "convert_kirafan_model.py")
mod = importlib.util.module_from_spec(spec)
sys.modules["ckm"] = mod
spec.loader.exec_module(mod)
cls = [o for _, o in vars(mod).items()
       if inspect.isclass(o) and hasattr(o, "face_part")][0]

# Collect every distinct L30_ part name in the catalog, plus every facial-table layer.
parts = set()
manifest = json.loads((ROOT / "asset" / "models" / "manifest.json").read_text(encoding="utf-8"))
for key, preview in manifest["models"].items():
    path = ROOT / str(preview.get("file", "")).split("?", 1)[0]
    if not path.is_file():
        continue
    try:
        doc = read_gltf_json(path)
    except Exception:
        continue
    for node in doc.get("nodes", []):
        name = node.get("name") or ""
        if "mesh" in node and name[:4].lower() == "l30_":
            parts.add(name[4:])
for table in (ROOT / "asset" / "models" / "facial").glob("*.json"):
    if table.name == "actions.json":
        continue
    data = json.loads(table.read_text(encoding="utf-8"))
    parts.update(data.get("layers") or [])
    parts.update(data.get("hide") or [])

parts = sorted(parts)
print(f"{len(parts)} distinct part names")

# Pull the two regex literals straight out of models.js so this cannot drift.
source = (ROOT / "models.js").read_text(encoding="utf-8")
overlay = re.search(r"var FACE_OVERLAY_PART = (/.*/);", source).group(1)
kind = re.search(r"var FACE_KIND_PATTERN = (/.*/);", source).group(1)

script = """
var FACE_OVERLAY_PART = %s;
var FACE_KIND_PATTERN = %s;
function canon(p){var l=String(p).toLowerCase().replace(/^(?:eyebrrow|eyeblow)/,'eyebrow');
  var m=FACE_KIND_PATTERN.exec(l); if(!m)return l;
  var r=m[2].replace(/^_+/,'').replace(/([a-z])(\\d)/g,'$1_$2');
  return r?m[1]+'_'+r:m[1];}
function cls(p){var c=canon(p);
 if(/^(?:eye_)?glass(?:es)?(?:_|$)/.test(c))return '';
 if(/^eye_lid(?:_|$)/.test(c))return 'overlay';
 if(/^eyebrow(?:_|$)/.test(c))return 'eyebrow';
 if(/^eye(?:_|$)/.test(c))return 'eye';
 if(/^mouth(?:_|$)/.test(c))return 'mouth';
 if(FACE_OVERLAY_PART.test(c))return 'overlay';
 return '';}
var fs = require('fs');
var names = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.writeFileSync(process.argv[3], JSON.stringify(names.map(cls)));
""" % (overlay, kind)

script_path = TMP / "_cls.js"
names_path = TMP / "_names.json"
kinds_path = TMP / "_kinds.json"
script_path.write_text(script, encoding="utf-8")
names_path.write_text(json.dumps(parts), encoding="utf-8")
result = subprocess.run(["node", str(script_path), str(names_path), str(kinds_path)],
                        capture_output=True, text=True)
if result.returncode != 0:
    sys.exit(f"node failed:\n{result.stderr}")
js_kinds = json.loads(kinds_path.read_text(encoding="utf-8"))

mismatch = []
for part, js_kind in zip(parts, js_kinds):
    py = cls.face_part("L30_" + part)
    py_kind = py["kind"] if py else ""
    if py_kind != js_kind:
        mismatch.append((part, py_kind or "(none)", js_kind or "(none)"))

shutil.rmtree(TMP, ignore_errors=True)
for part, py_kind, js_kind in mismatch:
    print(f"DIFFER {part:24s} exporter={py_kind:9s} models.js={js_kind}")
print(f"\n{len(parts) - len(mismatch)}/{len(parts)} agree"
      + (f", {len(mismatch)} differ" if mismatch else " -- classifiers are consistent"))
sys.exit(1 if mismatch else 0)
