#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mechanical inventory of an HTML/CSS/JS mockup.

Produces the checklist a spec set must cover. This is grep, not judgement:
if an element is here, some spec has to account for it or the coverage gate fails.

Usage:
    inventory.py <mockup-dir> [--json]

Expects the mockup laid out as fragments:
    <mockup-dir>/tabs/*.html      one file per page
    <mockup-dir>/modals/*.html    one file per overlay
    <mockup-dir>/js/**/*.js       classic scripts
If a project keeps a single assembled index.html instead, pass that directory
anyway; the script falls back to scanning every .html it finds except the
assembled root (see ASSEMBLED_NAMES).
"""
import json
import os
import re
import sys

ASSEMBLED_NAMES = {"index.html"}

RE_ID = re.compile(r'\bid="([^"]+)"')
RE_DATA_ATTR = re.compile(r'\b(data-[a-z-]+)="([^"]*)"')
RE_LISTENER = re.compile(r'(?:document\.)?getElementById\(\s*[\'"]([^\'"]+)[\'"]\s*\)')
RE_QUERY = re.compile(r'querySelector(?:All)?\(\s*[\'"]([^\'"]+)[\'"]\s*\)')
RE_FUNC = re.compile(r'^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)', re.M)
RE_ADDEV = re.compile(r'addEventListener\(\s*[\'"](\w+)[\'"]')


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def html_files(root):
    out = []
    for sub in ("tabs", "modals"):
        d = os.path.join(root, sub)
        if os.path.isdir(d):
            for name in sorted(os.listdir(d)):
                if name.endswith(".html"):
                    out.append((sub, os.path.join(d, name)))
    if not out:  # fallback: no fragment layout
        for dirpath, _, names in os.walk(root):
            for name in sorted(names):
                if name.endswith(".html") and name not in ASSEMBLED_NAMES:
                    out.append(("html", os.path.join(dirpath, name)))
    return out


def js_files(root):
    out = []
    d = os.path.join(root, "js")
    base = d if os.path.isdir(d) else root
    for dirpath, _, names in os.walk(base):
        for name in sorted(names):
            if name.endswith(".js"):
                out.append(os.path.join(dirpath, name))
    return out


def scan(root):
    screens = []
    for kind, path in html_files(root):
        text = read(path)
        ids = sorted(set(RE_ID.findall(text)))
        data = sorted({f"{k}={v}" for k, v in RE_DATA_ATTR.findall(text) if v})
        screens.append({
            "screen": os.path.basename(path),
            "kind": kind,
            "path": os.path.relpath(path, root),
            "ids": ids,
            "data_attrs": data,
        })

    scripts = []
    referenced = set()
    for path in js_files(root):
        text = read(path)
        refs = sorted(set(RE_LISTENER.findall(text)))
        referenced.update(refs)
        scripts.append({
            "script": os.path.relpath(path, root),
            "functions": sorted(set(RE_FUNC.findall(text))),
            "listeners": len(RE_ADDEV.findall(text)),
            "event_types": sorted(set(RE_ADDEV.findall(text))),
            "touches_ids": refs,
            "selectors": sorted(set(RE_QUERY.findall(text))),
        })

    all_ids = {i for s in screens for i in s["ids"]}
    return {
        "root": root,
        "screens": screens,
        "scripts": scripts,
        "totals": {
            "screens": len(screens),
            "ids": len(all_ids),
            "scripts": len(scripts),
            "functions": sum(len(s["functions"]) for s in scripts),
            "listeners": sum(s["listeners"] for s in scripts),
        },
        # An id nobody wires up is either decorative or a dead control.
        # Either way the spec must say which - silence is not an answer.
        "ids_never_referenced_in_js": sorted(all_ids - referenced),
        # A script reaching for an id that no fragment declares is a real bug
        # in the mockup, or an element living in the assembled shell only.
        "ids_referenced_but_undeclared": sorted(referenced - all_ids),
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    data = scan(os.path.abspath(args[0]))

    if "--json" in sys.argv:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    t = data["totals"]
    print("INVENTORY  %s" % data["root"])
    print("  screens %d | ids %d | scripts %d | functions %d | listeners %d"
          % (t["screens"], t["ids"], t["scripts"], t["functions"], t["listeners"]))
    print()
    print("%-30s %-8s %5s %5s" % ("screen", "kind", "ids", "data"))
    print("-" * 52)
    for s in data["screens"]:
        print("%-30s %-8s %5d %5d"
              % (s["screen"], s["kind"], len(s["ids"]), len(s["data_attrs"])))
    print()
    orphan = data["ids_never_referenced_in_js"]
    ghost = data["ids_referenced_but_undeclared"]
    print("ids never touched by any script: %d" % len(orphan))
    for i in orphan[:20]:
        print("   %s" % i)
    if len(orphan) > 20:
        print("   ... +%d more" % (len(orphan) - 20))
    print()
    print("ids used by scripts but declared in no fragment: %d" % len(ghost))
    for i in ghost[:20]:
        print("   %s" % i)
    if len(ghost) > 20:
        print("   ... +%d more" % (len(ghost) - 20))
    return 0


if __name__ == "__main__":
    sys.exit(main())
