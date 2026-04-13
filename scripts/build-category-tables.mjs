import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ERR_FLOOR = 0.55, ERR_DAMP = 1.20, GIS_SCALE = 1.25;

const POS_GROUP_MAP = {
  S:'S', OH:'OH', RS:'OH', OPP:'OH', OP:'OH', O:'OH',
  OPPOSITE:'OH', OPPO:'OH', OUTSIDE:'OH', OS:'OH',
  MB:'MB', MH:'MB', L:'L', DS:'L', LB:'L',
};

const CATEGORIES = [
  { key:'attack',   pos:{ kills:1.00 },                            err:{ errors:0.55 } },
  { key:'blocking', pos:{ block_solos:1.10, block_assists:0.50 },  err:{ blocking_errors:0.30 } },
  { key:'defense',  pos:{ digs:0.35 },                             err:{ reception_errors:0.30 } },
  { key:'serving',  pos:{ service_aces:1.20 },                     err:{ service_errors:0.35 } },
  { key:'setting',  pos:{ assists:0.28 },                          err:{ ball_handling_errors:0.45 } },
];

const archive = JSON.parse(readFileSync(path.join(__dirname, '../public/data/player_archive.json'), 'utf8'));
const allRecords = Object.values(archive.seasons).flat();

// Accumulate raw GIS*100 values per category/posGroup/setCount
const buckets = {};
for (const cat of CATEGORIES) {
  buckets[cat.key] = { S:{3:[],4:[],5:[]}, OH:{3:[],4:[],5:[]}, MB:{3:[],4:[],5:[]}, L:{3:[],4:[],5:[]} };
}

for (const rec of allRecords) {
  if (!rec.sets || rec.sets <= 0) continue;
  const grp = POS_GROUP_MAP[(rec.pos || '').toUpperCase()];
  if (!grp) continue;
  const setsPerGame = Math.min(5, Math.max(3, Math.round(rec.sets / (rec.games || 1))));

  for (const cat of CATEGORIES) {
    const raw    = Object.entries(cat.pos).reduce((s, [k, w]) => s + (rec[k] || 0) * w, 0);
    const errSum = Object.entries(cat.err).reduce((s, [k, w]) => s + (rec[k] || 0) * w, 0);
    const errPen = Math.max(ERR_FLOOR, Math.min(1.0, 1.0 - (errSum / (raw + 1)) * ERR_DAMP));
    const gis    = (raw / rec.sets) * errPen * GIS_SCALE;
    if (gis > 0) buckets[cat.key][grp][setsPerGame].push(Math.round(gis * 100));
  }
}

// Build 1000-point percentile arrays (same format as pgis_tables.json)
// Buckets with fewer than MIN_RECORDS fall back to the 4-set bucket.
const N = 1000;
const MIN_RECORDS = 30;
const tables = {};
for (const cat of CATEGORIES) {
  tables[cat.key] = {};
  for (const grp of ['S', 'OH', 'MB', 'L']) {
    tables[cat.key][grp] = {};
    // Build 3 and 4 first, then handle 5 with fallback
    for (const sc of [3, 4, 5]) {
      let raw = buckets[cat.key][grp][sc];
      if (raw.length < MIN_RECORDS && sc !== 4) {
        raw = [...buckets[cat.key][grp][4], ...raw]; // merge into 4-set pool
      }
      const sorted = raw.sort((a, b) => a - b);
      const len = sorted.length;
      if (!len) { tables[cat.key][grp][sc] = { p: [] }; continue; }
      // Last slot is absolute max + 1 so no real value can reach pGIS 10.0 in the season browser.
      const p = Array.from({ length: N }, (_, i) =>
        i === N - 1 ? sorted[len - 1] + 1 : sorted[Math.floor((i / N) * len)]
      );
      tables[cat.key][grp][sc] = { p };
      console.log(`  ${cat.key}/${grp}/${sc}: ${len} records`);
    }
  }
}

const outPath = path.join(__dirname, '../public/data/category_pgis_tables.json');
writeFileSync(outPath, JSON.stringify(tables));
console.log(`\nWritten: ${outPath}`);
