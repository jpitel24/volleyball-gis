"""
backfill_conference.py
──────────────────────

Fills the Conference and Opponent Conference columns in the _twosided.csv
files using team→conference mappings from the existing one-sided CSVs
(wvb_playermatch_div1_<year>.csv). Year-specific because of realignment.

Usage:
    python -X utf8 scripts/backfill_conference.py 2024
    python -X utf8 scripts/backfill_conference.py 2022 2023 2024 2025
"""

from __future__ import annotations

import csv
import re
import sys
import unicodedata
from pathlib import Path

DATA_DIR = Path("public/data")


def norm(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s.lower().strip())


def build_team_conf_map(year: int) -> dict[str, str]:
    """Walk one-sided CSV, collect team_norm → conference."""
    src = DATA_DIR / f"wvb_playermatch_div1_{year}.csv"
    m: dict[str, str] = {}
    if not src.exists():
        print(f"  ! missing one-sided source {src}")
        return m
    with src.open(encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh):
            t = r.get("Team") or ""
            c = r.get("Conference") or ""
            if t and c:
                key = norm(t)
                if key not in m:
                    m[key] = c
            # Also opponent → opponent conference (captures teams the
            # one-sided CSV dropped but that appear as opponents)
            ot = r.get("Opponent Team") or ""
            oc = r.get("Opponent Conference") or ""
            if ot and oc:
                key = norm(ot)
                if key not in m:
                    m[key] = oc
    print(f"  {len(m):,} team→conference entries")
    return m


def backfill(year: int):
    path = DATA_DIR / f"wvb_playermatch_div1_{year}_twosided.csv"
    if not path.exists():
        print(f"  ! missing {path}")
        return

    conf = build_team_conf_map(year)

    # Pass 1: identify contests where either team isn't D1 (not in conf map).
    # Dropping whole contest keeps both sides consistent.
    non_d1_contests: set[str] = set()
    unmatched_teams: set[str] = set()
    with path.open(encoding="utf-8", newline="") as fin:
        for r in csv.DictReader(fin):
            cid = r.get("ContestID", "")
            t_key = norm(r.get("Team", ""))
            o_key = norm(r.get("Opponent Team", ""))
            if t_key and t_key not in conf:
                non_d1_contests.add(cid)
                unmatched_teams.add(r["Team"])
            if o_key and o_key not in conf:
                non_d1_contests.add(cid)
                unmatched_teams.add(r["Opponent Team"])
    print(f"  Dropping {len(non_d1_contests):,} non-D1 contests "
          f"({len(unmatched_teams)} foreign teams)")
    if unmatched_teams:
        print(f"  foreign team sample: {sorted(unmatched_teams)[:15]}")

    # Pass 2: stream, drop non-D1 contests, fill conferences.
    tmp = path.with_suffix(".csv.tmp")
    total = 0
    kept = 0
    dropped = 0
    filled_team = 0
    filled_opp = 0

    with path.open(encoding="utf-8", newline="") as fin, \
         tmp.open("w", encoding="utf-8", newline="") as fout:
        rdr = csv.DictReader(fin)
        fields = list(rdr.fieldnames or [])
        w = csv.DictWriter(fout, fieldnames=fields)
        w.writeheader()
        for r in rdr:
            total += 1
            if r.get("ContestID") in non_d1_contests:
                dropped += 1
                continue
            t_key = norm(r.get("Team", ""))
            o_key = norm(r.get("Opponent Team", ""))
            if t_key in conf and not r.get("Conference"):
                r["Conference"] = conf[t_key]
                filled_team += 1
            if o_key in conf and not r.get("Opponent Conference"):
                r["Opponent Conference"] = conf[o_key]
                filled_opp += 1
            w.writerow(r)
            kept += 1

    tmp.replace(path)
    print(f"  {total:,} rows → kept {kept:,} · dropped {dropped:,}")
    print(f"  filled Team={filled_team:,} · Opp={filled_opp:,}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for y in [int(x) for x in sys.argv[1:]]:
        print(f"═══ Backfill conference {y} ═══")
        backfill(y)


if __name__ == "__main__":
    main()
