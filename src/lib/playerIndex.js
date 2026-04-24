/**
 * playerIndex.js
 * ──────────────
 *
 * Cross-season aggregation for the Player Browser. Walks every row of the
 * four per-year player-match CSVs and groups them into a player record with
 * career / per-season / per-game granularity.
 *
 * Public API:
 *   loadPlayerIndex(pgisTables) → Promise<{ players, byKey }>
 *
 * Where each PlayerRecord has:
 *   key:      "${team_lower}||${player_lower}"  (primary team + name)
 *   name:     canonical display name
 *   team:     primary team (most recent season with stats)
 *   teams:    array of all teams across career, most recent first
 *   position: most-common non-blank P across career
 *   career:   { sets, games, totals, gis, gisPlus, pGIS }
 *   seasons:  SeasonRecord[]  (sorted year desc)
 *
 * SeasonRecord: { year, team, position, sets, games, totals, gis, gisPlus,
 *                 pGIS, games: GameRecord[] }
 * GameRecord:   { gameKey, contestId, date, opponent, location, sets,
 *                 position, totals, gis, gisPlus, pGIS }
 *
 * GIS/GIS+ per game prefer the 46MB overlay CSV (Python-computed, bakes in
 * opp mod + leverage). On overlay miss, fall back to the JS-local GIS
 * formula from gis.js (no opp mod, no leverage — a plain volume-with-errors
 * estimate; fine for pre-season / non-D1 rows the overlay excludes).
 *
 * Season and career GIS/GIS+ are sets-weighted means of the per-game rates.
 * pGIS at every level is recomputed fresh via computePGIS() against the
 * per-position × nSets baselines in pgis_tables.json, so the 0-10 scale
 * stays comparable to what the Game Browser surfaces.
 */

import { loadYear } from './csvGames.js';
import { loadGisPlus, makeKey, seasonStrFromYear } from './gisPlus.js';
import {
  POS_W, ERR_W, ERR_FLOOR, ERR_DAMP, GIS_SCALE,
  computePGIS, posGroup, canonicalName,
} from './gis.js';

const YEARS = [2025, 2024, 2023, 2022];

const COUNTING_STATS = [
  'sets', 'kills', 'errors', 'total_attacks', 'assists',
  'service_aces', 'service_errors', 'serve_attempts',
  'reception_errors', 'reception_attempts',
  'set_errors', 'set_attempts',
  'digs', 'block_solos', 'block_assists',
  'blocking_errors', 'ball_handling_errors', 'points',
];

const num = v => { const n = parseInt(v ?? 0, 10); return Number.isFinite(n) ? n : 0; };
const flo = v => { const f = parseFloat(v ?? 0); return Number.isFinite(f) ? f : 0; };

function zeroTotals() {
  const o = {};
  for (const k of COUNTING_STATS) o[k] = 0;
  return o;
}

function addTotals(dst, src) {
  for (const k of COUNTING_STATS) dst[k] += src[k] || 0;
}

function rowToStats(r) {
  return {
    sets:                 num(r.S),
    kills:                num(r.Kills),
    errors:               num(r.Errors),
    total_attacks:        num(r.TotalAttacks),
    assists:              num(r.Assists),
    service_aces:         num(r.Aces),
    service_errors:       num(r.SErr),
    serve_attempts:       num(r.ServeAtt),
    reception_errors:     num(r.RErr),
    reception_attempts:   num(r.RetAtt),
    set_errors:           num(r.SetErr),
    set_attempts:         num(r.SetAtt),
    digs:                 num(r.Digs),
    block_solos:          num(r.BlockSolos),
    block_assists:        num(r.BlockAssists),
    blocking_errors:      num(r.BErr),
    ball_handling_errors: num(r.BHE),
    points:               flo(r.PTS),
  };
}

// JS fallback GIS/GIS+ for a single row when the overlay misses.
// Mirrors computeGIS() sans opp mod and leverage (avgLev=1, oppMod=1).
function fallbackGis(stats, ns) {
  if (!ns || ns <= 0) return { gis: 0, gisPlus: 0 };
  const raw    = Object.entries(POS_W).reduce((s, [k, w]) => s + (stats[k] || 0) * w, 0);
  const errSum = Object.entries(ERR_W).reduce((s, [k, w]) => s + (stats[k] || 0) * w, 0);
  const errPen = Math.max(ERR_FLOOR, Math.min(1.0, 1.0 - (errSum / (raw + 1)) * ERR_DAMP));
  const gis    = (raw / ns) * errPen * GIS_SCALE;
  return { gis, gisPlus: gis };
}

// Synthetic game key mirroring buildGameIndex() in csvGames.js so Player
// Browser → Game Browser deep-links resolve to the same slot in the year's
// byKey map.
function gameKeyFromRow(r) {
  const cid = r.ContestID;
  if (cid) return `cid_${cid}`;
  const [a, b] = [r.Team, r['Opponent Team']].slice().sort();
  return `${r.Date}_${a}_${b}`;
}

function pickMostCommonPosition(posCounts) {
  let best = null, bestN = 0;
  for (const [p, n] of Object.entries(posCounts)) {
    if (n > bestN && p && p !== '?') { best = p; bestN = n; }
  }
  return best;
}

let cachedPromise = null;

export function loadPlayerIndex(pgisTables) {
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async () => {
    // Fire everything off in parallel — loadYear/loadGisPlus are memoized
    // module-scope, so these are free if the Game Browser already ran.
    const [yearIndices, gisPlusMap] = await Promise.all([
      Promise.all(YEARS.map(y => loadYear(y).catch(err => {
        console.warn(`[playerIndex] skip ${y}:`, err?.message || err);
        return null;
      }))),
      loadGisPlus().catch(() => new Map()),
    ]);

    // byPlayer: key → { name, teamCounts, posCounts, teamsOrder, seasons: { [year]: SeasonAgg } }
    const byPlayer = new Map();

    for (let yi = 0; yi < YEARS.length; yi++) {
      const year = YEARS[yi];
      const idx  = yearIndices[yi];
      if (!idx) continue;
      const seasonStr = seasonStrFromYear(year);

      // Flatten all rows from the year's byKey map (this is every team-match
      // row; each player appears once per game they played).
      for (const [gKey, rows] of Object.entries(idx.byKey)) {
        for (const r of rows) {
          const team   = r.Team;
          const player = r.Player;
          if (!team || !player) continue;
          // Key on player name only so transfers collapse into one record
          // with both teams listed. Same-name homonyms collide (rare; plan
          // design decision #1 — revisit if it surfaces).
          const key = player.toLowerCase().trim();

          let rec = byPlayer.get(key);
          if (!rec) {
            rec = {
              key,
              name: canonicalName(player),
              primaryTeam: team,
              teamCounts: {},
              posCounts: {},
              seasons: {},
            };
            byPlayer.set(key, rec);
          }
          rec.teamCounts[team] = (rec.teamCounts[team] || 0) + 1;
          const rowPos = (r.P || '').trim().toUpperCase();
          if (rowPos) rec.posCounts[rowPos] = (rec.posCounts[rowPos] || 0) + 1;

          const stats = rowToStats(r);
          const ns    = stats.sets;
          if (ns <= 0) continue;

          // Overlay lookup; fall back to JS if missing.
          const gpKey = makeKey(seasonStr, r.Date, team, player);
          const hit   = gisPlusMap.get(gpKey);
          let gisPerSet, gisPlusPerSet;
          if (hit) {
            // Overlay CSV stores per-match totals, not per-set rates.
            gisPerSet     = hit.gis     / ns;
            gisPlusPerSet = hit.gisPlus / ns;
          } else {
            const fb = fallbackGis(stats, ns);
            gisPerSet     = fb.gis;     // already per-set
            gisPlusPerSet = fb.gisPlus;
          }

          let season = rec.seasons[year];
          if (!season) {
            season = {
              year, team,
              posCounts: {},
              sets: 0, games: 0,
              totals: zeroTotals(),
              gisSetsSum: 0, gisPlusSetsSum: 0,
              games_: [],
            };
            rec.seasons[year] = season;
          }
          // A player can show up for multiple teams in a season (transfer
          // mid-year; rare). Keep the team with the most games; first team
          // seen wins ties.
          if (rowPos) season.posCounts[rowPos] = (season.posCounts[rowPos] || 0) + 1;

          season.sets  += ns;
          season.games += 1;
          addTotals(season.totals, stats);
          season.gisSetsSum     += gisPerSet     * ns;
          season.gisPlusSetsSum += gisPlusPerSet * ns;

          season.games_.push({
            gameKey:   gKey,
            contestId: r.ContestID || null,
            date:      r.Date,
            opponent:  r['Opponent Team'] || '',
            location:  (r.Location || 'Neutral'),
            sets:      ns,
            position:  rowPos || '?',
            totals:    stats,
            gis:       gisPerSet,
            gisPlus:   gisPlusPerSet,
            pGIS:      null,  // filled below
          });
        }
      }
    }

    // Roll up seasons → career; compute pGIS at all three levels.
    const players = [];
    for (const rec of byPlayer.values()) {
      const seasonList = Object.values(rec.seasons)
        .sort((a, b) => b.year - a.year);

      // Career position = most common across career.
      const careerPos = pickMostCommonPosition(rec.posCounts) || '?';

      // Teams ordered by most-recent appearance first.
      const teams = [...new Set(seasonList.map(s => s.team))];

      // Build final season records.
      const seasons = [];
      const careerTotals = zeroTotals();
      let careerSets = 0, careerGames = 0;
      let careerGisSum = 0, careerGisPlusSum = 0;

      for (const s of seasonList) {
        const seasonPos = pickMostCommonPosition(s.posCounts) || careerPos;
        const gisPerSet     = s.sets > 0 ? s.gisSetsSum     / s.sets : 0;
        const gisPlusPerSet = s.sets > 0 ? s.gisPlusSetsSum / s.sets : 0;
        const nSetsBucket   = s.games > 0
          ? Math.min(5, Math.max(3, Math.round(s.sets / s.games)))
          : 3;
        const seasonPGIS = computePGIS(gisPlusPerSet, seasonPos, nSetsBucket, pgisTables);

        // Per-game pGIS.
        const gamesSorted = s.games_.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        for (const g of gamesSorted) {
          const gNs = Math.min(5, Math.max(3, g.sets));
          g.pGIS = computePGIS(g.gisPlus, g.position !== '?' ? g.position : seasonPos, gNs, pgisTables);
        }

        seasons.push({
          year:     s.year,
          team:     s.team,
          position: seasonPos,
          sets:     s.sets,
          games:    s.games,
          totals:   s.totals,
          gis:      gisPerSet,
          gisPlus:  gisPlusPerSet,
          pGIS:     seasonPGIS,
          gameLog:  gamesSorted,
        });

        addTotals(careerTotals, s.totals);
        careerSets       += s.sets;
        careerGames      += s.games;
        careerGisSum     += s.gisSetsSum;
        careerGisPlusSum += s.gisPlusSetsSum;
      }

      if (careerSets === 0) continue;  // zero-activity filter

      const careerGis     = careerGisSum     / careerSets;
      const careerGisPlus = careerGisPlusSum / careerSets;
      const careerNs      = careerGames > 0
        ? Math.min(5, Math.max(3, Math.round(careerSets / careerGames)))
        : 3;
      const careerPGIS = computePGIS(careerGisPlus, careerPos, careerNs, pgisTables);

      players.push({
        key:      rec.key,
        name:     rec.name,
        team:     teams[0] || rec.primaryTeam,
        teams,
        position: careerPos,
        career: {
          sets:    careerSets,
          games:   careerGames,
          totals:  careerTotals,
          gis:     careerGis,
          gisPlus: careerGisPlus,
          pGIS:    careerPGIS,
        },
        seasons,
      });
    }

    // Sort by career GIS+ desc for default top-N display.
    players.sort((a, b) => (b.career.gisPlus || 0) - (a.career.gisPlus || 0));

    const byKey = new Map(players.map(p => [p.key, p]));
    return { players, byKey };
  })().catch(err => {
    cachedPromise = null;
    throw err;
  });

  return cachedPromise;
}
