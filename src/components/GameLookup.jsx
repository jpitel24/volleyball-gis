import { useState, useEffect, useMemo } from 'react';
import GameReport from './GameReport.jsx';
import { useData } from '../lib/DataContext.jsx';
import { loadYear, gameRowsToBoxscore, loadSetScores } from '../lib/csvGames.js';
import { computeGIS, computePGIS } from '../lib/gis.js';
import { loadGisPlus, makeKey, seasonStrFromYear } from '../lib/gisPlus.js';
import { navigate, hrefFor } from '../lib/router.js';
import { useStickyYear } from '../lib/useStickyYear.js';
import TeamChip from './TeamChip.jsx';

const YEARS = [2026, 2025, 2024, 2023, 2022];

export default function GameLookup({ route }) {
  const { rpiByYear, pgisTables, categoryPgisTables } = useData();

  const [year, setYear]             = useStickyYear(2026);
  // If the URL names a specific game, its season wins over the shared
  // sticky value — a shared /games/2024/keyX link should open in 2024
  // even if the user was last browsing 2026.
  useEffect(() => {
    if (route?.name === 'games' && route.year && route.year !== year) {
      setYear(route.year);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [yearData, setYearData]     = useState(null);
  const [loadingYear, setLoadingYear] = useState(false);
  const [search, setSearch]         = useState('');
  const [report, setReport]         = useState(null);
  const [openKey, setOpenKey]       = useState(null);  // currently-open game key

  // ── Load CSV when year changes ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadingYear(true);
    setReport(null);
    setOpenKey(null);
    setSearch('');
    loadYear(year)
      .then(data => { if (!cancelled) { setYearData(data); setLoadingYear(false); } })
      .catch(() =>   { if (!cancelled) { setYearData(null); setLoadingYear(false); } });
    return () => { cancelled = true; };
  }, [year]);

  // ── URL-driven auto-select: /games/:year/:key opens that match ─────────────
  // Two-phase: switch year first (triggers CSV load), then on yearData
  // resolution find the matching game and open the report. The URL is the
  // source of truth — no consume-callback needed.
  useEffect(() => {
    if (!route || route.name !== 'games' || !route.gameKey) return;
    if (route.year !== year) { setYear(route.year); return; }
    if (!yearData) return;
    // Wait for pgisTables from DataContext before computing. On a hard
    // refresh of /games/:year/:key this effect fires immediately, and if
    // we open the game before the tables arrive computeGIS runs with an
    // empty lookup and every pGIS value comes out null.
    if (!pgisTables) return;
    if (openKey === route.gameKey) return;  // already open
    const g = yearData.games.find(x => x.key === route.gameKey);
    if (g) selectGame(g);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, yearData, pgisTables]);

  // ── Closing the report (back to /games) clears the open match ──────────────
  useEffect(() => {
    if (route && route.name === 'games' && !route.gameKey && report) {
      setReport(null);
      setOpenKey(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  // ── Preload the gis_plus_observations.csv Map (one-time, fire-and-forget) ──
  // Kicks off the 46 MB fetch as soon as the browser mounts, so by the time the
  // user clicks a game the Map is usually resolved and `selectGame` doesn't block.
  useEffect(() => { loadGisPlus(); }, []);

  // ── Filter games by search term ────────────────────────────────────────────
  // No search → show the 25 most recent games. With a search, show every
  // match in the season that hits (no cap — searches are naturally scoped).
  const filteredGames = useMemo(() => {
    if (!yearData) return [];
    const q = search.trim().toLowerCase();
    if (!q) return yearData.games.slice(0, 25);
    return yearData.games.filter(g =>
      g.homeTeam.toLowerCase().includes(q) ||
      g.awayTeam.toLowerCase().includes(q)
    );
  }, [yearData, search]);

  // ── Select a game → compute GIS → overlay Python GIS+ → show report ───────
  async function selectGame(game) {
    const rows = yearData.byKey[game.key];
    const bs   = gameRowsToBoxscore(rows, yearData.playerPos);

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
          // Game Browser displays per-MATCH totals (the Python pipeline
          // outputs match-level values). Season/Player browsers show
          // per-set rates by aggregating these and dividing by total
          // sets. The category breakdown in PlayerInspector rescales
          // its per-set categories up to per-match so the rows sum to
          // this headline.
          p.gis     = hit.gis;
          p.gisPlus = hit.gisPlus;
          overlayCount++;
          const ns = p.ns || mg.nSets || 0;
          if (ns > 0 && pgisTables) {
            // pgis_tables.json is built off per-set GIS+ rates, so divide
            // the per-match overlay by ns for the percentile lookup.
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
    setOpenKey(game.key);
    // Scroll to report after React paints
    requestAnimationFrame(() =>
      document.querySelector('.report')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    );
  }

  const totalGames = yearData?.games.length ?? 0;
  const showing    = filteredGames.length;

  return (
    <>
      {/* ── Sidebar — filters live here ───────────────────────────────── */}
      <aside className="tool-sidebar">
        <div className="tool-sidebar-title">Games</div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Season</div>
          <select
            className="gb-year-select"
            value={year}
            onChange={e => {
              setYear(parseInt(e.target.value, 10));
              // Reset to /games so we don't leave a stale game key in the URL.
              navigate(hrefFor('games'));
            }}
            aria-label="Select season"
          >
            {YEARS.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="tool-sidebar-section">
          <div className="tool-sidebar-label">Search</div>
          <input
            className="pb-search"
            placeholder="Filter by team name…"
            value={search}
            onChange={e => { setSearch(e.target.value); setReport(null); }}
            disabled={loadingYear}
          />
        </div>
      </aside>

      {/* ── Main content ──────────────────────────────────────────────── */}
      <main className="tool-main">
        <div className="page-title-row">
          <h1 className="page-title">Game Browser</h1>
          <div className="page-sub">
            Every D1 match, 2022–present. Pick a season, search for a team,
            click a game to see the full GIS+/pGIS report.
          </div>
        </div>

      {/* ── Status / game count ───────────────────────────────────────── */}
      {!report && (
        <div className="gb-status">
          {loadingYear
            ? <><div className="spinner" /> Loading {year} games…</>
            : search.trim()
              ? `${showing} match${showing === 1 ? '' : 'es'} for "${search.trim()}"`
              : `Showing ${Math.min(25, totalGames)} most recent of ${totalGames} games — search to find more`
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
              onClick={() => {
                // Push the canonical URL; the route effect will call selectGame.
                navigate(hrefFor('games', year, g.key));
              }}
            >
              <span className="gb-game-date">{g.date}</span>
              <span className="gb-game-matchup">
                <span className="gb-game-team"><TeamChip team={g.homeTeam} />{g.homeTeam}</span>
                <span className="gb-game-vs">vs</span>
                <span className="gb-game-team"><TeamChip team={g.awayTeam} />{g.awayTeam}</span>
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
      </main>
    </>
  );
}
