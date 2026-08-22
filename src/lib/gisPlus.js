/**
 * gisPlus.js
 *
 * Loads /data/gis_plus_observations.csv once and builds an in-memory Map
 * keyed on (season, date, team, player) → { gis, gisPlus } so the Game
 * Browser and player index can overlay Python-computed opponent-and-
 * leverage-adjusted GIS+ values onto the JS-derived player records.
 *
 * Public API:
 *   loadGisPlus()                → Promise<Map<string, { gis, gisPlus }>>
 *   makeKey(season, date, team, player)
 *                                → canonical lookup key
 *   seasonStrFromYear(year)      → "2022-2023" from 2022
 *
 * Implementation note (mobile-critical):
 *   The CSV is ~33 MB / 610k rows. A naive `text = await r.text(); rows =
 *   parseCSV(text)` peaks JS heap at ~150 MB during the parse (full string
 *   retained, plus the 610k-entry split() array, plus the row-object
 *   array). On iOS Safari that exceeds the per-tab memory budget and the
 *   OS kills the tab — the "A problem repeatedly occurred" error users
 *   were hitting on /players.
 *
 *   We now stream the response via fetch().body.getReader(), decode each
 *   chunk through TextDecoder, and parse line-by-line directly into the
 *   Map. Each chunk is GC'd as soon as it's consumed; the Map grows
 *   incrementally rather than allocating a 610k-row scratch array. Peak
 *   heap during parse drops from ~150 MB to ~25-30 MB — well within iOS
 *   Safari's tab budget. Yields to the main thread every 10k rows so the
 *   page stays responsive during the parse.
 */

/** Canonical join key: season|date|team|player, everything lower-cased/trimmed. */
export function makeKey(season, date, team, player) {
  return `${season}|${date}|${(team || '').trim().toLowerCase()}|${(player || '').trim().toLowerCase()}`;
}

/** Derive "2022-2023" from 2022. The build_gis_plus.py output uses this form. */
export function seasonStrFromYear(year) {
  const y = parseInt(year, 10);
  return `${y}-${y + 1}`;
}

// Parse a single CSV line, honouring quoted values and the escaped-quote
// convention (`""` inside a quoted field → literal `"`). Inlined from
// csvGames.js so this module can stand alone without re-importing the
// full-file parser.
function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else                     { inQuote = false; }
      } else {
        cur += c;
      }
    } else if (c === ',')      { out.push(cur); cur = ''; }
      else if (c === '"')      { inQuote = true; }
      else                     { cur += c; }
  }
  out.push(cur);
  return out;
}

let loaderPromise = null;
// Tracks the maximum Date value seen across observations rows. Used by the
// site footer to answer "how current is the data?" — populated during
// streamGisPlus/parseFullText and exposed via getLatestObservationDate().
let latestObservationDate = null;

export function loadGisPlus() {
  if (loaderPromise) return loaderPromise;
  loaderPromise = streamGisPlus().catch(err => {
    console.warn('[gisPlus] failed to load; UI will fall back to JS GIS+', err);
    return new Map();
  });
  return loaderPromise;
}

/** Returns the ISO date (YYYY-MM-DD) of the newest match observation
 * seen during loadGisPlus, or null if the load hasn't completed / no
 * dated rows landed. */
export function getLatestObservationDate() {
  return latestObservationDate;
}

async function streamGisPlus() {
  const response = await fetch('/data/gis_plus_observations.csv');
  if (!response.ok) throw new Error(`gis_plus_observations.csv HTTP ${response.status}`);

  // Old browsers / environments without ReadableStream: fall back to the
  // simple full-text path. Heavy but functional.
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return parseFullText(text);
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const map     = new Map();
  let buffer    = '';
  let header    = null;
  let idx       = null;            // resolved column indices
  let processed = 0;
  const CHUNK_YIELD = 10000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Pull complete lines out of the buffer one at a time.
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      // Trim trailing \r for CRLF files; strip leading BOM on the very first line.
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (!header && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
      if (!line) continue;

      const fields = parseCSVLine(line);
      if (!header) {
        header = fields;
        idx = {
          Season:   header.indexOf('Season'),
          Date:     header.indexOf('Date'),
          Team:     header.indexOf('Team'),
          Player:   header.indexOf('Player'),
          GIS:      header.indexOf('GIS'),
          GIS_Plus: header.indexOf('GIS_Plus'),
        };
        continue;
      }

      addRow(map, fields, idx);
      if (++processed % CHUNK_YIELD === 0) await yieldToMain();
    }
  }

  // Flush the decoder and consume any trailing line without a final newline.
  buffer += decoder.decode();
  if (buffer.trim()) {
    const fields = parseCSVLine(buffer);
    if (header) addRow(map, fields, idx);
  }

  return map;
}

function addRow(map, fields, idx) {
  const date = fields[idx.Date];
  const key = makeKey(
    fields[idx.Season],
    date,
    fields[idx.Team],
    fields[idx.Player],
  );
  const gis     = parseFloat(fields[idx.GIS]);
  const gisPlus = parseFloat(fields[idx.GIS_Plus]);
  map.set(key, {
    gis:     Number.isFinite(gis)     ? gis     : 0,
    gisPlus: Number.isFinite(gisPlus) ? gisPlus : 0,
  });
  // Track the newest date we see. ISO 'YYYY-MM-DD' compares lexicographically,
  // so a simple string comparison finds the max.
  if (date && (!latestObservationDate || date > latestObservationDate)) {
    latestObservationDate = date;
  }
}

// Old-browser fallback: full-text parse. Same logic as the streamed path
// but without the streaming benefit. Only fires when ReadableStream isn't
// available (rare).
function parseFullText(text) {
  const map = new Map();
  let header = null;
  let idx = null;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const fields = parseCSVLine(line);
    if (!header) {
      header = fields;
      idx = {
        Season:   header.indexOf('Season'),
        Date:     header.indexOf('Date'),
        Team:     header.indexOf('Team'),
        Player:   header.indexOf('Player'),
        GIS:      header.indexOf('GIS'),
        GIS_Plus: header.indexOf('GIS_Plus'),
      };
      continue;
    }
    addRow(map, fields, idx);
  }
  return map;
}

function yieldToMain() {
  return new Promise(r => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => r(), { timeout: 16 });
    } else {
      setTimeout(r, 0);
    }
  });
}
