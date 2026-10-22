"""refresh_daily.py — fast in-season pipeline for a single-year daily refresh.

Deliberately narrower than refresh_inseason.py:

- Only touches the current season's data (2026 by default).
- Does NOT rebuild historical per-year GIS+ CSVs (2022-2025) — those are
  frozen artifacts the pipeline references from disk via build_gis_plus_v2's
  concat_to_observations step.
- Does NOT rebuild pGIS percentile tables (pgis_tables.json,
  category_pgis_tables.json). Those are historical-baseline files and
  should be refreshed only in the offseason or when the baselines
  materially shift. Daily game additions move percentiles by rounding
  noise; recomputing them every day was burning 10-15 min for no visible
  change in the frontend.
- Does NOT scrape or discover — assumes the HTML cache for the --year
  argument is already populated (whoever runs this already did the
  scrape_via_adspower.py pass).

Usage:
    py -X utf8 scripts/refresh_daily.py --year 2026

Runtime: expect ~5-8 min on a typical day (vs. ~30-50 min for the full
refresh_inseason chain)."""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

PY = sys.executable
SCRIPTS = Path(__file__).resolve().parent


def run(name: str, cmd: list[str]) -> bool:
    """Run one pipeline step, print its tail output + wall-clock time.
    Returns True on exit 0, False otherwise — caller decides whether to
    continue the chain or abort."""
    print(f"\n━━━ {name} ━━━", flush=True)
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
    except Exception as e:
        print(f"  FATAL: couldn't launch step: {e}", flush=True)
        return False
    elapsed = time.time() - t0
    tail = "\n".join((proc.stdout or "").splitlines()[-6:])
    for line in tail.splitlines():
        print(f"  {line}", flush=True)
    err_tail = "\n".join((proc.stderr or "").splitlines()[-4:])
    if err_tail:
        for line in err_tail.splitlines():
            print(f"  [stderr] {line}", flush=True)
    status = "OK" if proc.returncode == 0 else f"FAIL (exit {proc.returncode})"
    print(f"  → {status}  ({elapsed:.1f}s)", flush=True)
    return proc.returncode == 0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2026,
                    help="Season year (default 2026)")
    args = ap.parse_args()
    year = str(args.year)

    overall = time.time()
    steps = [
        ("parse_all_pbp",             [PY, "-X", "utf8", str(SCRIPTS / "parse_all_pbp.py")]),
        ("parse_ncaa_boxscores",      [PY, "-X", "utf8", str(SCRIPTS / "parse_ncaa_boxscores.py"), "--year", year]),
        ("aggregate_pbp_touches",     [PY, "-X", "utf8", str(SCRIPTS / "aggregate_pbp_touches.py"), "--year", year]),
        ("build_per_match_efficiency", [PY, "-X", "utf8", str(SCRIPTS / "build_per_match_efficiency.py"), "--year", year]),
        ("build_setscores",           [PY, "-X", "utf8", str(SCRIPTS / "build_setscores.py"), "--year", year]),
        ("enrich_boxscores_from_pbp", [PY, "-X", "utf8", str(SCRIPTS / "enrich_boxscores_from_pbp.py"), "--year", year]),
        ("enrich_conferences",        [PY, "-X", "utf8", str(SCRIPTS / "enrich_conferences.py"), "--year", year]),
    ]
    for skill in ("reception", "serve", "set", "block", "dig"):
        steps.append((f"build_{skill}_quality",
                      [PY, "-X", "utf8", str(SCRIPTS / f"build_{skill}_quality.py"), "--year", year]))
    # Only this year's GIS+ gets rebuilt. concat_to_observations inside
    # build_gis_plus_v2.py reads the frozen historical per-year CSVs from
    # disk and unions them with the newly-built current-year CSV.
    steps.append(("build_gis_plus_v2 (current year only)",
                  [PY, "-X", "utf8", str(SCRIPTS / "build_gis_plus_v2.py"), "--year", year]))

    # IMPORTANT: pGIS baseline tables (pgis_tables.json,
    # category_pgis_tables.json) are intentionally NOT rebuilt here.
    # They represent historical percentile distributions that move by
    # rounding noise when daily games are added. Rebuild them manually
    # with build_pgis_tables.py + build_category_pgis_tables.py when
    # you want a fresh baseline (offseason or major formula change).

    failed = []
    for name, cmd in steps:
        if not run(name, cmd):
            failed.append(name)
            # Continue despite failures — some downstream steps may still
            # succeed. The caller sees the overall exit code at the end.

    elapsed = time.time() - overall
    print(f"\n═══ refresh_daily done in {elapsed/60:.1f} min "
          f"({'ALL OK' if not failed else f'FAILED: {failed}'})  ═══")
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
