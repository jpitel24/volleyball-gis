import { Fragment, useEffect, useMemo, useState } from 'react';
import { useData } from '../lib/DataContext.jsx';
import { loadPlayerIndex } from '../lib/playerIndex.js';
import { posColor, pgisLabel } from '../lib/gis.js';

const TOP_N_DEFAULT = 20;
const MAX_RESULTS   = 50;

function fmt(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(d);
}

function PGISChip({ v }) {
  if (v == null) return <span className="pb-chip">pGIS —</span>;
  const [, cls] = pgisLabel(v);
  return <span className={`pb-chip pgis-${cls}`}>pGIS {v.toFixed(1)}</span>;
}

function StatCells({ t }) {
  // Compact stat cells for a season/game row: K / A / D / B / SA.
  const blocks = (t.block_solos || 0) + (t.block_assists || 0);
  return (
    <>
      <td style={{ textAlign: 'right' }}>{t.kills || 0}</td>
      <td style={{ textAlign: 'right' }}>{t.assists || 0}</td>
      <td style={{ textAlign: 'right' }}>{t.digs || 0}</td>
      <td style={{ textAlign: 'right' }}>{blocks}</td>
      <td style={{ textAlign: 'right' }}>{t.service_aces || 0}</td>
    </>
  );
}

function GameLog({ season, playerKey, onGameClick }) {
  if (!season.gameLog.length) {
    return <div className="pb-log-empty">No games recorded for this season.</div>;
  }
  return (
    <div className="pb-log-wrap">
      <table className="pb-log-table" style={{ width: '100%', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.65rem' }}>
        <thead>
          <tr style={{ color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <th className="text-left">Date</th>
            <th className="text-left pb-log-opp">Opponent</th>
            <th style={{ textAlign: 'right' }}>S</th>
            <th style={{ textAlign: 'right' }}>K</th>
            <th style={{ textAlign: 'right' }}>A</th>
            <th style={{ textAlign: 'right' }}>D</th>
            <th style={{ textAlign: 'right' }}>B</th>
            <th style={{ textAlign: 'right' }}>SA</th>
            <th style={{ textAlign: 'right' }}>GIS+</th>
            <th style={{ textAlign: 'right' }}>pGIS</th>
          </tr>
        </thead>
        <tbody>
          {season.gameLog.map(g => {
            const clickable = !!onGameClick;
            return (
              <tr
                key={g.gameKey + '_' + g.date}
                onClick={clickable ? () => onGameClick(season.year, g.gameKey) : undefined}
                style={{ cursor: clickable ? 'pointer' : 'default' }}
              >
                <td className="text-left">{g.date}</td>
                <td className="text-left pb-log-opp">
                  {g.location === 'Away' ? '@ ' : g.location === 'Neutral' ? 'vs ' : 'vs '}
                  {g.opponent}
                </td>
                <td style={{ textAlign: 'right' }}>{g.sets}</td>
                <StatCells t={g.totals} />
                <td style={{ textAlign: 'right', color: 'var(--gisplus)' }}>{fmt(g.gisPlus)}</td>
                <td style={{ textAlign: 'right', color: 'var(--pgis)' }}>{fmt(g.pGIS, 1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PlayerCard({ player, expanded, onToggle, expandedSeason, onToggleSeason, onGameClick }) {
  const c = player.career;
  return (
    <div className="pb-card">
      <div
        className="pb-card-header"
        onClick={onToggle}
        style={{ cursor: 'pointer', borderLeftColor: posColor(player.position) }}
      >
        <span className="pb-pos" style={{ color: posColor(player.position), borderColor: posColor(player.position) + '50' }}>
          {player.position}
        </span>
        <span className="pb-name">{player.name}</span>
        <span className="pb-team" style={{ marginLeft: '0.5rem' }}>
          {player.teams.slice(0, 3).join(' · ')}
        </span>
        <div className="pb-career-chips">
          <span className="pb-chip">{c.games} G · {c.sets} S</span>
          <span className="pb-chip">GIS {fmt(c.gis)}</span>
          <span className="pb-chip" style={{ color: 'var(--gisplus)' }}>GIS+ {fmt(c.gisPlus)}</span>
          <PGISChip v={c.pGIS} />
          <span className="pb-expand-btn">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded && (
        <div className="pb-table-wrap">
          <table className="pb-season-table" style={{ width: '100%', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.72rem' }}>
            <thead>
              <tr style={{ color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <th className="text-left">Year</th>
                <th className="text-left">Team</th>
                <th className="text-left">Pos</th>
                <th style={{ textAlign: 'right' }}>G</th>
                <th style={{ textAlign: 'right' }}>S</th>
                <th style={{ textAlign: 'right' }}>K</th>
                <th style={{ textAlign: 'right' }}>A</th>
                <th style={{ textAlign: 'right' }}>D</th>
                <th style={{ textAlign: 'right' }}>B</th>
                <th style={{ textAlign: 'right' }}>SA</th>
                <th style={{ textAlign: 'right' }}>GIS</th>
                <th style={{ textAlign: 'right' }}>GIS+</th>
                <th style={{ textAlign: 'right' }}>pGIS</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {player.seasons.map(s => {
                const open = expandedSeason && expandedSeason.playerKey === player.key && expandedSeason.year === s.year;
                return (
                  <Fragment key={s.year}>
                    <tr
                      onClick={() => onToggleSeason(player.key, s.year)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="pb-yr">{s.year}</td>
                      <td className="pb-team">{s.team}</td>
                      <td>{s.position}</td>
                      <td style={{ textAlign: 'right' }}>{s.games}</td>
                      <td style={{ textAlign: 'right' }}>{s.sets}</td>
                      <StatCells t={s.totals} />
                      <td style={{ textAlign: 'right' }}>{fmt(s.gis)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--gisplus)' }}>{fmt(s.gisPlus)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--pgis)' }}>{fmt(s.pGIS, 1)}</td>
                      <td className="pb-expand-btn">{open ? '▾' : '▸'}</td>
                    </tr>
                    {open && (
                      <tr className="pb-log-row">
                        <td colSpan={14}>
                          <GameLog season={s} playerKey={player.key} onGameClick={onGameClick} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PlayerLookup({ onGameDeepLink }) {
  const { pgisTables, loading } = useData();
  const [index, setIndex]               = useState(null);
  const [indexErr, setIndexErr]         = useState(null);
  const [buildingIndex, setBuilding]    = useState(false);
  const [search, setSearch]             = useState('');
  const [expandedPlayer, setExpanded]   = useState(null);
  const [expandedSeason, setExpandedS]  = useState(null);

  useEffect(() => {
    if (loading || !pgisTables) return;
    let cancelled = false;
    setBuilding(true);
    loadPlayerIndex(pgisTables)
      .then(idx => { if (!cancelled) { setIndex(idx); setBuilding(false); } })
      .catch(err => { if (!cancelled) { setIndexErr(err?.message || String(err)); setBuilding(false); } });
    return () => { cancelled = true; };
  }, [loading, pgisTables]);

  const filtered = useMemo(() => {
    if (!index) return [];
    const q = search.trim().toLowerCase();
    if (!q) return index.players.slice(0, TOP_N_DEFAULT);
    const hits = index.players.filter(p => p.name.toLowerCase().includes(q));
    return hits.slice(0, MAX_RESULTS);
  }, [index, search]);

  const totalHits = useMemo(() => {
    if (!index) return 0;
    const q = search.trim().toLowerCase();
    if (!q) return index.players.length;
    return index.players.filter(p => p.name.toLowerCase().includes(q)).length;
  }, [index, search]);

  function togglePlayer(key) {
    setExpanded(prev => prev === key ? null : key);
    setExpandedS(null);
  }
  function toggleSeason(playerKey, year) {
    setExpandedS(prev =>
      (prev && prev.playerKey === playerKey && prev.year === year)
        ? null
        : { playerKey, year }
    );
  }

  return (
    <>
      <div className="hero">
        <div className="hero-eyebrow">NCAA D1 Women's Volleyball</div>
        <div className="hero-title">Player Browser</div>
        <div className="hero-sub">
          Search any D1 player from 2022–2025. Click a name to see per-season
          totals; click a season to see every game that year.
        </div>
      </div>

      <div className="gb-controls">
        <input
          className="pb-search"
          placeholder="Filter by player name…"
          value={search}
          onChange={e => { setSearch(e.target.value); setExpanded(null); setExpandedS(null); }}
          disabled={buildingIndex || !index}
        />
      </div>

      <div className="gb-status">
        {loading && <><div className="spinner" /> Loading baselines…</>}
        {!loading && buildingIndex && <><div className="spinner" /> Building player index…</>}
        {indexErr && <span style={{ color: '#f43f5e' }}>Error: {indexErr}</span>}
        {index && !search.trim() && (
          <>Showing top {Math.min(TOP_N_DEFAULT, index.players.length)} of {index.players.length.toLocaleString()} players (by career GIS+) — search to find more</>
        )}
        {index && search.trim() && (
          <>
            {totalHits.toLocaleString()} player{totalHits === 1 ? '' : 's'} match "{search.trim()}"
            {totalHits > MAX_RESULTS && ` — showing top ${MAX_RESULTS}`}
          </>
        )}
      </div>

      {index && filtered.length > 0 && (
        <div className="pb-list">
          {filtered.map(p => (
            <PlayerCard
              key={p.key}
              player={p}
              expanded={expandedPlayer === p.key}
              onToggle={() => togglePlayer(p.key)}
              expandedSeason={expandedSeason}
              onToggleSeason={toggleSeason}
              onGameClick={onGameDeepLink}
            />
          ))}
        </div>
      )}

      {index && filtered.length === 0 && (
        <div className="gb-empty">
          No players found matching "{search}".
        </div>
      )}
    </>
  );
}
