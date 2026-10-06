"""IPRoyal residential proxy helper.

Loads credentials from scripts/.pbp-build/iproyal_creds.txt (gitignored),
builds a sticky-session US-targeted proxy config for Playwright, and
verifies via ipinfo.io that the session actually landed on a US IP.
Occasionally IPRoyal falls back to a random country when the US pool is
briefly tapped out — we rotate the session id and retry.

Modifier syntax lives on the PASSWORD side (not the username), per
IPRoyal's dashboard output:

    username = <base_user>
    password = <base_pwd>_country-US_session-<sid>_lifetime-30m

Usage:
    from _iproyal import establish_us_session
    proxy = establish_us_session()  # dict Playwright accepts via launch(proxy=...)
"""
from __future__ import annotations

import json
import random
import string
import urllib.parse
import urllib.request
from pathlib import Path

CREDS_FILE = Path("scripts/.pbp-build/iproyal_creds.txt")


def _load_creds() -> dict:
    if not CREDS_FILE.exists():
        raise RuntimeError(
            f"IPRoyal creds missing — put host/port/username/password in "
            f"{CREDS_FILE} (one key=value per line)"
        )
    out = {}
    for line in CREDS_FILE.read_text(encoding="utf-8").splitlines():
        k, _, v = line.strip().partition("=")
        if k:
            out[k] = v
    for req in ("host", "port", "username", "password"):
        if req not in out or not out[req]:
            raise RuntimeError(f"IPRoyal creds missing {req!r} in {CREDS_FILE}")
    return out


def _rand_session_id() -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=10))


def build_proxy(session_id: str | None = None, country: str = "US",
                lifetime_min: int = 30) -> tuple[dict, str]:
    """Build a Playwright `proxy=` dict pinned to a sticky residential IP
    in `country`, holding for up to `lifetime_min` minutes. Returns the
    dict plus the random session id so callers can log/reuse it."""
    creds = _load_creds()
    sid = session_id or _rand_session_id()
    sticky_pwd = (
        f"{creds['password']}"
        f"_country-{country}"
        f"_session-{sid}"
        f"_lifetime-{lifetime_min}m"
    )
    return (
        {
            "server": f"http://{creds['host']}:{creds['port']}",
            "username": creds["username"],
            "password": sticky_pwd,
        },
        sid,
    )


def _probe_ip(proxy: dict, timeout_s: int = 20) -> dict:
    """Fetch ipinfo.io through the proxy and return the parsed JSON."""
    user = urllib.parse.quote(proxy["username"])
    pwd = urllib.parse.quote(proxy["password"])
    host_port = proxy["server"].replace("http://", "").replace("https://", "")
    url = f"http://{user}:{pwd}@{host_port}"
    handler = urllib.request.ProxyHandler({"http": url, "https": url})
    opener = urllib.request.build_opener(handler)
    with opener.open("http://ipinfo.io/json", timeout=timeout_s) as r:
        return json.loads(r.read().decode("utf-8"))


def establish_us_session(max_attempts: int = 5, verbose: bool = True
                         ) -> tuple[dict, dict]:
    """Build a sticky US session, verify, and return (proxy_dict, ipinfo).

    If the session lands outside the US (IPRoyal fallback behavior), the
    session id is rotated and we try again. Raises after `max_attempts`."""
    for attempt in range(1, max_attempts + 1):
        proxy, sid = build_proxy()
        try:
            info = _probe_ip(proxy)
        except Exception as e:
            if verbose:
                print(f"[iproyal] attempt {attempt}: probe failed ({e})")
            continue
        if info.get("country") == "US":
            if verbose:
                print(
                    f"[iproyal] session {sid}: {info.get('ip')} "
                    f"({info.get('city')}, {info.get('region')}) "
                    f"{info.get('org', '')[:60]}"
                )
            return proxy, info
        if verbose:
            print(
                f"[iproyal] attempt {attempt}: session {sid} landed in "
                f"{info.get('country')} ({info.get('city')}), rotating"
            )
    raise RuntimeError(
        f"[iproyal] could not get a US sticky session after {max_attempts} attempts"
    )
