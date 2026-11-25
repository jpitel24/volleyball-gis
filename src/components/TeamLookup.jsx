import { useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../lib/DataContext.jsx';
import { loadPlayerIndex } from '../lib/playerIndex.js';
import { posColor, pgisLabel, posGroup, POS_GROUP_MAP } from '../lib/gis.js';
import { navigate, hrefFor, useLinkHandler } from '../lib/router.js';
import { useRecent } from '../lib/recentlyViewed.js';
import { computeAwardsIndex, awardsToLabels } from '../lib/awards.js';
import TeamChip from './TeamChip.jsx';
import SeasonStatsTable from './SeasonStatsTable.jsx';

const CURRENT_YEAR = 2026;
const ALL_YEARS    = [2026, 2025, 2024, 2023, 2022];

function fmt(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(d);
}

function PGISChip({ v, style }) {
  if (v == null || !Number.isFinite(v)) return <span className="pb-chip" style={style}>pGIS —</span>;
  const [, cls] = pgisLabel(v);
  return <span className={`pb-chip pgis-${cls}`} style={style}>pGIS {v.toFixed(1)}</span>;
}

// ──────────────────────────────────────────────────────────────────────
// TeamLookup — route dispatcher
//   /teams              → TeamSelector
//   /teams/:slug        → TeamDetail (all-time)
//   /teams/:slug/:year  → TeamDetail (season)
// ──────────────────────────────────────────────────────────────────────
export default function TeamLookup({ route, onGameDeepLink }) {
  const { pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality, loading } = useData();
  const [index, setIndex]            = useState(null);
  const [indexErr, setIndexErr]      = useState(null);
  const [buildingIndex, setBuilding] = useState(false);

  useEffect(() => {
    if (loading || !pgisTables) return;
    let cancelled = false;
    setBuilding(true);
    loadPlayerIndex(pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality)
      .then(idx => { if (!cancelled) { setIndex(idx); setBuilding(false); } })
      .catch(err => { if (!cancelled) { setIndexErr(err?.message || String(err)); setBuilding(false); } });
    return () => { cancelled = true; };
  }, [loading, pgisTables, rpiByYear, receptionQuality, serveQuality, setQuality]);

  const teamNames = useMemo(() => {
    if (!index) return [];
    const names = new Set();
    for (const p of index.players) {
      for (const s of p.seasons) {
        if (s.team) names.add(s.team);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [index]);

  const selectedTeam = route?.team || null;
  const selectedYear = route?.year || null;

  // Validate team against the known roster — a bogus URL slug should
  // bounce back to the selector rather than render an empty page.
  const teamIsValid = selectedTeam && teamNames.includes(selectedTeam);

  return (
    <>
      <aside className="tool-sidebar">
        <div className="tool-sidebar-title">Teams</div>
        {teamIsValid ? (
          <TeamSidebar
            teamName={selectedTeam}
            selectedYear={selectedYear}
            index={index}
          />
        ) : (
          <SelectorSidebar />
        )}
      </aside>

      <main className="tool-main">
        <div className="gb-status">
          {loading && <><div className="spinner" /> Loading baselines…</>}
          {!loading && buildingIndex && <><div className="spinner" /> Building team index…</>}
          {indexErr && <span style={{ color: '#f43f5e' }}>Error: {indexErr}</span>}
        </div>

        {index && !teamIsValid && (
          <TeamSelector teamNames={teamNames} />
        )}

        {index && teamIsValid && (
          <TeamDetail
            teamName={selectedTeam}
            year={selectedYear}
            index={index}
            onGameDeepLink={onGameDeepLink}
          />
        )}
      </main>
    </>
  );
}

function SelectorSidebar() {
  return (
    <div className="tool-sidebar-section">
      <div className="tool-sidebar-label">About</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.55 }}>
        Pick a team to see its all-time best player, ideal starting lineup,
        and single-match highs — plus per-season views back to 2022.
      </div>
    </div>
  );
}

function TeamSidebar({ teamName, selectedYear, index }) {
  const linkHandler = useLinkHandler();

  // Years this team has data for — pulled from the player index.
  const availableYears = useMemo(() => {
    const ys = new Set();
    for (const p of index.players) {
      for (const s of p.seasons) {
        if (s.team === teamName && s.games > 0) ys.add(s.year);
      }
    }
    return [...ys].sort((a, b) => b - a);
  }, [index, teamName]);

  return (
    <>
      <div className="tool-sidebar-section">
        <div className="tool-sidebar-label">Team</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600, fontSize: '0.95rem' }}>
          <TeamChip team={teamName} size={14} />
          <span>{teamName}</span>
        </div>
        <a
          href={hrefFor('teams')}
          onClick={linkHandler}
          style={{ display: 'inline-block', marginTop: '0.6rem', fontSize: '0.75rem', color: 'var(--muted)' }}
        >
          ← Choose another team
        </a>
      </div>

      <div className="tool-sidebar-section">
        <div className="tool-sidebar-label">Season</div>
        <div className="tool-sidebar-pills" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <a
            href={hrefFor('teams', teamName)}
            onClick={linkHandler}
            className={`gl-mode-btn${selectedYear == null ? ' active' : ''}`}
            style={{ textAlign: 'left' }}
          >
            All-Time
          </a>
          {availableYears.map(y => (
            <a
              key={y}
              href={hrefFor('teams', teamName, y)}
              onClick={linkHandler}
              className={`gl-mode-btn${selectedYear === y ? ' active' : ''}`}
              style={{ textAlign: 'left' }}
            >
              {y}
              {y === CURRENT_YEAR && (
                <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: '0.75em' }}>
                  in progress
                </span>
              )}
            </a>
          ))}
        </div>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Typeable combobox entry
// ──────────────────────────────────────────────────────────────────────
function TeamSelector({ teamNames }) {
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const [recent] = useRecent('teams');
  const linkHandler = useLinkHandler();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teamNames;
    // Prefer prefix matches, fall back to substring. Prefix matches come
    // first so typing "flor" shows Florida before "Florida St.", before
    // "South Florida".
    const prefix = [];
    const substr = [];
    for (const name of teamNames) {
      const lc = name.toLowerCase();
      if (lc.startsWith(q))       prefix.push(name);
      else if (lc.includes(q))    substr.push(name);
    }
    return [...prefix, ...substr];
  }, [teamNames, query]);

  // Keep the keyboard cursor in-bounds when the filtered list shrinks.
  useEffect(() => { setCursor(0); }, [query]);

  // Focus the input on mount so the user can start typing immediately.
  useEffect(() => { inputRef.current?.focus(); }, []);

  function pick(name) {
    if (!name) return;
    navigate(hrefFor('teams', name));
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
      pick(filtered[cursor]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const MAX_VISIBLE = 50;
  const visible = filtered.slice(0, MAX_VISIBLE);

  return (
    <div className="page-title-row" style={{ flexDirection: 'column', alignItems: 'stretch', maxWidth: 560 }}>
      <h1 className="page-title">Team Browser</h1>
      <div className="page-sub" style={{ marginBottom: '1rem' }}>
        Start typing a team name, or scroll the list below. Pick a team to
        open its all-time page, with per-season views one click away.
      </div>

      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          className="pb-search"
          placeholder={`Search ${teamNames.length} teams…`}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          autoComplete="off"
          spellCheck={false}
          style={{ width: '100%' }}
        />
        {open && visible.length > 0 && (
          <div
            style={{
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
            }}
          >
            {visible.map((name, i) => (
              <div
                key={name}
                onMouseDown={e => { e.preventDefault(); pick(name); }}
                onMouseEnter={() => setCursor(i)}
                style={{
                  padding: '0.45rem 0.75rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  background: i === cursor ? 'var(--surface2)' : 'transparent',
                  color: 'var(--text)',
                  fontSize: '0.85rem',
                }}
              >
                <TeamChip team={name} size={12} />
                <span>{name}</span>
              </div>
            ))}
            {filtered.length > MAX_VISIBLE && (
              <div style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem', color: 'var(--muted)' }}>
                {filtered.length - MAX_VISIBLE} more — keep typing to narrow.
              </div>
            )}
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <div className="tool-sidebar-label" style={{ marginBottom: '0.4rem' }}>Recent</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {recent.map(r => (
              <a
                key={r.id}
                href={r.href}
                onClick={linkHandler}
                className="pb-chip"
                style={{ textDecoration: 'none' }}
              >
                {r.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Detail view helpers
// ──────────────────────────────────────────────────────────────────────

// Flatten every player-season for a given team. Each row carries the
// player key so downstream logic can key awards and "one appearance per
// player" lineup rules by it.
function collectTeamPlayerSeasons(index, teamName) {
  const rows = [];
  for (const p of index.players) {
    for (const s of p.seasons) {
      if (s.team !== teamName) continue;
      if (!s.games) continue;
      rows.push({
        playerKey: p.key,
        // Both shapes — SeasonStatsTable reads `name`, the existing
        // best-player / lineup cards read `playerName`.
        name:      p.name,
        playerName: p.name,
        year: s.year,
        team: s.team,
        conference: s.conference,
        position: s.position,
        games: s.games,
        sets: s.sets,
        gis: s.gis,
        gisPlus: s.gisPlus,
        pGIS: s.pGIS,
        t50: s.t50,
        inConf: s.inConf,
        gameLog: s.gameLog || [],
        teamGames: s.teamGames,
        // PBP-derived quality cells for the roster stats table.
        recQuality:     s.recQuality,
        srvQuality:     s.srvQuality,
        setQuality:     s.setQuality,
        blockEffPerSet: s.blockEffPerSet,
        totals:         s.totals,
      });
    }
  }
  return rows;
}

// Qualification floor shared by best-player and ideal-lineup picks.
// Matches the Seasons tool: a player must have appeared in ≥75% of the
// team's matches that season. Keeps single-game cameos and partial-year
// transfers from leapfrogging a full-season performer.
const MIN_TEAM_GAMES_SHARE = 0.75;
function isQualified(r) {
  if (!Number.isFinite(r.pGIS)) return false;
  if (!r.teamGames || r.teamGames <= 0) return false;
  return r.games / r.teamGames >= MIN_TEAM_GAMES_SHARE;
}

// Pick the best individual season for the "best player" card.
// Scoped by `year` (null = all-time).
function pickBestPlayerSeason(rows, year) {
  const scoped = (year == null ? rows : rows.filter(r => r.year === year))
    .filter(isQualified);
  if (!scoped.length) return null;
  scoped.sort((a, b) => (b.pGIS || 0) - (a.pGIS || 0));
  return scoped[0];
}

// Season "ideal starting lineup" — same selection the Team Browser was
// already using for its Rotation pGIS: top 3 OH, top 2 MB, top S,
// top L by season pGIS. Returns a list of { slot, pick, slotIndex }.
function seasonLineup(rows) {
  const by = { OH: [], MB: [], S: [], L: [] };
  for (const r of rows) {
    if (!isQualified(r)) continue;
    const grp = posGroup(r.position);
    if (!grp || !by[grp]) continue;
    by[grp].push(r);
  }
  for (const k of Object.keys(by)) by[k].sort((a, b) => (b.pGIS || 0) - (a.pGIS || 0));
  const out = [];
  for (let i = 0; i < 3; i++) if (by.OH[i]) out.push({ slot: 'OH', slotIndex: i, pick: by.OH[i] });
  for (let i = 0; i < 2; i++) if (by.MB[i]) out.push({ slot: 'MB', slotIndex: i, pick: by.MB[i] });
  if (by.S[0]) out.push({ slot: 'S', slotIndex: 0, pick: by.S[0] });
  if (by.L[0]) out.push({ slot: 'L', slotIndex: 0, pick: by.L[0] });
  return out;
}

// All-time ideal lineup — same shape as seasonLineup but each player
// may appear only once (their single best season at their natural
// position wins). If a player played the same position multiple years,
// we take their best pGIS season. Players who played multiple positions
// across seasons go into whichever bucket their highest-pGIS season
// used, so a player who moved OH→OPP stays a pin the whole time.
function allTimeLineup(rows) {
  // Group all seasons by (playerKey, posGroup) and keep each group's
  // best season. Then let the lineup picker see each player's single
  // best season per position group.
  const byPlayerBest = new Map(); // key: `${playerKey}|${posGrp}` → best season
  for (const r of rows) {
    if (!isQualified(r)) continue;
    const grp = posGroup(r.position);
    if (!grp) continue;
    const k = `${r.playerKey}|${grp}`;
    const prev = byPlayerBest.get(k);
    if (!prev || (r.pGIS || 0) > (prev.pGIS || 0)) byPlayerBest.set(k, r);
  }
  // Within each position group, rank unique players by their best season.
  const by = { OH: [], MB: [], S: [], L: [] };
  for (const season of byPlayerBest.values()) {
    const grp = posGroup(season.position);
    by[grp].push(season);
  }
  for (const k of Object.keys(by)) by[k].sort((a, b) => (b.pGIS || 0) - (a.pGIS || 0));

  // Greedy lineup pick: walk the slot order (3 OH, 2 MB, 1 S, 1 L) and
  // for each slot take the highest-pGIS season in that bucket whose
  // playerKey hasn't been placed yet.
  const taken = new Set();
  const out = [];
  const slots = [
    { slot: 'OH', k: 'OH' }, { slot: 'OH', k: 'OH' }, { slot: 'OH', k: 'OH' },
    { slot: 'MB', k: 'MB' }, { slot: 'MB', k: 'MB' },
    { slot: 'S',  k: 'S'  },
    { slot: 'L',  k: 'L'  },
  ];
  const cursors = { OH: 0, MB: 0, S: 0, L: 0 };
  for (let i = 0; i < slots.length; i++) {
    const { slot, k } = slots[i];
    while (cursors[k] < by[k].length && taken.has(by[k][cursors[k]].playerKey)) {
      cursors[k]++;
    }
    const pick = by[k][cursors[k]];
    if (pick) {
      taken.add(pick.playerKey);
      cursors[k]++;
      out.push({ slot, slotIndex: i, pick });
    }
  }
  return out;
}

// Per-game rotation pGIS for every game in the given rows. For each
// game key, collect the per-game pGIS of every roster member who
// appeared, bucket by position, pick top 3 pins, top 2 MB, top S,
// top L and average. Returns {gameKey, year, date, opponent, rotPGIS}[].
function perGameRotationPGIS(rows) {
  // Build gameKey → list of per-game entries.
  const byGame = new Map();
  for (const r of rows) {
    for (const g of r.gameLog) {
      if (!Number.isFinite(g.pGIS)) continue;
      if (!byGame.has(g.gameKey)) byGame.set(g.gameKey, {
        gameKey: g.gameKey, year: r.year, date: g.date, opponent: g.opponent, entries: [],
      });
      byGame.get(g.gameKey).entries.push({
        playerKey: r.playerKey, name: r.playerName,
        position: g.position || r.position,
        pGIS: g.pGIS,
      });
    }
  }
  const out = [];
  for (const game of byGame.values()) {
    const by = { OH: [], MB: [], S: [], L: [] };
    for (const e of game.entries) {
      const grp = posGroup(e.position);
      if (!grp || !by[grp]) continue;
      by[grp].push(e);
    }
    for (const k of Object.keys(by)) by[k].sort((a, b) => b.pGIS - a.pGIS);
    const picks = [
      ...by.OH.slice(0, 3),
      ...by.MB.slice(0, 2),
      ...by.S .slice(0, 1),
      ...by.L .slice(0, 1),
    ];
    if (!picks.length) continue;
    const avg = picks.reduce((s, p) => s + p.pGIS, 0) / picks.length;
    out.push({
      gameKey: game.gameKey, year: game.year, date: game.date,
      opponent: game.opponent, rotPGIS: avg, rotationSize: picks.length,
    });
  }
  return out;
}

// Best single-match performance at each position. Returns a map
// { OH, MB, S, L } → { playerKey, name, position, pGIS, gameKey, year, date, opponent }.
function bestGamesByPosition(rows) {
  const best = { OH: null, MB: null, S: null, L: null };
  for (const r of rows) {
    for (const g of r.gameLog) {
      if (!Number.isFinite(g.pGIS)) continue;
      const grp = posGroup(g.position || r.position);
      if (!grp || !(grp in best)) continue;
      const entry = {
        playerKey: r.playerKey, name: r.playerName,
        position: g.position || r.position,
        pGIS: g.pGIS,
        gis: g.gis, gisPlus: g.gisPlus,
        sets: g.sets,
        gameKey: g.gameKey, year: r.year,
        date: g.date, opponent: g.opponent,
      };
      if (!best[grp] || entry.pGIS > best[grp].pGIS) best[grp] = entry;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────
// Detail view
// ──────────────────────────────────────────────────────────────────────
function TeamDetail({ teamName, year, index, onGameDeepLink }) {
  const linkHandler = useLinkHandler();
  const [, recordRecent] = useRecent('teams');

  const rows = useMemo(() => collectTeamPlayerSeasons(index, teamName), [index, teamName]);
  const scopedRows = useMemo(
    () => year == null ? rows : rows.filter(r => r.year === year),
    [rows, year],
  );

  // Record this team page for the "Recent" rail on the selector.
  useEffect(() => {
    recordRecent({
      id: year == null ? teamName : `${teamName}||${year}`,
      label: teamName,
      sub: year == null ? 'All-Time' : String(year),
      href: year == null ? hrefFor('teams', teamName) : hrefFor('teams', teamName, year),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamName, year]);

  const awards = useMemo(() => computeAwardsIndex(index, ALL_YEARS), [index]);
  const awardKey = r => `${r.year}|${r.playerKey}|${r.team}`;

  const bestPlayer = useMemo(() => pickBestPlayerSeason(rows, year), [rows, year]);
  const lineup     = useMemo(
    () => year == null ? allTimeLineup(scopedRows) : seasonLineup(scopedRows),
    [scopedRows, year],
  );
  const rotGames = useMemo(() => perGameRotationPGIS(scopedRows), [scopedRows]);
  const avgRotPGIS = rotGames.length
    ? rotGames.reduce((s, g) => s + g.rotPGIS, 0) / rotGames.length
    : null;
  const bestGames = useMemo(() => bestGamesByPosition(scopedRows), [scopedRows]);

  const isAllTime = year == null;
  const scopeLabel = isAllTime ? 'All-Time' : `${year}${year === CURRENT_YEAR ? ' (in progress)' : ''}`;

  return (
    <>
      <div className="page-title-row">
        <h1 className="page-title">
          <TeamChip team={teamName} size={20} /> {teamName}
          <span style={{ marginLeft: '0.6rem', color: 'var(--muted)', fontWeight: 400, fontSize: '0.65em' }}>
            · {scopeLabel}
          </span>
        </h1>
        <div className="page-sub">
          {isAllTime
            ? 'Best single season, ideal all-time starting lineup, and single-match highs across every season in the database.'
            : `Season summary for ${year} — best player, ideal starting six + libero, and single-match highs.`}
        </div>
      </div>

      {scopedRows.length === 0 && (
        <div className="gb-empty">
          No data for {teamName}{isAllTime ? '' : ` in ${year}`}.
        </div>
      )}

      {scopedRows.length > 0 && (
        <>
          {/* Top row: best player + rotation pGIS summary */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 2fr) minmax(220px, 1fr)',
            gap: '1rem',
            marginBottom: '1rem',
          }}>
            <BestPlayerCard season={bestPlayer} awards={bestPlayer ? awards.get(awardKey(bestPlayer)) : null} isAllTime={isAllTime} />
            <RotationSummaryCard
              avg={avgRotPGIS}
              gameCount={rotGames.length}
              scopeLabel={scopeLabel}
            />
          </div>

          {/* Ideal lineup */}
          <LineupSection
            lineup={lineup}
            isAllTime={isAllTime}
            awards={awards}
            awardKey={awardKey}
          />

          {/* Best single-match performances */}
          <BestGamesSection
            best={bestGames}
            onGameDeepLink={onGameDeepLink}
          />

          {/* Full roster stats table — identical layout to the Seasons
              tool. All-time shows every player-season (so transfers /
              multi-year starters appear once per year); season view
              filters to that year only. */}
          <RosterStatsSection
            rows={scopedRows}
            isAllTime={isAllTime}
          />
        </>
      )}
    </>
  );
}

function RosterStatsSection({ rows, isAllTime }) {
  // Match SeasonLookup's 75% team-games filter so the table doesn't
  // include cameo appearances. Sort by pGIS desc.
  const qualified = rows
    .filter(r => r.teamGames > 0 && r.games / r.teamGames >= 0.75)
    .slice()
    .sort((a, b) => (b.pGIS || 0) - (a.pGIS || 0));
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <h2 style={{ margin: '0 0 0.4rem', fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>
        {isAllTime ? 'All-Time Roster' : 'Roster'}
        <span style={{ marginLeft: '0.5rem', fontSize: '0.75em', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          · {qualified.length} player-season{qualified.length === 1 ? '' : 's'} (≥75% team games)
        </span>
      </h2>
      {qualified.length === 0 ? (
        <div className="gb-empty">No qualifying player-seasons.</div>
      ) : (
        <SeasonStatsTable rows={qualified} showTeam={false} showYear={true} />
      )}
    </div>
  );
}

function BestPlayerCard({ season, awards, isAllTime }) {
  if (!season) {
    return (
      <div className="pb-card" style={{ padding: '1rem' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {isAllTime ? 'Best Season — All-Time' : 'Best Player'}
        </div>
        <div style={{ color: 'var(--muted)', fontStyle: 'italic', marginTop: '0.5rem' }}>
          Not enough data yet.
        </div>
      </div>
    );
  }
  const labels = awards ? awardsToLabels(awards, season.position, season.conference) : [];
  const asterisk = isAllTime && season.year === CURRENT_YEAR;
  return (
    <div className="pb-card" style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {isAllTime ? 'Best Season — All-Time' : 'Player of the Season'}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
          {season.year}{asterisk && <span style={{ color: 'var(--yellow)' }} title="In-progress season — picks may change">*</span>}
        </div>
      </div>
      <div style={{ marginTop: '0.4rem', fontSize: '1.25rem', fontWeight: 700, color: posColor(season.position) }}>
        {season.playerName}
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.1rem' }}>
        {season.position}{season.conference ? ` · ${season.conference}` : ''} · {season.games}G · {season.sets}S
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.6rem' }}>
        <PGISChip v={season.pGIS} style={{ fontWeight: 700 }} />
        <span className="pb-chip" style={{ color: 'var(--gisplus)' }}>GIS+/S {fmt(season.gisPlus)}</span>
        {season.t50?.games > 0 && (
          <span className="pb-chip" style={{ opacity: 0.8 }}>
            T50 pGIS {Number.isFinite(season.t50.pGIS) ? fmt(season.t50.pGIS, 1) : '—'} ({season.t50.games}G)
          </span>
        )}
      </div>
      {labels.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.7rem' }}>
          {labels.map(l => (
            <span key={l} className="pb-chip" style={{ fontSize: '0.65rem', background: 'rgba(250, 204, 21, 0.08)', borderColor: 'rgba(250, 204, 21, 0.35)', color: 'var(--yellow)' }}>
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RotationSummaryCard({ avg, gameCount, scopeLabel }) {
  return (
    <div className="pb-card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Avg Rotation pGIS
      </div>
      <div style={{ fontSize: '2.25rem', fontWeight: 700, color: 'var(--pgis)', lineHeight: 1.1, marginTop: '0.4rem' }}>
        {avg == null ? '—' : avg.toFixed(1)}
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 'auto' }}>
        Mean per-game pGIS of each match's starting rotation (top 3 pins,
        top 2 MB, top S, top L/DS by that game's pGIS). Across {gameCount}
        {' '}games · {scopeLabel}.
      </div>
    </div>
  );
}

const SLOT_LABEL = { OH: 'Pin', MB: 'Middle', S: 'Setter', L: 'Libero/DS' };

function LineupSection({ lineup, isAllTime, awards, awardKey }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>
          {isAllTime ? 'All-Time Ideal Lineup' : 'Ideal Starting Lineup'}
        </h2>
        {isAllTime && (
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', fontStyle: 'italic' }}>
            Each player appears once · year labeled · <span style={{ color: 'var(--yellow)' }}>*</span> = still in-progress
          </div>
        )}
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: '0.6rem',
      }}>
        {lineup.map((slot, i) => (
          <LineupSlotCard
            key={i}
            slot={slot}
            isAllTime={isAllTime}
            awardLabels={slot.pick ? awardsToLabels(awards.get(awardKey(slot.pick)), slot.pick.position, slot.pick.conference) : []}
          />
        ))}
      </div>
    </div>
  );
}

function LineupSlotCard({ slot, isAllTime, awardLabels }) {
  const p = slot.pick;
  const asterisk = isAllTime && p.year === CURRENT_YEAR;
  return (
    <div className="pb-card" style={{ padding: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{
          fontSize: '0.6rem',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: posColor(p.position),
          fontWeight: 700,
        }}>
          {SLOT_LABEL[slot.slot]}
        </span>
        {isAllTime && (
          <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>
            {p.year}
            {asterisk && <span style={{ color: 'var(--yellow)' }} title="In-progress season">*</span>}
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: posColor(p.position), marginTop: '0.2rem' }}>
        {p.playerName}
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '0.1rem' }}>
        {p.position} · {p.games}G
      </div>
      <div style={{ marginTop: '0.4rem' }}>
        <PGISChip v={p.pGIS} />
      </div>
      {awardLabels.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.4rem' }}>
          {awardLabels.slice(0, 2).map(l => (
            <span key={l} className="pb-chip" style={{
              fontSize: '0.55rem',
              background: 'rgba(250, 204, 21, 0.08)',
              borderColor: 'rgba(250, 204, 21, 0.3)',
              color: 'var(--yellow)',
              padding: '0.1rem 0.4rem',
            }}>
              {l}
            </span>
          ))}
          {awardLabels.length > 2 && (
            <span className="pb-chip" style={{ fontSize: '0.55rem', opacity: 0.7, padding: '0.1rem 0.4rem' }}>
              +{awardLabels.length - 2}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function BestGamesSection({ best, onGameDeepLink }) {
  const slots = [
    { k: 'OH', label: 'Pin (OH/OPP)' },
    { k: 'MB', label: 'Middle' },
    { k: 'S',  label: 'Setter' },
    { k: 'L',  label: 'Libero/DS' },
  ];
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ margin: '0 0 0.4rem', fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>
        Best Match Performance by Position
      </h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '0.6rem',
      }}>
        {slots.map(s => (
          <BestGameCard
            key={s.k}
            label={s.label}
            entry={best[s.k]}
            onGameDeepLink={onGameDeepLink}
          />
        ))}
      </div>
    </div>
  );
}

function BestGameCard({ label, entry, onGameDeepLink }) {
  if (!entry) {
    return (
      <div className="pb-card" style={{ padding: '0.75rem', opacity: 0.6 }}>
        <div style={{ fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--muted)' }}>{label}</div>
        <div style={{ fontStyle: 'italic', color: 'var(--muted)', marginTop: '0.3rem', fontSize: '0.8rem' }}>No qualifying match</div>
      </div>
    );
  }
  const handleClick = () => {
    if (onGameDeepLink && entry.year && entry.gameKey) onGameDeepLink(entry.year, entry.gameKey);
  };
  return (
    <div
      className="pb-card"
      onClick={handleClick}
      style={{ padding: '0.75rem', cursor: 'pointer' }}
      title="Open this match in the Games tool"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: posColor(entry.position) }}>{label}</span>
        <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>{entry.date || entry.year}</span>
      </div>
      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: posColor(entry.position), marginTop: '0.2rem' }}>
        {entry.name}
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.1rem' }}>
        vs {entry.opponent || '—'} · {entry.sets}S
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
        <PGISChip v={entry.pGIS} style={{ fontWeight: 700 }} />
        {Number.isFinite(entry.gisPlus) && (
          <span className="pb-chip" style={{ color: 'var(--gisplus)' }}>GIS+ {entry.gisPlus.toFixed(2)}</span>
        )}
      </div>
    </div>
  );
}
