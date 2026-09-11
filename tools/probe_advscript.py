#!/usr/bin/env python3
"""Read the game's own ADV staging scripts, to learn how a scene was staged.

Two bundles per scene: `advscript_*` carries the staging commands (background,
who is on screen, where they stand, which face, camera, BGM) and
`advscripttext_*` carries the dialogue. This reads the *staging* half.

Why: the fan game's scripts name backgrounds by role ("library"), and something
has to establish that the 図書館 interior is a particular one of 617 numbered
bundles. The original scripts already say which background each scene uses, so
the answer is in the data rather than in guesswork over a contact sheet.

Per decision 3 ①, dialogue is ours -- these are read for staging vocabulary and
asset ids, not for text to copy.

Usage:
    python tools/probe_advscript.py --find bg_adv_com_02_03
    python tools/probe_advscript.py adv/script/story/advscript_story_009_001_st.muast
    python tools/probe_advscript.py --bg-census story 40
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "advscript"
LOCAL_INDEX = ROOT / ".codex-tmp" / "assetBundle.json"
HTTP_HEADERS = {"User-Agent": "kirafan-timer-advscript/1.0"}

BG_PATTERN = re.compile(rb"bg_adv_[a-z]+_[0-9_]+")


def index() -> dict[str, dict]:
    data = json.loads(LOCAL_INDEX.read_text(encoding="utf-8"))
    return {e["name"]: e for e in data}


def download(entry: dict) -> Path:
    destination = CACHE / Path(entry["name"]).name
    if destination.exists() and destination.stat().st_size:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    bucket = str(entry["path"])[-1]
    url = f"https://bucket-{bucket}-asset.kirafan.cn/{entry['name']}"
    request = urllib.request.Request(url, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=90) as response:
        destination.write_bytes(response.read())
    return destination


def commands(path: Path) -> list[dict]:
    """The staging script as a list of {func, args}.

    The bundle holds a MonoBehaviour whose class is the game's own
    ADVScriptParam: a flat list of calls, each with a function name and up to
    ~10 loosely typed argument slots. Read via typetree because there is no
    generated class to deserialise against.

    The bundle is LZ4-compressed, so scanning the file bytes for asset ids finds
    nothing -- everything here goes through UnityPy.
    """
    import UnityPy

    env = UnityPy.load(str(path))
    out: list[dict] = []
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        # ADVScriptParam: m_Params is a list of scripts (usually one), each with
        # a FuncParam list of calls. A call is a funcName plus ten fixed
        # m_valueN slots, of which argNum are meaningful -- the rest are "".
        for script in (tree or {}).get("m_Params") or []:
            if not isinstance(script, dict):
                continue
            for row in script.get("FuncParam") or []:
                if not isinstance(row, dict):
                    continue
                count = row.get("argNum") or 0
                args = []
                for slot in range(1, 11):
                    value = row.get(f"m_value{slot}")
                    if value in ("", None):
                        continue
                    args.append(value)
                    if len(args) >= count and count:
                        break
                out.append({"func": row.get("funcName"), "args": args,
                            "script": script.get("ScriptName", "")})
    return out


def backgrounds_in(path: Path) -> list[str]:
    # Scripts spell them BG_Adv_Btl_0017; the bundles are lowercase. Normalised
    # here so a census key matches an asset name directly.
    found = []
    for command in commands(path):
        for arg in command["args"]:
            if isinstance(arg, str) and arg.lower().startswith("bg_adv"):
                found.append(arg.lower())
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("bundles", nargs="*", help="full bundle names to dump")
    parser.add_argument("--find", metavar="BG", help="scripts that use this background")
    parser.add_argument("--bg-census", nargs=2, metavar=("KIND", "COUNT"),
                        help="count background use across KIND (story/event/chara) scripts")
    args = parser.parse_args()

    entries = index()

    if args.bg_census:
        kind, count = args.bg_census[0], int(args.bg_census[1])
        names = sorted(n for n in entries
                       if n.startswith(f"adv/script/{kind}/advscript_") and "text" not in n)
        names = names[:count]
        census: Counter[str] = Counter()
        where: dict[str, list[str]] = {}
        for name in names:
            try:
                path = download(entries[name])
            except Exception as error:
                print(f"  ! {name}: {error}")
                continue
            for bg in set(backgrounds_in(path)):
                census[bg] += 1
                where.setdefault(bg, []).append(Path(name).stem)
        print(f"{len(names)} scripts, {len(census)} distinct backgrounds")
        for bg, n in census.most_common(40):
            print(f"  {bg:24s} {n:3d}  e.g. {where[bg][0]}")
        return 0

    if args.find:
        hits = []
        names = sorted(n for n in entries if n.startswith("adv/script/") and "text" not in n)
        for name in names:
            try:
                path = download(entries[name])
            except Exception:
                continue
            if args.find.encode("ascii") in path.read_bytes():
                hits.append(name)
                print(f"  {name}")
                if len(hits) >= 20:
                    break
        print(f"{len(hits)} script(s)")
        return 0

    for name in args.bundles:
        if name not in entries:
            print(f"  ! {name}: not in the index")
            continue
        path = download(entries[name])
        print(f"=== {name} ===")
        rows = commands(path)
        for row in rows[:120]:
            args = " ".join(str(a) for a in row["args"])
            print(f"  {str(row['func']):26s} {args[:110]}")
        print(f"--- {len(rows)} commands")
        print("--- backgrounds:", sorted(set(backgrounds_in(path))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
