"""
scrape_pbp.py — Phase 2 bulk PBP fetcher.

Pulls play-by-play HTML for D1 women's volleyball contests via the
Akamai-protected stats.ncaa.org. Designed to run while Cloudflare WARP
provides a clean exit IP at the system level.

Architecture (v1, single-browser, sequential):
  - Reads contest IDs from --year (default 2025) by walking the
    existing wvb_playermatch_div1_<year>.csv and deduping ContestID.
    Honours --limit for the 10-contest pilot.
  - Maintains a SQLite tracker at scripts/.pbp-build/progress.sqlite
    so re-runs skip already-fetched contests. Resumable.
  - Single Playwright Edge session, kept warm for the whole run so
    cookies, JA3 fingerprint, and DOM state stay coherent.
  - Throttle 1.5s between requests. Detects block responses by size
    and content; aborts if 3 consecutive failures (assume IP burned).
  - Writes raw HTML to scripts/.pbp-cache/<id>.html.

Usage:
  py -X utf8 scripts/scrape_pbp.py --year 2025 --limit 10
  py -X utf8 scripts/scrape_pbp.py --year 2025          # full season
  py -X utf8 scripts/scrape_pbp.py --ids 6501654,6479076

Inspect progress at any time:
  py -X utf8 -c "import sqlite3,os; c=sqlite3.connect('scripts/.pbp-build/progress.sqlite'); \\
                 [print(r) for r in c.execute('SELECT status,COUNT(*) FROM progress GROUP BY status')]"
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

CACHE_DIR = Path("scripts/.pbp-cache")
BUILD_DIR = Path("scripts/.pbp-build")
DB_PATH   = BUILD_DIR / "progress.sqlite"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
BUILD_DIR.mkdir(parents=True, exist_ok=True)

# Tunables ────────────────────────────────────────────────────────────
HOME_URL          = "https://stats.ncaa.org/"
THROTTLE_S        = 1.5            # sleep between requests
WARMUP_DWELL_MS   = 3_000          # let homepage settle before scraping
PAGE_DWELL_MS     = 1_500          # wait after each PBP nav
NAV_TIMEOUT_MS    = 60_000
MIN_VALID_SIZE    = 30_000         # below this, response is suspect
ABORT_AFTER_BLOCK = 3              # consecutive blocks → abort
USER_AGENT_EDGE   = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
)


def init_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS progress (
          contest_id TEXT PRIMARY KEY,
          status     TEXT,           -- 'ok' | 'blocked' | 'fail'
          size       INTEGER,
          attempts   INTEGER DEFAULT 0,
          last_error TEXT,
          last_ts    TEXT
        )
    """)
    conn.commit()
    return conn


def load_contest_ids(year: int, limit: int | None = None) -> list[str]:
    """Read unique ContestIDs from the existing per-year box-score CSV.

    DEPRECATED for stats.ncaa.org PBP fetching — those IDs use a
    different namespace than the box-score CSVs. Use load_ids_from_file()
    with the output of discover_pbp_ids.py instead.
    """
    csv_path = Path(f"public/data/wvb_playermatch_div1_{year}.csv")
    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found", file=sys.stderr)
        sys.exit(1)
    seen: set[str] = set()
    ids: list[str] = []
    with csv_path.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            cid = (r.get("ContestID") or "").strip()
            if cid and cid not in seen:
                seen.add(cid)
                ids.append(cid)
                if limit and len(ids) >= limit:
                    break
    return ids


def load_ids_from_file(path: Path, limit: int | None = None) -> list[str]:
    """Read one-ID-per-line from the discover_pbp_ids.py output file."""
    if not path.exists():
        print(f"ERROR: {path} not found. Run discover_pbp_ids.py first.", file=sys.stderr)
        sys.exit(1)
    ids: list[str] = []
    seen: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        cid = line.strip()
        if cid and cid not in seen:
            seen.add(cid)
            ids.append(cid)
            if limit and len(ids) >= limit:
                break
    return ids


def safe_write_text(path: Path, text: str, retries: int = 5, delay: float = 0.4) -> bool:
    """
    Write a file, retrying on PermissionError. OneDrive holds transient
    locks on files in synced folders; we just wait a beat and retry.
    Returns True on success, False if all retries failed.
    """
    for i in range(retries):
        try:
            path.write_text(text, encoding="utf-8")
            return True
        except (PermissionError, OSError):
            if i < retries - 1:
                time.sleep(delay)
                continue
    return False


def is_blocked(html: str) -> bool:
    """A response is suspicious if it's tiny or has the Akamai denial text."""
    if not html or len(html) < MIN_VALID_SIZE:
        return True
    low = html.lower()
    if "access denied" in low and "errors.edgesuite.net" in low:
        return True
    # A real PBP page always contains at least one <table>
    if "<table" not in low:
        return True
    return False


def update_status(conn, contest_id: str, status: str, size: int = 0, err: str | None = None) -> None:
    conn.execute(
        """INSERT INTO progress (contest_id, status, size, attempts, last_error, last_ts)
           VALUES (?, ?, ?, 1, ?, datetime('now'))
           ON CONFLICT(contest_id) DO UPDATE SET
             status     = excluded.status,
             size       = excluded.size,
             attempts   = progress.attempts + 1,
             last_error = excluded.last_error,
             last_ts    = excluded.last_ts""",
        (contest_id, status, size, err),
    )
    conn.commit()


def already_done_ids(conn) -> set[str]:
    cur = conn.execute("SELECT contest_id FROM progress WHERE status='ok'")
    return {row[0] for row in cur.fetchall()}


def fetch_one(page, conn, contest_id: str, idx: int, total: int) -> str:
    """Returns 'ok' | 'blocked' | 'fail'."""
    url = f"https://stats.ncaa.org/contests/{contest_id}/play_by_play"
    cache_path = CACHE_DIR / f"{contest_id}.html"
    print(f"[scrape] [{idx:>4}/{total}] {contest_id} …", end=" ", flush=True)
    try:
        page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
        page.wait_for_timeout(PAGE_DWELL_MS)
        html = page.content()
    except PWTimeout as e:
        print(f"timeout")
        update_status(conn, contest_id, "fail", 0, "navigation timeout")
        return "fail"
    except Exception as e:
        err = str(e)[:200]
        print(f"error: {err}")
        update_status(conn, contest_id, "fail", 0, err)
        return "fail"

    if is_blocked(html):
        print(f"BLOCKED ({len(html):,} bytes)")
        update_status(conn, contest_id, "blocked", len(html), "akamai block / no table")
        return "blocked"

    if not safe_write_text(cache_path, html):
        print(f"WRITE-LOCKED ({len(html):,} bytes) — file locked, will retry next run")
        update_status(conn, contest_id, "fail", len(html), "OneDrive lock on write")
        return "fail"
    print(f"ok ({len(html):,} bytes)")
    update_status(conn, contest_id, "ok", len(html))
    return "ok"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year",      type=int, default=2025)
    ap.add_argument("--limit",     type=int, default=None,
                    help="Only fetch the first N contests (good for pilots)")
    ap.add_argument("--ids",       type=str, default=None,
                    help="Explicit comma-separated contest IDs (overrides other sources)")
    ap.add_argument("--ids-file",  type=str, default=None,
                    help="Path to a file with one contest ID per line "
                         "(typically scripts/.pbp-build/contest_ids_<year>.txt "
                         "produced by discover_pbp_ids.py). Recommended path.")
    ap.add_argument("--retry-blocked", action="store_true",
                    help="Re-attempt contests previously marked 'blocked'")
    ap.add_argument("--retry-failed",  action="store_true",
                    help="Re-attempt contests previously marked 'fail'")
    args = ap.parse_args()

    # Build the ID list ───────────────────────────────────────────────
    # Priority: explicit --ids > --ids-file > --year (fallback to box-score CSV).
    if args.ids:
        ids = [s.strip() for s in args.ids.split(",") if s.strip()]
        source = "explicit --ids"
    elif args.ids_file:
        ids = load_ids_from_file(Path(args.ids_file), args.limit)
        source = f"file {args.ids_file}"
    else:
        # Default: try discovery output for the requested year first,
        # fall back to box-score CSV with a loud warning.
        discovered = BUILD_DIR / f"contest_ids_{args.year}.txt"
        if discovered.exists():
            ids = load_ids_from_file(discovered, args.limit)
            source = f"file {discovered}"
        else:
            print(f"[scrape] WARNING: {discovered} not found.")
            print(f"[scrape]          Falling back to wvb_playermatch_div1_{args.year}.csv "
                  "(NOT recommended — those IDs are in a different namespace).")
            ids = load_contest_ids(args.year, args.limit)
            source = f"CSV wvb_playermatch_div1_{args.year}.csv"
    print(f"[scrape] candidate IDs: {len(ids)}  (source: {source}, limit={args.limit})")

    conn = init_db()
    done = already_done_ids(conn)

    # Optionally clear failed/blocked statuses so they re-enter the queue
    if args.retry_blocked:
        conn.execute("UPDATE progress SET status='retry' WHERE status='blocked'")
        conn.commit()
    if args.retry_failed:
        conn.execute("UPDATE progress SET status='retry' WHERE status='fail'")
        conn.commit()

    todo = [cid for cid in ids if cid not in done]
    print(f"[scrape] already done: {len(done)}   to do: {len(todo)}")
    if not todo:
        print("[scrape] nothing to do — exiting")
        return

    print("[scrape] make sure Cloudflare WARP is connected before continuing")
    print(f"[scrape] launching Edge (msedge channel) …")

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

        # Warmup: visit homepage so Akamai sets ak_bmsc / bm_* cookies.
        print(f"[scrape] warmup → {HOME_URL}")
        try:
            page.goto(HOME_URL, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(WARMUP_DWELL_MS)
        except PWTimeout:
            print("[scrape] warmup timed out — continuing")
        cookies = context.cookies()
        akamai_cookie_names = {c["name"] for c in cookies}
        print(f"[scrape] cookies after warmup: {sorted(akamai_cookie_names)}")
        if "ak_bmsc" not in akamai_cookie_names:
            print("[scrape] WARNING: no ak_bmsc cookie — Akamai likely blocking. "
                  "Check WARP is connected and your IP is masked. Aborting.")
            browser.close()
            sys.exit(2)

        # Iterate the queue ──────────────────────────────────────────
        consecutive_blocks = 0
        ok = blocked = failed = 0
        start_ts = time.time()

        for i, cid in enumerate(todo, 1):
            result = fetch_one(page, conn, cid, i, len(todo))
            if result == "ok":
                ok += 1
                consecutive_blocks = 0
            elif result == "blocked":
                blocked += 1
                consecutive_blocks += 1
            else:
                failed += 1

            if consecutive_blocks >= ABORT_AFTER_BLOCK:
                print(f"\n[scrape] {ABORT_AFTER_BLOCK} consecutive blocks — aborting. "
                      "WARP exit may be flagged; toggle WARP off/on or wait 30 min.")
                break

            if i < len(todo):
                time.sleep(THROTTLE_S)

        browser.close()

    elapsed = time.time() - start_ts
    print()
    print(f"[scrape] done in {elapsed:.0f}s")
    print(f"[scrape] ok: {ok}   blocked: {blocked}   failed: {failed}")
    if ok > 0:
        print(f"[scrape] avg per fetch: {elapsed/ok:.2f}s")

    # Final status snapshot
    cur = conn.execute("SELECT status, COUNT(*) FROM progress GROUP BY status")
    print("[scrape] tracker totals:")
    for status, count in cur.fetchall():
        print(f"          {status:<10} {count}")


if __name__ == "__main__":
    main()
