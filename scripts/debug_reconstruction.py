"""Distribution of rally-count diffs across all games in a year."""
from __future__ import annotations
import json
import sys
from pathlib import Path
from collections import Counter

sys.path.insert(0, "scripts")
from reconstruct_pbp_rallies import (
    extract_rallies, linescore_finals, CACHE_ROOT
)

year = int(sys.argv[1]) if len(sys.argv) > 1 else 2022
cache = CACHE_ROOT / str(year)
contest_files = sorted((cache / "contest").glob("[0-9]*.json"))

diff_hist = Counter()
n_sets = 0
for cf in contest_files:
    gid = cf.stem
    contest = json.loads(cf.read_text(encoding="utf-8"))
    finals = linescore_finals(contest)
    if not finals: continue
    pbp_file = cache / "pbp" / f"{gid}.json"
    if not pbp_file.exists(): continue
    try:
        pbp = json.loads(pbp_file.read_text(encoding="utf-8"))
    except Exception:
        continue

    per_period_counts = Counter()
    for rec in extract_rallies(pbp):
        per_period_counts[rec[0]] += 1
    for i, (h,v) in enumerate(finals, 1):
        recon = per_period_counts.get(i, 0)
        exp = h + v
        diff = recon - exp
        # bucket extreme diffs
        if diff < -5: bucket = "<-5"
        elif diff > 5: bucket = ">+5"
        else: bucket = str(diff) if diff < 0 else (f"+{diff}" if diff > 0 else "0")
        diff_hist[bucket] += 1
        n_sets += 1

print(f"Year {year}: {n_sets} sets across {len(contest_files)} games")
print(f"{'diff':>6}  {'count':>6}  {'%':>6}")
order = ["<-5","-5","-4","-3","-2","-1","0","+1","+2","+3","+4","+5",">+5"]
for k in order:
    c = diff_hist.get(k, 0)
    pct = c/n_sets*100 if n_sets else 0
    print(f"{k:>6}  {c:>6}  {pct:>5.2f}%")
