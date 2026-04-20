/**
 * schoolColors.js
 *
 * Lookup table of primary/secondary colors for NCAA D1 women's volleyball
 * programs, keyed by the lowercase-trimmed display team name (the same
 * form used in the playermatch CSVs). Used to tint the pGIS meter bar
 * on PlayerCard and the stylized export card.
 *
 * `getSchoolColors(name)` does case-insensitive lookup and falls back to
 * a neutral dark-blue / white pair for any school not in the table.
 */

const SCHOOL_COLORS = {
  // ── Texas (first per request) ─────────────────────────────────────
  'texas':               { primary: '#BF5700', secondary: '#FFFFFF' },

  // ── SEC ──────────────────────────────────────────────────────────
  'alabama':             { primary: '#9E1B32', secondary: '#FFFFFF' },
  'arkansas':            { primary: '#9D2235', secondary: '#FFFFFF' },
  'auburn':              { primary: '#E87722', secondary: '#03244D' },
  'florida':             { primary: '#FA4616', secondary: '#0021A5' },
  'georgia':             { primary: '#BA0C2F', secondary: '#000000' },
  'kentucky':            { primary: '#0033A0', secondary: '#FFFFFF' },
  'lsu':                 { primary: '#461D7C', secondary: '#FDD023' },
  'mississippi state':   { primary: '#5D1725', secondary: '#FFFFFF' },
  'missouri':            { primary: '#F1B82D', secondary: '#000000' },
  'ole miss':            { primary: '#14213D', secondary: '#CE1126' },
  'oklahoma':            { primary: '#841617', secondary: '#FDF9D8' },
  'south carolina':      { primary: '#73000A', secondary: '#000000' },
  'tennessee':           { primary: '#FF8200', secondary: '#FFFFFF' },
  'texas a&m':           { primary: '#500000', secondary: '#FFFFFF' },
  'vanderbilt':          { primary: '#866D4B', secondary: '#000000' },

  // ── ACC ───────────────────────────────────────────────────────────
  'florida state':       { primary: '#782F40', secondary: '#CEB888' },
  'louisville':          { primary: '#AD0000', secondary: '#000000' },
  'nc state':            { primary: '#CC0000', secondary: '#000000' },
  'pittsburgh':          { primary: '#003594', secondary: '#FFB81C' },
  'pitt':                { primary: '#003594', secondary: '#FFB81C' },
  'north carolina':      { primary: '#7BAFD4', secondary: '#FFFFFF' },
  'duke':                { primary: '#012169', secondary: '#FFFFFF' },
  'virginia':            { primary: '#232D4B', secondary: '#F84C1E' },
  'georgia tech':        { primary: '#B3A369', secondary: '#003057' },
  'clemson':             { primary: '#F66733', secondary: '#522D80' },
  'miami':               { primary: '#005030', secondary: '#F47321' },
  'virginia tech':       { primary: '#75232D', secondary: '#CF4420' },
  'boston college':      { primary: '#8B0000', secondary: '#8B7355' },
  'notre dame':          { primary: '#0C2340', secondary: '#C99700' },
  'wake forest':         { primary: '#9E7E38', secondary: '#000000' },
  'syracuse':            { primary: '#D44500', secondary: '#000000' },

  // ── Big Ten ───────────────────────────────────────────────────────
  'nebraska':            { primary: '#E41C38', secondary: '#FFFFFF' },
  'wisconsin':           { primary: '#C5050C', secondary: '#FFFFFF' },
  'minnesota':           { primary: '#7A0019', secondary: '#FFCC33' },
  'penn state':          { primary: '#041E42', secondary: '#FFFFFF' },
  'ohio state':          { primary: '#BB0000', secondary: '#666666' },
  'michigan':            { primary: '#00274C', secondary: '#FFCB05' },
  'illinois':            { primary: '#E84A27', secondary: '#13294B' },
  'indiana':             { primary: '#990000', secondary: '#FFFFFF' },
  'iowa':                { primary: '#000000', secondary: '#FFCD00' },
  'purdue':              { primary: '#CEB888', secondary: '#000000' },
  'michigan state':      { primary: '#18453B', secondary: '#FFFFFF' },
  'northwestern':        { primary: '#4E2A84', secondary: '#FFFFFF' },
  'maryland':            { primary: '#E03A3E', secondary: '#FFD520' },
  'rutgers':             { primary: '#CC0033', secondary: '#FFFFFF' },
  'ucla':                { primary: '#2D68C4', secondary: '#F2A900' },
  'usc':                 { primary: '#990000', secondary: '#FFC72A' },
  'washington':          { primary: '#33006F', secondary: '#E8D3A2' },
  'oregon':              { primary: '#154733', secondary: '#FEE123' },

  // ── Big 12 ────────────────────────────────────────────────────────
  'kansas':              { primary: '#0051A5', secondary: '#E8000D' },
  'kansas state':        { primary: '#512888', secondary: '#FFFFFF' },
  'oklahoma state':      { primary: '#FF7300', secondary: '#000000' },
  'baylor':              { primary: '#003015', secondary: '#FFB81C' },
  'tcu':                 { primary: '#4D1979', secondary: '#A3A9AC' },
  'iowa state':          { primary: '#C8102E', secondary: '#F1BE48' },
  'west virginia':       { primary: '#002855', secondary: '#EAAA00' },
  'cincinnati':          { primary: '#E00122', secondary: '#000000' },
  'byu':                 { primary: '#002E5D', secondary: '#FFFFFF' },
  'houston':             { primary: '#C8102E', secondary: '#63666A' },
  'ucf':                 { primary: '#BA9B37', secondary: '#000000' },
  'colorado':            { primary: '#CFB87C', secondary: '#000000' },
  'arizona':             { primary: '#AB0520', secondary: '#0C234B' },
  'arizona state':       { primary: '#8C1D40', secondary: '#FFC627' },
  'utah':                { primary: '#CC0000', secondary: '#FFFFFF' },

  // ── Add mid-major / lower-tier schools below this line ───────────
};

const DEFAULT_COLORS = { primary: '#1a1a2e', secondary: '#ffffff' };

export function getSchoolColors(schoolName) {
  const key = (schoolName || '').toLowerCase().trim().replace(/\s+/g, ' ');
  return SCHOOL_COLORS[key] || DEFAULT_COLORS;
}

export function hasSchoolColors(schoolName) {
  const key = (schoolName || '').toLowerCase().trim().replace(/\s+/g, ' ');
  return Object.prototype.hasOwnProperty.call(SCHOOL_COLORS, key);
}
