"""Print numbered commands from a story script, the way the engine indexes them.

There is no build step, so Node treats `site/asset/story/*.js` as CommonJS and refuses
to import the named export. Rather than add a package.json just to read a list,
this splits the array on top-level braces -- enough to answer "what is command 18"
when a walkthrough stalls, which is the only thing it is for.
"""

import re
import sys

BACKSLASH = chr(92)


def entries(path, name):
    src = open(path, encoding="utf-8").read()
    marker = "export const " + name + " = ["
    i = src.index(marker) + len(marker)
    depth = 0
    out = []
    cur = []
    while i < len(src):
        c = src[i]
        if c == '"' or c == "'" or c == "`":
            quote = c
            j = i + 1
            while j < len(src) and (src[j] != quote or src[j - 1] == BACKSLASH):
                j += 1
            if depth > 0:
                cur.append(src[i:j + 1])
            i = j + 1
            continue
        if src[i:i + 2] == "//":
            i = src.index("\n", i)
            continue
        if c == "{":
            depth += 1
            cur.append(c)
        elif c == "}":
            depth -= 1
            cur.append(c)
            if depth == 0:
                out.append("".join(cur))
                cur = []
        elif c == "]" and depth == 0:
            break
        elif depth > 0:
            cur.append(c)
        i += 1
    return out


def main():
    path = sys.argv[1]
    name = sys.argv[2]
    lo = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    hi = int(sys.argv[4]) if len(sys.argv) > 4 else lo + 12
    items = entries(path, name)
    print("total", len(items))
    for n in range(lo, min(hi + 1, len(items))):
        print(n, re.sub(r"\s+", " ", items[n])[:220])


if __name__ == "__main__":
    main()
