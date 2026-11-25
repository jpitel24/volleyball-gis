/**
 * awards.js
 *
 * Shared computer-All-American / All-Conference / Player-of-the-Year
 * selection logic, extracted from SeasonLookup. Used by SeasonLookup
 * (year-scoped leaderboard panels) and by TeamLookup (badge chips on
 * team-history views).
 *
 * The scoring formulas mirror what's already shipped in SeasonLookup,
 * kept here as a single source of truth:
 *
 *   All-American (national):
 *     aaScore = 0.60 × pGIS
 *             + 0.40 × (T50 pGIS × trust)       trust = min(T50_share/0.33, 1)
 *             + 0.05 × T50_games                small additive volume bonus
 *
 *   All-Conference (one specific conference):
 *     acScore = 0.60 × pGIS
 *             + 0.40 × (inConf pGIS × trust)    trust = min(inConf_games/10, 1)
 *             + 0.05 × inConf_games
 *
 * Position mix (both formats): 3 OH, 2 MB, 1 S, 1 L — 7 total per team.
 * Second team shifts +3/+2/+1/+1 into each bucket.
 *
 * `rowsForYear(playerIndex, year)` extracts the leaderboard-style rows
 * the selectors need (same shape SeasonLookup's `allRows` uses).
 *
 * `computeAwardsIndex(playerIndex, years)` returns a lookup:
 *   Map< `${year}|${playerKey}|${team}`, string[] >
 * where the value is a list of award tags for that player-season, e.g.
 * ['All-American 1st Team', 'Best OH (national)', 'All-Big Ten 1st Team'].
 */

import { posGroup } from './gis.js';

const AA_W_OVERALL   = 0.60;
const AA_W_T50       = 0.40;
const AA_K_T50_GAMES = 0.05;
const AA_T50_TRUST_FULL = 0.33;  // share of games vs T50 at which T50 pGIS is fully trusted

const AC_W_OVERALL   = 0.60;
const AC_W_INCONF    = 0.40;
const AC_K_GAMES     = 0.05;
const AC_INCONF_TRUST_FULL = 10; // games vs. in-conference opp at which inConf pGIS is fully trusted

const POS_LABEL = {
  OH: 'OH', MB: 'MB', S: 'S', L: 'L/DS',
};

// Flatten the player index into one row per (player, season). Mirrors the
// shape SeasonLookup.buildRows() produces so the AA/AC logic can be
// reused verbatim. `minTeamGamesShare` mirrors the Seasons tool's 75%
// team-games filter — keeps mid-season walk-ons out of the leaderboard.
export function rowsForYear(playerIndex, year, minTeamGamesShare = 0.75) {
  if (!playerIndex) return [];
  const rows = [];
  for (const p of playerIndex.players) {
    for (const s of p.seasons) {
      if (s.year !== year) continue;
      if (!s.team || !s.games) continue;
      if (s.teamGames > 0 && s.games / s.teamGames < minTeamGamesShare) continue;
      rows.push({
        playerKey: p.key,
        name: p.name,
        year: s.year,
        team: s.team,
        conference: s.conference,
        position: s.position,
        games: s.games,
        sets: s.sets,
        pGIS: s.pGIS,
        gisPlus: s.gisPlus,
        t50: s.t50,
        inConf: s.inConf,
      });
    }
  }
  return rows;
}

// Pick AVCA-style 7-slot First + Second teams out of a bucketed pool
// scored by whatever metric the caller computed. Offsets shift into the
// bucket (0 = first team, 3/2/1/1 = second team).
function teamFromBuckets(buckets, offsets) {
  return [
    { slot: 'OH', pick: buckets.OH[offsets.OH    ] },
    { slot: 'OH', pick: buckets.OH[offsets.OH + 1] },
    { slot: 'OH', pick: buckets.OH[offsets.OH + 2] },
    { slot: 'MB', pick: buckets.MB[offsets.MB    ] },
    { slot: 'MB', pick: buckets.MB[offsets.MB + 1] },
    { slot: 'S',  pick: buckets.S [offsets.S     ] },
    { slot: 'L',  pick: buckets.L [offsets.L     ] },
  ].filter(s => s.pick);
}

// Compute national AA 1st/2nd team, POY, position awards for one year.
// Rows are those produced by `rowsForYear(..)` above.
export function computeAllAmericans(rows) {
  const byBucket = { OH: [], MB: [], S: [], L: [] };
  for (const r of rows) {
    const grp = posGroup(r.position);
    if (!grp || !byBucket[grp]) continue;
    if (!Number.isFinite(r.pGIS)) continue;
    const t50Games = r.t50?.games || 0;
    const t50PGis  = Number.isFinite(r.t50?.pGIS) ? r.t50.pGIS : 0;
    const totalG   = r.games || 0;
    const t50Share = totalG > 0 ? t50Games / totalG : 0;
    const trust    = Math.min(t50Share / AA_T50_TRUST_FULL, 1.0);
    byBucket[grp].push({
      ...r,
      aaScore: AA_W_OVERALL * r.pGIS
             + AA_W_T50 * (t50PGis * trust)
             + AA_K_T50_GAMES * t50Games,
    });
  }
  for (const k of Object.keys(byBucket)) {
    byBucket[k].sort((a, b) => (b.aaScore || 0) - (a.aaScore || 0));
  }
  const firstTeam  = teamFromBuckets(byBucket, { OH: 0, MB: 0, S: 0, L: 0 });
  const secondTeam = teamFromBuckets(byBucket, { OH: 3, MB: 2, S: 1, L: 1 });
  const allScored = [
    ...byBucket.OH, ...byBucket.MB, ...byBucket.S, ...byBucket.L,
  ].sort((a, b) => (b.aaScore || 0) - (a.aaScore || 0));
  return {
    firstTeam, secondTeam,
    poy: allScored[0] || null,
    positionLeaders: {
      OH: byBucket.OH[0] || null,
      MB: byBucket.MB[0] || null,
      S:  byBucket.S [0] || null,
      L:  byBucket.L [0] || null,
    },
  };
}

// Compute All-Conference 1st/2nd team + conf POY + conf position awards
// for every conference in `rows`. Returns Map<conference, {...}>.
export function computeAllConferences(rows) {
  const byConf = new Map();
  for (const r of rows) {
    if (!r.conference) continue;
    if (!byConf.has(r.conference)) byConf.set(r.conference, []);
    byConf.get(r.conference).push(r);
  }
  const out = new Map();
  for (const [conf, confRows] of byConf.entries()) {
    const byBucket = { OH: [], MB: [], S: [], L: [] };
    for (const r of confRows) {
      const grp = posGroup(r.position);
      if (!grp || !byBucket[grp]) continue;
      if (!Number.isFinite(r.pGIS)) continue;
      const inConfGames = r.inConf?.games || 0;
      const inConfPGis  = Number.isFinite(r.inConf?.pGIS) ? r.inConf.pGIS : 0;
      const trust       = Math.min(inConfGames / AC_INCONF_TRUST_FULL, 1.0);
      byBucket[grp].push({
        ...r,
        acScore: AC_W_OVERALL * r.pGIS
               + AC_W_INCONF  * (inConfPGis * trust)
               + AC_K_GAMES   * inConfGames,
      });
    }
    for (const k of Object.keys(byBucket)) {
      byBucket[k].sort((a, b) => (b.acScore || 0) - (a.acScore || 0));
    }
    const firstTeam  = teamFromBuckets(byBucket, { OH: 0, MB: 0, S: 0, L: 0 });
    const secondTeam = teamFromBuckets(byBucket, { OH: 3, MB: 2, S: 1, L: 1 });
    const allScored = [
      ...byBucket.OH, ...byBucket.MB, ...byBucket.S, ...byBucket.L,
    ].sort((a, b) => (b.acScore || 0) - (a.acScore || 0));
    out.set(conf, {
      firstTeam, secondTeam,
      poy: allScored[0] || null,
      positionLeaders: {
        OH: byBucket.OH[0] || null,
        MB: byBucket.MB[0] || null,
        S:  byBucket.S [0] || null,
        L:  byBucket.L [0] || null,
      },
    });
  }
  return out;
}

// Precompute a flat award map for every player-season across the given
// years. Returns:
//   Map< `${year}|${playerKey}|${team}`, Awards >
// where Awards = {
//   aaTier:      1 | 2 | null,                 // All-American 1st/2nd
//   acTier:      1 | 2 | null,                 // All-Conference 1st/2nd
//   acConf:      string | null,                // which conference (for label)
//   poy:         boolean,                      // National Player of the Year
//   posNat:      boolean,                      // Best at position nationally
//   posConf:     boolean,                      // Best at position in conference
//   confPOY:     boolean,                      // Conference Player of the Year
// }
// The team is part of the key because a transfer plays one season per
// (year, team) and awards are specific to that team-season.
export function computeAwardsIndex(playerIndex, years) {
  const out = new Map();
  if (!playerIndex) return out;
  for (const year of years) {
    const rows = rowsForYear(playerIndex, year);
    const aa   = computeAllAmericans(rows);
    const ac   = computeAllConferences(rows);
    const keyOf = r => `${year}|${r.playerKey}|${r.team}`;
    const seed  = (r) => {
      const k = keyOf(r);
      if (!out.has(k)) out.set(k, {
        aaTier: null, acTier: null, acConf: null,
        poy: false, posNat: false, posConf: false, confPOY: false,
      });
      return out.get(k);
    };
    for (const s of aa.firstTeam)  seed(s.pick).aaTier = 1;
    for (const s of aa.secondTeam) seed(s.pick).aaTier = 2;
    if (aa.poy) seed(aa.poy).poy = true;
    for (const grp of ['OH', 'MB', 'S', 'L']) {
      const leader = aa.positionLeaders[grp];
      if (leader) seed(leader).posNat = true;
    }
    for (const [conf, confAwards] of ac.entries()) {
      for (const s of confAwards.firstTeam) {
        const a = seed(s.pick);
        a.acTier = 1; a.acConf = conf;
      }
      for (const s of confAwards.secondTeam) {
        const a = seed(s.pick);
        if (a.acTier !== 1) { a.acTier = 2; a.acConf = conf; }
      }
      if (confAwards.poy) seed(confAwards.poy).confPOY = true;
      for (const grp of ['OH', 'MB', 'S', 'L']) {
        const leader = confAwards.positionLeaders[grp];
        if (leader) seed(leader).posConf = true;
      }
    }
  }
  return out;
}

// Render-side helper: turn an Awards record into an ordered list of
// short badge labels. Used by the best-player card and lineup chips.
export function awardsToLabels(a, position, conference) {
  if (!a) return [];
  const labels = [];
  if (a.poy) labels.push('National POY');
  if (a.confPOY && conference) labels.push(`${conference} POY`);
  if (a.aaTier === 1) labels.push('All-American 1st Team');
  else if (a.aaTier === 2) labels.push('All-American 2nd Team');
  if (a.acTier === 1 && a.acConf) labels.push(`All-${a.acConf} 1st Team`);
  else if (a.acTier === 2 && a.acConf) labels.push(`All-${a.acConf} 2nd Team`);
  const grp = position ? POS_LABEL[posGroup(position)] : null;
  if (a.posNat && grp) labels.push(`Best ${grp} (national)`);
  if (a.posConf && grp && conference) labels.push(`Best ${grp} (${conference})`);
  return labels;
}
