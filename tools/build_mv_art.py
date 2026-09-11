#!/usr/bin/env python3
"""Generate the art 白紙の書架 needs, out of the art the game already has.

The repo's entire image inventory is 1,907 effect textures, 42 story pictures and
10 shutdown artworks. There are no tiles, no backdrops and no bullet set, so the
platformer stage draws flat coloured rectangles. Rather than invent a look, this
derives one from the game's own material:

  PALETTE comes out of asset/story/background/library.webp by k-means, so the
  tiles are the library's own colours rather than something guessed. Measured on
  that file, the dominant clusters are the shelf browns and the paper cream.

  TILES are composited: a base fill in a palette colour, structure drawn from the
  geometry the stage already declares (wall / oneway / fade / crystal), then a
  grain layer lifted from a real effect texture's alpha so the surface is not
  vector-flat. 白紙 is the premise, so these stay pale and low-contrast; the
  blanch levels in core/mvstage.js darken *up* from here.

  BACKDROPS are derived from the two ADV backgrounds -- blurred, desaturated and
  value-shifted per region, at parallax sizes. One 1600x1600 library interior
  becomes six distinct far planes without inventing a pixel.

  BULLETS are selected, not drawn: the effect library already contains the game's
  own danmaku art. Selection needs content scoring, which the first catalogue
  (tools/build_mv_sprites.py) did not do -- it ranked by pixel size alone and
  shipped a 2x2, 77-byte file as a bullet. Scoring below rejects that.

Writes asset/mv/art/ (PNG, small, tracked) plus asset/mv/art.json. Reads the
peer-owned asset/uniqueskill/texture/ but never writes to it.

Usage:
    python tools/build_mv_art.py
    python tools/build_mv_art.py --check
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

try:
    from PIL import Image, ImageFilter, ImageDraw, ImageChops
except ImportError:
    print("needs Pillow: python -m pip install Pillow")
    sys.exit(2)

TEXTURE_DIR = os.path.join(ROOT, "asset", "uniqueskill", "texture")
BG_DIR = os.path.join(ROOT, "asset", "story", "background")
OUT_DIR = os.path.join(ROOT, "asset", "mv", "art")
OUT_INDEX = os.path.join(ROOT, "asset", "mv", "art.json")

TILE = 64           # tile art resolution; the stage maps one tile to one unit
# 1024x576, not 512x288. The source plates are 1600x1280 and 1600x1600, and the
# camera is a perspective one now: the far plane is scaled to the frustum at its
# own depth, so it covers more screen than it did under the orthographic camera
# and 512 px of width was being stretched across it.
#
# Measured on library.webp: source luminance stddev 72.8, the three 512-wide
# planes came out at 27.8 / 35.6 / 38.1 -- the pipeline was discarding just under
# six tenths of the contrast, and resolution was part of that. Held to 16:9 so
# the crop maths below stays one ratio.
BACKDROP = (1024, 576)
SEED = 20260829     # fixed, so a rebuild is byte-identical and reviewable

# The five effect roles core/mvdanmaku.js draws, and the size each is stored at.
#
# Sized to what is actually on screen, not to the source. A bullet is 0.18 tile
# of hitbox drawn at roughly 8-12 screen px, so 32 is already generous and 512
# is 200 KiB of detail nobody can see. Auras are the exception -- they cover a
# whole enemy, so they get the largest budget of the five.
SPRITE_ROLES = ["bullet", "spark", "glow", "burst", "aura"]
SPRITE_SIZE = {"bullet": 32, "spark": 32, "glow": 64, "burst": 64, "aura": 128}

# The eight regions of 白紙の書架, and how far each has been drained of colour.
# R0 is the lamp room the game opens in; R7 is the deepest shelf.
REGIONS = [
    ("R0", 0.00, "library"),
    ("R1", 0.10, "library"),
    ("R2", 0.22, "library"),
    ("R3", 0.34, "library-outside"),
    ("R4", 0.46, "library"),
    ("R5", 0.58, "library-outside"),
    ("R6", 0.72, "library"),
    ("R7", 0.88, "library"),
]


# --- palette, taken from the game's own background ---------------------------

def kmeans_palette(image, k=6, iterations=12, sample=4000):
    """Dominant colours of an image, by k-means on a random pixel sample.

    Sampled rather than exhaustive: 1600x1600 is 2.56M pixels and the answer is
    stable well below that. Seeded, so the palette does not drift between runs.
    """
    rng = random.Random(SEED)
    px = image.convert("RGB").load()
    w, h = image.size
    points = [px[rng.randrange(w), rng.randrange(h)] for _ in range(sample)]
    centres = [points[rng.randrange(len(points))] for _ in range(k)]
    for _ in range(iterations):
        buckets = [[] for _ in range(k)]
        for p in points:
            best, bd = 0, None
            for i, c in enumerate(centres):
                d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
                if bd is None or d < bd:
                    best, bd = i, d
            buckets[best].append(p)
        moved = []
        for i, bucket in enumerate(buckets):
            if not bucket:
                moved.append(centres[i])
                continue
            n = len(bucket)
            moved.append((sum(p[0] for p in bucket) // n,
                          sum(p[1] for p in bucket) // n,
                          sum(p[2] for p in bucket) // n))
        if moved == centres:
            break
        centres = moved
    sizes = [len(b) for b in buckets]
    order = sorted(range(k), key=lambda i: -sizes[i])
    return [{"rgb": list(centres[i]),
             "share": round(sizes[i] / float(sample), 4)} for i in order]


def lighten(rgb, amount):
    """Toward paper white. 白紙 means the surfaces are pale, not saturated."""
    return tuple(int(round(c + (246 - c) * amount)) for c in rgb)


def desaturate(rgb, amount):
    grey = int(round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]))
    return tuple(int(round(c + (grey - c) * amount)) for c in rgb)


# --- scoring the effect library ----------------------------------------------

def score_texture(path):
    """Is this texture usable as a game sprite? Returns None if not.

    The first catalogue ranked by pixel dimensions and shipped a 2x2 file. What
    actually matters:
      coverage  - fraction of pixels with meaningful alpha. Near 0 is an empty
                  or near-empty texture; near 1 is a full-bleed sheet with no
                  silhouette, which reads as a rectangle on screen.
      centred   - how much of the alpha mass sits in the middle. Danmaku art is
                  radial, so a high value means it will read as a bullet rather
                  than as a corner smear.
      contrast  - spread of the alpha histogram. A flat sheet has none.
    """
    try:
        im = Image.open(path)
        im.load()
    except Exception:
        return None
    w, h = im.size
    if w < 16 or h < 16:
        return None          # the 2x2 case, and everything else too small to draw
    im = im.convert("RGBA")
    small = im.resize((32, 32), Image.BILINEAR)
    px = small.load()

    alphas = []
    mass = 0.0
    centre_mass = 0.0
    for y in range(32):
        for x in range(32):
            a = px[x, y][3] / 255.0
            alphas.append(a)
            mass += a
            # Radial weight: 1 at the centre, 0 at the corners.
            dx, dy = (x - 15.5) / 15.5, (y - 15.5) / 15.5
            centre_mass += a * max(0.0, 1.0 - math.hypot(dx, dy))
    coverage = mass / 1024.0
    if coverage < 0.03 or coverage > 0.97:
        return None
    mean = mass / 1024.0
    variance = sum((a - mean) ** 2 for a in alphas) / 1024.0
    return {
        "w": w, "h": h,
        "coverage": round(coverage, 4),
        "centred": round(centre_mass / mass if mass else 0.0, 4),
        "contrast": round(math.sqrt(variance), 4),
    }


# Trim the transparent margin, keeping the result square and centred.
#
# Necessary before downscaling: several of the winners are a small core inside a
# mostly-empty 512 canvas (that is *why* they scored well on centredness), so a
# straight resize to 32 would put the core in 6 px and the rest in empty space.
# Squaring the crop rather than using the tight bounding box keeps the sprite
# round -- a non-square crop scaled into a square texture turns a dot into an
# ellipse, and a bullet that is an ellipse reads as motion it does not have.
def crop_to_content(image, floor=6):
    alpha = image.split()[3]
    box = alpha.point(lambda v: 255 if v > floor else 0).getbbox()
    if not box:
        return image
    left, top, right, bottom = box
    cx, cy = (left + right) / 2.0, (top + bottom) / 2.0
    half = max(right - left, bottom - top) / 2.0
    # A little air around the core, so the edge does not touch the texture
    # border (a bullet whose alpha runs to the edge shows a hard cut when the
    # sampler clamps).
    half *= 1.08
    l = int(round(cx - half))
    t = int(round(cy - half))
    r = int(round(cx + half))
    b = int(round(cy + half))
    if r - l < 4 or b - t < 4:
        return image
    # crop() pads with transparent black outside the source, which is what we
    # want when the 8% air runs past the edge.
    return image.crop((l, t, r, b))


def pick_sprites(limit_per_bucket=16, scan_limit=0):
    """Score the library and keep the best of each bucket, by role.

    Buckets are by pixel size (measured: 1,904 of 1,907 textures are square, so
    shape carries no information), but the *ranking* inside a bucket is by
    content. Bullets want radial and high-contrast; auras want coverage.
    """
    files = sorted(f for f in os.listdir(TEXTURE_DIR) if f.lower().endswith(".png"))
    if scan_limit:
        files = files[:scan_limit]
    buckets = {"bullet": [], "spark": [], "glow": [], "burst": [], "aura": []}
    rejected = {"tiny": 0, "empty": 0, "full": 0, "unreadable": 0}
    for name in files:
        path = os.path.join(TEXTURE_DIR, name)
        info = score_texture(path)
        if info is None:
            # Cheap re-check only to attribute the rejection, for the report.
            try:
                probe = Image.open(path)
                if min(probe.size) < 16:
                    rejected["tiny"] += 1
                else:
                    rejected["empty"] += 1
            except Exception:
                rejected["unreadable"] += 1
            continue
        long_side = max(info["w"], info["h"])
        if long_side <= 32:
            key = "bullet"
        elif long_side <= 64:
            key = "spark"
        elif long_side <= 128:
            key = "glow"
        elif long_side <= 256:
            key = "burst"
        else:
            key = "aura"
        info["file"] = "site/asset/uniqueskill/texture/" + name
        buckets[key].append(info)

    rank = {
        # A bullet is drawn 8px wide and there may be sixty of them: it has to
        # read as a dot, so centredness dominates.
        "bullet": lambda i: -(i["centred"] * 2.0 + i["contrast"]),
        "spark":  lambda i: -(i["centred"] * 1.5 + i["contrast"]),
        "glow":   lambda i: -(i["centred"] + i["coverage"]),
        "burst":  lambda i: -(i["contrast"] * 1.5 + i["coverage"]),
        "aura":   lambda i: -(i["coverage"] * 1.5 + i["contrast"]),
    }
    out = {}
    for key, items in buckets.items():
        items.sort(key=rank[key])
        out[key] = items[:limit_per_bucket]
    return out, {k: len(v) for k, v in buckets.items()}, rejected


# --- grain, lifted from a real texture ---------------------------------------

def grain_from(path, size):
    """A tiling grey field taken from a texture's alpha channel.

    Using the game's own noise rather than random(): the effect sheets were
    painted, so their alpha has brush structure that random noise does not, and
    it is what makes a flat fill look like a surface instead of a swatch.
    Mirrored into all four quadrants so the result tiles seamlessly.
    """
    im = Image.open(path).convert("RGBA")
    alpha = im.split()[3].resize((size // 2, size // 2), Image.BILINEAR)
    field = Image.new("L", (size, size))
    field.paste(alpha, (0, 0))
    field.paste(alpha.transpose(Image.FLIP_LEFT_RIGHT), (size // 2, 0))
    field.paste(alpha.transpose(Image.FLIP_TOP_BOTTOM), (0, size // 2))
    field.paste(alpha.transpose(Image.ROTATE_180), (size // 2, size // 2))
    return field.filter(ImageFilter.GaussianBlur(1.2))


# --- tiles -------------------------------------------------------------------

def make_tile(kind, palette, grain, blanch):
    """One terrain tile.

    Structure per kind is drawn from what the kind *means* to the platformer, so
    the picture teaches the rule:
      wall    - shelf boards: solid, horizontal, obviously standable
      oneway  - the same boards but with the underside open, drawn as a lip with
                nothing below it, so "you can jump up through this" is visible
      fade    - hatched outline only: present but not yet real, which is what
                blanched terrain is until the lamp is lit
      crystal - faceted and translucent: the ink-bearing surfaces
    """
    base = lighten(desaturate(palette[0]["rgb"], 0.35 + 0.45 * blanch),
                   0.55 + 0.35 * blanch)
    ink = lighten(desaturate(palette[min(2, len(palette) - 1)]["rgb"],
                             0.25 + 0.5 * blanch), 0.15 + 0.5 * blanch)
    im = Image.new("RGBA", (TILE, TILE), base + (255,))
    d = ImageDraw.Draw(im, "RGBA")
    edge = ink + (150,)

    if kind == "wall":
        for y in (0, TILE // 2):
            d.rectangle([0, y, TILE - 1, y + TILE // 2 - 1], outline=edge, width=1)
        # Board seams and a couple of vertical joins: reads as shelving.
        d.line([0, TILE // 2, TILE - 1, TILE // 2], fill=ink + (110,), width=2)
        for x in (TILE // 4, 3 * TILE // 4):
            d.line([x, 0, x, TILE // 2 - 1], fill=ink + (70,), width=1)
        d.line([TILE // 2, TILE // 2, TILE // 2, TILE - 1], fill=ink + (70,), width=1)

    elif kind == "oneway":
        # Top lip only, and a fade downward: the underside is passable.
        d.rectangle([0, 0, TILE - 1, TILE // 5], fill=ink + (190,))
        for y in range(TILE // 5 + 2, TILE, 6):
            fade = int(120 * (1.0 - (y - TILE // 5) / float(TILE)))
            d.line([0, y, TILE - 1, y], fill=ink + (max(0, fade),), width=1)

    elif kind == "fade":
        im = Image.new("RGBA", (TILE, TILE), base + (90,))
        d = ImageDraw.Draw(im, "RGBA")
        # Hatching, not fill: the shape is legible but reads as unfinished.
        for offset in range(-TILE, TILE * 2, 9):
            d.line([offset, 0, offset + TILE, TILE], fill=ink + (60,), width=1)
        d.rectangle([0, 0, TILE - 1, TILE - 1], outline=ink + (110,), width=1)

    elif kind == "crystal":
        im = Image.new("RGBA", (TILE, TILE), lighten(base, 0.25) + (200,))
        d = ImageDraw.Draw(im, "RGBA")
        mid = TILE // 2
        for poly in (
            [(mid, 2), (TILE - 3, mid), (mid, TILE - 3), (2, mid)],
            [(mid, 12), (TILE - 13, mid), (mid, TILE - 13), (12, mid)],
        ):
            d.polygon(poly, outline=ink + (130,))
        d.line([mid, 2, mid, TILE - 3], fill=ink + (60,), width=1)
        d.line([2, mid, TILE - 3, mid], fill=ink + (60,), width=1)

    # Grain last, as a gentle multiply, so every kind shares one surface.
    g = grain.point(lambda v: 200 + v // 5)
    rgb = Image.merge("RGB", im.split()[:3])
    rgb = ImageChops.multiply(rgb, Image.merge("RGB", (g, g, g)))
    return Image.merge("RGBA", rgb.split() + (im.split()[3],))


# --- backdrops ---------------------------------------------------------------

def make_backdrop(source, blanch, layer):
    """A parallax plane derived from an ADV background.

    Three layers per region at different blur and scale. The far plane is blurred
    hard and lightened toward paper so it never competes with the play field;
    the near plane keeps some structure. Cropping is centred and aspect-correct,
    which is also the bug that produced the black bars in the ADV: a 1:1 picture
    in a 16:9 frame has to be cropped or it leaves gaps.
    """
    sw, sh = source.size
    target_ratio = BACKDROP[0] / float(BACKDROP[1])
    # Zoom in for nearer layers, so the three planes do not move as one sheet.
    zoom = (1.0, 1.25, 1.6)[layer]
    # Aspect-correct means the crop's ratio equals the target's. Clamping the
    # WIDTH to the source breaks that: both plates are narrower than 16:9
    # (1600x1280 is 1.25, 1600x1600 is 1.00), so `min(sw, crop_h * ratio)` used
    # to return sw and leave the crop at the source's own ratio, which resize()
    # then stretched sideways.
    #
    # Measured stretch on the old code: library layer 0 +42%, layer 1 +14%;
    # library-outside layer 0 +78%, layer 1 +42%. The shelves in the far plane
    # were flattened by nearly half again their width. Only layer 2 of `library`
    # came out honest, which is why this read as "the backdrop looks soft"
    # rather than as an obvious bug.
    #
    # Fix: pick whichever axis actually binds and derive the other from it.
    crop_h = min(sh, int(sh / zoom))
    crop_w = int(crop_h * target_ratio)
    if crop_w > sw:
        crop_w = sw
        crop_h = int(crop_w / target_ratio)
    left = (sw - crop_w) // 2
    top = int((sh - crop_h) * 0.42)     # slightly above centre: shelves, not floor
    im = source.crop((left, top, left + crop_w, top + crop_h)).resize(
        BACKDROP, Image.LANCZOS)

    # Blur scaled to the plate: these were tuned at 512 px wide, and a Gaussian
    # radius is in pixels, so keeping 7.0 at 1024 would blur twice as far into
    # the picture and undo the resolution.
    scale = BACKDROP[0] / 512.0
    blur = (7.0, 4.0, 2.0)[layer] * scale
    im = im.filter(ImageFilter.GaussianBlur(blur))

    # Drain colour with depth and with the region's blanch level.
    wash = (0.72, 0.55, 0.38)[layer] + 0.2 * blanch
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            r, g, b = desaturate((r, g, b), min(0.95, wash))
            px[x, y] = lighten((r, g, b), min(0.9, wash * 0.75))
    return im.convert("RGB")


# --- driver ------------------------------------------------------------------

def build(check=False, scan_limit=0):
    if not os.path.isdir(TEXTURE_DIR):
        print("missing %s" % TEXTURE_DIR)
        return 2

    library = Image.open(os.path.join(BG_DIR, "library.webp"))
    palette = kmeans_palette(library)
    print("palette from asset/story/background/library.webp")
    for entry in palette:
        print("    #%02x%02x%02x  %4.1f%%" % (entry["rgb"][0], entry["rgb"][1],
                                              entry["rgb"][2], 100 * entry["share"]))

    sprites, found, rejected = pick_sprites(scan_limit=scan_limit)
    print()
    print("effect library: scanned %d, rejected %d (tiny %d, empty-or-full %d, "
          "unreadable %d)"
          % (sum(found.values()) + sum(rejected.values()), sum(rejected.values()),
             rejected["tiny"], rejected["empty"], rejected["unreadable"]))
    for key in SPRITE_ROLES:
        items = sprites[key]
        if not items:
            print("    %-7s none usable" % key)
            continue
        best = items[0]
        print("    %-7s %3d usable, keeping %2d; best %dx%d coverage %.2f "
              "centred %.2f contrast %.2f"
              % (key, found[key], len(items), best["w"], best["h"],
                 best["coverage"], best["centred"], best["contrast"]))

    # Grain source: the highest-contrast glow, which is painted brushwork.
    grain_src = os.path.join(ROOT, sprites["glow"][0]["file"]) if sprites["glow"] \
        else os.path.join(ROOT, sprites["aura"][0]["file"])
    grain = grain_from(grain_src, TILE)

    if not check:
        os.makedirs(OUT_DIR, exist_ok=True)

    written = {}
    tiles = {}
    # Two blanch variants per kind rather than five: the stage already tints at
    # runtime, so the art only has to bracket the range.
    #
    # Tiles stay lossless: they are 64px, they tile, and a lossy edge would show
    # as a seam repeated across the whole room. Backdrops go lossy -- they are
    # blurred by construction, so quality 80 costs nothing visible and the 24 of
    # them are the entire weight of this directory.
    for kind in ("wall", "oneway", "fade", "crystal"):
        for level, blanch in (("0", 0.0), ("1", 0.75)):
            name = "tile-%s-%s.webp" % (kind, level)
            tiles.setdefault(kind, []).append("art/" + name)
            if check:
                continue
            image = make_tile(kind, palette, grain, blanch)
            path = os.path.join(OUT_DIR, name)
            image.save(path, "WEBP", lossless=True, method=6)
            written[name] = os.path.getsize(path)

    # The chosen sprite for each role, copied into asset/mv/art/ at the size it
    # is actually drawn. Three reasons not to point the game at the originals:
    #
    #   1. asset/uniqueskill/ belongs to another workstream and is read-only to
    #      this one. A game that loads from it is a game that breaks when that
    #      tree is regenerated.
    #   2. The originals are up to 512x512 and 207 KiB. A bullet is drawn about
    #      8 px across; the top aura alone outweighs every tile and backdrop in
    #      this directory put together.
    #   3. Scoring picked them out of 1,907 candidates. Copying the winner is
    #      what makes that choice reproducible without re-scanning 163 MB.
    sprite_files = {}
    for role in SPRITE_ROLES:
        items = sprites.get(role) or []
        if not items:
            continue
        name = "fx-%s.webp" % role
        sprite_files[role] = "art/" + name
        if check:
            continue
        source = Image.open(os.path.join(ROOT, items[0]["file"])).convert("RGBA")
        source = crop_to_content(source)
        size = SPRITE_SIZE[role]
        if source.width != size or source.height != size:
            source = source.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, name)
        # Lossy would ring around the bright core, and these are tiny anyway.
        source.save(path, "WEBP", lossless=True, method=6)
        written[name] = os.path.getsize(path)

    backdrops = {}
    sources = {}
    for region, blanch, bg in REGIONS:
        if bg not in sources:
            sources[bg] = Image.open(os.path.join(BG_DIR, bg + ".webp")).convert("RGB")
        planes = []
        for layer in range(3):
            name = "bd-%s-%d.webp" % (region, layer)
            planes.append("art/" + name)
            if check:
                continue
            image = make_backdrop(sources[bg], blanch, layer)
            path = os.path.join(OUT_DIR, name)
            image.save(path, "WEBP", quality=80, method=6)
            written[name] = os.path.getsize(path)
        backdrops[region] = planes

    index = {
        "version": 1,
        "generator": "tools/build_mv_art.py",
        "note": "Derived from the game's own art: palette and backdrops from "
                "site/asset/story/background/, grain and sprites from "
                "site/asset/uniqueskill/texture/ (read-only).",
        "tile": TILE,
        "backdropSize": list(BACKDROP),
        "palette": palette,
        "tiles": tiles,
        "backdrops": backdrops,
        # What the game loads: one file per role, in asset/mv/art/.
        "fx": sprite_files,
        "fxSize": SPRITE_SIZE,
        # What it was chosen from, kept for review. The paths point into the
        # read-only source tree and are not fetched at runtime.
        "sprites": sprites,
    }
    if not check:
        with open(OUT_INDEX, "w", encoding="utf-8") as handle:
            json.dump(index, handle, ensure_ascii=False, indent=1, sort_keys=True)

    total = sum(written.values())
    print()
    if check:
        print("--check: would write %d tiles + %d backdrops and %s"
              % (sum(len(v) for v in tiles.values()),
                 sum(len(v) for v in backdrops.values()),
                 os.path.relpath(OUT_INDEX, ROOT).replace("\\", "/")))
        return 0
    print("wrote %d files into asset/mv/art/ (%.1f KiB), index %.1f KiB"
          % (len(written), total / 1024.0,
             os.path.getsize(OUT_INDEX) / 1024.0))
    biggest = sorted(written.items(), key=lambda kv: -kv[1])[:3]
    for name, size in biggest:
        print("    %-22s %6.1f KiB" % (name, size / 1024.0))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--scan-limit", type=int, default=0,
                        help="score only the first N textures (for a fast run)")
    args = parser.parse_args()
    return build(check=args.check, scan_limit=args.scan_limit)


if __name__ == "__main__":
    sys.exit(main())
