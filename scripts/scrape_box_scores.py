"""
scrape_box_scores.py
────────────────────

Scrapes NCAA D1 women's volleyball per-match box scores directly from
stats.ncaa.org — unlike the R `ncaavolleyballr` package we've been using,
this keeps BOTH teams' rosters for every contest (the R path's
`group_stats` applies a team filter and dedupes by contest, losing one
perspective).

URL pattern
───────────
  https://stats.ncaa.org/teams/{team_id}                  → schedule page
  https://stats.ncaa.org/contests/{contest_id}/individual_stats
                                                          → both rosters

Workflow
────────
  1. probe(contest_id)           – sanity-check one URL before committing
  2. build_team_list(year)       – load team_ids from teams CSV (see below)
  3. enumerate_contests(year)    – walk team schedules, cache contest IDs
  4. rescrape_month(year, mm)    – fetch individual_stats for contests in
                                   that month, cache per-contest JSON
  5. assemble_csv(year)          – concat cached JSON → CSV matching
                                   public/data/wvb_playermatch_div1_*.csv
                                   schema

Usage
─────
Run interactively from the repo root:

    py -3.14 -i scripts/scrape_box_scores.py

Then at the REPL:

    probe(6501597)                           # first thing you run
    enumerate_contests(2024)                 # ~10 min, resumable
    rescrape_month(2024, 8)                  # August → then 9, 10, 11, 12
    rescrape_month(2024, 9)
    ...
    assemble_csv(2024)                       # final CSV output

Dependencies
────────────
  Standard library + requests, beautifulsoup4, lxml.
  Install with:  py -3.14 -m pip install requests beautifulsoup4 lxml

If probe() reveals the page is rendered by JavaScript (i.e. the tables
aren't in the raw HTML), we'll escalate to Playwright:
  py -3.14 -m pip install playwright
  py -3.14 -m playwright install chromium

Team list input
───────────────
This script needs a mapping of {team_id → (team_name, conference, year)}.
Easiest path: export `ncaavolleyballr::wvb_teams` once from R.

In an R console (one-time setup):

    library(ncaavolleyballr)
    write.csv(wvb_teams, "scripts/wvb_teams.csv", row.names = FALSE)

The script reads that file to enumerate D1 teams for each season.
"""

from __future__ import annotations

import csv
import json
import os
import random
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import requests
from bs4 import BeautifulSoup

# ─── Paths / config ─────────────────────────────────────────────────────────

REPO_ROOT       = Path(__file__).resolve().parent.parent
CACHE_ROOT      = REPO_ROOT / "scripts" / ".boxscore-cache"
OUTPUT_DIR      = REPO_ROOT / "public" / "data"
TEAMS_CSV       = REPO_ROOT / "scripts" / "wvb_teams.csv"
FAILURES_CSV    = CACHE_ROOT / "_failures.csv"

BASE            = "https://stats.ncaa.org"
THROTTLE_MIN    = 1.8           # seconds between requests (randomized)
THROTTLE_MAX    = 3.2
MAX_RETRIES     = 3
BACKOFF_BASE    = 4.0           # seconds — doubles on each retry

# Rotate through a few realistic desktop user-agents. stats.ncaa.org watches
# for the Python/requests default UA and returns 403 for it.
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
]

# ─── Session setup ─────────────────────────────────────────────────────────

def make_session() -> requests.Session:
    """One shared session so cookies persist across calls."""
    s = requests.Session()
    s.headers.update({
        "User-Agent":      random.choice(USER_AGENTS),
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection":      "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest":  "document",
        "Sec-Fetch-Mode":  "navigate",
        "Sec-Fetch-Site":  "none",
        "Sec-Fetch-User":  "?1",
    })
    # Warm-up request to the root — this often returns cookies we need.
    try:
        s.get(BASE, timeout=15)
    except requests.RequestException as e:
        print(f"  [warn] warm-up request failed: {e}")
    return s

SESSION: requests.Session | None = None

def _session() -> requests.Session:
    global SESSION
    if SESSION is None:
        SESSION = make_session()
    return SESSION

def reset_session() -> None:
    """Call this if you start getting 403s mid-scrape — fresh cookies + UA."""
    global SESSION
    SESSION = None

def _throttle() -> None:
    time.sleep(random.uniform(THROTTLE_MIN, THROTTLE_MAX))

def _fetch(url: str, *, referer: str | None = None) -> str:
    """GET with retry + exponential backoff. Returns HTML text."""
    headers = {}
    if referer:
        headers["Referer"] = referer
    last_err: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = _session().get(url, headers=headers, timeout=25)
            if r.status_code == 200:
                return r.text
            if r.status_code in (403, 429):
                # Anti-bot — back off hard and rotate UA
                wait = BACKOFF_BASE * (2 ** (attempt - 1))
                print(f"  [warn] {r.status_code} on {url} — sleeping {wait:.0f}s (attempt {attempt}/{MAX_RETRIES})")
                time.sleep(wait)
                reset_session()
                continue
            raise RuntimeError(f"HTTP {r.status_code} for {url}")
        except requests.RequestException as e:
            last_err = e
            wait = BACKOFF_BASE * (2 ** (attempt - 1))
            print(f"  [warn] {type(e).__name__} on {url}: {e} — sleeping {wait:.0f}s")
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url}: {last_err}")

# ─── Probe — run this FIRST ────────────────────────────────────────────────

def probe(contest_id: int = 6501597) -> None:
    """
    Sanity-check one contest URL before committing to a full scrape.

    Prints: status code, byte size, table count, first-table-headers,
    whether the page looks JS-rendered. If this fails, escalate to
    Playwright (see module docstring).
    """
    url = f"{BASE}/contests/{contest_id}/individual_stats"
    print(f"\n── PROBE ──────────────────────────────────────────")
    print(f"URL: {url}")
    print(f"UA:  {_session().headers['User-Agent'][:70]}...")
    try:
        html = _fetch(url, referer=BASE)
    except Exception as e:
        print(f"✗ Fetch failed: {e}")
        print("  → Likely need to escalate to Playwright. See module docstring.")
        return

    print(f"✓ Fetched {len(html):,} bytes")

    soup   = BeautifulSoup(html, "lxml")
    tables = soup.find_all("table")
    print(f"  {len(tables)} <table> elements on page")

    # Heuristic: if the page is a JS shell, <body> is tiny and there are 0
    # meaningful tables. Real pages have 5+ tables.
    body = soup.find("body")
    body_text_len = len(body.get_text(strip=True)) if body else 0
    print(f"  body text length: {body_text_len:,}")

    if len(tables) < 2:
        print("  ⚠ page looks JS-rendered or blocked. Inspect the HTML:")
        print(f"     (first 500 chars): {html[:500]}")
        print("  → Escalate to Playwright.")
        return

    # Preview table structure so we can confirm indices 1/4/5 are correct
    # (R package uses tables 1, 4, 5 for match info / away roster / home roster).
    for i, t in enumerate(tables[:8]):
        rows = t.find_all("tr")
        first_cells = [c.get_text(strip=True) for c in rows[0].find_all(["th", "td"])] if rows else []
        print(f"  table[{i}]: {len(rows):3d} rows, headers: {first_cells[:6]}")

    print("\n  If tables 3 and 4 look like roster stats (columns MP/S/Kills/Errors/…),")
    print("  we're good to proceed to enumerate_contests() then rescrape_month().")
    print("──────────────────────────────────────────────────\n")

# ─── Team list loader ──────────────────────────────────────────────────────

@dataclass
class Team:
    team_id:    str
    name:       str
    conference: str
    division:   int
    year:       int

def load_teams(year: int) -> list[Team]:
    """
    Read D1 WVB teams for `year` from scripts/wvb_teams.csv.

    Expected columns (as exported from ncaavolleyballr::wvb_teams):
      team_id, team_name, conference, div, yr
    """
    if not TEAMS_CSV.exists():
        raise FileNotFoundError(
            f"{TEAMS_CSV} not found. Export it from R:\n"
            "  library(ncaavolleyballr)\n"
            "  write.csv(wvb_teams, 'scripts/wvb_teams.csv', row.names = FALSE)"
        )
    teams: list[Team] = []
    with TEAMS_CSV.open(encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        # Normalize column names — R exports can vary in casing
        for row in reader:
            low = {k.lower(): v for k, v in row.items()}
            try:
                yr  = int(float(low.get("yr") or low.get("year") or 0))
                div = int(float(low.get("div") or low.get("division") or 0))
            except ValueError:
                continue
            if yr != year or div != 1:
                continue
            tid  = str(low.get("team_id") or "").strip()
            name = (low.get("team_name") or low.get("name") or "").strip()
            conf = (low.get("conference") or "").strip()
            if tid and name:
                teams.append(Team(tid, name, conf, div, yr))
    print(f"  {len(teams)} D1 WVB teams loaded for {year}")
    return teams

# ─── Schedule / contest enumeration ────────────────────────────────────────

CONTEST_RE = re.compile(r"/contests/(\d+)/box_score", re.I)

def _team_schedule_contests(team_id: str) -> list[tuple[str, str]]:
    """
    Fetch one team's schedule page and extract (contest_id, date) tuples.
    Date format: whatever the schedule page shows (we'll normalize later).
    """
    url  = f"{BASE}/teams/{team_id}"
    html = _fetch(url, referer=BASE)
    soup = BeautifulSoup(html, "lxml")

    out: list[tuple[str, str]] = []
    for a in soup.find_all("a", href=True):
        m = CONTEST_RE.search(a["href"])
        if not m:
            continue
        cid = m.group(1)
        # Walk up to the <tr> and take the first cell as the date
        tr = a.find_parent("tr")
        date = ""
        if tr:
            cells = tr.find_all(["td", "th"])
            if cells:
                date = cells[0].get_text(strip=True)
        out.append((cid, date))
    return out

def enumerate_contests(year: int) -> list[str]:
    """
    Walk every D1 team's schedule for `year`, return unique contest IDs.
    Cached to <CACHE_ROOT>/<year>/_contest_ids.json after first run.
    """
    year_cache = CACHE_ROOT / str(year)
    year_cache.mkdir(parents=True, exist_ok=True)
    cache_path = year_cache / "_contest_ids.json"

    if cache_path.exists():
        ids = json.loads(cache_path.read_text(encoding="utf-8"))
        print(f"  Loaded {len(ids)} cached contest IDs for {year}")
        return ids

    teams = load_teams(year)
    seen:     set[str]   = set()
    ordered:  list[str]  = []
    failures              = 0

    for i, t in enumerate(teams, 1):
        try:
            pairs = _team_schedule_contests(t.team_id)
        except Exception as e:
            failures += 1
            print(f"  [fail {failures}] team {t.team_id} {t.name}: {e}")
            _throttle()
            continue
        for cid, _ in pairs:
            if cid not in seen:
                seen.add(cid)
                ordered.append(cid)
        if i % 10 == 0:
            print(f"    {i}/{len(teams)} teams · {len(ordered)} unique contests · {failures} failures")
        _throttle()

    cache_path.write_text(json.dumps(ordered), encoding="utf-8")
    print(f"  Cached {len(ordered)} contest IDs → {cache_path}")
    return ordered

# ─── Per-contest fetch + parse ─────────────────────────────────────────────

def _contest_cache_path(year: int, cid: str) -> Path:
    return CACHE_ROOT / str(year) / f"{cid}.json"

def _parse_individual_stats(html: str, contest_id: str) -> dict:
    """
    Parse a contests/{id}/individual_stats page into:
      {
        contest_id, date, location,
        teams: [ { team_name, conference, is_home, players: [ {...}, ... ] }, ... ]
      }

    NOTE: Actual table indices + column names come from probe() output on a
    real page. This implementation is the expected shape; adjust after probe.
    """
    soup = BeautifulSoup(html, "lxml")
    tables = soup.find_all("table")

    out: dict = {
        "contest_id": contest_id,
        "date":       None,
        "location":   None,
        "teams":      [],
    }

    # Match info is typically table[0] or table[1] — key/value pairs
    for t in tables[:3]:
        for row in t.find_all("tr"):
            cells = [c.get_text(" ", strip=True) for c in row.find_all(["th", "td"])]
            if len(cells) >= 2:
                k, v = cells[0].lower(), cells[1]
                if "date" in k and not out["date"]:
                    out["date"] = v
                elif ("location" in k or "site" in k) and not out["location"]:
                    out["location"] = v

    # Roster tables: typically the last two large tables with many rows.
    # R package uses indices 3 and 4 (1-indexed: 4 and 5). Pick the two
    # biggest tables with a "Player" or "Name" header.
    roster_tables: list[tuple[int, list[list[str]]]] = []
    for idx, t in enumerate(tables):
        rows = t.find_all("tr")
        if len(rows) < 3:
            continue
        header = [c.get_text(strip=True) for c in rows[0].find_all(["th", "td"])]
        hdr_join = "|".join(h.lower() for h in header)
        if "player" in hdr_join or "name" in hdr_join or "##" in hdr_join:
            data = []
            for r in rows:
                data.append([c.get_text(strip=True) for c in r.find_all(["th", "td"])])
            roster_tables.append((idx, data))

    # Take the two largest
    roster_tables.sort(key=lambda x: len(x[1]), reverse=True)
    for idx, rows in roster_tables[:2]:
        header = rows[0]
        players = []
        for r in rows[1:]:
            if len(r) < len(header):
                continue
            p = dict(zip(header, r))
            if not p.get("Player") and not p.get("Name"):
                continue
            players.append(p)
        out["teams"].append({
            "table_index": idx,
            "header":      header,
            "players":     players,
        })

    return out

def fetch_contest(year: int, cid: str, *, force: bool = False) -> bool:
    """
    Fetch + parse + cache one contest. Returns True on success, False on failure
    (failure row appended to _failures.csv). Idempotent — skips if already cached.
    """
    cache_path = _contest_cache_path(year, cid)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if cache_path.exists() and not force:
        return True

    url = f"{BASE}/contests/{cid}/individual_stats"
    try:
        html   = _fetch(url, referer=f"{BASE}/contests/{cid}/box_score")
        parsed = _parse_individual_stats(html, cid)
    except Exception as e:
        _log_failure(year, cid, str(e))
        return False

    cache_path.write_text(json.dumps(parsed, ensure_ascii=False, indent=1), encoding="utf-8")
    return True

def _log_failure(year: int, cid: str, msg: str) -> None:
    FAILURES_CSV.parent.mkdir(parents=True, exist_ok=True)
    new = not FAILURES_CSV.exists()
    with FAILURES_CSV.open("a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["year", "contest_id", "time", "error"])
        w.writerow([year, cid, time.strftime("%Y-%m-%d %H:%M:%S"), msg[:500]])

# ─── Month-at-a-time entry point ───────────────────────────────────────────

_DATE_RE = re.compile(r"(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})")

def _contest_month(year: int, cid: str) -> int | None:
    """
    Return the month (1-12) of a contest based on the enumeration cache
    (which stores dates from team schedules). Falls back to None if unknown.
    """
    # We didn't persist dates in _contest_ids.json (just IDs). Pull the date
    # from the per-contest cache if already fetched, else from any one team's
    # schedule would require re-walking. For simplicity: if not cached,
    # fetch the contest first (no filter). This means month filtering works
    # best AFTER a first pass enumerates + fetches everything.
    cache_path = _contest_cache_path(year, cid)
    if not cache_path.exists():
        return None
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        date = data.get("date") or ""
        m = _DATE_RE.search(date)
        if m:
            mm = int(m.group(1))
            if 1 <= mm <= 12:
                return mm
    except Exception:
        pass
    return None

def rescrape_month(year: int, month: int) -> None:
    """
    Fetch individual_stats for all contests in the given month.

    Because the enumeration cache stores only IDs (not dates), the first run
    fetches ALL contests for the year and month-filters from the per-contest
    cache afterward. On subsequent runs, month-filtering works off the
    existing cache and only contests in that month get re-fetched.

    In practice: run with month=0 to fetch everything in one pass, OR run
    month-by-month starting with the earliest (August = 8).
    """
    print(f"\n── RESCRAPE {year} month={month or 'all'} ──────────────")
    contest_ids = enumerate_contests(year)
    print(f"  {len(contest_ids)} total contests for {year}")

    success = fail = skipped = 0
    start_time = time.time()
    for i, cid in enumerate(contest_ids, 1):
        # Month filter: if we've already cached this contest, respect the
        # month filter. If not cached, fall through and fetch (since we
        # need the page to know its date).
        if month:
            mm = _contest_month(year, cid)
            if mm is not None and mm != month:
                continue

        if _contest_cache_path(year, cid).exists():
            skipped += 1
            continue

        ok = fetch_contest(year, cid)
        if ok: success += 1
        else:  fail += 1
        _throttle()

        if (success + fail) % 25 == 0 and (success + fail) > 0:
            elapsed = time.time() - start_time
            rate    = (success + fail) / max(elapsed, 1)
            eta_min = (len(contest_ids) - i) / max(rate, 0.01) / 60
            print(f"    {i}/{len(contest_ids)} · {success} new · {fail} fail · "
                  f"{skipped} cached · ETA {eta_min:.0f} min")

    print(f"  Done: {success} new · {skipped} cached · {fail} failed")

# ─── CSV assembly ──────────────────────────────────────────────────────────

TARGET_COLS = [
    "team", "Season", "Date", "Team", "Conference", "Opponent Team",
    "Opponent Conference", "Location", "Number", "Player", "P", "S",
    "Kills", "Errors", "TotalAttacks", "HitPct", "Assists", "Aces",
    "SErr", "Digs", "RetAtt", "RErr", "BlockSolos", "BlockAssists",
    "BErr", "PTS", "BHE",
]

# stats.ncaa.org uses slightly different column headers than the R package's
# tidied output. Map them here. Confirm via probe() output.
COL_MAP = {
    "##":          "Number",
    "#":           "Number",
    "Player":      "Player",
    "P":           "P",
    "Pos":         "P",
    "MS":          "S",   # "matches started" / sets played varies by page
    "S":           "S",
    "Sets":        "S",
    "Kills":       "Kills",
    "K":           "Kills",
    "Errors":      "Errors",
    "E":           "Errors",
    "Total Attacks": "TotalAttacks",
    "TA":          "TotalAttacks",
    "Hit Pct":     "HitPct",
    "Pct":         "HitPct",
    "Assists":     "Assists",
    "A":           "Assists",
    "Aces":        "Aces",
    "SA":          "Aces",
    "Serve Err":   "SErr",
    "SE":          "SErr",
    "Digs":        "Digs",
    "D":           "Digs",
    "RetAtt":      "RetAtt",
    "Reception Errors": "RErr",
    "RE":          "RErr",
    "Block Solos": "BlockSolos",
    "BS":          "BlockSolos",
    "Block Assists": "BlockAssists",
    "BA":          "BlockAssists",
    "BHE":         "BHE",
    "BE":          "BErr",
    "Block Errors": "BErr",
    "PTS":         "PTS",
    "Points":      "PTS",
}

def _normalize_row(raw: dict) -> dict:
    """Map stats.ncaa.org column names to our CSV schema."""
    out = {k: "" for k in TARGET_COLS}
    for k, v in raw.items():
        tgt = COL_MAP.get(k.strip())
        if tgt:
            out[tgt] = v
    return out

def assemble_csv(year: int) -> Path:
    """
    Concatenate all cached per-contest JSON into
    public/data/wvb_playermatch_div1_<year>_twosided.csv matching the
    existing schema (so the UI just consumes it as-is).
    """
    season_str  = f"{year}-{year+1}"
    year_cache  = CACHE_ROOT / str(year)
    if not year_cache.exists():
        raise FileNotFoundError(f"No cache for {year} at {year_cache}")

    out_path = OUTPUT_DIR / f"wvb_playermatch_div1_{year}_twosided.csv"
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    json_files = sorted(year_cache.glob("*.json"))
    json_files = [p for p in json_files if not p.name.startswith("_")]
    print(f"  Assembling from {len(json_files)} cached contests")

    for p in json_files:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  [skip] {p.name}: {e}")
            continue

        teams = data.get("teams", [])
        if len(teams) != 2:
            continue

        team_names = [t.get("team_name") or f"?table{t.get('table_index','?')}" for t in teams]

        for i, t in enumerate(teams):
            own_name = team_names[i]
            opp_name = team_names[1 - i]
            for raw in t.get("players", []):
                normed = _normalize_row(raw)
                normed["team"]                = own_name
                normed["Team"]                = own_name
                normed["Opponent Team"]       = opp_name
                normed["Season"]              = season_str
                normed["Date"]                = data.get("date") or ""
                normed["Location"]            = data.get("location") or ""
                normed["Conference"]          = t.get("conference") or ""
                normed["Opponent Conference"] = teams[1-i].get("conference") or ""
                rows.append(normed)

    with out_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=TARGET_COLS, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        w.writerows(rows)

    print(f"  Wrote {out_path} ({len(rows)} rows)")
    return out_path

# ─── REPL banner ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(__doc__.strip().split("\n\n")[0])
    print("\nAvailable functions (run from the REPL):")
    print("  probe(contest_id=6501597)    – sanity-check one URL first")
    print("  enumerate_contests(year)     – walk schedules, cache contest IDs")
    print("  rescrape_month(year, month)  – fetch contests (month=0 for all)")
    print("  fetch_contest(year, cid)     – fetch one contest")
    print("  assemble_csv(year)           – concat cache → CSV")
    print("  reset_session()              – if you start getting 403s\n")
    print("First step:  probe()\n")
