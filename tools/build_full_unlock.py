#!/usr/bin/env python3
"""Generate the default fully-unlocked save for the offline replica.

    python tools/build_full_unlock.py [--out site/asset/game/full_unlock_save.json]

The actual build lives in the JS module site/game/rl-core/fullunlocksav.js
(fullUnlockSave()), which runs headlessly in node and fills every field of the
v1 save shape from the data tables using the original game's progression
formulas (EditUtility / CharacterParamGrowthListDB_Ext). This script is a thin
wrapper: it injects the tables into globalThis.__kirafanGameData, calls the JS
builder, and writes the result as an importable save envelope
(kirafan.offline.save) so the player can import it, or the app can load it
directly as the default account.

Why a wrapper instead of pure Python: the formulas + save schema already live
in the JS layer (which the app uses at runtime). Re-implementing them in Python
would create a second source of truth. The JS module is the single source.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA_DIR = REPO / "site" / "game" / "star" / "data"
DEFAULT_OUT = REPO / "site" / "game" / "star" / "data" / "full_unlock_save.json"

# The node script: inject tables, build the save, emit JSON on stdout.
_NODE_SCRIPT = r"""
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
const dir = process.argv[2];
const injected = {};
for (const f of fs.readdirSync(dir)) {
  if (f.endsWith('.json') && f !== 'manifest.json') {
    injected[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
}
globalThis.__kirafanGameData = injected;
const data = await import(pathToFileURL(process.argv[3]).href);
const save = await import(pathToFileURL(process.argv[4]).href);
await data.load();
const s = save.fullUnlockSave();
const v = save.validate(s);
if (!v.ok) { console.error('validate failed:', v.errors); process.exit(1); }
// stamp a real uuid + timestamp so it behaves like a fresh account
s.player.uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  const val = c === 'x' ? r : (r & 0x3) | 0x8;
  return val.toString(16);
});
s.player.createdAt = Date.now();
// exportJSON already returns a JSON string (the versioned envelope).
process.stdout.write(save.exportJSON(s) + '\n');
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output save file")
    ap.add_argument("--check", action="store_true", help="build + validate, print summary, no write")
    args = ap.parse_args()

    node_script = REPO / "tools" / "_build_full_unlock_tmp.mjs"
    node_script.write_text(_NODE_SCRIPT, encoding="utf-8")
    try:
        proc = subprocess.run(
            [
                "node",
                str(node_script),
                str(DATA_DIR),
                str(REPO / "site" / "game" / "star" / "rl-core" / "data" / "index.js"),
                str(REPO / "site" / "game" / "star" / "rl-core" / "save.js"),
            ],
            capture_output=True, text=True, check=False,
        )
    finally:
        node_script.unlink(missing_ok=True)

    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        return proc.returncode

    payload = json.loads(proc.stdout)
    save = payload["save"]

    if args.check:
        chars = len(save["characters"])
        quests = len(save["quests"])
        print(f"OK: full-unlock save builds and validates")
        print(f"  characters: {chars} (all maxed)")
        print(f"  quests:     {quests} (all 3-star)")
        print(f"  player rank {save['player']['level']}  stamina {save['player']['staminaMax']}  gold {save['player']['gold']}")
        return 0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(proc.stdout, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    print(f"  characters {len(save['characters'])}  quests {len(save['quests'])}  rank {save['player']['level']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
