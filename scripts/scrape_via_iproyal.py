"""scrape_via_iproyal.py — Playwright + IPRoyal residential proxy scraper.

Replaces the Crawlbase transport with our own headless Chromium running
through a sticky-session US residential IP from IPRoyal. The real browser
means we can click through the /stats_terms interstitial ourselves — the
one thing Crawlbase couldn't do from a datacenter IP.

Flow:
  1. Pick a sticky-session US residential IP via scripts/_iproyal.py
  2. Launch Chromium with that proxy, one persistent BrowserContext
  3. Open stats.ncaa.org; if we land on /stats_terms, check the box and
     submit — session cookies now carry through the whole run
  4. Iterate contest IDs, fetch each page, feed the HTML through the
     existing classify/persist pipeline (reused from scrape_ncaa_boxscores
     and scrape_pbp), so cache paths and progress DBs are unchanged
  5. Resource filter aborts images/fonts/analytics so we don't burn
     IPRoyal bandwidth on things we never parse

Usage:
    py -X utf8 scripts/scrape_via_iproyal.py --mode boxscore \\
        --ids-file scripts/.pbp-build/scoreboard_2026-09-21_to_2026-10-01.txt

    py -X utf8 scripts/scrape_via_iproyal.py --mode pbp \\
        --ids 6593828,6625673 --headful
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _iproyal import establish_us_session  # noqa: E402

# Reuse classification + persistence helpers from the existing scrapers so
# we don't fork the schema or cache layout.
import scrape_ncaa_boxscores as box_mod  # noqa: E402
import scrape_pbp as pbp_mod  # noqa: E402

BASE_URL = "https://stats.ncaa.org"
# The scoreboard page is public (no T&C gate), so warming on it leaves
# the session uncleared when we then navigate to a /contests/{id}/* page.
# Warming on the first contest URL in the todo list means we hit T&C once,
# accept it, and every subsequent fetch rides the cleared session.

# Human-ish pacing. The Playwright session is one real browser making
# sequential navigations — too fast looks robotic, too slow burns time.
THROTTLE_MIN_S = 3.0
THROTTLE_MAX_S = 7.0

NAV_TIMEOUT_MS = 60_000
PAGE_DWELL_MS = 2_000

# Resource types we never need for stats-table extraction. Blocking these
# at the Playwright request-interception layer trims per-page bandwidth
# from ~1-2 MB down to ~100-200 KB.
BLOCKED_RESOURCE_TYPES = {"image", "font", "media", "stylesheet"}
BLOCKED_URL_SUBSTRINGS = (
    "go-mpulse.net",
    "google-analytics.com",
    "googletagmanager.com",
    "boomerang",
    "akamaihd.net",  # Akamai telemetry — not needed for page content
    "doubleclick",
    "googlesyndication",
)


# ── Session bootstrap ────────────────────────────────────────────────────────

def _looks_like_terms_gate(html: str) -> bool:
    """Match on the two most stable strings on NCAA's /stats_terms page."""
    if not html:
        return False
    return (
        "Continue to NCAA Statistics" in html
        or 'action="/stats_terms"' in html
    )


def _accept_terms(page) -> bool:
    """Check the T&C box and submit, waiting for the redirect. Returns
    True on success (page is now past the gate), False if we couldn't
    find the form or the submit didn't clear the gate."""
    try:
        page.wait_for_selector("#terms_accepted", timeout=10_000)
    except PWTimeout:
        return False
    page.check("#terms_accepted")
    # The button is disabled until the checkbox's change handler flips
    # it, which happens synchronously on .check(). Wait a tick to be safe.
    page.wait_for_timeout(300)
    try:
        with page.expect_navigation(timeout=NAV_TIMEOUT_MS):
            page.click("#stats-access-button")
    except PWTimeout:
        return False
    # After the redirect we should be on the originally-requested URL (or
    # the fallback /). Verify we're no longer looking at the gate.
    return not _looks_like_terms_gate(page.content())


def _bootstrap_session(page, first_cid: str, mode: str) -> bool:
    """Two-step warmup to look like a real user browsing the site:

    1. Visit the site homepage/scoreboard (public, no T&C gate). This
       establishes Akamai Bot Manager cookies (`ak_bmsc`, `bm_sv`) and
       gives subsequent requests a legitimate same-origin referer.
    2. Navigate to the first contest URL — this is where the T&C gate
       actually appears. Accept it if present.

    Direct deep-GETs with no prior browsing history look scripted to
    Akamai even from a residential IP, so skipping step 1 reliably
    trips the deny-stub response."""
    homepage = f"{BASE_URL}/contests/livestream_scoreboards"
    print(f"[iproyal-scrape] step 1: homepage warmup at {homepage}")
    try:
        page.goto(homepage, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
    except PWTimeout:
        print("[iproyal-scrape] homepage warmup timeout")
        return False
    page.wait_for_timeout(PAGE_DWELL_MS)
    size0 = len(page.content())
    if size0 < 1000:
        print(f"[iproyal-scrape] homepage returned {size0}B stub — "
              f"this proxy IP is burned at Akamai edge, rotate session")
        return False
    print(f"[iproyal-scrape] homepage ok ({size0:,}B)")

    contest_url = _target_url(first_cid, mode)
    print(f"[iproyal-scrape] step 2: contest warmup at {contest_url}")
    try:
        page.goto(contest_url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
    except PWTimeout:
        print("[iproyal-scrape] contest warmup timeout")
        return False
    page.wait_for_timeout(PAGE_DWELL_MS)
    html = page.content()
    if _looks_like_terms_gate(html):
        print("[iproyal-scrape] T&C gate present — accepting")
        if not _accept_terms(page):
            raise RuntimeError("T&C acceptance did not clear the gate")
        print("[iproyal-scrape] T&C cleared; session cookies now live")
        return True
    size = len(html)
    if size < 1000:
        print(f"[iproyal-scrape] contest warmup returned {size}B stub — "
              f"Akamai blocked the deep GET even after homepage warmup")
        return False
    print(f"[iproyal-scrape] contest warmup ok ({size:,}B — no T&C gate "
          f"shown, session may already be cleared)")
    return True


# ── Fetch loop ───────────────────────────────────────────────────────────────

def _target_url(cid: str, mode: str) -> str:
    if mode == "boxscore":
        return f"{BASE_URL}/contests/{cid}/individual_stats"
    if mode == "pbp":
        return f"{BASE_URL}/contests/{cid}/play_by_play"
    raise ValueError(f"unknown mode {mode!r}")


def _fetch_one(page, conn: sqlite3.Connection, cid: str, mode: str,
               label: str) -> str:
    """Navigate to one page, classify, persist. Returns the status string
    the caller uses for the abort-circuit tracking."""
    url = _target_url(cid, mode)
    print(f"[iproyal-scrape] {label} {cid} …", end=" ", flush=True)
    try:
        page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
        page.wait_for_timeout(PAGE_DWELL_MS)
        html = page.content()
    except PWTimeout:
        print("timeout")
        if mode == "boxscore":
            box_mod.update_status(conn, cid, "fail", 0, "navigation timeout")
        else:
            pbp_mod.update_status(conn, cid, "fail", 0, "navigation timeout")
        return "fail"
    except Exception as e:
        err = str(e)[:200]
        print(f"error: {err}")
        if mode == "boxscore":
            box_mod.update_status(conn, cid, "fail", 0, err)
        else:
            pbp_mod.update_status(conn, cid, "fail", 0, err)
        return "fail"

    # Session cookies can drop mid-run (rare but possible). If we see T&C
    # again, re-accept and retry the same URL once.
    if _looks_like_terms_gate(html):
        print("T&C re-appeared, re-accepting", end=" … ", flush=True)
        if _accept_terms(page):
            page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(PAGE_DWELL_MS)
            html = page.content()
        else:
            print("accept failed")
            if mode == "boxscore":
                box_mod.update_status(conn, cid, "fail", len(html), "T&C re-accept failed")
            else:
                pbp_mod.update_status(conn, cid, "fail", len(html), "T&C re-accept failed")
            return "fail"

    if mode == "boxscore":
        return _classify_box(conn, cid, html)
    return _classify_pbp(conn, cid, html)


def _classify_box(conn, cid, html) -> str:
    if box_mod.is_no_box_score(html):
        print(f"NOT AVAILABLE ({len(html):,} bytes)")
        box_mod.update_status(conn, cid, "empty", len(html),
                              "NCAA: Box score not available")
        return "not_available"
    if box_mod.is_blocked(html):
        status = box_mod._record_block(conn, cid, len(html),
                                       "akamai block via iproyal")
        print(f"{'ABANDONED' if status == 'abandoned' else 'BLOCKED'} "
              f"({len(html):,} bytes)")
        return status
    if not box_mod.has_roster_table(html):
        print(f"EMPTY ({len(html):,} bytes) — no roster table")
        box_mod.update_status(conn, cid, "empty", len(html),
                              "no roster table (individual_stats not published)")
        return "empty"
    cache_path = box_mod.CACHE_DIR / f"{cid}.html"
    if not box_mod.safe_write_text(cache_path, html):
        print(f"WRITE-LOCKED ({len(html):,} bytes)")
        box_mod.update_status(conn, cid, "fail", len(html), "OneDrive lock on write")
        return "fail"
    print(f"ok ({len(html):,} bytes)")
    box_mod.update_status(conn, cid, "ok", len(html))
    return "ok"


def _classify_pbp(conn, cid, html) -> str:
    if pbp_mod.is_blocked(html):
        status = pbp_mod._record_block(conn, cid, len(html),
                                       "akamai block via iproyal")
        print(f"{'ABANDONED' if status == 'abandoned' else 'BLOCKED'} "
              f"({len(html):,} bytes)")
        return status
    if not pbp_mod.has_pbp_table(html):
        print(f"EMPTY ({len(html):,} bytes) — no PBP table")
        pbp_mod.update_status(conn, cid, "empty", len(html),
                              "no <table> in page (PBP not recorded)")
        return "empty"
    cache_path = pbp_mod.CACHE_DIR / f"{cid}.html"
    if not pbp_mod.safe_write_text(cache_path, html):
        print(f"WRITE-LOCKED ({len(html):,} bytes)")
        pbp_mod.update_status(conn, cid, "fail", len(html), "OneDrive lock on write")
        return "fail"
    print(f"ok ({len(html):,} bytes)")
    pbp_mod.update_status(conn, cid, "ok", len(html))
    return "ok"


# ── Resource interception (bandwidth saver) ──────────────────────────────────

def _install_resource_filter(context) -> None:
    """Abort requests for assets we never parse (images, fonts, analytics
    beacons). Drops per-page bandwidth ~90% on stats.ncaa.org."""
    def _route(route, request):
        if request.resource_type in BLOCKED_RESOURCE_TYPES:
            return route.abort()
        if any(s in request.url for s in BLOCKED_URL_SUBSTRINGS):
            return route.abort()
        return route.continue_()
    context.route("**/*", _route)


# ── Orchestrator ─────────────────────────────────────────────────────────────

def run(mode: str, todo: list[str], headful: bool = False) -> None:
    conn = box_mod.init_db() if mode == "boxscore" else pbp_mod.init_db()
    n = len(todo)
    if not n:
        print("[iproyal-scrape] nothing to do")
        return

    print(f"[iproyal-scrape] mode={mode}  todo={n}")
    proxy, info = establish_us_session()
    print(f"[iproyal-scrape] egress ip: {info.get('ip')} "
          f"({info.get('city')}, {info.get('region')})")

    import random
    ok = blocked = empty = failed = not_avail = 0
    recent: list[str] = []
    not_avail_ids: list[str] = []
    aborted = False
    start_ts = time.time()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not headful, proxy=proxy)
        context = browser.new_context(
            user_agent=box_mod.USER_AGENT_EDGE,
            viewport={"width": 1366, "height": 820},
        )
        _install_resource_filter(context)
        page = context.new_page()

        try:
            booted = _bootstrap_session(page, todo[0], mode)
        except Exception as e:
            print(f"[iproyal-scrape] session bootstrap failed: {e}")
            browser.close()
            return
        if not booted:
            print(f"[iproyal-scrape] bootstrap landed on a block — aborting "
                  f"before burning more requests")
            browser.close()
            return

        # The main loop will re-fetch todo[0]; Playwright reuses the HTTP
        # cache so the redundant navigation is near-free, and classifying
        # inline keeps the counter accounting simple.
        for i, cid in enumerate(todo, 1):
            label = f"[{i:>4}/{n}]"
            result = _fetch_one(page, conn, cid, mode, label)
            if result == "ok":
                ok += 1
            elif result in ("blocked", "abandoned"):
                blocked += 1
            elif result == "empty":
                empty += 1
            elif result == "not_available":
                not_avail += 1
                not_avail_ids.append(cid)
            else:
                failed += 1

            recent.append("blocked" if result == "abandoned" else result)
            if len(recent) > box_mod.ABORT_AFTER_BLOCK:
                recent.pop(0)
            if (len(recent) == box_mod.ABORT_AFTER_BLOCK
                    and all(r == "blocked" for r in recent)):
                print(f"[iproyal-scrape] {box_mod.ABORT_AFTER_BLOCK} consecutive "
                      f"blocks — aborting")
                aborted = True
                break

            if i < n:
                page.wait_for_timeout(
                    int(random.uniform(THROTTLE_MIN_S, THROTTLE_MAX_S) * 1000)
                )

        browser.close()

    elapsed = time.time() - start_ts
    print()
    print(f"[iproyal-scrape] done in {elapsed:.1f}s "
          f"({elapsed / max(1, n):.1f}s avg)")
    print(f"[iproyal-scrape] results: ok={ok} blocked={blocked} empty={empty} "
          f"not_avail={not_avail} failed={failed} "
          f"{'(aborted)' if aborted else ''}")
    if mode == "boxscore":
        box_mod._print_not_available_report(not_avail_ids)


def _load_ids(args) -> list[str]:
    if args.ids:
        return [s.strip() for s in args.ids.split(",") if s.strip()]
    if args.ids_file:
        return [
            s.strip() for s in Path(args.ids_file).read_text(encoding="utf-8").splitlines()
            if s.strip() and not s.startswith("#")
        ]
    raise SystemExit("pass --ids or --ids-file")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("boxscore", "pbp"), required=True)
    ap.add_argument("--ids-file", type=str, help="File with one contest id per line")
    ap.add_argument("--ids", type=str, help="Comma-separated contest ids")
    ap.add_argument("--limit", type=int, help="Only process the first N ids")
    ap.add_argument("--headful", action="store_true",
                    help="Run Chromium with a visible window (debugging)")
    ap.add_argument("--retry-blocked", action="store_true",
                    help="Include contests previously marked 'blocked'")
    args = ap.parse_args()

    all_ids = _load_ids(args)

    # Skip already-complete contests unless --retry-blocked was passed.
    conn = box_mod.init_db() if args.mode == "boxscore" else pbp_mod.init_db()
    done = (box_mod.already_done_ids(conn) if args.mode == "boxscore"
            else pbp_mod.already_done_ids(conn))
    conn.close()
    if args.retry_blocked:
        # Only skip ok/empty/not_available/abandoned; let 'blocked' through
        pass  # already_done_ids excludes 'blocked' by design
    todo = [cid for cid in all_ids if cid not in done]
    if args.limit:
        todo = todo[: args.limit]

    print(f"[iproyal-scrape] {len(all_ids)} ids total, {len(all_ids) - len(todo)} "
          f"already done, {len(todo)} to fetch")
    run(args.mode, todo, headful=args.headful)


if __name__ == "__main__":
    main()
