"""scrape_via_adspower.py — scrape stats.ncaa.org via Playwright attached
to an already-running AdsPower browser profile over CDP.

AdsPower is a commercial anti-detect browser. Its SunBrowser kernel passes
Akamai Bot Manager's fingerprint detection where vanilla Playwright,
rebrowser-playwright, and nodriver all fail (observed: 10/10 Akamai 403s
across each of those stacks, vs. a clean 200 OK through AdsPower).

Workflow:
    1. User opens the ncaa-scraper profile in the AdsPower GUI (manual).
       AdsPower launches a Chromium with the IPRoyal residential proxy
       baked into its config, and exposes a CDP debug port on localhost.
    2. This script scans for that port, grabs the WebSocket endpoint,
       and attaches Playwright via `connect_over_cdp()`.
    3. Session bootstrap: visit the first contest URL, accept the T&C
       interstitial. Cookies persist in AdsPower's profile context for
       every subsequent fetch — one accept clears the whole run.
    4. Loop through contest IDs, classify + cache using the existing
       helpers from scrape_ncaa_boxscores / scrape_pbp so cache paths
       and progress DB are unchanged.
    5. A resource filter aborts images/fonts/analytics to stretch the
       IPRoyal bandwidth budget.

Usage:
    1. Open AdsPower, click "Open" on the ncaa-scraper profile.
    2. py -X utf8 scripts/scrape_via_adspower.py --mode boxscore \\
          --ids-file scripts/.pbp-build/scoreboard_2026-09-21_to_2026-10-01.txt
    3. py -X utf8 scripts/scrape_via_adspower.py --mode pbp --ids 6586883
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scrape_ncaa_boxscores as box_mod  # noqa: E402
import scrape_pbp as pbp_mod  # noqa: E402

BASE_URL = "https://stats.ncaa.org"
HOMEPAGE_URL = f"{BASE_URL}/contests/livestream_scoreboards"

NAV_TIMEOUT_MS = 60_000
PAGE_DWELL_MS = 2_000
# Fast pacing. Earlier 20-40s was meant to look human and dodge rate
# flags, but data shows the Akamai cascade kicks in at ~10 contests
# regardless of throttle, so the slow pacing was pure wasted time.
# 5-10s still lets each page render fully (NCAA's Rails backend
# occasionally needs a beat) without burning real wall clock.
THROTTLE_MIN_S = 5.0
THROTTLE_MAX_S = 10.0
# Post-accept pause: give the signed stats_terms_accepted cookie a few
# seconds to settle before the next navigation reads it. Shorter waits
# were correlating with T&C re-appearing a few fetches later.
POST_ACCEPT_PAUSE_S = 5.0

# Auto-recovery: when the abort circuit would normally trip, cool down
# instead and try to continue. The strategy exploits IPRoyal's
# lifetime-based rotation: when sticky sessions use `_lifetime-2m`,
# after >2min with no activity the NEXT request from the browser
# auto-rotates to a fresh IPRoyal IP. Combined with clearing all NCAA
# cookies (wipes Akamai's distrust-encoded ak_bmsc + bm_sv), this
# effectively starts a new identity from Akamai's perspective.
BLOCK_RECOVERY_THRESHOLD = 1   # trigger recovery after a single block.
# Observed cascades are clean — when the IP gets flagged, every
# subsequent fetch is 325B until recovery. Waiting for a 2nd confirmation
# block was just 30s of wasted throttle on a known-doomed fetch.
# Fresh contests from clean IPs after T&C flow are ~100KB+; any 323-325B
# response from these endpoints is Akamai, full stop.
RECOVERY_COOLDOWN_S = 180      # 3 min: 2m IPRoyal lifetime + 1m safety.
# REQUIRES the AdsPower profile password to use `_lifetime-2m` modifier
# (not `_lifetime-5m`). If you kept the 5m lifetime, bump this to 360
# or recovery will trigger a new request before IPRoyal rotates.
MAX_RECOVERY_ATTEMPTS = 100    # per run; abort for real after this. The
# observed pattern is ~10-15 contests per Akamai-trust window, so a
# 700-contest run needs ~50-70 recovery cycles in the worst case. 100 is
# enough to run overnight unattended and clear a full backlog in one
# pass, still bounded so a hard-flagged pool doesn't burn credits
# forever.

# Resource types we never need. Aborting these saves 80-90% of per-page
# bandwidth on stats.ncaa.org, extending the IPRoyal budget significantly.
BLOCKED_RESOURCE_TYPES = {"image", "font", "media"}
BLOCKED_URL_SUBSTRINGS = (
    "go-mpulse.net",
    "google-analytics.com",
    "googletagmanager.com",
    "boomerang",
    "akamaihd.net",
    "doubleclick",
    "googlesyndication",
)


# ── CDP endpoint discovery ───────────────────────────────────────────────────

def discover_adspower_cdp(port_hint: int | None = None) -> str:
    """Scan localhost listening ports for a Chrome DevTools endpoint and
    return the WebSocket URL. `port_hint` short-circuits the scan.

    Raises when no endpoint is found — usually means AdsPower's browser
    isn't open yet; user needs to click the profile's Open button."""
    if port_hint:
        return _probe_port(port_hint)

    out = subprocess.run(
        ["netstat", "-ano", "-p", "TCP"],
        capture_output=True, text=True, check=False,
    ).stdout
    candidates: list[int] = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0] == "TCP" and parts[3] == "LISTENING":
            addr = parts[1]
            if ":" in addr:
                try:
                    p = int(addr.rsplit(":", 1)[1])
                    if 1024 <= p <= 65535:
                        candidates.append(p)
                except ValueError:
                    pass

    for port in sorted(set(candidates)):
        try:
            ws = _probe_port(port)
            return ws
        except Exception:
            continue
    raise RuntimeError(
        "No AdsPower CDP endpoint found. Open the ncaa-scraper profile in "
        "AdsPower (click Open) and rerun."
    )


def _probe_port(port: int) -> str:
    with urllib.request.urlopen(
        f"http://127.0.0.1:{port}/json/version", timeout=1.0
    ) as r:
        data = json.loads(r.read())
    browser = data.get("Browser", "")
    ws = data.get("webSocketDebuggerUrl")
    if "Chrome" in browser and ws:
        return ws
    raise RuntimeError(f"port {port} is listening but not Chrome DevTools")


# ── T&C handling ─────────────────────────────────────────────────────────────

def _looks_like_terms_gate(html: str) -> bool:
    if not html:
        return False
    return (
        "Continue to NCAA Statistics" in html
        or 'action="/stats_terms"' in html
    )


TERMS_URL = "https://www.ncaa.org/terms-of-service/"


def _mark_terms_reviewed(page) -> None:
    """NCAA added a server-side check (Oct 2026) requiring evidence the
    user actually opened the Terms of Service page before accepting.

    We mimic what a real user does: click the "Terms and Conditions"
    link, which has target="_blank" so it opens in a new tab. We let
    that tab load (giving Akamai + server-side tracking a chance to
    see it), then close it. The original T&C tab stays untouched the
    entire time — critically, no navigate-away-and-back on the main
    page, which was previously accumulating Akamai bot signal (burned
    us at ~5 detours in).

    Falls back to a direct same-tab navigation if the popup path fails
    (e.g. no terms link on the page)."""
    try:
        with page.context.expect_page(timeout=15_000) as popup_info:
            page.locator('a[href*="terms-of-service"]').first.click(timeout=5_000)
        popup = popup_info.value
        try:
            popup.wait_for_load_state("domcontentloaded", timeout=15_000)
            # Short dwell so any Akamai challenge or server-side session
            # update completes before we close the tab.
            popup.wait_for_timeout(2000)
        finally:
            try:
                popup.close()
            except Exception:
                pass
    except Exception as e:
        print(f"    [T&C] popup detour failed ({str(e)[:80]}), falling back "
              f"to same-tab navigation", flush=True)
        gate_url = page.url
        try:
            page.goto(TERMS_URL, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            page.goto(gate_url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
        except Exception as e2:
            print(f"    [T&C] fallback detour also failed: {str(e2)[:120]}",
                  flush=True)


def _try_submit_terms(page) -> bool:
    """Check the box and submit the form. Returns True if we navigated
    off the terms gate. Common helper used by both the first attempt
    and the post-detour retry."""
    try:
        page.wait_for_selector("#terms_accepted", timeout=10_000)
    except PWTimeout:
        print("    [T&C] checkbox never appeared", flush=True)
        return False
    try:
        page.locator("#terms_accepted").check()
    except Exception as e:
        print(f"    [T&C] checkbox.check() failed: {str(e)[:120]}", flush=True)
        return False
    try:
        page.wait_for_function(
            "() => { const b = document.getElementById('stats-access-button'); return b && !b.disabled; }",
            timeout=10_000,
        )
    except PWTimeout:
        print("    [T&C] submit button never enabled; forcing form submit",
              flush=True)
        try:
            with page.expect_navigation(timeout=NAV_TIMEOUT_MS):
                page.evaluate(
                    "document.querySelector('form[action=\"/stats_terms\"]').submit()"
                )
            page.wait_for_timeout(int(POST_ACCEPT_PAUSE_S * 1000))
            return not _looks_like_terms_gate(page.content())
        except Exception as e:
            print(f"    [T&C] force-submit error: {str(e)[:120]}", flush=True)
            return False
    try:
        with page.expect_navigation(timeout=NAV_TIMEOUT_MS):
            page.locator("#stats-access-button").click()
    except PWTimeout:
        print("    [T&C] click succeeded but no navigation within timeout",
              flush=True)
        return False
    except Exception as e:
        print(f"    [T&C] button click error: {str(e)[:120]}", flush=True)
        return False
    page.wait_for_timeout(int(POST_ACCEPT_PAUSE_S * 1000))
    return not _looks_like_terms_gate(page.content())


def _accept_terms(page) -> bool:
    """Clear the T&C gate. Flow:
      1. Try the normal checkbox→submit path. Works on most mid-session
         re-prompts (server-side flag still valid, cookie just rotating).
      2. If the server bounces us back with "Please review the Terms and
         Conditions", detour to ncaa.org/terms-of-service (sets the
         review flag), then retry the submission once.

    Reactive detour only — proactively visiting ncaa.org on every T&C
    event burns Akamai Bot Manager tolerance on that domain and leaks
    the flag back to stats.ncaa.org."""
    if _try_submit_terms(page):
        return True

    html = page.content()
    if "Please review the Terms and Conditions" in html:
        print("    [T&C] server returned 'please review' error — detouring "
              "to terms page and retrying", flush=True)
        _mark_terms_reviewed(page)
        if _try_submit_terms(page):
            return True
        print("    [T&C] still blocked after review detour + retry",
              flush=True)
        return False

    # Not a "please review" rejection — some other failure path. Log the
    # current state so we can see what's up on next debugging pass.
    print(f"    [T&C] submission failed without 'please review' error "
          f"(url={page.url}, size={len(page.content()):,}B)", flush=True)
    return False


def _bootstrap_session(page, first_cid: str, mode: str) -> bool:
    """Navigate to the first contest URL. If T&C is shown, accept it so
    cookies persist for every later fetch in this session. Returns False
    only if the whole stack is blocked at the Akamai edge (shouldn't
    happen with AdsPower + IPRoyal but we check anyway)."""
    url = _target_url(first_cid, mode)
    print(f"[adspower-scrape] warming session at {url}")
    try:
        page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
    except PWTimeout:
        print("[adspower-scrape] warmup timeout")
        return False
    except Exception as e:
        # HTTP/2 protocol errors, tunnel failures, CDP disconnects, etc.
        # Treat as a soft failure so the caller can trigger recovery
        # instead of crashing the whole run.
        print(f"[adspower-scrape] warmup error: {str(e)[:160]}")
        return False
    page.wait_for_timeout(PAGE_DWELL_MS)
    try:
        html = page.content()
    except Exception as e:
        print(f"[adspower-scrape] warmup content read failed: {str(e)[:160]}")
        return False
    if _looks_like_terms_gate(html):
        print("[adspower-scrape] T&C present — accepting")
        try:
            if not _accept_terms(page):
                print("[adspower-scrape] T&C accept failed")
                return False
        except Exception as e:
            print(f"[adspower-scrape] T&C accept exception: "
                  f"{str(e)[:160]}")
            return False
        print("[adspower-scrape] T&C cleared; session cookies now live")
        return True
    size = len(html)
    if size < 1000:
        print(f"[adspower-scrape] warmup returned {size}B stub — Akamai "
              f"block (unexpected via AdsPower, check proxy session)")
        return False
    print(f"[adspower-scrape] warmup ok ({size:,}B — session may already "
          f"be cleared)")
    return True


# ── Fetch + classify (reuses existing helpers) ───────────────────────────────

def _target_url(cid: str, mode: str) -> str:
    if mode == "boxscore":
        return f"{BASE_URL}/contests/{cid}/individual_stats"
    if mode == "pbp":
        return f"{BASE_URL}/contests/{cid}/play_by_play"
    raise ValueError(f"unknown mode {mode!r}")


def _fetch_one(page, conn, cid: str, mode: str, label: str) -> str:
    url = _target_url(cid, mode)
    print(f"[adspower-scrape] {label} {cid} …", end=" ", flush=True)
    try:
        page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
        page.wait_for_timeout(PAGE_DWELL_MS)
        html = page.content()
    except PWTimeout:
        print("timeout")
        _update_fail(conn, mode, cid, 0, "navigation timeout")
        return "fail"
    except Exception as e:
        err = str(e)[:200]
        print(f"error: {err}")
        _update_fail(conn, mode, cid, 0, err)
        return "fail"

    # If T&C re-appears mid-run (session expired), re-accept and retry.
    if _looks_like_terms_gate(html):
        print("T&C re-appeared, re-accepting", end=" … ", flush=True)
        if _accept_terms(page):
            # Re-fetch the actual URL. Wrap in try/except — this goto
            # has crashed scrapes historically on transient IPRoyal
            # tunnel failures during mid-session rotation. Treat any
            # error as a fetch failure so the main loop keeps moving
            # instead of taking the whole run down.
            try:
                page.goto(url, timeout=NAV_TIMEOUT_MS,
                          wait_until="domcontentloaded")
                page.wait_for_timeout(PAGE_DWELL_MS)
                html = page.content()
            except PWTimeout:
                print("re-fetch timeout")
                _update_fail(conn, mode, cid, 0,
                             "re-fetch timeout after T&C accept")
                return "fail"
            except Exception as e:
                err = str(e)[:200]
                print(f"re-fetch error: {err}")
                _update_fail(conn, mode, cid, 0,
                             f"re-fetch after T&C accept: {err}")
                return "fail"
        else:
            print("accept failed")
            _update_fail(conn, mode, cid, len(html), "T&C re-accept failed")
            return "fail"

    if mode == "boxscore":
        return _classify_box(conn, cid, html)
    return _classify_pbp(conn, cid, html)


def _update_fail(conn, mode, cid, size, msg):
    mod = box_mod if mode == "boxscore" else pbp_mod
    mod.update_status(conn, cid, "fail", size, msg)


def _classify_box(conn, cid, html) -> str:
    if box_mod.is_no_box_score(html):
        print(f"NOT AVAILABLE ({len(html):,} bytes)")
        box_mod.update_status(conn, cid, "empty", len(html),
                              "NCAA: Box score not available")
        return "not_available"
    if box_mod.is_blocked(html):
        status = box_mod._record_block(conn, cid, len(html),
                                       "akamai block via adspower")
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
                                       "akamai block via adspower")
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


# ── Resource filter ──────────────────────────────────────────────────────────

def _attempt_recovery(ctx, page, mode: str, first_cid: str,
                      attempt_num: int) -> bool:
    """Try to recover from a run of Akamai blocks without aborting.

    Steps:
      1. Clear all cookies for ncaa.org / stats.ncaa.org (wipes the
         Akamai distrust state encoded in ak_bmsc + bm_sv).
      2. Sleep RECOVERY_COOLDOWN_S. This is longer than the IPRoyal
         sticky-session lifetime, so the next request from the
         browser rotates to a fresh residential IP automatically.
      3. Probe ipinfo.io to confirm the egress IP changed.
      4. Verify NCAA scoreboard loads cleanly. If still blocked, this
         recovery attempt failed — caller may try again (bounded by
         MAX_RECOVERY_ATTEMPTS) or give up.
      5. Re-run the T&C bootstrap on the first unprocessed contest URL.

    Returns True if recovery succeeded and the main loop can continue.
    Wrapped in a top-level try/except so transient Playwright errors
    (navigation races, tunnel failures) count as "recovery failed" and
    let the main loop try again rather than killing the whole scrape."""
    import time
    print(f"[recovery] attempt {attempt_num}/{MAX_RECOVERY_ATTEMPTS}: "
          f"clearing cookies + {RECOVERY_COOLDOWN_S}s cooldown", flush=True)

    try:
        try:
            for dom in (".ncaa.org", "stats.ncaa.org", ".stats.ncaa.org"):
                try:
                    ctx.clear_cookies(domain=dom)
                except Exception:
                    pass
        except Exception as e:
            print(f"[recovery] cookie clear failed (non-fatal): "
                  f"{str(e)[:100]}", flush=True)

        # Idle sleep; browser makes no requests, so IPRoyal's sticky
        # session expires on its own timer. Next request after this
        # rotates IP.
        time.sleep(RECOVERY_COOLDOWN_S)

        # Probe egress IP via ipinfo (also serves as the "next request"
        # that triggers IPRoyal's lifetime-expiry rotation).
        try:
            page.goto("https://ipinfo.io/json", timeout=NAV_TIMEOUT_MS,
                      wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            body = page.content()
            import re
            m = re.search(r'"ip"\s*:\s*"([^"]+)"', body)
            org_m = re.search(r'"org"\s*:\s*"([^"]+)"', body)
            ip = m.group(1) if m else "?"
            org = (org_m.group(1) if org_m else "?")[:50]
            print(f"[recovery] new egress IP: {ip} ({org})", flush=True)
        except Exception as e:
            print(f"[recovery] IP probe failed: {str(e)[:100]}", flush=True)
            # If the IP probe itself can't connect through the proxy,
            # it means IPRoyal rotation is mid-flight or the tunnel is
            # momentarily broken. Give it a beat before continuing so
            # the next navigation doesn't race against the dangling one.
            try:
                page.wait_for_load_state("domcontentloaded", timeout=5000)
            except Exception:
                pass
            page.wait_for_timeout(2000)

        # Verify NCAA is reachable. Only treat explicit Akamai 403 as a
        # hard failure — small responses are expected on fresh cookies.
        try:
            page.goto(
                "https://stats.ncaa.org/contests/livestream_scoreboards",
                timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded",
            )
            page.wait_for_timeout(PAGE_DWELL_MS)
            html = page.content()
            if "Access Denied" in html and "edgesuite" in html:
                print("[recovery] scoreboard still 403 — new IP also "
                      "flagged", flush=True)
                return False
            print(f"[recovery] scoreboard probe: {len(html):,}B "
                  f"(non-blocking heuristic, bootstrap is the real test)",
                  flush=True)
        except Exception as e:
            print(f"[recovery] scoreboard probe exception (continuing to "
                  f"bootstrap): {str(e)[:100]}", flush=True)
            # Settle any dangling in-flight navigation before bootstrap
            # starts its own goto, else Playwright raises "navigation
            # interrupted by another navigation" and crashes the run.
            try:
                page.wait_for_load_state("domcontentloaded", timeout=5000)
            except Exception:
                pass
            page.wait_for_timeout(2000)

        # Re-bootstrap on the first unprocessed contest (T&C accept
        # again). Real test — if it succeeds, we're genuinely back.
        if not _bootstrap_session(page, first_cid, mode):
            print("[recovery] re-bootstrap failed", flush=True)
            return False

        print("[recovery] success — resuming main loop", flush=True)
        return True

    except Exception as e:
        # Any unhandled exception during recovery — Playwright race,
        # CDP disconnect, whatever. Treat as a failed recovery so the
        # main loop can bail (if budget allows) rather than taking the
        # whole scrape down.
        print(f"[recovery] unhandled exception during recovery: "
              f"{str(e)[:200]}", flush=True)
        return False


def _install_resource_filter(context) -> None:
    """Abort image/font/analytics requests on stats.ncaa.org to stretch
    IPRoyal bandwidth. Leaves www.ncaa.org (and ncaa.org parent)
    completely untouched — those pages run Akamai Bot Manager too and
    need their challenge scripts to execute, otherwise a terms-page
    detour trips the bot flag."""
    def _route(route, request):
        host = request.url.split("/", 3)[2] if "://" in request.url else ""
        if host.endswith("ncaa.org") and not host.endswith("stats.ncaa.org"):
            return route.continue_()
        if request.resource_type in BLOCKED_RESOURCE_TYPES:
            return route.abort()
        if any(s in request.url for s in BLOCKED_URL_SUBSTRINGS):
            return route.abort()
        return route.continue_()
    context.route("**/*", _route)


# ── Orchestrator ─────────────────────────────────────────────────────────────

def run(mode: str, todo: list[str], port_hint: int | None = None) -> None:
    conn = box_mod.init_db() if mode == "boxscore" else pbp_mod.init_db()
    n = len(todo)
    if not n:
        print("[adspower-scrape] nothing to do")
        return

    print(f"[adspower-scrape] mode={mode}  todo={n}")
    ws = discover_adspower_cdp(port_hint=port_hint)
    print(f"[adspower-scrape] attaching to AdsPower CDP: {ws[:80]}...")

    import random
    ok = blocked = empty = failed = not_avail = 0
    recent: list[str] = []
    not_avail_ids: list[str] = []
    aborted = False
    start_ts = time.time()

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(ws)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()
        _install_resource_filter(ctx)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        recovery_attempts = 0
        # Initial bootstrap can fail for benign reasons — a flagged first
        # IP, a transient tunnel error, an HTTP/2 glitch on connect. Try
        # recovery before giving up so the whole run doesn't die at line
        # one.
        if not _bootstrap_session(page, todo[0], mode):
            print("[adspower-scrape] initial bootstrap failed — attempting "
                  "recovery before aborting")
            while recovery_attempts < MAX_RECOVERY_ATTEMPTS:
                recovery_attempts += 1
                if _attempt_recovery(ctx, page, mode, todo[0],
                                     recovery_attempts):
                    break
            else:
                print("[adspower-scrape] all recovery attempts failed on "
                      "initial bootstrap — aborting")
                browser.close()
                return

        i = 0
        while i < n:
            cid = todo[i]
            label = f"[{i+1:>4}/{n}]"
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
            if len(recent) > BLOCK_RECOVERY_THRESHOLD:
                recent.pop(0)

            # Trigger recovery after a run of consecutive blocks instead
            # of hard-aborting. Recovery clears cookies + waits for IPRoyal
            # to rotate IPs, then resumes.
            if (len(recent) == BLOCK_RECOVERY_THRESHOLD
                    and all(r == "blocked" for r in recent)):
                recovery_attempts += 1
                if recovery_attempts > MAX_RECOVERY_ATTEMPTS:
                    print(f"[adspower-scrape] exhausted {MAX_RECOVERY_ATTEMPTS}"
                          f" recovery attempts — aborting")
                    aborted = True
                    break
                # First unprocessed contest to use as bootstrap target
                next_cid = todo[i + 1] if i + 1 < n else cid
                ok_recov = _attempt_recovery(ctx, page, mode, next_cid,
                                             recovery_attempts)
                if not ok_recov:
                    print(f"[adspower-scrape] recovery {recovery_attempts} "
                          f"did not restore access — will try again if "
                          f"budget allows")
                    # Clear the recent-blocks window so we need another
                    # full BLOCK_RECOVERY_THRESHOLD before next recovery
                    # trigger — prevents immediate re-fire on next block.
                    recent.clear()
                    # Still consume throttle before moving on
                    page.wait_for_timeout(
                        int(random.uniform(THROTTLE_MIN_S, THROTTLE_MAX_S)
                            * 1000)
                    )
                    i += 1
                    continue
                # Recovery succeeded — reset the window and continue
                recent.clear()

            if i + 1 < n:
                page.wait_for_timeout(
                    int(random.uniform(THROTTLE_MIN_S, THROTTLE_MAX_S) * 1000)
                )
            i += 1

        # Don't close() — that would kill the AdsPower browser. Just
        # detach. User closes AdsPower manually when done with all runs.

    elapsed = time.time() - start_ts
    print()
    print(f"[adspower-scrape] done in {elapsed:.1f}s "
          f"({elapsed / max(1, n):.1f}s avg)")
    print(f"[adspower-scrape] ok={ok} blocked={blocked} empty={empty} "
          f"not_avail={not_avail} failed={failed} "
          f"{'(aborted)' if aborted else ''}")
    if mode == "boxscore":
        box_mod._print_not_available_report(not_avail_ids)


def _load_ids(args) -> list[str]:
    if args.ids:
        return [s.strip() for s in args.ids.split(",") if s.strip()]
    if args.ids_file:
        return [
            s.strip()
            for s in Path(args.ids_file).read_text(encoding="utf-8").splitlines()
            if s.strip() and not s.startswith("#")
        ]
    raise SystemExit("pass --ids or --ids-file")


def _fetch_and_parse_rpi(url: str, year: int, port_hint: int | None = None
                         ) -> None:
    """Pull the stats.ncaa.org RPI/nitty-gritties page for a season and
    merge the results into both the shipped historical_rpi.json (for the
    frontend) and team_conferences_<year>.json (for the pipeline).

    Reuses the AdsPower CDP + T&C-aware session the main scraper uses,
    so it rides on the same residential proxy + anti-detect setup. One
    page fetch, no cooldowns needed."""
    import json
    import re
    from bs4 import BeautifulSoup

    build_dir = Path("scripts/.pbp-build")
    rpi_cache = build_dir / f"rpi_page_{year}.html"
    team_conf_out = build_dir / f"team_conferences_{year}.json"
    hist_rpi_path = Path("public/data/historical_rpi.json")

    print(f"[rpi] attaching to AdsPower CDP…")
    ws = discover_adspower_cdp(port_hint=port_hint)
    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(ws)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()
        _install_resource_filter(ctx)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        print(f"[rpi] fetching {url}")
        try:
            page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
        except Exception as e:
            print(f"[rpi] fetch error: {str(e)[:200]}")
            return
        page.wait_for_timeout(PAGE_DWELL_MS)
        html = page.content()

        # Clear T&C if present and refetch
        if _looks_like_terms_gate(html):
            print("[rpi] T&C present — accepting")
            if not _accept_terms(page):
                print("[rpi] T&C accept failed, aborting")
                return
            try:
                page.goto(url, timeout=NAV_TIMEOUT_MS,
                          wait_until="domcontentloaded")
                page.wait_for_timeout(PAGE_DWELL_MS)
                html = page.content()
            except Exception as e:
                print(f"[rpi] re-fetch after T&C error: {str(e)[:200]}")
                return

        if len(html) < 5000 or "Access Denied" in html:
            print(f"[rpi] response looks blocked ({len(html)}B)")
            return

        rpi_cache.write_text(html, encoding="utf-8")
        print(f"[rpi] cached HTML to {rpi_cache} ({len(html):,}B)")

    # Parse the HTML
    soup = BeautifulSoup(html, "lxml")
    tables = soup.find_all("table")
    if not tables:
        print("[rpi] ERROR: no <table> in RPI HTML")
        return
    table = tables[0]
    rows = table.find_all("tr")
    header = [c.get_text(strip=True) for c in rows[0].find_all(["th", "td"])]
    try:
        team_idx = header.index("Team")
        conf_idx = header.index("Conference")
        rpi_idx = header.index("Adj.RPIValue")
    except ValueError as e:
        print(f"[rpi] ERROR: expected columns Team/Conference/Adj.RPIValue, "
              f"got {header}")
        return

    AQ_RE = re.compile(r"\s*\(AQ\)\s*$", re.IGNORECASE)
    rpi_map: dict[str, float] = {}
    team_conf: dict[str, str] = {}
    for row in rows[1:]:
        cells = [c.get_text(strip=True) for c in row.find_all(["th", "td"])]
        if len(cells) <= max(team_idx, conf_idx, rpi_idx):
            continue
        team = AQ_RE.sub("", cells[team_idx]).strip()
        conf = cells[conf_idx].strip()
        rpi_raw = cells[rpi_idx].strip()
        if not team:
            continue
        try:
            rpi_val = float(rpi_raw)
        except ValueError:
            continue
        rpi_map[team] = rpi_val
        if conf:
            team_conf[team] = conf

    # Merge into historical_rpi.json
    try:
        existing = json.loads(hist_rpi_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[rpi] ERROR reading {hist_rpi_path}: {e}")
        return
    year_key = str(year)
    prev_count = len(existing.get(year_key, {}))
    existing[year_key] = rpi_map
    hist_rpi_path.write_text(
        json.dumps(existing, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"[rpi] historical_rpi.json '{year_key}': {prev_count} → "
          f"{len(rpi_map)} teams")

    # Write team_conferences
    team_conf_out.write_text(
        json.dumps(team_conf, indent=2, sort_keys=True), encoding="utf-8"
    )
    print(f"[rpi] wrote {team_conf_out} ({len(team_conf)} teams)")

    # Summary
    top10 = sorted(rpi_map.items(), key=lambda x: -x[1])[:10]
    print(f"[rpi] top 10 by Adj.RPIValue:")
    for i, (team, val) in enumerate(top10, 1):
        print(f"  {i:>2}. {team:<30}  {val:.5f}")


def _print_stragglers() -> None:
    """List each contest that's still blocked/abandoned/fail in either DB,
    with the date it was played on and the matchup if we have the
    boxscore HTML cached locally."""
    import re
    import sqlite3

    out_dir = Path("scripts/.pbp-build")
    # Build a reverse index: contest_id -> date, by walking scoreboard files
    date_lookup: dict[str, str] = {}
    for p in out_dir.glob("scoreboard_2026-*.txt"):
        if "to_" in p.name:
            continue  # skip the union file
        date_str = p.stem.replace("scoreboard_", "")
        for cid in p.read_text().splitlines():
            cid = cid.strip()
            if cid:
                date_lookup.setdefault(cid, date_str)

    # Extract matchup from a cached boxscore (looks for <h3 class="tr-head"
    # ...>Team1 vs. Team2</h3>-like patterns in the actual NCAA HTML)
    team_re = re.compile(
        r'<a[^>]+/teams/\d+[^>]*>([^<]+)</a>', re.IGNORECASE
    )
    title_re = re.compile(
        r'<title>\s*([^<]+?)\s*</title>', re.IGNORECASE
    )

    def _lookup_matchup(cid: str) -> str:
        for cache_dir in (box_mod.CACHE_DIR, pbp_mod.CACHE_DIR):
            p = cache_dir / f"{cid}.html"
            if p.exists():
                try:
                    html = p.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    continue
                teams = team_re.findall(html)
                if len(teams) >= 2:
                    # First two /teams/ links are the two competing teams
                    return f"{teams[0].strip()} vs {teams[1].strip()}"
                title = title_re.search(html)
                if title:
                    return title.group(1).strip()
        return "(no cached HTML)"

    for label, mod, todo_name in (
        ("boxscore", box_mod, "catchup_boxscore_todo.txt"),
        ("pbp", pbp_mod, "catchup_pbp_todo.txt"),
    ):
        print(f"=== {label} stragglers ===")
        try:
            conn = mod.init_db()
            todo_path = out_dir / todo_name
            if not todo_path.exists():
                print("  (no todo file)")
                continue
            todo_ids = {x.strip() for x in todo_path.read_text().splitlines()
                        if x.strip()}
            qs = ",".join("?" * len(todo_ids))
            cur = conn.execute(
                f"SELECT contest_id, status, attempts, last_error "
                f"FROM progress "
                f"WHERE contest_id IN ({qs}) "
                f"  AND status IN ('blocked','abandoned','fail','retry') "
                f"ORDER BY contest_id",
                tuple(todo_ids),
            )
            rows = cur.fetchall()
            if not rows:
                print("  (none — all catchup contests resolved)")
            else:
                for cid, status, attempts, err in rows:
                    date = date_lookup.get(cid, "?")
                    matchup = _lookup_matchup(cid)
                    print(f"  {cid}  {date}  {status:>10}  "
                          f"attempts={attempts}  {matchup}")
            conn.close()
        except Exception as e:
            print(f"  status read failed: {e}")
        print()


def _print_status() -> None:
    """Report progress DB counts for both boxscore and PBP, plus the
    size of the current catchup todo files. No scraping, no network —
    just a sanity check from inside the scraper's permission scope."""
    import sqlite3
    for label, mod, todo_name in (
        ("boxscore", box_mod, "catchup_boxscore_todo.txt"),
        ("pbp", pbp_mod, "catchup_pbp_todo.txt"),
    ):
        try:
            conn = mod.init_db()
            cur = conn.execute(
                "SELECT status, COUNT(*) FROM progress GROUP BY status"
            )
            rows = cur.fetchall()
            total = sum(c for _, c in rows)
            print(f"[{label}] all-time total={total}")
            for status, count in sorted(rows, key=lambda r: -r[1]):
                print(f"  {status:>12}  {count:>5}")

            # Compare against the current catchup todo list
            todo_path = Path("scripts/.pbp-build") / todo_name
            if todo_path.exists():
                todo_ids = {x.strip() for x in todo_path.read_text().splitlines()
                            if x.strip()}
                qs = ",".join("?" * len(todo_ids))
                cur = conn.execute(
                    f"SELECT status, COUNT(*) FROM progress "
                    f"WHERE contest_id IN ({qs}) GROUP BY status",
                    tuple(todo_ids),
                )
                todo_rows = {s: c for s, c in cur.fetchall()}
                tracked = sum(todo_rows.values())
                missing = len(todo_ids) - tracked
                done = todo_rows.get("ok", 0) + todo_rows.get("empty", 0)
                need_retry = (todo_rows.get("blocked", 0)
                              + todo_rows.get("abandoned", 0)
                              + todo_rows.get("fail", 0)
                              + todo_rows.get("retry", 0))
                print(f"  catchup-list ({len(todo_ids)} ids): "
                      f"done={done}  needs-retry={need_retry}  "
                      f"never-attempted={missing}")
                if need_retry:
                    detail = ", ".join(f"{s}={todo_rows.get(s,0)}"
                                       for s in ("blocked", "abandoned",
                                                 "fail", "retry")
                                       if todo_rows.get(s, 0))
                    print(f"    retry breakdown: {detail}")
            conn.close()
        except Exception as e:
            print(f"[{label}] status read failed: {e}")
        print()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("boxscore", "pbp"))
    ap.add_argument("--ids-file", type=str)
    ap.add_argument("--ids", type=str, help="Comma-separated contest ids")
    ap.add_argument("--force-ids", type=str,
                    help="Comma-separated contest ids to fetch unconditionally, "
                         "bypassing the already-done filter. Useful for "
                         "targeted retries of contests the DB has marked "
                         "abandoned.")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--port", type=int,
                    help="AdsPower CDP port if auto-discovery is unreliable")
    ap.add_argument("--retry-blocked", action="store_true")
    ap.add_argument("--status", action="store_true",
                    help="Print DB counts for both modes and exit")
    ap.add_argument("--list-stragglers", action="store_true",
                    help="List remaining unresolved contests with their "
                         "date and matchup where cached")
    ap.add_argument("--rpi-url", type=str,
                    help="Fetch this stats.ncaa.org RPI/nitty-gritties URL "
                         "via AdsPower, parse it, and merge the results into "
                         "historical_rpi.json + team_conferences_<year>.json. "
                         "Requires --year.")
    ap.add_argument("--year", type=int,
                    help="Season year for --rpi-url (e.g. 2026)")
    args = ap.parse_args()

    if args.status:
        _print_status()
        return
    if args.list_stragglers:
        _print_stragglers()
        return
    if args.rpi_url:
        if not args.year:
            raise SystemExit("--rpi-url requires --year")
        _fetch_and_parse_rpi(args.rpi_url, args.year, port_hint=args.port)
        return
    if not args.mode:
        raise SystemExit("--mode is required unless --status, "
                         "--list-stragglers, or --rpi-url is set")

    # --force-ids: targeted retry that bypasses the done filter. Also
    # resets any 'abandoned' DB rows for these ids so the recovery
    # cascade logic doesn't bail early.
    force_ids: list[str] = []
    if args.force_ids:
        force_ids = [s.strip() for s in args.force_ids.split(",") if s.strip()]
        import sqlite3
        db_path = (box_mod.DB_PATH if args.mode == "boxscore"
                   else pbp_mod.DB_PATH)
        with sqlite3.connect(db_path) as conn:
            qs = ",".join("?" * len(force_ids))
            n = conn.execute(
                f"DELETE FROM progress WHERE contest_id IN ({qs})",
                tuple(force_ids),
            ).rowcount
            conn.commit()
        print(f"[adspower-scrape] --force-ids: reset {n} DB rows for "
              f"{len(force_ids)} id(s): {','.join(force_ids)}")

    all_ids = _load_ids(args) if (args.ids or args.ids_file) else []
    all_ids = list(dict.fromkeys(force_ids + all_ids))  # force-ids first, dedupe

    conn = box_mod.init_db() if args.mode == "boxscore" else pbp_mod.init_db()
    done = (box_mod.already_done_ids(conn) if args.mode == "boxscore"
            else pbp_mod.already_done_ids(conn))
    conn.close()
    # force-ids are exempt from the done filter (we just reset them above
    # anyway, but belt-and-suspenders)
    force_set = set(force_ids)
    todo = [cid for cid in all_ids if cid in force_set or cid not in done]
    if args.limit:
        todo = todo[: args.limit]

    if not todo:
        raise SystemExit("no ids to fetch — pass --ids, --ids-file, or "
                         "--force-ids")

    print(f"[adspower-scrape] {len(all_ids)} ids total, "
          f"{len(all_ids) - len(todo)} already done, {len(todo)} to fetch")
    run(args.mode, todo, port_hint=args.port)


if __name__ == "__main__":
    main()
