"""
build_category_pgis_tables.py
─────────────────────────────

Per-category pGIS baselines consumed by PlayerModal. Same cohort logic as
build_pgis_tables.py (top-N per team-match by overall GIS+/S, D1-vs-D1
only) but the distributions are built per (category, position, nSets).

Shape matches what src/components/PlayerModal.jsx reads:

    {
      "attack":   { "OH": { "3": { "p": [...ints] }, "4": ..., "5": ... }, ... },
      "blocking": { ... },
      "defense":  { ... },
      "serving":  { ... },
      "setting":  { ... }
    }

Values are `category_gisNeutral_per_set × 100` rounded to int — same
encoding as pgis_tables.json, so computePGIS() works unchanged.

Mirrors src/lib/gis.js:
  ERR_FLOOR = 0.55, ERR_DAMP = 1.20, GIS_SCALE = 1.25
  CATEGORIES → attack / blocking / defense / serving / setting
  gisNeutral = (raw / S) * errPen * GIS_SCALE   (no opp mod, no leverage)

Usage:
    python -X utf8 scripts/build_category_pgis_tables.py
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
OUT = Path("public/data/category_pgis_tables.json")

ERR_FLOOR = 0.55
ERR_DAMP  = 1.20
GIS_SCALE = 1.25

# Mirrors CATEGORIES in src/lib/gis.js.
CATEGORIES = [
    ("attack",   {"kills": 1.00},                                 {"errors": 0.55}),
    ("blocking", {"block_solos": 1.10, "block_assists": 0.50},    {"blocking_errors": 0.30}),
    ("defense",  {"digs": 0.35},                                  {"reception_errors": 0.30}),
    ("serving",  {"service_aces": 1.20},                          {"service_errors": 0.35}),
    ("setting",  {"assists": 0.28},                               {"ball_handling_errors": 0.45}),
]

# CSV-column aliases for the stat keys computeCategoryGIS uses.
STAT_COL = {
    "kills":                "Kills",
    "errors":               "Errors",
    "block_solos":          "BlockSolos",
    "block_assists":        "BlockAssists",
    "blocking_errors":      "BErr",
    "digs":                 "Digs",
    "reception_errors":     "RErr",
    "service_aces":         "Aces",
    "service_errors":       "SErr",
    "assists":              "Assists",
    "ball_handling_errors": "BHE",
}

POS_GROUP = {
    "S": "S",
    "OH": "OH", "RS": "OH", "OPP": "OH", "OP": "OH", "O": "OH",
    "OPPOSITE": "OH", "OPPO": "OH", "OUTSIDE": "OH", "OS": "OH",
    "MB": "MB", "MH": "MB",
    "L": "L", "DS": "L", "LB": "L",
}
TOP_N = {"OH": 3, "MB": 2, "S": 1, "L": 1}


def pos_group(p: str) -> str | None:
    if not p:
        return None
    return POS_GROUP.get(p.upper().split("/")[0].strip())


def infer_position(stats: dict) -> str | None:
    k = stats.get("kills", 0); a = stats.get("assists", 0); d = stats.get("digs", 0)
    bs = stats.get("block_solos", 0); ba = stats.get("block_assists", 0)
    total = k + a + d + bs + ba
    if total == 0: return None
    btot = bs + ba
    if a > 8 and a > k * 3: return "S"
    if d > 4 and k < 3 and btot < 1: return "L"
    if btot >= 2 and k >= 2 and btot / (k + btot) >= 0.30: return "MB"
    if k > 0 or d > 0 or a > 0: return "OH"
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


def safe_int(v) -> int:
    try: return int(v)
    except (ValueError, TypeError): return 0


def safe_float(v) -> float:
    try: return float(v)
    except (ValueError, TypeError): return 0.0


def category_neutral_per_set(stats: dict, S: int) -> dict[str, float]:
    """Mirror computeCategoryGIS(p, ns, avgLev=1, oppMod=1).gisNeutral / S  (already per-set)."""
    out: dict[str, float] = {}
    for key, pos_w, err_w in CATEGORIES:
        raw    = sum(stats.get(k, 0) * w for k, w in pos_w.items())
        errSum = sum(stats.get(k, 0) * w for k, w in err_w.items())
        errPen = max(ERR_FLOOR, min(1.0, 1.0 - (errSum / (raw + 1)) * ERR_DAMP))
        vol    = raw / S if S > 0 else 0.0
        out[key] = vol * errPen * GIS_SCALE
    return out


def main() -> None:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found.", file=sys.stderr)
        sys.exit(1)

    d1 = load_d1_sets(RPI)

    player_pos: dict[tuple[str, str, str], str] = {}
    contest_teams: dict[tuple[str, str], set[str]] = defaultdict(set)
    roster: dict[tuple[str, str, str], list[dict]] = defaultdict(list)

    print(f"Pass 1: reading {SRC.name} …")
    n = 0
    with SRC.open("r", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            n += 1
            if n % 100_000 == 0:
                print(f"  {n:,} rows")
            season = r["Season"]; contest = r["ContestID"]
            team_lc = (r["Team"] or "").lower(); player = r["Player"] or ""
            p_raw = (r.get("P") or "").strip()
            if p_raw:
                key = (season, team_lc, player.lower())
                if key not in player_pos:
                    grp = pos_group(p_raw)
                    if grp: player_pos[key] = grp
            contest_teams[(season, contest)].add(team_lc)
            S = safe_int(r.get("S"))
            if S <= 0: continue
            # Skip ghost appearances (rostered but didn't play — NCAA
            # credits them with the match's total sets and zero stats).
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
            if action_total == 0: continue
            stats = {k: safe_int(r.get(col)) for k, col in STAT_COL.items()}
            roster[(season, contest, team_lc)].append({
                "player": player, "p_raw": p_raw, "stats": stats, "S": S,
                "gp_per_s": safe_float(r.get("GIS_Plus")) / S,
            })

    print(f"Loaded {n:,} rows  ·  {len(contest_teams):,} contests  ·  {len(roster):,} team-matches")

    # Pass 2: D1-vs-D1 filter → top-N per position → bucket category values.
    print("\nPass 2: bucketing …")
    # buckets[(category, group, nsets_key)] = [ints of (category_neutral_per_set * 100)]
    buckets: dict[tuple[str, str, str], list[int]] = defaultdict(list)
    kept = skipped_d1 = skipped_one = 0

    for (season, contest), teams in contest_teams.items():
        if len(teams) != 2:
            skipped_one += 1; continue
        y = season_to_rpi_key(season)
        d1_season = d1.get(y, set())
        if not all(t in d1_season for t in teams):
            skipped_d1 += 1; continue
        kept += 1

        all_S = [pl["S"] for t in teams for pl in roster.get((season, contest, t), [])]
        if not all_S: continue
        n_sets = max(3, min(5, max(all_S)))
        ns_key = str(n_sets)

        for t in teams:
            team_roster = roster.get((season, contest, t), [])
            by_group: dict[str, list[dict]] = defaultdict(list)
            for pl in team_roster:
                grp = pos_group(pl["p_raw"]) \
                   or player_pos.get((season, t, pl["player"].lower())) \
                   or infer_position(pl["stats"])
                if not grp: continue
                by_group[grp].append(pl)

            for grp, n_top in TOP_N.items():
                players = by_group.get(grp, [])
                players.sort(key=lambda x: x["gp_per_s"], reverse=True)
                for pl in players[:n_top]:
                    cats = category_neutral_per_set(pl["stats"], pl["S"])
                    for cat_key, val in cats.items():
                        buckets[(cat_key, grp, ns_key)].append(round(val * 100))

    print(f"  contests kept (both D1):         {kept:,}")
    print(f"  contests skipped (non-D1 side):  {skipped_d1:,}")
    print(f"  contests skipped (not 2 teams):  {skipped_one:,}")

    # Emit.
    out: dict = {}
    for (cat, grp, ns), vals in buckets.items():
        vals.sort()
        out.setdefault(cat, {}).setdefault(grp, {})[ns] = {"p": vals}

    print("\nCategory baseline distributions (category_gisNeutral_per_set):")
    for cat in ("attack", "blocking", "defense", "serving", "setting"):
        for grp in ("OH", "MB", "S", "L"):
            for ns in ("3", "4", "5"):
                v = out.get(cat, {}).get(grp, {}).get(ns, {}).get("p", [])
                if not v:
                    continue
                n = len(v)
                def q(qv): return v[min(int(n * qv), n - 1)] / 100.0
                print(f"  {cat:<8} {grp}/{ns}: n={n:>6,}  p50={q(0.5):.2f}  p90={q(0.9):.2f}  max={v[-1]/100:.2f}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {OUT}  ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
