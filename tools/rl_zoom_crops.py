# Zoom evidence for the two live-reported defect classes:
#   (a) feet partially occluded by terrain  (b) head pieces missing / seams off
# The sweep PNGs are already cropped to the unit bbox + 30px margin, so
# proportional strips are enough: head = top 55%, feet = bottom 35%.
# Each strip is upscaled x3 and tiled M|F side by side for review.
# Usage: python tools/rl_zoom_crops.py pl_300001,pl_280001,...  [head|feet|both]
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "sweep" / "zoom"
OUT.mkdir(parents=True, exist_ok=True)

HEAD_FRAC = 0.55
FEET_FRAC = 0.35
SCALE = 3


def strip(im, which):
    h = im.height
    if which == "head":
        return im.crop((0, 0, im.width, int(h * HEAD_FRAC)))
    return im.crop((0, int(h * (1 - FEET_FRAC)), im.width, h))


def pair(label, which):
    imgs = []
    for st in ("M", "F"):
        p = ROOT / ".cache" / "sweep" / ("%s__%s.png" % (label, st))
        if not p.exists():
            return None
        imgs.append((strip(Image.open(p).convert("RGB"), which), st))
    w = max(im.width for im, _ in imgs) * SCALE
    h = max(im.height for im, _ in imgs) * SCALE
    canvas = Image.new("RGB", (w * 2 + 12, h + 26), "white")
    dr = ImageDraw.Draw(canvas)
    for i, (im, st) in enumerate(imgs):
        big = im.resize((im.width * SCALE, im.height * SCALE), Image.LANCZOS)
        dr.text((i * (w + 12) + 4, 2), "%s %s" % (label, st), fill="black")
        canvas.paste(big, (i * (w + 12), 24))
    dest = OUT / ("%s_%s.png" % (label, which))
    canvas.save(dest)
    return dest


def main() -> int:
    labels = [s for s in
              (sys.argv[1] if len(sys.argv) > 1 else "").split(",") if s]
    which = sys.argv[2] if len(sys.argv) > 2 else "both"
    kinds = ("head", "feet") if which == "both" else (which,)
    for label in labels:
        for kind in kinds:
            dest = pair(label, kind)
            print("%-28s %s" % (dest.name if dest else "MISSING " + label,
                                "ok" if dest else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
