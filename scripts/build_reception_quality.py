"""
build_reception_quality.py — Phase 5 first touch-level metric.

Reads the per-touch Parquet (output of aggregate_pbp_touches.py) and
computes a per-(player, team, year) reception-quality breakdown.

Classification rules (per user spec):

  GREAT — Setter took 2nd touch AND attack on 3rd was a KILL by us
  BAD   — Setter NOT on 2nd touch (any non-setter handled the 2nd ball)
       OR Setter on 2nd + 3rd-touch attack was BLOCK_KILL by opponent
       OR Setter on 2nd + 3rd-touch attack was ATTACK_ERROR by us
          (D1-level hitters rarely just mistime an attack — we treat
          attack errors as a delivery problem upstream)
  GOOD  — Setter on 2nd + everything else (rally continued, setter
          messed up the set without an attack happening, etc.)

Errored receptions (RECEPTION_ERROR / opponent ACE) are inherently
absent from this rating because they don't produce a RECEPTION row in
the touch table — only the terminal event row that the parser put in
result. The rating only applies to receptions that kept the ball alive.

Setter identification per (contest_id, team): the player(s) on the
team with the most SET non-terminal touches in that match, with a
floor of 5 sets in the match. Top 2 players kept (handles 6-2 dual-
setter systems). All-action-based, no need to join box-score data.

Output schema (keyed by '<lowercase-name>|<lowercase-school>|<year>'):
  {
    "kassie o'brien|kentucky|2025": {
      "total":     412,
      "great":     159,
      "good":      147,
      "bad":       106,
      "greatPct":  0.3859,
      "goodPct":   0.3568,
      "badPct":    0.2573,
      "qualified": true        // total >= MIN_RECEPTIONS_QUALIFIED
    },
    ...
  }

Usage:
  py -X utf8 scripts/build_reception_quality.py --year 2025
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd

PARQUET_TEMPLATE = "scripts/.pbp-build/wvb_pbp_touches_{year}.parquet"
OUT_TEMPLATE     = "public/data/wvb_reception_quality_{year}.json"

MIN_SETS_FOR_SETTER      = 5     # match-level threshold to count a player as "the setter"
TOP_SETTERS_PER_TEAM     = 2     # 1 for 5-1, 2 for 6-2 — keep top 2 to be safe
MIN_RECEPTIONS_QUALIFIED = 50    # season-level threshold to chart


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
    print(f"[recq] loading {parquet_path}")
    df = pd.read_parquet(parquet_path)
    print(f"[recq] {len(df):,} touch rows")

    # ── Step 1: setter identification per (contest_id, team) ─────────
    print("[recq] identifying setters per match …")
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
    print(f"[recq]   {len(setter_top):,} (contest, team, player) setter assignments")

    # ── Step 2: receptions + 2nd + 3rd touch via self-joins ──────────
    print("[recq] joining 2nd and 3rd touch context …")
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

    receptions = df[df["action"] == "RECEPTION"].copy()
    receptions["_t2"] = receptions["touch_idx"] + 1
    receptions["_t3"] = receptions["touch_idx"] + 2

    merged = receptions.merge(
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
    print(f"[recq]   {len(merged):,} reception rows after self-joins")

    # ── Step 3: vectorized classification ─────────────────────────────
    print("[recq] classifying …")
    setter_on_2nd = (
        (merged["second_action"] == "SET")
        & (merged["second_team"] == merged["team"])
        & merged["_is_setter"]
    )
    third_was_attack = (merged["third_action"] == "ATTACK")
    rally_won_by_us  = (merged["rally_winner_side"] == merged["team"])
    rally_won_by_opp = ~rally_won_by_us
    terminal         = merged["rally_terminal_type"]

    # Default: bad (covers setter-not-on-2nd, the broadest case)
    quality = pd.Series("bad", index=merged.index, dtype=object)

    # Setter on 2nd → default to good
    quality[setter_on_2nd] = "good"

    # Setter on 2nd AND 3rd was an attack: branch by terminal
    setter_attack = setter_on_2nd & third_was_attack
    # KILL by us → great
    quality[setter_attack & rally_won_by_us & (terminal == "KILL")] = "great"
    # BLOCK_KILL by opp → bad
    quality[setter_attack & rally_won_by_opp & (terminal == "BLOCK_KILL")] = "bad"
    # ATTACK_ERROR by us → bad (per user spec — D1 hitters rarely just
    # mistime; treat as a delivery problem upstream)
    quality[setter_attack & rally_won_by_opp & (terminal == "ATTACK_ERROR")] = "bad"

    merged["quality"] = quality

    # ── Step 4: aggregate per (player, school) ────────────────────────
    print("[recq] aggregating …")
    merged["receiver_school"] = merged["home_team"].where(
        merged["team"] == "home", merged["away_team"]
    )
    merged["player_key"]   = merged["player"].astype("string").str.lower().str.strip()
    merged["school_key"]   = merged["receiver_school"].astype("string").str.lower().str.strip()

    grouped = (
        merged.groupby(["player_key", "school_key", "receiver_school"])["quality"]
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
    grouped["qualified"] = grouped["total"] >= MIN_RECEPTIONS_QUALIFIED

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
            "school":    row["receiver_school"],     # human-readable, kept for debug
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")

    # ── Step 6: stdout summary ────────────────────────────────────────
    qualified = [v for v in out.values() if v["qualified"]]
    elapsed = time.time() - t0
    print()
    print(f"[recq] done in {elapsed:.0f}s")
    print(f"[recq] wrote {out_path}  "
          f"({out_path.stat().st_size / 1024:.0f} KB)")
    print(f"[recq] {len(out):,} player-team entries  "
          f"({len(qualified):,} qualified at ≥{MIN_RECEPTIONS_QUALIFIED} receptions)")

    if qualified:
        avg = sum(v["greatPct"] for v in qualified) / len(qualified)
        avg_g = sum(v["goodPct"]  for v in qualified) / len(qualified)
        avg_b = sum(v["badPct"]   for v in qualified) / len(qualified)
        print(f"[recq] qualified avg:  great {avg:.1%}  good {avg_g:.1%}  bad {avg_b:.1%}")

        # Top 15 by greatPct (min 100 receptions to surface in the leaderboard)
        leaderboard = [v for v in out.values() if v["qualified"] and v["total"] >= 100]
        leaderboard.sort(key=lambda v: -v["greatPct"])
        print()
        print("[recq] Top 15 by Great% (min 100 receptions):")
        # Build name-lookup so we can print the displayable name + school
        for v in leaderboard[:15]:
            # Find the corresponding key entry to display name nicely
            rev = next((k for k, val in out.items() if val is v), None)
            name = rev.split("|")[0] if rev else "?"
            school = v.get("school") or "?"
            print(f"  {name:<28} {school:<25}  "
                  f"great={v['greatPct']:.1%}  good={v['goodPct']:.1%}  bad={v['badPct']:.1%}  "
                  f"({v['total']} receptions)")


if __name__ == "__main__":
    main()
