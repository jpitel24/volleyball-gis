import { useEffect, useMemo, useState } from 'react';
import { useData } from '../lib/DataContext.jsx';
import { loadPlayerIndex } from '../lib/playerIndex.js';
import { posColor, pgisLabel, posGroup } from '../lib/gis.js';

// Player-season comparison tool. Up to 4 slots, each holding a
// (player, year) pair. Side-by-side stat grid covers box-score totals,
// per-set rates, efficiency percentages, GIS / GIS+ / pGIS, and the
// vs-RPI-Top-50 splits — all surfaced from the existing player index
// (which already aggregates per-season totals + PBP-derived metrics).
//
// State is local to the component for v1 (no URL deep-link). A refresh
// resets the slate; future revision can serialize selections into
// /compare?p=key|year&p=key|year if shareable links become valuable.

const MAX_SLOTS = 4;
const MIN_SLOTS_VISIBLE = 2;

// Stat row schema. `pick` reads a value out of a season record; `fmt`
// renders it; `lower_better` flips the winner-highlight rule for
// error-style stats. `dim` rows render the label dimmed because they
// behave more as context than as a competitive stat.
function fmt(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(d);
}
function pct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(3);
}
function int(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toString();
}

const ROWS = [
  // Volume
  { kind: 'group', label: 'Volume' },
  { id: 'games',    label: 'Games',     pick: s => s.games,                                          fmt: int },
  { id: 'sets',     label: 'Sets',      pick: s => s.sets,                                           fmt: int },
  { id: 'kills',    label: 'Kills',     pick: s => s.totals?.kills,                                  fmt: int },
  { id: 'asts',     label: 'Assists',   pick: s => s.totals?.assists,                                fmt: int },
  { id: 'digs',     label: 'Digs',      pick: s => s.totals?.digs,                                   fmt: int },
  { id: 'blks',     label: 'Blocks',    pick: s => (s.totals?.block_solos || 0) + (s.totals?.block_assists || 0), fmt: int },
  { id: 'aces',     label: 'Aces',      pick: s => s.totals?.service_aces,                           fmt: int },
  { id: 'recs',     label: 'Reception Att',  pick: s => s.totals?.reception_attempts,                fmt: int, dim: true },
  { id: 'sata',     label: 'Set Att',         pick: s => s.totals?.set_attempts,                     fmt: int, dim: true },
  { id: 'sva',      label: 'Serve Att',       pick: s => s.totals?.serve_attempts,                   fmt: int, dim: true },

  // Per-set rates
  { kind: 'group', label: 'Per-Set Rates' },
  { id: 'kps', label: 'Kills/Set',     pick: s => s.sets ? (s.totals?.kills    || 0) / s.sets : null, fmt: v => fmt(v, 2) },
  { id: 'aps', label: 'Assists/Set',   pick: s => s.sets ? (s.totals?.assists  || 0) / s.sets : null, fmt: v => fmt(v, 2) },
  { id: 'dps', label: 'Digs/Set',      pick: s => s.sets ? (s.totals?.digs     || 0) / s.sets : null, fmt: v => fmt(v, 2) },
  { id: 'bps', label: 'Blocks/Set',    pick: s => s.sets ? ((s.totals?.block_solos || 0) + 0.5 * (s.totals?.block_assists || 0)) / s.sets : null, fmt: v => fmt(v, 2) },
  { id: 'svps', label: 'Aces/Set',     pick: s => s.sets ? (s.totals?.service_aces || 0) / s.sets : null, fmt: v => fmt(v, 2) },
  { id: 'tap', label: 'Attacks/Set',   pick: s => s.sets ? (s.totals?.total_attacks || 0) / s.sets : null, fmt: v => fmt(v, 2), dim: true },

  // Efficiency
  { kind: 'group', label: 'Efficiency' },
  { id: 'hit', label: 'HIT %',  pick: s => {
      const ta = s.totals?.total_attacks || 0;
      if (ta <= 0) return null;
      return ((s.totals?.kills || 0) - (s.totals?.errors || 0)) / ta;
    }, fmt: pct },
  { id: 'rec', label: 'REC %',  pick: s => {
      const ra = s.totals?.reception_attempts || 0;
      if (ra <= 0) return null;
      return (ra - (s.totals?.reception_errors || 0)) / ra;
    }, fmt: pct },
  { id: 'srv', label: 'SRV %',  pick: s => {
      const sa = s.totals?.serve_attempts || 0;
      if (sa <= 0) return null;
      return ((s.totals?.service_aces || 0) - (s.totals?.service_errors || 0)) / sa;
    }, fmt: pct },
  { id: 'set', label: 'SET %',  pick: s => {
      const sa = s.totals?.set_attempts || 0;
      if (sa <= 0) return null;
      return ((s.totals?.assists || 0) - (s.totals?.set_errors || 0)) / sa;
    }, fmt: pct },

  // Composite — these are the headline metrics
  { kind: 'group', label: 'GIS Composite' },
  { id: 'gisS',     label: 'GIS/S',     pick: s => s.gis,     fmt: v => fmt(v, 2), bold: true },
  { id: 'gisPlusS', label: 'GIS+/S',    pick: s => s.gisPlus, fmt: v => fmt(v, 2), bold: true, color: 'var(--gisplus)' },
  { id: 'pGIS',     label: 'pGIS',      pick: s => s.pGIS,    fmt: v => fmt(v, 1), bold: true, color: 'var(--pgis)' },

  // T50 splits
  { kind: 'group', label: 'vs RPI Top-50' },
  { id: 't50G',     label: 'T50 Games',    pick: s => s.t50?.games,    fmt: int,   dim: true },
  { id: 't50Sets',  label: 'T50 Sets',     pick: s => s.t50?.sets,     fmt: int,   dim: true },
  { id: 't50Gis',   label: 'T50 GIS/S',    pick: s => s.t50?.gis,      fmt: v => fmt(v, 2) },
  { id: 't50Gp',    label: 'T50 GIS+/S',   pick: s => s.t50?.gisPlus,  fmt: v => fmt(v, 2), color: 'var(--gisplus)' },
  { id: 't50pGIS',  label: 'T50 pGIS',     pick: s => s.t50?.pGIS,     fmt: v => fmt(v, 1), color: 'var(--pgis)' },

  // Errors (lower better)
  { kind: 'group', label: 'Errors (fewer is better)' },
  { id: 'aErr',  label: 'Attack Err',     pick: s => s.totals?.errors,            fmt: int, lower_better: true },
  { id: 'bErr',  label: 'Block Err',      pick: s => s.totals?.blocking_errors,   fmt: int, lower_better: true },
  { id: 'rErr',  label: 'Reception Err',  pick: s => s.totals?.reception_errors,  fmt: int, lower_better: true },
  { id: 'sErr',  label: 'Service Err',    pick: s => s.totals?.service_errors,    fmt: int, lower_better: true },
  { id: 'bhe',   label: 'Ball-Handling Err', pick: s => s.totals?.ball_handling_errors, fmt: int, lower_better: true },
  { id: 'setErr', label: 'Set Err',       pick: s => s.totals?.set_errors,         fmt: int, lower_better: true, dim: true },
];

function pickWinners(values, lowerBetter) {
  // values: array (length = slots) of numeric or null. Returns set of
  // indices that "win" the row. Ties allowed (multiple winners).
  const valid = values.map((v, i) => ({ v, i })).filter(x => Number.isFinite(x.v));
  if (valid.length < 2) return new Set();
  const target = lowerBetter
    ? Math.min(...valid.map(x => x.v))
    : Math.max(...valid.map(x => x.v));
  return new Set(valid.filter(x => Math.abs(x.v - target) < 1e-9).map(x => x.i));
}

// Per-slot picker: search by name → pick player → pick year → confirm.
function CompareSlot({ slot, value, onSet, onClear, index, buildingIndex }) {
  const [query, setQuery]         = useState('');
  const [pickedPlayer, setPicked] = useState(null);

  const suggestions = useMemo(() => {
    if (!index) return [];
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return index.players
      .filter(p => p.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [index, query]);

  if (value) {
    const pc = posColor(value.position);
    return (
      <div className="cmp-slot cmp-slot-filled">
        <div className="cmp-slot-label">Slot {slot}</div>
        <div className="cmp-slot-card" style={{ borderLeft: `3px solid ${pc}` }}>
          <div className="cmp-slot-name" style={{ color: 'var(--text)' }}>
            <span style={{ color: pc }}>{value.position}</span>{' '}
            {value.name}
          </div>
          <div className="cmp-slot-meta">{value.team} · {value.year}</div>
        </div>
        <button type="button" className="gl-mode-btn cmp-slot-clear" onClick={onClear}>
          Clear
        </button>
      </div>
    );
  }

  if (pickedPlayer) {
    return (
      <div className="cmp-slot">
        <div className="cmp-slot-label">Slot {slot} · pick year</div>
        <div className="cmp-slot-name" style={{ color: posColor(pickedPlayer.position) }}>
          {pickedPlayer.name}
        </div>
        <div className="tool-sidebar-pills">
          {pickedPlayer.seasons.map(s => (
            <button
              key={s.year}
              type="button"
              className="gl-mode-btn"
              onClick={() => {
                onSet({
                  playerKey: pickedPlayer.key,
                  year: s.year,
                  name: pickedPlayer.name,
                  team: s.team,
                  position: s.position,
                });
                setPicked(null);
                setQuery('');
              }}
            >
              {s.year}
            </button>
          ))}
        </div>
        <button type="button" className="gl-mode-btn cmp-slot-clear" onClick={() => setPicked(null)}>
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="cmp-slot">
      <div className="cmp-slot-label">Slot {slot}</div>
      <input
        className="pb-search"
        placeholder="Search a player…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        disabled={buildingIndex || !index}
      />
      {suggestions.length > 0 && (
        <ul className="cmp-suggest">
          {suggestions.map(p => (
            <li
              key={p.key}
              className="cmp-suggest-item"
              onClick={() => setPicked(p)}
            >
              <span style={{ color: posColor(p.position) }}>{p.position}</span>{' '}
              <strong>{p.name}</strong>
              <span className="cmp-suggest-team"> · {p.teams.slice(0, 2).join('/')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Compare() {
  const { pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality, loading } = useData();
  const [index, setIndex]            = useState(null);
  const [indexErr, setIndexErr]      = useState(null);
  const [buildingIndex, setBuilding] = useState(false);
  // selections: array of { playerKey, year, name, team, position } | null
  const [selections, setSelections]  = useState(() => Array(MAX_SLOTS).fill(null));

  useEffect(() => {
    if (loading || !pgisTables) return;
    let cancelled = false;
    setBuilding(true);
    loadPlayerIndex(pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality)
      .then(idx => { if (!cancelled) { setIndex(idx); setBuilding(false); } })
      .catch(err => { if (!cancelled) { setIndexErr(err?.message || String(err)); setBuilding(false); } });
    return () => { cancelled = true; };
  }, [loading, pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality]);

  // Resolve each selection into the actual season record from the index.
  const seasons = useMemo(() => {
    if (!index) return Array(MAX_SLOTS).fill(null);
    return selections.map(sel => {
      if (!sel) return null;
      const player = index.byKey.get(sel.playerKey);
      if (!player) return null;
      const season = player.seasons.find(s => s.year === sel.year);
      if (!season) return null;
      return { ...sel, season, player };
    });
  }, [index, selections]);

  const filledCount = seasons.filter(Boolean).length;
  const visibleSlots = Math.max(MIN_SLOTS_VISIBLE, Math.min(MAX_SLOTS, filledCount + 1));

  function setSlot(idx, value) {
    setSelections(prev => prev.map((v, i) => i === idx ? value : v));
  }

  return (
    <>
      <aside className="tool-sidebar">
        <div className="tool-sidebar-title">Compare</div>
        {Array.from({ length: visibleSlots }, (_, i) => (
          <CompareSlot
            key={i}
            slot={i + 1}
            value={selections[i]}
            onSet={v => setSlot(i, v)}
            onClear={() => setSlot(i, null)}
            index={index}
            buildingIndex={buildingIndex}
          />
        ))}
        {filledCount > 0 && (
          <button
            type="button"
            className="gl-mode-btn"
            onClick={() => setSelections(Array(MAX_SLOTS).fill(null))}
            style={{ marginTop: '0.5rem' }}
          >
            Clear all
          </button>
        )}
      </aside>

      <main className="tool-main">
        <div className="page-title-row">
          <h1 className="page-title">Compare</h1>
          <div className="page-sub">
            Stack up to four player-seasons side by side. Box-score totals,
            per-set rates, efficiency percentages, and the PBP-fed
            GIS / GIS+ / pGIS composites all in one grid.
          </div>
        </div>

        <div className="gb-status">
          {loading && <><div className="spinner" /> Loading baselines…</>}
          {!loading && buildingIndex && <><div className="spinner" /> Building player index…</>}
          {indexErr && <span style={{ color: '#f43f5e' }}>Error: {indexErr}</span>}
          {index && filledCount === 0 && (
            <>Search a player in the sidebar to add the first slot.</>
          )}
          {index && filledCount > 0 && (
            <>{filledCount} of {MAX_SLOTS} slots filled.</>
          )}
        </div>

        {filledCount >= 1 && (
          <CompareGrid seasons={seasons.slice(0, visibleSlots)} />
        )}
      </main>
    </>
  );
}

function CompareGrid({ seasons }) {
  const slotCount = seasons.length;
  return (
    <div className="cmp-table-wrap">
      <table className="cmp-table" style={{ '--cmp-cols': slotCount }}>
        <thead>
          <tr>
            <th className="cmp-stat-col">Stat</th>
            {seasons.map((s, i) => (
              <th key={i} className="cmp-player-col">
                {s ? (
                  <div>
                    <div className="cmp-player-name" style={{ color: posColor(s.position) }}>
                      {s.name}
                    </div>
                    <div className="cmp-player-meta">
                      {s.team} · {s.year} · {s.position}
                    </div>
                  </div>
                ) : (
                  <div className="cmp-empty-head">— empty —</div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(row => {
            if (row.kind === 'group') {
              return (
                <tr key={row.label} className="cmp-group-row">
                  <td colSpan={slotCount + 1}>{row.label}</td>
                </tr>
              );
            }
            const values = seasons.map(s => s ? row.pick(s.season) : null);
            const winners = pickWinners(values, !!row.lower_better);
            return (
              <tr key={row.id} className={row.dim ? 'cmp-row-dim' : ''}>
                <td className="cmp-stat-col">{row.label}</td>
                {values.map((v, i) => {
                  const isWinner = winners.has(i);
                  const style = {};
                  if (row.color)  style.color = row.color;
                  if (row.bold)   style.fontWeight = 700;
                  if (isWinner)   { style.fontWeight = 800; style.background = 'var(--surface3)'; }
                  return (
                    <td key={i} className="cmp-val" style={style}>
                      {v == null ? '—' : (typeof row.fmt === 'function' ? row.fmt(v) : v)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
