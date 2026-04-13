import { useState } from 'react';
import GameReport from './GameReport.jsx';
import { useData } from '../lib/DataContext.jsx';
import {
  PROXY_BASE, extractId, extractGameMeta,
  normaliseBoxscore, normalisePbp, scoringSumFromPbp, scoringSumFromBoxscore,
  computeGIS,
} from '../lib/gis.js';

function getMockData() {
  return {
    boxscore: { teams: [
      { teamName: 'Arkansas State', teamId: '22', homeAway: 'home', score: '3', players: [
        {name:'Erica Haralson',  position:'OH', sets:4, kills:14, errors:5, total_attacks:38, hit_pct:0.237, assists:1,  service_aces:2, service_errors:1, reception_errors:1, digs:14, block_solos:0, block_assists:2, ball_handling_errors:0},
        {name:'Brooke Smith',    position:'MB', sets:4, kills:8,  errors:2, total_attacks:17, hit_pct:0.353, assists:0,  service_aces:0, service_errors:0, reception_errors:0, digs:2,  block_solos:1, block_assists:5, ball_handling_errors:0},
        {name:'Lilly Kotlarz',   position:'S',  sets:4, kills:2,  errors:1, total_attacks:8,  hit_pct:0.125, assists:40, service_aces:3, service_errors:2, reception_errors:0, digs:9,  block_solos:0, block_assists:2, ball_handling_errors:2},
        {name:'Mady Farris',     position:'RS', sets:4, kills:10, errors:4, total_attacks:24, hit_pct:0.250, assists:1,  service_aces:1, service_errors:3, reception_errors:0, digs:4,  block_solos:1, block_assists:2, ball_handling_errors:0},
        {name:'Avery Pemberton', position:'OH', sets:4, kills:11, errors:6, total_attacks:30, hit_pct:0.167, assists:2,  service_aces:0, service_errors:2, reception_errors:2, digs:10, block_solos:0, block_assists:1, ball_handling_errors:0},
        {name:'Jordan Darby',    position:'MB', sets:3, kills:6,  errors:1, total_attacks:13, hit_pct:0.385, assists:0,  service_aces:1, service_errors:0, reception_errors:0, digs:1,  block_solos:2, block_assists:2, ball_handling_errors:0},
        {name:'Payton Chamblee', position:'L',  sets:4, kills:0,  errors:0, total_attacks:0,  hit_pct:0.000, assists:2,  service_aces:1, service_errors:0, reception_errors:2, digs:21, block_solos:0, block_assists:0, ball_handling_errors:0},
        {name:'Kayla Caffey',    position:'DS', sets:2, kills:0,  errors:0, total_attacks:0,  hit_pct:0.000, assists:0,  service_aces:0, service_errors:1, reception_errors:0, digs:6,  block_solos:0, block_assists:0, ball_handling_errors:0},
      ]},
      { teamName: 'Southern Miss', teamId: '590', homeAway: 'away', score: '1', players: [
        {name:'Kylie Dobbins',    position:'OH', sets:4, kills:12, errors:4, total_attacks:32, hit_pct:0.250, assists:1, service_aces:1, service_errors:2, reception_errors:1, digs:8,  block_solos:0, block_assists:2, ball_handling_errors:0},
        {name:'Kaitlyn Dowd',     position:'MB', sets:3, kills:6,  errors:2, total_attacks:14, hit_pct:0.286, assists:0, service_aces:0, service_errors:1, reception_errors:0, digs:1,  block_solos:1, block_assists:4, ball_handling_errors:0},
        {name:'Avery Dedering',   position:'S',  sets:4, kills:1,  errors:1, total_attacks:6,  hit_pct:0.000, assists:32, service_aces:1, service_errors:3, reception_errors:0, digs:7, block_solos:0, block_assists:1, ball_handling_errors:1},
        {name:'Mallory Adams',    position:'OH', sets:4, kills:9,  errors:5, total_attacks:28, hit_pct:0.143, assists:2, service_aces:2, service_errors:1, reception_errors:2, digs:11, block_solos:0, block_assists:1, ball_handling_errors:0},
        {name:'Haley Barrett',    position:'RS', sets:4, kills:7,  errors:3, total_attacks:18, hit_pct:0.222, assists:0, service_aces:0, service_errors:2, reception_errors:0, digs:3,  block_solos:0, block_assists:3, ball_handling_errors:0},
        {name:'Chloe Stull',      position:'MB', sets:3, kills:5,  errors:1, total_attacks:11, hit_pct:0.364, assists:0, service_aces:0, service_errors:0, reception_errors:0, digs:1,  block_solos:2, block_assists:3, ball_handling_errors:0},
        {name:'Laney Gremillion', position:'L',  sets:4, kills:0,  errors:0, total_attacks:0,  hit_pct:0.000, assists:1, service_aces:0, service_errors:0, reception_errors:3, digs:17, block_solos:0, block_assists:0, ball_handling_errors:1},
        {name:'Taylor Shields',   position:'DS', sets:2, kills:0,  errors:0, total_attacks:0,  hit_pct:0.000, assists:0, service_aces:0, service_errors:0, reception_errors:1, digs:5,  block_solos:0, block_assists:0, ball_handling_errors:0},
      ]},
    ]},
    scoring_summary: {
      finalHomeScore: 3, finalAwayScore: 1,
      periods: [
        {periodNumber:1, homeScore:27, awayScore:25, winner:'home'},
        {periodNumber:2, homeScore:25, awayScore:18, winner:'home'},
        {periodNumber:3, homeScore:20, awayScore:25, winner:'away'},
        {periodNumber:4, homeScore:25, awayScore:18, winner:'home'},
      ],
    },
    play_by_play: null,
  };
}

export default function GameLookup() {
  const { rpiByYear, pgisTables, categoryPgisTables, loading: dataLoading } = useData();
  const [input, setInput]   = useState('');
  const [status, setStatus] = useState(null); // null | {type, msg}
  const [report, setReport] = useState(null); // null | {gameId, mg, isMock}
  const [busy, setBusy]     = useState(false);

  async function runGIS() {
    const gameId = extractId(input);
    if (!gameId) {
      setStatus({ type: 'error', msg: 'Please enter a valid game ID (e.g. <code>6481347</code>) or paste an ncaa.com game URL.' });
      return;
    }

    setBusy(true);
    setReport(null);
    setStatus({ type: 'loading', msg: `Fetching game ${gameId} from NCAA…` });

    let rawData, isMock = false;
    try {
      const [boxscore, pbp, ss, summary] = await Promise.all([
        fetch(`${PROXY_BASE}/game/${gameId}/boxscore`, { signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null),
        fetch(`${PROXY_BASE}/game/${gameId}/play-by-play`, { signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null),
        fetch(`${PROXY_BASE}/game/${gameId}/scoring-summary`, { signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null),
        fetch(`${PROXY_BASE}/game/${gameId}/`, { signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null),
      ]);
      rawData = { boxscore, play_by_play: pbp, scoring_summary: ss, summary };
      if (!rawData.boxscore) throw new Error('No boxscore returned');
    } catch (e) {
      setStatus({ type: 'error', msg: `Could not fetch game ${gameId}. Check the ID and try again.<br/><small>${e.message}</small>` });
      setBusy(false);
      return;
    }

    setStatus({ type: 'loading', msg: 'Computing GIS scores…' });

    try {
      const bs     = normaliseBoxscore(rawData.boxscore);
      const pbpRaw = rawData.play_by_play || null;

      let ss = null;
      if (rawData.scoring_summary?.periods?.length > 0) ss = rawData.scoring_summary;
      if (!ss && pbpRaw) ss = scoringSumFromPbp(pbpRaw);
      if (!ss && rawData.boxscore) ss = scoringSumFromBoxscore(rawData.boxscore);

      const pbp = normalisePbp(pbpRaw);

      if (!bs || !(bs.teams || []).some(t => (t.players || []).length > 0)) {
        setStatus({ type: 'error', msg: `No player data found for game ${gameId}.` });
        setBusy(false);
        return;
      }

      const mg = computeGIS(bs, ss, pbp, gameId, rpiByYear, pgisTables);
      const { gameDate, gameLocation } = extractGameMeta(rawData);
      mg.gameDate     = gameDate;
      mg.gameLocation = gameLocation;

      setStatus(null);
      setReport({ gameId, mg, isMock });
    } catch (e) {
      setStatus({ type: 'error', msg: `GIS error: ${e.message}` });
    }
    setBusy(false);
  }

  // Load demo on mount if no proxy (shouldn't happen, but keep parity)
  const showHero = !report;

  return (
    <>
      {showHero && (
        <div className="hero">
          <div className="hero-eyebrow">NCAA D1 Women's Volleyball</div>
          <div className="hero-title">Game Impact Score</div>
          <div className="hero-sub">
            Enter a game ID or paste an ncaa.com game URL to compute GIS, GIS+, and pGIS for every player.
          </div>
          <div className="search-wrap">
            <input
              className="search-input"
              placeholder="Game ID or ncaa.com/game/… URL"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !busy && runGIS()}
              autoFocus
            />
            <button className="search-btn" disabled={busy || dataLoading} onClick={runGIS}>
              {busy ? 'LOADING…' : 'COMPUTE'}
            </button>
          </div>
          <div className="search-hint">
            e.g. <code>6481347</code> or <code>ncaa.com/game/6481347/…</code>
          </div>
        </div>
      )}

      {!showHero && (
        <div style={{ maxWidth: 640, margin: '1.5rem auto 0', padding: '0 1.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            className="search-input"
            style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.4rem 0.8rem' }}
            placeholder="New game ID or URL"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !busy && runGIS()}
          />
          <button className="search-btn" disabled={busy || dataLoading} onClick={runGIS}>
            {busy ? 'LOADING…' : 'COMPUTE'}
          </button>
        </div>
      )}

      {status && (
        <div className="status-wrap">
          <div className={`status ${status.type}`}>
            {status.type === 'loading' && <div className="spinner" />}
            <span dangerouslySetInnerHTML={{ __html: status.msg }} />
          </div>
        </div>
      )}

      {report && (
        <GameReport
          gameId={report.gameId}
          mg={report.mg}
          isMock={report.isMock}
          rpiByYear={rpiByYear}
          categoryPgisTables={categoryPgisTables}
        />
      )}
    </>
  );
}
