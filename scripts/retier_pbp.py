"""
retier_pbp.py — re-classify cached parsed PBP files with the refined
4-tier classifier:

  metadata-only  → rallies == 0
  terminal-only  → rallies ≥ 30 AND touches/rally < 0.5
                   (only the kill/error/ace terminal events were
                   recorded — same shape as our existing rallies CSV)
  partial        → rallies ≥ 30 AND 0.5 ≤ touches/rally < 2.5
                   OR 1 ≤ rallies < 30 (truncated mid-match)
  full           → rallies ≥ 30 AND touches/rally ≥ 2.5
                   (rich touch-level data; unlocks new metrics)

Reads each scripts/.pbp-cache/<cid>.parsed.json's embedded
_rally_count + _touch_count (written by parse_all_pbp.py), recomputes
the tier, and rewrites the JSON in place. No HTML parsing required —
this is purely a label refresh and runs in seconds.

Usage:
  py -X utf8 scripts/retier_pbp.py
"""
from __future__ import annotations

import json
import time
from pathlib import Path

CACHE_DIR = Path("scripts/.pbp-cache")


def classify(rallies: int, touches: int) -> str:
    if rallies == 0:
        return "metadata-only"
    if rallies < 30:
        return "partial"
    avg = touches / rallies
    if avg < 0.5:
        return "terminal-only"
    if avg < 2.5:
        return "partial"
    return "full"


def safe_read_json(path: Path, retries: int = 5, delay: float = 0.4):
    for i in range(retries):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (PermissionError, OSError):
            if i < retries - 1:
                time.sleep(delay)
                continue
            return None
        except json.JSONDecodeError:
            return None
    return None


def safe_write_json(path: Path, obj, retries: int = 5, delay: float = 0.4) -> bool:
    text = json.dumps(obj, separators=(",", ":"))
    for i in range(retries):
        try:
            path.write_text(text, encoding="utf-8")
            return True
        except (PermissionError, OSError):
            if i < retries - 1:
                time.sleep(delay)
                continue
    return False


def main() -> None:
    parsed_files = sorted(CACHE_DIR.glob("*.parsed.json"))
    print(f"[retier] {len(parsed_files):,} parsed files to evaluate")

    counts = {"metadata-only": 0, "terminal-only": 0, "partial": 0, "full": 0}
    rewrites = 0
    no_change = 0
    failures = 0
    moved_from = {"full": 0, "partial": 0, "metadata-only": 0}  # source tier per reclass

    start = time.time()
    for i, path in enumerate(parsed_files, 1):
        parsed = safe_read_json(path)
        if parsed is None:
            failures += 1
            continue
        rallies = parsed.get("_rally_count")
        touches = parsed.get("_touch_count")
        if rallies is None or touches is None:
            # Fall back to recomputing from the sets array
            rallies = touches = 0
            for s in parsed.get("sets", []):
                for r in s.get("rallies", []):
                    rallies += 1
                    touches += len(r.get("touches", []))
            parsed["_rally_count"] = rallies
            parsed["_touch_count"] = touches

        old_tier = parsed.get("_coverage_tier")
        new_tier = classify(rallies, touches)
        counts[new_tier] += 1

        if old_tier != new_tier:
            if old_tier in moved_from:
                moved_from[old_tier] += 1
            parsed["_coverage_tier"] = new_tier
            if safe_write_json(path, parsed):
                rewrites += 1
            else:
                failures += 1
        else:
            no_change += 1

        if i % 500 == 0 or i == len(parsed_files):
            elapsed = time.time() - start
            rate = i / elapsed if elapsed else 0
            print(f"[retier] [{i:>5}/{len(parsed_files)}] "
                  f"full={counts['full']:>4} term-only={counts['terminal-only']:>3} "
                  f"partial={counts['partial']:>3} meta={counts['metadata-only']:>3} "
                  f"rewritten={rewrites} ({rate:.0f}/s)")

    print()
    print(f"[retier] done in {time.time() - start:.1f}s")
    print(f"[retier] total parsed files: {len(parsed_files):,}")
    print(f"[retier] tier distribution AFTER:")
    print(f"             full:           {counts['full']:>5,}")
    print(f"             terminal-only:  {counts['terminal-only']:>5,}")
    print(f"             partial:        {counts['partial']:>5,}")
    print(f"             metadata-only:  {counts['metadata-only']:>5,}")
    print()
    print(f"[retier] tier transitions (old → new):")
    for src, n in moved_from.items():
        if n:
            print(f"             {src} → {{terminal-only|partial|...}}: {n}")
    print(f"[retier] no-change: {no_change}, rewritten: {rewrites}, failures: {failures}")


if __name__ == "__main__":
    main()
