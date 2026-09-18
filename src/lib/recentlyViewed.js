import { useEffect, useState, useCallback } from 'react';

/**
 * recentlyViewed — small MRU list per tool, persisted to sessionStorage
 * so it survives navigation between tools without cluttering across
 * new tabs/windows.
 *
 * Each entry is { id, label, href, ...meta }. Callers add via `record()`
 * whenever the user opens a game / player / team. The list is capped
 * at MAX_RECENT items (oldest evicted) and de-duped by id.
 *
 * Read via useRecent(toolKey) — returns [entries, record].
 */

const MAX_RECENT = 5;
const KEY_PREFIX = 'recent.';
// Fires when a tool records a new entry so all mounted sidebars re-read.
const CHANGE_EVENT = 'recent-viewed-change';

function readStore(toolKey) {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage?.getItem(KEY_PREFIX + toolKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch (_) { return []; }
}

function writeStore(toolKey, entries) {
  try {
    window.sessionStorage?.setItem(KEY_PREFIX + toolKey, JSON.stringify(entries));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { toolKey } }));
  } catch (_) { /* ignore */ }
}

export function useRecent(toolKey) {
  const [entries, setEntries] = useState(() => readStore(toolKey));

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (e) => {
      if (e?.detail?.toolKey === toolKey) setEntries(readStore(toolKey));
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, [toolKey]);

  const record = useCallback((entry) => {
    if (!entry || !entry.id) return;
    const current = readStore(toolKey);
    // De-dupe: remove any existing entry with the same id, then unshift
    // the new one to the front. Cap at MAX_RECENT.
    const filtered = current.filter(e => e.id !== entry.id);
    const next = [entry, ...filtered].slice(0, MAX_RECENT);
    writeStore(toolKey, next);
  }, [toolKey]);

  return [entries, record];
}
