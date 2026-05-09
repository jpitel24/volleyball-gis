"""
build_pbp_coverage.py — per-match coverage manifest for the app.

Walks scripts/.pbp-cache/*.parsed.json and emits a small JSON file
that the React app reads to drive the "Limited PBP" / "Full PBP"
flag in the Game Browser, Player Browser game log, etc.

Output:
  public/data/match_pbp_coverage.json

Schema:
  {
    "<contestId>": {
      "tier":        "full" | "terminal-only" | "partial" | "metadata-only",
      "rallies":     <int>,
      "touches":     <int>,
      "homeTeam":    "<name>",
      "awayTeam":    "<name>"
    },
    ...
  }

Size estimate: ~5,000 matches × ~150 bytes/entry ≈ 750 KB raw,
~120 KB gzipped. Vercel serves it with brotli; well under the
budget for app-side data.

Usage:
  py -X utf8 scripts/build_pbp_coverage.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

CACHE_DIR = Path("scripts/.pbp-cache")
OUT_PATH  = Path("public/data/match_pbp_coverage.json")


def safe_read_json(path: Path, retries: int = 5, delay: float = 0.4):
    for _ in range(retries):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (PermissionError, OSError):
            time.sleep(delay)
        except json.JSONDecodeError:
            return None
    return None


def main() -> None:
    parsed_files = sorted(CACHE_DIR.glob("*.parsed.json"))
    print(f"[coverage] reading {len(parsed_files):,} parsed files")

    out: dict[str, dict] = {}
    tier_counts = {"full": 0, "terminal-only": 0, "partial": 0, "metadata-only": 0}

    for f in parsed_files:
        d = safe_read_json(f)
        if d is None:
            continue
        cid = str(d.get("contestId") or f.stem)
        tier = d.get("_coverage_tier") or "unknown"
        rallies = int(d.get("_rally_count") or 0)
        touches = int(d.get("_touch_count") or 0)
        out[cid] = {
            "tier":     tier,
            "rallies":  rallies,
            "touches":  touches,
            "homeTeam": d.get("homeTeam"),
            "awayTeam": d.get("awayTeam"),
        }
        tier_counts[tier] = tier_counts.get(tier, 0) + 1

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")

    size_kb = OUT_PATH.stat().st_size / 1024
    print()
    print(f"[coverage] wrote {OUT_PATH} ({size_kb:,.1f} KB)")
    print(f"[coverage] {len(out):,} matches")
    for tier, n in tier_counts.items():
        if n:
            print(f"             {tier:<14} {n:>5,}")


if __name__ == "__main__":
    main()
