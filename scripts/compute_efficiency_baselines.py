"""
compute_efficiency_baselines.py — Phase 6 cohort baselines.

Reads each per-skill quality JSON (or box scores for attack hitting%)
across 2022-25, filters to the "regular starter" cohort defined by
identify_starters.py, computes the scalar efficiency per player-season
using the locked formulas, and writes pooled distribution stats per
metric.

Locked scalar formulas:
    REC  = greatPct + 0.5 * goodPct  -  badPct
    SRV  = acePct   + 0.5 * greatPct -  0.5 * badPct  -  errorPct
    SET  = greatPct                                            (= assistPct)
    ATK  = (kills - errors) / total_attacks                    (hitting %)
    BLK  = (solos + 0.5*assists - errors) /
           (solos + 0.5*assists + errors)
    DIG  = greatPct + 0.5 * goodPct  -  badPct

Cohort: only starter-seasons (top 3 OH / 1 OPP / 2 MB / 1 S / 1 L/DS
per team-year). Pooled across all four years.

Output (consumed at runtime when computing the multiplier):
  public/data/efficiency_baselines.json
  {
    "reception": {
      "scalar_formula": "greatPct + 0.5*goodPct - badPct",
      "n": 7832,
      "mean":  0.45, "median": 0.46, "sd": 0.12,
      "p10":   0.30, "p25":  0.38, "p50": 0.46, "p75": 0.53, "p90": 0.60,
      "min":  -0.20, "max":  0.78
    },
    "serve": { ... },
    ...
  }

Usage:
  py -X utf8 scripts/compute_efficiency_baselines.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pandas as pd

YEARS = [2022, 2023, 2024, 2025]
DATA_DIR     = Path("public/data")
STARTERS_PATH = Path("scripts/.pbp-build/starters_by_player_season.json")
OUT_PATH     = DATA_DIR / "efficiency_baselines.json"

# Per-skill position cohort — which starters meaningfully perform this
# skill at sustained volume. OH is included in BLK because some programs
# don't distinguish OPP from OH in their NCAA P-column labels, so the
# OPP starter set under-counts; capturing OH-labeled-OPPs requires
# leaving OH in the BLK pool.
POSITION_COHORT = {
    "reception": {"OH", "L/DS"},
    "serve":     {"OH", "OPP", "MB", "S", "L/DS"},   # every starter serves
    "set":       {"S"},
    "attack":    {"OH", "OPP", "MB"},
    "block":     {"OH", "OPP", "MB"},
    "dig":       {"OH", "OPP", "MB", "S", "L/DS"},   # all positions dig
}


def load_quality(template: str) -> dict[str, dict]:
    """Load all years of a per-year quality JSON, return merged dict."""
    merged: dict[str, dict] = {}
    for y in YEARS:
        path = DATA_DIR / template.format(year=y)
        if not path.exists():
            print(f"[baselines] WARN: {path} not found, skipping year {y}", file=sys.stderr)
            continue
        d = json.loads(path.read_text(encoding="utf-8"))
        merged.update(d)
    return merged


def scalar_rec(v: dict) -> float:
    return v["greatPct"] + 0.5 * v["goodPct"] - v["badPct"]


def scalar_srv(v: dict) -> float:
    return v["acePct"] + 0.5 * v["greatPct"] - 0.5 * v["badPct"] - v["errorPct"]


def scalar_set(v: dict) -> float:
    return v["greatPct"]


def scalar_blk(v: dict) -> float | None:
    return v.get("blockEff")


def scalar_dig(v: dict) -> float:
    return v["greatPct"] + 0.5 * v["goodPct"] - v["badPct"]


def compute_distribution(values: list[float], formula: str) -> dict:
    if not values:
        return {"scalar_formula": formula, "n": 0}
    s = pd.Series(values)
    return {
        "scalar_formula": formula,
        "n":      int(s.size),
        "mean":   round(float(s.mean()),   4),
        "median": round(float(s.median()), 4),
        "sd":     round(float(s.std()),    4),
        "p10":    round(float(s.quantile(0.10)), 4),
        "p25":    round(float(s.quantile(0.25)), 4),
        "p50":    round(float(s.quantile(0.50)), 4),
        "p75":    round(float(s.quantile(0.75)), 4),
        "p90":    round(float(s.quantile(0.90)), 4),
        "min":    round(float(s.min()), 4),
        "max":    round(float(s.max()), 4),
    }


def load_atk_from_box_scores(starter_keys: set[str]) -> list[float]:
    """Aggregate Kills / Errors / TotalAttacks per (player, school, year)
    from box-score CSVs, filter to starters, return hitting% list."""
    rows = []
    for y in YEARS:
        path = DATA_DIR / f"wvb_playermatch_div1_{y}.csv"
        if not path.exists():
            print(f"[baselines] WARN: {path} not found, skipping ATK for {y}",
                  file=sys.stderr)
            continue
        df = pd.read_csv(path, usecols=["Team", "Player", "Kills", "Errors", "TotalAttacks"])
        df["year"] = y
        rows.append(df)
    if not rows:
        return []
    big = pd.concat(rows, ignore_index=True)
    big["player_key"] = big["Player"].astype("string").str.lower().str.strip()
    big["school_key"] = big["Team"].astype("string").str.lower().str.strip()
    agg = (
        big.groupby(["player_key", "school_key", "year"])
           [["Kills", "Errors", "TotalAttacks"]]
           .sum()
           .reset_index()
    )
    agg["key"] = agg["player_key"] + "|" + agg["school_key"] + "|" + agg["year"].astype(str)
    agg = agg[agg["key"].isin(starter_keys)]
    # Min 100 attempts on the season to qualify — matches the spirit of
    # the per-metric `qualified` flags on the touch-derived JSONs.
    agg = agg[agg["TotalAttacks"] >= 100]
    return ((agg["Kills"] - agg["Errors"]) / agg["TotalAttacks"]).tolist()


def main() -> None:
    if not STARTERS_PATH.exists():
        print(f"ERROR: {STARTERS_PATH} not found. Run identify_starters.py first.",
              file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    starters = json.loads(STARTERS_PATH.read_text(encoding="utf-8"))
    starter_keys = set(starters.keys())
    # Per-position starter key sets, used to build per-skill cohorts below.
    starters_by_pos: dict[str, set[str]] = {}
    for k, v in starters.items():
        starters_by_pos.setdefault(v["position"], set()).add(k)
    print(f"[baselines] {len(starter_keys):,} starter-seasons loaded")
    for pos, ks in sorted(starters_by_pos.items()):
        print(f"[baselines]   {pos:<5} {len(ks):>5,}")

    # ── Load all five quality JSONs (merged across years) ─────────────
    print("[baselines] loading per-skill quality JSONs …")
    rec_q = load_quality("wvb_reception_quality_{year}.json")
    srv_q = load_quality("wvb_serve_quality_{year}.json")
    set_q = load_quality("wvb_set_quality_{year}.json")
    blk_q = load_quality("wvb_block_quality_{year}.json")
    dig_q = load_quality("wvb_dig_quality_{year}.json")
    print(f"[baselines]   REC entries: {len(rec_q):,}")
    print(f"[baselines]   SRV entries: {len(srv_q):,}")
    print(f"[baselines]   SET entries: {len(set_q):,}")
    print(f"[baselines]   BLK entries: {len(blk_q):,}")
    print(f"[baselines]   DIG entries: {len(dig_q):,}")

    # ── Filter to per-skill cohorts and compute scalars ──────────────
    def cohort_keys(skill: str) -> set[str]:
        positions = POSITION_COHORT[skill]
        out: set[str] = set()
        for pos in positions:
            out |= starters_by_pos.get(pos, set())
        return out

    def skill_filter(q: dict, scalar_fn, skill: str) -> list[float]:
        keys = cohort_keys(skill)
        out = []
        for k, v in q.items():
            if k not in keys:
                continue
            # Require the per-metric qualification flag — drops sparse-
            # sample noise (e.g. an MB starter with 4 emergency receptions).
            if not v.get("qualified", False):
                continue
            x = scalar_fn(v)
            if x is None or pd.isna(x):
                continue
            out.append(float(x))
        return out

    print()
    print("[baselines] filtering per-skill cohorts (position × qualified) …")
    rec_vals = skill_filter(rec_q, scalar_rec, "reception")
    srv_vals = skill_filter(srv_q, scalar_srv, "serve")
    set_vals = skill_filter(set_q, scalar_set, "set")
    blk_vals = skill_filter(blk_q, scalar_blk, "block")
    dig_vals = skill_filter(dig_q, scalar_dig, "dig")
    atk_vals = load_atk_from_box_scores(cohort_keys("attack"))

    print(f"[baselines]   REC scalars: {len(rec_vals):,}")
    print(f"[baselines]   SRV scalars: {len(srv_vals):,}")
    print(f"[baselines]   SET scalars: {len(set_vals):,}")
    print(f"[baselines]   BLK scalars: {len(blk_vals):,}")
    print(f"[baselines]   DIG scalars: {len(dig_vals):,}")
    print(f"[baselines]   ATK scalars: {len(atk_vals):,}")

    # ── Build distributions ───────────────────────────────────────────
    out = {
        "cohort": {
            "description": "Regular starters: top 3 OH / 1 OPP / 2 MB / 1 S / 1 L/DS "
                           "per team-year, pooled across 2022-25.",
            "total_starter_seasons": len(starter_keys),
        },
        "reception": compute_distribution(rec_vals,
            "greatPct + 0.5*goodPct - badPct"),
        "serve":     compute_distribution(srv_vals,
            "acePct + 0.5*greatPct - 0.5*badPct - errorPct"),
        "set":       compute_distribution(set_vals,
            "greatPct (= assistPct)"),
        "attack":    compute_distribution(atk_vals,
            "(kills - errors) / total_attacks"),
        "block":     compute_distribution(blk_vals,
            "(solos + 0.5*assists - errors) / (solos + 0.5*assists + errors)"),
        "dig":       compute_distribution(dig_vals,
            "greatPct + 0.5*goodPct - badPct"),
    }

    OUT_PATH.write_text(json.dumps(out, indent=2), encoding="utf-8")
    elapsed = time.time() - t0
    print()
    print(f"[baselines] done in {elapsed:.0f}s")
    print(f"[baselines] wrote {OUT_PATH}  ({OUT_PATH.stat().st_size / 1024:.1f} KB)")

    # ── stdout summary ────────────────────────────────────────────────
    print()
    print("[baselines] Pooled starter-cohort distributions:")
    print(f"  {'skill':<10} {'n':>6} {'median':>9} {'sd':>8} {'p10':>8} {'p90':>8}")
    for skill in ("reception", "serve", "set", "attack", "block", "dig"):
        d = out[skill]
        if d.get("n", 0) == 0:
            print(f"  {skill:<10} {0:>6}  (no data)")
            continue
        print(f"  {skill:<10} {d['n']:>6}  "
              f"{d['median']:>+8.3f}  {d['sd']:>7.3f}  "
              f"{d['p10']:>+7.3f}  {d['p90']:>+7.3f}")


if __name__ == "__main__":
    main()
