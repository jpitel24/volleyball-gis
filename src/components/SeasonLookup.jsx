import { useEffect, useMemo, useState } from 'react';
import { useData } from '../lib/DataContext.jsx';
import { loadPlayerIndex } from '../lib/playerIndex.js';
import { posColor, pgisLabel, posGroup } from '../lib/gis.js';

const MAX_RESULTS = 100;

const YEAR_FILTERS = [
  { id: 'ALL',  label: 'All-Time' },
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
  { id: 'gisPlus',   label: 'GIS+' },
  { id: 'pGIS',      label: 'pGIS' },
  { id: 't50GisPlus', label: 'T50 GIS+' },
  { id: 't50PGis',    label: 'T50 pGIS' },
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
        playerKey: p.key,
        name:      p.name,
        team:      s.team || p.team,
        position:  s.position || p.position,
        year:      s.year,
        games:     s.games,
        sets:      s.sets,
        teamGames: s.teamGames,
        totals:    s.totals,
        gis:       s.gis,
        gisPlus:   s.gisPlus,
        pGIS:      s.pGIS,
        t50:       s.t50,
      });
    }
  }
  return rows;
}

export default function SeasonLookup() {
  const { pgisTables, rpiByYear, loading } = useData();
  const [index, setIndex]            = useState(null);
  const [indexErr, setIndexErr]      = useState(null);
  const [buildingIndex, setBuilding] = useState(false);

  const [year, setYear]           = useState('2025');
  const [posFilter, setPosFilter] = useState('ALL');
  const [minT50, setMinT50]       = useState(0);
  const [sortBy, setSortBy]       = useState('gisPlus');

  useEffect(() => {
    if (loading || !pgisTables) return;
    let cancelled = false;
    setBuilding(true);
    loadPlayerIndex(pgisTables, rpiByYear)
      .then(idx => { if (!cancelled) { setIndex(idx); setBuilding(false); } })
      .catch(err => { if (!cancelled) { setIndexErr(err?.message || String(err)); setBuilding(false); } });
    return () => { cancelled = true; };
  }, [loading, pgisTables, rpiByYear]);

  const allRows = useMemo(() => {
    if (!index) return [];
    return buildRows(index.players, year);
  }, [index, year]);

  const filtered = useMemo(() => {
    const rows = allRows.filter(r => {
      if (posFilter !== 'ALL' && posGroup(r.position) !== posFilter) return false;
      if (minT50 > 0) {
        const g = r.t50?.games || 0;
        if (g < minT50) return false;
      }
      return true;
    });
    const get = (r) => {
      if (sortBy === 'gisPlus')     return r.gisPlus || 0;
      if (sortBy === 'pGIS')        return r.pGIS    || 0;
      if (sortBy === 't50GisPlus')  return r.t50?.gisPlus ?? -Infinity;
      if (sortBy === 't50PGis')     return r.t50?.pGIS    ?? -Infinity;
      return 0;
    };
    rows.sort((a, b) => get(b) - get(a));
    return rows;
  }, [allRows, posFilter, minT50, sortBy]);

  const visible  = filtered.slice(0, MAX_RESULTS);
  const totalHits = filtered.length;

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
            {minT50 > 0 && ` · ${minT50}+ T50 G`}
            {totalHits > MAX_RESULTS && ` — showing top ${MAX_RESULTS}`}
          </>
        )}
      </div>

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
