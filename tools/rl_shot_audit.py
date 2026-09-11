# Pixel-level audit of the T21c room screenshots (1280x800 viewport).
# The image-read path in this session proxies to a CDN instead of rendering,
# so visual verification is done numerically: block grid of luminance /
# saturation, fog washout extent, and prop coverage (hue variety, contrast).
# Usage: python tools/rl_shot_audit.py shot_t21c_battle.png [more.png ...]
import colorsys
import statistics
import sys

from PIL import Image


def block_stats(img, n=10):
    w, h = img.size
    sw, sh = w // n, h // n
    for by in range(n):
        for bx in range(n):
            crop = img.crop((bx * sw, by * sh, (bx + 1) * sw, (by + 1) * sh))
            px = list(crop.getdata())
            npx = len(px)
            r = sum(p[0] for p in px) / npx
            g = sum(p[1] for p in px) / npx
            b = sum(p[2] for p in px) / npx
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            mx, mn = max(r, g, b), min(r, g, b)
            sat = 0.0 if mx == 0 else (mx - mn) / mx
            yield bx, by, lum, sat


def uniq_hues(crop):
    buckets = set()
    tot = 0
    for p in crop.getdata():
        mx, mn = max(p), min(p)
        if mx == 0 or (mx - mn) / mx < 0.15:
            continue  # neutral: ground/haze, not a prop colour
        h = int(colorsys.rgb_to_hsv(p[0] / 255, p[1] / 255, p[2] / 255)[0] * 24)
        buckets.add(h)
        tot += 1
    return len(buckets), tot


def contrast(crop):
    lums = [0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] for p in crop.getdata()]
    return statistics.pstdev(lums)


def report(path):
    img = Image.open(path).convert("RGB")
    w, h = img.size
    print("== %s (%dx%d)" % (path, w, h))
    stats = list(block_stats(img))
    print("lum grid (sat%% in brackets), row 0 = screen top:")
    for by in range(10):
        cells = {bx: (lum, sat) for bx, by2, lum, sat in stats if by2 == by}
        print("  y%-2d %s" % (by, " ".join(
            "%3d[%02d]" % (round(cells[bx][0]), round(cells[bx][1] * 99))
            for bx in range(10))))
    washed = [c for c in stats if c[2] > 170 and c[3] < 0.18]
    print("washed blocks (lum>170 sat<0.18): %d/100" % len(washed))
    if washed:
        print("  spread: x %d-%d y %d-%d" % (
            min(c[0] for c in washed), max(c[0] for c in washed),
            min(c[1] for c in washed), max(c[1] for c in washed)))
    top = img.crop((0, 0, w, int(h * 0.25)))       # far wall + border props
    mid = img.crop((int(w * 0.25), int(h * 0.35), int(w * 0.75), int(h * 0.85)))
    for name, band in (("top-quarter", top), ("centre", mid)):
        hues, px = uniq_hues(band)
        print("%s: hue buckets %d/24, saturated px %d, lum stdev %.1f" % (
            name, hues, px, contrast(band)))


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)
