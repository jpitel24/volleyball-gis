/**
 * schoolColors.js
 *
 * Primary/secondary colors for every NCAA D1 women's volleyball program,
 * keyed by the lowercase-trimmed form of the school name as it appears in
 * the playermatch CSVs and `public/data/historical_rpi.json`
 * (e.g. "mississippi st." — not "mississippi state").
 *
 * Used by PlayerCard to tint the pGIS meter bar and by the stylized
 * export card. `getSchoolColors(name)` does case-insensitive,
 * whitespace-normalized lookup and falls back to a neutral dark-blue /
 * white pair for any school not in the table.
 *
 * Source key format was chosen to match the CSV Team column directly so
 * that PlayerCard can pass `p.team` straight through. Common alias keys
 * (e.g. "pitt" → "pittsburgh", "ole miss" already matches) are added
 * where a school has multiple public-facing names.
 */

const SCHOOL_COLORS = {
  // ── SEC ──────────────────────────────────────────────────────────
  'alabama':             { primary: '#9E1B32', secondary: '#FFFFFF' },
  'arkansas':            { primary: '#9D2235', secondary: '#FFFFFF' },
  'auburn':              { primary: '#0C2340', secondary: '#E87722' },
  'florida':             { primary: '#0021A5', secondary: '#FA4616' },
  'georgia':             { primary: '#BA0C2F', secondary: '#000000' },
  'kentucky':            { primary: '#0033A0', secondary: '#FFFFFF' },
  'lsu':                 { primary: '#461D7C', secondary: '#FDD023' },
  'mississippi st.':     { primary: '#5D1725', secondary: '#FFFFFF' },
  'missouri':            { primary: '#F1B82D', secondary: '#000000' },
  'ole miss':            { primary: '#14213D', secondary: '#CE1126' },
  'oklahoma':            { primary: '#841617', secondary: '#FDF9D8' },
  'south carolina':      { primary: '#73000A', secondary: '#000000' },
  'tennessee':           { primary: '#FF8200', secondary: '#FFFFFF' },
  'texas':               { primary: '#BF5700', secondary: '#FFFFFF' },
  'texas a&m':           { primary: '#500000', secondary: '#FFFFFF' },
  'vanderbilt':          { primary: '#866D4B', secondary: '#000000' },

  // ── ACC ───────────────────────────────────────────────────────────
  'boston college':      { primary: '#8C2232', secondary: '#BC9B6A' },
  'california':          { primary: '#003262', secondary: '#FDB515' },
  'clemson':             { primary: '#F66733', secondary: '#522D80' },
  'duke':                { primary: '#012169', secondary: '#FFFFFF' },
  'florida st.':         { primary: '#782F40', secondary: '#CEB888' },
  'georgia tech':        { primary: '#B3A369', secondary: '#003057' },
  'louisville':          { primary: '#AD0000', secondary: '#000000' },
  'miami (fl)':          { primary: '#005030', secondary: '#F47321' },
  'nc state':            { primary: '#CC0000', secondary: '#000000' },
  'north carolina':      { primary: '#7BAFD4', secondary: '#FFFFFF' },
  'notre dame':          { primary: '#0C2340', secondary: '#C99700' },
  'pittsburgh':          { primary: '#003594', secondary: '#FFB81C' },
  'smu':                 { primary: '#C8102E', secondary: '#0033A0' },
  'stanford':            { primary: '#8C1515', secondary: '#FFFFFF' },
  'syracuse':            { primary: '#D44500', secondary: '#000000' },
  'virginia':            { primary: '#232D4B', secondary: '#F84C1E' },
  'virginia tech':       { primary: '#630031', secondary: '#CF4420' },
  'wake forest':         { primary: '#9E7E38', secondary: '#000000' },

  // ── Big Ten ───────────────────────────────────────────────────────
  'illinois':            { primary: '#E84A27', secondary: '#13294B' },
  'indiana':             { primary: '#990000', secondary: '#FFFFFF' },
  'iowa':                { primary: '#000000', secondary: '#FFCD00' },
  'maryland':            { primary: '#E03A3E', secondary: '#FFD520' },
  'michigan':            { primary: '#00274C', secondary: '#FFCB05' },
  'michigan st.':        { primary: '#18453B', secondary: '#FFFFFF' },
  'minnesota':           { primary: '#7A0019', secondary: '#FFCC33' },
  'nebraska':            { primary: '#E41C38', secondary: '#FFFFFF' },
  'northwestern':        { primary: '#4E2A84', secondary: '#FFFFFF' },
  'ohio st.':            { primary: '#BB0000', secondary: '#666666' },
  'oregon':              { primary: '#154733', secondary: '#FEE123' },
  'penn st.':            { primary: '#041E42', secondary: '#FFFFFF' },
  'purdue':              { primary: '#CEB888', secondary: '#000000' },
  'rutgers':             { primary: '#CC0033', secondary: '#FFFFFF' },
  'southern california': { primary: '#990000', secondary: '#FFC72A' },
  'ucla':                { primary: '#2D68C4', secondary: '#F2A900' },
  'washington':          { primary: '#4B2E83', secondary: '#B7A57A' },
  'wisconsin':           { primary: '#C5050C', secondary: '#FFFFFF' },

  // ── Big 12 ────────────────────────────────────────────────────────
  'arizona':             { primary: '#AB0520', secondary: '#0C234B' },
  'arizona st.':         { primary: '#8C1D40', secondary: '#FFC627' },
  'baylor':              { primary: '#003015', secondary: '#FFB81C' },
  'byu':                 { primary: '#002E5D', secondary: '#FFFFFF' },
  'cincinnati':          { primary: '#E00122', secondary: '#000000' },
  'colorado':            { primary: '#CFB87C', secondary: '#000000' },
  'houston':             { primary: '#C8102E', secondary: '#FFFFFF' },
  'iowa st.':            { primary: '#C8102E', secondary: '#F1BE48' },
  'kansas':              { primary: '#0051BA', secondary: '#E8000D' },
  'kansas st.':          { primary: '#512888', secondary: '#FFFFFF' },
  'oklahoma st.':        { primary: '#FF7300', secondary: '#000000' },
  'tcu':                 { primary: '#4D1979', secondary: '#A3A9AC' },
  'texas tech':          { primary: '#CC0000', secondary: '#000000' },
  'ucf':                 { primary: '#000000', secondary: '#BA9B37' },
  'utah':                { primary: '#CC0000', secondary: '#FFFFFF' },
  'west virginia':       { primary: '#002855', secondary: '#EAAA00' },

  // ── Pac-12 (rebuild) / remaining west ─────────────────────────────
  'oregon st.':          { primary: '#DC4405', secondary: '#000000' },
  'washington st.':      { primary: '#981E32', secondary: '#5E6A71' },

  // ── American (AAC) ───────────────────────────────────────────────
  'army west point':     { primary: '#000000', secondary: '#D4BF91' },
  'charlotte':           { primary: '#046A38', secondary: '#B9975B' },
  'east carolina':       { primary: '#592A8A', secondary: '#FDC82F' },
  'fla. atlantic':       { primary: '#003366', secondary: '#CC0000' },
  'memphis':             { primary: '#003087', secondary: '#8E9089' },
  'navy':                { primary: '#00205B', secondary: '#B9975B' },
  'north texas':         { primary: '#00853E', secondary: '#FFFFFF' },
  'rice':                { primary: '#00205B', secondary: '#C1C6C8' },
  'south fla.':          { primary: '#006747', secondary: '#CFC493' },
  'temple':              { primary: '#9D2235', secondary: '#FFFFFF' },
  'tulane':              { primary: '#006747', secondary: '#418FDE' },
  'tulsa':               { primary: '#003A70', secondary: '#C8102E' },
  'uab':                 { primary: '#1E6B52', secondary: '#F4C300' },
  'utsa':                { primary: '#0C2340', secondary: '#F15A22' },
  'wichita st.':         { primary: '#FFCD00', secondary: '#000000' },

  // ── Mountain West ────────────────────────────────────────────────
  'air force':           { primary: '#003594', secondary: '#8A8D8F' },
  'boise st.':           { primary: '#0033A0', secondary: '#D64309' },
  'colorado st.':        { primary: '#1E4D2B', secondary: '#C8C372' },
  'fresno st.':          { primary: '#DB0032', secondary: '#002E6D' },
  'hawaii':              { primary: '#024731', secondary: '#FFFFFF' },
  'nevada':              { primary: '#003366', secondary: '#807F84' },
  'new mexico':          { primary: '#BA0C2F', secondary: '#63666A' },
  'san diego st.':       { primary: '#A6192E', secondary: '#000000' },
  'san jose st.':        { primary: '#0055A2', secondary: '#E5A823' },
  'unlv':                { primary: '#CF0A2C', secondary: '#000000' },
  'utah st.':            { primary: '#00263A', secondary: '#8A8D8F' },
  'wyoming':             { primary: '#492F24', secondary: '#FFC425' },

  // ── Sun Belt ─────────────────────────────────────────────────────
  'app state':           { primary: '#000000', secondary: '#FFCC00' },
  'arkansas st.':        { primary: '#CC092F', secondary: '#000000' },
  'coastal carolina':    { primary: '#006F71', secondary: '#876D4B' },
  'ga. southern':        { primary: '#001A23', secondary: '#87714D' },
  'georgia st.':         { primary: '#0039A6', secondary: '#C60C30' },
  'james madison':       { primary: '#450084', secondary: '#CBB677' },
  'louisiana':           { primary: '#CE181E', secondary: '#000000' },
  'marshall':            { primary: '#00B140', secondary: '#000000' },
  'old dominion':        { primary: '#003057', secondary: '#7C878E' },
  'south alabama':       { primary: '#00205B', secondary: '#BF0D3E' },
  'southern miss.':      { primary: '#FFAA3C', secondary: '#000000' },
  'texas st.':           { primary: '#501214', secondary: '#83786F' },
  'troy':                { primary: '#8A2432', secondary: '#808080' },
  'ulm':                 { primary: '#8E0028', secondary: '#FFCC00' },

  // ── Conference USA ───────────────────────────────────────────────
  'jacksonville st.':    { primary: '#CE1126', secondary: '#000000' },
  'kennesaw st.':        { primary: '#000000', secondary: '#FFC629' },
  'liberty':             { primary: '#002D62', secondary: '#990000' },
  'louisiana tech':      { primary: '#002F8B', secondary: '#E31B23' },
  'middle tenn.':        { primary: '#0066CC', secondary: '#000000' },
  'new mexico st.':      { primary: '#8C0B42', secondary: '#FFFFFF' },
  'sam houston':         { primary: '#F56600', secondary: '#003594' },
  'utep':                { primary: '#041E42', secondary: '#FF8200' },
  'fiu':                 { primary: '#081E3F', secondary: '#B6862C' },
  'western ky.':         { primary: '#D60024', secondary: '#000000' },

  // ── Atlantic 10 ──────────────────────────────────────────────────
  'davidson':            { primary: '#000000', secondary: '#A6192E' },
  'dayton':              { primary: '#CE1141', secondary: '#004B8D' },
  'duquesne':            { primary: '#CC0000', secondary: '#002D62' },
  'fordham':             { primary: '#862633', secondary: '#FFFFFF' },
  'george mason':        { primary: '#006633', secondary: '#FFCC33' },
  'george washington':   { primary: '#033468', secondary: '#A9B0B7' },
  'la salle':            { primary: '#00205B', secondary: '#FFC72C' },
  'loyola chicago':      { primary: '#800000', secondary: '#FDBB30' },
  'rhode island':        { primary: '#002147', secondary: '#75B2DD' },
  'richmond':            { primary: '#990000', secondary: '#0033A0' },
  'saint joseph\u2019s':  { primary: '#A50021', secondary: '#B8860B' },
  "saint joseph's":      { primary: '#A50021', secondary: '#B8860B' },
  'saint louis':         { primary: '#003DA5', secondary: '#FFFFFF' },
  'st. bonaventure':     { primary: '#4B2E2E', secondary: '#FFFFFF' },
  'vcu':                 { primary: '#000000', secondary: '#F8B800' },

  // ── Big East ─────────────────────────────────────────────────────
  'butler':              { primary: '#0D1B2A', secondary: '#A9A9A9' },
  'connecticut':         { primary: '#000E2F', secondary: '#E4002B' },
  'uconn':               { primary: '#000E2F', secondary: '#E4002B' },
  'creighton':           { primary: '#00529C', secondary: '#FFFFFF' },
  'depaul':              { primary: '#00539F', secondary: '#E4002B' },
  'georgetown':          { primary: '#041E42', secondary: '#8D817B' },
  'marquette':           { primary: '#003366', secondary: '#FFCD00' },
  'providence':          { primary: '#000000', secondary: '#9E9E9E' },
  "st. john's (ny)":     { primary: '#BA0C2F', secondary: '#FFFFFF' },
  'seton hall':          { primary: '#004488', secondary: '#A7A9AC' },
  'villanova':           { primary: '#13B5EA', secondary: '#00205B' },
  'xavier':              { primary: '#0C2340', secondary: '#9EA2A2' },

  // ── WCC ──────────────────────────────────────────────────────────
  'gonzaga':             { primary: '#041E42', secondary: '#C8102E' },
  'lmu (ca)':            { primary: '#00205B', secondary: '#8A2432' },
  'pacific':             { primary: '#F47B20', secondary: '#000000' },
  'pepperdine':          { primary: '#00205B', secondary: '#F47321' },
  'portland':            { primary: '#4B306A', secondary: '#FFFFFF' },
  "saint mary's (ca)":   { primary: '#06315B', secondary: '#BF2C37' },
  'san diego':           { primary: '#002855', secondary: '#75B5E4' },
  'san francisco':       { primary: '#00543C', secondary: '#FDBB30' },
  'santa clara':         { primary: '#AA003D', secondary: '#FFFFFF' },

  // ── Big West ─────────────────────────────────────────────────────
  'cal poly':            { primary: '#154734', secondary: '#C8A964' },
  'cal st. fullerton':   { primary: '#00244E', secondary: '#FF7900' },
  'csun':                { primary: '#B30738', secondary: '#000000' },
  'csu bakersfield':     { primary: '#003A70', secondary: '#FDB827' },
  'hawaii':              { primary: '#024731', secondary: '#FFFFFF' },
  'long beach st.':      { primary: '#FFB81C', secondary: '#000000' },
  'uc davis':            { primary: '#002855', secondary: '#B3A369' },
  'uc irvine':           { primary: '#0064A4', secondary: '#FFD200' },
  'uc riverside':        { primary: '#003DA5', secondary: '#F1AA00' },
  'uc san diego':        { primary: '#182B49', secondary: '#FFCD00' },
  'uc santa barbara':    { primary: '#003660', secondary: '#FEBC11' },

  // ── Horizon League ──────────────────────────────────────────────
  'cleveland st.':       { primary: '#006A4D', secondary: '#FFFFFF' },
  'detroit mercy':       { primary: '#004987', secondary: '#FFCC29' },
  'green bay':           { primary: '#00563F', secondary: '#F6B221' },
  'iu indy':             { primary: '#DA1F05', secondary: '#000000' },
  'milwaukee':           { primary: '#000000', secondary: '#FFC20E' },
  'northern ky.':        { primary: '#000000', secondary: '#FFC72C' },
  'oakland':             { primary: '#000000', secondary: '#DAA900' },
  'purdue fort wayne':   { primary: '#00204E', secondary: '#DDB040' },
  'robert morris':       { primary: '#14377D', secondary: '#B02A30' },
  'uic':                 { primary: '#D50032', secondary: '#001E62' },
  'wright st.':          { primary: '#007A33', secondary: '#FFC72A' },
  'youngstown st.':      { primary: '#CE1126', secondary: '#FFFFFF' },

  // ── MVC ──────────────────────────────────────────────────────────
  'belmont':             { primary: '#002147', secondary: '#C8102E' },
  'bradley':             { primary: '#C8102E', secondary: '#000000' },
  'drake':               { primary: '#004A93', secondary: '#FFFFFF' },
  'evansville':          { primary: '#522D80', secondary: '#F1B434' },
  'illinois st.':        { primary: '#CE1126', secondary: '#FFFFFF' },
  'indiana st.':         { primary: '#0047BA', secondary: '#FFFFFF' },
  'missouri st.':        { primary: '#660033', secondary: '#FFFFFF' },
  'murray st.':          { primary: '#002147', secondary: '#FCB833' },
  'northern iowa':       { primary: '#4B116F', secondary: '#FFC82E' },
  'uni':                 { primary: '#4B116F', secondary: '#FFC82E' },
  'southern ill.':       { primary: '#720000', secondary: '#FFFFFF' },
  'valparaiso':          { primary: '#754E1A', secondary: '#EBB12E' },

  // ── Summit League ───────────────────────────────────────────────
  'denver':              { primary: '#864142', secondary: '#B5A268' },
  'kansas city':         { primary: '#00295B', secondary: '#FFC82E' },
  'north dakota':        { primary: '#009A44', secondary: '#000000' },
  'north dakota st.':    { primary: '#006341', secondary: '#FFB81C' },
  'omaha':               { primary: '#D6001C', secondary: '#000000' },
  'oral roberts':        { primary: '#002147', secondary: '#FFD100' },
  'south dakota':        { primary: '#D2232A', secondary: '#0C2340' },
  'south dakota st.':    { primary: '#0033A0', secondary: '#FFB81C' },
  'st. thomas (mn)':     { primary: '#510C76', secondary: '#F9B000' },

  // ── WAC ──────────────────────────────────────────────────────────
  'abilene christian':   { primary: '#4C2A85', secondary: '#FFFFFF' },
  'california baptist':  { primary: '#00205B', secondary: '#E4002B' },
  'grand canyon':        { primary: '#4B2A82', secondary: '#808080' },
  'sfa':                 { primary: '#582C83', secondary: '#C69214' },
  'seattle u':           { primary: '#AA0000', secondary: '#FFFFFF' },
  'southern utah':       { primary: '#CC0000', secondary: '#000000' },
  'tarleton st.':        { primary: '#4B116F', secondary: '#FFFFFF' },
  'uiw':                 { primary: '#B20838', secondary: '#000000' },
  'ut arlington':        { primary: '#0064B1', secondary: '#F58025' },
  'utah tech':           { primary: '#AA0000', secondary: '#000000' },
  'utah valley':         { primary: '#275D38', secondary: '#000000' },
  'utrgv':               { primary: '#F35B1C', secondary: '#003865' },

  // ── Big Sky ──────────────────────────────────────────────────────
  'eastern wash.':       { primary: '#A8102E', secondary: '#000000' },
  'idaho':               { primary: '#B3A369', secondary: '#191F1F' },
  'idaho st.':           { primary: '#F47B20', secondary: '#000000' },
  'montana':             { primary: '#7A0019', secondary: '#9EA2A2' },
  'montana st.':         { primary: '#003875', secondary: '#B69A4C' },
  'northern ariz.':      { primary: '#002B5C', secondary: '#FFC425' },
  'northern colo.':      { primary: '#013C65', secondary: '#F6B000' },
  'portland st.':        { primary: '#154734', secondary: '#FFFFFF' },
  'sacramento st.':      { primary: '#00543C', secondary: '#C4B581' },
  'weber st.':           { primary: '#582C83', secondary: '#FFFFFF' },

  // ── Southland ───────────────────────────────────────────────────
  'houston christian':   { primary: '#00205B', secondary: '#002855' },
  'incarnate word':      { primary: '#B20838', secondary: '#000000' },
  'lamar university':    { primary: '#D71920', secondary: '#FFFFFF' },
  'mcneese':             { primary: '#00539B', secondary: '#F5B335' },
  'new orleans':         { primary: '#002F65', secondary: '#A2AAAD' },
  'nicholls':            { primary: '#AE2531', secondary: '#8F8F8F' },
  'northwestern st.':    { primary: '#582C83', secondary: '#F15A22' },
  'southeastern la.':    { primary: '#006341', secondary: '#FFC627' },
  'texas a&m-cc':        { primary: '#005596', secondary: '#A7A8AA' },
  'a&m-corpus christi':  { primary: '#005596', secondary: '#A7A8AA' },
  'east texas a&m':      { primary: '#002855', secondary: '#FFC72C' },

  // ── SoCon ───────────────────────────────────────────────────────
  'chattanooga':         { primary: '#00386B', secondary: '#E0AA0F' },
  'citadel':             { primary: '#1B365D', secondary: '#AEAEA9' },
  'the citadel':         { primary: '#1B365D', secondary: '#AEAEA9' },
  'etsu':                { primary: '#002D65', secondary: '#FFC423' },
  'furman':              { primary: '#582C83', secondary: '#FFFFFF' },
  'mercer':              { primary: '#F47321', secondary: '#002D62' },
  'samford':             { primary: '#002147', secondary: '#C41230' },
  'unc greensboro':      { primary: '#FFB71B', secondary: '#002855' },
  'vmi':                 { primary: '#C8102E', secondary: '#FFD200' },
  'western caro.':       { primary: '#592C88', secondary: '#8B6F48' },
  'wofford':             { primary: '#8B6F48', secondary: '#000000' },

  // ── OVC ──────────────────────────────────────────────────────────
  'austin peay':         { primary: '#C41230', secondary: '#000000' },
  'eastern ill.':        { primary: '#00529C', secondary: '#717073' },
  'lindenwood':          { primary: '#BE1B4A', secondary: '#000000' },
  'little rock':         { primary: '#A10030', secondary: '#A2AAAD' },
  'morehead st.':        { primary: '#003DA5', secondary: '#F2C75C' },
  'se mo. st.':          { primary: '#B7202E', secondary: '#000000' },
  'southeast mo. st.':   { primary: '#B7202E', secondary: '#000000' },
  'siue':                { primary: '#A6192E', secondary: '#000000' },
  'southern ind.':       { primary: '#CE1126', secondary: '#002147' },
  'tennessee st.':       { primary: '#005596', secondary: '#FFFFFF' },
  'tennessee tech':      { primary: '#510C76', secondary: '#FFB71B' },
  'ut martin':           { primary: '#CF4420', secondary: '#002855' },
  'western ill.':        { primary: '#663399', secondary: '#FFCC00' },

  // ── Patriot League ──────────────────────────────────────────────
  'american':            { primary: '#CE1126', secondary: '#00205B' },
  'army west point':     { primary: '#000000', secondary: '#D4BF91' },
  'boston u.':           { primary: '#CC0000', secondary: '#FFFFFF' },
  'bucknell':            { primary: '#003A70', secondary: '#D49F00' },
  'colgate':             { primary: '#821019', secondary: '#FFFFFF' },
  'holy cross':          { primary: '#602D89', secondary: '#FFFFFF' },
  'lafayette':           { primary: '#641A2C', secondary: '#FFFFFF' },
  'lehigh':              { primary: '#4B2D17', secondary: '#FFE300' },
  'loyola maryland':     { primary: '#00543C', secondary: '#A89968' },
  'navy':                { primary: '#00205B', secondary: '#B9975B' },

  // ── Ivy League ──────────────────────────────────────────────────
  'brown':               { primary: '#4E3629', secondary: '#ED1C24' },
  'columbia':            { primary: '#9BCBEB', secondary: '#FFFFFF' },
  'cornell':             { primary: '#B31B1B', secondary: '#FFFFFF' },
  'dartmouth':           { primary: '#00693E', secondary: '#FFFFFF' },
  'harvard':             { primary: '#A51C30', secondary: '#FFFFFF' },
  'penn':                { primary: '#011F5B', secondary: '#990000' },
  'princeton':           { primary: '#E77500', secondary: '#000000' },
  'yale':                { primary: '#00356B', secondary: '#FFFFFF' },

  // ── CAA ──────────────────────────────────────────────────────────
  'campbell':            { primary: '#000000', secondary: '#FF6B00' },
  'col. of charleston':  { primary: '#63132F', secondary: '#FFFFFF' },
  'delaware':            { primary: '#00539F', secondary: '#FFD200' },
  'drexel':              { primary: '#07294D', secondary: '#FFC600' },
  'elon':                { primary: '#73000A', secondary: '#B59A57' },
  'hampton':             { primary: '#003B71', secondary: '#BFB68E' },
  'hofstra':             { primary: '#002E62', secondary: '#FFC72A' },
  'monmouth':            { primary: '#003DA5', secondary: '#A9A9AC' },
  'n.c. a&t':            { primary: '#004684', secondary: '#FFB71B' },
  'north carolina a&t':  { primary: '#004684', secondary: '#FFB71B' },
  'northeastern':        { primary: '#CC0000', secondary: '#000000' },
  'stony brook':         { primary: '#990000', secondary: '#000000' },
  'towson':              { primary: '#FFBE28', secondary: '#000000' },
  'uncw':                { primary: '#003366', secondary: '#BA9F66' },
  'william & mary':      { primary: '#115740', secondary: '#B9975B' },

  // ── ASUN ─────────────────────────────────────────────────────────
  'bellarmine':          { primary: '#990000', secondary: '#001D51' },
  'central ark.':        { primary: '#4F2984', secondary: '#A9A9AC' },
  'eastern ky.':         { primary: '#660000', secondary: '#B5A268' },
  'fgcu':                { primary: '#001E62', secondary: '#006747' },
  'jacksonville':        { primary: '#007A33', secondary: '#002F5D' },
  'lipscomb':            { primary: '#4E2A84', secondary: '#B3A369' },
  'north ala.':          { primary: '#63130F', secondary: '#FFFFFF' },
  'north florida':       { primary: '#004785', secondary: '#B7A76C' },
  'queens (nc)':         { primary: '#00205B', secondary: '#C8102E' },
  'stetson':             { primary: '#006747', secondary: '#FFFFFF' },
  'west ga.':            { primary: '#003DA5', secondary: '#C8102E' },

  // ── MAC ──────────────────────────────────────────────────────────
  'akron':               { primary: '#00285E', secondary: '#B3A369' },
  'ball st.':            { primary: '#BA0C2F', secondary: '#FFFFFF' },
  'bowling green':       { primary: '#4F2C1D', secondary: '#FE5000' },
  'buffalo':             { primary: '#041E42', secondary: '#FFFFFF' },
  'central mich.':       { primary: '#6A0032', secondary: '#FFC82E' },
  'eastern mich.':       { primary: '#006633', secondary: '#FFFFFF' },
  'kent st.':            { primary: '#002664', secondary: '#EAAB00' },
  'miami (oh)':          { primary: '#C41230', secondary: '#FFFFFF' },
  'niu':                 { primary: '#CC0000', secondary: '#000000' },
  'ohio':                { primary: '#00694E', secondary: '#CDA077' },
  'toledo':              { primary: '#15397F', secondary: '#FFC82E' },
  'western mich.':       { primary: '#6C4023', secondary: '#B5A268' },

  // ── MAAC ─────────────────────────────────────────────────────────
  'canisius':            { primary: '#003DA5', secondary: '#F1B434' },
  'fairfield':           { primary: '#C8102E', secondary: '#FFFFFF' },
  'iona':                { primary: '#7C0A02', secondary: '#FFB81C' },
  'manhattan':           { primary: '#064E2F', secondary: '#FFFFFF' },
  'marist':              { primary: '#B11B25', secondary: '#000000' },
  'merrimack':           { primary: '#002D72', secondary: '#F3B229' },
  'mount st. mary\u2019s': { primary: '#002147', secondary: '#F1B434' },
  "mount st. mary's":    { primary: '#002147', secondary: '#F1B434' },
  'niagara':             { primary: '#582D82', secondary: '#00539B' },
  'quinnipiac':          { primary: '#002F65', secondary: '#FFC82E' },
  'rider':               { primary: '#AE2531', secondary: '#FFFFFF' },
  'sacred heart':        { primary: '#A50021', secondary: '#FFFFFF' },
  "saint peter's":       { primary: '#002147', secondary: '#005EB8' },
  'siena':               { primary: '#006747', secondary: '#FFB71B' },

  // ── NEC ──────────────────────────────────────────────────────────
  'central conn. st.':   { primary: '#0F2348', secondary: '#0091B3' },
  'chicago st.':         { primary: '#005218', secondary: '#000000' },
  'fdu':                 { primary: '#00205B', secondary: '#BF311A' },
  'le moyne':            { primary: '#00573F', secondary: '#FFC72C' },
  'liu':                 { primary: '#004990', secondary: '#FFC72A' },
  'mercyhurst':          { primary: '#004B87', secondary: '#B5A268' },
  'saint francis':       { primary: '#BA0C2F', secondary: '#FFFFFF' },
  'st. francis brooklyn':{ primary: '#8B0000', secondary: '#000000' },
  'stonehill':           { primary: '#6A1437', secondary: '#FFFFFF' },
  'wagner':              { primary: '#006341', secondary: '#FFFFFF' },

  // ── America East ────────────────────────────────────────────────
  'binghamton':          { primary: '#005A43', secondary: '#000000' },
  'bryant':              { primary: '#272459', secondary: '#D6AC67' },
  'hartford':            { primary: '#CF102E', secondary: '#000000' },
  'maine':               { primary: '#005093', secondary: '#B0C2C5' },
  'new hampshire':       { primary: '#003591', secondary: '#FFFFFF' },
  'new haven':           { primary: '#002855', secondary: '#FFCC00' },
  'njit':                { primary: '#CA9A2E', secondary: '#CC0000' },
  'umbc':                { primary: '#FDB515', secondary: '#000000' },
  'ualbany':             { primary: '#461660', secondary: '#EEB211' },
  'vermont':             { primary: '#003300', secondary: '#FFD200' },

  // ── SWAC ─────────────────────────────────────────────────────────
  'alabama a&m':         { primary: '#790000', secondary: '#FFFFFF' },
  'alabama st.':         { primary: '#000000', secondary: '#E3A81E' },
  'alcorn':              { primary: '#4B0082', secondary: '#FFD700' },
  'ark.-pine bluff':     { primary: '#C49A3C', secondary: '#000000' },
  'bethune-cookman':     { primary: '#862633', secondary: '#F2A900' },
  'florida a&m':         { primary: '#FF8200', secondary: '#006747' },
  'grambling':           { primary: '#000000', secondary: '#FFC72C' },
  'jackson st.':         { primary: '#002147', secondary: '#C99700' },
  'mississippi val.':    { primary: '#006644', secondary: '#FFFFFF' },
  'prairie view':        { primary: '#4D1979', secondary: '#F4B223' },
  'southern u.':         { primary: '#002D62', secondary: '#FFC62D' },
  'texas southern':      { primary: '#660000', secondary: '#BEBEBE' },

  // ── MEAC ─────────────────────────────────────────────────────────
  'coppin st.':          { primary: '#002D62', secondary: '#FFB81C' },
  'delaware st.':        { primary: '#CF142B', secondary: '#003893' },
  'howard':              { primary: '#003A63', secondary: '#E51937' },
  'morgan st.':          { primary: '#00205B', secondary: '#F58025' },
  'n.c. central':        { primary: '#8A1538', secondary: '#8F7E3D' },
  'norfolk st.':         { primary: '#046A38', secondary: '#F1B434' },
  'south carolina st.':  { primary: '#7A0028', secondary: '#003087' },
  'umes':                { primary: '#7B0A05', secondary: '#9EA2A2' },

  // ── Big South ───────────────────────────────────────────────────
  'charleston so.':      { primary: '#0046AD', secondary: '#B29B6A' },
  'gardner-webb':        { primary: '#CE1126', secondary: '#000000' },
  'high point':          { primary: '#582C83', secondary: '#FFFFFF' },
  'longwood':            { primary: '#00539F', secondary: '#C09F5F' },
  'presbyterian':        { primary: '#0A2240', secondary: '#98002E' },
  'radford':             { primary: '#990000', secondary: '#008264' },
  'unc asheville':       { primary: '#002855', secondary: '#BBB27A' },
  'usc upstate':         { primary: '#006A4E', secondary: '#FDBB30' },
  'winthrop':            { primary: '#900028', secondary: '#FFFFFF' },

  // ── Summit / extra mid-majors previously missed ─────────────────
  'lmu (ca)':            { primary: '#00205B', secondary: '#8A2432' },

  // ── Common aliases ──────────────────────────────────────────────
  'pitt':                { primary: '#003594', secondary: '#FFB81C' },
  'pittsburgh':          { primary: '#003594', secondary: '#FFB81C' },
  'miami':               { primary: '#005030', secondary: '#F47321' },
  'usc':                 { primary: '#990000', secondary: '#FFC72A' },
  'florida state':       { primary: '#782F40', secondary: '#CEB888' },
  'mississippi state':   { primary: '#5D1725', secondary: '#FFFFFF' },
  'oklahoma state':      { primary: '#FF7300', secondary: '#000000' },
  'arizona state':       { primary: '#8C1D40', secondary: '#FFC627' },
  'ohio state':          { primary: '#BB0000', secondary: '#666666' },
  'penn state':          { primary: '#041E42', secondary: '#FFFFFF' },
  'michigan state':      { primary: '#18453B', secondary: '#FFFFFF' },
  'boise state':         { primary: '#0033A0', secondary: '#D64309' },
  'colorado state':      { primary: '#1E4D2B', secondary: '#C8C372' },
  'long beach state':    { primary: '#FFB81C', secondary: '#000000' },
};

const DEFAULT_COLORS = { primary: '#1a1a2e', secondary: '#ffffff' };

function normalize(schoolName) {
  return (schoolName || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function getSchoolColors(schoolName) {
  return SCHOOL_COLORS[normalize(schoolName)] || DEFAULT_COLORS;
}

export function hasSchoolColors(schoolName) {
  return Object.prototype.hasOwnProperty.call(SCHOOL_COLORS, normalize(schoolName));
}
