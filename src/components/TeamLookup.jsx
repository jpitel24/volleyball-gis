import { useEffect, useMemo, useState } from 'react';
import { useData } from '../lib/DataContext.jsx';
import { loadPlayerIndex, isP4 } from '../lib/playerIndex.js';
import { posColor, pgisLabel, posGroup, COL_TIPS } from '../lib/gis.js';

const MAX_RESULTS = 20;
const YEAR_OPTIONS = [2026, 2025, 2024, 2023, 2022];

function fmt(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(d);
}

function PGISChip({ v }) {
  if (v == null || !Number.isFinite(v)) return <span className="pb-chip">pGIS —</span>;
  const [, cls] = pgisLabel(v);
  return <span className={`pb-chip pgis-${cls}`}>pGIS {v.toFixed(1)}</span>;
}

// Aggregate the player index into one record per (year, team).
//
//   players[]   → every player-season for that team (sorted by GIS+/G desc)
//   games       → unique match count (union of every player's gameKeys)
//   t50Games    → matches against RPI Top-50 opponents
//   sets        → total team-sets (max S per match, summed)
//   gisPlus     → starter-weighted mean GIS+/G (games-weighted across players)
//   pGIS        → same — games-weighted mean of per-player season pGIS
function buildTeamIndex(players) {
  const byKey = new Map();

  for (const p of players) {
    for (const s of p.seasons) {
      if (!s.team || !s.games) continue;
      const key = `${s.year}||${s.team}`;
      let t = byKey.get(key);
      if (!t) {
        t = {
          key,
          year:      s.year,
          team:      s.team,
          players:   [],
          gameKeys:  new Set(),
          t50Keys:   new Set(),
          matchSets: {}, // gameKey → max sets (team match length)
        };
        byKey.set(key, t);
      }
      t.players.push({
        key:      p.key,
        name:     p.name,
        position: s.position || p.position,
        conference: s.conference || '',
        games:    s.games,
        sets:     s.sets,
        gis:      s.gis,
        gisPlus:  s.gisPlus,
        pGIS:     s.pGIS,
        t50:      s.t50,
        posRank:            s.posRank,
        posRankTotal:       s.posRankTotal,
        posRankTier:        s.posRankTier,
        posRankTierTotal:   s.posRankTierTotal,
        posRankConf:        s.posRankConf,
        posRankConfTotal:   s.posRankConfTotal,
      });
      for (const g of s.gameLog || []) {
        t.gameKeys.add(g.gameKey);
        if (g.vsTop50) t.t50Keys.add(g.gameKey);
        const cur = t.matchSets[g.gameKey] || 0;
        if (g.sets > cur) t.matchSets[g.gameKey] = g.sets;
      }
    }
  }

  const teams = [];
  for (const t of byKey.values()) {
    // Rank a team's roster by season pGIS — opponent-adjusted percentile
    // is a more meaningful "who carried the team" signal than raw
    // GIS+/S volume. GIS+/S still tiebreaks for players whose pGIS isn't
    // available (rare role-player edge cases).
    const sortedPlayers = t.players.slice().sort((a, b) => {
      const aP = Number.isFinite(a.pGIS) ? a.pGIS : -Infinity;
      const bP = Number.isFinite(b.pGIS) ? b.pGIS : -Infinity;
      if (aP !== bP) return bP - aP;
      return (b.gisPlus || 0) - (a.gisPlus || 0);
    });
    // Team metrics — sets-weighted (player rates are per-set), so a
    // libero who plays every set pulls weight toward her season line.
    // pGIS still weights by games since pGIS is a per-match average.
    let gSum = 0, gpSum = 0, sSum = 0, pgSum = 0, pgW = 0;
    for (const pl of t.players) {
      const ws = pl.sets || 0;
      if (ws > 0) {
        gSum  += (pl.gis     || 0) * ws;
        gpSum += (pl.gisPlus || 0) * ws;
        sSum  += ws;
      }
      const wg = pl.games || 0;
      if (wg > 0 && Number.isFinite(pl.pGIS)) { pgSum += pl.pGIS * wg; pgW += wg; }
    }
    const totalTeamSets = Object.values(t.matchSets).reduce((a, b) => a + b, 0);

    // Rotation pGIS — mean of the AVCA-style starting six + libero
    // (top 3 OH/OPP, top 2 MB, top S, top L) by season pGIS. The
    // metric tracks the players who actually drive wins rather than
    // a roster-wide weighted average that role players dilute.
    // Used as the default Team Browser sort key.
    const ROT_QUOTA = { OH: 3, MB: 2, S: 1, L: 1 };
    const byPos = { OH: [], MB: [], S: [], L: [] };
    for (const pl of sortedPlayers) {
      const grp = posGroup(pl.position);
      if (!grp || !byPos[grp]) continue;
      if (!Number.isFinite(pl.pGIS)) continue;
      byPos[grp].push(pl);
    }
    for (const k of Object.keys(byPos)) {
      byPos[k].sort((a, b) => (b.pGIS || 0) - (a.pGIS || 0));
    }
    const rotationPicks = [];
    for (const [k, n] of Object.entries(ROT_QUOTA)) {
      rotationPicks.push(...byPos[k].slice(0, n));
    }
    const rotationPGIS = rotationPicks.length
      ? rotationPicks.reduce((s, p) => s + (p.pGIS || 0), 0) / rotationPicks.length
      : null;

    teams.push({
      key:           t.key,
      year:          t.year,
      team:          t.team,
      rosterSize:    t.players.length,
      games:         t.gameKeys.size,
      t50Games:      t.t50Keys.size,
      sets:          totalTeamSets,
      gis:           sSum > 0 ? gSum  / sSum : 0,
      gisPlus:       sSum > 0 ? gpSum / sSum : 0,
      pGIS:          pgW  > 0 ? pgSum / pgW  : null,
      rotationPGIS,
      rotationCount: rotationPicks.length,
      players:       sortedPlayers,
    });
  }
  return teams;
}

function PlayerMiniRow({ p, rank }) {
  const p4 = isP4(p.conference);
  return (
    <tr>
      <td style={{ textAlign: 'right', color: 'var(--muted)' }}>{rank}</td>
      <td className="pb-name" style={{ color: posColor(p.position) }}>{p.name}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {p.position}
        {p.posRank ? (
          <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: '0.9em' }}>
            <span title={`National rank at ${p.position}`}>
              #{p.posRank}<span style={{ opacity: 0.55 }}>/{p.posRankTotal}</span>
              <span style={{ opacity: 0.55 }}> nat</span>
            </span>
            {p.posRankTier ? (
              <span style={{ marginLeft: 6 }} title={`Rank among ${p4 ? 'Power 4' : 'non-P4'} ${p.position}s`}>
                · #{p.posRankTier}<span style={{ opacity: 0.55 }}>/{p.posRankTierTotal}</span>
                <span style={{ opacity: 0.55 }}> {p4 ? 'P4' : 'other'}</span>
              </span>
            ) : null}
            {p.posRankConf && p.conference ? (
              <span style={{ marginLeft: 6 }} title={`Rank at ${p.position} in ${p.conference}`}>
                · #{p.posRankConf}<span style={{ opacity: 0.55 }}>/{p.posRankConfTotal}</span>
                <span style={{ opacity: 0.55 }}> {p.conference}</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </td>
      <td style={{ textAlign: 'right' }}>{p.games}</td>
      <td style={{ textAlign: 'right' }}>{p.sets}</td>
      <td style={{ textAlign: 'right' }}>{fmt(p.gis)}</td>
      <td style={{ textAlign: 'right', color: 'var(--gisplus)' }}>{fmt(p.gisPlus)}</td>
      <td style={{ textAlign: 'right', color: 'var(--pgis)' }}>{fmt(p.pGIS, 1)}</td>
      <td style={{ textAlign: 'right', opacity: 0.7 }}>{p.t50 ? p.t50.games : '—'}</td>
      <td style={{ textAlign: 'right', opacity: 0.7, color: 'var(--gisplus)' }}>{p.t50 ? fmt(p.t50.gisPlus) : '—'}</td>
      <td style={{ textAlign: 'right', opacity: 0.7 }}>{p.t50 && Number.isFinite(p.t50.pGIS) ? fmt(p.t50.pGIS, 1) : '—'}</td>
    </tr>
  );
}

function TeamCard({ t, expanded, onToggle }) {
  const top3 = t.players.slice(0, 3);
  return (
    <div className="pb-card">
      <div
        className="pb-card-header"
        onClick={onToggle}
        style={{ cursor: 'pointer' }}
      >
        <span className="pb-name">{t.team}</span>
        <span className="pb-team" style={{ marginLeft: '0.5rem' }}>{t.year}</span>
        <div className="pb-career-chips">
          <span className="pb-chip">{t.games} G · {t.sets} S</span>
          <span className="pb-chip">Roster {t.rosterSize}</span>
          {Number.isFinite(t.rotationPGIS) && (
            <span
              className="pb-chip"
              style={{ color: 'var(--pgis)', borderColor: '#ea580c40', background: '#ea580c10', fontWeight: 700 }}
              title="Mean season pGIS of top 3 OH/OPP, top 2 MB, top S, top L"
            >
              Rot pGIS {t.rotationPGIS.toFixed(1)}
            </span>
          )}
          <span className="pb-chip" style={{ color: 'var(--gisplus)' }}>GIS+/S {fmt(t.gisPlus)}</span>
          <PGISChip v={t.pGIS} />
          <span className="pb-chip" style={{ opacity: 0.7, borderStyle: 'dashed' }}>
            {t.t50Games} T50 G
          </span>
          <span className="pb-expand-btn">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {/* Always show top-3 summary in the collapsed card */}
      {!expanded && top3.length > 0 && (
        <div style={{ padding: '0.5rem 1rem', color: 'var(--muted)', fontSize: '0.7rem', fontFamily: "'JetBrains Mono',monospace" }}>
          Top 3:&nbsp;
          {top3.map((p, i) => (
            <span key={p.key}>
              <span style={{ color: posColor(p.position) }}>{p.name}</span>
              <span style={{ color: 'var(--pgis)' }}> ({Number.isFinite(p.pGIS) ? p.pGIS.toFixed(1) : '—'})</span>
              {i < top3.length - 1 ? '  ·  ' : ''}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="pb-table-wrap">
          <table className="pb-season-table" style={{ width: '100%', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem' }}>
            <thead>
              <tr style={{ color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <th style={{ textAlign: 'right' }} title={COL_TIPS['#']}>#</th>
                <th className="text-left" title={COL_TIPS.Player}>Player</th>
                <th className="text-left" title={COL_TIPS.Pos}>Pos</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.G}>G</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.S}>S</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS['GIS/S']}>GIS/S</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS['GIS+/S']}>GIS+/S</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.pGIS}>pGIS</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 G']}>T50 G</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 GIS+/S']}>T50 GIS+/S</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 pGIS']}>T50 pGIS</th>
              </tr>
            </thead>
            <tbody>
              {t.players.map((p, i) => (
                <PlayerMiniRow key={p.key} p={p} rank={i + 1} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function TeamLookup() {
  const { pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality, loading } = useData();
  const [index, setIndex]            = useState(null);
  const [indexErr, setIndexErr]      = useState(null);
  const [buildingIndex, setBuilding] = useState(false);

  const [year, setYear]       = useState(2026);
  const [search, setSearch]   = useState('');
  const [expanded, setExpand] = useState(null);

  useEffect(() => {
    if (loading || !pgisTables) return;
    let cancelled = false;
    setBuilding(true);
    loadPlayerIndex(pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality)
      .then(idx => { if (!cancelled) { setIndex(idx); setBuilding(false); } })
      .catch(err => { if (!cancelled) { setIndexErr(err?.message || String(err)); setBuilding(false); } });
    return () => { cancelled = true; };
  }, [loading, pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality]);

  const teams = useMemo(() => {
    if (!index) return [];
    return buildTeamIndex(index.players);
  }, [index]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = teams.filter(t => {
      if (t.year !== year) return false;
      if (q && !t.team.toLowerCase().includes(q)) return false;
      return true;
    });
    // Rank by rotation pGIS desc (top 3 OH, top 2 MB, top S, top L
    // averaged) — focuses on the starters who carried the team.
    // GIS+/S tiebreaks for the rare case of two teams matching on
    // rotation pGIS to one decimal.
    rows.sort((a, b) => {
      const aR = Number.isFinite(a.rotationPGIS) ? a.rotationPGIS : -Infinity;
      const bR = Number.isFinite(b.rotationPGIS) ? b.rotationPGIS : -Infinity;
      if (aR !== bR) return bR - aR;
      return (b.gisPlus || 0) - (a.gisPlus || 0);
    });
    return rows;
  }, [teams, year, search]);

  const visible   = filtered.slice(0, MAX_RESULTS);
  const totalHits = filtered.length;

  return (
    <>
      <aside className="tool-sidebar">
        <div className="tool-sidebar-title">Teams</div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Year</div>
          <div className="tool-sidebar-pills">
            {YEAR_OPTIONS.map(y => (
              <button
                key={y}
                type="button"
                className={`gl-mode-btn${year === y ? ' active' : ''}`}
                onClick={() => { setYear(y); setExpand(null); }}
                disabled={buildingIndex || !index}
              >
                {y}
              </button>
            ))}
          </div>
        </div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Search</div>
          <input
            className="pb-search"
            placeholder="Team name…"
            value={search}
            onChange={e => { setSearch(e.target.value); setExpand(null); }}
            disabled={buildingIndex || !index}
          />
        </div>
      </aside>

      <main className="tool-main">
        <div className="page-title-row">
          <h1 className="page-title">Team Browser</h1>
          <div className="page-sub">
            Pick a season and search for a program — roster-wide GIS+ aggregates,
            schedule strength, and top contributors for that year.
          </div>
        </div>

      <div className="gb-status">
        {loading && <><div className="spinner" /> Loading baselines…</>}
        {!loading && buildingIndex && <><div className="spinner" /> Building team index…</>}
        {indexErr && <span style={{ color: '#f43f5e' }}>Error: {indexErr}</span>}
        {index && !buildingIndex && (
          <>
            {totalHits.toLocaleString()} team{totalHits === 1 ? '' : 's'} · {year}
            {search.trim() && ` matching "${search.trim()}"`}
            {totalHits > MAX_RESULTS && ` — showing top ${MAX_RESULTS}`}
          </>
        )}
      </div>

      {index && visible.length > 0 && (
        <div className="pb-list">
          {visible.map(t => (
            <TeamCard
              key={t.key}
              t={t}
              expanded={expanded === t.key}
              onToggle={() => setExpand(prev => prev === t.key ? null : t.key)}
            />
          ))}
        </div>
      )}

      {index && visible.length === 0 && !buildingIndex && (
        <div className="gb-empty">
          No teams match the current filters.
        </div>
      )}
      </main>
    </>
  );
}
