"""
identify_starters.py — Phase 6 cohort builder.

Reads all four years of per-match box-score CSVs and identifies
"regular starters" per team-year. The output set becomes the
cohort filter for compute_efficiency_baselines.py.

Per-team starter slots (per user spec):
    3 × OH
    1 × OPP
    2 × MB
    1 × S
    1 × L/DS
    ─────
    8 starters per team-year

Per-player primary position is the mode of their P column across all
matches that season. Sets played is the sum of S. Within each
(team, year, position) group, players are ranked by sets played
descending; top-N keep starter status.

Position normalization (CSV labels vary):
    OH, O        → OH    (outside hitter)
    OPP, RS      → OPP   (opposite / right side)
    MB, MH       → MB    (middle blocker / middle hitter)
    S            → S
    L, DS, L/DS  → L/DS  (libero + defensive specialist treated as one pool)
    N            → (dropped — unknown position)

Output:
  scripts/.pbp-build/starters_by_player_season.json
  {
    "<player>|<school>|<year>": {
      "position":            "OH",
      "sets_played":         102,
      "rank_within_team_pos": 1,
      "year":                2024
    }
  }

Usage:
  py -X utf8 scripts/identify_starters.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pandas as pd

CSV_TEMPLATE = "public/data/wvb_playermatch_div1_{year}.csv"
OUT_PATH     = Path("scripts/.pbp-build/starters_by_player_season.json")

YEARS = [2022, 2023, 2024, 2025]

# Per-team-year starter slot counts by position
SLOTS_PER_POSITION = {
    "OH":   3,
    "OPP":  1,
    "MB":   2,
    "S":    1,
    "L/DS": 1,
}

# Position label canonicalization
POSITION_MAP = {
    "OH":   "OH",
    "O":    "OH",
    "OPP":  "OPP",
    "RS":   "OPP",
    "MB":   "MB",
    "MH":   "MB",
    "S":    "S",
    "L":    "L/DS",
    "DS":   "L/DS",
    "L/DS": "L/DS",
}


def load_year(year: int) -> pd.DataFrame:
    path = Path(CSV_TEMPLATE.format(year=year))
    if not path.exists():
        print(f"ERROR: {path} not found", file=sys.stderr)
        sys.exit(1)
    df = pd.read_csv(path, usecols=["Team", "Player", "P", "S"])
    df["year"] = year
    return df


def main() -> None:
    t0 = time.time()
    print(f"[starters] reading box-score CSVs for {YEARS}")
    frames = [load_year(y) for y in YEARS]
    df = pd.concat(frames, ignore_index=True)
    print(f"[starters] {len(df):,} player-match rows total")

    # Canonicalize position labels; drop unknown/N
    df["pos"] = df["P"].map(POSITION_MAP)
    before = len(df)
    df = df.dropna(subset=["pos"])
    dropped = before - len(df)
    print(f"[starters] {dropped:,} rows dropped (unmapped P labels)")

    # Per (player, team, year): primary position = mode of pos, sets = sum of S
    df["player_key"] = df["Player"].astype("string").str.lower().str.strip()
    df["school_key"] = df["Team"].astype("string").str.lower().str.strip()

    primary_pos = (
        df.groupby(["player_key", "school_key", "year"])["pos"]
          .agg(lambda s: s.mode().iat[0] if not s.mode().empty else None)
          .reset_index()
          .rename(columns={"pos": "position"})
    )
    sets_total = (
        df.groupby(["player_key", "school_key", "year"])["S"]
          .sum()
          .reset_index()
          .rename(columns={"S": "sets_played"})
    )
    # Keep display name + display school for the JSON
    display = (
        df.groupby(["player_key", "school_key", "year"])[["Player", "Team"]]
          .agg(lambda s: s.mode().iat[0] if not s.mode().empty else s.iat[0])
          .reset_index()
    )

    seasons = (
        primary_pos
        .merge(sets_total, on=["player_key", "school_key", "year"])
        .merge(display,    on=["player_key", "school_key", "year"])
    )
    print(f"[starters] {len(seasons):,} unique player-seasons (after position assignment)")

    # Rank by sets_played within each (school, year, position); top-N qualify
    seasons["rank_within_team_pos"] = (
        seasons.sort_values("sets_played", ascending=False)
               .groupby(["school_key", "year", "position"])
               .cumcount() + 1
    )

    # Filter to starter slots
    def is_starter(row) -> bool:
        slot_count = SLOTS_PER_POSITION.get(row["position"], 0)
        return row["rank_within_team_pos"] <= slot_count

    seasons["is_starter"] = seasons.apply(is_starter, axis=1)
    starters = seasons[seasons["is_starter"]].copy()
    print(f"[starters] {len(starters):,} starter-seasons "
          f"(expected ~{8 * 340 * len(YEARS):,})")

    # Position breakdown sanity
    print()
    print("[starters] starters by position (all years):")
    for pos, n in starters["position"].value_counts().items():
        slots = SLOTS_PER_POSITION.get(pos, 0)
        teams = n / (slots * len(YEARS)) if slots else 0
        print(f"  {pos:<5} {n:>5,}  (~{teams:.0f} teams × {slots} slot × {len(YEARS)} years)")

    # ── Build JSON ────────────────────────────────────────────────────
    out: dict = {}
    for _, row in starters.iterrows():
        key = f"{row['player_key']}|{row['school_key']}|{row['year']}"
        out[key] = {
            "position":            row["position"],
            "sets_played":         int(row["sets_played"]),
            "rank_within_team_pos": int(row["rank_within_team_pos"]),
            "year":                int(row["year"]),
            "player":              row["Player"],
            "school":              row["Team"],
        }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    elapsed = time.time() - t0
    print()
    print(f"[starters] done in {elapsed:.0f}s")
    print(f"[starters] wrote {OUT_PATH}  ({OUT_PATH.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
