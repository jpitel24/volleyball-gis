"""
build_team_conferences.py

Parses the cached stats.ncaa.org RPI/nitty_gritties HTML page (fetched
by discover_pbp_ids.py) into a simple team → conference JSON.

The RPI page has a single big table with every D1 team ranked, with
columns including Team and Conference. Sample row:
    ['Nebraska(AQ)', 'Big Ten', '12/21/2025 Result', '1', '0.74883', ...]

Team names get their trailing "(AQ)" auto-qualifier marker stripped so
they match the format used in stats.ncaa.org's box-score pages
(e.g. "Nebraska", not "Nebraska(AQ)").

Usage:
    py -X utf8 scripts/build_team_conferences.py --year 2026

Input:
    scripts/.pbp-build/rpi_page_<year>.html

Output:
    scripts/.pbp-build/team_conferences_<year>.json
    {
      "Nebraska": "Big Ten",
      "Texas":    "SEC",
      ...
    }
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup

BUILD_DIR = Path("scripts/.pbp-build")

AQ_SUFFIX_RE = re.compile(r"\s*\(AQ\)\s*$", re.IGNORECASE)


def normalize_team(name: str) -> str:
    """Strip the '(AQ)' automatic-qualifier suffix from team names."""
    return AQ_SUFFIX_RE.sub("", name).strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    args = ap.parse_args()

    rpi_path = BUILD_DIR / f"rpi_page_{args.year}.html"
    out_path = BUILD_DIR / f"team_conferences_{args.year}.json"

    if not rpi_path.exists():
        print(f"ERROR: {rpi_path} not found — run discover_pbp_ids.py "
              f"--year {args.year} first", file=sys.stderr)
        sys.exit(1)

    print(f"[teamconf] loading {rpi_path}")
    html = rpi_path.read_text(encoding="utf-8")
    soup = BeautifulSoup(html, "lxml")

    tables = soup.find_all("table")
    if not tables:
        print("ERROR: no <table> in RPI HTML", file=sys.stderr)
        sys.exit(1)
    table = tables[0]   # RPI page has one big table

    rows = table.find_all("tr")
    if len(rows) < 2:
        print("ERROR: RPI table has no data rows", file=sys.stderr)
        sys.exit(1)

    header = [c.get_text(strip=True) for c in rows[0].find_all(["th", "td"])]
    try:
        team_idx = header.index("Team")
        conf_idx = header.index("Conference")
    except ValueError:
        print(f"ERROR: expected 'Team' + 'Conference' columns, got {header}",
              file=sys.stderr)
        sys.exit(1)

    out: dict[str, str] = {}
    for row in rows[1:]:
        cells = [c.get_text(strip=True) for c in row.find_all(["th", "td"])]
        if len(cells) <= max(team_idx, conf_idx):
            continue
        team = normalize_team(cells[team_idx])
        conf = cells[conf_idx].strip()
        if team and conf:
            out[team] = conf

    out_path.write_text(json.dumps(out, indent=2, sort_keys=True),
                        encoding="utf-8")
    print(f"[teamconf] {len(out)} team → conference mappings")
    print(f"[teamconf] wrote {out_path}  "
          f"({out_path.stat().st_size / 1024:.1f} KB)")

    # Sanity summary: teams per conference
    by_conf: dict[str, int] = {}
    for c in out.values():
        by_conf[c] = by_conf.get(c, 0) + 1
    top = sorted(by_conf.items(), key=lambda x: -x[1])[:10]
    print("[teamconf] top-10 conferences by team count:")
    for c, n in top:
        print(f"  {n:>3}  {c}")


if __name__ == "__main__":
    main()
