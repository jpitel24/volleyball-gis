import { useState, useMemo, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import GameReport from './GameReport.jsx';
import { useData } from '../lib/DataContext.jsx';
import {
  PROXY_BASE, extractId, extractGameMeta,
  normaliseBoxscore, normalisePbp, scoringSumFromPbp, scoringSumFromBoxscore,
  computeGIS,
} from '../lib/gis.js';

// ── Display name helper ───────────────────────────────────────────────────────
// Build lowercase-team-key → display-name map by reading opponent names
// from game_logs entries (opponent names carry original API casing, e.g. "LSU", "NC State")
function buildDisplayMap(gameLogs) {
  const map = new Map();
  if (!gameLogs) return map;
  for (const entries of Object.values(gameLogs)) {
    for (const e of entries) {
      const opp = e[1];
      if (opp && !map.has(opp.toLowerCase())) map.set(opp.toLowerCase(), opp);
    }
  }
  return map;
}

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
  const { rpiByYear, pgisTables, categoryPgisTables, gameLogs, playerArchive, loading: dataLoading } = useData();
  const location = useLocation();
  const [input, setInput]   = useState('');
  const [status, setStatus] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy]     = useState(false);

  // Browse mode state
  const [mode, setMode]               = useState('id');   // 'id' | 'browse'
  const [browseYear, setBrowseYear]   = useState('2025');
  const [teamSearch, setTeamSearch]   = useState('');
  const [selectedTeam, setSelectedTeam] = useState(null); // { key, display }
  const [showSuggestions, setShowSuggestions] = useState(false);
  const teamInputRef = useRef(null);
  const suggestionsRef = useRef(null);

  // Auto-load game from router navigation state (Change 5)
  useEffect(() => {
    if (location.state?.gameId) {
      loadGame(location.state.gameId); // eslint-disable-line react-hooks/exhaustive-deps
      window.history.replaceState({}, '');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve available years from gameLogs
  const availableYears = useMemo(() => {
    if (!gameLogs) return ['2025', '2024', '2023', '2022'];
    const years = new Set();
    for (const key of Object.keys(gameLogs)) years.add(key.split('||')[2]);
    return [...years].sort((a, b) => b - a);
  }, [gameLogs]);

  // Build display name map once from opponent references
  const displayMap = useMemo(() => buildDisplayMap(gameLogs), [gameLogs]);

  function displayName(teamKey) {
    return displayMap.get(teamKey) || teamKey.replace(/\b\w/g, c => c.toUpperCase());
  }

  // All teams for the selected browse year — sourced from playerArchive for full coverage
  const teamsForYear = useMemo(() => {
    if (!playerArchive) return [];
    const records = playerArchive.seasons?.[browseYear] || [];
    const seen = new Set();
    const teams = [];
    for (const r of records) {
      if (!seen.has(r.team)) { seen.add(r.team); teams.push(r.team); }
    }
    return teams.sort((a, b) => a.localeCompare(b));
  }, [playerArchive, browseYear]);

  // Filtered suggestions while typing
  const suggestions = useMemo(() => {
    const list = teamsForYear;
    if (!teamSearch.trim()) return list.slice(0, 8);
    const q = teamSearch.toLowerCase();
    return list.filter(t => t.toLowerCase().includes(q)).slice(0, 12);
  }, [teamsForYear, teamSearch]);

  // Games for the selected team in the selected year, deduplicated and sorted by gameId
  const gamesForTeam = useMemo(() => {
    if (!gameLogs || !selectedTeam) return [];
    const gameMap = new Map();
    for (const [key, entries] of Object.entries(gameLogs)) {
      const parts = key.split('||');
      if (parts[2] !== browseYear || parts[1] !== selectedTeam.key) continue;
      for (const e of entries) {
        if (!gameMap.has(e[0])) gameMap.set(e[0], { gameId: e[0], opp: e[1], nSets: e[2] });
      }
    }
    return [...gameMap.values()].sort((a, b) => String(a.gameId).localeCompare(String(b.gameId)));
  }, [gameLogs, browseYear, selectedTeam]);

  // Close suggestions on outside click
  useEffect(() => {
    function onDown(e) {
      if (
        teamInputRef.current && !teamInputRef.current.contains(e.target) &&
        suggestionsRef.current && !suggestionsRef.current.contains(e.target)
      ) setShowSuggestions(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Reset browse state when switching years
  function switchYear(y) {
    setBrowseYear(y);
    setSelectedTeam(null);
    setTeamSearch('');
  }

  function pickTeam(displayName) {
    setSelectedTeam({ key: displayName.toLowerCase(), display: displayName });
    setTeamSearch('');
    setShowSuggestions(false);
  }

  // ── Core game fetch ───────────────────────────────────────────────────────
  async function loadGame(gameId) {
    if (!gameId) return;
    setBusy(true);
    setReport(null);
    setStatus({ type: 'loading', msg: `Fetching game ${gameId} from NCAA…` });

    let rawData;
    try {
      const [boxscore, pbp, ss] = await Promise.all([
        fetch(`${PROXY_BASE}/game/${gameId}/boxscore`,        { signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null),
        fetch(`${PROXY_BASE}/game/${gameId}/play-by-play`,    { signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null),
        fetch(`${PROXY_BASE}/game/${gameId}/scoring-summary`, { signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null),
      ]);
      rawData = { boxscore, play_by_play: pbp, scoring_summary: ss };
      if (!rawData.boxscore) throw new Error('No boxscore returned');
    } catch (e) {
      setStatus({ type: 'error', msg: `Could not fetch game ${gameId}. Check the ID and try again.<br/><small>${e.message}</small>` });
      setBusy(false);
      return;
    }

    setStatus({ type: 'loading', msg: 'Computing GIS scores…' });

    try {
      const bs  = normaliseBoxscore(rawData.boxscore);
      const pbpRaw = rawData.play_by_play || null;

      let scoringSummary = null;
      if (rawData.scoring_summary?.periods?.length > 0) scoringSummary = rawData.scoring_summary;
      if (!scoringSummary && pbpRaw) scoringSummary = scoringSumFromPbp(pbpRaw);
      if (!scoringSummary && rawData.boxscore) scoringSummary = scoringSumFromBoxscore(rawData.boxscore);

      const pbp = normalisePbp(pbpRaw);

      if (!bs || !(bs.teams || []).some(t => (t.players || []).length > 0)) {
        setStatus({ type: 'error', msg: `No player data found for game ${gameId}.` });
        setBusy(false);
        return;
      }

      const mg = computeGIS(bs, scoringSummary, pbp, gameId, rpiByYear, pgisTables);
      const { gameDate, gameLocation } = extractGameMeta(rawData);
      mg.gameDate     = gameDate;
      mg.gameLocation = gameLocation;

      setStatus(null);
      setReport({ gameId, mg });
    } catch (e) {
      setStatus({ type: 'error', msg: `GIS error: ${e.message}` });
    }
    setBusy(false);
  }

  async function runGIS() {
    const gameId = extractId(input);
    if (!gameId) {
      setStatus({ type: 'error', msg: 'Please enter a valid game ID (e.g. <code>6481347</code>) or paste an ncaa.com game URL.' });
      return;
    }
    await loadGame(gameId);
  }

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

          {/* Mode toggle */}
          <div className="gl-mode-toggle">
            <button
              className={`gl-mode-btn ${mode === 'id' ? 'active' : ''}`}
              onClick={() => setMode('id')}
            >Search by ID</button>
            <button
              className={`gl-mode-btn ${mode === 'browse' ? 'active' : ''}`}
              onClick={() => setMode('browse')}
              disabled={dataLoading || !playerArchive}
            >Browse by Team</button>
          </div>

          {mode === 'id' && (
            <>
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
            </>
          )}

          {mode === 'browse' && (
            <div className="gl-browse">
              {/* Year tabs */}
              <div className="gl-browse-years">
                {availableYears.map(y => (
                  <button
                    key={y}
                    className={`sb-view-btn ${browseYear === y ? 'active' : ''}`}
                    onClick={() => switchYear(y)}
                  >{y}</button>
                ))}
              </div>

              {/* Team search */}
              <div className="gl-team-search-wrap" style={{ position: 'relative' }}>
                <input
                  ref={teamInputRef}
                  className="gl-team-input"
                  placeholder={`Search ${browseYear} teams…`}
                  value={selectedTeam && !showSuggestions ? selectedTeam.display : teamSearch}
                  onChange={e => {
                    setTeamSearch(e.target.value);
                    setSelectedTeam(null);
                    setShowSuggestions(true);
                  }}
                  onFocus={() => setShowSuggestions(true)}
                />
                {selectedTeam && (
                  <button
                    className="gl-team-clear"
                    onClick={() => { setSelectedTeam(null); setTeamSearch(''); teamInputRef.current?.focus(); }}
                    title="Clear selection"
                  >✕</button>
                )}

                {showSuggestions && suggestions.length > 0 && !selectedTeam && (
                  <ul ref={suggestionsRef} className="gl-suggestions">
                    {suggestions.map(name => (
                      <li
                        key={name}
                        className="gl-suggestion-item"
                        onMouseDown={e => { e.preventDefault(); pickTeam(name); }}
                      >{name}</li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Game list */}
              {selectedTeam && (
                <div className="gl-game-list">
                  {gamesForTeam.length === 0 ? (
                    <div className="gl-no-games">
                      {gameLogs
                        ? `No game log data available for ${selectedTeam.display} ${browseYear}.`
                        : 'Loading…'}
                    </div>
                  ) : (
                    <>
                      <div className="gl-game-list-header">
                        {selectedTeam.display} · {browseYear} · {gamesForTeam.length} games
                      </div>
                      {gamesForTeam.map(g => (
                        <button
                          key={g.gameId}
                          className="gl-game-item"
                          onClick={() => loadGame(g.gameId)}
                          disabled={busy}
                        >
                          <span className="gl-game-opp">vs {g.opp}</span>
                          <span className="gl-game-sets">{g.nSets} sets</span>
                          <span className="gl-game-arrow">→</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
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
          <button
            className="gl-mode-btn"
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => { setReport(null); setMode('browse'); }}
          >← Browse</button>
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
