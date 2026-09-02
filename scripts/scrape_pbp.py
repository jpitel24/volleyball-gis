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
import json
import os
import random
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

def _load_fresh_cookie_state(path: Path, max_age_min: int) -> str | None:
    """Return the persisted storage_state path if it exists AND is recent
    enough to be plausibly still valid on Akamai's side. Otherwise return
    None so the caller does a normal cold warmup."""
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        cookies = raw.get("cookies", [])
        if not any(c.get("name") == "ak_bmsc" for c in cookies):
            return None
        age_s = time.time() - path.stat().st_mtime
        if age_s > max_age_min * 60:
            print(f"[scrape] persisted cookies are {age_s/60:.0f}min old — "
                  "discarding, will re-warmup")
            return None
        return str(path)
    except Exception as e:
        print(f"[scrape] cookie load failed (non-fatal): {e}")
        return None


CACHE_DIR = Path("scripts/.pbp-cache")
BUILD_DIR = Path("scripts/.pbp-build")
DB_PATH   = BUILD_DIR / "progress.sqlite"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
BUILD_DIR.mkdir(parents=True, exist_ok=True)

# Tunables ────────────────────────────────────────────────────────────
HOME_URL          = "https://stats.ncaa.org/"
# Randomized throttle window (min, max seconds). Wider + slower than
# the old fixed 1.5s to look less like a bot burst. Actual sleep is
# uniform-random within this range each iteration — the variance is
# itself a signal Akamai's WAF weights lower than a fixed cadence.
THROTTLE_MIN_S    = 6.0
THROTTLE_MAX_S    = 14.0
WARMUP_DWELL_MS   = 3_000          # let homepage settle before scraping
PAGE_DWELL_MS     = 1_500          # wait after each PBP nav
NAV_TIMEOUT_MS    = 60_000
# Persist Akamai cookies (ak_bmsc, bm_*) across runs so we skip the
# cold warmup when possible. Cookie file lives inside .pbp-build so
# it's ignored by git alongside progress.sqlite.
COOKIE_STATE_PATH = Path("scripts/.pbp-build/scraper_cookies.json")
# Reuse persisted cookies if they were saved within this many minutes.
# Akamai's ak_bmsc typically stays valid ~2h; we're conservative here.
COOKIE_MAX_AGE_MIN = 60
MIN_VALID_SIZE    = 1_000          # below this, response is a genuine Akamai stub
                                   # (real PBP pages are 100K+, empty-PBP shells are
                                   # 25-30K — the latter gets routed to "empty" via
                                   # the has_pbp_table check, not flagged as blocked)
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
    """True only for actual Akamai/WARP blocks — tiny response or denial text."""
    if not html or len(html) < MIN_VALID_SIZE:
        return True
    low = html.lower()
    if "access denied" in low and "errors.edgesuite.net" in low:
        return True
    return False


def has_pbp_table(html: str) -> bool:
    """A real PBP page always contains at least one <table>. Some legitimate
    matches (typically early-season / unrecorded) come back as a full page
    shell with no rally table — those should be marked 'empty', not 'blocked',
    so they don't trip the consecutive-block abort circuit."""
    return "<table" in (html or "").lower()


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
        update_status(conn, contest_id, "blocked", len(html), "akamai block")
        return "blocked"

    if not has_pbp_table(html):
        print(f"EMPTY ({len(html):,} bytes) — no PBP table; recording as known-missing")
        update_status(conn, contest_id, "empty", len(html), "no <table> in page (PBP not recorded)")
        return "empty"

    if not safe_write_text(cache_path, html):
        print(f"WRITE-LOCKED ({len(html):,} bytes) — file locked, will retry next run")
        update_status(conn, contest_id, "fail", len(html), "OneDrive lock on write")
        return "fail"
    print(f"ok ({len(html):,} bytes)")
    update_status(conn, contest_id, "ok", len(html))
    return "ok"


# ── Crawlbase transport ──────────────────────────────────────────────────────
#
# When CRAWLBASE_JS_TOKEN is set in the env, main() takes this path instead
# of Playwright + WARP. Crawlbase's JavaScript-rendering endpoint runs a
# headless browser on their side and returns the fully-rendered HTML — no
# Akamai handshake or WARP flag to worry about locally. Each request costs
# 2 credits against the JS-token quota.

CRAWLBASE_ENDPOINT     = "https://api.crawlbase.com/"
CRAWLBASE_TOKEN_FILE   = Path("scripts/.pbp-build/crawlbase_token.txt")
# Concurrency for parallel Crawlbase requests. Same env-var + default as
# the boxscore scraper — 5 is safe under the free-tier 20-connection cap.
CRAWLBASE_CONCURRENCY  = int(os.environ.get("CRAWLBASE_CONCURRENCY", "5"))


def _load_crawlbase_token() -> str | None:
    """Return the Crawlbase JS token from env var or the local token file.
    Env wins so you can override per-run; the file is the persistent
    default so daily scrapes don't require exporting the var each time.
    File lives inside .pbp-build (gitignored)."""
    tok = os.environ.get("CRAWLBASE_JS_TOKEN")
    if tok:
        return tok.strip() or None
    if CRAWLBASE_TOKEN_FILE.exists():
        try:
            tok = CRAWLBASE_TOKEN_FILE.read_text(encoding="utf-8").strip()
            return tok or None
        except Exception:
            return None
    return None


def _crawlbase_http_fetch_pbp(cid: str, token: str) -> tuple[str, str | None, str | None, str | None]:
    """Pure I/O: fetch one PBP page via Crawlbase. Thread-safe."""
    target = f"https://stats.ncaa.org/contests/{cid}/play_by_play"
    # PBP pages are heavier than boxscores; give the headless browser a
    # bit more time before returning the rendered HTML.
    params = {"token": token, "url": target, "page_wait": "4000"}
    req_url = CRAWLBASE_ENDPOINT + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(req_url, timeout=180) as resp:
            body = resp.read()
            pc_status = resp.headers.get("pc_status")
            html = body.decode("utf-8", errors="replace")
        return (cid, html, pc_status, None)
    except Exception as e:
        return (cid, None, None, str(e)[:200])


def _classify_and_persist_pbp(conn, cid: str, html: str | None,
                              pc_status: str | None, error: str | None,
                              label: str) -> str:
    """Main-thread half of the parallel fetch: classify + DB write + cache."""
    print(f"[scrape] {label} {cid} …", end=" ", flush=True)

    if error is not None:
        print(f"error: {error}")
        update_status(conn, cid, "fail", 0, error)
        return "fail"

    if pc_status and pc_status != "200":
        print(f"CRAWLBASE fail pc_status={pc_status}")
        update_status(conn, cid, "fail", len(html or ""), f"pc_status={pc_status}")
        return "fail"

    if is_blocked(html):
        print(f"BLOCKED ({len(html):,} bytes)")
        update_status(conn, cid, "blocked", len(html), "akamai block via crawlbase")
        return "blocked"

    if not has_pbp_table(html):
        print(f"EMPTY ({len(html):,} bytes) — no PBP table; recording as known-missing")
        update_status(conn, cid, "empty", len(html),
                      "no <table> in page (PBP not recorded)")
        return "empty"

    cache_path = CACHE_DIR / f"{cid}.html"
    if not safe_write_text(cache_path, html):
        print(f"WRITE-LOCKED ({len(html):,} bytes)")
        update_status(conn, cid, "fail", len(html), "OneDrive lock on write")
        return "fail"

    print(f"ok ({len(html):,} bytes)")
    update_status(conn, cid, "ok", len(html))
    return "ok"


def run_via_crawlbase(conn, todo: list[str], token: str) -> None:
    """Parallel fetch loop via Crawlbase's JS API. Workers do the HTTP
    call only; the main thread classifies + persists so SQLite writes
    stay serialized. Abort uses a rolling window over completion order
    since strict "consecutive" is fuzzy under concurrency."""
    n = len(todo)
    concurrency = max(1, min(CRAWLBASE_CONCURRENCY, 20))
    print(f"[scrape] transport: Crawlbase JS API  (2 credits per request)")
    print(f"[scrape] budget note: ~{n * 2} credits will be consumed")
    print(f"[scrape] concurrency: {concurrency}")

    ok = blocked = empty = failed = 0
    recent_results: list[str] = []
    aborted = False
    completed = 0
    start_ts = time.time()

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(_crawlbase_http_fetch_pbp, cid, token): cid for cid in todo}
        try:
            for fut in as_completed(futures):
                cid, html, pc_status, error = fut.result()
                completed += 1
                label = f"[{completed:>4}/{n}]"
                result = _classify_and_persist_pbp(
                    conn, cid, html, pc_status, error, label
                )
                if result == "ok":
                    ok += 1
                elif result == "blocked":
                    blocked += 1
                elif result == "empty":
                    empty += 1
                else:
                    failed += 1

                recent_results.append(result)
                if len(recent_results) > ABORT_AFTER_BLOCK:
                    recent_results.pop(0)
                if (len(recent_results) == ABORT_AFTER_BLOCK
                        and all(r == "blocked" for r in recent_results)):
                    print(f"\n[scrape] last {ABORT_AFTER_BLOCK} results all "
                          "blocked — aborting; cancelling remaining futures.")
                    aborted = True
                    for f in futures:
                        if not f.done():
                            f.cancel()
                    break
        finally:
            if aborted:
                for f in futures:
                    if f.cancelled():
                        continue
                    try:
                        f.result(timeout=0.1)
                    except Exception:
                        pass

    elapsed = time.time() - start_ts
    print(f"\n[scrape] done in {elapsed:.0f}s")
    print(f"[scrape] ok: {ok}   blocked: {blocked}   empty: {empty}   failed: {failed}")
    cur = conn.execute("SELECT status, COUNT(*) FROM progress GROUP BY status")
    totals = dict(cur.fetchall())
    print("[scrape] tracker totals:")
    for k in sorted(totals):
        print(f"          {k:<10} {totals[k]}")


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
    # Shuffle the queue so we don't hit contest IDs in monotonic order —
    # sequential ID access is one of the most obvious scraper fingerprints
    # for Akamai's WAF. Random order looks more like organic browsing.
    random.shuffle(todo)
    print(f"[scrape] already done: {len(done)}   to do: {len(todo)}  (shuffled order)")
    if not todo:
        print("[scrape] nothing to do — exiting")
        return

    # Auto-select transport. Crawlbase is the default going forward —
    # WARP has been reliably flagged for stats.ncaa.org — so we look for
    # the JS token in the env first, then fall back to a gitignored token
    # file. If neither is present we drop through to the Playwright path
    # as a last resort. See _load_crawlbase_token().
    crawlbase_token = _load_crawlbase_token()
    if crawlbase_token:
        run_via_crawlbase(conn, todo, crawlbase_token)
        return

    print("[scrape] make sure Cloudflare WARP is connected before continuing")
    print(f"[scrape] launching Edge (msedge channel) …")

    # Try to reuse a persisted Akamai session so we skip the cold warmup
    # when possible — a "returning visitor with valid cookies" pattern is
    # much less scrutinized than a fresh session that has to earn ak_bmsc
    # from scratch every run.
    fresh_state = _load_fresh_cookie_state(COOKIE_STATE_PATH, COOKIE_MAX_AGE_MIN)
    if fresh_state:
        print(f"[scrape] reusing persisted cookies from {COOKIE_STATE_PATH.name}")

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

        # Warmup: visit homepage so Akamai sets ak_bmsc / bm_* cookies.
        # Skip when we already have a valid ak_bmsc from persistence.
        preloaded = {c["name"] for c in context.cookies()}
        if "ak_bmsc" in preloaded:
            print(f"[scrape] ak_bmsc already loaded — skipping warmup")
        else:
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
        ok = blocked = failed = empty = 0
        start_ts = time.time()

        for i, cid in enumerate(todo, 1):
            result = fetch_one(page, conn, cid, i, len(todo))
            if result == "ok":
                ok += 1
                consecutive_blocks = 0
            elif result == "blocked":
                blocked += 1
                consecutive_blocks += 1
            elif result == "empty":
                empty += 1
                consecutive_blocks = 0   # legit no-PBP match, not a block
            else:
                failed += 1

            if consecutive_blocks >= ABORT_AFTER_BLOCK:
                print(f"\n[scrape] {ABORT_AFTER_BLOCK} consecutive blocks — aborting. "
                      "WARP exit may be flagged; toggle WARP off/on or wait 30 min.")
                break

            if i < len(todo):
                time.sleep(random.uniform(THROTTLE_MIN_S, THROTTLE_MAX_S))

        # Persist the current cookie jar so the next run can skip the
        # warmup dance. Save whenever we successfully finished the loop
        # or aborted after some progress — a fresh session with valid
        # ak_bmsc is worth keeping even if we didn't get through
        # everything on this pass.
        try:
            context.storage_state(path=str(COOKIE_STATE_PATH))
            print(f"[scrape] saved cookie state → {COOKIE_STATE_PATH.name}")
        except Exception as e:
            print(f"[scrape] cookie save failed (non-fatal): {e}")

        browser.close()

    elapsed = time.time() - start_ts
    print()
    print(f"[scrape] done in {elapsed:.0f}s")
    print(f"[scrape] ok: {ok}   blocked: {blocked}   empty: {empty}   failed: {failed}")
    if ok > 0:
        print(f"[scrape] avg per fetch: {elapsed/ok:.2f}s")

    # Final status snapshot
    cur = conn.execute("SELECT status, COUNT(*) FROM progress GROUP BY status")
    print("[scrape] tracker totals:")
    for status, count in cur.fetchall():
        print(f"          {status:<10} {count}")


if __name__ == "__main__":
    main()
