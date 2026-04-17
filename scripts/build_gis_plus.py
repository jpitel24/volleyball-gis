#!/usr/bin/env python3
"""
build_gis_plus.py

Reads gis_observations.csv, historical_rpi.json, and match_context.json
and produces gis_plus_observations.csv — the opponent-adjusted, leverage-
weighted, efficiency-modulated GIS+ score for every 2022–2025 player-match
observation.

GIS+ = (attacking + blocking + setting + serving + receiving + digs)
       × OpponentModifier

Where each bucket is:
    attacking  = (Kills − Errors)                               × leverage
    blocking   = (BlockSolos + 0.5·BlockAssists − BErr)         × leverage
    setting    = (0.5·Assists − BHE)              × SetMod      × leverage
    serving    = (Aces − SErr)                    × ServeMod    × leverage
    receiving  = (0.25·Passes − RErr)             × RecvMod     × leverage
    digs       = 0.25·Digs                                      × leverage

When all modifiers equal 1.0, GIS+ reduces exactly to the raw GIS value.

See the 7-step spec for details on each modifier's derivation.

Colab usage:
    1. Mount Drive (if match_context.json lives on Drive)
    2. Clone or upload the repo to Colab so public/data/ is accessible
    3. %cd /content/<repo root>
    4. Run this cell (prompts for match_context.json path if not auto-found)
"""

import csv
import json
import os
import pickle
import re
import sys
from pathlib import Path

# ── Paths (edit for your environment) ─────────────────────────────────────────
# Relative default — assumes script is run from the repo root OR scripts/ dir.
# Falls back to absolute paths at resolve time.
SCRIPT_DIR = Path(__file__).resolve().parent if "__file__" in dir() else Path.cwd()
REPO_ROOT  = SCRIPT_DIR.parent if SCRIPT_DIR.name == "scripts" else SCRIPT_DIR
DATA_DIR   = REPO_ROOT / "public" / "data"

GIS_OBS_PATH  = DATA_DIR / "gis_observations.csv"
RPI_PATH      = DATA_DIR / "historical_rpi.json"
OUT_PATH      = DATA_DIR / "gis_plus_observations.csv"
UNMATCHED_OUT = DATA_DIR / "unmatched_opponents.txt"

# match_context.json is local-only (~1 GB) — probe common locations, prompt on miss.
MATCH_CONTEXT_PROBES = [
    Path("/content/drive/MyDrive/Volleyball GIS Documents/match_context.json"),
    Path("/content/match_context.json"),
    DATA_DIR / "match_context.json",
    Path.home() / "OneDrive/Documents/Volleyball GIS Documents/match_context.json",
]

# Pickle cache on fast local disk — avoids re-parsing 1 GB of JSON on every run.
CACHE_PATH = Path("/content/match_context.pkl")
if not Path("/content").exists():
    CACHE_PATH = SCRIPT_DIR / "match_context.pkl"

# ── Tunables (from the spec) ──────────────────────────────────────────────────
SERVE_MIN_ATTEMPTS    = 8
RECEIVE_MIN_ATTEMPTS  = 8
SET_MIN_ATTEMPTS      = 20

# Anchor rates for efficiency → multiplier interpolation.
SERVE_ANCHORS    = (0.0000, 0.0625, 0.1667)   # floor / neutral / ceiling
RECEIVE_ANCHORS  = (0.1765, 0.3333, 0.5000)
SET_ANCHORS      = (0.2653, 0.3678, 0.4839)
MULT_LOW, MULT_MID, MULT_HIGH = 0.90, 1.00, 1.10

OPP_BOOST_CAP    = 1.10   # max opponent modifier (elite opponent)
OPP_DISCOUNT_CAP = 0.80   # min opponent modifier (weak / non-D1 opponent)
OPP_BOOST_PCT    = 0.10   # +10% at max RPI
OPP_DISCOUNT_PCT = 0.20   # -20% at min RPI

# Output schema — all gis_observations cols + the 11 new ones.
OUTPUT_COLS = [
    # Passthrough from gis_observations.csv
    "Season", "ContestID", "Date", "Team", "Conference", "Opponent Team",
    "Opponent Conference", "Location", "Player", "P", "S",
    "Kills", "Errors", "TotalAttacks", "HitPct",
    "Assists", "Aces", "SErr", "Digs", "RetAtt", "RErr",
    "BlockSolos", "BlockAssists", "BErr", "BHE",
    "Passes", "GIS",
    # New GIS+ columns
    "OpponentRPI", "OpponentModifier",
    "ServeEff", "ServeModifier",
    "ReceiveEff", "ReceiveModifier",
    "SetEff", "SetModifier",
    "LeverageModifier",
    "GIS_Plus",
    "ContextMissing",
]

# ── Small helpers ─────────────────────────────────────────────────────────────

def safe_int(v):
    try: return int(v)
    except (ValueError, TypeError): return 0

def safe_float(v):
    try: return float(v)
    except (ValueError, TypeError): return 0.0

def is_nan(x):
    """Float NaN check. NaN is the only value that isn't equal to itself."""
    try:
        return isinstance(x, float) and x != x
    except Exception:
        return False

def normalize_team(name):
    """Strip (AQ) suffix. Preserves state suffixes like (OH), (FL)."""
    if not name:
        return ""
    return re.sub(r"\s*\(AQ\)\s*", "", name).strip()

def make_contest_id(date, away, home):
    """Build synthetic contest ID matching build_match_context.py's format."""
    d = date.replace("/", "-")
    a = (away or "").lower().replace(" ", "_")
    h = (home or "").lower().replace(" ", "_")
    return f"{d}_{a}_{h}"

def parse_score(s):
    """'25-23' → (25, 23). Returns (0, 0) on parse failure."""
    try:
        a, h = s.split("-", 1)
        return int(a), int(h)
    except Exception:
        return 0, 0

# ── Efficiency modifiers ──────────────────────────────────────────────────────

def interp_mult(rate, anchors):
    """Piecewise-linear interpolation between 3 anchor rates and multipliers."""
    low, mid, high = anchors
    if rate <= low:  return MULT_LOW
    if rate >= high: return MULT_HIGH
    if rate <= mid:
        t = (rate - low) / (mid - low)
        return MULT_LOW + t * (MULT_MID - MULT_LOW)
    t = (rate - mid) / (high - mid)
    return MULT_MID + t * (MULT_HIGH - MULT_MID)

# ── Leverage layers ───────────────────────────────────────────────────────────

def layer1_match_state(set_num, sets_detail):
    """Match situation multiplier based on set wins entering this set."""
    if set_num <= 2:
        return 0.95
    if set_num >= 5:
        return 1.10
    # Count set wins by each team in prior sets.
    prior = [s.get("winner") for s in sets_detail if s.get("set", 0) < set_num]
    counts = {}
    for w in prior:
        if w:
            counts[w] = counts.get(w, 0) + 1
    counts_sorted = sorted(counts.values(), reverse=True)
    if set_num == 3:
        if counts_sorted == [2]:   return 1.00  # sweep situation
        if counts_sorted == [1, 1]: return 1.05  # tied
        return 1.00                              # partial/missing data fallback
    if set_num == 4:
        return 1.08                              # must be 2-1
    return 1.00

def layer2_set_closeness(set_num, sets_detail):
    """Closeness of THIS set based on its final margin."""
    for s in sets_detail:
        if s.get("set") == set_num:
            a, h = parse_score(s.get("score", "0-0"))
            margin = abs(a - h)
            if margin <= 2: return 1.10
            if margin <= 5: return 1.05
            if margin <= 9: return 1.00
            return 0.92
    return 1.00

def layer3_score_state(set_num, score_str):
    """Score-state pressure multiplier at the moment of the event."""
    a, h = parse_score(score_str)
    target = 15 if set_num == 5 else 25
    leading = max(a, h)
    # Deuce: either team has hit target AND margin ≤ 1 → 2 points remain
    if (a >= target or h >= target) and abs(a - h) <= 1:
        remaining = 2
    else:
        remaining = max(target - leading, 0)
    if remaining <= 2:  return 1.10
    if remaining <= 4:  return 1.07
    if remaining <= 7:  return 1.04
    if remaining <= 12: return 1.00
    return 0.94

def compute_leverage(score_state_events, sets_detail):
    """Weighted-average leverage multiplier across the player's scoring events."""
    if not score_state_events:
        return 1.0
    total = 0.0
    n = 0
    for ev in score_state_events:
        sn = ev.get("set", 0)
        score = ev.get("score", "0-0")
        lv = (
            layer1_match_state(sn, sets_detail)
            * layer2_set_closeness(sn, sets_detail)
            * layer3_score_state(sn, score)
        )
        total += lv
        n += 1
    return total / n if n > 0 else 1.0

# ── Loading ───────────────────────────────────────────────────────────────────

def resolve_match_context_path():
    for p in MATCH_CONTEXT_PROBES:
        if p.exists():
            print(f"Found match_context.json at {p}")
            return p
    print("match_context.json not found at any default location:")
    for p in MATCH_CONTEXT_PROBES:
        print(f"  - {p}")
    user_in = input("Enter path to match_context.json: ").strip().strip('"').strip("'")
    p = Path(user_in)
    if not p.exists():
        raise FileNotFoundError(f"File does not exist: {p}")
    return p

def load_match_context(path):
    """Load match_context.json with pickle cache for fast re-runs."""
    # Cache fresh if the JSON is newer than the pickle.
    cache_ok = (
        CACHE_PATH.exists()
        and path.exists()
        and CACHE_PATH.stat().st_mtime >= path.stat().st_mtime
    )
    if cache_ok:
        print(f"Loading cached match_context from {CACHE_PATH} …")
        try:
            with open(CACHE_PATH, "rb") as f:
                ctx = pickle.load(f)
            print(f"  {len(ctx):,} contests (from cache)")
            return ctx
        except Exception as e:
            print(f"  cache load failed ({e}); falling back to JSON", file=sys.stderr)

    print(f"Parsing {path} (this takes 30–60 seconds) …")
    with open(path, "r", encoding="utf-8") as f:
        ctx = json.load(f)
    print(f"  {len(ctx):,} contests loaded")

    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        print(f"Writing cache to {CACHE_PATH} …")
        with open(CACHE_PATH, "wb") as f:
            pickle.dump(ctx, f, protocol=pickle.HIGHEST_PROTOCOL)
        size_mb = CACHE_PATH.stat().st_size / 1024 / 1024
        print(f"  cache size: {size_mb:.1f} MB")
    except Exception as e:
        print(f"  cache write failed: {e}", file=sys.stderr)

    return ctx

def load_rpi(path):
    """
    Load historical_rpi.json.

    Python's json.load accepts NaN tokens by default (as float('nan')), which
    is what historical_rpi.json contains for defunct teams (e.g. Hartford 2022).
    We treat NaN values the same as absent teams → non-D1 season-min floor.
    """
    print(f"Loading {path} …")
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    per_season = {}
    for season, team_map in raw.items():
        teams = {}
        numeric = []
        neutral = None
        for k, v in team_map.items():
            if k == "_neutral_point":
                neutral = v
                continue
            if k.startswith("_"):
                continue
            teams[k] = v  # may be NaN
            if v is not None and not is_nan(v):
                numeric.append(v)
        if not numeric:
            print(f"  WARN: no numeric RPI values for season {season}", file=sys.stderr)
            continue
        mn, mx = min(numeric), max(numeric)
        per_season[season] = {
            "teams":         teams,
            "neutral_point": neutral if neutral is not None else (mn + mx) / 2,
            "min":           mn,
            "max":           mx,
        }

    print("  Season-level summary:")
    for yr in sorted(per_season.keys()):
        info = per_season[yr]
        print(f"    {yr}: {len(info['teams']):>4} teams · "
              f"min={info['min']:.4f} · neutral={info['neutral_point']:.4f} · "
              f"max={info['max']:.4f}")
    return per_season

# ── Opponent modifier ─────────────────────────────────────────────────────────

def lookup_opponent_rpi(opp_name, season_info, unmatched_log):
    """
    Returns (rpi_value, matched_flag).

    opp not in table OR rpi == NaN → treat as non-D1 → season-min floor.
    Every fallback name is logged in unmatched_log for auditing.
    """
    norm = normalize_team(opp_name)
    rpi = season_info["teams"].get(norm)
    if rpi is not None and not is_nan(rpi):
        return rpi, True
    unmatched_log[norm] = unmatched_log.get(norm, 0) + 1
    return season_info["min"], False

def opponent_modifier(opp_rpi, season_info):
    """Linear scale between caps: -20% at season-min, +10% at season-max."""
    np_ = season_info["neutral_point"]
    mn  = season_info["min"]
    mx  = season_info["max"]
    if opp_rpi >= np_:
        if mx == np_:
            return 1.0
        mod = 1.0 + OPP_BOOST_PCT * (opp_rpi - np_) / (mx - np_)
        return min(mod, OPP_BOOST_CAP)
    if np_ == mn:
        return 1.0
    mod = 1.0 - OPP_DISCOUNT_PCT * (np_ - opp_rpi) / (np_ - mn)
    return max(mod, OPP_DISCOUNT_CAP)

# ── Match-context lookup ──────────────────────────────────────────────────────

def find_player_context(match_ctx, contest_id, date, team, opp_team, player, season_year):
    """
    Resolve the player's context entry for this match.

    Primary key: ContestID from gis_observations.csv.

    Two forms of fallback:
      1. Date-format flip: gis_observations.csv writes YYYY-MM-DD_... but
         match_context.json (built from PBP) uses MM-DD-YYYY_... — try both.
      2. Team-order flip (for 2022-2024 neutral-site games): gis_observations
         sorts teams alphabetically but PBP uses home/away order.
    """
    def flip_date(cid):
        # "YYYY-MM-DD_..." -> "MM-DD-YYYY_..."
        if len(cid) >= 11 and cid[4] == '-' and cid[7] == '-' and cid[10] == '_':
            return f"{cid[5:7]}-{cid[8:10]}-{cid[0:4]}{cid[10:]}"
        return None

    candidates = [contest_id]
    flipped = flip_date(contest_id)
    if flipped:
        candidates.append(flipped)

    if not season_year.startswith("2025"):
        for a, h in ((team, opp_team), (opp_team, team)):
            alt = make_contest_id(date, a, h)
            if alt not in candidates:
                candidates.append(alt)
            alt_flipped = flip_date(alt)
            if alt_flipped and alt_flipped not in candidates:
                candidates.append(alt_flipped)

    for cid in candidates:
        contest = match_ctx.get(cid)
        if contest is not None:
            pc = contest.get(player)
            if pc is not None:
                return pc, cid, True
    return None, contest_id, False

# ── Main build ────────────────────────────────────────────────────────────────

def main():
    # ── Locate and load inputs ────────────────────────────────────────────────
    if not GIS_OBS_PATH.exists():
        print(f"ERROR: {GIS_OBS_PATH} not found. Adjust DATA_DIR at top of script.",
              file=sys.stderr)
        return
    if not RPI_PATH.exists():
        print(f"ERROR: {RPI_PATH} not found.", file=sys.stderr)
        return

    try:
        mc_path = resolve_match_context_path()
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return

    match_ctx = load_match_context(mc_path)
    rpi       = load_rpi(RPI_PATH)

    # ── Run ───────────────────────────────────────────────────────────────────
    n_rows               = 0
    n_context_missing    = 0
    n_contest_missing    = 0  # Contest absent from match_context entirely
    n_player_missing     = 0  # Contest present but player record absent
    unmatched_opps       = {}
    gis_vals             = []
    gis_plus_vals        = []
    opp_mods             = []
    lev_mods             = []
    serve_mods_nontrivial = []  # only count when eff threshold met
    recv_mods_nontrivial  = []
    set_mods_nontrivial   = []

    # Stream top-5 without holding full list in memory
    top5 = []

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    print(f"\nReading {GIS_OBS_PATH.name} and writing {OUT_PATH.name} …")
    with open(GIS_OBS_PATH, newline="", encoding="utf-8") as fin, \
         open(OUT_PATH, "w", newline="", encoding="utf-8") as fout:

        reader = csv.DictReader(fin)
        writer = csv.DictWriter(fout, fieldnames=OUTPUT_COLS)
        writer.writeheader()

        for row in reader:
            n_rows += 1
            if n_rows % 50000 == 0:
                print(f"  …{n_rows:,} rows")

            # ── Season / RPI ──────────────────────────────────────────────
            season = (row.get("Season") or "").strip()
            year   = season[:4]
            season_info = rpi.get(year)

            # ── Opponent modifier ────────────────────────────────────────
            opp = row.get("Opponent Team", "")
            if season_info:
                opp_rpi, _matched = lookup_opponent_rpi(opp, season_info, unmatched_opps)
                opp_mod = opponent_modifier(opp_rpi, season_info)
            else:
                opp_rpi = None
                opp_mod = 1.0

            # ── Match context lookup ─────────────────────────────────────
            contest_id = (row.get("ContestID") or "").strip()
            player     = (row.get("Player")    or "").strip()
            date       = (row.get("Date")      or "").strip()
            team       = (row.get("Team")      or "").strip()
            opp_team   = (row.get("Opponent Team") or "").strip()

            player_ctx, _resolved_cid, ctx_found = find_player_context(
                match_ctx, contest_id, date, team, opp_team, player, year
            )
            if not ctx_found:
                n_context_missing += 1
                if contest_id not in match_ctx:
                    n_contest_missing += 1
                else:
                    n_player_missing += 1

            # ── Efficiency mods + leverage ───────────────────────────────
            serve_eff = None
            serve_mod = 1.0
            recv_eff  = None
            recv_mod  = 1.0
            set_eff   = None
            set_mod   = 1.0
            leverage  = 1.0

            if player_ctx is not None:
                # Serve
                sa = player_ctx.get("serve_attempts") or []
                if len(sa) >= SERVE_MIN_ATTEMPTS:
                    imm = sum(1 for a in sa if a.get("immediate_point"))
                    serve_eff = imm / len(sa)
                    serve_mod = interp_mult(serve_eff, SERVE_ANCHORS)
                    serve_mods_nontrivial.append(serve_mod)
                # Receive
                ra = player_ctx.get("receive_attempts") or []
                if len(ra) >= RECEIVE_MIN_ATTEMPTS:
                    imm = sum(1 for a in ra if a.get("immediate_point"))
                    recv_eff = imm / len(ra)
                    recv_mod = interp_mult(recv_eff, RECEIVE_ANCHORS)
                    recv_mods_nontrivial.append(recv_mod)
                # Set — numerator comes from gis_observations row (Assists),
                # denominator from match_context (set_attempts)
                set_attempts = safe_int(player_ctx.get("set_attempts"))
                if set_attempts >= SET_MIN_ATTEMPTS:
                    assists_n = safe_int(row.get("Assists"))
                    set_eff = assists_n / set_attempts
                    set_mod = interp_mult(set_eff, SET_ANCHORS)
                    set_mods_nontrivial.append(set_mod)
                # Leverage
                sse = player_ctx.get("score_state_events") or []
                sd  = player_ctx.get("sets_detail") or []
                leverage = compute_leverage(sse, sd)

            # ── GIS+ calculation ──────────────────────────────────────────
            kills   = safe_int(row.get("Kills"))
            errors  = safe_int(row.get("Errors"))
            bs      = safe_int(row.get("BlockSolos"))
            ba      = safe_int(row.get("BlockAssists"))
            berr    = safe_int(row.get("BErr"))
            assists = safe_int(row.get("Assists"))
            bhe     = safe_int(row.get("BHE"))
            aces    = safe_int(row.get("Aces"))
            serr    = safe_int(row.get("SErr"))
            passes  = safe_int(row.get("Passes"))
            rerr    = safe_int(row.get("RErr"))
            digs_ct = safe_int(row.get("Digs"))

            attacking = (kills - errors)                                   * leverage
            blocking  = (bs + 0.5 * ba - berr)                             * leverage
            setting   = (0.5 * assists - bhe)         * set_mod            * leverage
            serving   = (aces - serr)                 * serve_mod          * leverage
            receiving = (0.25 * passes - rerr)        * recv_mod           * leverage
            digs_b    = (0.25 * digs_ct)                                    * leverage

            gis_plus = round(
                (attacking + blocking + setting + serving + receiving + digs_b) * opp_mod,
                2,
            )

            # ── Emit row ─────────────────────────────────────────────────
            out = {k: row.get(k, "") for k in OUTPUT_COLS if k in row}
            out.update({
                "OpponentRPI":      round(opp_rpi, 5) if opp_rpi is not None else "",
                "OpponentModifier": round(opp_mod, 4),
                "ServeEff":         round(serve_eff, 4) if serve_eff is not None else "",
                "ServeModifier":    round(serve_mod, 4),
                "ReceiveEff":       round(recv_eff, 4)  if recv_eff  is not None else "",
                "ReceiveModifier":  round(recv_mod, 4),
                "SetEff":           round(set_eff, 4)   if set_eff   is not None else "",
                "SetModifier":      round(set_mod, 4),
                "LeverageModifier": round(leverage, 4),
                "GIS_Plus":         gis_plus,
                "ContextMissing":   not ctx_found,
            })
            writer.writerow(out)

            # ── Running stats ────────────────────────────────────────────
            gis_val = safe_float(row.get("GIS"))
            gis_vals.append(gis_val)
            gis_plus_vals.append(gis_plus)
            opp_mods.append(opp_mod)
            lev_mods.append(leverage)

            # Top-5 maintenance
            if len(top5) < 5:
                top5.append((gis_plus, gis_val, row.copy()))
                top5.sort(key=lambda t: t[0], reverse=True)
            elif gis_plus > top5[-1][0]:
                top5[-1] = (gis_plus, gis_val, row.copy())
                top5.sort(key=lambda t: t[0], reverse=True)

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n{'=' * 70}")
    print(f"Total observations: {n_rows:,}")
    ctx_pct = 100 * n_context_missing / max(n_rows, 1)
    print(f"  Context missing (any reason): {n_context_missing:,} ({ctx_pct:.2f}%)")
    print(f"    - Contest not in match_context: {n_contest_missing:,}")
    print(f"    - Contest present, player absent: {n_player_missing:,}")
    print(f"  Unmatched opponent names: {len(unmatched_opps)} distinct, "
          f"{sum(unmatched_opps.values()):,} occurrences")
    print()

    if gis_plus_vals:
        print(f"GIS+  min:  {min(gis_plus_vals):>7.2f}")
        print(f"GIS+  max:  {max(gis_plus_vals):>7.2f}")
        print(f"GIS+ mean:  {sum(gis_plus_vals)/len(gis_plus_vals):>7.2f}")
        print()
        def avg(xs): return sum(xs) / len(xs) if xs else 0.0
        print(f"Mean opponent modifier:       {avg(opp_mods):.4f}")
        print(f"Mean leverage modifier:       {avg(lev_mods):.4f}")
        print(f"Mean serve modifier* :        {avg(serve_mods_nontrivial):.4f}  (n={len(serve_mods_nontrivial):,})")
        print(f"Mean receive modifier* :      {avg(recv_mods_nontrivial):.4f}  (n={len(recv_mods_nontrivial):,})")
        print(f"Mean set modifier* :          {avg(set_mods_nontrivial):.4f}  (n={len(set_mods_nontrivial):,})")
        print(f"  * excludes rows below attempt thresholds (modifier = 1.0)")
        print()

    # Pearson correlation GIS vs GIS+
    if len(gis_vals) > 1:
        n = len(gis_vals)
        mx = sum(gis_vals) / n
        my = sum(gis_plus_vals) / n
        num = sum((gis_vals[i] - mx) * (gis_plus_vals[i] - my) for i in range(n))
        vx  = sum((x - mx) ** 2 for x in gis_vals)
        vy  = sum((y - my) ** 2 for y in gis_plus_vals)
        denom = (vx * vy) ** 0.5
        corr = num / denom if denom > 0 else 0.0
        print(f"Pearson correlation (GIS, GIS+): {corr:.4f}")
        print()

    # Top 5
    print("Top 5 single-match GIS+ scores:")
    hdr = (f"  {'Player':<25} {'Team':<22} {'Opponent':<22} "
           f"{'Date':<12} {'S':>2}  {'GIS':>6}  {'GIS+':>6}")
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    for gp, g, r in top5:
        print(f"  {r.get('Player',''):<25} {r.get('Team',''):<22} "
              f"{r.get('Opponent Team',''):<22} {r.get('Date',''):<12} "
              f"{r.get('S',''):>2}  {g:>6.2f}  {gp:>6.2f}")
    print()

    # Unmatched opponents dump
    if unmatched_opps:
        print(f"Writing unmatched opponent diagnostic to {UNMATCHED_OUT} …")
        with open(UNMATCHED_OUT, "w", encoding="utf-8") as f:
            f.write("# Opponents not found in historical_rpi.json (or had NaN RPI).\n")
            f.write("# All are treated as non-D1 and receive the season-minimum RPI floor.\n")
            f.write("# Format: <occurrences>\\t<opponent_name>\n\n")
            for name, count in sorted(unmatched_opps.items(), key=lambda kv: -kv[1]):
                f.write(f"{count}\t{name}\n")

    size_mb = OUT_PATH.stat().st_size / 1024 / 1024
    print(f"Output: {OUT_PATH}  ({size_mb:.1f} MB)")


main()
