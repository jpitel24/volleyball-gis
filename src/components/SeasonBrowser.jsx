import { useState, useMemo } from 'react';
import { useData } from '../lib/DataContext.jsx';
import { POS_COLORS_SB } from '../lib/gis.js';

const POSITIONS = ['ALL', 'OH', 'MB', 'OPP', 'S', 'L', 'DS'];

const COLS_SEASON = [
  { key: '#',              label: '#',       nosort: true, fmt: (r,i) => <td key="#" className="sb-rank">{i+1}</td> },
  { key: 'player',         label: 'Player',  left: true,   fmt: r => <td key="player" className="sb-name">{r.player}</td> },
  { key: 'team',           label: 'Team',    left: true,   fmt: r => <td key="team" className="sb-team">{r.team}</td> },
  { key: 'season',         label: 'Yr',                    fmt: r => <td key="season">{r.season}</td>, hideInSeason: true },
  { key: 'pos',            label: 'Pos',                   fmt: r => <td key="pos" style={{color:'var(--accent)'}}>{r.pos}</td>, hideIfPos: true },
  { key: 'games',          label: 'G',                     fmt: r => <td key="games">{r.games}</td> },
  { key: 'qual_games',     label: 'Qg',                    fmt: r => <td key="qg" style={{color:'var(--muted)'}}>{r.qual_games}</td> },
  { key: 'avg_pgis',       label: 'pGIS',                  fmt: r => <td key="pgis" className="sb-pgis-val">{r.avg_pgis?.toFixed(2)??'—'}</td> },
  { key: 'gis_plus_per_set', label: 'GIS+/S',              fmt: r => <td key="gps" className="sb-gisplus-val">{r.gis_plus_per_set?.toFixed(3)??'—'}</td> },
  { key: 'gis_per_set',    label: 'GIS/S',                 fmt: r => <td key="gis">{r.gis_per_set?.toFixed(3)??'—'}</td> },
  { key: 'gis_plus_total', label: 'GIS+',                  fmt: r => <td key="gpt" className="sb-gisplus-val">{r.gis_plus_total?.toFixed(1)??'—'}</td> },
  { key: 'kills',          label: 'K',                     fmt: r => <td key="k">{r.kills}</td> },
  { key: 'errors',         label: 'E',                     fmt: r => <td key="e">{r.errors}</td> },
  { key: 'hit_pct',        label: 'HIT%',                  fmt: r => <td key="hit">{r.hit_pct?.toFixed(3)??'—'}</td> },
  { key: 'assists',        label: 'A',                     fmt: r => <td key="a">{r.assists}</td> },
  { key: 'digs',           label: 'D',                     fmt: r => <td key="d">{r.digs}</td> },
  { key: 'service_aces',   label: 'SA',                    fmt: r => <td key="sa">{r.service_aces}</td> },
  { key: 'reception_errors', label: 'RE',                  fmt: r => <td key="re">{r.reception_errors}</td> },
];

export default function SeasonBrowser() {
  const { playerArchive, loading, error } = useData();
  const [tab, setTab]       = useState('season'); // 'season' | 'all'
  const [season, setSeason] = useState('2025');
  const [pos, setPos]       = useState('ALL');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey]     = useState('avg_pgis');
  const [sortDir, setSortDir]     = useState('desc');

  const seasons = useMemo(() => {
    if (!playerArchive) return ['2025'];
    return Object.keys(playerArchive.seasons || {}).sort((a,b) => b-a);
  }, [playerArchive]);

  const rows = useMemo(() => {
    if (!playerArchive) return [];
    const all = [];
    if (tab === 'season') {
      for (const r of (playerArchive.seasons?.[season] || [])) all.push(r);
    } else {
      for (const [s, records] of Object.entries(playerArchive.seasons || {})) {
        for (const r of records) all.push({ ...r, season: parseInt(s) });
      }
    }
    return all;
  }, [playerArchive, tab, season]);

  const filtered = useMemo(() => {
    let out = rows;
    if (pos !== 'ALL') out = out.filter(r => r.pos === pos);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(r => r.player.toLowerCase().includes(q) || r.team.toLowerCase().includes(q));
    }
    return [...out].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return sortDir === 'desc' ? bv - av : av - bv;
    });
  }, [rows, pos, search, sortKey, sortDir]);

  function handleSort(key) {
    if (key === '#' || key === 'player' || key === 'team') return;
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  const visibleCols = COLS_SEASON.filter(c => {
    if (c.hideInSeason && tab === 'season') return false;
    if (c.hideIfPos && pos !== 'ALL') return false;
    return true;
  });

  if (loading) return <div className="data-loading"><div className="spinner" /> Loading season data…</div>;
  if (error)   return <div className="data-loading" style={{color:'var(--red)'}}>Failed to load data: {error}</div>;

  return (
    <div className="season-panel">
      <div className="sb-controls">
        <div className="sb-view-tabs">
          <button className={`sb-view-btn ${tab==='season'?'active':''}`} onClick={() => setTab('season')}>By Season</button>
          <button className={`sb-view-btn ${tab==='all'?'active':''}`} onClick={() => setTab('all')}>All Seasons</button>
        </div>
        {tab === 'season' && (
          <select className="sb-select" value={season} onChange={e => setSeason(e.target.value)}>
            {seasons.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <div className="sb-pos-tabs">
          {POSITIONS.map(p => (
            <button key={p} className={`sb-pos-btn ${pos===p?'active':''}`} onClick={() => setPos(p)}>
              {p !== 'ALL' && (
                <span className="sb-pos-dot" style={{ background: POS_COLORS_SB[p] || '#94a3b8' }} />
              )}
              {p}
            </button>
          ))}
        </div>
        <input
          className="sb-search"
          placeholder="Search player or team…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="sb-count">{filtered.length} players</span>
      </div>

      <div className="sb-table-wrap">
        <table className="sb-table">
          <thead>
            <tr>
              {visibleCols.map(c => (
                <th
                  key={c.key}
                  className={`${c.left ? 'text-left' : ''} ${sortKey===c.key ? `sort-${sortDir}` : ''}`}
                  onClick={() => handleSort(c.key)}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.player}-${r.team}-${r.season}`}>
                {visibleCols.map(c => c.fmt(r, i))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
