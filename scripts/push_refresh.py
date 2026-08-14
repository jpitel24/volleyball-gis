"""
push_refresh.py — semi-auto commit + push helper for daily in-season data.

Run after refresh_inseason.py has completed and you've reviewed the
report in scripts/.refresh-reports/. Stages the data files, shows the
diff summary, prompts for confirmation, then commits + pushes to main.

Usage:
    py -X utf8 scripts/push_refresh.py
    npm run push-refresh
"""
from __future__ import annotations

import subprocess
import sys
from datetime import date


DATA_PATHS = [
    "public/data",
    # If any scripts got tweaked as part of the refresh:
    "scripts/build_gis_plus_v2.py",
]


def run(*args) -> subprocess.CompletedProcess:
    return subprocess.run(list(args), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def main() -> int:
    print(f"═══ push_refresh — {date.today().isoformat()} ═══\n")

    # Stage data files (silently ignore paths that don't exist)
    for p in DATA_PATHS:
        run("git", "add", p)

    # Show what's staged
    status = run("git", "status", "--short", "public/data")
    if not status.stdout.strip():
        print("Nothing staged in public/data. Aborting.")
        return 1
    print("Staged changes in public/data:")
    for line in status.stdout.splitlines()[:40]:
        print(f"  {line}")
    if len(status.stdout.splitlines()) > 40:
        print(f"  … and {len(status.stdout.splitlines()) - 40} more")
    print()

    # Diff stats for a size sanity check
    stat = run("git", "diff", "--cached", "--stat")
    if stat.stdout:
        tail = stat.stdout.splitlines()[-1]
        print(f"Diff summary: {tail}")

    # Confirm
    ans = input("\nCommit + push to main? [y/N] ").strip().lower()
    if ans != "y":
        print("Aborted. Staged changes remain — run `git reset` to unstage.")
        return 1

    # Commit + push
    msg = f"Daily refresh: {date.today().isoformat()}"
    commit = run("git", "commit", "-m", msg)
    if commit.returncode != 0:
        print("git commit failed:")
        print(commit.stdout)
        print(commit.stderr)
        return 2
    print(commit.stdout.strip())

    push = run("git", "push", "origin", "HEAD:main")
    if push.returncode != 0:
        print("git push failed:")
        print(push.stdout)
        print(push.stderr)
        return 3
    print(push.stdout.strip() or push.stderr.strip())
    print("\n✓ Pushed. Vercel will deploy shortly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
