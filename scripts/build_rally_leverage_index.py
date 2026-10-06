"""
build_rally_leverage_index.py
─────────────────────────────

Aggregates the per-rally Leverage column in wvb_rallies_div1_<year>.csv into
a per-(ContestID, ScorerTeamID, Player) mean-leverage index, normalized by
the dataset-wide mean rally leverage so the resulting multiplier is ≈1.0
for an average-leverage player-match.

This is the raw material for replacing the 3-layer heuristic in
build_gis_plus.py with WP-based leverage.

Output: public/data/rally_leverage_index_<year>.json
  {
    "<contest_id>": {
      "<team_id>": {
        "<player_lower>": {"n": <events>, "mean_lev": <float>, "mult": <float>}
      }
    },
    "_meta": {"grand_mean_lev": <float>, "n_events": <int>}
  }

Players with fewer than MIN_EVENTS terminal events get mult=1.0 (insufficient
sample to claim clutch credit/blame).

Usage:
    python -X utf8 scripts/build_rally_leverage_index.py 2022 2023 2024 2025
"""

from __future__ import annotations

import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path("public/data")
CACHE_ROOT = Path("scripts/.ncaa-api-cache")
MIN_EVENTS = 3  # need at least 3 terminal events to assign a clutch multiplier

# Two NCAA PBP text formats exist across seasons:
#   2022/2023:  "Kill by Grote, Lydia (from Shaffmaster, Melani)."
#   2024/2025:  "Kill by Avry Tatum (from Camryn Haworth)."
#
# In the 2022/2023 form the rally CSV's Player column captures only the last
# name ("Grote"); we need the full name. In the 2024/2025 form the Player
# column is already the full name — trust it verbatim.
#
# We MUST anchor to the FIRST `by ` in the text (before any `(`), otherwise
# the regex backtracks into parentheticals like "(block by Mack, Sabrina)"
# and grabs the wrong players.
FIRST_BY_RE = re.compile(
    r"^[^()]*?\bby\s+([A-Z][^,()]+?),\s*([A-Z][^.(;,]+?)(?=\s*(?:\(|\.|;|$))"
)


def extract_full_name(play_text: str, fallback: str) -> str:
    """
    If fallback (rally CSV's Player column) already contains a space, it is
    the full name as-logged (2024/2025 format). Return it unchanged.

    Otherwise (2022/2023 format, last-name only) parse "Lastname, Firstname"
    from the first `by NAME` span in play_text.
    """
    fb = (fallback or "").strip()
    if " " in fb:
        return fb
    if not play_text:
        return fb
    m = FIRST_BY_RE.search(play_text)
    if not m:
        return fb
    last = m.group(1).strip()
    first = m.group(2).strip()
    return f"{first} {last}"


def _norm_team(name: str) -> str:
    return (name or "").lower().replace(" ", "_")


def synthetic_ids_for_contest(contest_json: dict, date_iso: str) -> list[str]:
    """
    Build the synthetic contest-IDs that gis_observations.csv uses, covering
    both possible home/away orderings plus alpha-sorted (for neutral-site
    ambiguity). Returns a list so the caller can emit every alias.
    """
    c0 = (contest_json.get("contests") or [{}])[0]
    teams = c0.get("teams") or []
    home = away = None
    for t in teams:
        n = t.get("nameShort") or t.get("nameFull") or ""
        if t.get("isHome"):
            home = n
        else:
            away = n
    if not home or not away:
        return []
    h = _norm_team(home)
    a = _norm_team(away)
    d = date_iso.replace("/", "-")
    ids = {f"{d}_{a}_{h}", f"{d}_{h}_{a}"}  # home-away flip
    pair = sorted([h, a])
    ids.add(f"{d}_{pair[0]}_{pair[1]}")  # alpha (neutral-site fallback)
    return list(ids)


def build_gid_to_synth_map(year: int) -> dict[str, list[str]]:
    """Read cached contest JSONs and return {ncaa_gid: [synthetic_ids...]}."""
    out: dict[str, list[str]] = {}
    contest_dir = CACHE_ROOT / str(year) / "contest"
    ids_path = CACHE_ROOT / str(year) / "_gameids.json"
    if not ids_path.exists():
        print(f"    WARN: {ids_path} missing — synthetic-id mapping will be empty")
        return out
    date_map_raw = json.loads(ids_path.read_text(encoding="utf-8"))
    gid_to_date = {g: d for d, gids in date_map_raw.items() for g in gids}

    for cf in contest_dir.glob("[0-9]*.json"):
        gid = cf.stem
        date_iso = gid_to_date.get(gid)
        if not date_iso:
            continue
        try:
            j = json.loads(cf.read_text(encoding="utf-8"))
        except Exception:
            continue
        syn = synthetic_ids_for_contest(j, date_iso)
        if syn:
            out[gid] = syn
    return out


def process_year(year: int):
    path = DATA_DIR / f"wvb_rallies_div1_{year}.csv"
    if not path.exists():
        print(f"  [skip] {path} not found")
        return

    # Build ncaa_gid → [synthetic_ids...] map so the index is keyed the way
    # gis_observations.csv expects.
    print(f"    building gid→synthetic-id map …")
    gid_to_syn = build_gid_to_synth_map(year)
    print(f"    mapped {len(gid_to_syn):,} contests to synthetic IDs")

    # Pass 1: compute grand-mean leverage across all rallies.
    # Aggregate each player's events by (contest, player) — ScorerTeamID is
    # the rally-WINNING team, which splits a single player's events into two
    # buckets (kills under own team, errors under opponent), so we ignore it.
    total_lev = 0.0
    n_rows = 0
    n_unmapped_contests = 0
    unmapped_gids = set()
    # key: (ncaa_gid, player_lower) → [lev_sum, count]
    per_player = defaultdict(lambda: [0.0, 0])

    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            lev = float(row.get("Leverage") or 0.0)
            total_lev += lev
            n_rows += 1
            player_raw = extract_full_name(
                row.get("PlayText") or "",
                row.get("Player") or "",
            )
            player = player_raw.strip().lower()
            if not player:
                continue
            gid = row["ContestID"]
            if gid not in gid_to_syn:
                if gid not in unmapped_gids:
                    unmapped_gids.add(gid)
                    n_unmapped_contests += 1
                continue
            key = (gid, player)
            per_player[key][0] += lev
            per_player[key][1] += 1
    if n_unmapped_contests:
        print(f"    WARN: {n_unmapped_contests:,} contests had no synthetic-id map entry")

    grand_mean = total_lev / n_rows if n_rows else 0.0
    print(f"  {year}: {n_rows:,} rallies · grand-mean leverage = {grand_mean:.4f}")

    # Pass 2: flatten to {synthetic_id: {player: mult}} for GIS+ consumption,
    # emitting an entry for EVERY synthetic-id alias so both home/away orders
    # and the alpha-sorted neutral form all resolve.
    index: dict = {}
    multipliers = []
    for (gid, player), (lev_sum, n) in per_player.items():
        mean_lev = lev_sum / n
        if n >= MIN_EVENTS and grand_mean > 0:
            mult = mean_lev / grand_mean
        else:
            mult = 1.0
        multipliers.append(mult)
        entry = {"n": n, "mean_lev": round(mean_lev, 5), "mult": round(mult, 4)}
        # Key by NCAA numeric gid so rows whose ContestID preserves the upstream
        # numeric ID (post two-sided rebuild) still resolve.
        index.setdefault(gid, {})[player] = entry
        for syn in gid_to_syn.get(gid, []):
            index.setdefault(syn, {})[player] = entry

    index["_meta"] = {
        "grand_mean_lev": round(grand_mean, 5),
        "n_rallies": n_rows,
        "n_player_matches": len(per_player),
        "min_events_for_mult": MIN_EVENTS,
    }

    out = DATA_DIR / f"rally_leverage_index_{year}.json"
    out.write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    size_kb = out.stat().st_size / 1024
    print(f"       wrote {out.name} · {size_kb:.0f} KB · {len(per_player):,} player-matches")

    # Distribution summary
    if multipliers:
        multipliers.sort()
        n = len(multipliers)
        p = lambda q: multipliers[int(n * q)]
        print(f"       multiplier distribution:"
              f"  p05={p(0.05):.2f}  p25={p(0.25):.2f}  p50={p(0.50):.2f}"
              f"  p75={p(0.75):.2f}  p95={p(0.95):.2f}  max={max(multipliers):.2f}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for y in [int(x) for x in sys.argv[1:]]:
        process_year(y)


if __name__ == "__main__":
    main()
