import { useEffect, useState, useCallback } from 'react';

/**
 * useStickyYear — a shared season selector persisted across every tool.
 *
 * Games, Seasons, and Teams all pick a season. Prior to this hook each tool
 * held its own `useState(2026)` that reset every remount, so navigating
 * Teams-2024 → Players → Teams silently snapped back to 2026. This hook
 * writes the last-picked season to sessionStorage under one shared key so
 * remounts restore it, AND so switching tools carries the season forward
 * (Teams-2024 → Seasons opens 2024, not the tool's default).
 *
 * Returns `[year, setYear]` with the same shape as `useState`. Setting the
 * year also broadcasts a same-tab `storage` event so any other mounted
 * tool re-reads from storage and stays in sync.
 */
const STORAGE_KEY = 'app.season';
const CHANGE_EVENT = 'app-season-change';

function readStored() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage?.getItem(STORAGE_KEY);
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

export function useStickyYear(defaultYear = 2026) {
  const [year, setYearState] = useState(() => readStored() ?? defaultYear);

  const setYear = useCallback((next) => {
    const n = typeof next === 'number' ? next : parseInt(next, 10);
    if (!Number.isFinite(n)) return;
    setYearState(n);
    try {
      window.sessionStorage?.setItem(STORAGE_KEY, String(n));
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: n }));
    } catch (_) { /* ignore */ }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (e) => {
      const n = e?.detail;
      if (Number.isFinite(n) && n !== year) setYearState(n);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, [year]);

  return [year, setYear];
}
