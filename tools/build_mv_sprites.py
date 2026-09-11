#!/usr/bin/env python3
"""Catalogue the game's effect textures so the Metroidvania can use them as sprites.

asset/uniqueskill/texture/ holds 1,907 PNGs -- the original game's own effect
art, pulled from the 177 uniqueskill scenes (2,828 emitters between them). That
is the bullet, slash, glow and aura library for a danmaku-flavoured action game,
already drawn, already in the repo. Nothing here needs to be painted.

That directory belongs to another session and is read only. This tool writes a
*derived index* into asset/mv/sprites.json and copies nothing.

The `blend` column records which compositing mode each file was authored for,
because getting it wrong is what produces a black rectangle around a sprite:

  colour type 6 / 4 (RGBA, grey+alpha)  -> straight alpha. transparent:true,
                                           NormalBlending.
  colour type 2 / 0 (RGB, grey)         -> the transparency IS the black. Authored
                                           for additive blending, where black adds
                                           nothing. Composite these as if they had
                                           alpha and the black square shows.

Measured, every one of the 1,907 files here is colour type 6, so this library is
uniformly straight-alpha and none of it needs additive treatment. The column is
kept because it is one byte per entry and it means core/mvdanmaku.js reads the
mode instead of assuming it -- an assumption that holds for this directory today
and would break silently the first time a texture from anywhere else is added.
It is not, however, the cause of the black edges on the ADV pictures: those
images are not in this directory and not RGBA. See tools/check_mv_art.py.
"""

import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEX_DIR = os.path.join(ROOT, "asset", "uniqueskill", "texture")
SCENE_INDEX = os.path.join(ROOT, "asset", "uniqueskill", "scene-index.json")
OUT = os.path.join(ROOT, "asset", "mv", "sprites.json")

# Per-bucket cap. The whole library is 77 MB; a room needs a handful of
# sprites, so shipping an index of all 1,907 would be indexing for its own
# sake. Cheapest-first within each bucket (see build()).
CAP = 24

# Colour types that carry their own alpha channel.
ALPHA_TYPES = {4, 6}

def png_header(path):
    """(width, height, bit_depth, colour_type, has_trns) from the IHDR.

    Read straight out of the header rather than through an image library: the
    repo has no Pillow dependency and adding one to count pixels would be a
    poor trade. IHDR is always the first chunk and always 13 bytes.
    """
    with open(path, "rb") as fh:
        head = fh.read(8)
        if head != b"\x89PNG\r\n\x1a\n":
            return None
        length = struct.unpack(">I", fh.read(4))[0]
        if fh.read(4) != b"IHDR" or length != 13:
            return None
        w, h, depth, ctype = struct.unpack(">IIBB", fh.read(10))
        # A palette PNG can still be transparent, via a tRNS chunk. Scan a
        # bounded prefix for it -- tRNS must precede IDAT, so it is near the
        # front, and reading the whole file to find out would cost 77 MB.
        rest = fh.read(4)  # remaining IHDR bytes + CRC start
        prefix = rest + fh.read(4096)
        return {"w": w, "h": h, "depth": depth, "ctype": ctype,
                "trns": b"tRNS" in prefix}


def blend_of(info):
    """Which compositing mode this file was authored for. See module docstring."""
    if info["ctype"] in ALPHA_TYPES:
        return "alpha"
    if info["ctype"] == 3 and info["trns"]:
        return "alpha"
    # RGB or greyscale with no alpha and no tRNS: the black is the transparency.
    return "add"


def bucket_of(info):
    """What this can be used as, keyed on pixel size.

    A first pass bucketed by aspect ratio, expecting wide strips for slashes and
    tall ones for beams. Measured, that classifier is wrong for this library:
    of 1,907 textures, 1,904 are square. The originals build a sweep by
    stretching a square sprite along an emitter path, not by authoring a wide
    one, so shape carries no information here and the ratio buckets came out
    arc=2, beam=1.

    Size does carry information, because it tracks how the original used the
    sprite -- and it happens to be the runtime-relevant axis too, since a
    bullet is drawn dozens at a time and a 512px aura is drawn once:

        128x128  790     64x64   328     32x32    76
        256x256  368    512x512  231   1024x1024  59
    """
    long_side = max(info["w"], info["h"])
    if long_side < 2:
        return None         # 1x1 padding textures, nothing to draw
    if long_side <= 32:
        return "bullet"     # the danmaku itself, drawn many at a time
    if long_side <= 64:
        return "spark"      # graze pop, ink mote, muzzle
    if long_side <= 128:
        return "glow"       # trail, lamp halo, pickup shine
    if long_side <= 256:
        return "burst"      # hit impact, crystal shatter
    return "aura"           # 512+: boss telegraph, room-wide wash


def texture_use_counts():
    """How many scenes reference each texture.

    A texture used by many uniqueskill scenes is one the original game leaned
    on, which makes it a safer pick than a one-off: it reads as "this game's
    effect art" rather than as a stray asset. scene-index.json only carries
    counts, not the texture lists, so this returns {} when it cannot tell --
    the caller falls back to file size.
    """
    try:
        with open(SCENE_INDEX, encoding="utf-8") as fh:
            index = json.load(fh)
    except (OSError, ValueError):
        return {}
    counts = {}
    for scene in (index.get("scenes") or {}).values():
        for name in scene.get("textureList") or []:
            counts[name] = counts.get(name, 0) + 1
    return counts


def build(cap=CAP):
    if not os.path.isdir(TEX_DIR):
        raise SystemExit("texture dir missing: %s" % TEX_DIR)
    uses = texture_use_counts()
    buckets = {}
    skipped = {"unreadable": 0, "odd-shape": 0}
    total = 0

    for name in sorted(os.listdir(TEX_DIR)):
        if not name.lower().endswith(".png"):
            continue
        path = os.path.join(TEX_DIR, name)
        info = png_header(path)
        if not info:
            skipped["unreadable"] += 1
            continue
        total += 1
        bucket = bucket_of(info)
        if not bucket:
            skipped["odd-shape"] += 1
            continue
        buckets.setdefault(bucket, []).append({
            "file": "site/asset/uniqueskill/texture/" + name,
            "w": info["w"], "h": info["h"],
            "blend": blend_of(info),
            "bytes": os.path.getsize(path),
            "uses": uses.get(name, 0)
        })

    # Cheap and well-used first. A bullet is drawn dozens at a time, so a 4 KB
    # sprite and a 300 KB sprite are not interchangeable at runtime.
    out = {}
    for bucket, items in buckets.items():
        items.sort(key=lambda e: (-e["uses"], e["bytes"]))
        out[bucket] = items[:cap]

    return {
        "generator": "tools/build_mv_sprites.py",
        "source": "site/asset/uniqueskill/texture/ (read-only, another session owns it)",
        "scanned": total,
        "skipped": skipped,
        "counts": {k: len(v) for k, v in sorted(buckets.items())},
        "shipped": {k: len(v) for k, v in sorted(out.items())},
        "sprites": out
    }


def render(data):
    parts = []
    for key in sorted(data):
        parts.append(" %s: %s" % (json.dumps(key),
                                  json.dumps(data[key], ensure_ascii=False,
                                             sort_keys=True,
                                             separators=(",", ":"))))
    return "{\n" + ",\n".join(parts) + "\n}\n"


def main():
    cap = CAP
    for arg in sys.argv[1:]:
        if arg.startswith("--cap="):
            cap = int(arg.split("=", 1)[1])
    data = build(cap)
    text = render(data)

    if "--check" in sys.argv:
        if not os.path.exists(OUT):
            print("missing: %s" % OUT)
            return 1
        with open(OUT, encoding="utf-8") as fh:
            if fh.read() != text:
                print("stale: %s (run tools/build_mv_sprites.py)" % OUT)
                return 1
        print("sprites.json up to date")
        return 0

    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print("scanned %d textures, skipped %s" % (data["scanned"], data["skipped"]))
    print("buckets found : %s" % data["counts"])
    print("buckets shipped: %s" % data["shipped"])
    blends = {}
    for items in data["sprites"].values():
        for e in items:
            blends[e["blend"]] = blends.get(e["blend"], 0) + 1
    print("blend modes in shipped set: %s" % blends)
    print("wrote %s (%d bytes)" % (os.path.relpath(OUT, ROOT),
                                   len(text.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())

