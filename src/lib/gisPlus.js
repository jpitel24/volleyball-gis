/**
 * gisPlus.js
 *
 * Loads /data/gis_plus_observations.csv once and builds an in-memory Map
 * keyed on (season, date, team, player) → { gis, gisPlus } so the Game
 * Browser can overlay Python-computed opponent-and-leverage-adjusted GIS+
 * values onto the JS-derived player records from computeGIS().
 *
 * Public API:
 *   loadGisPlus()                → Promise<Map<string, { gis, gisPlus }>>
 *   makeKey(season, date, team, player)
 *                                → canonical lookup key
 *   seasonStrFromYear(year)      → "2022-2023" from 2022
 *
 * The whole CSV (~46 MB, 241,978 rows) is fetched once and cached at module
 * scope. Subsequent calls resolve instantly.
 */

import { parseCSV } from './csvGames.js';

/** Canonical join key: season|date|team|player, everything lower-cased/trimmed. */
export function makeKey(season, date, team, player) {
  return `${season}|${date}|${(team || '').trim().toLowerCase()}|${(player || '').trim().toLowerCase()}`;
}

/** Derive "2022-2023" from 2022. The build_gis_plus.py output uses this form. */
export function seasonStrFromYear(year) {
  const y = parseInt(year, 10);
  return `${y}-${y + 1}`;
}

let loaderPromise = null;

/**
 * Fetch & parse gis_plus_observations.csv once. Returns a Map whose keys are
 * produced by makeKey() and whose values are { gis, gisPlus } parsed from the
 * GIS and GIS_Plus columns respectively. Missing file → empty Map (so the UI
 * stays functional; callers should treat a miss as "fall back to JS GIS+").
 */
export function loadGisPlus() {
  if (loaderPromise) return loaderPromise;
  loaderPromise = fetch('/data/gis_plus_observations.csv')
    .then(r => {
      if (!r.ok) throw new Error(`gis_plus_observations.csv HTTP ${r.status}`);
      return r.text();
    })
    .then(text => {
      const rows = parseCSV(text);
      const map = new Map();
      for (const r of rows) {
        const key = makeKey(r.Season, r.Date, r.Team, r.Player);
        const gis     = parseFloat(r.GIS);
        const gisPlus = parseFloat(r.GIS_Plus);
        map.set(key, {
          gis:     Number.isFinite(gis)     ? gis     : 0,
          gisPlus: Number.isFinite(gisPlus) ? gisPlus : 0,
        });
      }
      return map;
    })
    .catch(err => {
      console.warn('[gisPlus] failed to load; UI will fall back to JS GIS+', err);
      return new Map();
    });
  return loaderPromise;
}
