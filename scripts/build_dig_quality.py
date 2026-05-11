"""
build_dig_quality.py — Phase 6 efficiency metric, dig version.

Mirrors build_reception_quality.py but starts from DIG touches. A dig is
the defender's contact on an opponent's attack. Quality is determined
by what happens on the counter-attack:

  GREAT — Setter took 2nd touch after the dig AND 3rd-touch attack
          was a KILL by us (clean counter-attack out of transition)
  BAD   — Setter NOT on 2nd touch after the dig (dig went over,
          overpass, free-ball back — defense recovered but not in
          attacking shape)
       OR Setter on 2nd + 3rd-touch attack was BLOCK_KILL by opponent
       OR Setter on 2nd + 3rd-touch attack was ATTACK_ERROR by us
          (delivery / transition setup failed)
  GOOD  — Setter on 2nd + everything else (rally continued without a
          clean transition kill; the dig kept the ball alive in
          attacking shape but didn't immediately convert)

Rallies can have multiple digs (long defensive sequences). Each DIG row
is classified independently — same player can get multiple GREAT/GOOD/
BAD credits in a single long rally.

Dig errors (rally-ending failed dig) don't produce a DIG row in the
touch table — only the terminal event row — so they're inherently
excluded from this rating. The rating applies only to digs that kept
the ball alive.

Setter identification per (contest_id, team): same logic as
build_reception_quality.py — top 1-2 players by SET touches in the
match, min 5 sets, top 2 kept to handle 6-2 systems.

Output schema (keyed by '<lowercase-name>|<lowercase-school>|<year>'):
  {
    "<player>|<school>|2024": {
      "total":     312,
      "great":     74,
      "good":      168,
      "bad":       70,
      "greatPct":  0.2372,
      "goodPct":   0.5385,
      "badPct":    0.2244,
      "qualified": true        // total >= MIN_DIGS_QUALIFIED
    }
  }

Usage:
  py -X utf8 scripts/build_dig_quality.py --year 2025
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd

PARQUET_TEMPLATE = "scripts/.pbp-build/wvb_pbp_touches_{year}.parquet"
OUT_TEMPLATE     = "public/data/wvb_dig_quality_{year}.json"

MIN_SETS_FOR_SETTER  = 5
TOP_SETTERS_PER_TEAM = 2
MIN_DIGS_QUALIFIED   = 50


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
    print(f"[digq] loading {parquet_path}")
    df = pd.read_parquet(parquet_path)
    print(f"[digq] {len(df):,} touch rows")

    # ── Step 1: setter identification per (contest_id, team) ─────────
    print("[digq] identifying setters per match …")
    sets_only = df[df["action"] == "SET"][["contest_id", "team", "player"]]
    setter_counts = (
        sets_only.groupby(["contest_id", "team", "player"])
        .size()
        .reset_index(name="set_count")
    )
    setter_counts = setter_counts[setter_counts["set_count"] >= MIN_SETS_FOR_SETTER]
    setter_top = (
        setter_counts.sort_values("set_count", ascending=False)
        .groupby(["contest_id", "team"])
        .head(TOP_SETTERS_PER_TEAM)
        .copy()
    )
    setter_top["_is_setter"] = True
    print(f"[digq]   {len(setter_top):,} (contest, team, player) setter assignments")

    # ── Step 2: digs + 2nd + 3rd touch via self-joins ────────────────
    print("[digq] joining 2nd and 3rd touch context …")
    keep = ["contest_id", "set_num", "rally_id", "touch_idx", "team", "action", "player"]
    second = df[keep].rename(columns={
        "touch_idx": "_t2",
        "team":      "second_team",
        "action":    "second_action",
        "player":    "second_player",
    })
    third = df[keep].rename(columns={
        "touch_idx": "_t3",
        "team":      "third_team",
        "action":    "third_action",
        "player":    "third_player",
    })

    digs = df[df["action"] == "DIG"].copy()
    digs["_t2"] = digs["touch_idx"] + 1
    digs["_t3"] = digs["touch_idx"] + 2

    merged = digs.merge(
        second, on=["contest_id", "set_num", "rally_id", "_t2"], how="left"
    )
    merged = merged.merge(
        third, on=["contest_id", "set_num", "rally_id", "_t3"], how="left"
    )

    # Was the 2nd-touch player actually their team's setter that match?
    merged = merged.merge(
        setter_top[["contest_id", "team", "player", "_is_setter"]].rename(
            columns={"player": "second_player"}
        ),
        on=["contest_id", "team", "second_player"],
        how="left",
    )
    merged["_is_setter"] = merged["_is_setter"].fillna(False).astype(bool)
    print(f"[digq]   {len(merged):,} dig rows after self-joins")

    # ── Step 3: vectorized classification ─────────────────────────────
    print("[digq] classifying …")
    setter_on_2nd = (
        (merged["second_action"] == "SET")
        & (merged["second_team"] == merged["team"])
        & merged["_is_setter"]
    )
    third_was_attack = (merged["third_action"] == "ATTACK")
    rally_won_by_us  = (merged["rally_winner_side"] == merged["team"])
    rally_won_by_opp = ~rally_won_by_us
    terminal         = merged["rally_terminal_type"]

    quality = pd.Series("bad", index=merged.index, dtype=object)
    quality[setter_on_2nd] = "good"

    setter_attack = setter_on_2nd & third_was_attack
    quality[setter_attack & rally_won_by_us  & (terminal == "KILL")]         = "great"
    quality[setter_attack & rally_won_by_opp & (terminal == "BLOCK_KILL")]   = "bad"
    quality[setter_attack & rally_won_by_opp & (terminal == "ATTACK_ERROR")] = "bad"

    merged["quality"] = quality

    # ── Step 4: aggregate per (player, school) ────────────────────────
    print("[digq] aggregating …")
    merged["digger_school"] = merged["home_team"].where(
        merged["team"] == "home", merged["away_team"]
    )
    merged["player_key"] = merged["player"].astype("string").str.lower().str.strip()
    merged["school_key"] = merged["digger_school"].astype("string").str.lower().str.strip()

    grouped = (
        merged.groupby(["player_key", "school_key", "digger_school"])["quality"]
        .value_counts()
        .unstack(fill_value=0)
        .reset_index()
    )
    for col in ("great", "good", "bad"):
        if col not in grouped.columns:
            grouped[col] = 0
    grouped["total"]     = grouped["great"] + grouped["good"] + grouped["bad"]
    grouped["greatPct"]  = grouped["great"] / grouped["total"]
    grouped["goodPct"]   = grouped["good"]  / grouped["total"]
    grouped["badPct"]    = grouped["bad"]   / grouped["total"]
    grouped["qualified"] = grouped["total"] >= MIN_DIGS_QUALIFIED

    # ── Step 5: build JSON output ─────────────────────────────────────
    out: dict = {}
    for _, row in grouped.iterrows():
        pk = row["player_key"]
        sk = row["school_key"]
        if pd.isna(pk) or pd.isna(sk) or not pk or not sk:
            continue
        key = f"{pk}|{sk}|{year}"
        out[key] = {
            "total":     int(row["total"]),
            "great":     int(row["great"]),
            "good":      int(row["good"]),
            "bad":       int(row["bad"]),
            "greatPct":  round(float(row["greatPct"]), 4),
            "goodPct":   round(float(row["goodPct"]),  4),
            "badPct":    round(float(row["badPct"]),   4),
            "qualified": bool(row["qualified"]),
            "school":    row["digger_school"],
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")

    qualified = [v for v in out.values() if v["qualified"]]
    elapsed = time.time() - t0
    print()
    print(f"[digq] done in {elapsed:.0f}s")
    print(f"[digq] wrote {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)")
    print(f"[digq] {len(out):,} player-team entries  "
          f"({len(qualified):,} qualified at ≥{MIN_DIGS_QUALIFIED} digs)")

    if qualified:
        avg = sum(v["greatPct"] for v in qualified) / len(qualified)
        avg_g = sum(v["goodPct"] for v in qualified) / len(qualified)
        avg_b = sum(v["badPct"]  for v in qualified) / len(qualified)
        print(f"[digq] qualified avg:  great {avg:.1%}  good {avg_g:.1%}  bad {avg_b:.1%}")

        leaderboard = [v for v in out.values() if v["qualified"] and v["total"] >= 100]
        leaderboard.sort(key=lambda v: -v["greatPct"])
        print()
        print("[digq] Top 15 by Great% (min 100 digs):")
        for v in leaderboard[:15]:
            rev = next((k for k, val in out.items() if val is v), None)
            name = rev.split("|")[0] if rev else "?"
            print(f"  {name:<28} {v['school']:<25}  "
                  f"great={v['greatPct']:.1%}  good={v['goodPct']:.1%}  bad={v['badPct']:.1%}  "
                  f"({v['total']} digs)")


if __name__ == "__main__":
    main()
