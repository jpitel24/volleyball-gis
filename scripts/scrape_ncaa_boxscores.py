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
import sqlite3
import sys
import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

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
    cur = conn.execute("SELECT contest_id FROM progress WHERE status='ok'")
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

def is_blocked(html: str) -> bool:
    """True only for genuine Akamai/WARP blocks — tiny stub or denial text."""
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
    """Returns 'ok' | 'blocked' | 'empty' | 'fail'."""
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

    done = already_done_ids(conn)
    todo = [cid for cid in ids if cid not in done]
    print(f"[boxscrape] already done: {len(done)}   to do: {len(todo)}")
    if not todo:
        print("[boxscrape] nothing to do — exiting")
        return

    print("[boxscrape] make sure Cloudflare WARP is connected before continuing")
    print("[boxscrape] launching Edge (msedge channel) …")

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

        # Warmup — sets Akamai cookies (ak_bmsc, bm_*).
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
        ok = blocked = failed = empty = 0
        start_ts = time.time()

        for i, cid in enumerate(todo, 1):
            result = fetch_one(page, conn, cid, i, len(todo))
            if   result == "ok":       ok += 1;      consecutive_blocks = 0
            elif result == "blocked":  blocked += 1; consecutive_blocks += 1
            elif result == "empty":    empty += 1;   consecutive_blocks = 0
            else:                      failed += 1

            if consecutive_blocks >= ABORT_AFTER_BLOCK:
                print(f"\n[boxscrape] {ABORT_AFTER_BLOCK} consecutive blocks — "
                      "aborting. WARP exit may be flagged; toggle WARP off/on "
                      "or wait 30 min.")
                break

        browser.close()

    elapsed = time.time() - start_ts
    print(f"\n[boxscrape] done in {elapsed:.0f}s")
    print(f"[boxscrape] ok: {ok}   blocked: {blocked}   empty: {empty}   failed: {failed}")
    if ok + empty + failed > 0:
        print(f"[boxscrape] avg per fetch: {elapsed / max(ok + empty + failed, 1):.2f}s")

    # Tracker totals
    cur = conn.execute("SELECT status, COUNT(*) FROM progress GROUP BY status")
    totals = dict(cur.fetchall())
    print("[boxscrape] tracker totals:")
    for k in sorted(totals):
        print(f"          {k:<10} {totals[k]}")


if __name__ == "__main__":
    main()
