"""
add_contest_ids.py — quick helper to seed / add contest IDs to the
year's discovery output file. Useful for the pre-October window
when NCAA hasn't published RPI yet — you can grab contest IDs from
stats.ncaa.org URLs manually (e.g. the URL bar after clicking a
Texas match on stats.ncaa.org shows /contests/<id>/box_score),
paste them in, and the rest of the pipeline runs normally.

Reads existing contest_ids_<year>.txt, adds new IDs, dedupes and
sorts, writes back.

Accepts IDs as bare numbers OR full URLs — anything matching
/contests/<digits> in the input gets extracted.

Usage:
    py -X utf8 scripts/add_contest_ids.py --year 2026 --ids 6503421 6503422

    py -X utf8 scripts/add_contest_ids.py --year 2026 \\
        --ids https://stats.ncaa.org/contests/6503421/play_by_play

    py -X utf8 scripts/add_contest_ids.py --year 2026 --stdin
    (then paste one ID per line, ctrl-D to end)
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

CONTEST_RE = re.compile(r"/contests/(\d+)")
DIGIT_RE   = re.compile(r"^\d+$")

BUILD_DIR = Path("scripts/.pbp-build")


def extract_id(token: str) -> str | None:
    """Turn a token (bare ID or URL fragment) into a plain contest ID string."""
    token = token.strip()
    if not token:
        return None
    m = CONTEST_RE.search(token)
    if m:
        return m.group(1)
    if DIGIT_RE.match(token):
        return token
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--ids", nargs="*", default=[],
                    help="Contest IDs or /contests/<id> URLs (space-separated)")
    ap.add_argument("--stdin", action="store_true",
                    help="Read one ID per line from stdin")
    args = ap.parse_args()

    out_path = BUILD_DIR / f"contest_ids_{args.year}.txt"
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    existing: set[str] = set()
    if out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if s:
                existing.add(s)
        print(f"[add-cid] loaded {len(existing)} existing IDs from {out_path}")
    else:
        print(f"[add-cid] {out_path} does not exist — will create it")

    tokens: list[str] = list(args.ids)
    if args.stdin:
        print("[add-cid] reading IDs from stdin (one per line, Ctrl-D to end):")
        tokens.extend(sys.stdin.read().splitlines())

    if not tokens:
        print("[add-cid] no IDs provided (--ids or --stdin)", file=sys.stderr)
        sys.exit(1)

    added: list[str] = []
    skipped: list[str] = []
    for t in tokens:
        cid = extract_id(t)
        if cid is None:
            print(f"[add-cid]   ✗ could not parse ID from {t!r}")
            continue
        if cid in existing:
            skipped.append(cid)
        else:
            existing.add(cid)
            added.append(cid)

    # Write out sorted union
    sorted_ids = sorted(existing, key=lambda x: int(x))
    out_path.write_text("\n".join(sorted_ids) + "\n", encoding="utf-8")

    print(f"[add-cid] added:      {len(added)}")
    for cid in added:
        print(f"[add-cid]   + {cid}")
    if skipped:
        print(f"[add-cid] skipped (already present): {len(skipped)}")
    print(f"[add-cid] total in file now: {len(sorted_ids)}")
    print(f"[add-cid] wrote {out_path}")


if __name__ == "__main__":
    main()
