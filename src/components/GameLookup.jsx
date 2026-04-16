import { useState, useEffect, useMemo } from 'react';
import GameReport from './GameReport.jsx';
import { useData } from '../lib/DataContext.jsx';
import { loadYear, gameRowsToBoxscore } from '../lib/csvGames.js';
import { computeGIS } from '../lib/gis.js';

const YEARS = [2025, 2024, 2023, 2022, 2021];

export default function GameLookup() {
  const { rpiByYear, pgisTables, categoryPgisTables } = useData();

  const [year, setYear]             = useState(2025);
  const [yearData, setYearData]     = useState(null);
  const [loadingYear, setLoadingYear] = useState(false);
  const [search, setSearch]         = useState('');
  const [report, setReport]         = useState(null);

  // ── Load CSV when year changes ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadingYear(true);
    setReport(null);
    setSearch('');
    loadYear(year)
      .then(data => { if (!cancelled) { setYearData(data); setLoadingYear(false); } })
      .catch(() =>   { if (!cancelled) { setYearData(null); setLoadingYear(false); } });
    return () => { cancelled = true; };
  }, [year]);

  // ── Filter games by search term ────────────────────────────────────────────
  const filteredGames = useMemo(() => {
    if (!yearData) return [];
    const q = search.trim().toLowerCase();
    const list = q
      ? yearData.games.filter(g =>
          g.homeTeam.toLowerCase().includes(q) ||
          g.awayTeam.toLowerCase().includes(q))
      : yearData.games;
    return list.slice(0, 200);
  }, [yearData, search]);

  // ── Select a game → compute GIS → show report ─────────────────────────────
  function selectGame(game) {
    const rows = yearData.byKey[game.key];
    const bs   = gameRowsToBoxscore(rows);

    // Minimal scoring summary — we don't have per-set scores from the CSV,
    // so matchLev defaults to 1.00 and set chips are hidden.
    const ss = {
      periods: [],
      finalHomeScore: 0,
      finalAwayScore: 0,
      scoresUnknown: true,
    };

    const gameId = game.contestId || '0';
    const mg     = computeGIS(bs, ss, null, gameId, rpiByYear || {}, pgisTables || {});

    // Override fields that computeGIS can't derive from the CSV
    mg.nSets        = game.nSets;
    mg.gameDate     = game.date;
    mg.gameLocation = game.location === 'Neutral' ? 'Neutral site' : null;

    setReport({ gameId, mg });
    // Scroll to report after React paints
    requestAnimationFrame(() =>
      document.querySelector('.report')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    );
  }

  const totalGames = yearData?.games.length ?? 0;
  const showing    = filteredGames.length;

  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <div className="hero">
        <div className="hero-eyebrow">NCAA D1 Women's Volleyball</div>
        <div className="hero-title">Game Browser</div>
        <div className="hero-sub">
          Browse every D1 match from 2021 to 2025.
          Select a year, search for a team, then click a game to view the report.
        </div>
      </div>

      {/* ── Controls ──────────────────────────────────────────────────── */}
      <div className="gb-controls">
        <div className="gb-year-tabs">
          {YEARS.map(y => (
            <button
              key={y}
              className={`gb-year-tab${y === year ? ' active' : ''}`}
              onClick={() => setYear(y)}
            >
              {y}
            </button>
          ))}
        </div>

        <input
          className="gb-search"
          placeholder="Filter by team name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          disabled={loadingYear}
        />
      </div>

      {/* ── Status / game count ───────────────────────────────────────── */}
      <div className="gb-status">
        {loadingYear
          ? <><div className="spinner" /> Loading {year} games…</>
          : <>{showing === totalGames
                ? `${totalGames} games`
                : `${showing} of ${totalGames} games`
              }{showing === 200 && totalGames > 200 && ' (showing first 200 — refine your search)'}</>
        }
      </div>

      {/* ── Game list ─────────────────────────────────────────────────── */}
      {!loadingYear && filteredGames.length > 0 && (
        <div className="gb-list">
          {filteredGames.map(g => (
            <button
              key={g.key}
              className="gb-game"
              onClick={() => selectGame(g)}
            >
              <span className="gb-game-date">{g.date}</span>
              <span className="gb-game-matchup">
                <span className="gb-game-team">{g.homeTeam}</span>
                <span className="gb-game-vs">vs</span>
                <span className="gb-game-team">{g.awayTeam}</span>
              </span>
              <span className="gb-game-meta">
                {g.nSets}S
                {g.conference && <span className="gb-game-conf">{g.conference}</span>}
              </span>
            </button>
          ))}
        </div>
      )}

      {!loadingYear && filteredGames.length === 0 && yearData && (
        <div className="gb-empty">
          No games found{search ? ` matching "${search}"` : ''} for {year}.
        </div>
      )}

      {/* ── Report ────────────────────────────────────────────────────── */}
      {report && (
        <GameReport
          gameId={report.gameId}
          mg={report.mg}
          isMock={false}
          rpiByYear={rpiByYear}
          categoryPgisTables={categoryPgisTables}
        />
      )}
    </>
  );
}
