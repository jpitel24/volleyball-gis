"""
discover_pbp_ids.py — enumerate stats.ncaa.org native contest IDs.

The play-by-play URLs at stats.ncaa.org use a contest-ID namespace that
DIFFERS from the NCAA stats-api ContestIDs in our existing CSVs. To
build a correct fetch list for scrape_pbp.py we walk stats.ncaa.org's
own team pages and extract every /contests/<id> link.

Flow:
  Phase A (network):
    1. Fetch the RPI nitty-gritty page (URL passed via --rpi-url).
    2. Extract every /teams/<team_id> link.
    3. For each team, fetch their /teams/<team_id> page and cache
       the HTML to scripts/.pbp-build/team_pages_<year>/<team_id>.html.
    Re-runs skip teams that already have a cached HTML on disk.

  Phase B (local):
    4. Walk every cached team-page HTML, extract /contests/<id> links.
    5. Dedupe contest IDs across teams.
    6. Write scripts/.pbp-build/contest_ids_<year>.txt (one ID per line).

Cloudflare WARP must be connected for Phase A so Akamai accepts the
requests. Phase B is purely local and re-runs instantly.

Usage:
  py -X utf8 scripts/discover_pbp_ids.py \\
      --rpi-url https://stats.ncaa.org/selection_rankings/nitty_gritties/47691 \\
      --year 2025

  # Re-extract from cache without re-scraping (fast):
  py -X utf8 scripts/discover_pbp_ids.py --year 2025 --extract-only
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BUILD_DIR  = Path("scripts/.pbp-build")
BUILD_DIR.mkdir(parents=True, exist_ok=True)

# Tunables ───────────────────────────────────────────────────────────
THROTTLE_S       = 1.5
WARMUP_DWELL_MS  = 3_000
PAGE_DWELL_MS    = 1_200
NAV_TIMEOUT_MS   = 60_000
HOME_URL         = "https://stats.ncaa.org/"
USER_AGENT_EDGE  = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
)

TEAM_LINK_RE    = re.compile(r"/teams/(\d+)")
CONTEST_LINK_RE = re.compile(r"/contests/(\d+)/")


def cache_dir(year: int) -> Path:
    d = BUILD_DIR / f"team_pages_{year}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def rpi_cache_path(year: int) -> Path:
    return BUILD_DIR / f"rpi_page_{year}.html"


def out_path(year: int) -> Path:
    return BUILD_DIR / f"contest_ids_{year}.txt"


def extract_team_ids(html: str) -> list[str]:
    """Pull /teams/<id> from raw HTML, dedupe, preserve first-seen order."""
    seen: set[str] = set()
    out: list[str] = []
    for tid in TEAM_LINK_RE.findall(html):
        if tid not in seen:
            seen.add(tid)
            out.append(tid)
    return out


def extract_contest_ids(html: str) -> list[str]:
    """Pull /contests/<id> from raw HTML, dedupe."""
    seen: set[str] = set()
    out: list[str] = []
    for cid in CONTEST_LINK_RE.findall(html):
        if cid not in seen:
            seen.add(cid)
            out.append(cid)
    return out


def fetch_with_browser(rpi_url: str, year: int) -> None:
    """Phase A: fetch RPI page + every team page through Playwright + WARP."""
    rpi_html_path = rpi_cache_path(year)
    teams_dir = cache_dir(year)

    print("[discover] make sure Cloudflare WARP is connected before continuing")
    print("[discover] launching Edge (msedge channel) …")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            channel="msedge",
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent=USER_AGENT_EDGE,
            viewport={"width": 1366, "height": 900},
            locale="en-US",
            timezone_id="America/Chicago",
        )
        context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
        )
        page = context.new_page()

        # Warmup — homepage seeds Akamai cookies for the session
        print(f"[discover] warmup → {HOME_URL}")
        try:
            page.goto(HOME_URL, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(WARMUP_DWELL_MS)
        except PWTimeout:
            print("[discover] warmup timed out — continuing")
        akamai_cookies = {c["name"] for c in context.cookies()}
        if "ak_bmsc" not in akamai_cookies:
            print("[discover] WARNING: no ak_bmsc cookie — Akamai blocking. "
                  "Confirm WARP is connected. Aborting.")
            browser.close()
            sys.exit(2)

        # Step 1: RPI page (cache so re-runs reuse it)
        if rpi_html_path.exists() and rpi_html_path.stat().st_size > 5_000:
            print(f"[discover] using cached RPI page → {rpi_html_path}")
            rpi_html = rpi_html_path.read_text(encoding="utf-8")
        else:
            print(f"[discover] fetching RPI page → {rpi_url}")
            page.goto(rpi_url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(PAGE_DWELL_MS)
            rpi_html = page.content()
            rpi_html_path.write_text(rpi_html, encoding="utf-8")
            print(f"[discover]   saved ({len(rpi_html):,} bytes)")
            time.sleep(THROTTLE_S)

        team_ids = extract_team_ids(rpi_html)
        # The RPI page also has navigation/header links to /teams/... we don't
        # want. Filter to just IDs that look D1-volleyball-team-shaped (7-digit
        # season-team IDs are typical; nav links are usually shorter).
        team_ids = [t for t in team_ids if len(t) >= 6]
        print(f"[discover] {len(team_ids)} team links from RPI page")
        if len(team_ids) < 100:
            print(f"[discover] WARNING: expected ~340 D1 teams, only got {len(team_ids)}.")
            print(f"[discover] First 20 IDs: {team_ids[:20]}")
            print("[discover] If this looks wrong, inspect "
                  f"{rpi_html_path} and let me know what the table looks like.")

        # Step 2: each team page
        ok = skip = fail = 0
        for i, tid in enumerate(team_ids, 1):
            cache_path = teams_dir / f"{tid}.html"
            if cache_path.exists() and cache_path.stat().st_size > 5_000:
                skip += 1
                continue
            url = f"https://stats.ncaa.org/teams/{tid}"
            print(f"[discover] [{i:>4}/{len(team_ids)}] {tid} …", end=" ", flush=True)
            try:
                page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
                page.wait_for_timeout(PAGE_DWELL_MS)
                html = page.content()
                if len(html) < 5_000 or "<table" not in html.lower():
                    print(f"BLOCKED ({len(html):,} bytes)")
                    fail += 1
                else:
                    cache_path.write_text(html, encoding="utf-8")
                    contest_count = len(extract_contest_ids(html))
                    print(f"ok ({len(html):,} bytes, {contest_count} contest links)")
                    ok += 1
            except PWTimeout:
                print("timeout")
                fail += 1
            except Exception as e:
                err = str(e)[:120]
                print(f"error: {err}")
                fail += 1
            time.sleep(THROTTLE_S)

        browser.close()

    print(f"\n[discover] phase A done: {ok} fetched, {skip} cached, {fail} failed")


def safe_read_text(path: Path, retries: int = 5, delay: float = 0.4) -> str | None:
    """
    Read a file, retrying on PermissionError. OneDrive (and antivirus
    scanners) hold transient locks on freshly-written files; we just
    wait a bit and try again. Returns None if the file still can't be
    read after N attempts so the caller can log + skip.
    """
    last_err: Exception | None = None
    for i in range(retries):
        try:
            return path.read_text(encoding="utf-8")
        except (PermissionError, OSError) as e:
            last_err = e
            time.sleep(delay)
    print(f"[discover] WARNING: could not read {path} after {retries} retries: {last_err}")
    return None


def extract_from_cache(year: int) -> None:
    """Phase B: walk cached HTML files, dedupe contest IDs, write output."""
    teams_dir = cache_dir(year)
    cached_files = sorted(teams_dir.glob("*.html"))
    if not cached_files:
        print(f"[discover] no cached team pages in {teams_dir} — run without "
              "--extract-only first.")
        sys.exit(1)

    all_contest_ids: dict[str, set[str]] = {}  # cid → set of team_ids that listed it
    skipped: list[str] = []
    for f in cached_files:
        team_id = f.stem
        html = safe_read_text(f)
        if html is None:
            skipped.append(team_id)
            continue
        for cid in extract_contest_ids(html):
            all_contest_ids.setdefault(cid, set()).add(team_id)
    if skipped:
        print(f"[discover] {len(skipped)} team pages skipped: {skipped[:10]}"
              + (" …" if len(skipped) > 10 else ""))

    print(f"[discover] {len(cached_files)} team pages parsed")
    print(f"[discover] {len(all_contest_ids):,} unique contest IDs found")

    # A real D1 contest is listed on TWO team pages (home + away). IDs
    # listed on only one team page are usually non-D1 opponents — keep
    # them too since they're still valid stats.ncaa.org contests, but
    # surface the count in case it's useful for triage.
    one_sided = sum(1 for v in all_contest_ids.values() if len(v) == 1)
    two_sided = sum(1 for v in all_contest_ids.values() if len(v) == 2)
    multi     = sum(1 for v in all_contest_ids.values() if len(v) > 2)
    print(f"[discover]   listed on 1 team page:  {one_sided:,}  (opponent likely non-D1)")
    print(f"[discover]   listed on 2 team pages: {two_sided:,}  (D1 vs D1)")
    if multi:
        print(f"[discover]   listed on 3+ team pages: {multi:,}  (?)")

    # Write the consolidated list, sorted numerically for stability.
    sorted_ids = sorted(all_contest_ids.keys(), key=int)
    out = out_path(year)
    out.write_text("\n".join(sorted_ids) + "\n", encoding="utf-8")
    print(f"[discover] wrote {out} ({len(sorted_ids):,} IDs)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpi-url", type=str,
                    help="URL of stats.ncaa.org RPI/nitty-gritty page for the season")
    ap.add_argument("--year", type=int, required=True,
                    help="Season label for output (e.g. 2025 for 2025-26)")
    ap.add_argument("--extract-only", action="store_true",
                    help="Skip network; just re-parse cached team pages")
    args = ap.parse_args()

    if not args.extract_only:
        if not args.rpi_url:
            print("ERROR: --rpi-url required unless --extract-only", file=sys.stderr)
            sys.exit(1)
        fetch_with_browser(args.rpi_url, args.year)

    extract_from_cache(args.year)


if __name__ == "__main__":
    main()
