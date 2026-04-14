/**
 * build-player-archive.mjs
 *
 * Aggregates game_logs.json into seasonal player totals and merges the result
 * into public/data/player_archive.json.
 *
 * Usage:
 *   node scripts/build-player-archive.mjs [options]
 *
 * Options:
 *   --years 2022,2023     Only rebuild specified seasons (default: all years in game_logs)
 *   --overwrite           Overwrite ALL seasons in the archive (default: merge, keep unlisted years)
 *
 * Entry format in game_logs.json (extended):
 *   [gameId, opp, nSets, gisNeutralPlus, pGIS, qual, K, E, TA, A, D, SA,
 *    BS, BA, SE, RE, BHE, BE, pos, conf]
 *    0       1    2    3              4     5    6  7   8  9 10  11
 *    12  13  14  15  16   17  18   19
 *
 * Legacy entries (12 elements) are supported — missing fields default to 0/null.
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '../public/data');
const GL_PATH   = path.join(DATA_DIR, 'game_logs.json');
const OUT_PATH  = path.join(DATA_DIR, 'player_archive.json');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const getArg    = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : def; };
const hasFlag   = flag => args.includes(flag);
const YEARS_ARG = getArg('--years', null);
const OVERWRITE = hasFlag('--overwrite');
const TARGET_YEARS = YEARS_ARG ? new Set(YEARS_ARG.split(',')) : null; // null = all

// ── Constants (mirrors gis.js) ────────────────────────────────────────────────
const POS_W = {
  kills: 1.00, service_aces: 1.20, block_solos: 1.10,
  assists: 0.28, block_assists: 0.50, digs: 0.35,
};
const ERR_W = {
  errors: 0.55, service_errors: 0.35, reception_errors: 0.30,
  ball_handling_errors: 0.45, blocking_errors: 0.30,
};
const ERR_FLOOR = 0.55, ERR_DAMP = 1.20, GIS_SCALE = 1.25, PGIS_K = 2.0;
const POS_GROUP_MAP = {
  S: 'S', OH: 'OH', RS: 'OH', OPP: 'OH', OP: 'OH', O: 'OH',
  OPPOSITE: 'OH', OPPO: 'OH', OUTSIDE: 'OH', OS: 'OH',
  MB: 'MB', MH: 'MB', L: 'L', DS: 'L', LB: 'L',
};

function posGroup(pos) {
  return POS_GROUP_MAP[(pos || '').toUpperCase().split('/')[0].trim()] || null;
}

// Infer position from per-game stat rates (mirrors gis.js inferPosition)
function inferPosition({ kills=0, assists=0, digs=0, block_solos=0, block_assists=0 }) {
  const total = kills + assists + digs + block_solos + block_assists;
  if (total === 0) return null;
  const bTotal = block_solos + block_assists;
  if (assists > 8 && assists > kills * 3) return 'S';
  if (digs > 4 && kills < 3 && bTotal < 1) return 'L';
  if (bTotal >= 2 && kills >= 2 && bTotal / (kills + bTotal) >= 0.30) return 'MB';
  if (kills > 0 || digs > 0 || assists > 0) return 'OH';
  return null;
}

function computePGIS(gisRaw, position, nSets, PGIS_TABLES) {
  if (!gisRaw || gisRaw <= 0) return null;
  const grp  = posGroup(position);
  if (!grp) return null;
  const key  = String(Math.min(Math.max(nSets, 3), 5));
  const cell = PGIS_TABLES?.[grp]?.[key];
  if (!cell?.p) return null;
  const p = cell.p, n = p.length, raw = Math.round(gisRaw * 100);
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (p[mid] <= raw) lo = mid + 1; else hi = mid; }
  return Math.min(10.0, 10 * Math.pow(lo / n, PGIS_K));
}

// ── Most-frequent value helper ────────────────────────────────────────────────
function mostFrequent(arr) {
  const freq = {};
  for (const v of arr) if (v) freq[v] = (freq[v] || 0) + 1;
  let best = null, bestN = 0;
  for (const [v, n] of Object.entries(freq)) {
    if (n > bestN) { best = v; bestN = n; }
  }
  return best || '';
}

// ── Load data ─────────────────────────────────────────────────────────────────
console.log('Loading game_logs.json…');
const gameLogs  = JSON.parse(readFileSync(GL_PATH, 'utf8'));
const PGIS_TABLES = JSON.parse(readFileSync(path.join(DATA_DIR, 'pgis_tables.json'), 'utf8'));

// ── Aggregate ─────────────────────────────────────────────────────────────────
console.log('Aggregating player-season records…');

// seasonData[season] = [ ...records ]
const seasonData = {};

for (const [key, entries] of Object.entries(gameLogs)) {
  const [player, team, season] = key.split('||');
  if (!player || !team || !season) continue;
  if (TARGET_YEARS && !TARGET_YEARS.has(season)) continue;

  // Aggregate counting stats
  let games = 0, sets = 0, qual_games = 0;
  let kills = 0, errors = 0, total_attacks = 0;
  let assists = 0, digs = 0, service_aces = 0;
  let block_solos = 0, block_assists = 0, service_errors = 0;
  let reception_errors = 0, ball_handling_errors = 0, blocking_errors = 0;
  let gis_plus_total = 0;
  const pgis_vals = [], pgis_all_vals = [];
  const positions = [], confs = [];

  for (const e of entries) {
    const [
      /*gameId*/,    /*opp*/,  nSets,         gisNeutralPlus, pGIS,       qual,
      K,             E,        TA,             A,              D,          SA,
      BS = 0,        BA = 0,   SE = 0,         RE = 0,         BHE = 0,    BE = 0,
      pos = '',      conf = '',
    ] = e;

    games++;
    sets           += nSets || 0;
    qual_games     += qual ? 1 : 0;
    kills          += K   || 0;
    errors         += E   || 0;
    total_attacks  += TA  || 0;
    assists        += A   || 0;
    digs           += D   || 0;
    service_aces   += SA  || 0;
    block_solos    += BS  || 0;
    block_assists  += BA  || 0;
    service_errors += SE  || 0;
    reception_errors       += RE  || 0;
    ball_handling_errors   += BHE || 0;
    blocking_errors        += BE  || 0;

    // gis_plus_total = sum of (gisNeutralPlus per set × sets)
    if (gisNeutralPlus && nSets) gis_plus_total += gisNeutralPlus * nSets;

    if (pGIS !== null && pGIS !== undefined) pgis_vals.push(pGIS);
    pgis_all_vals.push(pGIS !== null && pGIS !== undefined ? pGIS : 0);

    if (pos) positions.push(pos);
    if (conf) confs.push(conf);
  }

  if (games === 0 || sets === 0) continue;

  // Determine canonical pos — if none from API, infer from per-game stat rates
  let pos = mostFrequent(positions);
  if (!pos || !posGroup(pos)) {
    pos = inferPosition({
      kills:         kills        / games,
      assists:       assists      / games,
      digs:          digs         / games,
      block_solos:   block_solos  / games,
      block_assists: block_assists / games,
    }) ?? '';
  }
  const conf = mostFrequent(confs);

  // Recompute neutral GIS from aggregated stats (same formula as computeArchivePGIS)
  const raw    = kills * POS_W.kills + service_aces * POS_W.service_aces
               + block_solos * POS_W.block_solos + assists * POS_W.assists
               + block_assists * POS_W.block_assists + digs * POS_W.digs;
  const errSum = errors * ERR_W.errors + service_errors * ERR_W.service_errors
               + reception_errors * ERR_W.reception_errors
               + ball_handling_errors * ERR_W.ball_handling_errors
               + blocking_errors * ERR_W.blocking_errors;
  const errPen = Math.max(ERR_FLOOR, Math.min(1.0, 1.0 - (errSum / (raw + 1)) * ERR_DAMP));
  const gis_per_set      = raw > 0 ? (raw / sets) * errPen * GIS_SCALE : 0;
  const gis_plus_per_set = gis_plus_total / sets;

  const hit_pct = total_attacks > 0
    ? parseFloat(((kills - errors) / total_attacks).toFixed(3))
    : 0;

  const avg_pgis     = pgis_vals.length > 0
    ? parseFloat((pgis_vals.reduce((s, v) => s + v, 0) / pgis_vals.length).toFixed(3))
    : null;
  const avg_pgis_all = pgis_all_vals.length > 0
    ? parseFloat((pgis_all_vals.reduce((s, v) => s + v, 0) / pgis_all_vals.length).toFixed(3))
    : null;

  const record = {
    player,
    team,
    pos,
    season,
    games,
    sets,
    qual_games,
    gis_per_set:      parseFloat(gis_per_set.toFixed(3)),
    gis_plus_per_set: parseFloat(gis_plus_per_set.toFixed(3)),
    gis_plus_total:   parseFloat(gis_plus_total.toFixed(1)),
    avg_pgis,
    kills,
    errors,
    total_attacks,
    hit_pct,
    assists,
    service_aces,
    service_errors,
    reception_errors,
    digs,
    block_solos,
    block_assists,
    ball_handling_errors,
    conf,
    avg_pgis_all,
  };

  if (!seasonData[season]) seasonData[season] = [];
  seasonData[season].push(record);
}

// ── Report ────────────────────────────────────────────────────────────────────
for (const [season, records] of Object.entries(seasonData)) {
  console.log(`  ${season}: ${records.length} player records`);
}

// ── Merge with existing archive ───────────────────────────────────────────────
let existing = { seasons: {} };
try {
  existing = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  console.log(`Loaded existing archive — seasons: ${Object.keys(existing.seasons).join(', ')}`);
} catch {
  console.log('No existing archive — creating fresh.');
}

if (OVERWRITE) {
  existing.seasons = seasonData;
} else {
  // Merge: overwrite only the seasons we just rebuilt
  for (const [season, records] of Object.entries(seasonData)) {
    existing.seasons[season] = records;
  }
}

// Sort each season's records by avg_pgis desc
for (const season of Object.keys(existing.seasons)) {
  existing.seasons[season].sort((a, b) => (b.avg_pgis ?? -1) - (a.avg_pgis ?? -1));
}

// ── Write output ──────────────────────────────────────────────────────────────
const sizeMB = (JSON.stringify(existing).length / 1024 / 1024).toFixed(1);
const allSeasons = Object.keys(existing.seasons).sort().join(', ');
console.log(`\nWriting ${OUT_PATH}  (seasons: ${allSeasons}, ~${sizeMB} MB)`);
writeFileSync(OUT_PATH, JSON.stringify(existing));
console.log('Done.\n');
