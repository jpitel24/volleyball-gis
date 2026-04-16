#!/usr/bin/env python3
"""
build_gis.py

Reads the 2022–2025 player-match CSV files in public/data/ and computes a raw
GIS score for every qualifying player-match observation. (2021 is currently
excluded because its source CSV lacks a RetAtt column; see YEARS comment.)

GIS = (Kills × 1.0) + (Aces × 1.0) + (BlockSolos × 1.0)
    + (Assists × 0.5) + (BlockAssists × 0.5)
    + (Passes × 0.25) + (Digs × 0.25)
    - (Errors × 1.0) - (SErr × 1.0) - (BErr × 1.0) - (RErr × 1.0) - (BHE × 1.0)

Where Passes = RetAtt - RErr

Usage:
    python scripts/build_gis.py

Output:
    public/data/gis_observations.csv
"""

import csv
import sys
from pathlib import Path
from collections import defaultdict

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR   = SCRIPT_DIR.parent / "public" / "data"
OUT_PATH   = DATA_DIR / "gis_observations.csv"

# 2021 is excluded: the source CSV lacks a RetAtt column and deriving it from
# the 2021 PBP file would require reconciling date/key formatting and a PBP
# event vocabulary that doesn't cleanly distinguish reception errors. We may
# revisit and repair 2021 later; for now downstream analysis starts at 2022.
YEARS = [2022, 2023, 2024, 2025]

# ── Filtering ─────────────────────────────────────────────────────────────────
EXCLUDE_SEASONS = {"2020-2021", "2021-2022"}
EXCLUDE_PLAYERS = {"Totals", "Opponent Totals", "TEAM"}

# ── Position normalization ────────────────────────────────────────────────────
POS_MAP = {
    "RS":  "OPP",
    "DS":  "L/DS",
    "L":   "L/DS",
}

# ── Output columns ───────────────────────────────────────────────────────────
OUTPUT_COLS = [
    "Season", "ContestID", "Date", "Team", "Conference", "Opponent Team",
    "Opponent Conference", "Location", "Player", "P", "S",
    "Kills", "Errors", "TotalAttacks", "HitPct",
    "Assists", "Aces", "SErr", "Digs", "RetAtt", "RErr",
    "BlockSolos", "BlockAssists", "BErr", "BHE",
    "Passes", "GIS",
]

# ── Helpers ───────────────────────────────────────────────────────────────────

def safe_int(val):
    """Parse a string to int, returning 0 on failure."""
    try:
        return int(val)
    except (ValueError, TypeError):
        return 0


def safe_float(val):
    """Parse a string to float, returning 0.0 on failure."""
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


def make_contest_id(date, away_team, home_team):
    """Synthetic contest ID for years that lack one."""
    d = date.replace("/", "-")
    a = away_team.lower().replace(" ", "_")
    h = home_team.lower().replace(" ", "_")
    return f"{d}_{a}_{h}"


def compute_gis(row):
    """Compute raw GIS from a parsed row dict. Returns (passes, gis)."""
    kills  = safe_int(row.get("Kills"))
    aces   = safe_int(row.get("Aces"))
    bs     = safe_int(row.get("BlockSolos"))
    assists = safe_int(row.get("Assists"))
    ba     = safe_int(row.get("BlockAssists"))
    digs   = safe_int(row.get("Digs"))
    errors = safe_int(row.get("Errors"))
    serr   = safe_int(row.get("SErr"))
    berr   = safe_int(row.get("BErr"))
    rerr   = safe_int(row.get("RErr"))
    bhe    = safe_int(row.get("BHE"))

    ret_att = safe_int(row.get("RetAtt"))
    passes  = ret_att - rerr

    gis = (
        kills * 1.0
        + aces * 1.0
        + bs * 1.0
        + assists * 0.5
        + ba * 0.5
        + passes * 0.25
        + digs * 0.25
        - errors * 1.0
        - serr * 1.0
        - berr * 1.0
        - rerr * 1.0
        - bhe * 1.0
    )

    return passes, round(gis, 2)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    observations = []
    season_counts = defaultdict(int)

    for file_year in YEARS:
        fpath = DATA_DIR / f"wvb_playermatch_div1_{file_year}.csv"
        if not fpath.exists():
            print(f"  WARNING: {fpath.name} not found — skipping", file=sys.stderr)
            continue

        print(f"Reading {fpath.name}…")
        with open(fpath, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # ── Filter ────────────────────────────────────────────────
                season = (row.get("Season") or "").strip()
                if season in EXCLUDE_SEASONS:
                    continue

                player = (row.get("Player") or "").strip()
                if player in EXCLUDE_PLAYERS or not player:
                    continue

                sets_played = safe_int(row.get("S"))
                if sets_played == 0:
                    continue

                # ── Derive contest ID ─────────────────────────────────────
                contest_id = (row.get("ContestID") or "").strip()
                if not contest_id:
                    team     = (row.get("Team") or "").strip()
                    opp_team = (row.get("Opponent Team") or "").strip()
                    date     = (row.get("Date") or "").strip()
                    location = (row.get("Location") or "").strip()
                    if location == "Home":
                        contest_id = make_contest_id(date, opp_team, team)
                    elif location == "Away":
                        contest_id = make_contest_id(date, team, opp_team)
                    else:
                        # Neutral — sort alphabetically for consistency
                        pair = sorted([team, opp_team])
                        contest_id = make_contest_id(date, pair[0], pair[1])

                # ── Normalize position ────────────────────────────────────
                pos_raw = (row.get("P") or "").strip().upper()
                pos = POS_MAP.get(pos_raw, pos_raw)

                # ── Compute GIS ───────────────────────────────────────────
                passes, gis = compute_gis(row)

                # ── Build output row ──────────────────────────────────────
                obs = {
                    "Season":              season,
                    "ContestID":           contest_id,
                    "Date":                (row.get("Date") or "").strip(),
                    "Team":                (row.get("Team") or "").strip(),
                    "Conference":          (row.get("Conference") or "").strip(),
                    "Opponent Team":       (row.get("Opponent Team") or "").strip(),
                    "Opponent Conference": (row.get("Opponent Conference") or "").strip(),
                    "Location":            (row.get("Location") or "").strip(),
                    "Player":              player,
                    "P":                   pos,
                    "S":                   sets_played,
                    "Kills":               safe_int(row.get("Kills")),
                    "Errors":              safe_int(row.get("Errors")),
                    "TotalAttacks":        safe_int(row.get("TotalAttacks")),
                    "HitPct":              safe_float(row.get("HitPct")),
                    "Assists":             safe_int(row.get("Assists")),
                    "Aces":                safe_int(row.get("Aces")),
                    "SErr":                safe_int(row.get("SErr")),
                    "Digs":                safe_int(row.get("Digs")),
                    "RetAtt":              safe_int(row.get("RetAtt")),
                    "RErr":                safe_int(row.get("RErr")),
                    "BlockSolos":          safe_int(row.get("BlockSolos")),
                    "BlockAssists":        safe_int(row.get("BlockAssists")),
                    "BErr":                safe_int(row.get("BErr")),
                    "BHE":                 safe_int(row.get("BHE")),
                    "Passes":              passes,
                    "GIS":                 gis,
                }
                observations.append(obs)
                season_counts[season] += 1

    # ── Write output ──────────────────────────────────────────────────────────
    print(f"\nWriting {OUT_PATH.name}…")
    with open(OUT_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLS)
        writer.writeheader()
        writer.writerows(observations)

    # ── Summary stats ─────────────────────────────────────────────────────────
    n = len(observations)
    print(f"\n{'=' * 60}")
    print(f"Total observations: {n:,}")
    print()

    print("Observations per season:")
    for season in sorted(season_counts.keys()):
        print(f"  {season}: {season_counts[season]:,}")
    print()

    if n > 0:
        gis_vals = [obs["GIS"] for obs in observations]
        gis_min  = min(gis_vals)
        gis_max  = max(gis_vals)
        gis_mean = sum(gis_vals) / n

        print(f"GIS  min: {gis_min:.2f}")
        print(f"GIS  max: {gis_max:.2f}")
        print(f"GIS mean: {gis_mean:.2f}")
        print()

        # Top 5 single-match GIS
        top5 = sorted(observations, key=lambda o: o["GIS"], reverse=True)[:5]
        print("Top 5 single-match GIS scores:")
        print(f"  {'Player':<25} {'Team':<22} {'Opponent':<22} {'Date':<12} {'S':>2}  {'GIS':>6}")
        print(f"  {'-'*25} {'-'*22} {'-'*22} {'-'*12} {'-'*2}  {'-'*6}")
        for o in top5:
            print(f"  {o['Player']:<25} {o['Team']:<22} {o['Opponent Team']:<22} {o['Date']:<12} {o['S']:>2}  {o['GIS']:>6.2f}")

    print()
    size_mb = OUT_PATH.stat().st_size / 1024 / 1024
    print(f"Output: {OUT_PATH}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
