"""
refresh_inseason.py — daily in-season data refresh orchestrator.

Runs the full data-refresh chain in dependency order:

  1. discover_pbp_ids           — walk RPI page + team schedules (skipped
                                   if --rpi-url is missing; assumes contest
                                   IDs are already discovered)
  2. scrape_pbp                 — Playwright + WARP incremental PBP scrape
  3. scrape_ncaa_boxscores      — Playwright + WARP incremental box-score scrape
  4. parse_all_pbp              — HTML → parsed JSON (all cached, incremental)
  5. parse_ncaa_boxscores       — HTML → per-year box-score CSV
  6. aggregate_pbp_touches      — parsed JSON → touches parquet
  7. build_per_match_efficiency — touches parquet → per-match tier counts
  8. enrich_boxscores_from_pbp  — join tier counts → fill ServeAtt/SetAtt/SetErr
  9. 5× build_*_quality         — REC/SRV/SET/BLK/DIG quality JSONs
 10. identify_starters          — starter cohort across all years
 11. compute_efficiency_baselines — pooled cohort baselines
 12. build_gis_plus_v2 --year all — per-match GIS+ + concat observations
 13. build_pgis_tables + build_category_pgis_tables — percentile tables

Stops BEFORE git commit — writes a summary report to
scripts/.refresh-reports/YYYY-MM-DD.md and (optionally) sends a
Windows toast notification. User reviews the report, then runs
`npm run push-refresh` (or git commit + push manually) to ship.

Semi-auto by design: no data hits main without a human eyeballing
the summary first.

Usage:
    py -X utf8 scripts/refresh_inseason.py --year 2026
    py -X utf8 scripts/refresh_inseason.py --year 2026 --rpi-url URL
    py -X utf8 scripts/refresh_inseason.py --year 2026 --skip-discover
    py -X utf8 scripts/refresh_inseason.py --dry-run
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

PY = sys.executable
SCRIPTS = Path(__file__).resolve().parent
REPORTS_DIR = SCRIPTS / ".refresh-reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class StepResult:
    name: str
    ok: bool
    duration_s: float
    stdout_tail: str = ""
    stderr_tail: str = ""
    skipped: bool = False
    skip_reason: str = ""


def run_step(name: str, cmd: list[str], *,
             dry_run: bool = False,
             critical: bool = False) -> StepResult:
    """Execute one pipeline step, capturing tail of stdout/stderr."""
    print(f"\n━━━ {name} ━━━")
    print(f"  cmd: {' '.join(cmd)}")
    if dry_run:
        print("  (dry-run — not executing)")
        return StepResult(name=name, ok=True, duration_s=0.0, skipped=True,
                          skip_reason="dry-run")
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
    except FileNotFoundError as e:
        elapsed = time.time() - t0
        print(f"  ✗ FAIL — cmd not found: {e}")
        return StepResult(name=name, ok=False, duration_s=elapsed,
                          stderr_tail=str(e))
    elapsed = time.time() - t0
    ok = proc.returncode == 0
    stdout_tail = "\n".join(proc.stdout.splitlines()[-8:]) if proc.stdout else ""
    stderr_tail = "\n".join(proc.stderr.splitlines()[-8:]) if proc.stderr else ""
    if stdout_tail:
        print("  stdout tail:")
        for line in stdout_tail.splitlines():
            print(f"    {line}")
    if stderr_tail:
        print("  stderr tail:")
        for line in stderr_tail.splitlines():
            print(f"    {line}")
    status = "✓ OK" if ok else "✗ FAIL"
    print(f"  {status}  ({elapsed:.1f}s)")
    if not ok and critical:
        print(f"  → critical step failed; aborting orchestrator")
    return StepResult(name=name, ok=ok, duration_s=elapsed,
                      stdout_tail=stdout_tail, stderr_tail=stderr_tail)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True,
                    help="Season year (e.g. 2026 for 2026-27)")
    ap.add_argument("--rpi-url", type=str, default=None,
                    help="stats.ncaa.org selection_rankings URL. If omitted, "
                         "discover step is skipped and existing contest_ids "
                         "file is used.")
    ap.add_argument("--skip-discover", action="store_true",
                    help="Skip the discover step (use existing contest_ids file)")
    ap.add_argument("--skip-baselines", action="store_true",
                    help="Skip starter/baseline recomputation (they're stable "
                         "through a season; monthly cadence is often enough)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the command chain without executing")
    args = ap.parse_args()

    year = args.year
    ids_file = SCRIPTS / ".pbp-build" / f"contest_ids_{year}.txt"

    print(f"═══ refresh_inseason.py — {date.today().isoformat()} ═══")
    print(f"  year:      {year}")
    print(f"  rpi-url:   {args.rpi_url or '(not set — discover will be skipped)'}")
    print(f"  ids-file:  {ids_file}")
    print(f"  dry-run:   {args.dry_run}")

    results: list[StepResult] = []
    overall_start = time.time()

    # ── Step 1: discover ─────────────────────────────────────────
    if args.skip_discover or not args.rpi_url:
        reason = "--skip-discover" if args.skip_discover else "no --rpi-url"
        print(f"\n━━━ discover ━━━\n  SKIP ({reason})")
        results.append(StepResult(name="discover", ok=True, duration_s=0.0,
                                  skipped=True, skip_reason=reason))
    else:
        results.append(run_step("discover",
            [PY, "-X", "utf8", str(SCRIPTS / "discover_pbp_ids.py"),
             "--year", str(year), "--rpi-url", args.rpi_url],
            dry_run=args.dry_run))

    if not ids_file.exists() and not args.dry_run:
        print(f"\n[abort] {ids_file} does not exist — cannot proceed without "
              "contest IDs. Run discover manually first.")
        write_report(results, year, aborted=True)
        return 2

    # ── Step 1.5: build team-conference map from RPI HTML ────────
    # Only runs if discover produced (or previously cached) an RPI page.
    # If not, enrich_conferences later falls back to a prior year's map.
    rpi_html = SCRIPTS / ".pbp-build" / f"rpi_page_{year}.html"
    if rpi_html.exists() or args.dry_run:
        results.append(run_step("build_team_conferences",
            [PY, "-X", "utf8", str(SCRIPTS / "build_team_conferences.py"),
             "--year", str(year)],
            dry_run=args.dry_run))
    else:
        print(f"\n━━━ build_team_conferences ━━━\n  SKIP "
              f"({rpi_html} not found — will fall back on prior year in enrich)")
        results.append(StepResult(name="build_team_conferences", ok=True,
                                  duration_s=0.0, skipped=True,
                                  skip_reason=f"{rpi_html.name} not found"))

    # ── Step 2: scrape PBP ────────────────────────────────────────
    results.append(run_step("scrape_pbp",
        [PY, "-X", "utf8", str(SCRIPTS / "scrape_pbp.py"),
         "--year", str(year), "--ids-file", str(ids_file)],
        dry_run=args.dry_run))

    # ── Step 3: scrape box scores ────────────────────────────────
    results.append(run_step("scrape_ncaa_boxscores",
        [PY, "-X", "utf8", str(SCRIPTS / "scrape_ncaa_boxscores.py"),
         "--year", str(year), "--ids-file", str(ids_file)],
        dry_run=args.dry_run))

    # ── Step 4: parse PBP (all cached, incremental) ──────────────
    results.append(run_step("parse_all_pbp",
        [PY, "-X", "utf8", str(SCRIPTS / "parse_all_pbp.py")],
        dry_run=args.dry_run))

    # ── Step 5: parse box scores (this year) ─────────────────────
    results.append(run_step("parse_ncaa_boxscores",
        [PY, "-X", "utf8", str(SCRIPTS / "parse_ncaa_boxscores.py"),
         "--year", str(year)],
        dry_run=args.dry_run))

    # ── Step 6: aggregate touches ────────────────────────────────
    results.append(run_step("aggregate_pbp_touches",
        [PY, "-X", "utf8", str(SCRIPTS / "aggregate_pbp_touches.py"),
         "--year", str(year)],
        dry_run=args.dry_run))

    # ── Step 7: per-match efficiency ─────────────────────────────
    results.append(run_step("build_per_match_efficiency",
        [PY, "-X", "utf8", str(SCRIPTS / "build_per_match_efficiency.py"),
         "--year", str(year)],
        dry_run=args.dry_run))

    # ── Step 8a: enrich box scores from PBP tier counts ─────────
    results.append(run_step("enrich_boxscores_from_pbp",
        [PY, "-X", "utf8", str(SCRIPTS / "enrich_boxscores_from_pbp.py"),
         "--year", str(year)],
        dry_run=args.dry_run))

    # ── Step 8b: enrich box scores with team conferences ────────
    results.append(run_step("enrich_conferences",
        [PY, "-X", "utf8", str(SCRIPTS / "enrich_conferences.py"),
         "--year", str(year)],
        dry_run=args.dry_run))

    # ── Step 9: 5 quality JSONs ──────────────────────────────────
    for skill in ("reception", "serve", "set", "block", "dig"):
        results.append(run_step(f"build_{skill}_quality",
            [PY, "-X", "utf8",
             str(SCRIPTS / f"build_{skill}_quality.py"),
             "--year", str(year)],
            dry_run=args.dry_run))

    # ── Step 10-11: starters + baselines (optional) ──────────────
    if not args.skip_baselines:
        results.append(run_step("identify_starters",
            [PY, "-X", "utf8", str(SCRIPTS / "identify_starters.py")],
            dry_run=args.dry_run))
        results.append(run_step("compute_efficiency_baselines",
            [PY, "-X", "utf8",
             str(SCRIPTS / "compute_efficiency_baselines.py")],
            dry_run=args.dry_run))
    else:
        for name in ("identify_starters", "compute_efficiency_baselines"):
            print(f"\n━━━ {name} ━━━\n  SKIP (--skip-baselines)")
            results.append(StepResult(name=name, ok=True, duration_s=0.0,
                                      skipped=True, skip_reason="--skip-baselines"))

    # ── Step 12: GIS+ v2 (all years) ─────────────────────────────
    results.append(run_step("build_gis_plus_v2",
        [PY, "-X", "utf8", str(SCRIPTS / "build_gis_plus_v2.py"),
         "--year", "all"],
        dry_run=args.dry_run))

    # ── Step 13: pGIS tables ─────────────────────────────────────
    results.append(run_step("build_pgis_tables",
        [PY, "-X", "utf8", str(SCRIPTS / "build_pgis_tables.py")],
        dry_run=args.dry_run))
    results.append(run_step("build_category_pgis_tables",
        [PY, "-X", "utf8", str(SCRIPTS / "build_category_pgis_tables.py")],
        dry_run=args.dry_run))

    total = time.time() - overall_start
    print(f"\n═══ complete in {total:.0f}s ═══")
    ok_count = sum(1 for r in results if r.ok and not r.skipped)
    fail_count = sum(1 for r in results if not r.ok)
    skip_count = sum(1 for r in results if r.skipped)
    print(f"  {ok_count} ok · {skip_count} skipped · {fail_count} failed")

    report_path = write_report(results, year)
    print(f"\n  Report: {report_path}")
    if fail_count == 0:
        print("  Next step: review the report, then commit + push to ship.")
        print("             (e.g. npm run push-refresh)")
    else:
        print(f"  ⚠ {fail_count} step(s) failed — inspect the report.")

    try_notify(f"volleyball-gis refresh {date.today().isoformat()}",
               f"{ok_count} ok / {fail_count} failed. See report.")
    return 0 if fail_count == 0 else 1


def write_report(results: list[StepResult], year: int, *,
                 aborted: bool = False) -> Path:
    today = date.today().isoformat()
    path = REPORTS_DIR / f"{today}.md"
    lines = [f"# Refresh report — {today}", ""]
    lines.append(f"- **Season:** {year}")
    lines.append(f"- **Total steps:** {len(results)}")
    ok = sum(1 for r in results if r.ok and not r.skipped)
    skipped = sum(1 for r in results if r.skipped)
    failed = sum(1 for r in results if not r.ok)
    lines.append(f"- **OK / Skipped / Failed:** {ok} / {skipped} / {failed}")
    if aborted:
        lines.append("- **ABORTED** — see step log below")
    lines.append("")
    lines.append("| Step | Status | Duration | Notes |")
    lines.append("|---|---|---|---|")
    for r in results:
        status = ("⏭ skip" if r.skipped
                  else ("✓ ok" if r.ok else "✗ FAIL"))
        note = r.skip_reason if r.skipped else ""
        lines.append(f"| {r.name} | {status} | {r.duration_s:.1f}s | {note} |")
    lines.append("")
    lines.append("## Per-step output tails")
    for r in results:
        if r.skipped:
            continue
        lines.append(f"### {r.name}")
        if r.stdout_tail:
            lines.append("```")
            lines.append(r.stdout_tail)
            lines.append("```")
        if r.stderr_tail:
            lines.append("**stderr:**")
            lines.append("```")
            lines.append(r.stderr_tail)
            lines.append("```")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def try_notify(title: str, msg: str) -> None:
    """Send a Windows toast notification if possible. Silent no-op on failure
    or non-Windows platforms."""
    if sys.platform != "win32":
        return
    try:
        # Use PowerShell BurntToast if available, else fall back to msg box.
        ps = ("[reflection.assembly]::loadwithpartialname('System.Windows.Forms')"
              " | out-null; "
              f"[System.Windows.Forms.MessageBox]::Show('{msg}','{title}')"
              " | out-null")
        subprocess.Popen(["powershell", "-NoProfile", "-Command", ps],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


if __name__ == "__main__":
    sys.exit(main())
