/**
 * csvGames.js
 *
 * Loads, parses, and indexes the per-season player-match CSV files in
 * public/data/wvb_playermatch_div1_{year}.csv into a browseable
 * games-by-year structure suitable for the Game Browser UI.
 *
 * Public API:
 *   loadYear(year)        → Promise<{ games: Game[], byKey: { [key]: Row[] } }>
 *   gameRowsToBoxscore()  → translate raw CSV rows for one game into the
 *                           boxscore shape expected by computeGIS().
 *
 * Year data is cached in module scope so switching years is instant after
 * the initial fetch+parse.
 */

// ── CSV parser (RFC 4180-ish, quote-aware) ────────────────────────────────────

/**
 * Split a single CSV line into fields, honouring quoted values and the
 * escaped-quote convention (`""` inside a quoted field → literal `"`).
 */
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

/** Parse full CSV text into an array of row objects keyed by header name. */
export function parseCSV(text) {
  // Strip BOM and split. Files use mixed line endings depending on year.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCSVLine(lines[0]);
  const rows = new Array(lines.length - 1);
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const vals = parseCSVLine(ln);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = vals[j] ?? '';
    rows[n++] = row;
  }
  rows.length = n;
  return rows;
}

// ── Game indexing ─────────────────────────────────────────────────────────────

/**
 * Build a game-level index from parsed CSV rows.
 *
 * Each game is keyed by ContestID for 2025 (which carries it natively) and by
 * a synthetic `<date>_<sortedTeam1>_<sortedTeam2>` slug for 2022–2024 (which
 * lack a contest column). The two teams' rosters share the same key — both
 * "perspectives" of a match collapse into one group.
 *
 * Returns:
 *   {
 *     games: [{ key, contestId, date, homeTeam, awayTeam, location,
 *               conference, oppConference, nSets }],   // sorted by date desc
 *     byKey: { [key]: rawRow[] }
 *   }
 */
export function buildGameIndex(rows, year) {
  const byKey = {};
  for (const r of rows) {
    const date    = r.Date;
    const team    = r.Team;
    const oppTeam = r['Opponent Team'];
    if (!date || !team || !oppTeam) continue;

    let key;
    const cid = r.ContestID;
    if (cid) {
      key = `cid_${cid}`;
    } else {
      // Synthetic key — sort the two team names so both perspectives collide
      const [a, b] = [team, oppTeam].slice().sort();
      key = `${date}_${a}_${b}`;
    }

    (byKey[key] = byKey[key] || []).push(r);
  }

  const games = [];
  for (const [key, gameRows] of Object.entries(byKey)) {
    const r0      = gameRows[0];
    const cid     = r0.ContestID || null;
    const teamA   = r0.Team;
    const teamB   = r0['Opponent Team'];

    // Determine home/away from the Location field. Falls back to alphabetical.
    let homeTeam, awayTeam;
    const loc = (r0.Location || '').trim();
    if (loc === 'Home')      { homeTeam = teamA; awayTeam = teamB; }
    else if (loc === 'Away') { homeTeam = teamB; awayTeam = teamA; }
    else                     { [homeTeam, awayTeam] = [teamA, teamB].sort(); }

    // nSets = max sets played across any player in the match (winning team
    // typically plays all sets; libero/sub players play fewer).
    let nSets = 0;
    for (const r of gameRows) {
      const s = parseInt(r.S || 0, 10) || 0;
      if (s > nSets) nSets = s;
    }

    games.push({
      key,
      contestId:     cid,
      date:          r0.Date,
      season:        year,
      homeTeam,
      awayTeam,
      location:      loc || 'Neutral',
      conference:    r0.Conference || '',
      oppConference: r0['Opponent Conference'] || '',
      nSets,
    });
  }

  // Most recent first (string compare works for ISO YYYY-MM-DD dates)
  games.sort((a, b) => b.date.localeCompare(a.date));

  return { games, byKey };
}

// ── Year cache + loader ───────────────────────────────────────────────────────

const yearCache = new Map();   // year → { games, byKey }
const inflight  = new Map();   // year → Promise<...>

/**
 * Fetch & parse the CSV for one season. Cached after first load — switching
 * years post-initial-fetch is synchronous from the cache.
 */
export async function loadYear(year) {
  if (yearCache.has(year)) return yearCache.get(year);
  if (inflight.has(year))  return inflight.get(year);

  const promise = fetch(`/data/wvb_playermatch_div1_${year}.csv`)
    .then(r => {
      if (!r.ok) throw new Error(`CSV not found for ${year} (HTTP ${r.status})`);
      return r.text();
    })
    .then(text => {
      const rows  = parseCSV(text);
      const index = buildGameIndex(rows, year);
      yearCache.set(year, index);
      inflight.delete(year);
      return index;
    })
    .catch(err => {
      inflight.delete(year);
      throw err;
    });

  inflight.set(year, promise);
  return promise;
}

// ── Set-scores loader ─────────────────────────────────────────────────────────
// Lazily fetches /data/wvb_setscores_<year>.json — a { ContestID → [[h,a], ...] }
// map built from NCAA play-by-play. Missing/404 → empty map (scoresUnknown path).

const setScoresCache = new Map();
const setScoresInflight = new Map();

export async function loadSetScores(year) {
  if (setScoresCache.has(year)) return setScoresCache.get(year);
  if (setScoresInflight.has(year)) return setScoresInflight.get(year);

  const promise = fetch(`/data/wvb_setscores_${year}.json`)
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}))
    .then(map => {
      setScoresCache.set(year, map);
      setScoresInflight.delete(year);
      return map;
    });

  setScoresInflight.set(year, promise);
  return promise;
}

// ── CSV → boxscore adapter ────────────────────────────────────────────────────

const num = v => {
  const n = parseInt(v ?? 0, 10);
  return Number.isFinite(n) ? n : 0;
};
const flo = v => {
  const f = parseFloat(v ?? 0);
  return Number.isFinite(f) ? f : 0;
};

function rowToPlayer(r) {
  return {
    name:                 r.Player || 'Unknown',
    number:               r.Number || '',
    position:             (r.P || '?').toUpperCase().trim(),
    sets:                 num(r.S),
    kills:                num(r.Kills),
    errors:               num(r.Errors),
    total_attacks:        num(r.TotalAttacks),
    hit_pct:              flo(r.HitPct),
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

/**
 * Convert the raw CSV rows for one game (both teams' rosters combined) into
 * the boxscore shape expected by `computeGIS()` in src/lib/gis.js.
 */
export function gameRowsToBoxscore(rows) {
  if (!rows || !rows.length) return { teams: [] };

  // Group rows by Team (player's own team)
  const byTeam = {};
  for (const r of rows) {
    const t = r.Team;
    (byTeam[t] = byTeam[t] || []).push(r);
  }

  // Pick home/away from the Location field on the first row
  const r0 = rows[0];
  const loc = (r0.Location || '').trim();
  let homeName, awayName;
  if (loc === 'Home')      { homeName = r0.Team; awayName = r0['Opponent Team']; }
  else if (loc === 'Away') { homeName = r0['Opponent Team']; awayName = r0.Team; }
  else {
    const names = Object.keys(byTeam).sort();
    [homeName, awayName] = names;
  }

  const teams = [];
  if (byTeam[homeName]) {
    teams.push({
      teamName: homeName,
      teamId:   homeName,
      homeAway: 'home',
      players:  byTeam[homeName].map(rowToPlayer),
    });
  }
  if (byTeam[awayName]) {
    teams.push({
      teamName: awayName,
      teamId:   awayName,
      homeAway: 'away',
      players:  byTeam[awayName].map(rowToPlayer),
    });
  }

  return { teams };
}
