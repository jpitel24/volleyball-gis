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

// JS fallback GIS/GIS+ for a single row when the Python overlay misses.
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

// Median of an array of finite numbers. Used for season / career / T50
// pGIS aggregation. Robust to off-night drag in a way that the mean
// isn't — consistency-driven roles (libero, DS) lift naturally because
// their typical-game pGIS lands above the few outlier bad games that
// previously dragged the mean down.
function median(vals) {
  if (!vals || !vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2
    ? s[Math.floor(mid)]
    : (s[mid - 1] + s[mid]) / 2;
}

// Yield back to the main thread so the browser can run animation
// frames, paint, and respond to input between chunks of heavy work.
// Without this, the row-iteration loop below freezes the page for
// 5-10 seconds on mobile and the OS kills the tab as unresponsive.
//
// Prefer requestIdleCallback (Chrome / Edge / Firefox) so we surrender
// the rest of the frame budget; setTimeout is a Safari-shaped fallback.
function yieldToMain() {
  return new Promise(r => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => r(), { timeout: 16 });
    } else {
      setTimeout(r, 0);
    }
  });
}

function pickMostCommonPosition(posCounts) {
  let best = null, bestN = 0;
  for (const [p, n] of Object.entries(posCounts)) {
    if (n > bestN && p && p !== '?') { best = p; bestN = n; }
  }
  return best;
}

// Infer a player's bucket (S | OH | MB | L) from per-set production rates
// over a span of games (a season or a career). Returns null when the
// stat line is ambiguous so callers can fall back to the CSV-tagged
// position. Thresholds chosen to fire only on unambiguous deployment
// signatures — see plan in unified-honking-aho.md (this is the
// "version of C" approach: stats lead, CSV breaks ties + supplies
// sub-tags like OPP/RS/MH).
//
// Inputs:
//   totals — { assists, digs, kills, total_attacks, reception_attempts,
//              block_solos, block_assists } summed across games
//   sets   — total sets played in the same span
function inferPositionFromTotals(totals, sets) {
  if (!sets || sets <= 0) return null;
  const assistsPerSet = (totals.assists            || 0) / sets;
  const digsPerSet    = (totals.digs               || 0) / sets;
  const killsPerSet   = (totals.kills              || 0) / sets;
  const attksPerSet   = (totals.total_attacks      || 0) / sets;
  const recvPerSet    = (totals.reception_attempts || 0) / sets;
  const blocksPerSet  = ((totals.block_solos || 0) + 0.5 * (totals.block_assists || 0)) / sets;

  // Setter: only role that puts up 5+ assists/set.
  if (assistsPerSet >= 5.0) return 'S';
  // Libero/DS: no-attack, high-dig, no-block.
  if (attksPerSet < 0.5 && digsPerSet >= 2.0 && blocksPerSet < 0.15) return 'L';
  // Middle: heavy blocking, no back-row receive (rotates out).
  if (blocksPerSet >= 0.8 && recvPerSet < 1.0) return 'MB';
  // Outside: kill volume + receives serves (six-rotation pin).
  if (killsPerSet >= 1.5 && recvPerSet >= 1.0) return 'OH';
  return null;
}

let cachedPromise = null;

export function loadPlayerIndex(pgisTables, rpiByYear) {
  if (cachedPromise) return cachedPromise;

  const top50Sets = buildTop50BySeason(rpiByYear);

  cachedPromise = (async () => {
    // Fire everything off in parallel — loadYear/loadGisPlus are memoized
    // module-scope, so these are free if the Game Browser already ran.
    // loadGisPlus() now stream-parses the 33 MB CSV through
    // fetch().body.getReader() so peak heap during the build stays in
    // the 25-30 MB range instead of the 150+ MB the old full-text parse
    // produced (which crashed iOS Safari).
    const [yearIndices, gisPlusMap] = await Promise.all([
      Promise.all(YEARS.map(y => loadYear(y).catch(err => {
        console.warn(`[playerIndex] skip ${y}:`, err?.message || err);
        return null;
      }))),
      loadGisPlus().catch(() => new Map()),
    ]);

    // byPlayer: key → { name, teamCounts, posCounts, teamsOrder, seasons: { [year]: SeasonAgg } }
    const byPlayer = new Map();

    // teamYearGamesByYear[year][team] = Set<gameKey> — populated below.
    const teamYearGamesByYear = {};

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

      // Per (team, year) game count — count of distinct gameKeys in which
      // this team appeared. Used downstream to gate Season Browser to
      // players who actually showed up for most of their team's matches
      // (otherwise one-game cameos clog the all-time pGIS leaderboard).
      const teamYearGames = teamYearGamesByYear[year] || (teamYearGamesByYear[year] = {});
      for (const [gKey, rows] of Object.entries(idx.byKey)) {
        const teamsInGame = new Set();
        for (const r of rows) if (r.Team) teamsInGame.add(r.Team);
        for (const team of teamsInGame) {
          if (!teamYearGames[team]) teamYearGames[team] = new Set();
          teamYearGames[team].add(gKey);
        }
      }

      // Flatten all rows from the year's byKey map (this is every team-match
      // row; each player appears once per game they played). Yield to
      // the main thread every CHUNK_ROWS rows so mobile browsers don't
      // kill the tab as unresponsive during the multi-second build.
      const CHUNK_ROWS = 5000;
      let processedRows = 0;
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

          // Skip ghost appearances: the NCAA CSV credits every rostered
          // player with the match's total sets even when they didn't
          // take the floor. Those rows come through with ns > 0 but
          // literally every counting stat at zero. A real appearance
          // produces at least one action (pass, attack, block, dig,
          // etc.) so a fully-zero line is effectively DNP.
          let anyAction = 0;
          for (const k of COUNTING_STATS) {
            if (k === 'sets') continue;
            anyAction += stats[k] || 0;
          }
          if (anyAction === 0) continue;

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
          if (++processedRows % CHUNK_ROWS === 0) await yieldToMain();
        }
      }
    }

    // Roll up seasons → career; compute pGIS at all three levels.
    const players = [];
    // Diagnostic counters — printed once at end of build.
    const overrideStats = {
      seasonOverrides: 0,
      seasonByDirection: {},  // e.g. "L→S": 4
      sampleOverrides: [],    // top-N for spot check
    };

    // Same chunked-yield pattern as the row loop above. Per-player
    // rollup is lighter per iteration but ~8k players × per-game pGIS
    // lookups still adds up; yield every 500 to keep the page responsive.
    const CHUNK_PLAYERS = 500;
    let processedPlayers = 0;
    for (const rec of byPlayer.values()) {
      const seasonList = Object.values(rec.seasons)
        .sort((a, b) => b.year - a.year);

      // CSV-tagged career position (most-common roster tag across career).
      // Used as a fallback when both season-level and career-level stat
      // signatures are ambiguous.
      const csvCareerPos = pickMostCommonPosition(rec.posCounts) || '?';

      // Teams ordered by most-recent appearance first.
      const teams = [...new Set(seasonList.map(s => s.team))];

      // Build final season records.
      const seasons = [];
      const careerTotals = zeroTotals();
      let careerSets = 0, careerGames = 0;
      let careerGisTotal = 0, careerGisPlusTotal = 0;
      // Career pGIS uses median across every game played, so collect
      // the per-game pGIS values into an array (instead of just the
      // running sum) — same shape we now use for the season-level calc.
      const careerPGisVals = [];
      // Vs-Top-50 career buckets.
      let t50CareerGames = 0, t50CareerSets = 0;
      let t50CareerGisSum = 0, t50CareerGisPlusSum = 0;
      const t50CareerPGisVals = [];

      for (const s of seasonList) {
        // Position resolution: stat-line first, CSV tag second.
        // 1. Compute the bucket implied by the season's per-set production.
        // 2. If inferred bucket disagrees with the CSV tag's bucket,
        //    OVERRIDE — display the canonical bucket symbol; we drop the
        //    CSV's sub-tag because it was attached to the wrong bucket.
        // 3. If they agree (or stat line is too ambiguous to fire),
        //    keep the full CSV tag so OPP/RS/MH sub-distinctions survive.
        const csvSeasonPos = pickMostCommonPosition(s.posCounts) || csvCareerPos;
        const inferredSeasonBucket = inferPositionFromTotals(s.totals, s.sets);
        let seasonPos = csvSeasonPos;
        if (inferredSeasonBucket && posGroup(csvSeasonPos) !== inferredSeasonBucket) {
          seasonPos = inferredSeasonBucket;
          overrideStats.seasonOverrides += 1;
          const dir = `${posGroup(csvSeasonPos) || '?'}→${inferredSeasonBucket}`;
          overrideStats.seasonByDirection[dir] = (overrideStats.seasonByDirection[dir] || 0) + 1;
          overrideStats.sampleOverrides.push({
            name: rec.name, year: s.year, sets: s.sets,
            csv: csvSeasonPos, inferred: inferredSeasonBucket,
            assistsPerSet: (s.totals.assists || 0) / s.sets,
            digsPerSet:    (s.totals.digs    || 0) / s.sets,
            killsPerSet:   (s.totals.kills   || 0) / s.sets,
            blocksPerSet:  ((s.totals.block_solos || 0) + 0.5 * (s.totals.block_assists || 0)) / s.sets,
            recvPerSet:    (s.totals.reception_attempts || 0) / s.sets,
          });
        }
        // Most-common team that season — shields against stray rows (e.g.
        // a single mis-attributed game or a same-name player at another
        // school).
        let seasonTeam = null, seasonTeamN = 0;
        for (const [t, n] of Object.entries(s.teamCounts || {})) {
          if (n > seasonTeamN) { seasonTeam = t; seasonTeamN = n; }
        }
        // Display = sets-weighted per-set rate. Using /sets instead of
        // /games removes the bias against players whose teams sweep more
        // often: a setter on a 3-set sweep team stacks fewer total GIS
        // points per match than one on a 5-set grinder team without
        // being any less efficient. Per-set rate compares like to like.
        const gisPerSet     = s.sets > 0 ? s.gisTotalSum     / s.sets : 0;
        const gisPlusPerSet = s.sets > 0 ? s.gisPlusTotalSum / s.sets : 0;

        // Per-game pGIS — per-set rate for the single match, looked up
        // against that match's position × nSets baseline. If the player
        // appeared (sets > 0) but produced no measurable GIS+ (bench role,
        // lopsided sweep, late-sub DS), computePGIS returns null; clamp
        // that to 0 so the game still counts toward the season/career
        // average. Otherwise a role player with one big game shows a
        // season pGIS of that one game's score.
        const gamesSorted = s.games_.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        // Collect per-game pGIS values into arrays so season / T50
        // pGIS can be aggregated as a median — robust to off-night
        // drag in a way the mean isn't. Liberos and other consistency-
        // driven roles end up where they should be because their
        // typical-game pGIS sits above the few outlier bad games.
        const seasonPGisVals = [];
        // Vs-Top-50 season buckets.
        let t50Games = 0, t50Sets = 0;
        let t50GisSum = 0, t50GisPlusSum = 0;
        const t50PGisVals = [];
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
            seasonPGisVals.push(gPGis || 0);
            if (g.vsTop50) {
              t50Games   += 1;
              t50Sets    += g.sets;
              t50GisSum     += g.gis;       // per-match totals
              t50GisPlusSum += g.gisPlus;
              t50PGisVals.push(gPGis || 0);
            }
          }
        }
        // Season pGIS = median of per-game pGIS values. Replaces the
        // old mean — bad games drag the mean down disproportionately
        // for consistency-driven roles, while the median tracks the
        // typical-game level the player produces.
        const seasonPGIS = median(seasonPGisVals);
        const t50Season = t50Games > 0 ? {
          games:   t50Games,
          sets:    t50Sets,
          gis:     t50Sets > 0 ? t50GisSum     / t50Sets : 0,
          gisPlus: t50Sets > 0 ? t50GisPlusSum / t50Sets : 0,
          pGIS:    median(t50PGisVals),
        } : null;

        // How many games the player's primary team played that season.
        // games / teamGames → "share of team's slate the player appeared
        // in" — the Season Browser uses this to gate out one-off cameos.
        const teamYearGames = teamYearGamesByYear[s.year] || {};
        const teamGameSet   = seasonTeam ? teamYearGames[seasonTeam] : null;
        const teamGames     = teamGameSet ? teamGameSet.size : 0;

        seasons.push({
          year:     s.year,
          team:     seasonTeam || '',
          position: seasonPos,
          sets:     s.sets,
          games:    s.games,
          teamGames,
          totals:   s.totals,
          gis:      gisPerSet,
          gisPlus:  gisPlusPerSet,
          pGIS:     seasonPGIS,
          t50:      t50Season,
          gameLog:  gamesSorted,
        });

        addTotals(careerTotals, s.totals);
        careerSets         += s.sets;
        careerGames        += s.games;
        careerGisTotal     += s.gisTotalSum;
        careerGisPlusTotal += s.gisPlusTotalSum;
        for (const v of seasonPGisVals) careerPGisVals.push(v);
        t50CareerGames     += t50Games;
        t50CareerSets      += t50Sets;
        t50CareerGisSum    += t50GisSum;
        t50CareerGisPlusSum += t50GisPlusSum;
        for (const v of t50PGisVals) t50CareerPGisVals.push(v);
      }

      if (careerSets === 0) continue;  // zero-activity filter

      // Sets-weighted per-set rate — same logic as season-level (see
      // gisPerSet block above). /sets, not /games, so length-biased
      // schedules don't pad the headline number.
      const careerGis     = careerSets > 0 ? careerGisTotal     / careerSets : 0;
      const careerGisPlus = careerSets > 0 ? careerGisPlusTotal / careerSets : 0;

      // Career position: same stats-first / CSV-fallback logic as season.
      // A career-long setter shows S; a player who switched mid-career
      // (Villar L/DS → S in 2025) sees their season-by-season records
      // resolve correctly while the career display lands on whichever
      // bucket dominated total sets played.
      const inferredCareerBucket = inferPositionFromTotals(careerTotals, careerSets);
      const careerPos = (inferredCareerBucket && posGroup(csvCareerPos) !== inferredCareerBucket)
        ? inferredCareerBucket
        : csvCareerPos;

      // Career pGIS = median across every per-game pGIS the player has
      // produced. Same robustness benefit as the season-level calc.
      const careerPGIS = median(careerPGisVals);

      const t50Career = t50CareerGames > 0 ? {
        games:   t50CareerGames,
        sets:    t50CareerSets,
        gis:     t50CareerSets > 0 ? t50CareerGisSum     / t50CareerSets : 0,
        gisPlus: t50CareerSets > 0 ? t50CareerGisPlusSum / t50CareerSets : 0,
        pGIS:    median(t50CareerPGisVals),
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
      if (++processedPlayers % CHUNK_PLAYERS === 0) await yieldToMain();
    }

    // Sort by career GIS+ desc for default top-N display.
    players.sort((a, b) => (b.career.gisPlus || 0) - (a.career.gisPlus || 0));

    // Diagnostic — fires once per page load. Tells us how often the
    // stat-line classifier disagrees with the NCAA CSV roster tag and in
    // which directions, so we can tune thresholds without flying blind.
    try {
      const sortedSamples = overrideStats.sampleOverrides
        .slice()
        .sort((a, b) => b.sets - a.sets)
        .slice(0, 20);
      console.log(`[playerIndex] Position overrides: ${overrideStats.seasonOverrides} season-level`);
      console.log('[playerIndex] By direction:', overrideStats.seasonByDirection);
      console.log('[playerIndex] Top-20 overrides by sets:', sortedSamples);
    } catch (_) { /* console may be unavailable */ }

    const byKey = new Map(players.map(p => [p.key, p]));

    // Free intermediate structures so the GC can reclaim them. The
    // gisPlus Map (~24 MB) is only consulted during build; byPlayer is
    // the scratch precursor to `players`; yearIndices holds parsed CSV
    // rows that were copied into per-game records. Frees 50-80 MB.
    try {
      gisPlusMap?.clear?.();
      byPlayer.clear();
      for (let i = 0; i < yearIndices.length; i++) yearIndices[i] = null;
      yearIndices.length = 0;
    } catch (_) { /* defensive — cleanup must never fail the build */ }

    return { players, byKey };
  })().catch(err => {
    cachedPromise = null;
    throw err;
  });

  return cachedPromise;
}
