import { useState, useEffect, useMemo } from 'react';
import GameReport from './GameReport.jsx';
import { useData } from '../lib/DataContext.jsx';
import { loadYear, gameRowsToBoxscore, loadSetScores } from '../lib/csvGames.js';
import { computeGIS, computePGIS } from '../lib/gis.js';
import { loadGisPlus, makeKey, seasonStrFromYear } from '../lib/gisPlus.js';

const YEARS = [2025, 2024, 2023, 2022];

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

  // ── Preload the gis_plus_observations.csv Map (one-time, fire-and-forget) ──
  // Kicks off the 46 MB fetch as soon as the browser mounts, so by the time the
  // user clicks a game the Map is usually resolved and `selectGame` doesn't block.
  useEffect(() => { loadGisPlus(); }, []);

  // ── Filter games by search term ────────────────────────────────────────────
  // No search → show the 5 most recent games. With a search, show every
  // match in the season that hits (no cap — searches are naturally scoped).
  const filteredGames = useMemo(() => {
    if (!yearData) return [];
    const q = search.trim().toLowerCase();
    if (!q) return yearData.games.slice(0, 5);
    return yearData.games.filter(g =>
      g.homeTeam.toLowerCase().includes(q) ||
      g.awayTeam.toLowerCase().includes(q)
    );
  }, [yearData, search]);

  // ── Select a game → compute GIS → overlay Python GIS+ → show report ───────
  async function selectGame(game) {
    const rows = yearData.byKey[game.key];
    const bs   = gameRowsToBoxscore(rows);

    // Per-set rally-point scores are served by /data/wvb_setscores_<year>.json,
    // a lightweight lookup built from NCAA play-by-play (ContestID → [[h,a], ...]).
    // If missing, fall through to scoresUnknown so matchLev defaults to 1.00.
    const setScoresMap = await loadSetScores(year).catch(() => ({}));
    const periodsArr   = game.contestId && setScoresMap[game.contestId]
      ? setScoresMap[game.contestId].map(([h, a]) => ({ homeScore: h, awayScore: a }))
      : [];
    const ss = periodsArr.length
      ? {
          periods:        periodsArr,
          finalHomeScore: periodsArr.filter(p => p.homeScore > p.awayScore).length,
          finalAwayScore: periodsArr.filter(p => p.awayScore > p.homeScore).length,
          scoresUnknown:  false,
        }
      : {
          periods:        [],
          finalHomeScore: 0,
          finalAwayScore: 0,
          scoresUnknown:  true,
        };

    const gameId = game.contestId || '0';
    const mg     = computeGIS(bs, ss, null, gameId, rpiByYear || {}, pgisTables || {});

    // Override fields that computeGIS can't derive from the CSV
    mg.nSets        = game.nSets;
    mg.gameDate     = game.date;
    mg.gameLocation = game.location === 'Neutral' ? 'Neutral site' : null;
    // Known season from the year dropdown — more reliable than
    // seasonFromGameId's numeric-range guess, which miscategorizes games at
    // season boundaries (the PBP-rebuilt ContestIDs don't match the original
    // thresholds calibrated to the R-scraped data).
    mg.season       = String(year);

    // Overlay Python-computed GIS+ values from gis_plus_observations.csv.
    // The fetch is kicked off on mount; this awaits the cached Map. Any
    // unmatched player falls back to the JS values from computeGIS().
    //
    // After overlay, recompute pGIS using the overlayed GIS+/S rate so the
    // percentile lookup is in the same units as pgis_tables.json (built
    // from Python GIS+/S). JS-derived gisNeutralPlus lacks the efficiency +
    // set-leverage modifiers the Python pipeline bakes in.
    try {
      const gisPlusMap = await loadGisPlus();
      const seasonStr  = seasonStrFromYear(year);
      let overlayCount = 0;
      for (const p of mg.players) {
        const key = makeKey(seasonStr, game.date, p.team, p.name);
        const hit = gisPlusMap.get(key);
        if (hit) {
          p.gis     = hit.gis;
          p.gisPlus = hit.gisPlus;
          overlayCount++;
          const ns = p.ns || mg.nSets || 0;
          if (ns > 0 && pgisTables) {
            const recomputed = computePGIS(hit.gisPlus / ns, p.position, mg.nSets, pgisTables);
            if (recomputed != null) p.pGIS = recomputed;
          }
        }
      }
      mg.gisPlusOverlay = overlayCount > 0;
    } catch (err) {
      console.warn('[GameLookup] GIS+ overlay failed', err);
    }

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
          Browse every D1 match from 2022 to 2025.
          Select a year, search for a team, then click a game to view the report.
        </div>
      </div>

      {/* ── Controls ──────────────────────────────────────────────────── */}
      <div className="gb-controls">
        <select
          className="gb-year-select"
          value={year}
          onChange={e => setYear(parseInt(e.target.value, 10))}
          aria-label="Select season"
        >
          {YEARS.map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>

        <input
          className="gb-search"
          placeholder="Filter by team name…"
          value={search}
          onChange={e => { setSearch(e.target.value); setReport(null); }}
          disabled={loadingYear}
        />
      </div>

      {/* ── Status / game count ───────────────────────────────────────── */}
      {!report && (
        <div className="gb-status">
          {loadingYear
            ? <><div className="spinner" /> Loading {year} games…</>
            : search.trim()
              ? `${showing} match${showing === 1 ? '' : 'es'} for "${search.trim()}"`
              : `Showing 5 most recent of ${totalGames} games — search to find more`
          }
        </div>
      )}

      {/* ── Game list (hidden once a game is selected) ────────────────── */}
      {!report && !loadingYear && filteredGames.length > 0 && (
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

      {!report && !loadingYear && filteredGames.length === 0 && yearData && (
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
