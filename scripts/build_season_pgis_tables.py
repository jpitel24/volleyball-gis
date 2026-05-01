"""
build_season_pgis_tables.py
───────────────────────────

Builds **season-aggregate** pGIS baseline distributions consumed by the UI
(src/lib/gis.js → computeSeasonPGIS). Replaces the
"average per-game pGIS values" approach for season-level pGIS with a true
percentile rank of the player's season GIS+/S aggregate against their
position cohort. Mirrors how OPS+ / similar metrics work in baseball.

Per-game pGIS (Game Browser inspector, rolling sparkline) keeps using
pgis_tables.json. Season pGIS in the Player/Season/Team browsers will use
this new file.

Cohort gates match build_pgis_tables.py:
  * Player's team must be top-100 RPI that season.
  * Player's team itself must be present in the season's RPI table (D1).
  * Plus: player must have appeared in at least MIN_TEAM_GAME_SHARE
    (75%) of their team's contests for the season — same gate the
    Season Browser already enforces in JS.

Position resolution uses the same chain the JS does:
  CSV P column (most common across player's season rows) → ultimate
  fallback to inferPosition() over the player's per-season totals.

Bucket by position only (no nSets sub-bucket — season aggregates blend
across all match lengths the player faced).

Output shape (matches what computeSeasonPGIS expects):
    {
      "OH": { "p": [sorted ints of (GIS+/S × 100)] },
      "MB": { "p": [...] },
      "S":  { "p": [...] },
      "L":  { "p": [...] }
    }

Usage:
    py -X utf8 scripts/build_season_pgis_tables.py
"""
from __future__ import annotations

import csv
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

SRC = Path("scripts/gis_plus_observations_full_local.csv")
RPI = Path("public/data/historical_rpi.json")
OUT = Path("public/data/season_pgis_tables.json")

MIN_TEAM_GAME_SHARE = 0.75   # mirrors src/components/SeasonLookup.jsx

POS_GROUP = {
    "S": "S",
    "OH": "OH", "RS": "OH", "OPP": "OH", "OP": "OH", "O": "OH",
    "OPPOSITE": "OH", "OPPO": "OH", "OUTSIDE": "OH", "OS": "OH",
    "MB": "MB", "MH": "MB",
    "L": "L", "DS": "L", "LB": "L",
}


def pos_group(p: str) -> str | None:
    if not p:
        return None
    key = p.upper().split("/")[0].strip()
    return POS_GROUP.get(key)


def infer_position(stats: dict) -> str | None:
    """Mirror src/lib/gis.js inferPosition. Returns 'S' | 'OH' | 'MB' | 'L' | None."""
    k  = stats.get("kills", 0)
    a  = stats.get("assists", 0)
    d  = stats.get("digs", 0)
    bs = stats.get("block_solos", 0)
    ba = stats.get("block_assists", 0)
    total = k + a + d + bs + ba
    if total == 0:
        return None
    btot = bs + ba
    if a > 8 and a > k * 3:
        return "S"
    if d > 4 and k < 3 and btot < 1:
        return "L"
    if btot >= 2 and k >= 2 and btot / (k + btot) >= 0.30:
        return "MB"
    if k > 0 or d > 0 or a > 0:
        return "OH"
    return None


def season_to_rpi_key(season: str) -> str:
    return season.split("-")[0]


def load_d1_sets(path: Path) -> dict[str, set[str]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, set[str]] = {}
    for year, tm in raw.items():
        teams: set[str] = set()
        for k, v in tm.items():
            if k.startswith("_") or v is None:
                continue
            try:
                if isinstance(v, float) and math.isnan(v):
                    continue
            except Exception:
                pass
            teams.add(k.lower())
        out[year] = teams
    return out


def load_top_n_sets(path: Path, n: int = 100) -> dict[str, set[str]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, set[str]] = {}
    for year, tm in raw.items():
        rated: list[tuple[str, float]] = []
        for k, v in tm.items():
            if k.startswith("_") or v is None:
                continue
            try:
                if isinstance(v, float) and math.isnan(v):
                    continue
            except Exception:
                pass
            try:
                rated.append((k.lower(), float(v)))
            except (ValueError, TypeError):
                continue
        rated.sort(key=lambda x: x[1], reverse=True)
        out[year] = {name for name, _ in rated[:n]}
    return out


def safe_int(v) -> int:
    try: return int(v)
    except (ValueError, TypeError): return 0


def safe_float(v) -> float:
    try: return float(v)
    except (ValueError, TypeError): return 0.0


def main() -> None:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found.", file=sys.stderr)
        sys.exit(1)

    d1 = load_d1_sets(RPI)
    top100 = load_top_n_sets(RPI, n=100)
    print("D1 / top-100 team counts by RPI year:")
    for y in sorted(d1):
        print(f"  {y}: D1={len(d1[y])}, top-100={len(top100.get(y, set()))}")

    # Season-aggregate accumulator: (season, team_lc, player_lc) → dict
    #   {S, GIS_Plus_sum, posCounts: Counter, contestIds: set, totals: dict}
    agg: dict[tuple[str, str, str], dict] = {}
    # Per (season, team_lc) → set of distinct ContestIDs that team appeared in.
    team_contests: dict[tuple[str, str], set[str]] = defaultdict(set)

    print(f"\nPass 1: reading {SRC.name} …")
    n = 0
    with SRC.open("r", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            n += 1
            if n % 100_000 == 0:
                print(f"  {n:,} rows")
            season  = r["Season"]
            contest = r["ContestID"]
            team_lc = (r["Team"] or "").lower()
            player  = r["Player"] or ""
            player_lc = player.lower()
            if not season or not contest or not team_lc or not player:
                continue

            S = safe_int(r.get("S"))
            if S <= 0:
                continue
            # DNP ghost-row filter — same as the per-match builder.
            action_total = (
                safe_int(r.get("Kills"))        + safe_int(r.get("Errors"))
              + safe_int(r.get("TotalAttacks")) + safe_int(r.get("Assists"))
              + safe_int(r.get("Aces"))         + safe_int(r.get("SErr"))
              + safe_int(r.get("ServeAtt"))     + safe_int(r.get("RErr"))
              + safe_int(r.get("RetAtt"))       + safe_int(r.get("SetErr"))
              + safe_int(r.get("SetAtt"))       + safe_int(r.get("Digs"))
              + safe_int(r.get("BlockSolos"))   + safe_int(r.get("BlockAssists"))
              + safe_int(r.get("BErr"))         + safe_int(r.get("BHE"))
            )
            if action_total == 0:
                continue

            team_contests[(season, team_lc)].add(contest)

            key = (season, team_lc, player_lc)
            slot = agg.get(key)
            if slot is None:
                slot = {
                    "player":      player,
                    "S":           0,
                    "GIS_Plus":    0.0,
                    "posCounts":   Counter(),
                    "contestIds":  set(),
                    # Season totals for inferPosition() fallback.
                    "kills":         0,
                    "assists":       0,
                    "digs":          0,
                    "block_solos":   0,
                    "block_assists": 0,
                }
                agg[key] = slot

            slot["S"]        += S
            slot["GIS_Plus"] += safe_float(r.get("GIS_Plus"))
            slot["contestIds"].add(contest)
            p_raw = (r.get("P") or "").strip().upper()
            if p_raw:
                slot["posCounts"][p_raw] += 1
            slot["kills"]         += safe_int(r.get("Kills"))
            slot["assists"]       += safe_int(r.get("Assists"))
            slot["digs"]          += safe_int(r.get("Digs"))
            slot["block_solos"]   += safe_int(r.get("BlockSolos"))
            slot["block_assists"] += safe_int(r.get("BlockAssists"))

    print(f"Loaded {n:,} rows  ·  {len(agg):,} player-seasons  ·  "
          f"{sum(len(v) for v in team_contests.values()):,} team-contest pairs")

    # Pass 2: gate on cohort + 75% team games + position resolve, bucket.
    print("\nPass 2: applying gates …")
    buckets: dict[str, list[int]] = defaultdict(list)
    kept = 0
    skipped_team_share = 0
    skipped_team_d1    = 0
    skipped_team_top   = 0
    skipped_no_pos     = 0
    skipped_no_sets    = 0
    skipped_no_gis     = 0

    for (season, team_lc, player_lc), slot in agg.items():
        team_games_total = len(team_contests.get((season, team_lc), set()))
        player_games     = len(slot["contestIds"])
        if team_games_total <= 0:
            skipped_team_share += 1
            continue
        if player_games / team_games_total < MIN_TEAM_GAME_SHARE:
            skipped_team_share += 1
            continue

        y = season_to_rpi_key(season)
        if team_lc not in d1.get(y, set()):
            skipped_team_d1 += 1
            continue
        if team_lc not in top100.get(y, set()):
            skipped_team_top += 1
            continue

        S = slot["S"]
        if S <= 0:
            skipped_no_sets += 1
            continue
        gis_plus_per_set = slot["GIS_Plus"] / S
        if gis_plus_per_set <= 0:
            skipped_no_gis += 1
            continue

        # Position resolution: CSV most-common → infer fallback.
        pos = None
        if slot["posCounts"]:
            top_pos, _ = slot["posCounts"].most_common(1)[0]
            pos = pos_group(top_pos)
        if not pos:
            pos = infer_position(slot)
        if not pos:
            skipped_no_pos += 1
            continue

        buckets[pos].append(round(gis_plus_per_set * 100))
        kept += 1

    print(f"  kept (qualifying player-seasons):     {kept:,}")
    print(f"  skipped (under-75% team-games gate):  {skipped_team_share:,}")
    print(f"  skipped (team not D1 that season):    {skipped_team_d1:,}")
    print(f"  skipped (team not top-100 that year): {skipped_team_top:,}")
    print(f"  skipped (no resolvable position):     {skipped_no_pos:,}")
    print(f"  skipped (zero sets / zero GIS+):      {skipped_no_sets + skipped_no_gis:,}")

    out: dict[str, dict[str, list[int]]] = {}
    for grp, vals in buckets.items():
        vals.sort()
        out[grp] = {"p": vals}

    print("\nSeason-aggregate baseline distributions (values are GIS+/S):")
    for grp in ("OH", "MB", "S", "L"):
        v = out.get(grp, {}).get("p", [])
        if not v:
            print(f"  {grp}: (empty)")
            continue
        n = len(v)
        def p(q: float) -> float:
            return v[min(int(n * q), n - 1)] / 100.0
        print(f"  {grp}: n={n:>5,}  "
              f"p10={p(0.10):.2f}  p25={p(0.25):.2f}  p50={p(0.50):.2f}  "
              f"p75={p(0.75):.2f}  p90={p(0.90):.2f}  p99={p(0.99):.2f}  "
              f"max={v[-1]/100:.2f}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {OUT}  ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
