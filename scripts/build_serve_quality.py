"""
build_serve_quality.py — Phase 5 second touch-level metric.

Reads the per-touch Parquet (output of aggregate_pbp_touches.py) and
computes a per-(server, team, year) serve-quality breakdown.

Classification rules (per user spec — quality determined by what
happens within 3 touches after the reception, NOT eventual rally
outcome):

  ACE             — Rally terminates directly with an ace by us
  GREAT           — Rally terminates in our favor by the 3rd touch
                    after the reception (e.g. block kill on 3rd,
                    attack error by them on 2nd, set error on 1st)
  GOOD            — Rally extends past the 3rd touch after the
                    reception, regardless of eventual winner. The
                    serve neither created an immediate point nor
                    surrendered one.
  BAD             — Rally terminates in their favor by the 3rd touch
                    after the reception (clean conversion against us)
  SERVICE_ERROR   — Server beat themselves. Tracked separately below
                    BAD; not part of the four-tier rating.

Math, derived purely from rally_total_touches + rally_winner_side
(both denormalized onto every SERVE touch row, no self-joins needed):

  N = max(rally_total_touches - 2, 0)       # touches AFTER the reception
                                             #   (subtracting serve + reception)

  if rally_terminal == 'ACE'           → ACE
  if rally_terminal == 'SERVICE_ERROR' → ERROR (excluded from rating)
  elif N <= 2  →  terminal happens by 3rd touch after reception
                  → GREAT if winner == server_team
                  → BAD   otherwise
  else (N >= 3) →  rally extended past 3rd touch after reception → GOOD

Output schema (keyed by '<lowercase-name>|<lowercase-school>|<year>'):
  {
    "<player>|<school>|2025": {
      "total":        412,
      "ace":          42,
      "great":        88,
      "good":         145,
      "bad":          107,
      "error":        30,
      "acePct":       0.1019,
      "greatPct":     0.2136,
      "goodPct":      0.3519,
      "badPct":       0.2597,
      "errorPct":     0.0728,
      "effectivePct": 0.3155,    // (ace + great) / total — headline rate
      "qualified":    true        // total >= MIN_SERVES_QUALIFIED
    }
  }

Usage:
  py -X utf8 scripts/build_serve_quality.py --year 2025
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd

PARQUET_TEMPLATE = "scripts/.pbp-build/wvb_pbp_touches_{year}.parquet"
OUT_TEMPLATE     = "public/data/wvb_serve_quality_{year}.json"

MIN_SERVES_QUALIFIED = 100   # season-level threshold to chart in the leaderboard


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
    print(f"[serveq] loading {parquet_path}")
    df = pd.read_parquet(parquet_path)
    print(f"[serveq] {len(df):,} touch rows")

    serves = df[df["action"] == "SERVE"].copy()
    print(f"[serveq] {len(serves):,} serve rows")

    # ── Vectorized classification ─────────────────────────────────────
    print("[serveq] classifying …")
    rally_term   = serves["rally_terminal_type"]
    server_team  = serves["team"]
    rally_winner = serves["rally_winner_side"]
    # Touches AFTER the reception (subtract serve + reception).
    # max(., 0) for edge cases like rallies that ended on a reception
    # error before any reception non-terminal touch was recorded.
    N = (serves["rally_total_touches"].fillna(0).astype(int) - 2).clip(lower=0)

    quality = pd.Series("bad", index=serves.index, dtype=object)

    is_ace = (rally_term == "ACE") & (rally_winner == server_team)
    is_err = (rally_term == "SERVICE_ERROR")
    is_normal = ~is_ace & ~is_err

    we_won  = (rally_winner == server_team)
    early   = N <= 2          # terminal happens by 3rd touch after reception
    extended = N >= 3          # rally went past 3rd touch after reception

    quality[is_normal & early & we_won]                    = "great"
    quality[is_normal & early & ~we_won]                   = "bad"
    quality[is_normal & extended]                          = "good"
    quality[is_ace]                                        = "ace"
    quality[is_err]                                        = "error"

    serves["quality"] = quality

    # ── Aggregate per (player, school) ────────────────────────────────
    print("[serveq] aggregating …")
    serves["school"]     = serves["home_team"].where(
        serves["team"] == "home", serves["away_team"]
    )
    serves["player_key"] = serves["player"].astype("string").str.lower().str.strip()
    serves["school_key"] = serves["school"].astype("string").str.lower().str.strip()

    grouped = (
        serves.groupby(["player_key", "school_key", "school"])["quality"]
        .value_counts()
        .unstack(fill_value=0)
        .reset_index()
    )
    for col in ("ace", "great", "good", "bad", "error"):
        if col not in grouped.columns:
            grouped[col] = 0

    grouped["total"]        = grouped[["ace", "great", "good", "bad", "error"]].sum(axis=1)
    grouped["acePct"]       = grouped["ace"]   / grouped["total"]
    grouped["greatPct"]     = grouped["great"] / grouped["total"]
    grouped["goodPct"]      = grouped["good"]  / grouped["total"]
    grouped["badPct"]       = grouped["bad"]   / grouped["total"]
    grouped["errorPct"]     = grouped["error"] / grouped["total"]
    grouped["effectivePct"] = (grouped["ace"] + grouped["great"]) / grouped["total"]
    grouped["qualified"]    = grouped["total"] >= MIN_SERVES_QUALIFIED

    # ── Build JSON output ─────────────────────────────────────────────
    out: dict = {}
    for _, row in grouped.iterrows():
        pk = row["player_key"]
        sk = row["school_key"]
        if pd.isna(pk) or pd.isna(sk) or not pk or not sk:
            continue
        key = f"{pk}|{sk}|{year}"
        out[key] = {
            "total":        int(row["total"]),
            "ace":          int(row["ace"]),
            "great":        int(row["great"]),
            "good":         int(row["good"]),
            "bad":          int(row["bad"]),
            "error":        int(row["error"]),
            "acePct":       round(float(row["acePct"]),       4),
            "greatPct":     round(float(row["greatPct"]),     4),
            "goodPct":      round(float(row["goodPct"]),      4),
            "badPct":       round(float(row["badPct"]),       4),
            "errorPct":     round(float(row["errorPct"]),     4),
            "effectivePct": round(float(row["effectivePct"]), 4),
            "qualified":    bool(row["qualified"]),
            "school":       row["school"],
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")

    qualified = [v for v in out.values() if v["qualified"]]
    elapsed = time.time() - t0
    print()
    print(f"[serveq] done in {elapsed:.0f}s")
    print(f"[serveq] wrote {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)")
    print(f"[serveq] {len(out):,} player-team entries  "
          f"({len(qualified):,} qualified at ≥{MIN_SERVES_QUALIFIED} serves)")

    if qualified:
        avg_ace   = sum(v["acePct"]       for v in qualified) / len(qualified)
        avg_great = sum(v["greatPct"]     for v in qualified) / len(qualified)
        avg_good  = sum(v["goodPct"]      for v in qualified) / len(qualified)
        avg_bad   = sum(v["badPct"]       for v in qualified) / len(qualified)
        avg_err   = sum(v["errorPct"]     for v in qualified) / len(qualified)
        avg_eff   = sum(v["effectivePct"] for v in qualified) / len(qualified)
        print(f"[serveq] qualified avg:  ace {avg_ace:.1%}  great {avg_great:.1%}  "
              f"good {avg_good:.1%}  bad {avg_bad:.1%}  error {avg_err:.1%}")
        print(f"[serveq] avg effective (ace+great):  {avg_eff:.1%}")

        leaderboard = sorted(qualified, key=lambda v: -v["effectivePct"])[:15]
        print()
        print("[serveq] Top 15 by Effective% (ace + great):")
        for v in leaderboard:
            rev = next((k for k, val in out.items() if val is v), None)
            name = rev.split("|")[0] if rev else "?"
            school = v.get("school") or "?"
            print(f"  {name:<28} {school:<25}  "
                  f"eff={v['effectivePct']:.1%}  ace={v['acePct']:.1%}  "
                  f"great={v['greatPct']:.1%}  bad={v['badPct']:.1%}  "
                  f"err={v['errorPct']:.1%}  ({v['total']} serves)")


if __name__ == "__main__":
    main()
