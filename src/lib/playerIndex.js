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
 * Per-game pGIS is computed via computePGIS() against the per-position ×
 * nSets baselines in pgis_tables.json; season and career pGIS are simple
 * averages of the per-match pGIS scores, so heavier seasons naturally
 * carry more weight without the noise of a roll-up rate lookup.
 */

import { loadYear } from './csvGames.js';
import { loadGisPlus, makeKey, seasonStrFromYear } from './gisPlus.js';
import {
  POS_W, ERR_W, ERR_FLOOR, ERR_DAMP, GIS_SCALE,
  computePGIS, posGroup, canonicalName, findRPIValue,
} from './gis.js';

const T50_THRESHOLD = 50;

// Build a per-season Set<team-slug> of top-N RPI teams so opponent lookups
// are O(1). Pre-slugging avoids running the full findRPIValue passes on
// every CSV row.
function buildTop50BySeason(rpiByYear, n = T50_THRESHOLD) {
  const out = {};
  if (!rpiByYear) return out;
  const slug = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [season, table] of Object.entries(rpiByYear)) {
    const entries = Object.entries(table)
      .filter(([name, v]) => name !== '_neutral_point' && Number.isFinite(v))
      .sort((a, b) => b[1] - a[1]);
    const topSet = new Set();
    for (let i = 0; i < Math.min(n, entries.length); i++) {
      topSet.add(slug(entries[i][0]));
    }
    out[season] = topSet;
  }
  return out;
}

// Returns true if oppTeam is a Top-50 RPI team for the given season.
// Uses findRPIValue to resolve abbreviations/aliases, then ranks by value.
function isTop50Opponent(oppTeam, seasonStr, rpiByYear, top50Sets) {
  if (!oppTeam || !rpiByYear) return false;
  // Fast slug path first.
  const slug = oppTeam.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (top50Sets?.[seasonStr]?.has(slug)) return true;
  // Fall back to findRPIValue → rpiToRank for aliased names.
  const rpi = findRPIValue(oppTeam, oppTeam, null, rpiByYear, seasonStr);
  if (!rpi) return false;
  const table = rpiByYear[seasonStr];
  if (!table) return false;
  let rank = 1;
  for (const v of Object.values(table)) { if (v > rpi) rank++; }
  return rank <= T50_THRESHOLD;
}

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
// Returns per-match totals to match the overlay's units.
function fallbackGis(stats, ns) {
  if (!ns || ns <= 0) return { gis: 0, gisPlus: 0 };
  const raw    = Object.entries(POS_W).reduce((s, [k, w]) => s + (stats[k] || 0) * w, 0);
  const errSum = Object.entries(ERR_W).reduce((s, [k, w]) => s + (stats[k] || 0) * w, 0);
  const errPen = Math.max(ERR_FLOOR, Math.min(1.0, 1.0 - (errSum / (raw + 1)) * ERR_DAMP));
  const perSet = (raw / ns) * errPen * GIS_SCALE;
  const total  = perSet * ns;
  return { gis: total, gisPlus: total };
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

export function loadPlayerIndex(pgisTables, rpiByYear) {
  if (cachedPromise) return cachedPromise;

  const top50Sets = buildTop50BySeason(rpiByYear);

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

      // Match-level nSets lookup (3, 4, or 5 — total sets played by the
      // winning team). Used as the pGIS volume denominator so a 1-set
      // cameo is rated against a full match's baseline rather than being
      // 3× inflated via the player's own set count.
      const matchNSets = {};
      for (const g of idx.games || []) matchNSets[g.key] = g.nSets || 3;

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

          // Overlay lookup; fall back to JS if missing. Both paths return
          // per-match totals (matching the units Game Browser displays).
          const gpKey = makeKey(seasonStr, r.Date, team, player);
          const hit   = gisPlusMap.get(gpKey);
          const gameGis     = hit ? hit.gis     : fallbackGis(stats, ns).gis;
          const gameGisPlus = hit ? hit.gisPlus : fallbackGis(stats, ns).gisPlus;

          let season = rec.seasons[year];
          if (!season) {
            season = {
              year,
              teamCounts: {},
              posCounts: {},
              sets: 0, games: 0,
              totals: zeroTotals(),
              gisTotalSum: 0, gisPlusTotalSum: 0,
              games_: [],
            };
            rec.seasons[year] = season;
          }
          // A player can show up for multiple teams in a season (mid-year
          // transfer, data error, or name collision with a different
          // player). Tally team + position counts and pick the most-common
          // at roll-up time.
          season.teamCounts[team] = (season.teamCounts[team] || 0) + 1;
          if (rowPos) season.posCounts[rowPos] = (season.posCounts[rowPos] || 0) + 1;

          season.sets  += ns;
          season.games += 1;
          addTotals(season.totals, stats);
          season.gisTotalSum     += gameGis;
          season.gisPlusTotalSum += gameGisPlus;

          const oppTeam  = r['Opponent Team'] || '';
          // RPI file is keyed on the single year ("2022") rather than
          // the "2022-2023" season string the GIS+ overlay uses.
          const vsTop50  = isTop50Opponent(oppTeam, String(year), rpiByYear, top50Sets);

          season.games_.push({
            gameKey:   gKey,
            contestId: r.ContestID || null,
            date:      r.Date,
            opponent:  oppTeam,
            location:  (r.Location || 'Neutral'),
            sets:      ns,
            matchSets: matchNSets[gKey] || ns,  // total sets played in the match
            position:  rowPos || '?',
            totals:    stats,
            gis:       gameGis,      // per-match total (matches Game Browser)
            gisPlus:   gameGisPlus,
            pGIS:      null,         // filled below
            vsTop50,
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
      let careerGisTotal = 0, careerGisPlusTotal = 0;
      let careerPGisSum = 0, careerPGisCount = 0;
      // Vs-Top-50 career buckets.
      let t50CareerGames = 0, t50CareerSets = 0;
      let t50CareerGisSum = 0, t50CareerGisPlusSum = 0;
      let t50CareerPGisSum = 0, t50CareerPGisCount = 0;

      for (const s of seasonList) {
        const seasonPos  = pickMostCommonPosition(s.posCounts) || careerPos;
        // Most-common team that season — shields against stray rows (e.g.
        // a single mis-attributed game or a same-name player at another
        // school).
        let seasonTeam = null, seasonTeamN = 0;
        for (const [t, n] of Object.entries(s.teamCounts || {})) {
          if (n > seasonTeamN) { seasonTeam = t; seasonTeamN = n; }
        }
        // Display = average per-match (same units as Game Browser totals).
        const gisPerGame     = s.games > 0 ? s.gisTotalSum     / s.games : 0;
        const gisPlusPerGame = s.games > 0 ? s.gisPlusTotalSum / s.games : 0;

        // Per-game pGIS — per-set rate for the single match, looked up
        // against that match's position × nSets baseline. If the player
        // appeared (sets > 0) but produced no measurable GIS+ (bench role,
        // lopsided sweep, late-sub DS), computePGIS returns null; clamp
        // that to 0 so the game still counts toward the season/career
        // average. Otherwise a role player with one big game shows a
        // season pGIS of that one game's score.
        const gamesSorted = s.games_.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        let seasonPGisSum = 0, seasonPGisCount = 0;
        // Vs-Top-50 season buckets.
        let t50Games = 0, t50Sets = 0;
        let t50GisSum = 0, t50GisPlusSum = 0;
        let t50PGisSum = 0, t50PGisCount = 0;
        for (const g of gamesSorted) {
          // Match match-level nSets as Game Browser's computeGIS() does —
          // a 1-set cameo is rated at the match's scale, not the player's
          // own sets (which would 3× inflate the per-set rate and peg
          // pGIS at 10 for any non-zero production).
          const mNs = Math.min(5, Math.max(3, g.matchSets || g.sets || 3));
          const perSet = mNs > 0 ? g.gisPlus / mNs : 0;
          const raw = computePGIS(perSet, g.position !== '?' ? g.position : seasonPos, mNs, pgisTables);
          const gPGis = Number.isFinite(raw) ? raw : (g.sets > 0 ? 0 : null);
          g.pGIS = gPGis;
          if (g.sets > 0) {
            seasonPGisSum += (gPGis || 0);
            seasonPGisCount += 1;
            if (g.vsTop50) {
              t50Games   += 1;
              t50Sets    += g.sets;
              t50GisSum  += g.gis;
              t50GisPlusSum += g.gisPlus;
              t50PGisSum += (gPGis || 0);
              t50PGisCount += 1;
            }
          }
        }
        // Season pGIS = simple average of its games' pGIS. Heavier seasons
        // naturally weight the career average more without an extra rate
        // lookup.
        const seasonPGIS = seasonPGisCount > 0 ? seasonPGisSum / seasonPGisCount : 0;
        const t50Season = t50Games > 0 ? {
          games:   t50Games,
          sets:    t50Sets,
          gis:     t50GisSum     / t50Games,
          gisPlus: t50GisPlusSum / t50Games,
          pGIS:    t50PGisCount > 0 ? t50PGisSum / t50PGisCount : 0,
        } : null;

        seasons.push({
          year:     s.year,
          team:     seasonTeam || '',
          position: seasonPos,
          sets:     s.sets,
          games:    s.games,
          totals:   s.totals,
          gis:      gisPerGame,
          gisPlus:  gisPlusPerGame,
          pGIS:     seasonPGIS,
          t50:      t50Season,
          gameLog:  gamesSorted,
        });

        addTotals(careerTotals, s.totals);
        careerSets         += s.sets;
        careerGames        += s.games;
        careerGisTotal     += s.gisTotalSum;
        careerGisPlusTotal += s.gisPlusTotalSum;
        careerPGisSum      += seasonPGisSum;
        careerPGisCount    += seasonPGisCount;
        t50CareerGames     += t50Games;
        t50CareerSets      += t50Sets;
        t50CareerGisSum    += t50GisSum;
        t50CareerGisPlusSum += t50GisPlusSum;
        t50CareerPGisSum   += t50PGisSum;
        t50CareerPGisCount += t50PGisCount;
      }

      if (careerSets === 0) continue;  // zero-activity filter

      const careerGis     = careerGames > 0 ? careerGisTotal     / careerGames : 0;
      const careerGisPlus = careerGames > 0 ? careerGisPlusTotal / careerGames : 0;
      // Career pGIS = simple average across every match played. A 130-set
      // season naturally contributes more games than a 40-set season.
      const careerPGIS = careerPGisCount > 0 ? careerPGisSum / careerPGisCount : 0;

      const t50Career = t50CareerGames > 0 ? {
        games:   t50CareerGames,
        sets:    t50CareerSets,
        gis:     t50CareerGisSum     / t50CareerGames,
        gisPlus: t50CareerGisPlusSum / t50CareerGames,
        pGIS:    t50CareerPGisCount > 0 ? t50CareerPGisSum / t50CareerPGisCount : 0,
      } : null;

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
          t50:     t50Career,
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
