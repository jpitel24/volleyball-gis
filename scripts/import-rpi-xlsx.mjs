/**
 * import-rpi-xlsx.mjs
 *
 * Reads NCAA RPI Excel files (2021–2025) and merges them into
 * public/data/rpi_by_year.json, overwriting existing year data.
 *
 * Usage:
 *   node scripts/import-rpi-xlsx.mjs "C:/path/to/xlsx/folder"
 *   node scripts/import-rpi-xlsx.mjs   (defaults to C:/Users/gordo/Downloads)
 *
 * Expected file names: "NCAA Statistics RPI {year}.xlsx"
 * Key columns: Team (col 0), Adj.RPIValue (col 3)
 */

import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require   = createRequire(import.meta.url);
const XLSX      = require('xlsx');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const XLSX_DIR  = process.argv[2] || 'C:/Users/gordo/Downloads';
const OUT_PATH  = path.join(__dirname, '../public/data/rpi_by_year.json');
const YEARS     = [2021, 2022, 2023, 2024, 2025];

// ── Name normalisation ────────────────────────────────────────────────────────
// Goal: produce the same lowercase keys used in the existing rpi_by_year.json.
// Patterns observed in the existing JSON:
//   "penn state", "ohio state", "texas a m", "florida a m", "william mary",
//   "saint mary's", "southeast mo state", "central conn state",
//   "cal state fullerton", "nc state", "app state"
function normaliseTeam(raw) {
  return raw
    // Strip auto-qualifier and regional markers in parens: (AQ), (NY), (CA), (MN) etc.
    .replace(/\([^)]*\)/g, '')
    // "St." → "state" — no trailing \b because . is a non-word char and \b won't fire after it.
    // This correctly handles "Penn St.", "St. John's", "Cal St. Fullerton", etc.
    .replace(/\bSt\./gi, 'state')
    // Remaining abbreviation dots: "Mo." → "Mo", "Conn." → "Conn", "N.C." → "N C" etc.
    .replace(/\b([A-Za-z]{1,4})\./g, '$1')
    // "&" (A&M, A&T, William & Mary) → space; collapse below handles doubles
    .replace(/&/g, ' ')
    // Lowercase everything
    .toLowerCase()
    // Keep apostrophes — existing keys have "saint mary's"
    // Remove anything that isn't a letter, digit, apostrophe, or space
    .replace(/[^a-z0-9'\s]/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Load existing data ────────────────────────────────────────────────────────
let existing = {};
try {
  existing = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  console.log('Loaded existing rpi_by_year.json — years:', Object.keys(existing).join(', '));
} catch {
  console.log('No existing rpi_by_year.json — creating fresh.');
}

// ── Process each year ─────────────────────────────────────────────────────────
for (const year of YEARS) {
  const xlsxPath = path.join(XLSX_DIR, `NCAA Statistics RPI ${year}.xlsx`);
  let wb;
  try {
    wb = XLSX.readFile(xlsxPath);
  } catch (e) {
    console.warn(`  ⚠ ${year}: could not read ${xlsxPath} — ${e.message}`);
    continue;
  }

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  // Find column indices from header row
  const header = rows[0].map(h => String(h).trim());
  const teamCol = header.findIndex(h => h === 'Team');
  const rpiCol  = header.findIndex(h => h === 'Adj.RPIValue');

  if (teamCol === -1 || rpiCol === -1) {
    console.warn(`  ⚠ ${year}: could not find Team/Adj.RPIValue columns in`, header);
    continue;
  }

  const yearData = {};
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const rawName = String(row[teamCol] ?? '').trim();
    const rpiVal  = parseFloat(row[rpiCol]);
    if (!rawName || isNaN(rpiVal)) { skipped++; continue; }
    const key = normaliseTeam(rawName);
    if (!key) { skipped++; continue; }
    yearData[key] = rpiVal;
  }

  existing[String(year)] = yearData;
  console.log(`  ✓ ${year}: ${Object.keys(yearData).length} teams (${skipped} skipped)`);
}

// ── Write output ─────────────────────────────────────────────────────────────
writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2));
console.log(`\nWritten: ${OUT_PATH}`);

// ── Validation: cross-check 2024 Excel vs existing keys ──────────────────────
console.log('\n── 2024 validation (Excel names → JSON keys) ──');
const wb24 = XLSX.readFile(path.join(XLSX_DIR, 'NCAA Statistics RPI 2024.xlsx'));
const rows24 = XLSX.utils.sheet_to_json(wb24.Sheets[wb24.SheetNames[0]], { header: 1 }).slice(1);
const keys24 = Object.keys(existing['2024'] || {});
const keySet = new Set(keys24);
const notFound = rows24
  .map(r => ({ raw: String(r[0]||'').trim(), key: normaliseTeam(String(r[0]||'').trim()) }))
  .filter(({ key }) => key && !keySet.has(key));
if (notFound.length === 0) {
  console.log('All 2024 teams matched ✓');
} else {
  console.log('Unmatched (these teams have generated keys not in the new set — check for collisions):');
  notFound.forEach(({ raw, key }) => console.log(`  ${JSON.stringify(raw)} → ${JSON.stringify(key)}`));
}
