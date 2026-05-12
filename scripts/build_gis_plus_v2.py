"""
build_gis_plus_v2.py — Phase 7 GIS+ builder.

Reads per-match box scores + per-match efficiency aggregates + season-
pooled efficiency baselines, applies the per-skill multiplier formula
on a per-match basis, and writes a per-match GIS+ CSV.

GIS+ formula (per match):
    positive_atk = Kills                              × 1.0   × m_atk
    positive_blk = (BlockSolos + 0.5*BlockAssists)    × 1.0   × m_blk
    positive_set = Assists                            × 0.5   × m_set
    positive_srv = Aces                               × 1.0   × m_srv
    positive_rec = (RetAtt − RErr)                    × 0.25  × m_rec
    positive_dig = Digs                               × 0.25  × m_dig

    errors_total = Errors + BErr + BHE + SErr + RErr

    GIS+ = (Σ positive_*  −  errors_total) × OpponentModifier

Per-skill multiplier (computed per-match using season baselines):
    eff      = per-match scalar  (e.g. hitting %, REC scalar, etc.)
    z        = (eff − season_median) / season_sd
    m_raw    = 1 + k × z
    trust    = attempts / (attempts + N0)
    m_shrunk = trust × m_raw + (1 − trust) × 1.0
    m_final  = max(m_shrunk, FLOOR)

Players with zero attempts in a skill get m = 1.0 (no signal, no adjustment).

Phase 7A intentionally drops the SetLeverageModifier — leverage is
deferred to Phase 7B (per-event leverage from score state).

Inputs:
    public/data/wvb_playermatch_div1_<year>.csv
    scripts/.pbp-build/per_match_efficiency_<year>.parquet
    public/data/efficiency_baselines.json
    public/data/historical_rpi.json

Output:
    public/data/gis_plus_v2_<year>.csv

Usage:
    py -X utf8 scripts/build_gis_plus_v2.py --year 2024
    py -X utf8 scripts/build_gis_plus_v2.py --year all  (runs 2022-25)
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from pathlib import Path

import pandas as pd

DATA_DIR     = Path("public/data")
PME_TEMPLATE = "scripts/.pbp-build/per_match_efficiency_{year}.parquet"
CSV_TEMPLATE = "public/data/wvb_playermatch_div1_{year}.csv"
RPI_PATH     = DATA_DIR / "historical_rpi.json"
BL_PATH      = DATA_DIR / "efficiency_baselines.json"
OUT_TEMPLATE = "public/data/gis_plus_v2_{year}.csv"

# ── Multiplier parameters ─────────────────────────────────────────────────────
K        = 0.15
FLOOR    = 0.25
# Per-match shrinkage prior — "attempts at which trust hits 50%"
N0 = {
    "reception": 10,
    "serve":     8,
    "set":       30,
    "attack":    10,
    "block":     3,
    "dig":       8,
}

# ── Skill weights (kept identical to current build_gis_plus.py) ───────────────
WEIGHT = {
    "atk": 1.0,
    "blk": 1.0,
    "set": 0.5,
    "srv": 1.0,
    "rec": 0.25,
    "dig": 0.25,
}

# ── Opponent modifier (lifted from build_gis_plus.py) ─────────────────────────
OPP_BOOST_CAP    = 1.20
OPP_DISCOUNT_CAP = 0.55
OPP_BOOST_PCT    = 0.20
OPP_DISCOUNT_PCT = 0.45


def is_nan(x) -> bool:
    try:
        return isinstance(x, float) and x != x
    except Exception:
        return False


def normalize_team(name: str) -> str:
    if not name:
        return ""
    return re.sub(r"\s*\(AQ\)\s*", "", name).strip()


def load_rpi(path: Path) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    per_season = {}
    for season, team_map in raw.items():
        teams, numeric = {}, []
        for k, v in team_map.items():
            if k.startswith("_"):
                continue
            teams[k] = v
            if v is not None and not is_nan(v):
                numeric.append(v)
        if not numeric:
            continue
        numeric_sorted = sorted(numeric)
        median = numeric_sorted[len(numeric_sorted) // 2]
        per_season[season] = {
            "teams": teams,
            "neutral_point": median,
            "min": min(numeric), "max": max(numeric),
        }
    return per_season


def opp_modifier(opp_rpi: float, season_info: dict) -> float:
    np_ = season_info["neutral_point"]
    mn, mx = season_info["min"], season_info["max"]
    if opp_rpi >= np_:
        if mx == np_:
            return 1.0
        return min(1.0 + OPP_BOOST_PCT * (opp_rpi - np_) / (mx - np_), OPP_BOOST_CAP)
    if np_ == mn:
        return 1.0
    return max(1.0 - OPP_DISCOUNT_PCT * (np_ - opp_rpi) / (np_ - mn), OPP_DISCOUNT_CAP)


def lookup_opp_rpi(opp_name: str, season_info: dict) -> float:
    norm = normalize_team(opp_name)
    rpi = season_info["teams"].get(norm)
    if rpi is not None and not is_nan(rpi):
        return rpi
    return season_info["min"]    # non-D1 opp → season floor


# ── Multiplier formula ────────────────────────────────────────────────────────

def multiplier(eff: float, attempts: int, baseline: dict, n0: int) -> float:
    """Per-match multiplier with shrinkage. attempts=0 → 1.0 (no signal)."""
    if attempts <= 0 or eff is None or math.isnan(eff):
        return 1.0
    median = baseline["median"]
    sd     = baseline["sd"]
    if sd <= 0:
        return 1.0
    z       = (eff - median) / sd
    m_raw   = 1.0 + K * z
    trust   = attempts / (attempts + n0)
    m_shrunk = trust * m_raw + (1 - trust) * 1.0
    return max(m_shrunk, FLOOR)


# ── Per-skill efficiency scalars (per-match) ─────────────────────────────────

def scalar_rec(row) -> tuple[float, int]:
    total = row["rec_great"] + row["rec_good"] + row["rec_bad"]
    if total <= 0:
        return float("nan"), 0
    g, o, b = row["rec_great"], row["rec_good"], row["rec_bad"]
    return (g + 0.5 * o - b) / total, total


def scalar_srv(row) -> tuple[float, int]:
    total = row["srv_ace"] + row["srv_great"] + row["srv_good"] + row["srv_bad"] + row["srv_err"]
    if total <= 0:
        return float("nan"), 0
    a, g, b, e = row["srv_ace"], row["srv_great"], row["srv_bad"], row["srv_err"]
    return (a + 0.5 * g - 0.5 * b - e) / total, total


def scalar_set(row) -> tuple[float, int]:
    total = row["set_great"] + row["set_good"] + row["set_bad"] + row["set_err"]
    if total <= 0:
        return float("nan"), 0
    return row["set_great"] / total, total


def scalar_dig(row) -> tuple[float, int]:
    total = row["dig_great"] + row["dig_good"] + row["dig_bad"]
    if total <= 0:
        return float("nan"), 0
    g, o, b = row["dig_great"], row["dig_good"], row["dig_bad"]
    return (g + 0.5 * o - b) / total, total


def scalar_atk(row) -> tuple[float, int]:
    att = row["TotalAttacks"]
    if att <= 0:
        return float("nan"), 0
    return (row["Kills"] - row["Errors"]) / att, int(att)


def scalar_blk(row) -> tuple[float, int]:
    s = row["BlockSolos"]; a = row["BlockAssists"]; e = row["BErr"]
    pos = s + 0.5 * a
    total = pos + e
    if total <= 0:
        return float("nan"), 0
    return (pos - e) / total, int(s + a + e)   # attempts = all block events


# ── Main per-year build ───────────────────────────────────────────────────────

def build_year(year: int, rpi: dict, bl: dict) -> Path:
    csv_path = Path(CSV_TEMPLATE.format(year=year))
    pme_path = Path(PME_TEMPLATE.format(year=year))
    out_path = Path(OUT_TEMPLATE.format(year=year))

    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found", file=sys.stderr); sys.exit(1)
    if not pme_path.exists():
        print(f"ERROR: {pme_path} not found", file=sys.stderr); sys.exit(1)

    t0 = time.time()
    print(f"[gisv2 {year}] loading box scores …")
    box = pd.read_csv(csv_path)
    print(f"[gisv2 {year}] loading per-match efficiency …")
    pme = pd.read_parquet(pme_path)

    # Normalize keys for join. Box-score CSV and PBP scrape use DIFFERENT
    # ContestID number spaces (different NCAA stats subsystems), so we
    # join on (date, player, school) — date is the only field that
    # uniquely disambiguates conference rematches and tournament games.
    box["player_key"] = box["Player"].astype("string").str.lower().str.strip()
    box["school_key"] = box["Team"].astype("string").str.lower().str.strip()
    box["date_key"]   = box["Date"].astype("string").str.strip()    # YYYY-MM-DD
    pme["date_key"]   = pme["match_date"].astype("string").str.strip()

    # LEFT JOIN — players without PBP touches still get a row (with m_* = 1.0)
    pme_cols = [c for c in pme.columns
                if c.startswith(("rec_", "srv_", "set_", "dig_"))]
    merged = box.merge(
        pme[["date_key", "player_key", "school_key"] + pme_cols],
        on=["date_key", "player_key", "school_key"], how="left",
    )
    for c in pme_cols:
        merged[c] = merged[c].fillna(0).astype("int32")
    print(f"[gisv2 {year}] {len(merged):,} player-match rows")

    # ── RPI lookup per match → opponent modifier ─────────────────────────
    season_info = rpi.get(str(year)) or rpi.get(year)
    if season_info is None:
        print(f"ERROR: no RPI data for {year}", file=sys.stderr); sys.exit(1)

    print(f"[gisv2 {year}] computing opponent modifiers …")
    opp_rpis  = merged["Opponent Team"].apply(lambda o: lookup_opp_rpi(o, season_info))
    opp_mods  = opp_rpis.apply(lambda r: opp_modifier(r, season_info))
    merged["OpponentRPI"]      = opp_rpis
    merged["OpponentModifier"] = opp_mods

    # ── Per-row multipliers and positive GIS components ─────────────────
    print(f"[gisv2 {year}] computing per-match scalars + multipliers …")
    bl_rec = bl["reception"]; bl_srv = bl["serve"]; bl_set = bl["set"]
    bl_atk = bl["attack"];    bl_blk = bl["block"]; bl_dig = bl["dig"]

    # Vectorize over the merged frame using apply (per-row), then expose
    # the new columns. For ~120K rows / year this is acceptable (~2s each).
    def compute(row):
        eff_rec, n_rec = scalar_rec(row)
        eff_srv, n_srv = scalar_srv(row)
        eff_set, n_set = scalar_set(row)
        eff_dig, n_dig = scalar_dig(row)
        eff_atk, n_atk = scalar_atk(row)
        eff_blk, n_blk = scalar_blk(row)

        m_rec = multiplier(eff_rec, n_rec, bl_rec, N0["reception"])
        m_srv = multiplier(eff_srv, n_srv, bl_srv, N0["serve"])
        m_set = multiplier(eff_set, n_set, bl_set, N0["set"])
        m_dig = multiplier(eff_dig, n_dig, bl_dig, N0["dig"])
        m_atk = multiplier(eff_atk, n_atk, bl_atk, N0["attack"])
        m_blk = multiplier(eff_blk, n_blk, bl_blk, N0["block"])

        pos_atk = row["Kills"]                                       * WEIGHT["atk"] * m_atk
        pos_blk = (row["BlockSolos"] + 0.5 * row["BlockAssists"])    * WEIGHT["blk"] * m_blk
        pos_set = row["Assists"]                                     * WEIGHT["set"] * m_set
        pos_srv = row["Aces"]                                        * WEIGHT["srv"] * m_srv
        pos_rec = (row["RetAtt"] - row["RErr"])                      * WEIGHT["rec"] * m_rec
        pos_dig = row["Digs"]                                        * WEIGHT["dig"] * m_dig

        errors_total = (row["Errors"] + row["BErr"] + row["BHE"]
                        + row["SErr"] + row["RErr"])
        raw_gis_plus = pos_atk + pos_blk + pos_set + pos_srv + pos_rec + pos_dig - errors_total
        gis_plus     = raw_gis_plus * row["OpponentModifier"]

        return pd.Series({
            "m_atk": m_atk, "m_blk": m_blk, "m_set": m_set,
            "m_srv": m_srv, "m_rec": m_rec, "m_dig": m_dig,
            "pos_atk": pos_atk, "pos_blk": pos_blk, "pos_set": pos_set,
            "pos_srv": pos_srv, "pos_rec": pos_rec, "pos_dig": pos_dig,
            "errors_total": errors_total,
            "raw_gis_plus": raw_gis_plus,
            "GIS_plus_v2":  gis_plus,
        })

    enriched = merged.apply(compute, axis=1)
    out = pd.concat([
        merged[["Season", "ContestID", "Date", "Team", "Conference", "Opponent Team",
                "Location", "Player", "P", "S",
                "Kills", "Errors", "TotalAttacks", "Assists", "Aces", "SErr",
                "Digs", "RetAtt", "RErr", "BlockSolos", "BlockAssists", "BErr",
                "BHE", "OpponentRPI", "OpponentModifier"]],
        enriched,
    ], axis=1)

    # Round float columns for clean output
    float_cols = [c for c in out.columns
                  if c.startswith(("m_", "pos_", "OpponentRPI", "OpponentModifier"))
                  or c in ("errors_total", "raw_gis_plus", "GIS_plus_v2")]
    for c in float_cols:
        out[c] = out[c].astype(float).round(4)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(out_path, index=False)

    elapsed = time.time() - t0
    print(f"[gisv2 {year}] done in {elapsed:.0f}s  ·  wrote {out_path}  "
          f"({out_path.stat().st_size / (1024 * 1024):.1f} MB)")
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", required=True, help="Single year or 'all'")
    args = ap.parse_args()

    print("[gisv2] loading RPI …")
    rpi = load_rpi(RPI_PATH)
    print("[gisv2] loading baselines …")
    bl = json.loads(BL_PATH.read_text(encoding="utf-8"))

    years = [2022, 2023, 2024, 2025] if args.year == "all" else [int(args.year)]
    for y in years:
        build_year(y, rpi, bl)


if __name__ == "__main__":
    main()
