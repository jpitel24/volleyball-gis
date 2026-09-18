"""
build_setscores.py — derive per-set final scores from the touch parquet.

Emits public/data/wvb_setscores_<year>.json in the shape the Game Browser
already consumes:

    { "<contest_id>": [[home, away], [home, away], ...], ... }

Each inner list is one set in play order. The score for a set is the
maximum score_home_after / score_away_after reached during any touch in
that set (i.e. the final score after the winning point lands).

The Python API pipeline (fetch_ncaa_api.py) has its own build_setscores
function that reads a different cache format — we're not using that
pipeline for 2026, so this smaller script pulls the same data out of
the touch parquet that our HTML-scraped PBP produces.

Usage:
  py -X utf8 scripts/build_setscores.py --year 2026
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

PARQUET_TEMPLATE = "scripts/.pbp-build/wvb_pbp_touches_{year}.parquet"
OUT_TEMPLATE     = "public/data/wvb_setscores_{year}.json"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    args = ap.parse_args()

    src = Path(PARQUET_TEMPLATE.format(year=args.year))
    if not src.exists():
        print(f"ERROR: {src} not found — run aggregate_pbp_touches.py first.",
              file=sys.stderr)
        sys.exit(1)

    print(f"[setscores] reading {src}")
    df = pd.read_parquet(
        src, columns=["contest_id", "set_num", "score_home_after", "score_away_after"]
    )
    df = df.dropna(subset=["contest_id", "set_num"])

    # For each (contest, set), the last touch's after-score IS the final
    # set score — but the max is safer since touches within a set can
    # sometimes land out of order in the parsed data. Both approaches
    # yield the same final scores for well-formed PBP feeds.
    finals = (
        df.groupby(["contest_id", "set_num"], as_index=False)
          .agg(home=("score_home_after", "max"),
               away=("score_away_after", "max"))
          .sort_values(["contest_id", "set_num"])
    )

    out: dict[str, list[list[int]]] = {}
    for cid, grp in finals.groupby("contest_id"):
        pairs = []
        for _, row in grp.iterrows():
            h = int(row["home"]) if pd.notna(row["home"]) else 0
            a = int(row["away"]) if pd.notna(row["away"]) else 0
            pairs.append([h, a])
        out[str(int(cid))] = pairs

    out_path = Path(OUT_TEMPLATE.format(year=args.year))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"[setscores] wrote {out_path} ({len(out)} contests, "
          f"{out_path.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
