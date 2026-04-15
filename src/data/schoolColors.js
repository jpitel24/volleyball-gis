/**
 * schoolColors.js
 *
 * Maps normalized school display names to primary and secondary brand hex colors.
 * Keys are lowercase, trimmed, with single spaces (matching team.toLowerCase().trim()).
 *
 * Usage:
 *   import { getSchoolColors } from '../data/schoolColors.js';
 *   const { primary, secondary } = getSchoolColors(p.team);
 *
 * Fallback when school not found: { primary: '#1a1a2e', secondary: '#ffffff' }
 */

const SCHOOL_COLORS = {
  // ── Texas (first per request) ─────────────────────────────────────────────
  'texas':                { primary: '#BF5700', secondary: '#FFFFFF' },

  // ── SEC ──────────────────────────────────────────────────────────────────
  'alabama':              { primary: '#9E1B32', secondary: '#FFFFFF' },
  'arkansas':             { primary: '#9D2235', secondary: '#FFFFFF' },
  'auburn':               { primary: '#E87722', secondary: '#03244D' },
  'florida':              { primary: '#FA4616', secondary: '#0021A5' },
  'georgia':              { primary: '#BA0C2F', secondary: '#000000' },
  'kentucky':             { primary: '#0033A0', secondary: '#FFFFFF' },
  'lsu':                  { primary: '#461D7C', secondary: '#FDD023' },
  'mississippi state':    { primary: '#5D1725', secondary: '#FFFFFF' },
  'missouri':             { primary: '#F1B82D', secondary: '#000000' },
  'ole miss':             { primary: '#14213D', secondary: '#CE1126' },
  'oklahoma':             { primary: '#841617', secondary: '#FDF9D8' },
  'south carolina':       { primary: '#73000A', secondary: '#000000' },
  'tennessee':            { primary: '#FF8200', secondary: '#FFFFFF' },
  'texas a&m':            { primary: '#500000', secondary: '#FFFFFF' },
  'vanderbilt':           { primary: '#866D4B', secondary: '#000000' },

  // ── ACC ───────────────────────────────────────────────────────────────────
  'boston college':       { primary: '#8B0000', secondary: '#8B7355' },
  'clemson':              { primary: '#F66733', secondary: '#522D80' },
  'duke':                 { primary: '#012169', secondary: '#FFFFFF' },
  'florida state':        { primary: '#782F40', secondary: '#CEB888' },
  'georgia tech':         { primary: '#B3A369', secondary: '#003057' },
  'louisville':           { primary: '#AD0000', secondary: '#000000' },
  'miami':                { primary: '#005030', secondary: '#F47321' },
  'nc state':             { primary: '#CC0000', secondary: '#000000' },
  'north carolina':       { primary: '#7BAFD4', secondary: '#FFFFFF' },
  'notre dame':           { primary: '#0C2340', secondary: '#C99700' },
  'pitt':                 { primary: '#003594', secondary: '#FFB81C' },
  'pittsburgh':           { primary: '#003594', secondary: '#FFB81C' },
  'syracuse':             { primary: '#D44500', secondary: '#000000' },
  'virginia':             { primary: '#232D4B', secondary: '#F84C1E' },
  'virginia tech':        { primary: '#75232D', secondary: '#CF4420' },
  'wake forest':          { primary: '#9E7E38', secondary: '#000000' },

  // ── Big Ten ───────────────────────────────────────────────────────────────
  'illinois':             { primary: '#E84A27', secondary: '#13294B' },
  'indiana':              { primary: '#990000', secondary: '#FFFFFF' },
  'iowa':                 { primary: '#000000', secondary: '#FFCD00' },
  'maryland':             { primary: '#E03A3E', secondary: '#FFD520' },
  'michigan':             { primary: '#00274C', secondary: '#FFCB05' },
  'michigan state':       { primary: '#18453B', secondary: '#FFFFFF' },
  'minnesota':            { primary: '#7A0019', secondary: '#FFCC33' },
  'nebraska':             { primary: '#E41C38', secondary: '#FFFFFF' },
  'northwestern':         { primary: '#4E2A84', secondary: '#FFFFFF' },
  'ohio state':           { primary: '#BB0000', secondary: '#666666' },
  'oregon':               { primary: '#154733', secondary: '#FEE123' },
  'penn state':           { primary: '#041E42', secondary: '#FFFFFF' },
  'purdue':               { primary: '#CEB888', secondary: '#000000' },
  'rutgers':              { primary: '#CC0033', secondary: '#FFFFFF' },
  'ucla':                 { primary: '#2D68C4', secondary: '#F2A900' },
  'usc':                  { primary: '#990000', secondary: '#FFC72A' },
  'washington':           { primary: '#33006F', secondary: '#E8D3A2' },
  'wisconsin':            { primary: '#C5050C', secondary: '#FFFFFF' },

  // ── Big 12 ────────────────────────────────────────────────────────────────
  'arizona':              { primary: '#AB0520', secondary: '#0C234B' },
  'arizona state':        { primary: '#8C1D40', secondary: '#FFC627' },
  'baylor':               { primary: '#003015', secondary: '#FFB81C' },
  'byu':                  { primary: '#002E5D', secondary: '#FFFFFF' },
  'cincinnati':           { primary: '#E00122', secondary: '#000000' },
  'colorado':             { primary: '#CFB87C', secondary: '#000000' },
  'houston':              { primary: '#C8102E', secondary: '#63666A' },
  'iowa state':           { primary: '#C8102E', secondary: '#F1BE48' },
  'kansas':               { primary: '#0051A5', secondary: '#E8000D' },
  'kansas state':         { primary: '#512888', secondary: '#FFFFFF' },
  'oklahoma state':       { primary: '#FF7300', secondary: '#000000' },
  'tcu':                  { primary: '#4D1979', secondary: '#A3A9AC' },
  'ucf':                  { primary: '#BA9B37', secondary: '#000000' },
  'utah':                 { primary: '#CC0000', secondary: '#FFFFFF' },
  'west virginia':        { primary: '#002855', secondary: '#EAAA00' },
  'texas tech':           { primary: '#CC0000', secondary: '#000000' },

  // ── Add mid-major / lower-tier schools below this line ────────────────────
};

/**
 * Returns { primary, secondary } hex colors for a given school name.
 * Case-insensitive, trims whitespace, collapses internal spaces.
 * Falls back to { primary: '#1a1a2e', secondary: '#ffffff' } if not found.
 */
export function getSchoolColors(schoolName) {
  const key = (schoolName || '').toLowerCase().trim().replace(/\s+/g, ' ');
  return SCHOOL_COLORS[key] || { primary: '#1a1a2e', secondary: '#ffffff' };
}
