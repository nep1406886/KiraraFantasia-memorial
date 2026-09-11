#!/usr/bin/env python3
"""Derive 《乱丁の迷宮》's floor, wall and obstacle art from the art the game has.

plans/labyrinth.md §4.4. The repo owns no top-down tiles and no room art at all
-- 1,907 effect textures, two story backgrounds, ten shutdown pictures. So the
same route as 白紙の書架 (tools/build_mv_art.py): take the palette out of
asset/story/background/library.webp, borrow grain from a real effect texture,
and composite the tiles.

Three things are deliberately different from the Metroidvania's builder:

  **Per volume, not per blanch level.** F's five 巻 each carry a paletteShift
  (asset/lb/volumes.js), so the tint is a property of the book being rebound,
  not of a runtime lamp state. core/lbstage.js swaps the map when the run
  starts; nothing tints at draw time, which is why the shift has to be baked.

  **Four floor surfaces, assigned by what the volume is about.** §4.4 asks for
  石・板・紙・水. Assigning them by volume rather than at random is what makes
  the floor say which book you are in: きんいろモザイク gets the mosaic stone,
  うらら迷路帖 the divining water. See SURFACES.

  **One backdrop, not 24.** This file used to say "no backdrops -- the floor
  *is* the backdrop", and that was wrong in a way nothing failed on. The room is
  20x12 tiles flattened by cos55 degrees, so it draws at about 2.9:1 against a
  1.78:1 window; showing the full width necessarily leaves vertical slack, and
  the slack was showing game/laby.html's #14110f through a transparent canvas --
  measured at 31.7% of frame height, a near-black band across the top and
  bottom. So there IS a far surface, just not a parallaxing one: SURROUND, one
  tile per volume, dark and coarse, drawn behind the floor by core/lbstage.js.
  Still no 24 files -- E's are per blanch level and per layer, and none of that
  applies to an orthographic camera.

Bullets are reused, not rebuilt: §4.4 says so outright, and it is right --
asset/mv/art/fx-bullet.webp was already scored out of the same 1,907 candidates
and cropped. Copied rather than referenced across, because core/lbstage.js
resolves art paths under asset/lb/art/ and a game that reaches into another
game's directory breaks when that one is regenerated.

Writes asset/lb/art/ (WEBP, tracked) plus asset/lb/art.json.

Usage:
    python tools/build_lb_art.py
    python tools/build_lb_art.py --check
"""

from __future__ import annotations

import argparse
import colorsys
import json
import os
import random
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
except ImportError:
    print("needs Pillow: python -m pip install Pillow")
    sys.exit(2)

# Reused rather than copied. kmeans_palette / lighten / desaturate / grain_from
# are already measured and commented over there, and two drifting copies of a
# palette extractor would give E and F different colours from one source file.
import build_mv_art as mva

BG = os.path.join(ROOT, "asset", "story", "background", "library.webp")
VOLUMES_JS = os.path.join(ROOT, "asset", "lb", "volumes.js")
MV_ART = os.path.join(ROOT, "asset", "mv", "art")
OUT_DIR = os.path.join(ROOT, "asset", "lb", "art")
OUT_INDEX = os.path.join(ROOT, "asset", "lb", "art.json")

TILE = 64          # one tile of the 20x12 room, matching core/lbstage.js UNIT
SEED = 20260831

# Which surface each 巻 gets, and why. §4.4 lists 石・板・紙・水; five volumes
# over four surfaces means one repeats, and 紙 is the right one to repeat --
# V3 is stacked printouts at sat 0.80 and V5 is 白紙 at sat 0.28, so they read
# as opposite ends of the same material rather than as the same floor twice.
SURFACES = {
    1: "board",   # きららファンタジア -- the library's own floorboards
    2: "stone",   # きんいろモザイク -- モザイク is the mosaic, literally
    3: "paper",   # NEW GAME! -- 納期 and 積の綴じ, printouts underfoot
    4: "water",   # うらら迷路帖 -- 占 reads a reflection
    5: "paper",   # がっこうぐらし！ -- 終の綴じ, drained to near white
}

# The floor is the largest flat area on screen and the hero has to read against
# it, so it is held pale and low-contrast; walls and obstacles carry the
# structure. These are multipliers into lighten(), measured by eye against a
# 48px hero at 1280 wide.
FLOOR_LIGHT = 0.62
WALL_LIGHT = 0.16
OBSTACLE_LIGHT = 0.34

# The surround is darker than the wall on purpose. The wall is the edge of what
# you can walk on and has to stay the darkest thing *inside* the frame; if the
# outside were lighter, the room would read as a bright hole in a pale field and
# the wall band would stop meaning "stop here".
#
# 0.03 against the wall's 0.16, and the first attempt at 0.09 was too close. On
# #27183d, lighten(0.09) is luminance 0.204 and lighten(0.16) is 0.263 -- once
# the tiles' own grain and shelf bands averaged in, 第一冊 measured a gap of
# 0.024, which passes an ordering check and is invisible. 0.03 puts the base at
# 0.154 and opens the gap to something the eye can use.
SURROUND_LIGHT = 0.03

# How much of the volume's blanch wash reaches the outside. See volume_colours.
SURROUND_WASH = 0.5


# --- the volume table, read out of the JS ------------------------------------

def read_volumes():
    """[{id, whiteness, hue, sat}] from asset/lb/volumes.js.

    Parsed rather than duplicated. The alternative is a second copy of the table
    in Python, and then the tint the art is baked with and the tint the game
    thinks it asked for can disagree with nothing to catch it -- there is no
    runtime tinting here, so a mismatch would just be a wrong-coloured floor
    that looks deliberate.
    """
    with open(VOLUMES_JS, encoding="utf-8") as fh:
        source = fh.read()
    out = []
    # Anchored on the three fields this file needs, in the order volumes.js
    # writes them. A reordering breaks the match loudly rather than silently
    # pairing volume 1's id with volume 2's shift.
    for block in re.finditer(
            r"\bid:\s*(\d+),\s*titleId:.*?"
            r"\bwhiteness:\s*([0-9.]+).*?"
            r"\bpaletteShift:\s*\{\s*hue:\s*(-?[0-9.]+),\s*sat:\s*([0-9.]+)\s*\}",
            source, re.S):
        out.append({"id": int(block.group(1)),
                    "whiteness": float(block.group(2)),
                    "hue": float(block.group(3)),
                    "sat": float(block.group(4))})
    return out


def shift(rgb, hue_deg, sat_mul):
    """Rotate hue and scale saturation, in HLS.

    Not a channel mix: rotating in RGB moves lightness too, so volume 3's 200
    degrees would also darken the floor and the whiteness ladder would stop
    being monotonic.
    """
    r, g, b = (c / 255.0 for c in rgb)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    h = (h + hue_deg / 360.0) % 1.0
    s = max(0.0, min(1.0, s * sat_mul))
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return (int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))


# --- seamlessness -------------------------------------------------------------

def seamless(paint, background=None):
    """Run a tile painter nine times on a 3x canvas and keep the middle.

    Every tile here is drawn with RepeatWrapping (core/lbstage.js tile()), and
    the floor repeats 20x12 times across one room, so a seam is not a hairline
    -- it is a grid of 240 hairlines, which reads as a defect rather than as a
    surface. A primitive that crosses the tile edge has to appear on the other
    side, and the cheapest way to guarantee that for *any* pattern is to let the
    neighbouring copies draw it and then crop the middle out.

    paint(draw, ox, oy) draws one tile's worth at the given offset.
    """
    big = Image.new("RGBA", (TILE * 3, TILE * 3),
                    (background + (255,)) if background else (0, 0, 0, 0))
    d = ImageDraw.Draw(big, "RGBA")
    for oy in (0, TILE, TILE * 2):
        for ox in (0, TILE, TILE * 2):
            paint(d, ox, oy)
    return big.crop((TILE, TILE, TILE * 2, TILE * 2))


def apply_grain(image, grain, floor=196, span=5):
    """Multiply a grain field over a tile's RGB, leaving alpha alone.

    Alpha has to survive: the obstacle tile is drawn on transparent and the
    grain field is opaque everywhere, so merging it into all four channels
    would turn every tile into a full square.
    """
    g = grain.point(lambda v: floor + v // span)
    rgb = Image.merge("RGB", image.split()[:3])
    rgb = ImageChops.multiply(rgb, Image.merge("RGB", (g, g, g)))
    return Image.merge("RGBA", rgb.split() + (image.split()[3],))


# --- floors -------------------------------------------------------------------

def floor_board(base, line, rng):
    """Planks, seen from above. Seams run across the short axis.

    Offsetting the vertical joins per plank row is what stops a 20x12 field of
    this from reading as a waffle grid: joins that line up column-to-column turn
    two seam directions into one lattice.

    **Nothing is drawn on the tile boundary.** The plank seams sit at y=16 and
    y=48, a quarter in from each edge, so the wrap lands on bare material. Put a
    seam at y=0 instead and the spacing is still uniform when tiled -- but the
    tile then has exactly one strong line and it is at the edge, which is
    indistinguishable from a hairline defect, and tools/check_lb_art.py measured
    the first version of this at 11x its own internal contrast.
    """
    def paint(d, ox, oy):
        for row, y0 in ((0, TILE // 4), (1, TILE // 4 + TILE // 2)):
            y = oy + y0
            d.line([ox, y, ox + TILE, y], fill=line + (120,), width=1)
            # One join per plank, pushed off-centre by row so the two planks of
            # a tile never share an x. seamless() draws the copy that carries
            # the part running past the tile edge.
            jx = ox + (TILE // 3 if row == 0 else 2 * TILE // 3)
            d.line([jx, y, jx, y + TILE // 2], fill=line + (85,), width=1)
    return paint


def floor_stone(base, line, rng):
    """Mosaic: a jittered 4x4 of tesserae with grout between.

    Jitter is seeded and applied to the *cell*, not to the vertex, so the cell
    at x=0 and the cell at x=TILE get the same offset and the grout lines up
    across the tile edge.
    """
    cell = TILE // 4
    jitter = [[(rng.randrange(-2, 3), rng.randrange(-2, 3)) for _ in range(4)]
              for _ in range(4)]

    def paint(d, ox, oy):
        for gy in range(4):
            for gx in range(4):
                dx, dy = jitter[gy][gx]
                x0 = ox + gx * cell + dx
                y0 = oy + gy * cell + dy
                d.rectangle([x0 + 1, y0 + 1, x0 + cell - 2, y0 + cell - 2],
                            outline=line + (105,), width=1)
    return paint


def floor_paper(base, line, rng):
    """Sheets: a faint rule and a single sheet edge. Almost nothing.

    Deliberately the quietest of the four. 紙 is the surface two volumes share,
    including 白紙 at sat 0.28, and any structure strong enough to read at sat
    0.28 is far too loud at 0.80.
    """
    def paint(d, ox, oy):
        for i in range(1, 4):
            y = oy + i * (TILE // 4)
            d.line([ox, y, ox + TILE, y], fill=line + (34,), width=1)
        # The sheet's own edge, one per tile, with a hint of lift under it.
        # Placed a third in, for the reason floor_board's註 gives: on the
        # boundary it is the tile's only strong line and reads as a seam (the
        # first version measured 15x internal contrast).
        ex = ox + TILE // 3
        d.line([ex, oy, ex, oy + TILE], fill=line + (60,), width=1)
        d.line([ex + 1, oy, ex + 1, oy + TILE], fill=line + (22,), width=1)
    return paint


def floor_water(base, line, rng):
    """Still water: concentric rings, off-centre, plus a horizon glint.

    Rings rather than a sine field because the ring is what says "reflective and
    shallow" at 8px on screen; a caustic pattern needs more pixels than a tile
    of this size has to read as anything but noise.
    """
    cx, cy = TILE * 0.34, TILE * 0.58

    def paint(d, ox, oy):
        for r in (7, 14, 22, 30):
            d.ellipse([ox + cx - r, oy + cy - r * 0.86,
                       ox + cx + r, oy + cy + r * 0.86],
                      outline=line + (max(18, 74 - r * 2),), width=1)
        d.line([ox, oy + TILE * 0.22, ox + TILE, oy + TILE * 0.22],
               fill=line + (30,), width=1)
    return paint


FLOOR_PAINTERS = {"board": floor_board, "stone": floor_stone,
                  "paper": floor_paper, "water": floor_water}


# --- wall and obstacle --------------------------------------------------------

# The wall tile is seen through two different UV slices and has to read in both.
#
# core/lbstage.js foldBoxes() writes UV in tile units, and the wall bands are
# UNIT * 0.7 thick, so the horizontal bands (north/south) show the bottom 70% of
# the texture stretched over ~21 repeats across, while the vertical bands
# (east/west) show the *left* 70% over 12 repeats down. One texture, two crops at
# right angles. So the pattern is kept roughly isotropic -- a design that only
# works read one way (spines running with the wall, say) turns the other two
# walls into stripes with no meaning.
def wall_books(base, line, rng, edge):
    block = TILE // 4
    widths = [rng.randrange(block - 4, block + 1) for _ in range(4)]

    def paint(d, ox, oy):
        for row in range(2):
            y = oy + row * (TILE // 2)
            x = ox
            for col in range(4):
                w = widths[(col + row * 2) % 4]
                d.rectangle([x + 1, y + 2, x + w - 2, y + TILE // 2 - 3],
                            fill=base + (255,), outline=line + (190,), width=1)
                # Page edge: one bright line inside the book top. This is the
                # detail that survives a 70% crop from either direction.
                d.line([x + 3, y + 4, x + 3, y + TILE // 2 - 5],
                       fill=edge + (160,), width=1)
                x += block
    return paint


def surround_shelves(base, line, rng):
    """The room's outside: shelf rows too far off to read, seen from above.

    Deliberately the lowest-contrast tile in the file. It covers more of the
    frame than anything else (core/lbstage.js draws it 8000 world units across
    against the room's 960), so any detail sharp enough to notice becomes a
    pattern the eye tracks instead of tracking the hero. Two amplitudes only:
    the band, and one gap line per band. No page edges, no grain highlights.

    Drawn at 1/4 the tile's frequency because core/lbstage.js repeats it 48
    times over that plane -- about 3.5 room tiles per texture tile -- so what is
    a quarter here lands at roughly one room tile on screen.
    """
    rows = 4
    step = TILE // rows
    # Alternating shelf depth. Constant rows would make the whole outside a
    # regular grid, which is exactly the thing that starts pulling the eye.
    depths = [rng.uniform(0.55, 0.85) for _ in range(rows)]

    def paint(d, ox, oy):
        for row in range(rows):
            y = oy + row * step
            band = mva.lighten(base, 0.05 * depths[row])
            d.rectangle([ox, y, ox + TILE - 1, y + step - 2], fill=band + (255,))
            # The gap between two shelf runs. One line, at 22% alpha -- enough
            # to say "there is structure out there", not enough to count.
            d.line([ox, y + step - 1, ox + TILE - 1, y + step - 1],
                   fill=line + (56,), width=1)
    return paint


def obstacle_stack(base, line, rng, edge):
    """A pile of books from above: nested rectangles, each offset a little.

    Not centred rings -- a stack nobody straightened is what a 積の綴じ looks
    like, and the offset is also what makes the pile read as having height under
    a camera that cannot show height (§6.2 is orthographic, 55 degrees).
    """
    def paint(d, ox, oy):
        inset = 2
        step = 0
        for i in range(3):
            dx = (-2, 3, -1)[i]
            dy = (2, -2, 3)[i]
            d.rectangle([ox + inset + dx, oy + inset + dy,
                         ox + TILE - inset - 1 + dx, oy + TILE - inset - 1 + dy],
                        fill=mva.lighten(base, 0.06 * i) + (255,),
                        outline=line + (175,), width=1)
            # The page block, along one side only, so the spine direction is
            # legible and the three books do not all face the same way.
            sx = ox + inset + dx + (3 if i % 2 == 0 else TILE - inset * 2 - 5)
            d.line([sx, oy + inset + dy + 3,
                    sx, oy + TILE - inset - 4 + dy], fill=edge + (150,), width=1)
            inset += 6
            step += 1
    return paint


# --- driver -------------------------------------------------------------------

def volume_colours(palette, vol):
    """The four colours one volume's tiles are built from.

    Whiteness enters as *lightening*, saturation as the volume's own multiplier.
    Kept separate because they answer different questions: sat says which book
    this is, whiteness says how far gone it is, and folding them into one number
    would make volume 3 (hue 200, sat 0.80, whiteness 2) indistinguishable from
    a hypothetical washed-out volume of the same hue.
    """
    wash = 0.10 * vol["whiteness"]
    def take(index, light, wash_mul=1.0):
        rgb = palette[min(index, len(palette) - 1)]["rgb"]
        return mva.lighten(shift(rgb, vol["hue"], vol["sat"]),
                           light + wash * wash_mul)
    return {
        # 1 is the pale cluster in library.webp (#e6dbf1, 21.9%): paper.
        "floor": take(1, FLOOR_LIGHT),
        # 0 is the dark cluster (#27183d, 23.1%): the shelves in shadow.
        "wall": take(0, WALL_LIGHT),
        "obstacle": take(2, OBSTACLE_LIGHT),
        # Same cluster as the wall, lightened less. Sharing the cluster is what
        # makes the outside read as more of the same room rather than as a
        # different material behind it.
        #
        # Half the wash, and that is not a taste call. At full wash the outside
        # and the wall are lightened by the same amount on top of a 0.07 starting
        # gap, and by 第三冊 (whiteness 2) they measured 0.417 against 0.435 --
        # ordered correctly, indistinguishable by eye. The wash means "how far
        # this book has been blanched", and the outside is not the book: it is the
        # 書架 the book sits in, so it should lag.
        "surround": take(0, SURROUND_LIGHT, SURROUND_WASH),
        # Lines are drawn from the darkest cluster regardless of surface, so the
        # ink is one ink across the whole volume.
        "line": take(0, wash * 0.5),
    }


def build(check=False):
    for path in (BG, VOLUMES_JS):
        if not os.path.exists(path):
            print("missing %s" % os.path.relpath(path, ROOT))
            return 2

    volumes = read_volumes()
    if len(volumes) != len(SURFACES):
        print("site/asset/lb/volumes.js has %d volumes, SURFACES covers %d -- a new "
              "volume needs a surface, or its floor silently reuses another's"
              % (len(volumes), len(SURFACES)))
        return 2

    palette = mva.kmeans_palette(Image.open(BG))
    print("palette from asset/story/background/library.webp")
    for entry in palette:
        print("    #%02x%02x%02x  %4.1f%%"
              % (entry["rgb"][0], entry["rgb"][1], entry["rgb"][2],
                 100 * entry["share"]))

    # Grain from the effect texture the Metroidvania already scored highest for
    # brushwork. Reading E's copy rather than rescanning 1,907 files in
    # asset/uniqueskill/texture/, which is read-only to this workstream anyway.
    grain_src = os.path.join(MV_ART, "fx-glow.webp")
    if not os.path.exists(grain_src):
        print("missing %s -- run tools/build_mv_art.py first"
              % os.path.relpath(grain_src, ROOT))
        return 2
    grain = mva.grain_from(grain_src, TILE)

    if not check:
        os.makedirs(OUT_DIR, exist_ok=True)

    tiles = {"floor": [], "wall": [], "obstacle": [], "surround": []}
    volume_index = {}
    surfaces = {}
    written = {}

    for slot, vol in enumerate(volumes):
        volume_index[str(vol["id"])] = slot
        surface = SURFACES[vol["id"]]
        surfaces[str(vol["id"])] = surface
        colours = volume_colours(palette, vol)
        names = {"floor": "tile-floor-v%d.webp" % vol["id"],
                 "wall": "tile-wall-v%d.webp" % vol["id"],
                 "obstacle": "tile-obstacle-v%d.webp" % vol["id"],
                 "surround": "tile-surround-v%d.webp" % vol["id"]}
        for kind in ("floor", "wall", "obstacle", "surround"):
            tiles[kind].append("art/" + names[kind])
        if check:
            continue

        rng = random.Random(SEED + vol["id"])
        edge = mva.lighten(colours["floor"], 0.35)

        image = seamless(FLOOR_PAINTERS[surface](
            colours["floor"], colours["line"], rng), colours["floor"])
        # The floor carries the most grain of the three: it is the biggest flat
        # area and the one a vector-flat fill shows on.
        image = apply_grain(image, grain, floor=190, span=4)
        save(image, names["floor"], written, check)

        image = seamless(wall_books(colours["wall"], colours["line"], rng, edge),
                         colours["wall"])
        image = apply_grain(image, grain, floor=206, span=6)
        save(image, names["wall"], written, check)

        # The narrowest grain span in the file (floor 222, span 3). This tile is
        # magnified ~3.5x on screen, so grain that reads as tooth on a room tile
        # reads as blotches out here.
        image = seamless(surround_shelves(colours["surround"], colours["line"],
                                          rng), colours["surround"])
        image = apply_grain(image, grain, floor=222, span=3)
        save(image, names["surround"], written, check)

        # Obstacles are drawn on transparent: core/lbstage.js gives the mesh a
        # map and turns the colour white, so a pile that fills its whole tile
        # would square off the corners of every book stack in the room.
        image = seamless(obstacle_stack(colours["obstacle"], colours["line"],
                                        rng, edge))
        image = apply_grain(image, grain, floor=206, span=6)
        save(image, names["obstacle"], written, check)

    # §4.4: reuse E's bullet rather than rebuild it.
    bullet_src = os.path.join(MV_ART, "fx-bullet.webp")
    fx = {}
    if os.path.exists(bullet_src):
        fx["bullet"] = "art/fx-bullet.webp"
        if not check:
            dest = os.path.join(OUT_DIR, "fx-bullet.webp")
            shutil.copyfile(bullet_src, dest)
            written["fx-bullet.webp"] = os.path.getsize(dest)

    index = {
        "version": 1,
        "generator": "tools/build_lb_art.py",
        "note": "Derived from asset/story/background/library.webp (palette) and "
                "site/asset/mv/art/fx-glow.webp (grain). One tile set per volume of "
                "site/asset/lb/volumes.js; core/lbstage.js picks by volumeIndex. "
                "fx-bullet is E's, reused per plans/labyrinth.md §4.4.",
        "tile": TILE,
        "palette": palette,
        "tiles": tiles,
        # volumeId -> index into each tiles[] array. A map rather than "the id
        # minus one": nothing forces volume ids to stay 1..5 contiguous, and an
        # off-by-one here paints the whole run in the wrong book's colours
        # without failing.
        "volumeIndex": volume_index,
        "surfaces": surfaces,
        "fx": fx,
        # What the room is measured in, so a reader can check the repeat counts
        # in core/lbstage.js against the file rather than against a comment.
        "roomTiles": [20, 12],
    }
    if not check:
        with open(OUT_INDEX, "w", encoding="utf-8") as fh:
            json.dump(index, fh, ensure_ascii=False, indent=1, sort_keys=True)

    print()
    for vol in volumes:
        print("    volume %d  %-6s hue %+4.0f sat %.2f whiteness %.0f"
              % (vol["id"], SURFACES[vol["id"]], vol["hue"], vol["sat"],
                 vol["whiteness"]))
    print()
    if check:
        print("--check: would write %d tiles + %d fx and %s"
              % (sum(len(v) for v in tiles.values()), len(fx),
                 os.path.relpath(OUT_INDEX, ROOT).replace("\\", "/")))
        return 0
    total = sum(written.values())
    print("wrote %d files into asset/lb/art/ (%.1f KiB), index %.1f KiB"
          % (len(written), total / 1024.0, os.path.getsize(OUT_INDEX) / 1024.0))
    for name, size in sorted(written.items(), key=lambda kv: -kv[1])[:3]:
        print("    %-24s %5.1f KiB" % (name, size / 1024.0))
    return 0


def save(image, name, written, check):
    if check:
        return
    path = os.path.join(OUT_DIR, name)
    # Lossless. These are 64px and they tile: a lossy edge shows up as a seam
    # repeated 240 times across one room floor, which is the one artefact this
    # whole file's seamless() exists to avoid.
    image.save(path, "WEBP", lossless=True, method=6)
    written[name] = os.path.getsize(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    return build(check=args.check)


if __name__ == "__main__":
    sys.exit(main())
