import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import GameReport from './GameReport.jsx';
import { useData } from '../lib/DataContext.jsx';
import { loadYear, gameRowsToBoxscore, loadSetScores } from '../lib/csvGames.js';
import { computeGIS, computePGIS } from '../lib/gis.js';
import { loadGisPlus, makeKey, seasonStrFromYear } from '../lib/gisPlus.js';
import { navigate, hrefFor } from '../lib/router.js';
import { useKeyboardShortcuts } from '../lib/useKeyboardShortcuts.js';
import { useRecent } from '../lib/recentlyViewed.js';
import TeamChip from './TeamChip.jsx';
import { getTeamDisplayName } from '../data/teamNicknames.js';

const YEARS = [2026, 2025, 2024, 2023, 2022];

export default function GameLookup({ route }) {
  const { rpiByYear, pgisTables, categoryPgisTables } = useData();

  // Multi-year game catalog — loaded lazily, driven by the picker UI below.
  // allYearData[year] is the full {games, byKey, playerPos} index for that
  // year once resolved. Keeping all years in memory is fine: the metadata
  // objects are tiny; the heavy byKey rows aren't needed by the picker but
  // are retained because selectGame() consumes them when the user picks.
  const [allYearData, setAllYearData] = useState({});
  const [loadingYears, setLoadingYears] = useState(true);

  const [report, setReport]       = useState(null);
  const [recent, recordRecent]    = useRecent('games');

  // Kick off every year's CSV fetch on mount, in parallel. Each loadYear
  // call is internally cached, so later lookups are free.
  useEffect(() => {
    let cancelled = false;
    setLoadingYears(true);
    Promise.all(YEARS.map(y => loadYear(y).then(d => [y, d]).catch(() => [y, null])))
      .then(results => {
        if (cancelled) return;
        const next = {};
        for (const [y, d] of results) if (d) next[y] = d;
        setAllYearData(next);
        setLoadingYears(false);
      });
    return () => { cancelled = true; };
  }, []);

  // ── URL-driven auto-select: /games/:year/:key opens that match ─────────
  useEffect(() => {
    if (!route || route.name !== 'games' || !route.gameKey) return;
    const yd = allYearData[route.year];
    if (!yd) return;
    if (!pgisTables) return;
    if (report && report.gameKey === route.gameKey) return;
    const g = yd.games.find(x => x.key === route.gameKey);
    if (g) selectGame(g, route.year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, allYearData, pgisTables]);

  // Closing the report (route back to /games) clears the view.
  useEffect(() => {
    if (route && route.name === 'games' && !route.gameKey && report) {
      setReport(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  // Preload the gis_plus_observations.csv Map (one-time, fire-and-forget).
  useEffect(() => { loadGisPlus(); }, []);

  async function selectGame(game, year) {
    const yd = allYearData[year];
    if (!yd) return;
    const rows = yd.byKey[game.key];
    const bs   = gameRowsToBoxscore(rows, yd.playerPos);

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

    mg.nSets        = game.nSets;
    mg.gameDate     = game.date;
    mg.gameLocation = game.location === 'Neutral' ? 'Neutral site' : null;
    mg.season       = String(year);

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

    setReport({ gameId, mg, year, gameKey: game.key });
    recordRecent({
      id:    `${year}|${game.key}`,
      label: `${getTeamDisplayName(game.homeTeam)} vs ${getTeamDisplayName(game.awayTeam)}`,
      sub:   game.date,
      href:  hrefFor('games', year, game.key),
    });
    requestAnimationFrame(() =>
      document.querySelector('.report')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    );
  }

  useKeyboardShortcuts({
    'Escape': () => { if (report) navigate(hrefFor('games')); },
  });

  const inPickerMode = !route?.gameKey;

  return (
    <>
      <aside className="tool-sidebar">
        <div className="tool-sidebar-title">Games</div>
        {inPickerMode ? (
          <div className="tool-sidebar-section">
            <div className="tool-sidebar-label">About</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.55 }}>
              Pick a year and two teams, in any order — options narrow to
              match the picks you've already made. Or hit Random Match.
            </div>
          </div>
        ) : (
          <div className="tool-sidebar-section">
            <a
              href={hrefFor('games')}
              onClick={e => { e.preventDefault(); navigate(hrefFor('games')); }}
              style={{ fontSize: '0.8rem', color: 'var(--muted)' }}
            >
              ← Pick a different game
            </a>
          </div>
        )}
        {recent.length > 0 && (
          <div className="tool-sidebar-section">
            <div className="tool-sidebar-label">Recent</div>
            <ul className="recent-list">
              {recent.map(r => (
                <li key={r.id}>
                  <a
                    href={r.href}
                    onClick={e => { e.preventDefault(); navigate(r.href); }}
                    title={r.sub || ''}
                  >
                    <span className="recent-label">{r.label}</span>
                    {r.sub && <span className="recent-sub">{r.sub}</span>}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>

      <main className="tool-main">
        {inPickerMode && (
          <>
            <div className="page-title-row">
              <h1 className="page-title">Game Browser</h1>
              <div className="page-sub">
                Pick a year and two teams (in any order) to find the match.
              </div>
            </div>
            {loadingYears
              ? <div className="gb-status"><div className="spinner" /> Loading schedule…</div>
              : <GamePicker allYearData={allYearData} onPick={(g, y) => navigate(hrefFor('games', y, g.key))} />
            }
          </>
        )}

        {report && (
          <GameReport
            gameId={report.gameId}
            mg={report.mg}
            year={report.year}
            isMock={false}
            rpiByYear={rpiByYear}
            categoryPgisTables={categoryPgisTables}
          />
        )}
      </main>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────
// GamePicker — 3-slot year × team × team selector
// ──────────────────────────────────────────────────────────────────────
function GamePicker({ allYearData, onPick }) {
  const [year,  setYear]  = useState(null);    // numeric year or null = any
  const [team1, setTeam1] = useState(null);
  const [team2, setTeam2] = useState(null);

  // Flat list: every game across every loaded year, with its year attached.
  const allGames = useMemo(() => {
    const out = [];
    for (const [y, yd] of Object.entries(allYearData)) {
      const yr = parseInt(y, 10);
      for (const g of yd.games) out.push({ ...g, year: yr });
    }
    return out;
  }, [allYearData]);

  // Narrow by current selections. Each slot filter is independent of its own
  // selector — year narrowing uses year; team1 options ignore team1; etc.
  function filterGames({ ignoreYear, ignoreTeam1, ignoreTeam2 } = {}) {
    return allGames.filter(g => {
      if (!ignoreYear  && year  != null && g.year !== year)                             return false;
      if (!ignoreTeam1 && team1 && g.homeTeam !== team1 && g.awayTeam !== team1)        return false;
      if (!ignoreTeam2 && team2 && g.homeTeam !== team2 && g.awayTeam !== team2)        return false;
      return true;
    });
  }

  // Available years = years in which there's any game that satisfies the
  // team filters (i.e. games the user's team picks can still match).
  const yearOptions = useMemo(() => {
    const s = new Set();
    for (const g of filterGames({ ignoreYear: true })) s.add(g.year);
    return [...s].sort((a, b) => b - a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allGames, team1, team2]);

  // Team-1 options: every team that appears in a game satisfying year + team2
  // (so if the user has already picked team2, team1 narrows to its opponents).
  const team1Options = useMemo(() => {
    const s = new Set();
    for (const g of filterGames({ ignoreTeam1: true })) {
      s.add(g.homeTeam);
      s.add(g.awayTeam);
    }
    if (team2) s.delete(team2);   // can't pick the same team twice
    return [...s].sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allGames, year, team2]);

  // Team-2 options: every team that appears opposite team1 in a satisfying game.
  const team2Options = useMemo(() => {
    const s = new Set();
    for (const g of filterGames({ ignoreTeam2: true })) {
      s.add(g.homeTeam);
      s.add(g.awayTeam);
    }
    if (team1) s.delete(team1);
    return [...s].sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allGames, year, team1]);

  // Candidate matches given current selections.
  const matches = useMemo(() => filterGames().sort((a, b) => b.date.localeCompare(a.date)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allGames, year, team1, team2],
  );

  // Auto-open when enough is selected to uniquely identify a match.
  // Teams picked + exactly one match in scope → navigate directly.
  useEffect(() => {
    if (team1 && team2 && matches.length === 1) {
      onPick(matches[0], matches[0].year);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team1, team2, matches.length]);

  function pickRandom() {
    if (allGames.length === 0) return;
    const pick = allGames[Math.floor(Math.random() * allGames.length)];
    onPick(pick, pick.year);
  }

  // Reset handlers — clearing team1 also clears team2 so stale downstream
  // picks don't linger.
  function updateYear(y)  { setYear(y); }
  function updateTeam1(t) { setTeam1(t); if (t && team2 === t) setTeam2(null); }
  function updateTeam2(t) { setTeam2(t); if (t && team1 === t) setTeam1(null); }

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
        <button
          type="button"
          className="gl-mode-btn"
          onClick={pickRandom}
          style={{ padding: '0.4rem 0.9rem' }}
        >
          🎲 Random Match
        </button>
      </div>

      <PickerSlot
        label="Year"
        placeholder="Any year — click to pick"
        value={year == null ? null : String(year)}
        options={yearOptions.map(y => ({ value: String(y), label: String(y) }))}
        onChange={v => updateYear(v == null ? null : parseInt(v, 10))}
        onClear={() => setYear(null)}
      />
      <PickerSlot
        label="Team 1"
        placeholder={`Pick any of ${team1Options.length} teams`}
        value={team1}
        options={team1Options.map(t => ({ value: t, label: getTeamDisplayName(t) }))}
        onChange={updateTeam1}
        onClear={() => setTeam1(null)}
        teamChip
      />
      <PickerSlot
        label="Team 2"
        placeholder={team1
          ? `Pick any of ${team2Options.length} opponents`
          : (team2Options.length > 0 ? `Pick any of ${team2Options.length} teams` : 'Pick Team 1 first')}
        value={team2}
        options={team2Options.map(t => ({ value: t, label: getTeamDisplayName(t) }))}
        onChange={updateTeam2}
        onClear={() => setTeam2(null)}
        teamChip
      />

      {/* Match disambiguation — shown when both teams + year yield >1 game,
          or when both teams are picked but no year was and they met in
          multiple seasons. */}
      {team1 && team2 && matches.length > 1 && (
        <div style={{ marginTop: '1.5rem' }}>
          <div className="tool-sidebar-label" style={{ marginBottom: '0.5rem' }}>
            {matches.length} matches between {team1} and {team2}
          </div>
          <div className="gb-list">
            {matches.map(g => (
              <button
                key={`${g.year}|${g.key}`}
                className="gb-game"
                onClick={() => onPick(g, g.year)}
              >
                <span className="gb-game-date">{g.date}</span>
                <span className="gb-game-matchup">
                  <span className="gb-game-team"><TeamChip team={g.homeTeam} />{getTeamDisplayName(g.homeTeam)}</span>
                  <span className="gb-game-vs">vs</span>
                  <span className="gb-game-team"><TeamChip team={g.awayTeam} />{getTeamDisplayName(g.awayTeam)}</span>
                </span>
                <span className="gb-game-meta">
                  {g.nSets}S · {g.year}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {team1 && team2 && matches.length === 0 && (
        <div className="gb-empty" style={{ marginTop: '1rem' }}>
          {team1} and {team2} haven't played{year ? ` in ${year}` : ' in our data'}.
        </div>
      )}
    </div>
  );
}

// Reusable typeable combobox for a single slot.
function PickerSlot({ label, placeholder, value, options, onChange, onClear, teamChip }) {
  const [open,   setOpen]   = useState(false);
  const [query,  setQuery]  = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return options;
    const pref = [], sub = [];
    for (const o of options) {
      const lc = o.label.toLowerCase();
      if (lc.startsWith(q))   pref.push(o);
      else if (lc.includes(q)) sub.push(o);
    }
    return [...pref, ...sub];
  }, [q, options]);

  useEffect(() => { setCursor(0); }, [query, open]);

  // When the slot gets a value from elsewhere, hide the dropdown and clear
  // the query so the picker shows the picked value (not a stale input).
  useEffect(() => { if (value) setOpen(false); if (value) setQuery(''); }, [value]);

  function pick(v) {
    onChange(v);
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setCursor(c => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(c => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[cursor]) pick(filtered[cursor].value);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const MAX_VISIBLE = 50;
  const visible = filtered.slice(0, MAX_VISIBLE);

  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{
        fontSize: '0.65rem',
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: 'var(--muted)',
        marginBottom: '0.3rem',
      }}>
        {label}
      </div>
      <div style={{ position: 'relative' }}>
        {value ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.5rem 0.75rem',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--surface2)',
            fontSize: '0.85rem',
            cursor: 'pointer',
          }}
          onClick={() => { onClear(); setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
          title="Click to change"
          >
            {teamChip && <TeamChip team={value} size={14} />}
            <span style={{ flex: 1 }}>{teamChip ? getTeamDisplayName(value) : value}</span>
            <span style={{ color: 'var(--muted)', fontSize: '0.75em' }}>✕</span>
          </div>
        ) : (
          <>
            <input
              ref={inputRef}
              className="pb-search"
              placeholder={placeholder}
              value={query}
              onChange={e => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              disabled={options.length === 0}
              autoComplete="off"
              spellCheck={false}
              style={{ width: '100%' }}
            />
            {open && visible.length > 0 && (
              <div style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                right: 0,
                maxHeight: 340,
                overflowY: 'auto',
                background: 'var(--surface)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                zIndex: 20,
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              }}>
                {visible.map((o, i) => (
                  <div
                    key={o.value}
                    onMouseDown={e => { e.preventDefault(); pick(o.value); }}
                    onMouseEnter={() => setCursor(i)}
                    style={{
                      padding: '0.4rem 0.75rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      background: i === cursor ? 'var(--surface2)' : 'transparent',
                      color: 'var(--text)',
                      fontSize: '0.85rem',
                    }}
                  >
                    {teamChip && <TeamChip team={o.value} size={12} />}
                    <span>{o.label}</span>
                  </div>
                ))}
                {filtered.length > MAX_VISIBLE && (
                  <div style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem', color: 'var(--muted)' }}>
                    {filtered.length - MAX_VISIBLE} more — keep typing.
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
