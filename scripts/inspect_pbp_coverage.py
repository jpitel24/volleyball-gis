"""
inspect_pbp_coverage.py — sanity-check the tier classifier with real data.

Walks every scripts/.pbp-cache/*.parsed.json and reports:

  1. Distribution of touches-per-rally bucketed (validates that "full"
     really has 4-7 touches/rally and isn't hiding terminal-only
     matches mis-classified as full).
  2. Per-action mix across all touches (confirms we're seeing SERVE,
     RECEPTION, SET, ATTACK, DIG in roughly the proportions volleyball
     actually produces; if we're really terminal-only-with-misclass,
     we'd see only KILL/ACE/ATKERR/etc.).
  3. Sample matches at the low end of touches/rally for hand-inspection.
  4. A few example rallies from a "full" match showing actual sequence.

Read-only. Doesn't modify anything. Use to validate or refute the
tier counts.

Usage:
  py -X utf8 scripts/inspect_pbp_coverage.py
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

CACHE_DIR = Path("scripts/.pbp-cache")


def main() -> None:
    files = sorted(CACHE_DIR.glob("*.parsed.json"))
    print(f"[inspect] loading {len(files):,} parsed files ...")

    # Per-match aggregate stats
    per_match: list[tuple[str, int, int, float, str]] = []
    # cross-match totals
    total_rallies = total_touches = total_terminals = 0
    action_counter: Counter[str] = Counter()
    terminal_counter: Counter[str] = Counter()
    unknown_terminal_texts: list[tuple[str, str, str]] = []
    bucket_counts = {
        "rallies==0":      0,
        "0 <= avg < 0.5":  0,
        "0.5 <= avg < 2":  0,
        "2 <= avg < 4":    0,
        "4 <= avg < 6":    0,
        "6 <= avg < 8":    0,
        "8 <= avg":        0,
    }

    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        cid = d.get("contestId", f.stem)
        home = d.get("homeTeam") or "?"
        away = d.get("awayTeam") or "?"
        rallies = touches = terminals = 0
        for s in d.get("sets", []):
            for r in s.get("rallies", []):
                rallies += 1
                ts = r.get("touches", []) or []
                touches += len(ts)
                for t in ts:
                    action_counter[t.get("action", "?")] += 1
                if r.get("result"):
                    terminals += 1
                    ttype = r["result"].get("type") or "UNKNOWN"
                    terminal_counter[ttype] += 1
                    # For UNKNOWN terminals, capture the raw text for inspection.
                    if ttype == "UNKNOWN":
                        unknown_terminal_texts.append(
                            (cid, r.get("rallyId"), r["result"].get("rawText", ""))
                        )
        avg = (touches / rallies) if rallies else 0.0
        per_match.append((cid, rallies, touches, avg, f"{home} vs {away}"))
        total_rallies += rallies
        total_touches += touches
        total_terminals += terminals
        # bucket
        if rallies == 0:
            bucket_counts["rallies==0"] += 1
        elif avg < 0.5:
            bucket_counts["0 <= avg < 0.5"] += 1
        elif avg < 2:
            bucket_counts["0.5 <= avg < 2"] += 1
        elif avg < 4:
            bucket_counts["2 <= avg < 4"] += 1
        elif avg < 6:
            bucket_counts["4 <= avg < 6"] += 1
        elif avg < 8:
            bucket_counts["6 <= avg < 8"] += 1
        else:
            bucket_counts["8 <= avg"] += 1

    print()
    print("=== Touches-per-rally distribution (across all matches) ===")
    for k, v in bucket_counts.items():
        bar = "█" * int(v / 50) if v > 0 else ""
        print(f"  {k:<20} {v:>5}  {bar}")

    print()
    print("=== Cross-match totals ===")
    print(f"  matches:           {len(files):>7,}")
    print(f"  rallies (sum):     {total_rallies:>7,}")
    print(f"  non-terminal touches (sum):  {total_touches:>10,}")
    print(f"  terminal events (sum):       {total_terminals:>10,}")
    print(f"  global avg touches/rally:    {total_touches / max(total_rallies, 1):.2f}")

    print()
    print("=== Non-terminal touch action mix ===")
    total_a = sum(action_counter.values())
    for action, n in action_counter.most_common():
        pct = 100 * n / total_a if total_a else 0
        print(f"  {action:<15} {n:>9,}  ({pct:.1f}%)")

    print()
    print("=== Terminal event mix ===")
    total_t = sum(terminal_counter.values())
    for ttype, n in terminal_counter.most_common():
        pct = 100 * n / total_t if total_t else 0
        label = ttype if ttype else "UNKNOWN"
        print(f"  {label:<20} {n:>9,}  ({pct:.1f}%)")

    if unknown_terminal_texts:
        print()
        print(f"=== UNKNOWN terminal samples ({len(unknown_terminal_texts):,} total) ===")
        # Show distinct raw-text patterns (up to 20)
        seen = set()
        for cid, rid, raw in unknown_terminal_texts:
            # Normalize player names so we see distinct templates
            import re as _re
            norm = _re.sub(r"\b[A-Z][a-z]+(?:[-' ][A-Z][a-z]+)+\b", "<NAME>", raw)
            norm = _re.sub(r"\b[A-Z][a-z]+\b", "<NAME>", norm)
            if norm not in seen:
                seen.add(norm)
                print(f"  contest={cid}  rallyId={rid}")
                print(f"    raw: {raw!r}")
                print(f"    norm: {norm!r}")
                if len(seen) >= 20:
                    break

    print()
    print("=== Lowest 10 matches by avg touches/rally (excluding 0-rally) ===")
    nonzero = [m for m in per_match if m[1] > 0]
    nonzero.sort(key=lambda m: m[3])
    for cid, rallies, touches, avg, label in nonzero[:10]:
        print(f"  {cid}  rallies={rallies:>3}  touches={touches:>4}  avg={avg:.2f}  {label}")

    print()
    print("=== Sample full-PBP rally sequence (random 'full' match) ===")
    full_matches = [m for m in per_match if m[3] >= 4]
    if full_matches:
        # Pick the median match for a representative example
        full_matches.sort(key=lambda m: m[3])
        sample = full_matches[len(full_matches) // 2]
        cid = sample[0]
        sample_path = CACHE_DIR / f"{cid}.parsed.json"
        d = json.loads(sample_path.read_text(encoding="utf-8"))
        print(f"  Showing match {cid}: {sample[4]}")
        # Print the first 2 rallies of set 1
        for s in d.get("sets", [])[:1]:
            for r in s.get("rallies", [])[:3]:
                print(f"  Rally {r.get('rallyId')} (set {s.get('setNum')}, "
                      f"score {r.get('scoreAfter')}, winner: {r.get('winnerSide')}):")
                for t in r.get("touches", []):
                    print(f"    {t.get('team'):<5} {t.get('action'):<14} {t.get('player')}")
                if r.get("result"):
                    res = r["result"]
                    print(f"    [TERMINAL] {res.get('team')} → {res.get('type')} by "
                          f"{res.get('primary')}")


if __name__ == "__main__":
    main()
