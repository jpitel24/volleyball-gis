"""
alias_match_context.py
──────────────────────

Stand-alone post-processor: reads public/data/match_context.json,
adds NCAA-numeric-gid aliases for every synthetic-ID entry by walking
scripts/.ncaa-api-cache/<year>/contest/*.json, and writes the file back.

This exists so we don't have to re-parse the giant PBP CSVs just to
add aliases — the alias pass only depends on cached contest metadata.
"""
from __future__ import annotations

import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR.parent / "public" / "data"
OUT_PATH = DATA_DIR / "match_context.json"
CACHE_ROOT = SCRIPT_DIR / ".ncaa-api-cache"

YEARS = [2022, 2023, 2024]  # synthetic-keyed in match_context

# For 2025, match_context uses the PBP-sourced native contestid (e.g. 6386684)
# but gis_observations.csv carries the ncaa-api contestid (e.g. 6479076).
# We bridge the two ID spaces via (date, teams) using the 2025 PBP CSV plus
# cached ncaa-api contest JSONs.
PBP_2025 = Path("C:/Users/gordo/OneDrive/Documents/Volleyball GIS Documents/wvb_pbp_div1_2025.csv")


def norm(s: str) -> str:
    return s.lower().replace(" ", "_").replace("/", "_").replace(".", "").replace("'", "")


def norm_plain(s: str) -> str:
    return s.lower().replace(" ", "_").replace("/", "_")


def main():
    print(f"Loading {OUT_PATH.name} …")
    output = json.loads(OUT_PATH.read_text(encoding="utf-8"))
    print(f"  {len(output):,} entries before aliasing")

    n_alias = 0
    n_missing_syn = 0
    samples_missing = []
    for year in YEARS:
        contest_dir = CACHE_ROOT / str(year) / "contest"
        ids_path = CACHE_ROOT / str(year) / "_gameids.json"
        if not ids_path.exists() or not contest_dir.exists():
            print(f"  [{year}] cache missing — skipping")
            continue
        date_map_raw = json.loads(ids_path.read_text(encoding="utf-8"))
        gid_to_date = {g: d for d, gids in date_map_raw.items() for g in gids}

        year_alias = 0
        year_miss = 0
        for cf in contest_dir.glob("[0-9]*.json"):
            gid = cf.stem
            if gid in output:
                continue
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
            d_iso = date_iso.replace("/", "-")
            try:
                y, mo, da = d_iso.split("-")
                d_us = f"{mo}-{da}-{y}"
            except ValueError:
                d_us = d_iso

            # try multiple normalizations and orderings
            variants = set()
            for ha_fn in (norm_plain, norm):
                h = ha_fn(home)
                a = ha_fn(away)
                pair = sorted([h, a])
                for d in (d_us, d_iso):
                    variants.add(f"{d}_{a}_{h}")
                    variants.add(f"{d}_{h}_{a}")
                    variants.add(f"{d}_{pair[0]}_{pair[1]}")

            hit = None
            for syn in variants:
                if syn in output:
                    hit = syn
                    break
            if hit:
                output[gid] = output[hit]
                n_alias += 1
                year_alias += 1
            else:
                year_miss += 1
                n_missing_syn += 1
                if len(samples_missing) < 8:
                    samples_missing.append((gid, date_iso, away, home, sorted(variants)[:3]))
        print(f"  [{year}] aliased {year_alias:,}  ·  no synthetic match {year_miss:,}")

    # ── 2025 bridge: PBP contestid ↔ ncaa-api gid via (date, teams) ─────────
    if PBP_2025.exists():
        print("\n[2025] bridging PBP contestid ↔ ncaa-api gid …")
        import csv as _csv
        # Build (date_iso, set(team_normed)) → pbp_contestid from PBP first rows
        pbp_key_to_cid: dict[tuple, str] = {}
        seen_cid = set()
        with PBP_2025.open("r", encoding="utf-8-sig", newline="") as f:
            rd = _csv.DictReader(f)
            for row in rd:
                cid = row.get("contestid", "").strip()
                if not cid or cid in seen_cid:
                    continue
                d = row.get("date", "").strip()
                ht = row.get("home_team", "").strip()
                at = row.get("away_team", "").strip()
                if not (d and ht and at):
                    continue
                # d is MM/DD/YYYY → YYYY-MM-DD
                try:
                    mo, da, yr = d.split("/")
                    d_iso = f"{yr}-{mo}-{da}"
                except ValueError:
                    d_iso = d
                teams_norm = frozenset([norm_plain(ht), norm_plain(at)])
                pbp_key_to_cid[(d_iso, teams_norm)] = cid
                seen_cid.add(cid)
        print(f"  indexed {len(pbp_key_to_cid):,} PBP 2025 contests")

        # Walk ncaa-api 2025 cache: for each (date, teams), find matching PBP cid
        contest_dir = CACHE_ROOT / "2025" / "contest"
        ids_path = CACHE_ROOT / "2025" / "_gameids.json"
        n_bridge = 0
        n_miss_pbp = 0
        samples = []
        if ids_path.exists() and contest_dir.exists():
            date_map = json.loads(ids_path.read_text(encoding="utf-8"))
            gid_to_date = {g: d for d, gids in date_map.items() for g in gids}
            for cf in contest_dir.glob("[0-9]*.json"):
                ncaa_gid = cf.stem
                if ncaa_gid in output:
                    continue
                date_iso = gid_to_date.get(ncaa_gid)
                if not date_iso:
                    continue
                try:
                    cj = json.loads(cf.read_text(encoding="utf-8"))
                except Exception:
                    continue
                c0 = (cj.get("contests") or [{}])[0]
                teams = c0.get("teams") or []
                ns = [t.get("nameShort") or t.get("nameFull") or "" for t in teams]
                if len(ns) < 2 or not all(ns):
                    continue
                teams_norm = frozenset([norm_plain(ns[0]), norm_plain(ns[1])])
                pbp_cid = pbp_key_to_cid.get((date_iso.replace("/", "-"), teams_norm))
                if pbp_cid and pbp_cid in output:
                    output[ncaa_gid] = output[pbp_cid]
                    n_bridge += 1
                else:
                    n_miss_pbp += 1
                    if len(samples) < 5:
                        samples.append((ncaa_gid, date_iso, ns, pbp_cid))
        print(f"  bridged {n_bridge:,} 2025 contests · unmatched {n_miss_pbp:,}")
        if samples:
            for s in samples:
                print(f"    miss: {s}")

    print(f"\nTotal aliased: {n_alias:,}  ·  unmatched: {n_missing_syn:,}")
    print(f"Final entry count: {len(output):,}")
    if samples_missing:
        print("Sample unmatched contests (gid, date, away, home, 3 variants tried):")
        for s in samples_missing:
            print(f"  {s}")

    print(f"\nWriting {OUT_PATH.name} …")
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(output, f, separators=(",", ":"))
    size_mb = OUT_PATH.stat().st_size / 1024 / 1024
    print(f"Done.  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
