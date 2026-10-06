"""
build_boxscore_from_pbp.py
──────────────────────────

Reconstructs two-sided per-match box scores from the NCAA D1 WVB
play-by-play CSVs. Unlike the `ncaavolleyballr`-generated one-sided
CSVs in public/data/, the PBP data carries events for BOTH teams in
every contest, so aggregating by (contest, team, player) gives us a
complete two-sided roster without any scraping.

Inputs
──────
  PBP_DIR/wvb_pbp_div1_<year>.csv         — play-by-play source
  public/data/wvb_playermatch_div1_<year>.csv
                                          — used to look up player positions

Output
──────
  public/data/wvb_playermatch_div1_<year>_twosided.csv
  scripts/.pbp-build/<year>/_compare.txt  — diff vs the one-sided CSV

Schema
──────
Extends the existing one-sided schema with two new columns (DigErr, SetErr)
so downstream code keeps working unmodified. All original columns preserved.

  team, Season, Date, Team, Conference, Opponent Team, Opponent Conference,
  Location, Number, Player, P, S, Kills, Errors, TotalAttacks, HitPct,
  Assists, Aces, SErr, Digs, RetAtt, RErr, BlockSolos, BlockAssists, BErr,
  PTS, BHE, DigErr, SetErr

Event → stat mapping
────────────────────
  Kills          = count of (Kill | First ball kill)
  TotalAttacks   = count of Attack events
  Errors         = count of Attack error events
  HitPct         = (Kills − Errors) / TotalAttacks
  Aces           = count of Ace events
  SErr           = count of Service error events
  Digs           = count of Dig events
  DigErr         = count of Dig error events
  BlockErr       = count of Block error events
  BHE            = count of Ball handling error events
  SetErr         = count of Set error events
  Assists        = for each Kill, credit the most recent same-team Set
                   within the same (contest, set)
  BlockSolos     = Block events not adjacent to another same-team Block
  BlockAssists   = Block events adjacent to another same-team Block by a
                   different player (in row order within the set)
  RErr           = player was the most recent Reception event (same team as
                   receiving side) before an opposing Ace
  S              = count of distinct set numbers the player has any event in
  PTS            = Kills + Aces + BlockSolos + 0.5 × BlockAssists
  P              = looked up from existing one-sided CSV by (year, team, player)
  Number         = same lookup (may be blank when opponent wasn't the kept side)
  RetAtt         = 0 (not derivable from PBP; preserved as column for schema)

Usage
─────
  python scripts/build_boxscore_from_pbp.py 2024
  python scripts/build_boxscore_from_pbp.py 2022 2023 2024 2025
  python scripts/build_boxscore_from_pbp.py --sample 2024   # diagnostic only

Configure PBP_DIR near the top of the file to point at your PBP directory.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

# ─── Paths ──────────────────────────────────────────────────────────────────

REPO_ROOT      = Path(__file__).resolve().parent.parent
PBP_DIR        = Path(r"C:\Users\gordo\OneDrive\Documents\Volleyball GIS Documents")
ONE_SIDED_DIR  = REPO_ROOT / "public" / "data"
OUT_DIR        = REPO_ROOT / "public" / "data"
WORK_DIR       = REPO_ROOT / "scripts" / ".pbp-build"

# Python's default CSV field size is too small for these files
csv.field_size_limit(10_000_000)

# ─── Event classification ──────────────────────────────────────────────────

KILL_EVENTS     = {"Kill", "First ball kill"}
ATTACK_EVENT    = "Attack"
ATTACK_ERR      = "Attack error"
ACE_EVENT       = "Ace"
SERVE_ERR       = "Service error"
DIG_EVENT       = "Dig"
DIG_ERR         = "Dig error"
BLOCK_EVENT     = "Block"
BLOCK_ERR       = "Block error"
BHE_EVENT       = "Ball handling error"
SET_EVENT       = "Set"
SET_ERR         = "Set error"
SERVE_EVENT     = "Serve"
RECEPTION_EVENT = "Reception"

# Error events log the SCORING (opposing) team in the `team` column while
# the `player` belongs to the erring team. We flip to get the player's team
# so the error gets credited to the correct roster.
FLIP_TEAM_EVENTS = {ATTACK_ERR, SERVE_ERR, SET_ERR, BLOCK_ERR, BHE_EVENT, DIG_ERR}

# ─── Output schema ─────────────────────────────────────────────────────────

OUT_COLS = [
    "team", "Season", "Date", "Team", "Conference", "Opponent Team",
    "Opponent Conference", "Location", "Number", "Player", "P", "S",
    "Kills", "Errors", "TotalAttacks", "HitPct", "Assists", "Aces",
    "SErr", "Digs", "RetAtt", "RErr", "BlockSolos", "BlockAssists",
    "BErr", "PTS", "BHE", "DigErr", "SetErr",
]

# ─── Position map (from one-sided CSVs) ────────────────────────────────────

def _norm(s: str) -> str:
    return (s or "").strip().lower()

def load_position_map(years: list[int]) -> dict[tuple[int, str, str], tuple[str, str]]:
    """
    Build a { (year, team_lower, player_lower) → (position, number) } map from
    all available one-sided CSVs. We scan every requested year — players move
    between seasons, so keep the lookup year-scoped.
    """
    pmap: dict[tuple[int, str, str], tuple[str, str]] = {}
    for year in years:
        src = ONE_SIDED_DIR / f"wvb_playermatch_div1_{year}.csv"
        if not src.exists():
            print(f"  [warn] no one-sided CSV for {year} at {src}")
            continue
        n = 0
        with src.open(encoding="utf-8") as fh:
            r = csv.DictReader(fh)
            for row in r:
                team   = _norm(row.get("Team"))
                player = _norm(row.get("Player"))
                pos    = (row.get("P") or "").strip()
                num    = (row.get("Number") or "").strip()
                if not team or not player:
                    continue
                key = (year, team, player)
                # Prefer a non-blank position if we've already seen the player
                existing = pmap.get(key)
                if existing and existing[0] and not pos:
                    continue
                pmap[key] = (pos, num)
                n += 1
        print(f"  {year}: {n:,} one-sided rows → {sum(1 for k in pmap if k[0]==year):,} unique players")
    return pmap

# ─── PBP streaming ─────────────────────────────────────────────────────────

CONTEST_DATE_RE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")

def _normalize_date(raw: str) -> str:
    """PBP uses MM/DD/YYYY. Convert to YYYY-MM-DD to match one-sided schema."""
    m = CONTEST_DATE_RE.match(raw or "")
    if not m:
        return raw
    mm, dd, yyyy = m.groups()
    return f"{yyyy}-{int(mm):02d}-{int(dd):02d}"

def stream_contests(year: int):
    """
    Yield (contest_key, rows) for each contest in the PBP file.

    NOTE: ~30% of contests in the PBP CSV have their rows split across
    non-contiguous chunks in the file (the file is sorted by date but
    within a date multiple contests interleave). A single-pass streaming
    group-by would yield each chunk as a separate contest, which double-
    counts those matches. Fix: accumulate all rows into a defaultdict
    keyed by contest, preserving file order within each key, then yield.
    Memory for a 5-million-row year is ~1.5 GB — acceptable on a local
    machine. If this ever becomes a problem, swap for a sqlite staging
    table.
    """
    src = PBP_DIR / f"wvb_pbp_div1_{year}.csv"
    if not src.exists():
        raise FileNotFoundError(f"PBP file not found: {src}")

    buckets: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    seen_fps: dict[tuple[str, str, str], set] = defaultdict(set)
    with src.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            key = (row["date"], row["away_team"], row["home_team"])
            # Dedup on the event fingerprint. Some PBP files (notably 2025)
            # contain every event duplicated twice for ~1,600 contests.
            fp = (row.get("set", ""), row.get("score", ""), row.get("team", ""),
                  row.get("event", ""), row.get("player", ""), row.get("description", ""))
            if fp in seen_fps[key]:
                continue
            seen_fps[key].add(fp)
            buckets[key].append(row)

    for key, rows in buckets.items():
        yield key, rows

# ─── Per-contest aggregation ───────────────────────────────────────────────

def _player_key(team: str, player: str) -> tuple[str, str]:
    return (team, _norm(player))

def process_contest(rows: list[dict]) -> dict:
    """
    Aggregate one contest's PBP rows into per-player stat lines for both
    teams. Returns:
      {
        date:       "YYYY-MM-DD",
        home_team:  str,
        away_team:  str,
        players: {
          (team_name, player_lower): {
            display_name, team, kills, attacks, attack_errors, aces,
            serve_errors, digs, dig_errors, blocks, block_errors, bhe,
            set_errors, assists, block_solos, block_assists, r_errors,
            sets_played: set(int)
          }
        },
        diag: { kills_no_assist, blocks_seen, ... }
      }
    """
    if not rows:
        return {}

    date_raw   = rows[0]["date"]
    away_team  = rows[0]["away_team"]
    home_team  = rows[0]["home_team"]

    players: dict[tuple[str, str], dict] = {}

    def p_rec(team: str, player: str) -> dict:
        k = _player_key(team, player)
        rec = players.get(k)
        if rec is None:
            rec = {
                "display_name":  player,
                "team":          team,
                "kills":         0,
                "attacks":       0,
                "attack_errors": 0,
                "aces":          0,
                "serve_errors":  0,
                "digs":          0,
                "dig_errors":    0,
                "block_errors":  0,
                "bhe":           0,
                "set_errors":    0,
                "assists":       0,
                "block_solos":   0,
                "block_assists": 0,
                "r_errors":      0,
                "sets_played":   set(),
            }
            players[k] = rec
        return rec

    # ── Pass 1: direct event counts + track recent context ────────────────
    # We walk rows in order and maintain "most recent Set by team in this
    # current set" and "most recent Reception by team in this current set"
    # so Kill → assist and Ace → receive-error attribution work in one pass.
    last_set_by_team:      dict[str, tuple[str, int]] = {}   # team → (player, set_num)
    last_receive_by_team:  dict[str, tuple[str, int]] = {}   # team → (player, set_num)
    current_set_num = None

    # For block solo/assist resolution we collect Block events as a list
    # and post-process them after the main pass.
    # Skip "combined" entries (player name contains a comma like "Jess
    # Mruzik, Maggie Mendelson") — those are PBP summary rows that
    # duplicate the individual Block entries for the same stuff.
    blocks: list[tuple[int, str, str]] = []   # (row_idx, team, player)

    # Track the most recent Attack by each team within the current set, so
    # when a stuff block fires we can charge the attacker with an attack
    # error.
    last_attack_by_team: dict[str, tuple[str, int]] = {}   # team → (player, set)

    for i, ev in enumerate(rows):
        try:
            snum = int(ev["set"])
        except (ValueError, TypeError):
            continue
        if snum != current_set_num:
            current_set_num = snum
            last_set_by_team.clear()
            last_receive_by_team.clear()
            last_attack_by_team.clear()

        raw_team = ev["team"]
        player   = ev["player"]
        event    = ev["event"]
        if not raw_team or not player:
            continue

        # For error events, the `team` column holds the SCORING team; flip
        # to the erring player's actual team so the error is credited to
        # the right roster.
        if event in FLIP_TEAM_EVENTS:
            team = home_team if raw_team == away_team else away_team
        else:
            team = raw_team

        rec = p_rec(team, player)
        rec["sets_played"].add(snum)

        if event in KILL_EVENTS:
            rec["kills"] += 1
            # Don't double-count attacks — the preceding `Attack` event
            # already contributed.  Assist: most recent Set by the same
            # team in this set.
            prev = last_set_by_team.get(team)
            if prev and prev[1] == snum:
                a_rec = p_rec(team, prev[0])
                a_rec["assists"] += 1

        elif event == ATTACK_EVENT:
            rec["attacks"] += 1
            last_attack_by_team[team] = (player, snum)

        elif event == ATTACK_ERR:
            rec["attack_errors"] += 1
            # Preceding `Attack` event already counted this attempt.

        elif event == ACE_EVENT:
            rec["aces"] += 1
            # RErr attribution is NOT derivable from PBP — aces don't carry
            # a preceding Reception event. Stage 3 (merge_rerr.py) populates
            # RErr from scraped box scores. RErr stays 0 here.

        elif event == SERVE_ERR:
            rec["serve_errors"] += 1

        elif event == DIG_EVENT:
            rec["digs"] += 1

        elif event == DIG_ERR:
            rec["dig_errors"] += 1

        elif event == BLOCK_EVENT:
            # Skip PBP "combined" summary rows (e.g. "Mruzik, Mendelson") —
            # they duplicate the individual Block entries for the same stuff.
            if "," not in player:
                # Snapshot the current last-opposing-attacker so Pass 2 can
                # charge the stuffed hitter with an attack error. We store
                # it with the block tuple because later events may overwrite
                # last_attack_by_team before we process blocks.
                opp = home_team if team == away_team else away_team
                victim = last_attack_by_team.get(opp)
                victim_player = victim[0] if (victim and victim[1] == snum) else None
                blocks.append((i, snum, team, player, opp, victim_player))

        elif event == BLOCK_ERR:
            rec["block_errors"] += 1

        elif event == BHE_EVENT:
            rec["bhe"] += 1

        elif event == SET_EVENT:
            last_set_by_team[team] = (player, snum)

        elif event == SET_ERR:
            rec["set_errors"] += 1

        elif event == RECEPTION_EVENT:
            last_receive_by_team[team] = (player, snum)

        # Serve event is tracked implicitly via Ace / Service error;
        # counted nowhere.

    # ── Pass 2: resolve Block events into solo vs assist + stuff errors ──
    # Group consecutive same-team Block events (each represents one blocker
    # on a rally-ending stuff). Group rules: same team, same set, row
    # indices within 3 rows of each other, different players. One group →
    # one stuff → one attack error on the most recent opposing attacker.
    n = len(blocks)
    resolved = [False] * n
    for a in range(n):
        if resolved[a]:
            continue
        ia, sa, ta, pa, opp_a, victim_a = blocks[a]
        partners = [(ia, ta, pa)]
        for b in range(a + 1, n):
            ib, sb, tb, pb, _, _ = blocks[b]
            if sb != sa:
                break
            if ib - partners[-1][0] > 3:
                break
            if tb == ta and pb != pa:
                partners.append((ib, tb, pb))
            else:
                break

        if len(partners) >= 2:
            for _, tt, pp in partners:
                p_rec(tt, pp)["block_assists"] += 1
            for k in range(len(partners)):
                resolved[a + k] = True
        else:
            p_rec(ta, pa)["block_solos"] += 1
            resolved[a] = True

        # Charge the stuffed hitter (if we found one) with an attack error
        if victim_a:
            p_rec(opp_a, victim_a)["attack_errors"] += 1

    return {
        "date":      _normalize_date(date_raw),
        "away_team": away_team,
        "home_team": home_team,
        "players":   players,
    }

# ─── CSV row builder ────────────────────────────────────────────────────────

def build_rows_for_contest(
    contest: dict, season_str: str, pos_map: dict, year: int,
    conf_map: dict[tuple[int, str], str],
) -> list[dict]:
    """
    Turn a processed contest dict into a list of output CSV rows — one per
    player on each side. Position/jersey looked up from pos_map; conference
    looked up from conf_map (built from the one-sided CSVs).
    """
    if not contest:
        return []

    date = contest["date"]
    home = contest["home_team"]
    away = contest["away_team"]

    home_conf = conf_map.get((year, _norm(home)), "")
    away_conf = conf_map.get((year, _norm(away)), "")

    out: list[dict] = []
    for (team, _plow), rec in contest["players"].items():
        is_home     = (team == home)
        own_conf    = home_conf if is_home else away_conf
        opp         = away if is_home else home
        opp_conf    = away_conf if is_home else home_conf
        location    = "Home" if is_home else "Away"

        pos, num = pos_map.get((year, _norm(team), _plow), ("", ""))

        kills         = rec["kills"]
        attacks       = rec["attacks"]
        errors        = rec["attack_errors"]
        hit_pct       = ((kills - errors) / attacks) if attacks else 0.0
        block_solos   = rec["block_solos"]
        block_assists = rec["block_assists"]
        aces          = rec["aces"]
        points        = kills + aces + block_solos + 0.5 * block_assists

        out.append({
            "team":                 team,
            "Season":               season_str,
            "Date":                 date,
            "Team":                 team,
            "Conference":           own_conf,
            "Opponent Team":        opp,
            "Opponent Conference":  opp_conf,
            "Location":             location,
            "Number":               num,
            "Player":               rec["display_name"],
            "P":                    pos,
            "S":                    len(rec["sets_played"]),
            "Kills":                kills,
            "Errors":               errors,
            "TotalAttacks":         attacks,
            "HitPct":               f"{hit_pct:.3f}",
            "Assists":              rec["assists"],
            "Aces":                 aces,
            "SErr":                 rec["serve_errors"],
            "Digs":                 rec["digs"],
            "RetAtt":               0,
            "RErr":                 rec["r_errors"],
            "BlockSolos":           block_solos,
            "BlockAssists":         block_assists,
            "BErr":                 rec["block_errors"],
            "PTS":                  f"{points:.1f}".rstrip("0").rstrip(".") or "0",
            "BHE":                  rec["bhe"],
            "DigErr":               rec["dig_errors"],
            "SetErr":               rec["set_errors"],
        })
    return out

# ─── Conference map ─────────────────────────────────────────────────────────

def load_conference_map(years: list[int]) -> dict[tuple[int, str], str]:
    """(year, team_lower) → conference — from one-sided CSVs."""
    cmap: dict[tuple[int, str], str] = {}
    for year in years:
        src = ONE_SIDED_DIR / f"wvb_playermatch_div1_{year}.csv"
        if not src.exists():
            continue
        with src.open(encoding="utf-8") as fh:
            r = csv.DictReader(fh)
            for row in r:
                t = _norm(row.get("Team"))
                c = (row.get("Conference") or "").strip()
                if t and c:
                    cmap.setdefault((year, t), c)
    return cmap

# ─── Compare report ─────────────────────────────────────────────────────────

def write_compare_report(year: int, twosided_rows: list[dict]) -> None:
    """
    Diff aggregate totals (kills, assists, digs, aces) between the new
    two-sided CSV and the existing one-sided CSV. Row counts should roughly
    double; per-team per-season totals should match for teams fully
    represented in the one-sided data.
    """
    work = WORK_DIR / str(year)
    work.mkdir(parents=True, exist_ok=True)
    report = work / "_compare.txt"

    new_team_totals: dict[str, dict] = defaultdict(lambda: {"rows": 0, "K": 0, "A": 0, "D": 0, "Ace": 0})
    for r in twosided_rows:
        t = r["Team"]
        tt = new_team_totals[t]
        tt["rows"] += 1
        tt["K"]    += int(r["Kills"] or 0)
        tt["A"]    += int(r["Assists"] or 0)
        tt["D"]    += int(r["Digs"] or 0)
        tt["Ace"]  += int(r["Aces"] or 0)

    old_team_totals: dict[str, dict] = defaultdict(lambda: {"rows": 0, "K": 0, "A": 0, "D": 0, "Ace": 0})
    old_src = ONE_SIDED_DIR / f"wvb_playermatch_div1_{year}.csv"
    if old_src.exists():
        with old_src.open(encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                t = row["Team"]
                tt = old_team_totals[t]
                tt["rows"] += 1
                try:
                    tt["K"]   += int(row.get("Kills")   or 0)
                    tt["A"]   += int(row.get("Assists") or 0)
                    tt["D"]   += int(row.get("Digs")    or 0)
                    tt["Ace"] += int(row.get("Aces")    or 0)
                except ValueError:
                    pass

    all_teams = sorted(set(new_team_totals) | set(old_team_totals))
    with report.open("w", encoding="utf-8") as fh:
        fh.write(f"Compare report: {year}\n")
        fh.write(f"Teams: {len(all_teams)}\n\n")
        fh.write(f"{'Team':<32}{'old_rows':>10}{'new_rows':>10}"
                 f"{'old_K':>8}{'new_K':>8}{'old_A':>8}{'new_A':>8}"
                 f"{'old_D':>8}{'new_D':>8}\n")
        for t in all_teams:
            o = old_team_totals.get(t, {"rows":0,"K":0,"A":0,"D":0,"Ace":0})
            n = new_team_totals.get(t, {"rows":0,"K":0,"A":0,"D":0,"Ace":0})
            fh.write(f"{t[:31]:<32}{o['rows']:>10}{n['rows']:>10}"
                     f"{o['K']:>8}{n['K']:>8}{o['A']:>8}{n['A']:>8}"
                     f"{o['D']:>8}{n['D']:>8}\n")
        # Aggregate ratio
        tk_o = sum(v["K"] for v in old_team_totals.values())
        tk_n = sum(v["K"] for v in new_team_totals.values())
        tr_o = sum(v["rows"] for v in old_team_totals.values())
        tr_n = sum(v["rows"] for v in new_team_totals.values())
        fh.write(f"\nAggregate row ratio (new/old):  {tr_n/max(tr_o,1):.3f}\n")
        fh.write(f"Aggregate kills ratio (new/old): {tk_n/max(tk_o,1):.3f}\n")
        fh.write("Expected row ratio ≈ 2.0 (two-sided vs one-sided).\n")
        fh.write("Expected kills ratio ≈ 2.0 (each match counts both teams' kills).\n")
    print(f"  Compare report written → {report}")

# ─── Diagnostic sampler ─────────────────────────────────────────────────────

def sample_contests(year: int, n: int = 5) -> None:
    """Print event sequences from n random contests to validate PBP shape."""
    import random
    all_contests = []
    for key, rows in stream_contests(year):
        all_contests.append((key, rows))
        if len(all_contests) >= 500:
            break
    random.seed(42)
    for key, rows in random.sample(all_contests, min(n, len(all_contests))):
        print(f"\n── Contest {key[0]}  {key[1]} @ {key[2]}  ({len(rows)} events) ──")
        # Show the first 12 events + the last 12
        for ev in rows[:12]:
            print(f"  set {ev['set']:>2}  {ev['team']:>30}  {ev['event']:<22}  {ev['player']}")
        print("   ...")
        for ev in rows[-12:]:
            print(f"  set {ev['set']:>2}  {ev['team']:>30}  {ev['event']:<22}  {ev['player']}")

# ─── Main driver ────────────────────────────────────────────────────────────

def build_year(year: int, pos_map: dict, conf_map: dict) -> Path:
    season_str = f"{year}-{year+1}"
    print(f"\n═══ Build {year} ═══")
    out_path = OUT_DIR / f"wvb_playermatch_div1_{year}_twosided.csv"

    t0 = time.time()
    n_contests = 0
    n_rows     = 0
    all_rows: list[dict] = []

    for key, rows in stream_contests(year):
        processed = process_contest(rows)
        out_rows  = build_rows_for_contest(processed, season_str, pos_map, year, conf_map)
        all_rows.extend(out_rows)
        n_contests += 1
        n_rows     += len(out_rows)
        if n_contests % 500 == 0:
            el = time.time() - t0
            print(f"  {n_contests} contests · {n_rows:,} player-rows · {el:.0f}s elapsed")

    print(f"  Total: {n_contests} contests · {n_rows:,} rows · {time.time()-t0:.0f}s")

    with out_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=OUT_COLS, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        w.writerows(all_rows)
    print(f"  Wrote {out_path}")

    write_compare_report(year, all_rows)
    return out_path

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("years", nargs="*", type=int,
                    help="seasons to build (e.g. 2022 2023 2024 2025)")
    ap.add_argument("--sample", type=int, metavar="YEAR",
                    help="print sample contest event sequences for a year and exit")
    args = ap.parse_args()

    if args.sample:
        sample_contests(args.sample)
        return

    if not args.years:
        print("Usage: build_boxscore_from_pbp.py YEAR [YEAR ...]")
        print("       build_boxscore_from_pbp.py --sample YEAR")
        sys.exit(1)

    print("Loading position + conference maps from one-sided CSVs…")
    pos_map  = load_position_map(args.years)
    conf_map = load_conference_map(args.years)
    print(f"  {len(pos_map):,} player-year keys · {len(conf_map):,} team-year keys\n")

    for y in args.years:
        try:
            build_year(y, pos_map, conf_map)
        except FileNotFoundError as e:
            print(f"  [skip] {e}")

if __name__ == "__main__":
    main()
