import { useEffect, useRef, useState } from 'react';
import PlayerCard from './PlayerCard.jsx';
import PlayerModal from './PlayerModal.jsx';
import { findRPIValue, rpiToRank, seasonFromGameId } from '../lib/gis.js';

const WEIGHTS = [
  ['Kill','1.00','#38bdf8'],
  ['Ace','1.20','#f43f5e'],
  ['Block Solo','1.10','#a78bfa'],
  ['Assist','0.28','#4ade80'],
  ['Block Assist','0.50','#a78bfa'],
  ['Dig','0.35','#facc15'],
];

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
  const oppMod  = side === 'home' ? mg.homeOppMod : mg.awayOppMod;
  const oppRank = side === 'home' ? mg.homeOppRank : mg.awayOppRank;

  const gameSeason = seasonFromGameId(gameId || 0);
  const ownRpiVal  = findRPIValue(teamNameFull, teamName, gameId, rpiByYear);
  const ownRank    = rpiToRank(ownRpiVal, gameSeason, rpiByYear);
  const oppStr     = oppRank
    ? `${oppMod >= 1 ? '+' : ''}${((oppMod-1)*100).toFixed(1)}% opp mod`
    : 'RPI unavailable';

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
          <span className="opp-ctx" style={{ color: oppRank ? 'inherit' : 'var(--muted)' }}>
            {oppStr}
          </span>
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

  const pbpCount = mg.players.filter(p => p.levPlays > 0).length;
  const hasPGIS  = mg.players.some(p => p.pGIS !== null);

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
          <span className="meta-chip">Match lev <strong>{mg.ml.toFixed(2)}×</strong></span>
          <span className="meta-chip">Players <strong>{mg.players.length}</strong></span>
          <span className="meta-chip">PBP lev <strong>{pbpCount}/{mg.players.length}</strong></span>
          {mg.gameDate && <span className="meta-chip">{mg.gameDate}</span>}
          {mg.gameLocation && <span className="meta-chip">{mg.gameLocation}</span>}
          {mg.hasRPI
            ? <span className="meta-chip gp">GIS+ <strong>active</strong></span>
            : <span className="meta-chip">GIS+ <strong style={{ color: 'var(--muted)' }}>RPI N/A</strong></span>
          }
          {hasPGIS && (
            <span className="meta-chip" style={{ borderColor: '#fb923c30', background: '#fb923c08', color: 'var(--pgis)' }}>
              pGIS <strong style={{ color: 'var(--pgis)' }}>active</strong>
            </span>
          )}
        </div>
        <div className="set-chips">
          {mg.periods.map((p, i) => {
            const score = mg.scoresUnknown || (p.homeScore === 0 && p.awayScore === 0)
              ? '—' : `${p.homeScore}–${p.awayScore}`;
            return (
              <span key={i} className="set-chip">
                <span className="set-chip-label">SET {i+1}</span>
                <span>{score}</span>
              </span>
            );
          })}
        </div>
      </div>

      <div className="formula-bar">
        <div className="formula-bar-label">POSITIVE ACTION WEIGHTS</div>
        <div className="wchips">
          {WEIGHTS.map(([n, v, c]) => (
            <span key={n} className="wchip">
              <span style={{ color: c }}>{n}</span>
              <span className="wchip-v">{v}</span>
            </span>
          ))}
        </div>
        <div className="formula-lines">
          <div className="formula-eq">
            GIS = <em>(Volume/Set × Leverage)</em> × <em>Error Penalty</em> × <em>1.25</em>
          </div>
          <div className="formula-eq">
            GIS+ = <em className="gp">GIS × Opponent RPI modifier</em>
            &nbsp;·&nbsp; modifier = 1 + (rpi_value − 0.500) × 0.63 &nbsp;·&nbsp; neutral at RPI 0.500
          </div>
          <div className="formula-eq">
            pGIS = <em className="pg">power curve percentile of opponent-adjusted per-set efficiency vs D1 peers at same position</em>
          </div>
        </div>
        {/* pGIS info card — clean primary + benchmark lines */}
        <div className="formula-note">
          <div className="formula-note-primary">
            <span>pGIS</span> = Positional GIS · Hard Scale 0–10
          </div>
          <div className="formula-note-benchmarks">
            Top 1% ≥ 9.80 &nbsp;·&nbsp; Top 5% ≥ 9.03 &nbsp;·&nbsp; Top 10% ≥ 8.10 &nbsp;·&nbsp; Top 25% ≥ 5.63
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
        Game {gameId} · GIS tiers: ELITE ≥10 · IMPACT ≥7 · SOLID ≥4.5 · PRESENT ≥2.5 · LIMITED &lt;2.5<br />
        pGIS tiers: ELITE ≥9.5 · IMPACT ≥8.5 · SOLID ≥7.5 · GOOD ≥6.0 · AVG ≥4.0 · BELOW ≥2.0 · LTD &lt;2<br />
        pGIS baseline derived from all D1 matches between 2022 and 2025
      </div>
    </div>
  );
}
