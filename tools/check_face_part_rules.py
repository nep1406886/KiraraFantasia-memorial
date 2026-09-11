"""Check face_part() against the exact vocabulary the corpus contains."""
import importlib.util, inspect, sys

spec = importlib.util.spec_from_file_location("ckm", "tools/convert_kirafan_model.py")
mod = importlib.util.module_from_spec(spec)
sys.modules["ckm"] = mod
spec.loader.exec_module(mod)
cls = [o for n, o in vars(mod).items()
       if inspect.isclass(o) and hasattr(o, "face_part")][0]
fp = cls.face_part

# Every suffix observed in the corpus, per word.
OVERLAY_SUFFIXES = ["", "_A", "_B", "_C", "_D", "_E", "_1", "_2", "_3", "_4",
                    "1", "_A_1", "_A_2", "_B_1", "_B_2", "_B_3", "_face_A", "_face_B"]
OVERLAY_WORDS = ["cry", "namida", "tere", "cheek", "cheeck", "sen", "shade",
                 "shadow", "blue", "bule", "aozame", "pale", "red", "black",
                 "angry", "sad", "shy", "question", "text", "eyelid"]

cases = []
for word in OVERLAY_WORDS:
    for suffix in OVERLAY_SUFFIXES:
        cases.append((word + suffix, "overlay"))

for base, kind in (("eye", "eye"), ("Eye", "eye"),
                   ("eyebrow", "eyebrow"), ("eyebrrow", "eyebrow"),
                   ("eyeblow", "eyebrow"), ("Eyeblow", "eyebrow"),
                   ("Eyebrrow", "eyebrow"), ("mouth", "mouth"), ("kuchi", "mouth")):
    for suffix in ["", "_A", "_A2", "_A_2", "_C_1", "_default", "_anger", "_I", "_H_2"]:
        cases.append((base + suffix, kind))

# Head base and permanent decoration must stay unclassified.
for name in ["face", "face_paint", "face_Accessory_L", "backhead", "backhead_B",
             "hair_C_A", "hair_back_R", "hair_said_L", "hair_accessory_2", "ahoge",
             "glasses", "eyeglass", "eyeglass_2", "hokuro", "backhair",
             "ribon_A", "ribon", "head_accessory", "horn_L", "accessories",
             "back_ribbon_top", "sad_face_hair", "cheek_ornament_mesh",
             "senpai_hair", "redhair_tie", "blueprint_thing", "angry_hair_spike"]:
    cases.append((name, None))

bad = []
for part, expect in cases:
    got = fp("L30_" + part)
    kind = got["kind"] if got else None
    if kind != expect:
        bad.append((part, kind, expect))
    if got and got["name"] != part:
        bad.append((part, f"name={got['name']}", f"name={part}"))

# A non-L30 direction set must never classify.
for part in ["L60_eye_A", "R30_mouth_B", "SIDE_eye_A", "body", "arm"]:
    if fp(part) is not None:
        bad.append((part, "classified", None))

print(f"{len(cases) + 5} cases")
for part, got, expect in bad:
    print(f"BAD {part:24s} -> {got} expected {expect}")
print("ALL PASS" if not bad else f"{len(bad)} FAILURES")
sys.exit(1 if bad else 0)
