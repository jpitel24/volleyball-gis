import { useEffect, useRef, useState } from 'react';
import PlayerCard from './PlayerCard.jsx';
import PlayerInspector from './PlayerInspector.jsx';
import { findRPIValue, rpiToRank, seasonFromGameId, computeCategoryGIS, CATEGORIES } from '../lib/gis.js';
import { getSchoolColors } from '../data/schoolColors.js';

// A player "participated" if they have any non-zero counting stat line.
// This is the visibility predicate for the roster grid and tug-of-war —
// we want players who took the floor even if their net GIS was negative
// (e.g. an OH who ran the full rotation but shot .100 on a rough night).
function hasStatLine(p) {
  return (
    (p.kills || 0) + (p.assists || 0) + (p.digs || 0) +
    (p.service_aces || 0) + (p.block_solos || 0) + (p.block_assists || 0) +
    (p.errors || 0) + (p.service_errors || 0) + (p.reception_errors || 0) +
    (p.blocking_errors || 0) + (p.ball_handling_errors || 0) +
    (p.total_attacks || 0) + (p.serve_attempts || 0) +
    (p.reception_attempts || 0) + (p.set_attempts || 0)
  ) > 0;
}

// Tug-of-war chart: per-category team-vs-team comparison. Sums each
// player's per-set computeCategoryGIS contribution × player.ns to get
// per-match category GIS, summed across the two team rosters. Each row
// is scaled to its own max (per-row scaling) so a category that's
// volume-light (e.g. Serving) reads "who won" as cleanly as a
// volume-heavy one (Attack). Bars use each team's brand primary color.
function TugOfWar({ mg }) {
  const home = mg.homeTeam;
  const away = mg.awayTeam;
  const homeColors = getSchoolColors(home);
  const awayColors = getSchoolColors(away);

  // Per-team category totals in per-match units.
  const totals = { [home]: {}, [away]: {} };
  for (const p of mg.players) {
    if (!p || !hasStatLine(p)) continue;
    const team = p.team;
    if (team !== home && team !== away) continue;
    const cats = computeCategoryGIS(p, p.ns, p.avgLev, p.oppMod);
    for (const c of cats) {
      totals[team][c.key] = (totals[team][c.key] || 0) + c.gis * p.ns;
    }
  }

  const rows = CATEGORIES.map(({ key, label }) => {
    const h = totals[home][key] || 0;
    const a = totals[away][key] || 0;
    const max = Math.max(h, a, 0.0001);
    return {
      key, label,
      h, a,
      hPct: (h / max) * 100,
      aPct: (a / max) * 100,
      homeWon: h > a + 1e-6,
      awayWon: a > h + 1e-6,
    };
  });

  return (
    <section className="tug-of-war">
      <div className="tug-header">
        <div className="tug-team-name" style={{ color: homeColors.primary }}>{home}</div>
        <div className="tug-vs">CATEGORY GIS</div>
        <div className="tug-team-name" style={{ color: awayColors.primary }}>{away}</div>
      </div>
      <div className="tug-rows">
        {rows.map(r => (
          <div key={r.key} className="tug-row">
            <div className="tug-label">{r.label}</div>
            <div className="tug-bars">
              <div className={`tug-val tug-val-home${r.homeWon ? ' tug-win' : ''}`}>{r.h.toFixed(1)}</div>
              <div className="tug-track tug-track-home">
                <div className="tug-bar" style={{ width: `${r.hPct}%`, background: homeColors.primary }} />
              </div>
              <div className="tug-axis" />
              <div className="tug-track tug-track-away">
                <div className="tug-bar" style={{ width: `${r.aPct}%`, background: awayColors.primary }} />
              </div>
              <div className={`tug-val tug-val-away${r.awayWon ? ' tug-win' : ''}`}>{r.a.toFixed(1)}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TeamSection({ mg, teamName, teamNameFull, side, matchRanks, gameId, rpiByYear, onSelect, selectedPlayer }) {
  const players = mg.players
    .filter(p => p.team === teamName && hasStatLine(p))
    .sort((a, b) => (b.pGIS ?? b.gisPlus) - (a.pGIS ?? a.gisPlus));

  if (!players.length) return null;

  const isWinner     = (side === 'home' && mg.hW > mg.aW) || (side === 'away' && mg.aW > mg.hW);
  const totalGIS     = players.reduce((s, p) => s + p.gis, 0);
  const totalGISPlus = players.reduce((s, p) => s + p.gisPlus, 0);
  const validPGIS    = players.filter(p => p.pGIS !== null).sort((a, b) => b.pGIS - a.pGIS);
  const rotationPGIS = validPGIS.length
    ? validPGIS.slice(0, 7).reduce((s, p) => s + p.pGIS, 0) / Math.min(validPGIS.length, 7)
    : null;
  // Prefer the explicit mg.season (set from the year dropdown) over the
  // gameId-range guess — that heuristic misbuckets games at season
  // boundaries when ContestIDs don't match the calibrated thresholds.
  const gameSeason = mg.season || seasonFromGameId(gameId || 0);
  const ownRpiVal  = findRPIValue(teamNameFull, teamName, gameId, rpiByYear, gameSeason);
  const ownRank    = rpiToRank(ownRpiVal, gameSeason, rpiByYear);
  // Opponent-modifier string removed: GIS+ now bakes in opp mod + efficiency
  // + set leverage, so surfacing the raw mod alongside the totals is noise.

  // Build gameData object to pass down to each PlayerCard for export
  const gameData = {
    opp:       side === 'home' ? mg.awayTeam : mg.homeTeam,
    homeTeam:  mg.homeTeam,
    awayTeam:  mg.awayTeam,
    homeScore: mg.hW,
    awayScore: mg.aW,
    date:      mg.gameDate,
    location:  mg.gameLocation,
    nSets:     mg.nSets,
    playerTeam: teamName,
  };

  return (
    <section className="team-section">
      <div className="team-hdr">
        <div className="team-hdr-left">
          {ownRank && <span className="rpi-rank-badge">RPI #{ownRank}</span>}
          <div className="team-name-lbl">
            {teamName}
            {isWinner && <span className="winner-crown">🏆 WINNER</span>}
          </div>
        </div>
        <div className="team-totals">
          <span>GIS: <strong>{totalGIS.toFixed(2)}</strong></span>
          <span>GIS+: <strong className="t-gp">{totalGISPlus.toFixed(2)}</strong></span>
          {rotationPGIS !== null && (
            <span>Rotation pGIS: <strong className="t-pg">{rotationPGIS.toFixed(2)}</strong></span>
          )}
        </div>
      </div>
      <div className="pgrid">
        {players.map(p => (
          <PlayerCard
            key={p.name}
            p={p}
            rank={matchRanks.get(p)}
            animDelay={matchRanks.get(p) * 35}
            onSelect={onSelect}
            gameData={gameData}
            isSelected={selectedPlayer === p}
          />
        ))}
      </div>
    </section>
  );
}

export default function GameReport({ gameId, mg, isMock, rpiByYear, categoryPgisTables }) {
  const ref = useRef(null);
  const [selectedPlayer, setSelectedPlayer] = useState(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [mg]);

  const matchRanks = new Map();
  [...mg.players]
    .filter(hasStatLine)
    .sort((a, b) => (b.pGIS ?? b.gisPlus) - (a.pGIS ?? a.gisPlus))
    .forEach((p, i) => matchRanks.set(p, i + 1));

  const activeCount = mg.players.filter(hasStatLine).length;
  const hasPGIS     = mg.players.some(p => p.pGIS !== null);

  // Toggle: clicking the already-selected card closes the inspector.
  // Otherwise it swaps to the new player.
  function handleSelectPlayer(p) {
    setSelectedPlayer(prev => prev === p ? null : p);
  }

  return (
    <div className={`report${selectedPlayer ? ' report-with-inspector' : ''}`} ref={ref}>
      <div className="rpt-header">
        <div className="rpt-eyebrow">
          NCAA D1 Women's Volleyball · Game {gameId}
          {isMock && <span style={{ color: '#fb923c', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.65rem' }}> · DEMO DATA</span>}
          {mg.gameDate && ` · ${mg.gameDate}`}
          {mg.gameLocation && ` · ${mg.gameLocation}`}
        </div>
        <div className="rpt-title">{mg.result}</div>
        <div className="meta-row">
          <span className="meta-chip">Sets <strong>{mg.nSets}</strong></span>
          <span className="meta-chip">Players <strong>{activeCount}</strong></span>
          {mg.gameDate && <span className="meta-chip">{mg.gameDate}</span>}
          {mg.gameLocation && <span className="meta-chip">{mg.gameLocation}</span>}
          {hasPGIS && (
            <span className="meta-chip" style={{ borderColor: '#fb923c30', background: '#fb923c08', color: 'var(--pgis)' }}>
              pGIS <strong style={{ color: 'var(--pgis)' }}>active</strong>
            </span>
          )}
        </div>
        {!mg.scoresUnknown && mg.periods.length > 0 && (
          <div className="set-chips">
            {mg.periods.map((p, i) => (
              <span key={i} className="set-chip">
                <span className="set-chip-label">SET {i+1}</span>
                <span>{p.homeScore}–{p.awayScore}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="formula-bar">
        <div className="formula-lines">
          <div className="formula-eq">
            <strong>GIS</strong> — volume &amp; leverage of positive actions per set, penalized for errors.
          </div>
          <div className="formula-eq">
            <strong className="gp">GIS+</strong> — GIS adjusted for opponent strength (RPI).
          </div>
          <div className="formula-eq">
            <strong className="pg">pGIS</strong> — 0–10 percentile score vs D1 peers at the same position.
          </div>
        </div>
      </div>

      <TugOfWar mg={mg} />

      <TeamSection
        mg={mg} teamName={mg.homeTeam} teamNameFull={mg.homeTeamFull}
        side="home" matchRanks={matchRanks} gameId={gameId}
        rpiByYear={rpiByYear} onSelect={handleSelectPlayer} selectedPlayer={selectedPlayer}
      />
      <TeamSection
        mg={mg} teamName={mg.awayTeam} teamNameFull={mg.awayTeamFull}
        side="away" matchRanks={matchRanks} gameId={gameId}
        rpiByYear={rpiByYear} onSelect={handleSelectPlayer} selectedPlayer={selectedPlayer}
      />

      {selectedPlayer && (
        <PlayerInspector
          p={selectedPlayer}
          onClose={() => setSelectedPlayer(null)}
          nSets={mg.nSets}
          categoryPgisTables={categoryPgisTables}
        />
      )}

      <div className="rpt-footer">
        Game {gameId}<br />
        pGIS tiers: ELITE ≥9.5 · IMPACT ≥8.5 · SOLID ≥7.5 · GOOD ≥6.0 · AVG ≥4.0 · BELOW ≥2.0 · LTD &lt;2<br />
        pGIS baseline derived from all D1 matches between 2022 and 2025
      </div>
    </div>
  );
}
