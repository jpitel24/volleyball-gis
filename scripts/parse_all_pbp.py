"""
parse_all_pbp.py — batch-run parse_pbp on every cached HTML.

Walks scripts/.pbp-cache/, finds every <contestId>.html, and produces
the corresponding <contestId>.parsed.json by reusing parse_pbp's
parser. Skips files that already have an up-to-date parsed JSON
(parsed.json mtime ≥ html mtime) so re-runs are fast.

Tolerates OneDrive's transient file-locks via retry on read/write.
Logs a summary of empty / metadata-only matches (real PBP not
recorded by NCAA) at the end so we can sanity-check the coverage
ratio before running the full coverage analysis.

Usage:
  py -X utf8 scripts/parse_all_pbp.py              # parse everything new
  py -X utf8 scripts/parse_all_pbp.py --force      # re-parse everything
  py -X utf8 scripts/parse_all_pbp.py --limit 100  # smoke-test first 100
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# Reuse the parser from parse_pbp.py (same module, sibling file)
sys.path.insert(0, str(Path(__file__).parent))
from parse_pbp import parse_pbp  # type: ignore

CACHE_DIR = Path("scripts/.pbp-cache")


def safe_read_text(path: Path, retries: int = 5, delay: float = 0.4) -> str | None:
    for i in range(retries):
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except (PermissionError, OSError) as e:
            if i < retries - 1:
                time.sleep(delay)
                continue
            print(f"[parse-all] WARNING: could not read {path}: {e}")
    return None


def safe_write_text(path: Path, text: str, retries: int = 5, delay: float = 0.4) -> bool:
    for i in range(retries):
        try:
            path.write_text(text, encoding="utf-8")
            return True
        except (PermissionError, OSError):
            if i < retries - 1:
                time.sleep(delay)
                continue
    return False


def needs_reparse(html_path: Path, json_path: Path, force: bool) -> bool:
    if force:
        return True
    if not json_path.exists():
        return True
    try:
        return html_path.stat().st_mtime > json_path.stat().st_mtime
    except OSError:
        return True


def summarize(parsed: dict) -> tuple[int, int, str]:
    """Returns (rally_count, touch_count, tier)."""
    rallies = 0
    touches = 0
    for s in parsed.get("sets", []):
        for r in s.get("rallies", []):
            rallies += 1
            touches += len(r.get("touches", []))
    if rallies == 0:
        return rallies, touches, "metadata-only"
    if rallies < 30:
        return rallies, touches, "partial"
    return rallies, touches, "full"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="Re-parse even when *.parsed.json already exists and is newer")
    ap.add_argument("--limit", type=int, default=None,
                    help="Stop after parsing N HTMLs (smoke test)")
    args = ap.parse_args()

    if not CACHE_DIR.exists():
        print(f"ERROR: {CACHE_DIR} does not exist", file=sys.stderr)
        sys.exit(1)

    html_files = sorted(CACHE_DIR.glob("*.html"))
    print(f"[parse-all] found {len(html_files):,} cached HTML files")

    work: list[Path] = []
    skipped = 0
    for html in html_files:
        cid = html.stem
        json_path = CACHE_DIR / f"{cid}.parsed.json"
        if needs_reparse(html, json_path, args.force):
            work.append(html)
        else:
            skipped += 1
    print(f"[parse-all] {skipped:,} already up-to-date · {len(work):,} to parse")

    if args.limit:
        work = work[: args.limit]
        print(f"[parse-all] limit applied → {len(work):,} to parse")

    if not work:
        print("[parse-all] nothing to do, exiting")
        return

    tier_counts = {"full": 0, "partial": 0, "metadata-only": 0}
    fail_count = 0
    write_lock_count = 0
    start_ts = time.time()

    for i, html in enumerate(work, 1):
        cid = html.stem
        json_path = CACHE_DIR / f"{cid}.parsed.json"

        text = safe_read_text(html)
        if text is None:
            fail_count += 1
            continue
        try:
            parsed = parse_pbp(text, cid)
        except Exception as e:
            print(f"[parse-all] [{i:>5}/{len(work)}] {cid} ✗ parse error: {e}")
            fail_count += 1
            continue

        rallies, touches, tier = summarize(parsed)
        tier_counts[tier] += 1
        # Annotate the parsed file with the tier so downstream readers
        # can filter without re-counting.
        parsed["_coverage_tier"] = tier
        parsed["_rally_count"]   = rallies
        parsed["_touch_count"]   = touches

        if not safe_write_text(json_path, json.dumps(parsed, separators=(",", ":"))):
            print(f"[parse-all] [{i:>5}/{len(work)}] {cid} ✗ write locked, skipping")
            write_lock_count += 1
            continue

        # Lightweight progress beacon every 250 contests
        if i % 250 == 0 or i == len(work):
            elapsed = time.time() - start_ts
            rate = i / elapsed if elapsed > 0 else 0
            remaining = (len(work) - i) / rate if rate > 0 else 0
            print(f"[parse-all] [{i:>5}/{len(work)}] "
                  f"full={tier_counts['full']:>4}  "
                  f"partial={tier_counts['partial']:>3}  "
                  f"meta-only={tier_counts['metadata-only']:>4}  "
                  f"fail={fail_count}  "
                  f"({rate:.1f}/s, ~{remaining/60:.1f}min remaining)")

    elapsed = time.time() - start_ts
    print()
    print(f"[parse-all] done in {elapsed:.0f}s")
    print(f"[parse-all] tier breakdown of newly-parsed files:")
    print(f"             full:          {tier_counts['full']:>5,}")
    print(f"             partial:       {tier_counts['partial']:>5,}")
    print(f"             metadata-only: {tier_counts['metadata-only']:>5,}")
    if fail_count:
        print(f"             parse-failed:  {fail_count:>5}")
    if write_lock_count:
        print(f"             write-locked:  {write_lock_count:>5}  (re-run to retry)")


if __name__ == "__main__":
    main()
