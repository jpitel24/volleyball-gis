"""
probe_pbp.py — Phase-1 probe (escalated v2).

Hard-block escalation path: stealth patches + session warmup + Edge channel.

Changes from v1:
  - playwright-stealth applied to the page (~30 fingerprint patches that
    cover the rest of the headless-detection signals plain Playwright
    leaks).
  - Session warmup: visit stats.ncaa.org homepage first, dwell, click
    into a team page, dwell, THEN navigate to the PBP URL. Cold-hitting
    deep URLs is itself a bot tell.
  - Edge channel: launches your installed Microsoft Edge instead of
    the Playwright-bundled Chromium. Edge's JA3 fingerprint differs
    enough from vanilla Chromium that some Akamai rules don't catch it.
    Toggle USE_EDGE = False to fall back to bundled Chromium.

Outputs into scripts/.pbp-cache/ — same files as before.

IMPORTANT: don't run repeatedly while blocked. Each denied request
can extend the IP cooldown. If the first run after this rewrite still
fails, wait at least 30 minutes before the next attempt — or switch
networks (e.g. phone hotspot) to use a fresh IP.

Usage:
    py -X utf8 scripts/probe_pbp.py [contest_id]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# playwright-stealth 2.x uses a Stealth() class. Older 1.x used a
# stealth_sync() function. Try both so the script works either way.
HAVE_STEALTH = False
_stealth_apply = None
try:
    from playwright_stealth import Stealth as _StealthCls   # 2.x
    _stealth_obj = _StealthCls()
    def _stealth_apply(page):
        _stealth_obj.apply_stealth_sync(page)
    HAVE_STEALTH = True
except (ImportError, AttributeError):
    try:
        from playwright_stealth import stealth_sync as _legacy_stealth  # 1.x
        def _stealth_apply(page):
            _legacy_stealth(page)
        HAVE_STEALTH = True
    except ImportError:
        pass

CACHE_DIR = Path("scripts/.pbp-cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

HEADLESS    = False
USE_EDGE    = True       # flip to False to use Playwright's bundled Chromium
TIMEOUT_MS  = 60_000
WAIT_AFTER  = 4_000
DWELL_MS    = 2_500      # human-like pause between page transitions

UA_EDGE = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
)
UA_CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

AKAMAI_COOKIES = {"_abck", "bm_sz", "bm_sv", "ak_bmsc", "bm_mi"}


def probe(contest_id: int) -> None:
    home_url    = "https://stats.ncaa.org/"
    sport_url   = "https://stats.ncaa.org/rankings/national_ranking?academic_year=2025&division=1&sport_code=WVB"
    pbp_url     = f"https://stats.ncaa.org/contests/{contest_id}/play_by_play"
    out_html    = CACHE_DIR / f"{contest_id}.html"
    out_png     = CACHE_DIR / f"{contest_id}.png"
    out_cookies = CACHE_DIR / f"{contest_id}.cookies.json"

    if not HAVE_STEALTH:
        print("[probe] playwright-stealth not installed — running without "
              "stealth patches. Install with: py -m pip install playwright-stealth")

    with sync_playwright() as p:
        launch_kwargs = {
            "headless": HEADLESS,
            "args": ["--disable-blink-features=AutomationControlled"],
        }
        if USE_EDGE:
            launch_kwargs["channel"] = "msedge"
            print("[probe] launching Microsoft Edge (msedge channel)")
        else:
            print("[probe] launching bundled Chromium")

        browser = p.chromium.launch(**launch_kwargs)
        context = browser.new_context(
            user_agent=UA_EDGE if USE_EDGE else UA_CHROME,
            viewport={"width": 1366, "height": 900},
            locale="en-US",
            timezone_id="America/Chicago",
        )
        context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
        )

        page = context.new_page()
        if HAVE_STEALTH:
            _stealth_apply(page)
            print("[probe] stealth patches applied")
        else:
            print("[probe] WARNING: stealth not loaded — install playwright-stealth")

        # ── 1. Warmup: homepage ────────────────────────────────────────
        print(f"[probe] warmup → {home_url}")
        try:
            page.goto(home_url, timeout=TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(DWELL_MS)
        except PWTimeout:
            print("[probe] homepage navigation timed out — continuing anyway")

        # Capture early Akamai cookies state for the run summary.
        early = {c["name"] for c in context.cookies()}
        print(f"[probe] cookies after homepage: {sorted(early)}")

        # ── 2. Warmup: a real volleyball ranking page ──────────────────
        print(f"[probe] warmup → {sport_url}")
        try:
            page.goto(sport_url, timeout=TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(DWELL_MS)
        except PWTimeout:
            print("[probe] sport page navigation timed out — continuing anyway")

        # ── 3. The actual target ───────────────────────────────────────
        print(f"[probe] target  → {pbp_url}")
        try:
            page.goto(pbp_url, timeout=TIMEOUT_MS, wait_until="domcontentloaded")
        except PWTimeout:
            print("[probe] PBP navigation timed out")

        page.wait_for_timeout(WAIT_AFTER)
        try:
            page.wait_for_selector("table", timeout=TIMEOUT_MS)
            print("[probe] saw a <table> — likely PBP rendered")
        except PWTimeout:
            print("[probe] no <table> after wait — capturing whatever's there")

        html = page.content()
        out_html.write_text(html, encoding="utf-8")
        page.screenshot(path=str(out_png), full_page=True)
        cookies = context.cookies()
        out_cookies.write_text(json.dumps(cookies, indent=2), encoding="utf-8")

        print(f"[probe] wrote {out_html}    ({len(html):,} bytes)")
        print(f"[probe] wrote {out_png}")
        print(f"[probe] wrote {out_cookies} ({len(cookies)} cookies)")
        print()
        print("[probe] Akamai cookies after PBP load:")
        seen_any = False
        for c in cookies:
            if c["name"] in AKAMAI_COOKIES:
                seen_any = True
                v = c["value"]
                snippet = v[:60] + ("…" if len(v) > 60 else "")
                print(f"        {c['name']:<10} = {snippet}")
        if not seen_any:
            print("        (none — block still active)")

        browser.close()


if __name__ == "__main__":
    cid = int(sys.argv[1]) if len(sys.argv) > 1 else 6479076
    probe(cid)
