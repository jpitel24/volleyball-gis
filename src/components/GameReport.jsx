import { useEffect, useRef, useState } from 'react';
import PlayerCard from './PlayerCard.jsx';
import PlayerModal from './PlayerModal.jsx';
import { findRPIValue, rpiToRank, seasonFromGameId } from '../lib/gis.js';

// A player "participated" if they have any non-zero counting stat line.
// Matches the per-card visibility rule (p.gis > 0) used in TeamSection.
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

function TeamSection({ mg, teamName, teamNameFull, side, matchRanks, gameId, rpiByYear, onSelect }) {
  const players = mg.players
    .filter(p => p.team === teamName && p.gis > 0)
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
    .filter(p => p.gis > 0)
    .sort((a, b) => (b.pGIS ?? b.gisPlus) - (a.pGIS ?? a.gisPlus))
    .forEach((p, i) => matchRanks.set(p, i + 1));

  const activeCount = mg.players.filter(hasStatLine).length;
  const hasPGIS     = mg.players.some(p => p.pGIS !== null);

  return (
    <div className="report" ref={ref}>
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

      <TeamSection
        mg={mg} teamName={mg.homeTeam} teamNameFull={mg.homeTeamFull}
        side="home" matchRanks={matchRanks} gameId={gameId}
        rpiByYear={rpiByYear} onSelect={setSelectedPlayer}
      />
      <TeamSection
        mg={mg} teamName={mg.awayTeam} teamNameFull={mg.awayTeamFull}
        side="away" matchRanks={matchRanks} gameId={gameId}
        rpiByYear={rpiByYear} onSelect={setSelectedPlayer}
      />

      {selectedPlayer && (
        <PlayerModal
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
