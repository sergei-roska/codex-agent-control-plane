#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Coverage gate: every control in the mockup must appear in the spec set.

Exit code 0 = covered, 1 = gaps found. Wire it into review; a red gate is the
whole point. Judgement is not involved: an id is either mentioned in a spec
file or it is not.

Usage:
    coverage.py <mockup-dir> <spec-dir> [--list] [--screen NAME]

An id counts as covered when it appears verbatim anywhere under <spec-dir>.
That is a deliberately weak test - it catches omission, not wrong content.
Wrong content is what the screen-pass review is for. Omission is what silently
shipped a spec set with no Project modal and no application shell.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inventory import scan  # noqa: E402


def spec_text(spec_dir):
    blobs = {}
    for dirpath, _, names in os.walk(spec_dir):
        for name in sorted(names):
            if name.endswith((".md", ".markdown")):
                p = os.path.join(dirpath, name)
                with open(p, encoding="utf-8") as fh:
                    blobs[os.path.relpath(p, spec_dir)] = fh.read()
    return blobs


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return 2
    mockup, specs = os.path.abspath(args[0]), os.path.abspath(args[1])
    only = None
    if "--screen" in sys.argv:
        only = sys.argv[sys.argv.index("--screen") + 1]

    inv = scan(mockup)
    blobs = spec_text(specs)
    joined = "\n".join(blobs.values())

    # Shell controls: referenced by scripts, declared in no fragment. They are
    # part of the app and must be specified too, so they enter the gate as a
    # synthetic screen rather than being quietly dropped.
    screens = list(inv["screens"])
    ghosts = inv["ids_referenced_but_undeclared"]
    if ghosts:
        screens.append({"screen": "<app shell>", "kind": "shell",
                        "path": "(assembled root / build script)", "ids": ghosts})

    total = covered = 0
    rows, gaps = [], []
    for s in screens:
        if only and s["screen"] != only:
            continue
        miss = [i for i in s["ids"] if i not in joined]
        total += len(s["ids"])
        covered += len(s["ids"]) - len(miss)
        pct = 100 * (len(s["ids"]) - len(miss)) // max(len(s["ids"]), 1)
        rows.append((s["screen"], s["kind"], len(s["ids"]), len(miss), pct))
        for m in miss:
            gaps.append((s["screen"], m))

    print("COVERAGE GATE   mockup=%s  specs=%s" % (mockup, specs))
    print("  %d of %d controls covered (%d%%)"
          % (covered, total, 100 * covered // max(total, 1)))
    print()
    print("%-30s %-8s %5s %6s %5s" % ("screen", "kind", "ids", "missing", "cov"))
    print("-" * 60)
    for name, kind, n, miss, pct in sorted(rows, key=lambda r: r[4]):
        flag = "" if miss == 0 else "  <-- GAP"
        print("%-30s %-8s %5d %6d %4d%%%s" % (name, kind, n, miss, pct, flag))

    if gaps and "--list" in sys.argv:
        print()
        print("uncovered controls:")
        cur = None
        for screen, cid in gaps:
            if screen != cur:
                print("  %s" % screen)
                cur = screen
            print("     %s" % cid)

    print()
    if gaps:
        print("FAIL: %d controls have no mention in any spec file." % len(gaps))
        print("      Re-run with --list to see them.")
        return 1
    print("PASS: every control is accounted for.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
