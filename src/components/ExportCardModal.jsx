/**
 * ExportCardModal.jsx
 *
 * Shared export modal for both career cards (Player Browser) and
 * per-game cards (Game Lookup). Renders a live preview at fixed pixel
 * dimensions and exports via html2canvas.
 *
 * Props:
 *   mode          'career' | 'game'
 *   player        { name, pos, team }
 *   -- career mode --
 *   allRecords    array of seasonal stat records (sorted newest first)
 *   gameLogs      game_logs object (for top games per season)
 *   pgisTables    for computeArchivePGIS
 *   -- game mode --
 *   gameStats     { gis, gisPlus, pGIS, kills, errors, total_attacks, hit_pct,
 *                   assists, digs, service_aces, service_errors, reception_errors,
 *                   ball_handling_errors, blocking_errors, block_solos, block_assists, ns }
 *   gameData      { opp, homeScore, awayScore, date, location, nSets,
 *                   homeTeam, awayTeam, playerTeam }
 *   onClose       () => void
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import html2canvas from 'html2canvas';
import { getSchoolColors } from '../data/schoolColors.js';
import { computeArchivePGIS, pgisLabel, gisTier } from '../lib/gis.js';

// ── Aspect ratios ─────────────────────────────────────────────────────────────
const TRANSPARENT_RATIOS = ['1:1', '4:5', '16:9'];
const STYLIZED_RATIOS    = ['1:1', '4:5', '9:16', '16:9'];

const DIMS = {
  '1:1':  { w: 600, h: 600 },
  '4:5':  { w: 600, h: 750 },
  '16:9': { w: 960, h: 540 },
  '9:16': { w: 540, h: 960 },
};

// Preview container max size (px) — card is scaled down to fit
const PREVIEW_MAX = 340;

// ── Helpers ───────────────────────────────────────────────────────────────────
function pgisColor(v) {
  if (v === null || v === undefined) return '#64748b';
  if (v >= 9.5) return '#f43f5e';
  if (v >= 8.5) return '#fb923c';
  if (v >= 7.5) return '#38bdf8';
  if (v >= 6.0) return '#38bdf8';
  return '#64748b';
}
function gisColor(v) {
  if (v >= 10)  return '#f43f5e';
  if (v >= 7)   return '#fb923c';
  if (v >= 4.5) return '#4ade80';
  if (v >= 2.5) return '#38bdf8';
  return '#64748b';
}

function fmtStat(v, decimals = 0) {
  if (v === null || v === undefined) return '—';
  return typeof v === 'number' ? v.toFixed(decimals) : String(v);
}

// ── Transparent card ──────────────────────────────────────────────────────────
function TransparentCard({ dims, player, gis, gisPlus, pGIS, solidBg }) {
  const { w, h } = dims;
  const [pLabel] = pgisLabel(pGIS);
  const pColor = pgisColor(pGIS);
  const gColor = gisColor(gis ?? 0);

  const pad = Math.round(w * 0.06);
  const fs  = { name: Math.round(w * 0.075), metric: Math.round(w * 0.12),
                label: Math.round(w * 0.035), badge: Math.round(w * 0.03),
                pos: Math.round(w * 0.032) };

  return (
    <div style={{
      width: w, height: h,
      background: solidBg ? '#0f1624' : 'rgba(8,12,20,0.88)',
      display: 'flex', flexDirection: 'column',
      justifyContent: 'center', alignItems: 'center',
      padding: pad, fontFamily: "'Barlow Condensed', sans-serif",
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Subtle grid overlay */}
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.06,
        backgroundImage: 'repeating-linear-gradient(0deg,transparent,transparent 39px,#ffffff10 40px),repeating-linear-gradient(90deg,transparent,transparent 39px,#ffffff10 40px)',
        pointerEvents: 'none',
      }} />

      {/* Position + name */}
      <div style={{ textAlign: 'center', marginBottom: Math.round(h * 0.06), zIndex: 1 }}>
        <div style={{
          display: 'inline-block', fontSize: fs.pos, fontWeight: 700, letterSpacing: '0.12em',
          color: '#38bdf8', background: '#38bdf810', border: '1px solid #38bdf830',
          borderRadius: 4, padding: `${Math.round(fs.pos * 0.25)}px ${Math.round(fs.pos * 0.7)}px`,
          marginBottom: Math.round(fs.pos * 0.6),
        }}>
          {player.pos || '?'}
        </div>
        <div style={{ fontSize: fs.name, fontWeight: 900, lineHeight: 1, color: '#e2e8f0',
          letterSpacing: '-0.01em', textTransform: 'uppercase' }}>
          {player.name}
        </div>
      </div>

      {/* Metrics row */}
      <div style={{
        display: 'flex', gap: Math.round(w * 0.06), alignItems: 'flex-end',
        justifyContent: 'center', zIndex: 1,
      }}>
        {[
          { val: (gis ?? 0).toFixed(2),       lbl: 'GIS',  color: gColor },
          { val: (gisPlus ?? 0).toFixed(2),   lbl: 'GIS+', color: '#e879f9' },
          { val: pGIS != null ? pGIS.toFixed(2) : '—', lbl: 'pGIS', color: pColor, badge: pLabel },
        ].map(({ val, lbl, color, badge }) => (
          <div key={lbl} style={{ textAlign: 'center' }}>
            {badge && (
              <div style={{
                fontSize: fs.badge, fontFamily: "'JetBrains Mono',monospace",
                letterSpacing: '0.08em', color, border: `1px solid ${color}40`,
                background: `${color}10`, borderRadius: 3,
                padding: `${Math.round(fs.badge * 0.3)}px ${Math.round(fs.badge * 0.9)}px`,
                marginBottom: Math.round(fs.badge * 0.5), display: 'inline-block',
              }}>{badge}</div>
            )}
            <div style={{ fontSize: fs.metric, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
            <div style={{ fontSize: fs.label, fontFamily: "'JetBrains Mono',monospace",
              color: '#64748b', letterSpacing: '0.1em', marginTop: Math.round(fs.label * 0.5) }}>
              {lbl}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stylized career card ───────────────────────────────────────────────────────
function StylizedCareerCard({ dims, player, record, topGames, pgisTables }) {
  const { w, h } = dims;
  const school = getSchoolColors(player.team || record?.team || '');
  const isPrimDark = parseInt(school.primary.slice(1), 16) < 0x888888 * 256;
  const hdrText   = isPrimDark ? '#FFFFFF' : '#0f1624';

  const pGIS    = computeArchivePGIS(record, pgisTables);
  const gps     = record?.gis_plus_per_set ?? 0;
  const [pLabel] = pgisLabel(pGIS);
  const pColor  = pgisColor(pGIS);

  const pad  = Math.round(w * 0.055);
  const fs   = { hdr: Math.round(w * 0.065), name: Math.round(w * 0.07),
                 metric: Math.round(w * 0.09), label: Math.round(w * 0.027),
                 stat: Math.round(w * 0.033), badge: Math.round(w * 0.027),
                 sub: Math.round(w * 0.03) };

  const statItems = [
    ['K',    record?.kills || 0],
    ['E',    record?.errors || 0],
    ['HIT%', (record?.hit_pct ?? 0).toFixed(3)],
    ['A',    record?.assists || 0],
    ['D',    record?.digs || 0],
    ['SA',   record?.service_aces || 0],
    ['G',    record?.games || 0],
    ['Qg',   record?.qual_games || 0],
  ];

  return (
    <div style={{
      width: w, height: h, background: '#0f1624',
      display: 'flex', flexDirection: 'column',
      fontFamily: "'Barlow Condensed', sans-serif", overflow: 'hidden',
    }}>
      {/* Header strip */}
      <div style={{
        background: school.primary, padding: `${pad}px ${pad}px ${Math.round(pad * 0.7)}px`,
        flexShrink: 0,
      }}>
        <div style={{ fontSize: fs.sub, fontFamily: "'JetBrains Mono',monospace",
          color: hdrText, opacity: 0.7, letterSpacing: '0.12em', marginBottom: Math.round(fs.sub * 0.4),
          textTransform: 'uppercase' }}>
          {record?.team || player.team} · {record?.season}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: Math.round(pad * 0.5) }}>
          <div style={{
            fontSize: fs.sub, fontWeight: 700, letterSpacing: '0.12em',
            color: hdrText, background: `rgba(255,255,255,0.15)`,
            border: `1px solid rgba(255,255,255,0.25)`,
            borderRadius: 3, padding: `${Math.round(fs.sub*0.25)}px ${Math.round(fs.sub*0.7)}px`,
          }}>
            {record?.pos || player.pos || '?'}
          </div>
          <div style={{ fontSize: fs.name, fontWeight: 900, color: hdrText, letterSpacing: '-0.01em',
            lineHeight: 1, textTransform: 'uppercase' }}>
            {player.name}
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, padding: `${Math.round(pad * 0.85)}px ${pad}px`, display: 'flex',
        flexDirection: 'column', gap: Math.round(pad * 0.6), overflow: 'hidden' }}>

        {/* GIS metrics row */}
        <div style={{ display: 'flex', gap: Math.round(w * 0.04), background: '#161e2e',
          border: '1px solid #1e2d45', borderRadius: 6, padding: `${Math.round(pad * 0.6)}px ${Math.round(pad * 0.75)}px`,
          justifyContent: 'space-around', flexShrink: 0 }}>
          {[
            { val: (gps).toFixed(3),                              lbl: 'GIS+/S',  color: '#e879f9' },
            { val: pGIS != null ? pGIS.toFixed(2) : '—',         lbl: 'pGIS',    color: pColor, badge: pLabel },
          ].map(({ val, lbl, color, badge }) => (
            <div key={lbl} style={{ textAlign: 'center' }}>
              {badge && (
                <div style={{ fontSize: fs.badge, fontFamily: "'JetBrains Mono',monospace",
                  letterSpacing: '0.08em', color, border: `1px solid ${color}40`,
                  background: `${color}10`, borderRadius: 3, marginBottom: Math.round(fs.badge*0.4),
                  padding: `${Math.round(fs.badge*0.3)}px ${Math.round(fs.badge*0.9)}px`,
                  display: 'inline-block' }}>{badge}</div>
              )}
              <div style={{ fontSize: fs.metric, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
              <div style={{ fontSize: fs.label, fontFamily: "'JetBrains Mono',monospace",
                color: '#64748b', letterSpacing: '0.1em', marginTop: Math.round(fs.label*0.4) }}>{lbl}</div>
            </div>
          ))}
        </div>

        {/* Stat grid */}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(statItems.length, 4)},1fr)`,
          gap: Math.round(pad * 0.4), flexShrink: 0 }}>
          {statItems.map(([lbl, val]) => (
            <div key={lbl} style={{ textAlign: 'center', background: '#161e2e',
              border: '1px solid #1e2d45', borderRadius: 4,
              padding: `${Math.round(pad * 0.35)}px` }}>
              <div style={{ fontSize: fs.stat, fontFamily: "'JetBrains Mono',monospace",
                color: '#e2e8f0', fontWeight: 700 }}>{val}</div>
              <div style={{ fontSize: fs.label, fontFamily: "'JetBrains Mono',monospace",
                color: '#64748b', marginTop: 2 }}>{lbl}</div>
            </div>
          ))}
        </div>

        {/* Top games */}
        {topGames && topGames.length > 0 && (
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontSize: fs.label, fontFamily: "'JetBrains Mono',monospace",
              color: '#64748b', letterSpacing: '0.1em', textTransform: 'uppercase',
              marginBottom: Math.round(fs.label * 0.6) }}>
              TOP GAMES
            </div>
            {topGames.slice(0, 3).map((g, i) => {
              const [/*gid*/, opp, /*sets*/, /*gisNP*/, pGisVal] = g;
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', padding: `${Math.round(pad * 0.25)}px 0`,
                  borderBottom: i < 2 ? '1px solid #1e2d45' : 'none' }}>
                  <span style={{ fontSize: fs.stat, color: '#94a3b8', flex: 1,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    vs {opp}
                  </span>
                  <span style={{ fontSize: fs.stat, fontFamily: "'JetBrains Mono',monospace",
                    color: pColor, fontWeight: 700, flexShrink: 0, marginLeft: 8 }}>
                    {pGisVal != null ? pGisVal.toFixed(2) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Stylized game card ────────────────────────────────────────────────────────
function StylizedGameCard({ dims, player, gameStats, gameData }) {
  const { w, h } = dims;
  const school = getSchoolColors(player.team || '');
  const isPrimDark = parseInt(school.primary.slice(1), 16) < 0x888888 * 256;
  const hdrText   = isPrimDark ? '#FFFFFF' : '#0f1624';

  const { gis, gisPlus, pGIS } = gameStats;
  const [pLabel] = pgisLabel(pGIS);
  const pColor   = pgisColor(pGIS);
  const gColor   = gisColor(gis ?? 0);

  const pad = Math.round(w * 0.055);
  const fs  = { hdr: Math.round(w * 0.06), name: Math.round(w * 0.07),
                metric: Math.round(w * 0.09), label: Math.round(w * 0.027),
                stat: Math.round(w * 0.033), badge: Math.round(w * 0.027),
                sub: Math.round(w * 0.03), score: Math.round(w * 0.042) };

  const scoreStr = gameData
    ? `${gameData.homeTeam || '?'} ${gameData.homeScore}–${gameData.awayScore} ${gameData.awayTeam || '?'}`
    : '';

  const statItems = [
    ['K',    gameStats.kills || 0],
    ['E',    gameStats.errors || 0],
    ['TA',   gameStats.total_attacks || 0],
    ['HIT%', (gameStats.hit_pct ?? 0).toFixed(3)],
    ['A',    gameStats.assists || 0],
    ['D',    gameStats.digs || 0],
    ['SA',   gameStats.service_aces || 0],
    ['BS',   gameStats.block_solos || 0],
    ['BA',   gameStats.block_assists || 0],
    ['SE',   gameStats.service_errors || 0],
    ['RE',   gameStats.reception_errors || 0],
    ['BHE',  gameStats.ball_handling_errors || 0],
  ].filter(([, v]) => v !== 0 && v !== '0.000');

  return (
    <div style={{
      width: w, height: h, background: '#0f1624',
      display: 'flex', flexDirection: 'column',
      fontFamily: "'Barlow Condensed', sans-serif", overflow: 'hidden',
    }}>
      {/* Header strip */}
      <div style={{
        background: school.primary, padding: `${pad}px ${pad}px ${Math.round(pad * 0.7)}px`,
        flexShrink: 0,
      }}>
        <div style={{ fontSize: fs.sub, fontFamily: "'JetBrains Mono',monospace",
          color: hdrText, opacity: 0.75, letterSpacing: '0.1em', marginBottom: Math.round(fs.sub * 0.3),
          textTransform: 'uppercase' }}>
          {gameData?.date || ''}
          {gameData?.location ? ` · ${gameData.location}` : ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: Math.round(pad * 0.5), marginBottom: Math.round(fs.sub * 0.4) }}>
          <div style={{
            fontSize: fs.sub, fontWeight: 700, letterSpacing: '0.1em',
            color: hdrText, background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 3, padding: `${Math.round(fs.sub*0.25)}px ${Math.round(fs.sub*0.7)}px`,
          }}>
            {player.pos || player.position || '?'}
          </div>
          <div style={{ fontSize: fs.name, fontWeight: 900, color: hdrText,
            letterSpacing: '-0.01em', lineHeight: 1, textTransform: 'uppercase' }}>
            {player.name}
          </div>
        </div>
        {scoreStr && (
          <div style={{ fontSize: fs.score, fontWeight: 700, color: hdrText,
            opacity: 0.85, letterSpacing: '0.02em' }}>
            {scoreStr}
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, padding: `${Math.round(pad * 0.85)}px ${pad}px`,
        display: 'flex', flexDirection: 'column', gap: Math.round(pad * 0.6), overflow: 'hidden' }}>

        {/* GIS metrics */}
        <div style={{ display: 'flex', background: '#161e2e', border: '1px solid #1e2d45',
          borderRadius: 6, padding: `${Math.round(pad * 0.6)}px ${Math.round(pad * 0.75)}px`,
          justifyContent: 'space-around', flexShrink: 0 }}>
          {[
            { val: (gis ?? 0).toFixed(2),       lbl: 'GIS',  color: gColor },
            { val: (gisPlus ?? 0).toFixed(2),   lbl: 'GIS+', color: '#e879f9' },
            { val: pGIS != null ? pGIS.toFixed(2) : '—', lbl: 'pGIS', color: pColor, badge: pLabel },
          ].map(({ val, lbl, color, badge }) => (
            <div key={lbl} style={{ textAlign: 'center' }}>
              {badge && (
                <div style={{ fontSize: fs.badge, fontFamily: "'JetBrains Mono',monospace",
                  letterSpacing: '0.08em', color, border: `1px solid ${color}40`,
                  background: `${color}10`, borderRadius: 3, marginBottom: Math.round(fs.badge*0.4),
                  padding: `${Math.round(fs.badge*0.3)}px ${Math.round(fs.badge*0.9)}px`,
                  display: 'inline-block' }}>{badge}</div>
              )}
              <div style={{ fontSize: fs.metric, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
              <div style={{ fontSize: fs.label, fontFamily: "'JetBrains Mono',monospace",
                color: '#64748b', letterSpacing: '0.1em', marginTop: Math.round(fs.label*0.4) }}>{lbl}</div>
            </div>
          ))}
        </div>

        {/* Stat grid */}
        {statItems.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(statItems.length, 4)},1fr)`,
            gap: Math.round(pad * 0.4), flexShrink: 0 }}>
            {statItems.map(([lbl, val]) => (
              <div key={lbl} style={{ textAlign: 'center', background: '#161e2e',
                border: '1px solid #1e2d45', borderRadius: 4,
                padding: `${Math.round(pad * 0.35)}px` }}>
                <div style={{ fontSize: fs.stat, fontFamily: "'JetBrains Mono',monospace",
                  color: '#e2e8f0', fontWeight: 700 }}>{val}</div>
                <div style={{ fontSize: fs.label, fontFamily: "'JetBrains Mono',monospace",
                  color: '#64748b', marginTop: 2 }}>{lbl}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────
export default function ExportCardModal({
  mode,        // 'career' | 'game'
  player,
  // career
  allRecords,
  gameLogs,
  pgisTables,
  // game
  gameStats,
  gameData,
  onClose,
}) {
  const [cardType, setCardType]   = useState('transparent'); // 'transparent' | 'stylized'
  const [ratio, setRatio]         = useState('1:1');
  const [solidBg, setSolidBg]     = useState(false);
  const [exporting, setExporting] = useState(false);

  // Career: season selector
  const [selectedSeason, setSelectedSeason] = useState(
    allRecords?.[0]?.season || null
  );
  const currentRecord = allRecords?.find(r => r.season === selectedSeason) || allRecords?.[0];

  // Top games for stylized career card (sorted by stored pGIS desc)
  const topGames = (() => {
    if (mode !== 'career' || !currentRecord || !gameLogs) return [];
    const key = `${currentRecord.player.toLowerCase()}||${currentRecord.team.toLowerCase()}||${currentRecord.season}`;
    const entries = gameLogs[key] || [];
    return [...entries].sort((a, b) => (b[4] ?? 0) - (a[4] ?? 0));
  })();

  const availableRatios = cardType === 'transparent' ? TRANSPARENT_RATIOS : STYLIZED_RATIOS;
  // Ensure ratio is valid for the current card type
  const activeRatio = availableRatios.includes(ratio) ? ratio : availableRatios[0];

  const dims = DIMS[activeRatio];
  const scale = Math.min(PREVIEW_MAX / dims.w, PREVIEW_MAX / dims.h);

  const previewRef = useRef(null);

  const handleExport = useCallback(async () => {
    if (!previewRef.current || exporting) return;
    setExporting(true);
    try {
      const canvas = await html2canvas(previewRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: null,
        logging: false,
        width: dims.w,
        height: dims.h,
      });
      const link = document.createElement('a');
      const safeRatio = activeRatio.replace(':', 'x');
      if (mode === 'career') {
        const season = currentRecord?.season || 'career';
        link.download = `${player.name.replace(/\s+/g, '_')}_${season}_${cardType}_${safeRatio}.png`;
      } else {
        const opp  = (gameData?.opp || gameData?.awayTeam || 'opp').replace(/\s+/g, '_');
        const date = (gameData?.date || '').replace(/\//g, '-') || 'game';
        link.download = `${player.name.replace(/\s+/g, '_')}_vs_${opp}_${date}_${cardType}_${safeRatio}.png`;
      }
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (e) {
      console.error('Export failed:', e);
    }
    setExporting(false);
  }, [previewRef, exporting, dims, activeRatio, mode, player, currentRecord, gameData, cardType]);

  // Stop bg scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Resolve values for transparent mode
  const gis    = mode === 'career'
    ? (currentRecord?.gis_per_set ?? 0)
    : (gameStats?.gis ?? 0);
  const gisPlus = mode === 'career'
    ? (currentRecord?.gis_plus_per_set ?? 0)
    : (gameStats?.gisPlus ?? 0);
  const pGIS   = mode === 'career'
    ? computeArchivePGIS(currentRecord, pgisTables)
    : (gameStats?.pGIS ?? null);

  const renderCard = () => {
    if (cardType === 'transparent') {
      return (
        <TransparentCard
          dims={dims}
          player={player}
          gis={gis}
          gisPlus={gisPlus}
          pGIS={pGIS}
          solidBg={solidBg}
        />
      );
    }
    if (mode === 'career') {
      return (
        <StylizedCareerCard
          dims={dims}
          player={player}
          record={currentRecord}
          topGames={topGames}
          pgisTables={pgisTables}
        />
      );
    }
    return (
      <StylizedGameCard
        dims={dims}
        player={{ ...player, pos: player.pos || player.position }}
        gameStats={gameStats}
        gameData={gameData}
      />
    );
  };

  return createPortal(
    <div className="export-modal-wrap" onClick={onClose}>
      <div className="export-modal-panel" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800, fontSize: '1.1rem' }}>
            Export Card — {player.name}
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Card type tabs */}
        <div className="export-modal-tabs">
          {['transparent', 'stylized'].map(t => (
            <button
              key={t}
              className={`sb-view-btn ${cardType === t ? 'active' : ''}`}
              onClick={() => setCardType(t)}
            >
              {t === 'transparent' ? 'Transparent' : 'Stylized'}
            </button>
          ))}
          {cardType === 'transparent' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem',
              fontFamily: "'JetBrains Mono',monospace", fontSize: '0.62rem', color: 'var(--muted)',
              cursor: 'pointer', marginLeft: 'auto' }}>
              <input type="checkbox" checked={solidBg} onChange={e => setSolidBg(e.target.checked)}
                style={{ cursor: 'pointer' }} />
              Solid BG
            </label>
          )}
        </div>

        {/* Season selector (career mode) */}
        {mode === 'career' && allRecords && allRecords.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.62rem', color: 'var(--muted)' }}>
              Season:
            </span>
            <div className="export-modal-ratios">
              {allRecords.map(r => (
                <button
                  key={r.season}
                  className={`sb-view-btn ${selectedSeason === r.season ? 'active' : ''}`}
                  onClick={() => setSelectedSeason(r.season)}
                >
                  {r.season}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Aspect ratio */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.62rem', color: 'var(--muted)' }}>
            Ratio:
          </span>
          <div className="export-modal-ratios">
            {availableRatios.map(r => (
              <button
                key={r}
                className={`sb-view-btn ${activeRatio === r ? 'active' : ''}`}
                onClick={() => setRatio(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        <div className="export-preview-wrap">
          <div
            className="export-preview-inner"
            style={{ transform: `scale(${scale})`, width: dims.w, height: dims.h }}
          >
            <div ref={previewRef} style={{ width: dims.w, height: dims.h, overflow: 'hidden' }}>
              {renderCard()}
            </div>
          </div>
        </div>

        {/* Export button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="export-export-btn"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'EXPORTING…' : '↓ EXPORT PNG'}
          </button>
        </div>

      </div>
    </div>,
    document.body
  );
}
