"""
backfill_positions.py
─────────────────────

Fills blank `P` (position) cells in every
`public/data/wvb_playermatch_div1_<year>.csv` by consulting the most-common
non-blank position observed for each player across ALL years.

Why: the PBP-rebuilt two-sided CSVs inherit their P column from the original
one-sided R scrape, which only populated one team per contest. The resulting
blank-P rate is severe (~97% of 2022 blank rows are unrecoverable from the
same season alone; see `buildGameIndex` in src/lib/csvGames.js for the
in-browser single-year fallback).

Cascade per blank row:
  1. (team, player) across all years  — preferred, handles career stability
  2. (player) across all years        — catches transfers who kept position
  3. leave blank (stays '?')          — unknown player, no signal anywhere

Name matching is case-insensitive with whitespace normalized. The CSVs are
rewritten in place with the rest of each row byte-identical (we only touch
the P column). Idempotent: running it twice is a no-op.

Usage:
    python -X utf8 scripts/backfill_positions.py
"""
from __future__ import annotations

import csv
import re
from collections import Counter, defaultdict
from pathlib import Path

DATA = Path("public/data")
YEARS = (2022, 2023, 2024, 2025)
SRC_FMT = "wvb_playermatch_div1_{year}.csv"


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def main() -> None:
    # Pass 1: tally P frequencies across all years.
    by_team_player: dict[tuple[str, str], Counter] = defaultdict(Counter)
    by_player:      dict[str, Counter]             = defaultdict(Counter)

    print("Pass 1: tallying non-blank P across all years …")
    for y in YEARS:
        path = DATA / SRC_FMT.format(year=y)
        if not path.exists():
            print(f"  skip (missing): {path}")
            continue
        n = 0
        with path.open("r", encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                n += 1
                p = (r.get("P") or "").strip()
                if not p:
                    continue
                t = norm(r.get("Team", ""))
                pl = norm(r.get("Player", ""))
                if not pl:
                    continue
                by_team_player[(t, pl)][p] += 1
                by_player[pl][p] += 1
        print(f"  {y}: {n:,} rows")

    def pick(counter: Counter) -> str | None:
        if not counter:
            return None
        return counter.most_common(1)[0][0]

    tp_map = {k: pick(v) for k, v in by_team_player.items()}
    p_map  = {k: pick(v) for k, v in by_player.items()}
    print(f"  known (team,player) positions: {len(tp_map):,}")
    print(f"  known (player) positions:      {len(p_map):,}")

    # Pass 2: rewrite each CSV, filling blank P cells.
    print("\nPass 2: filling blank P cells …")
    for y in YEARS:
        path = DATA / SRC_FMT.format(year=y)
        if not path.exists():
            continue
        with path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            fields = reader.fieldnames
            rows = list(reader)

        filled_tp = filled_p = still_blank = already = 0
        for r in rows:
            existing = (r.get("P") or "").strip()
            if existing:
                already += 1
                continue
            t  = norm(r.get("Team", ""))
            pl = norm(r.get("Player", ""))
            if not pl:
                still_blank += 1
                continue
            cand = tp_map.get((t, pl))
            if cand:
                r["P"] = cand
                filled_tp += 1
                continue
            cand = p_map.get(pl)
            if cand:
                r["P"] = cand
                filled_p += 1
                continue
            still_blank += 1

        # Write back, preserving column order + Windows-friendly newlines.
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
        tmp.replace(path)

        total = already + filled_tp + filled_p + still_blank
        print(f"  {y}: {total:,} rows  ·  already filled: {already:,}  ·  "
              f"backfilled via (team,player): {filled_tp:,}  ·  "
              f"via (player): {filled_p:,}  ·  still blank: {still_blank:,}  "
              f"({100*still_blank/total:.1f}%)")


if __name__ == "__main__":
    main()
