"""
build_set_quality.py — Phase 5 third touch-level metric.

Reads the per-touch Parquet (output of aggregate_pbp_touches.py) and
computes a per-(setter, team, year) set-quality breakdown.

Classification rules (per user spec):

  GREAT    — SET → next touch is ATTACK by setter's team → attack
             is a KILL by setter's team. This is an ASSIST.
  GOOD     — SET → next touch is ATTACK by setter's team → attack
             happens but isn't a kill. The set delivered to the
             hitter; what happened downstream (block, error,
             continuing rally) is the hitter / next-touch's story.
  BAD      — SET → next touch is NOT an ATTACK by setter's team.
             Net faults, back-row faults, free balls over, anything
             else where the offense never materialized.
  ERROR    — SET_ERROR terminal. The setter's attempt at a set itself
             failed — no SET non-terminal row produced. Counted by
             walking terminals and attributing to rally_terminal_player.

Headline metrics:
  successPct = (great + good) / total      "did the setter deliver?"
  assistPct  = great / total                fraction of sets producing a kill

No setter list / no opponent setter list / no position map needed —
the player on the SET row IS the setter being rated, and the
classification rules look only at the immediate next touch + rally
outcome (both already denormalized onto each touch row).

Output schema (keyed by '<lowercase-name>|<lowercase-school>|<year>'):
  {
    "<setter>|<school>|2025": {
      "total":      2147,
      "great":      611,
      "good":       902,
      "bad":        604,
      "error":      30,
      "greatPct":   0.2845,
      "goodPct":    0.4202,
      "badPct":     0.2813,
      "errorPct":   0.0140,
      "successPct": 0.7048,    // (great + good) / total — headline
      "assistPct":  0.2845,    // great / total — bonus
      "qualified":  true        // total >= MIN_SETS_QUALIFIED
    }
  }

Usage:
  py -X utf8 scripts/build_set_quality.py --year 2025
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd

PARQUET_TEMPLATE = "scripts/.pbp-build/wvb_pbp_touches_{year}.parquet"
OUT_TEMPLATE     = "public/data/wvb_set_quality_{year}.json"

MIN_SETS_QUALIFIED = 200   # season-level threshold; filters out emergency setters / liberos


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True,
                    help="Season label, e.g. 2025 for 2025-26")
    args = ap.parse_args()
    year = args.year

    parquet_path = Path(PARQUET_TEMPLATE.format(year=year))
    out_path     = Path(OUT_TEMPLATE.format(year=year))

    if not parquet_path.exists():
        print(f"ERROR: {parquet_path} not found. Run aggregate_pbp_touches.py first.",
              file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    print(f"[setq] loading {parquet_path}")
    df = pd.read_parquet(parquet_path)
    print(f"[setq] {len(df):,} touch rows")

    sets = df[df["action"] == "SET"].copy()
    print(f"[setq] {len(sets):,} set rows")

    # ── Vectorized GREAT / GOOD / BAD on SET non-terminal rows ────────
    print("[setq] classifying non-terminal SETs …")
    same_team_attack = (sets["next_action"] == "ATTACK") & (sets["next_team"] == sets["team"])

    # Was the next ATTACK the rally's last non-terminal touch (i.e. the
    # attack itself was terminal)? attack_idx == last_touch_idx.
    last_touch_idx   = sets["rally_total_touches"].fillna(0).astype(int) - 1
    attack_idx       = sets["touch_idx"] + 1
    attack_was_last  = (attack_idx == last_touch_idx)

    is_assist = (
        same_team_attack
        & attack_was_last
        & (sets["rally_terminal_type"] == "KILL")
        & (sets["rally_terminal_team"] == sets["team"])
    )

    quality = pd.Series("bad", index=sets.index, dtype=object)
    quality[same_team_attack]              = "good"
    quality[is_assist]                     = "great"
    sets["quality"] = quality

    # ── Roll up per (player, school) ──────────────────────────────────
    print("[setq] aggregating non-terminal SETs …")
    sets["school"]     = sets["home_team"].where(sets["team"] == "home", sets["away_team"])
    sets["player_key"] = sets["player"].astype("string").str.lower().str.strip()
    sets["school_key"] = sets["school"].astype("string").str.lower().str.strip()

    setter_grouped = (
        sets.groupby(["player_key", "school_key", "school"])["quality"]
        .value_counts()
        .unstack(fill_value=0)
        .reset_index()
    )
    for col in ("great", "good", "bad"):
        if col not in setter_grouped.columns:
            setter_grouped[col] = 0

    # ── SET_ERROR attribution (separate pass over terminals) ──────────
    # SET_ERROR terminals don't produce a SET non-terminal row, so we
    # walk the touch table for any row whose rally terminated as a
    # SET_ERROR, dedupe by rally to avoid double-counting (every touch
    # in the rally has the same terminal denormalized), then attribute
    # to the rally_terminal_player on the rally_terminal_team's school.
    print("[setq] attributing SET_ERROR terminals …")
    err_rows = df[df["rally_terminal_type"] == "SET_ERROR"].copy()
    err_unique = err_rows.drop_duplicates(["contest_id", "rally_id"])
    err_unique["school"] = err_unique["home_team"].where(
        err_unique["rally_terminal_team"] == "home",
        err_unique["away_team"],
    )
    err_unique["player_key"] = err_unique["rally_terminal_player"].astype("string").str.lower().str.strip()
    err_unique["school_key"] = err_unique["school"].astype("string").str.lower().str.strip()
    err_counts = (
        err_unique.groupby(["player_key", "school_key", "school"])
        .size()
        .reset_index(name="error")
    )
    print(f"[setq]   {len(err_unique):,} unique SET_ERROR rallies")

    # Merge errors onto the GREAT/GOOD/BAD aggregate
    grouped = setter_grouped.merge(
        err_counts, on=["player_key", "school_key", "school"], how="outer"
    )
    for col in ("great", "good", "bad", "error"):
        if col not in grouped.columns:
            grouped[col] = 0
        grouped[col] = grouped[col].fillna(0).astype(int)

    grouped["total"]      = grouped["great"] + grouped["good"] + grouped["bad"] + grouped["error"]
    grouped["greatPct"]   = grouped["great"]              / grouped["total"]
    grouped["goodPct"]    = grouped["good"]               / grouped["total"]
    grouped["badPct"]     = grouped["bad"]                / grouped["total"]
    grouped["errorPct"]   = grouped["error"]              / grouped["total"]
    grouped["successPct"] = (grouped["great"] + grouped["good"]) / grouped["total"]
    grouped["assistPct"]  = grouped["great"]              / grouped["total"]
    grouped["qualified"]  = grouped["total"] >= MIN_SETS_QUALIFIED

    # ── Build JSON ─────────────────────────────────────────────────────
    out: dict = {}
    for _, row in grouped.iterrows():
        pk = row["player_key"]
        sk = row["school_key"]
        if pd.isna(pk) or pd.isna(sk) or not pk or not sk:
            continue
        key = f"{pk}|{sk}|{year}"
        out[key] = {
            "total":      int(row["total"]),
            "great":      int(row["great"]),
            "good":       int(row["good"]),
            "bad":        int(row["bad"]),
            "error":      int(row["error"]),
            "greatPct":   round(float(row["greatPct"]),   4),
            "goodPct":    round(float(row["goodPct"]),    4),
            "badPct":     round(float(row["badPct"]),     4),
            "errorPct":   round(float(row["errorPct"]),   4),
            "successPct": round(float(row["successPct"]), 4),
            "assistPct":  round(float(row["assistPct"]),  4),
            "qualified":  bool(row["qualified"]),
            "school":     row["school"],
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")

    qualified = [v for v in out.values() if v["qualified"]]
    elapsed = time.time() - t0
    print()
    print(f"[setq] done in {elapsed:.0f}s")
    print(f"[setq] wrote {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)")
    print(f"[setq] {len(out):,} player-team entries  "
          f"({len(qualified):,} qualified at ≥{MIN_SETS_QUALIFIED} sets)")

    if qualified:
        avg_great   = sum(v["greatPct"]   for v in qualified) / len(qualified)
        avg_good    = sum(v["goodPct"]    for v in qualified) / len(qualified)
        avg_bad     = sum(v["badPct"]     for v in qualified) / len(qualified)
        avg_err     = sum(v["errorPct"]   for v in qualified) / len(qualified)
        avg_success = sum(v["successPct"] for v in qualified) / len(qualified)
        avg_assist  = sum(v["assistPct"]  for v in qualified) / len(qualified)
        print(f"[setq] qualified avg:  great {avg_great:.1%}  good {avg_good:.1%}  "
              f"bad {avg_bad:.1%}  error {avg_err:.1%}")
        print(f"[setq] avg successPct (great+good): {avg_success:.1%}")
        print(f"[setq] avg assistPct  (great):      {avg_assist:.1%}")

        # Top 15 by successPct
        leaderboard = sorted(qualified, key=lambda v: -v["successPct"])[:15]
        print()
        print("[setq] Top 15 by Success% (great + good):")
        for v in leaderboard:
            rev = next((k for k, val in out.items() if val is v), None)
            name = rev.split("|")[0] if rev else "?"
            school = v.get("school") or "?"
            print(f"  {name:<28} {school:<25}  "
                  f"success={v['successPct']:.1%}  "
                  f"assist={v['assistPct']:.1%}  "
                  f"great={v['greatPct']:.1%}  good={v['goodPct']:.1%}  "
                  f"bad={v['badPct']:.1%}  err={v['errorPct']:.1%}  "
                  f"({v['total']} sets)")


if __name__ == "__main__":
    main()
