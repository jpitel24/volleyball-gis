"""
fetch_ncaa_api.py
─────────────────

Fetches NCAA D1 Women's Volleyball box scores via the public ncaa-api
wrapper (https://ncaa-api.henrygd.me), which mirrors ncaa.com's internal
JSON and — crucially — is NOT behind Akamai bot-management.

Usage:

    python -X utf8 scripts/fetch_ncaa_api.py enumerate 2024
    python -X utf8 scripts/fetch_ncaa_api.py fetch 2024
    python -X utf8 scripts/fetch_ncaa_api.py build 2024

    # Or all-in-one:
    python -X utf8 scripts/fetch_ncaa_api.py all 2024

Caching:
  - scripts/.ncaa-api-cache/<year>/_gameids.json
  - scripts/.ncaa-api-cache/<year>/<gid>.json

Output:
  - public/data/wvb_playermatch_div1_<year>_twosided.csv

Resumable: already-cached dates/games are skipped.
"""

from __future__ import annotations

import csv
import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import requests

BASE = "https://ncaa-api.henrygd.me"
CACHE_ROOT = Path("scripts/.ncaa-api-cache")
OUTPUT_DIR = Path("public/data")

# WVB season runs late Aug to late Dec. Walk a generous window.
SEASON_START = (8, 15)   # Aug 15
SEASON_END = (12, 28)    # Dec 28

THROTTLE_SEC = 0.35       # polite but not glacial
TIMEOUT = 20

session = requests.Session()
session.headers["User-Agent"] = "Mozilla/5.0 (volleyball-gis research)"


def _get(url: str, retries: int = 3) -> requests.Response | None:
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=TIMEOUT)
            if r.status_code == 200:
                return r
            if r.status_code in (429, 503):
                wait = 2 ** attempt * 2
                print(f"    {r.status_code} backoff {wait}s")
                time.sleep(wait)
                continue
            # 502/404 etc → return response for caller to decide
            return r
        except requests.RequestException as e:
            if attempt == retries - 1:
                print(f"    giving up after {attempt + 1} retries: {e}")
                return None
            time.sleep(2 ** attempt)
    return None


def _season_dates(year: int):
    """Yield every date in the WVB season for the given fall-year."""
    start = date(year, *SEASON_START)
    end = date(year, *SEASON_END)
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


# ── Stage 1: enumerate game IDs ──────────────────────────────────────────

def enumerate_year(year: int) -> list[str]:
    """Walk every WVB D1 scoreboard date, collect unique gameIDs."""
    cache_dir = CACHE_ROOT / str(year)
    cache_dir.mkdir(parents=True, exist_ok=True)
    out_path = cache_dir / "_gameids.json"

    existing: dict[str, list[str]] = {}
    if out_path.exists():
        existing = json.loads(out_path.read_text(encoding="utf-8"))
        print(f"  Loaded {len(existing)} dates from cache")

    dates = list(_season_dates(year))
    new_dates = 0
    total_ids: set[str] = set()
    for d in existing.values():
        total_ids.update(d)

    for i, d in enumerate(dates):
        key = d.isoformat()
        if key in existing:
            continue
        url = f"{BASE}/scoreboard/volleyball-women/d1/{d.year}/{d.month:02d}/{d.day:02d}"
        r = _get(url)
        if r is None:
            existing[key] = []
        elif r.status_code == 200:
            try:
                games = r.json().get("games", [])
                ids = [g.get("game", {}).get("gameID") for g in games]
                ids = [x for x in ids if x]
                existing[key] = ids
                total_ids.update(ids)
                if ids:
                    print(f"    {key}: {len(ids)} games")
            except Exception as e:
                print(f"    {key}: parse err {e}")
                existing[key] = []
        else:
            # 404 etc — no games that day
            existing[key] = []
        new_dates += 1
        if new_dates % 20 == 0:
            out_path.write_text(json.dumps(existing), encoding="utf-8")
        time.sleep(THROTTLE_SEC)

    out_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    all_ids = sorted(total_ids)
    print(f"  Enumerated {len(all_ids)} unique game IDs across "
          f"{sum(1 for v in existing.values() if v)} active dates")
    return all_ids


# ── Stage 2: fetch per-game box scores ────────────────────────────────────

def fetch_one(gid: str, year: int) -> bool:
    """Fetch one game's boxscore; cache JSON. Returns True on success."""
    cache_dir = CACHE_ROOT / str(year)
    cache_path = cache_dir / f"{gid}.json"
    if cache_path.exists():
        return True

    url = f"{BASE}/game/{gid}/boxscore"
    r = _get(url)
    if r is None or r.status_code != 200:
        code = r.status_code if r is not None else "NET"
        _log_failure(gid, year, f"status={code}")
        return False
    try:
        d = r.json()
    except Exception as e:
        _log_failure(gid, year, f"json parse: {e}")
        return False

    if d.get("sportCode") != "WVB":
        # Not a volleyball game — mark and skip
        _log_failure(gid, year, f"sport={d.get('sportCode')}")
        return False

    cache_path.write_text(json.dumps(d), encoding="utf-8")
    return True


def _log_failure(gid: str, year: int, msg: str):
    fp = CACHE_ROOT / str(year) / "_failures.csv"
    exists = fp.exists()
    with fp.open("a", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        if not exists:
            w.writerow(["gameID", "time", "error"])
        w.writerow([gid, time.strftime("%Y-%m-%d %H:%M:%S"), msg])


def fetch_year(year: int):
    cache_dir = CACHE_ROOT / str(year)
    ids_path = cache_dir / "_gameids.json"
    if not ids_path.exists():
        print(f"  No _gameids.json for {year}; run 'enumerate' first")
        return
    date_map = json.loads(ids_path.read_text(encoding="utf-8"))
    all_ids = sorted({g for ids in date_map.values() for g in ids})
    print(f"  Fetching {len(all_ids)} games…")

    start = time.time()
    success = 0
    failure = 0
    skipped = 0
    for i, gid in enumerate(all_ids):
        if (cache_dir / f"{gid}.json").exists():
            skipped += 1
            continue
        ok = fetch_one(gid, year)
        if ok:
            success += 1
        else:
            failure += 1
        time.sleep(THROTTLE_SEC)
        if (i + 1) % 50 == 0:
            elapsed = time.time() - start
            done = success + failure
            rate = max(done / max(elapsed, 1), 0.01)
            remaining = len(all_ids) - skipped - done
            eta = remaining / rate / 60
            print(f"    {i + 1}/{len(all_ids)} · "
                  f"{skipped} cached · {success} new · {failure} fail · "
                  f"ETA {eta:.0f} min")
    print(f"  Done: {success} new · {skipped} cached · {failure} failed")


# ── Stage 3: build CSV from cache ─────────────────────────────────────────

# Output column order — keep compatible with existing one-sided schema,
# extend at end so downstream code works unchanged.
COLS = [
    "Season", "Date", "ContestID", "Team", "Conference",
    "Opponent Team", "Opponent Conference", "Location",
    "Number", "Player", "P", "S",
    "Kills", "Errors", "TotalAttacks", "HitPct",
    "Assists", "Aces", "SErr",
    "Digs", "RetAtt", "RErr",
    "BlockSolos", "BlockAssists", "BErr",
    "PTS", "BHE",
    # Extensions (not in original schema):
    "SetErr", "SetAtt", "ServeAtt", "TotalBlocks",
]


def _as_num(x):
    if x is None:
        return ""
    s = str(x)
    return s


def build_csv(year: int):
    cache_dir = CACHE_ROOT / str(year)
    game_files = sorted(cache_dir.glob("[0-9]*.json"))
    print(f"  Reading {len(game_files)} cached games…")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"wvb_playermatch_div1_{year}_twosided.csv"

    ids_path = cache_dir / "_gameids.json"
    date_map = json.loads(ids_path.read_text(encoding="utf-8")) if ids_path.exists() else {}
    id_to_date: dict[str, str] = {}
    for dstr, ids in date_map.items():
        for gid in ids:
            id_to_date[gid] = dstr

    rows_written = 0
    with out_path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS, extrasaction="ignore")
        w.writeheader()

        for gf in game_files:
            try:
                d = json.loads(gf.read_text(encoding="utf-8"))
            except Exception:
                continue
            gid = gf.stem
            teams_meta = {str(t["teamId"]): t for t in d.get("teams", [])}
            if len(teams_meta) != 2:
                continue
            team_ids = list(teams_meta.keys())

            game_date = id_to_date.get(gid, "")
            season_label = f"{year}-{year + 1}"

            for tbox in d.get("teamBoxscore", []):
                tid = str(tbox.get("teamId"))
                if tid not in teams_meta:
                    continue
                team = teams_meta[tid]
                opp_tid = next(x for x in team_ids if x != tid)
                opp = teams_meta[opp_tid]
                location = "Home" if team.get("isHome") else "Away"

                for ps in tbox.get("playerStats", []):
                    if not ps.get("participated"):
                        continue
                    player_name = f"{ps.get('firstName', '').strip()} {ps.get('lastName', '').strip()}".strip()
                    row = {
                        "Season":              season_label,
                        "Date":                game_date,
                        "ContestID":           gid,
                        "Team":                team.get("nameShort", ""),
                        "Conference":          "",
                        "Opponent Team":       opp.get("nameShort", ""),
                        "Opponent Conference": "",
                        "Location":            location,
                        "Number":              _as_num(ps.get("number")),
                        "Player":              player_name,
                        "P":                   ps.get("position", "") or "",
                        "S":                   _as_num(ps.get("gamesPlayed")),
                        "Kills":               _as_num(ps.get("kills")),
                        "Errors":              _as_num(ps.get("attackErrors")),
                        "TotalAttacks":        _as_num(ps.get("attackAttempts")),
                        "HitPct":              _as_num(ps.get("hittingPercentage")),
                        "Assists":             _as_num(ps.get("assists")),
                        "Aces":                _as_num(ps.get("serviceAces")),
                        "SErr":                _as_num(ps.get("serviceErrors")),
                        "Digs":                _as_num(ps.get("digs")),
                        "RetAtt":              _as_num(ps.get("receptionAttempts")),
                        "RErr":                _as_num(ps.get("receptionErrors")),
                        "BlockSolos":          _as_num(ps.get("blockSolos")),
                        "BlockAssists":        _as_num(ps.get("blockAssists")),
                        "BErr":                _as_num(ps.get("blockingErrors")),
                        "PTS":                 _as_num(ps.get("points")),
                        "BHE":                 _as_num(ps.get("ballHandlingErrors")),
                        "SetErr":              _as_num(ps.get("setErrors")),
                        "SetAtt":              _as_num(ps.get("setAttempts")),
                        "ServeAtt":            _as_num(ps.get("serveAttempts")),
                        "TotalBlocks":         _as_num(ps.get("totalBlocks")),
                    }
                    w.writerow(row)
                    rows_written += 1

    print(f"  Wrote {out_path} ({rows_written} rows)")


# ── Stage 4: fetch play-by-play for set scores ────────────────────────────

def fetch_pbp_one(gid: str, year: int) -> bool:
    """Cache play-by-play JSON for one game. Returns True on success."""
    cache_dir = CACHE_ROOT / str(year) / "pbp"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{gid}.json"
    if cache_path.exists():
        return True
    url = f"{BASE}/game/{gid}/play-by-play"
    r = _get(url)
    if r is None or r.status_code != 200:
        return False
    try:
        d = r.json()
    except Exception:
        return False
    cache_path.write_text(json.dumps(d), encoding="utf-8")
    return True


def fetch_pbp_year(year: int):
    cache_dir = CACHE_ROOT / str(year)
    ids_path = cache_dir / "_gameids.json"
    if not ids_path.exists():
        print(f"  No _gameids.json for {year}; run 'enumerate' first")
        return
    # Only fetch PBP for games whose boxscore was WVB (cached as <gid>.json)
    wvb_ids = sorted(p.stem for p in cache_dir.glob("[0-9]*.json"))
    print(f"  Fetching PBP for {len(wvb_ids)} games…")
    start = time.time()
    success = skipped = failure = 0
    pbp_dir = cache_dir / "pbp"
    for i, gid in enumerate(wvb_ids):
        if (pbp_dir / f"{gid}.json").exists():
            skipped += 1
            continue
        if fetch_pbp_one(gid, year):
            success += 1
        else:
            failure += 1
        time.sleep(THROTTLE_SEC)
        if (i + 1) % 50 == 0:
            done = success + failure
            rate = max(done / max(time.time() - start, 1), 0.01)
            remaining = len(wvb_ids) - skipped - done
            eta = remaining / rate / 60
            print(f"    {i+1}/{len(wvb_ids)} · {skipped} cached · "
                  f"{success} new · {failure} fail · ETA {eta:.0f} min")
    print(f"  Done: {success} new · {skipped} cached · {failure} failed")


def build_setscores(year: int):
    """Build public/data/wvb_setscores_<year>.json from cached PBP."""
    cache_dir = CACHE_ROOT / str(year) / "pbp"
    files = sorted(cache_dir.glob("[0-9]*.json"))
    print(f"  Reading {len(files)} cached PBP files…")
    out = {}
    for gf in files:
        gid = gf.stem
        try:
            d = json.loads(gf.read_text(encoding="utf-8"))
        except Exception:
            continue
        periods = []
        for per in d.get("periods", []):
            last_h = last_v = None
            for stat in per.get("playbyplayStats", []):
                for pl in stat.get("plays", []):
                    h = pl.get("homeScore")
                    v = pl.get("visitorScore")
                    if h is not None and v is not None:
                        try:
                            last_h, last_v = int(h), int(v)
                        except (TypeError, ValueError):
                            pass
            if last_h is not None:
                periods.append([last_h, last_v])
        if periods:
            out[gid] = periods
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"wvb_setscores_{year}.json"
    out_path.write_text(json.dumps(out), encoding="utf-8")
    print(f"  Wrote {out_path} ({len(out)} games)")


# ── Stage 5: fetch /game/{gid} (contest root) for authoritative linescores ─

def fetch_linescore_one(gid: str, year: int) -> bool:
    cache_dir = CACHE_ROOT / str(year) / "contest"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{gid}.json"
    if cache_path.exists():
        return True
    url = f"{BASE}/game/{gid}"
    r = _get(url)
    if r is None or r.status_code != 200:
        return False
    try:
        d = r.json()
    except Exception:
        return False
    cache_path.write_text(json.dumps(d), encoding="utf-8")
    return True


def fetch_linescores_year(year: int):
    cache_dir = CACHE_ROOT / str(year)
    wvb_ids = sorted(p.stem for p in cache_dir.glob("[0-9]*.json"))
    print(f"  Fetching linescores for {len(wvb_ids)} games…")
    start = time.time()
    success = skipped = failure = 0
    contest_dir = cache_dir / "contest"
    for i, gid in enumerate(wvb_ids):
        if (contest_dir / f"{gid}.json").exists():
            skipped += 1
            continue
        if fetch_linescore_one(gid, year):
            success += 1
        else:
            failure += 1
        time.sleep(THROTTLE_SEC)
        if (i + 1) % 50 == 0:
            done = success + failure
            rate = max(done / max(time.time() - start, 1), 0.01)
            remaining = len(wvb_ids) - skipped - done
            eta = remaining / rate / 60
            print(f"    {i+1}/{len(wvb_ids)} · {skipped} cached · "
                  f"{success} new · {failure} fail · ETA {eta:.0f} min")
    print(f"  Done: {success} new · {skipped} cached · {failure} failed")


def build_setscores_from_linescores(year: int):
    """Build public/data/wvb_setscores_<year>.json from cached linescore JSON."""
    contest_dir = CACHE_ROOT / str(year) / "contest"
    files = sorted(contest_dir.glob("[0-9]*.json"))
    print(f"  Reading {len(files)} cached contest files…")
    out = {}
    for gf in files:
        gid = gf.stem
        try:
            d = json.loads(gf.read_text(encoding="utf-8"))
        except Exception:
            continue
        contests = d.get("contests", [])
        if not contests:
            continue
        lines = contests[0].get("linescores") or []
        periods = []
        for ln in lines:
            try:
                h = int(ln.get("home"))
                v = int(ln.get("visit"))
                periods.append([h, v])
            except (TypeError, ValueError):
                pass
        if periods:
            out[gid] = periods
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"wvb_setscores_{year}.json"
    out_path.write_text(json.dumps(out), encoding="utf-8")
    print(f"  Wrote {out_path} ({len(out)} games)")


# ── CLI ──────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    year = int(sys.argv[2])
    print(f"═══ {cmd} {year} ═══")
    if cmd == "enumerate":
        enumerate_year(year)
    elif cmd == "fetch":
        fetch_year(year)
    elif cmd == "build":
        build_csv(year)
    elif cmd == "fetch_pbp":
        fetch_pbp_year(year)
    elif cmd == "build_setscores":
        build_setscores(year)
    elif cmd == "fetch_linescores":
        fetch_linescores_year(year)
    elif cmd == "build_setscores_ls":
        build_setscores_from_linescores(year)
    elif cmd == "all":
        enumerate_year(year)
        fetch_year(year)
        build_csv(year)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
