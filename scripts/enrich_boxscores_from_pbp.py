"""
enrich_boxscores_from_pbp.py

Fills in ServeAtt / SetErr / SetAtt on a newly-scraped box-score CSV
by joining tier counts from the per-match efficiency parquet.

The stats.ncaa.org /individual_stats page doesn't publish these three
columns (they were populated for older seasons via different sources).
For 2026+ data, we recover them from the PBP tier counts:

    ServeAtt = srv_ace + srv_great + srv_good + srv_bad + srv_err
    SetAtt   = set_great + set_good + set_bad + set_err
    SetErr   = set_err (directly)

Because both the box-score scraper and PBP scraper hit stats.ncaa.org
with the same {contest_id} URL scheme, the two data sets use the same
ContestID space for 2026+ — we can join on (contest_id, player, school)
directly, no date-based crosswalk needed.

Prerequisites:
  - scripts/build_per_match_efficiency.py --year <year> has run
    (produces scripts/.pbp-build/per_match_efficiency_<year>.parquet)
  - scripts/parse_ncaa_boxscores.py --year <year> has run
    (produces public/data/wvb_playermatch_div1_<year>.csv)

Usage:
    py -X utf8 scripts/enrich_boxscores_from_pbp.py --year 2026

Writes back to the same CSV path (public/data/wvb_playermatch_div1_<year>.csv).
Rows without a matching PBP entry get empty values (same as unenriched);
rows with a match get their three columns populated.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import pandas as pd

DATA_DIR = Path("public/data")
PME_TEMPLATE = "scripts/.pbp-build/per_match_efficiency_{year}.parquet"
CSV_TEMPLATE = "public/data/wvb_playermatch_div1_{year}.csv"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    args = ap.parse_args()

    pme_path = Path(PME_TEMPLATE.format(year=args.year))
    csv_path = Path(CSV_TEMPLATE.format(year=args.year))

    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found — run parse_ncaa_boxscores.py first",
              file=sys.stderr)
        sys.exit(1)
    if not pme_path.exists():
        print(f"ERROR: {pme_path} not found — run build_per_match_efficiency.py first",
              file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    print(f"[enrich] loading box-score CSV: {csv_path}")
    df = pd.read_csv(csv_path)
    print(f"[enrich]   {len(df):,} rows")

    print(f"[enrich] loading per-match efficiency: {pme_path}")
    pme = pd.read_parquet(pme_path)
    print(f"[enrich]   {len(pme):,} rows")

    # Normalize join keys — same shape in both frames.
    df["_cid_key"]    = df["ContestID"].astype("string")
    df["_player_key"] = df["Player"].astype("string").str.lower().str.strip()
    df["_school_key"] = df["Team"].astype("string").str.lower().str.strip()

    pme["_cid_key"]    = pme["contest_id"].astype("string")
    pme["_player_key"] = pme["player_key"].astype("string")
    pme["_school_key"] = pme["school_key"].astype("string")

    # Derive the three totals from tier counts.
    srv_cols = ["srv_ace", "srv_great", "srv_good", "srv_bad", "srv_err"]
    set_cols = ["set_great", "set_good", "set_bad", "set_err"]
    for c in srv_cols + set_cols:
        if c not in pme.columns:
            pme[c] = 0
    pme["_serve_att"] = pme[srv_cols].sum(axis=1)
    pme["_set_att"]   = pme[set_cols].sum(axis=1)
    pme["_set_err"]   = pme["set_err"]

    print("[enrich] joining on (contest_id, player, school) …")
    merged = df.merge(
        pme[["_cid_key", "_player_key", "_school_key",
             "_serve_att", "_set_att", "_set_err"]],
        on=["_cid_key", "_player_key", "_school_key"],
        how="left",
    )

    # Fill the three shipping columns wherever the join hit.
    hit_mask = merged["_serve_att"].notna()
    n_hit = int(hit_mask.sum())
    n_missed = len(merged) - n_hit
    print(f"[enrich]   hit:  {n_hit:>6,} rows  (values populated from PBP)")
    print(f"[enrich]   miss: {n_missed:>6,} rows  (no PBP touches — left as-is)")

    # ONLY overwrite when we have a join hit; preserve existing values
    # otherwise. Critical for historical years where the box-score CSV
    # already has ServeAtt/SetAtt/SetErr populated from other sources —
    # we don't want to zero them out if the join misses (which it will
    # for 2022-2025 data whose ContestIDs live in a different namespace
    # than the PBP scrape's).
    for src_col, tgt_col in [("_serve_att", "ServeAtt"),
                             ("_set_att",   "SetAtt"),
                             ("_set_err",   "SetErr")]:
        vals = merged[src_col]
        # Where we have a hit, write the int as string; elsewhere leave
        # the existing CSV value untouched.
        existing = merged[tgt_col] if tgt_col in merged.columns else ""
        merged[tgt_col] = vals.where(vals.notna(),
                                     existing).apply(
            lambda x: str(int(x)) if isinstance(x, (int, float)) and x == x
                      else ("" if pd.isna(x) else str(x))
        )

    # Drop scratch cols
    drop_cols = ["_cid_key", "_player_key", "_school_key",
                 "_serve_att", "_set_att", "_set_err"]
    merged = merged.drop(columns=[c for c in drop_cols if c in merged.columns])

    # Write back
    merged.to_csv(csv_path, index=False)
    elapsed = time.time() - t0
    print(f"[enrich] done in {elapsed:.0f}s")
    print(f"[enrich] wrote {csv_path}  "
          f"({csv_path.stat().st_size / (1024 * 1024):.1f} MB)")


if __name__ == "__main__":
    main()
