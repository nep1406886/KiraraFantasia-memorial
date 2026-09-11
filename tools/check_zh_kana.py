"""Flag kana that leaked into the Chinese half of a bilingual string.

Every line in this project is authored as {ja, zh}. The Japanese half is meant to
have kana; the Chinese half is not. When a term is coined in Japanese and pasted
straight into the Chinese line, a Chinese reader sees kana mid-sentence and reads
it as a rendering fault rather than as a name -- so it is worth catching
mechanically instead of by eye across every chapter.

Proper nouns that genuinely stay Japanese in both languages go in ALLOWED.
"""

import glob
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

KANA = re.compile("[぀-ゟ゠-ヿ]")
# Matches a zh: "..." value, honouring backslash escapes inside it.
ZH = re.compile(r'zh:\s*"((?:[^"\\]|\\.)*)"')
ZH_JSON = re.compile(r'"zh"\s*:\s*"((?:[^"\\]|\\.)*)"')

# Kanji whose Japanese form differs from the simplified Chinese one. Kana is the
# obvious leak, but pasting a Japanese line into the Chinese slot also drags
# these across, and they are easy to read past -- 聖典 looks plausible enough
# that it survived a full read-through of the prologue.
HAN_FORMS = {
    "聖": "圣", "図": "图", "頁": "页", "絆": "绊", "読": "读", "覚": "觉",
    "変": "变", "楽": "乐", "樹": "树", "葉": "叶", "書": "书", "館": "馆",
    "気": "气", "戦": "战", "闘": "斗", "沢": "泽", "誰": "谁", "點": "点",
    "後": "后", "來": "来", "們": "们", "個": "个", "說": "说", "話": "话",
    "見": "见", "願": "愿", "顔": "颜", "実": "实", "対": "对", "発": "发",
    "経": "经", "続": "续", "録": "录", "険": "险", "強": "强", "帰": "归",
    "収": "收", "処": "处", "壊": "坏", "夢": "梦", "験": "验",
}
HAN_RE = re.compile("[" + "".join(HAN_FORMS) + "]")

# Names left untranslated in Chinese on purpose. Deliberately empty for dialogue:
# the Chinese server has an official name for every character this project uses
# (琪拉拉 / 兰普 / 阿尔希芙 / 索拉), and mixing one katakana name into an
# otherwise-Chinese line reads as an oversight rather than as flavour. Add an
# entry only for a term with no Chinese form anywhere in the official data.
ALLOWED = ()

ROOTS = ("site/asset/story/*.js", "site/core/*.js", "game/*.js", "site/asset/story/*.json")


def offenders(text):
    probe = text
    for word in ALLOWED:
        probe = probe.replace(word, "")
    return KANA.findall(probe)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    hits = 0
    for pattern in ROOTS:
        for path in sorted(glob.glob(pattern)):
            src = open(path, encoding="utf-8").read()
            pat = ZH_JSON if path.endswith(".json") else ZH
            for match in pat.finditer(src):
                text = match.group(1)
                bad = offenders(text) if KANA.search(text) else []
                han = sorted(set(HAN_RE.findall(text)))
                if not bad and not han:
                    continue
                line = src[: match.start()].count("\n") + 1
                notes = []
                if bad:
                    notes.append("kana " + "".join(sorted(set(bad))))
                if han:
                    notes.append("han " + " ".join(c + "->" + HAN_FORMS[c] for c in han))
                print("%s:%d: %s\n    %s" % (path, line, "; ".join(notes), text))
                hits += 1
    print("\n%d Chinese line(s) with Japanese-form characters" % hits)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
