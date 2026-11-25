/**
 * SeasonStatsTable — the per-season leaderboard table.
 *
 * Extracted from SeasonLookup so the Teams tool can mirror it exactly
 * (user wants the team roster list to match the Seasons tab column for
 * column, cell for cell). SeasonLookup and TeamLookup both render this
 * component; any styling change made here lands in both.
 *
 * Rows should be the shape SeasonLookup's `buildRows()` produces:
 *   { playerKey, name, team, conference, position, year, games, sets,
 *     gis, gisPlus, pGIS, t50, recQuality, srvQuality, setQuality,
 *     blockEffPerSet, totals }
 */
import { posColor, pgisLabel, COL_TIPS } from '../lib/gis.js';
import TeamChip from './TeamChip.jsx';

export function fmt(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(d);
}

export function PGISCell({ v }) {
  if (v == null || !Number.isFinite(v)) return <td style={{ textAlign: 'right' }}>—</td>;
  const [, cls] = pgisLabel(v);
  return (
    <td style={{ textAlign: 'right' }}>
      <span className={`pb-chip pgis-${cls}`} style={{ fontSize: '0.6rem' }}>
        {v.toFixed(1)}
      </span>
    </td>
  );
}

function tierColor(value, thresholds) {
  if (!Number.isFinite(value)) return 'var(--muted)';
  if (value >= thresholds[0]) return 'var(--green)';
  if (value >= thresholds[1]) return 'var(--accent)';
  if (value >= thresholds[2]) return 'var(--yellow)';
  return 'var(--red)';
}
const smallSampleStyle = (color) => ({
  textAlign: 'right', color, fontWeight: 500,
  opacity: 0.55, fontStyle: 'italic',
});
const qualifiedStyle = (color) => ({
  textAlign: 'right', color, fontWeight: 700,
});

export function RecLeaderCell({ rq }) {
  if (!rq || (rq.total || 0) === 0) return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  const color = tierColor(rq.greatPct, [0.50, 0.40, 0.30]);
  const style = rq.qualified ? qualifiedStyle(color) : smallSampleStyle(color);
  return <td style={style} title={`${rq.total} receptions`}>{Math.round(rq.greatPct * 100)}%{rq.qualified ? '' : '*'}</td>;
}
export function SrvLeaderCell({ sq }) {
  if (!sq || (sq.total || 0) === 0) return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  const color = tierColor(sq.effectivePct, [0.25, 0.20, 0.15]);
  const style = sq.qualified ? qualifiedStyle(color) : smallSampleStyle(color);
  return <td style={style} title={`${sq.total} serves`}>{Math.round(sq.effectivePct * 100)}%{sq.qualified ? '' : '*'}</td>;
}
export function AstLeaderCell({ sq }) {
  if (!sq || (sq.total || 0) === 0) return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  const color = tierColor(sq.assistPct, [0.40, 0.35, 0.30]);
  const style = sq.qualified ? qualifiedStyle(color) : smallSampleStyle(color);
  return <td style={style} title={`${sq.total} sets`}>{Math.round(sq.assistPct * 100)}%{sq.qualified ? '' : '*'}</td>;
}
export function BlkLeaderCell({ value, sets }) {
  if (!Number.isFinite(value)) return <td style={{ textAlign: 'right', opacity: 0.5 }}>—</td>;
  const color = tierColor(value, [1.5, 1.0, 0.5]);
  const qualified = (sets || 0) >= 50;
  const style = qualified ? qualifiedStyle(color) : smallSampleStyle(color);
  return <td style={style} title={`${sets} sets`}>{value.toFixed(2)}{qualified ? '' : '*'}</td>;
}

/**
 * The table itself. Set `showTeam=false` to drop the Team column
 * (already implied by context on a team-scoped page). `showYear` is
 * usually true for all-time views and false for single-season.
 */
export default function SeasonStatsTable({ rows, showTeam = true, showYear = true, maxWidth = '1200px' }) {
  return (
    <div className="pb-table-wrap" style={{ maxWidth, margin: '0 auto' }}>
      <table className="pb-season-table" style={{ width: '100%', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.72rem' }}>
        <thead>
          <tr style={{ color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <th style={{ textAlign: 'right' }} title={COL_TIPS['#']}>#</th>
            <th className="text-left" title={COL_TIPS.Player}>Player</th>
            {showTeam && <th className="text-left" title={COL_TIPS.Team}>Team</th>}
            <th className="text-left" title={COL_TIPS.Pos}>Pos</th>
            {showYear && <th style={{ textAlign: 'right' }} title={COL_TIPS.Yr}>Yr</th>}
            <th style={{ textAlign: 'right' }} title={COL_TIPS.G}>G</th>
            <th style={{ textAlign: 'right' }} title={COL_TIPS.S}>S</th>
            <th style={{ textAlign: 'right' }} title={COL_TIPS['GIS/S']}>GIS/S</th>
            <th style={{ textAlign: 'right' }} title={COL_TIPS['GIS+/S']}>GIS+/S</th>
            <th style={{ textAlign: 'right' }} title={COL_TIPS.pGIS}>pGIS</th>
            <th style={{ textAlign: 'right' }} title={COL_TIPS['REC%']}>REC%</th>
            <th style={{ textAlign: 'right' }} title={COL_TIPS['SRV+']}>SRV+</th>
            <th style={{ textAlign: 'right' }} title={COL_TIPS['AST%']}>AST%</th>
            <th style={{ textAlign: 'right' }} title={COL_TIPS['BLK+']}>BLK+</th>
            <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 G']}>T50 G</th>
            <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 GIS+/S']}>T50 GIS+/S</th>
            <th style={{ textAlign: 'right', opacity: 0.6 }} title={COL_TIPS['T50 pGIS']}>T50 pGIS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.playerKey + '_' + r.year + '_' + r.team}>
              <td style={{ textAlign: 'right', color: 'var(--muted)' }}>{i + 1}</td>
              <td className="pb-name" style={{ color: posColor(r.position) }}>{r.name}</td>
              {showTeam && <td className="pb-team"><TeamChip team={r.team} />{r.team}</td>}
              <td>{r.position}</td>
              {showYear && <td style={{ textAlign: 'right' }}>{r.year}</td>}
              <td style={{ textAlign: 'right' }}>{r.games}</td>
              <td style={{ textAlign: 'right' }}>{r.sets}</td>
              <td style={{ textAlign: 'right' }}>{fmt(r.gis)}</td>
              <td style={{ textAlign: 'right', color: 'var(--gisplus)' }}>{fmt(r.gisPlus)}</td>
              <PGISCell v={r.pGIS} />
              <RecLeaderCell rq={r.recQuality} />
              <SrvLeaderCell sq={r.srvQuality} />
              <AstLeaderCell sq={r.setQuality} />
              <BlkLeaderCell value={r.blockEffPerSet} sets={r.sets} />
              <td style={{ textAlign: 'right', opacity: 0.7 }}>{r.t50 ? r.t50.games : '—'}</td>
              <td style={{ textAlign: 'right', opacity: 0.7, color: 'var(--gisplus)' }}>{r.t50 ? fmt(r.t50.gisPlus) : '—'}</td>
              <td style={{ textAlign: 'right', opacity: 0.7 }}>
                {r.t50 && Number.isFinite(r.t50.pGIS) ? fmt(r.t50.pGIS, 1) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
