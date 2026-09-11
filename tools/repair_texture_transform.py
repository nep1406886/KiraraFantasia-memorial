#!/usr/bin/env python3
"""Repair KHR_texture_transform scales that were previously inverted.

gltfpack quantizes TEXCOORD_0 into a narrow normalized sub-range and records a
KHR_texture_transform whose ``scale`` expands it back to the original UV range,
so scale is legitimately > 1 (typically ~16 for 12-bit UV quantization).

An earlier version of the build pipeline replaced every scale with its
reciprocal, collapsing all UVs onto a single texel: models then rendered as one
flat colour (black, wherever that texel happened to be dark).  This tool undoes
that by re-inverting scales below 1.  It is idempotent -- a correct file has
scale > 1 and is left alone.
"""

from __future__ import annotations

import gzip
import os
import json
import struct
import tempfile
from pathlib import Path
from typing import Any


def _restore_scales(obj: Any) -> bool:
    """Recursively re-invert KHR_texture_transform scales below 1."""
    changed = False
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "KHR_texture_transform" and isinstance(value, dict):
                scale = value.get("scale")
                if isinstance(scale, (list, tuple)) and len(scale) == 2:
                    if all(isinstance(s, (int, float)) and 0 < s < 1 for s in scale):
                        value["scale"] = [1.0 / s for s in scale]
                        changed = True
            elif _restore_scales(value):
                changed = True
    elif isinstance(obj, list):
        for item in obj:
            if _restore_scales(item):
                changed = True
    return changed


def _read_glb(data: bytes) -> tuple[dict, bytes | None]:
    if data[:4] != b"glTF":
        raise ValueError("not a GLB file")
    pos = 12
    json_bytes = None
    bin_bytes = None
    while pos < len(data):
        chunk_len = struct.unpack("<I", data[pos:pos + 4])[0]
        chunk_type = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + chunk_len]
        if chunk_type == b"JSON":
            json_bytes = chunk
        elif chunk_type == b"BIN\x00":
            bin_bytes = chunk
        pos += 8 + chunk_len
    if json_bytes is None:
        raise ValueError("GLB has no JSON chunk")
    return json.loads(json_bytes.decode("utf-8")), bin_bytes


def _write_glb(json_dict: dict, bin_bytes: bytes | None) -> bytes:
    json_chunk = json.dumps(json_dict, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    while len(json_chunk) % 4:
        json_chunk += b" "
    out = bytearray()
    out += b"glTF"
    out += struct.pack("<I", 2)
    out += b"\x00\x00\x00\x00"
    out += struct.pack("<I", len(json_chunk))
    out += b"JSON"
    out += json_chunk
    if bin_bytes:
        bin_chunk = bin_bytes
        while len(bin_chunk) % 4:
            bin_chunk += b"\x00"
        out += struct.pack("<I", len(bin_chunk))
        out += b"BIN\x00"
        out += bin_chunk
    out[8:12] = struct.pack("<I", len(out))
    return bytes(out)


def repair_glb_bytes(data: bytes) -> bytes:
    json_dict, bin_bytes = _read_glb(data)
    if _restore_scales(json_dict):
        return _write_glb(json_dict, bin_bytes)
    return data


def repair_file(path: Path) -> bool:
    """Repair a single .glb or .glb.gz in place. Returns True if changed."""
    path = Path(path)
    is_gz = path.name.endswith(".gz")
    raw = gzip.decompress(path.read_bytes()) if is_gz else path.read_bytes()
    fixed = repair_glb_bytes(raw)
    if fixed == raw:
        return False
    # Write beside the target then atomically replace, so a static file server
    # reading the asset concurrently never observes a truncated file.
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".part")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        if is_gz:
            with gzip.GzipFile(str(tmp), "wb", compresslevel=9, mtime=0) as fp:
                fp.write(fixed)
        else:
            tmp.write_bytes(fixed)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return True


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help=".glb/.glb.gz files or directories")
    parser.add_argument("--recursive", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    files: list[Path] = []
    for entry in args.paths:
        path = Path(entry)
        if path.is_dir():
            files.extend(path.glob("**/*.glb.gz" if args.recursive else "*.glb.gz"))
            files.extend(path.glob("**/*.glb" if args.recursive else "*.glb"))
        else:
            files.append(path)

    changed = checked = 0
    for target in sorted(set(files)):
        if not target.name.endswith((".glb", ".glb.gz")):
            continue
        checked += 1
        try:
            if args.dry_run:
                raw = gzip.decompress(target.read_bytes()) if target.name.endswith(".gz") else target.read_bytes()
                if repair_glb_bytes(raw) != raw:
                    changed += 1
                    print(f"WOULD REPAIR  {target}")
            elif repair_file(target):
                changed += 1
        except Exception as error:  # noqa: BLE001
            print(f"ERROR  {target}: {error}")
    print(f"Checked {checked} file(s), {'would repair' if args.dry_run else 'repaired'} {changed}.")


if __name__ == "__main__":
    main()
