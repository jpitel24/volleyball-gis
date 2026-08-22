import { Fragment, useEffect, useMemo, useState } from 'react';
import { useData } from '../lib/DataContext.jsx';
import { loadPlayerIndex, isP4 } from '../lib/playerIndex.js';

// Small helper for the position-cell tooltip. season.conference is
// already stored on the season record; we route through isP4() for
// the tier check to keep the source of truth in playerIndex.
const isSeasonP4 = (s) => isP4(s.conference);
import { posColor, pgisLabel, posGroup, computeCategoryGIS, COL_TIPS } from '../lib/gis.js';

const MAX_RESULTS = 50;
const POS_FILTERS = [
  { id: 'ALL', label: 'All' },
  { id: 'OH',  label: 'OH/RS' },
  { id: 'MB',  label: 'MB' },
  { id: 'S',   label: 'S' },
  { id: 'L',   label: 'L/DS' },
];

const SORT_OPTIONS = [
  { id: 'gisPlus',    label: 'GIS+' },
  { id: 'pGIS',       label: 'pGIS' },
  { id: 't50GisPlus', label: 'T50 GIS+' },
  { id: 't50PGis',    label: 'T50 pGIS' },
];

function fmt(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(d);
}

// Rolling-window pGIS sparkline. Reads a season's gameLog (which Player
// Browser sorts newest-first), reverses to chronological, computes a
// per-set rolling mean over `windowSize` games, and plots it as a tiny
// inline SVG. Y-axis auto-zooms to the player's own range +/- a small
// pad so the line shows variability rather than absolute level (the
// numeric column next to it conveys absolute). Returns null when the
// player doesn't have enough games for a meaningful trend.
function PgisSparkline({ games, width = 56, height = 16, windowSize = 5, color = 'var(--pgis)' }) {
  if (!games || games.length < windowSize) return null;
  const chrono = [...games]
    .filter(g => g && g.sets > 0 && Number.isFinite(g.pGIS))
    .reverse();
  if (chrono.length < windowSize) return null;

  const rolling = [];
  for (let i = windowSize - 1; i < chrono.length; i++) {
    let sum = 0;
    for (let j = i - windowSize + 1; j <= i; j++) sum += chrono[j].pGIS;
    rolling.push(sum / windowSize);
  }
  if (rolling.length < 2) return null;

  const lo = Math.max(0,  Math.min(...rolling) - 0.4);
  const hi = Math.min(10, Math.max(...rolling) + 0.4);
  const span = Math.max(hi - lo, 0.3);   // floor avoids divide-by-zero on flat lines

  const points = rolling.map((v, i) => {
    const x = (i / (rolling.length - 1)) * (width - 2) + 1;
    const y = height - ((v - lo) / span) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // Last-point marker so the eye lands on the most recent rolling avg.
  const last = rolling[rolling.length - 1];
  const lastX = width - 1;
  const lastY = height - ((last - lo) / span) * (height - 2) - 1;

  const title = `Rolling ${windowSize}-game pGIS · ${chrono.length} games · range ${Math.min(...rolling).toFixed(1)}–${Math.max(...rolling).toFixed(1)}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ verticalAlign: 'middle', marginRight: '0.4rem' }}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <polyline fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" points={points} />
      <circle cx={lastX} cy={lastY} r="1.6" fill={color} />
    </svg>
  );
}

// Aggregate-level category breakdown panel. Used for both career and
// season views in the Player Browser. Same shape as the Game Browser
// inspector's "Breakdown by Category" but driven by aggregate totals
// (career or season) rather than a single match.
//
// computeCategoryGIS() returns per-set rates (vol = raw/sets); we
// rescale each category proportionally so the categories sum exactly
// to the displayed headline GIS+/S — preserves relative shape while
// keeping the math additive in the user's eyes (matches the inspector
// rescaling for per-match values).
function buildBreakdown(totals, sets, displayGisPerSet, displayGisPlusPerSet) {
  if (!totals || !sets || sets <= 0) return null;
  const rawCats = computeCategoryGIS(totals, sets, 1, 1).filter(c => c.gis > 0);
  if (!rawCats.length) return null;
  const sumGis = rawCats.reduce((s, c) => s + c.gis,     0) || 1;
  const sumGp  = rawCats.reduce((s, c) => s + c.gisPlus, 0) || 1;
  const gScale  = (displayGisPerSet     || 0) / sumGis;
  const gpScale = (displayGisPlusPerSet || 0) / sumGp;
  const cats = rawCats.map(c => ({
    key: c.key,
    label: c.label,
    gis:     c.gis     * gScale,
    gisPlus: c.gisPlus * gpScale,
  }));
  const total = cats.reduce((s, c) => s + c.gisPlus, 0);
  return cats
    .map(c => ({ ...c, share: total > 0 ? (c.gisPlus / total) * 100 : 0 }))
    .sort((a, b) => b.gisPlus - a.gisPlus);
}

function CategoryBreakdownPanel({ label, totals, sets, gis, gisPlus, posColorHex }) {
  const rows = useMemo(
    () => buildBreakdown(totals, sets, gis, gisPlus),
    [totals, sets, gis, gisPlus]
  );
  if (!rows || rows.length === 0) return null;
  const max = Math.max(...rows.map(r => r.gisPlus), 0.01);
  return (
    <div className="cb-panel">
      <div className="cb-label">{label}</div>
      <div className="cb-rows">
        {rows.map(r => (
          <Fragment key={r.key}>
            <div className="cb-cat">{r.label}</div>
            <div className="cb-track">
              <div
                className="cb-fill"
                style={{
                  width: `${Math.max(2, (r.gisPlus / max) * 100).toFixed(1)}%`,
                  background: posColorHex || 'var(--gisplus)',
                }}
              />
            </div>
            <div className="cb-gis">{r.gis.toFixed(2)}</div>
            <div className="cb-val">{r.gisPlus.toFixed(2)}</div>
            <div className="cb-pct">{r.share.toFixed(0)}%</div>
          </Fragment>
        ))}
      </div>
      <div className="cb-foot">
        <span>Per-Set GIS · GIS+/S · Share of Total</span>
      </div>
    </div>
  );
}

// Cell renderer for the season-row REC% column. Tier-colored by Great%
// using the same conventions volleyball-coaching circles use for "pass
// rating": ≥50% great is elite, 40-50% solid, 30-40% average, <30%
// below average. Hover tooltip surfaces the full Great/Good/Bad split
// and total reception count.
function RecCell({ rq }) {
  if (!rq || !rq.qualified) {
    return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  }
  let color;
  if      (rq.greatPct >= 0.50) color = 'var(--green)';
  else if (rq.greatPct >= 0.40) color = 'var(--accent)';
  else if (rq.greatPct >= 0.30) color = 'var(--yellow)';
  else                          color = 'var(--red)';
  const tooltip = [
    `${rq.total} receptions`,
    `Great: ${rq.great} (${Math.round(rq.greatPct * 100)}%) — setter on 2nd, hitter killed on 3rd`,
    `Good:  ${rq.good} (${Math.round(rq.goodPct  * 100)}%) — setter on 2nd, rally continued`,
    `Bad:   ${rq.bad}  (${Math.round(rq.badPct   * 100)}%) — non-setter on 2nd, OR 3rd-touch attack blocked / errored`,
  ].join('\n');
  return (
    <td style={{ textAlign: 'right', color, fontWeight: 700 }} title={tooltip}>
      {Math.round(rq.greatPct * 100)}%
    </td>
  );
}

// SRV+: serve effective% = (ace + great) / total. "Great" here means
// the rally terminated in our favor by the 3rd touch after the
// reception. Tiers calibrated against the 2025 qualified-cohort
// distribution (avg 17.3%, top decile ≥ 25%).
function ServeCell({ sq }) {
  if (!sq || !sq.qualified) {
    return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  }
  let color;
  if      (sq.effectivePct >= 0.25) color = 'var(--green)';
  else if (sq.effectivePct >= 0.20) color = 'var(--accent)';
  else if (sq.effectivePct >= 0.15) color = 'var(--yellow)';
  else                              color = 'var(--red)';
  const pct = (k) => Math.round((sq[k] || 0) * 100);
  const tooltip = [
    `${sq.total} serves`,
    `Effective: ${sq.ace + sq.great} (${pct('effectivePct')}%) — ace + great`,
    `Ace:    ${sq.ace}    (${pct('acePct')}%) — direct point`,
    `Great:  ${sq.great}  (${pct('greatPct')}%) — we scored within 3 touches of reception`,
    `Good:   ${sq.good}   (${pct('goodPct')}%) — rally extended past 3rd touch after reception`,
    `Bad:    ${sq.bad}    (${pct('badPct')}%) — they scored within 3 touches of reception`,
    `Error:  ${sq.error}  (${pct('errorPct')}%) — service error`,
  ].join('\n');
  return (
    <td style={{ textAlign: 'right', color, fontWeight: 700 }} title={tooltip}>
      {pct('effectivePct')}%
    </td>
  );
}

// BLK+: net blocks per set, derived purely from box-score totals
//   (block_solos + 0.5 × block_assists - blocking_errors) / sets
// NCAA convention: solos count 1.0, assists 0.5 (split-credit), each
// error subtracts 1. Tier-coloring calibrated for D1 MBs — the
// position that actually blocks. Liberos / setters / six-rotation OHs
// who don't block at the net naturally trend low; that's accurate.
function BlockCell({ value, sets, totals }) {
  if (!Number.isFinite(value) || (sets || 0) < 50) {
    return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  }
  let color;
  if      (value >= 1.5) color = 'var(--green)';
  else if (value >= 1.0) color = 'var(--accent)';
  else if (value >= 0.5) color = 'var(--yellow)';
  else                   color = 'var(--red)';
  const solos   = totals?.block_solos     || 0;
  const assists = totals?.block_assists   || 0;
  const errors  = totals?.blocking_errors || 0;
  const tooltip = [
    `${(solos + assists).toLocaleString()} blocks (${solos} solo, ${assists} assist) over ${sets} sets`,
    `Block errors: ${errors}`,
    `Formula: (solos + 0.5 × assists − errors) / sets`,
    `         = (${solos} + ${0.5 * assists} − ${errors}) / ${sets}`,
    `         = ${value.toFixed(2)} per set`,
  ].join('\n');
  return (
    <td style={{ textAlign: 'right', color, fontWeight: 700 }} title={tooltip}>
      {value.toFixed(2)}
    </td>
  );
}

// AST%: assist rate per set = (sets that produced a kill on the next
// touch) / total sets. Tier-colored against the qualified-cohort
// distribution (avg 31.5%, top decile ≥ 40%). Hover surfaces the
// underlying delivery breakdown plus successPct ("did the set
// deliver to a hitter at all?").
function SetCell({ sq }) {
  if (!sq || !sq.qualified) {
    return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  }
  let color;
  if      (sq.assistPct >= 0.40) color = 'var(--green)';
  else if (sq.assistPct >= 0.35) color = 'var(--accent)';
  else if (sq.assistPct >= 0.30) color = 'var(--yellow)';
  else                           color = 'var(--red)';
  const pct = (k) => Math.round((sq[k] || 0) * 100);
  const tooltip = [
    `${sq.total} sets`,
    `Assist:  ${sq.great} (${pct('assistPct')}%) — set produced a kill on next touch`,
    `Success: ${sq.great + sq.good} (${pct('successPct')}%) — set delivered for an attack`,
    `  └ Great: ${sq.great} (${pct('greatPct')}%) — kill on next touch (=assist)`,
    `  └ Good:  ${sq.good}  (${pct('goodPct')}%)  — attack happened, not a kill`,
    `Bad:     ${sq.bad}    (${pct('badPct')}%)    — no attack on next touch (net fault, etc.)`,
    `Error:   ${sq.error}  (${pct('errorPct')}%)  — set error terminal`,
  ].join('\n');
  return (
    <td style={{ textAlign: 'right', color, fontWeight: 700 }} title={tooltip}>
      {pct('assistPct')}%
    </td>
  );
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
                  {g.vsTop50 && (
                    <span
                      title="RPI Top-50 opponent"
                      style={{
                        marginLeft: '0.35rem',
                        padding: '0 0.25rem',
                        fontSize: '0.55rem',
                        border: '1px solid var(--gisplus)',
                        color: 'var(--gisplus)',
                        borderRadius: '2px',
                        letterSpacing: '0.05em',
                      }}
                    >T50</span>
                  )}
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
          <span className="pb-chip">GIS/S {fmt(c.gis)}</span>
          <span className="pb-chip" style={{ color: 'var(--gisplus)' }}>GIS+/S {fmt(c.gisPlus)}</span>
          <PGISChip v={c.pGIS} />
          {c.t50 && (
            <>
              <span className="pb-chip" style={{ opacity: 0.6, borderStyle: 'dashed' }}>
                vs T50 · {c.t50.games}G
              </span>
              <span className="pb-chip" style={{ opacity: 0.85 }}>
                GIS/S {fmt(c.t50.gis)}
              </span>
              <span className="pb-chip" style={{ color: 'var(--gisplus)', opacity: 0.85 }}>
                GIS+/S {fmt(c.t50.gisPlus)}
              </span>
              <PGISChip v={c.t50.pGIS} />
            </>
          )}
          <span className="pb-expand-btn">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded && (
        <CategoryBreakdownPanel
          label="Career — GIS Breakdown"
          totals={c.totals}
          sets={c.sets}
          gis={c.gis}
          gisPlus={c.gisPlus}
          posColorHex={posColor(player.position)}
        />
      )}
      {expanded && (
        <div className="pb-table-wrap">
          <table className="pb-season-table" style={{ width: '100%', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.72rem' }}>
            <thead>
              <tr style={{ color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <th className="text-left" title={COL_TIPS.Yr}>Year</th>
                <th className="text-left" title={COL_TIPS.Team}>Team</th>
                <th className="text-left" title={COL_TIPS.Pos}>Pos</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.G}>G</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.S}>S</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.K}>K</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.A}>A</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.D}>D</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.B}>B</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.SA}>SA</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS['GIS/S']}>GIS/S</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS['GIS+/S']}>GIS+/S</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS.pGIS}>pGIS</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS['REC%']}>REC%</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS['SRV+']}>SRV+</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS['AST%']}>AST%</th>
                <th style={{ textAlign: 'right' }} title={COL_TIPS['BLK+']}>BLK+</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 G']}>T50 G</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 GIS/S']}>T50 GIS/S</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 GIS+/S']}>T50 GIS+/S</th>
                <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 pGIS']}>T50 pGIS</th>
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
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {s.position}
                        {s.posRank ? (
                          <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: '0.92em' }}>
                            <span title={`National rank at ${s.position} (${s.year})`}>
                              #{s.posRank}
                              <span style={{ opacity: 0.55 }}>/{s.posRankTotal}</span>
                              <span style={{ opacity: 0.55 }}> nat</span>
                            </span>
                            {s.posRankTier ? (
                              <span
                                style={{ marginLeft: 6 }}
                                title={`Rank among ${isSeasonP4(s) ? 'Power 4' : 'non-P4'} ${s.position}s`}
                              >
                                · #{s.posRankTier}
                                <span style={{ opacity: 0.55 }}>/{s.posRankTierTotal}</span>
                                <span style={{ opacity: 0.55 }}> {isSeasonP4(s) ? 'P4' : 'other'}</span>
                              </span>
                            ) : null}
                            {s.posRankConf && s.conference ? (
                              <span
                                style={{ marginLeft: 6 }}
                                title={`Rank at ${s.position} in ${s.conference}`}
                              >
                                · #{s.posRankConf}
                                <span style={{ opacity: 0.55 }}>/{s.posRankConfTotal}</span>
                                <span style={{ opacity: 0.55 }}> {s.conference}</span>
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </td>
                      <td style={{ textAlign: 'right' }}>{s.games}</td>
                      <td style={{ textAlign: 'right' }}>{s.sets}</td>
                      <StatCells t={s.totals} />
                      <td style={{ textAlign: 'right' }}>{fmt(s.gis)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--gisplus)' }}>{fmt(s.gisPlus)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--pgis)', whiteSpace: 'nowrap' }}>
                        <PgisSparkline games={s.gameLog} />
                        {fmt(s.pGIS, 1)}
                      </td>
                      <RecCell rq={s.recQuality} />
                      <ServeCell sq={s.srvQuality} />
                      <SetCell sq={s.setQuality} />
                      <BlockCell value={s.blockEffPerSet} sets={s.sets} totals={s.totals} />
                      <td style={{ textAlign: 'right', opacity: 0.7 }}>{s.t50 ? s.t50.games : '—'}</td>
                      <td style={{ textAlign: 'right', opacity: 0.7 }}>{s.t50 ? fmt(s.t50.gis) : '—'}</td>
                      <td style={{ textAlign: 'right', opacity: 0.7, color: 'var(--gisplus)' }}>{s.t50 ? fmt(s.t50.gisPlus) : '—'}</td>
                      <td style={{ textAlign: 'right', opacity: 0.7, color: 'var(--pgis)' }}>{s.t50 ? fmt(s.t50.pGIS, 1) : '—'}</td>
                      <td className="pb-expand-btn">{open ? '▾' : '▸'}</td>
                    </tr>
                    {open && (
                      <tr className="pb-log-row">
                        <td colSpan={22}>
                          <CategoryBreakdownPanel
                            label={`${s.year} — Season GIS Breakdown`}
                            totals={s.totals}
                            sets={s.sets}
                            gis={s.gis}
                            gisPlus={s.gisPlus}
                            posColorHex={posColor(s.position)}
                          />
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
  const { pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality, loading } = useData();
  const [index, setIndex]               = useState(null);
  const [indexErr, setIndexErr]         = useState(null);
  const [buildingIndex, setBuilding]    = useState(false);
  const [search, setSearch]             = useState('');
  const [posFilter, setPosFilter]       = useState('ALL');
  const [sortBy, setSortBy]             = useState('gisPlus');
  const [expandedPlayer, setExpanded]   = useState(null);
  const [expandedSeason, setExpandedS]  = useState(null);

  useEffect(() => {
    if (loading || !pgisTables) return;
    let cancelled = false;
    setBuilding(true);
    loadPlayerIndex(pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality)
      .then(idx => { if (!cancelled) { setIndex(idx); setBuilding(false); } })
      .catch(err => { if (!cancelled) { setIndexErr(err?.message || String(err)); setBuilding(false); } });
    return () => { cancelled = true; };
  }, [loading, pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality]);

  // Only compute hits once the user has started searching (or picked a
  // position). Avoids rendering 8k+ cards when the tab first opens.
  const isActive = search.trim().length > 0 || posFilter !== 'ALL';

  const allHits = useMemo(() => {
    if (!index || !isActive) return [];
    const q = search.trim().toLowerCase();
    const hits = index.players.filter(p => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (posFilter !== 'ALL' && posGroup(p.position) !== posFilter) return false;
      return true;
    });
    // Default index order is career GIS+ desc. Only re-sort when the
    // user picks a different key. T50 variants pull from career.t50
    // (nullable if the player never faced a top-50 opponent).
    const get = (p) => {
      if (sortBy === 'gisPlus') return p.career.gisPlus || 0;
      if (sortBy === 'pGIS')    return p.career.pGIS    || 0;
      if (sortBy === 't50GisPlus') return p.career.t50?.gisPlus ?? -1;
      if (sortBy === 't50PGis')    return p.career.t50?.pGIS    ?? -1;
      return 0;
    };
    if (sortBy !== 'gisPlus') {
      hits.sort((a, b) => get(b) - get(a));
    }
    return hits;
  }, [index, search, posFilter, sortBy, isActive]);

  const filtered  = allHits.slice(0, MAX_RESULTS);
  const totalHits = allHits.length;

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
      <aside className="tool-sidebar">
        <div className="tool-sidebar-title">Players</div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Search</div>
          <input
            className="pb-search"
            placeholder="Player name…"
            value={search}
            onChange={e => { setSearch(e.target.value); setExpanded(null); setExpandedS(null); }}
            disabled={buildingIndex || !index}
          />
        </div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Position</div>
          <div className="tool-sidebar-pills">
            {POS_FILTERS.map(f => (
              <button
                key={f.id}
                type="button"
                className={`gl-mode-btn${posFilter === f.id ? ' active' : ''}`}
                onClick={() => { setPosFilter(f.id); setExpanded(null); setExpandedS(null); }}
                disabled={buildingIndex || !index}
              >
                {f.label}
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
                onClick={() => { setSortBy(o.id); setExpanded(null); setExpandedS(null); }}
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
          <h1 className="page-title">Player Browser</h1>
          <div className="page-sub">
            Every D1 player, 2022–present. Click a name to expand per-season totals;
            click a season to see every game that year.
          </div>
        </div>

      <div className="gb-status">
        {loading && <><div className="spinner" /> Loading baselines…</>}
        {!loading && buildingIndex && <><div className="spinner" /> Building player index…</>}
        {indexErr && <span style={{ color: '#f43f5e' }}>Error: {indexErr}</span>}
        {index && !isActive && (
          <>{index.players.length.toLocaleString()} players indexed — type a name or pick a position to search</>
        )}
        {index && isActive && (
          <>
            {totalHits.toLocaleString()} player{totalHits === 1 ? '' : 's'} match
            {search.trim() && ` "${search.trim()}"`}
            {posFilter !== 'ALL' && ` · ${POS_FILTERS.find(f => f.id === posFilter).label}`}
            {totalHits > MAX_RESULTS && ` — showing top ${MAX_RESULTS}`}
          </>
        )}
      </div>

      {index && isActive && filtered.length > 0 && (
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

      {index && isActive && filtered.length === 0 && (
        <div className="gb-empty">
          No players match the current filters.
        </div>
      )}
      </main>
    </>
  );
}
