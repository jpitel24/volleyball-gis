"""
aggregate_pbp_touches.py — Phase 4 touch table.

Walks every scripts/.pbp-cache/*.parsed.json and emits one row per
non-terminal touch into a single Parquet file. Each row carries the
denormalized rally outcome, next-event lookahead, and score state so
downstream analytics can compute per-touch efficiency without
re-loading the source JSONs.

Schema (long format, one row per non-terminal touch):

    Identity / addressing
      contest_id            str
      home_team             str
      away_team             str
      set_num               int
      rally_id              str   (globally unique, NCAA-assigned)
      rally_num             int   (1-based within set, derived)
      touch_idx             int   (0-based within rally)
      team                  str   ('home' / 'away')
      action                str   (SERVE / RECEPTION / SET / ATTACK /
                                   DIG / BLOCK_TOUCH)
      player                str

    Rally outcome (denormalized — same for every touch in the rally)
      rally_winner_side     str
      rally_terminal_type   str   (KILL / ATTACK_ERROR / ACE / ...)
      rally_terminal_team   str
      rally_terminal_player str
      rally_total_touches   int
      score_home_after      int
      score_away_after      int

    Next-event lookahead
      next_action           str   (or 'TERMINAL' if the rally ends next)
      next_team             str
      next_player           str

    Position context
      is_first_touch        bool
      touches_remaining     int

Rallies with zero non-terminal touches (e.g. SANCTION-only events) are
skipped — there's nothing to emit a row for.

Output:
  scripts/.pbp-build/wvb_pbp_touches_<year>.parquet  (gitignored)

Requires:
  pyarrow + pandas
  py -m pip install pyarrow pandas

Usage:
  py -X utf8 scripts/aggregate_pbp_touches.py --year 2025
  py -X utf8 scripts/aggregate_pbp_touches.py --year 2025 --limit 100
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Iterator

CACHE_DIR = Path("scripts/.pbp-cache")
BUILD_DIR = Path("scripts/.pbp-build")
BUILD_DIR.mkdir(parents=True, exist_ok=True)


def safe_read_json(path: Path, retries: int = 5, delay: float = 0.4):
    for _ in range(retries):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (PermissionError, OSError):
            time.sleep(delay)
        except json.JSONDecodeError:
            return None
    return None


def emit_touches_for_match(parsed: dict) -> Iterator[dict]:
    """Yield one row dict per non-terminal touch, with full context."""
    contest_id = str(parsed.get("contestId") or "")
    home_team  = parsed.get("homeTeam")
    away_team  = parsed.get("awayTeam")

    for s in parsed.get("sets", []) or []:
        set_num = s.get("setNum")
        rallies = s.get("rallies", []) or []
        for rally_idx_in_set, r in enumerate(rallies, start=1):
            touches = r.get("touches", []) or []
            n_touches = len(touches)
            if n_touches == 0:
                continue   # SANCTION / CHALLENGE rallies — no touches to row up

            result = r.get("result") or {}
            rally_winner   = r.get("winnerSide")
            terminal_type  = result.get("type")
            terminal_team  = result.get("team")
            terminal_pl    = result.get("primary")
            score          = r.get("scoreAfter") or [None, None]
            score_home, score_away = (score + [None, None])[:2]
            rally_id       = str(r.get("rallyId") or "")

            for i, t in enumerate(touches):
                # Next-event lookahead. If this is the last non-terminal
                # touch, the next event is the terminal; otherwise it's
                # the touch immediately after this one.
                if i + 1 < n_touches:
                    nxt = touches[i + 1]
                    next_action = nxt.get("action")
                    next_team   = nxt.get("team")
                    next_player = nxt.get("player")
                else:
                    next_action = "TERMINAL"
                    next_team   = terminal_team
                    next_player = terminal_pl

                yield {
                    "contest_id":             contest_id,
                    "home_team":              home_team,
                    "away_team":              away_team,
                    "set_num":                set_num,
                    "rally_id":               rally_id,
                    "rally_num":              rally_idx_in_set,
                    "touch_idx":              i,
                    "team":                   t.get("team"),
                    "action":                 t.get("action"),
                    "player":                 t.get("player"),

                    "rally_winner_side":      rally_winner,
                    "rally_terminal_type":    terminal_type,
                    "rally_terminal_team":    terminal_team,
                    "rally_terminal_player":  terminal_pl,
                    "rally_total_touches":    n_touches,
                    "score_home_after":       score_home,
                    "score_away_after":       score_away,

                    "next_action":            next_action,
                    "next_team":              next_team,
                    "next_player":            next_player,

                    "is_first_touch":         (i == 0),
                    "touches_remaining":      n_touches - i - 1,
                }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year",  type=int, required=True,
                    help="Output filename label, e.g. 2025")
    ap.add_argument("--limit", type=int, default=None,
                    help="Only process first N parsed files (smoke test)")
    args = ap.parse_args()

    try:
        import pandas as pd
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        print("ERROR: pyarrow + pandas required. Install with:", file=sys.stderr)
        print("  py -m pip install pyarrow pandas", file=sys.stderr)
        sys.exit(1)

    parsed_files = sorted(CACHE_DIR.glob("*.parsed.json"))
    if args.limit:
        parsed_files = parsed_files[: args.limit]
    print(f"[aggregate] reading {len(parsed_files):,} parsed files")

    out_path = BUILD_DIR / f"wvb_pbp_touches_{args.year}.parquet"

    # Stream-write per-match batches into a single Parquet file so peak
    # memory stays bounded. ~5,000 matches × ~1,000 touches each ≈ 5M
    # rows total; we batch every 250 matches (~250k rows).
    batch_rows: list[dict] = []
    BATCH_MATCHES = 250
    matches_in_batch = 0
    matches_processed = 0
    total_rows = 0
    skipped = 0

    writer = None
    schema = None
    start = time.time()

    for f in parsed_files:
        parsed = safe_read_json(f)
        if parsed is None:
            skipped += 1
            continue
        for row in emit_touches_for_match(parsed):
            batch_rows.append(row)
        matches_in_batch += 1
        matches_processed += 1

        if matches_in_batch >= BATCH_MATCHES or matches_processed == len(parsed_files):
            if not batch_rows:
                matches_in_batch = 0
                continue
            df = pd.DataFrame(batch_rows)
            # Cast the non-string columns explicitly so pyarrow can build
            # a stable schema across batches.
            df["set_num"]             = df["set_num"].astype("Int32")
            df["rally_num"]           = df["rally_num"].astype("Int32")
            df["touch_idx"]           = df["touch_idx"].astype("Int32")
            df["rally_total_touches"] = df["rally_total_touches"].astype("Int32")
            df["score_home_after"]    = df["score_home_after"].astype("Int32")
            df["score_away_after"]    = df["score_away_after"].astype("Int32")
            df["touches_remaining"]   = df["touches_remaining"].astype("Int32")
            df["is_first_touch"]      = df["is_first_touch"].astype("boolean")

            table = pa.Table.from_pandas(df, preserve_index=False)
            if writer is None:
                schema = table.schema
                writer = pq.ParquetWriter(out_path, schema, compression="zstd")
            writer.write_table(table)
            total_rows += len(df)

            elapsed = time.time() - start
            rate = matches_processed / elapsed if elapsed else 0
            print(f"[aggregate] {matches_processed:>5,}/{len(parsed_files):,} matches  "
                  f"·  {total_rows:>9,} rows total  ·  {rate:.1f} matches/s")
            batch_rows = []
            matches_in_batch = 0

    if writer is not None:
        writer.close()
    elapsed = time.time() - start

    print()
    print(f"[aggregate] done in {elapsed:.0f}s")
    print(f"[aggregate] matches processed: {matches_processed:,}")
    print(f"[aggregate] rows written:      {total_rows:,}")
    print(f"[aggregate] skipped (read err):{skipped}")
    print(f"[aggregate] output:            {out_path}")
    if out_path.exists():
        size_mb = out_path.stat().st_size / (1024 * 1024)
        print(f"[aggregate] parquet size:      {size_mb:,.1f} MB")


if __name__ == "__main__":
    main()
