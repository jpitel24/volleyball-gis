"""
reconstruct_pbp_rallies.py
──────────────────────────

Reconstructs a per-rally event stream from cached NCAA play-by-play JSON,
using cached contest-root linescore JSON as the ground-truth validator for
each set's final score.

Input caches (built by fetch_ncaa_api.py):
    scripts/.ncaa-api-cache/<year>/pbp/<gid>.json
    scripts/.ncaa-api-cache/<year>/contest/<gid>.json

Output:
    public/data/wvb_rallies_div1_<year>.csv
      Columns: ContestID, Date, Set, RallyNum, HomeScore, VisitScore,
               Team (scorer short name), EventType, Player

A summary at the end breaks down per-set reconstruction quality:
  · exact    — reconstructed rally count matched linescore total
  · fixed    — overshoot collapsed via consecutive-duplicate dedupe
  · partial  — overshoot couldn't be fully reconciled (logged as best-effort)
  · under    — undershoot; set emitted with flag indicating rally count < final
  · nopbp    — game has linescores but no PBP (hasPbp: false on source)
  · noline   — game has PBP but no linescore (rare; skipped)

Usage:
    python -X utf8 scripts/reconstruct_pbp_rallies.py 2024
    python -X utf8 scripts/reconstruct_pbp_rallies.py 2022 2023 2024 2025
"""

from __future__ import annotations

import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

CACHE_ROOT = Path("scripts/.ncaa-api-cache")
OUTPUT_DIR = Path("public/data")

# A stat-block counts as a scoring rally when any of its plays contains one
# of these terminal-event phrases. Ordered roughly by frequency.
SCORING_RE = re.compile(
    r"\bkill\b|\bservice ace\b|\battack error\b|\bservice error\b"
    r"|\bball handling error\b|\bblock error\b|\breception error\b",
    re.I,
)
# Meta blocks that never represent a rally.
SKIP_RE = re.compile(r"starters:|subs:|timeout|challenge|medical", re.I)


def classify_event(text: str) -> str:
    """Return a short event-type code, or '' for non-scoring."""
    t = text.lower()
    if "service ace" in t:       return "ACE"
    if "first ball kill" in t:   return "KILL"
    if "attack error" in t:      return "ATKERR"
    if "service error" in t:     return "SERR"
    if "ball handling error" in t: return "BHE"
    if "block error" in t:       return "BERR"
    if "reception error" in t:   return "RERR"
    if "kill" in t:              return "KILL"
    return ""


PLAYER_RE = re.compile(r"by\s+([A-Z][^.(,;]+?)(?=\s*(?:\(|\.|$|,|;))")


def extract_player(text: str) -> str:
    """Best-effort extraction of the primary actor's name."""
    m = PLAYER_RE.search(text)
    return m.group(1).strip() if m else ""


def extract_rallies(pbp: dict):
    """
    Walk the PBP periods and yield one record per rally:
        (period_num, team_id, event_type, player, play_text, home_score, visit_score)

    NCAA's PBP feed logs every rally twice (once per team's stat feed), but
    the AUTHORITATIVE subset is the stat-blocks whose first play has a
    non-null homeScore/visitorScore — that's the running scoreboard's own
    rally stream. We use that as the primary path.

    Fallback: for the ~10% of games where no plays carry running scores, we
    dedupe consecutive identical (teamId, playText) stat-blocks and fall back
    to classifying by scoring-keyword text.
    """
    for per in pbp.get("periods", []):
        pn = per.get("periodNumber")
        raw = per.get("playbyplayStats", [])

        # Primary path: stat-blocks whose first play has a running score.
        # These are the authoritative rally events from the scoreboard feed.
        primary_hits = []
        for stat in raw:
            plays = stat.get("plays", [])
            if not plays:
                continue
            pl0 = plays[0]
            if pl0.get("homeScore") is None or pl0.get("visitorScore") is None:
                continue
            tid = str(stat.get("teamId") or "")
            if not tid:
                continue
            text = (pl0.get("playText") or "").strip()
            # Skip meta blocks that happened to carry a score (rare)
            if SKIP_RE.search(text) and not SCORING_RE.search(text):
                continue
            try:
                hs = int(pl0["homeScore"])
                vs = int(pl0["visitorScore"])
            except (TypeError, ValueError, KeyError):
                continue
            primary_hits.append(
                (pn, tid, classify_event(text), extract_player(text),
                 text, hs, vs)
            )

        if primary_hits:
            yield from primary_hits
            continue

        # Fallback: no running scores in this period. Dedupe consecutive
        # duplicate stat-blocks (home-log + visit-log pairs), then classify
        # by scoring-keyword text.
        deduped = []
        last_key = None
        for stat in raw:
            tid = str(stat.get("teamId") or "")
            plays = stat.get("plays", [])
            key = (tid, tuple((pl.get("playText") or "").strip() for pl in plays))
            if key == last_key:
                continue
            deduped.append(stat)
            last_key = key
        for stat in deduped:
            tid = str(stat.get("teamId") or "")
            plays = stat.get("plays", [])
            if not plays or not tid:
                continue
            primary_text = ""
            for pl in plays:
                t = (pl.get("playText") or "").strip()
                if not t or SKIP_RE.search(t):
                    continue
                if SCORING_RE.search(t):
                    primary_text = t
                    break
            if not primary_text:
                continue
            # Scores unknown in fallback; emit sentinels (-1,-1)
            yield (pn, tid, classify_event(primary_text),
                   extract_player(primary_text), primary_text, -1, -1)


def linescore_finals(contest: dict):
    """[(home, visit), ...] per set, or [] if missing."""
    if not contest or not contest.get("contests"):
        return []
    c0 = contest["contests"][0]
    out = []
    for ln in c0.get("linescores") or []:
        try:
            out.append((int(ln.get("home")), int(ln.get("visit"))))
        except (TypeError, ValueError):
            return []
    return out


def dedupe_collapse(rallies, target_count):
    """
    Drop up to (len(rallies) - target_count) consecutive-identical
    (teamId, playText) duplicates. Stops once count == target.
    Returns (new_list, fully_resolved?).
    """
    n_to_drop = len(rallies) - target_count
    if n_to_drop <= 0:
        return rallies, n_to_drop == 0
    out = []
    dropped = 0
    for r in rallies:
        if (dropped < n_to_drop and out
                and (r[1], r[4]) == (out[-1][1], out[-1][4])):
            dropped += 1
            continue
        out.append(r)
    return out, len(out) == target_count


def reconstruct_game(pbp, contest, teams_meta):
    """
    Returns (rally_records, per_set_status) where:
      rally_records = [(set_num, rally_num, home, visit, scorer_tid, event, player, text)]
      per_set_status = [('exact'|'fixed'|'partial'|'under'|'nopbp', reconstructed, expected)]
    """
    finals = linescore_finals(contest)
    if not finals:
        return [], [("noline", 0, 0)]

    if not pbp or not pbp.get("periods"):
        return [], [("nopbp", 0, sum(h + v for h, v in finals))]

    # Determine home_tid
    home_tid = None
    c0 = contest["contests"][0]
    for t in c0.get("teams", []):
        if t.get("isHome"):
            home_tid = str(t["teamId"])
            break
    if home_tid is None:
        return [], [("noline", 0, 0)]

    # Group extracted rallies by period
    by_period: dict[int, list] = {}
    for rec in extract_rallies(pbp):
        by_period.setdefault(rec[0], []).append(rec)

    all_records = []
    statuses = []
    for i, (h_final, v_final) in enumerate(finals, 1):
        expected = h_final + v_final
        raw = by_period.get(i, [])
        actual = len(raw)

        # Detect whether we're on the primary (scored) path or the fallback.
        has_scores = bool(raw) and raw[0][5] >= 0

        if actual == expected:
            status = "exact"; use = raw
        elif actual > expected and not has_scores:
            collapsed, ok = dedupe_collapse(
                [(r[0], r[1], r[2], r[3], r[4]) for r in raw], expected
            )
            # Re-wrap into 7-tuples with sentinel scores
            collapsed = [(c[0], c[1], c[2], c[3], c[4], -1, -1) for c in collapsed]
            if ok:
                status = "fixed"; use = collapsed
            else:
                status = "partial"; use = collapsed
        elif actual > expected:
            # Primary path overshoot is rare; keep as partial, don't dedupe
            status = "partial"; use = raw
        else:
            status = "under"; use = raw

        statuses.append((status, len(use), expected))

        # Running scores: use authoritative from primary path; infer on fallback
        h = v = 0
        for rn, rec in enumerate(use, 1):
            _, tid, ev, player, text, hs_auth, vs_auth = rec
            if hs_auth >= 0:
                h, v = hs_auth, vs_auth
            else:
                if tid == home_tid: h += 1
                else: v += 1
            all_records.append((i, rn, h, v, tid, ev, player, text))

    return all_records, statuses


def reconstruct_year(year: int):
    print(f"═══ Reconstruct rallies {year} ═══")
    cache = CACHE_ROOT / str(year)
    pbp_dir     = cache / "pbp"
    contest_dir = cache / "contest"
    contest_files = sorted(contest_dir.glob("[0-9]*.json"))
    print(f"  {len(contest_files)} contests to process")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"wvb_rallies_div1_{year}.csv"

    tally = Counter()
    games_emitted = 0
    rows_emitted = 0

    with out_path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["ContestID", "Date", "Set", "RallyNum",
                    "HomeScore", "VisitScore", "ScorerTeamID",
                    "EventType", "Player", "PlayText"])

        # Map gid → date via cached _gameids.json
        ids_path = cache / "_gameids.json"
        date_map = json.loads(ids_path.read_text(encoding="utf-8")) if ids_path.exists() else {}
        id_to_date = {g: d for d, gs in date_map.items() for g in gs}

        for i, cf in enumerate(contest_files):
            gid = cf.stem
            try:
                contest = json.loads(cf.read_text(encoding="utf-8"))
            except Exception:
                tally["noline"] += 1
                continue
            pbp_file = pbp_dir / f"{gid}.json"
            try:
                pbp = json.loads(pbp_file.read_text(encoding="utf-8")) if pbp_file.exists() else None
            except Exception:
                pbp = None

            # Pre-index team metadata (not strictly needed here but handy)
            teams_meta = {str(t["teamId"]): t for t in contest.get("contests", [{}])[0].get("teams", [])}

            records, statuses = reconstruct_game(pbp, contest, teams_meta)
            for s, _r, _e in statuses:
                tally[s] += 1

            if records:
                games_emitted += 1
                date = id_to_date.get(gid, "")
                for (set_num, rn, h, v, tid, ev, player, text) in records:
                    w.writerow([gid, date, set_num, rn, h, v, tid, ev, player, text])
                    rows_emitted += 1

            if (i + 1) % 1000 == 0:
                print(f"    {i+1}/{len(contest_files)} games processed · "
                      f"{rows_emitted:,} rally rows so far")

    # Summary
    total_sets = sum(tally.values())
    print(f"\n  Games with rallies emitted: {games_emitted:,}")
    print(f"  Rally rows written:         {rows_emitted:,}")
    print(f"  Output: {out_path}")
    print(f"\n  Per-set reconstruction quality ({total_sets:,} sets/games):")
    for k in ("exact", "fixed", "partial", "under", "nopbp", "noline"):
        c = tally.get(k, 0)
        if c:
            print(f"    {k:8} {c:6,}  ({c/total_sets*100:5.2f}%)")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for y in [int(x) for x in sys.argv[1:]]:
        reconstruct_year(y)


if __name__ == "__main__":
    main()
