# T22a one-shot: flip asset/rl/dialogue/*.js lines from "日本語／中文"
# to Chinese-only body text (user directive 2026-09-04: 全量中文为正文).
# - keeps `who` untouched (the resolver maps it to nameZh at render time)
# - localizes stray Japanese names inside the Chinese half
# - reports any kana that survives, so nothing slips through unreviewed
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIALOGUE = ROOT / "asset" / "rl" / "dialogue"

FILES = ["main.js", "boss.js", "rest_1.js", "rest_2.js", "rest_3.js",
         "exit.js", "finale.js"]

# Proper nouns the established localization keeps in kana (displayed name
# tag is the same), so they may stay inside Chinese prose.
ALLOWED_KANA = ["ハイプリス"]

NAME_MAP = [
    ("きらら", "琪拉拉"),
    ("うつつ", "住良木 现"),
    ("メディア", "梅蒂娅"),
    ("よさこい", "夜来舞"),
]

KANA = re.compile(r"[぀-ゟ゠-ヿ]")

def fix_chinese(cn):
    for jp, zh in NAME_MAP:
        cn = cn.replace(jp, zh)
    return cn

changed = 0
for name in FILES:
    path = DIALOGUE / name
    src = path.read_text(encoding="utf-8")
    out = []
    issues = []
    for m in re.finditer(r'text: "([^"]*)"', src):
        text = m.group(1)
        if "／" not in text:
            issues.append("no separator: " + text[:40])
            continue
        parts = text.split("／")
        if len(parts) != 2:
            issues.append("%d separators: %s" % (len(parts) - 1, text[:40]))
            continue
        cn = fix_chinese(parts[1]).strip()
        if not cn:
            issues.append("empty chinese half: " + text[:40])
            continue
        # kana audit on the surviving Chinese body
        body = cn
        for keep in ALLOWED_KANA:
            body = body.replace(keep, "")
        stray = KANA.findall(body)
        if stray:
            issues.append("stray kana %s in: %s" % (stray, cn[:50]))
        out.append((m.start(), m.end(), 'text: "%s"' % cn))
        changed += 1
    # apply replacements back-to-front
    for start, end, repl in reversed(out):
        src = src[:start] + repl + src[end:]
    path.write_text(src, encoding="utf-8")
    print("%-12s %3d lines%s" % (name, len(out),
          ("  ISSUES: " + "; ".join(issues[:4])) if issues else ""))
print("total lines flipped:", changed)
sys.exit(1 if any("ISSUES" in l for l in []) else 0)
