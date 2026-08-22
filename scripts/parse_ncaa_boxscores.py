"""
parse_ncaa_boxscores.py

Walks scripts/.boxscore-cache/*.html, parses each stats.ncaa.org
individual_stats page, and emits a per-year CSV matching the
wvb_playermatch_div1_<year>.csv schema:

    Season, Date, ContestID, Team, Conference, Opponent Team,
    Opponent Conference, Location, Number, Player, P, S,
    Kills, Errors, TotalAttacks, HitPct, Assists, Aces, SErr,
    Digs, RetAtt, RErr, BlockSolos, BlockAssists, BErr,
    PTS, BHE, SetErr, SetAtt, ServeAtt, TotalBlocks

Columns not available on stats.ncaa.org's individual_stats page are
emitted empty:
    - Conference / Opponent Conference (enriched separately from a
      team → conference map — see the enrichment step in the
      orchestrator; can be joined post-hoc)
    - ServeAtt, SetErr, SetAtt (never on this page — legacy columns
      only populated for older seasons via other sources)
    - Location — filled 'Neutral' by default; can be refined later
      by cross-checking team venue

TotalBlocks is computed as BlockSolos + BlockAssists.

Usage:
    py -X utf8 scripts/parse_ncaa_boxscores.py --year 2026

Output:
    public/data/wvb_playermatch_div1_<year>.csv
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
import time
from pathlib import Path

from bs4 import BeautifulSoup

CACHE_DIR = Path("scripts/.boxscore-cache")
OUTPUT_DIR = Path("public/data")

DATE_RE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")

# Columns the shipped CSV uses.
COLS = [
    "Season", "Date", "ContestID", "Team", "Conference",
    "Opponent Team", "Opponent Conference", "Location",
    "Number", "Player", "P", "S",
    "Kills", "Errors", "TotalAttacks", "HitPct",
    "Assists", "Aces", "SErr",
    "Digs", "RetAtt", "RErr",
    "BlockSolos", "BlockAssists", "BErr",
    "PTS", "BHE",
    "SetErr", "SetAtt", "ServeAtt", "TotalBlocks",
]

# Raw column headers seen on stats.ncaa.org's individual_stats page → our schema.
COL_MAP = {
    "#":            "Number",
    "Name":         "Player",
    "P":            "P",
    "S":            "S",
    "Kills":        "Kills",
    "Errors":       "Errors",
    "TotalAttacks": "TotalAttacks",
    "HitPct":       "HitPct",
    "Assists":      "Assists",
    "Aces":         "Aces",
    "SErr":         "SErr",
    "Digs":         "Digs",
    "RetAtt":       "RetAtt",
    "RErr":         "RErr",
    "BlockSolos":   "BlockSolos",
    "BlockAssists": "BlockAssists",
    "BErr":         "BErr",
    "PTS":          "PTS",
    "BHE":          "BHE",
}


def parse_iso_date(date_str: str) -> str:
    """Turn '08/29/2025 02:00 PM' into '2025-08-29'. Returns '' on failure."""
    m = DATE_RE.search(date_str or "")
    if not m:
        return ""
    mm, dd, yyyy = m.group(1), m.group(2), m.group(3)
    return f"{yyyy}-{int(mm):02d}-{int(dd):02d}"


def extract_team_name(roster_table) -> str:
    """The roster table is nested inside a card div whose first child div
    reads 'TeamNamePeriod Stats' (concatenated). Extract the team name by
    stripping the 'Period Stats' suffix."""
    ancestor = roster_table
    for _ in range(6):
        ancestor = ancestor.parent
        if ancestor is None:
            return ""
        cls = ancestor.get("class") or []
        if "card" in cls:
            for div in ancestor.find_all("div", recursive=False):
                txt = div.get_text(strip=True)
                if txt.endswith("Period Stats"):
                    return txt[:-len("Period Stats")].strip()
                # Some layouts have team name directly as first text
                if txt and len(txt) < 60 and "Period" not in txt:
                    return txt
            break
    return ""


def parse_one(html: str, contest_id: str, year: int) -> list[dict]:
    """Parse one individual_stats HTML → list of row dicts (both teams).
    Returns [] on failure or if no roster tables found."""
    soup = BeautifulSoup(html, "lxml")

    # Date — <td class="grey_text"> contains "MM/DD/YYYY HH:MM AM/PM"
    date_iso = ""
    for td in soup.find_all("td", class_="grey_text"):
        date_iso = parse_iso_date(td.get_text(strip=True))
        if date_iso:
            break

    season = f"{year}-{year + 1}"

    # Roster tables: the two large tables whose header row contains
    # {#, Name, P, S, Kills, ...}
    roster_tables = []
    for t in soup.find_all("table"):
        rows = t.find_all("tr")
        if len(rows) < 3:
            continue
        headers = [c.get_text(strip=True) for c in rows[0].find_all(["th", "td"])]
        if "Kills" in headers and "Digs" in headers and "Name" in headers:
            roster_tables.append((t, headers, rows))

    if len(roster_tables) < 2:
        return []

    # Pair the two rosters. Extract team name for each; the two teams
    # play each other so we cross-assign.
    parsed_teams = []
    team_names_seen: set[str] = set()
    for tbl, headers, rows in roster_tables[:2]:
        team_name = extract_team_name(tbl)
        if team_name:
            team_names_seen.add(team_name.lower())
        players = []
        for r in rows[1:]:
            cells = [c.get_text(strip=True) for c in r.find_all(["th", "td"])]
            if len(cells) < len(headers):
                continue
            raw = dict(zip(headers, cells))
            name = raw.get("Name", "").strip()
            if not name:
                continue
            # Filter out summary/totals rows. stats.ncaa.org uses various
            # markers for the team-totals row: literal "Totals"/"Total"/
            # "Team", OR just the team's own name repeated as the Name
            # field (e.g. "McNeese" appearing in the Name column of
            # McNeese's roster). Skip all of those.
            low = name.lower()
            if low in ("totals", "total", "team"):
                continue
            if low in team_names_seen:
                continue
            if team_name and low == team_name.lower():
                continue
            players.append(raw)
        parsed_teams.append({"team": team_name, "players": players})

    if len(parsed_teams) != 2:
        return []

    # Build rows for both teams
    out_rows: list[dict] = []
    for i in range(2):
        own = parsed_teams[i]
        opp = parsed_teams[1 - i]
        for raw in own["players"]:
            row = {c: "" for c in COLS}
            row["Season"]        = season
            row["Date"]          = date_iso
            row["ContestID"]     = contest_id
            row["Team"]          = own["team"]
            row["Opponent Team"] = opp["team"]
            row["Location"]      = "Neutral"    # can be refined later
            # Map stat columns
            for src, tgt in COL_MAP.items():
                if src in raw:
                    row[tgt] = raw[src]
            # Compute TotalBlocks = solos + assists (numeric coerce)
            try:
                bs = int(row["BlockSolos"] or 0)
                ba = int(row["BlockAssists"] or 0)
                row["TotalBlocks"] = str(bs + ba)
            except ValueError:
                row["TotalBlocks"] = ""
            out_rows.append(row)
    return out_rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True,
                    help="Season year (e.g. 2026 for 2026-27)")
    ap.add_argument("--limit", type=int, default=None,
                    help="Only parse first N HTML files (smoke test)")
    ap.add_argument("--output", type=str, default=None,
                    help="Output CSV path (default: "
                         "public/data/wvb_playermatch_div1_<year>.csv)")
    args = ap.parse_args()

    if not CACHE_DIR.exists():
        print(f"ERROR: {CACHE_DIR} does not exist", file=sys.stderr)
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.output) if args.output else \
               OUTPUT_DIR / f"wvb_playermatch_div1_{args.year}.csv"

    html_files = sorted(CACHE_DIR.glob("*.html"))
    if args.limit:
        html_files = html_files[: args.limit]
    print(f"[parse-box] {len(html_files):,} cached HTML files to parse")

    all_rows: list[dict] = []
    ok = 0
    empty = 0
    fail = 0
    t0 = time.time()

    for i, path in enumerate(html_files, 1):
        cid = path.stem
        try:
            html = path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"[parse-box] {cid}: read err {e}")
            fail += 1
            continue
        try:
            rows = parse_one(html, cid, args.year)
        except Exception as e:
            print(f"[parse-box] {cid}: parse err {e}")
            fail += 1
            continue
        if not rows:
            empty += 1
            continue
        all_rows.extend(rows)
        ok += 1
        if i % 500 == 0:
            elapsed = time.time() - t0
            rate = i / max(elapsed, 1)
            eta = (len(html_files) - i) / rate
            print(f"[parse-box] {i}/{len(html_files)}  ok={ok} empty={empty} "
                  f"fail={fail}  ({rate:.1f}/s, ~{eta / 60:.1f}min remaining)")

    # Write CSV
    with out_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS, extrasaction="ignore")
        w.writeheader()
        w.writerows(all_rows)

    elapsed = time.time() - t0
    print(f"\n[parse-box] done in {elapsed:.0f}s")
    print(f"[parse-box] ok: {ok}  empty: {empty}  fail: {fail}")
    print(f"[parse-box] rows written: {len(all_rows):,}")
    print(f"[parse-box] wrote {out_path}  "
          f"({out_path.stat().st_size / (1024 * 1024):.1f} MB)")


if __name__ == "__main__":
    main()
