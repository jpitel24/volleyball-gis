#!/usr/bin/env python3
"""
build_match_context.py

Reads NCAA D1 women's volleyball PBP CSV files (2021–2025) and produces
public/data/match_context.json — a per-contest, per-player breakdown of
serve attempts, receive attempts, score-state events, and set results.

Usage:
    python scripts/build_match_context.py [--pbp-dir PATH] [--years 2021,2025]

    --pbp-dir   Directory containing wvb_pbp_div1_{year}.csv files
                (default: C:/Users/gordo/Downloads)
    --years     Comma-separated subset of years to process
                (default: 2021,2022,2023,2024,2025)

Input file names expected in --pbp-dir:
    wvb_pbp_div1_2021.csv  …  wvb_pbp_div1_2025.csv

PBP CSV columns:
    2021–2024:  date, set, away_team, home_team, score, team, event, player, description
    2025:       date, contestid, set, away_team, home_team, score, team, event, player, description

Output:
    public/data/match_context.json

Schema:
    {
      "<contest_id>": {
        "<player_name>": {
          "team": "Team Name",
          "set_attempts": <int>,           # count of Set events (setter actions)
          "serve_attempts": [
            { "set": <int>, "score": "<away>-<home>", "immediate_point": <bool> }
            ...
          ],
          "receive_attempts": [
            { "set": <int>, "score": "<away>-<home>", "immediate_point": <bool> }
            ...
          ],
          "score_state_events": [
            { "set": <int>, "score": "<away>-<home>", "event": "<canonical>" }
            ...
          ],
          "sets_detail": [
            { "set": <int>, "winner": "Team Name", "score": "<away>-<home>" }
            ...
          ]
        }
      }
    }

Notes:
  - serve_attempts.immediate_point: True when the serving team scores a point
    within 4 events of the serve — covers aces, shank-recoveries, and
    out-of-system forced blocks (full serve→opp-receive→opp-set→opp-attack→
    our-block chain).
  - receive_attempts.immediate_point: True when the receiving team scores a
    point within 2 events of the reception.
  - score_state_events captures: Kill, First ball kill → "Kill";
    Ace → "Ace"; Block / Block point (scoring only) → "Block";
    Set → "Assist"; Dig → "Dig"; Reception → "Reception".
  - sets_detail is match-level and identical across all players in a contest.
  - contest_id: the numeric contestid from the CSV for 2025; a synthetic
    "<date>_<away>_<home>" slug for 2021–2024 (which lack a contestid column).
  - Multi-player block rows (e.g. "Alice, Bob") are attributed to each player.
  - All five seasons are merged into one combined output file.
"""

import csv
import json
import sys
import argparse
from pathlib import Path
from collections import defaultdict

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR   = SCRIPT_DIR.parent / "public" / "data"
OUT_PATH   = DATA_DIR / "match_context.json"
CACHE_ROOT = SCRIPT_DIR / ".ncaa-api-cache"

ALL_YEARS  = [2021, 2022, 2023, 2024, 2025]

# ── Event mapping ─────────────────────────────────────────────────────────────
# PBP event name → canonical score_state_events label
# Only events in this map are recorded in score_state_events.
# Blocks are handled specially (only when the score changes = actual block point).
EVENT_MAP = {
    "Kill":            "Kill",
    "First ball kill": "Kill",
    "Ace":             "Ace",
    "Block":           "Block",       # recorded only on scoring event
    "Block point":     "Block",       # recorded only on scoring event
    "Set":             "Assist",
    "Dig":             "Dig",
    "Reception":       "Reception",
}

BLOCK_EVENTS   = {"Block", "Block point"}
SERVE_EVENTS   = {"Serve"}
RECEIVE_EVENTS = {"Reception"}

# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_score(score_str):
    """'12-10' → (12, 10).  Returns (0, 0) on parse failure."""
    try:
        a, h = score_str.split("-", 1)
        return int(a), int(h)
    except Exception:
        return 0, 0


def make_contest_id(date, away_team, home_team):
    """
    Synthetic contest_id for years without a native contestid column.
    Format: YYYY-MM-DD_away_team_home_team  (lowercase, spaces→underscores)
    """
    d = date.replace("/", "-")
    a = away_team.lower().replace(" ", "_").replace("/", "_")
    h = home_team.lower().replace(" ", "_").replace("/", "_")
    return f"{d}_{a}_{h}"


def split_players(player_str):
    """
    Split potentially multi-player strings like 'Alice Smith, Bob Jones'
    (block assist rows) into a list of individual names.
    """
    return [p.strip() for p in player_str.split(",") if p.strip()]


def init_player(team):
    return {
        "team":              team,
        "set_attempts":      0,
        "serve_attempts":    [],
        "receive_attempts":  [],
        "score_state_events": [],
        "sets_detail":       [],  # filled in after full contest is processed
    }


# ── Rally builder ─────────────────────────────────────────────────────────────

def build_rallies(set_events):
    """
    Split a flat, ordered list of events for one set into individual rallies.

    A rally begins at a Serve event and ends when the score changes.
    Each entry in the returned list is a list of event dicts for that rally.
    The scoring event (where the score first changes) is the last element.
    """
    rallies  = []
    current  = []
    prev_score = None

    for ev in set_events:
        if ev["event"] == "Serve":
            # Flush any unfinished rally (edge case: back-to-back serves with
            # no recorded scoring event, e.g. a substitution row mid-rally)
            if current:
                rallies.append(current)
            current    = [ev]
            prev_score = ev["score"]
        else:
            current.append(ev)
            score_changed = (prev_score is not None and ev["score"] != prev_score)
            if score_changed and current:
                rallies.append(current)
                current    = []
                prev_score = ev["score"]
                continue
            prev_score = ev["score"]

    if current:
        rallies.append(current)

    return rallies


# ── Rally processor ───────────────────────────────────────────────────────────

def process_rally(rally, away_team, home_team, players):
    """
    Update the `players` dict in-place with all relevant actions from one rally.

    players: { player_name → player_data_dict }  (initialised lazily)
    """
    if not rally:
        return

    set_num = rally[0]["set"]

    # Locate the scoring event: first row where score changes from previous row.
    scoring_idx  = None
    scoring_ev   = None
    scoring_team = None

    for i in range(1, len(rally)):
        if rally[i]["score"] != rally[i - 1]["score"]:
            scoring_idx = i
            scoring_ev  = rally[i]
            # Determine which team's score increased
            prev_a, prev_h = parse_score(rally[i - 1]["score"])
            curr_a, curr_h = parse_score(rally[i]["score"])
            if curr_a > prev_a:
                scoring_team = away_team
            elif curr_h > prev_h:
                scoring_team = home_team
            break

    # ── Process each event in the rally ──────────────────────────────────────
    for i, ev in enumerate(rally):
        ev_type   = ev["event"]
        ev_score  = ev["score"]
        ev_team   = ev["team"]
        raw_player = ev["player"]

        if not raw_player:
            continue

        pnames = split_players(raw_player)

        for pname in pnames:
            if not pname:
                continue

            # Lazy-init player record
            if pname not in players:
                players[pname] = init_player(ev_team)

            p = players[pname]

            # ── set_attempts (setter actions) ─────────────────────────────
            if ev_type == "Set":
                p["set_attempts"] += 1

            # ── serve_attempts ────────────────────────────────────────────
            if ev_type in SERVE_EVENTS:
                imm = False
                if scoring_ev is not None and scoring_team == ev_team:
                    # immediate_point: serving team scores within ≤ 4 events.
                    # Covers: serve → opp receive → opp set → opp attack → our
                    # block/dig-kill. Captures aces all the way through to
                    # out-of-system forced-block points — all reasonably
                    # credited to a tough serve.
                    events_after_serve = scoring_idx - i
                    imm = events_after_serve <= 4
                p["serve_attempts"].append({
                    "set":             set_num,
                    "score":           ev_score,
                    "immediate_point": imm,
                })

            # ── receive_attempts ──────────────────────────────────────────
            if ev_type in RECEIVE_EVENTS:
                imm = False
                if scoring_ev is not None and scoring_team == ev_team:
                    # immediate_point: receiving team scores within ≤ 2 events
                    # after the reception
                    events_after_recv = scoring_idx - i
                    imm = events_after_recv <= 2
                p["receive_attempts"].append({
                    "set":             set_num,
                    "score":           ev_score,
                    "immediate_point": imm,
                })

            # ── score_state_events ────────────────────────────────────────
            canonical = EVENT_MAP.get(ev_type)
            if canonical:
                if canonical == "Block":
                    # Only record block when it is the actual scoring event
                    if scoring_ev is not None and ev is scoring_ev:
                        p["score_state_events"].append({
                            "set":   set_num,
                            "score": ev_score,
                            "event": canonical,
                        })
                else:
                    p["score_state_events"].append({
                        "set":   set_num,
                        "score": ev_score,
                        "event": canonical,
                    })


# ── Contest processor ─────────────────────────────────────────────────────────

def process_contest(contest_events, away_team, home_team):
    """
    Process all PBP events for a single contest.

    Returns: { player_name → player_data } with sets_detail populated.
    """
    players = {}

    # ── Derive sets_detail from score progression ─────────────────────────────
    # Track the maximum total-point score seen in each set (proxy for final score)
    set_finals = {}
    for ev in contest_events:
        sn = ev["set"]
        sc = parse_score(ev["score"])
        prev = set_finals.get(sn)
        if prev is None or sum(sc) >= sum(parse_score(prev)):
            set_finals[sn] = ev["score"]

    sets_detail = []
    for sn in sorted(set_finals.keys()):
        away_s, home_s = parse_score(set_finals[sn])
        winner = home_team if home_s > away_s else away_team
        sets_detail.append({
            "set":    sn,
            "winner": winner,
            "score":  f"{away_s}-{home_s}",
        })

    # ── Process rallies per set ───────────────────────────────────────────────
    by_set = defaultdict(list)
    for ev in contest_events:
        by_set[ev["set"]].append(ev)

    for sn in sorted(by_set.keys()):
        rallies = build_rallies(by_set[sn])
        for rally in rallies:
            process_rally(rally, away_team, home_team, players)

    # Attach sets_detail (match-level, identical for all players in contest)
    for pdata in players.values():
        pdata["sets_detail"] = sets_detail

    return players


# ── Main pipeline ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Build match_context.json from PBP CSV files."
    )
    parser.add_argument(
        "--pbp-dir",
        default="C:/Users/gordo/Downloads",
        help="Directory containing wvb_pbp_div1_YEAR.csv files",
    )
    parser.add_argument(
        "--years",
        default=None,
        help="Comma-separated years to process (default: all five seasons)",
    )
    args = parser.parse_args()

    pbp_dir = Path(args.pbp_dir)
    target_years = (
        [int(y.strip()) for y in args.years.split(",")]
        if args.years
        else ALL_YEARS
    )

    output = {}         # contest_id → { player_name → player_data }
    total_contests = 0

    for year in target_years:
        fpath = pbp_dir / f"wvb_pbp_div1_{year}.csv"
        if not fpath.exists():
            print(f"  WARNING: {fpath} not found — skipping {year}", file=sys.stderr)
            continue

        print(f"Processing {year} ({fpath.name})…")
        has_contestid = (year == 2025)

        # Stream through the CSV one contest at a time to minimise memory use.
        # Contests are ordered in the file so we can flush on ID change.
        current_cid    = None
        current_events = []
        current_away   = None
        current_home   = None
        contest_count  = 0

        with open(fpath, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # ── Parse row ─────────────────────────────────────────────
                date      = row.get("date", "").strip()
                away_team = row.get("away_team", "").strip()
                home_team = row.get("home_team", "").strip()
                event     = row.get("event", "").strip()
                player    = row.get("player", "").strip()
                score     = row.get("score", "").strip()
                set_raw   = row.get("set", "0").strip()

                # Skip blank or clearly malformed rows
                if not date or not event or not away_team or not home_team:
                    continue

                # Derive contest_id
                if has_contestid:
                    cid = row.get("contestid", "").strip()
                    if not cid:
                        cid = make_contest_id(date, away_team, home_team)
                else:
                    cid = make_contest_id(date, away_team, home_team)

                # Parse set number
                try:
                    set_num = int(set_raw)
                except ValueError:
                    set_num = 0

                ev = {
                    "set":    set_num,
                    "score":  score,
                    "team":   row.get("team", "").strip(),
                    "event":  event,
                    "player": player,
                }

                # ── Contest boundary ──────────────────────────────────────
                if cid != current_cid:
                    # Process and flush previous contest
                    if current_cid and current_events:
                        result = process_contest(
                            current_events, current_away, current_home
                        )
                        if result:
                            output[current_cid] = result
                            contest_count += 1
                            if contest_count % 500 == 0:
                                print(f"    …{contest_count} contests processed")

                    current_cid    = cid
                    current_events = []
                    current_away   = away_team
                    current_home   = home_team

                current_events.append(ev)

        # Flush last contest
        if current_cid and current_events:
            result = process_contest(current_events, current_away, current_home)
            if result:
                output[current_cid] = result
                contest_count += 1

        print(f"  {year}: {contest_count} contests")
        total_contests += contest_count

    # ── Alias synthetic contest_ids to NCAA numeric gids ─────────────────────
    # Post-two-sided-rebuild, gis_observations.csv uses numeric NCAA contest IDs
    # (e.g. '6176032') for 2022-2024 rather than the synthetic
    # '<date>_<away>_<home>' slugs built above. Reuse the cached contest JSONs
    # (scripts/.ncaa-api-cache/<year>/contest/<gid>.json + _gameids.json) to
    # duplicate each synthetic entry under its NCAA gid so the downstream
    # lookup hits.
    print("\nAliasing synthetic IDs to NCAA numeric gids …")
    n_alias = 0
    for year in target_years:
        if year == 2025:
            continue  # 2025 already uses native contestid
        contest_dir = CACHE_ROOT / str(year) / "contest"
        ids_path = CACHE_ROOT / str(year) / "_gameids.json"
        if not ids_path.exists() or not contest_dir.exists():
            print(f"  [{year}] cache missing — skipping alias pass")
            continue
        date_map_raw = json.loads(ids_path.read_text(encoding="utf-8"))
        gid_to_date = {g: d for d, gids in date_map_raw.items() for g in gids}
        for cf in contest_dir.glob("[0-9]*.json"):
            gid = cf.stem
            date_iso = gid_to_date.get(gid)
            if not date_iso:
                continue
            try:
                cj = json.loads(cf.read_text(encoding="utf-8"))
            except Exception:
                continue
            c0 = (cj.get("contests") or [{}])[0]
            teams = c0.get("teams") or []
            home = away = None
            for t in teams:
                n = t.get("nameShort") or t.get("nameFull") or ""
                if t.get("isHome"):
                    home = n
                else:
                    away = n
            if not home or not away:
                continue
            # PBP CSV dates are MM-DD-YYYY; cache is YYYY-MM-DD. Try both.
            d_iso = date_iso.replace("/", "-")              # YYYY-MM-DD
            try:
                y, mo, da = d_iso.split("-")
                d_us = f"{mo}-{da}-{y}"                      # MM-DD-YYYY
            except ValueError:
                d_us = d_iso
            h = home.lower().replace(" ", "_").replace("/", "_")
            a = away.lower().replace(" ", "_").replace("/", "_")
            # Candidate synthetic keys: both date formats × both orderings + alpha
            pair = sorted([h, a])
            candidates = []
            for d in (d_us, d_iso):
                candidates += [
                    f"{d}_{a}_{h}", f"{d}_{h}_{a}",
                    f"{d}_{pair[0]}_{pair[1]}",
                ]
            for syn in candidates:
                if syn in output and gid not in output:
                    output[gid] = output[syn]
                    n_alias += 1
                    break
    print(f"  aliased {n_alias:,} contests to numeric gids")

    # ── Write output ──────────────────────────────────────────────────────────
    print(f"\nTotal: {total_contests} contests across all processed seasons")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Writing {OUT_PATH}…")
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, separators=(",", ":"))

    size_mb = OUT_PATH.stat().st_size / 1024 / 1024
    print(f"Done.  Output: {OUT_PATH}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
