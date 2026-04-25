"""
build_pgis_tables.py
────────────────────

Builds the per-position pGIS baseline distributions consumed by the UI
(src/lib/gis.js → computePGIS). A player's raw GIS+/S is percentile-ranked
against these distributions to produce a 0–10 pGIS score.

Specification (from the project lead):

  * Baseline cohort per team-match: top-N players by GIS+/S
      - OH group (OH, OPP, RS, …) → top 3
      - MB                         → top 2
      - S                          → top 1
      - L group (L, DS, LB)        → top 1
  * Both teams must be D1 in the given season (present in historical_rpi.json
    with a numeric RPI — NaNs are treated as non-D1).
  * Position per row: use the P column when populated; otherwise fall back to
    the player's season-stable position learned from their other rows; finally
    fall back to inferPosition() based on per-match stat rates (mirrors the
    JS implementation).
  * Match nSets = clamp(max(S across all players in contest), 3, 5).
  * Emit `public/data/pgis_tables.json` shaped as:
      { group: { "3"|"4"|"5": { "p": [sorted ints of (GIS+/S)*100] } } }
    (matches the shape src/lib/gis.js already expects).

Usage:
    python -X utf8 scripts/build_pgis_tables.py
"""
from __future__ import annotations

import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

SRC = Path("scripts/gis_plus_observations_full_local.csv")
RPI = Path("public/data/historical_rpi.json")
OUT = Path("public/data/pgis_tables.json")

POS_GROUP = {
    "S": "S",
    "OH": "OH", "RS": "OH", "OPP": "OH", "OP": "OH", "O": "OH",
    "OPPOSITE": "OH", "OPPO": "OH", "OUTSIDE": "OH", "OS": "OH",
    "MB": "MB", "MH": "MB",
    "L": "L", "DS": "L", "LB": "L",
}

# Per-match top-N per team per position bucket.
TOP_N = {"OH": 3, "MB": 2, "S": 1, "L": 1}


def pos_group(p: str) -> str | None:
    if not p:
        return None
    key = p.upper().split("/")[0].strip()
    return POS_GROUP.get(key)


def infer_position(stats: dict) -> str | None:
    """Mirror src/lib/gis.js inferPosition. Returns 'S' | 'OH' | 'MB' | 'L' | None."""
    k = stats.get("kills", 0)
    a = stats.get("assists", 0)
    d = stats.get("digs", 0)
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
    """'2022-2023' -> '2022'."""
    return season.split("-")[0]


def load_d1_sets(path: Path) -> dict[str, set[str]]:
    """{rpi_year: set(team_name_lower)} for teams with a numeric (non-NaN) RPI."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, set[str]] = {}
    for year, tm in raw.items():
        teams: set[str] = set()
        for k, v in tm.items():
            if k.startswith("_"):
                continue
            if v is None:
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
    """{rpi_year: set(team_name_lower)} for the top-N teams by numeric RPI.

    Higher RPI = better, so we sort desc and take the head N. Used to gate
    the pGIS baseline cohort to elite-vs-elite contests, which prevents
    mid-major top-N production against weak schedules from polluting the
    percentile distribution.
    """
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
    try:
        return int(v)
    except (ValueError, TypeError):
        return 0


def safe_float(v) -> float:
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def main() -> None:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found (expected the full local GIS+ CSV).", file=sys.stderr)
        sys.exit(1)

    d1 = load_d1_sets(RPI)
    top100 = load_top_n_sets(RPI, n=100)
    print("D1 team counts by season:")
    for y in sorted(d1):
        print(f"  {y}: {len(d1[y])} teams  (top-100: {len(top100.get(y, set()))})")

    # Season-stable player → position map (first non-null wins).
    player_pos: dict[tuple[str, str, str], str] = {}

    contest_teams: dict[tuple[str, str], set[str]] = defaultdict(set)
    roster: dict[tuple[str, str, str], list[dict]] = defaultdict(list)

    print(f"\nPass 1: reading {SRC.name} …")
    n = 0
    with SRC.open("r", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            n += 1
            if n % 100_000 == 0:
                print(f"  {n:,} rows")
            season = r["Season"]
            contest = r["ContestID"]
            team_lc = (r["Team"] or "").lower()
            player = r["Player"] or ""
            p_raw = (r.get("P") or "").strip()
            if p_raw:
                key = (season, team_lc, player.lower())
                if key not in player_pos:
                    grp = pos_group(p_raw)
                    if grp:
                        player_pos[key] = grp
            contest_teams[(season, contest)].add(team_lc)
            s = safe_int(r.get("S"))
            if s <= 0:
                continue
            # Skip ghost appearances: the NCAA CSV credits every rostered
            # player with the match's total sets even when they didn't
            # actually take the floor. Those rows have S>0 but zero across
            # every counting column. Including them adds GIS+/S=0 values
            # to the baseline distribution and inflates every real
            # player's pGIS percentile.
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
            gp = safe_float(r.get("GIS_Plus"))
            stats = {
                "kills":         safe_int(r.get("Kills")),
                "assists":       safe_int(r.get("Assists")),
                "digs":          safe_int(r.get("Digs")),
                "block_solos":   safe_int(r.get("BlockSolos")),
                "block_assists": safe_int(r.get("BlockAssists")),
            }
            roster[(season, contest, team_lc)].append({
                "player": player,
                "p_raw":  p_raw,
                "stats":  stats,
                "S":      s,
                "gp_per_s": gp / s if s > 0 else 0.0,
            })

    print(f"Loaded {n:,} rows  ·  {len(contest_teams):,} contests  ·  "
          f"{len(roster):,} team-matches  ·  {len(player_pos):,} known (team,player) positions")

    # Pass 2: filter to D1-vs-D1, bucket & collect top-N.
    print("\nPass 2: building baselines …")
    buckets: dict[tuple[str, str], list[int]] = defaultdict(list)
    contests_kept = 0
    contests_skipped_notd1 = 0
    contests_skipped_single = 0
    contests_skipped_nottop = 0

    for (season, contest), teams in contest_teams.items():
        if len(teams) != 2:
            contests_skipped_single += 1
            continue
        y = season_to_rpi_key(season)
        d1_season = d1.get(y, set())
        if not all(t in d1_season for t in teams):
            contests_skipped_notd1 += 1
            continue
        # Quality-cohort gate: both teams must be RPI top-100 that season.
        # The pGIS distribution should reflect elite-vs-elite production so
        # mid-major top-N production against weaker schedules doesn't anchor
        # the percentile curve.
        top_season = top100.get(y, set())
        if not all(t in top_season for t in teams):
            contests_skipped_nottop += 1
            continue
        contests_kept += 1

        # match nSets = clamp(max S, 3, 5)
        all_s: list[int] = []
        for t in teams:
            for pl in roster.get((season, contest, t), []):
                all_s.append(pl["S"])
        if not all_s:
            continue
        n_sets = max(3, min(5, max(all_s)))
        key_ns = str(n_sets)

        for t in teams:
            team_roster = roster.get((season, contest, t), [])
            by_group: dict[str, list[dict]] = defaultdict(list)
            for pl in team_roster:
                grp = pos_group(pl["p_raw"])
                if not grp:
                    grp = player_pos.get((season, t, pl["player"].lower()))
                if not grp:
                    grp = infer_position(pl["stats"])
                if not grp:
                    continue
                by_group[grp].append(pl)

            for grp, n_top in TOP_N.items():
                players = by_group.get(grp, [])
                players.sort(key=lambda x: x["gp_per_s"], reverse=True)
                for pl in players[:n_top]:
                    buckets[(grp, key_ns)].append(round(pl["gp_per_s"] * 100))

    print(f"  contests kept (both top-100):    {contests_kept:,}")
    print(f"  contests skipped (non-D1 side):  {contests_skipped_notd1:,}")
    print(f"  contests skipped (sub-100 side): {contests_skipped_nottop:,}")
    print(f"  contests skipped (not 2 teams):  {contests_skipped_single:,}")

    # Emit sorted lists + print distribution.
    out: dict[str, dict[str, dict[str, list[int]]]] = {}
    print("\nBaseline distributions (values are GIS+/S):")
    for (grp, ns), vals in buckets.items():
        vals.sort()
        out.setdefault(grp, {})[ns] = {"p": vals}

    for grp in ("OH", "MB", "S", "L"):
        for ns in ("3", "4", "5"):
            v = out.get(grp, {}).get(ns, {}).get("p", [])
            if not v:
                print(f"  {grp}/{ns}: (empty)")
                continue
            n = len(v)
            def p(q: float) -> float:
                return v[min(int(n * q), n - 1)] / 100.0
            print(f"  {grp}/{ns}: n={n:>6,}  "
                  f"p25={p(0.25):.2f}  p50={p(0.50):.2f}  "
                  f"p75={p(0.75):.2f}  p90={p(0.90):.2f}  "
                  f"p99={p(0.99):.2f}  max={v[-1]/100:.2f}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {OUT}  ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
