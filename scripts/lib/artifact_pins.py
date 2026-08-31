#!/usr/bin/env python3
"""Read one pinned value out of config/artifact-decisions.json.

The decision matrix is the single source of truth for every external artifact identity in
this repository. Shell scripts that need one of those values must read it from there
rather than keep a second copy that can drift — which is exactly the failure mode the
matrix exists to prevent.

    scripts/lib/artifact_pins.py config/artifact-decisions.json \\
        'components[indexer-standalone].assets[linux/amd64].outerSha256'

Path syntax is deliberately tiny:

    key                 a dict key
    key[selector]       a dict key, then either that dict's `selector` key, or — if the
                        value is a list — the element whose `id` equals `selector`

Exit codes: 0 and the value on stdout; 1 and a message on stderr if the path does not
resolve. `--optional` turns a missing path into exit 0 with empty output, for fields the
catalog truthfully leaves null (a `legacy-unverified` member hash, for example).

This module only reads. It never edits the matrix, and it is not a substitute for
scripts/verify-artifact-decisions.sh, which is what proves the matrix is still internally
consistent and still carries its recorded pinsDigest.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

TOKEN_RE = re.compile(r"^([A-Za-z0-9_]+)(?:\[([^\]]+)\])?$")


def resolve(doc, path: str):
    cur = doc
    for token in path.split("."):
        m = TOKEN_RE.match(token)
        if not m:
            raise KeyError(f"malformed path token {token!r}")
        key, selector = m.group(1), m.group(2)
        if not isinstance(cur, dict) or key not in cur:
            raise KeyError(f"no key {key!r} at {token!r}")
        cur = cur[key]
        if selector is None:
            continue
        if isinstance(cur, list):
            for item in cur:
                if isinstance(item, dict) and item.get("id") == selector:
                    cur = item
                    break
            else:
                raise KeyError(f"no list entry with id {selector!r} in {key!r}")
        elif isinstance(cur, dict):
            if selector not in cur:
                raise KeyError(f"no key {selector!r} in {key!r}")
            cur = cur[selector]
        else:
            raise KeyError(f"{key!r} is not indexable by {selector!r}")
    return cur


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("matrix", type=Path)
    parser.add_argument("path")
    parser.add_argument("--optional", action="store_true",
                        help="a missing path or null value exits 0 with empty output")
    args = parser.parse_args()

    try:
        doc = json.loads(args.matrix.read_text(encoding="utf-8"))
    except OSError as exc:
        print(f"cannot read {args.matrix}: {exc}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"{args.matrix} is not valid JSON: {exc}", file=sys.stderr)
        return 1

    try:
        value = resolve(doc, args.path)
    except KeyError as exc:
        if args.optional:
            return 0
        print(f"{args.path}: {exc}", file=sys.stderr)
        return 1

    if value is None:
        if args.optional:
            return 0
        print(f"{args.path} is null", file=sys.stderr)
        return 1

    if isinstance(value, (dict, list)):
        print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    elif isinstance(value, bool):
        print("true" if value else "false")
    else:
        print(value)
    return 0


if __name__ == "__main__":
    sys.exit(main())
