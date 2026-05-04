"""
parse_pbp.py — Phase-1 parser.

Reads a single stats.ncaa.org play-by-play HTML file (saved to
scripts/.pbp-cache/<contestId>.htm) and emits a structured
per-touch JSON dump of the match.

Usage:
    py -X utf8 scripts/parse_pbp.py [contest_id]

Defaults to 6501654 (Texas A&M vs Kentucky, the manual save we have).

Output:
    scripts/.pbp-cache/<contest_id>.parsed.json

Schema (one match):
    {
      "contestId":   "6501654",
      "homeTeam":    "Texas A&M",
      "awayTeam":    "Kentucky",
      "sets": [
        {
          "setNum":  1,
          "rallies": [
            {
              "rallyId":     "2846182924",
              "scoreAfter":  [0, 1],          // [home, away]
              "winnerSide":  "away",
              "result": {
                "type":        "KILL",
                "team":        "away",
                "primary":     "Eva Hudson",
                "secondaries": [],            // multi-player block etc.
                "rawText":     "First ball kill by Eva Hudson"
              },
              "touches": [
                { "team": "home", "action": "SERVE",      "player": "Maddie Waak" },
                { "team": "away", "action": "RECEPTION",  "player": "Brooklyn DeLeye" },
                { "team": "away", "action": "SET",        "player": "Kassie O'Brien" },
                { "team": "away", "action": "ATTACK",     "player": "Eva Hudson" }
              ]
            },
            ...
          ],
          "events": [                          // non-rally rows (subs, etc.)
            { "type": "MATCH_START" },
            { "type": "SET_START" },
            { "type": "SUB_IN",  "team": "home", "player": "Ava Underwood" },
            ...
          ]
        }
      ]
    }
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Optional

from bs4 import BeautifulSoup

CACHE_DIR = Path("scripts/.pbp-cache")

# ─── Action vocabulary ────────────────────────────────────────────────
# Terminal actions (rally-ending) appear in <span class="short_play_text">.
# Non-terminal touches appear in <td class="smtext"> with the row tagged
# class="scoring_plays scoring_plays_<rallyId>".

# Order matters — more specific patterns must come first.
TERMINAL_PATTERNS = [
    # "First ball kill by X" / "Kill by X"
    (re.compile(r"^(?:First ball )?[Kk]ill by (.+)$"),                "KILL"),
    # "Attack error by X"
    (re.compile(r"^Attack error by (.+)$"),                           "ATTACK_ERROR"),
    # "Block error by X"
    (re.compile(r"^Block error by (.+)$"),                            "BLOCK_ERROR"),
    # "Set error by X"
    (re.compile(r"^Set error by (.+)$"),                              "SET_ERROR"),
    # "Reception error by X"
    (re.compile(r"^Reception error by (.+)$"),                        "RECEPTION_ERROR"),
    # "Ball handling error by X"
    (re.compile(r"^Ball handling error by (.+)$"),                    "BHE"),
    # "X serves an ace"
    (re.compile(r"^(.+?) serves an ace$"),                            "ACE"),
    # "X service error"
    (re.compile(r"^(.+?) service error$"),                            "SERVICE_ERROR"),
    # Terminal block (kill block) — looks like "Block by X" or "Block by X, Y"
    (re.compile(r"^Block by (.+)$"),                                  "BLOCK_KILL"),
]

NONTERMINAL_PATTERNS = [
    (re.compile(r"^(.+?) serves$"),         "SERVE"),
    (re.compile(r"^Reception\s+by\s+(.+)$"),"RECEPTION"),
    (re.compile(r"^Set\s+by\s+(.+)$"),      "SET"),
    (re.compile(r"^Attack\s+by\s+(.+)$"),   "ATTACK"),
    (re.compile(r"^Dig\s+by\s+(.+)$"),      "DIG"),
    (re.compile(r"^Block\s+by\s+(.+)$"),    "BLOCK_TOUCH"),
]

EVENT_PATTERNS = [
    (re.compile(r"^Sub in (.+)$"),          "SUB_IN"),
    (re.compile(r"^Sub out (.+)$"),         "SUB_OUT"),
    (re.compile(r"^Match started$"),        "MATCH_START"),
    (re.compile(r"^Match ended$"),          "MATCH_END"),
    (re.compile(r"^Set started$"),          "SET_START"),
    (re.compile(r"^Set ended$"),            "SET_END"),
    (re.compile(r"^Facultative timeout$"),  "TIMEOUT"),
    (re.compile(r"^Team\((.+?)\)"),         "CHALLENGE"),
]


def clean_text(t: str) -> str:
    """Strip whitespace + HTML entities + control chars from a cell's text."""
    if not t:
        return ""
    # Firefox sometimes saves the +/- toggle icons as control chars (U+0001
    # being the most common). Strip the whole C0 range.
    t = re.sub(r"[\x00-\x1f]", " ", t)
    t = t.replace("\xa0", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def parse_players(s: str) -> list[str]:
    """Split a comma-separated player list (used by multi-player blocks)."""
    return [p.strip() for p in s.split(",") if p.strip()]


def classify(text: str, is_terminal: bool):
    """
    Return (action_type, primary_player, secondary_players) given the
    play's text and whether it came from a terminal-action span.
    """
    if not text:
        return None, None, []
    pool = TERMINAL_PATTERNS if is_terminal else NONTERMINAL_PATTERNS
    for pattern, action in pool:
        m = pattern.match(text)
        if m:
            players = parse_players(m.group(1)) if m.groups() else []
            primary = players[0] if players else None
            secondaries = players[1:]
            return action, primary, secondaries
    return None, None, []


def classify_event(text: str):
    """Non-rally event row (subs, timeouts, set/match boundaries)."""
    for pattern, kind in EVENT_PATTERNS:
        m = pattern.match(text)
        if m:
            payload = m.group(1) if m.groups() else None
            return kind, payload
    return None, None


def cell_team(row, home_idx: int = 0, away_idx: int = 2) -> Optional[str]:
    """
    Determine which team owns a row's action by checking which of the
    outer two cells has non-empty text. Returns 'home', 'away', or None.
    """
    cells = row.find_all("td", recursive=False)
    if len(cells) < 3:
        return None
    home_text = clean_text(cells[home_idx].get_text(" "))
    away_text = clean_text(cells[away_idx].get_text(" "))
    if home_text and not away_text:
        return "home"
    if away_text and not home_text:
        return "away"
    if home_text and away_text:
        # Shouldn't happen, but pick the longer one
        return "home" if len(home_text) >= len(away_text) else "away"
    return None


def extract_action_text(row, terminal: bool) -> str:
    """
    Pull the play description text out of the row.

    Terminal rows have <a class="toggleLink"> + <span class="short_play_text">
    + <span class="long_play_text">. Reading the cell text directly gets all
    three concatenated. Read short_play_text alone for the canonical action
    description. (Long text is always identical for our purposes.)

    Non-terminal rows have plain text in the populated outer <td>.
    """
    if terminal:
        span = row.find("span", class_="short_play_text")
        if span:
            return clean_text(span.get_text(" "))
        # Fallback if structure varies
        long_span = row.find("span", class_="long_play_text")
        if long_span:
            return clean_text(long_span.get_text(" "))
        return ""

    cells = row.find_all("td", recursive=False)
    for c in cells:
        txt = clean_text(c.get_text(" "))
        if not txt:
            continue
        # Skip the score cell (just digits / dash)
        if re.fullmatch(r"\d+\s*-\s*\d+", txt):
            continue
        return txt
    return ""


def extract_score(row) -> Optional[tuple[int, int]]:
    """Pull the (home, away) score from the middle cell, if present."""
    cells = row.find_all("td", recursive=False)
    if len(cells) < 3:
        return None
    score_txt = clean_text(cells[1].get_text(" "))
    m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", score_txt)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    return None


def get_rally_id(row) -> Optional[str]:
    """Pull rally ID from class="scoring_plays scoring_plays_<id>"."""
    classes = row.get("class", []) or []
    for c in classes:
        m = re.fullmatch(r"scoring_plays_(\d+)", c)
        if m:
            return m.group(1)
    # Terminal rows: rally id lives in the link's id="play_id_<id>"
    link = row.find("a", id=re.compile(r"play_id_\d+"))
    if link:
        m = re.match(r"play_id_(\d+)", link["id"])
        if m:
            return m.group(1)
    return None


def is_terminal_row(row) -> bool:
    """Terminal rows have a <span class='short_play_text'>."""
    return row.find("span", class_="short_play_text") is not None


def parse_set_table(table, set_num: int) -> dict:
    # Header → team names
    head_ths = table.find("thead").find_all("th")
    home_team = clean_text(head_ths[0].get_text(" "))
    away_team = clean_text(head_ths[2].get_text(" "))

    rallies_by_id: dict[str, dict] = {}
    rally_order: list[str] = []
    events: list[dict] = []

    for row in table.find("tbody").find_all("tr", recursive=False):
        terminal = is_terminal_row(row)
        action_text = extract_action_text(row, terminal=terminal)
        if not action_text:
            continue
        rally_id = get_rally_id(row)
        team = cell_team(row)

        if rally_id is not None:
            rally = rallies_by_id.setdefault(rally_id, {
                "rallyId": rally_id,
                "scoreAfter": None,
                "winnerSide": None,
                "result": None,
                "touches": [],
            })
            if rally_id not in rally_order:
                rally_order.append(rally_id)

            if terminal:
                action, primary, secondaries = classify(action_text, is_terminal=True)
                rally["result"] = {
                    "type":        action,
                    "team":        team,
                    "primary":     primary,
                    "secondaries": secondaries,
                    "rawText":     action_text,
                }
                rally["winnerSide"] = team
                score = extract_score(row)
                if score is not None:
                    rally["scoreAfter"] = list(score)
            else:
                action, primary, _ = classify(action_text, is_terminal=False)
                if action:
                    rally["touches"].append({
                        "team":   team,
                        "action": action,
                        "player": primary,
                    })
            continue

        # Non-rally row: subs, set/match boundaries, timeouts, challenges
        kind, payload = classify_event(action_text)
        ev = {"type": kind or "UNKNOWN", "rawText": action_text}
        if team:
            ev["team"] = team
        if payload:
            ev["payload"] = payload
        events.append(ev)

    rallies = [rallies_by_id[rid] for rid in rally_order]
    return {
        "setNum":   set_num,
        "homeTeam": home_team,
        "awayTeam": away_team,
        "rallies":  rallies,
        "events":   events,
    }


def parse_pbp(html: str, contest_id: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    # Each set lives in a card → "Nth Set" header → table.table.
    # We grab each card-header, derive set num, then find its sibling table.
    sets_out = []
    for card in soup.select("div.card.table-responsive"):
        header = card.find("div", class_="card-header")
        table = card.find("table", class_="table")
        if not header or not table:
            continue
        head_text = clean_text(header.get_text(" ")).lower()
        m = re.match(r"(\d+)(?:st|nd|rd|th)\s+set", head_text)
        if not m:
            continue
        set_num = int(m.group(1))
        sets_out.append(parse_set_table(table, set_num))

    # Match-level fields from the first set's header
    home = sets_out[0]["homeTeam"] if sets_out else None
    away = sets_out[0]["awayTeam"] if sets_out else None

    # Strip per-set redundant team-name copies for the final shape
    for s in sets_out:
        s.pop("homeTeam", None)
        s.pop("awayTeam", None)

    return {
        "contestId": contest_id,
        "homeTeam":  home,
        "awayTeam":  away,
        "sets":      sets_out,
    }


def main() -> None:
    cid = sys.argv[1] if len(sys.argv) > 1 else "6501654"
    # Tolerate either .htm or .html on disk
    candidates = [CACHE_DIR / f"{cid}.htm", CACHE_DIR / f"{cid}.html"]
    in_path = next((p for p in candidates if p.exists()), None)
    if not in_path:
        print(f"ERROR: no {cid}.htm or {cid}.html in {CACHE_DIR}", file=sys.stderr)
        sys.exit(1)

    out_path = CACHE_DIR / f"{cid}.parsed.json"
    print(f"[parse] reading {in_path} ({in_path.stat().st_size:,} bytes)")
    html = in_path.read_text(encoding="utf-8", errors="replace")
    parsed = parse_pbp(html, cid)
    out_path.write_text(json.dumps(parsed, indent=2), encoding="utf-8")
    print(f"[parse] wrote {out_path} ({out_path.stat().st_size:,} bytes)")

    # ─── Sanity summary ────────────────────────────────────────────────
    print()
    print(f"Match: {parsed['homeTeam']} vs {parsed['awayTeam']}")
    print(f"Sets:  {len(parsed['sets'])}")
    total_rallies = total_touches = 0
    action_counts: dict[str, int] = {}
    for s in parsed["sets"]:
        rallies = s["rallies"]
        total_rallies += len(rallies)
        for r in rallies:
            for t in r["touches"]:
                total_touches += 1
                action_counts[t["action"]] = action_counts.get(t["action"], 0) + 1
            if r.get("result") and r["result"].get("type"):
                k = "RESULT_" + r["result"]["type"]
                action_counts[k] = action_counts.get(k, 0) + 1
        # Per-set summary
        last_score = next((r["scoreAfter"] for r in reversed(rallies) if r.get("scoreAfter")), None)
        print(f"  Set {s['setNum']}: {len(rallies)} rallies"
              + (f", final {last_score[0]}-{last_score[1]}" if last_score else ""))
    print()
    print(f"Total rallies: {total_rallies}")
    print(f"Total non-terminal touches: {total_touches}")
    print()
    print("Action breakdown:")
    for action, n in sorted(action_counts.items(), key=lambda x: -x[1]):
        print(f"  {action:<25} {n:>5}")


if __name__ == "__main__":
    main()
