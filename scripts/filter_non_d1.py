"""filter_non_d1.py — purge non-D1 teams from all data files.

Definition of D1: a team appears in public/data/historical_rpi.json for
that season year. If a team is not in the RPI for a given year, every
contest they participated in that year is removed from every data file.

This is both a one-shot cleanup and a pipeline guard. Run it after any
refresh to strip non-D1-vs-D1 games.

Usage:
    py -X utf8 scripts/filter_non_d1.py              # all years
    py -X utf8 scripts/filter_non_d1.py --year 2026  # one year
    py -X utf8 scripts/filter_non_d1.py --dry-run    # report only

Season-year mapping: Season "2022-2023" (start year 2022) maps to RPI
key "2022". The data-file year suffix (e.g. wvb_playermatch_div1_2026.csv)
is likewise the start year.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"

ALL_YEARS = [2022, 2023, 2024, 2025, 2026]


def load_d1_sets() -> dict[int, set[str]]:
    rpi = json.loads((DATA / "historical_rpi.json").read_text(encoding="utf-8"))
    return {int(y): set(teams.keys()) for y, teams in rpi.items()}


def season_to_year(season: str) -> int | None:
    try:
        return int(season.split("-")[0])
    except Exception:
        return None


def read_csv(path: Path) -> tuple[list[str], list[dict]]:
    with path.open(encoding="utf-8", newline="") as f:
        rdr = csv.DictReader(f)
        cols = list(rdr.fieldnames or [])
        rows = list(rdr)
    return cols, rows


def write_csv(path: Path, cols: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


def collect_bad_contests(d1_by_year: dict[int, set[str]]) -> tuple[dict[int, set[str]], dict[tuple[int, str], set[tuple[str, str]]]]:
    """Return (bad_contest_ids_by_year, bad_team_dates_by_year_team).

    bad_contest_ids_by_year[year] = {ContestID, ...} where either team was non-D1.
    bad_team_dates_by_year_team is used to filter the no-ContestID CSV:
      given (year, team_name) → {(Date, season_str), ...} to drop.
    """
    bad_contests: dict[int, set[str]] = defaultdict(set)
    bad_team_dates: dict[tuple[int, str], set[tuple[str, str]]] = defaultdict(set)

    # Use wvb_playermatch_div1_{year}.csv as the source of truth for
    # (ContestID, Team, Opponent Team, Date, Season).
    for y in ALL_YEARS:
        p = DATA / f"wvb_playermatch_div1_{y}.csv"
        if not p.exists():
            continue
        d1 = d1_by_year.get(y, set())
        if not d1:
            print(f"  [warn] no RPI D1 set for year {y}; skipping", file=sys.stderr)
            continue
        cols, rows = read_csv(p)
        for r in rows:
            team = (r.get("Team") or "").strip()
            opp = (r.get("Opponent Team") or "").strip()
            if team and opp and (team not in d1 or opp not in d1):
                cid = (r.get("ContestID") or "").strip()
                date = (r.get("Date") or "").strip()
                season = (r.get("Season") or "").strip()
                if cid:
                    bad_contests[y].add(cid)
                if date:
                    if team:
                        bad_team_dates[(y, team)].add((date, season))
                    if opp:
                        bad_team_dates[(y, opp)].add((date, season))
    return bad_contests, bad_team_dates


def filter_csv_by_contest(path: Path, bad_contests: dict[int, set[str]], season_col: str = "Season", year: int | None = None, dry_run: bool = False) -> int:
    """Filter a CSV in place by ContestID. If `year` is given, uses that
    year's bad-contest set for every row (for single-year files). Else uses
    Season column mapped to year."""
    if not path.exists():
        return 0
    cols, rows = read_csv(path)
    if "ContestID" not in cols:
        return 0
    kept = []
    dropped = 0
    for r in rows:
        y = year if year is not None else season_to_year(r.get(season_col, ""))
        if y is None:
            kept.append(r); continue
        if (r.get("ContestID") or "").strip() in bad_contests.get(y, set()):
            dropped += 1
        else:
            kept.append(r)
    if dropped and not dry_run:
        write_csv(path, cols, kept)
    return dropped


def filter_gis_plus_observations(path: Path, bad_team_dates: dict[tuple[int, str], set[tuple[str, str]]], dry_run: bool = False) -> int:
    """gis_plus_observations.csv has Season/Date/Team/Player/GIS/GIS_Plus
    but no ContestID. Drop rows whose (year, Team) matches a bad game and
    whose Date + Season matches that game."""
    if not path.exists():
        return 0
    cols, rows = read_csv(path)
    kept = []
    dropped = 0
    for r in rows:
        season = (r.get("Season") or "").strip()
        y = season_to_year(season)
        if y is None:
            kept.append(r); continue
        team = (r.get("Team") or "").strip()
        date = (r.get("Date") or "").strip()
        if (date, season) in bad_team_dates.get((y, team), set()):
            dropped += 1
        else:
            kept.append(r)
    if dropped and not dry_run:
        write_csv(path, cols, kept)
    return dropped


def _detect_compact(raw: str) -> bool:
    """Heuristic: if the first 500 chars contain no newlines, treat it as
    compact (single-line) JSON and preserve that on write."""
    return "\n" not in raw[:500]


def filter_json_by_contest(path: Path, bad_contest_ids: set[str], dry_run: bool = False) -> int:
    """JSON file keyed by ContestID at top level. Drop matching keys and
    preserve the source file's compact-vs-indented style."""
    if not path.exists():
        return 0
    raw = path.read_text(encoding="utf-8")
    d = json.loads(raw)
    if not isinstance(d, dict):
        return 0
    dropped = 0
    for k in list(d.keys()):
        if str(k) in bad_contest_ids:
            del d[k]
            dropped += 1
    if dropped and not dry_run:
        if _detect_compact(raw):
            path.write_text(json.dumps(d, separators=(",", ":")), encoding="utf-8")
        else:
            path.write_text(json.dumps(d, indent=2), encoding="utf-8")
    return dropped


def filter_match_pbp_coverage(bad_contests: dict[int, set[str]], dry_run: bool = False) -> int:
    """match_pbp_coverage.json is keyed by ContestID across all years."""
    all_bad = set()
    for s in bad_contests.values():
        all_bad |= s
    return filter_json_by_contest(DATA / "match_pbp_coverage.json", all_bad, dry_run=dry_run)


def filter_pbp_touches_parquet(bad_contests: dict[int, set[str]], dry_run: bool = False) -> int:
    """Strip non-D1 contests from scripts/.pbp-build/wvb_pbp_touches_<year>.parquet
    so downstream quality builders don't aggregate their touches."""
    try:
        import pandas as pd  # type: ignore
    except ImportError:
        print("  [warn] pandas not available; skipping parquet filter", file=sys.stderr)
        return 0
    pbp_dir = ROOT / "scripts" / ".pbp-build"
    total = 0
    for y in ALL_YEARS:
        p = pbp_dir / f"wvb_pbp_touches_{y}.parquet"
        if not p.exists():
            continue
        bad = bad_contests.get(y, set())
        if not bad:
            continue
        df = pd.read_parquet(p)
        if "contest_id" not in df.columns:
            continue
        before = len(df)
        bad_str = {str(c) for c in bad}
        df = df[~df["contest_id"].astype(str).isin(bad_str)]
        dropped = before - len(df)
        if dropped and not dry_run:
            df.to_parquet(p, index=False)
        if dropped:
            print(f"  {p.name}: dropped {dropped} rows")
            total += dropped
    return total


def filter_match_context(d1_by_year: dict[int, set[str]], dry_run: bool = False) -> int:
    """match_context.json keyed by MM-DD-YYYY_team1_team2 with team values
    inside. Drop any key where the inner 'team' values include non-D1 teams
    (checked against both teams' year).
    Keys look like: '08-26-2022_boston_college_siena'. Use the year in the
    key for D1 lookup. Players inside map to {'team': 'Siena', ...}."""
    path = DATA / "match_context.json"
    if not path.exists():
        return 0
    raw = path.read_text(encoding="utf-8")
    d = json.loads(raw)
    dropped = 0
    for k in list(d.keys()):
        parts = k.split("_", 1)
        if len(parts) != 2:
            continue
        date_part = parts[0]  # e.g. 08-26-2022
        try:
            y = int(date_part.split("-")[2])
        except Exception:
            continue
        d1 = d1_by_year.get(y, set())
        if not d1:
            continue
        # gather team names from inner player dicts
        teams_in_match = set()
        inner = d[k]
        if isinstance(inner, dict):
            for pdata in inner.values():
                if isinstance(pdata, dict):
                    t = pdata.get("team")
                    if t:
                        teams_in_match.add(t)
        if teams_in_match and not teams_in_match.issubset(d1):
            del d[k]
            dropped += 1
    if dropped and not dry_run:
        if _detect_compact(raw):
            path.write_text(json.dumps(d, separators=(",", ":")), encoding="utf-8")
        else:
            path.write_text(json.dumps(d, indent=2), encoding="utf-8")
    return dropped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=None, help="limit scope to one year (default: all)")
    ap.add_argument("--dry-run", action="store_true", help="report only, do not write")
    args = ap.parse_args()

    years = [args.year] if args.year else ALL_YEARS
    d1_by_year = load_d1_sets()

    print("D1 teams per year (from historical_rpi.json):")
    for y in years:
        print(f"  {y}: {len(d1_by_year.get(y, set()))}")

    print("\nCollecting bad contests (non-D1-vs-D1 games)…")
    bad_contests, bad_team_dates = collect_bad_contests(d1_by_year)
    for y in years:
        print(f"  {y}: {len(bad_contests.get(y, set()))} contests to purge")

    total_dropped = 0

    # Per-year single-year CSVs
    for y in years:
        for template in ("gis_plus_v2_{y}.csv", "wvb_playermatch_div1_{y}.csv", "wvb_rallies_div1_{y}.csv"):
            p = DATA / template.format(y=y)
            n = filter_csv_by_contest(p, bad_contests, year=y, dry_run=args.dry_run)
            if n:
                print(f"  {p.name}: dropped {n} rows")
                total_dropped += n
        # twosided variant (2025 only in current data)
        p2 = DATA / f"wvb_playermatch_div1_{y}_twosided.csv"
        n = filter_csv_by_contest(p2, bad_contests, year=y, dry_run=args.dry_run)
        if n:
            print(f"  {p2.name}: dropped {n} rows")
            total_dropped += n

    # Multi-year CSVs (keyed by Season)
    for name in ("gis_observations.csv",):
        p = DATA / name
        n = filter_csv_by_contest(p, bad_contests, dry_run=args.dry_run)
        if n:
            print(f"  {name}: dropped {n} rows")
            total_dropped += n

    # gis_plus_observations.csv (no ContestID; use date+team key)
    n = filter_gis_plus_observations(DATA / "gis_plus_observations.csv", bad_team_dates, dry_run=args.dry_run)
    if n:
        print(f"  gis_plus_observations.csv: dropped {n} rows")
        total_dropped += n

    # Per-year setscores JSON (keyed by ContestID)
    for y in years:
        p = DATA / f"wvb_setscores_{y}.json"
        n = filter_json_by_contest(p, bad_contests.get(y, set()), dry_run=args.dry_run)
        if n:
            print(f"  {p.name}: dropped {n} entries")
            total_dropped += n

    # PBP touches parquet (upstream of the quality builders)
    n = filter_pbp_touches_parquet(bad_contests, dry_run=args.dry_run)
    if n:
        total_dropped += n

    # match_pbp_coverage.json (keyed by ContestID across all years)
    n = filter_match_pbp_coverage(bad_contests, dry_run=args.dry_run)
    if n:
        print(f"  match_pbp_coverage.json: dropped {n} entries")
        total_dropped += n

    # match_context.json (keyed by date_team_team)
    n = filter_match_context(d1_by_year, dry_run=args.dry_run)
    if n:
        print(f"  match_context.json: dropped {n} entries")
        total_dropped += n

    print(f"\nTotal rows/entries {'would be ' if args.dry_run else ''}dropped: {total_dropped}")
    if args.dry_run:
        print("(dry run; no files were modified)")
    else:
        print("\nNote: downstream aggregates (reception/serve/set/block/dig quality "
              "JSONs, pGIS tables, efficiency baselines, rally leverage) are NOT "
              "regenerated by this script. Re-run the relevant build_*.py steps or "
              "the full refresh pipeline to rebuild them from the cleaned sources.")


if __name__ == "__main__":
    main()
