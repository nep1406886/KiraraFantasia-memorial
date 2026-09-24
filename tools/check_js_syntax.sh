#!/usr/bin/env bash
# Syntax-check every ES module in core/ and game/.
#
# There is no build step -- the browser is the only thing that ever parses these
# files, so a typo in a rarely-taken branch would otherwise surface as a blank
# page. `node --check` parses without executing, which is exactly what is wanted
# for code full of `window` and `fetch`.
#
# Node decides module vs script by extension, and these are .js in a directory
# with no package.json, so each file is copied to a .mjs with its directory
# folded into the name (core/actor.js -> core__actor.mjs) to keep same-named
# files in different directories from overwriting each other.
set -u
cd "$(dirname "$0")/.." || exit 1

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail=0
count=0
# 2026-09-11 起 core/ 与 game/ 落在 site/ 之下；rl 模块在 site/game/rl/{,ui/,view/}。
for f in site/core/*.js site/game/rl/*.js site/game/rl/ui/*.js site/game/rl/view/*.js; do
    [ -e "$f" ] || continue
    cp "$f" "$work/$(printf '%s' "$f" | tr '/' '_' | sed 's/\.js$/.mjs/')"
done

for m in "$work"/*.mjs; do
    [ -e "$m" ] || continue
    name="$(basename "$m" .mjs | tr '_' '/')"
    count=$((count + 1))
    if out="$(node --check "$m" 2>&1)"; then
        printf '  ok    %s\n' "$name"
    else
        printf '  FAIL  %s\n' "$name"
        printf '%s\n' "$out" | sed 's/^/          /'
        fail=$((fail + 1))
    fi
done

printf '\n%d modules checked, %d failed\n' "$count" "$fail"
[ "$fail" -eq 0 ]
