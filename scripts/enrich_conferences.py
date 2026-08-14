"""
enrich_conferences.py

Fills the Conference + Opponent Conference columns on a newly-parsed
box-score CSV by joining against the team→conference map produced by
build_team_conferences.py.

Prerequisites:
  - scripts/parse_ncaa_boxscores.py --year <year> has run
    (produces public/data/wvb_playermatch_div1_<year>.csv)
  - scripts/build_team_conferences.py --year <year> has run
    (produces scripts/.pbp-build/team_conferences_<year>.json)

Year fallback: if the requested year's team_conferences JSON doesn't
exist yet (e.g. NCAA hasn't published 2026 RPI until October), falls
back to the most recent prior year that does. Matches the RPI
fallback behavior in build_gis_plus_v2.py — team-conference
membership is highly stable year-over-year, so 2025 as a stand-in
for pre-October 2026 gets the vast majority of teams right.

Only overwrites the Conference column when the join hits (matches
enrich_boxscores_from_pbp.py's non-destructive behavior — historical
CSVs whose team names differ from the RPI page keep their existing
values).

Usage:
    py -X utf8 scripts/enrich_conferences.py --year 2026
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd

BUILD_DIR = Path("scripts/.pbp-build")
CSV_TEMPLATE = "public/data/wvb_playermatch_div1_{year}.csv"


def load_conf_map_with_fallback(year: int) -> tuple[dict[str, str], int]:
    """Return (team → conference dict, effective_year). Walks back to
    the most recent prior year with a cached mapping if the requested
    year doesn't have one."""
    for offset in range(0, 10):
        candidate = year - offset
        path = BUILD_DIR / f"team_conferences_{candidate}.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if offset > 0:
                print(f"[conf-enrich] NOTE: no team_conferences_{year}.json; "
                      f"falling back to {candidate} ({len(data)} teams)",
                      file=sys.stderr)
            return data, candidate
    return {}, -1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    args = ap.parse_args()

    csv_path = Path(CSV_TEMPLATE.format(year=args.year))
    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found — run parse_ncaa_boxscores.py first",
              file=sys.stderr)
        sys.exit(1)

    conf_map, effective_year = load_conf_map_with_fallback(args.year)
    if not conf_map:
        print(f"ERROR: no team_conferences_*.json found for {args.year} or "
              "any prior year — run build_team_conferences.py first",
              file=sys.stderr)
        sys.exit(1)
    print(f"[conf-enrich] using team_conferences_{effective_year}.json "
          f"({len(conf_map)} teams)")

    t0 = time.time()
    print(f"[conf-enrich] loading {csv_path}")
    df = pd.read_csv(csv_path)
    print(f"[conf-enrich]   {len(df):,} rows")

    # Build lookup helper — case-insensitive team name → conference
    conf_lower = {k.lower(): v for k, v in conf_map.items()}

    def lookup(name: str) -> str:
        if not isinstance(name, str) or not name.strip():
            return ""
        return conf_lower.get(name.strip().lower(), "")

    print("[conf-enrich] filling Conference + Opponent Conference …")
    new_conf = df["Team"].apply(lookup)
    new_opp  = df["Opponent Team"].apply(lookup)

    # Only overwrite where lookup succeeded — preserves any existing
    # conference values on rows whose team name doesn't match our RPI map
    # (name variants, non-D1 opponents, etc.)
    if "Conference" in df.columns:
        df["Conference"] = new_conf.where(new_conf != "", df["Conference"])
    else:
        df["Conference"] = new_conf
    if "Opponent Conference" in df.columns:
        df["Opponent Conference"] = new_opp.where(new_opp != "",
                                                  df["Opponent Conference"])
    else:
        df["Opponent Conference"] = new_opp

    hit_team = int((new_conf != "").sum())
    hit_opp  = int((new_opp != "").sum())
    print(f"[conf-enrich]   Team hits:          {hit_team:>6,} / {len(df):,}")
    print(f"[conf-enrich]   Opponent Team hits: {hit_opp:>6,} / {len(df):,}")

    # Identify unmatched team names for follow-up (usually non-D1 opponents
    # or name variants that need a manual alias)
    unmatched_teams = set()
    for name in df["Team"].unique():
        if isinstance(name, str) and name.strip() and lookup(name) == "":
            unmatched_teams.add(name)
    if unmatched_teams:
        print(f"[conf-enrich] {len(unmatched_teams)} unmatched Team names "
              "(showing up to 10):")
        for name in sorted(unmatched_teams)[:10]:
            print(f"  - {name!r}")

    df.to_csv(csv_path, index=False)
    elapsed = time.time() - t0
    print(f"[conf-enrich] done in {elapsed:.0f}s")
    print(f"[conf-enrich] wrote {csv_path}  "
          f"({csv_path.stat().st_size / (1024 * 1024):.1f} MB)")


if __name__ == "__main__":
    main()
