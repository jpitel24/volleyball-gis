import { useEffect, useMemo, useState } from 'react';
import { useData } from '../lib/DataContext.jsx';
import { loadPlayerIndex, isP4, P4_CONFERENCES } from '../lib/playerIndex.js';
import { posColor, pgisLabel, posGroup } from '../lib/gis.js';

const MAX_RESULTS = 100;

const YEAR_FILTERS = [
  { id: 'ALL',  label: 'All-Time' },
  { id: '2026', label: '2026' },
  { id: '2025', label: '2025' },
  { id: '2024', label: '2024' },
  { id: '2023', label: '2023' },
  { id: '2022', label: '2022' },
];

const POS_FILTERS = [
  { id: 'ALL', label: 'All' },
  { id: 'OH',  label: 'OH/RS' },
  { id: 'MB',  label: 'MB' },
  { id: 'S',   label: 'S' },
  { id: 'L',   label: 'L/DS' },
];

const T50_MIN_OPTIONS = [
  { id: 0,  label: 'Any' },
  { id: 1,  label: '1+' },
  { id: 3,  label: '3+' },
  { id: 5,  label: '5+' },
  { id: 10, label: '10+' },
  { id: 15, label: '15+' },
];

const SORT_OPTIONS = [
  { id: 'gisPlus',    label: 'GIS+' },
  { id: 'pGIS',       label: 'pGIS' },
  { id: 't50GisPlus', label: 'T50 GIS+' },
  { id: 't50PGis',    label: 'T50 pGIS' },
  { id: 'rec',        label: 'REC%' },
  { id: 'srv',        label: 'SRV+' },
  { id: 'ast',        label: 'AST%' },
  { id: 'blk',        label: 'BLK+' },
];

function fmt(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(d);
}

function PGISCell({ v }) {
  if (v == null || !Number.isFinite(v)) return <td style={{ textAlign: 'right' }}>—</td>;
  const [, cls] = pgisLabel(v);
  return (
    <td style={{ textAlign: 'right' }}>
      <span className={`pb-chip pgis-${cls}`} style={{ fontSize: '0.6rem' }}>
        {v.toFixed(1)}
      </span>
    </td>
  );
}

// Compact tier-colored cells for the leaderboard. Same coloring rules
// as PlayerLookup's RecCell / ServeCell / SetCell / BlockCell — kept
// inline here because the leaderboard cells are smaller and don't need
// the per-row hover tooltips.
function tierColor(value, thresholds) {
  if (!Number.isFinite(value)) return 'var(--muted)';
  if (value >= thresholds[0]) return 'var(--green)';
  if (value >= thresholds[1]) return 'var(--accent)';
  if (value >= thresholds[2]) return 'var(--yellow)';
  return 'var(--red)';
}
function RecLeaderCell({ rq }) {
  if (!rq?.qualified) return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  const color = tierColor(rq.greatPct, [0.50, 0.40, 0.30]);
  return <td style={{ textAlign: 'right', color, fontWeight: 700 }}>{Math.round(rq.greatPct * 100)}%</td>;
}
function SrvLeaderCell({ sq }) {
  if (!sq?.qualified) return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  const color = tierColor(sq.effectivePct, [0.25, 0.20, 0.15]);
  return <td style={{ textAlign: 'right', color, fontWeight: 700 }}>{Math.round(sq.effectivePct * 100)}%</td>;
}
function AstLeaderCell({ sq }) {
  if (!sq?.qualified) return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  const color = tierColor(sq.assistPct, [0.40, 0.35, 0.30]);
  return <td style={{ textAlign: 'right', color, fontWeight: 700 }}>{Math.round(sq.assistPct * 100)}%</td>;
}
function BlkLeaderCell({ value, sets }) {
  if (!Number.isFinite(value) || (sets || 0) < 50) {
    return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  }
  const color = tierColor(value, [1.5, 1.0, 0.5]);
  return <td style={{ textAlign: 'right', color, fontWeight: 700 }}>{value.toFixed(2)}</td>;
}

// Build a flat list of rows, one per (player × season). All-Time mode
// emits every qualifying season across 2022-2025, so a transfer like
// Torrey Stafford shows as three rows (two Pitt seasons + one Texas).
// Year-specific mode filters to just that year's rows.
// Constant filter: a player must have appeared in at least this fraction
// of their team's games to chart on the leaderboard. Without it, one-game
// cameos with a single huge match dominate the all-time pGIS view (the
// season pGIS is the simple average of per-match pGIS, so 1-of-1 = pure
// outlier production).
const MIN_TEAM_GAME_SHARE = 0.75;

function buildRows(players, year) {
  const rows = [];
  const targetYear = year === 'ALL' ? null : parseInt(year, 10);
  for (const p of players) {
    for (const s of p.seasons) {
      if (!s.games) continue;
      if (targetYear !== null && s.year !== targetYear) continue;
      // Skip seasons where the player didn't show up for ≥75% of the
      // team's slate. teamGames=0 means we couldn't resolve the team's
      // schedule (rare; treat as a fail-closed skip).
      if (!s.teamGames || s.games / s.teamGames < MIN_TEAM_GAME_SHARE) continue;
      rows.push({
        playerKey:      p.key,
        name:           p.name,
        team:           s.team || p.team,
        conference:     s.conference || '',
        position:       s.position || p.position,
        year:           s.year,
        games:          s.games,
        sets:           s.sets,
        teamGames:      s.teamGames,
        totals:         s.totals,
        gis:            s.gis,
        gisPlus:        s.gisPlus,
        pGIS:           s.pGIS,
        t50:            s.t50,
        recQuality:     s.recQuality,
        srvQuality:     s.srvQuality,
        setQuality:     s.setQuality,
        blockEffPerSet: s.blockEffPerSet,
      });
    }
  }
  return rows;
}

export default function SeasonLookup() {
  const { pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality, loading } = useData();
  const [index, setIndex]            = useState(null);
  const [indexErr, setIndexErr]      = useState(null);
  const [buildingIndex, setBuilding] = useState(false);

  const [year, setYear]           = useState('2026');
  const [posFilter, setPosFilter] = useState('ALL');
  const [minT50, setMinT50]       = useState(0);
  const [sortBy, setSortBy]       = useState('gisPlus');
  // Conference filter: 'ALL' | 'P4' | 'NON_P4' | any specific conference label
  const [confFilter, setConfFilter] = useState('ALL');

  useEffect(() => {
    if (loading || !pgisTables) return;
    let cancelled = false;
    setBuilding(true);
    loadPlayerIndex(pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality)
      .then(idx => { if (!cancelled) { setIndex(idx); setBuilding(false); } })
      .catch(err => { if (!cancelled) { setIndexErr(err?.message || String(err)); setBuilding(false); } });
    return () => { cancelled = true; };
  }, [loading, pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality]);

  const allRows = useMemo(() => {
    if (!index) return [];
    return buildRows(index.players, year);
  }, [index, year]);

  // Union of every conference seen for the selected year, sorted for
  // the filter dropdown. Rebuilt when the year changes.
  const yearConferences = useMemo(() => {
    const set = new Set();
    for (const r of allRows) if (r.conference) set.add(r.conference);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allRows]);

  const filtered = useMemo(() => {
    const rows = allRows.filter(r => {
      if (posFilter !== 'ALL' && posGroup(r.position) !== posFilter) return false;
      if (minT50 > 0) {
        const g = r.t50?.games || 0;
        if (g < minT50) return false;
      }
      if (confFilter !== 'ALL') {
        if (confFilter === 'P4' && !isP4(r.conference)) return false;
        if (confFilter === 'NON_P4' && isP4(r.conference)) return false;
        if (confFilter !== 'P4' && confFilter !== 'NON_P4'
            && r.conference !== confFilter) return false;
      }
      return true;
    });
    const get = (r) => {
      if (sortBy === 'gisPlus')     return r.gisPlus || 0;
      if (sortBy === 'pGIS')        return r.pGIS    || 0;
      if (sortBy === 't50GisPlus')  return r.t50?.gisPlus ?? -Infinity;
      if (sortBy === 't50PGis')     return r.t50?.pGIS    ?? -Infinity;
      // Unqualified PBP-derived metrics fall to -Infinity so they
      // sink to the bottom rather than competing with real numbers.
      if (sortBy === 'rec')         return r.recQuality?.qualified ? r.recQuality.greatPct     : -Infinity;
      if (sortBy === 'srv')         return r.srvQuality?.qualified ? r.srvQuality.effectivePct : -Infinity;
      if (sortBy === 'ast')         return r.setQuality?.qualified ? r.setQuality.assistPct    : -Infinity;
      if (sortBy === 'blk') {
        if (!Number.isFinite(r.blockEffPerSet) || (r.sets || 0) < 50) return -Infinity;
        return r.blockEffPerSet;
      }
      return 0;
    };
    rows.sort((a, b) => get(b) - get(a));
    return rows;
  }, [allRows, posFilter, minT50, sortBy, confFilter]);

  const visible  = filtered.slice(0, MAX_RESULTS);
  const totalHits = filtered.length;

  // Computer All-American team picks. AVCA-style position mix
  // (2 OH, 2 MB, 1 S, 1 L) chosen by:
  //   1. Eligibility — must have at least AA_MIN_T50_GAMES games vs.
  //      RPI Top-50 opponents that season (the "showed up against good
  //      teams" filter — pure pGIS without this lets cupcake-schedule
  //      stars chart even though pGIS already opponent-adjusts).
  //   2. Hybrid score — AA_W_OVERALL × season pGIS
  //                   + AA_W_T50     × season T50 pGIS.
  //      Rewards consistency over the full slate AND production
  //      specifically against elite opponents.
  // Career picks (All-Time) need a different aggregation; for now the
  // panel only renders for a specific year.
  const allAmericans = useMemo(() => {
    if (!index || year === 'ALL') return null;
    const AA_W_OVERALL   = 0.60;
    const AA_W_T50       = 0.40;
    const K_T50_GAMES    = 0.05;   // additive bonus per T50 game played
    const T50_TRUST_FULL = 20;     // T50 games at which we fully trust T50 pGIS

    // No hard T50-games gate. The 75% team-games filter in buildRows()
    // is the only qualification. Small-sample T50 pGIS is shrunk toward
    // zero via the trust weight, so a mid-major with one lucky T50
    // performance can't leapfrog a real P4 season, and a 0-T50 player
    // naturally scores low enough to fall out of the AA cohort.
    const byBucket = { OH: [], MB: [], S: [], L: [] };
    for (const r of allRows) {
      const grp = posGroup(r.position);
      if (!grp || !byBucket[grp]) continue;
      if (!Number.isFinite(r.pGIS)) continue;
      const t50Games = r.t50?.games || 0;
      const t50PGis  = Number.isFinite(r.t50?.pGIS) ? r.t50.pGIS : 0;
      const trust    = Math.min(t50Games / T50_TRUST_FULL, 1.0);
      const effT50   = t50PGis * trust;
      byBucket[grp].push({
        ...r,
        aaScore: AA_W_OVERALL * r.pGIS
               + AA_W_T50 * effT50
               + K_T50_GAMES * t50Games,
      });
    }
    for (const k of Object.keys(byBucket)) {
      byBucket[k].sort((a, b) => (b.aaScore || 0) - (a.aaScore || 0));
    }
    // Slot template — reused for both teams. Index into each bucket
    // shifts by 6 between teams (2 OH, 2 MB, 1 S, 1 L).
    const teamFor = (offsets) => [
      { slot: 'OH', pick: byBucket.OH[offsets.OH    ] },
      { slot: 'OH', pick: byBucket.OH[offsets.OH + 1] },
      { slot: 'MB', pick: byBucket.MB[offsets.MB    ] },
      { slot: 'MB', pick: byBucket.MB[offsets.MB + 1] },
      { slot: 'S',  pick: byBucket.S [offsets.S     ] },
      { slot: 'L',  pick: byBucket.L [offsets.L     ] },
    ].filter(s => s.pick);

    const firstTeam  = teamFor({ OH: 0, MB: 0, S: 0, L: 0 });
    const secondTeam = teamFor({ OH: 2, MB: 2, S: 1, L: 1 });
    return { firstTeam, secondTeam };
  }, [index, allRows, year]);

  return (
    <>
      <aside className="tool-sidebar">
        <div className="tool-sidebar-title">Seasons</div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Year</div>
          <div className="tool-sidebar-pills">
            {YEAR_FILTERS.map(f => (
              <button
                key={f.id}
                type="button"
                className={`gl-mode-btn${year === f.id ? ' active' : ''}`}
                onClick={() => setYear(f.id)}
                disabled={buildingIndex || !index}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Position</div>
          <div className="tool-sidebar-pills">
            {POS_FILTERS.map(f => (
              <button
                key={f.id}
                type="button"
                className={`gl-mode-btn${posFilter === f.id ? ' active' : ''}`}
                onClick={() => setPosFilter(f.id)}
                disabled={buildingIndex || !index}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Conference</div>
          <select
            value={confFilter}
            onChange={(e) => setConfFilter(e.target.value)}
            disabled={buildingIndex || !index}
            style={{
              width: '100%',
              padding: '0.4rem 0.5rem',
              background: 'var(--panel-2)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.78rem',
            }}
          >
            <option value="ALL">All Conferences</option>
            <option value="P4">Power 4 (ACC, B10, B12, SEC, Pac-12)</option>
            <option value="NON_P4">Non-Power 4</option>
            <option disabled>──────────</option>
            {yearConferences.map(c => (
              <option key={c} value={c}>
                {c}{P4_CONFERENCES.has(c) ? '  ★' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Min T50 Games</div>
          <div className="tool-sidebar-pills">
            {T50_MIN_OPTIONS.map(o => (
              <button
                key={o.id}
                type="button"
                className={`gl-mode-btn${minT50 === o.id ? ' active' : ''}`}
                onClick={() => setMinT50(o.id)}
                disabled={buildingIndex || !index}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Sort</div>
          <div className="tool-sidebar-pills">
            {SORT_OPTIONS.map(o => (
              <button
                key={o.id}
                type="button"
                className={`gl-mode-btn${sortBy === o.id ? ' active' : ''}`}
                onClick={() => setSortBy(o.id)}
                disabled={buildingIndex || !index}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="tool-main">
        <div className="page-title-row">
          <h1 className="page-title">Season Browser</h1>
          <div className="page-sub">
            Rank D1 players by GIS+ or pGIS, filtered by year, position group, and
            minimum games vs RPI Top-50 opponents. Players must have appeared in
            ≥75% of their team's games to chart.
          </div>
        </div>

      <div className="gb-status">
        {loading && <><div className="spinner" /> Loading baselines…</>}
        {!loading && buildingIndex && <><div className="spinner" /> Building player index…</>}
        {indexErr && <span style={{ color: '#f43f5e' }}>Error: {indexErr}</span>}
        {index && !buildingIndex && (
          <>
            {totalHits.toLocaleString()} player-season{totalHits === 1 ? '' : 's'}
            {year === 'ALL' ? ' (2022–2025)' : ` · ${year}`}
            {posFilter !== 'ALL' && ` · ${POS_FILTERS.find(f => f.id === posFilter).label}`}
            {confFilter !== 'ALL' && ` · ${confFilter === 'P4' ? 'Power 4'
                                        : confFilter === 'NON_P4' ? 'Non-P4'
                                        : confFilter}`}
            {minT50 > 0 && ` · ${minT50}+ T50 G`}
            {totalHits > MAX_RESULTS && ` — showing top ${MAX_RESULTS}`}
          </>
        )}
      </div>

      {index && allAmericans && allAmericans.firstTeam.length === 6 && (
        <div className="aa-panel">
          <div className="aa-panel-title">
            {year} Computer All-American Teams
            <span className="aa-panel-sub">≥75% team games · 0.6 × pGIS + 0.4 × trust(T50) × T50 pGIS + 0.05 × T50 games · 2 OH · 2 MB · 1 S · 1 L</span>
          </div>

          {[
            { label: 'First Team',  team: allAmericans.firstTeam,  rank: 1 },
            { label: 'Second Team', team: allAmericans.secondTeam, rank: 2 },
          ].filter(t => t.team.length === 6).map(({ label, team, rank }) => (
            <div key={rank} className={`aa-team-block aa-team-${rank}`}>
              <div className="aa-team-label">{label}</div>
              <div className="aa-grid">
                {team.map((entry, i) => {
                  const r  = entry.pick;
                  const pc = posColor(r.position);
                  return (
                    <div key={i} className="aa-card" style={{ borderTop: `3px solid ${pc}` }}>
                      <div className="aa-slot" style={{ color: pc }}>{entry.slot}</div>
                      <div className="aa-name">{r.name}</div>
                      <div className="aa-team">{r.team}</div>
                      <div className="aa-stats">
                        <span className="aa-pgis" style={{ color: 'var(--pgis)' }}>pGIS {r.pGIS.toFixed(1)}</span>
                        <span className="aa-gisplus" style={{ color: 'var(--gisplus)' }}>{r.gisPlus.toFixed(2)} GIS+/S</span>
                        <span className="aa-t50" style={{ color: 'var(--muted)' }}>
                          T50 pGIS {Number.isFinite(r.t50?.pGIS) ? r.t50.pGIS.toFixed(1) : '—'}
                          <span style={{ opacity: 0.65 }}> · {r.t50?.games || 0}G</span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {index && visible.length > 0 && (
        <div className="pb-table-wrap" style={{ maxWidth: '1200px', margin: '0 auto' }}>
          <table className="pb-season-table" style={{ width: '100%', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.72rem' }}>
            <thead>
              <tr style={{ color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <th style={{ textAlign: 'right' }}>#</th>
                <th className="text-left">Player</th>
                <th className="text-left">Team</th>
                <th className="text-left">Pos</th>
                <th style={{ textAlign: 'right' }}>Yr</th>
                <th style={{ textAlign: 'right' }}>G</th>
                <th style={{ textAlign: 'right' }}>S</th>
                <th style={{ textAlign: 'right' }}>GIS/S</th>
                <th style={{ textAlign: 'right' }}>GIS+/S</th>
                <th style={{ textAlign: 'right' }}>pGIS</th>
                <th style={{ textAlign: 'right' }} title="Great-pass %: setter on 2nd touch and hitter killed on 3rd">REC%</th>
                <th style={{ textAlign: 'right' }} title="Effective serve %: ace + serves where we scored within 3 touches of reception">SRV+</th>
                <th style={{ textAlign: 'right' }} title="Assist %: fraction of sets producing a kill on the next touch">AST%</th>
                <th style={{ textAlign: 'right' }} title="Net blocks per set: (solos + 0.5 × assists − errors) / sets">BLK+</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }}>T50 G</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }}>T50 GIS+/S</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }}>T50 pGIS</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.playerKey + '_' + r.year}>
                  <td style={{ textAlign: 'right', color: 'var(--muted)' }}>{i + 1}</td>
                  <td className="pb-name" style={{ color: posColor(r.position) }}>{r.name}</td>
                  <td className="pb-team">{r.team}</td>
                  <td>{r.position}</td>
                  <td style={{ textAlign: 'right' }}>{r.year}</td>
                  <td style={{ textAlign: 'right' }}>{r.games}</td>
                  <td style={{ textAlign: 'right' }}>{r.sets}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(r.gis)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--gisplus)' }}>{fmt(r.gisPlus)}</td>
                  <PGISCell v={r.pGIS} />
                  <RecLeaderCell rq={r.recQuality} />
                  <SrvLeaderCell sq={r.srvQuality} />
                  <AstLeaderCell sq={r.setQuality} />
                  <BlkLeaderCell value={r.blockEffPerSet} sets={r.sets} />
                  <td style={{ textAlign: 'right', opacity: 0.7 }}>{r.t50 ? r.t50.games : '—'}</td>
                  <td style={{ textAlign: 'right', opacity: 0.7, color: 'var(--gisplus)' }}>{r.t50 ? fmt(r.t50.gisPlus) : '—'}</td>
                  <td style={{ textAlign: 'right', opacity: 0.7 }}>
                    {r.t50 && Number.isFinite(r.t50.pGIS) ? fmt(r.t50.pGIS, 1) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {index && visible.length === 0 && !buildingIndex && (
        <div className="gb-empty">
          No players match the current filters.
        </div>
      )}
      </main>
    </>
  );
}
