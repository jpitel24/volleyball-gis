"""
add_ids_from_page.py — fetch a stats.ncaa.org page (through Playwright +
WARP) and extract every /contests/<id>/ link on it, appending to the
year's contest_ids file.

Use case: daily in-season workflow. NCAA publishes a scoreboard page
per day at a URL like:
    https://stats.ncaa.org/season_divisions/17820/scoreboards?game_date=8%2F27%2F2026
(or similar — grab whatever URL your browser shows when you view the
scoreboard for a given day). You paste it in, this script grabs every
game's contest ID off the page, dedupes against the existing file,
and writes back.

Works for any stats.ncaa.org page that includes contest links — daily
scoreboards, tournament brackets, team schedule pages, conference-
specific pages, whatever. Same regex the discover script uses.

Usage:
    py -X utf8 scripts/add_ids_from_page.py --year 2026 \\
        --url "https://stats.ncaa.org/season_divisions/17820/scoreboards?game_date=8%2F27%2F2026"

    # Or via the npm shortcut (drops the --url flag; pass URL directly):
    npm run add-from-url "https://stats.ncaa.org/…"
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright
from playwright.sync_api import TimeoutError as PWTimeout

CONTEST_RE = re.compile(r"/contests/(\d+)/")
BUILD_DIR = Path("scripts/.pbp-build")
HOME_URL = "https://stats.ncaa.org/"
NAV_TIMEOUT_MS = 60_000
PAGE_DWELL_MS = 3_000

USER_AGENT_EDGE = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
)


def extract_contest_ids(html: str) -> list[str]:
    """Return contest IDs in first-seen order, deduped."""
    seen: set[str] = set()
    out: list[str] = []
    for cid in CONTEST_RE.findall(html):
        if cid not in seen:
            seen.add(cid)
            out.append(cid)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--url",  type=str, required=True,
                    help="stats.ncaa.org page URL to scan for /contests/<id>/ links")
    ap.add_argument("--headless", action="store_true",
                    help="Run browser hidden (default: visible so you can spot Akamai walls)")
    args = ap.parse_args()

    out_path = BUILD_DIR / f"contest_ids_{args.year}.txt"
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    existing: set[str] = set()
    if out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if s:
                existing.add(s)
        print(f"[add-from-url] {out_path} has {len(existing)} existing IDs")
    else:
        print(f"[add-from-url] {out_path} does not exist — will create it")

    print(f"[add-from-url] fetching {args.url}")
    print("[add-from-url] make sure Cloudflare WARP is connected before continuing")

    t0 = time.time()
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=args.headless,
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

        # Warmup — seeds Akamai cookies for the session
        try:
            page.goto(HOME_URL, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(2_500)
        except PWTimeout:
            print("[add-from-url] warmup timed out — continuing anyway")

        try:
            page.goto(args.url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(PAGE_DWELL_MS)
            html = page.content()
        except PWTimeout:
            print(f"[add-from-url] ✗ timeout fetching page", file=sys.stderr)
            browser.close()
            return 2
        except Exception as e:
            print(f"[add-from-url] ✗ error: {e}", file=sys.stderr)
            browser.close()
            return 2
        finally:
            browser.close()

    print(f"[add-from-url] fetched {len(html):,} bytes in {time.time() - t0:.1f}s")

    if len(html) < 5_000 or "<table" not in html.lower():
        print(f"[add-from-url] ✗ page looks blocked or empty (no <table>). "
              f"Confirm WARP is on and the URL is correct.", file=sys.stderr)
        return 3

    found = extract_contest_ids(html)
    print(f"[add-from-url] extracted {len(found)} contest IDs from page")
    if not found:
        print("[add-from-url] no /contests/<id>/ links found — nothing to add")
        return 1

    added = [cid for cid in found if cid not in existing]
    combined = sorted(existing | set(found), key=lambda x: int(x))
    out_path.write_text("\n".join(combined) + "\n", encoding="utf-8")

    print(f"[add-from-url] new IDs added: {len(added)}")
    for cid in added[:20]:
        print(f"  + {cid}")
    if len(added) > 20:
        print(f"  … and {len(added) - 20} more")
    print(f"[add-from-url] skipped (already in file): {len(found) - len(added)}")
    print(f"[add-from-url] total IDs in {out_path}: {len(combined)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
