"""
add_rally_leverage.py
─────────────────────

Adds a Leverage column to wvb_rallies_div1_<year>.csv.

Leverage of a rally is defined as the absolute difference in home-team match
win probability between "home wins this rally" and "visit wins this rally",
assuming every subsequent rally is a fair coin flip (p=0.5). This yields a
pure state-based measure: rallies at 24-24 in set 5 carry ~1.00 leverage;
rallies at 3-1 in set 1 of an eventual sweep carry ~0.01.

NCAA indoor rules: sets 1-4 to 25, set 5 to 15, all win-by-2 (no cap).

Input:  public/data/wvb_rallies_div1_<year>.csv
Output: same path, with Leverage appended.

Usage:
    python -X utf8 scripts/add_rally_leverage.py 2022 2023 2024 2025
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

DATA_DIR = Path("public/data")

# Precompute WP table iteratively (bottom-up; avoids recursion depth limits)
# Domain bounds — no NCAA match goes beyond these.
MAX_SCORE = 50  # headroom for long deuces
WP_TABLE: dict[tuple[int, int, int, int], float] = {}


def _set_next(sets_h, sets_v, score_h, score_v):
    """If this score decides the set, return (new_sets_h, new_sets_v); else None."""
    set_idx = sets_h + sets_v + 1
    target = 15 if set_idx == 5 else 25
    if (score_h >= target or score_v >= target) and abs(score_h - score_v) >= 2:
        return (sets_h + 1, sets_v) if score_h > score_v else (sets_h, sets_v + 1)
    return None


def _build_wp_table():
    """Fill WP_TABLE for every reachable (sets_h, sets_v, score_h, score_v)."""
    # Process match-states in reverse order of (sets_h + sets_v): a set's WP
    # depends only on the next-set WP (which has a higher sets-sum).
    for sets_sum in range(4, -1, -1):  # 4 → 0
        for sets_h in range(0, min(3, sets_sum) + 1):
            sets_v = sets_sum - sets_h
            if sets_v < 0 or sets_v > 3:
                continue
            # If match already decided (shouldn't occur in this loop, but safe)
            if sets_h == 3 or sets_v == 3:
                for sh in range(MAX_SCORE + 1):
                    for sv in range(MAX_SCORE + 1):
                        WP_TABLE[(sets_h, sets_v, sh, sv)] = 1.0 if sets_h == 3 else 0.0
                continue
            # Fill this set bottom-up: high scores first
            for total in range(2 * MAX_SCORE, -1, -1):
                for sh in range(max(0, total - MAX_SCORE), min(MAX_SCORE, total) + 1):
                    sv = total - sh
                    if sv < 0 or sv > MAX_SCORE:
                        continue
                    nxt = _set_next(sets_h, sets_v, sh, sv)
                    if nxt is not None:
                        nsh, nsv = nxt
                        if nsh == 3:
                            WP_TABLE[(sets_h, sets_v, sh, sv)] = 1.0
                        elif nsv == 3:
                            WP_TABLE[(sets_h, sets_v, sh, sv)] = 0.0
                        else:
                            WP_TABLE[(sets_h, sets_v, sh, sv)] = WP_TABLE[(nsh, nsv, 0, 0)]
                        continue
                    # Not decided — recurse within same set (higher scores already filled)
                    h_win = WP_TABLE.get((sets_h, sets_v, sh + 1, sv))
                    v_win = WP_TABLE.get((sets_h, sets_v, sh, sv + 1))
                    # If we've hit MAX_SCORE without resolving (shouldn't happen w/ headroom),
                    # fall back to 0.5.
                    if h_win is None or v_win is None:
                        WP_TABLE[(sets_h, sets_v, sh, sv)] = 0.5
                    else:
                        WP_TABLE[(sets_h, sets_v, sh, sv)] = 0.5 * h_win + 0.5 * v_win


_build_wp_table()


def wp(sets_h: int, sets_v: int, score_h: int, score_v: int) -> float:
    if sets_h >= 3:
        return 1.0
    if sets_v >= 3:
        return 0.0
    return WP_TABLE.get((sets_h, sets_v, min(score_h, MAX_SCORE), min(score_v, MAX_SCORE)), 0.5)


def leverage(sets_h: int, sets_v: int, pre_h: int, pre_v: int) -> float:
    """|WP if home wins this rally  −  WP if visit wins this rally|."""
    a = wp(sets_h, sets_v, pre_h + 1, pre_v)
    b = wp(sets_h, sets_v, pre_h, pre_v + 1)
    return abs(a - b)


def process_year(year: int):
    path = DATA_DIR / f"wvb_rallies_div1_{year}.csv"
    if not path.exists():
        print(f"  [skip] {path} not found")
        return

    tmp = path.with_suffix(".csv.tmp")
    rows_written = 0

    with path.open("r", encoding="utf-8", newline="") as fi, \
         tmp.open("w", encoding="utf-8", newline="") as fo:
        reader = csv.reader(fi)
        writer = csv.writer(fo)

        header = next(reader)
        if "Leverage" in header:
            # Re-compute in place: strip old column first
            lev_idx = header.index("Leverage")
            header = [h for i, h in enumerate(header) if i != lev_idx]
        else:
            lev_idx = None
        writer.writerow(header + ["Leverage"])

        col = {name: i for i, name in enumerate(header)}

        # Buffer rows per (contest, set) to compute pre-state from prior row,
        # and track sets-won history across sets within a contest.
        cur_contest = None
        cur_set = None
        sets_h = sets_v = 0
        prev_h = prev_v = 0
        # Track per-set finals so we can credit a set win when the set changes
        last_set_end_h = last_set_end_v = 0

        for raw in reader:
            if lev_idx is not None:
                raw = [v for i, v in enumerate(raw) if i != lev_idx]

            contest = raw[col["ContestID"]]
            set_num = int(raw[col["Set"]])
            h = int(raw[col["HomeScore"]])
            v = int(raw[col["VisitScore"]])

            if contest != cur_contest:
                cur_contest = contest
                cur_set = set_num
                sets_h = sets_v = 0
                prev_h = prev_v = 0
                last_set_end_h = last_set_end_v = 0
            elif set_num != cur_set:
                # Credit the previous set to its winner
                if last_set_end_h > last_set_end_v:
                    sets_h += 1
                else:
                    sets_v += 1
                cur_set = set_num
                prev_h = prev_v = 0

            lev = leverage(sets_h, sets_v, prev_h, prev_v)
            writer.writerow(raw + [f"{lev:.6f}"])
            rows_written += 1

            prev_h, prev_v = h, v
            last_set_end_h, last_set_end_v = h, v

    tmp.replace(path)
    print(f"  {year}: {rows_written:,} rows written with Leverage · {path}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for y in [int(x) for x in sys.argv[1:]]:
        process_year(y)


if __name__ == "__main__":
    main()
