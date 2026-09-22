"""
build_setscores.py — derive per-set final scores from the touch parquet.

Emits public/data/wvb_setscores_<year>.json in the shape the Game Browser
already consumes:

    { "<contest_id>": [[home, away], [home, away], ...], ... }

Each inner list is one set in play order. The score for a set is the
maximum score_home_after / score_away_after reached during any touch in
that set (i.e. the final score after the winning point lands).

The Python API pipeline (fetch_ncaa_api.py) has its own build_setscores
function that reads a different cache format — we're not using that
pipeline for 2026, so this smaller script pulls the same data out of
the touch parquet that our HTML-scraped PBP produces.

Usage:
  py -X utf8 scripts/build_setscores.py --year 2026
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

PARQUET_TEMPLATE = "scripts/.pbp-build/wvb_pbp_touches_{year}.parquet"
BOXSCORE_TEMPLATE = "public/data/wvb_playermatch_div1_{year}.csv"
OUT_TEMPLATE     = "public/data/wvb_setscores_{year}.json"


def _display_home_team(team: str, opp: str, location: str) -> str:
    """Mirror the frontend's csvGames.js gameRowsToBoxscore home/away
    determination so the setscores JSON's [home, away] pairs align with
    the perspective the Game Browser uses to render them.

      - Location == 'Home' → this row's Team is home.
      - Location == 'Away' → this row's Opponent Team is home.
      - Else (Neutral / blank) → alphabetical sort of the two names,
        first team is home. Matches JS's [teamA, teamB].sort().
    """
    loc = (location or "").strip()
    if loc == "Home":
        return team
    if loc == "Away":
        return opp
    return min(team, opp) if team and opp else (team or opp or "")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    args = ap.parse_args()

    src = Path(PARQUET_TEMPLATE.format(year=args.year))
    if not src.exists():
        print(f"ERROR: {src} not found — run aggregate_pbp_touches.py first.",
              file=sys.stderr)
        sys.exit(1)

    print(f"[setscores] reading {src}")
    df = pd.read_parquet(
        src, columns=["contest_id", "home_team", "away_team",
                      "set_num", "score_home_after", "score_away_after"]
    )
    df = df.dropna(subset=["contest_id", "set_num"])

    # For each (contest, set), take the max after-score across all touches
    # as the final. Also carry the parquet's home_team so we can align
    # the perspective with the frontend below.
    finals = (
        df.groupby(["contest_id", "home_team", "away_team", "set_num"],
                   as_index=False)
          .agg(home=("score_home_after", "max"),
               away=("score_away_after", "max"))
          .sort_values(["contest_id", "set_num"])
    )

    # Load the boxscore CSV to figure out the DISPLAY's home team per
    # contest — the frontend renders [home, away] according to its own
    # home/away pick (Location field, alphabetical fallback for
    # Neutral). If that disagrees with the parquet's home_team, we need
    # to swap the pair values in the JSON so the display shows the
    # correct team on the correct side.
    bs_path = Path(BOXSCORE_TEMPLATE.format(year=args.year))
    display_home_by_contest: dict[str, str] = {}
    if bs_path.exists():
        bs = pd.read_csv(bs_path, usecols=["ContestID", "Team",
                                            "Opponent Team", "Location"])
        first_rows = bs.drop_duplicates("ContestID", keep="first")
        for _, r in first_rows.iterrows():
            display_home_by_contest[str(int(r["ContestID"]))] = (
                _display_home_team(r["Team"], r["Opponent Team"], r["Location"])
            )
    else:
        print(f"[setscores] WARNING: {bs_path} not found — perspectives "
              "may not align with the frontend for Neutral / no-Location contests")

    out: dict[str, list[list[int]]] = {}
    swaps = 0
    for cid, grp in finals.groupby("contest_id"):
        parquet_home = grp["home_team"].iloc[0]
        display_home = display_home_by_contest.get(str(int(cid)))
        # If the display picks the OTHER team as home, swap each pair
        # so [home, away] in the JSON matches the display's perspective.
        swap = display_home is not None and display_home != parquet_home
        if swap:
            swaps += 1
        pairs = []
        for _, row in grp.iterrows():
            h = int(row["home"]) if pd.notna(row["home"]) else 0
            a = int(row["away"]) if pd.notna(row["away"]) else 0
            pairs.append([a, h] if swap else [h, a])
        out[str(int(cid))] = pairs

    out_path = Path(OUT_TEMPLATE.format(year=args.year))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"[setscores] wrote {out_path} ({len(out)} contests, "
          f"{out_path.stat().st_size / 1024:.0f} KB, {swaps} swapped for perspective)")


if __name__ == "__main__":
    main()
