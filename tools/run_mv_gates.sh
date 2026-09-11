#!/usr/bin/env bash
# Run every 白紙の書架 gate and print one line per gate.
#
# Why a runner: there are 15 of them, two need a live server, and the ones that
# drive a browser take minutes. Running them by hand means the slow ones get
# skipped, which is how a green claim goes stale. This is the whole set or
# nothing.
#
# Usage: bash tools/run_mv_gates.sh [PORT]
#   PORT defaults to 8645. The two browser gates (a11y, menu) need a server
#   already serving the repo root on it; the rest ignore it.

PORT="${1:-8645}"
cd "$(dirname "$0")/.." || exit 1

pass=0
fail=0
declare -a failed

for f in tools/check_mv_*.py; do
    name=$(basename "$f" .py)
    if grep -q 'add_argument("--port"' "$f"; then
        out=$(timeout 900 python "$f" --port "$PORT" 2>&1)
    else
        out=$(timeout 900 python "$f" 2>&1)
    fi
    code=$?
    # The gates disagree on how they announce success -- some print "RESULT: pass",
    # some print a bare "ok" summary line. The exit code is the one thing all of
    # them set, so that is what decides. Text is only for the tail on failure.
    if [ "$code" -eq 0 ]; then
        pass=$((pass + 1))
        printf 'pass  %-22s %s\n' "$name" "$(echo "$out" | grep -iE 'assertion|negative case|RESULT|checked' | tail -1 | cut -c1-84)"
    else
        fail=$((fail + 1))
        failed+=("$name")
        printf 'FAIL  %-22s exit=%s  %s\n' "$name" "$code" "$(echo "$out" | tail -2 | tr '\n' ' ' | cut -c1-84)"
    fi
done

echo
echo "$((pass + fail)) gates: $pass pass, $fail fail"
if [ "$fail" -gt 0 ]; then
    printf 'failed: %s\n' "${failed[*]}"
    exit 1
fi
