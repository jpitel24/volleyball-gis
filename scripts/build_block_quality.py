"""
build_block_quality.py — Phase 6 efficiency metric.

Reads per-match box-score CSVs (public/data/wvb_playermatch_div1_<year>.csv)
and computes a per-(player, team, year) block-efficiency score using the
locked formula:

    block_eff = (solos + 0.5 * assists - errors)
                / (solos + 0.5 * assists + errors)

Bounded in [-1, 1] when denominator > 0, null when the player had no
block events at all.

Why box scores instead of touches parquet? NCAA's PBP doesn't reliably
expose multi-blocker secondary credit (the touches schema only carries
rally_terminal_player, not secondaries), and BS / BA / BE are already
authoritatively counted per-match in the box-score CSVs. Same source
of truth NCAA uses for end-of-season block leaderboards.

Output schema (keyed by '<lowercase-name>|<lowercase-school>|<year>'):
  {
    "<player>|<school>|2024": {
      "solos":        12,
      "assists":      67,
      "errors":        8,
      "total_events": 87,
      "blockEff":     0.4615,
      "qualified":   true,
      "school":      "Stanford"
    }
  }

Usage:
  py -X utf8 scripts/build_block_quality.py --year 2024
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd

CSV_TEMPLATE = "public/data/wvb_playermatch_div1_{year}.csv"
OUT_TEMPLATE = "public/data/wvb_block_quality_{year}.json"

# Low qualification floor at the JSON level — the starter-filter cohort
# applied at baseline-compute time is the real quality gate.
MIN_EVENTS_QUALIFIED = 20


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True,
                    help="Season label, e.g. 2024 for 2024-25")
    args = ap.parse_args()
    year = args.year

    csv_path = Path(CSV_TEMPLATE.format(year=year))
    out_path = Path(OUT_TEMPLATE.format(year=year))

    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    print(f"[blockq] loading {csv_path}")
    df = pd.read_csv(csv_path, usecols=[
        "Team", "Player", "BlockSolos", "BlockAssists", "BErr"
    ])
    print(f"[blockq] {len(df):,} player-match rows")

    # ── Aggregate per (player, school) ────────────────────────────────
    df["player_key"] = df["Player"].astype("string").str.lower().str.strip()
    df["school_key"] = df["Team"].astype("string").str.lower().str.strip()

    grouped = (
        df.groupby(["player_key", "school_key", "Team"], dropna=False)
          [["BlockSolos", "BlockAssists", "BErr"]]
          .sum()
          .reset_index()
          .rename(columns={
              "BlockSolos":   "solos",
              "BlockAssists": "assists",
              "BErr":         "errors",
              "Team":         "school",
          })
    )
    grouped["total_events"] = grouped[["solos", "assists", "errors"]].sum(axis=1)

    # block_eff = (s + 0.5a - e) / (s + 0.5a + e). Null when denominator
    # is zero (player had zero block events all season).
    pos = grouped["solos"] + 0.5 * grouped["assists"]
    num = pos - grouped["errors"]
    den = pos + grouped["errors"]
    grouped["blockEff"] = (num / den).where(den > 0)
    grouped["qualified"] = grouped["total_events"] >= MIN_EVENTS_QUALIFIED

    # ── Build JSON output ─────────────────────────────────────────────
    out: dict = {}
    for _, row in grouped.iterrows():
        pk = row["player_key"]
        sk = row["school_key"]
        if pd.isna(pk) or pd.isna(sk) or not pk or not sk:
            continue
        eff = row["blockEff"]
        key = f"{pk}|{sk}|{year}"
        out[key] = {
            "solos":        int(row["solos"]),
            "assists":      int(row["assists"]),
            "errors":       int(row["errors"]),
            "total_events": int(row["total_events"]),
            "blockEff":     round(float(eff), 4) if pd.notna(eff) else None,
            "qualified":    bool(row["qualified"]),
            "school":       row["school"],
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")

    qualified = [v for v in out.values() if v["qualified"] and v["blockEff"] is not None]
    elapsed = time.time() - t0
    print()
    print(f"[blockq] done in {elapsed:.0f}s")
    print(f"[blockq] wrote {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)")
    print(f"[blockq] {len(out):,} player-team entries  "
          f"({len(qualified):,} qualified at ≥{MIN_EVENTS_QUALIFIED} events)")

    if qualified:
        avg = sum(v["blockEff"] for v in qualified) / len(qualified)
        print(f"[blockq] qualified mean blockEff: {avg:+.3f}")
        leaderboard = sorted(qualified, key=lambda v: -v["blockEff"])[:15]
        print()
        print("[blockq] Top 15 by blockEff:")
        for v in leaderboard:
            rev = next((k for k, val in out.items() if val is v), None)
            name = rev.split("|")[0] if rev else "?"
            print(f"  {name:<28} {v['school']:<25}  "
                  f"eff={v['blockEff']:+.3f}  "
                  f"(s={v['solos']}, a={v['assists']}, e={v['errors']})")


if __name__ == "__main__":
    main()
