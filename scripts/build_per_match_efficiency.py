"""
build_per_match_efficiency.py — Phase 7 step 1.

For each (contest_id, player, school) row, computes the per-match tier
counts for all four touch-derived skills (REC, SRV, SET, DIG) using
the same classification logic as the season-level build_*_quality.py
scripts. ATK and BLK are not included here — they come from the box-
score CSVs which are already keyed per-match.

This is the Python-side intermediate that feeds the per-match GIS+
multiplier computation (build_gis_plus_v2.py). Not shipped to the
browser — kept in scripts/.pbp-build/.

Output schema (one row per (contest_id, player_key, school_key)):
    contest_id, player_key, school_key, school, player

    rec_great, rec_good, rec_bad
    srv_ace, srv_great, srv_good, srv_bad, srv_err
    set_great, set_good, set_bad, set_err
    dig_great, dig_good, dig_bad

A player might not appear in one or more skill blocks for a match (e.g.,
a MB with zero receptions). Missing counts are zero, not null.

Usage:
    py -X utf8 scripts/build_per_match_efficiency.py --year 2025
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import pandas as pd

PARQUET_TEMPLATE = "scripts/.pbp-build/wvb_pbp_touches_{year}.parquet"
OUT_TEMPLATE     = "scripts/.pbp-build/per_match_efficiency_{year}.parquet"

MIN_SETS_FOR_SETTER  = 5
TOP_SETTERS_PER_TEAM = 2


def classify_receptions(df: pd.DataFrame, setter_top: pd.DataFrame) -> pd.DataFrame:
    """Returns DataFrame with one row per RECEPTION touch and a 'quality' column."""
    keep = ["contest_id", "set_num", "rally_id", "touch_idx", "team", "action", "player"]
    second = df[keep].rename(columns={
        "touch_idx": "_t2", "team": "second_team",
        "action": "second_action", "player": "second_player",
    })
    third = df[keep].rename(columns={
        "touch_idx": "_t3", "team": "third_team",
        "action": "third_action", "player": "third_player",
    })

    rec = df[df["action"] == "RECEPTION"].copy()
    rec["_t2"] = rec["touch_idx"] + 1
    rec["_t3"] = rec["touch_idx"] + 2

    merged = rec.merge(second, on=["contest_id", "set_num", "rally_id", "_t2"], how="left")
    merged = merged.merge(third,  on=["contest_id", "set_num", "rally_id", "_t3"], how="left")
    merged = merged.merge(
        setter_top[["contest_id", "team", "player", "_is_setter"]].rename(
            columns={"player": "second_player"}),
        on=["contest_id", "team", "second_player"], how="left",
    )
    merged["_is_setter"] = merged["_is_setter"].fillna(False).astype(bool)

    setter_on_2nd = ((merged["second_action"] == "SET")
                     & (merged["second_team"] == merged["team"])
                     & merged["_is_setter"])
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
    return merged


def classify_digs(df: pd.DataFrame, setter_top: pd.DataFrame) -> pd.DataFrame:
    """Same shape as receptions, but for DIG action."""
    keep = ["contest_id", "set_num", "rally_id", "touch_idx", "team", "action", "player"]
    second = df[keep].rename(columns={
        "touch_idx": "_t2", "team": "second_team",
        "action": "second_action", "player": "second_player",
    })
    third = df[keep].rename(columns={
        "touch_idx": "_t3", "team": "third_team",
        "action": "third_action", "player": "third_player",
    })
    digs = df[df["action"] == "DIG"].copy()
    digs["_t2"] = digs["touch_idx"] + 1
    digs["_t3"] = digs["touch_idx"] + 2
    merged = digs.merge(second, on=["contest_id", "set_num", "rally_id", "_t2"], how="left")
    merged = merged.merge(third,  on=["contest_id", "set_num", "rally_id", "_t3"], how="left")
    merged = merged.merge(
        setter_top[["contest_id", "team", "player", "_is_setter"]].rename(
            columns={"player": "second_player"}),
        on=["contest_id", "team", "second_player"], how="left",
    )
    merged["_is_setter"] = merged["_is_setter"].fillna(False).astype(bool)

    setter_on_2nd = ((merged["second_action"] == "SET")
                     & (merged["second_team"] == merged["team"])
                     & merged["_is_setter"])
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
    return merged


def classify_serves(df: pd.DataFrame) -> pd.DataFrame:
    """Each SERVE touch gets a tier from rally_terminal_type + rally_total_touches."""
    serves = df[df["action"] == "SERVE"].copy()
    rally_term   = serves["rally_terminal_type"]
    server_team  = serves["team"]
    rally_winner = serves["rally_winner_side"]
    N = (serves["rally_total_touches"].fillna(0).astype(int) - 2).clip(lower=0)

    quality = pd.Series("bad", index=serves.index, dtype=object)
    is_ace = (rally_term == "ACE") & (rally_winner == server_team)
    is_err = (rally_term == "SERVICE_ERROR")
    is_normal = ~is_ace & ~is_err
    we_won  = (rally_winner == server_team)
    early   = N <= 2
    extended = N >= 3
    quality[is_normal & early & we_won]   = "great"
    quality[is_normal & early & ~we_won]  = "bad"
    quality[is_normal & extended]         = "good"
    quality[is_ace]                       = "ace"
    quality[is_err]                       = "err"
    serves["quality"] = quality
    return serves


def classify_sets(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """SET touches → great/good/bad tiers. Errors come from terminal rows."""
    sets = df[df["action"] == "SET"].copy()
    sets["_t_next"] = sets["touch_idx"] + 1
    # Use underscored names so we don't collide with the parquet's own
    # next_action/next_team columns (the lookahead aggregate baked in).
    next_touch = df[["contest_id", "set_num", "rally_id", "touch_idx", "team", "action"]].rename(
        columns={"touch_idx": "_t_next", "team": "_nx_team", "action": "_nx_action"}
    )
    merged = sets.merge(next_touch, on=["contest_id", "set_num", "rally_id", "_t_next"], how="left")
    same_team_attack = (merged["_nx_action"] == "ATTACK") & (merged["_nx_team"] == merged["team"])
    rally_won_by_us  = (merged["rally_winner_side"] == merged["team"])
    terminal         = merged["rally_terminal_type"]

    quality = pd.Series("bad", index=merged.index, dtype=object)
    quality[same_team_attack] = "good"
    # "great" = the immediate-next attack produced a kill for us
    quality[same_team_attack & rally_won_by_us & (terminal == "KILL")] = "great"
    merged["quality"] = quality

    # SET_ERROR terminals: one error per rally, credited to terminal player
    err_rows = df[df["rally_terminal_type"] == "SET_ERROR"].drop_duplicates(["contest_id", "rally_id"]).copy()
    err_rows["school"] = err_rows["home_team"].where(
        err_rows["rally_terminal_team"] == "home", err_rows["away_team"]
    )
    err_rows["player_key"] = err_rows["rally_terminal_player"].astype("string").str.lower().str.strip()
    err_rows["school_key"] = err_rows["school"].astype("string").str.lower().str.strip()
    return merged, err_rows


def per_match_tier_counts(events: pd.DataFrame, prefix: str,
                          tiers: list[str]) -> pd.DataFrame:
    """Aggregate event rows into per-(contest_id, player, school) tier counts."""
    events = events.copy()
    events["school"] = events["home_team"].where(
        events["team"] == "home", events["away_team"]
    )
    events["player_key"] = events["player"].astype("string").str.lower().str.strip()
    events["school_key"] = events["school"].astype("string").str.lower().str.strip()
    keys = ["contest_id", "match_date", "player_key", "school_key", "school", "player"]

    grouped = (
        events.groupby(keys)["quality"]
              .value_counts()
              .unstack(fill_value=0)
              .reset_index()
    )
    for t in tiers:
        if t not in grouped.columns:
            grouped[t] = 0
    rename_map = {t: f"{prefix}_{t}" for t in tiers}
    return grouped[keys + tiers].rename(columns=rename_map)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    args = ap.parse_args()
    year = args.year

    parquet_path = Path(PARQUET_TEMPLATE.format(year=year))
    out_path     = Path(OUT_TEMPLATE.format(year=year))
    if not parquet_path.exists():
        print(f"ERROR: {parquet_path} not found", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    print(f"[pme] loading {parquet_path}")
    df = pd.read_parquet(parquet_path)
    print(f"[pme] {len(df):,} touch rows")

    # ── Setter identification per (contest, team) ─────────────────────
    print("[pme] identifying setters …")
    sets_only = df[df["action"] == "SET"][["contest_id", "team", "player"]]
    setter_counts = (
        sets_only.groupby(["contest_id", "team", "player"])
                 .size().reset_index(name="set_count")
    )
    setter_counts = setter_counts[setter_counts["set_count"] >= MIN_SETS_FOR_SETTER]
    setter_top = (
        setter_counts.sort_values("set_count", ascending=False)
                     .groupby(["contest_id", "team"])
                     .head(TOP_SETTERS_PER_TEAM).copy()
    )
    setter_top["_is_setter"] = True

    # ── Classify each skill ───────────────────────────────────────────
    print("[pme] classifying receptions …")
    rec = classify_receptions(df, setter_top)
    print("[pme] classifying digs …")
    dig = classify_digs(df, setter_top)
    print("[pme] classifying serves …")
    srv = classify_serves(df)
    print("[pme] classifying sets …")
    setm, set_errs = classify_sets(df)

    # ── Per-match tier counts per skill ───────────────────────────────
    print("[pme] aggregating per (contest, player, school) …")
    rec_pm = per_match_tier_counts(rec, "rec", ["great", "good", "bad"])
    dig_pm = per_match_tier_counts(dig, "dig", ["great", "good", "bad"])
    srv_pm = per_match_tier_counts(srv, "srv", ["ace", "great", "good", "bad", "err"])
    set_pm = per_match_tier_counts(setm, "set", ["great", "good", "bad"])

    # SET errors: per-match count keyed by contest_id + terminal player + school
    if not set_errs.empty:
        set_err_pm = (
            set_errs.groupby(["contest_id", "player_key", "school_key"])
                    .size().reset_index(name="set_err")
        )
    else:
        set_err_pm = pd.DataFrame(columns=["contest_id", "player_key", "school_key", "set_err"])

    # ── Outer-join all skill blocks ──────────────────────────────────
    print("[pme] joining skill blocks …")
    join_keys = ["contest_id", "match_date", "player_key", "school_key"]
    out = (rec_pm.merge(dig_pm, on=join_keys + ["school", "player"], how="outer")
                 .merge(srv_pm, on=join_keys + ["school", "player"], how="outer")
                 .merge(set_pm, on=join_keys + ["school", "player"], how="outer")
                 .merge(set_err_pm, on=["contest_id", "player_key", "school_key"], how="outer"))

    count_cols = [c for c in out.columns
                  if c.startswith(("rec_", "srv_", "set_", "dig_"))]
    for c in count_cols:
        out[c] = out[c].fillna(0).astype("int32")

    # ── Write ─────────────────────────────────────────────────────────
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(out_path, compression="zstd", index=False)
    elapsed = time.time() - t0
    print()
    print(f"[pme] done in {elapsed:.0f}s")
    print(f"[pme] {len(out):,} (contest, player, school) rows")
    print(f"[pme] wrote {out_path}  ({out_path.stat().st_size / (1024*1024):.1f} MB)")


if __name__ == "__main__":
    main()
