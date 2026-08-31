"""
scrape_ncaa_boxscores.py

Scrape stats.ncaa.org's per-contest individual_stats pages through
Playwright + Edge + WARP. Modeled directly on scrape_pbp.py — same
architecture: SQLite progress tracker, incremental (skips cached),
anti-abort circuit for genuine Akamai blocks vs. legit empty pages.

The individual_stats page contains BOTH teams' player-match stats
(unlike the R ncaavolleyballr `group_stats` which is one-sided).
Column headers already match our shipped CSV schema — no post-parse
mapping needed.

Reads contest IDs from `scripts/.pbp-build/contest_ids_<year>.txt`
(same file discover_pbp_ids.py emits and scrape_pbp.py consumes),
so once discover has run we can scrape both PBP and box scores off
the same ID list.

Cached HTML → `scripts/.boxscore-cache/<contest_id>.html`.
Progress DB → `scripts/.boxscore-cache/_progress.sqlite`.

Usage:
    py -X utf8 scripts/scrape_ncaa_boxscores.py --year 2026 \\
        --ids-file scripts/.pbp-build/contest_ids_2026.txt

    # Re-attempt previously blocked contests:
    py -X utf8 scripts/scrape_ncaa_boxscores.py --year 2026 \\
        --ids-file scripts/.pbp-build/contest_ids_2026.txt --retry-blocked
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright


def _load_fresh_cookie_state(path: Path, max_age_min: int) -> str | None:
    """Return the persisted storage_state path if a valid ak_bmsc cookie
    is present and the file is recent. Lets the boxscore scraper skip
    the cold warmup when the PBP scraper (or a previous boxscore run)
    already earned a session."""
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        cookies = raw.get("cookies", [])
        if not any(c.get("name") == "ak_bmsc" for c in cookies):
            return None
        age_s = time.time() - path.stat().st_mtime
        if age_s > max_age_min * 60:
            print(f"[boxscrape] persisted cookies are {age_s/60:.0f}min old — "
                  "discarding, will re-warmup")
            return None
        return str(path)
    except Exception as e:
        print(f"[boxscrape] cookie load failed (non-fatal): {e}")
        return None

# ── Paths / config ────────────────────────────────────────────────────────────

CACHE_DIR = Path("scripts/.boxscore-cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH   = CACHE_DIR / "_progress.sqlite"

BUILD_DIR = Path("scripts/.pbp-build")

BASE_URL  = "https://stats.ncaa.org"
HOME_URL  = "https://stats.ncaa.org/"

# Tuning
NAV_TIMEOUT_MS      = 60_000
PAGE_DWELL_MS       = 2_500
MIN_VALID_SIZE      = 1_000     # below this, response is an Akamai stub
ABORT_AFTER_BLOCK   = 3
WARMUP_TIMEOUT_MS   = 30_000
# Randomized inter-request throttle. The scraper had NO throttle before,
# so 200 fetches went out ~as-fast-as-the-page-loads — 4-5s apart, all
# from one IP, in monotonic ID order. That's the exact signature Akamai
# blocks. Widening the gap and randomizing it makes each session look
# more like a human clicking through matches.
THROTTLE_MIN_S      = 6.0
THROTTLE_MAX_S      = 14.0
# Persist Akamai cookies across runs so we can skip the cold warmup and
# reuse whatever session scrape_pbp.py just earned. Path matches PBP
# scraper's so both scripts share the same jar.
COOKIE_STATE_PATH   = Path("scripts/.pbp-build/scraper_cookies.json")
COOKIE_MAX_AGE_MIN  = 60

USER_AGENT_EDGE = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
)

# ── Progress DB ───────────────────────────────────────────────────────────────

def init_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS progress (
            contest_id TEXT PRIMARY KEY,
            status     TEXT,
            size       INTEGER,
            attempts   INTEGER DEFAULT 0,
            last_error TEXT,
            last_ts    TEXT
        )
    """)
    conn.commit()
    return conn


def already_done_ids(conn: sqlite3.Connection) -> set[str]:
    # 'empty' status covers contests whose individual_stats page NCAA has
    # explicitly served as "Box score not available." Those never change
    # after publish, so skip them permanently — otherwise a stalled
    # scoretaker's page burns 2 Crawlbase credits per refresh forever.
    # Use --retry-empty to force a re-check for a specific contest.
    cur = conn.execute("SELECT contest_id FROM progress WHERE status IN ('ok', 'empty')")
    return {row[0] for row in cur.fetchall()}


def update_status(conn: sqlite3.Connection, cid: str, status: str,
                  size: int = 0, err: str | None = None) -> None:
    conn.execute("""
        INSERT INTO progress (contest_id, status, size, attempts, last_error, last_ts)
        VALUES (?, ?, ?, 1, ?, datetime('now'))
        ON CONFLICT(contest_id) DO UPDATE SET
            status     = excluded.status,
            size       = excluded.size,
            attempts   = progress.attempts + 1,
            last_error = excluded.last_error,
            last_ts    = excluded.last_ts
    """, (cid, status, size, err))
    conn.commit()

# ── Content classification ────────────────────────────────────────────────────

def _print_not_available_report(ids: list[str]) -> None:
    """Print the list of contests NCAA reported as 'Box score not available'
    in this run. These are permanently marked 'empty' in the DB so they
    won't burn scrape credits on future runs, but calling them out here
    makes it easy to see at a glance what data we're missing today and
    to spot-check them manually on stats.ncaa.org if needed."""
    if not ids:
        return
    print(f"[boxscrape] {len(ids)} contest(s) returned "
          f"'Box score not available' this run:")
    for cid in ids:
        print(f"          {cid}   https://stats.ncaa.org/contests/{cid}/individual_stats")
    print(f"[boxscrape] these will not be retried automatically — "
          f"use --retry-empty if a scoretaker uploads late")


def is_no_box_score(html: str) -> bool:
    """True when NCAA explicitly serves 'Box score not available' — a tiny
    stub page (~170-330 bytes) that means the scoretaker never uploaded
    stats for this contest. Permanent state; classify as 'empty' rather
    than 'blocked' so we don't retry it every day and don't trip the
    consecutive-block abort circuit."""
    if not html:
        return False
    return "box score not available" in html.lower()


def is_blocked(html: str) -> bool:
    """True only for genuine Akamai/WARP blocks — tiny stub or denial text.
    Callers should check is_no_box_score() first, since NCAA's not-available
    stub is also tiny and would false-positive here."""
    if not html or len(html) < MIN_VALID_SIZE:
        return True
    low = html.lower()
    if "access denied" in low and "errors.edgesuite.net" in low:
        return True
    return False


def has_roster_table(html: str) -> bool:
    """A real individual_stats page contains at least one table with the
    'Kills' + 'Assists' + 'Digs' column headers. Some contests exist but
    have no box score published — those pages are still valid HTML but
    lack the roster tables; we mark them 'empty' rather than 'blocked' so
    the abort circuit doesn't trip."""
    low = html.lower()
    if "<table" not in low:
        return False
    # All three markers must be present; individual columns can appear
    # in nav/other tables so requiring the trio is a solid roster signal.
    return ("kills" in low and "assists" in low and "digs" in low)


# ── Fetch loop ────────────────────────────────────────────────────────────────

def safe_write_text(path: Path, content: str, retries: int = 5,
                    delay: float = 0.4) -> bool:
    """OneDrive can lock files briefly during sync — retry a few times."""
    for _ in range(retries):
        try:
            path.write_text(content, encoding="utf-8")
            return True
        except (PermissionError, OSError):
            time.sleep(delay)
    return False


def fetch_one(page, conn: sqlite3.Connection, cid: str,
              idx: int, total: int) -> str:
    """Returns 'ok' | 'blocked' | 'empty' | 'not_available' | 'fail'.
    'not_available' is a distinct return code so callers can list the
    affected contest IDs at end-of-run; DB status is still 'empty' so
    they're skipped on future runs."""
    url = f"{BASE_URL}/contests/{cid}/individual_stats"
    cache_path = CACHE_DIR / f"{cid}.html"
    print(f"[boxscrape] [{idx:>4}/{total}] {cid} …", end=" ", flush=True)
    try:
        page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
        page.wait_for_timeout(PAGE_DWELL_MS)
        html = page.content()
    except PWTimeout:
        print("timeout")
        update_status(conn, cid, "fail", 0, "navigation timeout")
        return "fail"
    except Exception as e:
        err = str(e)[:200]
        print(f"error: {err}")
        update_status(conn, cid, "fail", 0, err)
        return "fail"

    if is_no_box_score(html):
        print(f"NOT AVAILABLE ({len(html):,} bytes)")
        update_status(conn, cid, "empty", len(html),
                      "NCAA: Box score not available")
        return "not_available"

    if is_blocked(html):
        print(f"BLOCKED ({len(html):,} bytes)")
        update_status(conn, cid, "blocked", len(html), "akamai block")
        return "blocked"

    if not has_roster_table(html):
        print(f"EMPTY ({len(html):,} bytes) — no roster table")
        update_status(conn, cid, "empty", len(html),
                      "no roster table (individual_stats not published)")
        return "empty"

    if not safe_write_text(cache_path, html):
        print(f"WRITE-LOCKED ({len(html):,} bytes)")
        update_status(conn, cid, "fail", len(html), "OneDrive lock on write")
        return "fail"
    print(f"ok ({len(html):,} bytes)")
    update_status(conn, cid, "ok", len(html))
    return "ok"


# ── Crawlbase transport ──────────────────────────────────────────────────────
#
# When CRAWLBASE_JS_TOKEN is set in the env, main() takes this path instead
# of Playwright + WARP. Crawlbase's JavaScript-rendering endpoint runs a
# headless browser on their side and returns the fully-rendered HTML — no
# Akamai handshake to worry about locally. Each request costs 5 credits
# against the JS-token quota (5000 free = ~1000 real requests).

CRAWLBASE_ENDPOINT = "https://api.crawlbase.com/"


def fetch_one_crawlbase(conn: sqlite3.Connection, cid: str,
                        idx: int, total: int, token: str) -> str:
    """Returns 'ok' | 'blocked' | 'empty' | 'not_available' | 'fail'.
    See fetch_one() docstring re: not_available."""
    target = f"{BASE_URL}/contests/{cid}/individual_stats"
    cache_path = CACHE_DIR / f"{cid}.html"
    # page_wait tells Crawlbase's headless browser to sit on the page for
    # this many ms after load, giving Akamai's client-side challenge time
    # to resolve and the roster table to hydrate.
    params = {"token": token, "url": target, "page_wait": "3000"}
    req_url = CRAWLBASE_ENDPOINT + "?" + urllib.parse.urlencode(params)
    print(f"[boxscrape] [{idx:>4}/{total}] {cid} …", end=" ", flush=True)
    try:
        with urllib.request.urlopen(req_url, timeout=120) as resp:
            body = resp.read()
            pc_status = resp.headers.get("pc_status")
            html = body.decode("utf-8", errors="replace")
    except Exception as e:
        err = str(e)[:200]
        print(f"error: {err}")
        update_status(conn, cid, "fail", 0, err)
        return "fail"

    if pc_status and pc_status != "200":
        print(f"CRAWLBASE fail pc_status={pc_status}")
        update_status(conn, cid, "fail", len(html), f"pc_status={pc_status}")
        return "fail"

    if is_no_box_score(html):
        print(f"NOT AVAILABLE ({len(html):,} bytes)")
        update_status(conn, cid, "empty", len(html),
                      "NCAA: Box score not available")
        return "not_available"

    if is_blocked(html):
        print(f"BLOCKED ({len(html):,} bytes)")
        update_status(conn, cid, "blocked", len(html), "akamai block via crawlbase")
        return "blocked"

    if not has_roster_table(html):
        print(f"EMPTY ({len(html):,} bytes) — no roster table")
        update_status(conn, cid, "empty", len(html),
                      "no roster table (individual_stats not published)")
        return "empty"

    if not safe_write_text(cache_path, html):
        print(f"WRITE-LOCKED ({len(html):,} bytes)")
        update_status(conn, cid, "fail", len(html), "OneDrive lock on write")
        return "fail"
    print(f"ok ({len(html):,} bytes)")
    update_status(conn, cid, "ok", len(html))
    return "ok"


def run_via_crawlbase(conn: sqlite3.Connection, todo: list[str], token: str) -> None:
    """Run the fetch loop against Crawlbase's JS-rendering API. Same
    accounting + abort logic as the Playwright path, but simpler because
    there's no browser context to manage."""
    print(f"[boxscrape] transport: Crawlbase JS API  (5 credits per request)")
    print(f"[boxscrape] budget note: ~{len(todo) * 5} credits will be consumed")
    consecutive_blocks = 0
    ok = blocked = failed = empty = not_avail = 0
    not_avail_ids: list[str] = []
    start_ts = time.time()

    for i, cid in enumerate(todo, 1):
        result = fetch_one_crawlbase(conn, cid, i, len(todo), token)
        if result == "ok":
            ok += 1; consecutive_blocks = 0
        elif result == "blocked":
            blocked += 1; consecutive_blocks += 1
        elif result == "empty":
            empty += 1; consecutive_blocks = 0
        elif result == "not_available":
            not_avail += 1; consecutive_blocks = 0
            not_avail_ids.append(cid)
        else:
            failed += 1

        if consecutive_blocks >= ABORT_AFTER_BLOCK:
            print(f"\n[boxscrape] {ABORT_AFTER_BLOCK} consecutive blocks via "
                  "Crawlbase — aborting. Their upstream may be flagged too, "
                  "or their JS backend is having trouble with this site.")
            break

        if i < len(todo):
            # Lighter throttle than Playwright — Crawlbase handles the
            # rate-limit / pattern-hiding on their side. Some pacing still
            # helps to avoid API-side rate limits.
            time.sleep(random.uniform(1.0, 3.0))

    elapsed = time.time() - start_ts
    print(f"\n[boxscrape] done in {elapsed:.0f}s")
    print(f"[boxscrape] ok: {ok}   blocked: {blocked}   empty: {empty}   "
          f"not-available: {not_avail}   failed: {failed}")
    if ok + empty + not_avail + failed > 0:
        print(f"[boxscrape] avg per fetch: "
              f"{elapsed / max(ok + empty + not_avail + failed, 1):.2f}s")

    _print_not_available_report(not_avail_ids)

    cur = conn.execute("SELECT status, COUNT(*) FROM progress GROUP BY status")
    totals = dict(cur.fetchall())
    print("[boxscrape] tracker totals:")
    for k in sorted(totals):
        print(f"          {k:<10} {totals[k]}")


# ── ID loading ────────────────────────────────────────────────────────────────

def load_ids_from_file(path: Path, limit: int | None = None) -> list[str]:
    if not path.exists():
        print(f"ERROR: {path} not found", file=sys.stderr)
        sys.exit(1)
    ids = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()
           if line.strip()]
    if limit:
        ids = ids[:limit]
    return ids


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year",     type=int, required=True)
    ap.add_argument("--ids-file", type=str, default=None,
                    help="Path to contest_ids_<year>.txt "
                         "(default: scripts/.pbp-build/contest_ids_<year>.txt)")
    ap.add_argument("--limit",    type=int, default=None,
                    help="Only fetch the first N contests (smoke test)")
    ap.add_argument("--retry-blocked", action="store_true",
                    help="Re-attempt contests previously marked blocked")
    ap.add_argument("--retry-failed",  action="store_true",
                    help="Re-attempt contests previously marked fail")
    ap.add_argument("--retry-empty",   action="store_true",
                    help="Re-attempt contests previously marked empty "
                         "(NCAA 'Box score not available' pages — use when "
                         "a scoretaker uploaded stats late)")
    args = ap.parse_args()

    ids_path = Path(args.ids_file) if args.ids_file else \
               BUILD_DIR / f"contest_ids_{args.year}.txt"
    ids = load_ids_from_file(ids_path, args.limit)
    print(f"[boxscrape] candidate IDs: {len(ids)}  (source: {ids_path})")

    conn = init_db()

    if args.retry_blocked:
        conn.execute("UPDATE progress SET status='retry' WHERE status='blocked'")
        conn.commit()
    if args.retry_failed:
        conn.execute("UPDATE progress SET status='retry' WHERE status='fail'")
        conn.commit()
    if args.retry_empty:
        conn.execute("UPDATE progress SET status='retry' WHERE status='empty'")
        conn.commit()

    done = already_done_ids(conn)
    todo = [cid for cid in ids if cid not in done]
    # Randomize order — sequential contest ID access is one of the most
    # obvious scraper fingerprints. The IDs happen to be time-ordered on
    # NCAA's side too, so monotonic access screams "just grabbed today's
    # matches." Shuffling breaks that pattern.
    random.shuffle(todo)
    print(f"[boxscrape] already done: {len(done)}   to do: {len(todo)}  (shuffled order)")
    if not todo:
        print("[boxscrape] nothing to do — exiting")
        return

    # Auto-select transport. If CRAWLBASE_JS_TOKEN is set, use Crawlbase's
    # headless-browser API (bypasses our WARP/Akamai flag situation at 5
    # credits per request). Otherwise fall back to local Playwright+WARP.
    crawlbase_token = os.environ.get("CRAWLBASE_JS_TOKEN")
    if crawlbase_token:
        run_via_crawlbase(conn, todo, crawlbase_token)
        return

    print("[boxscrape] make sure Cloudflare WARP is connected before continuing")
    print("[boxscrape] launching Edge (msedge channel) …")

    fresh_state = _load_fresh_cookie_state(COOKIE_STATE_PATH, COOKIE_MAX_AGE_MIN)
    if fresh_state:
        print(f"[boxscrape] reusing persisted cookies from {COOKIE_STATE_PATH.name}")

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
            storage_state=fresh_state,
        )
        context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
        )
        page = context.new_page()

        # Warmup — skip when persistence already carried ak_bmsc in.
        preloaded = {c["name"] for c in context.cookies()}
        if "ak_bmsc" in preloaded:
            print("[boxscrape] ak_bmsc already loaded — skipping warmup")
        else:
            print(f"[boxscrape] warmup → {HOME_URL}")
            try:
                page.goto(HOME_URL, timeout=WARMUP_TIMEOUT_MS,
                          wait_until="domcontentloaded")
                page.wait_for_timeout(2_500)
            except Exception as e:
                print(f"[boxscrape] warmup failed: {e}")
                browser.close()
                sys.exit(2)
            cookies = [c["name"] for c in context.cookies()]
            print(f"[boxscrape] cookies after warmup: {cookies}")

        # Iterate the queue ───────────────────────────────────────────
        consecutive_blocks = 0
        ok = blocked = failed = empty = not_avail = 0
        not_avail_ids: list[str] = []
        start_ts = time.time()

        for i, cid in enumerate(todo, 1):
            result = fetch_one(page, conn, cid, i, len(todo))
            if result == "ok":
                ok += 1; consecutive_blocks = 0
            elif result == "blocked":
                blocked += 1; consecutive_blocks += 1
            elif result == "empty":
                empty += 1; consecutive_blocks = 0
            elif result == "not_available":
                not_avail += 1; consecutive_blocks = 0
                not_avail_ids.append(cid)
            else:
                failed += 1

            if consecutive_blocks >= ABORT_AFTER_BLOCK:
                print(f"\n[boxscrape] {ABORT_AFTER_BLOCK} consecutive blocks — "
                      "aborting. WARP exit may be flagged; toggle WARP off/on "
                      "or wait 30 min.")
                break

            if i < len(todo):
                time.sleep(random.uniform(THROTTLE_MIN_S, THROTTLE_MAX_S))

        # Persist cookies so subsequent runs (PBP or boxscore) can skip
        # the warmup and inherit this session's Akamai handshake.
        try:
            context.storage_state(path=str(COOKIE_STATE_PATH))
            print(f"[boxscrape] saved cookie state → {COOKIE_STATE_PATH.name}")
        except Exception as e:
            print(f"[boxscrape] cookie save failed (non-fatal): {e}")

        browser.close()

    elapsed = time.time() - start_ts
    print(f"\n[boxscrape] done in {elapsed:.0f}s")
    print(f"[boxscrape] ok: {ok}   blocked: {blocked}   empty: {empty}   "
          f"not-available: {not_avail}   failed: {failed}")
    if ok + empty + not_avail + failed > 0:
        print(f"[boxscrape] avg per fetch: "
              f"{elapsed / max(ok + empty + not_avail + failed, 1):.2f}s")

    _print_not_available_report(not_avail_ids)

    # Tracker totals
    cur = conn.execute("SELECT status, COUNT(*) FROM progress GROUP BY status")
    totals = dict(cur.fetchall())
    print("[boxscrape] tracker totals:")
    for k in sorted(totals):
        print(f"          {k:<10} {totals[k]}")


if __name__ == "__main__":
    main()
