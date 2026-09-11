from pathlib import Path

import cv2
import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parent
IMAGE_DIR = ROOT / "imgs" / "kiraraOP"
SOURCE = IMAGE_DIR / "Fpf8XLeX0AM1btW.jpg"
OUT_DIR = IMAGE_DIR / "milestones_3000_10000"

# These local sheets contain the lettering style already approved for this image.
DIGIT_SHEETS = {
    "1234": IMAGE_DIR / "Gemini_Generated_Image_m803e5m803e5m803.png",
    "5678": IMAGE_DIR / "Gemini_Generated_Image_wamwatwamwatwamw.png",
    "9": IMAGE_DIR / "Gemini_Generated_Image_e3ahsne3ahsne3ah.png",
    "0": IMAGE_DIR / "Gemini_Generated_Image_m58hijm58hijm58h.png",
}


def yellow_components(image: Image.Image) -> list[tuple[np.ndarray, tuple[int, int, int, int]]]:
    rgb = np.array(image.convert("RGB"))
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    yellow = cv2.inRange(hsv, (14, 80, 115), (42, 255, 255))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(yellow)
    found = []
    for index in range(1, count):
        x, y, width, height, area = map(int, stats[index])
        if 450 <= x <= 740 and 690 <= y <= 815 and area >= 900 and height >= 65:
            found.append((labels == index, (x, y, width, height)))
    return sorted(found, key=lambda item: item[1][0])


def extract_digit(image: Image.Image, component: tuple[np.ndarray, tuple[int, int, int, int]]) -> dict:
    core, (x, y, width, height) = component
    # Capture the brown inner stroke and white outer stroke around the yellow core.
    distance = cv2.distanceTransform((~core).astype(np.uint8), cv2.DIST_L2, 5)
    alpha = np.clip((13.0 - distance) * 127.5, 0, 255).astype(np.uint8)
    margin = 15
    left, top = max(0, x - margin), max(0, y - margin)
    right, bottom = min(image.width, x + width + margin), min(image.height, y + height + margin)
    rgba = np.dstack((np.array(image.convert("RGB")), alpha))[top:bottom, left:right]
    return {
        "image": Image.fromarray(rgba, "RGBA"),
        "core_left": x - left,
        "core_top": y - top,
        "core_width": width,
        "core_height": height,
    }


def load_digit_sprites(size: tuple[int, int]) -> dict[str, dict]:
    sprites: dict[str, dict] = {}
    for digits, path in DIGIT_SHEETS.items():
        sheet = Image.open(path).convert("RGB").resize(size, Image.Resampling.LANCZOS)
        components = yellow_components(sheet)
        if digits == "9":
            components = components[:1]
        elif digits == "0":
            components = components[1:2]
        if len(components) != len(digits):
            raise RuntimeError(f"cannot identify {digits!r} in {path.name}: found {len(components)} glyphs")
        for digit, component in zip(digits, components):
            sprites[digit] = extract_digit(sheet, component)
    missing = set("0123456789") - set(sprites)
    if missing:
        raise RuntimeError(f"missing digit sprites: {sorted(missing)}")
    return sprites


def remove_original_number(source: Image.Image) -> Image.Image:
    rgb = np.array(source.convert("RGB"))
    components = yellow_components(source)
    if len(components) != 4:
        raise RuntimeError(f"cannot identify original 1900: found {len(components)} glyphs")
    core = np.logical_or.reduce([item[0] for item in components])
    # Expansion is local to the detected glyphs and includes both outlines plus shadow.
    mask = cv2.dilate(core.astype(np.uint8) * 255, np.ones((7, 7), np.uint8), iterations=5)
    repaired = cv2.inpaint(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), mask, 5, cv2.INPAINT_TELEA)
    return Image.fromarray(cv2.cvtColor(repaired, cv2.COLOR_BGR2RGB))


def scaled_sprite(sprite: dict, scale: float) -> dict:
    image = sprite["image"]
    width = max(1, round(image.width * scale))
    height = max(1, round(image.height * scale))
    return {
        "image": image.resize((width, height), Image.Resampling.LANCZOS),
        "core_left": round(sprite["core_left"] * scale),
        "core_top": round(sprite["core_top"] * scale),
        "core_width": round(sprite["core_width"] * scale),
        "core_height": round(sprite["core_height"] * scale),
    }


def render(base: Image.Image, sprites: dict[str, dict], value: int) -> Image.Image:
    text = str(value)
    scale = 1.0 if len(text) == 4 else 0.82
    glyphs = [scaled_sprite(sprites[digit], scale) for digit in text]
    gap = round(4 * scale)
    core_width = sum(glyph["core_width"] for glyph in glyphs) + gap * (len(glyphs) - 1)
    core_x = 600 - core_width // 2
    core_bottom = 799

    result = base.convert("RGBA")
    for glyph in glyphs:
        x = core_x - glyph["core_left"]
        y = core_bottom - glyph["core_height"] - glyph["core_top"]
        result.alpha_composite(glyph["image"], (x, y))
        core_x += glyph["core_width"] + gap
    return result.convert("RGB")


def main() -> None:
    source = Image.open(SOURCE).convert("RGB")
    sprites = load_digit_sprites(source.size)
    background = remove_original_number(source)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for value in range(3000, 10001, 100):
        render(background, sprites, value).save(
            OUT_DIR / f"kirara_{value:05d}.jpg", quality=97, subsampling=0
        )
    print(f"generated {len(list(OUT_DIR.glob('*.jpg')))} images in {OUT_DIR}")


if __name__ == "__main__":
    main()
