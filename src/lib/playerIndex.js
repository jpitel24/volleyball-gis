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

// Resolve the season key we should use for RPI lookups — falls back
// to the most recent prior year that has RPI data. Mirrors the fallback
// pattern in build_gis_plus_v2.py's resolve_season_rpi(): NCAA doesn't
// publish current-season RPI until several weeks in, so for the
// pre-October window we use the prior season's final RPI as an
// approximation for both opponent-modifier AND T50 classification.
// Team-RPI tier is highly stable year-over-year.
function resolveRpiSeason(seasonStr, rpiByYear) {
  if (!rpiByYear) return null;
  const y = parseInt(seasonStr, 10);
  if (!Number.isFinite(y)) return null;
  for (let offset = 0; offset < 10; offset++) {
    const key = String(y - offset);
    if (rpiByYear[key]) return key;
  }
  return null;
}

// Returns true if oppTeam is a Top-50 RPI team for the given season.
// Uses findRPIValue to resolve abbreviations/aliases, then ranks by value.
function isTop50Opponent(oppTeam, seasonStr, rpiByYear, top50Sets) {
  if (!oppTeam || !rpiByYear) return false;
  const effectiveSeason = resolveRpiSeason(seasonStr, rpiByYear) || seasonStr;
  // Fast slug path first.
  const slug = oppTeam.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (top50Sets?.[effectiveSeason]?.has(slug)) return true;
  // Fall back to findRPIValue → rpiToRank for aliased names.
  const rpi = findRPIValue(oppTeam, oppTeam, null, rpiByYear, effectiveSeason);
  if (!rpi) return false;
  const table = rpiByYear[effectiveSeason];
  if (!table) return false;
  let rank = 1;
  for (const v of Object.values(table)) { if (v > rpi) rank++; }
  return rank <= T50_THRESHOLD;
}

const YEARS = [2026, 2025, 2024, 2023, 2022];

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
// pGIS aggregation. 50/50 blend of mean and median: median anchors to
// the player's typical-game level (robust to off-night drag), mean
// captures the full distribution (rewards upside spikes, reflects
// off-night clusters honestly). Together they answer both "how good
// are you usually" and "what was your total contribution shape."
// Aggressive normalization used to build the player key. Two goals:
//
//   1. Fold together mojibake variants of the same player name. NCAA's
//      upstream pipeline occasionally double-encodes UTF-8 for players
//      with diacritics, producing garbage bytes like `ä\x86` in place
//      of `ć`. Stripping to lowercase ASCII alphanumerics collapses
//      variants like `Ana Burilović` and `Ana Buriloviä\x86` to the
//      same key `anaburilovic`.
//
//   2. Combined with the team key (see below), it lets us distinguish
//      genuine same-name homonyms at different schools — e.g. two
//      Ella Vogels in 2025 (one at Florida, one at Murray St) become
//      separate records instead of collapsing into a single 53-game
//      Frankenstein season.
//
// Trade-off: a player who legitimately transfers becomes two records
// (one per team). Rare-enough on a season-by-season basis to accept;
// cross-team career rollups would need a separate opt-in merge pass.
function normalizeNameKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Power conferences for tier-based cohort grouping. Includes Pac-12 so
// pre-2025 Pac-12 members (Stanford, Washington, Oregon, etc.) get
// grouped with the other power programs during the years they were in
// the Pac-12 — their competition tier was equivalent even though the
// conference has since dissolved.
export const P4_CONFERENCES = new Set([
  'ACC', 'Big Ten', 'Big 12', 'SEC', 'Pac-12',
]);

export function isP4(conference) {
  return P4_CONFERENCES.has(conference);
}

function median(vals) {
  if (!vals || !vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2
    ? s[Math.floor(mid)]
    : (s[mid - 1] + s[mid]) / 2;
}

function mean(vals) {
  if (!vals || !vals.length) return 0;
  let sum = 0;
  for (const v of vals) sum += v;
  return sum / vals.length;
}

function blendPGIS(vals) {
  if (!vals || !vals.length) return 0;
  return 0.5 * mean(vals) + 0.5 * median(vals);
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
  // EXCLUDE high-volume attackers: real middles get 2-4 quick-attack
  // swings/set, not 4+. A player with blocks BUT ALSO high attack
  // volume + high kills is a front-row pin (6-2 OH or OPP) who
  // happens to block a bit, not a middle. Without this guard, any OH
  // who rotates out for a libero and puts up 0.8+ blocks/set would
  // wrongly override their CSV OH tag to MB (verified against 1,690
  // MB player-seasons on 2025 aggregate — the un-guarded rule
  // misfired at 27%).
  if (blocksPerSet >= 0.8 && recvPerSet < 1.0
      && !(attksPerSet >= 4.0 && killsPerSet >= 2.0)) return 'MB';
  // Six-rotation OH: kill volume + receives serves.
  if (killsPerSet >= 1.5 && recvPerSet >= 1.0) return 'OH';
  return null;
}

let cachedPromise = null;

export function loadPlayerIndex(
  pgisTables,
  rpiByYear,
  receptionQuality = null,
  serveQuality = null,
  setQuality = null,
) {
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
          // Key on (aggressive-normalized-name, team). See normalizeNameKey
          // comment for why the aggressive fold (handles mojibake variants
          // + same-name homonyms at different schools). Team-scoping trades
          // off transfer collapsing for correct same-name splitting.
          const nameKey = normalizeNameKey(player);
          const teamKey = team.toLowerCase().trim();
          const key = `${nameKey}|${teamKey}`;

          let rec = byPlayer.get(key);
          if (!rec) {
            rec = {
              key,
              name: canonicalName(player),
              primaryTeam: team,
              teamCounts: {},
              posCounts: {},
              spellingCounts: {},   // raw-name → count, for picking the
                                    // most-common spelling as display name
              seasons: {},
            };
            byPlayer.set(key, rec);
          }
          rec.teamCounts[team] = (rec.teamCounts[team] || 0) + 1;
          rec.spellingCounts[player] = (rec.spellingCounts[player] || 0) + 1;
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
            gameKey:      gKey,
            contestId:    r.ContestID || null,
            date:         r.Date,
            opponent:     oppTeam,
            location:     (r.Location || 'Neutral'),
            conference:   r.Conference || '',
            oppConference: r['Opponent Conference'] || '',
            sets:         ns,
            matchSets:    matchNSets[gKey] || ns,  // total sets played in the match
            position:     rowPos || '?',
            totals:       stats,
            gis:          gameGis,      // per-match total (matches Game Browser)
            gisPlus:      gameGisPlus,
            pGIS:         null,         // filled below
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

      // Promote the best-spelling display name onto rec.name BEFORE
      // the season loop, so quality-JSON lookups (which use the display
      // name lowercased as their key) hit the correct entry for mojibake-
      // merged records. Ana Burilović's quality JSON is keyed under the
      // correct diacritic form; without this promotion, rec.name might
      // still be the first-seen mojibake spelling and the lookup misses.
      {
        let bestSpelling = null, bestSpellingCount = -1;
        for (const [spelling, count] of Object.entries(rec.spellingCounts || {})) {
          if (count > bestSpellingCount) {
            bestSpellingCount = count;
            bestSpelling = spelling;
          }
        }
        if (bestSpelling) rec.name = canonicalName(bestSpelling);
      }

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
          // Always use the season-level position (`seasonPos`) for the
          // pGIS lookup. seasonPos already has the stat-line override
          // applied (line ~457), so per-game CSV labels that NCAA hasn't
          // updated — e.g. a setter whose roster designation is still
          // "L/DS" from a prior season — get corrected here. Without
          // this, the per-game CSV label feeds raw into computePGIS
          // and the override fires only for display, not for the lookup.
          const lookupPos = seasonPos;
          const raw = computePGIS(perSet, lookupPos, mNs, pgisTables);
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
        // Season pGIS = 50/50 blend of mean + median of per-game pGIS.
        // Median anchors to typical-game level (off-nights don't drag
        // a starter down disproportionately); mean captures the full
        // distribution shape so upside peaks and off-night clusters
        // both register honestly.
        const seasonPGIS = blendPGIS(seasonPGisVals);
        const t50Season = t50Games > 0 ? {
          games:   t50Games,
          sets:    t50Sets,
          gis:     t50Sets > 0 ? t50GisSum     / t50Sets : 0,
          gisPlus: t50Sets > 0 ? t50GisPlusSum / t50Sets : 0,
          pGIS:    blendPGIS(t50PGisVals),
        } : null;

        // How many games the player's primary team played that season.
        // games / teamGames → "share of team's slate the player appeared
        // in" — the Season Browser uses this to gate out one-off cameos.
        const teamYearGames = teamYearGamesByYear[s.year] || {};
        const teamGameSet   = seasonTeam ? teamYearGames[seasonTeam] : null;
        const teamGames     = teamGameSet ? teamGameSet.size : 0;

        // Reception / serve / set quality lookups. Keyed by lowercased
        // name|school|year exactly as the build_*_quality.py scripts
        // emit. rec.key now uses aggressive-normalized name (no spaces,
        // no diacritics) plus team-scoping, so we can't build the
        // lookup key from it directly — instead, reconstruct from the
        // canonical display name (highest-count spelling, Title-Cased),
        // which lowercased matches how the Python builders keyed the
        // JSON. Returns null when the player had too few attempts to
        // qualify or the season's data isn't loaded.
        let recQuality = null;
        let srvQuality = null;
        let setQ       = null;
        if (seasonTeam) {
          const teamKey = seasonTeam.toLowerCase().trim();
          const nameKey = (rec.name || '').toLowerCase().trim();
          const lookupKey = `${nameKey}|${teamKey}|${s.year}`;
          if (receptionQuality) recQuality = receptionQuality[lookupKey] || null;
          if (serveQuality)     srvQuality = serveQuality[lookupKey]     || null;
          if (setQuality)       setQ       = setQuality[lookupKey]       || null;
        }

        // Block efficiency per set — derived from box-score totals,
        // no PBP overlay required. NCAA convention is solo blocks
        // worth 1.0 each, assists 0.5 each (the "team" block credit
        // is split between two blockers); errors subtract one each.
        // Result is "net positive blocks per set" — directly
        // comparable to BPS league leaderboards but error-adjusted.
        const blockEffPerSet = s.sets > 0
          ? ((s.totals.block_solos || 0)
              + 0.5 * (s.totals.block_assists || 0)
              - (s.totals.blocking_errors || 0)
            ) / s.sets
          : 0;

        // Season conference = most-common conference across the game log.
        // A team's conference is stable through a regular season, so this
        // is really just picking the value; the mode-of-many is defensive
        // against stray tournament/postseason rows tagged differently.
        const confCounts = {};
        for (const g of gamesSorted) {
          const c = g.conference || '';
          if (c) confCounts[c] = (confCounts[c] || 0) + 1;
        }
        let seasonConference = '', seasonConfN = 0;
        for (const [c, n] of Object.entries(confCounts)) {
          if (n > seasonConfN) { seasonConference = c; seasonConfN = n; }
        }

        seasons.push({
          year:     s.year,
          team:     seasonTeam || '',
          conference: seasonConference,
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
          recQuality,
          srvQuality,
          setQuality: setQ,
          blockEffPerSet,
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

      // Career pGIS = 50/50 mean+median blend across every per-game
      // pGIS the player has produced. Same aggregation as season-level.
      const careerPGIS = blendPGIS(careerPGisVals);

      const t50Career = t50CareerGames > 0 ? {
        games:   t50CareerGames,
        sets:    t50CareerSets,
        gis:     t50CareerSets > 0 ? t50CareerGisSum     / t50CareerSets : 0,
        gisPlus: t50CareerSets > 0 ? t50CareerGisPlusSum / t50CareerSets : 0,
        pGIS:    blendPGIS(t50CareerPGisVals),
      } : null;

      // rec.name has already been set to the best-spelling canonical form
      // earlier in this loop (before the season loop, so quality-JSON
      // lookups could see it). Just use it as-is here.
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

    // Transfer collapse: merge same-name player records with non-overlapping
    // year sets into a single career-spanning record.
    //
    // The player key is (aggressive-normalized-name, team) — that split
    // correctly keeps distinct people who share a name (two Ella Vogels
    // in 2025, one at Florida, one at Murray St) but ALSO splits genuine
    // transfers into per-team fragments (a player who moved Florida →
    // Nebraska becomes two records).
    //
    // Detection: within a same-name group, if the two records' year sets
    // don't overlap, they can only be the same person (nobody plays for
    // two D1 teams in the same year). Homonym pairs by construction have
    // overlapping years since both were active D1 players simultaneously.
    //
    // Multi-transfer players (3+ teams over a career) merge greedily:
    // sort by earliest year and fold each subsequent record into the
    // running merge if its years are disjoint from every already-folded
    // record. Records that would overlap stay separate (rare).
    //
    // Merged record inherits the primary's key + name, unions all
    // seasons + teams, and has career/t50Career metrics recomputed from
    // the combined per-game pGIS values (using the same blendPGIS
    // aggregation as the initial per-player build).
    {
      const nameGroups = new Map();
      for (const p of players) {
        const nk = normalizeNameKey(p.name);
        if (!nameGroups.has(nk)) nameGroups.set(nk, []);
        nameGroups.get(nk).push(p);
      }
      const toDrop = new Set();
      let mergeCount = 0;
      for (const [nk, group] of nameGroups) {
        if (group.length < 2) continue;
        // Sort by first-season-year so we merge chronologically.
        group.sort((a, b) => {
          const ay = Math.min(...a.seasons.map(s => s.year));
          const by = Math.min(...b.seasons.map(s => s.year));
          return ay - by;
        });
        // Greedy: primary = first record; try to fold each subsequent
        // record if its year set is disjoint from all currently-folded
        // records.
        const folded = [group[0]];
        const foldedYears = new Set(group[0].seasons.map(s => s.year));
        for (let i = 1; i < group.length; i++) {
          const candidate = group[i];
          const cYears = candidate.seasons.map(s => s.year);
          const overlaps = cYears.some(y => foldedYears.has(y));
          if (!overlaps) {
            folded.push(candidate);
            for (const y of cYears) foldedYears.add(y);
          }
          // If overlaps: leave candidate as a separate record (homonym).
        }
        if (folded.length < 2) continue;

        // Fold seconds+ into the primary.
        const primary = folded[0];
        const secondaries = folded.slice(1);
        // Union seasons; sort desc-by-year to match display order.
        primary.seasons = [...primary.seasons, ...secondaries.flatMap(s => s.seasons)]
          .sort((a, b) => b.year - a.year);
        // Teams: chronological order across all seasons, deduped.
        const teamOrder = [];
        const seenTeams = new Set();
        for (const s of [...primary.seasons].sort((a, b) => a.year - b.year)) {
          if (s.team && !seenTeams.has(s.team)) {
            seenTeams.add(s.team);
            teamOrder.push(s.team);
          }
        }
        primary.teams = teamOrder;
        primary.team = teamOrder[teamOrder.length - 1] || primary.team;

        // Recompute career metrics from the unified season list.
        const c = { sets: 0, games: 0, gisTotalSum: 0, gisPlusTotalSum: 0 };
        const pGisVals = [];
        let t50Games = 0, t50Sets = 0, t50GisSum = 0, t50GisPlusSum = 0;
        const t50PGisVals = [];
        for (const s of primary.seasons) {
          c.sets  += s.sets  || 0;
          c.games += s.games || 0;
          c.gisTotalSum     += (s.gis     || 0) * (s.sets || 0);
          c.gisPlusTotalSum += (s.gisPlus || 0) * (s.sets || 0);
          for (const g of s.gameLog || []) {
            if (g.pGIS != null) pGisVals.push(g.pGIS);
            if (g.vsTop50) {
              t50Games += 1;
              t50Sets  += g.sets  || 0;
              t50GisSum     += g.gis     || 0;
              t50GisPlusSum += g.gisPlus || 0;
              if (g.pGIS != null) t50PGisVals.push(g.pGIS);
            }
          }
        }
        primary.career = {
          sets:    c.sets,
          games:   c.games,
          totals:  primary.career.totals,  // kept — per-team totals summing
                                            // is complex; approximate ok for
                                            // display since totals are per-team
                                            // in season records anyway
          gis:     c.sets > 0 ? c.gisTotalSum     / c.sets : 0,
          gisPlus: c.sets > 0 ? c.gisPlusTotalSum / c.sets : 0,
          pGIS:    blendPGIS(pGisVals),
          t50:     t50Games > 0 ? {
            games:   t50Games,
            sets:    t50Sets,
            gis:     t50Sets > 0 ? t50GisSum     / t50Sets : 0,
            gisPlus: t50Sets > 0 ? t50GisPlusSum / t50Sets : 0,
            pGIS:    blendPGIS(t50PGisVals),
          } : null,
        };

        for (const sec of secondaries) toDrop.add(sec);
        mergeCount += secondaries.length;
      }
      // Filter out folded-away records.
      const before = players.length;
      const kept = players.filter(p => !toDrop.has(p));
      players.length = 0;
      for (const p of kept) players.push(p);
      try {
        console.log(`[playerIndex] Transfer merge: folded ${mergeCount} records `
                    + `(${before} → ${players.length})`);
      } catch (_) {}
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

    // Per-season national / P4-tier / conference position rankings.
    // Every qualified season gets three ranks stamped on it, so the
    // Players browser can show "OH · #12/437 nat · #8/220 P4 · #2/18 SEC"
    // for a given season.
    //
    // Qualification (single gate):
    //   - Played in ≥75% of the team's games that season. Filters out
    //     backups, rotation players, and partial-season transfers whose
    //     pGIS isn't anchored to a full season's body of work.
    //
    // Ranks are all computed via the same sort — pGIS desc — and differ
    // only in which cohort they compare against.
    //
    // Unqualified player-seasons get no rank fields, so the PlayerLookup
    // display naturally hides the rank cells for them.
    {
      const MIN_TEAM_SHARE = 0.75;
      const natCohorts  = new Map();   // 'YEAR|GROUP' → [{season, score}]
      const tierCohorts = new Map();   // 'YEAR|GROUP|P4|1' or '…|0'
      const confCohorts = new Map();   // 'YEAR|GROUP|CONFERENCE'
      for (const p of players) {
        for (const s of p.seasons) {
          const grp = posGroup(s.position);
          if (!grp) continue;
          const teamShare = (s.teamGames > 0) ? (s.games / s.teamGames) : 0;
          if (teamShare < MIN_TEAM_SHARE) continue;
          const entry = { season: s, score: s.pGIS || 0 };

          const natKey = `${s.year}|${grp}`;
          if (!natCohorts.has(natKey)) natCohorts.set(natKey, []);
          natCohorts.get(natKey).push(entry);

          const p4Flag = isP4(s.conference) ? 1 : 0;
          const tierKey = `${s.year}|${grp}|${p4Flag}`;
          if (!tierCohorts.has(tierKey)) tierCohorts.set(tierKey, []);
          tierCohorts.get(tierKey).push(entry);

          if (s.conference) {
            const confKey = `${s.year}|${grp}|${s.conference}`;
            if (!confCohorts.has(confKey)) confCohorts.set(confKey, []);
            confCohorts.get(confKey).push(entry);
          }
        }
      }
      const applyRanks = (map, rankField, totalField) => {
        for (const list of map.values()) {
          list.sort((a, b) => b.score - a.score);
          for (let i = 0; i < list.length; i++) {
            list[i].season[rankField]  = i + 1;
            list[i].season[totalField] = list.length;
          }
        }
      };
      applyRanks(natCohorts,  'posRank',     'posRankTotal');
      applyRanks(tierCohorts, 'posRankTier', 'posRankTierTotal');
      applyRanks(confCohorts, 'posRankConf', 'posRankConfTotal');
    }

    const byKey = new Map(players.map(p => [p.key, p]));

    // Free intermediate structures so the GC can reclaim them. byPlayer
    // is the scratch precursor to `players`; yearIndices holds parsed
    // CSV rows that were copied into per-game records. Frees 30-50 MB.
    //
    // DO NOT clear gisPlusMap here — it is the shared cached Map that
    // GameLookup's per-match overlay also consults. Clearing it means
    // any Games-tool visit AFTER a Season/Player/Team browse silently
    // gets an empty overlay and falls back to the JS-derived (wrong-
    // scale) pGIS from computeGIS. The Map is cached at module scope,
    // so keeping it around costs one allocation, not one per visit.
    try {
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
