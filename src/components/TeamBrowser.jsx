import { useState, useMemo } from 'react';
import { useData } from '../lib/DataContext.jsx';
import {
  POS_COLORS_SB,
  computeArchivePGIS,
  findRPIValue,
  rpiToRank,
} from '../lib/gis.js';

// Fake game IDs that map to the right season via seasonFromGameId
const SEASON_FAKE_ID = {
  '2025': '6479200',
  '2024': '6326200',
  '2023': '6173900',
  '2022': '6026000',
  '2021': '5874000',
};

function RosterTable({ players, gameLogs, season }) {
  return (
    <div className="tb-roster-wrap">
      <div className="tb-section-label">Roster</div>
      <table className="sb-table pb-log-table">
        <thead>
          <tr>
            <th className="text-left">Player</th>
            <th>Pos</th>
            <th>G</th>
            <th title="Qualifying games vs top-100">Qg</th>
            <th>pGIS</th>
            <th>GIS+/S</th>
            <th>K</th>
            <th>E</th>
            <th>HIT%</th>
            <th>A</th>
            <th>D</th>
            <th>SA</th>
          </tr>
        </thead>
        <tbody>
          {players.map((p, i) => {
            const pc  = POS_COLORS_SB[p.pos] || '#94a3b8';
            const hit = p.total_attacks > 0
              ? ((p.kills - p.errors) / p.total_attacks).toFixed(3)
              : '—';
            return (
              <tr key={i}>
                <td className="text-left" style={{ fontWeight: 600 }}>{p.player}</td>
                <td>
                  <span style={{
                    background: `${pc}20`, color: pc, borderColor: `${pc}40`,
                    border: '1px solid', borderRadius: 3,
                    padding: '0 0.3rem', fontSize: '0.62rem', fontWeight: 700,
                  }}>{p.pos}</span>
                </td>
                <td>{p.games}</td>
                <td style={{ color: 'var(--muted)' }}>{p.qual_games || 0}</td>
                <td className="sb-pgis-val">{p._pGIS?.toFixed(2) ?? '—'}</td>
                <td className="sb-gisplus-val">{p.gis_plus_per_set?.toFixed(3) ?? '—'}</td>
                <td>{p.kills || 0}</td>
                <td>{p.errors || 0}</td>
                <td>{hit}</td>
                <td>{p.assists || 0}</td>
                <td>{p.digs || 0}</td>
                <td>{p.service_aces || 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="tb-section-label" style={{ marginTop: '1rem' }}>Top Individual Games</div>
      <div className="tb-placeholder">
        Game log data not yet available.
      </div>
    </div>
  );
}

function TeamRow({ row, gameLogs }) {
  const [open, setOpen] = useState(false);

  const confStr  = row.conf || '—';
  const rpiStr   = row.rpiRank ? `#${row.rpiRank}` : '—';

  return (
    <>
      <tr className="tb-team-row">
        <td>
          <button className="pb-expand-btn" onClick={() => setOpen(o => !o)}>
            {open ? '▼' : '▶'}
          </button>
        </td>
        <td className="text-left" style={{ fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif", fontSize: '1rem' }}>
          {row.team}
        </td>
        <td style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{confStr}</td>
        <td>{rpiStr}</td>
        <td style={{ color: 'var(--muted)' }}>{row.players.length}</td>
        <td className="sb-pgis-val">{row.rotPGIS?.toFixed(2) ?? '—'}</td>
        <td className="sb-gisplus-val">{row.gipsSet?.toFixed(3) ?? '—'}</td>
        {row.showSeason && <td style={{ color: 'var(--accent)', fontWeight: 700 }}>{row.season}</td>}
      </tr>
      {open && (
        <tr>
          <td colSpan={row.showSeason ? 8 : 7} style={{ padding: 0, background: 'var(--bg)' }}>
            <RosterTable players={row.players} gameLogs={gameLogs} season={row.season} />
          </td>
        </tr>
      )}
    </>
  );
}

const SORT_KEYS = ['rotPGIS', 'gipsSet', 'rpiRank', 'team', 'conf'];

export default function TeamBrowser() {
  const { playerArchive, pgisTables, gameLogs, rpiByYear, loading, error } = useData();

  const [tab, setTab]         = useState('2025');
  const [confFilter, setConf] = useState('ALL');
  const [search, setSearch]   = useState('');
  const [sortKey, setSortKey] = useState('rotPGIS');
  const [sortDir, setSortDir] = useState('desc');

  // Build (team, season) → players map with pGIS computed
  const teamIndex = useMemo(() => {
    if (!playerArchive) return new Map();
    const map = new Map();
    for (const [season, records] of Object.entries(playerArchive.seasons || {})) {
      for (const r of records) {
        const key = `${r.team}||${season}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ ...r, _pGIS: computeArchivePGIS(r, pgisTables) });
      }
    }
    return map;
  }, [playerArchive, pgisTables]);

  // All available seasons descending
  const seasons = useMemo(() => {
    if (!playerArchive) return ['2025'];
    return Object.keys(playerArchive.seasons || {}).sort((a, b) => b - a);
  }, [playerArchive]);

  // All conferences for the current tab
  const allConfs = useMemo(() => {
    const set = new Set();
    for (const [key, players] of teamIndex) {
      const [, season] = key.split('||');
      if (tab === 'all' || season === tab) {
        const c = players[0]?.conf;
        if (c) set.add(c);
      }
    }
    return ['ALL', ...Array.from(set).sort()];
  }, [teamIndex, tab]);

  // Build flat team rows
  const teamRows = useMemo(() => {
    const rows = [];
    for (const [key, players] of teamIndex) {
      const [team, season] = key.split('||');
      if (tab !== 'all' && season !== tab) continue;

      const conf = players[0]?.conf || '';
      if (confFilter !== 'ALL' && conf !== confFilter) continue;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!team.toLowerCase().includes(q) && !conf.toLowerCase().includes(q)) continue;
      }

      const sorted   = [...players].sort((a, b) => (b._pGIS ?? 0) - (a._pGIS ?? 0));
      const top7     = sorted.slice(0, 7).filter(p => p._pGIS != null);
      const rotPGIS  = top7.length
        ? top7.reduce((s, p) => s + p._pGIS, 0) / top7.length
        : null;
      const totalGIP = players.reduce((s, p) => s + (p.gis_plus_total || 0), 0);
      const totalSets= players.reduce((s, p) => s + (p.sets || 0), 0);
      const gipsSet  = totalSets > 0 ? totalGIP / totalSets : null;

      const fakeId   = SEASON_FAKE_ID[season] || '6200001';
      const rpiVal   = findRPIValue(team, team, fakeId, rpiByYear);
      const rpiRank  = rpiToRank(rpiVal, season, rpiByYear);

      rows.push({
        key, team, season, conf,
        players: sorted,
        rotPGIS, gipsSet, rpiRank,
        showSeason: tab === 'all',
      });
    }

    return rows.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      // For text fields sort alphabetically; nulls last
      if (sortKey === 'team' || sortKey === 'conf') {
        av = av ?? '';
        bv = bv ?? '';
        return sortDir === 'asc'
          ? av.localeCompare(bv)
          : bv.localeCompare(av);
      }
      // For rpiRank, lower = better, so 'desc' means ascending numerically
      if (sortKey === 'rpiRank') {
        av = av ?? 9999;
        bv = bv ?? 9999;
        return sortDir === 'desc' ? av - bv : bv - av;
      }
      av = av ?? -Infinity;
      bv = bv ?? -Infinity;
      return sortDir === 'desc' ? bv - av : av - bv;
    });
  }, [teamIndex, tab, confFilter, search, sortKey, sortDir, rpiByYear]);

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      // RPI rank: lower is better, so default to ascending
      setSortDir(key === 'rpiRank' ? 'asc' : 'desc');
    }
  }

  const showSeason = tab === 'all';

  if (loading) return <div className="data-loading"><div className="spinner" /> Loading team data…</div>;
  if (error)   return <div className="data-loading" style={{ color: 'var(--red)' }}>Failed to load data: {error}</div>;

  return (
    <div className="season-panel">
      <div className="sb-controls">
        <div className="sb-view-tabs">
          {seasons.map(s => (
            <button
              key={s}
              className={`sb-view-btn ${tab === s ? 'active' : ''}`}
              onClick={() => setTab(s)}
            >{s}</button>
          ))}
          <button
            className={`sb-view-btn ${tab === 'all' ? 'active' : ''}`}
            onClick={() => setTab('all')}
          >All Seasons</button>
        </div>

        <select
          className="sb-select"
          value={confFilter}
          onChange={e => setConf(e.target.value)}
        >
          {allConfs.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <input
          className="pb-search"
          placeholder="Search team or conference…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="sb-count">{teamRows.length} team{teamRows.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="sb-table-wrap">
        <table className="sb-table">
          <thead>
            <tr>
              <th style={{ width: 24 }} />
              <th
                className={`text-left ${sortKey === 'team' ? `sort-${sortDir}` : ''}`}
                onClick={() => handleSort('team')}
              >Team</th>
              <th
                className={sortKey === 'conf' ? `sort-${sortDir}` : ''}
                onClick={() => handleSort('conf')}
              >Conf</th>
              <th
                className={sortKey === 'rpiRank' ? `sort-${sortDir}` : ''}
                onClick={() => handleSort('rpiRank')}
                title="RPI rank for this season"
              >RPI</th>
              <th title="Players with recorded stats">Plyrs</th>
              <th
                className={`sb-pgis-val ${sortKey === 'rotPGIS' ? `sort-${sortDir}` : ''}`}
                onClick={() => handleSort('rotPGIS')}
                title="Average pGIS of top-7 players (starting rotation proxy)"
              >Rot. pGIS</th>
              <th
                className={`sb-gisplus-val ${sortKey === 'gipsSet' ? `sort-${sortDir}` : ''}`}
                onClick={() => handleSort('gipsSet')}
                title="Team GIS+ per set (sum of all player GIS+ totals / total sets)"
              >GIS+/S</th>
              {showSeason && <th>Yr</th>}
            </tr>
          </thead>
          <tbody>
            {teamRows.map(row => (
              <TeamRow key={row.key} row={row} gameLogs={gameLogs} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
