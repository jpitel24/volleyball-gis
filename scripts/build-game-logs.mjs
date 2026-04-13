/**
 * build-game-logs.mjs
 *
 * Builds public/data/game_logs.json from the NCAA casablanca API.
 * Covers D1 women's volleyball seasons 2021–2025.
 *
 * Usage:
 *   node scripts/build-game-logs.mjs [options]
 *
 * Options:
 *   --years 2023,2024       Only process specific years (default: all)
 *   --concurrency 8         Parallel boxscore fetches (default: 8)
 *   --delay 120             Ms between batch dispatches (default: 120)
 *   --phase1-only           Only collect game IDs from scoreboard, skip boxscores
 *   --phase2-only           Only process boxscores (requires existing checkpoint)
 *   --resume                Skip already-processed game IDs (default: true)
 *   --no-resume             Re-process all games
 *
 * Progress checkpoint: scripts/.game-logs-progress/
 *   games.json     — all discovered game IDs + metadata
 *   done.json      — set of processed game IDs
 *   logs.json      — accumulated output so far
 *
 * Output: public/data/game_logs.json
 * Format: { "player||team||season": [[gameId, opp, nSets, gisPlus, pGIS, qual, K, E, TA, A, D, SA], ...] }
 *
 * Notes:
 * - Phase 1 hits the NCAA scoreboard API directly (no proxy, CORS not an issue in Node).
 * - Phase 2 hits the proxy for boxscores (required — NCAA blocks direct requests).
 * - GIS is computed without play-by-play leverage (same as archive/season browser).
 * - Only players with at least one meaningful stat are stored.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROGRESS_DIR = path.join(__dirname, '.game-logs-progress');
const OUT_PATH     = path.join(__dirname, '../public/data/game_logs.json');
const DATA_DIR     = path.join(__dirname, '../public/data');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const getArg      = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : def; };
const hasFlag     = flag => args.includes(flag);
const YEARS       = getArg('--years', '2021,2022,2023,2024,2025').split(',').map(Number);
const CONCURRENCY = parseInt(getArg('--concurrency', '8'));
const DELAY_MS    = parseInt(getArg('--delay', '120'));
const PHASE1_ONLY = hasFlag('--phase1-only');
const PHASE2_ONLY = hasFlag('--phase2-only');
const RESUME      = !hasFlag('--no-resume');

// ── Constants (mirrors src/lib/gis.js) ───────────────────────────────────────
const PROXY_BASE = 'https://volleyball-gis-proxy.gordonno24.workers.dev';
const POS_W = { kills:1.00, service_aces:1.20, block_solos:1.10, assists:0.28, block_assists:0.50, digs:0.35 };
const ERR_W = { errors:0.55, service_errors:0.35, reception_errors:0.30, ball_handling_errors:0.45, blocking_errors:0.30 };
const ERR_FLOOR = 0.55, ERR_DAMP = 1.20, GIS_SCALE = 1.25, PGIS_K = 2.0;
const POS_GROUP_MAP = {
  S:'S', OH:'OH', RS:'OH', OPP:'OH', OP:'OH', O:'OH',
  OPPOSITE:'OH', OPPO:'OH', OUTSIDE:'OH', OS:'OH',
  MB:'MB', MH:'MB', L:'L', DS:'L', LB:'L',
};
const TEAM_RPI_ALIASES = {
  'pennsylvania state': 'penn state',
  'north carolina state': 'nc state',
  'appalachian state': 'app state',
};

// Season game ID ranges (from empirical observation of scoreboard data)
const SEASON_ID_RANGES = [
  { season: '2025', min: 6479114 },
  { season: '2024', min: 6326102 },
  { season: '2023', min: 6173797 },
  { season: '2022', min: 6025912 },
  { season: '2021', min: 0 },
];

function seasonFromId(id) {
  const n = parseInt(id);
  for (const { season, min } of SEASON_ID_RANGES) {
    if (n >= min) return season;
  }
  return '2021';
}

// ── GIS computation ───────────────────────────────────────────────────────────
function posGroup(pos) {
  return POS_GROUP_MAP[(pos || '').toUpperCase().split('/')[0].trim()] || null;
}

function computePGIS(gisRaw, position, nSets, PGIS_TABLES) {
  if (!gisRaw || gisRaw <= 0) return null;
  const grp = posGroup(position);
  if (!grp) return null;
  const key  = String(Math.min(Math.max(nSets, 3), 5));
  const cell = PGIS_TABLES?.[grp]?.[key];
  if (!cell?.p) return null;
  const p = cell.p, n = p.length, raw = Math.round(gisRaw * 100);
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (p[mid] <= raw) lo = mid + 1; else hi = mid; }
  return Math.min(10.0, 10 * Math.pow(lo / n, PGIS_K));
}

function computePlayerGIS(stats, nSets, oppMod, position, PGIS_TABLES) {
  const raw    = Object.entries(POS_W).reduce((s, [k, w]) => s + (stats[k] || 0) * w, 0);
  if (raw <= 0) return null;
  const errSum = Object.entries(ERR_W).reduce((s, [k, w]) => s + (stats[k] || 0) * w, 0);
  const errPen = Math.max(ERR_FLOOR, Math.min(1.0, 1.0 - (errSum / (raw + 1)) * ERR_DAMP));
  const vol    = raw / nSets;
  const gisNeutral     = vol * errPen * GIS_SCALE;
  const gisNeutralPlus = gisNeutral * oppMod;
  const pGIS           = computePGIS(gisNeutralPlus, position, nSets, PGIS_TABLES);
  return { gisNeutralPlus, pGIS };
}

// ── RPI helpers ───────────────────────────────────────────────────────────────
function normaliseTeamName(name) {
  return name.toLowerCase()
    .replace(/\b(university|college|state|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '').trim();
}

function findRPIValue(teamNameFull, teamNameShort, season, RPI_BY_YEAR) {
  const raw = RPI_BY_YEAR?.[season] || {};
  const names = [...new Set([teamNameFull, teamNameShort].filter(Boolean))];
  if (!names.length) return null;

  // Pre-pass: alias check
  for (const n of names) {
    const stripped = n.toLowerCase()
      .replace(/\b(university|college|the)\b/g, '')
      .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const aliasKey = TEAM_RPI_ALIASES[stripped];
    if (aliasKey && raw[aliasKey] !== undefined) return raw[aliasKey];
  }

  // Pass 1: exact slug
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const n of names) {
    const inputSlug = slug(n);
    for (const [k, v] of Object.entries(raw)) {
      if (slug(k) === inputSlug) return v;
    }
  }

  // Pass 2: all stored-key words in input, longest match wins
  let best = null, bestLen = 0;
  for (const n of names) {
    const inputWords = new Set(n.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
    for (const [k, v] of Object.entries(raw)) {
      const kWords = k.toLowerCase().split(/\s+/).filter(Boolean);
      if (kWords.length > 0 && kWords.every(w => inputWords.has(w)) && k.length > bestLen) {
        best = v; bestLen = k.length;
      }
    }
  }
  if (best !== null) return best;

  // Pass 3: 5-char prefix fallback
  for (const n of names) {
    const norm = normaliseTeamName(n);
    if (norm.length >= 5) {
      for (const [stored, val] of Object.entries(raw)) {
        const sn = normaliseTeamName(stored);
        if (sn.length >= 5 && sn.slice(0, 5) === norm.slice(0, 5)) return val;
      }
    }
  }
  return null;
}

function rpiToRank(rpiVal, season, RPI_BY_YEAR) {
  if (!rpiVal) return null;
  const table  = RPI_BY_YEAR?.[season] || {};
  const sorted = Object.values(table).sort((a, b) => b - a);
  const idx    = sorted.findIndex(v => v <= rpiVal);
  return idx >= 0 ? idx + 1 : null;
}

function rankToModifier(rank, totalTeams) {
  if (!rank) return 1.0;
  if (rank <= 50) return 1.05 - (rank - 1) * (0.05 / 49);
  if (totalTeams <= 50) return 1.0;
  return Math.max(0.50, 1.00 - (rank - 50) * (0.50 / (totalTeams - 50)));
}

// ── Normalise player stats from API field names to internal names ─────────────
function normalisePlayerStats(p) {
  return {
    kills:               parseInt(p.kills)             || 0,
    errors:              parseInt(p.attackErrors)       || 0,
    total_attacks:       parseInt(p.attackAttempts)     || 0,
    assists:             parseInt(p.assists)            || 0,
    digs:                parseInt(p.digs)              || 0,
    service_aces:        parseInt(p.serviceAces)        || 0,
    service_errors:      parseInt(p.serviceErrors)      || 0,
    reception_errors:    parseInt(p.receptionErrors)    || 0,
    block_solos:         parseInt(p.blockSolos)         || 0,
    block_assists:       parseInt(p.blockAssists)       || 0,
    blocking_errors:     parseInt(p.blockingErrors)     || 0,
    ball_handling_errors:parseInt(p.ballHandlingErrors) || 0,
    position:            (p.position || '').split('/')[0].trim(),
    name:               `${(p.firstName||'').trim()} ${(p.lastName||'').trim()}`.trim().toLowerCase(),
  };
}

// ── Fetch with retry ──────────────────────────────────────────────────────────
async function fetchWithRetry(url, retries = 3, backoff = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (res.ok) return res.json();
      if (res.status === 404) return null;   // game not found — skip
      if (res.status === 429 || res.status >= 500) {
        if (i < retries) { await sleep(backoff * (i + 1)); continue; }
      }
      return null;
    } catch (e) {
      if (i < retries) { await sleep(backoff * (i + 1)); } else return null;
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function withPool(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Checkpoint helpers ────────────────────────────────────────────────────────
function cpPath(name) { return path.join(PROGRESS_DIR, name); }
function loadCP(name, def) {
  try { return JSON.parse(readFileSync(cpPath(name), 'utf8')); } catch { return def; }
}
function saveCP(name, data) {
  mkdirSync(PROGRESS_DIR, { recursive: true });
  writeFileSync(cpPath(name), JSON.stringify(data));
}

// ── Season date ranges ────────────────────────────────────────────────────────
function* seasonDates(year) {
  // D1 volleyball regular season: late August through early December
  // Tournament runs into mid-December
  const start = new Date(`${year}-08-22`);
  const end   = new Date(`${year}-12-22`);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    yield `${year}/${mm}/${dd}`;
  }
}

// ── Phase 1: collect all game IDs from scoreboard ────────────────────────────
async function phase1(years) {
  console.log('\n── Phase 1: collecting game IDs from scoreboard ──');
  const existing = loadCP('games.json', {});
  let added = 0;

  for (const year of years) {
    let yearCount = 0;
    process.stdout.write(`  ${year}: `);
    for (const dateStr of seasonDates(year)) {
      const url = `https://data.ncaa.com/casablanca/scoreboard/volleyball-women/d1/${dateStr}/scoreboard.json`;
      const data = await fetchWithRetry(url, 2, 500);
      if (!data?.games) continue;

      for (const g of data.games) {
        const game     = g.game || g;
        const urlMatch = (game.url || '').match(/\/game\/(\d+)/);
        if (!urlMatch) continue;
        const gameId   = urlMatch[1];
        if (existing[gameId]) continue;

        const hScore = parseInt(game.home?.score ?? game.homeScore ?? 0);
        const aScore = parseInt(game.away?.score ?? game.awayScore ?? 0);
        const nSets  = hScore + aScore;
        if (nSets < 3 || nSets > 5) continue;  // skip non-final or invalid
        if (game.gameState !== 'final') continue;

        existing[gameId] = {
          gameId,
          season:       String(year),
          nSets,
          homeNameShort: game.home?.names?.short  || game.home?.nameShort || '',
          homeNameFull:  game.home?.names?.full   || game.home?.nameFull  || '',
          awayNameShort: game.away?.names?.short  || game.away?.nameShort || '',
          awayNameFull:  game.away?.names?.full   || game.away?.nameFull  || '',
        };
        added++; yearCount++;
      }
      await sleep(50); // gentle on the scoreboard API
    }
    console.log(`${yearCount} games`);
    saveCP('games.json', existing);
  }

  saveCP('games.json', existing);
  console.log(`Phase 1 complete. Total games: ${Object.keys(existing).length} (+${added} new)`);
  return existing;
}

// ── Phase 2: fetch boxscores and compute GIS ──────────────────────────────────
async function phase2(games, PGIS_TABLES, RPI_BY_YEAR) {
  console.log('\n── Phase 2: fetching boxscores and computing GIS ──');

  const done = RESUME ? loadCP('done.json', {}) : {};
  const logs = RESUME ? loadCP('logs.json', {}) : {};

  const gameList = Object.values(games).filter(g => {
    if (!YEARS.includes(parseInt(g.season))) return false;
    if (RESUME && done[g.gameId]) return false;
    return true;
  });

  console.log(`  ${gameList.length} games to process (${Object.keys(done).length} already done)`);

  let processed = 0, skipped = 0, errors = 0;
  const SAVE_EVERY = 200;

  // Process in batches for progress reporting
  const BATCH = CONCURRENCY * 4;
  for (let offset = 0; offset < gameList.length; offset += BATCH) {
    const batch = gameList.slice(offset, offset + BATCH);
    await sleep(DELAY_MS);

    await withPool(batch, CONCURRENCY, async (meta) => {
      const url = `${PROXY_BASE}/game/${meta.gameId}/boxscore`;
      const bs  = await fetchWithRetry(url, 3, 800);

      if (!bs) { errors++; return; }

      const season    = meta.season;
      const totalTeams = Object.keys(RPI_BY_YEAR?.[season] || {}).length;

      // Build team map: teamId → {nameShort, nameFull, homeAway, oppNameShort, oppNameFull, oppMod, oppRank}
      const teamsInfo = [];
      const apiTeams  = bs.teams || [];
      const tb        = bs.teamBoxscore || [];

      if (apiTeams.length < 2) { skipped++; return; }

      // Determine home/away — use isHome flag
      const home = apiTeams.find(t => t.isHome)  || apiTeams[0];
      const away = apiTeams.find(t => !t.isHome) || apiTeams[1];

      const homeRpiVal  = findRPIValue(meta.homeNameFull || home.nameFull, meta.homeNameShort || home.nameShort, season, RPI_BY_YEAR);
      const awayRpiVal  = findRPIValue(meta.awayNameFull || away.nameFull, meta.awayNameShort || away.nameShort, season, RPI_BY_YEAR);
      const homeOppRank = rpiToRank(awayRpiVal, season, RPI_BY_YEAR);
      const awayOppRank = rpiToRank(homeRpiVal, season, RPI_BY_YEAR);
      const homeOppMod  = rankToModifier(homeOppRank, totalTeams);
      const awayOppMod  = rankToModifier(awayOppRank, totalTeams);
      const homeQual    = homeOppRank != null && homeOppRank <= 100;
      const awayQual    = awayOppRank != null && awayOppRank <= 100;

      for (const teamBox of tb) {
        const tId      = String(teamBox.teamId || '');
        const apiTeam  = apiTeams.find(t => String(t.teamId) === tId) || {};
        const isHome   = apiTeam.isHome ?? false;
        const nameShort = apiTeam.nameShort || (isHome ? meta.homeNameShort : meta.awayNameShort) || 'Unknown';
        const oppShort  = isHome
          ? (meta.awayNameShort || away.nameShort || 'Unknown')
          : (meta.homeNameShort || home.nameShort || 'Unknown');

        const oppMod  = isHome ? homeOppMod  : awayOppMod;
        const qual    = isHome ? homeQual    : awayQual;
        const nSets   = meta.nSets;

        for (const rawPlayer of (teamBox.playerStats || [])) {
          const p = normalisePlayerStats(rawPlayer);
          if (!p.name || p.name === ' ') continue;

          const result = computePlayerGIS(p, nSets, oppMod, p.position, PGIS_TABLES);
          if (!result) continue;  // no meaningful stats

          const { gisNeutralPlus, pGIS } = result;
          const logKey = `${p.name}||${nameShort.toLowerCase()}||${season}`;

          const entry = [
            meta.gameId,                           // gameId
            oppShort,                              // opponent display name
            nSets,                                 // match sets
            parseFloat(gisNeutralPlus.toFixed(3)), // GIS+ (opponent-adjusted, no leverage)
            pGIS !== null ? parseFloat(pGIS.toFixed(2)) : null, // pGIS
            qual,                                  // qualifying game (opp ≤ top-100)
            p.kills,
            p.errors,
            p.total_attacks,
            p.assists,
            p.digs,
            p.service_aces,
          ];

          if (!logs[logKey]) logs[logKey] = [];
          logs[logKey].push(entry);
        }
      }

      done[meta.gameId] = 1;
      processed++;
    });

    // Progress report + checkpoint
    const total = processed + skipped + errors;
    const pct   = ((offset + batch.length) / gameList.length * 100).toFixed(1);
    process.stdout.write(`\r  ${pct}% — processed: ${processed}  skipped: ${skipped}  errors: ${errors}  players tracked: ${Object.keys(logs).length}   `);

    if (total % SAVE_EVERY < BATCH) {
      saveCP('done.json', done);
      saveCP('logs.json', logs);
    }
  }

  saveCP('done.json', done);
  saveCP('logs.json', logs);
  console.log(`\nPhase 2 complete. processed: ${processed}  skipped: ${skipped}  errors: ${errors}`);
  return logs;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nBuild Game Logs — years: ${YEARS.join(',')} — concurrency: ${CONCURRENCY} — delay: ${DELAY_MS}ms`);
  if (RESUME) console.log('Resume mode ON (--no-resume to reprocess all)');

  mkdirSync(PROGRESS_DIR, { recursive: true });

  // Load static reference data
  const PGIS_TABLES = JSON.parse(readFileSync(path.join(DATA_DIR, 'pgis_tables.json'), 'utf8'));
  const RPI_BY_YEAR = JSON.parse(readFileSync(path.join(DATA_DIR, 'rpi_by_year.json'), 'utf8'));

  let games = loadCP('games.json', {});

  if (!PHASE2_ONLY) {
    games = await phase1(YEARS);
  } else {
    console.log(`Phase 1 skipped — loaded ${Object.keys(games).length} games from checkpoint`);
  }

  if (PHASE1_ONLY) {
    console.log('\nPhase 1 only — done.');
    return;
  }

  const logs = await phase2(games, PGIS_TABLES, RPI_BY_YEAR);

  // Write final output
  const sizeMB = (JSON.stringify(logs).length / 1024 / 1024).toFixed(1);
  console.log(`\nWriting ${OUT_PATH}  (${Object.keys(logs).length} player-season keys, ~${sizeMB} MB)`);
  writeFileSync(OUT_PATH, JSON.stringify(logs));
  console.log('Done.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
