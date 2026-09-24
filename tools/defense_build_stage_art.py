"""Make stage plates from verified Room textures, without painting fake terrain."""
from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site/etowaria-defense/assets/stage"
ROOM = ROOT / "site/etowaria-defense/assets/room"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    evidence = []
    for name, source in [
        ("day", "background_1006_0/Background_1006_0.png"),
        ("camp", "background_1013_1/Background_1013_1.png"),
        ("water", "background_1013_0/Background_1013_0.png"),
    ]:
        file = ROOM / source
        image = Image.open(file).convert("RGB")
        assert image.size == (1024, 1024), source
        # Remove the source atlas padding. The daytime composition also trims
        # 80 pixels of sky so the back lane stands on grass, not the hedges.
        # This presentation crop is recorded below; it is not original layout.
        box = (36, 232 if name == "day" else 152, 992, 872)
        image.crop(box).save(OUT / (name + ".webp"), "WEBP", quality=95, method=6)
        evidence.append({"output": name + ".webp", "source": file.relative_to(ROOT).as_posix(),
                         "sha256": sha256(file.read_bytes()).hexdigest(), "crop": box})
    for name, source_name, crop, rows in [
        ("day-field", "background_1006_0/Background_1006_0.png", (260, 754, 930, 850), 5),
        ("camp-field", "background_1013_1/Background_1013_1.png", (160, 772, 860, 868), 5),
        ("water-field", "background_1013_0/Background_1013_0.png", (160, 772, 860, 868), 6),
    ]:
        source = ROOM / source_name
        grass = Image.open(source).convert("RGB").crop(crop)
        strip = ImageOps.fit(grass, (1200, 160), method=Image.Resampling.LANCZOS)
        field = Image.new("RGBA", (1200, rows * 160))
        for row in range(rows):
            band = ImageEnhance.Brightness(strip).enhance(1 if row % 2 == 0 else .965)
            field.paste(band, (0, row * 160))
        mask = Image.new("L", field.size)
        ImageDraw.Draw(mask).rounded_rectangle((14, 14, 1185, field.height - 15), radius=42, fill=255)
        field.putalpha(mask.filter(ImageFilter.GaussianBlur(10)))
        field.save(OUT / (name + ".webp"), "WEBP", lossless=True, method=6)
        evidence.append({"output": name + ".webp", "source": source.relative_to(ROOT).as_posix(),
                         "sha256": sha256(source.read_bytes()).hexdigest(), "sourceCrop": crop,
                         "adaptation": "Continuous lane ground made from original Room grass; subtle brightness bands and feathered edge are new layout"})
    for name, source in [
        ("water-surface", "floor_1012_m_0/Floor_1012_M_0_rgb.png"),
        ("sand-surface", "floor_1013_m/Floor_1013_M_rgb.png"),
    ]:
        file = ROOM / source
        image = Image.open(file).convert("RGB")
        # Recover the flat surface from the original isometric floor plate.
        # The 3D scene projects it once; placing the diamond on a plane would
        # apply that perspective twice. The beveled outer rim is excluded.
        quad = (512, 308, 124, 502, 512, 694, 900, 502)
        flat = image.transform((1024, 1024), Image.Transform.QUAD, quad, Image.Resampling.BICUBIC)
        flat.save(OUT / (name + ".webp"), "WEBP", quality=96, method=6)
        evidence.append({"output": name + ".webp", "source": file.relative_to(ROOT).as_posix(),
                         "sha256": sha256(file.read_bytes()).hexdigest(), "sourceQuad": quad,
                         "adaptation": "Unproject original Room floor surface; no new pattern or colorization"})
    (OUT / "provenance.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Prepared 3 complete Room backgrounds and 2 original floor surfaces")


if __name__ == "__main__":
    main()
