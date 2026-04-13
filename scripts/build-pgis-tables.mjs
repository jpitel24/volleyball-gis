import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ERR_FLOOR = 0.55, ERR_DAMP = 1.20, GIS_SCALE = 1.25;
const POS_W = { kills:1.00, service_aces:1.20, block_solos:1.10, assists:0.28, block_assists:0.50, digs:0.35 };
const ERR_W = { errors:0.55, service_errors:0.35, reception_errors:0.30, ball_handling_errors:0.45, blocking_errors:0.30 };
const POS_GROUP_MAP = {
  S:'S', OH:'OH', RS:'OH', OPP:'OH', OP:'OH', O:'OH',
  OPPOSITE:'OH', OPPO:'OH', OUTSIDE:'OH', OS:'OH',
  MB:'MB', MH:'MB', L:'L', DS:'L', LB:'L',
};

const archive = JSON.parse(readFileSync(path.join(__dirname, '../public/data/player_archive.json'), 'utf8'));
const allRecords = Object.values(archive.seasons).flat();

const buckets = { S:{3:[],4:[],5:[]}, OH:{3:[],4:[],5:[]}, MB:{3:[],4:[],5:[]}, L:{3:[],4:[],5:[]} };

for (const rec of allRecords) {
  if (!rec.sets || rec.sets <= 0) continue;
  const grp = POS_GROUP_MAP[(rec.pos || '').toUpperCase()];
  if (!grp) continue;
  const sc = Math.min(5, Math.max(3, Math.round(rec.sets / (rec.games || 1))));
  const raw        = Object.entries(POS_W).reduce((s, [k, w]) => s + (rec[k] || 0) * w, 0);
  const errSum     = Object.entries(ERR_W).reduce((s, [k, w]) => s + (rec[k] || 0) * w, 0);
  const errPen     = Math.max(ERR_FLOOR, Math.min(1.0, 1.0 - (errSum / (raw + 1)) * ERR_DAMP));
  const gisNeutral = (raw / rec.sets) * errPen * GIS_SCALE;
  // Apply the historical opponent modifier from the archive (ratio of GIS+ to neutral GIS).
  // Both fields were computed by the same old formula, so their ratio is a valid opp-quality proxy.
  const oppModRatio = (rec.gis_per_set > 0 && rec.gis_plus_per_set != null)
    ? Math.max(0.5, Math.min(1.5, rec.gis_plus_per_set / rec.gis_per_set))
    : 1.0;
  const gisPlus = gisNeutral * oppModRatio;
  if (gisPlus > 0) buckets[grp][sc].push(Math.round(gisPlus * 100));
}

const N = 1000, MIN_RECORDS = 30;
const tables = {};
for (const grp of ['S', 'OH', 'MB', 'L']) {
  tables[grp] = {};
  for (const sc of [3, 4, 5]) {
    let raw = buckets[grp][sc];
    if (raw.length < MIN_RECORDS && sc !== 4) raw = [...buckets[grp][4], ...raw];
    const sorted = [...raw].sort((a, b) => a - b);
    const len = sorted.length;
    if (!len) { tables[grp][sc] = { p: [] }; continue; }
    // Last slot is absolute max + 1 so no real value can reach pGIS 10.0 in the season browser.
    // Only a live game strictly above the all-time GIS+ high will hit 10.0.
    const p = Array.from({ length: N }, (_, i) =>
      i === N - 1 ? sorted[len - 1] + 1 : sorted[Math.floor((i / N) * len)]
    );
    tables[grp][sc] = { p };
    console.log(`  ${grp}/${sc}: ${len} records, max=${(sorted[len-1]/100).toFixed(3)}`);
  }
}

const outPath = path.join(__dirname, '../public/data/pgis_tables.json');
writeFileSync(outPath, JSON.stringify(tables));
console.log(`\nWritten: ${outPath}`);
