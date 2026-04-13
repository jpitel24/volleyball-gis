// ─── Constants ────────────────────────────────────────────────────────────────
export const PROXY_BASE = 'https://volleyball-gis-proxy.gordonno24.workers.dev';

export const POS_W = {
  kills: 1.00, service_aces: 1.20, block_solos: 1.10,
  assists: 0.28, block_assists: 0.50, digs: 0.35,
};
export const ERR_W = {
  errors: 0.55, service_errors: 0.35, reception_errors: 0.30,
  ball_handling_errors: 0.45, blocking_errors: 0.30,
};
export const ERR_FLOOR = 0.55;
export const ERR_DAMP  = 1.20;
export const GIS_SCALE = 1.25;

export const CATEGORIES = [
  { key: 'attack',   label: 'Attack',   pos: { kills: 1.00 },                            err: { errors: 0.55 } },
  { key: 'blocking', label: 'Blocking', pos: { block_solos: 1.10, block_assists: 0.50 }, err: { blocking_errors: 0.30 } },
  { key: 'defense',  label: 'Defense',  pos: { digs: 0.35 },                             err: { reception_errors: 0.30 } },
  { key: 'serving',  label: 'Serving',  pos: { service_aces: 1.20 },                     err: { service_errors: 0.35 } },
  { key: 'setting',  label: 'Setting',  pos: { assists: 0.28 },                          err: { ball_handling_errors: 0.45 } },
];

export function computeCategoryGIS(p, ns, avgLev, oppMod) {
  return CATEGORIES.map(({ key, label, pos, err }) => {
    const raw    = Object.entries(pos).reduce((s, [k, w]) => s + (p[k] || 0) * w, 0);
    const errSum = Object.entries(err).reduce((s, [k, w]) => s + (p[k] || 0) * w, 0);
    const errPen = Math.max(ERR_FLOOR, Math.min(1.0, 1.0 - (errSum / (raw + 1)) * ERR_DAMP));
    const vol    = raw / ns;
    const gis        = vol * avgLev * errPen * GIS_SCALE;
    const gisNeutral = vol * errPen * GIS_SCALE;
    return { key, label, gis, gisPlus: gis * oppMod, gisNeutral };
  });
}
export const PGIS_K    = 2.0;

export const POS_GROUP_MAP = {
  S: 'S',
  OH: 'OH', RS: 'OH', OPP: 'OH', OP: 'OH', O: 'OH',
  OPPOSITE: 'OH', OPPO: 'OH', OUTSIDE: 'OH', OS: 'OH',
  MB: 'MB', MH: 'MB',
  L: 'L', DS: 'L', LB: 'L',
};

export const POS_COLORS = {
  OH: '#38bdf8', MB: '#a78bfa', RS: '#fb923c',
  S: '#4ade80', L: '#facc15', DS: '#94a3b8',
};

export const POS_COLORS_SB = {
  OH: '#38bdf8', MB: '#a78bfa', OPP: '#fb923c', RS: '#fb923c',
  S: '#4ade80', L: '#facc15', DS: '#94a3b8',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function posGroup(position) {
  return POS_GROUP_MAP[position?.toUpperCase()?.split('/')[0]?.trim()] || null;
}

export function posColor(p) { return POS_COLORS[p] || '#94a3b8'; }

export function gisTier(g) {
  if (g >= 10)  return ['ELITE',   '#f43f5e'];
  if (g >= 7)   return ['IMPACT',  '#fb923c'];
  if (g >= 4.5) return ['SOLID',   '#4ade80'];
  if (g >= 2.5) return ['PRESENT', '#38bdf8'];
  return              ['LIMITED', '#64748b'];
}

export function pgisLabel(v) {
  if (v === null)  return ['N/A',    'low'];
  if (v >= 9.5)    return ['ELITE',  'elite'];
  if (v >= 8.5)    return ['IMPACT', 'strong'];
  if (v >= 7.5)    return ['SOLID',  'avg'];
  if (v >= 6.0)    return ['GOOD',   'avg'];
  if (v >= 4.0)    return ['AVG',    'below'];
  if (v >= 2.0)    return ['BELOW',  'below'];
  return                  ['LTD',    'low'];
}

export function normaliseTeamName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\b(university|college|state|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export function seasonFromGameId(gameId) {
  const id = parseInt(gameId);
  if (id >= 6500000) return '2025';
  if (id >= 6200000) return '2024';
  return '2023';
}

// ─── RPI modifier ─────────────────────────────────────────────────────────────
// Rank 1 → +5% (1.05), rank 50 → +0% (1.00), last place → -50% (0.50).
// Two linear segments meeting at rank 50.
export function rankToModifier(rank, totalTeams) {
  if (!rank || !totalTeams) return 1.0;
  if (rank <= 50) {
    return 1.05 - (rank - 1) * (0.05 / 49);
  }
  if (totalTeams <= 50) return 1.0;
  return Math.max(0.50, 1.00 - (rank - 50) * (0.50 / (totalTeams - 50)));
}

export function findRPIValue(teamName, gameId, RPI_BY_YEAR) {
  if (!RPI_BY_YEAR) return null;
  const norm   = normaliseTeamName(teamName);
  if (!norm) return null;
  const season = seasonFromGameId(gameId);
  const raw    = RPI_BY_YEAR[season] || RPI_BY_YEAR['2025'] || {};

  // Pass 1: slug match — strip only punctuation/spaces, NOT words like "state".
  // "Texas A&M" → "texasam" matches stored "texas a m" → "texasam" without
  // colliding with "Texas State" → "texasstate" or "Texas" → "texas".
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const inputSlug = slug(teamName);
  for (const [k, v] of Object.entries(raw)) {
    if (slug(k) === inputSlug) return v;
  }

  // Pass 2: exact match on word-stripped norm (handles "University of Kentucky" → "kentucky")
  if (raw[norm] !== undefined) return raw[norm];

  // Pass 3: longest substring match on word-stripped norms
  let best = null, bestLen = 0;
  for (const [stored, val] of Object.entries(raw)) {
    if (stored.includes(norm) || norm.includes(stored)) {
      if (stored.length > bestLen) { best = val; bestLen = stored.length; }
    }
  }
  if (best !== null) return best;

  // Pass 4: 5-char prefix fallback
  if (norm.length >= 5) {
    for (const [stored, val] of Object.entries(raw)) {
      if (stored.length >= 5 && stored.slice(0,5) === norm.slice(0,5)) return val;
    }
  }
  return null;
}

export function rpiToRank(rpiVal, season, RPI_BY_YEAR) {
  if (!rpiVal || !RPI_BY_YEAR) return null;
  const table  = RPI_BY_YEAR[season] || RPI_BY_YEAR['2025'] || {};
  const sorted = Object.values(table).sort((a, b) => b - a);
  const idx    = sorted.findIndex(v => v <= rpiVal);
  return idx >= 0 ? idx + 1 : null;
}

// ─── pGIS ─────────────────────────────────────────────────────────────────────
export function computePGIS(gisRaw, position, nSets, PGIS_TABLES) {
  if (!gisRaw || gisRaw <= 0) return null;
  const grp  = posGroup(position);
  if (!grp) return null;
  const key  = String(Math.min(Math.max(nSets, 3), 5));
  const cell = PGIS_TABLES?.[grp]?.[key];
  if (!cell) return null;

  const p   = cell.p;
  const n   = p.length;
  const raw = Math.round(gisRaw * 100);
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (p[mid] <= raw) lo = mid + 1; else hi = mid; }

  const pct = lo / n;
  return Math.min(10.0, 10 * Math.pow(pct, PGIS_K));
}

// Compute pGIS from a raw archive record (seasonal stat totals).
// Uses the same neutral GIS formula as the live computeGIS path.
export function computeArchivePGIS(rec, PGIS_TABLES) {
  if (!rec?.sets || rec.sets <= 0) return null;
  const raw    = Object.entries(POS_W).reduce((s, [k, w]) => s + (rec[k] || 0) * w, 0);
  const errSum = Object.entries(ERR_W).reduce((s, [k, w]) => s + (rec[k] || 0) * w, 0);
  const errPen = Math.max(ERR_FLOOR, Math.min(1.0, 1.0 - (errSum / (raw + 1)) * ERR_DAMP));
  const gisNeutral = (raw / rec.sets) * errPen * GIS_SCALE;
  const sc = Math.min(5, Math.max(3, Math.round(rec.sets / (rec.games || 1))));
  return computePGIS(gisNeutral, rec.pos, sc, PGIS_TABLES);
}

// ─── Leverage ─────────────────────────────────────────────────────────────────
export function matchLev(nSets, setScores) {
  if (nSets === 5) return 1.40;
  if (nSets === 4) return 1.20;
  if (!setScores.length) return 1.00;
  const avg = setScores.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / setScores.length;
  return avg >= 8 ? 1.00 : 1.10;
}

export function setWinProb(s, r, is5) {
  const win = is5 ? 15 : 25;
  let p = 0.50 + (s - r) * 0.045;
  const sRem = Math.max(win - s, 0), rRem = Math.max(win - r, 0);
  if (sRem <= 3 && s > r) p += 0.08 * (4 - sRem);
  if (rRem <= 3 && r > s) p -= 0.08 * (4 - rRem);
  if (s >= win - 1 && r >= win - 1) p = 0.50 + (s - r) * 0.06;
  return Math.max(0.05, Math.min(0.95, p));
}

export function buildLevMap(pbp, ml) {
  const map = {};
  for (const setData of (pbp.sets || [])) {
    const n = setData.setNumber || 1;
    const is5 = n === 5;
    let ph = 0, pa = 0;
    for (const play of (setData.plays || [])) {
      const hA = play.home_score ?? ph, aA = play.away_score ?? pa;
      const swing = Math.abs(setWinProb(hA, aA, is5) - setWinProb(ph, pa, is5));
      const lw = ml * (1.0 + Math.min(swing / 0.05, 1.5) * 0.4);
      (map[play.player || 'Unknown'] = map[play.player || 'Unknown'] || []).push(lw);
      ph = hA; pa = aA;
    }
  }
  return map;
}

// ─── Core compute ─────────────────────────────────────────────────────────────
export function computeGIS(bs, ss, pbp, gameId, RPI_BY_YEAR, PGIS_TABLES) {
  const periods   = (ss && ss.periods) || [];
  const setScores = periods.map(p => [Math.max(p.homeScore, p.awayScore), Math.min(p.homeScore, p.awayScore)]);
  const nSets     = periods.length;
  const ml        = matchLev(nSets, setScores);
  const levMap    = pbp ? buildLevMap(pbp, ml) : {};

  const homeTeam = (bs.teams || []).find(t => t.homeAway === 'home') || {};
  const awayTeam = (bs.teams || []).find(t => t.homeAway === 'away') || {};

  const season       = seasonFromGameId(gameId);
  const rpiTable     = RPI_BY_YEAR?.[season] || RPI_BY_YEAR?.['2025'] || {};
  const totalTeams   = Object.keys(rpiTable).length;

  const homeOppRpiVal = findRPIValue(awayTeam.teamName, gameId, RPI_BY_YEAR);
  const awayOppRpiVal = findRPIValue(homeTeam.teamName, gameId, RPI_BY_YEAR);
  const homeOppRank   = rpiToRank(homeOppRpiVal, season, RPI_BY_YEAR);
  const awayOppRank   = rpiToRank(awayOppRpiVal, season, RPI_BY_YEAR);
  const homeOppMod    = rankToModifier(homeOppRank, totalTeams);
  const awayOppMod    = rankToModifier(awayOppRank, totalTeams);

  const players = [];
  for (const team of (bs.teams || [])) {
    const isHome  = team.homeAway === 'home';
    const oppMod  = isHome ? homeOppMod : awayOppMod;
    const oppRank = isHome ? homeOppRank : awayOppRank;

    for (const p of (team.players || [])) {
      // Use match-level nSets as the authoritative denominator.
      // The NCAA API's per-player gamesPlayed field returns sets needed to win
      // the match (e.g. 3 in a 5-set game) rather than total sets played.
      const ns = nSets || p.sets || 0;
      if (ns === 0) continue;

      const raw        = Object.entries(POS_W).reduce((s, [k, w]) => s + (p[k] || 0) * w, 0);
      const err        = Object.entries(ERR_W).reduce((s, [k, w]) => s + (p[k] || 0) * w, 0);
      const errPen     = Math.max(ERR_FLOOR, Math.min(1.0, 1.0 - (err / (raw + 1)) * ERR_DAMP));
      const vol        = raw / ns;
      const plays      = levMap[p.name] || [];
      const avgLev     = plays.length ? plays.reduce((a, b) => a + b, 0) / plays.length : ml;
      const gisNeutral = vol * errPen * GIS_SCALE;
      const gis        = vol * avgLev * errPen * GIS_SCALE;
      const gisPlus    = gis * oppMod;
      const pGIS       = computePGIS(gisNeutral, p.position, nSets, PGIS_TABLES);

      players.push({
        ...p, team: team.teamName, side: team.homeAway,
        ns, vol, errPen, avgLev, levPlays: plays.length, hasPbp: !!pbp,
        gisNeutral, gis, gisPlus, oppMod, oppRank, pGIS,
      });
    }
  }

  const hW = ss ? (ss.finalHomeScore || 0) : 0;
  const aW = ss ? (ss.finalAwayScore || 0) : 0;
  const scoresUnknown = !!(ss?.scoresUnknown);
  return {
    players, ml, nSets, setScores, periods,
    homeTeam: homeTeam.teamName || 'Home',
    awayTeam: awayTeam.teamName || 'Away',
    result: scoresUnknown
      ? `${homeTeam.teamName || 'Home'} vs ${awayTeam.teamName || 'Away'}`
      : `${homeTeam.teamName || 'Home'} ${hW} – ${aW} ${awayTeam.teamName || 'Away'}`,
    hW, aW, scoresUnknown,
    homeOppRank, awayOppRank, homeOppMod, awayOppMod,
    hasRPI: !!(homeOppRank || awayOppRank),
    gameDate: null, gameLocation: null,
  };
}

// ─── Normalise NCAA API responses ─────────────────────────────────────────────
export function normalisePlayer(p) {
  const n = s => parseInt(s || 0) || 0;
  const f = s => parseFloat(s || 0) || 0;
  const name = (p.firstName && p.lastName)
    ? `${p.firstName} ${p.lastName}`
    : (p.name || p.playerName || p.fullName || 'Unknown');
  const rawPos = (p.position || p.pos || '?').toUpperCase().trim();
  const position = rawPos.includes('/') ? rawPos.split('/')[0] : rawPos;
  return {
    name, number: p.number || p.jersey || '', position,
    sets:                 n(p.gamesPlayed || p.sets || p.s || p.gp),
    kills:                n(p.kills || p.k),
    errors:               n(p.attackErrors || p.errors || p.e),
    total_attacks:        n(p.attackAttempts || p.total_attacks || p.ta),
    hit_pct:              f(p.hittingPercentage || p.hit_pct || p.pct),
    assists:              n(p.assists || p.a),
    service_aces:         n(p.serviceAces || p.service_aces || p.sa),
    service_errors:       n(p.serviceErrors || p.service_errors || p.se),
    reception_errors:     n(p.receptionErrors || p.reception_errors || p.re),
    digs:                 n(p.digs || p.d),
    block_solos:          n(p.blockSolos || p.block_solos || p.bs),
    block_assists:        n(p.blockAssists || p.block_assists || p.ba),
    ball_handling_errors: n(p.ballHandlingErrors || p.ball_handling_errors || p.bhe),
    blocking_errors:      n(p.blockingErrors || p.blocking_errors || p.be),
    points:               f(p.points || p.pts),
  };
}

export function normaliseBoxscore(raw) {
  if (!raw) return null;

  // raw.teams has isHome + name info; raw.teamBoxscore has playerStats
  const teamInfoMap = {};
  for (const t of (raw.teams || [])) {
    teamInfoMap[String(t.teamId)] = t;
  }

  const teams = (raw.teamBoxscore || []).map(tb => {
    const tId      = String(tb.teamId || '');
    const teamInfo = teamInfoMap[tId] || tb.team || tb;
    const isHome   = teamInfo.isHome ?? (tb.homeAway === 'home' || tb.home_away === 'home');
    const players  = (tb.playerStats || tb.players || tb.playerBoxscore || []).map(normalisePlayer);
    return {
      teamName: teamInfo.nameShort || teamInfo.nameFull || teamInfo.teamName || teamInfo.name || tb.teamName || 'Unknown',
      teamId:   tId,
      homeAway: isHome ? 'home' : 'away',
      players,
    };
  });

  // Fallback: if no teamBoxscore, build shell entries from raw.teams
  if (!teams.length) {
    return {
      teams: (raw.teams || []).map(t => ({
        teamName: t.nameShort || t.nameFull || t.teamName || 'Unknown',
        teamId:   String(t.teamId || ''),
        homeAway: t.isHome ? 'home' : 'away',
        players:  [],
      })),
    };
  }

  return { teams };
}

export function scoringSumFromPbp(pbp) {
  if (!pbp?.periods) return null;
  const periods = [];
  for (const period of pbp.periods) {
    let lastHome = null, lastAway = null;
    for (const entry of (period.playbyplayStats || []))
      for (const play of (entry.plays || []))
        if (play.homeScore !== null && play.visitorScore !== null)
          { lastHome = play.homeScore; lastAway = play.visitorScore; }
    if (lastHome !== null)
      periods.push({
        periodNumber: period.periodNumber,
        homeScore: lastHome, awayScore: lastAway,
        winner: lastHome > lastAway ? 'home' : 'away',
      });
  }
  if (!periods.length) return null;
  return {
    periods,
    finalHomeScore: periods.filter(p => p.winner === 'home').length,
    finalAwayScore: periods.filter(p => p.winner === 'away').length,
  };
}

export function scoringSumFromBoxscore(raw) {
  if (!raw) return null;
  const linescore = raw.linescore || raw.linescores || raw.scores;
  if (linescore?.periods?.length > 0) {
    const periods = linescore.periods.map((p, i) => {
      const home = parseInt(p.homeScore || p.home || 0);
      const away = parseInt(p.awayScore || p.visitor || p.away || 0);
      return { periodNumber: i + 1, homeScore: home, awayScore: away,
               winner: home > away ? 'home' : 'away' };
    }).filter(p => p.homeScore > 0 || p.awayScore > 0);
    if (periods.length > 0) {
      return {
        periods,
        finalHomeScore: periods.filter(p => p.winner === 'home').length,
        finalAwayScore: periods.filter(p => p.winner === 'away').length,
      };
    }
  }
  for (const tb of (raw.teamBoxscore || [])) {
    const ts      = tb.teamStats || {};
    const setsArr = ts.sets;
    if (Array.isArray(setsArr) && setsArr.length >= 3) {
      const nSets = setsArr.length;
      const periods = Array.from({ length: nSets }, (_, i) => ({
        periodNumber: i + 1, homeScore: 0, awayScore: 0, winner: 'unknown',
      }));
      return { periods, finalHomeScore: 0, finalAwayScore: 0, scoresUnknown: true };
    }
  }
  return null;
}

export function normalisePbp(raw) {
  if (!raw) return null;
  if (raw.sets) return raw;
  if (!raw.periods) return null;
  const sets = raw.periods.map(period => {
    const plays = [];
    let prevHome = 0, prevAway = 0;
    for (const entry of (period.playbyplayStats || [])) {
      for (const play of (entry.plays || [])) {
        const hScore = play.homeScore, aScore = play.visitorScore;
        if (hScore === null || aScore === null) continue;
        if (hScore === prevHome && aScore === prevAway) continue;
        const text = play.playText || '';
        if (/\bsubs?\b/i.test(text) || /starters:/i.test(text)) continue;
        let player = 'Unknown', m;
        if      ((m = text.match(/^(?:Kill|Block solo) by ([^(.\n]+)/i)))  player = m[1].trim();
        else if ((m = text.match(/^Attack error by ([^(.\n]+)/i)))         player = m[1].trim().replace(/\.$/, '');
        else if ((m = text.match(/^Service ace \(([^)]+)\)/i)))            player = m[1].trim();
        plays.push({ home_score: hScore, away_score: aScore,
          scoring_team: hScore > prevHome ? 'home' : 'away', player });
        prevHome = hScore; prevAway = aScore;
      }
    }
    return { setNumber: period.periodNumber, plays };
  });
  return { sets };
}

export function extractId(input) {
  const m = input.trim().match(/\/game\/(\d+)/);
  if (m) return m[1];
  if (/^\d{5,}$/.test(input.trim())) return input.trim();
  return null;
}

export function extractGameMeta(rawData) {
  const summ   = rawData.summary || {};
  const bsMeta = rawData.boxscore || {};
  const ssMeta = rawData.scoring_summary || {};
  const gameInfo = summ.game || summ.gameInfo || bsMeta.game || bsMeta.gameInfo
                || ssMeta.game || ssMeta.gameInfo || summ || {};

  const rawDate = gameInfo.startDate || gameInfo.gameDate || gameInfo.date
                || bsMeta.startDate  || bsMeta.gameDate   || bsMeta.date
                || ssMeta.startDate  || ssMeta.date       || '';

  let gameDate = null;
  if (rawDate) {
    try {
      const d = new Date(rawDate);
      if (!isNaN(d)) {
        const mm   = String(d.getUTCMonth()+1).padStart(2,'0');
        const dd   = String(d.getUTCDate()).padStart(2,'0');
        const yyyy = d.getUTCFullYear();
        gameDate = `${mm}/${dd}/${yyyy}`;
      }
    } catch(e) {}
  }

  const venue = gameInfo.venue || gameInfo.facility || bsMeta.venue || {};
  const arena = venue.name || venue.facilityName || gameInfo.facilityName
              || bsMeta.facilityName || bsMeta.facility?.name || '';
  const city  = venue.city  || gameInfo.city  || bsMeta.city  || '';
  const st    = venue.state || venue.stateAbbr || gameInfo.state
              || bsMeta.state || bsMeta.stateAbbr || '';
  const gameLocation = (arena || city)
    ? [arena, [city, st].filter(Boolean).join(', ')].filter(Boolean).join(', ')
    : null;

  return { gameDate, gameLocation };
}
