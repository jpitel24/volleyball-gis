import { useState, useMemo } from 'react';
import { useData } from '../lib/DataContext.jsx';
import { POS_COLORS_SB } from '../lib/gis.js';

function GameLogRow({ g }) {
  const [gid, opp, ms, gp, pgis, qual, k, e, ta, a, d, sa] = g;
  const hit = ta > 0 ? ((k-e)/ta).toFixed(3) : '—';
  return (
    <tr>
      <td className="pb-log-gid">
        <a href={`https://www.ncaa.com/game/${gid}`} target="_blank" rel="noreferrer"
           style={{color:'var(--muted)',fontSize:'0.6rem'}}>{gid}</a>
      </td>
      <td className="pb-log-opp">
        {qual
          ? <span className="pb-qual-dot" title="Counts toward pGIS">●</span>
          : <span className="pb-qual-dot-off" title="Below quality threshold">○</span>
        }
        {' '}{opp}
      </td>
      <td>{ms}S</td>
      <td className="sb-gisplus-val">{gp}</td>
      <td className={pgis >= 8.5 ? 'sb-pgis-val' : ''}>{pgis ?? '—'}</td>
      <td>{k}</td><td>{e}</td><td>{hit}</td>
      <td>{a}</td><td>{d}</td><td>{sa}</td>
    </tr>
  );
}

function SeasonRow({ record, cardId, gameLogs }) {
  const [open, setOpen] = useState(false);
  const key = `${record.player.toLowerCase()}||${record.team.toLowerCase()}||${record.season}`;
  const games = gameLogs?.[key] || [];
  const rHit = record.total_attacks > 0
    ? ((record.kills - record.errors) / record.total_attacks).toFixed(3)
    : '—';
  const qPgis = record.avg_pgis ? record.avg_pgis.toFixed(2) : '—';

  return (
    <>
      <tr className="pb-season-row">
        <td>
          <button className="pb-expand-btn" onClick={() => setOpen(o => !o)}>
            {open ? '▼' : '▶'}
          </button>
        </td>
        <td className="pb-yr">{record.season}</td>
        <td className="pb-team">{record.team}</td>
        <td>{record.games}</td>
        <td>{record.qual_games || 0}</td>
        <td className="sb-pgis-val" title="pGIS across all full-match games">
          {record.avg_pgis_all?.toFixed(2) ?? '—'}
        </td>
        <td className="sb-pgis-val" title="pGIS vs top-100 opponents only (≥8 games)">
          {qPgis}
        </td>
        <td className="sb-gisplus-val">{record.gis_plus_per_set?.toFixed(3) ?? '—'}</td>
        <td>{record.kills || 0}</td>
        <td>{record.errors || 0}</td>
        <td>{rHit}</td>
        <td>{record.assists || 0}</td>
        <td>{record.digs || 0}</td>
        <td>{record.service_aces || 0}</td>
        <td>{record.reception_errors || 0}</td>
      </tr>
      {open && (
        <tr className="pb-log-row">
          <td colSpan="15">
            <div className="pb-log-wrap">
              {!games.length
                ? <div className="pb-log-empty">No qualifying game data available.</div>
                : (
                  <table className="sb-table pb-log-table">
                    <thead>
                      <tr>
                        <th className="text-left">Game</th>
                        <th className="text-left">Opponent</th>
                        <th>Sets</th><th>GIS+</th><th>pGIS</th>
                        <th>K</th><th>E</th><th>HIT%</th><th>A</th><th>D</th><th>SA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {games.map((g, i) => <GameLogRow key={i} g={g} />)}
                    </tbody>
                  </table>
                )
              }
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function PlayerCard({ norm, records, gameLogs }) {
  const canon = records[0].player;
  const pos   = records[0].pos;
  const pc    = POS_COLORS_SB[pos] || '#94a3b8';

  let totalGames=0, totalSets=0, totalGisPlus=0;
  let totalK=0, totalE=0, totalTA=0, totalA=0, totalD=0, totalSA=0, totalRE=0;
  let allPgis = [];
  for (const r of records) {
    totalGames   += r.games;
    totalSets    += r.sets;
    totalGisPlus += r.gis_plus_total || 0;
    totalK  += r.kills||0; totalE  += r.errors||0;  totalTA += r.total_attacks||0;
    totalA  += r.assists||0; totalD += r.digs||0;
    totalSA += r.service_aces||0; totalRE += r.reception_errors||0;
    if (r.avg_pgis) allPgis.push(r.avg_pgis);
  }
  const careerHit = totalTA > 0 ? ((totalK-totalE)/totalTA).toFixed(3) : '—';
  const careerGPS = totalSets > 0 ? (totalGisPlus/totalSets).toFixed(3) : '—';
  const bestPgis  = allPgis.length ? Math.max(...allPgis).toFixed(2) : '—';

  return (
    <div className="pb-card">
      <div className="pb-card-header" style={{ borderLeftColor: pc }}>
        <span className="pb-pos" style={{ background:`${pc}20`, color:pc, borderColor:`${pc}40` }}>{pos}</span>
        <span className="pb-name">{canon}</span>
        <div className="pb-career-chips">
          <span className="pb-chip">Best pGIS <strong className="sb-pgis-val">{bestPgis}</strong></span>
          <span className="pb-chip">GIS+/S <strong className="sb-gisplus-val">{careerGPS}</strong></span>
          <span className="pb-chip">Career HIT% <strong>{careerHit}</strong></span>
          <span className="pb-chip">{totalGames}G / {totalSets}S</span>
        </div>
      </div>
      <div className="pb-table-wrap">
        <table className="sb-table pb-season-table">
          <thead>
            <tr>
              <th style={{width:24}}></th>
              <th className="text-left">Year</th>
              <th className="text-left">Team</th>
              <th>G</th>
              <th title="Qualifying games (opp top-100)">Qg</th>
              <th title="pGIS across all full-match games">pGIS all</th>
              <th title="pGIS vs top-100 opponents only">pGIS q100</th>
              <th>GIS+/S</th>
              <th>K</th><th>E</th><th>HIT%</th>
              <th>A</th><th>D</th><th>SA</th><th>RE</th>
            </tr>
          </thead>
          <tbody>
            {records.map(r => (
              <SeasonRow
                key={`${r.player}-${r.team}-${r.season}`}
                record={r}
                cardId={norm.replace(/[^a-z0-9]/g,'_')}
                gameLogs={gameLogs}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PlayerBrowser() {
  const { playerArchive, gameLogs, loading, error } = useData();
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    if (!playerArchive || query.length < 2) return null;
    const q = query.toLowerCase();
    const matched = new Map();
    for (const [season, records] of Object.entries(playerArchive.seasons || {})) {
      for (const r of records) {
        if (r.player.toLowerCase().includes(q)) {
          const norm = r.player.toLowerCase();
          if (!matched.has(norm)) matched.set(norm, []);
          matched.get(norm).push(r);
        }
      }
    }
    return [...matched.entries()]
      .map(([norm, records]) => ({ norm, records: records.sort((a,b) => b.season - a.season) }))
      .sort((a, b) => {
        const aB = Math.max(...a.records.map(r => r.avg_pgis || 0));
        const bB = Math.max(...b.records.map(r => r.avg_pgis || 0));
        return bB - aB;
      });
  }, [playerArchive, query]);

  if (loading) return <div className="data-loading"><div className="spinner" /> Loading player data…</div>;
  if (error)   return <div className="data-loading" style={{color:'var(--red)'}}>Failed to load data: {error}</div>;

  return (
    <div className="season-panel">
      <div className="sb-controls">
        <input
          className="pb-search"
          placeholder="Search by player name…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
        <span className="sb-count">
          {results === null ? '' : results.length ? `${results.length} player${results.length>1?'s':''} found` : ''}
        </span>
      </div>

      {results === null && (
        <div className="pb-hint">Type at least 2 characters to search</div>
      )}
      {results !== null && results.length === 0 && (
        <div className="pb-hint">No players found</div>
      )}
      {results !== null && results.map(p => (
        <PlayerCard key={p.norm} norm={p.norm} records={p.records} gameLogs={gameLogs} />
      ))}
    </div>
  );
}
