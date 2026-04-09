#!/usr/bin/env node
/**
 * extract-data.mjs
 *
 * Run this once to pull the embedded data blobs out of volleyball_gis.html
 * and write them as JSON files into public/data/.
 *
 * Usage:
 *   node scripts/extract-data.mjs path/to/volleyball_gis.html
 *
 * Output files (written to public/data/):
 *   pgis_tables.json
 *   rpi_by_year.json
 *   player_archive.json
 *   game_logs.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir    = join(__dirname, '..', 'public', 'data');
mkdirSync(outDir, { recursive: true });

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error('Usage: node scripts/extract-data.mjs path/to/volleyball_gis.html');
  process.exit(1);
}

const html = readFileSync(htmlPath, 'utf8');

// ─── Generic extractor ────────────────────────────────────────────────────────
// Finds  `const VARNAME = { ... };`  or  `const VARNAME = [ ... ];`
// Uses a simple brace-depth tracker so it handles nested structures.
function extractVar(src, varName) {
  // Match the start of the assignment
  const startRe = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*`);
  const match   = startRe.exec(src);
  if (!match) throw new Error(`Variable ${varName} not found in HTML`);

  let i          = match.index + match[0].length;
  const opener   = src[i];

  // Handle primitive literals: null, true, false, numbers
  if (opener !== '{' && opener !== '[') {
    const rest  = src.slice(i);
    const prim  = rest.match(/^(null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!prim)  throw new Error(`${varName}: unexpected opener '${opener}'`);
    // eslint-disable-next-line no-new-func
    return new Function(`"use strict"; return ${prim[1]};`)();
  }

  const closer   = opener === '{' ? '}' : ']';

  let depth = 0, inStr = false, strChar = '', escape = false;
  let start = i;

  for (; i < src.length; i++) {
    const ch = src[i];

    if (escape)          { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }

    if (!inStr && (ch === '"' || ch === "'" || ch === '`')) {
      inStr = true; strChar = ch; continue;
    }
    if (inStr && ch === strChar) { inStr = false; continue; }
    if (inStr) continue;

    if (ch === opener) depth++;
    if (ch === closer) { depth--; if (depth === 0) { i++; break; } }
  }

  const raw = src.slice(start, i).trim().replace(/;$/, '').trim();

  // Evaluate the raw JS literal into a real JS value, then serialise as JSON.
  // We use Function() so that JS object shorthand (keys without quotes) is handled.
  try {
    // eslint-disable-next-line no-new-func
    const val = new Function(`"use strict"; return (${raw});`)();
    return val;
  } catch (e) {
    throw new Error(`Failed to evaluate ${varName}: ${e.message}`);
  }
}

function write(name, val) {
  const path = join(outDir, name);
  writeFileSync(path, JSON.stringify(val));
  const kb = (Buffer.byteLength(JSON.stringify(val)) / 1024).toFixed(1);
  console.log(`  ✓ ${name}  (${kb} KB)`);
}

console.log(`\nExtracting data from: ${htmlPath}\n`);

try {
  write('pgis_tables.json',    extractVar(html, 'PGIS_TABLES'));
} catch(e) { console.warn('  ⚠ PGIS_TABLES:', e.message); }

try {
  write('rpi_by_year.json',    extractVar(html, 'RPI_BY_YEAR'));
} catch(e) { console.warn('  ⚠ RPI_BY_YEAR:', e.message); }

try {
  write('player_archive.json', extractVar(html, 'PLAYER_ARCHIVE'));
} catch(e) { console.warn('  ⚠ PLAYER_ARCHIVE:', e.message); }

try {
  write('game_logs.json',      extractVar(html, 'GAME_LOGS'));
} catch(e) { console.warn('  ⚠ GAME_LOGS:', e.message); }

console.log('\nDone. Files written to public/data/\n');
