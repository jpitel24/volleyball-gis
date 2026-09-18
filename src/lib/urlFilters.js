import { useEffect, useRef } from 'react';

/**
 * urlFilters — read + write filter state to the URL query string so a
 * copy-pasted link reproduces the exact filtered view the sender saw.
 *
 * Design:
 *   - Filter changes push via `history.replaceState` (not pushState) so
 *     the browser back button doesn't cycle through every filter tweak.
 *   - Empty / default values are omitted from the URL to keep it short.
 *   - The router (see router.js) matches on `pathname` only, so adding
 *     a query string doesn't disturb route matching.
 *
 * Usage in a tool component:
 *
 *   const [posFilter, setPosFilter] = useState(() =>
 *     getUrlFilter('pos') ?? 'ALL'
 *   );
 *   useSyncUrlFilter('pos', posFilter, 'ALL');
 *
 * The hook writes any non-default value to the URL on change and clears
 * the param when the value returns to the default.
 */

export function getUrlFilter(name) {
  if (typeof window === 'undefined') return null;
  try {
    const p = new URLSearchParams(window.location.search);
    const v = p.get(name);
    return v == null ? null : v;
  } catch (_) { return null; }
}

/**
 * Merge a patch of {name: value} into the URL search string, omitting
 * entries whose value equals the tool's default (kept short + clean).
 * Uses replaceState so this doesn't count as a navigation.
 */
export function writeUrlFilters(patch) {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    for (const [name, value] of Object.entries(patch)) {
      if (value == null || value === '' || value === false) {
        url.searchParams.delete(name);
      } else {
        url.searchParams.set(name, String(value));
      }
    }
    // Only touch history if the search string actually changed —
    // avoids spurious history entries under React strict-mode re-renders.
    const next = url.pathname + (url.search ? url.search : '') + url.hash;
    const cur  = window.location.pathname + window.location.search + window.location.hash;
    if (next !== cur) window.history.replaceState(null, '', next);
  } catch (_) { /* ignore */ }
}

/**
 * useSyncUrlFilter — mirror one piece of state into a URL query param.
 * Writes the param when the value differs from the provided default,
 * clears it when it matches. Only writes on change (not on mount) so
 * we don't clobber the URL a user just navigated to.
 */
export function useSyncUrlFilter(name, value, defaultValue) {
  // Track whether the effect has run before; on the very first render
  // we skip writing so the initial URL (which the user probably arrived
  // via) stays intact until they actually change something.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const shouldClear = value === defaultValue || value == null || value === '';
    writeUrlFilters({ [name]: shouldClear ? null : value });
  }, [name, value, defaultValue]);
}
